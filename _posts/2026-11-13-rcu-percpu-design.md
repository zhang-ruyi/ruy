---
layout: post
title: "内核设计精妙:RCU、per-CPU 与无锁读"
date: 2026-11-13
categories: [kernel-deep]
description: 从 grace period 到 this_cpu_inc:读多写少场景下,RCU、per-CPU、seqlock 与 refcount 如何把读侧开销压到接近零
---
内核精读 · 并发/RCU · 源码基线 v7.4.0-rc1

并发编程里有一个朴素的规律:**读多写少的场景,不应该让读者为写者买单**。互斥锁的问题是读也要抢同一个缓存行;读写锁的问题是读者仍要原子地修改锁状态;引用计数的问题是每次读都要 `lock inc`。Linux 内核给出的答案是一组互补的机制:RCU 让读者几乎零开销地拿到一个"至少在当前 grace period 内有效"的对象,per-CPU 变量让每个 CPU 写自己的副本从而避免缓存行 bouncing,seqlock 让读者用"读—校验—重试"换取无锁快照,refcount 则负责对象生命周期的最后一道闸门。

本文不打算把 RCU 讲成一组 API 清单,而是从"为什么读侧可以这么快"出发,逐步展开 grace period、发布/订阅、per-CPU、顺序锁、引用计数和内存屏障,最后用 dcache、路由表、网络收包、进程遍历四个真实例子说明它们如何组合。


## 一、先算一笔账:读多写少到底贵在哪

假设有一个全局链表,读者只遍历,写者偶尔插入或删除。用互斥锁保护时,每次读都要:

1. 原子地修改锁字(独占缓存行)
2. 可能睡眠或自旋
3. 读完后再次原子地解锁

即使读操作本身只是几次指针跟随,锁也把成本抬高了一个数量级,而且**所有 CPU 的读者都在争抢同一个缓存行**。核越多,缓存行 bouncing 越严重,扩展性越差。

RCU 的核心洞察是:**如果读者只要求"我遍历期间对象不要被释放",而不要求"我看到最新版本",那么读侧就根本不需要写任何共享状态**。写者可以先把新版本挂上去,等所有"可能还持有旧指针"的读者都离开后,再释放旧版本。这段等待期就是 grace period。

| 机制 | 读侧开销 | 写侧开销 | 适用场景 |
|---|---|---|---|
| mutex | 原子加锁/解锁,可能睡眠 | 原子加锁/解锁 | 读写都少、临界区长 |
| rwlock | 原子修改读者计数 | 等待读者清空 | 读多写少但临界区短 |
| seqlock | 读序列号 + 重试 | 序列号自增 + 屏障 | 小而一致的快照 |
| RCU | 几乎为零(禁抢占/屏障) | 等待 grace period | 读极多、写极少 |
| per-CPU | 本 CPU 读写,无原子 | 需汇总或迁移处理 | 统计计数、每 CPU 队列 |
| refcount | 一次原子加减 | 一次原子加减 | 对象生命周期管理 |

这张表不是"谁替代谁",而是"谁负责哪一段"。真实内核代码往往是 RCU + per-CPU + refcount 的组合。

## 二、RCU 读侧:为什么几乎零开销

RCU 读侧的典型写法只有三行:

```c
rcu_read_lock();
p = rcu_dereference(gp);
if (p)
        do_something(p);
rcu_read_unlock();
```

`rcu_read_lock` 在 `include/linux/rcupdate.h:844` 定义,它最终调用 `__rcu_read_lock`。在 PREEMPT_RCU 下,这个函数维护的是当前任务的嵌套计数;在非 PREEMPT_RCU 下,它退化成一件事——`preempt_disable()`(`include/linux/rcupdate.h:110`):

```c
static inline void __rcu_read_lock(void)
{
        preempt_disable();
}

static inline void __rcu_read_unlock(void)
{
        if (IS_ENABLED(CONFIG_RCU_STRICT_GRACE_PERIOD))
                rcu_read_unlock_strict();
        preempt_enable();
}
```

