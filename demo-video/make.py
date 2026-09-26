"""Arm demo video: edge-tts narration per sentence → Playwright scene recordings timed to the audio → ffmpeg."""
import asyncio, json, subprocess, sys, time
from pathlib import Path

import edge_tts
from playwright.async_api import async_playwright

ROOT = Path(__file__).parent
OUT = ROOT / "build"
BASE = "https://arm.yyheart.com"
TOKEN = "0xc22290cBCa56ef218f6cE28CDB1e4BC0016c5416"
LAUNCH_TX = "0x4ce9e93b4c38a26b87cbc13be8d5e96b76b36dbbfc97ceec0cb6b0ac27dcaad6"
LOGO = "https://arm.yyheart.com/api/uploads/0d17108c9c203325f9d6ebc04f678d31.png"
VOICE = "en-US-AriaNeural"
W, H = 1440, 810
GAP = 0.3

# (display, spoken) — spoken defaults to display
SCENES = [
    ("home", [
        ("This is Arm, a free meme token launchpad built natively on Arc mainnet.",),
        ("Every token trades against USDC, and gas is paid in USDC too.",),
        ("So there is no separate gas token to buy.",),
    ]),
    ("create", [
        ("Launching takes a single transaction.",),
        ("Pick a name, a symbol, a description and a logo. There is no creation fee.",),
        ("The factory mints the token, opens a Uniswap V3 pool against USDC, and locks the liquidity forever.",),
    ]),
    ("token", [
        ("Here is Arc Cat, which we just launched on Arc mainnet.",),
        ("Price, market cap, the chart and every trade are indexed from on-chain events in real time.",),
        ("The launch buy is already in the trade list.",),
    ]),
    ("fees", [
        ("The core idea: 78% of the 1% pool fee goes to the creator.",
         "The core idea: seventy-eight percent of the one percent pool fee goes to the creator."),
        ("Forever, before and after graduation, collected automatically by a fee locker contract.",),
    ]),
    ("promote", [
        ("To grow without a marketing budget, creators can share up to half of their fees with promoters.",),
        ("Anyone can share a referral link and earn USDC on the volume they bring.",),
    ]),
    ("arcscan", [
        ("Every launch is a plain on-chain transaction you can verify, and the contracts are open source on GitHub.",),
    ]),
    ("end", [
        ("Arm is live today at arm.yyheart.com. Launch your meme on Arc.",
         "Arm is live today at arm dot Y Y heart dot com. Launch your meme on Arc."),
    ]),
]

CURSOR_JS = """
(() => {
  const init = () => {
    if (document.getElementById('__cur')) return;
    const c = document.createElement('div'); c.id = '__cur';
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-4px 0 0 -4px;z-index:2147483647;pointer-events:none;transition:transform .08s linear;';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
"""


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def duration(p: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


async def tts():
    """→ {scene: {"wav": path, "dur": s, "cues": [(start, end, text)]}}"""
    meta = {}
    for name, lines in SCENES:
        if ONLY and name not in ONLY:
            continue
        parts, cues, t = [], [], 0.0
        for i, line in enumerate(lines):
            disp, spoken = line[0], line[-1]
            mp3 = OUT / f"{name}_{i}.mp3"
            await edge_tts.Communicate(spoken, VOICE, rate="-4%").save(str(mp3))
            d = duration(mp3)
            cues.append((t, t + d, disp))
            parts.append(mp3)
            t += d + GAP
        lst = OUT / f"{name}_list.txt"
        silence = OUT / "gap.wav"
        if not silence.exists():
            run("ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r=24000:cl=mono", "-t", str(GAP), str(silence))
        seq = []
        for p in parts:
            wav = p.with_suffix(".wav")
            run("ffmpeg", "-y", "-i", str(p), "-ar", "24000", "-ac", "1", str(wav))
            seq += [wav, silence]
        lst.write_text("".join(f"file '{s.name}'\n" for s in seq), encoding="utf-8")
        wav = OUT / f"{name}.wav"
        run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(wav))
        meta[name] = {"wav": str(wav), "dur": duration(wav), "cues": cues}
        print("tts", name, round(meta[name]["dur"], 2))
    return meta


