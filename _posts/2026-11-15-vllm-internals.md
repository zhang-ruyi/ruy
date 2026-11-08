---
layout: post
date: 2026-11-15
categories: [ai-inference]
description: 从 EngineCore、Scheduler 到 PagedAttention 与前缀缓存，逐层拆解 vLLM 如何用连续批处理、分块预填和 KV 分页把 LLM 推理吞吐做上去。
title: "vLLM 精读:连续批处理、PagedAttention 与前缀缓存"
---

## 开场：vLLM 要解决的不是“模型能不能跑”，而是“GPU 有没有被喂饱”

LLM 推理有两个互相纠缠的瓶颈。第一个是**批处理的静态性**：传统做法一次收一批请求，等这一批里最长的序列生成完才回收整批；短请求结束后，它占用的 batch slot 和 KV 显存一直空转。第二个是**KV Cache 的连续性假设**：如果每个请求都要求一段连续的显存来存放历史 K/V，那么生成长度不可预知，框架只能按最坏情况预留，于是外部碎片和内部浪费同时出现。第三个是**重复计算**：大量请求共享系统提示词、few-shot 示例或对话前缀，却每次都要把相同的 prompt 重新 prefill 一遍。

vLLM 的三件核心武器正好对应这三点：**连续批处理**（continuous batching）让每个 GPU step 重新组 batch，请求完成即退出、新请求随时加入；**PagedAttention** 把 KV Cache 切成固定大小的块，用类似操作系统页表的结构按需映射，把显存浪费压到“每序列最多一个未填满的尾块”；**前缀缓存**（prefix caching）给完整 KV 块算链式哈希，相同前缀直接复用物理块，避免重复 prefill。这三者不是三个独立优化，而是同一套调度不变量在不同层面的体现。

本文基于 vLLM 仓库 `c724bb35d4e70201cf0fa6f2f1dcd802c6f9dad4` 阅读。文中引用的函数与行号均已用 `grep -n` 核实；由于该版本迭代很快，具体行号可能随提交漂移，但结构和方法名是稳定的。

## 一、总架构：从 HTTP 请求到 attention kernel

先给结论：vLLM V1 的主干是一条**单线程调度 + 多进程执行**的流水线。前端负责 tokenize、参数校验和输出 detokenize；EngineCore 负责“调度一步、执行一步”的忙循环；Scheduler 决定这一步哪些请求各算多少 token；KVCacheManager 决定这些 token 需要哪些物理块；Executor 把 `SchedulerOutput` 广播给各 rank 的 Worker；Worker 里的 ModelRunner 组装 block table、slot mapping 和输入张量，最后交给 attention backend。

| 层级 | 组件 | 职责 | 关键源码 |
| --- | --- | --- | --- |
| 前端 | `LLMEngine` / API Server | 接收请求、tokenize、采样参数校验、输出流式返回 | `vllm/v1/engine/llm_engine.py:54`、`:229` |
| 引擎核心 | `EngineCore` / `EngineCoreProc` | 输入队列、忙循环、一步调度与执行、输出回传 | `vllm/v1/engine/core.py:129`、`:713`、`:1794` |
| 调度 | `Scheduler` | 预算分配、waiting/running 管理、抢占、分块预填 | `vllm/v1/core/sched/scheduler.py:86`、`:716` |
| KV 管理 | `KVCacheManager` | 前缀命中、块分配、块释放、缓存统计 | `vllm/v1/core/kv_cache_manager.py:131`、`:288`、`:401` |
| 块池 | `BlockPool` | 空闲块队列、引用计数、块哈希索引、LRU 回收 | `vllm/v1/core/block_pool.py:107` |
| KV 协调 | `KVCacheCoordinator` | 单组/多组 KV 的联合命中与分配策略 | `vllm/v1/core/kv_cache_coordinator.py:89`、`:464` |
| 执行 | `Executor` / `Worker` | 进程/设备管理、TP/PP 通信、调用 ModelRunner | `vllm/v1/worker/gpu_worker.py:215`、`:1442` |
| 模型执行 | `GPUModelRunner` | 组装输入、block table、slot mapping、采样 | `vllm/v1/worker/gpu/model_runner.py:201`、`:1649`、`:1810` |
| 注意力 | attention backend | 按 block table 做分页 attention | `vllm/v1/attention/backends/flash_attn.py` 等 |

