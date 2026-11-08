---
layout: post
title: "LMCache 精读:把 KV Cache 变成可复用的一层存储"
date: 2026-11-16
categories: [ai-inference]
description: "从 MP 架构、ObjectKey 与 object group 数据模型,到 L1/L2 命中与写回路径,系统拆解 LMCache 如何把 KV Cache 变成跨请求、跨实例可复用的存储层。"
---

大模型推理里,prefill 和 decode 的成本结构并不对称。prefill 要把整段 prompt 过一遍模型,计算密集、首 token 延迟高;decode 每步只处理一个 token,却要反复读写不断变长的 KV Cache。对 agent、RAG、多轮对话、代码补全这类"同一段前缀被反复使用"的负载来说,真正昂贵的往往不是生成,而是把相同前缀重新 prefill 一遍。

vLLM 自带的 paged KV 和 prefix caching 已经能在**单个引擎实例内部**复用前缀。但它的边界也很清晰:GPU 显存有限,缓存随实例生命周期存在,跨副本、跨节点、重启之后都不共享。LMCache 想做的,是把 KV Cache 从"某个进程里的临时张量"提升为**一层可寻址、可分层、可跨实例复用的存储**:请求 A 写下的 KV,请求 B 可以命中;实例 1 写下的 KV,实例 2 可以命中;GPU 里放不下的 KV,可以沉到 DRAM、NVMe,甚至远端存储和别的节点。

这篇文章按源码读一遍 LMCache 的多进程(MP)实现,重点回答四个问题:它如何组织数据,如何判定命中,如何把 KV 搬进搬出,以及它和 vLLM 本地前缀缓存到底是什么关系。以下行号基于 LMCache HEAD `a4a688827def88f1df3e9af5fad43245913fca36`。

<div class="callout callout-info">
<p><strong>先给结论:</strong> LMCache 不是“更快的磁盘”,而是一层以 chunk/ObjectKey 为索引、以 L1/L2 分层、通过 vLLM connector 接入的两级 KV 缓存。它复用的是“已经算过的前缀状态”,不是“文件”。</p>
</div>

<figure class="diagram"><iframe src="{{ '/linux-arch-dia/LLM推理/lmcache-architecture.html' | relative_url }}" loading="lazy" title="LMCache 架构:KVCache 缓存层"></iframe><figcaption>图 1:LMCache MP 架构。vLLM 侧是 connector 与 scheduler/worker adapter,服务侧是 MP server、LookupModule、KeyDirectory 与 StorageManager,L1/L2 再向下分层。</figcaption></figure>

## 一、定位:在 prefill 之前多问一句"这段前缀算过吗"

LMCache 的核心价值不是"缓存张量",而是**把 prefill 的结果变成可复用的前缀状态**。一次请求进来,理想路径是这样:

1. vLLM scheduler 在分配 KV block 之前,先问 connector:这段 prompt 在外部缓存里有没有已经算好的前缀?
2. connector 把 token 序列按 chunk 切分、哈希,发一次 LOOKUP。
3. LMCache 在 L1(本机内存)和 L2(磁盘/远端)里找前缀,返回命中的 token 数。
4. vLLM 只为"没命中的部分"分配计算;命中的部分通过 RETRIEVE 直接写回 paged KV。
5. 前向结束后,新算出的 KV 再通过 STORE 写回 LMCache,供下一次请求使用。

这条路径直接削减的是 prefill 计算量和首 token 延迟,同时把"缓存容量"从 GPU 显存扩展到 CPU DRAM 和更慢但更大的存储层。它和"把 KV 放到 CPU 上做 swap"不是一回事:swap 服务于单个请求的显存压力,而 LMCache 服务于**跨请求的前缀复用**。

LMCache 有两种运行形态:in-process 和 multiprocess(MP)。前者与 vLLM 同进程,部署简单;后者把缓存服务拆成独立进程,通过 ZMQ 或 gRPC 通信。本文主要看 MP,因为它把"缓存是一层独立基础设施"这件事体现得最完整:进程隔离、多个 vLLM 副本共享同一份 L1、缓存进程的 GIL 和 I/O 不进入推理主路径。

## 二、架构:四条边界把推理与缓存解耦

MP 模式的组件可以按"谁在调用谁"分成四段。

**第一段是 vLLM connector。** `LMCacheMPConnector` 继承 vLLM 的 `KVConnectorBase_V1`,同时实现 scheduler 和 worker 两个角色。构造函数在 `lmcache/integration/vllm/lmcache_mp_connector.py:594`。scheduler 角色创建 `LMCacheMPSchedulerAdapter`(`lmcache_mp_connector.py:798`),worker 角色创建 `LMCacheMPWorkerAdapter`(`lmcache_mp_connector.py:831`)。这两个 adapter 是 LMCache 对 vLLM 暴露的全部接口面:前者负责"查得到多少",后者负责"搬得进来、搬得出去"。