async def glide(pg, x, y, steps=25):
    await pg.mouse.move(x, y, steps=steps)


async def smooth_scroll(pg, y, ms=1200):
    await pg.evaluate(f"window.scrollTo({{top:{y},behavior:'smooth'}})")
    await pg.wait_for_timeout(ms)


async def scene_actions(name, pg, dur):
    t_end = time.monotonic() + dur

    async def hold():
        left = t_end - time.monotonic()
        if left > 0:
            await pg.wait_for_timeout(int(left * 1000))

    if name == "home":
        await glide(pg, 700, 300)
        await pg.wait_for_timeout(1500)
        await glide(pg, 420, 600)
        await pg.wait_for_timeout(1200)
        await glide(pg, 620, 600)
        await pg.wait_for_timeout(1200)
        await smooth_scroll(pg, 330, 1800)
        await glide(pg, 900, 500)
        await pg.wait_for_timeout(1500)
        await smooth_scroll(pg, 0, 1500)
    elif name == "create":
        name_in = pg.get_by_placeholder("Arc Cat")
        await glide(pg, 400, 250)
        await name_in.click()
        await name_in.press_sequentially("Arc Cat", delay=110)
        await pg.wait_for_timeout(600)
        sym = pg.get_by_placeholder("ACAT")
        await sym.click()
        await sym.fill("")
        await sym.press_sequentially("ACAT", delay=110)
        desc = pg.get_by_placeholder("The first cat on Arc…")
        await desc.click()
        await desc.fill("")
        await desc.press_sequentially("The first cat on Arc. Sunglasses on, gas paid in USDC.", delay=35)
        url = pg.get_by_placeholder("https://…/logo.png")
        await url.click()
        await url.fill(LOGO)
        await pg.wait_for_timeout(1500)
        box = await pg.get_by_text("You earn forever").bounding_box()
        if box:
            await glide(pg, box["x"] + 60, box["y"] + 40)
        await pg.wait_for_timeout(1500)
        await smooth_scroll(pg, 380, 1800)
    elif name == "token":
        await glide(pg, 550, 520)
        await pg.wait_for_timeout(1500)
        await glide(pg, 800, 560)
        await pg.wait_for_timeout(1500)
        await smooth_scroll(pg, 520, 1800)
        box = await pg.get_by_role("cell", name="Buy").first.bounding_box() if await pg.get_by_role("cell", name="Buy").count() else None
        if box:
            await glide(pg, box["x"] + 20, box["y"] + 10)
    elif name == "fees":
        amt = pg.locator("input[placeholder='0.00']").first
        if await amt.count():
            await glide(pg, 1050, 200)
            await amt.click()
            await amt.press_sequentially("5", delay=150)
        await pg.wait_for_timeout(1800)
        box = await pg.get_by_text("Creator share").first.bounding_box()
        if box:
            await smooth_scroll(pg, max(0, box["y"] - 360), 1200)
            box = await pg.get_by_text("Creator share").first.bounding_box()
            await glide(pg, box["x"] + 250, box["y"] + 8)
    elif name == "promote":
        await glide(pg, 520, 280)
        await pg.wait_for_timeout(2500)
        await glide(pg, 900, 530)
        await pg.wait_for_timeout(2000)
        await glide(pg, 1000, 575)
    elif name == "arcscan":
        await glide(pg, 700, 400)
        await pg.wait_for_timeout(1200)
        eng = pg.locator("article h2", has_text="English").first
        y = await eng.evaluate("e => e.getBoundingClientRect().top + scrollY - 90") if await eng.count() else 700
        await smooth_scroll(pg, y, 2200)
        await glide(pg, 600, 500)
    await hold()


