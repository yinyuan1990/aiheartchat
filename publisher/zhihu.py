"""知乎「想法」（纯文本短帖）适配器。social-auto-upload 没做知乎，这里自己用 patchright 走网页。

登录态放在持久化浏览器目录 profiles/zhihu（不是 cookie 文件）：`python publisher.py login zhihu` 打开有界面浏览器，
你扫码 / 手机号登录后自动检测到并关闭；之后发布和检查都用这个目录无头跑。
"""
from __future__ import annotations

import time
from pathlib import Path

from patchright.sync_api import BrowserContext, Page, sync_playwright

HOME = "https://www.zhihu.com/"
SIGNIN = "https://www.zhihu.com/signin"
PIN_PAGE = "https://www.zhihu.com/pin"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


def _context(p, profile: Path, headless: bool) -> BrowserContext:
    profile.mkdir(parents=True, exist_ok=True)
    return p.chromium.launch_persistent_context(
        str(profile), headless=headless, viewport={"width": 1280, "height": 900}, user_agent=UA, locale="zh-CN",
        args=["--disable-blink-features=AutomationControlled"],
    )


def _me(page: Page) -> dict | None:
    """已登录时 /api/v4/me 回 200 + 用户信息，未登录 401"""
    try:
        r = page.request.get("https://www.zhihu.com/api/v4/me", timeout=15000)
        if r.ok:
            return r.json()
    except Exception:
        pass
    return None


def login(profile: Path, timeout_sec: int = 300) -> tuple[bool, str]:
    with sync_playwright() as p:
        ctx = _context(p, profile, headless=False)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(SIGNIN, wait_until="domcontentloaded")
        print("请在弹出的浏览器里登录知乎（扫码或手机号），登录成功后会自动关闭…")
        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            me = _me(page)
            if me and me.get("name"):
                ctx.close()
                return True, f"已登录：{me.get('name')}"
            time.sleep(2)
        ctx.close()
        return False, "超时未完成登录"


def check(profile: Path, headless: bool = True) -> tuple[bool, str]:
    if not profile.exists():
        return False, "还没登录过，运行 python publisher.py login zhihu"
    with sync_playwright() as p:
        ctx = _context(p, profile, headless)
        page = ctx.new_page()
        try:
            page.goto(HOME, wait_until="domcontentloaded", timeout=30000)
            me = _me(page)
            if me and me.get("name"):
                return True, f"已登录：{me.get('name')}"
            return False, "登录失效，重新 login zhihu"
        finally:
            ctx.close()


def post_pin(profile: Path, content: str, headless: bool, shot_dir: Path) -> tuple[bool, str, str]:
    """发一条想法。返回 (ok, url, error)。失败时截图到 shot_dir 方便排查。"""
    with sync_playwright() as p:
        ctx = _context(p, profile, headless)
        page = ctx.new_page()
        try:
            page.goto(PIN_PAGE, wait_until="domcontentloaded", timeout=45000)
            me = _me(page)
            if not me or not me.get("name"):
                return False, "", "知乎登录失效"
            page.wait_for_timeout(2500)
            # 想法页顶部就是编辑框（占位「分享你此刻的想法…」）；有些版本要先点一下占位才出现 contenteditable
            editor = None
            for sel in ['.PinEditor [contenteditable="true"]', '[data-testid="pin-editor"] [contenteditable="true"]', '.Editable-content[contenteditable="true"]', '[contenteditable="true"]']:
                loc = page.locator(sel).first
                if loc.count() and loc.is_visible():
                    editor = loc
                    break
            if editor is None:
                ph = page.get_by_text("分享你此刻的想法", exact=False).first
                if ph.count():
                    ph.click()
                    page.wait_for_timeout(1000)
                    loc = page.locator('[contenteditable="true"]').first
                    if loc.count():
                        editor = loc
            if editor is None:
                page.screenshot(path=str(shot_dir / f"zhihu-noeditor-{int(time.time())}.png"))
                return False, "", "没找到想法编辑框（知乎页面可能改版，看 logs 截图）"
            editor.click()
            page.wait_for_timeout(500)
            # 逐段输入：段落之间回车两次
            paras = [s for s in content.split("\n") if s.strip()]
            for i, para in enumerate(paras):
                page.keyboard.type(para, delay=12)
                if i < len(paras) - 1:
                    page.keyboard.press("Enter")
                    page.keyboard.press("Enter")
            page.wait_for_timeout(800)
            btn = None
            for sel in ['.PinEditor button:has-text("发布")', 'button:has-text("发布")']:
                loc = page.locator(sel).filter(has_not_text="定时").first
                if loc.count() and loc.is_visible() and loc.is_enabled():
                    btn = loc
                    break
            if btn is None:
                page.screenshot(path=str(shot_dir / f"zhihu-nobtn-{int(time.time())}.png"))
                return False, "", "没找到「发布」按钮"
            btn.click()
            page.wait_for_timeout(4000)
            # 发布后编辑框应清空；再查最新一条想法拿地址
            token = me.get("url_token") or ""
            url = ""
            if token:
                try:
                    r = page.request.get(f"https://www.zhihu.com/api/v4/members/{token}/pins?limit=1&offset=0", timeout=15000)
                    if r.ok:
                        data = r.json().get("data") or []
                        if data and data[0].get("id"):
                            created = int(data[0].get("created") or 0)
                            if time.time() - created < 300:
                                url = f"https://www.zhihu.com/pin/{data[0]['id']}"
                except Exception:
                    pass
            if not url:
                # 页面上没有报错、编辑框已清空也算成功
                err = page.locator(".Notification, .ErrorMessage, [class*='error']").first
                if err.count() and err.is_visible():
                    page.screenshot(path=str(shot_dir / f"zhihu-err-{int(time.time())}.png"))
                    return False, "", f"知乎提示：{err.inner_text()[:120]}"
                remain = (editor.inner_text() or "").strip() if editor.count() else ""
                if remain and remain[:20] in content:
                    page.screenshot(path=str(shot_dir / f"zhihu-notsent-{int(time.time())}.png"))
                    return False, "", "点了发布但内容没发出去（可能触发验证）"
            return True, url, ""
        except Exception as e:  # noqa: BLE001
            try:
                page.screenshot(path=str(shot_dir / f"zhihu-exc-{int(time.time())}.png"))
            except Exception:
                pass
            return False, "", f"知乎发布异常：{str(e)[:200]}"
        finally:
            ctx.close()
