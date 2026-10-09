"""心之音 App 介绍视频（竖屏 1080x1920）：promo.html 写动画场景，这里配音 → 算时间轴 → 逐帧截图 → 合成。

素材（不进 git）：assets/ 里的真实界面截图由 arm/web/scripts/_heart-promo-assets.mjs（心之音网页版，三个测试账号）和
_heart-promo-wallet.mjs（Arm 钱包，公开测试助记词，只读）生成；游戏片段从三款游戏的宣传视频里截（prep_clips）。
用发布机的虚拟环境跑（要 edge-tts / patchright）：
  ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py            # 出 out/heartchat-promo.mp4
  ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py --preview  # 只截关键帧到 out/prev-*.jpg
  ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe make.py --mix      # 只重新混音
配乐沿用 Arm 宣传片的 Mixkit「Epical Drums 01」（免版权，../out/bgm.mp3）。
英文版（英文配音 + 英文字幕带中文翻译）：加 --en，素材用 assets-en/（两个素材脚本加环境变量 LANG_EN=1 生成），输出 out-en/heartchat-promo-en.mp4。
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
ROOT = HERE.parents[2]
PUB = ROOT / "publisher"
sys.path.insert(0, str(PUB))
from video import tts  # noqa: E402
from video.common import ffmpeg, media_duration, run_ffmpeg  # noqa: E402

EN = "--en" in sys.argv
OUT = HERE / ("out-en" if EN else "out")
ASSETS = HERE / "assets"
FPS = 30
VOICE = "en-US-AndrewNeural" if EN else "zh-CN-YunyangNeural"
RATE = "+4%" if EN else "+6%"
VO_OFF = 0.4
# (场景 id, 配音, 配音后留多久)；旁白里不写 $，免得念成「美元」
SCENES = [
    ("s0", "心之音。一个 App，把社交、娱乐和 Web3，连成完整的商业闭环。", 0.8),
    ("s1", "聊天，是一切的起点。文字、相册、语音，消息秒达，已读一目了然。", 0.6),
    ("s2", "群聊把人聚在一起。兴趣群、币种讨论群、语音房，社区在这里生长。", 0.6),
    ("s3", "一对一高清视频，按分钟计费。主播自主定价，平台按分钟抽成，每一分钟都是收入。", 0.7),
    ("s4", "内置 Web3 自托管钱包，私钥只在你手里。多条公链的资产和行情，一键兑换，还能直接做链上合约。", 0.7),
    ("s4m", "钱包里还能买美股代币，用 AI 模型聊天、生图、做视频，闲置的 USDC 存进去，自动生息。", 0.7),
    ("s5", "小游戏边玩边赚。快艇、赛车、射击、盖楼，赢到的 BOAT 币可以提现，也能在钱包里交易。", 0.7),
    ("s6", "看好的币，一键喊单到群里。行情实时可见，群友点开就能买，合约仓位也能喊单跟单。", 0.7),
    ("s6s", "发过币就能在 Arm 开店卖东西。买家买入等值代币，或者直接付 USDC，商品还能一键喊单到店铺群。", 0.7),
    ("s7", "社交带来流量，视频和礼物带来收入，钱包承接资产，游戏、喊单和商城带来链上交易，交易又把用户带回社交。这就是心之音的商业闭环。", 1.2),
    ("s8", "心之音，遇见有趣的人，也遇见更大的世界。", 3.2),
]
# English cut: subtitle-sized pieces with their Chinese translation; the voice reads the pieces joined.
# promo.html's AT_EN maps each Chinese cue word to a word in these English lines.
SCENES_EN = [
    ("s0", [("HeartChat.", "心之音。"), ("One app that links social, entertainment and Web3", "一个 App，把社交、娱乐和 Web3"), ("into one complete business loop.", "连成完整的商业闭环。")], 0.8),
    ("s1", [("Chat is where it all starts.", "聊天，是一切的起点。"), ("Text, photo albums and voice,", "文字、相册、语音"), ("delivered instantly, with read receipts.", "消息秒达，已读一目了然。")], 0.6),
    ("s2", [("Groups bring people together.", "群聊把人聚在一起。"), ("Interest groups, coin chats and voice rooms:", "兴趣群、币种讨论群、语音房"), ("this is where communities grow.", "社区在这里生长。")], 0.6),
    ("s3", [("One-on-one HD video, billed by the minute.", "一对一高清视频，按分钟计费。"), ("Hosts set their own price,", "主播自主定价"), ("and the platform takes a cut of every minute.", "平台按分钟抽成，每一分钟都是收入。")], 0.7),
    ("s4", [("A built-in self-custody Web3 wallet:", "内置 Web3 自托管钱包"), ("your keys stay with you.", "私钥只在你手里。"), ("Assets across many chains with live prices,", "多条公链的资产和行情"), ("one-tap swaps, and on-chain perps.", "一键兑换，还能直接做链上合约。")], 0.7),
    ("s4m", [("The wallet also has tokenized US stocks,", "钱包里还能买美股代币"), ("AI models for chat, images and video,", "用 AI 模型聊天、生图、做视频"), ("and idle USDC that earns interest on its own.", "闲置的 USDC 存进去，自动生息。")], 0.7),
    ("s5", [("Mini games that pay.", "小游戏边玩边赚。"), ("Speedboat, racing, shooting and tower building:", "快艇、赛车、射击、盖楼"), ("the BOAT you win can be cashed out or traded in the wallet.", "赢到的 BOAT 币可以提现，也能在钱包里交易。")], 0.7),
    ("s6", [("Like a coin? Call it out to your group in one tap.", "看好的币，一键喊单到群里。"), ("Live prices for everyone,", "行情实时可见"), ("friends tap and buy,", "群友点开就能买"), ("and perp positions can be called and copied too.", "合约仓位也能喊单跟单。")], 0.7),
    ("s6s", [("Launched a token? Open a shop on Arm.", "发过币就能在 Arm 开店卖东西。"), ("Buyers pay by buying the same value of your token,", "买家买入等值代币"), ("or in USDC,", "或者直接付 USDC"), ("and every item can be called out to your shop group.", "商品还能一键喊单到店铺群。")], 0.7),
    ("s7", [("Social brings traffic,", "社交带来流量"), ("video and gifts bring revenue,", "视频和礼物带来收入"), ("the wallet holds the assets,", "钱包承接资产"), ("games, calls and shops drive on-chain trading,", "游戏、喊单和商城带来链上交易"),
            ("and trading brings people back to social.", "交易又把用户带回社交。"), ("That's the HeartChat business loop.", "这就是心之音的商业闭环。")], 1.2),
    ("s8", [("HeartChat.", "心之音。"), ("Meet interesting people,", "遇见有趣的人"), ("and a bigger world.", "也遇见更大的世界。")], 3.2),
]
if EN:
    SCENES = [(sid, " ".join(e for e, _ in parts), tail) for sid, parts, tail in SCENES_EN]
SUB_MAX = 15
# (名字, 源视频, 从第几秒开始, 截几秒)
CLIPS = [
    ("race", ROOT / "arm/ops/.tmp/race-video/arm-bridge-rush.mp4", 14.0, 3.0),
    ("shoot", ROOT / "arm/ops/.tmp/shoot-video/neon-strike-fruit.mp4", 6.0, 3.0),
    ("tower", ROOT / "arm/ops/.tmp/tower-video/tower-building.mp4", 10.0, 4.0),
]


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


def prep_clips() -> dict:
    """游戏片段 → 手机屏幕比例（390:844）的 jpg 序列，assets/clips/<名字>/0001.jpg…"""
    counts = {}
    for name, src, ss, dur in CLIPS:
        d = ASSETS / "clips" / name
        if not d.exists() or not any(d.iterdir()):
            d.mkdir(parents=True, exist_ok=True)
            run_ffmpeg(["-ss", str(ss), "-t", str(dur), "-i", str(src), "-vf", f"fps={FPS},crop='ih*390/844':ih,scale=780:1688", "-q:v", "3", str(d / "%04d.jpg")])
        counts[name] = len(list(d.glob("*.jpg")))
    return counts


def build_timeline() -> dict:
    OUT.mkdir(exist_ok=True)
    scenes, subs, t = [], [], 0.0
    for i, (sid, text, tail) in enumerate(SCENES):
        mp3 = OUT / f"vo-{sid}.mp3"
        dur, ct, _ = tts.synth(text, mp3, voice=VOICE, rate=RATE)
        sdur = VO_OFF + dur + tail
        scenes.append({"id": sid, "start": round(t, 3), "dur": round(sdur, 3), "vo": VO_OFF, "voDur": dur, "text": text, "ct": [round(x, 3) for x in ct], "last": i == len(SCENES) - 1})
        if EN:
            # one subtitle per piece, English over Chinese, from where the voice starts it to where the next one starts
            parts, at, starts = dict((s, p) for s, p, _ in SCENES_EN)[sid], 0, []
            for en, _ in parts:
                k = text.index(en, at)
                starts.append(ct[k])
                at = k + len(en)
            for j, (en, zh) in enumerate(parts):
                t1 = starts[j + 1] if j + 1 < len(parts) else dur + 0.2
                subs.append({"t0": round(t + VO_OFF + starts[j], 3), "t1": round(t + VO_OFF + t1, 3), "text": en, "zh": zh})
        else:
            cs = chunks(text)
            for j, (a, b) in enumerate(cs):
                t0 = t + VO_OFF + ct[a]
                t1 = t + VO_OFF + (ct[cs[j + 1][0]] if j + 1 < len(cs) else dur + 0.2)
                subs.append({"t0": round(t0, 3), "t1": round(t1, 3), "text": text[a:b].strip()})
        t += sdur
    tl = {"fps": FPS, "total": round(t, 3), "scenes": scenes, "subs": subs, "clips": prep_clips(), "lang": "en" if EN else "zh", "assets": "assets-en" if EN else "assets"}
    (OUT / "timeline.js").write_text("window.TL = " + json.dumps(tl, ensure_ascii=False) + ";\n", encoding="utf-8")
    (OUT / "timeline.json").write_text(json.dumps(tl, ensure_ascii=False, indent=1), encoding="utf-8")
    return tl


def render(tl: dict, preview: list[float] | None = None) -> Path:
    from patchright.sync_api import sync_playwright

    silent = OUT / "video.mp4"
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, channel="chromium", args=["--allow-file-access-from-files"])
        page = b.new_page(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
        page.goto((HERE / "promo.html").as_uri() + f"?tl={OUT.name}", wait_until="load")
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(800)
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
    bgm = OUT / "bgm.mp3"
    if not bgm.exists():
        shutil.copy(HERE.parent / "out" / "bgm.mp3", bgm)
    ins, parts = ["-i", str(silent), "-i", str(bgm)], []
    for k, sc in enumerate(tl["scenes"]):
        ins += ["-i", str(OUT / f"vo-{sc['id']}.mp3")]
        ms = int((sc["start"] + sc["vo"]) * 1000)
        parts.append(f"[{k + 2}:a]adelay={ms}|{ms},volume=1.6[v{k}]")
    n = len(tl["scenes"])
    vo = "".join(f"[v{k}]" for k in range(n))
    fc = ";".join(parts) + f";{vo}amix=inputs={n}:normalize=0:dropout_transition=0[vo];" \
         f"[1:a]aloop=loop=-1:size=2e9,atrim=0:{total:.2f},volume=0.3,afade=t=in:d=0.6,afade=t=out:st={total - 2.5:.2f}:d=2.5[bg];" \
         f"[vo][bg]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-14:TP=-1.5:LRA=11[a]"
    out = OUT / ("heartchat-promo-en.mp4" if EN else "heartchat-promo.mp4")
    run_ffmpeg([*ins, "-filter_complex", fc, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
    return out


if __name__ == "__main__":
    if "--mix" in sys.argv:
        tl = json.loads((OUT / "timeline.json").read_text(encoding="utf-8"))
        print("mixed", mix(tl, OUT / "video.mp4"))
        sys.exit(0)
    tl = build_timeline()
    print("total", tl["total"], "s;", [(s["id"], s["dur"]) for s in tl["scenes"]], tl["clips"])
    if "--preview" in sys.argv:
        pts = []
        for s in tl["scenes"]:
            pts += [s["start"] + s["dur"] * 0.3, s["start"] + s["dur"] * 0.65, s["start"] + s["dur"] * 0.95]
        render(tl, pts)
        print("preview done")
    else:
        silent = render(tl)
        out = mix(tl, silent)
        print("mixed", out, media_duration(out))
