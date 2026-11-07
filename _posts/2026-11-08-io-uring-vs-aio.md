---
layout: post
title: "io_uring 相比 libaio 与 POSIX AIO:异步 IO 的三代设计"
date: 2026-11-08
categories: [kernel-deep]
description: 从线程模型、上下文切换与队列深度出发,对比 POSIX AIO、libaio 与 io_uring 三代异步 IO 的内核实现、系统调用、共享内存与选型
---
内核精读 · 存储/异步 IO · 源码基线 v7.4.0-rc1

异步 IO 要解决的不是"读得快",而是"在等待设备的时候不浪费 CPU"。同一件事,Linux 上出现过三代截然不同的做法:glibc 用用户态线程池模拟,libaio 用内核的完成环,io_uring 则把提交环和完成环都放进用户态共享内存。理解三代设计的差异,比记住 API 名字重要得多。


## 一、为什么需要异步 IO

最朴素的并发模型是"一个请求一个线程":线程发起 `read()`,在页缓存未命中时睡眠,设备完成后被唤醒。它简单、直观,但每个阻塞点都要付出一次**上下文切换**。当队列深度(同时未完成的 IO 数)上升到几百、几千,线程本身的内存栈、调度开销和缓存污染就会盖过设备延迟的收益。

可以用三个量来刻画这个矛盾:

| 维度 | 同步/线程模型 | 真正的异步 IO |
|---|---|---|
| 每 IO 系统调用 | 至少 1 次 `read`/`write` | 可 0 次(共享内存) |
| 等待方式 | 线程睡眠,唤醒即切换 | 完成事件入队,由应用批量收割 |
| 队列深度 | 受线程数限制 | 受环大小与设备队列限制 |
| 内存拷贝 | 用户缓冲区直接参与 | 可固定缓冲区,减少映射/固定开销 |
| 编程复杂度 | 低 | 中到高 |

一个经验数字:在百万级 IOPS 的场景里,如果每个 IO 都要两次系统调用(提交 + 收割),仅系统调用就可能吃掉可观的核心。异步 IO 的核心目标,是把"提交"和"完成"变成**批量、无锁、尽量少进内核**的操作。

## 二、第一代:POSIX AIO 其实是用户态线程池

POSIX 定义了一组 `aio_read`、`aio_write`、`aio_fsync`、`aio_suspend`、`aio_error`、`aio_return` 接口,通过 `struct aiocb` 描述请求。它在 POSIX 语义上是异步的,但 **Linux 的 glibc 实现并不依赖内核 AIO**:glibc 在用户态维护一个工作线程池,把请求排队,由工作线程执行普通的阻塞 `read`/`write`,完成后通过信号或回调通知调用者。

因此第一代方案的本质是:

```text
应用线程
  └─ aio_read(aiocb)
       └─ glibc 请求队列
            └─ 工作线程池(userspace threads)
                 └─ 普通 read()/write()  ← 仍然可能阻塞
```

它有几个直接后果:

- **可移植性好**:任何支持 pthread 的 POSIX 系统都能实现,不要求文件系统支持 `O_DIRECT`。
- **仍然有线程切换**:只是把切换从"应用线程"转移到了"glibc 工作线程",并没有消除。
- **没有内核级批处理**:每次提交/完成都要穿过用户态队列,且线程池大小固定。
- **对网络 fd 也能用**:因为它最终就是阻塞系统调用,不依赖内核 AIO 的完成环。

所以 POSIX AIO 在 Linux 上更像"可移植的线程封装",而不是一种内核异步机制。它适合低并发、需要跨平台、或者文件系统不支持 `O_DIRECT` 的场景;不适合追求极限 IOPS 的存储服务。

## 三、第二代:libaio 与内核 fs/aio.c

libaio 是对 Linux 原生 AIO 系统调用的薄封装,核心只有四个:

```c
int io_setup(unsigned nr_events, aio_context_t *ctxp);          /* fs/aio.c:1445 */
int io_submit(aio_context_t ctx, long nr, struct iocb **iocbs); /* fs/aio.c:2150 */
int io_getevents(aio_context_t ctx, long min_nr, long nr,
                 struct io_event *events, struct timespec *timeout); /* fs/aio.c:2319 */
int io_destroy(aio_context_t ctx);                              /* fs/aio.c:1514 */
```

