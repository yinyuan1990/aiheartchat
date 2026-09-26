"""TikTok 视频适配器：sau 的 tk_uploader 登录要靠调试器手点「继续」、发布有死循环，这里照 x.py 自写（patchright 持久化 profiles/tiktok）。

TikTok 对 IP 最敏感：注册 / 登录 / 发布必须一直是同一个住宅 IP，所以浏览器固定走本机 v2rayN（PROXY，出口 IPRoyal 美国静态住宅 IP）；
v2rayN 没开就直接失败，不会用别的出口去发。发布用有界面浏览器（和 X 一样，无头指纹容易被判脚本）。
文案（caption）= 标题 + 推广行 + 话题，TikTok 上限 4000 字；文案里的链接点不了，推广行写「link in bio」，主页简介里放带 ref 的链接。
"""
from __future__ import annotations

import time
from pathlib import Path

from patchright.sync_api import BrowserContext, Page, sync_playwright

PROXY = "http://127.0.0.1:10808"
LOGIN = "https://www.tiktok.com/login?lang=en"
UPLOAD = "https://www.tiktok.com/tiktokstudio/upload?lang=en"
CONTENT = "https://www.tiktok.com/tiktokstudio/content?lang=en"
CAPTION_MAX = 4000


def _context(p, profile: Path, headless: bool) -> BrowserContext:
    profile.mkdir(parents=True, exist_ok=True)
    return p.chromium.launch_persistent_context(
        str(profile), headless=headless, channel="chromium", viewport={"width": 1366, "height": 900}, locale="en-US",
        proxy={"server": PROXY}, args=["--disable-blink-features=AutomationControlled", "--lang=en-US"],
    )


def _session(ctx: BrowserContext) -> bool:
    now = time.time()
    return any(c["name"] == "sessionid" and c.get("value") and (c.get("expires", -1) in (-1, 0) or c["expires"] > now)
               for c in ctx.cookies("https://www.tiktok.com"))


def login(profile: Path, timeout_sec: int = 900) -> tuple[bool, str]:
    with sync_playwright() as p:
        ctx = _context(p, profile, headless=False)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(LOGIN, wait_until="domcontentloaded", timeout=90000)
        print("请在弹出的浏览器里登录 TikTok（邮箱 / 手机 / Google 都行），登录成功后会自动关闭…")
        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            if _session(ctx):
                page.wait_for_timeout(5000)
                ctx.close()
                return True, "TikTok 已登录"
            time.sleep(2)
        ctx.close()
        return False, "超时未完成登录"


def check(profile: Path) -> tuple[bool, str]:
    """只看本地登录态里的 sessionid，不开 TikTok 页面（定时访问会被判脚本）；真实状态由发布结果反映"""
    if not profile.exists():
        return False, "还没登录过，运行 python publisher.py login tiktok"
    with sync_playwright() as p:
        ctx = _context(p, profile, headless=True)
        try:
            return (True, "已登录（本地登录态）") if _session(ctx) else (False, "登录失效，重新 login tiktok")
        finally:
            ctx.close()


def _dismiss(page: Page) -> None:
    """上传页常见弹窗：自动内容检查 / 新功能引导 / cookie 条"""
    for name in ("Got it", "Not now", "Cancel", "Allow all", "Decline optional cookies"):
        try:
            b = page.get_by_role("button", name=name, exact=True)
            if b.count() and b.first.is_visible():
                b.first.click(timeout=3000)
                page.wait_for_timeout(500)
        except Exception:
            pass


def _mark_ai(page: Page, log=None) -> None:
    """打开「AI-generated content」开关（配图是 AI 生成的，TikTok 要求标注）；找不到只记日志"""
    try:
        more = page.get_by_text("Show more", exact=True)
        if more.count() and more.first.is_visible():
            more.first.click(timeout=3000)
            page.wait_for_timeout(800)
        row = page.locator("div", has_text="AI-generated content").filter(has=page.locator('[role="switch"], input[type="checkbox"]')).last
        sw = row.locator('[role="switch"], input[type="checkbox"]').first
        if not sw.count():
            raise RuntimeError("没找到开关")
        on = (sw.get_attribute("aria-checked") or "") == "true" or sw.is_checked()
        if not on:
            sw.click(timeout=3000, force=True)
            page.wait_for_timeout(800)
            _dismiss(page)
            turn_on = page.get_by_role("button", name="Turn on")
            if turn_on.count() and turn_on.first.is_visible():
                turn_on.first.click(timeout=3000)
        if log:
            log.info("TikTok 已标注 AI 生成内容")
    except Exception as e:  # noqa: BLE001
        if log:
            log.warning("TikTok AI 内容标注跳过：%s", str(e)[:120])


