"""形式 1：文字逐字浮现 + AI 配音 + 钢琴 BGM，玫红卡片风（和小红书卡片同款）。

做法：按 TTS 的字级时间戳，每多显示一个字就是一帧"状态图"（Pillow 画），用 ffmpeg concat（带每帧时长）拼成视频，
最后一帧多停 2.5 秒；音频 = 配音 + 低音量 BGM。正文放不下时翻页（标题只在第一页）。
"""
from __future__ import annotations

import random
import shutil
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from . import assets, tts
from .common import FONT_BOLD, FONT_REG, H, W, WORK, media_duration, paragraphs, run_ffmpeg

CARD_X0, CARD_X1 = 72, W - 72
CARD_Y0 = 330
CARD_Y1 = H - 380
PAD = 64
TITLE_SIZE = 58
BODY_SIZE = 44
LINE_H = int(BODY_SIZE * 1.75)
PARA_GAP = 22
TAIL_SEC = 2.5


def _gradient() -> Image.Image:
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    c0, c1, c2 = (255, 95, 143), (255, 143, 176), (255, 209, 221)
    for y in range(H):
        t = y / (H - 1)
        if t < 0.55:
            k = t / 0.55
            c = tuple(int(c0[i] + (c1[i] - c0[i]) * k) for i in range(3))
        else:
            k = (t - 0.55) / 0.45
            c = tuple(int(c1[i] + (c2[i] - c1[i]) * k) for i in range(3))
        d.line([(0, y), (W, y)], fill=c)
    # 两个柔光圆
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([W - 300, -200, W + 160, 260], fill=(255, 255, 255, 46))
    gd.ellipse([-120, H - 620, 180, H - 320], fill=(255, 255, 255, 40))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    return img


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_w: int) -> list[str]:
    lines: list[str] = []
    cur = ""
    for ch in text:
        if draw.textlength(cur + ch, font=font) > max_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


class Layout:
    """把标题 + 正文排成若干页；每个字符知道自己在哪页哪行哪列"""

    def __init__(self, title: str, body: str):
        self.font_t = ImageFont.truetype(FONT_BOLD, TITLE_SIZE)
        self.font_b = ImageFont.truetype(FONT_REG, BODY_SIZE)
        probe = ImageDraw.Draw(Image.new("RGB", (W, H)))
        max_w = CARD_X1 - CARD_X0 - PAD * 2
        self.title_lines = _wrap(probe, title, self.font_t, max_w) if title else []
        title_h = len(self.title_lines) * int(TITLE_SIZE * 1.35) + (34 if title else 0)
        # pages: list of list of (para_idx, line_text, char_start) ; positions
        self.pages: list[list[tuple[int, str, int]]] = []
        self.page_title_h: list[int] = []
        avail = CARD_Y1 - CARD_Y0 - PAD * 2
        page: list[tuple[int, str, int]] = []
        used = title_h
        self.page_title_h.append(title_h)
        char_index = 0
        self.char_pos: list[tuple[int, int]] = []  # 每个正文字符 → (page, line_in_page)
        self.para_count = 0
        for pi, para in enumerate(paragraphs(body)):
            self.para_count += 1
            lines = _wrap(probe, para, self.font_b, max_w)
            for li, line in enumerate(lines):
                need = LINE_H + (PARA_GAP if li == 0 and page else 0)
                if used + need > avail and page:
                    self.pages.append(page)
                    page = []
                    used = 0
                    self.page_title_h.append(0)
                    need = LINE_H
                page.append((pi, line, char_index))
                used += need
                for _ in line:
                    self.char_pos.append((len(self.pages), len(page) - 1))
                char_index += len(line)
            # 段落之间的换行符不占字符
        if page:
            self.pages.append(page)

    def total_chars(self) -> int:
        return len(self.char_pos)

    def page_height(self, idx: int) -> int:
        """该页内容高度（标题 + 正文行 + 段距），卡片按它来画，不留大片空白"""
        if idx >= len(self.pages):
            return 0
        h = self.page_title_h[idx] if idx < len(self.page_title_h) else 0
        last = None
        for pi, _line, _s in self.pages[idx]:
            if last is not None and pi != last:
                h += PARA_GAP
            last = pi
            h += LINE_H
        return h