另外还有 `io_cancel`(`fs/aio.c:2244`)和 `io_pgetevents`(`fs/aio.c:2344`)。`aio_context_t` 在内核里对应 `struct kioctx`,每个上下文拥有自己的完成环。

### 3.1 完成环是怎么建起来的

`io_setup` 最终调用 `aio_setup_ring`(`fs/aio.c:547`),先按 `nr_events` 算出环大小,再通过一个私有文件建立页缓存,并 `do_mmap` 到用户空间:

```c
nr_events += 2;
size = sizeof(struct aio_ring);
size += sizeof(struct io_event) * nr_events;
nr_pages = PFN_UP(size);
...
ctx->mmap_base = do_mmap(ctx->aio_ring_file, 0, ctx->mmap_size,
                         PROT_READ | PROT_WRITE,
                         MAP_SHARED, EMPTY_VMA_FLAGS, 0, &unused, NULL);
```

完成事件由 `aio_complete`(`fs/aio.c:1184`)写入这个环:它拿到 `ctx->tail`,把 `struct io_event` 写到对应页,`smp_wmb()` 之后再更新 `ring->tail`。用户态 `io_getevents` 只需要比较 head/tail,就能批量收割。

每个事件是固定 32 字节的 `struct io_event`(见 `include/uapi/linux/aio_abi.h:60`):

```c
struct io_event {
        __u64 data;   /* iocb 里的 aio_data */
        __u64 obj;    /* 对应的 iocb 地址 */
        __s64 res;    /* 结果码 */
        __s64 res2;   /* 次级结果 */
};
```

### 3.2 提交路径与分派

`io_submit` 逐个复制用户态 `struct iocb`,进入 `io_submit_one`(`fs/aio.c:2091`),再由 `__io_submit_one`(`fs/aio.c:2037`)按 `aio_lio_opcode` 分派:

```c
switch (iocb->aio_lio_opcode) {
case IOCB_CMD_PREAD:   return aio_read(&req->rw, iocb, false, compat);
case IOCB_CMD_PWRITE:  return aio_write(&req->rw, iocb, false, compat);
case IOCB_CMD_PREADV:  return aio_read(&req->rw, iocb, true, compat);
case IOCB_CMD_PWRITEV: return aio_write(&req->rw, iocb, true, compat);
case IOCB_CMD_FSYNC:   return aio_fsync(&req->fsync, iocb, false);
case IOCB_CMD_FDSYNC:  return aio_fsync(&req->fsync, iocb, true);
case IOCB_CMD_POLL:    return aio_poll(req, iocb);
default:               return -EINVAL;
}
```

`aio_read`(`fs/aio.c:1644`)和 `aio_write`(`fs/aio.c:1671`)最终调用文件的 `read_iter`/`write_iter`。这里有一个关键约定:如果底层没有真正异步,调用会同步完成;只有当底层返回 `-EIOCBQUEUED` 时,请求才算"已提交、稍后完成"。`aio_rw_done`(`fs/aio.c:1624`)正是处理这个约定:

```c
switch (ret) {
case -EIOCBQUEUED:
        break;                 /* 已经排好,等完成回调 */
case -ERESTARTSYS:
...
default:
        req->ki_complete(req, ret);  /* 同步完成,直接入完成环 */
}
```

### 3.3 为什么 libaio 常和 O_DIRECT 绑定

这就是"libaio 必须配 O_DIRECT"这一经验的来源。对于 buffered IO,`read_iter` 很可能在页缓存、锁或回写上**睡眠**,不可能立刻返回 `-EIOCBQUEUED`;内核只能把它当作同步请求处理,提交线程仍然被拖住。而 `O_DIRECT` 路径通常把 bio 提交给块层后立即返回 `-EIOCBQUEUED`,完成时再由 `ki_complete` 回调 `aio_complete_rw`(`fs/aio.c:1554`)写入完成环。

换句话说,libaio 的"异步"能否成立,取决于文件系统/文件类型的 `read_iter`/`write_iter` 实现,而不是 libaio 自己。常见边界:

