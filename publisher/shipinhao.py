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


_DUMP_JS = """() => {
  // 连 shadow DOM 一起翻（视频号助手部分组件把内容放在 shadow root 里，普通 querySelectorAll 看不到）
  const all = [];
  const walk = (root) => { for (const e of root.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot); } };
  walk(document);
  const vis = (e) => e.getClientRects().length;
  return {
    url: location.href,
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').slice(0, 300),
    inputs: all.filter(e => /^(INPUT|TEXTAREA)$/.test(e.tagName) || e.hasAttribute('contenteditable')).filter(vis)
        .map(e=>({tag:e.tagName, type:e.type||'', ce:e.getAttribute('contenteditable'), ph:e.getAttribute('placeholder')||e.getAttribute('data-placeholder')||'', cls:(e.className||'').toString().slice(0,60)})),
    clickables: all.filter(e => /^(BUTTON|A)$/.test(e.tagName) || e.getAttribute('role')==='button' || /btn|tab/.test((e.className||'').toString())).filter(vis)
        .map(e=>(e.innerText||'').trim().replace(/\\s+/g,' ')).filter(t=>t && t.length<24).slice(0,60)
  };
}"""


def _dump(page: Page, shot_dir: Path, tag: str, log) -> None:
    """截图 + 把每个 frame（视频号助手的正文在 iframe 里，主文档几乎是空的）里可见的输入框 / 可点元素写进日志"""
    try:
        shot_dir.mkdir(exist_ok=True)
        page.screenshot(path=str(shot_dir / f"shipinhao-{tag}-{int(time.time())}.png"))
        for fr in page.frames:
            try:
                info = fr.evaluate(_DUMP_JS)
                log.error("视频号 frame[%s]：%s", fr.url[:80], json.dumps(info, ensure_ascii=False)[:1400])
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass


def _first_visible(page: Page, selectors: list[str], timeout_ms: int = 15000):
    """在所有 frame 里找第一个可见的元素（视频号助手的内容在 iframe 里）"""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        for fr in page.frames:
            for sel in selectors:
                try:
                    loc = fr.locator(sel).first
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
            # /post/create 是「发表动态」= 纯视频表单，没有图文开关；图文入口在首页：
            # 「最近视频 | 最近图文」切到「最近图文」后，右上橙色按钮从「发表视频」变成「发表图文」
            page.goto(HOME_URL, wait_until="domcontentloaded", timeout=60000)
            try:
                page.wait_for_load_state("networkidle", timeout=20000)
            except Exception:  # noqa: BLE001
                pass
            page.wait_for_timeout(2000)
            login_el, _ = _first_visible(page, ["text=扫码登录", "text=微信扫码"], 1500)
            if "login" in page.url or login_el is not None:
                return False, "", "视频号登录失效，重新 login shipinhao"

            # 1. 首页 → 最近图文 → 发表图文
            tab, sel = _first_visible(page, ["text=最近图文"], 20000)
            if tab is None:
                _dump(page, shot_dir, "notab", log)
                return False, "", "首页没找到「最近图文」标签（看 logs 截图与日志）"
            tab.click()
            page.wait_for_timeout(1500)
            btn, sel = _first_visible(page, ['button:has-text("发表图文")', 'text=发表图文', 'a:has-text("发表图文")'], 15000)
            if btn is None:
                _dump(page, shot_dir, "nonotebtn", log)
                return False, "", "点了「最近图文」但没出现「发表图文」按钮（看 logs 截图与日志）"
            btn.click()
            log.info("视频号：进入发表图文（%s）", sel)
            page.wait_for_timeout(2000)
            if len(ctx.pages) > 1:  # 有些入口是新标签页打开
                page = ctx.pages[-1]
            try:
                page.wait_for_load_state("networkidle", timeout=20000)
            except Exception:  # noqa: BLE001
                pass
            page.wait_for_timeout(2500)
            log.info("视频号：图文发表页 URL = %s", page.url)
            _dump(page, shot_dir, "note-page", log)  # 记一次图文页结构，元素定下来后可删

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
            # 图文页（图文管理 / 发表动态）：「图文标题」input（填写标题，22 个字符内）+「图文描述」富文本（占位「添加描述，1000个字符内」）。
            # 描述框的 contenteditable 值不一定是 "true"，直接点占位文字聚焦最稳
            box, sel = _first_visible(page, [
                'text=添加描述', '[contenteditable]:not([contenteditable="false"])', '.input-editor', '[data-placeholder*="描述"]',
                'textarea[placeholder*="描述"]', 'textarea',
            ], 15000)
            if box is None:
                _dump(page, shot_dir, "nobox", log)
                return False, "", "没找到描述输入框"
            log.info("视频号：描述框（%s）", sel)
            box.click()
            page.wait_for_timeout(400)
            page.keyboard.press("Control+A")
            page.keyboard.press("Delete")
            body_text = "\n".join(x for x in [content.strip(), " ".join(f"#{t}" for t in tags)] if x) if title else text
            for i, line in enumerate(body_text.split("\n")):
                page.keyboard.type(line, delay=8)
                if i < body_text.count("\n"):
                    page.keyboard.press("Enter")
            page.keyboard.press("Escape")  # 收起 #话题 联想
            page.wait_for_timeout(800)
            # 图文标题
            tbox, _ = _first_visible(page, ['input[placeholder*="标题"]'], 3000)
            if tbox is not None and title:
                tbox.click()
                tbox.fill(title[:22])
                log.info("视频号：标题已填")

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
                ok_el, _ = _first_visible(page, ["text=发表成功", "text=发布成功"], 200)
                if ok_el is not None or all("post/create" not in fr.url for fr in page.frames):
                    return True, "", ""
                err, _ = _first_visible(page, [".weui-desktop-toast", ".weui-desktop-dialog__bd", "[class*='toast']"], 200)
                if err is not None:
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