<figure class="diagram"><iframe src="{{ '/linux-arch-dia/LLM推理/vllm-architecture.html' | relative_url }}" loading="lazy" title="vLLM 架构分层"></iframe><figcaption>图 1:vLLM V1 的分层结构。调度与 KV 管理位于 EngineCore 进程内，Worker 只消费 SchedulerOutput 并执行前向。</figcaption></figure>

这里有两个容易忽略的细节。第一，`LLMEngine` 在当前代码里被标注为“Legacy LLMEngine for backwards compatibility”（`vllm/v1/engine/llm_engine.py:55`），真正的服务入口通常是异步引擎，但它们最终都通过 `EngineCoreClient` 把请求送进同一个 `EngineCore`。第二，调度器只存在于 EngineCore 一侧；Worker 不做“这一步该跑谁”的决策，只接收 `SchedulerOutput` 里的 `num_scheduled_tokens`、block id 增量和已缓存请求的 diff。这种“调度集中、执行分散”的设计避免了多 rank 各自调度导致的不一致，也让 TP/PP 下的 block table 可以按同一份 block id 构造。

## 二、一次请求的生命周期

`LLMEngine.add_request()` 完成 tokenize 和参数处理后，把请求交给 EngineCore（`vllm/v1/engine/llm_engine.py:229`）。多进程模式下，请求先进入 `EngineCoreProc` 的输入队列；`run_busy_loop()` 在没有工作时阻塞在队列上，有工作时调用 `_process_engine_step()`（`vllm/v1/engine/core.py:1794`）。每一步的核心只有四行：

```python
scheduler_output = self.scheduler.schedule(...)
future = self.model_executor.execute_model(scheduler_output, non_block=True)
model_output = self._wait_for_output(future)
engine_core_outputs = self.scheduler.update_from_output(scheduler_output, model_output)
```

这是 `EngineCore.step()` 的骨架（`vllm/v1/engine/core.py:713`）。注意 `execute_model(..., non_block=True)`：执行是异步提交的，EngineCore 可以在等待 GPU 的同时做 grammar bitmask 等 CPU 侧工作；如果启用 batch queue，还可以继续调度下一批，形成流水。

<figure class="diagram"><iframe src="{{ '/linux-arch-dia/LLM推理/vllm-request-lifecycle.html' | relative_url }}" loading="lazy" title="vLLM 请求生命周期"></iframe><figcaption>图 2:请求从 waiting 到 running、再到完成的生命周期。抢占会把请求退回 waiting，并清空已计算的 KV 计数。</figcaption></figure>

`SchedulerOutput` 是调度器与执行器之间的契约，包含：首次调度的请求全量数据 `scheduled_new_reqs`、已调度请求的增量 `scheduled_cached_reqs`、每个请求本步要算的 token 数 `num_scheduled_tokens`、投机解码草稿 `scheduled_spec_decode_tokens`、新分配需要清零的 block id 等（`vllm/v1/core/sched/output.py:220`）。Worker 端会为每个请求维护一份请求状态和 block table；新请求通过 `NewRequestData.block_ids` 一次性写入，后续步骤只追加新增块（`vllm/v1/core/sched/output.py:47`、`vllm/v1/worker/gpu/model_runner.py:1305`、`vllm/v1/worker/gpu/block_table.py:125`）。

## 三、调度器：没有 prefill/decode，只有“追赶”

理解 vLLM 调度器的关键是读 `schedule()` 开头那段注释：

> There's no "decoding phase" nor "prefill phase" in the scheduler. Each request just has the `num_computed_tokens` and `num_tokens_with_spec`. ... At each step, the scheduler tries to assign tokens to the requests so that each request's `num_computed_tokens` can catch up its `num_tokens_with_spec`.

这段注释位于 `vllm/v1/core/sched/scheduler.py:719`。它不是文字游戏，而是整个 V1 调度器的设计公理。每个请求只维护两个数：

- `num_tokens_with_spec = len(prompt_token_ids) + len(output_token_ids) + len(spec_token_ids)`（`vllm/v1/request.py:337`），即“这个请求最终应该有多少 token 的 KV”。
- `num_computed_tokens`，即“已经算好 KV 的 token 数”。