注意它**没有原子指令、没有全局计数器、没有写共享缓存行**。读侧只是告诉内核"我进入了一个不能被打断的区间",而这个信息记录在 CPU 本地或当前任务上,不需要跨核同步。这就是 RCU 读侧接近零开销的根本原因。

`rcu_dereference` 也不是普通读。它定义在 `include/linux/rcupdate.h:751`,内部走 `rcu_dereference_check`,最终用 `READ_ONCE` 读取指针,并保留数据依赖顺序:

```c
#define __rcu_dereference_raw(p, local) \
({ \
        typeof(p) local = READ_ONCE(p); \
        ((TYPEOF_NO_ADDRESS_SPACE(*p) __force __kernel *)(local)); \
})
```

`READ_ONCE` 防止编译器把指针读取拆开或缓存到寄存器里多次读;数据依赖则保证"先读到指针,再解引用它指向的字段"的顺序不会被 CPU 重排。对绝大多数架构,这已经足够;历史上 Alpha 需要额外的读屏障,现代内核把这层复杂性封装在 `rcu_dereference` 里。

### 发布/订阅:写者如何安全地挂上新版本

写者不能简单地 `gp = new`,因为编译器和 CPU 都可能把"初始化 new 的字段"重排到"发布指针"之后。正确做法是:

```c
struct obj *new = kmalloc(sizeof(*new), GFP_KERNEL);
new->a = 1;
new->b = 2;

rcu_assign_pointer(gp, new);   /* 发布:保证初始化先于指针可见 */
```

`rcu_assign_pointer`(`include/linux/rcupdate.h:567`)的核心是 `smp_store_release`:

```c
#define rcu_assign_pointer(p, v) \
context_unsafe( \
        uintptr_t _r_a_p__v = (uintptr_t)(v); \
        rcu_check_sparse(p, __rcu); \
        if (__builtin_constant_p(v) && (_r_a_p__v) == (uintptr_t)NULL) \
                WRITE_ONCE((p), (typeof(p))(_r_a_p__v)); \
        else \
                smp_store_release(&p, RCU_INITIALIZER((typeof(p))_r_a_p__v)); \
)
```

`smp_store_release` 是"release 语义"的写:它保证此前的所有写操作,在指针值对其他 CPU 可见之前已经完成。读者用 `rcu_dereference` 读取时,配合数据依赖,就能看到完整初始化的对象。这一对操作构成了 RCU 的**发布/订阅模型**。

## 三、grace period:写者到底在等什么

RCU 的写者分成两类:

- `synchronize_rcu()`:阻塞等待一个 grace period 结束
- `call_rcu()`:登记一个回调,grace period 结束后由内核调用

`call_rcu` 在 `kernel/rcu/tree.c:3393`:

```c
void call_rcu(struct rcu_head *head, rcu_callback_t func)
{
        __call_rcu_common(head, func, enable_rcu_lazy);
}
```

`rcu_head` 其实就是 `callback_head`(`include/linux/types.h:254`、`258`),里面只有 `next` 和 `func` 两个字段。回调登记后进入当前 CPU 的 callback 链表(`rcu_segcblist_enqueue`,`kernel/rcu/tree.c:3050`),由 RCU 的 grace-period kthread(`rcu_gp_kthread`,`kernel/rcu/tree.c:2304`)推进。

一个 grace period 的直观定义是:

> 所有在 grace period 开始之前就已经进入的 RCU 读侧临界区,都已经结束。

注意它只保证"旧的读侧临界区结束",不保证"未来不会再有新读者",也不保证读者看到的是最新值。这正是 RCU 语义的边界,也是它便宜的原因。

`synchronize_rcu`(`kernel/rcu/tree.c:3494`)是阻塞版本,它内部可能走 `synchronize_rcu_normal`(`kernel/rcu/tree.c:3421`),把当前任务挂到一个等待队列,等 GP 完成后再唤醒。它的注释写得很清楚:返回后,**之前开始的读侧临界区都已经完成,并且每个 CPU 都执行了一次完整内存屏障**。这给了写者一个强有力的保证:GP 结束后,旧读者不可能还持有旧指针。

