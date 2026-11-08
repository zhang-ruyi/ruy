---
layout: post
title: "一次 IO 的数据变形记:从用户页到 NAND 页"
date: 2026-11-18
categories: [linux]
description: "read/write 一次 4KB 数据,在用户态、页缓存、块层、NVMe 驱动和 SSD 内部分别以什么形态存在、又通过什么结构转移;用图形而不是调用链来理解 Linux IO。"
---
Linux 内核 · IO 栈 · 源码基线 v7.4.0-rc1(`d487237`)

同样是一次 4KB 读写,数据在用户态是**用户页**,在页缓存是 **folio**,在块层是 **bio_vec**,在 NVMe 是 **PRP/SGL 地址**,在 SSD 内部是 **NAND 页**。它没有被复制成五个东西:多数步骤只是**换一种描述**,真正的数据搬运只有 CPU 拷贝和设备 DMA。

<div class="journey">
  <div class="journey-head"><span class="journey-title">同一批 4KB 的形态变换</span><span class="journey-note">读从右往左,写从左往右</span></div>
  <div class="journey-ribbon">
    <div class="hop tone-blue">
      <div class="where">用户内存</div>
      <div class="shape"><div class="mini-pages"><i></i><i></i><i></i><i></i></div></div>
      <div class="name">用户页</div>
      <div class="desc">虚拟地址</div>
    </div>
    <div class="journey-arrow copy"><span class="bar"></span><span>CPU 拷贝</span></div>
    <div class="hop tone-violet">
      <div class="where">页缓存</div>
      <div class="shape"><div class="mini-folio"><b>folio</b>index=2<br>uptodate</div></div>
      <div class="name">folio</div>
      <div class="desc">物理页 + 状态</div>
    </div>
    <div class="journey-arrow desc"><span class="bar"></span><span>换描述</span></div>
    <div class="hop tone-green">
      <div class="where">块层</div>
      <div class="shape"><div class="mini-segs"><i>bvec0 page+0+4K</i><i>bvec1 page+0+4K</i></div></div>
      <div class="name">bio_vec</div>
      <div class="desc">page + off + len</div>
    </div>
    <div class="journey-arrow desc"><span class="bar"></span><span>DMA 映射</span></div>
    <div class="hop tone-amber">
      <div class="where">NVMe 驱动</div>
      <div class="shape"><div class="mini-sqe"><b>SQE 64B</b>PRP1→page<br>PRP2→list</div></div>
      <div class="name">SQE / PRP</div>
      <div class="desc">DMA 地址</div>
    </div>
    <div class="journey-arrow dma"><span class="bar"></span><span>设备 DMA</span></div>
    <div class="hop tone-rose">
      <div class="where">SSD</div>
      <div class="shape"><div class="mini-nand"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
      <div class="name">NAND 页</div>
      <div class="desc">LBA → FTL</div>
    </div>
  </div>
  <div class="legend">
    <span><i class="copy"></i>CPU 拷贝(数据真的移动)</span>
    <span><i class="desc"></i>只换描述(不复制数据)</span>
    <span><i class="dma"></i>设备 DMA(数据真的移动)</span>
  </div>
  <div class="lanes">
    <div class="lane"><b>READ</b><span class="flow-step">NAND</span><span class="flow-arrow">→DMA→</span><span class="flow-step">PRP/SGL</span><span class="flow-arrow">→</span><span class="flow-step">folio</span><span class="flow-arrow">→copy→</span><span class="flow-step">用户页</span></div>
    <div class="lane"><b>WRITE</b><span class="flow-step">用户页</span><span class="flow-arrow">→copy→</span><span class="flow-step">folio</span><span class="flow-arrow">→换描述→</span><span class="flow-step">bio</span><span class="flow-arrow">→DMA→</span><span class="flow-step">NAND</span></div>
  </div>
</div>

## 一、用户态:一段虚拟地址

用户调用 `read(fd, buf, 4096)` 时,内核拿到的是 `buf` 这个**虚拟地址**。系统调用层把它包装成 `iov_iter`(`include/linux/uio.h:45`),类型 `ITER_IOVEC`(:27):里面是用户 `iovec`(虚拟地址 + 长度),对应一到多个用户页。

<div class="split">
  <div class="view-card">
    <h4>用户态:用户页</h4>
    <div class="io-row"><div class="mini-pages"><i></i><i></i><i></i><i></i></div><div class="mini"><code>iovec</code>:iov_base(虚拟地址)+ iov_len</div></div>
  </div>
  <div class="split-arrow"><span>iov_iter</span><span>read ← / write →</span></div>
  <div class="view-card">
    <h4>页缓存:folio</h4>
    <div class="io-row"><div class="mini-folio"><b>folio</b>index=2<br>uptodate</div><div class="mini"><code>address_space.i_pages</code> 的 value</div></div>
  </div>
