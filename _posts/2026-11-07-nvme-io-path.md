---
layout: post
title: "从 read() 到 NVMe 门铃:一次 IO 的完整旅程"
date: 2026-11-07
categories: [kernel-deep]
description: VFS → 块层 blk-mq → NVMe queue_rq → SQ 门铃 → MSI-X 完成回收
---
[打开可交互深度调用链]({{ '/linux-arch-dia/NVMe驱动/deep-nvme-io.html' | relative_url }})

一次 `read()` 看起来只是把数据从磁盘搬到用户缓冲区,实际要穿过 VFS、页缓存、块层、blk-mq、NVMe 驱动和 PCIe 设备。下面按时间顺序走一遍,重点看**谁在什么上下文里做了什么**。

## 全景调用链

```text
[提交路径 · 进程上下文]
ksys_read                        — fs/read_write.c:705
└─ vfs_read                      — fs/read_write.c:554
   └─ submit_bio_noacct          — block/blk-core.c:818
      └─ blk_mq_submit_bio       — block/blk-mq.c:3115
         └─ nvme_queue_rq        — drivers/nvme/host/pci.c:1663
            ├─ nvme_setup_cmd    — drivers/nvme/host/core.c:1107
            ├─ nvme_sq_copy_cmd  — drivers/nvme/host/pci.c:742
            └─ nvme_write_sq_db  — drivers/nvme/host/pci.c:724

[设备执行 · NVMe 控制器]
SQE DMA fetch → 执行命令 → CQE 写入 → MSI-X 中断

[完成路径 · 中断上下文]
nvme_irq                           — drivers/nvme/host/pci.c:1862
└─ nvme_poll_cq                    — drivers/nvme/host/pci.c:1841
   └─ nvme_handle_cqe              — drivers/nvme/host/pci.c:1789
      └─ nvme_pci_complete_rq      — drivers/nvme/host/pci.c:1754
         └─ nvme_complete_rq       — drivers/nvme/host/core.c:513
            └─ blk_mq_end_request  — block/blk-mq.c:1165
               └─ bio_endio        — block/bio.c:1863
```

> 注:提交路径省略了 page cache / ext4 等中间层(见《read 到块层》一文);这里聚焦进入 NVMe 驱动后的主干。

## 第一阶段:VFS 与页缓存

`vfs_read` 先看文件类型与是否命中页缓存。命中则直接从 page cache 拷贝到用户空间,根本不会到块层;只有缺页/未命中时,才会创建 bio 并提交。也就是说,**"读文件"不一定产生 NVMe IO**。

## 第二阶段:块层与 blk-mq

`submit_bio_noacct` 把 bio 交给块层,`blk_mq_submit_bio` 从标签集分配 request、选择合适的硬件队列,然后调用驱动的 `queue_rq`。这里完成了从"字节流"到"块设备请求"的转换。

## 第三阶段:NVMe 提交

`nvme_queue_rq` 是 NVMe 驱动的提交入口:

1. `nvme_setup_cmd` 按 `req_op` 填充 64 字节 SQE(RW 命令还会填 LBA/长度等字段)
2. `nvme_sq_copy_cmd` 把 SQE 拷贝到主机内存的提交队列
3. `nvme_write_sq_db` 写 SQ tail doorbell,通知控制器有新命令

门铃是 MMIO 写,控制器通过 DMA 读取 SQE,执行命令后把完成项写入 CQ,并触发 MSI-X 中断。

## 第四阶段:完成回收

中断处理 `nvme_irq` → `nvme_poll_cq` 遍历 CQ,`nvme_handle_cqe` 用 `command_id` 找回 request,再经 `nvme_pci_complete_rq` / `nvme_complete_rq` 进入块层完成路径,`blk_mq_end_request` 结束请求,`bio_endio` 通知上层。对于 buffered read,页缓存被填充后唤醒等待的进程。

## 三个容易忽略的细节

- **批量提交**:`nvme_submit_cmds` 可以合并多条命令后只敲一次门铃,减少 MMIO 次数
- **轮询模式**:poll queue 不走中断,由 `nvme_poll` 主动收割 CQE
- **io_uring 透传**:`uring_cmd` 绕过普通 read 的 VFS/页缓存语义,直接把 NVMe 命令下发;它不是这条路径的替代品,而是另一条专用通道

## 相关图示

- [NVMe IO 深度调用链]({{ '/linux-arch-dia/NVMe驱动/deep-nvme-io.html' | relative_url }})
- [用户态完整 I/O 路径]({{ '/linux-arch-dia/NVMe驱动/nvme-io-path.html' | relative_url }})
- [SQ/CQ 队列对与门铃]({{ '/linux-arch-dia/NVMe驱动/nvme-queue-doorbell.html' | relative_url }})
- [块层 IO 深度调用链]({{ '/linux-arch-dia/设备驱动/deep-block-io.html' | relative_url }})

> 源码基线:Linux `d487237`(v7.4.0-rc1)。行号会随内核版本漂移,以图集仓库重新 finalize 后的结果为准。
