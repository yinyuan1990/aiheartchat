"""心之音 · 内容分发发布机（跑在操作者本机 Windows 上）。

    python publisher.py login <xiaohongshu|douyin|kuaishou|zhihu|shipinhao>   扫码登录一个平台（有界面浏览器）
    python publisher.py logout <平台>                                退出（删本地登录态，换号用）
    python publisher.py check                                        检查出口 IP + 各平台登录状态并上报后台
    python publisher.py card                                         用一段示例文案渲染卡片图到 cards/ 看效果
    python publisher.py run                                          常驻：轮询后台领任务 → 渲染卡片 → 发布 → 回写

流程见 houduan/src/publish/publish.service.ts。抖音 / 快手 / 小红书走 social-auto-upload 的 `sau` CLI（vendor/），知乎走自写 zhihu.py。
"""
from __future__ import annotations

import json
import logging
import platform as _platform
import random
import re
import socket
import subprocess
import sys
import time
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / "vendor" / "social-auto-upload"
CARDS = ROOT / "cards"
LOGS = ROOT / "logs"
PROFILES = ROOT / "profiles"
SAU_PLATFORMS = {"xiaohongshu", "douyin", "kuaishou"}
ALL_PLATFORMS = ["xiaohongshu", "douyin", "kuaishou", "zhihu", "shipinhao", "x", "youtube"]
NAMES = {"xiaohongshu": "小红书", "douyin": "抖音", "kuaishou": "快手", "zhihu": "知乎", "shipinhao": "视频号", "x": "X", "youtube": "YouTube"}
# 外网平台：出口在国外的发布机才领；国内平台反过来（同一套代码，一台国内一台国外各领各的）
OVERSEAS = {"x", "youtube"}
# 英文平台：配英文音色 / 英文标语
ENGLISH = {"youtube"}
# 我们的平台 key → sau 里的名字（视频号在 sau 里叫 tencent；登录 / 校验复用它，图文发布走自写 shipinhao.py；X 走自写 x.py）
SAU_NAME = {"xiaohongshu": "xiaohongshu", "douyin": "douyin", "kuaishou": "kuaishou", "shipinhao": "tencent", "youtube": "youtube"}
# X 免费账号视频最长 140 秒，留点余量
X_MAX_SEC = 136

LOGS.mkdir(exist_ok=True)
log = logging.getLogger("publisher")
log.setLevel(logging.INFO)
_fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%m-%d %H:%M:%S")
if sys.stdout is not None:  # pythonw（计划任务后台跑）没有 stdout
    _h1 = logging.StreamHandler(sys.stdout)
    _h1.setFormatter(_fmt)
    log.addHandler(_h1)
