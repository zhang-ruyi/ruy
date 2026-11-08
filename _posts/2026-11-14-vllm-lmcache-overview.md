---
layout: post
title: "vLLM + LMCache 联合分析:执行引擎与 KV 缓存层如何协作"
date: 2026-11-14
categories: [ai-inference]
description: "从 KVConnector V1 的五个关键接口出发，拆解 vLLM 的调度、PagedAttention 与 LMCache 分层 KV 缓存如何拼成一条完整请求链路，并给出部署、调优与选型建议。"
---

大模型推理系统里，性能讨论经常把两件不同的事混在一起:一件是“算得快不快”，另一件是“KV 存得下不下、能不能复用”。前者是执行引擎的问题，后者是缓存系统的问题。vLLM 与 LMCache 的组合之所以值得单独分析，是因为它把这两件事拆成了两层，并用一组相对稳定的接口把它们缝在一起。理解这条缝的位置和语义，比记住某个 benchmark 数字更有价值。

本文基于两个具体版本展开:vLLM `c724bb35d4e70201cf0fa6f2f1dcd802c6f9dad4`，LMCache `a4a688827def88f1df3e9af5fad43245913fca36`。文中出现的函数与行号均在该版本内核对过，接口名称以 vLLM 的 KVConnector V1 为准。

## 一、问题背景:两类瓶颈，两种解法

LLM 推理可以粗略分成 prefill 与 decode 两个阶段。prefill 一次处理整段 prompt，计算量大、并行度高，通常是 compute-bound;decode 每步只生成一个 token，矩阵乘的算术强度低，更多受显存带宽和 kernel 启动延迟约束。两类阶段对资源的需求不同，但真正把系统顶到墙上的，往往是第三个量:KV cache。

KV cache 的大小与序列长度、层数、hidden size、batch 大小近似成正比。一个 32K 上下文、batch 不小的请求，KV 占用可以轻松吃掉数十 GB 显存。于是系统同时面对两座山:

1. **prefill 计算**:长 prompt、RAG 拼接、多轮对话历史，都会让 prefill 成为首 token 延迟(TTFT)的主要来源。
2. **KV 显存**:并发的长请求越多，KV 越挤，最终限制 batch、触发抢占(preemption)，甚至让请求排队。

vLLM 的 PagedAttention 解决的是“显存怎么被高效管理”:把 KV 切成固定大小的 block，用类似虚拟内存页表的 block table 做非连续映射，减少碎片，并让前缀相同的请求共享 block。但 PagedAttention 的复用范围仍然被限定在**单个实例的 GPU 显存**内:请求结束、block 被驱逐，KV 就没了;换一个 vLLM 实例，缓存也不通。

LMCache 补的正是这一块:把 KV 从“某个实例的显存”提升为“一个可跨请求、跨实例访问的分层缓存对象”。vLLM 负责算，LMCache 负责存与取，二者通过 KVConnector V1 交换“这段前缀的 KV 已经有了”这一事实。这就是“执行引擎 + 缓存层”拆分的根本原因。

<div class="callout callout-note">
<strong>一句话概括</strong>
<p>vLLM 优化的是“给定已有哪些 KV，如何最快算出剩下的 token”;LMCache 优化的是“如何让更多前缀的 KV 在更长时间、更大范围内保持可命中”。两者不是替代关系，而是流水线上的上下游。</p>
</div>

## 二、角色分工

先给出一张职责对照表，后面所有链路都可以回到这张表来定位。

| 维度 | vLLM(执行引擎) | LMCache(缓存层) |
| --- | --- | --- |
| 核心职责 | 请求调度、连续批处理、PagedAttention、GPU kernel 执行、采样 | 跨请求/跨实例 KV 复用、分层存储、异步加载与保存 |
| KV 管理单位 | 固定大小 block(由 `block_size` 决定) | chunk(MP 模式默认 256 token，可协商) |
| 复用范围 | 单个实例的 GPU HBM 内 | L1(DRAM/Device-DAX/GDS)+ L2(本地盘/远端存储) |
| 生命周期 | 随请求与 block 驱逐 | 由 TTL、LRU 与容量策略决定，可跨请求长期存在 |
| 对外接口 | `KVConnectorBase_V1` | `LMCacheMPConnector`(或 in-process 的 `LMCacheConnectorV1`) |
| 关键源码 | `vllm/v1/core/sched/scheduler.py`、`vllm/v1/core/kv_cache_manager.py` | `lmcache/integration/vllm/lmcache_mp_connector.py`、`lmcache/v1/distributed/storage_manager.py` |

