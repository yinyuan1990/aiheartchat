"""生成两种形式的样片看效果：python video_demo.py [1|2|all] → videos/demo-typewriter.mp4 / videos/demo-broll.mp4"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
from video import broll, typewriter
from video.common import WORK

TITLE = "那年冬天，没吹干的头发"
BODY = """我妈再婚那年，我二十出头。
她带了个女儿，比我小两岁，我们各过各的。
有年过年，家里人都出门了，只剩我俩看房子。
晚上她洗完澡，头发湿着，来我房间找吹风机。
门被风带上了一点。
后来谁先靠近的，我说不清。
她咬着手背，没出声。
之后每年见面，叫哥叫妹，吃饭夹菜。
她订婚那年，我当伴郎，帮她提裙摆。
她侧脸很平静。
我到现在还会梦见那没吹干的头发，一醒就去开窗。
风很冷，正好。"""
SLOGAN = "爱情与金钱无关，和内心相连"

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    WORK.mkdir(exist_ok=True)
    if which in ("1", "all"):
        t = time.time()
        p = typewriter.render(TITLE, BODY, WORK / "demo-typewriter.mp4", SLOGAN)
        print(f"形式1 → {p}  ({time.time() - t:.0f}s)")
    if which in ("2", "all"):
        t = time.time()
        p = broll.render(TITLE, BODY, WORK / "demo-broll.mp4", SLOGAN)
        print(f"形式2 → {p}  ({time.time() - t:.0f}s)")
