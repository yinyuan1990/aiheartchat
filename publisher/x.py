"""X（推特）视频帖适配器：social-auto-upload 没做 X，这里用 patchright 走网页（持久化浏览器目录 profiles/x）。

`python publisher.py login x` 打开有界面浏览器，你登录后自动检测到并关闭；发布也用有界面浏览器（X 对无头浏览器很敏感）。
要走本机的国外出口，所以不加 --no-proxy-server。免费账号视频最长 2 分 20 秒，文字按 280「权重字符」算（中文一个算 2）。
想让 X 把媒体标成敏感内容：在 X 的「设置 → 隐私与安全 → 你发的帖子 → 将你发布的媒体标记为可能包含敏感内容」手动打开一次。
"""
from __future__ import annotations

import time
from pathlib import Path

from patchright.sync_api import BrowserContext, Page, sync_playwright

HOME = "https://x.com/home"
LOGIN = "https://x.com/i/flow/login"
COMPOSE = "https://x.com/compose/post"


def _context(p, profile: Path, headless: bool) -> BrowserContext:
    profile.mkdir(parents=True, exist_ok=True)
    return p.chromium.launch_persistent_context(
        str(profile), headless=headless, channel="chromium", viewport={"width": 1280, "height": 900},
        args=["--disable-blink-features=AutomationControlled"],
    )


def _logged_in(page: Page) -> bool:
    try:
        return page.locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"]').first.is_visible()
    except Exception:
        return False


def login(profile: Path, timeout_sec: int = 600) -> tuple[bool, str]:
    with sync_playwright() as p:
        ctx = _context(p, profile, headless=False)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(LOGIN, wait_until="domcontentloaded")
        print("请在弹出的浏览器里登录 X（账号密码 / Google），登录成功后会自动关闭…")
        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            if "/home" in page.url or _logged_in(page):
                page.wait_for_timeout(3000)
                ctx.close()
                return True, "X 已登录"
            time.sleep(2)
        ctx.close()
        return False, "超时未完成登录"


def check(profile: Path, headless: bool = False) -> tuple[bool, str]:
    if not profile.exists():
        return False, "还没登录过，运行 python publisher.py login x"
    with sync_playwright() as p:
        ctx = _context(p, profile, headless)
        page = ctx.new_page()
        try:
            page.goto(HOME, wait_until="domcontentloaded", timeout=45000)
            for _ in range(20):
                if _logged_in(page):
                    return True, "已登录"
                if "/login" in page.url or "/i/flow" in page.url:
                    break
                page.wait_for_timeout(500)
            return False, "登录失效，重新 login x"
        finally:
            ctx.close()


def post_video(profile: Path, video: Path, text: str, headless: bool, shot_dir: Path, log=None) -> tuple[bool, str, str]:
    """发一条带视频的帖子。返回 (ok, url, error)；失败截图到 shot_dir"""

    def shot(tag: str):
        try:
            page.screenshot(path=str(shot_dir / f"x-{tag}-{int(time.time())}.png"))
        except Exception:
            pass

    with sync_playwright() as p:
        ctx = _context(p, profile, headless)
        page = ctx.new_page()
        try:
            page.goto(COMPOSE, wait_until="domcontentloaded", timeout=60000)
            box = page.locator('[data-testid="tweetTextarea_0"]').first
            try:
                box.wait_for(state="visible", timeout=30000)
            except Exception:
                shot("nobox")
                if "/login" in page.url or "/i/flow" in page.url:
                    return False, "", "X 登录失效（cookie expired），重新 login x"
                return False, "", "没找到发帖输入框（看 logs 截图）"
            box.click()
            for i, line in enumerate(text.split("\n")):
                if i:
                    page.keyboard.press("Shift+Enter")
                page.keyboard.type(line, delay=15)
            page.locator('input[data-testid="fileInput"]').first.set_input_files(str(video))
            btn = page.locator('[data-testid="tweetButton"]').first
            # 视频上传 + 转码：按钮可点才算好，最多等 10 分钟
            ready = False
            for i in range(600):
                page.wait_for_timeout(1000)
                if btn.count() and btn.is_enabled() and btn.get_attribute("aria-disabled") != "true":
                    ready = True
                    break
                if log and i and i % 60 == 0:
                    log.info("X 视频还在上传 / 处理（%d 秒）", i)
            if not ready:
                shot("notready")
                return False, "", "视频上传 10 分钟还没好（看 logs 截图）"
            page.wait_for_timeout(1500)
            btn.click()
            url = ""
            for _ in range(60):
                page.wait_for_timeout(1000)
                toast = page.locator('[data-testid="toast"]').first
                if toast.count() and toast.is_visible():
                    link = toast.locator('a[href*="/status/"]').first
                    if link.count():
                        href = link.get_attribute("href") or ""
                        url = href if href.startswith("http") else f"https://x.com{href}"
                    return True, url, ""
                if "/compose/post" not in page.url and not box.is_visible():
                    return True, url, ""
            shot("notsent")
            return False, "", "点了发布但没确认成功（看 logs 截图）"
        except Exception as e:  # noqa: BLE001
            shot("exc")
            return False, "", f"X 发布异常：{str(e)[:200]}"
        finally:
            ctx.close()
