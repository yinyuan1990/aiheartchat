"""发布机控制台（小窗口）：登录各平台 / 检查状态 / 启停后台发布任务 / 看日志。

打包成 发布机.exe（build-exe.ps1）后双击即可；它自己不带浏览器和依赖，只是调用同目录的 .venv 和 publisher.py。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import messagebox, ttk

ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
PY = ROOT / ".venv" / "Scripts" / "python.exe"
LOG = ROOT / "logs" / "publisher.log"
CONFIG = ROOT / "config.json"
TASK = "PeiwanPublisher"
PLATFORMS = [("xiaohongshu", "小红书"), ("douyin", "抖音"), ("kuaishou", "快手"), ("zhihu", "知乎")]
ADMIN_URL = "https://admin.yyheart.com/"
CREATE_NO_WINDOW = 0x08000000


def run_hidden(cmd: list[str], timeout: int = 60) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, creationflags=CREATE_NO_WINDOW, cwd=str(ROOT))
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except Exception as e:  # noqa: BLE001
        return 1, str(e)


def task_state() -> str:
    code, out = run_hidden(["powershell", "-NoProfile", "-Command", f"(Get-ScheduledTask -TaskName {TASK} -ErrorAction SilentlyContinue).State"], 30)
    s = out.strip()
    if not s or code != 0:
        return "未安装"
    return {"Running": "运行中", "Ready": "已停止", "Disabled": "已禁用"}.get(s, s)


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("心之音 · 发布机")
        self.geometry("760x560")
        self.minsize(680, 480)
        self.busy = False
        self._build()
        self.after(300, self.refresh_status)
        self.after(1000, self.tail_log)

    # ---------- UI ----------
    def _build(self):
        top = ttk.Frame(self, padding=10)
        top.pack(fill="x")
        ttk.Label(top, text="后台发布任务：").grid(row=0, column=0, sticky="w")
        self.lbl_task = ttk.Label(top, text="…", font=("Microsoft YaHei", 10, "bold"))
        self.lbl_task.grid(row=0, column=1, sticky="w")
        ttk.Button(top, text="启动", command=lambda: self.task("start")).grid(row=0, column=2, padx=4)
        ttk.Button(top, text="停止", command=lambda: self.task("stop")).grid(row=0, column=3, padx=4)
        ttk.Button(top, text="重启", command=lambda: self.task("restart")).grid(row=0, column=4, padx=4)
        ttk.Button(top, text="打开后台网页", command=lambda: webbrowser.open(ADMIN_URL)).grid(row=0, column=5, padx=12)

        box = ttk.LabelFrame(self, text="平台登录（点「登录」弹浏览器扫码；状态来自最近一次检查）", padding=10)
        box.pack(fill="x", padx=10)
        self.lbl_acc: dict[str, ttk.Label] = {}
        for i, (key, name) in enumerate(PLATFORMS):
            ttk.Label(box, text=name, width=8).grid(row=i, column=0, sticky="w", pady=3)
            lbl = ttk.Label(box, text="未检查", width=44)
            lbl.grid(row=i, column=1, sticky="w")
            self.lbl_acc[key] = lbl
            ttk.Button(box, text="登录", command=lambda k=key, n=name: self.login(k, n)).grid(row=i, column=2, padx=4)
        ttk.Button(box, text="检查全部登录状态并上报后台", command=self.check).grid(row=len(PLATFORMS), column=0, columnspan=3, sticky="w", pady=(8, 0))

        mid = ttk.Frame(self, padding=(10, 6))
        mid.pack(fill="x")
        ttk.Label(mid, text="发布机 token：").pack(side="left")
        self.var_token = tk.StringVar(value=self.read_token())
        ttk.Entry(mid, textvariable=self.var_token, width=54).pack(side="left", padx=4)
        ttk.Button(mid, text="保存", command=self.save_token).pack(side="left")
        ttk.Button(mid, text="看卡片样式", command=self.card).pack(side="left", padx=(16, 0))
        ttk.Button(mid, text="打开日志文件夹", command=lambda: os.startfile(str(LOG.parent))).pack(side="left", padx=4)

        ttk.Label(self, text="日志（自动刷新）", padding=(10, 4, 0, 0)).pack(anchor="w")
        frame = ttk.Frame(self)
        frame.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        self.txt = tk.Text(frame, wrap="word", font=("Consolas", 9), state="disabled", bg="#fafafa")
        sb = ttk.Scrollbar(frame, command=self.txt.yview)
        self.txt.configure(yscrollcommand=sb.set)
        self.txt.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.status = ttk.Label(self, text="", padding=(10, 0, 10, 6), foreground="#8e8e93")
        self.status.pack(anchor="w")

    # ---------- 动作 ----------
    def set_busy(self, on: bool, msg: str = ""):
        self.busy = on
        self.status.configure(text=msg)

    def in_thread(self, fn):
        if self.busy:
            messagebox.showinfo("请稍等", "上一个操作还没结束")
            return
        threading.Thread(target=fn, daemon=True).start()

    def read_token(self) -> str:
        try:
            return json.loads(CONFIG.read_text(encoding="utf-8")).get("token", "")
        except Exception:  # noqa: BLE001
            return ""

    def save_token(self):
        try:
            cfg = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
            cfg["token"] = self.var_token.get().strip()
            CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
            self.status.configure(text="token 已保存；改了 token 记得点「重启」")
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("保存失败", str(e))

    def task(self, action: str):
        def work():
            self.set_busy(True, f"正在{'启动' if action == 'start' else '停止' if action == 'stop' else '重启'}后台任务…")
            if action in ("stop", "restart"):
                run_hidden(["powershell", "-NoProfile", "-Command", f"Stop-ScheduledTask -TaskName {TASK} -ErrorAction SilentlyContinue"], 30)
                # 计划任务 Stop 只结束主进程，把残留的 python 子进程一起清掉
                run_hidden(["powershell", "-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*publisher.py run*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], 30)
            if action in ("start", "restart"):
                code, out = run_hidden(["powershell", "-NoProfile", "-Command", f"Start-ScheduledTask -TaskName {TASK}"], 30)
                if code != 0:
                    self.after(0, lambda: messagebox.showerror("启动失败", out or "计划任务不存在，先运行 install-task.ps1"))
            self.set_busy(False, "")
            self.after(500, self.refresh_status)
        self.in_thread(work)

    def login(self, key: str, name: str):
        def work():
            self.set_busy(True, f"正在打开 {name} 登录窗口，请用手机 {name} App 扫码…（最长等 10 分钟）")
            code, out = run_hidden([str(PY), "publisher.py", "login", key], 660)
            tail = out.strip().splitlines()[-1] if out.strip() else ""
            self.set_busy(False, ("✓ " if code == 0 else "✗ ") + f"{name}：{tail[:120]}")
            self.after(200, lambda: self.after_check_ui(out))
        self.in_thread(work)

    def check(self):
        def work():
            self.set_busy(True, "正在检查四个平台登录状态（每个几秒）…")
            code, out = run_hidden([str(PY), "publisher.py", "check"], 300)
            self.set_busy(False, "检查完成" if code == 0 else "检查出错，看日志")
            self.after(200, lambda: self.after_check_ui(out))
        self.in_thread(work)

    def after_check_ui(self, out: str):
        for key, name in PLATFORMS:
            for line in out.splitlines():
                if f"{name} 登录状态" in line:
                    ok = "OK" in line
                    self.lbl_acc[key].configure(text=("已登录" if ok else "未登录 / 失效") + "  " + line.split("（", 1)[-1].rstrip("）")[:40], foreground="#1a9c4b" if ok else "#d33")

    def card(self):
        def work():
            self.set_busy(True, "正在渲染示例卡片…")
            code, out = run_hidden([str(PY), "publisher.py", "card"], 120)
            self.set_busy(False, "")
            p = ROOT / "cards" / "sample-1.png"
            if code == 0 and p.exists():
                os.startfile(str(p))
            else:
                self.after(0, lambda: messagebox.showerror("渲染失败", out[-500:]))
        self.in_thread(work)

    # ---------- 定时 ----------
    def refresh_status(self):
        def work():
            s = task_state()
            self.after(0, lambda: self.lbl_task.configure(text=s, foreground="#1a9c4b" if s == "运行中" else "#d33"))
        threading.Thread(target=work, daemon=True).start()
        # 从日志里带出最近一次各平台状态
        try:
            lines = LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-400:]
            for key, name in PLATFORMS:
                for line in reversed(lines):
                    if f"{name} 登录状态" in line:
                        ok = "OK" in line
                        self.lbl_acc[key].configure(text=("已登录" if ok else "未登录 / 失效") + "  " + line[:5], foreground="#1a9c4b" if ok else "#d33")
                        break
        except Exception:  # noqa: BLE001
            pass
        self.after(20000, self.refresh_status)

    def tail_log(self):
        try:
            text = LOG.read_text(encoding="utf-8", errors="replace")
            tail = "\n".join(text.splitlines()[-150:])
        except Exception:  # noqa: BLE001
            tail = "（还没有日志）"
        cur = self.txt.get("1.0", "end-1c")
        if cur != tail:
            self.txt.configure(state="normal")
            self.txt.delete("1.0", "end")
            self.txt.insert("end", tail)
            self.txt.see("end")
            self.txt.configure(state="disabled")
        self.after(3000, self.tail_log)


if __name__ == "__main__":
    if not PY.exists():
        messagebox.showerror("没安装", f"找不到 {PY}\n请先在 publisher 目录运行 setup.ps1")
        sys.exit(1)
    App().mainloop()