写者的典型回收模式是:

```c
old = rcu_dereference_protected(gp, lockdep_is_held(&writer_lock));
rcu_assign_pointer(gp, new);
synchronize_rcu();
kfree(old);
```

如果不想阻塞,就换成:

```c
static void obj_free_rcu(struct rcu_head *head)
{
        struct obj *o = container_of(head, struct obj, rcu);
        kfree(o);
}

call_rcu(&old->rcu, obj_free_rcu);
```

`call_rcu` 的代价是**回收延迟**:旧对象要等到 GP 结束才释放。GP 的长度取决于读侧临界区的长度、CPU 是否处于 idle、是否有任务长时间不进入 quiescent state。这也是 RCU 最容易被忽视的成本:内存不会立刻回来。

## 四、per-CPU:把共享变成"各写各的"

RCU 解决的是"读侧不要抢共享状态",per-CPU 解决的是"写侧也不要抢同一个缓存行"。

看一个最简单的计数器:

```c
DEFINE_PER_CPU(long, counter);

void inc_counter(void)
{
        this_cpu_inc(counter);
}

long read_counter(void)
{
        int cpu;
        long sum = 0;

        for_each_possible_cpu(cpu)
                sum += per_cpu(counter, cpu);
        return sum;
}
```

`DEFINE_PER_CPU`(`include/linux/percpu-defs.h:108`)为每个 CPU 分配一份独立副本。`this_cpu_inc`(`include/linux/percpu-defs.h:506`)展开成 `this_cpu_add(pcp, 1)`,再按变量大小选择 `this_cpu_add_1/2/4/8`。在 x86 上,`PER_CPU_VAR` 使用 `%gs` 段前缀(`arch/x86/include/asm/percpu.h:77`),最终生成一条"段相对"的加法指令:

```text
incq %gs:counter(%rip)
```

这条指令**没有 `lock` 前缀,不需要总线锁,也不会修改其他 CPU 的缓存行**。每个 CPU 只写自己那份数据,缓存行一直处于自己的 L1/L2 中,自然没有 bouncing。核数越多,收益越明显。

`per_cpu_ptr`(`include/linux/percpu-defs.h:232`)则用于"访问指定 CPU 的副本":

```c
long *p = per_cpu_ptr(&counter, cpu);
```

它把变量地址加上目标 CPU 的 per-CPU 偏移(`per_cpu_offset(cpu)`)得到实际地址。`this_cpu_ptr`(`include/linux/percpu-defs.h:245`)是"当前 CPU"的快捷方式,等价于 `per_cpu_ptr(ptr, smp_processor_id())`。

几个必须注意的点:

- per-CPU 变量是"每 CPU",不是"每任务"。任务迁移后,`this_cpu_ptr` 指向的副本会变。
- `this_cpu_*` 操作对抢占是安全的,但**不保证对中断/NMI 原子**。如果同一份 per-CPU 数据会在进程上下文和中断上下文同时修改,仍然需要额外的锁或使用 `atomic_t`。
- `__this_cpu_*` 变体要求调用者已经禁用抢占,内核用它在已知上下文中省掉检查。
- 需要跨 CPU 汇总时,`per_cpu` 读取不是原子的;通常接受"近似值",或者用序列号/锁保证一致性。

网络收包就是 per-CPU 的经典用法。`softnet_data` 每 CPU 一份(`include/linux/netdevice.h:3632`,`net/core/dev.c:464`),收包时直接增加本 CPU 的计数(`net/core/dev.c:6231`):

```c
__this_cpu_inc(softnet_data.processed);
```

没有锁,没有原子指令,也不会让所有 CPU 争抢同一个 `processed` 字段。

## 五、seqlock:无锁读的"乐观快照"

RCU 适合"指针指向的对象不变,只是替换指针";如果读者需要读取一组会原地更新的字段,就需要 seqlock。

