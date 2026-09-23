"""微信视频号「图文动态」适配器。

登录 / cookie 校验复用 social-auto-upload 的 `sau tencent login|check`（cookie 文件 vendor/cookies/tencent_<账号>.json）；
上游只做了视频发布，图文是空壳（TencentNote 全是 NotImplementedError），这里自己用 patchright 走网页：
视频号助手 → 发表动态（/platform/post/create）→ 切到「图文」→ 传图 → 写描述（标题 + 正文 + #话题）→ 发表。
页面元素是按 2026-09 的视频号助手猜的，找不到会截图 + 把可见输入框 / 按钮文字写进日志，方便对着改。
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from patchright.sync_api import Page, sync_playwright

CREATE_URL = "https://channels.weixin.qq.com/platform/post/create"
HOME_URL = "https://channels.weixin.qq.com/platform"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


def _dump(page: Page, shot_dir: Path, tag: str, log) -> None:
    try:
        shot_dir.mkdir(exist_ok=True)
        page.screenshot(path=str(shot_dir / f"shipinhao-{tag}-{int(time.time())}.png"))
        info = page.evaluate(
            """() => ({
                url: location.href,
                inputs: Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]')).filter(e=>e.getClientRects().length)
                    .map(e=>({tag:e.tagName, type:e.type||'', ph:e.getAttribute('placeholder')||e.getAttribute('data-placeholder')||'', cls:(e.className||'').toString().slice(0,60)})),
                buttons: Array.from(document.querySelectorAll('button,[role=button],.weui-desktop-btn,.tab,[class*=tab]')).filter(e=>e.getClientRects().length)
                    .map(e=>(e.innerText||'').trim()).filter(t=>t && t.length<20).slice(0,40)
            })"""
        )
        log.error("视频号页面结构：%s", json.dumps(info, ensure_ascii=False)[:1500])
    except Exception:  # noqa: BLE001
        pass


def _first_visible(page: Page, selectors: list[str], timeout_ms: int = 15000):
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        for sel in selectors:
            loc = page.locator(sel).first
            try:
                if loc.count() and loc.is_visible():
                    return loc, sel
            except Exception:  # noqa: BLE001
                pass
        page.wait_for_timeout(500)
    return None, ""


def post_note(cookie_file: Path, images: list[Path], title: str, content: str, tags: list[str], headed: bool, shot_dir: Path, log) -> tuple[bool, str, str]:
    """→ (ok, url, error)"""
    if not cookie_file.exists():
        return False, "", "视频号还没登录（vendor/cookies 里没有 tencent 的 cookie）"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headed, channel="chromium", args=["--disable-blink-features=AutomationControlled"])
        ctx = browser.new_context(storage_state=str(cookie_file), user_agent=UA, viewport={"width": 1400, "height": 900}, locale="zh-CN")
        page = ctx.new_page()
        try:
            page.goto(CREATE_URL, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(3000)
            if "login" in page.url or page.locator("text=扫码登录").count():
                return False, "", "视频号登录失效，重新 login shipinhao"

            # 1. 切到「图文」
            tab, sel = _first_visible(page, [
                'text=/^图文$/', '.post-type-tab:has-text("图文")', '[class*="tab"]:has-text("图文")',
                'button:has-text("发表图文")', 'text=发表图文', 'text=图文动态', 'text=发布图文',
            ], 12000)
            if tab is None:
                # 也可能在首页有「发表图文」入口
                page.goto(HOME_URL, wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(2500)
                tab, sel = _first_visible(page, ['button:has-text("发表图文")', 'text=发表图文', 'text=图文'], 8000)
            if tab is None:
                _dump(page, shot_dir, "notab", log)
                return False, "", "没找到「图文」入口（看 logs 截图与日志里的按钮列表）"
            tab.click()
            log.info("视频号：切到图文（%s）", sel)
            page.wait_for_timeout(2000)

            # 2. 传图
            file_input = None
            for fr in page.frames:
                loc = fr.locator('input[type="file"]').first
                if loc.count():
                    file_input = loc
                    break
            if file_input is None:
                _dump(page, shot_dir, "nofile", log)
                return False, "", "没找到图片上传框"
            file_input.set_input_files([str(i) for i in images])
            log.info("视频号：已选择 %d 张图，等上传…", len(images))
            page.wait_for_timeout(4000 + 1500 * len(images))

            # 3. 描述：标题 + 正文 + 话题
            text = "\n".join(x for x in [title.strip(), content.strip(), " ".join(f"#{t}" for t in tags)] if x)
            box, sel = _first_visible(page, [
                '[contenteditable="true"]', 'textarea[placeholder*="描述"]', 'textarea[placeholder*="说点"]', 'textarea[placeholder*="添加"]', 'textarea',
            ], 15000)
            if box is None:
                _dump(page, shot_dir, "nobox", log)
                return False, "", "没找到描述输入框"
            box.click()
            page.keyboard.press("Control+A")
            page.keyboard.press("Delete")
            for i, line in enumerate(text.split("\n")):
                page.keyboard.type(line, delay=8)
                if i < text.count("\n"):
                    page.keyboard.press("Enter")
            page.wait_for_timeout(1000)
            # 标题框单独存在的话也填一下
            tbox = page.locator('input[placeholder*="标题"]').first
            if tbox.count() and tbox.is_visible() and title:
                tbox.fill(title[:22])

            # 4. 发表
            btn, sel = _first_visible(page, ['button:has-text("发表"):not(:has-text("草稿"))', '.form-btns button:has-text("发表")', 'button.weui-desktop-btn_primary:has-text("发表")'], 10000)
            if btn is None:
                _dump(page, shot_dir, "nobtn", log)
                return False, "", "没找到「发表」按钮"
            for _ in range(60):  # 图片上传中按钮会禁用，最多等 30 秒
                if btn.is_enabled():
                    break
                page.wait_for_timeout(500)
            btn.click()
            # 成功：跳到动态列表 / 离开 create 页
            for _ in range(40):
                page.wait_for_timeout(500)
                if "post/create" not in page.url or page.locator("text=发表成功").count():
                    return True, "", ""
                err = page.locator(".weui-desktop-toast, .weui-desktop-dialog__bd, [class*='toast']").first
                if err.count() and err.is_visible():
                    t = (err.inner_text() or "").strip()
                    if t and "成功" not in t:
                        _dump(page, shot_dir, "err", log)
                        return False, "", f"视频号提示：{t[:120]}"
            _dump(page, shot_dir, "notsent", log)
            return False, "", "点了发表但页面没变化（可能要人工确认 / 验证），看 logs 截图"
        except Exception as e:  # noqa: BLE001
            _dump(page, shot_dir, "exc", log)
            return False, "", f"视频号发布异常：{str(e)[:200]}"
        finally:
            try:
                ctx.storage_state(path=str(cookie_file))  # 刷新 cookie
            except Exception:  # noqa: BLE001
                pass
            ctx.close()
            browser.close()
