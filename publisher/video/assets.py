"""Mixkit 免版权素材（不用 API key）：实拍空镜 + 钢琴 BGM。首次按关键词抓页面里的直链下载到本地缓存，之后随机取。"""
from __future__ import annotations

import random
import re
from pathlib import Path

import requests

from .common import ROOT

FOOTAGE = ROOT / "footage"
BGM = ROOT / "bgm"
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"}

# 情感 / 倾诉类内容通用的"情绪空镜"关键词池（Mixkit 分类 slug）
MOOD_KEYWORDS = ["rain-window", "night-city", "coffee", "sunset", "sea", "walking", "window", "candle", "sky"]
PER_KEYWORD = 4


def _fetch_links(page_url: str, pattern: str) -> list[str]:
    r = requests.get(page_url, timeout=30, headers=H)
    r.raise_for_status()
    return sorted(set(re.findall(pattern, r.text)))


def _download(url: str, dest: Path) -> bool:
    try:
        with requests.get(url, timeout=120, headers=H, stream=True) as r:
            if r.status_code != 200:
                return False
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(dest.suffix + ".part")
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 16):
                    f.write(chunk)
            tmp.rename(dest)
            return True
    except Exception:
        return False


def ensure_footage(keyword: str, n: int = PER_KEYWORD) -> list[Path]:
    """某关键词的本地空镜（720p），不够就去 Mixkit 补"""
    d = FOOTAGE / keyword
    have = sorted(d.glob("*.mp4")) if d.exists() else []
    if len(have) >= n:
        return have
    try:
        links = _fetch_links(f"https://mixkit.co/free-stock-video/{keyword}/", r"https://assets\.mixkit\.co/videos/(\d+)/\1-360\.mp4")
    except Exception:
        return have
    random.shuffle(links)
    for vid in links:
        if len(have) >= n:
            break
        dest = d / f"{vid}.mp4"
        if dest.exists():
            continue
        # 720p 够用（1080x1920 竖屏会裁切放大，1080p 文件 70MB 太大）
        if _download(f"https://assets.mixkit.co/videos/{vid}/{vid}-720.mp4", dest):
            have.append(dest)
    return sorted(have)


def pick_footage(count: int, keywords: list[str] | None = None) -> list[Path]:
    """随机挑 count 段不同关键词的空镜"""
    kws = list(keywords or MOOD_KEYWORDS)
    random.shuffle(kws)
    out: list[Path] = []
    for kw in kws:
        clips = ensure_footage(kw, 2)
        if clips:
            out.append(random.choice(clips))
        if len(out) >= count:
            break
    return out


def ensure_bgm(n: int = 6) -> list[Path]:
    """钢琴类 BGM 若干首（Mixkit 音乐 → bgm/）"""
    have = sorted(BGM.glob("*.mp3")) if BGM.exists() else []
    if len(have) >= n:
        return have
    try:
        links = _fetch_links("https://mixkit.co/free-stock-music/piano/", r"https://assets\.mixkit\.co/music/\d+/\d+\.mp3")
    except Exception:
        return have
    random.shuffle(links)
    for url in links:
        if len(have) >= n:
            break
        dest = BGM / url.rsplit("/", 1)[-1]
        if dest.exists():
            continue
        if _download(url, dest):
            have.append(dest)
    return sorted(have)


def pick_bgm() -> Path | None:
    tracks = ensure_bgm()
    return random.choice(tracks) if tracks else None
