"""YouTube：视频发完后自己评论一条（推广链接）并尝试置顶。

复用 sau 的 YouTube 登录态（vendor/cookies/youtube_main.json，storage_state），和上传一样用本机 Google Chrome 有界面跑。
竖版短视频会被当成 Shorts（打开是 /shorts/ 页，评论在右侧面板里）；普通视频评论在播放器下方。
元素是按当前页面写的，失败会截图 logs/yt-comment-*.png。
"""
from __future__ import annotations

import re
import time
from pathlib import Path

from patchright.sync_api import Page, sync_playwright


def _latest_video_url(page: Page) -> str:
    """sau 没带出视频链接时：去 Studio 内容列表拿最新一条（先看 Shorts 标签，再看视频标签）"""
    page.goto("https://studio.youtube.com", wait_until="domcontentloaded", timeout=60000)
    for _ in range(20):
        page.wait_for_timeout(1000)
        m = re.search(r"/channel/([\w-]+)", page.url)
        if m:
            break
    else:
        return ""
    for tab in ("short", "upload"):
        page.goto(f"https://studio.youtube.com/channel/{m.group(1)}/videos/{tab}", wait_until="domcontentloaded", timeout=60000)
        link = page.locator('ytcp-video-row a[href*="/video/"]').first
        try:
            link.wait_for(state="attached", timeout=20000)
        except Exception:  # noqa: BLE001
            continue
        vid = re.search(r"/video/([\w-]{11})", link.get_attribute("href") or "")
        if vid:
            return f"https://www.youtube.com/shorts/{vid.group(1)}" if tab == "short" else f"https://www.youtube.com/watch?v={vid.group(1)}"
    return ""


def _open_comment_box(page: Page) -> None:
    if "/shorts/" in page.url:
        page.locator('#comments-button button, button[aria-label*="评论"], button[aria-label*="omment"]').first.click(timeout=15000)
        page.wait_for_timeout(2500)
    else:
        for _ in range(10):
            if page.locator("#simplebox-placeholder").first.is_visible():
                break
            page.mouse.wheel(0, 700)
            page.wait_for_timeout(1500)
    ph = page.locator("#simplebox-placeholder:visible").first
    ph.wait_for(state="visible", timeout=30000)
    ph.click()


def _pin_first(page: Page) -> str:
    """置顶第一条评论（刚发的自己那条）。返回 "" = 置顶成功，否则是原因"""
    thread = page.locator("ytd-comment-thread-renderer:visible").first
    thread.wait_for(state="visible", timeout=15000)
    thread.hover()
    thread.locator("#action-menu button").first.click()
    page.wait_for_timeout(1000)
    item = page.locator("tp-yt-iron-dropdown tp-yt-paper-item:visible").filter(has_text=re.compile(r"^\s*(Pin|置顶)\s*$")).first
    if not item.count():
        page.keyboard.press("Escape")
        return "菜单里没有置顶"
    item.click()
    page.wait_for_timeout(2000)
    # 新频道：弹「积累频道历史记录后才能置顶」，只有一个「知道了」
    got_it = page.locator("yt-flow-bottom-bar-renderer button:visible").first
    if got_it.count():
        got_it.click()
        return "新频道 YouTube 暂不让置顶评论（要先积累频道历史）"
    page.locator("yt-confirm-dialog-renderer #confirm-button button:visible").first.click(timeout=15000)
    page.wait_for_timeout(2000)
    return ""


def comment(account_file: Path, url: str, text: str, shot_dir: Path) -> tuple[bool, str, str]:
    """url 为空就去 Studio 找最新一条。返回 (是否评论成功, 视频链接, 备注)；评论成功但没置顶上时备注写原因"""
    if not account_file.exists():
        return False, url, "YouTube 还没登录"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, channel="chrome")
        ctx = browser.new_context(storage_state=str(account_file), viewport={"width": 1280, "height": 900})
        page = ctx.new_page()

        def shot(tag: str):
            try:
                page.screenshot(path=str(shot_dir / f"yt-comment-{tag}-{int(time.time())}.png"))
            except Exception:
                pass

        try:
            url = url or _latest_video_url(page)
            if not url:
                shot("nourl")
                return False, "", "Studio 里没找到刚发的视频"
            # Shorts 页的评论在弹出面板里、元素常变，统一用普通播放页评论
            page.goto(re.sub(r"/shorts/([\w-]+)", r"/watch?v=\1", url), wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(5000)
            try:
                _open_comment_box(page)
            except Exception as e:  # noqa: BLE001
                shot("nobox")
                return False, url, f"没找到评论框（刚发的视频可能还在处理 / 评论被关了）：{str(e)[:120]}"
            editor = page.locator("#contenteditable-root:visible").first
            editor.wait_for(state="visible", timeout=15000)
            editor.click()
            for i, line in enumerate(text.split("\n")):
                if i:
                    page.keyboard.press("Shift+Enter")
                page.keyboard.type(line, delay=15)
            page.wait_for_timeout(800)
            page.locator("#submit-button:visible").first.click()
            page.wait_for_timeout(5000)
            try:
                why = _pin_first(page)
            except Exception as e:  # noqa: BLE001
                why = f"置顶出错：{str(e)[:80]}"
            if why:
                shot("nopin")
                return True, url, f"评论了，没置顶：{why}"
            return True, url, ""
        except Exception as e:  # noqa: BLE001
            shot("exc")
            return False, url, str(e)[:200]
        finally:
            try:
                ctx.storage_state(path=str(account_file))
            except Exception:
                pass
            browser.close()