| 场景 | libaio 表现 | 原因 |
|---|---|---|
| 普通文件 + `O_DIRECT` | 通常真正异步 | `direct_IO` 提交 bio 后返回 `-EIOCBQUEUED` |
| 普通文件 buffered read | 可能同步/阻塞 | 页缓存未命中、预读、锁等待 |
| buffered write | 常退化为同步 | 需要分配页、可能触发回写 |
| 网络 socket | 不适用 | AIO 只面向可 `read_iter` 的普通文件语义,缺少 accept/connect 等 |
| 某些网络/FUSE 文件系统 | 支持不完整 | 没有可靠的 `direct_IO` 或异步完成路径 |
| 元数据操作(open/stat/unlink) | 不支持 | AIO 只覆盖 read/write/fsync/poll |

此外,内核有一个全局配额:`/proc/sys/fs/aio-max-nr` 默认 `0x10000`(`fs/aio.c:235`),`/proc/sys/fs/aio-nr` 是当前已用量(`fs/aio.c:238` 的 sysctl 表)。配额耗尽时 `io_submit` 会返回 `-EAGAIN`,这是高并发下很容易踩到的坑。

## 四、第三代:io_uring

io_uring 的关键变化是:**提交和完成都变成用户态与内核共享内存中的环**,系统调用从"每 IO 一次"变成"能批就批、能不进就不进"。

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/存储技术/io-uring-aio.html' | relative_url }}" loading="lazy" title="io_uring 与 libaio 架构对比"></iframe>
  <figcaption>图 1:POSIX AIO、libaio 与 io_uring 的架构对比(SQ/CQ 环、内核路径与完成方式)。</figcaption>
</figure>

### 4.1 两个环、两种条目

io_uring 的共享内存布局由 `struct io_rings`(`include/linux/io_uring_types.h:194`)描述,包含:

- **SQ ring**:应用写 tail,内核读 tail;应用通过 `sq_array` 间接索引到 SQE 数组
- **CQ ring**:内核写 tail,应用读 head;条目是 `struct io_uring_cqe`
- `sq_ring_mask`/`cq_ring_mask`:大小为 2 的幂,索引用位与代替取模

条目格式在 UAPI 中定义:

```c
struct io_uring_sqe {          /* include/uapi/linux/io_uring.h:32 */
        __u8  opcode;
        __u8  flags;
        __u16 ioprio;
        __s32 fd;
        __u64 off;
        __u64 addr;
        __u32 len;
        __u32 rw_flags;
        __u64 user_data;       /* 原样回传到 CQE */
        ...
};

struct io_uring_cqe {          /* include/uapi/linux/io_uring.h:501 */
        __u64 user_data;
        __s32 res;
        __u32 flags;
};
```

应用只关心"我往 SQ 里放 SQE,从 CQ 里取 CQE",中间不需要为每个 IO 做一次系统调用。

### 4.2 setup:一次系统调用换来三个 mmap

`io_uring_setup`(`io_uring/io_uring.c:3404`)接收 `entries` 和 `struct io_uring_params`,内部调用 `io_uring_setup`(`io_uring/io_uring.c:3365`)再到 `io_uring_create`(`io_uring/io_uring.c:3232`)。其中 `io_allocate_scq_urings`(`io_uring/io_uring.c:2983`)建立 ring 与 SQE 区域,并写入 mask/entries:

```c
ctx->rings = rings = io_region_get_ptr(&ctx->ring_region);
...
ctx->sq_sqes = io_region_get_ptr(&ctx->sq_region);
WRITE_ONCE(rings->sq_ring_mask, ctx->sq_entries - 1);
WRITE_ONCE(rings->cq_ring_mask, ctx->cq_entries - 1);
```

用户态拿到 `io_uring_params` 里的偏移后,用三个固定偏移做 `mmap`:

| 偏移宏 | 值 | 映射内容 |
|---|---|---|
| `IORING_OFF_SQ_RING` | `0ULL` | SQ ring 元数据 + `sq_array` |
| `IORING_OFF_CQ_RING` | `0x8000000ULL` | CQ ring 元数据 + CQE 数组 |
| `IORING_OFF_SQES` | `0x10000000ULL` | SQE 数组 |

定义见 `include/uapi/linux/io_uring.h:552-554`。这一步之后,提交和收割都可以是纯用户态内存操作。

### 4.3 enter:提交、等待、批处理

`io_uring_enter`(`io_uring/io_uring.c:2852`)的签名是:

```c
SYSCALL_DEFINE6(io_uring_enter, unsigned int fd, u32 to_submit,
                u32 min_complete, u32 flags, const void __user *argp,
                size_t argsz)
```

