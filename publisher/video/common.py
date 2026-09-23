from __future__ import annotations

import re
import subprocess
from pathlib import Path

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "videos"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONTS_DIR = r"C:/Windows/Fonts"
W, H = 1080, 1920
FPS = 30
CREATE_NO_WINDOW = 0x08000000


def ffmpeg() -> str:
    return imageio_ffmpeg.get_ffmpeg_exe()


def run_ffmpeg(args: list[str], timeout: int = 900, cwd: Path | None = None) -> None:
    cmd = [ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", *args]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, creationflags=CREATE_NO_WINDOW, cwd=str(cwd) if cwd else None)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg 失败：{(p.stderr or '')[-800:]}")


def media_duration(path: Path) -> float:
    """imageio-ffmpeg 不带 ffprobe，用 ffmpeg -i 的 Duration 行"""
    p = subprocess.run([ffmpeg(), "-hide_banner", "-i", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=CREATE_NO_WINDOW)
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+)\.(\d+)", p.stderr or "")
    if not m:
        return 0.0
    h, mi, s, frac = m.groups()
    return int(h) * 3600 + int(mi) * 60 + int(s) + int(frac) / (10 ** len(frac))


def paragraphs(content: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n|\n", content) if p.strip()]


def sentences(text: str, max_len: int = 16) -> list[str]:
    """按标点切成字幕句；太长的再按逗号 / 长度硬切"""
    out: list[str] = []
    for s in re.findall(r"[^。！？!?；;\n]+[。！？!?；;]?", text):
        s = s.strip()
        if not s:
            continue
        if len(s) <= max_len:
            out.append(s)
            continue
        parts = re.split(r"(?<=[，,、：:])", s)
        cur = ""
        for part in parts:
            if len(cur) + len(part) > max_len and cur:
                out.append(cur)
                cur = part
            else:
                cur += part
        if cur:
            out.append(cur)
    # 仍然太长的硬切
    final: list[str] = []
    for s in out:
        while len(s) > max_len + 4:
            final.append(s[:max_len])
            s = s[max_len:]
        final.append(s)
    return final