调度器每一步做的事，就是给每个请求分配一段 `num_new_tokens`，让前者追赶后者。prompt 没算完时，追赶表现为 prefill；prompt 算完后每次只追一个采样 token，表现为 decode；开了投机解码，`spec_token_ids` 让目标变长，追赶就包含对草稿的验证；开了分块预填，只是把一次追赶拆成多步、每步受预算限制。**四种看似不同的执行模式，在同一套记账逻辑下统一了。**

### 3.1 两个预算：token budget 与 input budget

`schedule()` 一开始设置两个预算（`vllm/v1/core/sched/scheduler.py:735`、`:738`）：

```python
token_budget = self.max_num_scheduled_tokens
input_budget = self.scheduler_config.max_num_batched_tokens
```

`token_budget` 限制本步“调度出去”的 token 总数；`input_budget` 限制本步真正进入前向的 token 数。大多数情况下两者相等（`max_num_scheduled_tokens` 默认等于 `max_num_batched_tokens`），但在投机解码下，Worker 可能在一步里额外追加 draft token，因此 input budget 还要为 `draft_slots` 留出空间。运行队列每调度一个请求，代码会同时扣减 `num_new_tokens` 和 `num_new_tokens + draft_slots`（`vllm/v1/core/sched/scheduler.py:1018`）。把这两个预算分开，是为了在“调度决策”和“实际前向规模”之间留出安全边界。

### 3.2 RUNNING 优先，FCFS 是默认但不是铁律

调度顺序是“先 RUNNING，后 WAITING”（`vllm/v1/core/sched/scheduler.py:809`、`:1065`）。对每个 running 请求，本步应算的 token 数是：

```python
num_new_tokens = (
    request.num_tokens_with_spec
    + request.num_output_placeholders
    - request.num_computed_tokens
)
num_new_tokens = min(num_new_tokens, token_budget, input_budget - draft_slots)
```

（`vllm/v1/core/sched/scheduler.py:855` 起。）`num_output_placeholders` 是异步调度下“已经提交但输出还没回来”的占位 token，把它加回去可以避免重复调度。随后还会用 `max_model_len`、Mamba 对齐、encoder 输入预算等做二次裁剪。

如果 `allocate_slots()` 返回 `None`，说明空闲块不够。此时调度器不会立刻放弃，而是**抢占**（preempt）一个 running 请求：默认策略下选 `self.running[-1]`，即优先级最低/最晚加入的请求；如果是 priority 策略，则按优先级和到达时间选牺牲者（`vllm/v1/core/sched/scheduler.py:954`）。抢占动作在 `_preempt_request()` 里完成（`vllm/v1/core/sched/scheduler.py:1853`）：释放该请求的全部块、清空 encoder cache、把 `num_computed_tokens` 归零、`num_preemptions += 1`、然后 `waiting.prepend_request(request)` 放回等待队列头部。

<div class="callout">
<strong>注意：抢占不是免费的。</strong> 被抢占请求的 KV 已经释放，恢复时必须从头重算（或依赖外部 KV 连接器重新加载）。因此 <code>num_computed_tokens = 0</code> 是抢占的代价标签。线上看到 “Preemptions: N” 持续增长，通常意味着 KV 显存相对并发量偏紧，应该降低 <code>max_num_seqs</code>、提高 <code>gpu_memory_utilization</code>，或者接受更小的 batch。
</div>

### 3.3 WAITING：前缀命中、分块预填、准入

等待队列里的请求第一次被调度时，调度器先做本地前缀缓存查询：`_get_local_prefix_cache_hit()` 最终调用 `KVCacheManager.get_computed_blocks()`（`vllm/v1/core/sched/scheduler.py:681`、`vllm/v1/core/kv_cache_manager.py:288`）。命中的块会被 `touch()` 增加引用计数，随后 `allocate_slots()` 只需为未命中的 token 分配新块（`vllm/v1/core/kv_cache_manager.py:401`）。

