"""Sell the Top promo (vertical, for X): record one real round on the live site → narrate on its timeline → ffmpeg.

python demo-video/game-video.py [all|rec|compose]
"""
import asyncio, base64, json, re, subprocess, sys, time
from pathlib import Path

import edge_tts
from playwright.async_api import async_playwright

ROOT = Path(__file__).parent
OUT = ROOT / "build" / "game"
URL = "https://arm.yyheart.com/game?lang=en"
VOICE = "en-US-AriaNeural"
VW, VH, DPR = 432, 768, 2.5
W, H = int(VW * DPR), int(VH * DPR)
GAP = 0.25
BAND = 280  # caption band over the site header + ticker (device px)

INTRO = [
    ("Every Arc meme coin has a top. Can you sell it?",),
    ("One real launch a day. You're the first retail buyer, and the dev and the bots are already in.",),
]
PLAY = [("The first hour plays in 45 seconds. You get one tap.", "The first hour plays in forty-five seconds. You get one tap.")]
REVEAL = [("Then the whole hour is revealed: where the top was, and how the insiders did.",)]
OUTRO = [("It's free. No token, no gas, no prizes. Just a daily board, and your squares to share.",)]
END = [("New round every day at arm.yyheart.com/game", "New round every day, at arm dot Y Y heart dot com, slash game.")]

PREFS_JS = """
try { localStorage.setItem('arm.theme', 'terminal'); localStorage.setItem('arm.locale', 'en'); } catch {}
addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('style');
  s.textContent = 'button.fixed.right-3.bottom-20 { display: none !important; }';
  document.head.appendChild(s);
});
"""
TAP_JS = """
(() => {
  addEventListener('pointerdown', (e) => {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:${e.clientX - 26}px;top:${e.clientY - 26}px;width:52px;height:52px;border-radius:50%;` +
      'background:rgba(255,255,255,.35);border:2px solid rgba(255,255,255,.8);z-index:2147483647;pointer-events:none;' +
      'transition:transform .45s ease-out,opacity .45s ease-out;';
    document.documentElement.appendChild(d);
    requestAnimationFrame(() => { d.style.transform = 'scale(1.8)'; d.style.opacity = '0'; });
    setTimeout(() => d.remove(), 500);
  }, true);
})();
"""


def run(*args, cwd=None):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, cwd=cwd)


def duration(p: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


async def say(name: str, lines) -> dict:
    """One wav per line group → {"wav", "dur", "cues": [(start, end, text)]} relative to the group start."""
    parts, cues, t = [], [], 0.0
    silence = OUT / "gap.wav"
    if not silence.exists():
        run("ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", str(GAP), str(silence))
    for i, line in enumerate(lines):
        disp, spoken = line[0], line[-1]
        mp3 = OUT / f"{name}_{i}.mp3"
        await edge_tts.Communicate(spoken, VOICE, rate="+4%").save(str(mp3))
        wav = mp3.with_suffix(".wav")
        run("ffmpeg", "-y", "-i", str(mp3), "-ar", "24000", "-ac", "1", str(wav))
        d = duration(wav)
        cues.append((t, t + d, disp))
        parts += [wav, silence]
        t += d + GAP
    lst = OUT / f"{name}_list.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in parts[:-1]), encoding="utf-8")
    wav = OUT / f"{name}.wav"
    run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(wav))
    return {"wav": str(wav), "dur": duration(wav), "cues": cues}


def num(s: str):
    m = re.search(r"(\d+(?:\.\d+)?)x", s or "")
    return float(m.group(1)) if m else None