</div>

**buffered read**:命中页缓存就 `copy_page_to_iter`(`lib/iov_iter.c:361`)把 folio 拷到用户页;未命中先读文件页。**buffered write**:`copy_from_user` 把用户页写进 folio,变脏,稍后回写。**O_DIRECT**:用户页被 pin 住,直接成为 bio 的 bvec,绕开页缓存。

## 二、页缓存:文件偏移 → folio

`address_space`(`include/linux/fs.h:471`)里的 `i_pages` xarray(:473)用**文件页号**做键,`folio` 做值。`folio`(`include/linux/mm_types.h:404`)把物理页、`index`、`flags`、`refcount` 放在一起。

<div class="io-box">
  <h4>文件偏移 → xarray → folio</h4>
  <div class="io-row">
    <span class="flow-step">offset 0</span><span class="flow-arrow">→</span><span class="flow-step">index 0</span><span class="flow-arrow">→</span><span class="mini-folio"><b>folio 0</b>4K</span>
    <span class="flow-step">offset 4K</span><span class="flow-arrow">→</span><span class="flow-step">index 1</span><span class="flow-arrow">→</span><span class="mini-folio"><b>folio 1</b>4K</span>
    <span class="flow-step">offset 8K</span><span class="flow-arrow">→</span><span class="flow-step">index 2</span><span class="flow-arrow">→</span><span class="mini-folio"><b>folio 2</b>4K</span>
  </div>
  <div class="lanes">
    <div class="lane"><b>READ</b><span class="flow-step">!uptodate</span><span class="flow-arrow">→read bio→</span><span class="flow-step">uptodate</span><span class="flow-arrow">→copy_page_to_iter→</span><span class="flow-step">用户页</span></div>
    <div class="lane"><b>WRITE</b><span class="flow-step">folio dirty</span><span class="flow-arrow">→writeback→</span><span class="flow-step">writeback</span><span class="flow-arrow">→</span><span class="flow-step">clean</span></div>
  </div>
  <div class="mini">读:`filemap_read`(`mm/filemap.c:2816`)→`filemap_get_pages`(:2715)→`filemap_read_folio`(:2539)→`ext4_read_folio`(`fs/ext4/readpage.c:321`)。写:`generic_perform_write`(`mm/filemap.c:4364`)→`ext4_write_begin`(`fs/ext4/inode.c:1403`)/`ext4_write_end`(:1558);回写 `ext4_writepages`(`fs/ext4/inode.c:3154`)。</div>
</div>

## 三、块层:folio 变成 bio 的段

页缓存页不会整块交给块层,而是被描述成 `bio` 里的 `bio_vec`。`bio`(`include/linux/blk_types.h:210`)有 `bi_opf`(:213)、`bi_iter`(:242)、`bio_vec[]`(:237);每个 `bio_vec`(`include/linux/bvec.h:28`)是 **page + offset + len**。

<div class="io-box">
  <h4>bio:把页描述成段</h4>
  <div class="io-row">
    <div class="mini-sqe"><b>bio</b>bi_opf=WRITE<br>bi_iter=sector/size</div>
    <span class="flow-arrow">→</span>
    <div class="mini-segs"><i>bvec0: page+0, 4K</i><i>bvec1: page+0, 4K</i><i>bvec2: page+0, 4K</i></div>
  </div>
  <div class="io-row" style="margin-top:8px">
    <span class="flow-step">folio 0</span><span class="flow-arrow">→</span><span class="flow-step">bvec0</span>
    <span class="flow-step">folio 1</span><span class="flow-arrow">→</span><span class="flow-step">bvec1</span>
    <span class="mini">buffered 的 bvec 页来自页缓存;O_DIRECT 的 bvec 页来自 pin 住的用户页(<code>bio_iov_iter_get_pages</code> `block/bio.c:1343`)。</span>
  </div>
</div>
<div class="io-box" style="margin-top:8px">
  <h4>request:blk-mq 的提交单位</h4>
  <div class="io-row">
    <span class="flow-step">bio</span><span class="flow-arrow">→包进→</span><span class="flow-step">request(q / mq_hctx / tag)</span><span class="flow-arrow">→queue_rq→</span><span class="flow-step">驱动</span>
  </div>
  <div class="mini"><code>submit_bio_noacct</code>(`block/blk-core.c:818`)→<code>blk_mq_submit_bio</code>(`block/blk-mq.c:3115`)→<code>queue_rq</code>;完成 <code>blk_mq_end_request</code>(:1165)→<code>bio_endio</code>(`block/bio.c:1863`)。</div>