seqlock 的基本思想是:**写者修改数据前后各把序列号加一,读者读序列号、读数据、再读序列号;如果两次序列号一致且为偶数,说明读到的是一份一致快照,否则重试。**

写侧:

```c
write_seqcount_begin(&s);
data.field1 = new1;
data.field2 = new2;
write_seqcount_end(&s);
```

`write_seqcount_begin`(`include/linux/seqlock.h:492`)最终调用 `do_write_seqcount_begin`;底层 `do_raw_write_seqcount_begin`(`include/linux/seqlock.h:429`)先把 `sequence` 加一,再执行 `smp_wmb()`。结束时再执行 `smp_wmb()`,然后把 `sequence` 加一(`include/linux/seqlock.h:450`)。序列号为奇数表示"正在写",偶数表示"稳定"。

读侧:

```c
unsigned int seq;
struct snapshot snap;

do {
        seq = read_seqcount_begin(&s);
        snap = data;
} while (read_seqcount_retry(&s, seq));
```

`read_seqcount_begin`(`include/linux/seqlock.h:297`)读取序列号并等待其稳定;`read_seqcount_retry`(`include/linux/seqlock.h:406`)先执行 `smp_rmb()`,再比较序列号是否变化。如果写者在中途开始或结束,读者就会失败并重试。

seqlock 的取舍非常明确:

- 读侧无锁,适合读多写少
- 写侧仍然需要互斥(通常用 spinlock)保证写者之间串行
- 读者可能重试,数据越大、写越频繁,重试成本越高
- 不适合"读侧需要长时间持有快照"的场景

dcache 里的 `rename_lock`(`fs/dcache.c:87`)就是 seqlock:目录重命名时修改父链,路径查找时用序列号检测冲突。dentry 自身的 `d_seq` 也是 seqcount,在 `dentry_unlink_inode`(`fs/dcache.c:485`)等地方用 `raw_write_seqcount_begin/end` 保护字段更新。

## 六、refcount:生命周期的最后一道闸门

RCU 保证"GP 期间对象不会被释放",但它不负责"对象什么时候该释放"。引用计数负责这件事。

```c
refcount_inc(&o->refs);

if (refcount_dec_and_test(&o->refs))
        kfree(o);
```

`refcount_inc`(`include/linux/refcount.h:381`)和 `refcount_dec_and_test`(`include/linux/refcount.h:448`)用的是原子操作,但它们和普通 `atomic_t` 的区别在于**溢出/下溢保护**:

- 计数器到达 `INT_MAX` 时 saturate,不会回绕
- 从 0 再减会触发 warning,防止 use-after-free 被掩盖
- `refcount_dec_and_test` 带 release 语义,确保对象内容在释放前对其他 CPU 可见

refcount 和 RCU 经常配合使用:

```text
查找:rcu_read_lock(); p = rcu_dereference(gp);
      if (p && refcount_inc_not_zero(&p->refs))
              /* 拿到强引用,可以离开 RCU 读侧 */
      rcu_read_unlock();

释放:if (refcount_dec_and_test(&p->refs))
              call_rcu(&p->rcu, free_p);
```

`refcount_inc_not_zero` 的意义是:如果对象正在被释放(计数已经为 0),就不要"复活"它。这样即使查找和释放并发,也不会出现引用一个已死对象的情况。

## 七、内存屏障:只记住三个直觉

RCU、seqlock、per-CPU 都绕不开内存屏障。初学阶段不必背下所有组合,先建立三个直觉:

1. **`smp_mb()` 是全能屏障**:它保证屏障前的读写不会被重排到屏障后,反之亦然。代价最大。
2. **`smp_rmb()`/`smp_wmb()` 是单向屏障**:分别约束读-读和写-写。seqlock 用 `smp_wmb()` 保证"数据写完再发布序列号",用 `smp_rmb()` 保证"先读序列号再读数据"。
3. **acquire/release 是配对的**:`smp_store_release` 保证之前的写先完成,`smp_load_acquire` 保证之后的读后发生。`rcu_assign_pointer` 用 release,`rcu_dereference` 依赖 `READ_ONCE` 和数据依赖。