它的行为可以概括为:

1. `to_submit > 0`:调用 `io_submit_sqes`(`io_uring/io_uring.c:2177`)批量消费 SQ 中的 SQE
2. `flags & IORING_ENTER_GETEVENTS`:调用 `io_cqring_wait` 等到至少 `min_complete` 个完成事件
3. SQPOLL 模式下,应用甚至不需要提交,只需在需要时唤醒内核线程

`io_submit_sqes` 一次最多处理 `nr` 个请求,失败时把剩余引用退回:

```c
entries = min(nr, entries);
...
do {
        if (unlikely(!io_alloc_req(ctx, &req)))
                break;
        if (unlikely(!io_get_sqe(ctx, &sqe))) { ... }
        ...
} while (--left);
io_commit_sqring(ctx);
```

`io_get_sqe`(`io_uring/io_uring.c:2145`)负责从 `sq_array` 取索引并校验,防止越界。批处理的意义在于:一次 `io_uring_enter` 可以提交几百个 SQE,再顺带等待完成,系统调用次数从 O(IO) 降到 O(批次)。

### 4.4 SQPOLL:把提交也交给内核线程

`IORING_SETUP_SQPOLL`(`include/uapi/linux/io_uring.h:176`)会创建内核线程 `io_sq_thread`(`io_uring/sqpoll.c:303`),由它轮询 SQ ring。应用只需要写 SQE 和 tail;当内核线程睡着时,应用通过 `IORING_ENTER_SQ_WAKEUP` 唤醒它。稳态下,应用可以做到**零系统调用提交**。

代价是:轮询线程会占用一个 CPU,空闲时也会消耗;因此适合高吞吐、持续有 IO 的负载,不适合长时间空闲的连接。

### 4.5 registered files 与 registered buffers

普通 `read`/`write` 每次都要 `fget`/`fput` 文件,并且每次都要固定用户缓冲区。io_uring 允许提前注册:

| 操作码 | 作用 | 定义位置 |
|---|---|---|
| `IORING_REGISTER_BUFFERS` | 注册一组固定缓冲区 | `include/uapi/linux/io_uring.h:655` |
| `IORING_REGISTER_FILES` | 注册一组固定 fd | 同文件 `:657` |
| `IORING_REGISTER_FILES_UPDATE` | 增量更新 fd 表 | `:661` |
| `IORING_REGISTER_EVENTFD` | 完成事件投递到 eventfd | `:659` |
| `IORING_REGISTER_RESTRICTIONS` | 限制可用 opcode/参数 | `:666` |

内核侧,`io_sqe_files_register`(`io_uring/rsrc.c:676`)建立 fd 表,`io_sqe_buffer_register`(`io_uring/rsrc.c:947`)把用户页钉住并记录;提交时 `io_import_fixed`(`io_uring/rsrc.c:1297`)直接从固定表取地址。这样既省掉每 IO 的 `fget`,也避免重复 pin page。

注意:注册缓冲区会长期占用页(计入 locked memory),不是越多越好;应按并发深度和单次 IO 大小估算。

### 4.6 IOPOLL:用轮询代替中断

`IORING_SETUP_IOPOLL`(`include/uapi/linux/io_uring.h:175`)让内核主动轮询设备完成队列,而不是等中断。它适合低延迟、高 IOPS 的 `O_DIRECT`/块设备场景,能减少中断开销和上下文切换;但会占用 CPU,且并非所有文件类型都支持。代码里可以看到它对 opcode 和设备能力的约束(`io_uring/io_uring.c:1309`、`:1962`、`:3275`)。

### 4.7 uring_cmd:直达驱动的透传通道

`IORING_OP_URING_CMD`(`include/uapi/linux/io_uring.h:303`)不是普通读写,而是把命令原样交给文件的 `uring_cmd` 回调。内核入口是 `io_uring_cmd`(`io_uring/uring_cmd.c:226`):

```c
if (!file->f_op->uring_cmd)
        return -EOPNOTSUPP;
...
ret = file->f_op->uring_cmd(ioucmd, issue_flags);
```