**第二段是 scheduler/worker adapter 到 MP server 的 RPC。** scheduler adapter 通过 `maybe_submit_lookup_request`(`lmcache/integration/vllm/vllm_multi_process_adapter.py:710`)发 LOOKUP,通过 `check_lookup_result`(`vllm_multi_process_adapter.py:794`)轮询结果;worker adapter 通过 `submit_store_request`(`vllm_multi_process_adapter.py:1678`)和 `submit_retrieve_request`(`vllm_multi_process_adapter.py:1761`)提交搬运任务。这两类调用都由 worker 侧的 request client 发出,client 按 URL scheme 选择 ZMQ 或 gRPC,服务端传输层由 `--transport` 决定,两者必须匹配。

**第三段是 MP server 内部的模块。** `MPCacheServer`(`lmcache/v1/multiprocess/server.py:76`)本身是一个很薄的组合器,真正的请求处理按操作名分发给 `EngineModule`。前缀查找落在 `LookupModule`(`lmcache/v1/multiprocess/modules/lookup.py:136`),它负责 LOOKUP、QUERY_PREFETCH_STATUS、FREE_LOOKUP_LOCKS 和 END_SESSION;真正的存储编排落在 `StorageManager`(`lmcache/v1/distributed/storage_manager.py:131`)。

**第四段是全局放置视图。** `KeyDirectory`(`lmcache/v1/mp_coordinator/views/key_directory.py:175`)属于 MP coordinator,不是每个缓存 server 的本地哈希表。它通过 cache event 汇聚"哪个实例、哪一层、哪个 backend 上有这个 key",`lookup` 返回每个 key 的 `Placement` 列表(`key_directory.py:305`)。这里要区分两个层次:请求热路径上的前缀命中主要依赖本地 `StorageManager` 的 L1/L2 状态;coordinator 的 `KeyDirectory` 提供的是**跨实例的全局放置视图**,用于路由、淘汰和运维观测。把两者混为一谈,是读 MP 架构时最常见的误解之一。

<figure class="diagram"><iframe src="{{ '/linux-arch-dia/LLM推理/lmcache-kv-flow.html' | relative_url }}" loading="lazy" title="LMCache KV 命中、加载与写回"></iframe><figcaption>图 2:一次请求的 KV 命中与写回时序。scheduler 先 LOOKUP,worker 再 RETRIEVE 到 vLLM paged KV;前向结束后 STORE 回 L1,并由后台控制器决定是否继续下沉到 L2。</figcaption></figure>

## 三、数据模型:chunk、ObjectKey、object group、kv_rank 与 bitmap

LMCache 的缓存单位不是"整个请求",也不是"单个 token",而是 **chunk**。一个 chunk 覆盖固定数量的 token,chunk 内所有层的 KV 被打包成一个或多个对象。chunk size 不是随便定的:`lmcache server --chunk-size` 只是下限,connector 会在启动时用每个可缓存 KV group 的 block 跨度求最小公倍数,再把配置值向上取整到该对齐(`docs/source/mp/chunk_size_negotiation.rst`)。例如 group 跨度为 32 和 48,对齐是 96,配置 256 会落成 288;配置 600 且对齐 544 会落成 1088。一个 MP server 的最终 chunk size 一旦绑定就不可变,多个 server 必须协商出同一个值。

```text
required_alignment = lcm(group_tokens_per_block...)
final_chunk_size = smallest multiple of required_alignment
                   that is >= --chunk-size
```

chunk 的内容哈希加上并行身份,构成 `ObjectKey`。`ObjectKeyIdentity`(`lmcache/v1/distributed/api.py:202`)包含:

- `chunk_hash`:chunk 内容的哈希;
- `model_name`:模型名,LoRA、revision 等身份信息会以 tag 的形式进入 key;
- `kv_rank`:这个对象属于哪个 KV 并行 rank;
- `object_group_id`:对象组的编号;
- `cache_salt`:租户/隔离域;
- `tags`:额外的匹配维度。

`ObjectKey`(`api.py:226`)是不可变 dataclass,`extra_attributes` 不参与相等和哈希,只作为请求级元数据透传给 L2 adapter。这个设计很关键:它让"缓存身份"保持稳定,又允许上层在不改变 key 的前提下携带 trace、TTL、租户策略等信息。

