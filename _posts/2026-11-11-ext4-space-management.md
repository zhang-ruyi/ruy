---
layout: post
title: "ext4:内核态与设备级空间管理如何串联"
date: 2026-11-11
categories: [kernel-deep]
description: 从 superblock/块组/位图/extent 到 mballoc、延迟分配、JBD2、fsync/barrier、bio/request queue 与 discard/TRIM 的完整空间管理链路
---
内核精读 · 文件系统/ext4 · 源码基线 v7.4.0-rc1

ext4 的"空间管理"经常被拆成两个不相干的话题:文件系统侧讲位图、extent、延迟分配;块层侧讲 bio、request queue、NVMe/SCSI。但在内核里,这两件事是**同一条链路的两端**:ext4 先在逻辑块空间里挑中一块物理块,再把"逻辑块 → 物理块"的映射写进 inode 的 extent 树,最后把脏页转成 bio,交给块层变成 request 发给设备。本文沿 v7.4.0-rc1 源码,把这条链路从磁盘布局一直串到 discard/TRIM。

<div class="callout">
本文结构:磁盘布局 → 块位图与 mballoc → inode/extent/延迟分配/预分配 → JBD2 事务与三种日志模式 → fsync/barrier → bio/request queue/NVMe → discard/TRIM → 碎片/预留/orphan/resize → 观测工具 → 设计精妙。
</div>

## 一、磁盘布局:先建立一张地图

ext4 把设备切成一系列**块组(block group)**,每个块组内既有自己的元数据,也有一批数据块。启动时内核只看块组 0 里的主 superblock 和组描述符表;其余块组可能保存 superblock/GDT 的冗余副本。

### 1.1 superblock:全盘的"总账"

superblock 位于偏移 1024 字节处(块大小为 1024 时位于块 1),这块区域前 1024 字节在块组 0 中留空,以兼容 x86 引导扇区。结构是 `struct ext4_super_block`(`fs/ext4/ext4.h:1372`),关键字段包括:

- `s_inodes_count` / `s_blocks_count_lo` / `s_blocks_count_hi`:inode 总数、块总数(高 32 位在 64bit 特性下使用)
- `s_first_data_block`:第一个数据块号(块大小 1024 时为 1,否则为 0)
- `s_log_block_size`:块大小的对数编码
- `s_blocks_per_group` / `s_inodes_per_group`:每块组的块数/inode 数
- `s_magic`:ext4 魔数
- `s_feature_compat` / `s_feature_incompat` / `s_feature_ro_compat`:特性位图
- `s_journal_inum`(`fs/ext4/ext4.h:1432`):日志 inode 号(通常为 8)

特性位决定了磁盘格式的"方言":`EXT4_FEATURE_INCOMPAT_EXTENTS`(`fs/ext4/ext4.h:2238`)表示用 extent 树,`EXT4_FEATURE_INCOMPAT_64BIT`(`:2239`)表示支持 64 位块号,`EXT4_FEATURE_INCOMPAT_FLEX_BG`(`:2241`)允许把多个块组的位图和 inode 表集中摆放,`EXT4_FEATURE_RO_COMPAT_BIGALLOC`(`:2219`)把分配单位从块提升为 cluster。

### 1.2 group descriptor:每组的"目录"

每个块组有一个 `struct ext4_group_desc`(`fs/ext4/ext4.h:402`),记录:

- `bg_block_bitmap_lo` / `bg_block_bitmap_hi`:块位图所在块
- `bg_inode_bitmap_lo` / `bg_inode_bitmap_hi`:inode 位图所在块
- `bg_inode_table_lo` / `bg_inode_table_hi`:inode 表起始块
- `bg_free_blocks_count_lo/hi`、`bg_free_inodes_count_lo/hi`:空闲计数
- `bg_used_dirs_count`:目录数,供 Orlov 分配器做目录分散
- `bg_flags`:如 `EXT4_BG_BLOCK_UNINIT`、`EXT4_BG_INODE_UNINIT`,表示位图/表尚未初始化
- `bg_checksum`:元数据校验和

