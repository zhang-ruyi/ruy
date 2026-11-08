---
layout: post
title: "一次 IO 的数据变形记:从用户页到 NAND 页"
date: 2026-11-18
categories: [linux]
description: "read/write 一次 4KB 数据,在用户态、页缓存、块层、NVMe 驱动和 SSD 内部分别以什么视图存在、又通过什么结构转移;用数据视图而不是调用链来理解 Linux IO。"
---
Linux 内核 · IO 栈 · 源码基线 v7.4.0-rc1(`d487237`)

同样是一次 4KB 读写,在用户态它是 `iovec` 描述的一段虚拟地址;进了内核,它变成 `address_space` 里的一个 `folio`;到了块层,它变成 `bio` 里的一条 `bio_vec`;到了 NVMe,它变成 `nvme_command` 里的 PRP/SGL DMA 地址;到了 SSD 内部,它变成 LBA 对应的 NAND 页。**数据没有变成同一个东西,每一层换的是"描述方式"**。本文按"数据现在以什么视图存在、怎么交给下一层"来拆这条链路。

<div class="pipe">
  <div class="dataflow-head"><span class="dataflow-title">一次 IO 的五层视图</span><span class="dataflow-note">虚线是描述转换;真正的数据拷贝只发生在用户↔页缓存与 DMA</span></div>
  <div class="pipe-node">
    <div class="pipe-layer">用户态</div>
    <div class="pipe-body">
      <div class="unit-grid"><span class="unit">buf VA</span><span class="unit">iov_base</span><span class="unit">iov_len</span></div>
      <div class="mini"><code>struct iovec</code> / <code>iov_iter</code>(ITER_IOVEC):用户虚拟地址 + 长度;可能跨多个用户页。</div>
    </div>
  </div>
  <div class="pipe-arrow"><b>read: copy_page_to_iter</b> 页缓存 → 用户;<b>write: copy_from_user</b> 用户 → 页缓存</div>
  <div class="pipe-node">
    <div class="pipe-layer">内核 · 页缓存</div>
    <div class="pipe-body">
      <div class="unit-grid"><span class="unit">address_space.i_pages</span><span class="unit">folio</span><span class="unit">uptodate / dirty</span></div>
      <div class="mini"><code>struct folio</code> = 物理页 + 文件偏移(<code>index</code>)+ 状态;xarray 把文件页号映射到 folio。</div>
    </div>
  </div>
  <div class="pipe-arrow"><b>submit_bio / bio_endio</b> folio 变成 bio_vec;只是描述,不复制数据</div>
  <div class="pipe-node">
    <div class="pipe-layer">块层</div>
    <div class="pipe-body">
      <div class="unit-grid"><span class="unit">bio.bi_iter</span><span class="unit">bio_vec[]</span><span class="unit">request + tag</span></div>
      <div class="mini"><code>bio_vec</code> = page + offset + len;blk-mq 用 <code>request</code> 包住 bio,分配硬件队列与 tag。</div>
    </div>
  </div>
  <div class="pipe-arrow"><b>queue_rq</b> bvec 的物理页 → NVMe PRP/SGL 的 DMA 地址</div>
  <div class="pipe-node">
    <div class="pipe-layer">NVMe 驱动</div>
    <div class="pipe-body">
      <div class="unit-grid"><span class="unit">SQE 64B</span><span class="unit">PRP1 / PRP2</span><span class="unit">SGL</span><span class="unit">CQE 16B</span></div>
      <div class="mini"><code>nvme_command</code> 携带 opcode / nsid / slba / length / dptr;PRP/SGL 指向主机物理页。</div>
    </div>
  </div>
  <div class="pipe-arrow"><b>DMA</b> 设备按 PRP/SGL 读/写主机内存;完成后写 CQE 并发 MSI-X</div>
  <div class="pipe-node">
    <div class="pipe-layer">设备 · SSD</div>
    <div class="pipe-body">
      <div class="unit-grid"><span class="unit">LBA</span><span class="unit">FTL</span><span class="unit">NAND page</span></div>
      <div class="mini">控制器把 <code>slba/length</code> 翻译成 NAND 页地址;内部 DRAM、FTL 映射、program/read 由固件管理。</div>
    </div>
  </div>
</div>

## 一、用户态:一段虚拟地址