然后是分块预填。等待请求本步可算的 token 数先按 `request.num_tokens - num_computed_tokens` 计算（`vllm/v1/core/sched/scheduler.py:1356`），再被 `request_token_budget` 截断（`:1396`）。如果 `enable_chunked_prefill` 为假且 prompt 超过剩余预算，调度器直接 `break`，不再把一个长 prompt 拆开（`:1388`）；如果为真，长 prompt 可以被切成多步。当前版本在模型支持时默认开启分块预填（`vllm/config/scheduler.py:146`、`vllm/engine/arg_utils.py:3081`），所以“长 prompt 默认会被分块”是常态。

分块预填还配了一个防饿死旋钮 `long_prefill_token_threshold`（`vllm/config/scheduler.py:90`）：当一个长 prefill 和多个 decode 同时在跑时，限制长 prefill 单步能吃的 token 数，避免它一口气占满 `max_num_batched_tokens`，把 decode 的 ITL 拉爆。当前版本还提供自适应下限，按“预算除以排队请求数”取公平份额。这是一个非常实用的细节：**分块预填优化的是公平性和尾延迟，不是单纯的吞吐。**

### 3.4 调度之后：先记账，再按采样结果回滚

`_update_after_schedule()` 在调度完成后立刻把 `num_computed_tokens += num_scheduled_token`（`vllm/v1/core/sched/scheduler.py:1912`），并更新 `is_prefill_chunk`。这一步必须发生在执行之前，因为下一步调度需要看到“已经承诺出去”的进度。

但投机解码会打破这个承诺：草稿 token 可能被拒绝。`update_from_output()` 里，`num_rejected = num_draft_tokens - num_accepted`，然后把 `num_computed_tokens` 减回去（`vllm/v1/core/sched/scheduler.py:2401`、`:2408`）。**先乐观推进、再按验证结果回滚**，是 V1 调度器能同时支持异步调度、PP 流水和投机解码的关键。

## 四、PagedAttention：把 KV Cache 变成页表

<figure class="diagram"><iframe src="{{ '/linux-arch-dia/LLM推理/vllm-paged-attention.html' | relative_url }}" loading="lazy" title="PagedAttention 逻辑块与物理块"></iframe><figcaption>图 3:逻辑块通过 block table 映射到物理块。相同前缀的逻辑块可以指向同一物理块，引用计数归零后才回到空闲队列。</figcaption></figure>

### 4.1 逻辑块、物理块与 block table

PagedAttention 借用了虚拟内存的分页思想。序列被切成固定 token 数的**逻辑块**，GPU 上预分配一大片**物理块**，每个物理块能放 `block_size` 个 token 的 K/V。每个请求维护一张 **block table**，第 i 项记录“第 i 个逻辑块当前落在哪个物理块”。注意力 kernel 不再假设 KV 连续，而是拿着 block table 去 gather。

本仓库当前 `block_size` 默认是 64（`vllm/config/cache.py:185`），并且可以通过 `--block-size` 覆盖。历史版本常见默认是 16；不同默认值不影响原理，只影响碎片粒度和 kernel 的 gather 开销。Worker 侧的 `BlockTables` 为每个 KV group 维护一个 `int32[max_num_reqs, max_num_blocks]` 张量（`vllm/v1/worker/gpu/block_table.py:17`），前向时 `gather_block_tables()` 取当前 batch 的页表（`:160`），`compute_slot_mappings()` 则把本步每个 token 映射到物理块内的具体 slot，供 KV 写入使用（`:229`）。因此“读旧 KV”和“写新 KV”走的是同一张页表，只是用途不同。

### 4.2 block hash：前缀缓存的键

前缀缓存要回答“这个新请求的前 i 个块，和之前哪个请求的块完全一样”。vLLM 用**链式哈希**：第 i 个块的哈希由“父块哈希 + 本块 token + 额外键”计算（`vllm/v1/core/kv_cache_utils.py:703`）。额外键用于区分 LoRA、多模态特征、cache salt 等不影响 token id 但影响 KV 内容的因素。`get_request_block_hasher()` 以 `hash_block_size` 为粒度、沿完整前缀链式计算（`vllm/v1/core/kv_cache_utils.py:949`），所以哈希天然带有“前缀”语义：内容相同但位置不同的块不会误命中。

