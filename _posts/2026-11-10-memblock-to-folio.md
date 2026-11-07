---
layout: post
title: "内存管理:从 memblock 到 folio 的演化"
date: 2026-11-10
categories: [kernel-deep]
description: 开机期 memblock 记账与线性分配、memblock_free_all 交接 buddy、slab/slub、page cache 与 folio 的演进,含迁移类型、PCP 与 large folio
---
内核精读 · 内存管理 · 源码基线 v7.4.0-rc1

内核里没有"一个内存分配器",只有一套**逐级升级的分配体系**:开机时连 `struct page` 都还没准备好,只能用 memblock 记账和线性分配;等页表、zone、vmemmap 就绪后,再把空闲物理页一次性交给 buddy;buddy 只适合整页,于是又长出 slab/slub 来管理小对象;文件缓存和匿名内存则以 page cache、folio 的形式存在,最后由回收器统一回收。本文沿 v7.4.0-rc1 源码,把这条从"物理内存账本"到"folio"的演化链拆开。

<div class="callout">
本文结构:为什么早期不能用 buddy → memblock 的 add/reserve/alloc → memblock_free_all 与 buddy 交接 → zone/PCP/迁移类型 → slab/slub → struct page 到 folio → anon folio/THP/filemap/readahead/writeback → 生命周期 → 观测 → 设计取舍。
</div>

## 一、开机早期:为什么不能直接用 buddy

伙伴系统(buddy allocator)看起来是"最底层"的分配器,但它自身依赖一大堆已经初始化的元数据:

- 每个物理页都要有 `struct page`(或 `struct folio` 的存储),也就是 vmemmap/`mem_map` 必须已经建立
- 每个 NUMA 节点要有 `pg_data_t`,每个 zone 要有 `struct zone`、free_area、锁与统计
- 每 CPU 要有 `per_cpu_pages`(PCP)缓存,需要 per-cpu 机制先可用
- 页的 `refcount`、`mapcount`、page flags、LRU 链表等字段要能安全读写

这些东西本身都要占内存,而"谁来分配这些内存"在 buddy 可用之前无解。memblock 就是为这个空窗期准备的**引导期分配器**:它不管理单页,只维护若干段物理地址区间,并用一个极简的线性扫描来满足早期分配。

memblock 的核心结构在 `include/linux/memblock.h`:

- `struct memblock_region`(`include/linux/memblock.h:75`):一段 `base + size`,带 NUMA 节点与 flags
- `struct memblock_type`(`include/linux/memblock.h:92`):一组 region,分别表示 `memory` 与 `reserved`
- `struct memblock`(`include/linux/memblock.h:107`):全局 `memblock`,里面就是 `memory`、`reserved`、`physmem` 等几组区间

它做三件事:

1. **add**:把固件/设备树报告的可用物理内存登记进 `memblock.memory`
2. **reserve**:把内核镜像、initrd、页表、设备保留区等从可用内存里划掉,登记进 `memblock.reserved`
3. **alloc**:在 `memory - reserved` 的空隙里做对齐的线性分配

`memblock_add`(`mm/memblock.c:769`)和 `memblock_add_node`(`mm/memblock.c:747`)最终都进入 `memblock_add_range`(`mm/memblock.c:628`)。这个函数会做区间合并与重叠检查,保证 `memory` 里的区间尽量连续、无重复。`memblock_reserve` 是一个内联包装(`include/linux/memblock.h:135`),落到 `__memblock_reserve`(`mm/memblock.c:1024`),再调用同一个 `memblock_add_range`,只是目标换成 `memblock.reserved`。

分配侧的关键函数是 `memblock_alloc_range_nid`(`mm/memblock.c:1576`):它遍历 `memblock.memory`,跳过 `memblock.reserved` 覆盖的部分,在给定地址范围内找满足对齐要求的空洞。`memblock_alloc_try_nid`(`mm/memblock.c:1835`)和常用的内联 `memblock_alloc`(`include/linux/memblock.h:423`)都是它的包装。

