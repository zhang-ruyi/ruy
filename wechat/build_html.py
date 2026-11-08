#!/usr/bin/env python3
"""把 wechat/*.md 转成微信可粘贴的内联样式 HTML(无图片/无外部 CSS)。"""
import html, re
from pathlib import Path

BASE = Path(__file__).parent
OUT = BASE / "html"

def inline(text):
    s = html.escape(text, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r'<code style="background:#eef3f9;border:1px solid #dbe2ea;padding:1px 5px;border-radius:4px;font-family:Menlo,Consolas,monospace;font-size:0.92em;color:#0b5cad;">\1</code>', s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2" style="color:#1a6fd0;text-decoration:none;">\1</a>', s)
    s = re.sub(r'(https?://[^\s<]+)', r'<span style="color:#1a6fd0;word-break:break-all;">\1</span>', s)
    return s

def blocks(lines):
    out = []
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            i += 1; continue
        if line.strip() == "---":
            out.append('<hr style="border:0;border-top:1px solid #dbe2ea;margin:24px 0;">'); i += 1; continue
        m = re.match(r"^(#{1,3})\s+(.*)$", line)
        if m:
            level = len(m.group(1)); text = inline(m.group(2))
            if level == 1:
                out.append(f'<h1 style="font-size:24px;line-height:1.35;color:#10202f;margin:8px 0 16px;font-weight:800;">{text}</h1>')
            elif level == 2:
                out.append(f'<h2 style="font-size:20px;line-height:1.4;color:#10202f;margin:30px 0 12px;padding-bottom:8px;border-bottom:1px solid #dbe2ea;font-weight:700;">{text}</h2>')
            else:
                out.append(f'<h3 style="font-size:17px;color:#10202f;margin:22px 0 10px;font-weight:700;">{text}</h3>')
            i += 1; continue
        if line.startswith(">"):
            buf = []
            while i < len(lines) and lines[i].startswith(">"):
                buf.append(lines[i].lstrip(">").strip()); i += 1
            out.append('<blockquote style="margin:14px 0;padding:10px 14px;border-left:3px solid #1a6fd0;background:#f2f6fb;color:#2c3e50;border-radius:0 6px 6px 0;">' + "<br>".join(inline(x) for x in buf) + "</blockquote>")
            continue
        if line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append(lines[i]); i += 1
            cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
            if len(cells) >= 2 and all(re.fullmatch(r":?-{2,}:?", c) for c in cells[1] if c):
                head = cells[0]; body = cells[2:]
                thead = "".join(f'<th style="border:1px solid #d9e0e8;padding:8px 10px;background:#eef3f9;text-align:left;font-weight:600;color:#10202f;">{inline(c)}</th>' for c in head)
                tbody = "".join('<tr>' + "".join(f'<td style="border:1px solid #d9e0e8;padding:8px 10px;vertical-align:top;color:#2c3e50;">{inline(c)}</td>' for c in row) + '</tr>' for row in body)
                out.append(f'<table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;line-height:1.6;"><thead><tr>{thead}</tr></thead><tbody>{tbody}</tbody></table>')
            else:
                out.append("<p>" + "<br>".join(inline(r) for r in rows) + "</p>")
            continue
        if re.match(r"^\s*[-*]\s+", line):
            items = []
            while i < len(lines) and re.match(r"^\s*[-*]\s+", lines[i]):
                items.append(re.sub(r"^\s*[-*]\s+", "", lines[i])); i += 1
            out.append('<ul style="margin:10px 0;padding-left:1.5em;color:#2c3e50;">' + "".join(f'<li style="margin:4px 0;">{inline(x)}</li>' for x in items) + "</ul>")
            continue
        buf = []
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,3}\s|>|\||\s*[-*]\s+|---$)", lines[i]):
            buf.append(lines[i].strip()); i += 1
        out.append(f'<p style="margin:12px 0;color:#2c3e50;">{inline(" ".join(buf))}</p>')
    return "\n".join(out)

def build(md):
    text = md.read_text(encoding="utf-8")
    # 去掉 markdown 标题: 用 H1,正文从 ## 开始
    body = blocks(text.splitlines())
    return f'''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>{html.escape(md.stem)}</title></head>
<body style="margin:0;background:#ffffff;">
<section style="max-width:720px;margin:0 auto;padding:28px 20px 40px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;font-size:16px;line-height:1.8;color:#1c2531;">
{body}
</section>
</body></html>'''

def main():
    OUT.mkdir(exist_ok=True)
    for md in sorted(BASE.glob("*.md")):
        if md.name.upper() == "README.MD":
            continue
        (OUT / (md.stem + ".html")).write_text(build(md), encoding="utf-8")
        print("built", OUT / (md.stem + ".html"))

if __name__ == "__main__":
    main()