用户调用 `read(fd, buf, 4096)` 时,内核拿到的是 `buf` 这个**虚拟地址**,不是物理页。系统调用层把它包装成 `iov_iter`(`include/linux/uio.h:45`),类型是 `ITER_IOVEC`(:27),里面是用户 `iovec` 数组和总长度。

<div class="split">
  <div class="view-card">
    <h4>用户态视图</h4>
    <dl class="field-grid">
      <dt>iov_base</dt><dd>虚拟地址(可能跨页)</dd>
      <dt>iov_len</dt><dd>本段长度</dd>
      <dt>page</dt><dd>由 MMU 翻译成物理页</dd>
    </dl>
    <div class="unit-grid"><span class="unit">user page A</span><span class="unit">user page B</span></div>
  </div>
  <div class="split-arrow"><span>iov_iter</span><span>read ← / write →</span></div>
  <div class="view-card">
    <h4>页缓存视图</h4>
    <dl class="field-grid">
      <dt>mapping</dt><dd>address_space</dd>
      <dt>index</dt><dd>文件页号 = offset >> PAGE_SHIFT</dd>
      <dt>flags</dt><dd>uptodate / dirty / writeback</dd>
    </dl>
    <div class="unit-grid"><span class="unit">folio 0</span><span class="unit">folio 1</span></div>
  </div>
</div>

**buffered read**:页缓存命中就直接 `copy_page_to_iter`(`lib/iov_iter.c:361`)把 folio 拷到用户页;未命中则先把文件页读进 folio。**buffered write**:`copy_from_user` 把用户页写进 folio,数据留在页缓存,稍后由回写线程刷盘。**O_DIRECT** 则不同:用户页被 pin 住,直接成为 bio 的 bvec,绕开页缓存。

## 二、页缓存:文件偏移 → folio

页缓存的核心是 `address_space`(`include/linux/fs.h:471`)里的 `i_pages` xarray(:473):键是**文件页号**,值是 `folio`。`folio`(`include/linux/mm_types.h:404`)把物理页、`mapping`、`index`、`flags`、`refcount` 放在一起。

<div class="dataflow">
  <div class="dataflow-head"><span class="dataflow-title">页缓存:文件偏移 → folio</span><span class="dataflow-note">同一个文件页,读路径与写路径的状态不同</span></div>
  <div class="view-card">
    <h4>address_space.i_pages(xarray)</h4>
    <div class="unit-grid">
      <span class="unit">offset 0 → folio#0</span><span class="unit">offset 4K → folio#1</span><span class="unit">offset 8K → folio#2</span><span class="unit">offset 12K → folio#3</span>
    </div>
    <div class="mini">读未命中:<code>filemap_read</code>(`mm/filemap.c:2816`)→<code>filemap_get_pages</code>(:2715)→<code>filemap_read_folio</code>(:2539)→<code>ext4_read_folio</code>(`fs/ext4/readpage.c:321`)→ 下发读 bio。</div>
  </div>
  <div class="view-card" style="margin-top:10px">
    <h4>folio 状态</h4>
    <div class="state-row">
      <span class="state on">!uptodate</span><span class="state">→ read bio →</span><span class="state on">uptodate</span><span class="state">→ copy_to_iter</span>
    </div>
    <div class="state-row" style="margin-top:6px">
      <span class="state">write: dirty</span><span class="state">→ writeback</span><span class="state on">writeback</span><span class="state">→ clean</span>
    </div>
    <div class="mini">写路径:<code>generic_perform_write</code>(`mm/filemap.c:4364`)→<code>ext4_write_begin</code>(`fs/ext4/inode.c:1403`)/<code>ext4_write_end</code>(:1558);脏页由 <code>balance_dirty_pages</code>(`mm/page-writeback.c:1793`)节流,回写走 <code>ext4_writepages</code>(`fs/ext4/inode.c:3154`)。</div>
  </div>
</div>

## 三、块层:folio 变成 bio 的段

页缓存页不会"整块"交给块层,而是被描述成 `bio` 里的若干 `bio_vec`。`bio`(`include/linux/blk_types.h:210`)有 `bi_opf`(:213,READ/WRITE)、`bi_iter`(:242,起始 sector/size)、`bi_io_vec`(:237)和 `bi_vcnt`(:275)。每个 `bio_vec`(`include/linux/bvec.h:28`)就是 **page + offset + len**。

