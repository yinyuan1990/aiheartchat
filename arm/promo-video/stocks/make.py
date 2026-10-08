"""「美股 / US Stocks」X 宣传短片（竖屏 1080x1920，英文配音 + 字幕）。

流程（成片和中间文件都在 out/，不进 git）：
  1. ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py --tts   # 配音 → out/vo-*.mp3 + out/vo.json（每段时长）
  2. cd arm/web; node scripts/_stocks-video.mjs                       # 本地 next start -p 3125，按配音时长真实操作钱包、CDP 录屏
                                                                       # → out/frames/*.jpg + frames.txt + events.json
  3. ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py         # 合成 → out/us-stocks.mp4
股票列表、价格、K 线、KyberSwap 报价都是线上真实数据；测试钱包的 USDT / BNB 余额是录屏脚本拦截 BSC 节点返回的演示数，不签名、不上链。
配乐沿用 ../out/bgm.mp3（Mixkit「Epical Drums 01」，免版权）。
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

OUT = HERE / "out"
W, H, FPS = 1080, 1920, 30
VOICE, RATE = "en-US-AndrewNeural", "+4%"
# (场景, 配音)；录屏脚本按这些时长停留
LINES = [
    ("home", "US stocks, now inside the HeartChat wallet."),
    ("list", "Twenty-three tokenized stocks from Binance bStocks on BNB Chain. NVIDIA, Tesla, Apple, SpaceX, and the S&P 500."),
    ("detail", "Tap any stock for a live chart, real trades and holders."),
    ("buy", "Pay with USDT or BNB, and see exactly what you get before you sign. Routed by KyberSwap, with no platform fee."),
    ("end", "HeartChat wallet. US stocks on chain, and only you hold the keys."),
]
CAPTIONS = {
    "home": "US stocks, in your wallet",
    "list": "23 Binance bStocks · BNB Chain",
    "detail": "Live charts & real trades",
    "buy": "Pay with USDT or BNB",
}
GOLD, DEEP = (240, 185, 11), (12, 12, 16)
SCREEN_W = 640
SCREEN_H = round(SCREEN_W * 844 / 390 / 2) * 2
SX, SY = (W - SCREEN_W) // 2, 330
RADIUS = 56
END_DUR = 6.0
FONT_B = "C:/Windows/Fonts/segoeuib.ttf"
FONT_R = "C:/Windows/Fonts/segoeui.ttf"


def font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_B if bold else FONT_R, size)


def do_tts() -> None:
    OUT.mkdir(exist_ok=True)
    durs = {}
    for sid, text in LINES:
        dur, _, _ = tts.synth(text, OUT / f"vo-{sid}.mp3", voice=VOICE, rate=RATE)
        durs[sid] = round(dur, 3)
    (OUT / "vo.json").write_text(json.dumps(durs, indent=1), encoding="utf-8")
    print("vo", durs)


def gradient() -> Image.Image:
    g = Image.new("RGB", (W, H), DEEP)
    glow = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(glow)
    d.ellipse((W - 560, -300, W + 300, 560), fill=120)
    d.ellipse((-420, H - 520, 420, H + 320), fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(170))
    return Image.composite(Image.new("RGB", (W, H), (150, 108, 8)), g, glow)


def centered(d: ImageDraw.ImageDraw, y: int, text: str, f: ImageFont.FreeTypeFont, fill) -> None:
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=fill)


def build_layers() -> None:
    """top.png：背景 + 标题 + 挖空的圆角屏幕 + 外框；cap-*.png：底部字幕；end.png：片尾卡"""
    bg = gradient()
    top = bg.convert("RGBA")
    d = ImageDraw.Draw(top)
    centered(d, 92, "US Stocks", font(92), GOLD)
    centered(d, 212, "now in the HeartChat wallet  ·  Binance bStocks", font(40, False), (235, 228, 210))
    shadow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((SX - 14, SY - 4, SX + SCREEN_W + 14, SY + SCREEN_H + 30), RADIUS + 14, fill=190)
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    top = Image.composite(Image.new("RGBA", (W, H), (0, 0, 0, 255)), top, shadow)
    d = ImageDraw.Draw(top)
    d.rounded_rectangle((SX - 12, SY - 12, SX + SCREEN_W + 12, SY + SCREEN_H + 12), RADIUS + 12, fill=(40, 40, 46, 255))
    hole = Image.new("L", (W, H), 255)
    ImageDraw.Draw(hole).rounded_rectangle((SX, SY, SX + SCREEN_W - 1, SY + SCREEN_H - 1), RADIUS, fill=0)
    top.putalpha(hole)
    top.save(OUT / "top.png")

    for sid, text in CAPTIONS.items():
        cap = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(cap)
        f = font(46)
        tw = d.textlength(text, font=f)
        y = SY + SCREEN_H + 44
        d.rounded_rectangle(((W - tw) / 2 - 34, y - 14, (W + tw) / 2 + 34, y + 70), 40, fill=(*GOLD, 248))
        d.text(((W - tw) / 2, y - 2), text, font=f, fill=(18, 18, 22))
        cap.save(OUT / f"cap-{sid}.png")

    end = bg.copy().convert("RGBA")
    d = ImageDraw.Draw(end)
    centered(d, 580, "HeartChat Wallet", font(96), (255, 255, 255))
    centered(d, 720, "US Stocks", font(76), GOLD)
    for i, line in enumerate(["23 Binance bStocks on BNB Chain", "Pay with USDT or BNB  ·  via KyberSwap", "Self-custody: your keys, your funds"]):
        centered(d, 890 + i * 76, line, font(46, False), (232, 226, 212))
    for i, line in enumerate(["Tokenized certificates, not shares. Not available to US persons.", "Not financial advice."]):
        centered(d, 1230 + i * 48, line, font(32, False), (170, 162, 140))
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
    ins = ["-f", "lavfi", "-i", f"color=c=0x0c0c10:s={W}x{H}:r={FPS}:d={total:.3f}", "-i", str(OUT / "screen.mp4"), "-loop", "1", "-i", str(OUT / "top.png")]
    for s in scenes:
        ins += ["-loop", "1", "-i", str(OUT / f"cap-{s}.png")]
    ins += ["-loop", "1", "-i", str(OUT / "end.png")]
    n_cap = len(scenes)
    end_idx = 3 + n_cap
    vf = [f"[1:v]tpad=stop_mode=clone:stop_duration={END_DUR}[scr]", f"[0:v][scr]overlay={SX}:{SY}[a0]", "[a0][2:v]overlay=0:0[a1]"]
    cur = "a1"
    for i, s in enumerate(scenes):
        t0 = starts[s] + 0.15
        t1 = starts[scenes[i + 1]] if i + 1 < len(scenes) else rec
        vf.append(f"[{cur}][{3 + i}:v]overlay=0:0:enable='between(t,{t0:.2f},{t1:.2f})'[c{i}]")
        cur = f"c{i}"
    vf.append(f"[{end_idx}:v]format=rgba,fade=t=in:st={rec:.2f}:d=0.5:alpha=1[endf]")
    vf.append(f"[{cur}][endf]overlay=0:0:enable='gte(t,{rec:.2f})'[v]")
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
    out = OUT / "us-stocks.mp4"
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
    print("done", compose(), media_duration(OUT / "us-stocks.mp4"))
