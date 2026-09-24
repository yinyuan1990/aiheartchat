"""形式 3：一组连续剧照（同一人物 / 画风）+ 慢推拉 + 交叉淡化 + AI 配音 + 逐字高亮字幕 + BGM + 「AI 生成」标识。

和 broll 的区别：画面是按故事生成的连续图片，不是随机空镜，所以前后连得上。
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from . import assets, tts
from .broll import TAIL_SEC, _ass, _ass_time
from .common import FONTS_DIR, FPS, H, W, WORK, paragraphs, run_ffmpeg

XFADE = 0.8
ZOOM = 0.10


def _overlay_ass(total: float, slogan: str, ai_tag: str) -> str:
    events = []
    if slogan:
        events.append(f"Dialogue: 0,{_ass_time(0)},{_ass_time(total)},S,,0,0,0,,{slogan}")
    if ai_tag:
        events.append(f"Dialogue: 0,{_ass_time(0)},{_ass_time(total)},Tag,,0,0,0,,{ai_tag}")
    return (
        f"[Script Info]\nScriptType: v4.00+\nPlayResX: {W}\nPlayResY: {H}\n\n[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "Style: S,Microsoft YaHei,38,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,3,0,1,3,0,2,60,60,120,1\n"
        "Style: Tag,Microsoft YaHei,30,&H40FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,2,0,7,40,40,60,1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" + "\n".join(events) + "\n"
    )


def render(title: str, content: str, images: list[Path], out: Path, slogan: str = "", voice: str = "xiaoxiao", bgm: bool = True, ai_tag: str = "AI 生成") -> Path:
    if not images:
        raise ValueError("没有图片")
    WORK.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="sl-", dir=str(WORK)))
    try:
        body_text = "\n".join(paragraphs(content))
        speech = (title + "。\n" if title else "") + body_text
        voice_mp3 = tmp / "voice.mp3"
        dur, char_t, _ = tts.synth(speech, voice_mp3, voice=voice)
        total = dur + TAIL_SEC
        off = len(title) + 2 if title else 0
        (tmp / "subs.ass").write_text(_ass(title, body_text, char_t, total, off), encoding="utf-8")
        (tmp / "overlay.ass").write_text(_overlay_ass(total, slogan, ai_tag), encoding="utf-8")

        # 切图时间点：图片数 = 段落数时一段一张（按配音里该段开始的时间切），否则均分
        n = len(images)
        paras = paragraphs(content)
        if len(paras) == n:
            starts, pos = [0.0], 0
            for p in paras[1:]:
                idx = body_text.find(p, pos)
                pos = idx + len(p)
                starts.append(char_t[min(off + idx, len(char_t) - 1)])
        else:
            starts = [i * total / n for i in range(n)]
        # 第 i 张从 starts[i] 开始，和下一张交叠 XFADE 秒；xfade 的 offset 正好等于 starts[i]
        lens = [(starts[i + 1] - starts[i] + XFADE) if i < n - 1 else (total - starts[i]) for i in range(n)]
        inputs: list[str] = []
        filters: list[str] = []
        for i, img in enumerate(images):
            inputs += ["-i", str(img)]
            frames = max(1, int(round(lens[i] * FPS)))
            # 先放大 2 倍再 zoompan，推拉才不抖；单双张交替推近 / 拉远
            z = f"1+{ZOOM}*on/{frames}" if i % 2 == 0 else f"{1 + ZOOM}-{ZOOM}*on/{frames}"
            filters.append(
                f"[{i}:v]scale={W * 2}:{H * 2}:force_original_aspect_ratio=increase,crop={W * 2}:{H * 2},"
                f"zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={W}x{H}:fps={FPS},"
                f"eq=brightness=-0.05,setsar=1,format=yuv420p[v{i}]"
            )
        prev = "v0"
        for i in range(1, n):
            filters.append(f"[{prev}][v{i}]xfade=transition=fade:duration={XFADE}:offset={starts[i]:.3f}[x{i}]")
            prev = f"x{i}"

        fonts_dir = tmp / "fonts"
        fonts_dir.mkdir(exist_ok=True)
        for f in ("msyh.ttc", "msyhbd.ttc"):
            src = Path(FONTS_DIR) / f
            if src.exists():
                shutil.copy(src, fonts_dir / f)
        fc = ";".join(filters) + f";[{prev}]ass=subs.ass:fontsdir=fonts,ass=overlay.ass:fontsdir=fonts[vo]"
        silent = tmp / "video.mp4"
        run_ffmpeg([*inputs, "-filter_complex", fc, "-map", "[vo]", "-t", f"{total:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-an", str(silent)], cwd=tmp)

        track = assets.pick_bgm() if bgm else None
        if track:
            run_ffmpeg([
                "-i", str(silent), "-i", str(voice_mp3), "-stream_loop", "-1", "-i", str(track),
                "-filter_complex",
                f"[1:a]apad=pad_dur={TAIL_SEC + 0.5}[v];[2:a]volume=0.15,afade=t=out:st={max(0, total - 2):.2f}:d=2[b];[v][b]amix=inputs=2:duration=first:dropout_transition=0[a]",
                "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out),
            ])
        else:
            run_ffmpeg(["-i", str(silent), "-i", str(voice_mp3), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", str(out)])
        return out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