内核通过 `ext4_get_group_desc`(`fs/ext4/balloc.c:265`)按块组号定位描述符。注意 `bg_block_bitmap`、`bg_inode_bitmap`、`bg_inode_table` 都是**块号**,不是偏移;它们可以因为 `flex_bg` 而"漂浮"到别的块组,所以不能假设每组布局固定。

### 1.3 一个块组的典型布局

```text
块组 0:
[0, 1024)        引导扇区/保留
[1024, ...)      superblock
                 group descriptors
                 reserved GDT blocks
                 block bitmap        ← 1 块
                 inode bitmap        ← 1 块
                 inode table         ← 多块
                 data blocks
块组 N:
                 (可能) superblock 副本
                 (可能) GDT 副本
                 block bitmap / inode bitmap / inode table
                 data blocks
```

块位图每 bit 表示一个块(或一个 cluster)是否占用;inode 位图每 bit 表示一个 inode 是否占用;inode 表是定长 inode 的数组。`flex_bg` 会把多个组的这些元数据集中到一组开头,减少寻道。

### 1.4 inode 与 extent 树

`struct ext4_inode`(`fs/ext4/ext4.h:794`)是磁盘上的 inode。最关键的字段是 `i_block[EXT4_N_BLOCKS]`:在 extent 模式下,它不是 15 个直接/间接块指针,而是**内联的 extent 树根**。

extent 的三类磁盘结构在 `fs/ext4/ext4_extents.h`:

- `struct ext4_extent_header`(`:78`):`eh_magic`、`eh_entries`、`eh_max`、`eh_depth`
- `struct ext4_extent_idx`(`:67`):索引节点,指向下一层块
- `struct ext4_extent`(`:56`):叶子节点,描述"逻辑块起点 + 长度 + 物理块起点"

一个 extent 可以覆盖连续的多块,因此大文件通常只需要很少的树节点。创建新 inode 时,`ext4_ext_tree_init`(`fs/ext4/extents.c:872`)会把根 header 写进 `i_block`,depth 为 0,表示根就是叶子。

## 二、分配:位图是底座,mballoc 是大脑

### 2.1 块位图与最小分配单位

最底层的"空间账本"是块位图。ext4 用 `ext4_set_bit`/`ext4_clear_bit`/`ext4_test_bit` 操作位图;在 mballoc 内部还有 `mb_set_bit`/`mb_clear_bit` 等封装(`fs/ext4/mballoc.c:488` 附近)。一次分配至少要占一个 bit,`bigalloc` 特性下则占一个 cluster(多个块)。

块位图适合"知道某块是否空闲",但不适合"快速找到连续的一段"。ext4 的解法是在内存里为每个块组维护更丰富的统计信息,也就是 mballoc。

### 2.2 mballoc:从 goal 到 preallocation

块分配的入口是 `ext4_mb_new_blocks`(`fs/ext4/mballoc.c:6228`)。它接收一个 `struct ext4_allocation_request`(`fs/ext4/ext4.h:210`),里面包含 inode、目标逻辑块、长度、goal 等信息。核心流程:

```text
ext4_mb_new_blocks                 — fs/ext4/mballoc.c:6228
├─ ext4_mb_initialize_context      — fs/ext4/mballoc.c:5882
├─ ext4_mb_use_preallocated        — fs/ext4/mballoc.c:4875
└─ ext4_mb_regular_allocator       — fs/ext4/mballoc.c:3000
   └─ ext4_mb_find_by_goal         — fs/ext4/mballoc.c:2428
```

`ext4_mb_initialize_context` 把请求转换成分配上下文 `struct ext4_allocation_context`(`fs/ext4/mballoc.h:173`),并设置 goal。`ext4_mb_use_preallocated` 先尝试复用预分配空间;失败才进入常规分配器。

`ext4_mb_regular_allocator` 按"最佳匹配/目标块组/遍历"的顺序找空间。它会在块组的 buddy 位图上找连续空闲段:`struct ext4_buddy`(`fs/ext4/mballoc.h:224`)和 `mb_set_bit`/`mb_clear_bit` 就是为这个场景服务的。找到后更新块位图、组描述符空闲计数,并把结果写回 extent 树。

预分配是 ext4 抑制碎片的关键。`struct ext4_prealloc_space`(`fs/ext4/mballoc.h:118`)记录一段为某个 inode 或某个块组预留的空间:

- `ext4_mb_new_inode_pa`(`fs/ext4/mballoc.c:5250`):按 inode 预留,适合同一文件持续追加
- `ext4_mb_new_group_pa`(`fs/ext4/mballoc.c:5350`):按块组预留,适合多文件共享局部性

### 2.3 inode 分配:Orlov 与目标块组

inode 分配入口是 `__ext4_new_inode`(`fs/ext4/ialloc.c:933`)。它先调用 `new_inode`,再在 inode 位图中找空位。选组策略有两套:

- `find_group_orlov`(`fs/ext4/ialloc.c:424`):目录密集场景,尽量把子目录分散到不同块组,避免热点
- `find_group_other`(`fs/ext4/ialloc.c:572`):普通文件,优先靠近父目录所在组,提升局部性

选中组后,内核读入该组的 inode 位图,找到空闲 bit,设置位图、更新组描述符、初始化磁盘 inode。inode 号 = 组号 × 每组 inode 数 + 组内偏移。

### 2.4 延迟分配:先记账,后落盘

ext4 默认开启延迟分配(delalloc)。写 `write()` 时并不立刻分配物理块,而是:

1. `ext4_da_write_begin`(`fs/ext4/inode.c:3263`)只把页标记为脏
2. `ext4_da_write_end`(`fs/ext4/inode.c:3418`)更新 inode 大小与时间
3. 真正的映射推迟到 writeback,由 `ext4_da_map_blocks`(`fs/ext4/inode.c:2033`)完成
4. `ext4_da_get_block_prep`(`fs/ext4/inode.c:2140`)在回写时把延迟块变成真实块

延迟分配的好处是把"多次小写"合并成"一次大分配",让 mballoc 有机会找到更连续的空间;代价是崩溃时可能丢失尚未回写的数据(取决于日志模式)。`ext4_nonda_switch`(`fs/ext4/inode.c:3229`)会在内存压力或特殊场景下临时关闭延迟分配,避免脏页堆积。

### 2.5 extent 分配:把结果写进树

真正的块映射入口是 `ext4_map_blocks`(`fs/ext4/inode.c:772`)。它先查 extent status tree 缓存,再按 inode 特性分派:

- extent 文件:`ext4_ext_map_blocks`(`fs/ext4/extents.c:4275`)
- 旧式间接块:`ext4_ind_map_blocks`(`fs/ext4/indirect.c:530`)

extent 路径会先用 `ext4_find_extent` 找到叶子,然后调用 `ext4_ext_insert_extent`(`fs/ext4/extents.c:1992`)插入或合并 extent。如果叶子满了,就分裂/新建节点,树高增加。这个过程需要日志保护,否则崩溃会留下"块已分配但树没更新"的不一致。

### 2.6 预分配:fallocate 与 unwritten extent

`ext4_fallocate`(`fs/ext4/extents.c:4970`)支持预分配。它通常分配一块空间并标记为 **unwritten extent**:物理块已经保留,但逻辑上读出来是零,直到真正写入才转成 written。`ext4_zero_range`(`fs/ext4/extents.c:4780`)则在指定范围做零填充,常用于避免后续读旧数据。

预分配的价值是"先占坑,后写入":对于日志、数据库、虚拟机镜像这类会持续增长的文件,可以显著减少碎片和分配次数。

## 三、日志:JBD2 如何把空间变更变原子

ext4 的元数据变更通过 JBD2(journaling block device 2)提交。日志本身是一个隐藏文件,通常 inode 号为 8;`struct journal_s`(`include/linux/jbd2.h:764`)描述整个日志,`struct transaction_s`(`:571`)描述一个事务。

### 3.1 一次事务的生命周期

```text
jbd2_journal_start              — fs/jbd2/transaction.c:539
jbd2_journal_get_write_access   — fs/jbd2/transaction.c:1233
jbd2_journal_dirty_metadata     — fs/jbd2/transaction.c:1517
jbd2_journal_commit_transaction — fs/jbd2/commit.c:376
jbd2_journal_flush              — fs/jbd2/journal.c:2415
```

