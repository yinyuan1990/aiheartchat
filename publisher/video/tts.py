"""edge-tts（微软免费中文声）配音，带每个词的时间戳。

返回的 chars[i] = 第 i 个字（按传入文本的字符序，含标点）开始显示 / 被念到的秒数：
WordBoundary 只给词级时间，词内按字数均分；词与词之间的标点跟在前一个词后面。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import edge_tts

from .common import media_duration

VOICES = {
    "xiaoxiao": "zh-CN-XiaoxiaoNeural",   # 女声，温柔，情感类默认
    "xiaoyi": "zh-CN-XiaoyiNeural",       # 女声，年轻
    "yunxi": "zh-CN-YunxiNeural",         # 男声，青年
    "yunyang": "zh-CN-YunyangNeural",     # 男声，新闻播报
    "yunjian": "zh-CN-YunjianNeural",     # 男声，接地气（快手可用）
}


async def _synth(text: str, voice: str, rate: str, out: Path):
    c = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    words: list[tuple[str, float, float]] = []
    with open(out, "wb") as f:
        async for ch in c.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                words.append((ch["text"], ch["offset"] / 1e7, (ch["offset"] + ch["duration"]) / 1e7))
    return words


def synth(text: str, out: Path, voice: str = "xiaoxiao", rate: str = "-6%") -> tuple[float, list[float], list[tuple[str, float, float]]]:
    """→ (音频时长, 每个字符的出现时间, 词边界)"""
    v = VOICES.get(voice, voice)
    words = asyncio.run(_synth(text, v, rate, out))
    dur = media_duration(out)
    chars = char_times(text, words, dur)
    return dur, chars, words


def char_times(text: str, words: list[tuple[str, float, float]], total: float) -> list[float]:
    """把词边界摊到每个字符上"""
    times = [None] * len(text)  # type: list[float | None]
    cursor = 0
    last_end = 0.0
    for w, start, end in words:
        w = w.strip()
        if not w:
            continue
        idx = text.find(w, cursor)
        if idx < 0:
            # 找不到（TTS 归一化了数字等）：跳过，后面补
            continue
        # 词前面的标点 / 空白：跟前一个词的结尾
        for i in range(cursor, idx):
            times[i] = last_end
        n = len(w)
        for k in range(n):
            times[idx + k] = start + (end - start) * k / n
        cursor = idx + n
        last_end = end
    for i in range(cursor, len(text)):
        times[i] = last_end
    # 缺口用前一个值填
    prev = 0.0
    out: list[float] = []
    for t in times:
        if t is None:
            t = prev
        prev = t
        out.append(min(t, total))
    return out
