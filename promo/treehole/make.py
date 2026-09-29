"""私密树洞宣传短片（竖屏 1080x1920，给抖音）：情绪空镜背景 + 信纸卡片逐字打出心事 + 男 / 女声配音 + 钢琴 BGM。

不出现 App 名 / 心之音 / 下载 / 微信（小红书冻号就是冲着品牌导流来的），只推「树洞」这个主题，引导评论区互动。
用发布机的虚拟环境跑：..\\..\\publisher\\.venv\\Scripts\\python.exe make.py [--preview]
产物 out/treehole-promo.mp4（out/ 不进 git）。
"""
from __future__ import annotations

import json
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
FOOT = PUB / "footage"
FPS = 30
XF = 0.6
VO_OFF = 0.4
F, M = "xiaoxiao", "yunxi"
RATE = "-4%"
# 心事摘自树洞里浏览最高的几条（删减到一两句，不带可识别信息）
SCENES = [
    dict(id="s0", kind="line", voice=F, text="这些话，他们从没对身边的人说过。", lines=["这些话", "他们从没对身边的人说过"], bg="rain-window/20311.mp4", tail=0.8),
    dict(id="n1", kind="note", voice=F, header="匿名 · 凌晨 1:24", rot=-1.2, text="我到现在还留着他送的那条项链，有时候，睡觉会戴着。", bg="night-city/41375.mp4", tail=0.9),
    dict(id="n2", kind="note", voice=F, header="匿名 · 23:47", rot=1.0, text="他有女朋友，我知道。可我还是把他给我点的那杯奶茶，拍照存了下来。", bg="window/22511.mp4", tail=0.9),
    dict(id="n3", kind="note", voice=M, header="匿名 · 凌晨 0:12", rot=-0.8, text="工资降了百分之二十，老婆还不知道。有两个晚上我没加班，在地下车库坐着抽烟，不敢回家。", bg="city-lights/41161.mp4", tail=0.9),
    dict(id="n4", kind="note", voice=M, header="匿名 · 凌晨 2:05", rot=1.3, text="她半夜哭，说觉得自己像个保姆。我不是不爱了，是不知道怎么爱了。", bg="candle/17426.mp4", tail=0.9),
    dict(id="n5", kind="note", voice=F, header="匿名 · 凌晨 3:31", rot=-1.0, text="在别人眼里，我什么事都一笑而过。可是压着的事越来越多，我也会难受。", bg="rain-window/28085.mp4", tail=0.9),
    dict(id="s6", kind="line", voice=F, text="有些话，不能对朋友说，也不敢对家人说。", lines=["有些话", "不能对朋友说", "也不敢对家人说"], bg="night-city/42048.mp4", tail=0.8),
    dict(id="s7", kind="title", voice=F, text="那就，说给树洞听。", bg="candle/41762.mp4", tail=1.6),
    dict(id="s8", kind="end", voice=F, text="评论区，说说你的心事吧", slogan="爱情与金钱无关，和内心相连", bg="night/4148.mp4", tail=3.0),
]
BGM = PUB / "bgm" / "587.mp3"


def build_timeline() -> dict:
    OUT.mkdir(exist_ok=True)
    scenes, t = [], 0.0
    for i, s in enumerate(SCENES):
        mp3 = OUT / f"vo-{s['id']}.mp3"
        for attempt in range(4):
            try:
                dur, ct, _ = tts.synth(s["text"], mp3, voice=s["voice"], rate=RATE)
                break
            except Exception:  # noqa: BLE001  代理时通时断，edge-tts 偶尔收不到音频
                if attempt == 3:
                    raise
                time.sleep(3)
        sdur = VO_OFF + dur + s["tail"]
        scenes.append({**s, "start": round(t, 3), "dur": round(sdur, 3), "vo": VO_OFF, "ct": [round(x, 3) for x in ct], "last": i == len(SCENES) - 1})
        t += sdur
    tl = {"total": round(t, 3), "scenes": scenes}
    (OUT / "timeline.js").write_text("window.TL = " + json.dumps(tl, ensure_ascii=False) + ";\n", encoding="utf-8")
    (OUT / "timeline.json").write_text(json.dumps(tl, ensure_ascii=False, indent=1), encoding="utf-8")
    return tl