只有**完整的块**才会被写入缓存索引。`BlockPool.cache_full_blocks()` 在请求推进时把已填满的块登记到 `cached_block_hash_to_block`（`vllm/v1/core/block_pool.py:203`）；`get_cached_block()` 则按哈希和 KV group 查块（`:175`）。这也解释了为什么前缀缓存对“最后一块不满”的命中会保守：不完整的块不参与哈希。

### 4.3 find_longest_cache_hit：只找“最长连续前缀”

命中查询的抽象接口在 `KVCacheCoordinator.find_longest_cache_hit()`（`vllm/v1/core/kv_cache_coordinator.py:464`）。它返回三样东西：每个 KV group 的命中块、命中 token 数、以及混合模型里“某个稀疏保留组尚未缓存的公共前缀长度”。具体实现按 attention 类型分派：

- `KVCacheCoordinatorNoPrefixCache`：前缀缓存关闭或模型不支持时，直接返回空（`:480`）。
- `UnitaryKVCacheCoordinator`：只有一种 KV 类型（全注意力或滑窗），委托给单个 manager（`:530`、`:582`）。
- `HybridKVCacheCoordinator`：混合注意力/混合 KV group，需要各组取交集（`:617`）。

以最典型的 `FullAttentionManager.find_longest_cache_hit()` 为例（`vllm/v1/core/single_type_kv_cache_manager.py:748`），它分两阶段：

1. **整块扫描**：从第一个块开始，只要 `block_pool.get_cached_block()` 命中就继续；一旦某块缺失就停止。因为哈希是链式的，后面的块不可能独立命中（注释在 `:797`）。
2. **细粒度探测**：如果 `hash_block_size` 小于物理块大小，还会在第一个未命中块内部，从高到低探测哈希边界，尽量多命中几个 token（`:807`）。

最终命中长度还要被 `request.get_max_cache_hit_length()` 限制为 `num_tokens - 1`（`vllm/v1/request.py:352`）。原因很直接：**即使所有 token 都命中，也必须重算最后一个 token 才能得到 logits**。这个看似保守的 `-1` 会在块边界上导致整个尾块重算，但换来的是正确性。

### 4.4 碎片与共享：引用计数 + 写时复制

`KVCacheBlock` 只有几个关键字段：`block_id`、`ref_cnt`、`block_hash`、`block_hash_num_tokens`（`vllm/v1/core/kv_cache_utils.py:166`）。空闲块放在 `FreeKVCacheBlockQueue` 里（`:254`），本质是一个双向链表，支持 O(1) 地从头部取块；带哈希的块按 LRU 顺序追加到尾部，未缓存的块则优先复用。

- **分配**：`get_new_blocks()` 从空闲队列头部弹出，设置 `ref_cnt = 1`；如果这个块还挂着旧哈希，先 `_maybe_evict_cached_block()` 把哈希索引清掉（`vllm/v1/core/block_pool.py:681`）。这就是 LRU 回收：哈希表里的块同时也在空闲队列里，谁被重新分配，谁的缓存条目就失效。
- **共享**：前缀命中时 `touch()` 把 `ref_cnt += 1`，并把块从空闲队列移除（`:774`）。于是同一个物理块可以被多个请求同时读。
- **释放**：`free_blocks()` 把 `ref_cnt` 归零的块放回空闲队列（`:798`）；只要还有请求引用，块就不会被回收。
- **写时复制**：如果请求命中了一个共享块，但接下来要往这个块尾部写新 token，就不能原地写。`allocate_new_blocks()` 检测到 partial hit 时，会额外分配一个私有块，把共享尾块重定向过去，并登记一次 `pending copy`（`vllm/v1/core/single_type_kv_cache_manager.py:395`、`:400`）。粗粒度路径直接在调度阶段完成重定向；细粒度路径因为 worker 的 block table 是追加式的，会把缓存条目移动到新块，再在 forward 前做一次 GPU 拷贝。

这就是 PagedAttention 的“碎片账本”：物理块等大且按需分配，外部碎片几乎被消除；内部浪费的上限是每个序列最后一个块里 `block_size - 1` 个 token 的 KV；共享则把“相同前缀”的物理块复用率做到请求级别。**PagedAttention 省的是 KV 显存，不是模型权重显存**，这一点在后文 FAQ 还会展开。

### 4.5 一次前缀命中的完整路径

