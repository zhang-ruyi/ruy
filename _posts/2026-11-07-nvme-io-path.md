---
layout: post
title: "从 read() 到 NVMe 门铃:一次 IO 的完整旅程"
date: 2026-11-07
categories: [kernel-deep]
description: VFS → 块层 blk-mq → NVMe queue_rq → SQ 门铃 → MSI-X 完成回收,含队列限制与 io_uring 透传
---
内核精读 · 存储/NVMe · 源码基线 v7.4.0-rc1

一次 `read()` 看起来只是把数据从磁盘搬到用户缓冲区,实际要穿过 VFS、页缓存、块层、blk-mq、NVMe 驱动和 PCIe 设备。本文按时间顺序走一遍,重点看**谁在什么上下文里做了什么**,以及 NVMe 的队列、门铃、完成和错误恢复。


## 一、先分清三条路径

"读文件"并不总是产生 NVMe IO,也不只有一条路径:

| 路径 | 入口 | 是否经过页缓存 | 是否经过块层 |
|---|---|---|---|
| buffered read | `read()` | 是(命中直接返回) | 未命中时 |
| O_DIRECT | `read()` + `O_DIRECT` | 否 | 是 |
| io_uring 普通读写 | `io_uring` read/write | 取决于是否 O_DIRECT | 是 |
| io_uring 命令透传 | `IORING_OP_URING_CMD` | 否 | `blk_execute_rq` 直达驱动 |

本文主线是"buffered read 未命中页缓存"的最完整路径;透传路径在第九节单独说明。

## 二、全景调用链

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/NVMe驱动/deep-nvme-io.html' | relative_url }}" loading="lazy" title="NVMe IO 深度调用链"></iframe>
  <figcaption>图 1:NVMe IO 的函数级调用链(提交、门铃、完成)。</figcaption>
</figure>

<div class="tree-map" role="img" aria-label="提交路径 · 进程上下文">
  <div class="tree-map-head">
    <span class="tree-map-title">提交路径 · 进程上下文</span>
    <span class="tree-map-note">源码基线 v7.4.0-rc1</span>
  </div>
  <ul><li><div class="tree-card tone-slate"><span class="tree-label">ksys_read</span><span class="tree-sub">fs/read_write.c:705</span></div><ul><li><div class="tree-card tone-blue"><span class="tree-label">vfs_read</span><span class="tree-sub">fs/read_write.c:554</span></div><ul><li><div class="tree-card tone-violet"><span class="tree-label">submit_bio_noacct</span><span class="tree-sub">block/blk-core.c:818</span></div><ul><li><div class="tree-card tone-amber"><span class="tree-label">blk_mq_submit_bio</span><span class="tree-sub">block/blk-mq.c:3115</span></div><ul><li><div class="tree-card tone-green"><span class="tree-label">nvme_queue_rq</span><span class="tree-sub">drivers/nvme/host/pci.c:1663</span></div><ul><li><div class="tree-card tone-teal"><span class="tree-label">nvme_setup_cmd</span><span class="tree-sub">drivers/nvme/host/core.c:1107</span></div></li><li><div class="tree-card tone-teal"><span class="tree-label">nvme_map_data</span><span class="tree-sub">drivers/nvme/host/pci.c:1469</span></div></li><li><div class="tree-card tone-teal"><span class="tree-label">nvme_sq_copy_cmd</span><span class="tree-sub">drivers/nvme/host/pci.c:742</span></div></li><li><div class="tree-card tone-teal"><span class="tree-label">nvme_write_sq_db</span><span class="tree-sub">drivers/nvme/host/pci.c:724</span></div></li></ul></li></ul></li></ul></li></ul></li></ul></li></ul>
</div>

<div class="callout"><strong>设备执行 · NVMe 控制器</strong>:SQE DMA fetch → 执行命令 → CQE 写入 → MSI-X 中断。</div>

<div class="tree-map" role="img" aria-label="完成路径 · 中断上下文">
  <div class="tree-map-head">
    <span class="tree-map-title">完成路径 · 中断上下文</span>
    <span class="tree-map-note">源码基线 v7.4.0-rc1</span>
  </div>
  <ul><li><div class="tree-card tone-slate"><span class="tree-label">nvme_irq</span><span class="tree-sub">drivers/nvme/host/pci.c:1862</span></div><ul><li><div class="tree-card tone-blue"><span class="tree-label">nvme_poll_cq</span><span class="tree-sub">drivers/nvme/host/pci.c:1841</span></div><ul><li><div class="tree-card tone-violet"><span class="tree-label">nvme_handle_cqe</span><span class="tree-sub">drivers/nvme/host/pci.c:1789</span></div><ul><li><div class="tree-card tone-amber"><span class="tree-label">nvme_pci_complete_rq</span><span class="tree-sub">drivers/nvme/host/pci.c:1754</span></div><ul><li><div class="tree-card tone-green"><span class="tree-label">nvme_complete_rq</span><span class="tree-sub">drivers/nvme/host/core.c:513</span></div><ul><li><div class="tree-card tone-teal"><span class="tree-label">blk_mq_end_request</span><span class="tree-sub">block/blk-mq.c:1165</span></div><ul><li><div class="tree-card tone-rose"><span class="tree-label">bio_endio</span><span class="tree-sub">block/bio.c:1863</span></div></li></ul></li></ul></li></ul></li></ul></li></ul></li></ul></li></ul>