`kv_rank` 名字叫 rank,实际是一个把并行拓扑压进 32 位的整数。`ObjectKey.ComputeKVRank`(`api.py:368`)按 `world_size << 24 | global_rank << 16 | local_world_size << 8 | local_rank` 打包,docstring 里把它画成"按层重复的 bitmap"。当前实现还没有做真正的非对称并行位图,但这个编码已经能区分不同 TP/PP 布局,避免把拓扑不兼容的 KV 混在一起。LOOKUP 时如果没有指定 worker,`_lookup_kv_ranks`(`api.py:45`)会把 key 展开到该 world size 下的所有 rank;worker 自己的 STORE/RETRIEVE 则只寻址自己那一片。

**object group** 是混合注意力模型带来的概念。`GroupKind`(`api.py:547`)把对象组分成 `attention`、`recurrent`、`aux`:普通注意力 KV、Mamba/GDN 之类的循环状态页、以及 connector 私有的辅助组。`AttnWindowDesc`(`api.py:627`)用 `num_chunks_in_sw` 描述每个组的跨 chunk 依赖:

- `-1` 表示 full attention,服务一个前缀需要它前面的**全部** chunk;
- `w >= 1` 表示滑动窗口,只需要末尾 `w` 个 chunk;
- 循环状态组通常按 1 个 chunk 处理,因为它的状态是"最新快照",不是可累加的历史。

这解释了为什么 LMCache 不能简单地"每个 group 各查各的"。一个前缀要被判定为可服务,必须所有 group 都能满足自己的窗口约束。`fold`(`lmcache/v1/distributed/bitmap_ops/fold.py:92`)把每个 group 的 presence bitmap 折成一张 servable bitmap:第 `j` 位为 1,当且仅当所有 group 都能服务第 `j` 个 chunk;`highest_set_bit`(`fold.py:141`)再把它变成"最长可服务前缀长度"。`fold_grouped`(`fold.py:205`)和 `unfold_grouped`(`fold.py:252`)处理多组、多 rank 的行列展开,`PrefetchResult`(`api.py:834`)则用 `hit_cells`、`l1_hit_cells`、`l2_hit_cells` 三张 bitmap 分别表示"最终命中""L1 本来就有""L2 补出来的部分"。

用一句话概括这套模型:**chunk 决定粒度,ObjectKey 决定身份,object group 决定依赖,kv_rank 决定分片,bitmap 决定前缀能否成立。**

## 四、L1:DRAM、DEVDAX 与 GDS

L1 是 LMCache 的"热层",也是它和 vLLM 本地 KV 最本质的区别:L1 可以是一个独立进程管理的、跨多个 vLLM 副本共享的内存池。

`L1BackendType`(`api.py:95`)把 L1 介质限定为三种:

| L1 介质 | 实现 | 特点 | 适用场景 |
| --- | --- | --- | --- |
| DRAM | `DramL1Manager` | 主机内存,可懒分配、可用共享内存/大页 | 大多数在线推理,追求最低命中延迟 |
| DEVDAX | `DevDaxL1Manager` | 直接映射 Device-DAX/CXL 内存,无隐式 DRAM 池 | 大容量持久内存、CXL 扩展内存 |
| GDS | `GdsL1Manager` | NVMe slab,经 cuFile/hipFile 或 GPUDirect Storage 访问 | 单机大容量、希望绕过 CPU 拷贝的热层 |

工厂入口是 `create_l1_manager`(`lmcache/v1/distributed/l1_manager/factory.py:15`),三种 manager 分别实现在 `dram.py`、`devdax.py`、`gds.py`。它们共同实现 `BaseL1Manager`(`lmcache/v1/distributed/l1_manager/base.py:142`)的 `reserve_read`、`reserve_write`、`finish_write`、`finish_read`、`delete`、`touch_keys` 等接口,核心是**带 TTL 的读写锁**:对象在被读取或写入期间不能被淘汰,读锁可以被多个读者共享,写锁互斥。`StorageManager.reserve_write`(`storage_manager.py:287`)先由 write policy 选 L1,再向对应 manager 预留;`finish_write`(`storage_manager.py:347`)在数据真正写入后把对象"发布"给读者。

MP 模式支持多个 L1 manager 并存(`docs/source/mp/multi_l1.rst`),按 `--l1-manager` 的书写顺序决定写入优先级。默认 write policy 把 key 放到第一个 manager;某个 manager OOM 就是该 key 的结果,不会自动重试到下一个。每个 L1 有独立的淘汰控制器,每个 L2 adapter 则绑定一个 L1:通常是第一个 DRAM manager,没有 DRAM 时取第一个 DEVDAX。这个绑定关系决定了"L2 回填到哪里",也意味着只有 GDS 的 server 不能直接使用现有的 L2 adapter。