- `jbd2_journal_start` 获取 handle,并预留 `nblocks` 个日志块信用
- `jbd2_journal_get_write_access` 把 buffer head 纳入事务,准备 COW 式修改
- `jbd2_journal_dirty_metadata` 标记元数据已修改
- 提交线程调用 `jbd2_journal_commit_transaction` 把事务写入日志,再写 commit record
- `jbd2_journal_flush` 等待/强制日志落盘

事务状态机在 `include/linux/jbd2.h:588-596`,依次经历 `T_RUNNING`、`T_LOCKED`、`T_SWITCH`、`T_FLUSH`、`T_COMMIT`、`T_COMMIT_DFLUSH`、`T_COMMIT_JFLUSH`、`T_COMMIT_CALLBACK`、`T_FINISHED`。这个状态机的意义是:先把所有修改固定下来,再决定提交顺序,最后才允许新事务复用日志空间。

### 3.2 三种日志模式

| 模式 | 数据是否进日志 | 数据/元数据顺序 | 崩溃后数据一致性 | 典型代价 |
|---|---|---|---|---|
| `data=journal` | 是 | 数据与元数据都先写日志 | 最强,数据也可恢复 | 写放大最大,吞吐最低 |
| `data=ordered` | 否 | 数据先落盘,元数据后提交 | 元数据一致,旧数据可能被暴露 | 默认,平衡 |
| `data=writeback` | 否 | 不保证数据先于元数据 | 元数据一致,数据可能损坏 | 最快,但最弱 |

模式宏定义在 `fs/ext4/ext4.h:1273-1275`:`EXT4_MOUNT_JOURNAL_DATA`、`EXT4_MOUNT_ORDERED_DATA`、`EXT4_MOUNT_WRITEBACK_DATA`。`data=ordered` 是默认值,它的关键保证是:在包含某文件元数据的事务提交前,先把该文件对应的数据页写回。这样崩溃后不会出现"元数据说文件变长了,但新数据块还是旧内容"的严重问题。

### 3.3 fsync 与 barrier

`fsync` 对应 `ext4_sync_file`(`fs/ext4/fsync.c:128`):

```text
ext4_sync_file                 — fs/ext4/fsync.c:128
├─ file_write_and_wait_range
├─ ext4_fsync_journal          — fs/ext4/fsync.c:96
│  └─ 等待相关事务提交
└─ blkdev_issue_flush          — fs/ext4/fsync.c:166
```

如果有日志,元数据由日志保证,`ext4_fsync_journal` 等待对应事务提交;如果没有日志,`ext4_fsync_nojournal`(`fs/ext4/fsync.c:79`)直接回写并判断是否需要 flush。最后 `blkdev_issue_flush` 把设备写缓存刷到稳定介质。

JBD2 提交时使用 `REQ_PREFLUSH | REQ_FUA`(`fs/jbd2/commit.c:153`)。这两个标志定义在 `include/linux/blk_types.h:432-433`:

- `REQ_PREFLUSH`:写数据前先让设备把缓存刷干净
- `REQ_FUA`:写完成后数据必须落到非易失介质

块层的 flush 状态机在 `block/blk-flush.c` 里,`blkdev_issue_flush`(`block/blk-flush.c:476`)是统一入口。设备若不支持 FUA,块层会把 FUA 转成 POSTFLUSH;若支持,则直接下发。barrier 语义最终由设备缓存策略和块层共同保证。

## 四、从 inode 到设备:bio、request queue、NVMe/SCSI

### 4.1 脏页回写

`ext4_writepages`(`fs/ext4/inode.c:3154`)是 address_space 的回写入口。它遍历脏 folio,调用 `ext4_bio_write_folio`(`fs/ext4/page-io.c:465`)把 folio 拆成 buffer head,再通过 `ext4_io_submit`(`fs/ext4/page-io.c:392`)提交。

```c
/* fs/ext4/page-io.c:392 附近 —— 简化 */
void ext4_io_submit(struct ext4_io_submit *io)
{
        struct bio *bio = io->io_bio;

        if (bio) {
                if (io->io_wbc->sync_mode == WB_SYNC_ALL)
                        io->io_bio->bi_opf |= REQ_SYNC;
                blk_crypto_submit_bio(io->io_bio);
        }
        io->io_bio = NULL;
}
```

