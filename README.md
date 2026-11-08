# ruy · Linux 与 LLM 推理笔记

个人技术博客,记录 **Linux 内核 / IO 栈 / 存储** 与 **LLM 推理(vLLM、LMCache)** 的架构、时序和源码细节。文章尽量配可交互原理图或数据视图图,关键符号标注 `path:line`。

- 博客:https://zhang-ruyi.github.io/ruy/
- 图集总览:https://zhang-ruyi.github.io/ruy/diagrams/
- Linux 内核图集:https://zhang-ruyi.github.io/ruy/linux-arch-dia/
- LLM 推理图集:https://zhang-ruyi.github.io/ruy/llm-arch-dia/
- 内核精读:https://zhang-ruyi.github.io/ruy/reading/

## 内容

| 板块 | 说明 |
|---|---|
| Linux 内核图集 | 58 张交互图:进程、内存、网络、文件系统、块层、NVMe、驱动框架、并发、总览;含 7 张函数级深度链 |
| LLM 推理图集 | 7 张: vLLM 架构/请求生命周期/PagedAttention、LMCache 架构/KV 流、联合链路、超长会话 |
| 内核精读 | fork、缺页、NVMe IO、io_uring、驱动框架、memblock→folio、ext4、VFS、RCU 等长文 |
| 公众号版 | `wechat/` 下的 Markdown 版(表格化,适配微信编辑器) |

## 目录结构

```text
.
├── _config.yml               # Jekyll 配置(baseurl: /ruy)
├── _layouts/                 # default / post 布局
├── _data/                    # 首页统计、专栏配置
├── _posts/                   # 文章(Markdown)
├── assets/                   # CSS / JS(含自研 diagram 组件)
├── diagrams/                 # 图集总览页
├── reading/                  # 内核精读首页
├── wechat/                   # 公众号版 Markdown
├── subprojects/
│   ├── linux-arch-dia/       # Linux 内核图集(submodule)
│   └── llm-arch-dia/         # LLM 推理图集(submodule)
└── .github/workflows/pages.yml
```

## 本地预览

```bash
git clone --recurse-submodules git@github.com:zhang-ruyi/ruy.git
cd ruy
```

把两个子图集产物放到站点对应目录(CI 里也是这么做的):

```bash
rm -rf linux-arch-dia llm-arch-dia
cp -r subprojects/linux-arch-dia/site linux-arch-dia
cp -r subprojects/llm-arch-dia/site llm-arch-dia
```

用 Docker 跑 Jekyll:

```bash
docker run --rm -it -v "$PWD":/srv/jekyll -p 4000:4000 \
  jekyll/jekyll:4 jekyll serve --host 0.0.0.0
# 打开 http://localhost:4000/ruy/
```

或使用本机 Ruby/Jekyll:`bundle install && bundle exec jekyll serve`。

## 部署

`.github/workflows/pages.yml` 会在 push 到 `main` 时:

1. 递归检出两个 submodule
2. 把 `submodules/*/site/` 复制到站点目录 `linux-arch-dia/`、`llm-arch-dia/`
3. Jekyll 构建 `_site`
4. 发布到 GitHub Pages

Pages 的 Source 需设置为 **GitHub Actions**。

## 写新文章

在 `_posts/` 新建 `YYYY-MM-DD-slug.md`:

```markdown
---
layout: post
title: "文章标题"
date: 2026-11-20
categories: [linux]   # 或 ai-inference / kernel-deep
description: "一句话摘要"
---
正文……
```

- `categories` 对应首页专栏:`linux`(Linux 深度解读)、`ai-inference`(AI 推理)、`kernel-deep`(内核精读)、storage、ai-native-os
- 可交互图来自两个子图集;文章里用 `/linux-arch-dia/...`、`/llm-arch-dia/...` 链接或 iframe
- 自研数据视图组件(无需外部依赖):`.dataflow`、`.journey`、`.io-box`、`.layout-map`、`.tree-map`,样式在 `assets/css/style.css`

## 更新图集

图集在独立仓库中维护。更新后 bump 子模块:

```bash
cd subprojects/linux-arch-dia && git pull && cd ../..
git add subprojects/linux-arch-dia && git commit -m "Bump kernel atlas" && git push
```

LLM 图集同理(`subprojects/llm-arch-dia`)。也可以在 `pages.yml` 里去掉
`git submodule update --remote` 的注释,让构建自动跟随远端 `main`。

## 公众号版

`wechat/` 下是两篇长文的微信适配版(Markdown,已把 CSS 图改成表格):

- `wechat/2026-11-17-vllm-lmcache-long-session.md`
- `wechat/2026-11-18-io-data-journey.md`

推荐流程:用 [mdnice](https://mdnice.com/) 或 [doocs/md](https://github.com/doocs/md) 打开 Markdown →
选主题 → 复制预览 → 粘贴到公众号编辑器。若想配图,可从对应网页截图后插入;纯表格版不依赖图片也能完整表达。

## 版权与使用限制

Copyright © 2026 zhang-ruyi (Ruyi.zhang). All rights reserved.

- **未经作者书面许可,请勿将本站内容(文章、图表、图源、脚本)用于任何商业用途。**
- **未经作者书面许可,请勿直接转载、复制或再发布本站内容。**
- 个人学习、研究、教学等非商业性使用,须保留本版权声明并注明来源(站点地址与提交版本)。
- 商业授权、转载授权请联系:www.zhangyi.studio@gmail.com
- Linux 内核源码遵循其各自许可(主要为 GPL-2.0);本站仅包含分析整理与图示,不包含内核源码副本。
