---
layout: default
title: 首页
---
# {{ site.title }}

## 子项目

- [Linux 内核原理图解(Archify 交互图集)]({{ '/linux-arch-dia/' | relative_url }})

## 文章

{% for post in site.posts %}
- [{{ post.title }}]({{ post.url | relative_url }}) — {{ post.date | date: "%Y-%m-%d" }}
{% endfor %}