<div class="dataflow">
  <div class="dataflow-head"><span class="dataflow-title">bio 与 request:描述同一批页</span><span class="dataflow-note">bvec 指向页缓存页,不复制数据</span></div>
  <div class="view-card">
    <h4>bio</h4>
    <dl class="field-grid">
      <dt>bi_opf</dt><dd>READ / WRITE</dd>
      <dt>bi_iter</dt><dd>sector / size / idx</dd>
      <dt>bi_vcnt</dt><dd>段数</dd>
    </dl>
    <div class="bvec-list">
      <span class="bvec k">bvec0: folio#0 + 0, 4K</span>
      <span class="bvec k">bvec1: folio#1 + 0, 4K</span>
      <span class="bvec v">bvec2: folio#2 + 0, 4K</span>
    </div>
    <div class="mini">buffered IO 的 bvec 页来自页缓存;O_DIRECT 的 bvec 页来自 pin 住的用户页(<code>bio_iov_iter_get_pages</code>,`block/bio.c:1343`)。</div>
  </div>
  <div class="view-card" style="margin-top:10px">
    <h4>request(blk-mq)</h4>
    <dl class="field-grid">
      <dt>q / mq_hctx</dt><dd>请求队列 / 硬件队列</dd>
      <dt>tag</dt><dd>唯一 tag</dd>
      <dt>bio</dt><dd>bio 链表头</dd>
      <dt>__sector</dt><dd>起始扇区</dd>
    </dl>
    <div class="mini"><code>submit_bio_noacct</code>(`block/blk-core.c:818`)→<code>blk_mq_submit_bio</code>(`block/blk-mq.c:3115`)→<code>queue_rq</code>;完成时 <code>blk_mq_end_request</code>(:1165)→<code>bio_endio</code>(`block/bio.c:1863`)。</div>
  </div>
</div>

## 四、NVMe:物理页变成 PRP/SGL 地址

块层的 `bio_vec` 里是**页指针**;NVMe 控制器不认识虚拟地址,驱动要把它映射成 DMA 地址,填进 SQE 的 `dptr`。SQE 是 64B 的 `nvme_command`(`include/linux/nvme.h:1992`),读写用 `nvme_rw_command`(:1100):

<div class="dataflow">
  <div class="dataflow-head"><span class="dataflow-title">NVMe 的 SQE 与数据指针</span><span class="dataflow-note">PRP 是页地址列表;SGL 是另一种散射聚集描述</span></div>
  <div class="view-card">
    <h4>SQE(64B)</h4>
    <dl class="field-grid">
      <dt>opcode</dt><dd>nvme_cmd_read / nvme_cmd_write</dd>
      <dt>nsid</dt><dd>namespace</dd>
      <dt>command_id</dt><dd>完成时找回请求</dd>
      <dt>dptr</dt><dd>PRP1/PRP2 或 SGL</dd>
      <dt>slba / length</dt><dd>起始 LBA / 0-based 块数</dd>
    </dl>
  </div>
  <div class="view-card" style="margin-top:10px">
    <h4>PRP 视图</h4>
    <div class="unit-grid">
      <span class="unit">PRP1 → host page</span><span class="unit">PRP2 → PRP list page</span><span class="unit">PRP list → 更多 host page</span>
    </div>
    <div class="bvec-list"><span class="bvec">DMA addr A</span><span class="bvec">DMA addr B</span><span class="bvec">DMA addr C</span></div>
    <div class="mini">驱动在 <code>nvme_map_data</code>(`drivers/nvme/host/pci.c:1469`)里做 DMA 映射,<code>nvme_pci_setup_data_prp</code>(:1104)填 PRP;支持 SGL 时走 SGL。描述符存在 <code>nvme_iod</code>(`pci.c:437`)。</div>
  </div>
  <div class="view-card" style="margin-top:10px">
    <h4>SQ / CQ</h4>
    <div class="unit-grid"><span class="unit">SQ tail doorbell</span><span class="unit">CQ head doorbell</span><span class="unit">CQE: status / command_id / sq_head</span></div>
    <div class="mini">设备按 PRP/SGL 做 DMA:读命令把 NAND 数据写进主机页;写命令从主机页读数据。完成只写 CQE(状态),数据早已在主机内存里。</div>
  </div>