```c
/* mm/memblock.c:1576 —— 简化后的分配逻辑 */
phys_addr_t __init memblock_alloc_range_nid(phys_addr_t size,
                phys_addr_t align, phys_addr_t start, phys_addr_t end,
                int nid, bool kmem)
{
        /* 扫描 memory，跳过 reserved，找到满足对齐的空洞 */
        ...
        return found;
}
```

注意它的几个特征:**没有 struct page、没有引用计数、没有回收、没有并发保护、没有 NUMA 均衡**。它只在 `__init` 阶段使用,分配出去的内存通常永不归还。这不是缺陷,而是引导期的正确取舍:先把系统跑起来,再谈精细管理。memblock 还区分 `MEMBLOCK_NOMAP`、`MEMBLOCK_MIRROR`、`MEMBLOCK_HOTPLUG` 等标志(`include/linux/memblock.h:57-60`),用来表达"不要建立直接映射""镜像区""可热插拔"等语义,这些信息在后续建立页表与 zone 时仍然有用。

## 二、交接:memblock_free_all 把空闲页交给 buddy

真正的交接分两步,顺序在 `init/main.c` 里很清楚:`mm_core_init_early()`(`init/main.c:1067`)先搭骨架,`mm_core_init()`(`init/main.c:1106`)再完成页分配器、slab、vmalloc 等初始化。

### 2.1 先有 zone,再有页

`mm_core_init_early`(`mm/mm_init.c:2681`)里先调用 `free_area_init`(`mm/mm_init.c:1838`)。这个函数根据架构给出的 zone 边界,算出每个 zone 的起止 PFN,并打印 `Zone ranges`。真正填充 zone 的是 `free_area_init_node`(`mm/mm_init.c:1733`)和 `free_area_init_core`(`mm/mm_init.c:1618`),其中会初始化 `free_area`、迁移类型、水位、锁以及 PCP。

`free_area_init_core` 内部会调用 `zone_pcp_init`(`mm/page_alloc.c:6420`),为每个 zone 计算 PCP 的 `high`、`batch`。PCP 的意义是:分配/释放单页时先走每 CPU 的页链表,避免每次抢 zone 的 spinlock;只有批量耗尽或超过高水位时才与 buddy 交互。

紧接着 `memmap_init`(`mm/mm_init.c:996`)遍历所有 PFN,把对应的 `struct page` 初始化成"空闲/保留"的初始状态。到这一步,`struct page` 数组才算可用。

### 2.2 一次性释放空闲页

`mm_core_init`(`mm/mm_init.c:2698`)里依次执行:

```text
build_all_zonelists(NULL)      — mm/page_alloc.c:6101   建立 zone 的分配回退顺序
memblock_free_all()           — mm/mm_init.c:2725       把空闲物理页交给 buddy
mem_init()                    — mm/mm_init.c:2677       架构相关的收尾
kmem_cache_init()             — 初始化 slab 的根缓存
```

`memblock_free_all`(`mm/memblock.c:2461`)先清理未使用的 memmap,再复位各 zone 的 `managed_pages`,最后调用 `free_low_memory_core_early`(`mm/memblock.c:2420`)。后者用 `for_each_free_mem_range` 遍历"memory 减去 reserved"的每一段,对每段调用 `__free_memory_core`(`mm/memblock.c:2329`),最终进入 `__free_pages_core`(`mm/page_alloc.c:1585`),把页按最大可用阶(order)挂进 buddy 的 `free_area`。

```text
memblock_free_all              — mm/memblock.c:2461
└─ free_low_memory_core_early  — mm/memblock.c:2420
   └─ __free_memory_core       — mm/memblock.c:2329
      └─ __free_pages_memory   — mm/memblock.c:2303
         └─ memblock_free_pages — mm/mm_init.c:2465
            └─ __free_pages_core — mm/page_alloc.c:1585
               └─ buddy 合并
```

