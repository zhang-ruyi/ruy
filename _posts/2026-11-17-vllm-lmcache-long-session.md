---
layout: post
title: "超长会话的 KV 数据流:GPU 建块、L1 成对象、L2 落 NVMe,再回载"
date: 2026-11-17
categories: [ai-inference]
description: "按数据在 GPU HBM、LMCache L1、NVMe L2 中的真实视图,拆解超长会话 KV 的创建、落盘、命中与回载;包含对 store_kv 条件和 L1→L2 路径的代码核对。"
---
LLM 推理 · vLLM / LMCache · 源码基线 vLLM `c724bb3` / LMCache `a4a6888`

超长会话的 KV 不是"一块内存从显存搬到 SSD"那么简单:在 GPU 里它是 **paged block**,进了 LMCache 变成 **chunk × object group × kv_rank 的 MemoryObj**,落到 NVMe 又变成 **一个 key 一个文件**或 **固定 slot**。介质变了,视图也变了。本文按"数据现在在哪、以什么视图存在"来拆这条链路:GPU paged block → LMCache MemoryObj → NVMe 文件/slot,再按命中路径回载。

## 一、三种介质,三种视图

<div class="dataflow">
  <div class="dataflow-head"><span class="dataflow-title">KV 在三种介质中的视图</span><span class="dataflow-note">同一段前缀,单位从 block 变成 chunk/object,再变成文件/slot</span></div>
  <div class="flow-row">
    <div class="medium">
      <div class="medium-head tone-blue">GPU HBM</div>
      <div class="medium-body">
        <div class="view-label">vLLM 视图</div>
        <div class="kv-grid"><span class="kv-cell hot">B0</span><span class="kv-cell hot">B1</span><span class="kv-cell">B2</span><span class="kv-cell">B3</span><span class="kv-cell">B4</span><span class="kv-cell">B5</span></div>
        <div class="mini">paged KV block + block table + slot mapping;block hash 指向前缀</div>
      </div>
    </div>
    <div class="flow-arrow"><span>store_kv</span><span class="line"></span><span>GPU→CPU 拷贝</span></div>
    <div class="medium">
      <div class="medium-head tone-violet">L1 DRAM</div>
      <div class="medium-body">
        <div class="view-label">LMCache 视图</div>
        <div class="unit-grid"><span class="unit">c0/g0/r0</span><span class="unit">c0/g0/r1</span><span class="unit">c1/g0/r0</span><span class="unit">c1/g1/r0</span></div>
        <div class="mini">MemoryObj(shapes/dtypes)+ ObjectKey;写策略为每个 key 选一个 L1 目标</div>
      </div>
    </div>
    <div class="flow-arrow"><span>StoreController</span><span class="line"></span><span>L1→L2 异步</span></div>
    <div class="medium">
      <div class="medium-head tone-amber">L2 NVMe</div>
      <div class="medium-body">
        <div class="view-label">FS / block 视图</div>
        <div class="unit-grid"><span class="unit">key.data</span><span class="unit">key.data</span><span class="unit">slot 0</span><span class="unit">slot 1</span></div>
        <div class="mini">FS:一个 ObjectKey 一个 .data 文件;raw block:固定 slot + header/meta</div>
      </div>
    </div>
  </div>
  <div class="flow-return"><span class="step hot">lookup 命中</span><span class="step-arrow">→</span><span class="step">L2 读</span><span class="step-arrow">→</span><span class="step">L1 暂存</span><span class="step-arrow">→</span><span class="step">GPU paged KV</span><span class="mini">异步;命中计入 num_computed_tokens;可 skip_first_n_tokens</span></div>
</div>

## 二、GPU 视图:请求 → block table → 物理块

vLLM 在 GPU 里不是按"整段 KV"管理,而是按**固定大小的 block**。请求进入 `Scheduler.schedule`(`vllm/v1/core/sched/scheduler.py:716`),`KVCacheManager.allocate_slots`(`vllm/v1/core/kv_cache_manager.py:401`)分配逻辑块,`BlockPool` 给物理块。每个请求维护一行 block table:

