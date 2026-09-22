"""把文案渲染成 3:4 卡片图（抖音 / 快手 / 小红书没有纯文字帖，最少要一张图）。

用 patchright（Playwright 同源）的 Chromium 截一段 HTML：Windows 自带微软雅黑，字体不用另装。
正文长了自动拆成多张（每张约 MAX_CHARS 字），小红书 / 抖音图文本来就支持多图。
"""
from __future__ import annotations

import html
import re
from pathlib import Path

from patchright.sync_api import sync_playwright

W, H = 1080, 1440
MAX_CHARS = 230
MAX_CARDS = 4

TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;padding:0}}
body{{width:{w}px;height:{h}px;background:linear-gradient(160deg,#ff5f8f 0%,#ff8fb0 55%,#ffd1dd 100%);
  font-family:"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif;position:relative;overflow:hidden}}
.blob{{position:absolute;border-radius:50%;background:rgba(255,255,255,.18)}}
.card{{position:absolute;left:72px;top:{top}px;width:{cw}px;background:#fff;border-radius:40px;padding:72px 72px 64px;
  box-shadow:0 30px 80px rgba(120,20,50,.25);box-sizing:border-box}}
.title{{font-size:{ts}px;font-weight:700;color:#1b1b1f;line-height:1.35;margin:0 0 34px;letter-spacing:.5px}}
.body{{font-size:{fs}px;color:#2b2b30;line-height:1.75;letter-spacing:.3px;word-break:break-all}}
.body p{{margin:0 0 {pm}px}}
.body p:last-child{{margin-bottom:0}}
.quote{{position:absolute;left:72px;top:{qtop}px;font-size:120px;color:rgba(255,255,255,.6);font-family:Georgia,serif;line-height:1}}
.foot{{position:absolute;left:0;right:0;bottom:64px;text-align:center;color:#fff}}
.brand{{font-size:34px;font-weight:700;letter-spacing:2px;text-shadow:0 2px 10px rgba(0,0,0,.15)}}
.slogan{{font-size:30px;font-weight:600;letter-spacing:3px;opacity:.95;margin-top:10px;text-shadow:0 2px 10px rgba(0,0,0,.15)}}
.brand:empty,.slogan:empty{{display:none}}
.page{{position:absolute;right:80px;top:56px;color:rgba(255,255,255,.85);font-size:26px;letter-spacing:2px}}
</style></head><body>
<div class="blob" style="width:420px;height:420px;right:-140px;top:-160px"></div>
<div class="blob" style="width:260px;height:260px;left:-90px;bottom:180px"></div>
<div class="quote">&ldquo;</div>
{page}
<div class="card">{title}<div class="body">{body}</div></div>
<div class="foot"><div class="brand">{brand}</div><div class="slogan">{slogan}</div></div>
</body></html>"""


def split_content(content: str, max_chars: int = MAX_CHARS) -> list[str]:
    """按段落切成几张卡片的文字；一段太长就按句子切。"""
    paras = [p.strip() for p in re.split(r"\n\s*\n|\n", content) if p.strip()]
    chunks: list[str] = []
    cur = ""
    for p in paras:
        pieces = [p] if len(p) <= max_chars else re.findall(r"[^。！？!?；;]+[。！？!?；;]?", p)
        for piece in pieces:
            if len(cur) + len(piece) + 1 > max_chars and cur:
                chunks.append(cur)
                cur = piece
            else:
                cur = f"{cur}\n{piece}" if cur else piece
    if cur:
        chunks.append(cur)
    if len(chunks) > MAX_CARDS:
        # 超出的并进最后一张（会稍挤）
        chunks = chunks[: MAX_CARDS - 1] + ["\n".join(chunks[MAX_CARDS - 1 :])]
    return chunks or [content]


def _font_size(n: int) -> tuple[int, int]:
    if n <= 90:
        return 46, 30
    if n <= 160:
        return 40, 26
    if n <= 230:
        return 36, 22
    return 32, 18


def render_cards(out_dir: Path, name: str, title: str, content: str, brand: str, slogan: str, headless: bool = True) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    chunks = split_content(content)
    paths: list[Path] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        for i, chunk in enumerate(chunks):
            fs, pm = _font_size(len(chunk))
            body = "".join(f"<p>{html.escape(line)}</p>" for line in chunk.split("\n") if line.strip())
            show_title = title if (i == 0 and title) else ""
            page_tag = f'<div class="page">{i + 1} / {len(chunks)}</div>' if len(chunks) > 1 else ""
            doc = TEMPLATE.format(
                w=W, h=H, top=200, cw=W - 144, ts=52, fs=fs, pm=pm, qtop=110,
                title=f'<div class="title">{html.escape(show_title)}</div>' if show_title else "",
                body=body, brand=html.escape(brand), slogan=html.escape(slogan), page=page_tag,
            )
            page.set_content(doc, wait_until="load")
            # 卡片超高时缩小字号再来一次（最多两次）
            for _ in range(2):
                bottom = page.evaluate("document.querySelector('.card').getBoundingClientRect().bottom")
                if bottom <= H - 200:
                    break
                fs = max(26, fs - 4)
                doc = TEMPLATE.format(
                    w=W, h=H, top=200, cw=W - 144, ts=48, fs=fs, pm=max(12, pm - 4), qtop=110,
                    title=f'<div class="title">{html.escape(show_title)}</div>' if show_title else "",
                    body=body, brand=html.escape(brand), slogan=html.escape(slogan), page=page_tag,
                )
                page.set_content(doc, wait_until="load")
            out = out_dir / f"{name}-{i + 1}.png"
            page.screenshot(path=str(out), full_page=False, type="png")
            paths.append(out)
        browser.close()
    return paths
