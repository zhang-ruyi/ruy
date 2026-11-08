# 一次 IO 的数据变形记:从用户页到 NAND 页

> 源码基线:Linux `d487237`(v7.4.0-rc1)

同样是一次 4KB 读写,数据在用户态是用户页,在页缓存是 folio,在块层是 bio_vec,在 NVMe 是 PRP/SGL 地址,在 SSD 内部是 NAND 页。它没有被复制成五个东西:多数步骤只是**换一种描述**,真正的数据搬运只有 CPU 拷贝和设备 DMA。

## 一、五层视图

| 层 | 数据形态 | 存在位置 | 下一步 |
|---|---|---|---|
| 用户态 | `iovec` / 用户页 | 用户内存 | CPU 拷贝到页缓存 |
| 页缓存 | folio(物理页 + index + 状态) | 内核内存 | 描述成 bio_vec |
| 块层 | bio_vec(page + off + len) | 内核内存 | 包进 request,下发驱动 |
| NVMe 驱动 | SQE + PRP/SGL DMA 地址 | 主机内存 + BAR | 设备 DMA |
| SSD | LBA → FTL → NAND 页 | NAND | program / read |

读从右往左,写从左往右。蓝线是 CPU 拷贝,紫线只换描述,黄线是设备 DMA。

## 二、用户态与页缓存

| 视图 | 内容 |
|---|---|
| 用户态 | `iov_iter`(ITER_IOVEC):iov_base 虚拟地址 + iov_len |
| 页缓存 | `address_space.i_pages` 的 value:folio(mapping/index/flags/refcount) |

buffered read 命中页缓存就 `copy_page_to_iter` 把 folio 拷到用户页;未命中先读文件页。buffered write 用 `copy_from_user` 把用户页写进 folio,变脏,稍后回写。O_DIRECT 则 pin 住用户页,直接成为 bio 的 bvec,绕开页缓存。

## 三、页缓存:文件偏移 → folio

`address_space` 里的 `i_pages` xarray 用文件页号做键:

| 文件偏移 | xarray 键 | 值 |
|---|---|---|
| offset 0 | index 0 | folio 0 |
| offset 4K | index 1 | folio 1 |
| offset 8K | index 2 | folio 2 |

| 路径 | 状态变化 |
|---|---|
| read | !uptodate → read bio → uptodate → copy_page_to_iter |
| write | dirty → writeback → clean |

读:`filemap_read` → `filemap_get_pages` → `filemap_read_folio` → `ext4_read_folio`。写:`generic_perform_write` → `ext4_write_begin` / `ext4_write_end`;回写 `ext4_writepages`。

## 四、块层:folio 变成 bio 的段

| 结构 | 关键字段 |
|---|---|
| bio | `bi_opf`(READ/WRITE)、`bi_iter`(sector/size)、`bi_vcnt` |
| bio_vec | `bv_page` + `bv_offset` + `bv_len` |
| request | q / mq_hctx / tag / bio 链表 / `__sector` |

buffered 的 bvec 页来自页缓存;O_DIRECT 的 bvec 页来自 pin 住的用户页。`submit_bio_noacct` → `blk_mq_submit_bio` → `queue_rq`;完成 `blk_mq_end_request` → `bio_endio`。

## 五、NVMe:页指针变成 PRP/SGL 地址

| SQE 字段 | 含义 |
|---|---|
| opcode | nvme_cmd_read / nvme_cmd_write |
| nsid | namespace |
| command_id | 完成时找回请求 |
| dptr | PRP1/PRP2 或 SGL |
| slba / length | 起始 LBA / 0-based 块数 |

PRP1 指向第一个主机页;PRP2 指向 PRP list 页,list 再指向更多主机页。驱动在 `nvme_map_data` 做 DMA 映射,`nvme_pci_setup_data_prp` 填 PRP;支持 SGL 时走 SGL。

CQE 只有 16B:`status / command_id / sq_head`,它是完成状态,不是数据。

## 六、SSD:LBA → FTL → NAND

| 逻辑 | 物理 |
|---|---|
| LBA 1 | NAND block 3 / page 7 |
| LBA 2 | NAND block 3 / page 8 |
| LBA 5 | NAND block 5 / page 1 |

写:主机数据 DMA → 内部缓冲 → ECC → NAND program;读:FTL 查物理页 → NAND read → ECC → DMA 到主机。LBA 连续不代表 NAND 物理连续,磨损均衡和垃圾回收在固件里。

## 七、read / write 对照

| 层 | read | write |
|---|---|---|
| 用户态 | 用户页 ← copy | 用户页 → copy |
| 页缓存 | !uptodate → 读入 → uptodate | folio 变 dirty → 回写 |
| 块层 | bio READ,bvec 指向 folio 页 | bio WRITE,bvec 指向 folio 页 |
| NVMe | SQE read + PRP,DMA 写主机 | SQE write + PRP,DMA 读主机 |
| SSD | NAND read → 内部缓冲 → DMA | DMA → 内部缓冲 → NAND program |

O_DIRECT:用户页被 pin,直接进 `bio_vec`,没有页缓存这一层;`ext4_file_write_iter` 分派 `ext4_dio_write_iter` 或 `ext4_buffered_write_iter`。

## 八、三个边界与观测

- 拷贝 vs 描述:用户↔页缓存是 CPU 拷贝;folio→bvec、bvec→PRP 只是换描述,不复制数据。
- page cache vs O_DIRECT:buffered 的数据中途存在页缓存;O_DIRECT 只存在用户页与 DMA 路径。
- 数据 vs 完成:CQE 是完成状态,不是数据;数据在 DMA 时已经移动。

观测:`iostat -x` / `/proc/diskstats`、`blktrace` / `bpftrace`、`perf` 看 `filemap_read` / `submit_bio` / `nvme_queue_rq`、`/proc/meminfo` 与 `slabinfo`。

---

完整数据视图:
https://zhang-ruyi.github.io/ruy/2026/11/18/io-data-journey.html
