"""币圈简史短片（竖屏 1080x1920）：比特币对数价格曲线随年份推进 + 各时代卡片 + 新闻男声配音 + 鼓点 BGM。

history.html 写画面，这里配音 → 算时间轴 → 逐帧截图 → 合成。
用发布机的虚拟环境跑：
  ..\\..\\publisher\\.venv\\Scripts\\python.exe make.py            # 出 out/crypto-history.mp4
  ..\\..\\publisher\\.venv\\Scripts\\python.exe make.py --preview  # 只截关键帧到 out/prev-*.jpg
  ..\\..\\publisher\\.venv\\Scripts\\python.exe make.py --mix      # 只重新混音
配乐沿用 arm/promo-video/out/bgm.mp3（Mixkit「Epical Drums 01」，免版权），out/ 不进 git。
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PUB = ROOT / "publisher"
sys.path.insert(0, str(PUB))
from video import tts  # noqa: E402
from video.common import ffmpeg, media_duration, run_ffmpeg  # noqa: E402

OUT = HERE / "out"
FPS = 30
VOICE = "zh-CN-YunyangNeural"
RATE = "+10%"
VO_OFF = 0.45
BGM_SRC = ROOT / "arm" / "promo-video" / "out" / "bgm.mp3"
# (场景 id, 配音, 配音后留多久)；价格 / 时间点截至 2026-09-30
SCENES = [
    ("s0", "从一张白皮书，到三万亿美元。币圈这十七年，到底发生了什么？", 0.8),
    ("s1", "2008年，中本聪发布比特币白皮书。2010年，有人用一万个比特币，换了两块披萨。", 0.8),
    ("s2", "2013年，比特币第一次突破1000美元。第二年，门头沟交易所倒闭，85万个比特币不翼而飞。", 0.8),
    ("s3", "2017年，ICO狂潮。一份白皮书就能募资上亿，比特币逼近2万美元。那是散户的黄金年代，懂的人少，早进就能赚。", 0.9),
    ("s4", "2018年，泡沫破裂。比特币跌掉八成，无数项目归零。", 0.8),
    ("s5", "2020年，DeFi之夏。2021年，NFT和Meme币全面出圈，比特币突破6万9千美元。", 0.8),
    ("s6", "2022年，Luna几天归零，FTX一夜暴雷，行业信任跌到冰点。", 0.8),
    ("s7", "2024年，比特币现货ETF获批，华尔街正式入场。2025年，比特币最高冲到12万6千美元。", 0.8),
    ("s8", "而今天，比特币在8万4千美元附近徘徊。ETF累计净流入超过570亿美元，真正在买的，是机构。", 0.9),
    ("s9", "为什么没有17年好挣了？信息差没了；一发射就有机器人抢跑；VC币上所就是顶；拼的是资金、信息和速度。", 1.0),
    ("s10", "但这扇门从来没有关上。不需要谁批准，就能发币、建站、收款。机会，从炒，变成了做。", 1.2),
    ("s11", "十七年，从自由之地，到成熟市场。你是哪一年入圈的？评论区聊聊。", 3.5),
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
        for attempt in range(4):
            try:
                dur, ct, _ = tts.synth(text, mp3, voice=VOICE, rate=RATE)
                break
            except Exception:  # noqa: BLE001  代理时通时断，edge-tts 偶尔收不到音频
                if attempt == 3:
                    raise
                time.sleep(3)
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
        page.goto((HERE / "history.html").as_uri(), wait_until="load")
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(500)
        # patchright 默认在隔离环境里 evaluate，看不到页面自己的 seek
        kind = page.evaluate("typeof window.seek", isolated_context=False)
        if kind != "function":
            raise RuntimeError(f"history.html 的脚本没跑起来（seek 是 {kind}）")
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
    bgm = OUT / "bgm.mp3"
    if not bgm.exists():
        shutil.copy(BGM_SRC, bgm)
    ins, parts = ["-i", str(silent), "-stream_loop", "-1", "-i", str(bgm)], []
    for k, sc in enumerate(tl["scenes"]):
        ins += ["-i", str(OUT / f"vo-{sc['id']}.mp3")]
        ms = int((sc["start"] + sc["vo"]) * 1000)
        parts.append(f"[{k + 2}:a]adelay={ms}|{ms},volume=1.6[v{k}]")
    n = len(tl["scenes"])
    vo = "".join(f"[v{k}]" for k in range(n))
    fc = ";".join(parts) + f";{vo}amix=inputs={n}:normalize=0:dropout_transition=0,apad[vo];" \
         f"[1:a]volume=0.26,afade=t=in:d=0.5,afade=t=out:st={total - 3:.2f}:d=3[bg];[vo][bg]amix=inputs=2:normalize=0:duration=shortest,loudnorm=I=-14:TP=-1.5:LRA=11[a]"
    out = OUT / "crypto-history.mp4"
    run_ffmpeg([*ins, "-filter_complex", fc, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
    return out


if __name__ == "__main__":
    if "--mix" in sys.argv:
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
        out = mix(tl, silent)
        print("done", out, media_duration(out))