async def record(intro_dur: float) -> dict:
    """Playwright's own recorder captures CSS pixels only, so frames come from a device-pixel CDP screencast."""
    vdir = OUT / "rec"
    vdir.mkdir(exist_ok=True)
    for old in vdir.glob("*.jpg"):
        old.unlink()
    frames: list[tuple[float, Path]] = []
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="msedge", args=["--no-proxy-server"])
        ctx = await b.new_context(viewport={"width": VW, "height": VH}, device_scale_factor=DPR, is_mobile=True, has_touch=True,
                                  locale="en-US", color_scheme="dark")
        await ctx.add_init_script(PREFS_JS)
        await ctx.add_init_script(TAP_JS)
        pg = await ctx.new_page()
        await pg.goto(URL, wait_until="load", timeout=60000)
        await pg.get_by_role("button", name="Start").wait_for(timeout=30000)
        cdp = await ctx.new_cdp_session(pg)

        def on_frame(ev):
            f = vdir / f"{len(frames):05}.jpg"
            f.write_bytes(base64.b64decode(ev["data"]))
            frames.append((ev["metadata"]["timestamp"], f))
            asyncio.ensure_future(cdp.send("Page.screencastFrameAck", {"sessionId": ev["sessionId"]}))

        cdp.on("Page.screencastFrame", on_frame)
        await cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": W, "maxHeight": H, "everyNthFrame": 1})
        await pg.wait_for_timeout(2500)
        mark = {"begin": time.time()}
        await pg.wait_for_timeout(int((intro_dur + 0.4) * 1000))

        mark["start"] = time.time()
        await pg.get_by_role("button", name="Start").click()
        price = pg.locator("div.font-mono.text-4xl").first
        sell = pg.get_by_role("button", name="SELL")
        await sell.wait_for(timeout=15000)
        top, deadline = 0.0, time.monotonic() + 60
        while time.monotonic() < deadline:
            x = num(await price.inner_text()) if await price.count() else None
            if x is None:
                break
            top = max(top, x)
            # sell into strength: near the old high, or on the first real pullback once it has run
            if x >= 2.3 or (top >= 1.8 and x < top * 0.92):
                await sell.click()
                break
            await pg.wait_for_timeout(40)
        mark["sold"] = time.time()
        await pg.get_by_role("link", name="Share on X").wait_for(timeout=60000)
        mark["result"] = time.time()
        info = await pg.evaluate("""() => {
          const x = document.querySelector('div.font-mono.text-5xl');
          return { persona: x?.previousElementSibling?.textContent ?? '', x: x?.textContent ?? '',
                   key: Object.keys(localStorage).filter(k => k.startsWith('arm-game:')).map(k => JSON.parse(localStorage.getItem(k)).id)[0] ?? null };
        }""")
        await pg.wait_for_timeout(9000)
        mark["scroll"] = time.time()
        share = pg.get_by_role("link", name="Share on X")
        y = await share.evaluate("e => e.getBoundingClientRect().bottom + scrollY - innerHeight + 40")
        await pg.evaluate(f"window.scrollTo({{top:{max(0, y)},behavior:'smooth'}})")
        await pg.wait_for_timeout(9000)
        mark["end"] = time.time()
        await cdp.send("Page.stopScreencast")
        await ctx.close()
        await b.close()
    # variable-rate screencast → constant 30 fps; marks become seconds from the first frame
    t0 = frames[0][0]
    lst = vdir / "frames.txt"
    lst.write_text("".join(f"file '{f.name}'\nduration {max(0.001, (frames[i + 1][0] if i + 1 < len(frames) else ts + 0.5) - ts):.4f}\n"
                           for i, (ts, f) in enumerate(frames)) + f"file '{frames[-1][1].name}'\n", encoding="utf-8")
    video = OUT / "rec.mp4"
    run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", "frames.txt", "-vf", f"scale={W}:{H},fps=30,format=yuv420p",
        "-c:v", "libx264", "-crf", "16", "-preset", "fast", str(video), cwd=vdir)
    print("frames", len(frames), "fps", round(len(frames) / (frames[-1][0] - t0), 1))
    return {"video": str(video), "mark": {k: v - t0 for k, v in mark.items()}, **info}


