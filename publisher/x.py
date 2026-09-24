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


def _press(page: Page, btn, log=None) -> None:
    """X 打完字（尤其带链接出卡片后）会在 #layers 里盖一层透明全屏遮罩，鼠标点什么都被它吃掉：
    先正常点 5 秒，不行就直接按 Ctrl+Enter（发帖快捷键；刚打完字焦点还在输入框里，键盘不受遮罩影响），按钮还在再 JS 直接点"""
    try:
        btn.click(timeout=5000)
        return
    except Exception:  # noqa: BLE001
        if log:
            log.info("X 按钮被透明遮罩挡住点不动，改用 Ctrl+Enter")
    page.keyboard.press("Control+Enter")
    page.wait_for_timeout(3000)
    try:
        if btn.count() and btn.is_visible() and btn.get_attribute("aria-disabled") != "true":
            btn.evaluate("b => b.click()", timeout=5000)
    except Exception:  # noqa: BLE001
        pass


def _focus(loc) -> None:
    try:
        loc.click(timeout=5000)
    except Exception:  # noqa: BLE001
        loc.evaluate("e => e.focus()")


def _latest_status_url(page: Page) -> str:
    """发帖成功但 toast 没给链接时：去自己主页找最新一条（跳过置顶）"""
    prof = page.locator('[data-testid="AppTabBar_Profile_Link"]').first
    href = prof.get_attribute("href") if prof.count() else ""
    if not href:
        return ""
    page.goto(f"https://x.com{href}", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(4000)
    for art in page.locator('article[data-testid="tweet"]').all()[:5]:
        if art.locator('[data-testid="socialContext"]').count():
            continue
        a = art.locator('a[href*="/status/"]:has(time)').first
        if a.count():
            h = a.get_attribute("href") or ""
            return h if h.startswith("http") else f"https://x.com{h}"
    return ""


def _reply(page: Page, url: str, text: str, log=None) -> tuple[bool, str]:
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    box = page.locator('[data-testid="tweetTextarea_0"]').first
    box.wait_for(state="visible", timeout=30000)
    _focus(box)
    for i, line in enumerate(text.split("\n")):
        if i:
            page.keyboard.press("Shift+Enter")
        page.keyboard.type(line, delay=15)
    btn = page.locator('[data-testid="tweetButtonInline"]').first
    for _ in range(30):
        page.wait_for_timeout(1000)
        if btn.count() and btn.is_enabled() and btn.get_attribute("aria-disabled") != "true":
            break
    else:
        return False, "回复按钮一直不可点"
    page.wait_for_timeout(1000)
    _press(page, btn, log)
    # 有时点完会弹出完整的回复框（按钮在弹框里），要再点一次弹框里的
    dialog_btn = page.locator('[role="dialog"] [data-testid="tweetButton"]').first
    for _ in range(8):
        page.wait_for_timeout(1000)
        if dialog_btn.count() and dialog_btn.is_visible():
            if log:
                log.info("X 回复弹出了回复框，点框里的按钮")
            _press(page, dialog_btn, log)
            break
    # 输入框里还留着推广文字 = 没发出去
    probe = text.strip().splitlines()[0][:8]
    for _ in range(15):
        page.wait_for_timeout(1000)
        left = [t for t in page.locator('[data-testid="tweetTextarea_0"]').all() if t.is_visible() and probe in (t.inner_text() or "")]
        if not left:
            return True, ""
    return False, "点了回复但文字还在输入框里，没发出去"


def post_video(profile: Path, video: Path, text: str, headless: bool, shot_dir: Path, log=None, reply: str = "") -> tuple[bool, str, str]:
    return post_media(profile, [video], text, headless, shot_dir, log, reply)


def post_media(profile: Path, files: list[Path], text: str, headless: bool, shot_dir: Path, log=None, reply: str = "") -> tuple[bool, str, str]:
    """发一条帖子：files 是一个视频或最多 4 张图，text 可以为空（纯图）；reply 非空就发完再自己回复一条。
    返回 (ok, url, error)；失败截图到 shot_dir；回复失败只记日志，不算发布失败"""

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
            _focus(box)
            if text:
                for i, line in enumerate(text.split("\n")):
                    if i:
                        page.keyboard.press("Shift+Enter")
                    page.keyboard.type(line, delay=15)
            page.locator('input[data-testid="fileInput"]').first.set_input_files([str(f) for f in files])
            btn = page.locator('[data-testid="tweetButton"]').first
            # 上传（视频还要转码）：按钮可点才算好，最多等 10 分钟
            ready = False
            for i in range(600):
                page.wait_for_timeout(1000)
                if btn.count() and btn.is_enabled() and btn.get_attribute("aria-disabled") != "true":
                    ready = True
                    break
                if log and i and i % 60 == 0:
                    log.info("X 媒体还在上传 / 处理（%d 秒）", i)
            if not ready:
                shot("notready")
                return False, "", "媒体上传 10 分钟还没好（看 logs 截图）"
            page.wait_for_timeout(1500)
            _press(page, btn, log)
            url, sent = "", False
            for _ in range(60):
                page.wait_for_timeout(1000)
                toast = page.locator('[data-testid="toast"]').first
                if toast.count() and toast.is_visible():
                    link = toast.locator('a[href*="/status/"]').first
                    if link.count():
                        href = link.get_attribute("href") or ""
                        url = href if href.startswith("http") else f"https://x.com{href}"
                    sent = True
                    break
                if "/compose/post" not in page.url and not box.is_visible():
                    sent = True
                    break
            if not sent:
                shot("notsent")
                return False, "", "点了发布但没确认成功（看 logs 截图）"
            if reply:
                try:
                    page.wait_for_timeout(5000)
                    url = url or _latest_status_url(page)
                    ok, err = _reply(page, url, reply, log) if url else (False, "找不到刚发的帖子链接")
                except Exception as e:  # noqa: BLE001
                    ok, err = False, str(e)[:200]
                if log:
                    if ok:
                        log.info("X 已在 %s 下回复推广链接", url)
                    else:
                        shot("noreply")
                        log.warning("X 帖子发成功了，但回复推广链接失败：%s", err)
            return True, url, ""
        except Exception as e:  # noqa: BLE001
            shot("exc")
            return False, "", f"X 发布异常：{str(e)[:200]}"
        finally:
            ctx.close()