需要强调:表里的“KV 管理单位”不同，是后面很多细节的根源。vLLM 以 block 为粒度分配和复用，LMCache 以 chunk 为粒度存取，二者的对齐关系决定了命中边界、尾部处理和元数据换算。

## 三、架构总览

先看执行引擎本身。vLLM V1 的调度器在一个 step 内决定哪些请求进入 batch、每个请求算多少 token，然后把结果交给 worker 执行;`KVCacheManager` 负责 block 的分配、回收和前缀查找。

<figure class="diagram"><iframe src="{{ '/llm-arch-dia/vllm-architecture.html' | relative_url }}" loading="lazy" title="vLLM 执行引擎架构"></iframe><figcaption>图 1:vLLM V1 执行引擎——调度器、KV 管理与 worker 执行的分层结构</figcaption></figure>

再看缓存层。LMCache 的 MP 模式把缓存做成独立 server，vLLM 进程通过 connector 与 server 通信;server 内部由 `StorageManager` 统一管理 L1 与 L2，`reserve_write`/`finish_write` 负责写入，`submit_prefetch_task`/`query_prefetch_status` 负责把 L2 的数据预取到 L1。

<figure class="diagram"><iframe src="{{ '/llm-arch-dia/lmcache-architecture.html' | relative_url }}" loading="lazy" title="LMCache 分层缓存架构"></iframe><figcaption>图 2:LMCache 分层缓存——connector 适配、MP server 与 L1/L2 存储管理</figcaption></figure>

把两层拼起来，就得到联合架构:请求在 vLLM 侧被调度，调度过程中通过 connector 查询 LMCache，命中则把外部 token 计入已计算量并异步搬运 KV，未命中则回落到本地 prefill;执行结束后再按策略把新产生的 KV 存回 LMCache。

<figure class="diagram"><iframe src="{{ '/llm-arch-dia/vllm-lmcache-integration.html' | relative_url }}" loading="lazy" title="vLLM 与 LMCache 联合请求链路"></iframe><figcaption>图 3:vLLM + LMCache 联合链路——本地命中、外部命中、未命中重算与异步存取</figcaption></figure>

## 四、完整请求链路

下面按一个请求从进入到结束的顺序，把关键判断点走一遍。这条链路的核心可以浓缩成一句话:**外部命中的 token 会被当作“已经算过”的 token，直接抬高 `num_computed_tokens`，从而跳过对应的 prefill 计算。**

### 4.1 本地前缀命中

调度器在请求首次被调度、且 `request.num_computed_tokens == 0` 时做前缀查找。vLLM 调用 `KVCacheManager.get_computed_blocks()`(`vllm/v1/core/kv_cache_manager.py:288`)，根据请求的 block hash 找到最长的本地缓存前缀。返回值包括命中的 block、命中 token 数，以及一个 `shared_prefix_boundary`。这里的命中是 **block 对齐**的，且有一个重要约束:即使整段 prompt 全部命中，也要保留最后一个 token 重新计算以获得 logits，所以 `get_computed_blocks` 会把最大命中长度限制在 `prompt_length - 1` 附近。

### 4.2 查询 LMCache 外部命中

如果配置了 connector，调度器会在本地命中之后调用 `get_num_new_matched_tokens()`。调用点在 `vllm/v1/core/sched/scheduler.py:1178`:

```python
ext_tokens, load_kv_async = self.connector.get_num_new_matched_tokens(
    request, block_aligned_local
)
```

注意传入的是 `block_aligned_local`，即把本地命中向下对齐到 block 边界后的长度。这样做是为了把一个“块对齐的本地命中”呈现给 connector，使得一个**严格更长**的远端命中可以覆盖本地命中中不足一个 block 的尾部，而不会与 copy-on-write 产生竞争(`scheduler.py:1170` 附近的注释说得很清楚)。

LMCache 侧的实现位于 `lmcache/integration/vllm/lmcache_mp_connector.py:1349`。它返回一个二元组:

- `ext_tokens`:`int | None`。表示在 `num_computed_tokens` 之外还能从外部缓存加载多少 token。返回 `None` 表示“还没查完”，调度器本 step 跳过该请求，稍后再问。
- `load_kv_async`:`bool`。表示这批外部 token 是否在调度 step 之间异步加载。契约要求:当 `ext_tokens == 0` 时必须为 `False`。

接口文档(`vllm/distributed/kv_transfer/kv_connector/v1/base.py:523`)还规定，connector 只能上报**当下确实可加载**的最长前缀;如果某些 token 因网络、驱逐等原因取不到，就不能计入。这条约束很重要，它把“缓存索引里存在”和“此刻能取到”区分开了。

### 4.3 未命中重算

如果 `ext_tokens == 0`，说明外部也没有可用前缀，调度器就把这段前缀交给本地 prefill 正常计算。此时 `num_external_computed_tokens = 0`，后面的分配与执行逻辑与没有 connector 时基本一致。

### 4.4 Scheduler 如何把外部命中计入 num_computed_tokens

这是整个协作里最关键的一步。在 `scheduler.py:1256` 附近，调度器把两类命中相加:

```python
num_computed_tokens = (
    num_new_local_computed_tokens + num_external_computed_tokens
)
```

也就是说，**外部命中的 token 与本地命中的 token 一样，被直接视为已计算**。随后 `num_external_computed_tokens` 会被传给 `KVCacheManager.allocate_slots()`(`scheduler.py:1497` 调用，`kv_cache_manager.py:401` 定义)。`allocate_slots` 的参数说明里给出了 block 布局:

```text
| < comp > | < new_comp > | < ext_comp > | < new > | < lookahead > |
```

其中 `ext_comp` 就是外部命中段:这些 block 会被分配出来，等待 KV 搬运写入，而不是由 GPU 计算填充。这个设计的意义在于，调度器可以在“KV 还没到”的时候就把请求当作“已经算到某个位置”来排布，从而把加载与计算重叠起来。

还有一个细节:vLLM 会把本地命中长度与外部命中长度做“取长”处理。如果本地命中存在不足一个 block 的尾部，而远端命中严格更长，调度器会用 `truncate_computed_blocks()` 把本地尾部裁掉，让远端加载覆盖它;如果远端没有更长，就保留本地尾部、不加载远端(`scheduler.py:1188-1205`)。这避免了“本地子块命中”和“远端加载”同时写同一段 KV。

### 4.5 异步加载与 WAITING_FOR_REMOTE_KVS

当 `load_kv_async == True` 时，调度器不会让请求立刻进入 running，而是把状态置为 `RequestStatus.WAITING_FOR_REMOTE_KVS`(`scheduler.py:1585`)，并**先把 `num_computed_tokens` 设成含外部命中的值**。注释明确说明:在传输完成前，这个值不会被使用;等传输结束，`_update_waiting_for_remote_kv()`(`scheduler.py:3616`)会缓存成功加载的 block，并把请求送回 WAITING。

worker 侧的加载由 `start_load_kv()` 发起。接口定义在 `base.py:340`，LMCache 的实现位于 `lmcache_mp_connector.py:996`。它遍历本 step 元数据里方向为 `RETRIEVE` 的请求，调用 `batched_submit_retrieve_requests()` 批量提交。之后 `wait_for_save()`(`base.py:393`，LMCache 实现见 `lmcache_mp_connector.py:1083`)负责在 forward 退出前完成保存侧的同步。

`build_connector_meta()`(`base.py:602`，LMCache 实现见 `lmcache_mp_connector.py:1663`)在每个 step 前把调度结果翻译成 connector 元数据:哪些请求要 RETRIEVE、哪些要 STORE、各自的 block 与 token 范围。LMCache 的实现里还会处理 `eager_prefetch` 触发的存储动作以及 lazy offload 的决策。

### 4.6 保存路径:默认只存完整 prompt chunk

执行完成后，新算出的 KV 是否回写 LMCache，由角色和策略决定。只有当 connector 具备 producer 角色时才允许存储(`lmcache_mp_connector.py:675` 附近的 `_can_store`)。默认行为是**只保存 prompt 内完整的 chunk**;生成阶段产生的 token 默认不保存。这与 `save_decode_cache` 配置直接相关:该开关默认 `False`，打开后才会把包含生成 token 的 chunk 也存下来(`lmcache/integration/vllm/lmcache_mp_metadata.py:381` 的条件判断)。对多轮对话，这会影响“上一轮生成的内容能否在下一轮被复用”。

