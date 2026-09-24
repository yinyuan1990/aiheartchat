"""生成样片看效果：python video_demo.py [1|2|3|all] → videos/demo-typewriter.mp4 / demo-broll.mp4 / demo-slides.mp4"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
from video import broll, imagegen, slides, typewriter
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

# 形式 3：连续剧照（树洞 #57「对门那盏灯」，去掉了露骨部分）
SLIDES_TITLE = "对门那盏灯，我只开给他看"
SLIDES_BODY = """我离婚后搬回老小区，对门是个开出租车的，四十出头，一个人住。
有天我钥匙掉进楼下花坛，他帮我捡，泥蹭在他裤腿上。我请他上来喝口水，他站在门口，不进。
第二次是下雨，他送快递上楼，衣服湿透。我把毛巾递出去，这次他进门了，站在垫子上滴水。
后来变成他夜班收车后，上来坐一会儿，去阳台抽根烟。
现在我下班，先看他的车在不在车位。在，我就把灯开着。不在，我就把灯关了，省电。
有次他小孩周末来住，我在门镜里看见一个男孩背着书包。那天，我灯没开。
周一他车又停回来了，我还是开了灯。他没上来。烟灰缸还在阳台，烟蒂是我前天留下的。"""
SLIDES_STYLE = "cinematic film still, 35mm film photo, realistic, warm tungsten light, shallow depth of field, subtle film grain, contemporary China"
SLIDES_CHARACTERS = ""
_W = "a beautiful Chinese woman in a wine-red silk slip dress and a beige knit cardigan, long wavy black hair, early 30s"
# 一段旁白一张图（7 段 → 7 张）。免费模型画不好两个人同框：只画「我」和物件，男人用背影 / 第一视角带过
SLIDES_SCENES = [
    f"{_W}, standing alone at the foot of an old apartment block at dusk, lonely expression",
    f"{_W}, holding a set of muddy keys in her palm next to a flowerbed at dusk, looking down",
    f"{_W}, leaning on an apartment door frame at night, handing a white towel toward the camera, rain in the stairwell, dim yellow light",
    f"{_W}, standing in a dark living room watching the blurred back of a man smoking on the balcony, city lights outside",
    f"{_W}, looking up at a lit apartment window in a residential parking lot at night, a green and white taxi parked beside her",
    f"{_W}, close-up of her eye at a door peephole, dim corridor light on her face, sad",
    "close-up of a glass ashtray with a single cigarette butt on a balcony windowsill at night, warm light from the window",
]

# 形式 4：同一个故事，万相 2.7 组图一次出 7 张（需要 DASHSCOPE_API_KEY）
WANX_PROMPT = """电影感写实组图，竖版，35mm胶片质感，暖黄钨丝灯与夜色，浅景深，轻微胶片颗粒，当代中国老小区。同一个故事的7张连续画面，人物外貌和服装必须前后一致，画面中不要出现任何文字。
人物：林，30岁左右的中国女人，五官精致，眼神慵懒疏离，微卷黑长发，身材曼妙，穿酒红色丝质吊带长裙，外搭一件滑落肩头的米色针织开衫；老周，40岁出头的出租车司机，寸头，胡茬，肩膀宽，穿深灰色旧夹克。
第一张：黄昏，老小区楼下单元门口，林独自站着，神情落寞。
第二张：黄昏，楼下花坛边，老周蹲着从泥里捡起一串钥匙，裤腿蹭了泥，林站在旁边低头看他。
第三张：雨夜，老楼楼道昏黄的声控灯下，老周浑身湿透抱着快递箱站在门口，林倚着门框递给他一条白毛巾。
第四张：深夜阳台，老周背对镜头抽烟，烟被风吹散，远处城市灯火；林站在亮着暖灯的客厅门口看着他的背影。
第五张：傍晚，小区停车位停着一辆绿白色出租车，林穿黑色修身连衣裙，抬头望向一扇亮着灯的窗户。
第六张：从门上猫眼看出去的鱼眼视角，昏暗楼道里，老周牵着一个背书包的小男孩走进对门。
第七张：夜晚阳台窗台特写，玻璃烟灰缸里只有一个烟蒂，旁边搭着那件米色针织开衫，窗内透出暖黄灯光。"""

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
    if which in ("3", "all"):
        t = time.time()
        imgs = imagegen.storyboard(SLIDES_SCENES, SLIDES_CHARACTERS, SLIDES_STYLE, WORK / "demo-slides-img")
        print(f"形式3 出图 {len(imgs)} 张 ({time.time() - t:.0f}s)")
        p = slides.render(SLIDES_TITLE, SLIDES_BODY, imgs, WORK / "demo-slides.mp4", SLOGAN)
        print(f"形式3 → {p}  ({time.time() - t:.0f}s)")
    if which == "4":
        t = time.time()
        d = WORK / "demo-wanx-img"
        imgs = sorted(d.glob("*.jpg")) if d.exists() else []
        if len(imgs) < 7:
            imgs = imagegen.wanx_sequence(WANX_PROMPT, d, n=7)
        print(f"形式4 出图 {len(imgs)} 张 ({time.time() - t:.0f}s)")
        p = slides.render(SLIDES_TITLE, SLIDES_BODY, imgs, WORK / "demo-wanx.mp4", SLOGAN)
        print(f"形式4 → {p}  ({time.time() - t:.0f}s)")
