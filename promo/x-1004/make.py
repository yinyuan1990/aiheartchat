"""两条发 X 的竖屏短片（1080x1920，约 50 秒，男声配音 + 字幕 + 鼓点 BGM），数据截至 2026-10-04 傍晚：
  meme：今日 meme 速报（GM 8 小时 1.2 亿、假基金叙事、zipcoin、pump 每分钟 32 个新币、追涨前看什么）
  arc ：Circle 的 Arc 主网 18 天（TVL 5.6 亿、Morpho 5 亿存款、cirBTC、21X、Centrifuge 机构基金、Arm 发币和小游戏）

画面是 meme.html / arc.html，这里配音 → 算时间轴 → 逐帧截图 → 合成（照 promo/crypto-history/make.py）。
用发布机的虚拟环境跑：
  ..\\..\\publisher\\.venv\\Scripts\\python.exe make.py meme            # 出 out/meme/meme-1004.mp4
  ..\\..\\publisher\\.venv\\Scripts\\python.exe make.py arc --preview   # 只截关键帧到 out/arc/prev-*.jpg
  ..\\..\\publisher\\.venv\\Scripts\\python.exe make.py meme --mix      # 只重新混音
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

FPS = 30
VOICE = "zh-CN-YunjianNeural"
RATE = "+15%"
VO_OFF = 0.3
BGM_SRC = ROOT / "arm" / "promo-video" / "out" / "bgm.mp3"
SUB_MAX = 14

# (场景 id, 配音, 配音后留多久)
VIDEOS = {
    # 数据：GeckoTerminal（BSC / 以太坊）、pump.fun（Solana），2026-10-04 19:00 前后抓取
    "meme": [
        ("s0", "10月4号，今天最疯的meme币，30秒带你看完。", 0.4),
        ("s1", "BSC上的GM，上线8个小时，市值冲到1.2亿美元，一天涨了将近5000倍。", 0.5),
        ("s2", "但它的池子，只有200万美元。一个亿的市值，两百万的流动性，真想卖，根本卖不动。", 0.6),
        ("s3", "Solana上在炒假基金：世界石油信托基金，4天1.59亿；全球石油机构基金，1100万；连先锋领航都被做成了币，不到3个小时，540万。", 0.5),
        ("s4", "以太坊上，zipcoin一天涨了184%，市值3300万。", 0.4),
        ("s5", "pump.fun现在每分钟发32个新币，一天就是四万多个。", 0.5),
        ("s6", "热点换得比翻书还快。追之前，先看三样：池子有多深，筹码在谁手里，是谁在喊单。", 0.6),
        ("s7", "关注我，每天一条meme速报。数据仅供参考，不构成投资建议。", 2.5),
    ],
    # 数据：Circle 官方博客、Crypto Briefing（Morpho 10.2）、Chainwire（21X 10.1）、The Chain Observer（Centrifuge）、DefiLlama（TVL）
    "arc": [
        ("s0", "Circle的公链Arc，主网上线才18天，钱已经开始往里冲了。", 0.4),
        ("s1", "链上锁仓，已经到了5.6亿美元。", 0.5),
        ("s2", "光Morpho一家，两周多存款就破了5亿，借出去1.9亿；其中86%，是拿比特币抵押，借USDC。", 0.6),
        ("s3", "背后是Circle刚推出的cirBTC：一比一锚定比特币，Circle信托托管，Chainlink链上证明储备。", 0.5),
        ("s4", "传统金融也来了。欧盟持牌的代币化证券平台21X，成了Arc首发合作伙伴，用USDC原子结算，不到1秒。", 0.5),
        ("s5", "Centrifuge把骏利亨德森的美债基金、AAA级CLO，还有纽约人寿的高收益债，搬上了Arc。", 0.5),
        ("s6", "机构在Arc上做金融，那普通人在Arc上玩什么？", 0.5),
        ("s7", "来Arm：在Arc上一键发币、买卖，还有快艇、赛车、射击小游戏，赚BOAT。关注我，持续跟踪Arc。", 2.5),
    ],
}
# 「念到这个词时红闪震屏」在 html 里配；字幕按中文标点切


def chunks(text: str) -> list[tuple[int, int]]:
    out, start = [], 0
    for m in re.finditer(r"[，。：、！？；]", text):
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


def build_timeline(name: str, out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    scenes, subs, t = [], [], 0.0
    spec = VIDEOS[name]
    for i, (sid, text, tail) in enumerate(spec):
        mp3 = out / f"vo-{sid}.mp3"
        for attempt in range(4):
            try:
                dur, ct, _ = tts.synth(text, mp3, voice=VOICE, rate=RATE)
                break
            except Exception:  # noqa: BLE001  代理时通时断，edge-tts 偶尔收不到音频
                if attempt == 3:
                    raise
                time.sleep(3)
        sdur = VO_OFF + dur + tail
        scenes.append({"id": sid, "start": round(t, 3), "dur": round(sdur, 3), "vo": VO_OFF, "voDur": dur, "text": text, "ct": [round(x, 3) for x in ct], "last": i == len(spec) - 1})
        cs = chunks(text)
        for j, (a, b) in enumerate(cs):
            t0 = t + VO_OFF + ct[a]
            t1 = t + VO_OFF + (ct[cs[j + 1][0]] if j + 1 < len(cs) else dur + 0.2)
            subs.append({"t0": round(t0, 3), "t1": round(t1, 3), "text": text[a:b].strip()})
        t += sdur
    tl = {"fps": FPS, "total": round(t, 3), "scenes": scenes, "subs": subs}
    (out / "timeline.js").write_text("window.TL = " + json.dumps(tl, ensure_ascii=False) + ";\n", encoding="utf-8")
    (out / "timeline.json").write_text(json.dumps(tl, ensure_ascii=False, indent=1), encoding="utf-8")
    return tl


def render(name: str, out: Path, tl: dict, preview: list[float] | None = None) -> Path:
    from patchright.sync_api import sync_playwright

    silent = out / "video.mp4"
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, channel="chromium")
        page = b.new_page(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
        page.goto((HERE / f"{name}.html").as_uri(), wait_until="load")
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(800)
        kind = page.evaluate("typeof window.seek", isolated_context=False)
        if kind != "function":
            raise RuntimeError(f"{name}.html 的脚本没跑起来（seek 是 {kind}）")
        if preview:
            for x in preview:
                page.evaluate(f"seek({x})", isolated_context=False)
                page.screenshot(path=str(out / f"prev-{x:05.1f}.jpg"), type="jpeg", quality=85)
            b.close()
            return out
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


def mix(name: str, out: Path, tl: dict, silent: Path) -> Path:
    total = tl["total"]
    bgm = out / "bgm.mp3"
    if not bgm.exists():
        shutil.copy(BGM_SRC, bgm)
    ins, parts = ["-i", str(silent), "-stream_loop", "-1", "-i", str(bgm)], []
    for k, sc in enumerate(tl["scenes"]):
        ins += ["-i", str(out / f"vo-{sc['id']}.mp3")]
        ms = int((sc["start"] + sc["vo"]) * 1000)
        parts.append(f"[{k + 2}:a]adelay={ms}|{ms},volume=1.6[v{k}]")
    n = len(tl["scenes"])
    vo = "".join(f"[v{k}]" for k in range(n))
    fc = ";".join(parts) + f";{vo}amix=inputs={n}:normalize=0:dropout_transition=0,apad[vo];" \
         f"[1:a]volume=0.26,afade=t=in:d=0.5,afade=t=out:st={total - 3:.2f}:d=3[bg];[vo][bg]amix=inputs=2:normalize=0:duration=shortest,loudnorm=I=-14:TP=-1.5:LRA=11[a]"
    final = out / f"{name}-1004.mp4"
    run_ffmpeg([*ins, "-filter_complex", fc, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(final)])
    return final


if __name__ == "__main__":
    name = next((a for a in sys.argv[1:] if a in VIDEOS), None)
    if not name:
        sys.exit(f"用法：make.py {'|'.join(VIDEOS)} [--preview|--mix]")
    out = HERE / "out" / name
    if "--mix" in sys.argv:
        tl = json.loads((out / "timeline.json").read_text(encoding="utf-8"))
        print("mixed", mix(name, out, tl, out / "video.mp4"))
        sys.exit(0)
    tl = build_timeline(name, out)
    print("total", tl["total"], "s;", [(s["id"], s["dur"]) for s in tl["scenes"]])
    if "--preview" in sys.argv:
        pts = []
        for s in tl["scenes"]:
            pts += [s["start"] + s["dur"] * 0.35, s["start"] + s["dur"] * 0.9]
        render(name, out, tl, pts)
        print("preview done")
    else:
        silent = render(name, out, tl)
        final = mix(name, out, tl, silent)
        print("done", final, media_duration(final))