def _type_caption(page: Page, caption: str) -> None:
    box = page.locator('div[contenteditable="true"]').first
    box.wait_for(state="visible", timeout=120000)
    box.click()
    page.keyboard.press("Control+A")
    page.keyboard.press("Delete")
    body, tags = caption, []
    lines = caption.rstrip().split("\n")
    if lines and all(w.startswith("#") for w in lines[-1].split()):
        body, tags = "\n".join(lines[:-1]).rstrip(), lines[-1].split()
    for i, line in enumerate(body.split("\n")):
        if i:
            page.keyboard.press("Shift+Enter")
        if line:
            page.keyboard.insert_text(line)
    # 话题一个个敲：输入 # 会弹联想框，敲完空格让它收起，别用回车（回车会选中联想项）
    if tags:
        page.keyboard.press("Shift+Enter")
        for t in tags:
            page.keyboard.type(t, delay=60)
            page.wait_for_timeout(1200)
            page.keyboard.press("Space")
            page.wait_for_timeout(500)


def _latest_url(page: Page) -> str:
    try:
        page.goto(CONTENT, wait_until="domcontentloaded", timeout=60000)
        link = page.locator('a[href*="/video/"]').first
        link.wait_for(state="attached", timeout=30000)
        href = link.get_attribute("href") or ""
        return href if href.startswith("http") else f"https://www.tiktok.com{href}"
    except Exception:
        return ""


def post_video(profile: Path, video: Path, caption: str, shot_dir: Path, log=None, ai_label: bool = True) -> tuple[bool, str, str]:
    """发一条视频；返回 (ok, url, error)，失败截图到 shot_dir"""

    def shot(tag: str):
        try:
            page.screenshot(path=str(shot_dir / f"tiktok-{tag}-{int(time.time())}.png"))
        except Exception:
            pass

    with sync_playwright() as p:
        ctx = _context(p, profile, headless=False)
        page = ctx.new_page()
        try:
            try:
                page.goto(UPLOAD, wait_until="domcontentloaded", timeout=90000)
            except Exception as e:  # noqa: BLE001
                return False, "", f"打不开 TikTok（v2rayN 开着吗？代理 {PROXY}）：{str(e)[:120]}"
            page.wait_for_timeout(5000)
            if "/login" in page.url or not _session(ctx):
                shot("login")
                return False, "", "TikTok 登录失效（cookie expired），重新 login tiktok"
            _dismiss(page)
            inp = page.locator('input[type="file"]').first
            try:
                inp.wait_for(state="attached", timeout=60000)
            except Exception:
                shot("noinput")
                return False, "", "没找到上传入口（看 logs 截图）"
            inp.set_input_files(str(video))
            _type_caption(page, caption[:CAPTION_MAX])
            _dismiss(page)
            if ai_label:
                _mark_ai(page, log)
            btn = page.locator('button[data-e2e="post_video_button"]').first
            if not btn.count():
                btn = page.get_by_role("button", name="Post", exact=True).first
            ready = False
            for i in range(600):
                page.wait_for_timeout(1000)
                try:
                    if btn.is_visible() and btn.is_enabled() and btn.get_attribute("aria-disabled") != "true" and btn.get_attribute("data-disabled") != "true":
                        ready = True
                        break
                except Exception:
                    pass
                if log and i and i % 60 == 0:
                    log.info("TikTok 视频还在上传 / 处理（%d 秒）", i)
            if not ready:
                shot("notready")
                return False, "", "视频上传 10 分钟还没好（看 logs 截图）"
            page.wait_for_timeout(2000)
            btn.scroll_into_view_if_needed()
            btn.click(timeout=15000)
            sent = False
            for _ in range(90):
                page.wait_for_timeout(1000)
                # 内容检查没跑完会弹「Continue to post?」
                for name in ("Post now", "Post anyway", "Continue"):
                    b = page.get_by_role("button", name=name, exact=True)
                    if b.count() and b.first.is_visible():
                        b.first.click(timeout=5000)
                if "/tiktokstudio/content" in page.url or page.get_by_text("Your video has been uploaded").count() or page.get_by_text("Video published").count():
                    sent = True
                    break
            if not sent:
                shot("notsent")
                return False, "", "点了发布但没确认成功（看 logs 截图）"
            page.wait_for_timeout(5000)
            return True, _latest_url(page), ""
        except Exception as e:  # noqa: BLE001
            shot("error")
            return False, "", f"TikTok 发布异常：{str(e)[:200]}"
        finally:
            ctx.close()
