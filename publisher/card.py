"""把文案渲染成 3:4 卡片图（抖音 / 快手 / 小红书没有纯文字帖，最少要一张图）。

用 patchright（Playwright 同源）的 Chromium 截一段 HTML：Windows 自带微软雅黑，字体不用另装。
分页按**实际排版高度**算（不是按字数——十几行短句字数少但很高，按字数会把底部标语压住）：
把剩下的段落全塞进卡片渲染一次，读每个 <p> 的底边，只保留落在底线之上的那几段，剩下的下一张接着；小红书 / 抖音图文本来就支持多图。
"""
from __future__ import annotations

import html
import re
from pathlib import Path

from patchright.sync_api import sync_playwright

W, H = 1080, 1440
MAX_CARDS = 6
CARD_TOP = 200
# 卡片底边不能超过这条线（底部标语 bottom:64px + 一行高度，再留一点呼吸）
LIMIT = H - 200
# 一段最多多少字（再长按句子拆，避免一段就撑满一张）
MAX_PARA = 160

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


def _paragraphs(content: str) -> list[str]:
    """按行拆段；一段太长按句子再拆"""
    out: list[str] = []
    for p in (s.strip() for s in re.split(r"\n\s*\n|\n", content)):
        if not p:
            continue
        if len(p) <= MAX_PARA:
            out.append(p)
            continue
        cur = ""
        for piece in re.findall(r"[^。！？!?；;]+[。！？!?；;]?", p):
            if len(cur) + len(piece) > MAX_PARA and cur:
                out.append(cur)
                cur = piece
            else:
                cur += piece
        if cur:
            out.append(cur)
    return out or [content.strip()]


def _font_for(paras: list[str]) -> tuple[int, int]:
    """字号 / 段距：字少行少就放大一点，好看；行多就用标准字号"""
    n = sum(len(p) for p in paras)
    lines = len(paras)
    if n <= 90 and lines <= 5:
        return 46, 30
    if n <= 160 and lines <= 8:
        return 40, 26
    return 36, 22


def _doc(paras: list[str], title: str, fs: int, pm: int, brand: str, slogan: str, page_tag: str) -> str:
    body = "".join(f"<p>{html.escape(p)}</p>" for p in paras)
    return TEMPLATE.format(
        w=W, h=H, top=CARD_TOP, cw=W - 144, ts=52 if fs >= 40 else 48, fs=fs, pm=pm, qtop=110,
        title=f'<div class="title">{html.escape(title)}</div>' if title else "",
        body=body, brand=html.escape(brand), slogan=html.escape(slogan), page=page_tag,
    )


def render_cards(out_dir: Path, name: str, title: str, content: str, brand: str, slogan: str, headless: bool = True) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    remaining = _paragraphs(content)
    paths: list[Path] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)

        # 第一遍：按标准字号分页（每张先把剩余全部放进去量一次，取放得下的那几段）
        pages: list[list[str]] = []
        while remaining and len(pages) < MAX_CARDS:
            first = not pages
            page.set_content(_doc(remaining, title if first else "", 36, 22, brand, slogan, ""), wait_until="load")
            bottoms: list[float] = page.evaluate(
                "Array.from(document.querySelectorAll('.body p')).map(e => e.getBoundingClientRect().bottom)"
            )
            card_pad_bottom = 64
            fit = sum(1 for b in bottoms if b + card_pad_bottom <= LIMIT)
            if fit == 0:
                fit = 1  # 一段就放不下：硬放，第二遍会缩字号
            if len(pages) == MAX_CARDS - 1:
                fit = len(remaining)  # 最后一张兜底全放，第二遍缩字号
            pages.append(remaining[:fit])
            remaining = remaining[fit:]

        # 第二遍：逐张出图；字少的放大字号，放不下再缩
        for i, paras in enumerate(pages):
            fs, pm = _font_for(paras)
            show_title = title if i == 0 else ""
            page_tag = f'<div class="page">{i + 1} / {len(pages)}</div>' if len(pages) > 1 else ""
            for _ in range(6):
                page.set_content(_doc(paras, show_title, fs, pm, brand, slogan, page_tag), wait_until="load")
                bottom = page.evaluate("document.querySelector('.card').getBoundingClientRect().bottom")
                if bottom <= LIMIT or fs <= 24:
                    break
                fs -= 3
                pm = max(10, pm - 3)
            out = out_dir / f"{name}-{i + 1}.png"
            page.screenshot(path=str(out), full_page=False, type="png")
            paths.append(out)
        browser.close()
    return paths


