---
layout: post
title: "fork() 到底复制了什么:从 kernel_clone 到 wake_up_new_task"
date: 2026-11-05
categories: [kernel-deep]
description: 一次 fork 的逐函数深读:task_struct、COW、copy_thread 与子进程返回 0 的来由
---
内核精读 · 进程管理 · 源码基线 v7.4.0-rc1

`fork()` 常被概括为"复制一个进程",但内核真正复制的是一组**受控的引用与状态**:地址空间用写时复制共享,文件表引用计数加一,信号处理与命名空间按需复制,最后为子进程伪造一份"从系统调用返回 0"的上下文。本文沿 v7.4.0-rc1 源码把这条路径拆到函数级,并给出数据结构、失败路径与观测方法。


## 一、全景:从系统调用到运行队列

先看一张可交互的函数级调用图。节点就是函数,箭头是调用关系,所有符号都对应真实源码。

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/进程管理/deep-process-create.html' | relative_url }}" loading="lazy" title="fork 创建进程深度调用链"></iframe>
  <figcaption>图 1:fork() 创建进程的深度调用链(可缩放、可导出)。</figcaption>
</figure>

```text
SYSCALL_DEFINE0(fork)             — kernel/fork.c:2879
└─ kernel_clone                   — kernel/fork.c:2744
   ├─ copy_process                — kernel/fork.c:2029
   │  ├─ dup_task_struct          — kernel/fork.c:916
   │  ├─ sched_fork               — kernel/sched/core.c:4876
   │  ├─ copy_files               — kernel/fork.c:1676
   │  ├─ copy_fs                  — kernel/fork.c:1634
   │  ├─ copy_sighand             — kernel/fork.c:1707
   │  ├─ copy_signal              — kernel/fork.c:1756
   │  ├─ copy_mm                  — kernel/fork.c:1575
   │  ├─ copy_namespaces          — kernel/fork.c:2331 附近
   │  ├─ copy_io                  — kernel/fork.c:2334 附近
   │  ├─ copy_thread              — arch/x86/kernel/process.c:170
   │  ├─ alloc_pid                — kernel/fork.c:2344 附近
   │  └─ ...                      — 安全/审计/cgroup 等收尾
   └─ wake_up_new_task            — kernel/sched/core.c:5014
```

几个容易被忽略的事实:

- `fork` 不是单独的实现,它和 `clone`/`clone3`/`vfork` 最终都汇入 `kernel_clone`。
- 复制顺序不是随意的:`sched_fork` 在多数资源复制之前,先给子进程一个调度器状态;真正让它可运行的是 `wake_up_new_task`。
- `copy_process` 内部还会做安全钩子、cgroup、审计、PID 分配等大量收尾工作,本文只展开与"复制"最相关的部分。

## 二、task_struct:被复制的"控制块"

`fork` 的第一件事不是复制内存,而是复制进程控制块 `task_struct`。它把进程的地址空间、文件、信号、命名空间、调度状态、寄存器上下文都挂在这个结构上:

<div class="tree-map" role="img" aria-label="task_struct 资源树">
  <div class="tree-map-head">
    <span class="tree-map-title">task_struct 资源树</span>
    <span class="tree-map-note">括号内为复制函数</span>
  </div>
  <ul>
    <li>
      <div class="tree-card tone-slate">
        <span class="tree-label">task_struct</span>
        <span class="tree-sub">进程控制块</span>
      </div>
      <ul>
        <li><div class="tree-card tone-green"><span class="tree-label">mm / active_mm</span><span class="tree-sub">地址空间 · dup_mm(COW)</span></div></li>
        <li><div class="tree-card tone-blue"><span class="tree-label">files</span><span class="tree-sub">打开文件表 · copy_files(引用计数 +1)</span></div></li>
        <li><div class="tree-card tone-violet"><span class="tree-label">fs</span><span class="tree-sub">根目录 / cwd · copy_fs</span></div></li>
        <li><div class="tree-card tone-amber"><span class="tree-label">sighand</span><span class="tree-sub">信号处理函数表 · copy_sighand</span></div></li>
        <li><div class="tree-card tone-rose"><span class="tree-label">signal</span><span class="tree-sub">信号队列 / 定时器 · copy_signal</span></div></li>
        <li><div class="tree-card tone-teal"><span class="tree-label">nsproxy</span><span class="tree-sub">命名空间 · copy_namespaces</span></div></li>
        <li><div class="tree-card tone-slate"><span class="tree-label">io_context</span><span class="tree-sub">IO 上下文 · copy_io</span></div></li>
        <li><div class="tree-card tone-blue"><span class="tree-label">thread</span><span class="tree-sub">寄存器 / 内核栈 · copy_thread</span></div></li>
      </ul>
    </li>
  </ul>
</div>

`dup_task_struct` 负责"骨架":

```c
tsk = alloc_task_struct_node(node);
err = arch_dup_task_struct(tsk, orig);      /* 整块拷贝 task_struct */
err = alloc_thread_stack_node(tsk, node);   /* 分配内核栈 */
...
setup_thread_stack(tsk, orig);              /* 设置栈指针/栈顶魔数 */
```