这些定义在 `include/asm-generic/barrier.h:99`、`103`、`107`、`172`、`176`。在 x86 这种强一致模型上,很多屏障会退化成编译器屏障,但在 ARM/POWER 上它们是真实指令。写可移植代码时,**不要假设 x86 的顺序**。

## 八、实例一:dcache 查找

路径查找是 RCU 最经典的应用。`__d_lookup_rcu`(`fs/dcache.c:2560`)在无锁情况下遍历哈希桶:

```c
seq = raw_seqcount_begin(&dentry->d_seq);
if (dentry->d_parent != parent)
        continue;
if (dentry->d_name.hash_len != hashlen)
        continue;
if (unlikely(dentry_cmp(dentry, str, hashlen_len(hashlen)) != 0))
        continue;
if (unlikely(d_unhashed(dentry)))
        continue;
*seqp = seq;
return dentry;
```

读者不需要拿 `d_lock`,只需要在最后用 `read_seqcount_retry` 校验 `d_seq`。如果期间发生了 rename 或 unlink,序列号会变化,查找失败并退回带锁路径。`d_lookup`(`fs/dcache.c:2648`)则用 `rename_lock` 这个 seqlock 包住整个查找,防止并发 rename 把父链改乱。

这套组合的收益是:在绝大多数情况下,路径查找完全不需要写共享状态,也不需要拿自旋锁。代价是代码要处理 `-ECHILD` 重试路径,可读性不如一把大锁。

## 九、实例二:路由表

路由查找同样是读多写少。`fib_table_lookup`(`net/ipv4/fib_trie.c:1418`)在 RCU 读侧遍历 trie,调用者负责 `rcu_read_lock`。例如 `net/ipv4/fib_frontend.c:241`:

```c
rcu_read_lock();

table = fib_get_table(net, tb_id);
if (table) {
        ret = RTN_UNICAST;
        if (!fib_table_lookup(table, &fl4, &res, FIB_LOOKUP_NOREF)) {
                ...
        }
}

rcu_read_unlock();
```

`fib_table_lookup` 内部用 `rcu_dereference_rtnl` 读取子节点(`net/ipv4/fib_trie.c:200`),写者在更新路由时替换指针,旧节点通过 `call_rcu` 延迟释放:

```c
#define node_free(n) call_rcu(&tn_info(n)->rcu, __node_free_rcu)
```

对应的回调在 `net/ipv4/fib_trie.c:303`,删除整张表时在 `2238` 调用 `call_rcu`。`fib_info` 的释放走 `call_rcu_hurry`(`net/ipv4/fib_semantics.c:245`),`hurry` 版本会尽快触发 GP,减少内存驻留。

这里还能看到 per-CPU 统计:每次查表 `this_cpu_inc(stats->gets)`(`net/ipv4/fib_trie.c:1442`),避免所有 CPU 争抢同一个统计计数器。

## 十、实例三:网络收包

网络栈是 per-CPU + RCU + 下半部的集中展示。每个 CPU 有独立的 `softnet_data` 队列,收包时进入软中断上下文,直接操作本 CPU 的数据:

```text
网卡中断 → napi_schedule → NET_RX_SOFTIRQ
→ net_rx_action → napi_poll → netif_receive_skb
→ __netif_receive_skb_core
```

`__netif_receive_skb_core`(`net/core/dev.c:6197`)里先增加本 CPU 的收包计数(`net/core/dev.c:6231`),然后遍历 `ptype_all` 链表:

```c
list_for_each_entry_rcu(ptype, &dev_net_rcu(skb->dev)->ptype_all, list) {
        ...
}
```

