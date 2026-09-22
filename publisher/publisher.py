"""心之音 · 内容分发发布机（跑在操作者本机 Windows 上）。

    python publisher.py login <xiaohongshu|douyin|kuaishou|zhihu>   扫码登录一个平台（有界面浏览器）
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
ALL_PLATFORMS = ["xiaohongshu", "douyin", "kuaishou", "zhihu"]
NAMES = {"xiaohongshu": "小红书", "douyin": "抖音", "kuaishou": "快手", "zhihu": "知乎"}

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
    cfg.setdefault("check_min", 30)
    # 卡片底部：默认不放品牌 / App 名（小红书判「非官方渠道导流」就是冲着这个来的），只放一句标语
    cfg.setdefault("brand", "")
    cfg.setdefault("slogan", "爱情与金钱无关，和内心相连")
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

    def next(self, platforms: list[str]):
        return self._unwrap(requests.get(f"{self.base}/publish/agent/next", headers=self.h, params={"platforms": ",".join(platforms)}, timeout=20))

    def result(self, job_id: str, ok: bool, url: str = "", error: str = ""):
        return self._unwrap(requests.post(f"{self.base}/publish/agent/result", headers=self.h, json={"id": job_id, "ok": ok, "url": url, "error": error}, timeout=20))


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


def sau_upload_note(platform: str, account: str, images: list[Path], title: str, note: str, tags: list[str]) -> tuple[bool, str]:
    args = [platform, "upload-note", "--account", account, "--images", *[str(i) for i in images], "--title", title or note[:20], "--note", note]
    if tags:
        args += ["--tags", ",".join(tags)]
    code, out = sau(args, timeout=900)
    return code == 0, out[-500:]


# ---------- 状态检查 / 心跳 ----------

def check_all(cfg: dict) -> dict:
    accounts: dict = {}
    for p in cfg["platforms"]:
        if p not in ALL_PLATFORMS:
            continue
        try:
            if p == "zhihu":
                import zhihu
                ok, msg = zhihu.check(PROFILES / "zhihu", headless=bool(cfg["headless"]))
            else:
                ok, msg = sau_check(p, cfg["account"])
        except Exception as e:  # noqa: BLE001
            ok, msg = False, f"检查异常：{str(e)[:150]}"
        accounts[p] = {"ok": ok, "msg": msg, "checkedAt": datetime.now().astimezone().isoformat()}
        log.info("%s 登录状态：%s（%s）", NAMES[p], "OK" if ok else "失效", msg[:80])
    return accounts


# ---------- 发布一条 ----------

def publish_job(cfg: dict, job: dict) -> tuple[bool, str, str]:
    p = job["platform"]
    title = job.get("title") or ""
    content = job.get("content") or ""
    tags = [t for t in (job.get("tags") or []) if t]
    if p == "zhihu":
        import zhihu
        ok, url, err = zhihu.post_pin(PROFILES / "zhihu", content, bool(cfg["headless"]), LOGS, title=title)
        return ok, url, err
    import card
    images = card.render_cards(CARDS, f"job{job['id']}", title, content, cfg["brand"], cfg["slogan"], headless=True)
    ok, out = sau_upload_note(p, cfg["account"], images, title, content, tags)
    return ok, "", ("" if ok else out)


# ---------- 命令 ----------

def cmd_login(cfg: dict, platform: str):
    if platform not in ALL_PLATFORMS:
        print(f"平台只能是 {' / '.join(ALL_PLATFORMS)}")
        return 2
    if platform == "zhihu":
        import zhihu
        ok, msg = zhihu.login(PROFILES / "zhihu")
        print(msg)
    else:
        print(f"正在打开 {NAMES[platform]} 创作者后台，请用手机 App 扫码登录…（二维码若没显示，看 vendor 目录下生成的二维码图片）")
        code, out = sau([platform, "login", "--account", cfg["account"]], timeout=600, headed=True)
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
    log.info("出口 IP：%s %s → %s", ip.get("ip"), ip.get("where"), "OK" if ip["ok"] else "不在国内，会暂停发布")
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
    if platform == "zhihu":
        shutil.rmtree(PROFILES / "zhihu", ignore_errors=True)
    else:
        f = VENDOR / "cookies" / f"{platform}_{cfg['account']}.json"
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
    accounts = check_all(cfg)
    last_check = time.time()
    last_recheck = time.time()
    while True:
        try:
            if time.time() - last_check > cfg["check_min"] * 60:
                accounts = check_all(cfg)
                last_check = last_recheck = time.time()
            elif time.time() - last_recheck > 3 * 60:
                # 没登录的平台每 3 分钟再看一眼：你刚在另一个窗口 login 完，这里很快就能接上
                bad = [p for p, a in accounts.items() if not a.get("ok")]
                if bad:
                    accounts.update(check_all({**cfg, "platforms": bad}))
                last_recheck = time.time()
            ip = check_ip()
            api.heartbeat(accounts, ip)
            ready = [p for p, a in accounts.items() if a.get("ok")]
            if not ip["ok"]:
                log.warning("出口 IP 不在国内（%s %s），不领任务；关掉 VPN 或把发布机放到没有 VPN 的电脑", ip.get("ip"), ip.get("where") or ip.get("msg"))
            elif not ready:
                log.warning("没有任何平台处于已登录状态，等待…（python publisher.py login 平台）")
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
            print(f"用法：python publisher.py {argv[1]} <xiaohongshu|douyin|kuaishou|zhihu>")
            return 2
        return cmd_login(cfg, argv[2]) if argv[1] == "login" else cmd_logout(cfg, argv[2])
    if argv[1] == "check":
        return cmd_check(cfg)
    if argv[1] == "card":
        return cmd_card(cfg)
    return cmd_run(cfg)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