## 五、L2:一个开放的 adapter 注册表

L2 是"容量层",负责把 L1 里放不下的 KV 持久化或搬到更远的地方。LMCache 没有把 L2 写死成某一种存储,而是做成了**自注册的 adapter 注册表**。

`register_l2_adapter_factory`(`lmcache/v1/distributed/l2_adapters/factory.py:62`)让每个 adapter 模块在 import 时注册自己的工厂;`create_l2_adapter_from_registry`(`factory.py:177`)按类型名创建实例。内置 adapter 通过 `pkgutil` 发现,但**按需 import**:只有真正请求某个类型时才加载对应模块和第三方依赖,避免把 Mooncake、NIXL、HF3FS 的依赖全部拖进启动路径。

目前仓库里能看到这些 L2 适配器:

| L2 adapter | 配置入口 | 底层 | 适用场景 |
| --- | --- | --- | --- |
| 文件系统 `fs` | `FSL2AdapterConfig`(`fs_l2_adapter.py:178`) | 本地/网络文件系统 | 最简单、最通用的持久化层 |
| `fs_native` | `FSNativeL2AdapterConfig`(`fs_native_l2_adapter.py:57`) | 原生文件 I/O | 希望绕开 Python 文件开销 |
| `raw_block` | `RawBlockL2AdapterConfig`(`raw_block_l2_adapter.py:221`) | 裸块设备/预分配文件,POSIX `pread/pwrite` 或 Rust io_uring | 需要 O_DIRECT、低开销、NVMe 直写 |
| NIXL native | `NixlNativeL2AdapterConfig`(`nixl_native_l2_adapter.py:49`) | NIXL backend(POSIX/OBJ 等) | 统一走 NIXL 生态的远端/本地存储 |
| NIXL store | `NixlStoreL2AdapterConfig`(`nixl_store_l2_adapter.py:950`) | GDS/GDS_MT/POSIX/HF3FS/OBJ/Azure Blob | 已有 NIXL store 集群 |
| Mooncake | `MooncakeStoreL2AdapterConfig`(`mooncake_store_l2_adapter.py:46`) | Mooncake Store 原生 C++ connector | 分布式 KV/对象存储池 |
| HF3FS | `Hf3fsL2AdapterConfig`(`hf3fs_l2_adapter.py:47`) | 3FS 原生 C++ connector | 高性能分布式文件系统 |
| P2P | `P2PL2AdapterConfig`(`p2p_l2_adapter.py:88`) | 对等节点 lookup + RDMA transfer channel | 跨节点复用、避免中心化存储 |
| DAX | `DaxL2AdapterConfig`(`dax_l2_adapter.py:181`) | Device-DAX | 大容量持久内存 |
| 其他 | S3、Redis/Valkey、Aerospike、Bigtable、RESP、SageMaker HyperPod 等 | 对象/键值/云存储 | 跨机房、低成本归档 |

`raw_block` 值得单独说一句。它把设备切成固定大小的 slot,用 header 和 metadata checkpoint 管理分配与恢复;`io_engine` 可选 `posix` 或 `io_uring`(`raw_block_l2_adapter.py:242`),`use_uring_cmd` 还能走 NVMe 字符设备的 passthrough,并支持 FDP 放置提示。对追求"KV 直写 NVMe、尽量少占 CPU"的部署,这是比文件系统更贴近硬件的路径。

所有 L2 adapter 实现同一套异步接口(`lmcache/v1/distributed/l2_adapters/base.py`):`submit_store_task`、`pop_completed_store_tasks`、`submit_lookup_and_lock_task`、`query_lookup_and_lock_result`、`submit_load_task`、`query_load_result`、`submit_unlock`、`submit_touch`。这套接口的关键词是 **lookup-and-lock**:L2 查找不仅要返回"有没有",还要在返回结果期间把对象锁住,防止在 L1 回填之前被别的路径淘汰。

## 六、命中路径:从 LOOKUP 到写回 paged KV

现在把一次命中拆开看。