这个链表用 RCU 保护:协议处理程序注册/注销时替换指针,收包路径只读遍历。`netif_receive_skb`(`net/core/dev.c:6687`)通常在软中断里调用,此时抢占已经被禁用,天然构成 RCU 读侧临界区的一部分。

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/进程管理/bottom-half.html' | relative_url }}" loading="lazy" title="中断下半部三机制对比"></iframe>
  <figcaption>图 1:tasklet、softirq、workqueue 三种下半部机制,对应不同的执行上下文与回收时机。</figcaption>
</figure>

这张图虽然讲的是下半部,但它解释了为什么网络收包路径可以放心使用 per-CPU:软中断在固定 CPU 上执行,`softnet_data` 的副本不会被其他 CPU 并发写;而 RCU 读侧在软中断/中断上下文中同样有效,因为禁用中断或软中断本身就构成 quiescent state。

## 十一、实例四:进程遍历

`for_each_process`(`include/linux/sched/signal.h:660`)遍历全局任务链表。这个链表在任务创建/退出时会变化,所以遍历通常要持有 RCU 读锁。`fs/proc/base.c:1164` 是一个典型例子:

```c
rcu_read_lock();
for_each_process(p) {
        if (same_thread_group(task, p))
                continue;
        ...
        task_lock(p);
        ...
        task_unlock(p);
}
rcu_read_unlock();
```

任务退出后的 `task_struct` 也不是立刻释放:内核用 `call_rcu` 延迟回收,例如 `kernel/fork.c:1979` 的 `__delayed_free_task`,以及 `include/linux/sched/task.h:159` 的 `__put_task_struct_rcu_cb`。这样遍历者即使拿到一个正在退出的任务,也能安全地看它的字段,直到 GP 结束。

进程创建/退出本身的细节可以看[进程创建深度调用链]({{ '/linux-arch-dia/进程管理/deep-process-create.html' | relative_url }})和[进程状态机]({{ '/linux-arch-dia/进程管理/process-states.html' | relative_url }})。

## 十二、代价:RCU 不是免费的

RCU 把成本从读侧转移到了写侧和内存,具体表现在:

| 代价 | 说明 | 缓解手段 |
|---|---|---|
| 内存放大 | 旧版本要等 GP 结束才释放 | 缩短读侧临界区、`call_rcu_hurry` |
| 回收延迟 | GP 可能被 idle/长读侧拖长 | `synchronize_rcu_expedited`、RCU lazy |
| 调试困难 | 读侧没有锁,竞争窗口靠工具发现 | `CONFIG_PROVE_RCU`、lockdep、rcutorture |
| 写侧复杂 | 要处理发布顺序、旧对象回收 | 统一封装、代码审查 |
| 不保证最新 | 读者可能看到旧值 | 需要强一致时用 seqlock/锁 |
| 读侧不能睡眠 | 经典 RCU 读侧不可阻塞 | 需要睡眠用 SRCU |

### 什么时候不该用 RCU

- **写非常频繁**:GP 一个接一个,写者等待和回调堆积会拖垮系统。
- **读侧临界区很长**:会推迟 GP,导致旧对象长期无法释放。
- **需要读到严格一致的多字段快照**:RCU 只保证指针生命周期,不保证字段一致性,应该用 seqlock。
- **需要跨 CPU 的精确计数**:per-CPU 汇总不是原子的,应该用 `atomic_t` 或加锁。
- **写者要求低延迟**:`synchronize_rcu` 可能睡眠较久,实时性敏感路径要谨慎。
- **模块卸载**:必须先用 `rcu_barrier()` 等所有回调执行完,否则可能调用到已卸载的代码。

## 十三、FAQ

**Q:RCU 读侧需要关中断吗?**
不需要。`rcu_read_lock` 只处理抢占/嵌套计数;如果代码本身要求关中断(例如硬中断上下文),那是另一回事。

**Q:RCU 读侧可以睡眠吗?**
经典 RCU 不可以。需要睡眠的读侧请使用 SRCU(`synchronize_srcu`)。

**Q:`rcu_dereference` 和普通读有什么区别?**
它告诉编译器和 CPU"这是一个 RCU 保护的指针",并用 `READ_ONCE`/数据依赖保证顺序。普通读可能被优化或重排。