<div class="dataflow">
  <div class="dataflow-head"><span class="dataflow-title">GPU 侧:block table 与物理块</span><span class="dataflow-note">图里 B0–B5 是物理块编号</span></div>
  <div class="view-card">
    <h4>block table(每个请求一行)</h4>
    <div class="matrix-wrap">
      <div class="matrix-row"><span class="row-label">req0</span><span class="cell on">B0</span><span class="cell on">B1</span><span class="cell on">B2</span><span class="cell on">B3</span><span class="cell">—</span><span class="cell">—</span></div>
      <div class="matrix-row"><span class="row-label">req1</span><span class="cell on">B1</span><span class="cell on">B4</span><span class="cell on">B5</span><span class="cell">—</span><span class="cell">—</span><span class="cell">—</span></div>
    </div>
    <div class="mini">实现是 <code>[max_num_reqs, max_num_blocks]</code> 的 int32 张量(`vllm/v1/worker/gpu/block_table.py:17/66`);`slot_mappings`(:90)把 token 映射到块内槽位。req0 与 req1 共享 B1,就是前缀缓存的物理基础。</div>
  </div>
  <div class="view-card" style="margin-top:10px">
    <h4>一个物理块的张量视图(FlashAttention 示例)</h4>
    <div class="unit-grid"><span class="unit">num_blocks</span><span class="unit">num_kv_heads</span><span class="unit">block_size</span><span class="unit">2 × head_size</span><span class="unit">dtype</span></div>
    <div class="mini">物理布局是 <code>[num_blocks, num_kv_heads, block_size, 2*head_size]</code>(`vllm/v1/attention/backends/flash_attn.py:1236`),K/V 打包在最后一维。不同 attention backend 的布局可能不同;`block_size` 与 `page_size_bytes` 由 <code>KVCacheSpec</code>(`kv_cache_interface.py:191/630`)决定。</div>
  </div>
</div>

前提前缀命中时,`get_computed_blocks`(`kv_cache_manager.py:288`)→`find_longest_cache_hit`(`kv_cache_coordinator.py:464`)返回可复用的**完整块**;命中的块直接复用物理块,不重新 prefill。

## 三、Store 视图:block 变成 chunk × object group × kv_rank

LMCache 落盘时不再看 vLLM 的 block,而是看自己的对象模型:

<div class="dataflow">
  <div class="dataflow-head"><span class="dataflow-title">LMCache 的 key 与对象分组</span><span class="dataflow-note">一个 chunk 可覆盖多个 vLLM block</span></div>
  <div class="view-card">
    <h4>请求 tokens → chunk → object group × kv_rank → ObjectKey</h4>
    <div class="unit-grid">
      <span class="unit">chunk c0: t0–t15</span><span class="unit">chunk c1: t16–t31</span>
      <span class="unit">group g0: full attention</span><span class="unit">group g1: sliding window</span>
      <span class="unit">kv_rank r0</span><span class="unit">kv_rank r1</span>
    </div>
    <div class="mini"><code>GroupedObjectKeys</code>(`lmcache/v1/distributed/api.py:709`)规定 <code>keys[i]</code> 覆盖 tokens <code>[i*chunk, (i+1)*chunk)</code>;<code>ObjectKey</code>(:226)的字段是 <b>chunk_hash + model_name + kv_rank + object_group_id + cache_salt</b>;每组的 shapes/dtypes 由 <code>MemoryLayoutDesc</code>(:532)描述。</div>
  </div>
</div>

| 维度 | 含义 | 与 GPU 的关系 |
|---|---|---|
| chunk | 一段连续 token 的 KV 单元 | 一个 chunk 可能对应多个 vLLM block |
| object group | full attention / sliding window / recurrent 等 | 不同 group 的 block 数、布局不同 |
| kv_rank | 张量并行下的 KV 分片 | 每个 rank 单独一个 ObjectKey |
| cache_salt | 隔离/多租户盐 | 同前缀不同 salt 不命中 |

实际 store 调用在 `LMCacheDrivenTransferModule.store`(`lmcache/v1/multiprocess/modules/lmcache_driven_transfer.py:608`):入参包括 `gpu_block_ids`(按 LMCache KV group 索引)、`chunk_size`、`blocks_per_chunk`;它会把 GPU 上的若干 block 按 chunk 聚合,再拷进 L1 的 MemoryObj。store 是 **all-or-nothing**:请求的 chunk 没有全部覆盖、拷贝失败或完成所有权无效,整次 store 跳过,后续 retrieve 就 miss。