**第一步,scheduler 发起查询。** `get_num_new_matched_tokens`(`lmcache_mp_connector.py:1349`)是 vLLM 给 connector 的入口。它先取请求对应的 tracker,再调用 `maybe_submit_lookup_request`(`vllm_multi_process_adapter.py:710`)。后者把 token 序列按 chunk 对齐,生成一个去掉 worker 维度的 key,然后向每个 server 发 LOOKUP。注意这里**不等待 ack**:LOOKUP 只是提交,真正的结果由 `check_lookup_result`(`vllm_multi_process_adapter.py:794`)轮询 `QUERY_PREFETCH_STATUS` 得到。如果结果还没好,connector 返回 `(None, True)`,vLLM 下一轮再问;如果命中 0 个 chunk,返回 `(0, False)`;否则返回需要加载的 token 数和 `True`。

**第二步,server 做前缀查找和预取。** `LookupModule.lookup`(`lookup.py:199`)先做 token 哈希,再按 `(object group, kv_rank)` 生成一组 `GroupedObjectKeys`,最后调用 `StorageManager.submit_prefetch_task`(`storage_manager.py:535`)。真正干活的是 `PrefetchController`(`lmcache/v1/distributed/storage_controllers/prefetch_controller.py:499`):

1. `_start_lookup_phase`(`prefetch_controller.py:1158`)登记请求;
2. `_lock_l1_keys`(`prefetch_controller.py:1214`)先在所有允许的 L1 manager 上 `reserve_read`,把 L1 已经有的 key 锁住并记录成 bitmap;
3. 对合格的 L2 adapter 发 `submit_lookup_and_lock_task`;
4. `_plan_load`(`prefetch_controller.py:1256`)根据 L1/L2 的 bitmap 和每个 object group 的窗口,决定最终要保留哪些 key,并把计划外的锁释放掉;
5. 为 L2 命中项在 L1 预留写缓冲,`_submit_load_tasks`(`prefetch_controller.py:1433`)提交 L2→L1 的加载;
6. `_poll_load_results`(`prefetch_controller.py:1561`)在加载完成后把对象从"staging"转成"可读",失败项删除并释放 L2 锁;
7. `_finish_request`(`prefetch_controller.py:1666`)结算锁并发布结果。

结果是一组 bitmap,`LookupModule` 把它折叠成"命中多少个 chunk",再换算成 token 数返回给 connector。

**第三步,scheduler 记账并生成 RETRIEVE 元数据。** `update_state_after_alloc`(`lmcache_mp_connector.py:1569`)拿到 vLLM 分配的 block 列表,只追加"还没记录过"的部分,避免异步加载第二次回调时重复追加。它还会根据 `num_external_tokens` 和 tracker 状态,把请求从 `PREFETCHING` 推到 `WAITING_FOR_LOAD` 或 `READY`,并释放那些"vLLM 已经自己算过、不需要从 LMCache 取"的 chunk 上的读锁。随后 `build_connector_meta`(`lmcache_mp_connector.py:1663`)把 RETRIEVE/STORE 请求写进本 step 的 connector metadata。

**第四步,worker 把 KV 搬进 GPU。** vLLM 在 forward 之前调用 `start_load_kv`(`lmcache_mp_connector.py:996`),connector 收集所有 `direction == "RETRIEVE"` 的请求,调用 `batched_submit_retrieve_requests`(`lmcache_mp_connector.py:1032`),最终走到 `transfer_ctx.submit_retrieve`(`vllm_multi_process_adapter.py:1806`)。这里传的是 **vLLM 的 block ID 列表** 和 `kv_caches` 张量,worker adapter 通过 CUDA IPC/SHM 把 L1 里的字节直接写进 vLLM 的 paged KV。`wait_for_layer_load` 当前是空实现(`lmcache_mp_connector.py:1040`),因为 LMCache 不是按层流水,而是按请求批量提交;完成状态由 `get_finished`(`lmcache_mp_connector.py:1146`)统一回收。

这里有一个容易忽略的细节:**LMCache 的命中 token 数与 vLLM 的 block 边界不一定对齐**。connector 用 `_hit_alignment_tokens` 把 APC 命中和 LMCache 命中都向下取整到每个 group 的 paged-chunk 边界,再按 LMCache chunk 对齐,确保 RETRIEVE 的范围在每个 group 里都能落到完整 block。否则,最后一个不完整的 block 会把错误的数据写进 GPU。

## 七、写回路径:STORE、L1 发布与 L2 下沉

写回分两段:**GPU→L1** 和 **L1→L2**。

GPU→L1 的入口是 `wait_for_save`(`lmcache_mp_connector.py:1083`),它在 forward context 退出时被调用,收集 `direction == "STORE"` 的请求,`batched_submit_store_requests`(`lmcache_mp_connector.py:1113`)逐个调用 `submit_store_request`(`vllm_multi_process_adapter.py:1678`)。worker adapter 把 `kv_caches`、block IDs、chunk 信息和 device event 交给 `transfer_ctx.submit_store`;server 侧的 `LMCacheDrivenTransferModule.store`(`lmcache/v1/multiprocess/modules/lmcache_driven_transfer.py:608`)完成实际的 GPU→CPU 拷贝,并通过 `StorageManager.reserve_write` / `finish_write` 把对象发布到 L1。

