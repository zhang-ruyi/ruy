# 超长会话的 KV 数据流:GPU 建块、L1 成对象、L2 落 NVMe,再回载

> 源码基线:vLLM `c724bb3` / LMCache `a4a6888`

超长会话的 KV 不是"一块内存从显存搬到 SSD"那么简单:在 GPU 里它是 paged block,进了 LMCache 变成 chunk × object group × kv_rank 的 MemoryObj,落到 NVMe 又变成一个 key 一个文件或固定 slot。介质变了,视图也变了。

本文按"数据现在在哪、以什么视图存在"拆这条链路:GPU → L1 → L2 NVMe,再按命中路径回载。

## 一、三种介质,三种视图

| 介质 | 数据形态 | 谁描述它 | 跨层动作 |
|---|---|---|---|
| GPU HBM | paged KV block | block table + slot mapping + block hash | GPU→CPU 拷贝 |
| L1 DRAM | chunk × object group × kv_rank 的 MemoryObj | ObjectKey + MemoryLayoutDesc | L1→L2 异步 store |
| L2 NVMe | FS:一个 key 一个 `.data` 文件;raw block:固定 slot | 文件名编码 / slot 号 | L2→L1 预取,再进 GPU |

## 二、第一轮请求:KV 先落在 GPU

请求进入 `LLMEngine.add_request` → `EngineCore.add_request` → `Scheduler.schedule`:

| 步骤 | 视图 | 关键点 |
|---|---|---|
| 调度 | waiting / running | 按 token budget 选请求 |
| 前缀查找 | block table | `get_computed_blocks` 找本地 GPU 前缀 |
| 分配 | 逻辑块 → 物理块 | `allocate_slots` |
| prefill | paged KV | KV 写入 HBM,建立 block table |

FlashAttention 的物理块视图是 `[num_blocks, num_kv_heads, block_size, 2*head_size]`;block table 是 `[max_num_reqs, max_num_blocks]` 的 int32 张量。

## 三、store_kv:什么时候交给 LMCache

默认只保存**完整的 prompt chunk**,并且要满足:

- 该 vLLM 实例是 KV producer(`kv_transfer_config.is_kv_producer`)
- prompt chunk 已完整计算(块对齐)
- forward 退出前触发 `wait_for_save()`
- decode KV 默认不存;`lmcache.mp.save_decode_cache=True` 才存

## 四、block 变成 chunk × object group × kv_rank

LMCache 落盘时不再看 vLLM 的 block,而是看自己的对象模型:

| 维度 | 含义 |
|---|---|
| chunk | 一段连续 token 的 KV 单元,可能覆盖多个 vLLM block |
| object group | full attention / sliding window / recurrent |
| kv_rank | 张量并行下的 KV 分片 |
| cache_salt | 隔离/多租户盐 |

`ObjectKey` = `chunk_hash + model_name + kv_rank + object_group_id + cache_salt`。store 是 all-or-nothing:请求的 chunk 没有全部覆盖、拷贝失败或完成所有权无效,整次 store 跳过,后续 retrieve 就 miss。

## 五、L1 里的 MemoryObj

| 字段 | 含义 |
|---|---|
| shape / dtype | 逻辑张量形状(可多组) |
| address | L1 介质地址 |
| phy_size | 物理分配字节数 |
| ref_count / pin_count | 引用与 pin,归零才可回收 |
| fmt | K/V 排列格式 |

`TensorMemoryObj` 用 `group_prefix_sum` 把多个 object group 拼在一个 flat tensor 里。L1 介质是 DRAM / DEVDAX / GDS,`WritePolicy` 为每个 key 选一个目标,失败不重试。

## 六、L1 → L2:StoreController

顺序是:**GPU→L1 写完成 → StoreController 按 StorePolicy 选 L2 → L2 adapter 异步 store → 可选删除 L1**。L1 eviction 是另一条控制器,不等于写 L2。

| L2 形态 | 视图 | 关键点 |
|---|---|---|
| 文件系统 FS | 一个 ObjectKey → 一个 `.data` 文件 | 文件名由 key 编码,异步 aiofiles |
| raw block | 固定 slot(header + 数据) | `block_align` 对齐,posix / io_uring |

## 七、第二轮请求:lookup 命中与原路回载

| placement | 含义 |
|---|---|
| L2 · fs · node2 | NVMe 上的 `.data` 文件 |
| L1 · dram · node1 | 已驻留内存 |
| L2 · raw_block · node2 | 固定 slot |

lookup 只返回"哪里有",prefetch 结果按 `(object group, kv_rank)` 分行,bitmap 里的 1 才是可回载 chunk。回载路径:L2 读 → L1 暂存 → GPU block 拷贝;`num_computed_tokens` 加上外部命中数,异步时请求进入 `WAITING_FOR_REMOTE_KVS`。

命中上限是 `prompt_length - 1` 且要块对齐,所以最后一个 token 通常仍会重算。

## 八、配置与观测

| 目标 | 配置 |
|---|---|
| vLLM 写出 KV | KV transfer config + `is_kv_producer` |
| 连接 LMCache | `lmcache.mp.server_urls` |
| 提前查缓存 | `lmcache.mp.eager_prefetch=True` |
| 保存 decode KV | `lmcache.mp.save_decode_cache=True` |
| NVMe 做 L2 | L2 adapter = FS / raw block,路径指向 NVMe |

观测要分三层:GPU 本地前缀命中、LMCache L1/L2 命中、回载延迟(TTFT / NVMe 读)。只看总命中率会掩盖 L2 回载成本。

---

完整交互图与数据视图:
https://zhang-ruyi.github.io/ruy/2026/11/17/vllm-lmcache-long-session.html