`blk_crypto_submit_bio` 在没有内联加密上下文时直接调用 `submit_bio`。bio 的 sector 来自 `bh->b_blocknr` 乘以每块扇区数,也就是 ext4 已经算好的**物理块号**;`b_blocknr` 是文件系统块号,块层只认 512 字节扇区。

### 4.2 块层:bio → request

```text
submit_bio                    — block/blk-core.c:960
└─ submit_bio_noacct          — block/blk-core.c:818
   └─ blk_mq_submit_bio       — block/blk-mq.c:3115
      └─ 驱动 queue_rq        — NVMe/SCSI
```

`blk_mq_submit_bio` 负责分配 request、选择硬件队列(hctx)、做合并/plug、调用驱动的 `queue_rq`。对 NVMe,`queue_rq` 会把命令写进 SQ 并敲门铃;对 SCSI,则走 SCSI mid-layer 与 host adapter。ext4 不关心这些差异,它只负责把"逻辑块 → 物理块"的映射做对,并把 bio 交出去。

### 4.3 discard/TRIM

删除文件或截断时,ext4 可以告诉设备"这些块不再需要",让 SSD 做垃圾回收:

- `ext4_issue_discard`(`fs/ext4/mballoc.c:3958`)把范围转成 discard 请求,经 `sb_issue_discard`(`include/linux/blkdev.h:1205`)换算成扇区
- 最终调用 `blkdev_issue_discard`(`block/blk-lib.c:84`)
- `ext4_trim_all_free`(`fs/ext4/mballoc.c:6991`)实现 FITRIM 的批量 trim
- 挂载选项 `discard` 让释放路径自动发 discard;也可以手动 `fstrim`

discard 不是"必须":它会影响延迟,也可能与加密/RAID 交互,所以现代系统更常用周期性 `fstrim`,而不是在线 `discard`。

## 五、空间管理:碎片、预留、orphan 与 resize

### 5.1 碎片控制

ext4 用多种手段控制碎片:

- **extent**:把连续块合并成一个描述,减少树节点
- **mballoc goal**:优先在目标块组附近分配,保持局部性
- **预分配**:为增长型文件预留连续空间
- **flex_bg**:把元数据集中,给数据块留下更大的连续区域
- **bigalloc**:以 cluster 为单位分配,减少位图与 extent 项,但会增加内部碎片

碎片不是"越少越好",而是要在**局部性、连续性、空间利用率**之间取舍。

### 5.2 预留块与配额

superblock 的 `s_r_blocks_count` 保留一部分块只给 root 使用,避免普通用户把文件系统写满后 root 也无法操作。分配路径会通过 `ext4_claim_free_clusters` 等检查空闲量,配额则由 dquot 层在 `ext4_mb_new_blocks` 里扣减。

### 5.3 orphan:崩溃后的"待清理"

删除/截断一个 inode 时,ext4 先把 inode 加入 orphan 列表,再释放块,最后移除 orphan。`ext4_orphan_add`(`fs/ext4/orphan.c:102`)和 `ext4_orphan_del`(`fs/ext4/orphan.c:226`)负责维护。这样即使崩溃,`e2fsck` 也能根据 orphan 记录找到"删了一半"的 inode 并完成清理。

### 5.4 在线 resize

`ext4_resize_fs`(`fs/ext4/resize.c:1999`)支持在线扩容,入口是 `EXT4_IOC_RESIZE_FS`(`fs/ext4/ioctl.c:1736`)。扩容时:

1. 更新 superblock 的块计数
2. `ext4_group_add`(`fs/ext4/resize.c:1703`)初始化新块组的描述符
3. `ext4_group_add_blocks`(`fs/ext4/mballoc.c:6793`)把新块加入 mballoc 的空闲统计
4. 更新备份 superblock/GDT

收缩通常不受支持,或者需要离线操作。

## 六、布局与日志模式总表