NVMe 驱动实现了这条路径:`nvme_uring_cmd_io`(`drivers/nvme/host/ioctl.c:480`)做权限与参数校验,分配请求并映射用户缓冲区,最后走 `blk_execute_rq_nowait`;完成时 `nvme_uring_cmd_end_io`(`drivers/nvme/host/ioctl.c:444`)回调 io_uring。它绕过了页缓存和 VFS 的 buffered 语义,换来的是**自定义命令、零拷贝、低延迟**。

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/NVMe驱动/nvme-uring-passthrough.html' | relative_url }}" loading="lazy" title="NVMe io_uring 命令透传"></iframe>
  <figcaption>图 2:NVMe 的 uring_cmd 透传路径(应用 SQE → 驱动 → 块层 → 设备)。</figcaption>
</figure>

## 五、三代设计对比

| 维度 | POSIX AIO(glibc) | libaio | io_uring |
|---|---|---|---|
| 实现位置 | 用户态线程池 | 内核 `fs/aio.c` | 内核 `io_uring/` + 共享内存 |
| 每 IO 系统调用 | 无(但线程切换) | 提交 1 次 + 收割 1 次 | 可 0 次(SQPOLL),通常按批 |
| 是否共享内存 | 否 | 完成环共享 | SQ/CQ 都共享 |
| 是否支持 buffered | 是(本质是阻塞调用) | 不可靠,常需 `O_DIRECT` | 支持(buffered 走 io-wq 异步) |
| 是否支持网络 | 是(阻塞 socket) | 基本不支持 | 支持(accept/connect/send/recv 等) |
| 批处理 | 无 | `io_submit` 可批量,但完成环固定 | SQE 批量提交、CQE 批量收割 |
| 固定缓冲区/文件 | 无 | 无 | registered buffers/files |
| 轮询模式 | 无 | `IOCB_CMD_POLL` 是等事件 | IOPOLL + SQPOLL |
| 透传命令 | 无 | 无 | `uring_cmd` |
| 元数据操作 | 部分(经线程) | 不支持 | 支持 open/stat/unlink 等 |
| 复杂度 | 低 | 中 | 高 |
| 典型场景 | 跨平台、低并发 | 传统数据库 `O_DIRECT` | 高 IOPS、低延迟、全功能异步 |

一句话总结:**POSIX AIO 用线程换可移植,libaio 用完成环换内核异步,io_uring 用共享内存换系统调用**。三代不是简单替代关系,而是内核能力与用户态约定逐步下移的过程。

## 六、代码与观测

### 6.1 strace:看清系统调用次数

```bash
# libaio:提交与收割是两次独立系统调用
strace -f -e trace=io_setup,io_submit,io_getevents,io_destroy ./aio_app

# POSIX AIO:通常看不到 AIO 系统调用,看到的是线程与 read/write
strace -f -e trace=clone,read,write,rt_sigqueueinfo ./posix_aio_app

# io_uring:setup 一次,enter 按批,mmap 三次
strace -f -e trace=io_uring_setup,io_uring_enter,io_uring_register,mmap ./uring_app
```

一个常见现象:libaio 程序在 `O_DIRECT` 文件上 `io_submit` 很快返回,但在 buffered 文件上 `io_submit` 本身就很慢——因为提交线程替内核等了 IO。

### 6.2 perf:看内核路径

```bash
# 统计异步 IO 系统调用
sudo perf stat -e syscalls:sys_enter_io_submit,syscalls:sys_enter_io_getevents -a sleep 5
sudo perf stat -e syscalls:sys_enter_io_uring_enter,syscalls:sys_enter_io_uring_setup -a sleep 5

# 追踪块层与完成
sudo perf trace -e block:block_rq_issue,block:block_rq_complete -a
```

如果想确认 libaio 是否真的异步,可以观察提交线程是否在 `io_submit` 内睡眠(用户态 `perf` 的 off-cpu 分析),或者直接在 `aio_read`/`aio_write` 上打点看返回值是否为 `-EIOCBQUEUED`。

### 6.3 /proc 与配额

```bash
# 当前 AIO 请求数与上限
cat /proc/sys/fs/aio-nr
cat /proc/sys/fs/aio-max-nr

# 调大上限(需要 root;生产环境要评估内存)
sysctl -w fs.aio-max-nr=1048576
```

`aio-nr` 接近 `aio-max-nr` 时,新的 `io_setup`/`io_submit` 会失败或返回 `-EAGAIN`。这是 libaio 服务在高压下"突然不工作"的常见原因。

