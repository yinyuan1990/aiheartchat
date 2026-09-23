"""把文案渲染成 3:4 卡片图（抖音 / 快手 / 小红书没有纯文字帖，最少要一张图）。

用 patchright（Playwright 同源）的 Chromium 截一段 HTML：Windows 自带微软雅黑，字体不用另装。
分页按**实际排版高度**算（不是按字数——十几行短句字数少但很高，按字数会把底部标语压住）：
把剩下的段落全塞进卡片渲染一次，读每个 <p> 的底边，只保留落在底线之上的那几段，剩下的下一张接着；小红书 / 抖音图文本来就支持多图。
"""
from __future__ import annotations

import html
import random
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

SANS = '"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif'
SERIF = '"Songti SC","SimSun","Noto Serif SC",serif'
CN_NUM = "〇一二三四五六七八九"

# 三套样式（操作者从 card-preview.html 里挑的 1 / 3 / 4），每条任务随机用一套。
# 结构共用：.wrap（版心，定位在 CARD_TOP）> .meta（只在第一页）+ .title + .body ；.foot 底部标语；.page 右上页码
STYLES: dict[str, dict[str, str]] = {
    # 1 信笺：米色横线纸、宋体、右上红印章、中文日期
    "letter": {
        "css": f"""
body{{background:#F5EFE3;background-image:repeating-linear-gradient(180deg,transparent 0 79px,rgba(120,90,60,.13) 79px 81px);font-family:{SERIF}}}
.wrap{{padding:0 38px}}
.meta{{font-size:26px;color:#9A7B5A;letter-spacing:4px;margin:0 0 38px}}
.title{{font-size:58px;color:#3A2A1E;letter-spacing:2px;margin:0 0 44px}}
.body{{font-size:38px;color:#3F332A;line-height:80px;letter-spacing:1.5px}}
.body p{{margin:0}}
.seal{{position:absolute;right:110px;top:120px;width:92px;height:92px;border:4px solid #C0392B;border-radius:12px;color:#C0392B;font-size:46px;line-height:88px;text-align:center;font-weight:700;opacity:.85;transform:rotate(-8deg)}}
.foot{{color:#B0453A}}
.slogan{{font-size:28px;letter-spacing:5px}}
.page{{color:#9A7B5A}}
""",
        "deco": '<div class="seal">心</div>',
        "meta": '<div class="meta">{date_cn}</div>',
        "top": 150,
    },
    # 3 杂志：白底、大数字日期、英文小字、粗黑线
    "magazine": {
        "css": f"""
body{{background:#FFFFFF;font-family:{SANS};color:#111}}
.wrap{{padding:0 28px}}
.meta{{display:flex;align-items:flex-end;justify-content:space-between;border-bottom:6px solid #111;padding-bottom:26px;margin-bottom:60px}}
.num{{font-size:120px;font-weight:200;letter-spacing:-4px;line-height:1;font-family:"Helvetica Neue",Arial,sans-serif}}
.en{{font-size:22px;letter-spacing:6px;color:#666;text-align:right;line-height:1.7;font-family:"Helvetica Neue",Arial,sans-serif}}
.title{{font-size:60px;font-weight:800;letter-spacing:-1px;margin:0 0 48px}}
.body{{font-size:36px;line-height:74px;color:#333}}
.body p{{margin:0}}
.foot{{left:100px;right:100px;border-top:2px solid #111;padding-top:24px;text-align:left;color:#111}}
.slogan{{font-size:26px;letter-spacing:4px}}
.page{{color:#666;font-family:"Helvetica Neue",Arial,sans-serif}}
""",
        "deco": "",
        "meta": '<div class="meta"><div class="num">{date_num}</div><div class="en">ANONYMOUS<br>LETTER · NO.{serial}</div></div>',
        "top": 120,
    },
    # 4 奶油治愈：暖米底、奶白卡、宋体棕字标题、三点分隔
    "cream": {
        "css": f"""
body{{background:#F7F1E8;font-family:{SANS}}}
.wrap{{background:#FFFCF7;border-radius:36px;padding:76px 72px 70px;box-shadow:0 26px 70px rgba(120,90,60,.16)}}
.title{{font-family:{SERIF};font-size:60px;color:#5B4636;margin:0 0 34px}}
.meta{{color:#D9B48F;letter-spacing:14px;font-size:30px;margin:0 0 34px}}
.body{{font-size:38px;line-height:76px;color:#4A4038}}
.body p{{margin:0}}
.foot{{color:#8C6F58}}
.slogan{{font-size:28px;letter-spacing:4px}}
.page{{color:#B59F8C}}
""",
        "deco": "",
        "meta": '<div class="meta">· · ·</div>',
        "meta_after_title": "1",
        "top": 120,
    },
}

TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;padding:0}}
body{{width:{w}px;height:{h}px;position:relative;overflow:hidden}}
.wrap{{position:absolute;left:72px;top:{top}px;width:{cw}px;box-sizing:border-box}}
.title{{font-weight:700;line-height:1.35}}
.body{{word-break:break-all}}
.foot{{position:absolute;left:0;right:0;bottom:76px;text-align:center}}
.slogan:empty{{display:none}}
.page{{position:absolute;right:80px;top:56px;font-size:26px;letter-spacing:2px}}
{style_css}
</style></head><body>
{deco}
{page}
<div class="wrap">{head}<div class="body">{body}</div></div>
<div class="foot"><div class="slogan">{slogan}</div></div>
</body></html>"""


def _cn_date(now: datetime) -> str:
    m = now.month
    d = now.day
    ms = "十" if m == 10 else ("十一" if m == 11 else ("十二" if m == 12 else CN_NUM[m]))
    if d < 10:
        ds = CN_NUM[d]
    elif d < 20:
        ds = "十" + (CN_NUM[d % 10] if d % 10 else "")
    else:
        ds = CN_NUM[d // 10] + "十" + (CN_NUM[d % 10] if d % 10 else "")
    return f"{ms}月{ds}日"


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


def _doc(paras: list[str], title: str, fs: int, pm: int, slogan: str, page_tag: str, style: str, first: bool, serial: str = "") -> str:
    st = STYLES[style]
    body = "".join(f"<p>{html.escape(p)}</p>" for p in paras)
    now = datetime.now()
    meta = st["meta"].format(date_cn=_cn_date(now), date_num=f"{now.month:02d}.{now.day:02d}", serial=serial or f"{now.timetuple().tm_yday:03d}") if first else ""
    title_html = f'<div class="title">{html.escape(title)}</div>' if title else ""
    head = (title_html + meta) if st.get("meta_after_title") else (meta + title_html)
    # 字号缩放：fs 是基准 36，各样式按比例缩
    scale = fs / 36
    css = st["css"] + f"\n.body{{font-size:{int(38 * scale)}px;line-height:{int(78 * scale)}px}}\n.body p{{margin:0 0 {pm - 22}px}}" if fs != 36 else st["css"]
    return TEMPLATE.format(
        w=W, h=H, top=st.get("top", CARD_TOP), cw=W - 144,
        head=head, body=body, slogan=html.escape(slogan), page=page_tag, style_css=css, deco=st["deco"],
    )


def pick_style(name: str = "") -> str:
    """每条任务随机一套；同一任务的几张图用同一套（按 name 定种子）"""
    keys = sorted(STYLES)
    if name:
        return keys[sum(ord(c) for c in name) % len(keys)]
    return random.choice(keys)


def render_cards(out_dir: Path, name: str, title: str, content: str, brand: str, slogan: str, headless: bool = True, style: str = "random") -> list[Path]:
    """brand 参数保留兼容（不印品牌）；style = letter | magazine | cream | random（默认随机，同一任务各页一致）"""
    if style not in STYLES:
        style = pick_style(name)
    serial = "".join(ch for ch in name if ch.isdigit())[-3:].rjust(3, "0") if any(ch.isdigit() for ch in name) else ""
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
            page.set_content(_doc(remaining, title if first else "", 36, 22, slogan, "", style, first, serial), wait_until="load")
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
                page.set_content(_doc(paras, show_title, fs, pm, slogan, page_tag, style, i == 0, serial), wait_until="load")
                bottom = page.evaluate("document.querySelector('.wrap').getBoundingClientRect().bottom")
                if bottom <= LIMIT or fs <= 24:
                    break
                fs -= 3
                pm = max(10, pm - 3)
            out = out_dir / f"{name}-{i + 1}.png"
            page.screenshot(path=str(out), full_page=False, type="png")
            paths.append(out)
        browser.close()
    return paths