## 五、关键接口对照

vLLM 的 KVConnector V1 定义了调度侧与 worker 侧的两组钩子。下表把接口、调用时机和 LMCache 的实现位置对齐。

| vLLM 接口(定义位置) | 调用时机 | LMCache 实现 | 作用 |
| --- | --- | --- | --- |
| `get_num_new_matched_tokens`(`base.py:523`) | 请求准入、本地命中之后 | `lmcache_mp_connector.py:1349` | 查询外部可加载 token 数及是否异步 |
| `update_state_after_alloc`(`base.py:576`) | `allocate_slots` 之后 | `lmcache_mp_connector.py:1569` | 把新分配的 block 追加进 tracker，推进状态机 |
| `build_connector_meta`(`base.py:602`) | 每个 step 前 | `lmcache_mp_connector.py:1663` | 生成 RETRIEVE/STORE 元数据，并重置本步状态 |
| `start_load_kv`(`base.py:340`) | worker forward 开始前 | `lmcache_mp_connector.py:996` | 批量提交异步加载 |
| `save_kv_layer`(`base.py:371`)/ `wait_for_save`(`base.py:393`) | forward 结束后 | `lmcache_mp_connector.py:1053` / `1083` | 提交保存并做必要同步 |
| `get_external_cache_hit_sources`(`base.py:557`) | `update_state_after_alloc` 之后 | 由 connector 按层实现 | 把外部命中拆分到 L1/L2 等来源，用于指标 |

`update_state_after_alloc` 有一个容易忽略的语义:对异步加载请求，它可能被调用**两次**——第一次是加载目标的初始分配，第二次是加载完成后为剩余 token 追加分配。LMCache 的实现因此只追加“超出已跟踪数量”的 block(`lmcache_mp_connector.py:1595` 附近),避免重复索引破坏存储路径的 block 换算。这个细节如果实现错了，表现往往是“存进去的 KV 偏移错位”，而不是立刻报错。

另一个接口是 `bind_kv_cache_manager`(`base.py:497`)。调度器在构造完成后把 `KVCacheManager` 绑定给 connector(`scheduler.py:382` 附近)，使 connector 能访问缓存管理器的状态。这也是为什么 connector 既能做“外部查询”，又能参与“本地命中对齐”。

## 六、部署形态与配置

### 6.1 两种部署形态

LMCache 与 vLLM 的集成有两种形态:

- **in-process(`LMCacheConnectorV1`)**:LMCache 逻辑跑在 vLLM 进程内，适合快速验证与单机场景。
- **multi-process(`LMCacheMPConnector`)**:LMCache 作为独立 server 运行，一个 server 可以被多个 vLLM 实例共享。这是跨实例复用和集中式分层存储的推荐形态。

vLLM 侧的开关是 `--kv-transfer-config`，对应 `KVTransferConfig`(`vllm/config/kv_transfer.py:68`)。关键字段包括 `kv_connector`(第 71 行)、`kv_role`(第 82 行)、`kv_port`(第 87 行)、`kv_connector_extra_config`(第 90 行)。其中 `kv_role` 取 `kv_producer`、`kv_consumer` 或 `kv_both`;如果只做本地复用，`kv_both` 最常见。

一个典型的 MP 启动参数如下(单花括号，避免模板冲突):

```bash
vllm serve Qwen/Qwen3-14B \
  --kv-transfer-config '{"kv_connector":"LMCacheMPConnector","kv_role":"kv_both","kv_connector_extra_config":{"lmcache.mp.host":"tcp://127.0.0.1","lmcache.mp.port":6555}}'
```

`lmcache.mp.server_urls` 支持传入列表或逗号分隔的多地址，例如 `tcp://host1:6667,tcp://host2:6667`;不传时回落为 `lmcache.mp.host` + `lmcache.mp.port`(`lmcache_mp_connector.py:594` 的类文档)。常见部署是每个节点跑一个 LMCache DaemonSet，vLLM pod 通过节点回环地址连接，这样 L1 的共享范围被限制在节点内。

### 6.2 LMCache server 与 L1/L2

LMCache server 的常用参数:

```bash
lmcache server \
  --port 6555 \
  --chunk-size 256 \
  --l1-size-gb 20 \
  --eviction-policy LRU \
  --l2-adapter '{"type":"fs","base_path":"/mnt/archive/lmcache"}'
```

默认端口是 5555，默认 chunk 大小是 256 token(`docs/source/mp/configuration.rst:84`、`:87`)。`--l1-size-gb` 指定 L1 容量，L1 默认是 pinned DRAM，也可以换成 Device-DAX/CXL 或 GDS;L2 通过可重复的 `--l2-adapter` 配置，顺序即级联顺序(`configuration.rst:371`、`:723`)。L2 adapter 的类型很丰富:本地文件系统、`nixl_store`、Mooncake、Valkey、Aerospike、S3、HF3FS、raw block，以及 P2P 等。

L1 的后端类型在 `lmcache/v1/distributed/api.py:95` 定义为 `DRAM`、`DEVDAX`、`GDS`;`StorageManager`(`lmcache/v1/distributed/storage_manager.py:131`)统一管理这些层级，`reserve_write`(`:287`)、`finish_write`(`:347`)完成写入，`read_prefetched_results`(`:388`)、`submit_prefetch_task`(`:535`)完成读取与预取。L2 命中不会直接变成 vLLM 的命中，它需要先被预取到 L1，再通过 RETRIEVE 搬进 GPU。

### 6.3 两个值得单独说的开关

**`eager_prefetch`**:当请求进入 vLLM 等待队列时就提交 LMCache 查询(`lmcache_mp_connector.py:686`、`:1548`)。好处是把查找延迟藏到排队时间里，坏处是可能为最终没被调度的请求做无用查询。默认关闭。

**`save_decode_cache`**:默认 `False`，只存 prompt 内完整 chunk;打开后会把生成 token 也存下来(`lmcache_mp_connector.py:675`、`:1914`)。它提升多轮场景的复用率，但会增加写放大和 L2 容量压力。

另外，`kv_load_failure_policy`(`vllm/config/kv_transfer.py:100`)决定加载失败后的行为:默认 `fail` 直接失败，`recompute` 则回退重算。生产环境通常更愿意选 `recompute`，用一点算力换取可用性。

<div class="callout callout-warning">
<strong>关于 --no-enable-prefix-caching</strong>
<p>不少 LMCache 示例会显式关闭 vLLM 的本地 prefix cache，目的是让 LMCache 成为唯一的缓存源，便于观测和压测。生产环境里两者可以共存:调度器会把块对齐的本地命中交给 connector，并允许更长的外部命中覆盖本地子块尾部。是否关闭，应基于“想要 GPU 内快命中，还是想要单一缓存口径”来决定。</p>
</div>

## 七、性能与权衡

### 7.1 命中率不是唯一指标

LMCache 的命中以 chunk 为单位，而 vLLM 的复用以 block 为单位。命中率至少有三个层次:请求级命中率、token 级命中率、以及“命中且加载划算”的有效命中率。一个 90% token 命中的请求，如果剩下 10% 的 token 恰好很长、而加载又要走慢速 L2/网络，端到端未必更快。所以看命中率时一定要同时看加载延迟和 TTFT。

### 7.2 TTFT、吞吐与传输成本

外部命中把 prefill 的算力省掉了，但引入了 KV 传输。是否划算取决于一个简单的不等式:

```text
传输时间(命中 token 的 KV 大小 / 有效带宽) < 重算时间(命中 token 的 prefill 时间)
```

长前缀、高带宽(L1 DRAM、CUDA IPC、节点内 NVLink/PCIe)时，左边远小于右边，收益明显;短前缀、跨机网络、或 L2 走远端存储时，左边可能反超。异步加载通过“先分配、后搬运、与调度重叠”来隐藏一部分延迟，但不能突破带宽上限。

### 7.3 显存、内存与 IO

LMCache 并不会凭空增加 GPU 显存。它的直接价值是把 KV 的**保存期限和共享范围**从 GPU 显存扩展出去:请求结束后，KV 可以留在 L1 DRAM 甚至 L2，下一次相同前缀到来时再搬回。间接价值是减少重复 prefill，从而在相同 GPU 上服务更多请求。代价是主机内存、L2 存储容量和 IO 带宽的消耗，以及 server 侧的 CPU 开销。

### 7.4 什么场景适合，什么场景不需要