</div>

## 五、设备: LBA → FTL → NAND 页

到了 SSD 内部,`slba/length` 是**逻辑块地址**,不是物理位置。控制器通过 FTL 把 LBA 映射到 NAND 页,内部 DRAM 可能缓存映射表和数据;program/read 以 NAND 页为单位。

<div class="dataflow">
  <div class="dataflow-head"><span class="dataflow-title">SSD 内部视图(示意)</span><span class="dataflow-note">不同厂商固件实现不同,这里只画逻辑关系</span></div>
  <div class="view-card">
    <h4>LBA 空间</h4>
    <div class="lba-grid">
      <span class="lba">L0</span><span class="lba on">L1</span><span class="lba on">L2</span><span class="lba">L3</span><span class="lba">L4</span><span class="lba on">L5</span><span class="lba">L6</span><span class="lba">L7</span>
      <span class="lba">L8</span><span class="lba">L9</span><span class="lba ftl">FTL</span><span class="lba ftl">FTL</span><span class="lba on">L12</span><span class="lba">L13</span><span class="lba on">L14</span><span class="lba">L15</span>
    </div>
    <div class="unit-grid" style="margin-top:8px">
      <span class="unit">L1 → NAND block 3 / page 7</span>
      <span class="unit">L2 → NAND block 3 / page 8</span>
      <span class="unit">L5 → NAND block 5 / page 1</span>
    </div>
    <div class="mini">写:控制器把主机数据 DMA 到内部缓冲 → 编码/ECC → NAND program;读:FTL 查物理页 → NAND read → ECC → DMA 到主机。LBA 连续不代表 NAND 物理连续,磨损均衡/垃圾回收都在固件里。</div>
  </div>
</div>

## 六、read 与 write 的视图对照

| 层 | read 的数据视图 | write 的数据视图 | 关键转换 |
|---|---|---|---|
| 用户态 | `iov_iter` 指向用户 buffer | 同左 | `copy_page_to_iter` / `copy_from_user` |
| 页缓存 | folio `!uptodate` → 读入 → `uptodate` | folio 被写入 → `dirty` | xarray `index` → folio |
| 块层 | bio READ,bvec 指向 folio 页 | bio WRITE,bvec 指向 folio 页 | `bio_add_page` / `submit_bio` |
| NVMe | SQE read,PRP 指向主机页 | SQE write,PRP 指向主机页 | `nvme_map_data` |
| SSD | NAND read → 内部缓冲 → DMA | DMA → 内部缓冲 → NAND program | FTL LBA→物理页 |

**O_DIRECT** 是另一条视图:用户页被 pin 住(`bio_iov_iter_get_pages`),直接作为 `bio_vec` 的页;没有页缓存这一层,数据在用户页和 NAND 之间靠 DMA 搬运。`ext4_file_write_iter`(`fs/ext4/file.c:785`)根据是否 O_DIRECT 分派到 `ext4_dio_write_iter`(:593)或 `ext4_buffered_write_iter`(:348)。

## 七、三个容易混淆的边界

- **拷贝 vs 描述**:用户↔页缓存是 CPU 拷贝;folio→bvec、bvec→PRP 只是换描述,不复制数据。真正的数据搬运是 DMA。
- **page cache vs O_DIRECT**:buffered 路径的数据在中途存在于页缓存;O_DIRECT 的数据只存在于用户页和设备的 DMA 路径里。
- **数据 vs 完成**:CQE 只是完成状态(16B),不是数据;数据在 DMA 时已经写进主机内存/从主机内存读走。

## 八、观测

- `iostat -x` / `/proc/diskstats`:设备层吞吐与延迟。
- `blktrace` / `bpftrace`:bio/request 的合并、排队、下发。
- `perf`:`filemap_read`、`submit_bio`、`nvme_queue_rq` 的热点。
- `slabinfo` / `/proc/meminfo`:页缓存与对象分配。
- `nvme smart-log` / `nvme id-ns`:设备侧块大小、LBA 格式。

> 一句话收束:一次 IO 的数据没有"变成同一个东西";用户页、folio、bvec、PRP、LBA/NAND 页,是同一批字节在五层里的五种描述。