def background(tl: dict) -> Path:
    """每个场景一段空镜：压暗 + 轻模糊，场景之间交叉淡化"""
    sc = tl["scenes"]
    n = len(sc)
    ins, fs = [], []
    for i, s in enumerate(sc):
        ln = s["dur"] + (XF if i < n - 1 else 0)
        ins += ["-stream_loop", "-1", "-t", f"{ln:.3f}", "-i", str(FOOT / s["bg"])]
        fs.append(f"[{i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps={FPS},"
                  f"eq=brightness=-0.10:saturation=0.75,gblur=sigma=3,setsar=1,format=yuv420p[b{i}]")
    prev, acc = "b0", 0.0
    for i in range(1, n):
        acc += sc[i - 1]["dur"]
        fs.append(f"[{prev}][b{i}]xfade=transition=fade:duration={XF}:offset={acc:.3f}[x{i}]")
        prev = f"x{i}"
    out = OUT / "bg.mp4"
    run_ffmpeg([*ins, "-filter_complex", ";".join(fs), "-map", f"[{prev}]", "-t", f"{tl['total']:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", str(out)])
    return out


def render(tl: dict, bg: Path | None, preview: list[float] | None = None) -> Path:
    from patchright.sync_api import sync_playwright

    silent = OUT / "video.mp4"
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, channel="chromium")
        page = b.new_page(viewport={"width": 1080, "height": 1920})
        page.goto((HERE / "treehole.html").as_uri(), wait_until="load")
        page.evaluate("document.fonts.ready")
        kind = page.evaluate("typeof window.seek", isolated_context=False)
        if kind != "function":
            raise RuntimeError(f"treehole.html 的脚本没跑起来（seek 是 {kind}）")
        if preview:
            for x in preview:
                page.evaluate(f"seek({x})", isolated_context=False)
                page.screenshot(path=str(OUT / f"ov-{x:05.1f}.png"), omit_background=True)
            b.close()
            return OUT
        n = int(tl["total"] * FPS)
        proc = subprocess.Popen([ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(bg), "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "png", "-i", "-",
                                 "-filter_complex", "[0:v][1:v]overlay=format=auto,format=yuv420p[v]", "-map", "[v]",
                                 "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-t", f"{tl['total']:.3f}", str(silent)], stdin=subprocess.PIPE)
        t0 = time.time()
        for i in range(n):
            page.evaluate(f"seek({i / FPS})", isolated_context=False)
            proc.stdin.write(page.screenshot(omit_background=True))
            if i % 300 == 0:
                print(f"frame {i}/{n}  {time.time() - t0:.0f}s", flush=True)
        proc.stdin.close()
        proc.wait()
        b.close()
    return silent


def mix(tl: dict, silent: Path) -> Path:
    total = tl["total"]
    ins, parts = ["-i", str(silent), "-stream_loop", "-1", "-i", str(BGM)], []
    for k, s in enumerate(tl["scenes"]):
        ins += ["-i", str(OUT / f"vo-{s['id']}.mp3")]
        ms = int((s["start"] + s["vo"]) * 1000)
        parts.append(f"[{k + 2}:a]adelay={ms}|{ms}[v{k}]")
    n = len(tl["scenes"])
    fc = ";".join(parts) + ";" + "".join(f"[v{k}]" for k in range(n)) + f"amix=inputs={n}:normalize=0:dropout_transition=0[vo];" \
         f"[1:a]volume=0.22,afade=t=in:d=1.5,afade=t=out:st={total - 3:.2f}:d=3[bg];[vo][bg]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-14:TP=-1.5:LRA=11[a]"
    out = OUT / "treehole-promo.mp4"
    run_ffmpeg([*ins, "-filter_complex", fc, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
    return out


if __name__ == "__main__":
    tl = build_timeline()
    print("total", tl["total"], [(s["id"], s["dur"]) for s in tl["scenes"]])
    if "--preview" in sys.argv:
        render(tl, None, [s["start"] + s["dur"] * 0.8 for s in tl["scenes"]])
        print("preview done")
    else:
        bg = background(tl)
        silent = render(tl, bg)
        out = mix(tl, silent)
        print("done", out, media_duration(out))