从这里开始,memblock 的"账本"逐步退场,内存分配的主角变成 buddy 与后续的 slab。

### 2.3 zone、迁移类型与 PCP

- **zone**:`struct zone`(`include/linux/mmzone.h:955`)按物理地址范围划分,常见有 DMA、DMA32、NORMAL、MOVABLE。不同 zone 的可分配性不同,比如 `ZONE_MOVABLE` 用于可迁移内存。
- **迁移类型**:`enum migratetype`(`include/linux/mmzone.h:99`)把空闲页按能否迁移/回收分组,常见有 `MIGRATE_UNMOVABLE`、`MIGRATE_MOVABLE`、`MIGRATE_RECLAIMABLE`、`MIGRATE_HIGHATOMIC`、`MIGRATE_CMA`、`MIGRATE_ISOLATE`。按类型分桶能显著降低碎片:内核对象和可迁移的用户页尽量不混在一起。
- **PCP**:`struct per_cpu_pages`(`include/linux/mmzone.h:820`)保存每 CPU 的小批量页链表。分配路径 `__alloc_pages_noprof`(`mm/page_alloc.c:5494`)先尝试 `rmqueue_pcplist`(`mm/page_alloc.c:3368`),失败才进 `rmqueue_buddy`(`mm/page_alloc.c:3216`)。

迁移类型不是"绝对隔离",而是"优先同类型,必要时回退"。当某类空闲页不足时,buddy 会做 fallback,甚至触发 reclaim/compaction。这正是"分层 + 按需升级"的典型做法。

## 三、slab/slub:buddy 之上的小对象层

buddy 的分配单位是 `2^order` 个页,最小也是一页(通常 4KiB)。但内核里大量对象只有几十到几百字节:`task_struct`、`inode`、`dentry`、网络 skb 的某些结构、文件系统句柄等。直接一对象一页会浪费 90% 以上,于是有了 slab 分配器(slub 是当前默认实现)。

### 3.1 三层结构

- `struct kmem_cache`(`mm/slab.h:226`):一种对象类型一个缓存,记录对象大小、对齐、构造/析构、per-cpu 信息等
- `struct slab`(`mm/slab.h:116`):由若干连续页组成的"页块",被切成等长对象槽位
- 对象:真正返回给调用者的内存

`kmem_cache_create` 创建一个缓存;`kmem_cache_alloc_noprof`(`mm/slub.c:5038`)是分配入口。它构造一个 `struct slab_alloc_context`,然后调用 `slab_alloc_node`(`mm/slub.c:5006`):

```c
/* mm/slub.c:5006 —— 简化 */
static __fastpath_inline void *slab_alloc_node(struct kmem_cache *s,
                gfp_t gfpflags, int node, const struct slab_alloc_context *ac)
{
        s = slab_pre_alloc_hook(s, gfpflags);
        if (unlikely(!s))
                return NULL;

        object = kfence_alloc(s, ac->orig_size, gfpflags);
        if (unlikely(object))
                goto out;

        object = alloc_from_pcs(s, gfpflags, ac->alloc_flags, node);
        if (unlikely(!object))
                object = ___slab_alloc(s, gfpflags, node, ac);

        slab_post_alloc_hook(s, gfpflags, 1, &object, ac);
        return object;
}
```

这里有两个层次:**per-CPU slab 快路径**(`alloc_from_pcs`)和**慢路径**(`___slab_alloc`)。快路径不拿全局锁;慢路径才去找部分空闲的 slab、向 buddy 要新页、或从其他 CPU 偷取。释放路径同理,空的 slab 会被还给 buddy。

### 3.2 kmalloc 只是"按大小选缓存"

`kmalloc` 并不神秘,它先根据大小选一个通用缓存,再走同样的 `slab_alloc_node`:

```text
__kmalloc_noprof             — mm/slub.c:5548
└─ __do_kmalloc_node
   └─ kmalloc_slab           — mm/slab.h:418
      └─ slab_alloc_node     — mm/slub.c:5006
```

`kmalloc_slab` 维护 8、16、32……直到 `KMALLOC_MAX_CACHE_SIZE` 的尺寸类;超过这个阈值就退化为 `kmalloc_large`,直接向 buddy 要页。于是同一套 API 在"小对象"和"大块内存"之间自动切换,调用者不必关心。

## 四、从 struct page 到 folio:为什么要换单位

### 4.1 struct page 的负担

`struct page`(`include/linux/mm_types.h:80`)是物理页的元数据。它用 union 复用了很多字段:

- 页缓存/匿名页:`lru`、`mapping`、`index`、`private`
- 空闲页:buddy 链表或 PCP 链表
- 复合页的尾页:`compound_info`
- `_refcount`、`_mapcount` 等

问题在于:**一个 2MiB 的大页仍然是 512 个 `struct page`**。每次操作大页,内核都要反复做 `compound_head()` 去找 head page;而 `compound_head()` 既可能是一次指针追索,也可能涉及原子/标志位读取。对于 page cache、readahead、writeback 这些高频路径,这些开销会被放大。

### 4.2 folio 是什么

`struct folio`(`include/linux/mm_types.h:404`)不是新的物理对象,而是**"一个连续的、可作为整体管理的页组"的强类型视图**。它可以和 `struct page` 通过 union 互转,但语义上:

- 一个 folio 有一个 head page
- `folio_order`(`include/linux/mm.h:1946`)给出阶,`folio_test_large`(`include/linux/page-flags.h:867`)判断是否大于一页
- folio 的锁、引用计数、writeback 标志、LRU 项都是**按整体**计,而不是按 4KiB 页
- 访问 folio 内的第 n 页用 `folio_page(folio, n)`,不再需要每次 `compound_head`

这带来三个直接收益:

1. **类型安全**:接收 `struct folio *` 的函数明确表示"我处理的是整个页组",减少把尾页当首页用的错误
2. **减少重复计算**:一次拿到 order/nr_pages,后续循环复用
3. **支持 large folio**:page cache、匿名内存、readahead 可以按 2、4、8……页批量分配和管理,减少元数据与锁操作

需要强调的是,folio 与 page 之间的转换在编译后通常只是取地址或做一次 union 偏移,并没有额外的运行时分配。也就是说,folio 不是"再造一个对象",而是给现有物理页组套上一层更有语义的类型;真正的成本在于代码迁移与边界处理,而不在数据结构本身。

## 五、anon folio、THP 与文件路径

### 5.1 匿名页:从零页到 large folio

匿名缺页的入口是 `do_anonymous_page`(`mm/memory.c:5539`)。只读缺页通常直接映射全局零页;写缺页才真正分配。分配函数是 `alloc_anon_folio`(`mm/memory.c:5413`),它会先看该 VMA 是否允许小于 PMD 阶的 large folio:

```c
/* mm/memory.c:5436 附近 */
orders = thp_vma_allowable_orders(vma, vma->vm_flags, TVA_PAGEFAULT,
                                  BIT(PMD_ORDER) - 1);
...
folio = vma_alloc_folio(gfp, order, vma, addr);
```

如果 PMD 阶可用,则走透明大页路径 `do_huge_pmd_anonymous_page`(`mm/huge_memory.c:1558`);否则按可用阶分配 large folio。`__handle_mm_fault`(`mm/memory.c:6714`)在页表遍历时也会在 PUD/PMD 层尝试 `create_huge_pmd`,失败再回退到 PTE。

### 5.2 page cache:folio 是天然单位