把上面的碎片拼起来，一个新请求命中前缀缓存时，会经历：

1. Scheduler 在 waiting 队列里调用 `get_computed_blocks()`（`vllm/v1/core/kv_cache_manager.py:288`）。
2. Coordinator 沿 `request.block_hashes` 调 `find_longest_cache_hit()`，拿到命中块列表和 `num_new_computed_tokens`。
3. `create_kv_cache_blocks()` 包装成 `KVCacheBlocks`；`allocate_slots()` 对这些块 `touch()`，只为剩余 token 分配新块（`:401`）。
4. Scheduler 把 `num_computed_tokens` 设为命中长度，`num_new_tokens` 只覆盖剩余部分。
5. Worker 的 `BlockTables.append_block_ids()` 把新块追加到页表（`vllm/v1/worker/gpu/block_table.py:125`），ModelRunner 组装本次输入。
6. 请求推进后，`cache_blocks()` 把新填满的块登记进前缀缓存（`vllm/v1/core/kv_cache_manager.py:807`），供后来者命中。

注意第 4 步：命中长度直接成为 `num_computed_tokens`，所以“前缀缓存”在调度器眼里就是“这个请求已经算过这么多 token 了”。它不需要单独的 prefill 阶段，也不需要特殊的 kernel 分支。

## 五、连续批处理、投机解码与分块预填是什么关系

很多文章把这三者写成三个独立特性，其实它们共享同一个调度骨架：

- **连续批处理**：每个 step 重新组 batch，完成的请求退出，等待的请求补位。它解决的是“batch 生命周期和请求生命周期不一致”的问题。
- **分块预填**：把一次很长的追赶拆成多个 step，每步只吃一部分 token 预算。它解决的是“长 prompt 独占一个 step，导致 decode 等待”的问题。
- **投机解码**：让目标序列临时变长（`num_tokens_with_spec` 包含 draft token），一次前向验证多个位置；被拒绝的草稿通过 `num_computed_tokens` 回滚。它解决的是“decode 每步只前进一个 token，GPU 利用率低”的问题。

三者能共存，是因为调度器的唯一状态是“已计算 token 数”和“应计算 token 数”。分块预填改变的是每步追多少，投机解码改变的是目标有多远，连续批处理改变的是“这一步有哪些请求参与追赶”。**只要不变量成立，具体模式可以任意组合。**

## 六、分布式：TP/PP 下谁在做什么

`tensor_parallel_size` 和 `pipeline_parallel_size` 定义在 `vllm/config/parallel.py:150`、`:148`。分布式对调度器是透明的：Scheduler 仍然只产出全局的 `num_scheduled_tokens` 和 block id；Executor 把这些信息发给所有 rank。

- **TP**：注意力头和 MLP 切分到多卡，KV Cache 按头切分。每个 rank 用相同的 block id 构造本地的 block table，但每个物理块只存自己负责的那部分 KV。前向中的 all-reduce 由模型内部的并行层完成。
- **PP**：层按 stage 切分。`Worker.execute_model()` 在非首 stage 先 `irecv_tensor_dict()` 收上一 stage 的中间张量（`vllm/v1/worker/gpu_worker.py:1456`），算完再 `isend_tensor_dict()` 发给下一 stage（`:1488`）。调度器需要感知 PP 的流水深度，因此代码里会出现 `num_prefill_lookahead`、`next_decode_eligible_step` 等约束，确保同一个请求的相邻 decode step 之间留出 `pp_size` 步的节奏。

对使用者来说，重要的结论是：**调度和 KV 记账发生在 EngineCore 的单个逻辑点上，分布式只放大执行侧。** 这也是为什么 TP/PP 不会改变 `max_num_batched_tokens` 的语义，但会改变每张卡实际能容纳的块数和通信开销。

## 七、观测：不要只看 tokens/s

### 7.1 日志

默认日志每个统计周期会打印 prompt throughput、generation throughput、running/waiting 请求数、GPU KV cache 使用率，以及前缀缓存命中率。KV 使用率的格式化位置在 `vllm/v1/metrics/loggers.py:203`，抢占次数在 `:311`，前缀缓存命中率在 `:322`。几个判读经验：

