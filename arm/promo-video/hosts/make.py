"""心之音「百位主播招募计划」活动宣传片（竖屏 1080x1920，中文配音 + 字幕）：promo.html 写动画，这里配音 → 时间轴 → 逐帧截图 → 合成。

画面全是 HTML 做的活动示意（商品图是生成的，主播头像是 emoji，销量 / 成交额是演示数字，片尾写明）。
素材（不进 git）：assets/p-*.jpg 商品图、assets/bgm.mp3（Mixkit「Epical Drums 01」，同 ../out/bgm.mp3）。
用发布机的虚拟环境跑（要 edge-tts / patchright）：
  ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py            # 出 out/hosts-recruit.mp4
  ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py --preview  # 只截关键帧到 out/prev-*.jpg
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "publisher"))
from video import tts  # noqa: E402
from video.common import ffmpeg, media_duration, run_ffmpeg  # noqa: E402

OUT = HERE / "out"
FPS = 30
VOICE, RATE = "zh-CN-YunxiNeural", "+8%"
VO_OFF = 0.35
# (场景 id, 配音, 配音后留多久)；旁白里不写 $
SCENES = [
    ("s0", "心之音百位主播招募计划，正式开启！", 0.8),
    ("s1", "水果、茶叶、蜂蜜、地方特产，你家乡的好东西，都能在心之音开店卖。", 0.6),
    ("s2", "和粉丝聊着天，商品一键喊单到店铺群，粉丝点开就能下单。", 0.9),
    ("s3", "一百家小店同时开张，订单一单接一单，销量实时往上涨。", 0.9),
    ("s4", "发过币就能开店。买家买入等值代币付款，代币归买家，你拿交易手续费分成；也能直接收 USDC。实物和虚拟商品都能卖。", 0.7),
    ("s5", "毕业的代币，平台还有额外奖励。首批一百个名额，先到先得！", 0.9),
    ("s6", "心之音，让每个主播都有自己的小店。现在就来报名！", 3.2),
]
SUB_MAX = 15


def chunks(text: str) -> list[tuple[int, int]]:
    """按标点切字幕，返回 (起, 止) 下标；标点不显示"""
    out, start = [], 0
    for m in re.finditer(r"[，。：、！？；,.]", text):
        if m.start() > start:
            out.append((start, m.start()))
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
        dur, ct, _ = tts.synth(text, OUT / f"vo-{sid}.mp3", voice=VOICE, rate=RATE)
        sdur = VO_OFF + dur + tail
        scenes.append({"id": sid, "start": round(t, 3), "dur": round(sdur, 3), "vo": VO_OFF, "text": text, "ct": [round(x, 3) for x in ct], "last": i == len(SCENES) - 1})
        cs = chunks(text)
        for j, (a, b) in enumerate(cs):
            t1 = ct[cs[j + 1][0]] if j + 1 < len(cs) else dur + 0.2
            subs.append({"t0": round(t + VO_OFF + ct[a], 3), "t1": round(t + VO_OFF + t1, 3), "text": text[a:b].strip()})
        t += sdur
    tl = {"fps": FPS, "total": round(t, 3), "scenes": scenes, "subs": subs}
    (OUT / "timeline.js").write_text("window.TL = " + json.dumps(tl, ensure_ascii=False) + ";\n", encoding="utf-8")
    return tl


def render(tl: dict, preview: list[float] | None = None) -> Path:
    from patchright.sync_api import sync_playwright

    silent = OUT / "video.mp4"
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, channel="chromium", args=["--allow-file-access-from-files"])
        page = b.new_page(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
        page.goto((HERE / "promo.html").as_uri(), wait_until="load")
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(800)
        if page.evaluate("typeof window.seek", isolated_context=False) != "function":
            raise RuntimeError("promo.html 的脚本没跑起来")
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
    ins, parts = ["-i", str(silent), "-i", str(HERE / "assets" / "bgm.mp3")], []
    for k, sc in enumerate(tl["scenes"]):
        ins += ["-i", str(OUT / f"vo-{sc['id']}.mp3")]
        ms = int((sc["start"] + sc["vo"]) * 1000)
        parts.append(f"[{k + 2}:a]adelay={ms}|{ms},volume=1.6[v{k}]")
    n = len(tl["scenes"])
    vo = "".join(f"[v{k}]" for k in range(n))
    fc = ";".join(parts) + f";{vo}amix=inputs={n}:normalize=0:dropout_transition=0[vo];" \
         f"[1:a]aloop=loop=-1:size=2e9,atrim=0:{total:.2f},volume=0.32,afade=t=in:d=0.4,afade=t=out:st={total - 2.5:.2f}:d=2.5[bg];" \
         f"[vo][bg]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-14:TP=-1.5:LRA=11[a]"
    out = OUT / "hosts-recruit.mp4"
    run_ffmpeg([*ins, "-filter_complex", fc, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
    return out


if __name__ == "__main__":
    tl = build_timeline()
    print("total", tl["total"], "s;", [(s["id"], s["dur"]) for s in tl["scenes"]])
    if "--preview" in sys.argv:
        pts = []
        for s in tl["scenes"]:
            pts += [s["start"] + s["dur"] * f for f in (0.3, 0.65, 0.95)]
        render(tl, pts)
        print("preview done")
    else:
        out = mix(tl, render(tl))
        print("mixed", out, media_duration(out))
