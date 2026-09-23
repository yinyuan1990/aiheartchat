"""把文案渲染成 3:4 卡片图（抖音 / 快手 / 小红书没有纯文字帖，最少要一张图）。

用 patchright（Playwright 同源）的 Chromium 截一段 HTML：Windows 自带微软雅黑，字体不用另装。
分页按**实际排版高度**算（不是按字数——十几行短句字数少但很高，按字数会把底部标语压住）：
把剩下的段落全塞进卡片渲染一次，读每个 <p> 的底边，只保留落在底线之上的那几段，剩下的下一张接着；小红书 / 抖音图文本来就支持多图。
"""
from __future__ import annotations

import html
import re
from datetime import datetime
from pathlib import Path

from patchright.sync_api import sync_playwright

W, H = 1080, 1440
MAX_CARDS = 6
CARD_TOP = 200
# 卡片底边不能超过这条线（底部标语 bottom:64px + 一行高度，再留一点呼吸）
LIMIT = H - 200
# 一段最多多少字（再长按句子拆，避免一段就撑满一张）
MAX_PARA = 160

FONT_STACK = '-apple-system,"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif'

# 三套样式共用同一套结构：.card > (.meta?)(.title)(.body) + .foot；只有 CSS 和装饰不同
STYLES: dict[str, dict[str, str]] = {
    # 原来的玫红渐变（保留对比）
    "rose": {
        "css": """
body{background:linear-gradient(160deg,#ff5f8f 0%,#ff8fb0 55%,#ffd1dd 100%)}
.blob{position:absolute;border-radius:50%;background:rgba(255,255,255,.18)}
.card{background:#fff;border-radius:40px;padding:72px 72px 64px;box-shadow:0 30px 80px rgba(120,20,50,.25)}
.title{color:#1b1b1f;letter-spacing:.5px;margin:0 0 34px}
.body{color:#2b2b30;letter-spacing:.3px}
.quote{position:absolute;left:72px;top:110px;font-size:120px;color:rgba(255,255,255,.6);font-family:Georgia,serif;line-height:1}
.foot{color:#fff}
.slogan{font-size:30px;font-weight:600;letter-spacing:3px;text-shadow:0 2px 10px rgba(0,0,0,.15)}
.page{color:rgba(255,255,255,.85)}
""",
        "deco": '<div class="blob" style="width:420px;height:420px;right:-140px;top:-160px"></div><div class="blob" style="width:260px;height:260px;left:-90px;bottom:180px"></div><div class="quote">&ldquo;</div>',
        "meta": "",
    },
    # A：iOS 备忘录 —— 系统灰底、白卡、细分隔线、时间戳小字，克制
    "notes": {
        "css": """
body{background:#F2F2F7}
.card{background:#fff;border-radius:28px;padding:56px 64px 60px;box-shadow:0 2px 6px rgba(0,0,0,.04),0 18px 48px rgba(0,0,0,.07)}
.meta{font-size:26px;color:#8E8E93;letter-spacing:.5px;margin:0 0 22px;font-weight:500}
.title{color:#1C1C1E;letter-spacing:-.6px;margin:0 0 26px;padding-bottom:26px;border-bottom:1.5px solid #E5E5EA}
.body{color:#3A3A3C;letter-spacing:.2px}
.foot{color:#8E8E93}
.slogan{font-size:27px;font-weight:500;letter-spacing:1.5px}
.page{color:#AEAEB2}
""",
        "deco": "",
        "meta": '<div class="meta">{date}</div>',
    },
    # B：iOS 桌面毛玻璃 —— 淡彩网格渐变背景、半透明磨砂卡片、彩色小竖条、胶囊标语
    "glass": {
        "css": """
body{background:#EEF0FA;background-image:radial-gradient(60% 50% at 15% 10%,#CBD6FF 0%,transparent 60%),radial-gradient(55% 45% at 90% 20%,#FFD4E5 0%,transparent 60%),radial-gradient(60% 55% at 50% 100%,#FFF0C8 0%,transparent 65%),radial-gradient(45% 40% at 85% 85%,#D7F5E9 0%,transparent 60%)}
.card{background:rgba(255,255,255,.70);backdrop-filter:blur(30px);border:1.5px solid rgba(255,255,255,.75);border-radius:34px;padding:60px 64px 60px;box-shadow:0 24px 70px rgba(70,80,140,.14)}
.bar{width:12px;height:52px;border-radius:6px;background:linear-gradient(180deg,#FF6B8B,#FFA06B);margin:0 0 22px}
.title{color:#1C1C1E;letter-spacing:-.6px;margin:0 0 28px}
.body{color:#2C2C2E;letter-spacing:.2px}
.foot{color:#636366}
.slogan{display:inline-block;font-size:26px;font-weight:600;letter-spacing:1.5px;padding:14px 34px;border-radius:999px;background:rgba(255,255,255,.65);border:1px solid rgba(255,255,255,.9);box-shadow:0 8px 24px rgba(70,80,140,.10)}
.page{color:#8E8E93}
""",
        "deco": "",
        "meta": '<div class="bar"></div>',
    },
}

TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;padding:0}}
body{{width:{w}px;height:{h}px;font-family:{font};position:relative;overflow:hidden}}
.card{{position:absolute;left:72px;top:{top}px;width:{cw}px;box-sizing:border-box}}
.title{{font-size:{ts}px;font-weight:700;line-height:1.35}}
.body{{font-size:{fs}px;line-height:1.78;word-break:break-all}}
.body p{{margin:0 0 {pm}px}}
.body p:last-child{{margin-bottom:0}}
.foot{{position:absolute;left:0;right:0;bottom:64px;text-align:center}}
.slogan:empty{{display:none}}
.page{{position:absolute;right:80px;top:56px;font-size:26px;letter-spacing:2px}}
{style_css}
</style></head><body>
{deco}
{page}
<div class="card">{meta}{title}<div class="body">{body}</div></div>
<div class="foot"><div class="slogan">{slogan}</div></div>
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


def _doc(paras: list[str], title: str, fs: int, pm: int, slogan: str, page_tag: str, style: str, first: bool) -> str:
    st = STYLES.get(style, STYLES["notes"])
    body = "".join(f"<p>{html.escape(p)}</p>" for p in paras)
    now = datetime.now()
    meta = st["meta"].format(date=f"{now.month}月{now.day}日 {now:%H:%M}") if first else ""
    return TEMPLATE.format(
        w=W, h=H, top=CARD_TOP, cw=W - 144, ts=52 if fs >= 40 else 48, fs=fs, pm=pm, font=FONT_STACK,
        title=f'<div class="title">{html.escape(title)}</div>' if title else "",
        body=body, slogan=html.escape(slogan), page=page_tag, style_css=st["css"], deco=st["deco"], meta=meta,
    )


def render_cards(out_dir: Path, name: str, title: str, content: str, brand: str, slogan: str, headless: bool = True, style: str = "notes") -> list[Path]:
    """brand 参数保留兼容（现在不印品牌）；style = rose | notes | glass"""
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
            page.set_content(_doc(remaining, title if first else "", 36, 22, slogan, "", style, first), wait_until="load")
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
                page.set_content(_doc(paras, show_title, fs, pm, slogan, page_tag, style, i == 0), wait_until="load")
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


