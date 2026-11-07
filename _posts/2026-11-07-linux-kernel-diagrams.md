---
layout: post
title: "Linux 内核原理图解(Archify 交互图集)"
date: 2026-11-07
categories: [linux]
description: 52 张可交互的 Linux 内核原理图与逐函数调用链
---
[Linux 内核原理图解](https://github.com/zhang-ruyi/linux-arch-dia) 用 Archify 对 Linux 内核源码(v7.4.0-rc1)做了系统化整理,包含:

- 52 张可交互原理图:进程管理、内存管理、网络协议栈、文件系统、设备驱动、NVMe、内核驱动框架、存储与异步 IO、并发与同步
- 每张概览图附「完整调用链(源码核实)」卡片,逐函数标注 `path:line`
- 7 张函数级深度调用链:fork、缺页异常、TCP 收包、open、read、块层 IO、NVMe IO

[打开交互图集]({{ '/linux-arch-dia/' | relative_url }})
