"""Arm 项目介绍动态视频（竖屏 1080x1920）：promo.html 写动画场景，这里配音 → 算时间轴 → 逐帧截图 → 合成。

用发布机的虚拟环境跑（要 edge-tts / patchright / imageio-ffmpeg）：
  ..\\..\\publisher\\.venv\\Scripts\\python.exe make.py            # 出 out/arm-promo.mp4
  ..\\..\\publisher\\.venv\\Scripts\\python.exe make.py --preview  # 只截几张关键帧到 out/prev-*.jpg
  ..\\..\\publisher\\.venv\\Scripts\\python.exe make.py --mix      # 只重新混音
配乐 out/bgm.mp3：Mixkit「Epical Drums 01」（免版权），out/ 不进 git。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUB = HERE.parent.parent / "publisher"
sys.path.insert(0, str(PUB))
from video import tts  # noqa: E402
from video.common import ffmpeg, media_duration, run_ffmpeg  # noqa: E402

OUT = HERE / "out"
FPS = 30
VOICE = "zh-CN-YunyangNeural"
RATE = "+4%"
VO_OFF = 0.45
# (场景 id, 配音, 配音后留多久)
SCENES = [
    ("s0", "史无前例的一场实验，正在 Arc 主网上发生。", 0.7),
    ("s1", "Arm，Circle 推出的 Arc 主网上，零成本的 Meme 发射台。", 0.8),
    ("s2", "一键发币，自动建池，流动性永久锁定，全部用 USDC 计价，链上可查。", 0.9),
    ("s3", "商业闭环：主播免费发币，粉丝买入交易，每笔交易百分之一的池费，百分之七十八永远归主播。主播开播引流，粉丝推广拉新还能分佣。流量、交易、收益，循环不息。", 1.2),
    ("s5", "第一期：KOL 入驻。头部创作者带着粉丝来发币，一个 KOL，就是一个社区。", 1.0),
    ("s6", "第二期：一千位主播，同时发布自己的陪玩代币，同时开播，线上开黑，语音陪伴。一千个直播间，一千条链上曲线。", 1.2),
    ("s7", "我们的目标：链上累计成交额，突破一百亿。那一天，将是整个行业的特大新闻。", 1.4),
    ("s8", "Arm，为你的心中女神，发射一枚。", 3.5),
]
SUB_MAX = 15


def chunks(text: str) -> list[tuple[int, int]]:
    """按标点切字幕，返回 (起, 止) 下标；标点不显示"""
    out, start = [], 0
    for m in re.finditer(r"[，。：、！？；,.]", text):
        seg = (start, m.start())
        if seg[1] > seg[0]:
            out.append(seg)
        start = m.end()
    if start < len(text):
        out.append((start, len(text)))
    res = []
    for a, b in out:
        while b - a > SUB_MAX + 3:
            res.append((a, a + SUB_MAX))
            a += SUB_MAX
        res.append((a, b))
    return res


def build_timeline() -> dict:
    OUT.mkdir(exist_ok=True)
    scenes, subs, t = [], [], 0.0
    for i, (sid, text, tail) in enumerate(SCENES):
        mp3 = OUT / f"vo-{sid}.mp3"
        dur, ct, _ = tts.synth(text, mp3, voice=VOICE, rate=RATE)
        sdur = VO_OFF + dur + tail
        scenes.append({"id": sid, "start": round(t, 3), "dur": round(sdur, 3), "vo": VO_OFF, "voDur": dur, "text": text, "ct": [round(x, 3) for x in ct], "last": i == len(SCENES) - 1})
        cs = chunks(text)
        for j, (a, b) in enumerate(cs):
            t0 = t + VO_OFF + ct[a]
            t1 = t + VO_OFF + (ct[cs[j + 1][0]] if j + 1 < len(cs) else dur + 0.2)
            subs.append({"t0": round(t0, 3), "t1": round(t1, 3), "text": text[a:b].strip()})
        t += sdur
    tl = {"fps": FPS, "total": round(t, 3), "scenes": scenes, "subs": subs}
    (OUT / "timeline.js").write_text("window.TL = " + json.dumps(tl, ensure_ascii=False) + ";\n", encoding="utf-8")
    (OUT / "timeline.json").write_text(json.dumps(tl, ensure_ascii=False, indent=1), encoding="utf-8")
    return tl


def render(tl: dict, preview: list[float] | None = None) -> Path:
    from patchright.sync_api import sync_playwright

    silent = OUT / "video.mp4"
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, channel="chromium")
        page = b.new_page(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
        page.goto((HERE / "promo.html").as_uri(), wait_until="load")
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(500)
        # patchright 默认在隔离环境里 evaluate，看不到页面自己的 seek
        kind = page.evaluate("typeof window.seek", isolated_context=False)
        if kind != "function":
            raise RuntimeError(f"promo.html 的脚本没跑起来（seek 是 {kind}）")
        if preview:
            for x in preview:
                page.evaluate(f"seek({x})", isolated_context=False)
                page.screenshot(path=str(OUT / f"prev-{x:05.1f}.jpg"), type="jpeg", quality=85)
            b.close()
            return OUT
        n = int(tl["total"] * FPS)
        proc = subprocess.Popen([ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "-",
                                 "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", str(silent)], stdin=subprocess.PIPE)
        t0 = time.time()
        for i in range(n):
            page.evaluate(f"seek({i / FPS})", isolated_context=False)
            proc.stdin.write(page.screenshot(type="jpeg", quality=92))
            if i % 300 == 0:
                print(f"frame {i}/{n}  {time.time() - t0:.0f}s", flush=True)
        proc.stdin.close()
        proc.wait()
        b.close()
    return silent


def mix(tl: dict, silent: Path) -> Path:
    total = tl["total"]
    ins, parts = ["-i", str(silent), "-i", str(OUT / "bgm.mp3")], []
    for k, sc in enumerate(tl["scenes"]):
        ins += ["-i", str(OUT / f"vo-{sc['id']}.mp3")]
        ms = int((sc["start"] + sc["vo"]) * 1000)
        parts.append(f"[{k + 2}:a]adelay={ms}|{ms},volume=1.6[v{k}]")
    n = len(tl["scenes"])
    vo = "".join(f"[v{k}]" for k in range(n))
    fc = ";".join(parts) + f";{vo}amix=inputs={n}:normalize=0:dropout_transition=0[vo];" \
         f"[1:a]volume=0.32,afade=t=in:d=0.5,afade=t=out:st={total - 2.5:.2f}:d=2.5[bg];[vo][bg]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-14:TP=-1.5:LRA=11[a]"
    out = OUT / "arm-promo.mp4"
    run_ffmpeg([*ins, "-filter_complex", fc, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
    return out


if __name__ == "__main__":
    if "--mix" in sys.argv:
        # 只重新混音（画面 out/video.mp4 和配音沿用上次的）
        tl = json.loads((OUT / "timeline.json").read_text(encoding="utf-8"))
        print("mixed", mix(tl, OUT / "video.mp4"))
        sys.exit(0)
    tl = build_timeline()
    print("total", tl["total"], "s;", [(s["id"], s["dur"]) for s in tl["scenes"]])
    if "--preview" in sys.argv:
        pts = []
        for s in tl["scenes"]:
            pts += [s["start"] + s["dur"] * 0.35, s["start"] + s["dur"] * 0.9]
        render(tl, pts)
        print("preview done")
    else:
        silent = render(tl)
        print("mixed", mix(tl, silent), media_duration(OUT / "arm-promo.mp4"))
