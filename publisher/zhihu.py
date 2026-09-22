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
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


def _context(p, profile: Path, headless: bool) -> BrowserContext:
    profile.mkdir(parents=True, exist_ok=True)
    # channel="chromium"：用完整 Chromium 的 new headless。默认的 headless shell 里知乎首页的想法编辑器（Draft.js）渲染不出来
    # --no-proxy-server：不走系统代理（本机开着 VPN 时，浏览器仍直连，发布定位才是国内；TUN 全局模式挡不住，见 publisher 的出口 IP 检查）
    return p.chromium.launch_persistent_context(
        str(profile), headless=headless, channel="chromium", viewport={"width": 1280, "height": 900}, user_agent=UA, locale="zh-CN",
        args=["--disable-blink-features=AutomationControlled", "--no-proxy-server"],
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


def post_pin(profile: Path, content: str, headless: bool, shot_dir: Path, title: str = "", dry_run: bool = False) -> tuple[bool, str, str]:
    """
    发一条想法。返回 (ok, url, error)。失败时截图到 shot_dir 方便排查。

    知乎当前（2026-09）的结构（/pin 页已 404）：首页顶部 `.WriteArea` 里有占位「分享此刻的想法...」，点一下展开编辑器：
    可选标题 `textarea[placeholder=标题]` + Draft.js 正文 `.public-DraftEditor-content[role=textbox]` + 蓝色「发布」按钮（有字才可点）。
    编辑器会自动存草稿，所以先全选删掉再输入。
    """
    def shot(tag: str):
        try:
            page.screenshot(path=str(shot_dir / f"zhihu-{tag}-{int(time.time())}.png"))
        except Exception:
            pass

    with sync_playwright() as p:
        ctx = _context(p, profile, headless)
        page = ctx.new_page()
        try:
            page.goto(HOME, wait_until="domcontentloaded", timeout=45000)
            me = _me(page)
            if not me or not me.get("name"):
                return False, "", "知乎登录失效"
            area = page.locator(".WriteArea").first
            try:
                area.wait_for(state="visible", timeout=20000)
            except Exception:
                shot("nowritearea")
                return False, "", "首页没找到写想法区域（知乎页面可能改版，看 logs 截图）"
            ph = area.get_by_text("分享此刻的想法", exact=False).first
            if ph.count():
                ph.click()
            editor = area.locator('.public-DraftEditor-content[role="textbox"], [contenteditable="true"]').first
            try:
                editor.wait_for(state="visible", timeout=20000)
            except Exception:
                shot("noeditor")
                return False, "", "想法编辑框没有展开（看 logs 截图）"
            # 清掉自动保存的旧草稿
            editor.click()
            page.keyboard.press("Control+A")
            page.keyboard.press("Delete")
            page.wait_for_timeout(300)
            if title:
                t = area.locator("textarea").first
                if t.count() and t.is_visible():
                    t.click()
                    t.fill("")
                    page.keyboard.type(title[:50], delay=15)
                    editor.click()
            paras = [s for s in content.split("\n") if s.strip()]
            for i, para in enumerate(paras):
                page.keyboard.type(para, delay=12)
                if i < len(paras) - 1:
                    page.keyboard.press("Enter")
            page.wait_for_timeout(1200)
            btn = area.locator('button:has-text("发布")').first
            if not btn.count():
                shot("nobtn")
                return False, "", "没找到「发布」按钮"
            for _ in range(20):
                if btn.is_enabled():
                    break
                page.wait_for_timeout(300)
            if not btn.is_enabled():
                shot("btndisabled")
                return False, "", "「发布」按钮一直是灰的（内容没输进去？）"
            if dry_run:
                # 只验证流程：截图留证，清掉输入，不点发布
                shot("dryrun")
                editor.click()
                page.keyboard.press("Control+A")
                page.keyboard.press("Delete")
                page.wait_for_timeout(500)
                return True, "", ""
            btn.click()
            # 发布成功后编辑器收回成占位；等最多 15 秒
            posted = False
            for _ in range(30):
                page.wait_for_timeout(500)
                if area.get_by_text("分享此刻的想法", exact=False).count() and not editor.is_visible():
                    posted = True
                    break
                err = page.locator(".Notification, .Toast, [class*='Toast'], [class*='error']").first
                if err.count() and err.is_visible():
                    txt = (err.inner_text() or "").strip()
                    if txt and "成功" not in txt:
                        shot("err")
                        return False, "", f"知乎提示：{txt[:120]}"
            url = ""
            token = me.get("url_token") or ""
            if token:
                try:
                    r = page.request.get(f"https://www.zhihu.com/api/v4/members/{token}/pins?limit=1&offset=0", timeout=15000)
                    if r.ok:
                        data = r.json().get("data") or []
                        if data and data[0].get("id") and time.time() - int(data[0].get("created") or 0) < 600:
                            url = f"https://www.zhihu.com/pin/{data[0]['id']}"
                            posted = True
                except Exception:
                    pass
            if not posted:
                shot("notsent")
                return False, "", "点了发布但没确认成功（可能触发验证，看 logs 截图）"
            return True, url, ""
        except Exception as e:  # noqa: BLE001
            shot("exc")
            return False, "", f"知乎发布异常：{str(e)[:200]}"
        finally:
            ctx.close()


