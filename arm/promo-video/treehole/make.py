"""心之音树洞 → 电影感短片（横屏 1920x1080，参考 E:\\soft\\aichat\\kw.mp4 的风格：黑底暖光、宋体金字、竖排古文 + 红印、粒子意象、底部字幕）。

素材：树洞 #163（2026-10-11，Telegram 同步，商场门口地推请人帮忙下载应用、嫌手机差、反过来说教）。地名去掉了。
垫乐不用现成音乐：ffmpeg 合成一段低沉的氛围音（out/pad.wav）。
  ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py            # 出 out/treehole-163.mp4
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
W, H, FPS = 1920, 1080, 30
VOICE, RATE = "zh-CN-YunxiNeural", "-8%"
VO_OFF = 0.6
# (场景 id, 配音, 配音后留多久)；不要用全角分号「；」（edge-tts 遇到会不出声）
SCENES = [
    ("k0", "有人说：帮忙是情分，不帮是本分。", 1.2),
    ("k1", "前几天，有人在商场门口被拦下，对方请他用自己的手机，帮忙下载一个应用。", 0.7),
    ("k2", "他等了二十多分钟，换来的却是一句：你这手机牌子不行。还被反问：你朋友为什么就不能好好等？", 0.9),
    ("k3", "他在树洞里写下：让别人帮忙，不说一句谢谢，还要阴阳别人，到底是怎么想的？", 1.1),
    ("k4", "其实我们每个人，都可能是那个开口求人的人，也可能是那个被为难的人。", 0.9),
    ("k5", "两千多年前，孔子说：己所不欲，勿施于人。", 1.4),
    ("k6", "子夏也说：君子敬而无失，与人恭而有礼。", 1.4),
    ("k7", "求人的时候，先说一声谢谢。被拒绝的时候，也要记得，别人从来不欠你。", 1.1),
    ("k8", "分寸感，是一个人最好的教养。", 1.8),
    ("k9", "心之音树洞。每一份心事，都值得被听见。", 2.8),
]
SUB_MAX = 20


def chunks(text: str) -> list[tuple[int, int]]:
    out, start = [], 0
    for m in re.finditer(r"[，。：、！？,.]", text):
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


def voice(sid: str, text: str) -> tuple[float, list[float]]:
    """synthesise once per line (cached with its timings); the speech service drops bursts, so retry with a pause"""
    mp3, meta = OUT / f"vo-{sid}.mp3", OUT / f"vo-{sid}.json"
    if mp3.exists() and mp3.stat().st_size > 0 and meta.exists():
        m = json.loads(meta.read_text(encoding="utf-8"))
        if m.get("text") == text and m.get("voice") == [VOICE, RATE]:
            return m["dur"], m["ct"]
    for attempt in range(5):
        try:
            dur, ct, _ = tts.synth(text, mp3, voice=VOICE, rate=RATE)
            meta.write_text(json.dumps({"text": text, "voice": [VOICE, RATE], "dur": dur, "ct": ct}, ensure_ascii=False), encoding="utf-8")
            return dur, ct
        except Exception as e:  # edge_tts.NoAudioReceived when throttled
            print(f"tts {sid} attempt {attempt + 1}: {type(e).__name__}, retrying", flush=True)
            time.sleep(6 * (attempt + 1))
    raise RuntimeError(f"tts failed for {sid}")


def build_timeline() -> dict:
    OUT.mkdir(exist_ok=True)
    scenes, subs, t = [], [], 0.0
    for i, (sid, text, tail) in enumerate(SCENES):
        dur, ct = voice(sid, text)
        sdur = VO_OFF + dur + tail
        scenes.append({"id": sid, "start": round(t, 3), "dur": round(sdur, 3), "vo": VO_OFF, "text": text, "ct": [round(x, 3) for x in ct], "last": i == len(SCENES) - 1})
        cs = chunks(text)
        for j, (a, b) in enumerate(cs):
            t1 = ct[cs[j + 1][0]] if j + 1 < len(cs) else dur + 0.3
            subs.append({"t0": round(t + VO_OFF + ct[a], 3), "t1": round(t + VO_OFF + t1, 3), "text": text[a:b].strip()})
        t += sdur
    tl = {"fps": FPS, "total": round(t, 3), "scenes": scenes, "subs": subs}
    (OUT / "timeline.js").write_text("window.TL = " + json.dumps(tl, ensure_ascii=False) + ";\n", encoding="utf-8")
    return tl


def pad(total: float) -> Path:
    """a slow, dark A-minor drone (no third-party music)"""
    out = OUT / "pad.wav"
    expr = ("0.10*sin(2*PI*55*t)*(0.8+0.2*sin(2*PI*0.07*t))"
            "+0.07*sin(2*PI*110*t)*(0.7+0.3*sin(2*PI*0.11*t))"
            "+0.05*sin(2*PI*164.81*t)*(0.6+0.4*sin(2*PI*0.05*t))"
            "+0.035*sin(2*PI*220*t)*(0.5+0.5*sin(2*PI*0.09*t+1))"
            "+0.025*sin(2*PI*261.63*t)*(0.5+0.5*sin(2*PI*0.06*t+2))")
    run_ffmpeg(["-f", "lavfi", "-i", f"aevalsrc={expr}:s=44100:d={total + 1:.2f}",
                "-af", "lowpass=f=900,aecho=0.8:0.85:600|900:0.35|0.25,afade=t=in:d=3", str(out)])
    return out


def render(tl: dict, preview: list[float] | None = None) -> Path:
    from patchright.sync_api import sync_playwright

    silent = OUT / "video.mp4"
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, channel="chromium", args=["--allow-file-access-from-files"])
        page = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        page.goto((HERE / "promo.html").as_uri(), wait_until="load")
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(1000)
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
    ins, parts = ["-i", str(silent), "-i", str(pad(total))], []
    for k, sc in enumerate(tl["scenes"]):
        ins += ["-i", str(OUT / f"vo-{sc['id']}.mp3")]
        ms = int((sc["start"] + sc["vo"]) * 1000)
        parts.append(f"[{k + 2}:a]adelay={ms}|{ms},volume=1.5[v{k}]")
    n = len(tl["scenes"])
    vo = "".join(f"[v{k}]" for k in range(n))
    fc = ";".join(parts) + f";{vo}amix=inputs={n}:normalize=0:dropout_transition=0[vo];" \
         f"[1:a]atrim=0:{total:.2f},volume=0.9,afade=t=out:st={total - 3:.2f}:d=3[bg];" \
         f"[vo][bg]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-15:TP=-1.5:LRA=11[a]"
    out = OUT / "treehole-163.mp4"
    run_ffmpeg([*ins, "-filter_complex", fc, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
    return out


if __name__ == "__main__":
    tl = build_timeline()
    print("total", tl["total"], "s;", [(s["id"], s["dur"]) for s in tl["scenes"]])
    if "--preview" in sys.argv:
        pts = []
        for s in tl["scenes"]:
            pts += [s["start"] + s["dur"] * f for f in (0.4, 0.92)]
        render(tl, pts)
        print("preview done")
    else:
        out = mix(tl, render(tl))
        print("mixed", out, media_duration(out))
