---
layout: post
title: "超长会话的 KV 生命周期:vLLM 建缓存,LMCache 下沉 NVMe,再命中回载"
date: 2026-11-17
categories: [ai-inference]
description: "以一次超长会话的两轮请求为主线:KV 如何在 GPU HBM 中创建,达到 store_kv 条件后经 LMCache L1 下沉到 L2 NVMe,以及第二次请求命中后如何原路加载回 GPU。"
---
LLM 推理 · vLLM / LMCache · 源码基线 vLLM `c724bb3` / LMCache `a4a6888`

超长会话(多轮对话、长文档续写、Agent 长轨迹)有两个绕不开的成本:**prefill 越来越长**,以及 **KV Cache 越来越大**。前者决定首 token 延迟,后者决定单机能容纳多少并发。vLLM 用 PagedAttention 把 KV 切成块放进 GPU HBM;LMCache 则把已经算过的 KV 变成可复用的缓存层,按热度在 GPU、CPU、NVMe 之间流动。本文只讲一条主线:**一次超长会话的 KV,如何从 GPU 创建、下沉到 NVMe,再在下一轮请求中命中并回载**。

<figure class="diagram">
  <iframe src="{{ '/llm-arch-dia/vllm-lmcache-long-session.html' | relative_url }}" loading="lazy" title="超长会话 KV 生命周期"></iframe>
  <figcaption>图 1:超长会话的 KV 生命周期——首次请求建 KV、store_kv 下沉 L1/L2,二次请求命中后回载 GPU。</figcaption>
</figure>

## 一、第一轮请求:KV 先落在 GPU

请求从 OpenAI API 或 `LLM` 进入后,先到 `LLMEngine.add_request`(`vllm/v1/engine/llm_engine.py:229`),再交给 `EngineCore.add_request`(`vllm/v1/engine/core.py:564`)。EngineCore 的 `step`(`:713`)驱动调度器:

1. `Scheduler.schedule`(`vllm/v1/core/sched/scheduler.py:716`)从 waiting/running 队列里选请求,计算这一步的 token budget。
2. 如果开启前缀缓存,`KVCacheManager.get_computed_blocks`(`vllm/v1/core/kv_cache_manager.py:288`)先查本地 GPU 前缀;`KVCacheCoordinator.find_longest_cache_hit`(`kv_cache_coordinator.py:464`)返回可复用的完整块。
3. `allocate_slots`(`kv_cache_manager.py:401`)为未命中的 token 分配逻辑块,BlockPool 再映射到物理块。
4. `GPUWorker.execute_model`(`vllm/v1/worker/gpu_worker.py:1442`)/`GPUModelRunner`(`model_runner.py:201`)执行 prefill,把每层 K/V 写进 paged KV buffer。

此时 KV 的形态是:**HBM 中的物理块 + block table + block hash**。`num_computed_tokens` 记录这条请求已经算到哪;只有完整的块才能被前缀缓存复用。超长会话的前几轮,所有 KV 都只在 GPU 里。

## 二、store_kv:什么时候把 KV 交给 LMCache

KV 不是一算完就自动落盘。LMCache connector 的存储由 vLLM 的 KVConnector 回调驱动:

- `LMCacheMPConnector`(`lmcache/integration/vllm/lmcache_mp_connector.py:594`)在 scheduler 侧和 worker 侧各有一个 adapter(`vllm_multi_process_adapter.py:526/1063`)。
- forward 退出前,调度器调用 `wait_for_save`(`:1083`)。connector 只对 `direction == "STORE"` 的请求提交保存。
- 是否允许 store 取决于部署角色:`kv_transfer_config.is_kv_producer` 为真时,这个 vLLM 实例才会把 KV 写出去。
- 默认只保存**完整的 prompt chunk**;`lmcache.mp.save_decode_cache=True` 时才会把 decode 阶段生成的 KV 也存下来。

因此,"达到 store_kv 条件"可以概括为:**KV producer + 完整块 + forward 退出前触发 wait_for_save**。这也是为什么超长会话的前缀缓存通常以"轮次/块"为单位增长,而不是每个 token 都写一次。

## 三、GPU → L1 → L2 NVMe:KV 的下沉路径

`wait_for_save` 之后,connector 通过 worker adapter 提交 store,进入 LMCache 的多进程(MP)链路:

1. **GPU → L1**:把 paged KV 从 HBM 拷到 LMCache 的 L1。L1 的介质是 DRAM、DEVDAX 或 GDS(`lmcache/v1/distributed/api.py:95` 的 `L1BackendType`),由 `StorageManager`(`v1/distributed/storage_manager.py:131`)统一管理。
2. **L1 → L2**:L2 是开放 adapter 注册表(`l2_adapters/factory.py:62`),内置文件系统(`fs_l2_adapter.py`)、raw block(POSIX/io_uring)、NIXL、Mooncake、HF3FS、P2P 等。把 L2 配到 NVMe 上的目录或裸块设备,就得到本文说的"NVMe SSD 层"。
3. **下沉时机**:L1 的 eviction controller 和 write policy 决定何时把冷块写到 L2;这一步可以是异步的,不阻塞当前 forward。
4. **登记位置**:KeyDirectory(`v1/mp_coordinator/views/key_directory.py:305`)记录每个 key 在哪些 L1/L2、哪些实例上,供后续 lookup 使用。

关键点:**"下沉到 NVMe"不是默认行为,而是 L2 配置的结果**。如果只配 L1,LMCache 就是 CPU 内存缓存;要让超长会话跨越显存/内存容量,需要显式配置 L2 到 NVMe。

## 四、第二轮请求:lookup 命中与原路回载