## 四、L1 视图:MemoryObj 里到底是什么

L1 不是"一块大缓存",而是一组按介质管理的对象池。对象元数据在 `MemoryObjMetadata`(`lmcache/v1/memory_management.py:144`):

<div class="dataflow">
  <div class="dataflow-head"><span class="dataflow-title">L1 MemoryObj 与介质</span><span class="dataflow-note">DRAM / DEVDAX / GDS 三选一,写策略决定目标</span></div>
  <div class="view-card">
    <dl class="field-grid">
      <dt>shape/dtype</dt><dd>逻辑张量形状(可多组:shapes/dtypes)</dd>
      <dt>address</dt><dd>该对象在 L1 介质中的地址</dd>
      <dt>phy_size</dt><dd>物理分配字节数</dd>
      <dt>ref_count</dt><dd>引用计数,归零才可回收</dd>
      <dt>pin_count</dt><dd>被 pin 住时不可淘汰</dd>
      <dt>fmt</dt><dd>MemoryFormat,描述 K/V 排列</dd>
    </dl>
    <div class="mini"><code>TensorMemoryObj</code>(:658)把多个 object group 拼在一个 flat tensor 里,用 <code>group_prefix_sum</code> 记录每组偏移;所以一个 L1 对象不是"一个 vLLM block",而是"一个 chunk 在该 group/rank 下的多组张量"。</div>
  </div>
  <div class="unit-grid" style="margin-top:10px">
    <span class="unit">DRAM:L1MemoryManager / pinned host</span>
    <span class="unit">DEVDAX:CXL / Device-DAX arena</span>
    <span class="unit">GDS:GPUDirect Storage slab</span>
  </div>
  <div class="mini">三种 L1 由各自的 manager 管理(`docs/design/v1/distributed/l1_manager/l1-manager-types.md`);<code>WritePolicy</code>(`storage_controllers/write_policy.py:99`)为每个 key **选一个** L1 目标,不跨介质重试。L1 容量不够时走 eviction,但这不等于写 L2。</div>
</div>

## 五、L1 → L2:StoreController,而不是淘汰

实际顺序是:

<div class="dataflow">
  <div class="dataflow-head"><span class="dataflow-title">L1 写完成后的异步 L2 下沉</span><span class="dataflow-note">L1 eviction 与 L2 store 是两条控制器</span></div>
  <div class="timeline">
    <span class="step">GPU→L1 写完成</span><span class="step-arrow">→</span>
    <span class="step hot">StoreController</span><span class="step-arrow">→</span>
    <span class="step">StorePolicy 选 L2</span><span class="step-arrow">→</span>
    <span class="step">L2 adapter 异步 store</span><span class="step-arrow">→</span>
    <span class="step">可选删除 L1</span>
  </div>
  <table>
    <tr><th>L2 形态</th><th>视图</th><th>关键点</th></tr>
    <tr><td>文件系统 FS L2</td><td>一个 ObjectKey → 一个 <code>.data</code> 文件</td><td>文件名由 key 编码;异步 aiofiles;适合本地 NVMe 目录</td></tr>
    <tr><td>raw block L2</td><td>固定大小的 slot(header + 数据)</td><td>按 <code>block_align</code> 对齐;posix / io_uring;适合裸盘/高性能 NVMe</td></tr>
  </table>
  <div class="mini"><code>StoreController</code>(`storage_controllers/store_controller.py:197`)在 L1 写完成回调后,按 <code>StorePolicy</code> 选择 L2,并提交 store;完成后可删除 L1。L1 eviction controller 只负责 L1 容量,不应把"淘汰"和"写 L2"混为一谈。</div>
</div>

## 六、回载:lookup → placement → L2→L1→GPU

第二次请求(或相同前缀)到来时,先看 LMCache 的 placement:

<div class="dataflow">
  <div class="dataflow-head"><span class="dataflow-title">lookup 与回载视图</span><span class="dataflow-note">KeyDirectory 返回的是"哪里有",不是数据本身</span></div>
  <div class="placements">
    <div class="placement"><b>c0 / g0 / r0</b><span>L2 · fs · node2 · /nvme/kv/&lt;hash&gt;.data</span></div>
    <div class="placement"><b>c1 / g0 / r0</b><span>L1 · dram · node1 · 已驻留</span></div>
    <div class="placement"><b>c1 / g1 / r0</b><span>L2 · raw_block · node2 · slot 17</span></div>
  </div>
  <div class="view-card" style="margin-top:10px">
    <h4>prefetch 结果按 (object group, kv_rank) 分行</h4>
    <div class="matrix-wrap">
      <div class="matrix-row"><span class="row-label">g0/r0</span><span class="cell on">1</span><span class="cell on">1</span><span class="cell on">1</span><span class="cell">0</span><span class="cell">—</span><span class="cell">—</span></div>
      <div class="matrix-row"><span class="row-label">g1/r0</span><span class="cell on">1</span><span class="cell on">1</span><span class="cell">0</span><span class="cell">0</span><span class="cell">—</span><span class="cell">—</span></div>
    </div>
    <div class="mini">lookup 只返回 placement(`v1/mp_coordinator/views/key_directory.py:305`);`PrefetchTaskSpec` 按 group×rank 分行,`FetchingPolicy="prefix"` 只取所有行都能覆盖的最长前缀。bitmap 里的 1 才是最终可回载的 chunk。</div>
  </div>
  <div class="flow-return"><span class="step">L2 读文件/slot</span><span class="step-arrow">→</span><span class="step">L1 暂存</span><span class="step-arrow">→</span><span class="step">GPU block 拷贝</span><span class="mini">retrieve 可 skip_first_n_tokens,避免覆盖 APC 共享块;异步事件完成后 scheduler 继续</span></div>
</div>

回载后,vLLM 的 `get_num_new_matched_tokens`(`scheduler.py:1178`)把外部命中数加到 `num_computed_tokens`(:1256);异步加载时请求会进入 `WAITING_FOR_REMOTE_KVS`(:1585),由 `_update_waiting_for_remote_kv`(:3616)推进。真正 forward 时只算未命中部分,但**最后一个 token 通常仍要重算**(命中上限是 `prompt_length - 1`,且要块对齐)。

## 七、条件

store_kv 的触发条件是 **KV producer + 完整 chunk + `wait_for_save`**;默认只存完整 prompt chunk,decode KV 需要 `save_decode_cache=True`。

命中条件是 **block hash / model / block size / cache salt 一致 + placement 可读 + bitmap 覆盖**。命中上限是 `prompt_length - 1` 且要求块对齐,因此最后一个 token 通常仍会重算。

## 八、观测与配置(简)

- 观测:看 lookup 的 L1/L2 分层命中、L2 读延迟、retrieve 的 skip/失败、TTFT;只看总命中率会掩盖 L2 回载成本。
- 配置:KV transfer config;LMCache MP server;L1 介质(DRAM/DEVDAX/GDS);L2 适配器(FS 路径或 raw block 设备);`eager_prefetch`;`save_decode_cache`。
- 关键源码:`lmcache_mp_connector.py:1349/1569/1663/996/1083`;`storage_manager.py:287/347/535`;`lmcache_driven_transfer.py:608/934`;`fs_l2_adapter.py:6`;`raw_block_l2_adapter.py:6`。

## 相关

- 时序总览:[超长会话 KV 生命周期]({{ '/llm-arch-dia/vllm-lmcache-long-session.html' | relative_url }})(Archify 交互版,可与本文数据视图对照)
- [LMCache 架构]({{ '/llm-arch-dia/lmcache-architecture.html' | relative_url }}) · [KV 命中/加载/写回]({{ '/llm-arch-dia/lmcache-kv-flow.html' | relative_url }}) · [vLLM PagedAttention]({{ '/llm-arch-dia/vllm-paged-attention.html' | relative_url }})

> 源码基线:vLLM `c724bb35d4e70201cf0fa6f2f1dcd802c6f9dad4` / LMCache `a4a688827def88f1df3e9af5fad43245913fca36`。