文件页缓存本来就可能以多页为单位读入。`filemap_alloc_folio_noprof`(`mm/filemap.c:997`)按 `order` 分配;`filemap_read_folio`(`mm/filemap.c:2539`)对一个 folio 发起读取并等待解锁;`filemap_get_pages`(`mm/filemap.c:2715`)负责在 page cache 中查找/创建 folio 批次。

readahead 是 large folio 的主要受益者:

- `page_cache_sync_ra`(`mm/readahead.c:577`)处理同步预读
- `page_cache_async_ra`(`mm/readahead.c:653`)处理命中预读窗口后的异步预读
- 预读窗口越大,越倾向于一次分配更大的 folio,从而减少 `xarray` 项、减少锁竞争、减少 IO 提交次数

writeback 也以 folio 为单位:

- `__folio_start_writeback`(`mm/page-writeback.c:2991`)给整个 folio 置 writeback 标志,并在 `mapping->i_pages` 上打 `PAGECACHE_TAG_WRITEBACK`
- `__folio_end_writeback`(`mm/page-writeback.c:2954`)在 IO 完成后清除标志并唤醒等待者
- 一个 large folio 只需要一次标志位操作,而不是 512 次

回收路径同样受益:`shrink_folio_list`(`mm/vmscan.c:1161`)以 folio 为单位扫描 LRU,`shrink_node`(`mm/vmscan.c:6457`)和 `try_to_free_pages`(`mm/vmscan.c:6967`)负责整体回收决策。large folio 让 LRU 项更少,但也带来"部分页仍被引用时不好拆"的问题,所以内核在回收时可以按需 split。

### 5.3 large folio 的代价与边界

large folio 不是"越大越好"。它至少有三类代价:

- **内部碎片**:如果文件只有 5KiB 却分配了 16KiB 的 folio,尾部空间在拆分前无法被其他文件使用
- **拆分成本**:当只写其中一小部分、或回收器只需要释放一部分时,必须把 folio 拆成更小的页,涉及页表、rmap、引用计数的重新组织
- **失败回退**:设备/文件系统可以限制最小与最大 folio 阶,分配不到目标阶时要逐级回退,否则会放大分配失败率

因此内核的策略是"**能大则大,不能大则退**":readahead 根据预读窗口决定 order,anon 路径根据 VMA 的 THP 设置决定 order,文件系统还可以通过 `mapping_min_folio_order` 给出下限。这个策略与 buddy 的阶、迁移类型、PCP 批量共同决定了一次分配到底能拿到多大连续块。换句话说,folio 只是把"大页"这件事从零散的 `compound_head` 操作,提升为一等公民的接口;它并没有消除物理连续性这个根本约束。

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/内存管理/memblock-to-folio.html' | relative_url }}" loading="lazy" title="从 memblock 到 folio 的内存管理生命周期"></iframe>
  <figcaption>图 1:开机 → memblock → buddy → slab/page cache → 回收的生命周期与交接点。</figcaption>
</figure>

## 六、生命周期总表

| 阶段 | 分配器 | 分配单位 | 元数据 | 生命周期 | 典型使用者 |
|---|---|---|---|---|---|
| 引导期 | memblock | 物理地址区间 | `memblock_region` | 永久/直到交接 | 页表、initrd、早期结构 |
| 页分配 | buddy | `2^order` 页 | `struct page`、zone、free_area | 可分裂/合并 | 页表、slab、large folio |
| 小对象 | slab/slub | 对象 | `kmem_cache`、`struct slab` | 可回收为空 slab | `task_struct`、inode、dentry |
| 文件缓存 | page cache | folio | `address_space`、xarray | 可回收/回写 | 文件读写、mmap |
| 匿名内存 | anon/THP | folio/PMD | `anon_vma`、rmap | 可换出/回收 | 堆、栈、匿名映射 |

这张表最重要的信息不是名字,而是**单位在变**:区间 → 页 → 对象 → folio。每换一次单位,都是为了解决上一层的浪费或开销。