</div>

## 三、VFS 与页缓存:先看命中不命中

`vfs_read` 先判断文件类型与页缓存状态:

- 命中 page cache:直接 `copy_folio_to_iter` 到用户缓冲区,**不会进入块层**
- 未命中:调用 `read_folio`/`filemap_read` 触发回读,创建 bio 并提交
- 文件系统层:ext4 走 `ext4_file_read_iter` → `generic_file_read_iter` → `filemap_read` → `ext4_read_folio`

所以性能分析的第一步是区分:你的 `read()` 到底有没有产生 IO。`iostat`/`perf` 看到的磁盘读,和 `strace` 看到的 `read()` 次数不是一回事。

## 四、blk-mq:从 bio 到 request

`submit_bio_noacct` 把 bio 交给块层,`blk_mq_submit_bio`(`block/blk-mq.c:3115`)负责分配 request:

```c
rq = blk_mq_get_cached_request(plug, q, bio->bi_opf);
...
if (!rq) {
        if (unlikely(bio_queue_enter(bio)))
                return;
}
if (unlikely(bio_unaligned(bio, q))) {
        bio_io_error(bio);
        goto queue_exit;
}
if ((bio->bi_opf & REQ_POLLED) && !blk_mq_can_poll(q)) {
        bio_endio_status(bio, BLK_STS_NOTSUPP);
        goto queue_exit;
}
```

几个关键点:

- **plug 缓存**:同一批提交可以复用 request,减少分配
- **queue enter**:增加队列使用计数,阻止设备在提交期间被移除
- **对齐检查**:不满足块大小对齐的 bio 直接失败
- **poll 检查**:只有支持 poll 的队列才允许 `REQ_POLLED`

之后按 `hctx` 选择硬件队列,调用驱动的 `queue_rq`。

## 五、NVMe 提交:nvme_queue_rq

`nvme_queue_rq`(`drivers/nvme/host/pci.c:1663`)是 NVMe 驱动的提交入口:

```c
if (unlikely(!test_bit(NVMEQ_ENABLED, &nvmeq->flags)))
        return BLK_STS_IOERR;

if (unlikely(!nvme_check_ready(&dev->ctrl, req, true)))
        return nvme_fail_nonready_command(&dev->ctrl, req);

ret = nvme_prep_rq(req);           /* 构造命令 + DMA 映射 */
if (unlikely(ret))
        return ret;

spin_lock(&nvmeq->sq_lock);
nvme_sq_copy_cmd(nvmeq, &iod->cmd); /* 64B SQE 写入 SQ */
nvme_write_sq_db(nvmeq, bd->last);  /* 敲 SQ tail doorbell */
spin_unlock(&nvmeq->sq_lock);
```

`nvme_prep_rq` 内部会调用 `nvme_setup_cmd` 和 `nvme_map_data`:

- `nvme_setup_cmd`(`core.c:1107`)按 `req_op` 分派:READ/WRITE 走 `nvme_setup_rw`,FLUSH/DISCARD/WRITE_ZEROES/ZONE 各有构造器
- `nvme_map_data`(`pci.c:1469`)把 bio 的物理段映射成 PRP 或 SGL,填入 SQE 的 `dptr`
- 每个请求的 `command_id` 来自块层 tag,完成时用它找回 request

### SQE 拷贝与门铃

```c
static inline void nvme_sq_copy_cmd(struct nvme_queue *nvmeq,
                                    struct nvme_command *cmd)
{
        memcpy(nvmeq->sq_cmds + (nvmeq->sq_tail << nvmeq->sqes),
               absolute_pointer(cmd), sizeof(*cmd));
        if (++nvmeq->sq_tail == nvmeq->q_depth)
                nvmeq->sq_tail = 0;
}

static inline void nvme_write_sq_db(struct nvme_queue *nvmeq, bool write_sq)
{
        ...
        if (nvme_dbbuf_update_and_check_event(nvmeq->sq_tail,
                        nvmeq->dbbuf_sq_db, nvmeq->dbbuf_sq_ei))
                writel(nvmeq->sq_tail, nvmeq->q_db);
        nvmeq->last_sq_tail = nvmeq->sq_tail;
}
```

