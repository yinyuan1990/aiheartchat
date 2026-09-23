"""形式 2：AI 配音 + 逐词高亮大字幕 + 实拍空镜（Mixkit）+ BGM（MoneyPrinterTurbo 那一类"故事号"的做法）。

字幕用 ASS 卡拉 OK（\\kf）逐字变色，libass 渲染；空镜按句均分时长，缩放裁切成 1080x1920 并压暗一点保证字幕可读；
开头 3 秒叠一个大标题当钩子。
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from . import assets, tts
from .common import FONTS_DIR, H, W, WORK, media_duration, paragraphs, run_ffmpeg, sentences

TAIL_SEC = 2.0
CLIP_SEC = 6.0  # 每段空镜大约几秒换一个


def _ass_time(t: float) -> str:
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _ass(title: str, body: str, char_t: list[float], total: float, off: int) -> str:
    """char_t：语音全文每个字符的时间；off：正文在语音全文里的起始下标"""
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Microsoft YaHei,72,&H0000D4FF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,2,0,1,4,2,2,60,60,560,1
Style: Title,Microsoft YaHei,86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,2,0,1,5,3,8,80,80,260,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines: list[str] = []
    if title:
        lines.append(f"Dialogue: 1,{_ass_time(0)},{_ass_time(min(3.2, total))},Title,,0,0,0,,{{\\fad(200,400)}}{title}")
    # 正文按句切，句内每个字一个 \kf（厘秒）
    pos = 0
    body_chars = body
    for sent in sentences(body):
        idx = body_chars.find(sent, pos)
        if idx < 0:
            continue
        pos = idx + len(sent)
        times = [char_t[min(off + idx + k, len(char_t) - 1)] for k in range(len(sent))]
        start = times[0]
        end = char_t[min(off + idx + len(sent), len(char_t) - 1)] if off + idx + len(sent) < len(char_t) else total
        end = max(end, start + 0.6)
        parts = []
        for k, ch in enumerate(sent):
            t0 = times[k]
            t1 = times[k + 1] if k + 1 < len(times) else end
            cs = max(1, int(round((t1 - t0) * 100)))
            parts.append(f"{{\\kf{cs}}}{ch}")
        lines.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Sub,,0,0,0,,{''.join(parts)}")
    return head + "\n".join(lines) + "\n"


def render(title: str, content: str, out: Path, slogan: str, voice: str = "xiaoxiao", bgm: bool = True) -> Path:
    WORK.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="br-", dir=str(WORK)))
    try:
        body_text = "\n".join(paragraphs(content))
        speech = (title + "。\n" if title else "") + body_text
        voice_mp3 = tmp / "voice.mp3"
        dur, char_t, _ = tts.synth(speech, voice_mp3, voice=voice)
        total = dur + TAIL_SEC
        off = len(title) + 2 if title else 0
        ass_path = tmp / "subs.ass"
        ass_path.write_text(_ass(title, body_text, char_t, total, off), encoding="utf-8")

        # 空镜：按总时长分段
        n = max(2, int(total // CLIP_SEC) + 1)
        clips = assets.pick_footage(n)
        if not clips:
            raise RuntimeError("没有拿到空镜素材（Mixkit 访问失败）")
        seg = total / len(clips)
        inputs: list[str] = []
        filters: list[str] = []
        for i, c in enumerate(clips):
            inputs += ["-stream_loop", "-1", "-i", str(c)]
            filters.append(
                f"[{i}:v]trim=duration={seg:.3f},setpts=PTS-STARTPTS,scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
                f"setsar=1,eq=brightness=-0.08:saturation=0.9,fps=30,format=yuv420p[v{i}]"
            )
        concat = "".join(f"[v{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=1:a=0[vc]"
        # 字幕 / 字体路径里的 ":" 和引号在 filter 里很难转义：把字体拷进临时目录，ffmpeg 以临时目录为 cwd，全部用相对路径
        fonts_dir = tmp / "fonts"
        fonts_dir.mkdir(exist_ok=True)
        for f in ("msyh.ttc", "msyhbd.ttc"):
            src = Path(FONTS_DIR) / f
            if src.exists():
                shutil.copy(src, fonts_dir / f)
        # 底部一行小标语，全程
        (tmp / "slogan.ass").write_text(
            f"[Script Info]\nScriptType: v4.00+\nPlayResX: {W}\nPlayResY: {H}\n\n[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
            "Style: S,Microsoft YaHei,38,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,3,0,1,3,0,2,60,60,120,1\n\n"
            "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
            + (f"Dialogue: 0,{_ass_time(0)},{_ass_time(total)},S,,0,0,0,,{slogan}\n" if slogan else ""),
            encoding="utf-8",
        )
        fc = ";".join(filters) + ";" + concat + ";[vc]ass=subs.ass:fontsdir=fonts,ass=slogan.ass:fontsdir=fonts[vo]"
        silent = tmp / "video.mp4"
        run_ffmpeg([*inputs, "-filter_complex", fc, "-map", "[vo]", "-t", f"{total:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-an", str(silent)], cwd=tmp)

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