- `GPU KV cache usage` 长期贴近 100% 且 `Preemptions` 增长：KV 不够，降低并发或换更大显存。
- `Prefix cache hit rate` 很低：请求之间没有稳定公共前缀，或者块太大导致命中粒度太粗。
- `Waiting` 持续增长但 `Running` 不满：可能是 `max_num_seqs`、LoRA 数量或 encoder 预算卡住了，而不一定是显存。

### 7.2 Prometheus

`vllm:kv_cache_usage_perc`（`vllm/v1/metrics/loggers.py:620`）是最直接的容量指标；`vllm:prefix_cache_queries` 与 `vllm:prefix_cache_hits`（`:661`、`:672`）可以用来算命中率。前者是“查询了多少 token”，后者是“命中了多少 token”，两者相除才是按 token 加权的命中率。不要用请求数去算，长 prompt 和短 prompt 的权重完全不同。

### 7.3 Profiler 与 TensorBoard

想看 kernel 级时间线，可以启用 torch profiler：

```bash
vllm serve <model> \
  --profiler-config.profiler=torch \
  --profiler-config.torch_profiler_dir=/tmp/vllm-trace
```

trace 默认通过 `torch.profiler.tensorboard_trace_handler()` 写出（`vllm/profiler/wrapper.py:266`），随后用 `tensorboard --logdir=/tmp/vllm-trace` 打开。重点看 attention kernel、KV 写入、all-reduce 和采样各自占比；如果 decode step 的 GPU 时间被大量小 kernel 切碎，通常说明 batch 太小或 CUDA Graph 没覆盖到。

### 7.4 Benchmark

在线服务压测用 `vllm bench serve`（用法见 `vllm/benchmarks/serve.py:10`）：

```bash
vllm bench serve \
  --backend openai \
  --model <model> \
  --dataset-name random \
  --input-len 1024 \
  --output-len 256 \
  --num-prompts 1000 \
  --request-rate 20
```

离线吞吐用 `vllm bench throughput`，固定延迟用 `vllm bench latency`。压测时至少记录三组数：TTFT（首 token 延迟）、ITL（相邻 token 间隔）、总吞吐。只报 tokens/s 会掩盖尾延迟问题。

## 八、调优：旋钮与副作用

| 参数 | 作用 | 调大 | 调小 | 典型风险 |
| --- | --- | --- | --- | --- |
| `max_num_batched_tokens` | 单步 token 预算 | 吞吐更高、GPU 更饱 | 调度更细、ITL 更稳 | 太大让长 prefill 挤占 decode |
| `max_num_seqs` | 单步并发序列数/runner 容量 | 并发高、吞吐高 | 并发低、显存压力小 | 太大导致 KV 不足和抢占 |
| `block_size` | KV 物理块 token 数 | 页表小、块管理开销低 | 碎片小、前缀粒度细 | 太大浪费尾部 KV、命中变粗 |
| `enable_chunked_prefill` | 长 prompt 是否分块 | 公平性好、尾延迟低 | 单请求延迟可能更低 | 关闭后长 prompt 可能阻塞整步 |
| `enable_prefix_caching` | 是否复用相同前缀 KV | 多轮/共享提示词吞吐大增 | 省哈希与块管理开销 | 关闭后重复 prefill |
| `long_prefill_token_threshold` | 单个 prefill 单步上限 | 长 prefill 更快 | decode 更稳 | 太小会拉长 TTFT |
| `gpu_memory_utilization` | KV 可用显存比例 | 块更多、并发更高 | 更安全 | 太贴近上限会 OOM |

几条实操建议：

1. **先定 `max_num_seqs`，再定 `max_num_batched_tokens`。** 前者受 KV 容量约束，后者受计算和延迟目标约束。若 `max_num_batched_tokens < max_num_seqs`，配置会直接报错（`vllm/config/scheduler.py:375`）。
2. **长 prompt 场景优先开分块预填，并用 `long_prefill_token_threshold` 限流。** 分块预填不是为了让单个请求更快，而是为了让 decode 不被长 prefill 长时间挡住。
3. **前缀缓存是否开启要看流量结构。** 当前版本在模型支持时默认开启（`vllm/engine/arg_utils.py:3112`、`vllm/config/cache.py:260`），可以用 `--enable-prefix-caching` 显式打开，也可以按需关闭。多轮对话、固定 system prompt、RAG 共享上下文收益最大；一次性、互不相关的短请求收益有限，反而多付哈希开销。
4. **`block_size` 不要盲目调小。** 小块减少尾部浪费，但页表更长、块管理更频繁、attention gather 更碎。默认值（本仓库 64）通常是 kernel 和碎片之间的折中；只有在 KV 尾部浪费显著、且前缀命中很粗时才考虑下调。
5. **抢占是信号，不是配置。** 如果日志里持续出现 Preemptions，优先降低 `max_num_seqs` 或提高显存预算，而不是指望调度器“优化掉”它。