| 区域 | 作用 | 关键结构/字段 | 分配/访问入口 |
|---|---|---|---|
| superblock | 全盘总账、特性、日志 inode | `ext4_super_block`、`s_feature_*` | 挂载时读取 |
| group descriptor | 每组位图/表位置、空闲计数 | `ext4_group_desc`、`bg_*` | `ext4_get_group_desc` |
| block bitmap | 块/cluster 占用 | bit per block/cluster | mballoc、`ext4_set_bit` |
| inode bitmap | inode 占用 | bit per inode | `__ext4_new_inode` |
| inode table | 定长 inode 数组 | `ext4_inode`、`i_block` | inode 读写 |
| extent tree | 逻辑块到物理块映射 | `ext4_extent_header/idx/extent` | `ext4_ext_map_blocks` |
| journal | 元数据事务日志 | `journal_s`、`transaction_s` | JBD2 |

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/文件系统/ext4-layout.html' | relative_url }}" loading="lazy" title="ext4 磁盘布局与空间管理"></iframe>
  <figcaption>图 1:superblock、块组、位图、inode 表、extent 树与日志的布局关系。</figcaption>
</figure>

## 七、观测与工具

```bash
# 查看布局:块大小、块组、inode 数、特性、日志
sudo dumpe2fs -h /dev/nvme0n1p2
sudo dumpe2fs /dev/nvme0n1p2 | head -80

# 调整特性/参数(谨慎)
sudo tune2fs -l /dev/nvme0n1p2
sudo tune2fs -O metadata_csum /dev/nvme0n1p2

# 一致性检查(离线)
sudo e2fsck -f /dev/nvme0n1p2

# 查看碎片
sudo e4defrag -c /mnt/data
filefrag -v /mnt/data/bigfile

# 在线 trim
sudo fstrim -av

# 跟踪分配与日志
sudo perf trace -e ext4:ext4_request_blocks,ext4:ext4_ext_map_blocks_enter -a sleep 5
sudo perf trace -e jbd2:jbd2_start_commit,jbd2:jbd2_end_commit -a sleep 5
```

判断问题时要分层:

- `filefrag` 显示碎片多:看 mballoc goal、预分配、文件增长模式
- `dumpe2fs` 显示空闲块多但写入 `ENOSPC`:看保留块、配额、inode 耗尽
- `fsync` 慢:看日志提交、barrier、设备写缓存策略
- `fstrim` 慢:看 discard 粒度与设备队列能力

## 八、设计精妙:三层解耦与两次延迟

1. **位图 + extent 两级分配**:位图回答"哪些块空闲",extent 回答"文件占哪些连续块"。前者适合快速标记,后者适合大文件的高效映射。两者通过 mballoc 的 goal/preallocation 连接起来。
2. **日志与延迟分配配合**:延迟分配把物理块选择推迟到回写,让 mballoc 看到更大的连续写;日志则保证"元数据变更"原子。二者分工明确:一个优化空间布局,一个保证崩溃一致性。
3. **与块层解耦**:ext4 只产生 bio,不关心 request queue、NVMe SQ/CQ 或 SCSI 命令。物理块号一旦确定,后续都由块层和设备驱动处理。这让 ext4 可以同时跑在 NVMe、SCSI、virtio 上。
4. **空间管理的"两次延迟"**:第一次是写路径的 delalloc,第二次是日志提交的 checkpoint。前者延迟块分配,后者延迟元数据落盘,都是在"看清全局后再做决定"。
5. **预留与回退**:预分配、保留块、迁移类型、goal fallback 都是"先给一个好位置,不行再退而求其次"的策略,兼顾性能与鲁棒性。

把这条链走完,就能理解为什么一次 `write()` + `fsync()` 会同时牵动 extent 树、块位图、JBD2 事务、bio 和 request queue:它们不是五个独立模块,而是同一个空间管理故事的不同章节。

## 相关图示

- [VFS 架构]({{ '/linux-arch-dia/文件系统/vfs-architecture.html' | relative_url }})
- [writeback 流程]({{ '/linux-arch-dia/文件系统/writeback-flow.html' | relative_url }})
- [块层 IO 深度调用链]({{ '/linux-arch-dia/设备驱动/deep-block-io.html' | relative_url }})

> 源码基线:Linux `d487237`(v7.4.0-rc1)。行号会随内核版本漂移,以图集仓库重新 finalize 后的结果为准。
