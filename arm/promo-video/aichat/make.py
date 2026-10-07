"""「AI 模型 / AI Models」X 宣传短片（竖屏 1080x1920，英文配音 + 字幕）。

流程（成片和中间文件都在 out/，不进 git）：
  1. ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py --tts   # 配音 → out/vo-*.mp3 + out/vo.json（每段时长）
  2. cd arm/web; node scripts/_aichat-video.mjs                       # 本地 next start -p 3124，按配音时长真实操作钱包、CDP 录屏
                                                                       # → out/frames/*.jpg + frames.txt + events.json
  3. ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py         # 合成 → out/ai-models.mp4
钱包用 localhost 的演示模式（sessionStorage arm-ai-demo）：模型列表和价格是线上真实数据，生成结果回放测试时 BlockRun 真实生成的
文件（out/fixtures/，录屏时本地拦截返回），确认框照常弹出，不签名不上链。配乐沿用 ../out/bgm.mp3（Mixkit「Epical Drums 01」，免版权）。
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
    ("home", "Your HeartChat wallet now pays for A.I. Per use, in USDC."),
    ("modes", "Chat, images, video, voice, music and sound effects. Eighty-plus models. No sign-up, no API key."),
    ("image", "Describe a picture. About two cents, paid straight from your wallet."),
    ("edit", "Tap edit, and restyle it with a sentence."),
    ("video", "Or animate it. You see the price first, and it only settles when the video is ready."),
    ("end", "HeartChat wallet. A.I., paid in USDC on Base."),
]
CAPTIONS = {
    "home": "AI, paid per use in USDC",
    "modes": "Chat · Image · Video · Voice · Music",
    "image": "~$0.02 an image · no API key",
    "edit": "Edit any image",
    "video": "Image → video · pay on success",
}
BLUE, DEEP = (84, 52, 232), (22, 10, 72)
SCREEN_W = 640
SCREEN_H = round(SCREEN_W * 844 / 390 / 2) * 2
SX, SY = (W - SCREEN_W) // 2, 330
RADIUS = 56
END_DUR = 5.6
FONT_B = "C:/Windows/Fonts/segoeuib.ttf"
FONT_R = "C:/Windows/Fonts/segoeui.ttf"
FONT_SYM = "C:/Windows/Fonts/seguisym.ttf"


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
    px = g.load()
    for y in range(H):
        for x in range(0, W, 4):
            k = min(1.0, max(0.0, 0.55 * (1 - y / H) + 0.45 * (x / W) * (1 - y / H) + 0.25 * (y / H) ** 3))
            c = tuple(round(DEEP[i] + (BLUE[i] - DEEP[i]) * k) for i in range(3))
            for dx in range(4):
                if x + dx < W:
                    px[x + dx, y] = c
    glow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(glow).ellipse((W - 520, -260, W + 260, 520), fill=110)
    glow = glow.filter(ImageFilter.GaussianBlur(160))
    return Image.composite(Image.new("RGB", (W, H), (120, 150, 255)), g, glow)


def centered(d: ImageDraw.ImageDraw, y: int, text: str, f: ImageFont.FreeTypeFont, fill) -> None:
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=fill)


def build_layers() -> None:
    """top.png：背景 + 标题 + 挖空的圆角屏幕 + 外框；cap-*.png：底部字幕；end.png：片尾卡"""
    bg = gradient()
    top = bg.convert("RGBA")
    d = ImageDraw.Draw(top)
    centered(d, 92, "AI Models", font(92), (255, 255, 255))
    centered(d, 212, "now in the HeartChat wallet  ·  paid in USDC", font(40, False), (214, 210, 255))
    shadow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((SX - 14, SY - 4, SX + SCREEN_W + 14, SY + SCREEN_H + 30), RADIUS + 14, fill=170)
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    top = Image.composite(Image.new("RGBA", (W, H), (8, 0, 30, 255)), top, shadow)
    d = ImageDraw.Draw(top)
    d.rounded_rectangle((SX - 12, SY - 12, SX + SCREEN_W + 12, SY + SCREEN_H + 12), RADIUS + 12, fill=(16, 18, 26, 255))
    hole = Image.new("L", (W, H), 255)
    ImageDraw.Draw(hole).rounded_rectangle((SX, SY, SX + SCREEN_W - 1, SY + SCREEN_H - 1), RADIUS, fill=0)
    top.putalpha(hole)
    top.save(OUT / "top.png")

    for sid, text in CAPTIONS.items():
        cap = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(cap)
        f = font(46)
        # "→" isn't in Segoe UI Bold: draw it with Segoe UI Symbol
        parts = text.split("→")
        widths = [d.textlength(p, font=f) for p in parts]
        arrow = ImageFont.truetype(FONT_SYM, 46)
        aw = d.textlength("→", font=arrow)
        tw = sum(widths) + aw * (len(parts) - 1)
        y = SY + SCREEN_H + 44
        d.rounded_rectangle(((W - tw) / 2 - 34, y - 14, (W + tw) / 2 + 34, y + 70), 40, fill=(255, 255, 255, 245))
        x = (W - tw) / 2
        for i, p in enumerate(parts):
            d.text((x, y - 2), p, font=f, fill=(40, 16, 120))
            x += widths[i]
            if i < len(parts) - 1:
                d.text((x, y - 2), "→", font=arrow, fill=(40, 16, 120))
                x += aw
        cap.save(OUT / f"cap-{sid}.png")

    end = bg.copy().convert("RGBA")
    d = ImageDraw.Draw(end)
    centered(d, 560, "HeartChat Wallet", font(96), (255, 255, 255))
    centered(d, 700, "AI Models", font(72), (190, 170, 255))
    for i, line in enumerate(["80+ chat models · images · video · voice", "Pay per use in USDC on Base, via x402", "No sign-up, no API key · your keys"]):
        centered(d, 860 + i * 76, line, font(46, False), (222, 220, 255))
    centered(d, 1200, "Powered by BlockRun", font(36, False), (170, 165, 230))
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
    ins = ["-f", "lavfi", "-i", f"color=c=0x160a48:s={W}x{H}:r={FPS}:d={total:.3f}", "-i", str(OUT / "screen.mp4"), "-loop", "1", "-i", str(OUT / "top.png")]
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
    out = OUT / "ai-models.mp4"
    run_ffmpeg([*ins, *a_in, "-filter_complex", ";".join(vf) + ";" + af, "-map", "[v]", "-map", "[a]", "-t", f"{total:.3f}",
                "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)])
    for s in scenes:
        if starts[s] + 0.25 + durs[s] > (starts[scenes[scenes.index(s) + 1]] if s != scenes[-1] else rec + 0.3):
            print(f"warning: voice-over '{s}' runs into the next scene")
    return out


if __name__ == "__main__":
    if "--tts" in sys.argv:
        do_tts()
        sys.exit(0)
    build_layers()
    screen_video()
    print("done", compose(), media_duration(OUT / "ai-models.mp4"))