def ass_time(t: float) -> str:
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02}:{cs // 100 % 60:02}.{cs % 100:02}"


def write_ass(cues, path: Path):
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,0,8,60,60,{BAND // 2 - 66},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    body = "".join(f"Dialogue: 0,{ass_time(s)},{ass_time(e)},Default,,0,0,0,,{txt}\n" for s, e, txt in cues)
    path.write_text(head + body, encoding="utf-8")


async def compose(rec: dict):
    m = rec["mark"]
    base = m["begin"]
    persona, x = rec.get("persona", "").strip(), rec.get("x", "").strip()
    result_line = [(f"{persona}: sold at {x}.",)] if persona and x else [("Sold.",)]
    groups = [
        ("intro", INTRO, 0.3),
        ("play", PLAY, m["start"] - base + 0.4),
        ("result", result_line + REVEAL, m["result"] - base + 0.5),
        ("outro", OUTRO, m["scroll"] - base + 0.3),
    ]
    # lay the narration on the recording's timeline; a group never starts before the previous one ends
    seq, cues, cur = [], [], 0.0
    for name, lines, at in groups:
        g = await say(name, lines)
        at = max(at, cur + 0.2)
        if at > cur:
            sil = OUT / f"sil_{name}.wav"
            run("ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", f"{at - cur:.3f}", str(sil))
            seq.append(sil)
        seq.append(Path(g["wav"]))
        cues += [(at + s, at + e, t) for s, e, t in g["cues"]]
        cur = at + g["dur"]
    main_len = min(cur + 0.8, m["end"] - base)
    lst = OUT / "main_list.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in seq), encoding="utf-8")
    run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(OUT / "main.wav"))

    vf = f"scale={W}:{H}:flags=lanczos,fps=30,format=yuv420p"
    run("ffmpeg", "-y", "-ss", f"{base:.2f}", "-i", rec["video"], "-i", str(OUT / "main.wav"), "-t", f"{main_len:.2f}",
        "-vf", vf + f",drawbox=x=0:y=0:w=iw:h={BAND}:color=0x050505@1:t=fill,fade=t=out:st={main_len - 0.4:.2f}:d=0.4", "-c:v", "libx264", "-crf", "18", "-preset", "slow",
        "-c:a", "aac", "-b:a", "160k", "-af", "apad", "-map", "0:v", "-map", "1:a", str(OUT / "clip_main.mp4"))
    t_end = duration(OUT / "clip_main.mp4")

    run("node", str(ROOT / "game-endcard.cjs"), str(OUT / "endcard.png"))
    e = await say("end", END)
    run("ffmpeg", "-y", "-loop", "1", "-t", f"{e['dur'] + 1.2:.2f}", "-i", str(OUT / "endcard.png"), "-i", e["wav"],
        "-vf", vf + ",fade=t=in:st=0:d=0.4", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-c:a", "aac", "-b:a", "160k",
        "-af", "adelay=300:all=1,apad", "-shortest", str(OUT / "clip_end.mp4"))
    cues += [(t_end + 0.3 + s, t_end + 0.3 + en, t) for s, en, t in e["cues"]]

    (OUT / "clips.txt").write_text("file 'clip_main.mp4'\nfile 'clip_end.mp4'\n", encoding="utf-8")
    run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", "clips.txt", "-c", "copy", "joined.mp4", cwd=OUT)
    write_ass(cues, OUT / "subs.ass")
    final = ROOT / "sell-the-top.mp4"
    run("ffmpeg", "-y", "-i", "joined.mp4", "-vf", "subtitles=subs.ass", "-c:v", "libx264", "-crf", "20", "-preset", "slow",
        "-c:a", "copy", "-movflags", "+faststart", str(final), cwd=OUT)
    print("done", final, round(duration(final), 1), "s")


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    stage = sys.argv[1] if len(sys.argv) > 1 else "all"
    meta = OUT / "rec.json"
    if stage in ("all", "rec"):
        intro = await say("intro", INTRO)
        rec = await record(intro["dur"])
        meta.write_text(json.dumps(rec), encoding="utf-8")
        print("rec", json.dumps({k: v for k, v in rec.items() if k != "key"}))
    if stage in ("all", "compose"):
        await compose(json.loads(meta.read_text(encoding="utf-8")))


asyncio.run(main())