对应 `kernel/fork.c:916-960`。注意它只复制结构体和栈,**不复制地址空间内容**;地址空间由后面的 `copy_mm` 处理。

## 三、kernel_clone:校验、trace 与 vfork

`kernel_clone` 负责参数校验和公共流程(见 `kernel/fork.c:2744`):

```c
if ((clone_flags & CLONE_PIDFD) &&
    (clone_flags & CLONE_PARENT_SETTID) &&
    (args->pidfd == args->parent_tid))
        return -EINVAL;

if (!(clone_flags & CLONE_UNTRACED)) {
        if (clone_flags & CLONE_VFORK)
                trace = PTRACE_EVENT_VFORK;
        else if (args->exit_signal != SIGCHLD)
                trace = PTRACE_EVENT_CLONE;
        else
                trace = PTRACE_EVENT_FORK;
}

p = copy_process(NULL, trace, NUMA_NO_NODE, args);
...
wake_up_new_task(p);
```

这里决定了 `ptrace` 看到的 fork/clone/vfork 事件类型,以及是否要向调试器报告。之后:

- 普通 `fork`:`wake_up_new_task` 后返回子进程 PID
- `CLONE_VFORK`:`wait_for_vfork_done` 等子进程 `exec` 或 `exit` 后才返回
- `clone3`:`CLONE_PIDFD` 返回 pidfd,`set_tid` 指定 PID

### clone 标志决定"共享还是复制"

`copy_*` 函数几乎都受 `clone_flags` 控制,这是 `fork` 与 pthread 共用一条路径的原因:

| 标志 | 含义 | 典型场景 |
|---|---|---|
| `CLONE_VM` | 共享地址空间 | 线程 |
| `CLONE_FS` | 共享根目录/工作目录 | 线程 |
| `CLONE_FILES` | 共享文件描述符表 | 线程 |
| `CLONE_SIGHAND` | 共享信号处理函数 | 线程 |
| `CLONE_THREAD` | 同线程组,共享 `signal` | 线程 |
| `CLONE_NEWNS` | 新建 mount namespace | 容器 |
| `CLONE_NEWPID` | 新建 PID namespace | 容器 |
| `CLONE_IO` | 共享 IO 上下文 | 线程 |

`fork()` 不传这些标志,所以是"复制";`pthread_create` 传入 `CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|...`,所以是"共享"。

## 四、copy_process:复制顺序与失败回滚

`copy_process` 的顺序很关键(节选自 `kernel/fork.c:2296-2344`):

```c
retval = sched_fork(clone_flags, p);
retval = copy_files(clone_flags, p, args->no_files);
retval = copy_fs(clone_flags, p, args->fs, args->no_files);
retval = copy_sighand(clone_flags, p);
retval = copy_signal(clone_flags, p);
retval = copy_mm(clone_flags, p);
retval = copy_namespaces(clone_flags, p);
retval = copy_io(clone_flags, p);
retval = copy_thread(p, args);
...
pid = alloc_pid(p->nsproxy->pid_ns_for_children, args->set_tid, ...);
```

为什么先 `sched_fork`?因为它把子进程标记为 `TASK_NEW`,保证在资源复制完成前**不会被调度器选中,也不会被信号唤醒**。这避免了"半初始化任务"进入运行队列。

每一步失败都会跳到对应的 `bad_fork_cleanup_*` 标签,逆序释放已经复制的资源。常见失败点:

| 失败点 | 触发条件 | 清理 |
|---|---|---|
| `copy_process` 校验 | 非法 clone 标志组合 | 直接返回 `-EINVAL` |
| `dup_task_struct` | 内存不足 | 释放 task_struct/栈 |
| `copy_sighand` | 分配失败 | 释放 files/fs |
| `copy_mm` | `dup_mm` 失败 | 释放信号/文件/fs |
| `alloc_pid` | PID 耗尽/受限 | 释放 mm/namespaces |
| `sched_fork` | 实时调度带宽/优先级限制 | 走调度策略清理 |

此外还有 `RLIMIT_NPROC`、cgroup `pids.max`、seccomp、LSM 等钩子会在不同阶段拦截。

## 五、copy_mm:COW 的真相

`copy_mm` 只在 `CLONE_VM` 时共享,否则复制页表(`kernel/fork.c:1575`):

```c
if (clone_flags & CLONE_VM) {
        mmget(oldmm);
        mm = oldmm;
} else {
        mm = dup_mm(tsk, current->mm);
        if (!mm)
                return -ENOMEM;
}
```

`dup_mm` 复制的是 `mm_struct` 与**页表项**,不是物理页。对可写的私有映射,内核会把父子双方的 PTE 标记为只读,并让它们指向同一物理页;任一方写入时触发缺页,进入 `do_wp_page` 才真正复制一页。这就是写时复制(COW)。

可以用一段伪代码理解这个过程:

```text
fork:
  parent PTE(addr) ──┐
                     ├──> 物理页 P(只读,mapcount = 2)
  child  PTE(addr) ──┘

child 写 addr:
  #PF(WRITE) → do_wp_page:
    分配新页 P'
    复制 P 的内容到 P'
    child PTE(addr) ──> P'(可写)
  P 的 mapcount 减一
```