适合:

- 多轮对话:系统提示词和对话历史高度重复。
- RAG/文档问答:同一批文档被反复拼接进 prompt。
- 共享系统提示的大规模服务:固定前缀可以在实例间共享。
- prefill/decode 分离:producer 算完的 KV 交给 consumer 复用。
- 单实例显存不足以长期保留高价值前缀。

不需要或收益有限:

- prompt 高度唯一、重复率低。
- 请求很短，prefill 本来就便宜。
- 单实例、低并发，vLLM 本地 prefix cache 已经够用。
- 网络或 L2 带宽是瓶颈，加载比重算还慢。
- 对尾延迟极敏感、又不愿意用预取隐藏延迟。

## 八、观测与压测

vLLM 暴露了本地与外部两套前缀缓存指标:`vllm:prefix_cache_queries` / `vllm:prefix_cache_hits`(`vllm/v1/metrics/loggers.py:661`)与 `vllm:external_prefix_cache_queries` / `vllm:external_prefix_cache_hits`(`loggers.py:685`)。注意不要把两套计数混在一起算命中率，否则会重复计算重叠前缀。

LMCache 侧可以观测 MP 查询延迟(`lmcache/integration/vllm/lmcache_mp_metrics.py:55`)、L1/L2 命中分布(`PrefetchResult` 里的 `l1_hit_cells` 与 `l2_hit_cells`，见 `lmcache/v1/distributed/api.py:834`)、以及 `StorageManager` 的容量与驱逐事件。压测时建议至少记录:

- TTFT 与 TPOT 的 p50/p99;
- token 级缓存命中率(本地、外部、按 L1/L2 拆分);
- 外部加载延迟与失败率;
- L1/L2 占用、驱逐次数、写放大;
- 抢占次数与 block 分配失败次数;
- 网络吞吐与有效带宽。

压测工具可以用 LMCache 自带的 `benchmarks/long_doc_qa`、`benchmarks/multi_round_qa`、`benchmarks/microbenchmark`，也可以用 vLLM 的 `benchmark_serving`、`benchmark_prefix_caching` 与 `benchmarks/multi_turn`。关键是构造**有重复前缀**的负载，否则测不出缓存层的差异。

## 九、vLLM 本地 prefix cache 与 LMCache 对比

| 维度 | vLLM 本地 prefix cache | LMCache |
| --- | --- | --- |
| 位置 | GPU HBM 中的 paged block | L1 DRAM/Device-DAX/GDS + L2 盘/远端 |
| 容量 | 受 `gpu_memory_utilization` 限制 | 可到数百 GB 到 TB 级 |
| 复用范围 | 单实例内、请求之间 | 跨请求、跨实例、跨进程 |
| 命中延迟 | 纳秒到微秒级(直接引用 block) | 微秒到毫秒级(DRAM/IPC)甚至更高(网络/盘) |
| 数据搬运 | 基本无拷贝 | 需要 KV transfer |
| 失效策略 | 请求结束/驱逐即释放 | TTL、LRU、容量驱逐，可异步保存 |
| 部署复杂度 | 内置，几乎零配置 | 需要 server、层级与网络配置 |
| 适用场景 | 单实例高并发、重复前缀 | 多实例/多轮/大容量/跨机复用 |

结论不是“谁更好”，而是“谁先命中”。理想的顺序是:先让 GPU 内的本地 prefix cache 吃掉最快的那部分命中，再用 LMCache 接住显存放不下、或跨实例才能复用的部分。

## 十、常见误区

**误区一:命中就一定更快。** 传输有成本。命中一段很长的 KV，如果它躺在慢速 L2 或远端，搬运时间可能超过重算。要看有效带宽和前缀长度，而不是只看命中率。

**误区二:异步加载不需要预留 block。** 异步只是把搬运与调度重叠，目标 block 必须在加载前分配好。调度器通过 `allocate_slots` 的 `num_external_computed_tokens` 和 `delay_cache_blocks` 预留空间(`kv_cache_manager.py:401`)，并用 `reserved_blocks` 做准入闸门，避免外部加载把正在 prefill 的请求所需的 block 吃掉。

**误区三:decode 产生的 KV 默认也会保存。** 默认只存 prompt 内完整 chunk。多轮对话里，如果希望复用上一轮生成的内容，需要显式打开 `save_decode_cache`。

