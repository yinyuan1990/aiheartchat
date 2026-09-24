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


def is_latin(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    return bool(letters) and sum(c.isascii() for c in letters) / len(letters) > 0.6


def wrap_words(text: str, max_len: int) -> list[str]:
    """英文按单词折行（每行不超过 max_len 个字符，单词不拆），返回的每行都是原文的连续子串"""
    lines: list[str] = []
    cur = ""
    for w in text.split(" "):
        if cur and len(cur) + 1 + len(w) > max_len:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}" if cur else w
    if cur:
        lines.append(cur)
    return lines


def wrap_cjk(text: str, max_len: int) -> list[str]:
    """中文按字数折行：每行不超过 max_len 字，尽量断在标点后面（标点留在行尾）"""
    lines: list[str] = []
    rest = text.strip()
    while len(rest) > max_len:
        cut = max((i + 1 for i, c in enumerate(rest[:max_len + 1]) if c in "，。！？、；：,.!?;: "), default=0)
        if cut < max_len // 2:
            cut = max_len
        lines.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        lines.append(rest)
    return lines


def sentences(text: str, max_len: int = 16) -> list[str]:
    """按标点切成字幕句；太长的再按逗号 / 长度硬切。英文按句号 / 逗号切，再按单词折成 ≤24 字符的行"""
    if is_latin(text):
        out_en: list[str] = []
        for s in re.findall(r"[^.!?;\n]+[.!?;]*", text):
            s = s.strip()
            if s:
                out_en.extend(x.strip() for x in wrap_words(s, 24) if x.strip())
        return out_en
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