因此:

- `fork` 的主要成本是页表复制与结构体复制,不是整块内存拷贝
- 如果父进程或子进程随后大量写入,COW 会把成本"推迟"到缺页路径
- `vfork`/`CLONE_VM` 连页表都不复制,父子共享同一地址空间,所以 `vfork` 要求子进程尽快 `exec`/`exit`

COW 的细节(页表锁、TLB flush、rmap、`page_count`)在《一次缺页异常都经历了什么》中有完整展开。

## 六、copy_thread:子进程为什么返回 0

这是 fork 语义最精巧的地方。`copy_thread` 在 x86 上做三件事(`arch/x86/kernel/process.c:170`):

```c
frame->ret_addr = (unsigned long) ret_from_fork_asm;
p->thread.sp = (unsigned long) fork_frame;
...
*childregs = *current_pt_regs();
childregs->ax = 0;
if (sp)
        childregs->sp = sp;
```

- 构造一个内核栈帧,返回地址指向 `ret_from_fork_asm`
- 复制父进程的用户态寄存器(`pt_regs`)
- **把返回寄存器 `ax` 置 0**

子进程第一次被调度时,从 `ret_from_fork_asm` 返回用户态,恢复的是这份被修改过的 `pt_regs`,于是 `fork()` 在子进程里表现为返回 0。父进程则继续执行,拿到 `kernel_clone` 返回的 PID。

内核线程走的是另一条分支:如果 `args->fn` 非空,`copy_thread` 会把 `childregs->sp/ip` 置 0,并用 `kthread_frame_init` 把返回地址设为内核函数,这就是 `kthread_create` 的实现基础。

## 七、sched_fork 与 wake_up_new_task

`sched_fork`(`kernel/sched/core.c:4876`)先给子进程一个"不可运行"的初始状态:

```c
p->__state = TASK_NEW;
p->prio = current->normal_prio;
uclamp_fork(p);
...
if (rt_prio(p->prio)) p->sched_class = &rt_sched_class;
else if (task_should_scx(p->policy)) p->sched_class = &ext_sched_class;
else p->sched_class = &fair_sched_class;
```

`wake_up_new_task`(`kernel/sched/core.c:5014`)才真正把它变成可运行:

```c
WRITE_ONCE(p->__state, TASK_RUNNING);
p->recent_used_cpu = task_cpu(p);
__set_task_cpu(p, select_task_rq(p, task_cpu(p), &wake_flags));
rq = __task_rq_lock(p, &rf);
update_rq_clock(rq);
activate_task(rq, p, ENQUEUE_NOCLOCK | ENQUEUE_INITIAL);
wakeup_preempt(rq, p, wake_flags);
```

注意 `select_task_rq` 会做**fork 负载均衡**,子进程可能被放到空闲 CPU 上;`wakeup_preempt` 决定是否抢占当前任务。`fork` 返回时子进程已经 runnable,但不保证已经运行。

## 八、观测与调试

**tracepoint**:`sched_process_fork` 会记录父子 PID、comm;`sched_wakeup_new` 记录新任务入队。

```bash
# 观察 fork/wakeup
sudo perf trace -e sched:sched_process_fork,sched:sched_wakeup_new -a

# 统计每秒 fork 次数
sudo perf stat -e sched:sched_process_fork -a sleep 5

# 用 bpftrace 抓 kernel_clone 的参数(示意)
sudo bpftrace -e 'kprobe:kernel_clone { printf("clone flags=%lx\n", arg0); }'
```

**/proc**:`/proc/<pid>/status` 的 `Threads`、`VmSize`、`VmRSS` 可以观察 fork 后的地址空间变化;`/proc/<pid>/maps` 可以看到 COW 前后的映射。

**常见现象**:

- fork 后 `VmRSS` 不会立刻翻倍(物理页共享)
- 子进程大量写入后 RSS 才逐步上升(COW 复制)
- `vmstat` 的 `pgfault`/`pgmajfault` 会随着 COW 与换入变化

## 九、常见误解

- **"fork 会复制内存"**:物理页通常共享,写入才复制。
- **"子进程马上运行"**:只是变为 runnable,由调度器决定。
- **"fork 与 clone 是两套实现"**:最终都走 `kernel_clone`。
- **"copy_thread 只是保存寄存器"**:它还负责伪造返回值、内核线程入口、TLS、shadow stack 等。
- **"COW 一定更快"**:读多写少时更快;写多时缺页与复制成本会显现。

## 相关图示

- [fork() 创建进程深度调用链]({{ '/linux-arch-dia/进程管理/deep-process-create.html' | relative_url }})
- [fork() 创建进程时序图]({{ '/linux-arch-dia/进程管理/fork-process-creation.html' | relative_url }})
- [进程状态机]({{ '/linux-arch-dia/进程管理/process-states.html' | relative_url }})
- [上下文切换]({{ '/linux-arch-dia/进程管理/context-switch.html' | relative_url }})

> 源码基线:Linux `d487237`(v7.4.0-rc1)。行号会随内核版本漂移,以图集仓库重新 finalize 后的结果为准。
