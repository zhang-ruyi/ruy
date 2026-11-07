---
layout: post
title: "一次缺页异常都经历了什么:从 exc_page_fault 到具体页处理"
date: 2026-11-06
categories: [kernel-deep]
description: 缺页异常的分层入口、错误码、VMA 查找、页表遍历与匿名页/文件页/COW/swap 分支
---
内核精读 · 内存管理 · 源码基线 v7.4.0-rc1

缺页异常是内存管理最直观的入口:一次访问触发异常,内核判断这是"合法的按需分配"还是"非法访问",然后走不同分支。理解它的关键不是记住所有函数,而是看清**分层判断**与**分支归属**。本文按"入口 → 地址校验 → 页表遍历 → 具体分支"四层展开,并给出错误码、数据结构与观测方法。


## 一、全景:一次缺页的四层结构

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/内存管理/deep-page-fault.html' | relative_url }}" loading="lazy" title="缺页异常深度调用链"></iframe>
  <figcaption>图 1:缺页异常的函数级调用链(分支可交互展开)。</figcaption>
</figure>

```text
exc_page_fault                   — arch/x86/mm/fault.c:1492
└─ handle_page_fault             — arch/x86/mm/fault.c:1471
   └─ do_user_addr_fault         — arch/x86/mm/fault.c:1216(用户态分支)
      ├─ lock_mm_and_find_vma    — mm/mmap_lock.c:623
      └─ handle_mm_fault         — mm/memory.c:6949
         └─ __handle_mm_fault    — mm/memory.c:6714
            └─ handle_pte_fault  — mm/memory.c:6621
               ├─ do_pte_missing — mm/memory.c:4773(PTE 为空)
               │  ├─ do_anonymous_page — mm/memory.c:5539(匿名映射)
               │  └─ do_fault          — mm/memory.c:6216(文件映射)
               │     ├─ do_read_fault   — mm/memory.c:6092
               │     ├─ do_cow_fault    — mm/memory.c:6124
               │     └─ do_shared_fault — mm/memory.c:6166
               ├─ do_swap_page   — mm/memory.c:4987(swap 项)
               ├─ do_numa_page   — mm/memory.c:6395(NUMA 保护页)
               └─ do_wp_page     — mm/memory.c:4458(写只读页/COW)
```

这四层分别是:

1. **异常入口**:拿到出错地址与错误码
2. **地址分类**:判断用户/内核、是否在合法 VMA 内
3. **页表遍历**:逐级检查 PGD/P4D/PUD/PMD/PTE,处理 THP
4. **具体处理**:按 PTE 状态分发到匿名页、文件页、swap、COW、NUMA

## 二、异常入口:CR2 与错误码

x86 的缺页异常入口是 `exc_page_fault`(`arch/x86/mm/fault.c:1492`),出错地址来自 `CR2`(或 FRED 事件数据):

```c
address = cpu_feature_enabled(X86_FEATURE_FRED) ? fred_event_data(regs) : read_cr2();
...
if (kvm_handle_async_pf(regs, (u32)address))
        return;
```

错误码不是"错误原因字符串",而是一组位。理解位图比记函数名更重要:

| 位 | 名称 | 含义 |
|---|---|---|
| 0 | `X86_PF_PROT` | 0=页不存在,1=保护违规 |
| 1 | `X86_PF_WRITE` | 0=读,1=写 |
| 2 | `X86_PF_USER` | 0=内核态,1=用户态 |
| 3 | `X86_PF_RSVD` | 使用了保留位 |
| 4 | `X86_PF_INSTR` | 取指缺页 |
| 5 | `X86_PF_PK` | protection key 阻止访问 |
| 6 | `X86_PF_SHSTK` | shadow stack 访问违例 |

这些位在 `arch/x86/include/asm/trap_pf.h` 中定义,最终会转换成内核的 `FAULT_FLAG_*`:

```c
perf_sw_event(PERF_COUNT_SW_PAGE_FAULTS, 1, regs, address);

if (error_code & X86_PF_SHSTK)
        flags |= FAULT_FLAG_WRITE;
if (error_code & X86_PF_WRITE)
        flags |= FAULT_FLAG_WRITE;
if (error_code & X86_PF_INSTR)
        flags |= FAULT_FLAG_INSTRUCTION;
if (user_mode(regs))
        flags |= FAULT_FLAG_USER;
```

注意:即使发生在内核态,只要访问的是用户地址,`FAULT_FLAG_USER` 仍可能被设置(取决于寄存器状态),这会影响 OOM 处理与 `mmap_lock` 的获取方式。

## 三、地址校验:VMA 与 mmap_lock

`do_user_addr_fault` 在进入页表处理前做一系列校验:

- 内核态取指用户内存、保留位被置位、SMAP 违规 → 直接 `oops`
- 中断上下文/禁用缺页/没有 `mm` → `bad_area_nosemaphore`
- 用 `lock_mm_and_find_vma` 在 `mmap_lock` 保护下找到 VMA

找不到 VMA 或权限不匹配(`arch_vma_access_permitted`)会返回 `VM_FAULT_SIGSEGV`,最终给用户态 `SIGSEGV`。这一步区分了"合法的按需分配"与"真的越界"。

`FAULT_FLAG_*` 的常见取值(`include/linux/mm_types.h:1847-1857`):

| 标志 | 含义 |
|---|---|
| `FAULT_FLAG_WRITE` | 写缺页 |
| `FAULT_FLAG_USER` | 来自用户态 |
| `FAULT_FLAG_REMOTE` | 非当前进程/`mm` |
| `FAULT_FLAG_INSTRUCTION` | 取指缺页 |
| `FAULT_FLAG_UNSHARE` | 只解除共享,不写(用于 COW 判定) |

## 四、页表遍历与 THP

`handle_mm_fault` 先处理 hugetlb,再进入通用路径(`mm/memory.c:6949`):

```c
if (unlikely(vma_is_hugetlb(vma)))
        ret = hugetlb_fault(vma->vm_mm, vma, address, flags);
else
        ret = __handle_mm_fault(vma, address, flags);
```

`__handle_mm_fault` 从 PGD 开始逐级分配页表,并在每一级尝试透明大页(THP):

```c
pgd = pgd_offset(mm, address);
p4d = p4d_alloc(mm, pgd, address);
vmf.pud = pud_alloc(mm, p4d, address);
...
if (pud_none(*vmf.pud) && thp_vma_allowable_order(vma, vm_flags, TVA_PAGEFAULT, PUD_ORDER))
        ret = create_huge_pud(&vmf);
...
vmf.pmd = pmd_alloc(mm, vmf.pud, address);
if (pmd_none(*vmf.pmd) && thp_vma_allowable_order(vma, vm_flags, TVA_PAGEFAULT, PMD_ORDER))
        ret = create_huge_pmd(&vmf);
```

如果 THP 失败,会返回 `VM_FAULT_FALLBACK` 并回退到 PTE 路径。这里也是"是否分配页表"的决策点:很多缺页在 PTE 为空之前就已经被 THP 满足了。

## 五、handle_pte_fault:四个出口

到达 PTE 层后,`handle_pte_fault`(`mm/memory.c:6621`)做的是**状态机分发**:

```c
if (!vmf->pte)
        return do_pte_missing(vmf);
if (!pte_present(vmf->orig_pte))
        return do_swap_page(vmf);
if (pte_protnone(vmf->orig_pte) && vma_is_accessible(vmf->vma))
        return do_numa_page(vmf);
...
if (vmf->flags & (FAULT_FLAG_WRITE|FAULT_FLAG_UNSHARE)) {
        if (!pte_write(entry))
                return do_wp_page(vmf);
        ...
}
```

可以整理成一张判定表:

| PTE 状态 | 条件 | 处理函数 |
|---|---|---|
| 不存在 | `pte_none` | `do_pte_missing` |
| 不在内存 | swap 项 | `do_swap_page` |
| 存在但 PROT_NONE | NUMA hint | `do_numa_page` |
| 存在但只读 + 写/unshare | COW | `do_wp_page` |
| 存在且可写 | 只需建 dirty/young | 直接完成 |

注意 `do_numa_page` 只在 `pte_protnone` 且 VMA 可访问时触发;userfaultfd 的 RWP 保护页有额外的判定。

## 六、匿名页:do_anonymous_page

匿名映射(堆、栈、`MAP_ANONYMOUS`)的 PTE 为空时进入 `do_anonymous_page`(`mm/memory.c:5539`)。它有一个重要优化:**读缺页直接映射零页**:

```c
if (!(vmf->flags & FAULT_FLAG_WRITE) && !mm_forbids_zeropage(vma->vm_mm)) {
        entry = pte_mkspecial(pfn_pte(zero_pfn(vmf->address), vma->vm_page_prot));
        ...
        set_pte_at(vma->vm_mm, addr, vmf->pte, entry);
        update_mmu_cache(vma, addr, vmf->pte);
        goto unlock;
}

ret = vmf_anon_prepare(vmf);
folio = alloc_anon_folio(vmf);
```

- 只读缺页:多个进程可以共享同一个全零物理页,直到有人写入
- 写缺页:`alloc_anon_folio` 分配真实页,清零后建立映射
- userfaultfd:可在建映射前把事件交给用户态处理

这一分支是"读时零页、写时才分配"的来源,也是很多 `VmRSS` 统计看起来"没有增长"的原因。

## 七、文件页:do_fault 与 page cache

文件映射的 PTE 为空时进入 `do_fault`,再按映射类型分成:

| 分支 | 触发 | 行为 |
|---|---|---|
| `do_read_fault` | 读文件页 | 从 page cache 读入,建立只读 PTE |
| `do_cow_fault` | 私有可写映射 | 读入后按 COW 处理 |
| `do_shared_fault` | 共享映射写 | 走 `page_mkwrite`,可能触发回写 |

最终都会走到 `__do_fault` → `vma->vm_ops->fault`,对 ext4 就是 `filemap_fault`(`mm/filemap.c:3572`)。如果页不在 page cache,会触发 IO 并把页读入;`fault_around` 还会预读相邻页,减少后续缺页次数。

```text
私有文件映射读:
  PTE 为空 → do_fault → do_read_fault → __do_fault → filemap_fault
           → page cache 命中/读盘 → 建立只读 PTE
写入:
  → do_wp_page(COW) → 复制页 → 建立可写 PTE
```

## 八、COW:do_wp_page

`do_wp_page`(`mm/memory.c:4458`)处理"PTE 存在但只读,且当前是写/unshare"的情况。它的核心判断是:

- 如果该页是**独占**的(只有当前映射),可以直接升级为可写(`wp_page_reuse`)
- 如果被多个映射共享,需要 `wp_page_copy`:分配新页、复制内容、更新 PTE、减少旧页引用

COW 的正确性依赖三件事:

1. **页表锁**:防止并发缺页同时复制
2. **TLB flush**:旧 PTE 失效后不能继续访问旧页
3. **rmap 引用计数**:确认旧页何时可以真正释放

`do_wp_page` 还要处理 userfaultfd wp、KSM、swap cache、共享映射的 `page_mkwrite` 等特殊情况,所以它的代码比"复制一页"复杂得多。

## 九、swap 与 NUMA

- `do_swap_page`:PTE 不在内存但仍是 swap 项,需要把页换入;可能命中 swap cache,也可能触发 swap IO
- `do_numa_page`:NUMA balancing 留下的 PROT_NONE 页,根据访问位置决定是否迁移
- 大页:THP 的换入/换出路径与 4K 页不同,`do_swap_page` 里有专门的 large folio 处理

## 十、失败路径与信号

缺页处理失败最终会转换成信号或错误码:

| 返回/条件 | 结果 |
|---|---|
| `VM_FAULT_SIGSEGV` | 用户态 `SIGSEGV` |
| `VM_FAULT_SIGBUS` | 用户态 `SIGBUS`(如文件截断) |
| `VM_FAULT_OOM` | OOM 处理或返回错误 |
| `VM_FAULT_HWPOISON` | 内存硬件错误 |
| `VM_FAULT_RETRY` | 释放锁后重试 |

常见触发:

- 访问未映射地址 → `SIGSEGV`
- 映射了文件但访问超出文件末尾 → `SIGBUS`
- 匿名页分配失败且无法回收 → OOM
- `mlock` 超限、cgroup 内存限制、userfaultfd 未处理 → 相应错误

## 十一、观测与调试

```bash
# 缺页总数与 major fault
grep -E 'pgfault|pgmajfault' /proc/vmstat

# perf 统计
perf stat -e page-faults,minor-faults,major-faults -a sleep 5

# tracepoint(用户态/内核态缺页)
sudo perf trace -e exceptions:page_fault_user,exceptions:page_fault_kernel -a

# 观察某个进程的映射与缺页
cat /proc/<pid>/maps
cat /proc/<pid>/stat        # minflt / majflt
```

`minor` 缺页通常不需要 IO(零页、COW、page cache 命中);`major` 缺页需要 IO(读盘、swap in)。把两者分开看,才能判断是"分配/COW 开销"还是"IO 开销"。

## 十二、常见误解

- **"缺页就是错误"**:大部分缺页是正常按需分配/COW。
- **"匿名页读缺页会分配内存"**:读缺页通常映射零页。
- **"COW 只发生在 fork"**:私有文件映射、`mremap`、KSM 等也会触发。
- **"页表遍历一定到 PTE"**:THP 可能在 PUD/PMD 层就满足。
- **"mmap_lock 一直持有"**:部分路径会在缺页处理中释放并重试。

## 相关图示

- [缺页异常深度调用链]({{ '/linux-arch-dia/内存管理/deep-page-fault.html' | relative_url }})
- [缺页异常流程图]({{ '/linux-arch-dia/内存管理/page-fault-flow.html' | relative_url }})
- [伙伴系统]({{ '/linux-arch-dia/内存管理/buddy-allocator.html' | relative_url }})
- [页回收]({{ '/linux-arch-dia/内存管理/page-reclaim.html' | relative_url }})

> 源码基线:Linux `d487237`(v7.4.0-rc1)。行号会随内核版本漂移,以图集仓库重新 finalize 后的结果为准。