async def record(meta):
    urls = {
        "home": f"{BASE}/?lang=en",
        "create": f"{BASE}/create?lang=en",
        "token": f"{BASE}/token/{TOKEN}?lang=en",
        "fees": f"{BASE}/token/{TOKEN}?lang=en",
        "promote": f"{BASE}/promote?lang=en",
        "arcscan": "https://github.com/yinyuan1990/arn",
    }
    async with async_playwright() as p:
        direct = await p.chromium.launch(channel="msedge", args=["--no-proxy-server"])
        proxied = None
        for name, url in urls.items():
            if ONLY and name not in ONLY:
                continue
            vdir = OUT / f"rec_{name}"
            for old in vdir.glob("*.webm"):
                old.unlink()
            b = direct
            if "github.com" in url:
                proxied = proxied or await p.chromium.launch(channel="msedge", proxy={"server": "socks5://127.0.0.1:10808"})
                b = proxied
            ctx = await b.new_context(viewport={"width": W, "height": H}, locale="en-US", record_video_dir=str(vdir), record_video_size={"width": W, "height": H})
            await ctx.add_init_script(CURSOR_JS)
            t0 = time.monotonic()
            pg = await ctx.new_page()
            await pg.goto(url, wait_until="load", timeout=60000)
            await pg.wait_for_timeout(4000)
            await pg.mouse.move(W / 2, H / 2)
            start = time.monotonic() - t0
            await scene_actions(name, pg, meta[name]["dur"] + 0.3)
            await ctx.close()
            webm = next(vdir.glob("*.webm"))
            meta[name]["video"] = str(webm)
            meta[name]["start"] = start
            print("rec", name, round(start, 2))
        await direct.close()
        if proxied:
            await proxied.close()


def srt_time(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"


def compose(meta):
    clips, cues, t = [], [], 0.0
    for name, _ in SCENES:
        m = meta[name]
        clip = OUT / f"clip_{name}.mp4"
        vf = f"scale=1920:1080:flags=lanczos,fps=30,format=yuv420p"
        if name == "end":
            run("ffmpeg", "-y", "-loop", "1", "-t", str(m["dur"] + 0.8), "-i", str(ROOT / "endcard.png"), "-i", m["wav"],
                "-vf", vf + ",fade=t=in:st=0:d=0.5", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-c:a", "aac", "-b:a", "160k", "-af", "apad", "-shortest", str(clip))
        else:
            run("ffmpeg", "-y", "-ss", f"{m['start']:.2f}", "-i", m["video"], "-i", m["wav"], "-t", f"{m['dur'] + 0.3:.2f}",
                "-vf", vf, "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-c:a", "aac", "-b:a", "160k", "-af", "apad", "-map", "0:v", "-map", "1:a", str(clip))
        for s, e, txt in m["cues"]:
            cues.append((t + s, t + e, txt))
        t += duration(clip)
        clips.append(clip)
    (OUT / "clips.txt").write_text("".join(f"file '{c.name}'\n" for c in clips), encoding="utf-8")
    raw = OUT / "joined.mp4"
    run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(OUT / "clips.txt"), "-c", "copy", str(raw))
    srt = OUT / "subs.srt"
    srt.write_text("".join(f"{i + 1}\n{srt_time(s)} --> {srt_time(e)}\n{txt}\n\n" for i, (s, e, txt) in enumerate(cues)), encoding="utf-8")
    final = ROOT / "arm-demo.mp4"
    style = "FontName=Arial,FontSize=15,PrimaryColour=&H00FFFFFF,BackColour=&H99000000,BorderStyle=4,Outline=0,Shadow=0,MarginV=28"
    subprocess.run(["ffmpeg", "-y", "-i", raw.name, "-vf", f"subtitles=subs.srt:force_style='{style}'", "-c:v", "libx264", "-crf", "19", "-preset", "slow", "-c:a", "copy", "-movflags", "+faststart", str(final)],
                   check=True, cwd=OUT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    print("done", final, round(duration(final), 1), "s")


async def main():
    OUT.mkdir(exist_ok=True)
    meta_file = OUT / "meta.json"
    stage = sys.argv[1] if len(sys.argv) > 1 else "all"
    if stage in ("all", "tts"):
        meta = json.loads(meta_file.read_text(encoding="utf-8")) if ONLY and meta_file.exists() else {}
        meta.update(await tts())
        meta_file.write_text(json.dumps(meta), encoding="utf-8")
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    if stage in ("all", "rec"):
        await record(meta)
        meta_file.write_text(json.dumps(meta), encoding="utf-8")
    if stage in ("all", "compose"):
        compose(meta)


ONLY = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else set()
asyncio.run(main())