`writel` 就是对 BAR 的 MMIO 写,也就是"敲门铃"。`bd->last` 为真时才真正敲门铃,否则只更新 `sq_tail`,让同一批请求合并成一次门铃。

## 六、队列对与门铃:硬件视角

<div class="layout-map" role="img" aria-label="NVMe 队列对与门铃布局示意">
  <div class="layout-map-head">
    <span class="layout-map-title">队列对与门铃:内存/寄存器视角</span>
    <span class="layout-map-note">示意,非按字节比例</span>
  </div>
  <div class="layout-groups">
    <div class="layout-group">
      <div class="layout-group-name">主机内存(DMA 可访问)</div>
      <div class="layout-row">
        <span class="layout-range">SQ</span>
        <span class="layout-block tone-blue"><span class="name">提交队列:64B SQE 数组 + head/tail</span></span>
        <span class="layout-size">q_depth</span>
      </div>
      <div class="layout-row">
        <span class="layout-range">CQ</span>
        <span class="layout-block tone-violet"><span class="name">完成队列:16B CQE 数组 + phase</span></span>
        <span class="layout-size">q_depth</span>
      </div>
      <div class="layout-row">
        <span class="layout-range">数据</span>
        <span class="layout-block tone-green"><span class="name">PRP/SGL:bio 物理段</span></span>
        <span class="layout-size">DMA</span>
      </div>
    </div>
    <div class="layout-group">
      <div class="layout-group-name">BAR0(MMIO 寄存器)</div>
      <div class="layout-row">
        <span class="layout-range">SQ tail</span>
        <span class="layout-block tone-amber"><span class="name">SQ tail doorbell</span></span>
        <span class="layout-size">writel</span>
      </div>
      <div class="layout-row">
        <span class="layout-range">CQ head</span>
        <span class="layout-block tone-rose"><span class="name">CQ head doorbell</span></span>
        <span class="layout-size">writel</span>
      </div>
      <div class="layout-row">
        <span class="layout-range">CAP/CC</span>
        <span class="layout-block tone-slate"><span class="name">能力/配置寄存器</span></span>
        <span class="layout-size">MMIO</span>
      </div>
    </div>
  </div>
  <div class="layout-legend">
    <span><i class="tone-blue"></i>SQ</span>
    <span><i class="tone-violet"></i>CQ</span>
    <span><i class="tone-green"></i>数据缓冲区</span>
    <span><i class="tone-amber"></i>SQ 门铃</span>
    <span><i class="tone-rose"></i>CQ 门铃</span>
  </div>
</div>

控制器通过 DMA 读取 SQE、写回 CQE,完成后用 MSI-X 通知驱动。

- **SQ/CQ**:提交队列与完成队列都在主机内存,控制器通过 DMA 访问
- **doorbell**:驱动写 BAR 通知控制器"有新命令"或"已回收完成项"
- **phase bit**:CQE 的 `status` 最低位是 phase,驱动用它判断完成项是否有效
- **db_stride**:CQ head doorbell 的偏移是 `q_db + db_stride`,由 CAP 决定

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/NVMe驱动/nvme-queue-doorbell.html' | relative_url }}" loading="lazy" title="NVMe SQ/CQ 队列与门铃"></iframe>
  <figcaption>图 2:SQ/CQ、门铃与完成中断的交互细节。</figcaption>
</figure>

## 七、完成回收:中断上下文

命令完成后,控制器写 CQE 并触发 MSI-X,进入 `nvme_irq`(`pci.c:1862`):

```c
static irqreturn_t nvme_irq(int irq, void *data)
{
        struct nvme_queue *nvmeq = data;
        DEFINE_IO_COMP_BATCH(iob);

        if (nvme_poll_cq(nvmeq, &iob)) {
                if (!rq_list_empty(&iob.req_list))
                        nvme_pci_complete_batch(&iob);
                return IRQ_HANDLED;
        }
        return IRQ_NONE;
}
```

`nvme_poll_cq` 循环检查 phase bit,逐个处理 CQE:

```c
while (nvme_cqe_pending(nvmeq)) {
        dma_rmb();
        nvme_handle_cqe(nvmeq, iob, nvmeq->cq_head);
        nvme_update_cq_head(nvmeq);
}
if (found)
        nvme_ring_cq_doorbell(nvmeq);
```

`nvme_handle_cqe`(`pci.c:1789`)做三件事:

1. **AEN 特判**:异步事件不走 request,直接 `nvme_complete_async_event`
2. **command_id 找回 request**:`nvme_find_rq(nvme_queue_tagset(nvmeq), command_id)`
3. **取状态与结果**:`nvme_try_complete_req` 回填,失败则进入完成路径

之后 `nvme_pci_complete_rq` → `nvme_complete_rq`(`core.c:513`)→ `__nvme_complete_rq` → `__nvme_end_req` → `blk_mq_end_request` → `bio_endio`。对 buffered read,`bio_endio` 之后页缓存被填充,等待的进程被唤醒。