## 九、FAQ 与常见误解

**Q1：vLLM 是不是把 prefill 和 decode 拼在同一个 batch 里？**

不完全是。更准确的说法是：调度器不区分阶段，只让每个请求的 `num_computed_tokens` 追赶 `num_tokens_with_spec`。一个 step 里可能同时包含“还在追赶 prompt 的请求”和“只追一个采样 token 的请求”，但代码里没有 `prefill_batch` 和 `decode_batch` 两个对象。

**Q2：PagedAttention 节省的是模型权重显存吗？**

不是。它管理的是 KV Cache。模型权重仍然按 TP/PP 切分常驻显存；PagedAttention 解决的是“历史 K/V 如何按需分配、共享和回收”。

**Q3：前缀缓存能复用任意公共子串吗？**

不能。它只复用**从第一个 token 开始的最长公共前缀**，而且以完整块为粒度、用链式哈希索引。两个请求中间有一段相同但开头不同，是命中不了的。

**Q4：前缀缓存命中后是不是完全不用算？**

不是。即使全部命中，也要重算最后一个 token 以产生 logits（`vllm/v1/request.py:352`）；如果块边界不巧，可能重算整个尾块。另外，命中只复用 KV，采样和输出仍然要做。

**Q5：抢占只是把请求挪回队列，没什么代价？**

代价是重算。`_preempt_request()` 会把 `num_computed_tokens` 归零并释放块（`vllm/v1/core/sched/scheduler.py:1853`），恢复时这些 token 的 KV 要重新计算。抢占多了，吞吐和尾延迟都会明显变差。

**Q6：`max_num_batched_tokens` 越大吞吐越高？**

不一定。预算越大，单步能塞的长 prefill 越多，decode 可能要等更久，ITL 尾延迟变差；同时 KV 峰值压力更大，可能触发抢占。它应该和 `max_num_seqs`、`long_prefill_token_threshold` 一起调。

**Q7：分块预填会降低吞吐吗？**

它可能让单个长请求的完成时间变长，但通过让 decode 持续运行，通常能提升整体吞吐和尾延迟。是否开启要看流量里长 prompt 和 decode 的比例。

**Q8：开了投机解码，调度器需要特殊处理吗？**

只需要把 draft token 计入 `num_tokens_with_spec`，并在验证后按接受数回滚 `num_computed_tokens`（`vllm/v1/core/sched/scheduler.py:2401`、`:2408`）。调度器本身仍然在做“追赶”，没有额外的阶段。

## 十、小结

vLLM 的性能来自一组非常克制的不变量，而不是某个单点 kernel：

- **调度不变量**：每个请求只有 `num_computed_tokens` 和 `num_tokens_with_spec`，每步让前者追赶后者；prefill、decode、分块预填、投机解码都是这一条的不同投影。
- **显存不变量**：KV 以固定大小的物理块管理，逻辑块通过 block table 映射；碎片上限是每序列一个尾块，共享通过引用计数和写时复制实现。
- **复用不变量**：完整块用链式哈希索引，命中查询只找最长连续前缀，命中长度直接变成已计算 token 数。
- **执行不变量**：调度集中在 EngineCore，Worker 只消费 `SchedulerOutput`；TP/PP 只放大执行侧，不改变调度语义。

把这四条记住，再看 `scheduler.py`、`kv_cache_manager.py`、`block_pool.py` 和 `model_runner.py`，就不会被层出不穷的新特性淹没。**vLLM 的复杂不在于概念多，而在于它把很多看似不同的优化，压进了同一套 token 记账和块记账里。**
