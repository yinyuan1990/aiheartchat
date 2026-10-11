"""树洞流水线：自动把心之音树洞的新帖做成「情感密码」短片（横屏 1920x1080），不用 AI，零 token。

拉帖：心之音公开接口 GET https://app.yyheart.com/api/app/treehole/<id>（分享页用的，匿名、不用登录），
     从上次处理到的编号往后逐个取，连续取不到 MISS_STOP 个就停（out/batch-state.json 记住进度）。
过滤：BLOCK 里的词一律跳过（性 / 死 / 自残 / 暴力等），太短跳过，太长截到 MAX_CHARS；REPLACE 换掉地名、人名缩写等。
默认不配音：帖子一句句显示在画面上，每句按字数停 2.2～5.5 秒；加 --voice 才念原文（Yunxi）。画面：batch.html（kw.mp4 风格模板）。
默认没有声音（留一条静音音轨，有的平台不收没音轨的视频）；加 --music 才垫 assets/kw-music.wav（从 E:\\soft\\aichat\\kw.mp4 去掉居中人声提出来的背景音乐）。

  ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe batch.py                 # 处理新帖
  ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe batch.py --ids 163,162   # 指定编号（不改进度）
  ..\\..\\..\\publisher\\.venv\\Scripts\\python.exe batch.py --from 150      # 从 150 号开始往后
  加 --preview 只截几张关键帧；加 --limit 3 最多做 3 条
出片：out/th-<编号>.mp4；跳过的原因写在 out/batch-log.txt。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "publisher"))
from video import tts  # noqa: E402
from video.common import ffmpeg, run_ffmpeg  # noqa: E402

OUT = HERE / "out"
API = "https://app.yyheart.com/api/app/treehole/{}"
STATE = OUT / "batch-state.json"
MUSIC = HERE / "assets" / "kw-music.wav"
W, H, FPS = 1920, 1080, 30
VOICE, RATE = "zh-CN-YunxiNeural", "-6%"
SERIES = "情感密码"
MIN_CHARS, MAX_CHARS, CHUNK = 30, 460, 26
MISS_STOP = 6
# 含这些词的帖子不做（平台审核过不了，或者不适合配音念出来）
BLOCK = ["性生", "性爱", "性关系", "性生活", "做爱", "约炮", "嫖", "遗精", "打飞机", "自慰", "射了", "胸", "屁股", "裸", "强奸", "鸡巴",
         "去死", "死了就好", "弄死", "杀了", "砍死", "自杀", "跳楼", "割腕", "毒品", "吸毒"]
# 原文里要换掉的词（地名、具体商家、人名缩写等）
REPLACE = {"太原公元时代城大门口": "商场门口", "公元时代城": "商场"}
# 情绪大字：帖子里先出现哪个词就用哪个字
MOODS = [("恨", "恨"), ("报应", "报"), ("烦", "烦"), ("委屈", "屈"), ("哭", "泪"), ("累", "累"), ("分手", "离"), ("离开", "离"),
         ("想你", "念"), ("爱", "爱"), ("孤独", "独"), ("钱", "钱"), ("情商", "礼"), ("帮忙", "礼"), ("邻居", "邻"), ("家", "家")]


def log(msg: str) -> None:
    print(msg, flush=True)
    with open(OUT / "batch-log.txt", "a", encoding="utf-8") as f:
        f.write(time.strftime("%m-%d %H:%M ") + msg + "\n")


def fetch(pid: int) -> dict | None:
    try:
        with urllib.request.urlopen(API.format(pid), timeout=15) as r:
            j = json.loads(r.read().decode("utf-8"))
        return j.get("data") if j.get("code") == 0 and j.get("data") else None
    except Exception:
        return None


def clean(text: str) -> str:
    t = re.sub(r"https?://\S+|t\.me/\S+|@\w+", "", text)
    t = re.sub(r"[\U00010000-\U0010ffff\u2600-\u27bf\ufe0f\u200d]", "", t)  # emoji
    for a, b in REPLACE.items():
        t = t.replace(a, b)
    t = t.replace("；", "，").replace(";", "，")  # edge-tts goes silent on full-width semicolons
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in t.splitlines()]
    t = "。".join(ln.rstrip("。，,.!！?？") for ln in lines if ln)
    t = re.sub(r"\s*([，。！？、：])\s*", r"\1", t)
    if not re.search(r"[。！？…]$", t):
        t += "。"
    if len(t) > MAX_CHARS:
        cut = max(t.rfind(p, 0, MAX_CHARS) for p in "。！？")
        t = t[: cut + 1 if cut > MIN_CHARS else MAX_CHARS] + "……"
    return t


def chunks(text: str) -> list[tuple[int, int]]:
    """display pieces: sentences, long ones split at commas, none longer than CHUNK + a few"""
    out, start = [], 0
    for m in re.finditer(r"[。！？…]+", text):
        out.append((start, m.end()))
        start = m.end()
    if start < len(text):
        out.append((start, len(text)))
    res = []
    for a, b in out:
        while b - a > CHUNK + 4:
            cut = max(text.rfind(p, a + 6, a + CHUNK + 1) for p in "，、：,")
            cut = cut + 1 if cut > a else a + CHUNK
            res.append((a, cut))
            a = cut
        if b > a:
            res.append((a, b))
    return [(a, b) for a, b in res if text[a:b].strip("。，！？… ")]


def mood(text: str) -> str:
    hits = [(text.find(w), ch) for w, ch in MOODS if w in text]
    return min(hits)[1] if hits else "心"


def voice(key: str, text: str) -> tuple[float, list[float], Path]:
    """cached per text; the speech service drops bursts, so retry with a pause"""
    mp3, meta = OUT / f"vo-{key}.mp3", OUT / f"vo-{key}.json"
    if mp3.exists() and mp3.stat().st_size > 0 and meta.exists():
        m = json.loads(meta.read_text(encoding="utf-8"))
        if m.get("text") == text and m.get("voice") == [VOICE, RATE]:
            return m["dur"], m["ct"], mp3
    for attempt in range(6):
        try:
            dur, ct, _ = tts.synth(text, mp3, voice=VOICE, rate=RATE)
            meta.write_text(json.dumps({"text": text, "voice": [VOICE, RATE], "dur": dur, "ct": ct}, ensure_ascii=False), encoding="utf-8")
            time.sleep(2)
            return dur, ct, mp3
        except Exception as e:
            log(f"  tts {key} attempt {attempt + 1}: {type(e).__name__}")
            time.sleep(8 * (attempt + 1))
    raise RuntimeError(f"tts failed: {key}")


def line_secs(s: str) -> float:
    """how long a line stays up when nothing is read aloud"""
    return min(5.5, max(2.2, 1.4 + 0.17 * len(s)))


def timeline(post: dict, text: str, read_aloud: bool, music: bool) -> dict:
    pid = int(post["id"])
    date = str(post.get("createdAt") or post.get("created_at") or "")[:10]
    parts = chunks(text)
    body0 = 0.9
    if read_aloud:
        db, cb, vb = voice(f"th{pid}", text)
        body = [{"t": round(body0 + cb[a], 3), "text": text[a:b]} for a, b in parts]
        outro0 = body0 + db + 1.4
        voices = [[str(vb), body0]]
    else:
        body, t = [], body0
        for a, b in parts:
            body.append({"t": round(t, 3), "text": text[a:b]})
            t += line_secs(text[a:b])
        outro0 = t + 0.4
        voices = []
    total = outro0 + 5.2
    return {
        "id": pid, "date": date, "mood": mood(text), "series": SERIES, "total": round(total, 3),
        "body": {"t0": round(body0 - 0.5, 3), "t1": round(outro0 - 0.2, 3), "chunks": body},
        "outro": {"t": round(outro0, 3)},
        "voices": voices,
        "music": music,
    }


def render(tl: dict, out: Path, preview: bool) -> None:
    from patchright.sync_api import sync_playwright

    silent = OUT / f"th-{tl['id']}-silent.mp4"
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, channel="chromium", args=["--allow-file-access-from-files"])
        page = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        (OUT / "tl.js").write_text("window.TL = " + json.dumps(tl, ensure_ascii=False) + ";\n", encoding="utf-8")
        page.goto((HERE / "batch.html").as_uri(), wait_until="load")
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(1000)
        if preview:
            body = tl["body"]["chunks"]
            pts = [1.5, *(c["t"] + 1.2 for c in body[:: max(1, len(body) // 4)]), tl["outro"]["t"] + 2]
            for x in pts:
                page.evaluate(f"seek({x})", isolated_context=False)
                page.screenshot(path=str(OUT / f"th-{tl['id']}-prev-{x:05.1f}.jpg"), type="jpeg", quality=85)
            b.close()
            return
        n = int(tl["total"] * FPS)
        proc = subprocess.Popen([ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "-",
                                 "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", str(silent)], stdin=subprocess.PIPE)
        for i in range(n):
            page.evaluate(f"seek({i / FPS})", isolated_context=False)
            proc.stdin.write(page.screenshot(type="jpeg", quality=90))
        proc.stdin.close()
        proc.wait()
        b.close()
    total = tl["total"]
    if not tl["voices"] and not tl["music"]:
        # no sound at all, but keep a silent track: some platforms refuse videos without audio
        run_ffmpeg(["-i", str(silent), "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-map", "0:v", "-map", "1:a", "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "64k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
        silent.unlink(missing_ok=True)
        return
    ins, parts = ["-i", str(silent), "-stream_loop", "-1", "-i", str(MUSIC)], []
    music = f"[1:a]atrim=0:{total:.2f},afade=t=in:d=1.5,afade=t=out:st={total - 3:.2f}:d=3" + ("" if tl["music"] else ",volume=0")
    if tl["voices"]:
        for k, (path, at) in enumerate(tl["voices"]):
            ins += ["-i", path]
            ms = int(at * 1000)
            parts.append(f"[{k + 2}:a]adelay={ms}|{ms},volume=1.5[v{k}]")
        vo = "".join(f"[v{k}]" for k in range(len(tl["voices"])))
        fc = ";".join(parts) + f";{vo}amix=inputs={len(tl['voices'])}:normalize=0:dropout_transition=0[vo];" \
             f"{music},volume=0.55[bg];[vo][bg]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-15:TP=-1.5:LRA=11[a]"
    else:
        # music only: the post is read on screen
        fc = f"{music},loudnorm=I=-15:TP=-1.5:LRA=11[a]"
    run_ffmpeg([*ins, "-filter_complex", fc, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
    silent.unlink(missing_ok=True)


def make(pid: int, preview: bool, read_aloud: bool = False, music: bool = False) -> bool:
    post = fetch(pid)
    if not post:
        return False
    raw = post.get("content") or ""
    bad = [w for w in BLOCK if w in raw]
    text = clean(raw)
    if bad:
        log(f"skip #{pid}: blocked words {bad}")
        return True
    if len(text) < MIN_CHARS:
        log(f"skip #{pid}: too short ({len(text)} chars)")
        return True
    out = OUT / f"th-{pid}.mp4"
    tl = timeline(post, text, read_aloud, music)
    log(f"make #{pid}: {len(text)} chars, {len(tl['body']['chunks'])} lines, {tl['total']:.0f}s, mood {tl['mood']}")
    render(tl, out, preview)
    if not preview:
        log(f"done #{pid} → {out.name}")
    return True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids")
    ap.add_argument("--from", dest="start", type=int)
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--voice", action="store_true", help="read the post aloud (default: no voice, text on screen)")
    ap.add_argument("--music", action="store_true", help="add the kw background music (default: silent)")
    a = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    if a.music and not MUSIC.exists():
        sys.exit("assets/kw-music.wav missing: ffmpeg -i kw.mp4 -vn -af \"pan=stereo|c0=c0-c1|c1=c1-c0,highpass=f=50,loudnorm=I=-20\" assets/kw-music.wav")
    if a.ids:
        for pid in [int(x) for x in a.ids.split(",") if x.strip()][: a.limit]:
            if not make(pid, a.preview, a.voice, a.music):
                log(f"skip #{pid}: not found / hidden")
        sys.exit(0)
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {"last": 0}
    pid, miss, done = (a.start - 1 if a.start else state["last"]), 0, 0
    while miss < MISS_STOP and done < a.limit:
        pid += 1
        if make(pid, a.preview, a.voice, a.music):
            miss = 0
            done += 1
            if not a.preview:
                state["last"] = pid
                STATE.write_text(json.dumps(state), encoding="utf-8")
        else:
            miss += 1
    log(f"batch end: {done} handled, last #{state['last']}")
