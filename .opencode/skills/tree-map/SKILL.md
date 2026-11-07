---
name: tree-map
description: 用 HTML/CSS 组件把对象包含关系、资源树、决策树、类/结构体层级画成可读的树形图,替代 ASCII 的 ├──/└──。Use when 文章需要展示 task_struct 资源树、VFS 对象关系、设备模型包含、并发原语选择等层级结构。
---

# Tree Map(层级/包含/决策树)

`layout-map` 解决"区间/块布局",`tree-map` 解决"父子层级":对象包含、资源树、决策分支、类/结构体关系。纯 HTML/CSS,无依赖。

不适用:带 `path:line` 的长调用链(保留代码块或 Archify 时序图/流程图),因为树形卡片会丢失对齐与可复制性。

## 组件用法

```html
<div class="tree-map" role="img" aria-label="task_struct 资源树">
  <div class="tree-map-head">
    <span class="tree-map-title">task_struct 资源树</span>
    <span class="tree-map-note">括号内为复制函数</span>
  </div>
  <ul>
    <li>
      <div class="tree-card tone-slate">
        <span class="tree-label">task_struct</span>
        <span class="tree-sub">进程控制块</span>
      </div>
      <ul>
        <li>
          <div class="tree-card tone-green">
            <span class="tree-label">mm / active_mm</span>
            <span class="tree-sub">地址空间 · dup_mm(COW)</span>
          </div>
        </li>
        <li>
          <div class="tree-card tone-blue">
            <span class="tree-label">files</span>
            <span class="tree-sub">打开文件表 · copy_files</span>
          </div>
        </li>
      </ul>
    </li>
  </ul>
</div>
```

## 色块与语义

- 使用 `tone-blue` / `tone-violet` / `tone-amber` / `tone-green` / `tone-slate` / `tone-rose` / `tone-teal` 作为左边框色。
- `tree-label` 放代码/结构体名(等宽);`tree-sub` 放中文解释或来源。
- 决策树:根节点写判断条件,子节点写"条件 → 结论"。
- 包含关系:父节点是容器,子节点是内嵌字段/对象。

## 写作规范

1. 只画**层级**,不要把线性调用链硬塞成树;调用链保留代码块或 Archify 图。
2. 图前给一句真实语义,图后解释"为什么这样包含/如何还原"。
3. `role="img"` + `aria-label`;不要只靠颜色传达语义。
4. 不要把大段 ASCII 的 ├── 留在正文;用组件替代。
5. 与 `layout-map` 配合:区间布局用 layout-map,层级结构用 tree-map。

## 样式

组件样式见本 skill 的 `assets/tree-map.css`;引入一次即可。