**误区四:跨机一定比本地强。** 跨机 L2 受网络带宽和尾延迟约束。节点内 L1 的收益通常最稳，跨机更适合“容量换命中”而非“延迟换命中”。

**误区五:把 LMCache 当无限显存。** 它缓存的是 KV 副本，不是计算资源;L1 是主机内存，L2 是存储。容量上去了，IO 和带宽也会成为新的墙。

**误区六:命中可以精确到任意 token。** 命中按 chunk/block 对齐，尾部不足一个单位的 token 通常要重算。全量命中也要重算最后一个 token 以取得 logits。

**误区七:两套缓存会互相打架。** 设计上它们是组合关系:本地命中先呈现为块对齐结果，外部更长命中可以覆盖本地子块尾部，调度器用 `truncate_computed_blocks` 处理边界。真正需要小心的是指标口径，而不是语义冲突。

## 十一、结论与选型建议

把这条链路拉直看，vLLM 与 LMCache 的分工非常清晰:vLLM 决定“这一步算什么”，LMCache 决定“哪些可以不算”。二者通过 `get_num_new_matched_tokens` 交换命中长度，通过 `num_computed_tokens` 把外部命中纳入调度，通过 `start_load_kv`/`wait_for_save` 完成搬运，通过 `build_connector_meta` 把每步意图落到 worker。理解这五个点，就理解了整套协作。

选型上可以按下面的顺序决策:

1. **先测本地**:单实例、低并发、prompt 重复率一般时，先用 vLLM 自带 prefix cache，不要过早引入外部依赖。
2. **再看容量与范围**:如果瓶颈是“显存放不下高价值前缀”或“需要跨实例复用”，再上 LMCache。
3. **优先 L1**:从 DRAM L1 开始，配合 `eager_prefetch` 隐藏查询延迟;命中率稳定后再考虑 L2。
4. **按负载调 chunk 与开关**:chunk 越小命中越细但元数据开销越大;多轮场景评估 `save_decode_cache`;延迟敏感场景评估 `eager_prefetch` 的收益与浪费。
5. **始终用数据说话**:同时看 TTFT/TPOT、加载延迟、L1/L2 命中、带宽与驱逐，避免只盯命中率。

一句话:如果重复前缀是你负载里的主要矛盾，LMCache 值得;如果重复前缀本来就少，把 vLLM 的调度与 PagedAttention 调好，收益更直接。

## FAQ

**Q1:vLLM 已经有 prefix cache，为什么还需要 LMCache?**
vLLM 的 prefix cache 在 GPU 显存里，范围限于单实例、生命周期受 block 驱逐约束。LMCache 把 KV 放到主机内存和更下层存储，并支持跨实例共享，解决的是容量和范围问题。

**Q2:LMCache 命中后，vLLM 还会重算吗?**
命中的 token 会计入 `num_computed_tokens`，对应 prefill 被跳过;但最后一个 token 通常仍要重算以产生 logits。未命中的部分照常 prefill。

**Q3:什么时候 `get_num_new_matched_tokens` 会返回 None?**
当 connector 还无法确定可加载 token 数时(例如查询尚未完成)。调度器会跳过该请求、稍后再问，而不是把它当作未命中。

**Q4:异步加载失败怎么办?**
由 `kv_load_failure_policy` 决定:默认 `fail` 使请求失败，`recompute` 则让调度器回退重算。LMCache 在检测到失败后会清理该请求的 tracker，并把请求标记为绕过 LMCache，避免卡在 `WAITING_FOR_REMOTE_KVS`。

**Q5:L1 和 L2 应该怎么选?**
先用 DRAM L1，延迟最低、收益最直接;需要更大容量或持久化时再加 L2(本地盘、远端存储、P2P 等)。L2 命中需要先预取到 L1，再搬进 GPU，链路更长。

**Q6:chunk 大小会影响什么?**
影响命中粒度、元数据开销与对齐损失。MP 默认 256 token，且可能根据模型 KV 几何向上协商。chunk 越小越灵活，但管理和传输开销更高。

**Q7:能不能只让部分实例做 producer?**
可以。`kv_role` 支持 `kv_producer`/`kv_consumer`/`kv_both`，在 prefill/decode 分离等场景下，producer 负责算并保存，consumer 负责取用。