下一轮请求(或另一个相同前缀的请求)再次进入 vLLM 时,过程反过来:

1. `Scheduler` 先查本地 GPU 前缀;未命中时调用 connector 的 `get_num_new_matched_tokens`(`lmcache_mp_connector.py:1349`)。
2. connector 触发 LMCache `lookup`(`v1/multiprocess/modules/lookup.py:199`),KeyDirectory 返回该前缀在 L1/L2 的 placement。
3. 如果只有 L2 有(L1 已被逐出),LMCache 先做 prefetch/retrieve:从 NVMe 读回 L1,再写进 vLLM 的 paged KV。
4. `update_state_after_alloc`(`:1569`)与 `build_connector_meta`(`:1663`)把"要加载哪些块"变成 connector 元数据。
5. `start_load_kv`(`:996`)提交异步 retrieve;vLLM 的 `num_computed_tokens` 加上外部命中数(`scheduler.py:1256`)。如果加载是异步的,请求会进入 `WAITING_FOR_REMOTE_KVS`(`:1585`),由 `_update_waiting_for_remote_kv`(`:3616`)推进。
6. 加载完成后,`forward` 只计算未命中的 token;命中的 KV 直接从 paged buffer 读取。

两个细节决定了"命中"是否真的省事:

- **最后一个 token 通常仍需重算**:vLLM 把命中上限压在 `prompt_length - 1`,因为要拿最后一个位置的 logits,且分配要求块对齐。
- **key 必须一致**:block hash、模型、block size、cache salt 等任何一项不同都会导致 miss。

## 五、续算、解码与超长会话的容量

第二轮命中后,会话继续 decode。此时可以选择是否保存 decode 生成的 KV(`save_decode_cache`)。默认不保存,原因是 decode KV 增长快、复用率通常低于 prompt 前缀;如果业务是"同一长上下文反复续写",可以打开,让后续轮次连 decode 段也能命中。

超长会话真正的瓶颈会从"算力"逐渐变成"容量":

- GPU HBM 只放热块;L1 放温块;L2 NVMe 放冷块。
- L1/L2 都有 eviction;被逐出的块仍可能通过 lookup 找到 L2 placement 再回载。
- 如果 L2 也放不下,就会 miss,回到 vLLM 重新 prefill。

## 六、失败与边界

| 情况 | 结果 | 处理 |
|---|---|---|
| lookup 未命中 | 外部命中为 0 | 回到本地 prefill 重算 |
| L2 读延迟高 | 回载慢,TTFT 变差 | 异步加载、prefetch、就近 L1 |
| 异步加载失败 | 请求可能卡在等待态 | connector 失败旁路,回退本地重算 |
| 块 key 不一致 | 永远 miss | 固定模型/tokenizer/block size/cache salt |
| L1 被逐出 | 只命中 L2 | 从 NVMe 回载到 L1 再进 GPU |
| 显存不足/抢占 | KV 被释放 | 命中变少,依赖 L2/L1 复用 |

## 七、配置清单

| 目标 | 配置 |
|---|---|
| 让 vLLM 把 KV 写出去 | KV transfer config + `is_kv_producer` |
| 连接 LMCache | `lmcache.mp.server_urls`(MP server 地址) |
| 提前查缓存 | `lmcache.mp.eager_prefetch=True` |
| 保存 decode KV | `lmcache.mp.save_decode_cache=True` |
| 用 CPU 内存做 L1 | L1 DRAM(默认常见配置) |
| 用 NVMe 做 L2 | L2 adapter = 文件系统 / raw block,路径指向 NVMe |
| 跨机共享 | L2 = NIXL / Mooncake / P2P 等 |

## 八、观测:命中率要分三层看

- **GPU 本地前缀命中**:vLLM metrics / prefix cache 命中率。
- **LMCache L1/L2 命中**:lookup 返回的 placement;要区分 L1 hit 与 L2 hit。
- **回载成本**:retrieve 延迟、NVMe 读带宽、prefetch 命中率。
- **端到端**:TTFT(首 token)、TPOT(每 token)、吞吐;L2 命中会降低 prefill,但可能增加回载等待。

只看"命中率"不够:一次 L2 命中的价值,取决于它省下的 prefill 计算是否大于 NVMe 回载的延迟。

## 九、设计精妙之处

- **GPU 只做热层**:vLLM 的 PagedAttention 让 KV 可以按块管理,LMCache 才能按块搬运,而不是整段复制。
- **异步重叠**:`start_load_kv` 与 forward、`wait_for_save` 与后续 step 可以重叠,把回载/写回藏进计算。
- **分层而不侵入**:vLLM 不需要知道 LMCache 内部是 DRAM 还是 NVMe,只通过 KVConnector 的 5 个回调协作。
- **块级复用**:完整块 + 相同 hash 才能命中,这让"超长会话的前缀"天然适合缓存,也让跨请求/跨实例共享成为可能。

## 相关图示

- [超长会话 KV 生命周期]({{ '/llm-arch-dia/vllm-lmcache-long-session.html' | relative_url }})
- [LMCache KV 命中、加载与写回]({{ '/llm-arch-dia/lmcache-kv-flow.html' | relative_url }})
- [vLLM + LMCache 联合请求链路]({{ '/llm-arch-dia/vllm-lmcache-integration.html' | relative_url }})
- [LMCache 架构]({{ '/llm-arch-dia/lmcache-architecture.html' | relative_url }})

> 源码基线:vLLM `c724bb35d4e70201cf0fa6f2f1dcd802c6f9dad4` / LMCache `a4a688827def88f1df3e9af5fad43245913fca36`。行号会随版本漂移,以仓库重新 finalize 的结果为准。