## 八、队列与限制

| 项目 | 规则 | 代码位置 |
|---|---|---|
| admin 队列深度 | 固定 32 | `include/linux/nvme.h:121` |
| IO 队列深度 | `min(CAP.MQES+1, io_queue_depth)`,默认 1024,范围 2–4095 | `pci.c:3460`,模块参数 `io_queue_depth` |
| IO 队列数 | `blk_mq_num_possible_queues(0) + write + poll`,受 MSI-X 向量数限制 | `pci.c:2932`、`3277` |
| shared tags quirk | 只允许 1 个 IO 队列 | `pci.c:2932` |
| 队列深度特殊值 | QDEPTH_ONE→2;PM1725→64;shared tags→AQ+2 | `pci.c:3239` 附近 |

这些限制解释了为什么"加 CPU 不一定加队列":队列数受 MSI-X 向量与驱动策略约束;而队列深度受控制器 CAP 与模块参数约束。

## 九、io_uring 命令透传

`uring_cmd` 不是普通 read 的替代品,而是一条**直达驱动**的通道:

```text
应用 IORING_OP_URING_CMD
  → io_uring_cmd
  → nvme_uring_cmd_io            drivers/nvme/host/ioctl.c:480
     → nvme_cmd_allowed(权限/白名单) ioctl.c:96
     → nvme_alloc_user_request     ioctl.c:133
     → nvme_map_user_request       ioctl.c:156
     → blk_execute_rq_nowait
  → nvme_queue_rq                  pci.c:1663
  → nvme_uring_cmd_end_io          ioctl.c:444
  → nvme_uring_task_cb / __io_uring_cmd_done
```

限制与注意点:

- `c.common.flags` 必须为 0
- `nsid` 要校验,写命令需要文件以写方式打开
- 支持固定缓冲(`IORING_URING_CMD_FIXED`)与 `NOWAIT`/`IOPOLL`
- 透传命令不经过页缓存,也不享受 VFS 的 buffered 语义

## 十、错误与恢复

NVMe 的错误处理分三层:

1. **命令级**:CQE status 非 0,`nvme_decide_disposition` 决定重试/完成/切换路径
2. **请求级**:超时后 `nvme_timeout` 先轮询 CQ(防漏中断),再决定 abort 或复位
3. **控制器级**:`nvme_reset_ctrl` → `nvme_reset_work`,状态机 `NEW → CONNECTING → LIVE → RESETTING → ...`

超时路径尤其值得注意:它先尝试"是不是漏了中断",只有在确认命令真的没完成时才 abort/复位,避免误杀。

## 十一、观测与调试

```bash
# 队列参数
cat /sys/block/nvme0n1/queue/nr_requests
cat /sys/block/nvme0n1/queue/scheduler
cat /sys/block/nvme0n1/queue/io_poll

# 设备与命名空间
nvme list
nvme id-ctrl /dev/nvme0
nvme id-ns /dev/nvme0n1

# 追踪 NVMe 命令
sudo perf trace -e nvme:nvme_setup_cmd,nvme:nvme_complete_rq -a
sudo perf stat -e block:block_rq_issue,block:block_rq_complete -a sleep 5

# IO 延迟
iostat -x 1
```

判断瓶颈时,先分清:是页缓存命中(没有块层 IO)、块层排队(队列深度/调度)、还是设备执行(IOPS/带宽/延迟)。

## 十二、常见误解

- **"read() 一定读盘"**:页缓存命中时完全不进块层。
- **"门铃每次都敲"**:`bd->last` 与批量提交会合并门铃。
- **"中断一定处理完成"**:poll 队列与 `nvme_poll` 可以完全绕过中断。
- **"队列越多越好"**:受 MSI-X 向量、CPU、控制器能力限制。
- **"uring_cmd 就是异步 read"**:它绕过页缓存,语义与普通 read 不同。

## 相关图示

- [NVMe IO 深度调用链]({{ '/linux-arch-dia/NVMe驱动/deep-nvme-io.html' | relative_url }})
- [用户态完整 I/O 路径]({{ '/linux-arch-dia/NVMe驱动/nvme-io-path.html' | relative_url }})
- [SQ/CQ 队列对与门铃]({{ '/linux-arch-dia/NVMe驱动/nvme-queue-doorbell.html' | relative_url }})
- [NVMe 控制器状态机]({{ '/linux-arch-dia/NVMe驱动/nvme-ctrl-states.html' | relative_url }})
- [块层 IO 深度调用链]({{ '/linux-arch-dia/设备驱动/deep-block-io.html' | relative_url }})

> 源码基线:Linux `d487237`(v7.4.0-rc1)。行号会随内核版本漂移,以图集仓库重新 finalize 后的结果为准。