def _render_state(bg: Image.Image, lay: Layout, title_shown: int, body_shown: int, slogan: str, cursor: bool) -> Image.Image:
    """title_shown / body_shown = 已显示的字符数"""
    img = bg.copy()
    d = ImageDraw.Draw(img)
    page_idx0 = lay.char_pos[body_shown - 1][0] if body_shown > 0 else 0
    # 卡片高度按这一页的内容来（最少 620），不然短页下面一大块空白
    card_y1 = min(CARD_Y1, max(CARD_Y0 + 620, CARD_Y0 + PAD * 2 + lay.page_height(page_idx0)))
    d.rounded_rectangle([CARD_X0, CARD_Y0, CARD_X1, card_y1], radius=40, fill=(255, 255, 255))
    # 引号
    qf = ImageFont.truetype("C:/Windows/Fonts/georgia.ttf", 150) if Path("C:/Windows/Fonts/georgia.ttf").exists() else lay.font_t
    d.text((CARD_X0, 140), "\u201c", font=qf, fill=(255, 226, 235))
    page_idx = lay.char_pos[body_shown - 1][0] if body_shown > 0 else 0
    y = CARD_Y0 + PAD
    x = CARD_X0 + PAD
    # 标题（第一页）
    if page_idx == 0 and lay.title_lines:
        remain = title_shown
        for line in lay.title_lines:
            part = line[:max(0, remain)]
            d.text((x, y), part, font=lay.font_t, fill=(27, 27, 31))
            remain -= len(line)
            y += int(TITLE_SIZE * 1.35)
        y += 34
    # 正文（当前页）
    lines = lay.pages[page_idx] if lay.pages else []
    last_para = None
    for pi, line, start in lines:
        if last_para is not None and pi != last_para:
            y += PARA_GAP
        last_para = pi
        shown = max(0, min(len(line), body_shown - start))
        part = line[:shown]
        if part:
            d.text((x, y), part, font=lay.font_b, fill=(43, 43, 48))
        # 光标画在正在打的那一行末尾
        if cursor and body_shown > 0 and start <= body_shown - 1 < start + len(line):
            cx = x + d.textlength(part, font=lay.font_b) + 6
            d.rounded_rectangle([cx, y + 6, cx + 8, y + BODY_SIZE + 4], radius=3, fill=(255, 95, 143))
            cursor = False
        y += LINE_H
        if shown < len(line):
            break
    # 底部标语
    if slogan:
        f = ImageFont.truetype(FONT_BOLD, 40)
        tw = d.textlength(slogan, font=f)
        d.text(((W - tw) / 2, H - 200), slogan, font=f, fill=(255, 255, 255))
    return img


def render(title: str, content: str, out: Path, slogan: str, voice: str = "xiaoxiao", bgm: bool = True) -> Path:
    WORK.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="tw-", dir=str(WORK)))
    try:
        body_text = "\n".join(paragraphs(content))
        speech = (title + "。\n" if title else "") + body_text
        voice_mp3 = tmp / "voice.mp3"
        dur, char_t, _ = tts.synth(speech, voice_mp3, voice=voice)
        # 把语音里的字符时间映射到 标题字符 / 正文字符（跳过我们加的「。\n」和换行）
        title_t = char_t[: len(title)] if title else []
        body_t: list[float] = []
        off = len(title) + 2 if title else 0
        for i, ch in enumerate(body_text):
            if ch == "\n":
                continue
            body_t.append(char_t[off + i] if off + i < len(char_t) else dur)
        lay = Layout(title, content)
        assert lay.total_chars() == len(body_t), f"字符数不一致 {lay.total_chars()} vs {len(body_t)}"

        bg = _gradient()
        # 事件序列：(时间, title_shown, body_shown)
        events: list[tuple[float, int, int]] = [(0.0, 0, 0)]
        for i, t in enumerate(title_t):
            events.append((t, i + 1, 0))
        for i, t in enumerate(body_t):
            events.append((t, len(title), i + 1))
        events.sort(key=lambda e: e[0])
        # 合并同一时刻的
        frames: list[tuple[Path, float]] = []
        total = dur + TAIL_SEC
        for k, (t, ts_, bs_) in enumerate(events):
            nxt = events[k + 1][0] if k + 1 < len(events) else total
            d_ = max(0.0, nxt - t)
            if d_ < 0.02 and k + 1 < len(events):
                continue
            last = k + 1 >= len(events)
            img = _render_state(bg, lay, ts_, bs_, slogan, cursor=not last)
            p = tmp / f"f{k:05d}.png"
            img.save(p, compress_level=1)
            frames.append((p, d_ if not last else TAIL_SEC + max(0.0, dur - t)))
        lst = tmp / "list.txt"
        with open(lst, "w", encoding="utf-8") as f:
            for p, d_ in frames:
                f.write(f"file '{p.as_posix()}'\nduration {max(0.034, d_):.3f}\n")
            f.write(f"file '{frames[-1][0].as_posix()}'\n")
        silent = tmp / "video.mp4"
        run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(lst), "-fps_mode", "cfr", "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-t", f"{total:.3f}", str(silent)])
        _mux(silent, voice_mp3, out, total, bgm)
        return out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _mux(video: Path, voice: Path, out: Path, total: float, bgm: bool) -> None:
    track = assets.pick_bgm() if bgm else None
    if track:
        run_ffmpeg([
            "-i", str(video), "-i", str(voice), "-stream_loop", "-1", "-i", str(track),
            "-filter_complex",
            f"[1:a]apad=pad_dur={TAIL_SEC + 0.5}[v];[2:a]volume=0.13,afade=t=out:st={max(0, total - 2.5):.2f}:d=2.5[b];[v][b]amix=inputs=2:duration=first:dropout_transition=0[a]",
            "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out),
        ])
    else:
        run_ffmpeg(["-i", str(video), "-i", str(voice), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", str(out)])