`wait_for_save` 的语义是"确保异步保存完成,避免 paged KV 被覆盖"。这也是为什么 connector 在 `get_finished` 里要严格区分 store 和 retrieve:retrieve 完成之前不能提前释放 block,store 完成之前不能让 vLLM 复用这些 GPU block。`request_finished`(`lmcache_mp_connector.py:1725`)在请求结束时清理 tracker、结束 LMCache session;如果开启了 lazy offload,它会返回 `False`,把 block 交还给 vLLM,同时由 `LazyOffloadManager` 延后提交 store。

L1→L2 是后台异步的。`StoreController`(`lmcache/v1/distributed/storage_controllers/store_controller.py:197`)监听 L1 的写完成事件,`_process_new_keys`(`store_controller.py:573`)让 store policy 选出目标 adapter,`_submit_store_for_single_shape`(`store_controller.py:592`)对目标 key 做 `reserve_read` 拿到 `MemoryObj`,再 `submit_store_task` 给 L2。完成后 `_finalize_store`(`store_controller.py:750`)释放 L1 读锁、发布指标,并根据 policy 决定是否把 L1 副本删掉——这就是"L2 作为容量层,而不是只读归档"的含义。

淘汰由两个控制器负责:

- `L1EvictionController`(`lmcache/v1/distributed/storage_controllers/eviction_controller.py:88`)每秒检查一次 L1 使用率,超过 watermark 就按 LRU 等策略生成淘汰动作,`execute_eviction_action` 直接删除 L1 对象(`eviction_controller.py:192`);
- `L2EvictionController`(`eviction_controller.py:218`)按 adapter 的容量、全局或 per-`cache_salt` 配额决定删哪些 L2 对象。

预取控制器和淘汰控制器是一对反向操作:前者把 L2 的对象拉到 L1,后者把 L1 的对象清掉。二者都通过 EventBus 发布指标,所以从 `/metrics` 能同时看到"L2 拉了多少"和"L1 淘汰了多少"。

## 八、vLLM 集成:五个回调,两条异步链

把 vLLM 侧的回调列成表,能更清楚地看到职责边界:

| 回调 | 角色 | 职责 |
| --- | --- | --- |
| `get_num_new_matched_tokens` | scheduler | 查询外部缓存,返回可加载 token 数;可能返回 `None` 表示"还在查" |
| `update_state_after_alloc` | scheduler | 记录 vLLM 分配的 block,推进请求状态,释放不需要的读锁 |
| `build_connector_meta` | scheduler | 把本 step 的 RETRIEVE/STORE 请求打包成 metadata |
| `start_load_kv` | worker | forward 前提交 RETRIEVE,异步把 KV 写进 paged KV |
| `wait_for_layer_load` | worker | 按层等待;当前 LMCache 是 no-op |
| `save_kv_layer` | worker | 按层保存;LMCache 通过 dispatcher 转发,实际批量提交在 `wait_for_save` |
| `wait_for_save` | worker | forward 退出时提交 STORE,防止 paged KV 被覆盖 |
| `get_finished` | worker/scheduler | 回收已完成的 store/retrieve,决定 block 何时可释放 |
| `request_finished` | scheduler | 请求结束清理,结束 LMCache session |

这里有两条异步链。**加载链**是 scheduler 先查、worker 后搬:LOOKUP 在 scheduler 线程发起,但结果通过非阻塞轮询获取;RETRIEVE 在 forward 前提交,GPU 计算可以与搬运重叠。**保存链**是 forward 结束后统一提交:虽然 `save_kv_layer` 提供了按层入口,但 LMCache 的 MP 路径把 store 批量化到 `wait_for_save`,以减少 RPC 次数和锁竞争。

## 九、配置与部署:同一台机器,还是跨机器

LMCache MP 的默认部署是**同机**:vLLM 通过 `lmcache.mp.host` / `lmcache.mp.port` 连接本机的 `lmcache server`,默认 `tcp://localhost:5555`。生产上常见的形态是"每个节点一个 LMCache DaemonSet,多个 vLLM Pod 共享",server 只监听回环地址,缓存进程和推理进程通过 CUDA IPC/SHM 搬 KV。这样做的收益是:多个副本共享同一份 L1,缓存容量按节点而不是按 Pod 计算。

