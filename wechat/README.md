# 公众号版

两种发布方式,任选其一:

## 方式一:原生 HTML(无图片,推荐先试)

`html/` 下是内联样式的 HTML,可直接粘贴到公众号编辑器:

1. 浏览器打开 `wechat/html/<文章>.html`
2. 全选正文(或 Ctrl+A / Cmd+A)→ 复制
3. 粘贴到公众号编辑器 → 预览

说明:

- 微信会剥离 class、`<style>`、JS、iframe,所以这里所有样式都写在 `style="..."` 里
- 图表用**表格/块**表达,不依赖 CSS grid/flex,保证微信可渲染
- 无图片、无外链资源;公众号正文外链默认不可点击,文末链接会以文本显示
- 微信编辑器可能对边框/背景做少量规范化,以预览为准

## 方式二:Markdown(用第三方排版工具)

`wechat/*.md` 是 Markdown 版,可用 [mdnice](https://mdnice.com/) 或 [doocs/md](https://github.com/doocs/md) 渲染后复制到公众号。

## 方式三:图片版(需要 100% 还原 Web 时)

图片不是本仓库默认产物。若需要与网页完全一致,可用无头 Chrome 按小节渲染成图片后上传:

- 文字和图表一起截图,深/浅两套主题
- 微信按顺序上传图片即可,但正文文字不可选中/搜索

## 重新生成 HTML

```bash
python3 wechat/build_html.py
```

源文件是 `wechat/*.md`,输出到 `wechat/html/`。
