"""「Arm 创作者商城」宣传短片（竖屏 1080x1920，中文配音 + 字幕）。

流程（成片和中间文件都在 out/，不进 git）：
  1. ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py --tts   # 配音 → out/vo-*.mp3 + out/vo.json（每段时长）
  2. cd arm/web; node scripts/_shop-video.mjs                         # 本地 next start -p 3123，按配音时长真实操作钱包、CDP 录屏
                                                                       # → out/frames/*.jpg + frames.txt + events.json
  3. ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py         # 合成 → out/arm-shop.mp4
商品、评价、留言、价格都是线上真实数据；录屏里的那笔「买入等值 $EGIRL」是专用测试钱包真付的 $0.01。
配乐沿用 ../out/bgm.mp3（Mixkit「Epical Drums 01」，免版权）。
英文版（英文配音 + 英文字幕带中文翻译）：三步都加 --en（录屏用 `$env:LANG_EN=1`），中间文件和成片在 out-en/。
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "publisher"))
from video import tts  # noqa: E402
from video.common import media_duration, run_ffmpeg  # noqa: E402

EN = "--en" in sys.argv
OUT = HERE / ("out-en" if EN else "out")
W, H, FPS = 1080, 1920, 30
VOICE, RATE = ("en-US-AndrewNeural", "+4%") if EN else ("zh-CN-YunyangNeural", "+6%")
# (场景, 配音)；录屏脚本按这些时长停留
LINES = [
    ("home", "心之音钱包上线 Arm 创作者商城，发过币的人都能开店卖东西。"),
    ("market", "商品以图片为主，按美元标价，可以直接搜索。"),
    ("detail", "点进去看大图，有买家评价和留言，还能一键喊单到卖家的店铺群。"),
    ("buy", "付款两种方式：买入等值的店铺代币，代币归你，卖家拿交易手续费分成；也可以直接付 USDC 给卖家。"),
    ("done", "链上确认后自动下单，卖家看到订单自己发货。"),
    ("end", "毕业的代币，平台还会额外奖励。Arm 创作者商城，就在心之音钱包。"),
]
CAPTIONS = {
    "home": "发过币就能开店",
    "market": "图片为主 · 美元标价 · 可搜索",
    "detail": "评价、留言、一键喊单",
    "buy": "买入等值代币 或 USDC 直付",
    "done": "链上确认 · 自动下单",
}
# English cut: each line in subtitle-sized pieces, each with its Chinese translation; the voice reads the pieces joined
LINES_EN = [
    ("home", [("HeartChat Wallet now has Arm Creator Shops.", "心之音钱包上线 Arm 创作者商城"),
              ("Anyone who has launched a token can open a shop.", "发过币的人都能开店")]),
    ("market", [("Items lead with pictures,", "商品以图片为主"), ("priced in US dollars,", "按美元标价"), ("and you can search them.", "还可以直接搜索")]),
    ("detail", [("Open one for big photos,", "点进去看大图"), ("buyer reviews and comments,", "有买家评价和留言"),
                ("and a one-tap call-out to the seller's shop group.", "还能一键喊单到卖家的店铺群")]),
    ("buy", [("Two ways to pay.", "付款有两种方式"), ("Buy the same value of the shop's token:", "买入等值的店铺代币"),
             ("the tokens are yours,", "代币归你"), ("and the seller earns a share of the trading fee.", "卖家拿交易手续费分成"),
             ("Or pay the seller directly in USDC.", "或者直接付 USDC 给卖家")]),
    ("done", [("Once it's confirmed on-chain, the order is placed,", "链上确认后自动下单"), ("and the seller ships it.", "卖家看到订单自己发货")]),
    ("end", [("Graduated tokens get extra rewards from the platform.", "毕业的代币，平台还会额外奖励"),
             ("Arm Creator Shops, in the HeartChat Wallet.", "Arm 创作者商城，就在心之音钱包")]),
]
if EN:
    LINES = [(sid, " ".join(e for e, _ in parts)) for sid, parts in LINES_EN]
ACCENT, DEEP = (249, 115, 22), (14, 10, 14)
SCREEN_W = 640
SCREEN_H = round(SCREEN_W * 844 / 390 / 2) * 2
SX, SY = (W - SCREEN_W) // 2, 330
RADIUS = 56
END_DUR = 6.5
FONT_B = "C:/Windows/Fonts/msyhbd.ttc"
FONT_R = "C:/Windows/Fonts/msyh.ttc"
FONT_EN_B = "C:/Windows/Fonts/segoeuib.ttf"
FONT_EN_R = "C:/Windows/Fonts/segoeui.ttf"


def font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_B if bold else FONT_R, size)


def font_en(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_EN_B if bold else FONT_EN_R, size)


def do_tts() -> None:
    OUT.mkdir(exist_ok=True)
    durs, subs = {}, {}
    for sid, text in LINES:
        dur, ct, _ = tts.synth(text, OUT / f"vo-{sid}.mp3", voice=VOICE, rate=RATE)
        durs[sid] = round(dur, 3)
        if EN:
            # each piece shows from the moment the voice starts it until the next piece starts
            parts, at, rows = dict(LINES_EN)[sid], 0, []
            for i, (en, zh) in enumerate(parts):
                k = text.index(en, at)
                rows.append({"t": round(ct[k] if k < len(ct) and ct[k] is not None else 0, 3), "en": en, "zh": zh})
                at = k + len(en)
            for i, r in enumerate(rows):
                r["t1"] = rows[i + 1]["t"] if i + 1 < len(rows) else round(dur + 0.3, 3)
            subs[sid] = rows
    (OUT / "vo.json").write_text(json.dumps(durs, indent=1), encoding="utf-8")
    if EN:
        (OUT / "subs.json").write_text(json.dumps(subs, ensure_ascii=False, indent=1), encoding="utf-8")
    print("vo", durs)


def wrap(d: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines, cur = [], ""
    for w in text.split():
        nxt = f"{cur} {w}".strip()
        if cur and d.textlength(nxt, font=f) > width:
            lines.append(cur)
            cur = w
        else:
            cur = nxt
    return lines + [cur] if cur else lines


def sub_layer(en: str, zh: str) -> Image.Image:
    """bilingual subtitle under the phone: English (one or two lines) over its Chinese translation"""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    fe, fz = font_en(40), font(32, False)
    lines = wrap(d, en, fe, W - 140)
    tw = max([d.textlength(x, font=fe) for x in lines] + [d.textlength(zh, font=fz)])
    h = 52 * len(lines) + 46
    y = SY + SCREEN_H + (H - SY - SCREEN_H - h) // 2 - 4
    d.rounded_rectangle(((W - tw) / 2 - 30, y - 12, (W + tw) / 2 + 30, y + h + 6), 26, fill=(10, 8, 12, 215))
    for i, x in enumerate(lines):
        centered(d, y + i * 52, x, fe, (255, 255, 255))
    centered(d, y + 52 * len(lines) + 2, zh, fz, (255, 200, 160))
    return img


def gradient() -> Image.Image:
    g = Image.new("RGB", (W, H), DEEP)
    glow = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(glow)
    d.ellipse((W - 560, -300, W + 300, 560), fill=130)
    d.ellipse((-420, H - 520, 420, H + 320), fill=80)
    glow = glow.filter(ImageFilter.GaussianBlur(170))
    return Image.composite(Image.new("RGB", (W, H), (190, 40, 110)), g, glow)


def centered(d: ImageDraw.ImageDraw, y: int, text: str, f: ImageFont.FreeTypeFont, fill) -> None:
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=fill)


def build_layers() -> None:
    """top.png：背景 + 标题 + 挖空的圆角屏幕 + 外框；cap-*.png：底部字幕；end.png：片尾卡"""
    bg = gradient()
    top = bg.convert("RGBA")
    d = ImageDraw.Draw(top)
    if EN:
        centered(d, 92, "Arm Creator Shops", font_en(88), (255, 255, 255))
        centered(d, 212, "Shop with creator tokens · 用代币买东西", font(38, False), (255, 214, 186))
    else:
        centered(d, 96, "Arm 创作者商城", font(88), (255, 255, 255))
        centered(d, 214, "用代币买东西 · 心之音钱包", font(40, False), (255, 214, 186))
    shadow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((SX - 14, SY - 4, SX + SCREEN_W + 14, SY + SCREEN_H + 30), RADIUS + 14, fill=190)
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    top = Image.composite(Image.new("RGBA", (W, H), (0, 0, 0, 255)), top, shadow)
    d = ImageDraw.Draw(top)
    d.rounded_rectangle((SX - 12, SY - 12, SX + SCREEN_W + 12, SY + SCREEN_H + 12), RADIUS + 12, fill=(40, 36, 42, 255))
    hole = Image.new("L", (W, H), 255)
    ImageDraw.Draw(hole).rounded_rectangle((SX, SY, SX + SCREEN_W - 1, SY + SCREEN_H - 1), RADIUS, fill=0)
    top.putalpha(hole)
    top.save(OUT / "top.png")

    if EN:
        for sid, rows in json.loads((OUT / "subs.json").read_text(encoding="utf-8")).items():
            for i, r in enumerate(rows):
                sub_layer(r["en"], r["zh"]).save(OUT / f"sub-{sid}-{i}.png")
        end = bg.copy().convert("RGBA")
        d = ImageDraw.Draw(end)
        centered(d, 470, "Arm Creator Shops", font_en(100), (255, 255, 255))
        centered(d, 610, "Arm 创作者商城", font(46, False), (255, 214, 186))
        centered(d, 722, "Graduated tokens earn extra rewards", font_en(50), ACCENT)
        centered(d, 790, "毕业的代币 · 平台额外奖励", font(36, False), ACCENT)
        rows = [("Launched a token? Open a shop.", "发过币就能开店"), ("Pay by buying the token, or in USDC", "买入等值代币付款，或 USDC 直付"),
                ("Reviews · comments · one-tap call-outs", "评价 · 留言 · 一键喊单到店铺群")]
        for i, (en, zh) in enumerate(rows):
            centered(d, 920 + i * 112, en, font_en(44, False), (245, 236, 240))
            centered(d, 974 + i * 112, zh, font(30, False), (200, 180, 188))
        centered(d, 1290, "arm.yyheart.com", font_en(56), (255, 255, 255))
        for i, line in enumerate(["Real product footage · reward rules per platform announcements · not investment advice",
                                  "画面为产品实拍 · 奖励规则以平台公告为准 · 不构成投资建议"]):
            f = font_en(26, False) if i == 0 else font(26, False)
            centered(d, 1410 + i * 42, line, f, (190, 170, 178))
        end.save(OUT / "end.png")
        return

    for sid, text in CAPTIONS.items():
        cap = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(cap)
        f = font(48)
        tw = d.textlength(text, font=f)
        y = SY + SCREEN_H + 44
        d.rounded_rectangle(((W - tw) / 2 - 36, y - 12, (W + tw) / 2 + 36, y + 76), 40, fill=(*ACCENT, 248))
        d.text(((W - tw) / 2, y - 2), text, font=f, fill=(255, 255, 255))
        cap.save(OUT / f"cap-{sid}.png")

    end = bg.copy().convert("RGBA")
    d = ImageDraw.Draw(end)
    centered(d, 560, "Arm 创作者商城", font(96), (255, 255, 255))
    centered(d, 700, "毕业的代币 · 平台额外奖励", font(64), ACCENT)
    for i, line in enumerate(["发过币就能开店，商品图片为主", "买入等值代币付款，或 USDC 直付", "评价 · 留言 · 一键喊单到店铺群"]):
        centered(d, 880 + i * 76, line, font(46, False), (240, 228, 232))
    centered(d, 1150, "arm.yyheart.com", font(54), (255, 255, 255))
    for i, line in enumerate(["画面为产品实拍 · 奖励规则以平台公告为准", "不构成投资建议"]):
        centered(d, 1300 + i * 48, line, font(32, False), (190, 170, 178))
    end.save(OUT / "end.png")


def screen_video() -> Path:
    """frames.txt（concat，每帧真实停留时长）→ 固定 30fps 的屏幕录像"""
    out = OUT / "screen.mp4"
    run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(OUT / "frames.txt"), "-vf", f"fps={FPS},scale={SCREEN_W}:{SCREEN_H}:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "16", "-preset", "medium", str(out)])
    return out


def compose() -> Path:
    ev = json.loads((OUT / "events.json").read_text(encoding="utf-8"))
    durs = json.loads((OUT / "vo.json").read_text(encoding="utf-8"))
    rec = media_duration(OUT / "screen.mp4")
    total = rec + END_DUR
    bgm = OUT / "bgm.mp3"
    if not bgm.exists():
        shutil.copy(HERE.parent / "out" / "bgm.mp3", bgm)
    scenes = [s for s, _ in LINES if s != "end"]
    starts = {s: ev[s] for s in scenes}
    starts["end"] = rec + 0.3
    ins = ["-f", "lavfi", "-i", f"color=c=0x0e0a0e:s={W}x{H}:r={FPS}:d={total:.3f}", "-i", str(OUT / "screen.mp4"), "-loop", "1", "-i", str(OUT / "top.png")]
    # (layer, from, to): one caption per scene, or in the English cut the bilingual subtitle pieces
    caps: list[tuple[Path, float, float, bool]] = []
    if EN:
        for s, rows in json.loads((OUT / "subs.json").read_text(encoding="utf-8")).items():
            for i, r in enumerate(rows):
                caps.append((OUT / f"sub-{s}-{i}.png", starts[s] + 0.25 + r["t"], starts[s] + 0.25 + r["t1"], s == "end"))
    else:
        for i, s in enumerate(scenes):
            caps.append((OUT / f"cap-{s}.png", starts[s] + 0.15, starts[scenes[i + 1]] if i + 1 < len(scenes) else rec, False))
    for c in caps:
        ins += ["-loop", "1", "-i", str(c[0])]
    ins += ["-loop", "1", "-i", str(OUT / "end.png")]
    end_idx = 3 + len(caps)
    vf = [f"[1:v]tpad=stop_mode=clone:stop_duration={END_DUR}[scr]", f"[0:v][scr]overlay={SX}:{SY}[a0]", "[a0][2:v]overlay=0:0[a1]"]
    cur = "a1"
    for i, (_, t0, t1, on_end) in enumerate(caps):
        if not on_end:
            vf.append(f"[{cur}][{3 + i}:v]overlay=0:0:enable='between(t,{t0:.2f},{t1:.2f})'[c{i}]")
            cur = f"c{i}"
    vf.append(f"[{end_idx}:v]format=rgba,fade=t=in:st={rec:.2f}:d=0.5:alpha=1[endf]")
    vf.append(f"[{cur}][endf]overlay=0:0:enable='gte(t,{rec:.2f})'[e0]")
    cur = "e0"
    for i, (_, t0, t1, on_end) in enumerate(caps):
        if on_end:
            vf.append(f"[{cur}][{3 + i}:v]overlay=0:0:enable='between(t,{t0:.2f},{t1:.2f})'[d{i}]")
            cur = f"d{i}"
    vf.append(f"[{cur}]null[v]")
    a_in, parts = [], []
    base = end_idx + 1
    for k, (s, _) in enumerate(LINES):
        a_in += ["-i", str(OUT / f"vo-{s}.mp3")]
        ms = int((starts[s] + 0.25) * 1000)
        parts.append(f"[{base + k}:a]adelay={ms}|{ms},volume=1.5[v{k}]")
    a_in += ["-i", str(bgm)]
    nb = len(LINES)
    vo = "".join(f"[v{k}]" for k in range(nb))
    af = ";".join(parts) + f";{vo}amix=inputs={nb}:normalize=0:dropout_transition=0[vo];" \
        f"[{base + nb}:a]aloop=loop=-1:size=2e9,atrim=0:{total:.2f},volume=0.22,afade=t=in:d=0.6,afade=t=out:st={total - 2:.2f}:d=2[bg];" \
        f"[vo][bg]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-14:TP=-1.5:LRA=11[a]"
    out = OUT / ("arm-shop-en.mp4" if EN else "arm-shop.mp4")
    run_ffmpeg([*ins, *a_in, "-filter_complex", ";".join(vf) + ";" + af, "-map", "[v]", "-map", "[a]", "-t", f"{total:.3f}",
                "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)])
    for s in scenes:
        if starts[s] + 0.25 + durs[s] > (starts[scenes[scenes.index(s) + 1]] if s != scenes[-1] else rec + 0.3):
            print(f"warning: voice-over '{s}' runs into the next scene")
    if 0.25 + durs["end"] > END_DUR:
        print("warning: end voice-over is longer than the end card")
    return out


if __name__ == "__main__":
    if "--tts" in sys.argv:
        do_tts()
        sys.exit(0)
    build_layers()
    screen_video()
    out = compose()
    print("done", out, media_duration(out))
