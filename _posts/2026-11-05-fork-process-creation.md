---
layout: post
title: "fork() 到底复制了什么:从 kernel_clone 到 wake_up_new_task"
date: 2026-11-05
categories: [kernel-deep]
description: 一次 fork 的逐函数走读,以及 COW、copy_thread 与子进程返回 0 的来由
---
[打开可交互深度调用链]({{ '/linux-arch-dia/进程管理/deep-process-create.html' | relative_url }})

`fork()` 常被概括为"复制一个进程",但内核真正复制的是一组**受控的引用与状态**:地址空间用写时复制共享,文件表引用计数加一,信号处理与命名空间按需复制,最后为子进程伪造一份"从系统调用返回 0"的上下文。下面沿 v7.4.0-rc1 源码逐函数走一遍。

## 全景调用链

```text
SYSCALL_DEFINE0(fork)      kernel/fork.c:2879
  kernel_clone             kernel/fork.c:2744
    copy_process           kernel/fork.c:2029
      dup_task_struct      kernel/fork.c:916
      sched_fork           kernel/sched/core.c:4876
      copy_files           kernel/fork.c:1676
      copy_fs              kernel/fork.c:1634
      copy_sighand         kernel/fork.c:1707
      copy_signal          kernel/fork.c:1756
      copy_mm              kernel/fork.c:1575
      copy_thread          arch/x86/kernel/process.c:170
    wake_up_new_task       kernel/sched/core.c:5014
```

注意顺序:`sched_fork` 在多数资源复制之前调用,它负责把新任务放入调度器的初始状态;真正让子进程可运行的是最后的 `wake_up_new_task`。

## 关键步骤

**1. dup_task_struct:先有骨架**

为子进程分配 `task_struct` 与内核栈,并把父进程的结构体整体拷贝过来,随后把引用计数、锁、待处理信号等字段重置为"新任务"的初值。此时子进程还没有自己的地址空间内容。

**2. copy_mm:不是复制内存,而是复制页表 + COW**

匿名页与文件页的物理页不会立即复制。内核复制页表项并把可写映射标记为只读,父子进程共享物理页;任一方写入触发缺页,`do_wp_page` 才真正复制一页(写时复制)。因此 `fork` 的成本主要是页表与结构体,而不是整块内存。

**3. copy_files / copy_fs / copy_sighand / copy_signal**

- `copy_files`:复制文件描述符表,底层 `struct file` 引用计数加一
- `copy_fs`:复制 `fs_struct`(根目录、当前工作目录),通常共享或按 `CLONE_FS` 决定
- `copy_sighand`:共享或复制信号处理函数表
- `copy_signal`:复制信号队列、定时器等每进程状态

**4. copy_thread:子进程为什么返回 0**

这是 fork 语义的关键。内核为子进程构造一份保存的寄存器上下文,把返回值寄存器设为 0;父进程则继续执行并拿到子进程 PID。子进程第一次被调度时,从这份伪造的上下文"返回用户态",于是 `fork()` 在子进程里表现为返回 0。

**5. wake_up_new_task:放进运行队列**

子进程被标记为可运行并加入调度器。是否立刻抢占父进程,取决于调度策略与 CPU 状态,而不是 fork 本身。

## 常见误解

- **"fork 会复制内存"**:物理页通常是共享的,写入才复制。
- **"子进程马上运行"**:只是变为 runnable,真正运行由调度器决定。
- **"返回值靠两个不同的函数实现"**:父子走的是同一条返回路径,区别在保存的返回寄存器值。

## 相关图示

- [fork() 创建进程深度调用链]({{ '/linux-arch-dia/进程管理/deep-process-create.html' | relative_url }})
- [fork() 创建进程时序图]({{ '/linux-arch-dia/进程管理/fork-process-creation.html' | relative_url }})
- [进程状态机]({{ '/linux-arch-dia/进程管理/process-states.html' | relative_url }})

> 源码基线:Linux `d487237`(v7.4.0-rc1)。行号会随内核版本漂移,以图集仓库重新 finalize 后的结果为准。