## 七、观测:把"层"看清楚

```bash
# 总览:空闲、缓存、slab、可回收
grep -E 'MemFree|MemAvailable|Cached|Slab|SReclaimable|SUnreclaim' /proc/meminfo

# buddy:各 zone、各阶的空闲块数量
cat /proc/buddyinfo
cat /proc/pagetypeinfo        # 按迁移类型看碎片

# slab:每个缓存的对象数、页数、活跃数
sudo slabinfo -v
sudo cat /proc/slabinfo | head

# 回收与缺页
grep -E 'pgsteal|pgscan|pgfault|pgmajfault' /proc/vmstat

# 分配热点
sudo perf trace -e kmem:kmalloc,kmem:kfree,kmem:mm_page_alloc -a sleep 5
sudo perf stat -e kmem:mm_page_alloc,kmem:mm_page_free -a sleep 5
```

判断内存问题时要先定位"层":

- `MemAvailable` 低但 `MemFree` 不低:大量可回收 page cache
- `buddyinfo` 里高阶块长期为 0:碎片化,可能需要 compaction
- `slabinfo` 某缓存持续增长:内核对象泄漏或缓存未回收
- `pgscan/pgsteal` 高但 `pgmajfault` 不高:回收压力来自文件页而非 swap

还有一个容易忽略的观察点:同一个指标在不同层含义不同。`MemFree` 只统计 buddy 的空闲页,不包含 PCP 里缓存的页,也不包含可回收的 page cache;`Slab` 既可能是活跃对象,也可能是可以收缩的空 slab。真正判断"内存是否紧张",要同时看 `MemAvailable`、watermark、`pgscan` 与分配失败计数(`/proc/vmstat` 的 `allocstall` 等)。只看一个数字,很容易把缓存当泄漏,或把碎片当容量不足。

## 八、设计精妙:分层、按需升级与批处理

1. **分层而非统一**:memblock 解决"能不能启动",buddy 解决"整页",slab 解决"小对象",folio 解决"大页语义"。每层只做自己擅长的事。
2. **按需升级**:小分配先走 PCP 和 per-CPU slab,失败才升级到 zone/buddy;大页先在 PUD/PMD 尝试,失败回退 PTE。快路径短、慢路径才复杂。
3. **迁移类型**:用"分桶 + 回退"降低碎片,而不是追求绝对隔离。MOVABLE 与 UNMOVABLE 分开,让 compaction 有腾挪空间。
4. **批处理**:PCP 批量、readahead 批量、large folio 批量、writeback 批量。批处理减少锁、减少元数据、减少 IO 次数。
5. **渐进式改造**:folio 没有推翻 `struct page`,而是用 union 与转换函数逐步迁移。这让一个拥有海量调用点的子系统可以渐进演进。

再补一句:分层的代价是"路径变长",所以每一层都必须在快路径上足够便宜。PCP、per-CPU slab、folio 的类型化访问,本质上都是在保留分层的同时,把最常用的一步做成近乎零开销。

理解了这条链,再看 `/proc/meminfo` 里的数字,就不再是孤立指标,而是"哪一层在做什么"的直接反映。

## 相关图示

- [伙伴系统]({{ '/linux-arch-dia/内存管理/buddy-allocator.html' | relative_url }})
- [slab 分配器]({{ '/linux-arch-dia/内存管理/slab-allocator.html' | relative_url }})
- [page cache 读取]({{ '/linux-arch-dia/内存管理/page-cache-read.html' | relative_url }})
- [页回收]({{ '/linux-arch-dia/内存管理/page-reclaim.html' | relative_url }})
- [缺页异常深度调用链]({{ '/linux-arch-dia/内存管理/deep-page-fault.html' | relative_url }})

> 源码基线:Linux `d487237`(v7.4.0-rc1)。行号会随内核版本漂移,以图集仓库重新 finalize 后的结果为准。
