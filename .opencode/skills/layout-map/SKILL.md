---
name: layout-map
description: 用 HTML/CSS 组件把磁盘块组、地址空间、内存布局等多段区间画成可读的布局图,替代 ASCII 文本。Use when 文章需要展示 block group、address space、offset ranges、队列/寄存器布局等"分段区间"示意。
---

# Layout Map(布局区间图)

Archify 没有"地址区间 / 块布局"类型,纯 ASCII 也不好看。本 skill 提供一个纯 HTML/CSS 的布局图组件,适合:

- 磁盘块组布局(ext4 block group、superblock/GDT/bitmap/inode table)
- 进程地址空间(text/data/heap/mmap/stack)
- 内存区域、页表层级、寄存器/MMIO 布局
- 队列、缓冲区、日志区域的区间划分

组件是**示意性**的(非按比例),必须在标题旁标注"示意,非按比例",精确布局以工具输出为准(`dumpe2fs`、`/proc/<pid>/maps` 等)。

## 组件用法

在 Markdown 中直接写 HTML:

```html
<div class="layout-map" role="img" aria-label="ext4 块组典型布局示意">
  <div class="layout-map-head">
    <span class="layout-map-title">一个块组的典型布局</span>
    <span class="layout-map-note">示意,非按比例</span>
  </div>
  <div class="layout-strip" aria-hidden="true">
    <span class="layout-seg kind-boot" style="--w:1" title="引导扇区/保留">boot</span>
    <span class="layout-seg kind-super" style="--w:2" title="superblock">super</span>
    <span class="layout-seg kind-gdt" style="--w:4" title="GDT">GDT</span>
    <span class="layout-seg kind-bitmap" style="--w:1" title="block bitmap">bb</span>
    <span class="layout-seg kind-bitmap" style="--w:1" title="inode bitmap">ib</span>
    <span class="layout-seg kind-inode" style="--w:8" title="inode table">inode table</span>
    <span class="layout-seg kind-data" style="--w:30" title="data blocks">data blocks</span>
  </div>
  <div class="layout-groups">
    <div class="layout-group">
      <div class="layout-group-name">块组 0</div>
      <div class="layout-row">
        <span class="layout-range">[0, 1024)</span>
        <span class="layout-block kind-boot"><span class="name">引导扇区 / 保留</span></span>
        <span class="layout-size">1 KiB</span>
      </div>
      <!-- 继续添加 .layout-row -->
    </div>
    <div class="layout-group">
      <div class="layout-group-name">块组 N</div>
      <!-- 副本用 is-copy 虚线 -->
      <div class="layout-row">
        <span class="layout-range">可能</span>
        <span class="layout-block kind-super is-copy"><span class="name">superblock 副本</span></span>
        <span class="layout-size">1 块</span>
      </div>
    </div>
  </div>
  <div class="layout-legend">
    <span><i class="kind-super"></i>superblock</span>
    <span><i class="kind-bitmap"></i>位图</span>
    <span><i class="kind-inode"></i>inode 表</span>
    <span><i class="kind-data"></i>数据块</span>
  </div>
</div>
```

## 颜色/语义类

| 类名 | 用途 |
|---|---|
| `kind-boot` | 引导/保留 |
| `kind-super` | superblock |
| `kind-gdt` | 组描述符/GDT |
| `kind-reserved` | 预留区 |
| `kind-bitmap` | 位图 |
| `kind-inode` | inode 表 |
| `kind-data` | 数据区 |
| `is-copy` | 副本/可能存在的区域(虚线) |
| `tone-blue` / `tone-violet` / `tone-amber` / `tone-green` / `tone-slate` / `tone-rose` / `tone-teal` | 非磁盘语义的通用色块(队列、寄存器、内存区等) |

可在 CSS 变量 `--kind` 上覆盖颜色;条带用 `style="--w:N"` 控制相对宽度。三列布局给 `.layout-groups` 加 `three` 类。

## 写作规范

1. 先给一句真实语义的说明,再放图;图后补充"为什么这样布局/内核如何定位"。
2. 必须标注"示意,非按比例";涉及 flex_bg、动态布局时明确说明"不能假设固定"。
3. `role="img"` + `aria-label` 提供无障碍描述;条带加 `aria-hidden="true"`。
4. 与 Archify 图配合:机制/调用链用 Archify,区间布局用 layout-map。
5. 不要把大段 ASCII 留在正文;用组件替代,保留必要的关键偏移文本。

## 样式

组件样式位于 `assets/css/style.css` 的 `/* ===== Layout map ===== */` 段。新页面无需额外依赖。
