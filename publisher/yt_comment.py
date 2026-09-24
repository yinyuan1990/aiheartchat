"""YouTube：视频发完后自己评论一条（推广链接）并尝试置顶。

复用 sau 的 YouTube 登录态（vendor/cookies/youtube_main.json，storage_state），和上传一样用本机 Google Chrome 有界面跑。
竖版短视频会被当成 Shorts（打开是 /shorts/ 页，评论在右侧面板里）；普通视频评论在播放器下方。
元素是按当前页面写的，失败会截图 logs/yt-comment-*.png。
"""
from __future__ import annotations

import time
from pathlib import Path

from patchright.sync_api import Page, sync_playwright


def _open_comment_box(page: Page) -> None:
    if "/shorts/" in page.url:
        page.locator("#comments-button button, #comments-button").first.click()
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


def _pin_first(page: Page) -> bool:
    thread = page.locator("ytd-comment-thread-renderer:visible").first
    thread.wait_for(state="visible", timeout=15000)
    thread.hover()
    thread.locator("#action-menu button").first.click()
    page.wait_for_timeout(1000)
    item = page.locator("ytd-menu-service-item-renderer:visible").filter(has_text="Pin").or_(
        page.locator("ytd-menu-service-item-renderer:visible").filter(has_text="置顶")).first
    if not item.count():
        page.keyboard.press("Escape")
        return False
    item.click()
    page.wait_for_timeout(1000)
    page.locator("#confirm-button:visible, yt-button-renderer#confirm-button:visible").first.click()
    page.wait_for_timeout(2000)
    return True


def comment(account_file: Path, url: str, text: str, shot_dir: Path) -> tuple[bool, str]:
    """返回 (是否评论成功, 备注)；评论成功但没置顶上时备注写原因"""
    if not account_file.exists():
        return False, "YouTube 还没登录"
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
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(5000)
            try:
                _open_comment_box(page)
            except Exception as e:  # noqa: BLE001
                shot("nobox")
                return False, f"没找到评论框（刚发的视频可能还在处理 / 评论被关了）：{str(e)[:120]}"
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
                pinned = _pin_first(page)
            except Exception as e:  # noqa: BLE001
                shot("nopin")
                return True, f"评论了但没置顶上：{str(e)[:80]}"
            if not pinned:
                shot("nopin")
            return True, "" if pinned else "评论了但菜单里没找到置顶"
        except Exception as e:  # noqa: BLE001
            shot("exc")
            return False, str(e)[:200]
        finally:
            try:
                ctx.storage_state(path=str(account_file))
            except Exception:
                pass
            browser.close()
