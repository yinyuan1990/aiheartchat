"""科普短片「疫情为什么让经济变差：钱没少，是转不动了」（竖屏 1080x1920，中文配音 + 字幕）：promo.html 写动画，这里配音 → 时间轴 → 逐帧截图 → 合成。

数据：2022 年住户存款增加 17.84 万亿元、M2 增长 11.8%（人民银行 2022 年金融统计）；GDP 增长 3.0%（国家统计局 2022 年统计公报）。
垫乐：publisher/bgm/614.mp3。用发布机的虚拟环境跑（要 edge-tts / patchright）：
  ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py            # 出 out/econ-flow.mp4
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
VOICE, RATE = "zh-CN-YunxiNeural", "+4%"
VO_OFF = 0.35
BGM = ROOT / "publisher" / "bgm" / "614.mp3"
# (场景 id, 配音, 配音后留多久)；数字写成汉字，配音念得准；不要用全角分号「；」，edge-tts 遇到它会不出声
SCENES = [
    ("s0", "疫情那几年，钱明明没少，经济却变差了。底层的人没钱了，为什么整个社会的钱都转不动了？", 0.7),
    ("s1", "先记住一句话：你花出去的每一块钱，都是别人的收入。", 0.7),
    ("s2", "比如一张一百块：外卖小哥拿去吃面，面馆老板拿去理发，理发师拿去买菜，菜贩又拿去打车。", 0.6),
    ("s3", "同一张一百块，转了五手，就给大家创造了五百块收入。经济有多大，不看有多少钱，看钱转了多少手。", 0.9),
    ("s4", "谁转得最快？底层的人。月薪三千，到手就交房租、买菜，几乎全花掉，有钱人多赚一万，大部分存进银行。", 0.7),
    ("s5", "疫情一来，餐馆、商场、旅游都停了。最先没收入的，正是外卖员、服务员、小商贩，这些花钱最快的人。", 0.7),
    ("s6", "他们没钱就不敢花，面馆没了客人就裁员，被裁的人更不敢花。一环断了，后面的收入一起消失。", 0.9),
    ("s7", "那钱去哪了？钱没消失，而是躺在存款里不动了。大家都怕，有钱也先存着。", 0.7),
    ("s8", "看数据：二零二二年，全国住户存款一年多了十七点八万亿元，创下纪录。钱的总量增长百分之十一点八，经济只增长了百分之三。钱多了，转得却慢了。", 1.0),
    ("s9", "所以反直觉的地方在这里：经济不是看池子里有多少水，而是看水流得多快。底层的人，就是水流最快的那一段。", 0.9),
    ("s10", "这也是为什么疫情时，很多地方直接发钱、发消费券：把钱交到最会花的人手里，转起来，经济才能活过来。", 0.9),
    ("s11", "一句话：钱要流动，才是收入。", 3.0),
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
    ins, parts = ["-i", str(silent), "-i", str(BGM)], []
    for k, sc in enumerate(tl["scenes"]):
        ins += ["-i", str(OUT / f"vo-{sc['id']}.mp3")]
        ms = int((sc["start"] + sc["vo"]) * 1000)
        parts.append(f"[{k + 2}:a]adelay={ms}|{ms},volume=1.6[v{k}]")
    n = len(tl["scenes"])
    vo = "".join(f"[v{k}]" for k in range(n))
    fc = ";".join(parts) + f";{vo}amix=inputs={n}:normalize=0:dropout_transition=0[vo];" \
         f"[1:a]aloop=loop=-1:size=2e9,atrim=0:{total:.2f},volume=0.16,afade=t=in:d=0.6,afade=t=out:st={total - 2.5:.2f}:d=2.5[bg];" \
         f"[vo][bg]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-14:TP=-1.5:LRA=11[a]"
    out = OUT / "econ-flow.mp4"
    run_ffmpeg([*ins, "-filter_complex", fc, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
    return out


if __name__ == "__main__":
    tl = build_timeline()
    print("total", tl["total"], "s;", [(s["id"], s["dur"]) for s in tl["scenes"]])
    if "--preview" in sys.argv:
        pts = []
        for s in tl["scenes"]:
            pts += [s["start"] + s["dur"] * f for f in (0.35, 0.95)]
        render(tl, pts)
        print("preview done")
    else:
        out = mix(tl, render(tl))
        print("mixed", out, media_duration(out))