### 6.4 io_uring 的注册与查询

```bash
# 查看进程的 io_uring 使用情况
cat /proc/<pid>/fdinfo/<uring_fd>

# 常用注册操作(伪代码)
# io_uring_register(ring_fd, IORING_REGISTER_FILES, fds, nr_fds)
# io_uring_register(ring_fd, IORING_REGISTER_BUFFERS, iovecs, nr)
# io_uring_register(ring_fd, IORING_REGISTER_EVENTFD, &efd, 1)
```

`io_uring_register` 的系统调用入口在 `io_uring/register.c:1081`,分派表覆盖 buffers/files/eventfd/restrictions/pbuf/ring fds 等。注册失败通常意味着资源上限、权限或参数不合法,建议在初始化阶段就检查返回值,而不是等到提交时才发现。

## 七、FAQ 与选型建议

**Q1:io_uring 一定比 libaio 快吗?**
不一定。队列深度很低、IO 已经打满设备、或者每次只提交一个请求时,io_uring 的环维护和内存屏障开销可能抵消收益。它的优势在**高并发、批处理、需要网络/元数据异步**的场景。

**Q2:libaio 能不能用于 buffered IO?**
能调用,但"异步"不保证。buffered 路径可能同步完成;需要真正异步时,优先 `O_DIRECT`,并确认文件系统实现了可靠的 `direct_IO`。

**Q3:io_uring 支持 buffered 吗?**
支持。内核对不能立即完成的 buffered 请求会交给 io-wq 工作队列,从而避免阻塞提交者;但这也意味着它仍然依赖后台线程,延迟和 CPU 特性与 `O_DIRECT` 不同。

**Q4:三者都能做网络 IO 吗?**
POSIX AIO 通过阻塞 socket + 线程池可以;libaio 主要面向文件,不适合网络;io_uring 原生支持 socket 的 accept/connect/send/recv 等操作。

**Q5:生产环境如何限制 io_uring?**
内核提供 `kernel.io_uring_disabled` 与 `kernel.io_uring_group` 两个 sysctl(`io_uring/io_uring.c:134` 附近),可以在不需要时禁用,或只允许特定组使用;容器场景还要考虑 seccomp。

**选型建议**:

| 你的情况 | 建议 |
|---|---|
| 跨平台、低并发、代码简单 | POSIX AIO 或直接线程池 |
| 传统数据库、`O_DIRECT`、已有 libaio 代码 | 继续 libaio,注意 `aio-max-nr` 与文件系统支持 |
| 高 IOPS、低延迟、需要网络/元数据异步 | io_uring,优先 registered files/buffers |
| 极端低延迟、可接受占 CPU | io_uring + IOPOLL(+ SQPOLL) |
| 需要驱动自定义命令 | io_uring `uring_cmd` |

## 八、常见误解

- **"POSIX AIO 是内核 AIO"**:Linux 上 glibc 版本是用户态线程池,和 `fs/aio.c` 是两套东西。
- **"libaio 天然异步"**:异步与否取决于底层 `read_iter`/`write_iter` 是否返回 `-EIOCBQUEUED`。
- **"libaio 必须 O_DIRECT"**:不是语法要求,而是 buffered 路径常常无法真正异步,所以实践中被绑定。
- **"io_uring 每次都要系统调用"**:SQPOLL + 共享内存可以做到稳态零提交系统调用。
- **"注册缓冲区越多越好"**:固定页会长期占用内存并计入锁定页限制。
- **"uring_cmd 就是异步 read"**:它绕过页缓存,语义由驱动定义。

## 相关图示

- [io_uring 与 libaio 架构对比]({{ '/linux-arch-dia/存储技术/io-uring-aio.html' | relative_url }})
- [NVMe io_uring 命令透传]({{ '/linux-arch-dia/NVMe驱动/nvme-uring-passthrough.html' | relative_url }})
- [NVMe IO 深度调用链]({{ '/linux-arch-dia/NVMe驱动/deep-nvme-io.html' | relative_url }})
- [SQ/CQ 队列对与门铃]({{ '/linux-arch-dia/NVMe驱动/nvme-queue-doorbell.html' | relative_url }})

> 源码基线:Linux `d487237`(v7.4.0-rc1)。行号会随内核版本漂移,以图集仓库重新 finalize 后的结果为准。