跨机有两种方式。一种是 `lmcache.mp.server_urls` 配置多个 MP server:vLLM 的 world size 必须能被 server 数整除,每个 worker 只连接分配给自己的那个 server,目前只支持 TP,PP 和 DP 会被拒绝。另一种是通过 L2 的远端 adapter(如 Mooncake、NIXL、S3)或 P2P adapter,让不同节点的缓存互相可见。要注意,**多 server 不等于"共享同一个 GPU KV 池"**:每个 server 仍然管理自己节点的 L1,跨节点复用要么走 L2,要么走 P2P 的远端读。

几个常被问到的配置项:

- `lmcache.mp.eager_prefetch`(默认 `false`):请求一进 vLLM 的等待队列就发 LOOKUP,让 L2→L1 的 staging 与排队时间重叠。对 L2 命中率高的负载,这个选项能明显降低首 token 延迟;代价是可能为最终没被调度的请求做无用预取。
- `lmcache.mp.save_decode_cache`(默认 `false`):默认只缓存 prompt chunk,不缓存生成出来的 token。对流式/多轮会话,如果希望生成内容也进入下一轮前缀,可以打开;但这会让缓存随生成长度增长,需要配合容量和淘汰策略。
- `lmcache.mp.server_urls`:多 server 部署入口,优先于 `host` / `port`;bare `host:port` 会被规范化为 `tcp://`。
- `--chunk-size`:server 侧的最小 chunk;最终值由 connector 协商,不能假设等于配置值。
- `lmcache.mp.lazy_offload`:把 store 延后到请求结束后批量提交,适合"缓存立即可见性不重要、但希望降低每步开销"的场景;它要求 vLLM 开启 prefix caching,因为要靠 block hash 判断 GPU block 是否已被复用。

## 十、观测:命中率要分三层看

LMCache 的观测基于 OTel:默认开 metrics 和 logging,tracing 需要 `--enable-tracing --otlp-endpoint`。`lmcache server` 的 `/metrics` 在 HTTP frontend 的 `--http-port`(默认 8080),不是 `--prometheus-port`。

最有用的指标是 lookup 的 token 级命中率。`LookupMetricsSubscriber`(`lmcache/v1/mp_observability/subscribers/metrics/lookup.py:59`)维护:

- `lmcache_mp.lookup_requested`:请求查找的 token 数(分母);
- `lmcache_mp.lookup_hit`:L1+L2 命中的 token 数(分子);
- `lmcache_mp.lookup_hit_l1`:其中 L1 本来就能服务的部分;
- `lmcache_mp.lookup_hit_l2`:L2 额外补出来的部分。

这三个数满足 `l1 + l2 == lookup_hit`。只看总命中率会掩盖问题:如果命中主要来自 L2,首 token 延迟仍然受限于磁盘/网络,应该关注预取是否及时、L2 带宽是否成为瓶颈;如果 L1 命中率很高但总命中率低,说明容量或淘汰策略需要调整。

L1/L2 还有各自的生命周期指标:`l1_read`、`l1_write`、`l1_evicted`、`l1_chunk_lifetime`、`l1_chunk_reuse_gap`、`l2_store_submitted`、`l2_store_completed`、`l2_prefetch_load_completed` 等。Trace 侧有 `mp.store`、`mp.retrieve`、`mp.lookup_prefetch` 三个 span,以及请求级 root span 上的 `hit_tokens`、`requested_tokens`、`hit_rate`、`l1_hit_tokens`、`l2_hit_tokens`、`apc_covered_tokens`、`engine_hit_tokens` 等属性。排查"为什么这次没命中"时,先看 `apc_covered_tokens`:如果 vLLM 本地前缀缓存已经覆盖了大部分 prompt,LMCache 的查找范围本来就会被压缩,命中率分母也会相应变小。

## 十一、与 vLLM 本地前缀缓存的分工

这是最容易混淆的地方。vLLM 的 prefix caching(APC)和 LMCache 不是替代关系,而是**两级缓存**。

| 维度 | vLLM APC | LMCache |
| --- | --- | --- |
| 位置 | 推理进程内、GPU 显存 | 独立进程,L1 DRAM/DEVDAX/GDS,L2 磁盘/远端 |
| 粒度 | paged block + block hash | chunk + ObjectKey + object group |
| 生命周期 | 随引擎实例,GPU block 被淘汰即消失 | 跨请求、跨实例、可持久化 |
| 容量 | 受 GPU 显存限制 | 可到 TB 级 |
| 延迟 | 最低,几乎无额外拷贝 | 多一次 LOOKUP/RETRIEVE,可能还有 L2 I/O |
| 擅长 | 单实例内热点前缀 | 跨副本共享、长前缀、冷启动、跨节点 |