**Q:per-CPU 变量是线程局部存储吗?**
不是。它是每 CPU 一份,任务迁移后会看到另一个副本。`this_cpu_ptr` 取的是"当前 CPU"的副本。

**Q:this_cpu_inc 是原子的吗?**
对本 CPU 的抢占是安全的,但对中断/NMI 不是原子 RMW。跨上下文共享同一份 per-CPU 数据时仍需加锁。

**Q:seqlock 能替代自旋锁吗?**
不能。seqlock 只保证读者拿到一致快照,写者之间仍需互斥;读者也可能重试。

**Q:RCU 会导致内存泄漏吗?**
不会,但会延迟回收。GP 迟迟不结束时,旧对象会堆积;可以用 `rcu_barrier`、`call_rcu_hurry` 或 expedited GP 缓解。

**Q:为什么 `rcu_assign_pointer` 不能直接赋值?**
直接赋值可能让其他 CPU 先看到指针、后看到对象字段的初始化。`smp_store_release` 保证初始化先完成。

**Q:RCU 和 refcount 怎么选?**
RCU 管"查找期间对象不被释放",refcount 管"对象什么时候真正释放"。常见做法是 RCU 查找 + refcount 取强引用。

## 十四、观测与调试

```bash
# 内核配置
grep -E 'CONFIG_PREEMPT_RCU|CONFIG_PROVE_RCU|CONFIG_RCU_LAZY' /boot/config-$(uname -r)

# RCU 状态
cat /sys/kernel/debug/rcu/rcu_preempt/rcudata 2>/dev/null
cat /sys/kernel/debug/rcu/rcu_preempt/gp_seq 2>/dev/null

# 跟踪 grace period 与回调
sudo perf trace -e 'rcu:*' -a
sudo perf stat -e 'rcu:rcu_grace_period,rcu:rcu_callback' -a sleep 5

# lockdep / PROVE_RCU 报告
dmesg | grep -i rcu

# RCU torture(需模块)
sudo modprobe rcutorture
```

调试 RCU 问题的关键是**看锁的边界**:读侧有没有真的在 `rcu_read_lock` 里?写者释放旧对象前有没有等 GP?`rcu_dereference` 保护的是不是同一个指针?lockdep 和 `CONFIG_PROVE_RCU` 能在编译期/运行期发现大部分用法错误,比事后排查 use-after-free 便宜得多。

## 十五、把四个机制串起来

最后用一张"选择流程图"收束:

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/并发与同步/concurrency-primitives.html' | relative_url }}" loading="lazy" title="并发原语选择决策流程"></iframe>
  <figcaption>图 2:按访问模式选择并发原语(可交互)。</figcaption>
</figure>

一句话:读多写少优先 RCU;需要一致快照用 seqlock;计数用 per-CPU;临界区长再用锁。

RCU 的精妙不在于它"快",而在于它**把读侧从并发控制中解放出来**,把复杂性集中到写侧和回收策略。per-CPU 则是同一思想的另一面:不去共享,就不会有竞争。seqlock 和 refcount 分别补上"一致快照"和"生命周期"两块拼图。理解它们的边界,比记住 API 更重要。

## 相关图示

- [中断下半部三机制对比]({{ '/linux-arch-dia/进程管理/bottom-half.html' | relative_url }})
- [进程创建深度调用链]({{ '/linux-arch-dia/进程管理/deep-process-create.html' | relative_url }})
- [进程状态机]({{ '/linux-arch-dia/进程管理/process-states.html' | relative_url }})
- [上下文切换]({{ '/linux-arch-dia/进程管理/context-switch.html' | relative_url }})
- [VFS 架构与路径查找]({{ '/linux-arch-dia/文件系统/vfs-architecture.html' | relative_url }})

> 源码基线:Linux `d487237`(v7.4.0-rc1)。行号会随内核版本漂移,以图集仓库重新 finalize 后的结果为准。