_h2 = RotatingFileHandler(LOGS / "publisher.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
_h2.setFormatter(_fmt)
log.addHandler(_h2)


def load_config() -> dict:
    f = ROOT / "config.json"
    if not f.exists():
        print("缺 config.json：复制 config.example.json 为 config.json，把后台「内容分发」页的 token 填进去")
        sys.exit(2)
    cfg = json.loads(f.read_text(encoding="utf-8"))
    cfg.setdefault("api", "https://api.yyheart.com/api")
    cfg.setdefault("platforms", ALL_PLATFORMS)
    cfg.setdefault("account", "main")
    cfg.setdefault("headless", True)
    cfg.setdefault("poll_sec", 60)
    # 定时联网核对登录态的间隔：6 小时。之前 30 分钟一次，小红书把这种规律访问判成脚本浏览（账号异常提醒）
    cfg.setdefault("check_min", 360)
    # 这些平台定时检查时不开浏览器（只看本地 cookie 文件）；发布时用有界面浏览器
    cfg.setdefault("no_periodic_check", ["xiaohongshu"])
    cfg.setdefault("headed_platforms", ["xiaohongshu", "shipinhao"])
    # 卡片底部：默认不放品牌 / App 名（小红书判「非官方渠道导流」就是冲着这个来的），只放一句标语
    cfg.setdefault("brand", "")
    cfg.setdefault("slogan", "爱情与金钱无关，和内心相连")
    # 视频配音（edge-tts 音色，见 video/tts.py VOICES）：可按平台单独设；英文平台默认 en-US-AriaNeural
    cfg.setdefault("video_voice", "xiaoxiao")
    cfg.setdefault("video_voice_en", "en-US-AriaNeural")
    cfg.setdefault("video_voices", {})
    cfg.setdefault("slogan_en", "Love has nothing to do with money. It's about the heart.")
    # X 代币联动：正文推广行 / 发完自己回复一条 / 视频片尾卡（每项一行）。空字符串 / 空列表 = 不带
    cfg.setdefault("x_promo", "第一个陪玩美女代币（USDC 链）👉 https://ccfspt.com/token/0x870B91f9aF1f73F80E42826eb5f7400c9e97D37c")
    cfg.setdefault("x_reply", cfg["x_promo"])
    cfg.setdefault("x_outro", ["第一个陪玩美女代币", "USDC 链上发行", "ccfspt.com", "链接见帖子和评论区"])
    # YouTube 同样三处（英文）：简介第一行 / 发完自己评论一条并尝试置顶 / 视频片尾卡
    cfg.setdefault("yt_promo", "The first e-girl companion token (USDC chain) 👉 https://ccfspt.com/token/0x870B91f9aF1f73F80E42826eb5f7400c9e97D37c")
    cfg.setdefault("yt_reply", cfg["yt_promo"])
    cfg.setdefault("yt_outro", ["E-Girl Companion Token", "The first one, on the USDC chain", "ccfspt.com", "Link in description & comments"])
    if not cfg.get("token") or "填这里" in cfg["token"]:
        print("config.json 里的 token 还没填")
        sys.exit(2)
    return cfg


class Api:
    def __init__(self, cfg: dict):
        self.base = cfg["api"].rstrip("/")
        self.h = {"X-Publish-Token": cfg["token"], "Content-Type": "application/json"}

    def _unwrap(self, r: requests.Response):
        r.raise_for_status()
        j = r.json()
        if isinstance(j, dict) and "code" in j and "data" in j:
            if j["code"] != 0:
                raise RuntimeError(j.get("msg") or f"code {j['code']}")
            return j["data"]
        return j

    def heartbeat(self, accounts: dict, ip: dict | None = None) -> dict:
        return self._unwrap(requests.post(f"{self.base}/publish/agent/heartbeat", headers=self.h, json={"host": socket.gethostname(), "accounts": accounts, "ip": ip or {}}, timeout=20))

    def next(self, platforms: list[str]):
        formats = "note,video" if video_ready() else "note"
        params = {"platforms": ",".join(platforms), "formats": formats, "host": socket.gethostname()}
        return self._unwrap(requests.get(f"{self.base}/publish/agent/next", headers=self.h, params=params, timeout=20))

    def result(self, job_id: str, ok: bool, url: str = "", error: str = ""):
        return self._unwrap(requests.post(f"{self.base}/publish/agent/result", headers=self.h, json={"id": job_id, "ok": ok, "url": url, "error": error}, timeout=20))


# ---------- 出口 IP 检查（本机开着 VPN 就不发：发布定位会变成国外，账号很快被判异常） ----------

_ip_cache: dict = {"at": 0.0, "res": None}


def check_ip(force: bool = False) -> dict:
    """返回 {ok, ip, where, msg}；ok = 出口在中国大陆。5 分钟缓存。走系统代理（requests 默认信任环境代理），所以 VPN 开着就能测出来"""
    if not force and _ip_cache["res"] and time.time() - _ip_cache["at"] < 300:
        return _ip_cache["res"]
    res = {"ok": False, "ip": "", "where": "", "msg": "无法获取出口 IP"}
    try:
        r = requests.get("http://ip-api.com/json/?lang=zh-CN&fields=status,country,countryCode,regionName,city,query", timeout=10)
        j = r.json()
        if j.get("status") == "success":
            cn = j.get("countryCode") == "CN"
            where = f"{j.get('country', '')} {j.get('regionName', '')} {j.get('city', '')}".strip()
            res = {"ok": cn, "ip": j.get("query", ""), "where": where, "msg": "出口在国内" if cn else f"出口在 {where}，像是开着 VPN，暂停发布"}
    except Exception as e:  # noqa: BLE001
        try:
            t = requests.get("https://myip.ipip.net", timeout=10).text.strip()
            cn = "中国" in t and "台湾" not in t and "香港" not in t
            res = {"ok": cn, "ip": "", "where": t[:80], "msg": "出口在国内" if cn else f"{t[:60]}，暂停发布"}
        except Exception:  # noqa: BLE001
            res["msg"] = f"无法获取出口 IP：{str(e)[:80]}"
    _ip_cache.update(at=time.time(), res=res)
    return res


# ---------- sau（抖音 / 快手 / 小红书） ----------

def sau(args: list[str], timeout: int = 900, headed: bool = False) -> tuple[int, str]:
    """用本 venv 的 python 跑 vendor 里的 sau_cli.py（cwd = vendor，cookies/ 与 conf.py 都在那）"""
    if not (VENDOR / "sau_cli.py").exists():
        return 1, "vendor/social-auto-upload 不存在，先运行 setup.ps1"
    cmd = [sys.executable, str(VENDOR / "sau_cli.py"), *args]
    if headed:
        cmd.append("--headed")
    try:
        p = subprocess.run(cmd, cwd=str(VENDOR), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        out = (p.stdout or "") + ("\n" + p.stderr if p.stderr else "")
        return p.returncode, out.strip()
    except subprocess.TimeoutExpired:
        return 1, f"sau {' '.join(args[:2])} 超时（{timeout}s）"


def sau_check(platform: str, account: str) -> tuple[bool, str]:
    # sau <平台> check：cookie 有效退出码 0 并打印 valid；无效 / 没登录过退出码 1
    code, out = sau([platform, "check", "--account", account], timeout=180)
    ok = code == 0
    return ok, ("cookie 有效" if ok else (out[-200:] or "cookie 无效或还没登录"))


def sau_upload_note(platform: str, account: str, images: list[Path], title: str, note: str, tags: list[str], headed: bool = False) -> tuple[bool, str]:
    args = [platform, "upload-note", "--account", account, "--images", *[str(i) for i in images], "--title", title or note[:20], "--note", note]
    if tags:
        args += ["--tags", ",".join(tags)]
    code, out = sau(args, timeout=900, headed=headed)
    return code == 0, out[-500:]


# ---------- 状态检查 / 心跳 ----------

def check_all(cfg: dict, periodic: bool = False) -> dict:
    """periodic=True 是后台定时检查：no_periodic_check 里的平台（默认小红书）不真去开浏览器——
    小红书把无头浏览器每半小时访问一次创作者后台判成「不常见的浏览行为 / 脚本自动浏览」，只看本地 cookie 文件在不在，真实状态由发布结果反映"""
    accounts: dict = {}
    for p in cfg["platforms"]:
        if p not in ALL_PLATFORMS:
            continue
        try:
            # 外网平台定时检查也不开浏览器（X 只能有界面跑，定时弹窗太烦）
            if periodic and (p in cfg.get("no_periodic_check", []) or p in OVERSEAS):
                if p in ("zhihu", "x"):
                    ok, msg = (PROFILES / p).exists(), "按本地登录态，未联网核对"
                else:
                    ok = cookie_file(p, cfg).exists()
                    msg = "按本地 cookie 文件，未联网核对（避免被判脚本浏览）" if ok else "还没登录"
            elif p == "zhihu":
                import zhihu
                ok, msg = zhihu.check(PROFILES / "zhihu", headless=bool(cfg["headless"]))
            elif p == "x":
                import x as xpost
                ok, msg = xpost.check(PROFILES / "x")
            else:
                ok, msg = sau_check(SAU_NAME[p], cfg["account"])
        except Exception as e:  # noqa: BLE001
            ok, msg = False, f"检查异常：{str(e)[:150]}"
        accounts[p] = {"ok": ok, "msg": msg, "checkedAt": datetime.now().astimezone().isoformat()}
        log.info("%s 登录状态：%s（%s）", NAMES[p], "OK" if ok else "失效", msg[:80])
    return accounts


def sau_upload_video(platform: str, account: str, video: Path, title: str, desc: str, tags: list[str], headed: bool = False) -> tuple[bool, str]:
    # 视频号（tencent）有 --tags；快手等把话题拼在描述里
    if tags and platform not in ("tencent", "youtube"):
        desc = (desc + "\n" + " ".join(f"#{t}" for t in tags)).strip()
    args = [platform, "upload-video", "--account", account, "--file", str(video), "--title", title or desc[:16], "--desc", desc]
    if tags and platform in ("tencent", "youtube"):
        args += ["--tags", ",".join(tags)]
    if platform == "youtube":
        args += ["--visibility", "public"]
    code, out = sau(args, timeout=1500, headed=headed)
    return code == 0, out[-500:]


# ---------- 发布一条 ----------

_video_ok: bool | None = None


def video_ready() -> bool:
    """本机装了合成视频要的依赖（edge-tts / imageio-ffmpeg / pillow）才向后台领视频任务"""
    global _video_ok
    if _video_ok is None:
        try:
            import edge_tts  # noqa: F401
            import imageio_ffmpeg  # noqa: F401
            import PIL  # noqa: F401

            _video_ok = True
        except ImportError as e:
            log.warning("缺视频依赖（%s），只领图文任务；运行 安装视频依赖.bat 后重启", e)
            _video_ok = False
    return _video_ok


def publish_video(cfg: dict, job: dict) -> tuple[bool, str, str]:
    """视频任务：下载后台出好的连续剧照 → 配音 + 逐字字幕 + BGM 合成竖版视频（video/slides.py）→ sau upload-video"""
    from video import slides

    p = job["platform"]
    title = job.get("title") or ""
    content = job.get("content") or ""
    tags = [t for t in (job.get("tags") or []) if t]
    media = job.get("media") or {}
    paragraphs = [s for s in media.get("paragraphs") or [] if s]
    urls = media.get("images") or []
    if not paragraphs or not urls:
        return False, "", "视频任务缺图片或旁白"
    work = CARDS / f"job{job['id']}-video"
    work.mkdir(parents=True, exist_ok=True)
    images = []
    for i, u in enumerate(urls):
        f = work / f"{i + 1:02d}.png"
        if not f.exists():
            r = requests.get(u, timeout=120)
            r.raise_for_status()
            f.write_bytes(r.content)
        images.append(f)
    english = p in ENGLISH
    voice = (cfg.get("video_voices") or {}).get(p) or (cfg["video_voice_en"] if english else cfg.get("video_voice")) or "xiaoxiao"
    slogan = cfg["slogan_en"] if english else cfg["slogan"]
    ai_tag = "AI generated" if english else "AI 生成"
    if p == "x":
        # X 免费账号视频上限 140 秒：先按字数粗砍，合成后超了再去掉最后一段重来
        budget, keep = 520, 0
        for i, s in enumerate(paragraphs):
            budget -= len(s)
            if budget < 0 and i:
                break
            keep = i + 1
        paragraphs, images = paragraphs[:keep], images[:keep]
    from video.common import media_duration

    out = CARDS / f"job{job['id']}.mp4"
    while True:
        narration = "\n".join(paragraphs)
        # 原文模式的标题就是第一句，别念两遍（屏幕上照样显示标题）
        speak_title = bool(title) and not narration.replace(" ", "").startswith(title.replace(" ", "")[:8])
        slides.render(title, narration, images, out, slogan, voice=voice, speak_title=speak_title, ai_tag=ai_tag, outro={"x": cfg.get("x_outro"), "youtube": cfg.get("yt_outro")}.get(p))
        if p != "x" or len(paragraphs) <= 1 or media_duration(out) <= X_MAX_SEC:
            break
        paragraphs, images = paragraphs[:-1], images[:-1]
    log.info("任务 #%s 视频已合成 %s（%.0f 秒）", job["id"], out.name, media_duration(out))
    headed = p in cfg.get("headed_platforms", []) or p in OVERSEAS
    time.sleep(random.uniform(20, 120))
    if p == "x":
        import x as xpost

        text = "\n".join(s for s in [title, cfg.get("x_promo") or "", " ".join(f"#{t}" for t in tags[:3])] if s)
        return xpost.post_video(PROFILES / "x", out, text, headless=False, shot_dir=LOGS, log=log, reply=cfg.get("x_reply") or "")
    desc = content[:4500] if english else content[:900]
    if p == "youtube" and cfg.get("yt_promo"):
        desc = cfg["yt_promo"] + "\n\n" + desc
    ok, sau_out = sau_upload_video(SAU_NAME[p], cfg["account"], out, title, desc, tags, headed=headed)
    if not ok:
        return False, "", sau_out
    url = ""
    if p == "youtube":
        # sau 发布成功最后一行会带视频链接
        m = re.search(r"https?://(?:youtu\.be/|www\.youtube\.com/(?:watch\?v=|shorts/))[\w-]+", sau_out)
        url = m.group(0) if m else ""
        if cfg.get("yt_reply"):
            import yt_comment

            time.sleep(30)
            c_ok, url, c_err = yt_comment.comment(cookie_file(p, cfg), url, cfg["yt_reply"], LOGS)
            if c_ok:
                log.info("YouTube 已在 %s 下评论推广链接%s", url, f"（{c_err}）" if c_err else "并置顶")
            else:
                log.warning("YouTube 视频发成功了，但评论推广链接失败：%s", c_err)
    return True, url, ""


def publish_job(cfg: dict, job: dict) -> tuple[bool, str, str]:
    p = job["platform"]
    title = job.get("title") or ""
    content = job.get("content") or ""
    tags = [t for t in (job.get("tags") or []) if t]
    if job.get("format") == "video":
        return publish_video(cfg, job)
    if p == "zhihu":
        import zhihu
        ok, url, err = zhihu.post_pin(PROFILES / "zhihu", content, bool(cfg["headless"]), LOGS, title=title)
        return ok, url, err
    import card
    images = card.render_cards(CARDS, f"job{job['id']}", title, content, cfg["brand"], cfg["slogan"], headless=True, style=cfg.get("card_style", "random"))
    # 小红书用有界面浏览器发（headed_platforms）：无头浏览器的指纹是它判「脚本工具」的主要依据之一；发布前再随机等一会，别每次都是领到任务立刻动手
    headed = p in cfg.get("headed_platforms", [])
    time.sleep(random.uniform(20, 120))
    if p == "shipinhao":
        import shipinhao
        return shipinhao.post_note(cookie_file(p, cfg), images, title, content, tags, headed, LOGS, log)
    ok, out = sau_upload_note(SAU_NAME[p], cfg["account"], images, title, content, tags, headed=headed)
    return ok, "", ("" if ok else out)


def cookie_file(platform: str, cfg: dict) -> Path:
    """sau 存 cookie 的文件（视频号在 sau 里叫 tencent）"""
    return VENDOR / "cookies" / f"{SAU_NAME.get(platform, platform)}_{cfg['account']}.json"


# ---------- 命令 ----------

def cmd_login(cfg: dict, platform: str):
    if platform not in ALL_PLATFORMS:
        print(f"平台只能是 {' / '.join(ALL_PLATFORMS)}")
        return 2
    if platform == "zhihu":
        import zhihu
        ok, msg = zhihu.login(PROFILES / "zhihu")
        print(msg)
    elif platform == "x":
        import x as xpost
        ok, msg = xpost.login(PROFILES / "x")
        print(msg)
    else:
        if platform in OVERSEAS:
            print(f"正在打开 {NAMES[platform]}，请在弹出的浏览器里登录账号…")
        else:
            print(f"正在打开 {NAMES[platform]} 创作者后台，请用手机 {'微信' if platform == 'shipinhao' else NAMES[platform] + ' App'} 扫码登录…（二维码若没显示，看 vendor 目录下生成的二维码图片）")
        code, out = sau([SAU_NAME[platform], "login", "--account", cfg["account"]], timeout=600, headed=True)
        ok = code == 0
        print(out[-800:])
    if ok:
        try:
            Api(cfg).heartbeat(check_all({**cfg, "platforms": [platform]}))
        except Exception as e:  # noqa: BLE001
            log.warning("上报状态失败：%s", e)
    return 0 if ok else 1


def cmd_check(cfg: dict):
    ip = check_ip(force=True)
    log.info("出口 IP：%s %s → %s", ip.get("ip"), ip.get("where"), "国内，只发国内平台" if ip["ok"] else "国外，只发 X / YouTube")
    accounts = check_all(cfg)
    try:
        Api(cfg).heartbeat(accounts, ip)
        print("已上报后台")
    except Exception as e:  # noqa: BLE001
        print(f"上报后台失败：{e}")
    return 0


def cmd_logout(cfg: dict, platform: str):
    """退出某平台：删本地登录态（账号废了换新号时用）。抖音 / 快手 / 小红书是 vendor/cookies 下的 json，知乎是 profiles/zhihu 整个目录"""
    if platform not in ALL_PLATFORMS:
        print(f"平台只能是 {' / '.join(ALL_PLATFORMS)}")
        return 2
    import shutil
    if platform in ("zhihu", "x"):
        shutil.rmtree(PROFILES / platform, ignore_errors=True)
    else:
        f = cookie_file(platform, cfg)
        if f.exists():
            f.unlink()
    log.info("%s 已登出（本地登录态已删除），要换号请重新 login", NAMES[platform])
    try:
        Api(cfg).heartbeat({platform: {"ok": False, "msg": "已登出", "checkedAt": datetime.now().astimezone().isoformat()}})
    except Exception:  # noqa: BLE001
        pass
    return 0


def cmd_card(cfg: dict):
    import card
    sample = ("和他在一起三年，昨天他说想先各自冷静一下。\n我没有哭，只是把他留在我这儿的杯子洗了三遍。\n"
              "原来一个人最难过的时候，反而会特别安静。\n你们有没有过这种时刻？")
    paths = card.render_cards(CARDS, "sample", "他说想冷静一下，我洗了三遍杯子", sample, cfg["brand"], cfg["slogan"])
    for pth in paths:
        print(pth)
    return 0


def cmd_run(cfg: dict):
    api = Api(cfg)
    log.info("发布机启动：%s，平台 %s，轮询 %ss", _platform.node(), ",".join(cfg["platforms"]), cfg["poll_sec"])
    accounts = check_all(cfg, periodic=True)
    last_check = time.time()
    last_recheck = time.time()
    while True:
        try:
            if time.time() - last_check > cfg["check_min"] * 60:
                accounts = check_all(cfg, periodic=True)
                last_check = last_recheck = time.time()
            elif time.time() - last_recheck > 5 * 60:
                # 没登录的平台每 5 分钟看一眼本地登录态文件（login 完很快能接上；不联网、不开浏览器）
                bad = [p for p, a in accounts.items() if not a.get("ok")]
                if bad:
                    accounts.update(check_all({**cfg, "platforms": bad, "no_periodic_check": bad}, periodic=True))
                last_recheck = time.time()
            ip = check_ip()
            api.heartbeat(accounts, ip)
            logged = [p for p, a in accounts.items() if a.get("ok")]
            # 出口在国内只领国内平台，在国外只领 X / YouTube（国内平台用国外 IP 发会被判异常，反之外网平台用国内 IP 根本上不去）
            ready = [p for p in logged if (p in OVERSEAS) != bool(ip["ok"])]
            if not logged:
                log.warning("没有任何平台处于已登录状态，等待…（python publisher.py login 平台）")
            elif not ready:
                log.warning("出口 %s %s：本机已登录的平台（%s）都不能从这个出口发——国内平台要国内出口（关 VPN），X / YouTube 要国外出口",
                            ip.get("ip"), ip.get("where") or ip.get("msg"), ",".join(NAMES[p] for p in logged))
            else:
                job = api.next(ready)
                if job:
                    log.info("领到任务 #%s → %s：%s", job["id"], NAMES.get(job["platform"], job["platform"]), (job.get("title") or job.get("content", ""))[:40])
                    try:
                        ok, url, err = publish_job(cfg, job)
                    except Exception as e:  # noqa: BLE001
                        ok, url, err = False, "", f"发布异常：{str(e)[:300]}"
                    if ok:
                        log.info("任务 #%s 发布成功 %s", job["id"], url)
                    else:
                        log.warning("任务 #%s 发布失败：%s", job["id"], err[:300])
                        if "cookie" in err.lower() or "登录" in err or "expired" in err.lower():
                            accounts[job["platform"]] = {"ok": False, "msg": err[:150], "checkedAt": datetime.now().astimezone().isoformat()}
                    api.result(job["id"], ok, url, err)
                    # 连续任务之间歇一下，别一口气发
                    time.sleep(20)
                    continue
        except requests.RequestException as e:
            log.warning("后台连不上：%s", e)
        except Exception as e:  # noqa: BLE001
            log.exception("循环异常：%s", e)
        time.sleep(cfg["poll_sec"])


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] not in {"login", "logout", "check", "card", "run"}:
        print(__doc__)
        return 2
    cfg = load_config()
    if argv[1] in ("login", "logout"):
        if len(argv) < 3:
            print(f"用法：python publisher.py {argv[1]} <xiaohongshu|douyin|kuaishou|zhihu|shipinhao>")
            return 2
        return cmd_login(cfg, argv[2]) if argv[1] == "login" else cmd_logout(cfg, argv[2])
    if argv[1] == "check":
        return cmd_check(cfg)
    if argv[1] == "card":
        return cmd_card(cfg)
    return cmd_run(cfg)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