实际路径是:**vLLM 先用自己的 APC**。`get_num_new_matched_tokens` 收到的 `num_computed_tokens` 就是本地已经算好的 token 数;connector 以它为起点,只向 LMCache 查"APC 之外"的部分,并把 `lmcache.hint.engine_computed_tokens` 传给 server,供 load policy 判断是否值得加载。LMCache 返回的命中数如果超过 APC,增量部分才需要 RETRIEVE;如果 LMCache 的命中比 APC 还短,connector 会向下对齐,避免让 vLLM 回退。

所以正确的理解是:**APC 负责"我这块 GPU 上已经有什么",LMCache 负责"整个集群曾经算过什么"**。APC 是 LMCache 的前置过滤器,也是它的兜底;LMCache 则是 APC 容量和生命周期之外的扩展。把 APC 关掉只用 LMCache,通常会损失最低延迟的那一层;只开 APC 不开 LMCache,则无法跨实例复用。

## 十二、FAQ 与常见误解

**误解一:LMCache 就是一个磁盘缓存。** 不是。L1 是 DRAM/DEVDAX/GDS,是真正的热层;L2 才是磁盘或远端。很多部署只开 L1 就能获得跨请求复用,根本不需要 L2。

**误解二:LOOKUP 命中就等于零成本。** 不是。命中只说明"数据在 L1/L2 里",还要 RETRIEVE 到 GPU;如果命中的是 L2,还要先加载到 L1。`eager_prefetch` 的意义就是把这段延迟藏到排队时间里,但它不能消除带宽成本。

**误解三:chunk size 越大越好。** 不是。chunk 越大,元数据和 RPC 次数越少,但前缀复用的粒度越粗,部分命中会被浪费;而且 chunk size 要和所有 attention group 的 block 边界对齐,配错会直接启动失败或写错 block。

**误解四:默认会缓存生成出来的 token。** 不会。`save_decode_cache` 默认 `false`,只缓存完整 prompt chunk。多轮会话如果希望生成内容成为下一轮前缀,需要显式打开。

**误解五:多机部署就是共享同一份 KV。** 不是。每个 MP server 管理自己的 L1;跨机复用要么走 L2 远端 adapter,要么走 P2P。`server_urls` 只是让一个 vLLM 部署连接多个 server,不是把它们的显存池合并。

**误解六:KeyDirectory 在 MP server 里。** 不在。`KeyDirectory` 属于 MP coordinator,是跨实例的放置索引;MP server 的前缀查找主要走本地 `StorageManager` 和 `PrefetchController`。把 coordinator 的 `lookup` 当成请求热路径,会高估它的调用频率。

**误解七:L2 命中一定意味着前缀命中。** 不一定。前缀是否可服务取决于所有 object group 的窗口:full attention 要求整个前缀都在,sliding window 只要求末尾 `w` 个 chunk,recurrent 只要求最新状态。`fold` 之后的最长可服务前缀,才是最终返回给 vLLM 的命中长度。

**误解八:LMCache 可以取代 vLLM 的 prefix caching。** 不建议,也不符合它的设计。两者是互补的:LMCache 的 lookup 以 APC 的命中为起点,`update_state_after_alloc` 还会释放 APC 已覆盖部分的锁。关掉 APC 会让 LMCache 多查、多搬,延迟更高;保留 APC 才能让"最近、最快"的那层缓存继续发挥作用。

## 结语

LMCache 的复杂度不在某一行代码,而在它把"KV 复用"拆成了几个彼此正交的维度:用 chunk 定义粒度,用 ObjectKey 定义身份,用 object group 表达模型结构,用 kv_rank 表达并行分片,用 bitmap 表达"前缀是否可服务",再用 L1/L2 和 connector 回调把这一切接进 vLLM 的调度与执行。

读完之后,我更愿意把它看成一层**以 KV 为对象、以 chunk 为页、以命中路径为中心**的存储系统,而不是"vLLM 的一个插件"。它的很多设计——lookup-and-lock、prefetch 与 eviction 的反向控制、APC 与外部缓存的边界对齐——都是在回答同一个问题:怎样在不破坏推理正确性的前提下,让"已经算过的前缀"尽可能地多被复用一次。

对线上系统来说,最值得记住的可能是三点:**先看 APC 再看 LMCache,命中率要分 L1/L2,chunk 和 object group 决定了下限。** 剩下的,才是调参和选介质。
