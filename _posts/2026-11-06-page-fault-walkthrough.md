---
layout: post
title: "一次缺页异常都经历了什么:从 exc_page_fault 到具体页处理"
date: 2026-11-06
categories: [kernel-deep]
description: 缺页异常的分层入口、页表遍历与匿名页/文件页/COW/swap 分支
---
[打开可交互深度调用链]({{ '/linux-arch-dia/内存管理/deep-page-fault.html' | relative_url }})

缺页异常是内存管理最直观的入口:一次访问触发异常,内核判断这是"合法的按需分配"还是"非法访问",然后走不同分支。理解它的关键不是记住所有函数,而是看清**分层判断**与**分支归属**。

## 全景调用链

```text
exc_page_fault             arch/x86/mm/fault.c:1492
  handle_page_fault        arch/x86/mm/fault.c:1471
    do_user_addr_fault     arch/x86/mm/fault.c:1216   (用户态分支)
      lock_mm_and_find_vma mm/mmap_lock.c:623
      handle_mm_fault      mm/memory.c:6949
        __handle_mm_fault  mm/memory.c:6714
          handle_pte_fault mm/memory.c:6621
            do_pte_missing mm/memory.c:4561   (PTE 为空)
              do_anonymous_page  mm/memory.c:5287
              do_fault          mm/memory.c:5964
            do_swap_page    mm/memory.c:4747
            do_numa_page    mm/memory.c:6109
            do_wp_page      mm/memory.c:4244
```

## 三层入口

1. **异常入口**:`exc_page_fault` 是 x86 的 IDT 入口,拿到出错地址与错误码。
2. **地址分类**:`handle_page_fault` / `do_user_addr_fault` 判断是用户地址还是内核地址、是否在合法 VMA 内。非法访问在这里直接 `SIGSEGV`。
3. **页表处理**:进入 `handle_mm_fault` 后,逐级检查 PUD/PMD/PTE,最终由 `handle_pte_fault` 决定具体分支。

## 四个关键分支

**PTE 为空 → do_pte_missing**

- 匿名映射:`do_anonymous_page` 分配零页或新页,填充 PTE
- 文件映射:`do_fault` → `do_read_fault` / `do_cow_fault` / `do_shared_fault`,必要时 `__do_fault` 调 `filemap_fault` 从 page cache/磁盘读入

**PTE 存在但页在 swap → do_swap_page**

把页从 swap 换入,恢复 PTE;共享匿名页还要处理换入后的映射关系。

**PTE 存在但只读、写入触发 → do_wp_page**

写时复制:为当前进程复制一份新页,更新 PTE 为可写,原页引用计数减一。

**NUMA 保护页 → do_numa_page**

NUMA balancing 产生的保护页,根据访问位置决定是否迁移。

## 容易混淆的点

- **缺页不等于错误**:大部分缺页是正常的按需分配或 COW。
- **文件页与匿名页在 PTE 为空时走同一个入口**,但后续分支完全不同。
- **`mmap_lock` 的获取在 VMA 查找阶段**,不是在整个缺页处理期间一直持有。

## 相关图示

- [缺页异常深度调用链]({{ '/linux-arch-dia/内存管理/deep-page-fault.html' | relative_url }})
- [缺页异常流程图]({{ '/linux-arch-dia/内存管理/page-fault-flow.html' | relative_url }})
- [伙伴系统]({{ '/linux-arch-dia/内存管理/buddy-allocator.html' | relative_url }}) · [页回收]({{ '/linux-arch-dia/内存管理/page-reclaim.html' | relative_url }})

> 源码基线:Linux `d487237`(v7.4.0-rc1)。行号会随内核版本漂移,以图集仓库重新 finalize 后的结果为准。