</div>

## 四、NVMe:页指针变成 PRP/SGL 地址

`bio_vec` 里是页指针;NVMe 控制器只认 DMA 地址,驱动把它填进 SQE 的 `dptr`。SQE 是 64B 的 `nvme_command`(`include/linux/nvme.h:1992`),读写用 `nvme_rw_command`(:1100)。

<div class="io-box">
  <h4>SQE → PRP → 主机页</h4>
  <div class="io-row">
    <div class="mini-sqe"><b>SQE 64B</b>opcode=read/write<br>slba / length<br>dptr</div>
    <span class="flow-arrow">→PRP1→</span><div class="mini-pages"><i></i><i></i></div>
    <span class="flow-arrow">→PRP2→</span><div class="mini-folio"><b>PRP list</b>→ pages</div>
  </div>
  <div class="mini" style="margin-top:8px">驱动在 <code>nvme_map_data</code>(`drivers/nvme/host/pci.c:1469`)做 DMA 映射,<code>nvme_pci_setup_data_prp</code>(:1104)填 PRP;支持 SGL 时走 SGL。描述符存在 <code>nvme_iod</code>(`pci.c:437`)。</div>
</div>
<div class="io-box" style="margin-top:8px">
  <h4>SQ / CQ:提交与完成</h4>
  <div class="io-row">
    <span class="flow-step">SQ tail doorbell</span><span class="flow-arrow">→</span><span class="flow-step">设备 DMA</span><span class="flow-arrow">→</span><span class="flow-step">CQE(16B: status / command_id)</span>
  </div>
  <div class="mini">CQE 只是完成状态,不是数据;数据在 DMA 时已经写进主机内存/从主机内存读走。</div>
</div>

## 五、设备:LBA → FTL → NAND 页

`slba/length` 是逻辑块地址,不是物理位置。控制器通过 FTL 把 LBA 映射到 NAND 页;内部 DRAM 可能缓存映射表和数据;program/read 以 NAND 页为单位。

<div class="io-box">
  <h4>SSD 内部(示意)</h4>
  <div class="io-row">
    <div class="mini-nand"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <span class="flow-arrow">→FTL→</span>
    <div class="mini-segs"><i>L1 → NAND block 3 / page 7</i><i>L2 → NAND block 3 / page 8</i><i>L5 → NAND block 5 / page 1</i></div>
  </div>
  <div class="mini" style="margin-top:8px">写:主机数据 DMA → 内部缓冲 → ECC → NAND program;读:FTL 查物理页 → NAND read → ECC → DMA 到主机。LBA 连续不代表 NAND 物理连续,磨损均衡/垃圾回收在固件里。</div>
</div>

## 六、read 与 write 对照

| 层 | read | write |
|---|---|---|
| 用户态 | 用户页 ← copy | 用户页 → copy |
| 页缓存 | !uptodate → 读入 → uptodate | folio 变 dirty → 回写 |
| 块层 | bio READ,bvec 指向 folio 页 | bio WRITE,bvec 指向 folio 页 |
| NVMe | SQE read + PRP;DMA 写主机 | SQE write + PRP;DMA 读主机 |
| SSD | NAND read → 内部缓冲 → DMA | DMA → 内部缓冲 → NAND program |

**O_DIRECT**:用户页被 pin,直接进 `bio_vec`,没有页缓存这一层;`ext4_file_write_iter`(`fs/ext4/file.c:785`)分派 `ext4_dio_write_iter`(:593)或 `ext4_buffered_write_iter`(:348)。

## 七、三个边界

- **拷贝 vs 描述**:用户↔页缓存是 CPU 拷贝;folio→bvec、bvec→PRP 只是换描述,不复制数据。
- **page cache vs O_DIRECT**:buffered 的数据中途存在页缓存;O_DIRECT 只存在用户页与 DMA 路径。
- **数据 vs 完成**:CQE 是完成状态,不是数据;数据在 DMA 时已经移动。

## 八、观测

- `iostat -x` / `/proc/diskstats`:设备吞吐与延迟。
- `blktrace` / `bpftrace`:bio/request 合并、排队、下发。
- `perf`:`filemap_read`、`submit_bio`、`nvme_queue_rq`。
- `/proc/meminfo`、`slabinfo`:页缓存与对象分配。

> 一句话:用户页、folio、bvec、PRP、NAND 页,是同一批字节在五层里的五种形态;真正搬数据的只有 CPU 拷贝和设备 DMA。
