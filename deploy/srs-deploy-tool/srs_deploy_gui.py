# -*- coding: utf-8 -*-
"""
心之音 SRS 节点一键部署 · 图形界面

只做一件事：把同目录（或打包内置）的 srs-node-install.sh 传到新机（Ubuntu 22.04），以 root 跑起来，把日志实时显示出来。
所有部署逻辑都在 srs-node-install.sh 里：
  - 从「源节点」（默认 = 后台「SRS 节点」里标记为默认的那台）复制源码/配置/二进制/systemd，只改 candidate
  - 装好后写进主服务器的 srs_node 表，后台立即可见，通话/语音房按优先级 + 最大连接数自动分配
本程序不改任何服务器配置，不保存任何密码（只记住 IP / 端口 / 优先级等）。

打包成 exe：见同目录 build.bat
"""
import datetime as _dt
import json
import os
import re
import shlex
import socket
import sys
import threading
import tkinter as tk
from tkinter import messagebox, ttk
from tkinter.scrolledtext import ScrolledText

import paramiko

APP_TITLE = "心之音 · SRS 节点一键部署"
SCRIPT_NAME = "srs-node-install.sh"
REMOTE_SCRIPT = "/root/srs-node-install.sh"
REMOTE_RUNNER = "/root/.srs_deploy_runner.sh"
REMOTE_PW_SRC = "/root/.srs_deploy_pw_src_in"
REMOTE_PW_MAIN = "/root/.srs_deploy_pw_main_in"
DEFAULT_MAIN = "8.162.5.160"
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def app_dir() -> str:
    """exe 所在目录（PyInstaller）或脚本目录"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def bundled_dir() -> str:
    return getattr(sys, "_MEIPASS", app_dir())


def load_script_bytes() -> tuple[bytes, str]:
    """优先用 exe 旁边的 srs-node-install.sh（方便改脚本不重打包），否则用打包内置的"""
    side = os.path.join(app_dir(), SCRIPT_NAME)
    inner = os.path.join(bundled_dir(), SCRIPT_NAME)
    path = side if os.path.isfile(side) else inner
    with open(path, "rb") as f:
        data = f.read()
    data = data.replace(b"\r\n", b"\n")  # Windows 传上去常带 CRLF，这里先修
    src = "exe 同目录" if path == side else "内置"
    return data, f"{src} {path}"


CONF_PATH = os.path.join(app_dir(), "srs-deploy-tool.json")


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("960x700")
        self.minsize(800, 540)
        self.running = False
        self.log_fp = None
        self._build()
        self._load_conf()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ---------------- UI ----------------
    def _build(self):
        pad = {"padx": 6, "pady": 3}
        frm = ttk.LabelFrame(self, text="新机（Ubuntu 22.04，以 root 登录）")
        frm.pack(fill="x", padx=10, pady=(10, 4))

        self.v_host = tk.StringVar()
        self.v_port = tk.StringVar(value="22")
        self.v_pw = tk.StringVar()
        self.v_pubip = tk.StringVar()

        r = 0
        ttk.Label(frm, text="新机 IP").grid(row=r, column=0, sticky="e", **pad)
        ttk.Entry(frm, textvariable=self.v_host, width=22).grid(row=r, column=1, sticky="w", **pad)
        ttk.Label(frm, text="SSH 端口").grid(row=r, column=2, sticky="e", **pad)
        ttk.Entry(frm, textvariable=self.v_port, width=8).grid(row=r, column=3, sticky="w", **pad)
        ttk.Label(frm, text="新机 root 密码").grid(row=r, column=4, sticky="e", **pad)
        ttk.Entry(frm, textvariable=self.v_pw, width=30, show="*").grid(row=r, column=5, sticky="w", **pad)
        r += 1
        ttk.Label(frm, text="公网 IP(可空=自动)").grid(row=r, column=0, sticky="e", **pad)
        ttk.Entry(frm, textvariable=self.v_pubip, width=22).grid(row=r, column=1, sticky="w", **pad)
        ttk.Label(frm, text="云厂商内网机自动探测不准时手工填；写进 srs.conf 的 candidate 与后台节点表",
                  foreground="#666").grid(row=r, column=2, columnspan=4, sticky="w", **pad)

        frm2 = ttk.LabelFrame(self, text="复制源 与 主服务器")
        frm2.pack(fill="x", padx=10, pady=4)
        self.v_main = tk.StringVar(value=DEFAULT_MAIN)
        self.v_main_pw = tk.StringVar()
        self.v_src = tk.StringVar()
        self.v_src_pw = tk.StringVar()
        r = 0
        ttk.Label(frm2, text="主服务器 IP").grid(row=r, column=0, sticky="e", **pad)
        ttk.Entry(frm2, textvariable=self.v_main, width=22).grid(row=r, column=1, sticky="w", **pad)
        ttk.Label(frm2, text="主服务器 root 密码").grid(row=r, column=2, sticky="e", **pad)
        ttk.Entry(frm2, textvariable=self.v_main_pw, width=30, show="*").grid(row=r, column=3, sticky="w", **pad)
        ttk.Label(frm2, text="（应用服务器：查默认节点、写 srs_node 表）", foreground="#666").grid(row=r, column=4, sticky="w", **pad)
        r += 1
        ttk.Label(frm2, text="源节点 IP(可空=后台默认节点)").grid(row=r, column=0, sticky="e", **pad)
        ttk.Entry(frm2, textvariable=self.v_src, width=22).grid(row=r, column=1, sticky="w", **pad)
        ttk.Label(frm2, text="源节点 root 密码").grid(row=r, column=2, sticky="e", **pad)
        ttk.Entry(frm2, textvariable=self.v_src_pw, width=30, show="*").grid(row=r, column=3, sticky="w", **pad)
        ttk.Label(frm2, text="（从它复制源码/配置/二进制；后台「SRS 节点 → 设为默认」可换）", foreground="#666").grid(row=r, column=4, sticky="w", **pad)

        frm3 = ttk.LabelFrame(self, text="登记到后台「SRS 节点」")
        frm3.pack(fill="x", padx=10, pady=4)
        self.v_name = tk.StringVar(value="新节点")
        self.v_prio = tk.StringVar(value="200")
        self.v_max = tk.StringVar(value="40")
        self.v_remark = tk.StringVar(value="")
        r = 0
        ttk.Label(frm3, text="节点名称").grid(row=r, column=0, sticky="e", **pad)
        ttk.Entry(frm3, textvariable=self.v_name, width=22).grid(row=r, column=1, sticky="w", **pad)
        ttk.Label(frm3, text="优先级").grid(row=r, column=2, sticky="e", **pad)
        ttk.Entry(frm3, textvariable=self.v_prio, width=8).grid(row=r, column=3, sticky="w", **pad)
        ttk.Label(frm3, text="最大连接数").grid(row=r, column=4, sticky="e", **pad)
        ttk.Entry(frm3, textvariable=self.v_max, width=8).grid(row=r, column=5, sticky="w", **pad)
        ttk.Label(frm3, text="备注").grid(row=r, column=6, sticky="e", **pad)
        ttk.Entry(frm3, textvariable=self.v_remark, width=24).grid(row=r, column=7, sticky="w", **pad)
        r += 1
        ttk.Label(frm3, text="优先级越小越优先（老节点 100）；连接数 = 该节点上通话人数 + 语音房人数，满了自动落到下一个节点",
                  foreground="#666").grid(row=r, column=0, columnspan=8, sticky="w", **pad)

        bar = ttk.Frame(self)
        bar.pack(fill="x", padx=10, pady=4)
        self.btn_go = ttk.Button(bar, text="一键部署", command=lambda: self._start("install"))
        self.btn_go.pack(side="left", padx=(0, 6))
        self.btn_status = ttk.Button(bar, text="只看状态", command=lambda: self._start("status"))
        self.btn_status.pack(side="left")
        self.v_status = tk.StringVar(value="就绪")
        ttk.Label(bar, textvariable=self.v_status).pack(side="right")

        self.txt = ScrolledText(self, wrap="word", font=("Consolas", 10), state="disabled",
                                background="#111", foreground="#ddd", insertbackground="#ddd")
        self.txt.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        for tag, color in (("ok", "#5fd75f"), ("bad", "#ff5f5f"), ("warn", "#ffd75f"), ("sys", "#7fbfff")):
            self.txt.tag_config(tag, foreground=color)

    # ---------------- 配置记忆（不存密码） ----------------
    _CONF_KEYS = ("host", "port", "main", "src", "name", "prio", "max", "remark")

    def _vars(self):
        return dict(zip(self._CONF_KEYS, (self.v_host, self.v_port, self.v_main, self.v_src,
                                          self.v_name, self.v_prio, self.v_max, self.v_remark)))

    def _load_conf(self):
        try:
            with open(CONF_PATH, "r", encoding="utf-8") as f:
                c = json.load(f)
            for k, v in self._vars().items():
                if c.get(k):
                    v.set(c[k])
        except Exception:
            pass

    def _save_conf(self):
        try:
            with open(CONF_PATH, "w", encoding="utf-8") as f:
                json.dump({k: v.get() for k, v in self._vars().items()}, f, ensure_ascii=False, indent=1)
        except Exception:
            pass

    # ---------------- 日志 ----------------
    def log(self, line: str, tag: str | None = None):
        line = ANSI_RE.sub("", line).rstrip("\r\n")
        if tag is None:
            if "[INFO] 完成" in line or "已登记" in line or "可直接运行" in line:
                tag = "ok"
            elif "[FAIL]" in line or "SQL_FAILED" in line:
                tag = "bad"
            elif "[WARN]" in line:
                tag = "warn"
            elif "[INFO]" in line:
                tag = "sys"
        if self.log_fp:
            try:
                self.log_fp.write(line + "\n")
                self.log_fp.flush()
            except Exception:
                pass

        def _append():
            self.txt.configure(state="normal")
            self.txt.insert("end", line + "\n", tag or ())
            self.txt.see("end")
            self.txt.configure(state="disabled")

        self.after(0, _append)

    def _set_status(self, s: str):
        self.after(0, lambda: self.v_status.set(s))

    # ---------------- 主流程 ----------------
    def _start(self, mode: str):
        if self.running:
            return
        host = self.v_host.get().strip()
        pw = self.v_pw.get()
        main_pw = self.v_main_pw.get()
        src_pw = self.v_src_pw.get()
        if not host or not pw:
            messagebox.showwarning(APP_TITLE, "请填写新机 IP 和 root 密码")
            return
        if not main_pw:
            messagebox.showwarning(APP_TITLE, "请填写主服务器 root 密码（脚本要去主服务器查默认节点、登记本机）")
            return
        if mode == "install" and not src_pw:
            messagebox.showwarning(APP_TITLE, "请填写源节点 root 密码（脚本要从源节点复制源码与配置）")
            return
        try:
            port = int(self.v_port.get().strip() or "22")
            int(self.v_prio.get().strip() or "200")
            if int(self.v_max.get().strip() or "40") < 1:
                raise ValueError
        except ValueError:
            messagebox.showwarning(APP_TITLE, "端口 / 优先级 / 最大连接数 必须是数字（最大连接数 ≥ 1）")
            return
        self._save_conf()
        self.running = True
        self.btn_go.configure(state="disabled")
        self.btn_status.configure(state="disabled")
        self.txt.configure(state="normal")
        self.txt.delete("1.0", "end")
        self.txt.configure(state="disabled")
        ts = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        log_path = os.path.join(app_dir(), f"srs-deploy-{host}-{ts}.log")
        try:
            self.log_fp = open(log_path, "w", encoding="utf-8")
        except Exception:
            self.log_fp = None
        self.log(f"[本地] 日志文件: {log_path}", "sys")
        threading.Thread(target=self._worker, args=(mode, host, port, pw, main_pw, src_pw), daemon=True).start()

    def _worker(self, mode, host, port, pw, main_pw, src_pw):
        rc = -1
        cli = None
        try:
            self._set_status("连接中…")
            self.log(f"[本地] 连接 root@{host}:{port} …", "sys")
            cli = paramiko.SSHClient()
            cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            cli.connect(host, port=port, username="root", password=pw, timeout=20,
                        banner_timeout=30, auth_timeout=30, allow_agent=False, look_for_keys=False)
            cli.get_transport().set_keepalive(30)
            self.log("[本地] SSH 已连接", "sys")

            script, src = load_script_bytes()
            self.log(f"[本地] 脚本来源: {src}（{len(script)} 字节，已转 LF）", "sys")

            env_lines = [
                f"export MAIN_PW=\"$(cat {REMOTE_PW_MAIN})\"",
                f"export SRC_PW=\"$(cat {REMOTE_PW_SRC})\"",
                f"export MAIN_SRV={shlex.quote(self.v_main.get().strip() or DEFAULT_MAIN)}",
                f"export PRIORITY={shlex.quote(self.v_prio.get().strip() or '200')}",
                f"export MAX_CONN={shlex.quote(self.v_max.get().strip() or '40')}",
                f"export NAME={shlex.quote(self.v_name.get().strip() or '新节点')}",
            ]
            if self.v_src.get().strip():
                env_lines.append(f"export SRC_NODE={shlex.quote(self.v_src.get().strip())}")
            if self.v_remark.get().strip():
                env_lines.append(f"export REMARK={shlex.quote(self.v_remark.get().strip())}")
            pub = self.v_pubip.get().strip()
            if pub:
                env_lines.append(f"export PUBLIC_IP={shlex.quote(pub)}")
            arg = "status" if mode == "status" else ""
            runner = "#!/bin/bash\ncd /root\n" + "\n".join(env_lines) + \
                     f"\nbash {REMOTE_SCRIPT} {arg}\nrc=$?\nrm -f {REMOTE_PW_SRC} {REMOTE_PW_MAIN} {REMOTE_RUNNER}\nexit $rc\n"

            sftp = cli.open_sftp()
            with sftp.file(REMOTE_SCRIPT, "wb") as f:
                f.write(script)
            sftp.chmod(REMOTE_SCRIPT, 0o700)
            with sftp.file(REMOTE_PW_MAIN, "wb") as f:
                f.write(main_pw.encode("utf-8"))
            sftp.chmod(REMOTE_PW_MAIN, 0o600)
            with sftp.file(REMOTE_PW_SRC, "wb") as f:
                f.write(src_pw.encode("utf-8"))
            sftp.chmod(REMOTE_PW_SRC, 0o600)
            with sftp.file(REMOTE_RUNNER, "wb") as f:
                f.write(runner.encode("utf-8"))
            sftp.chmod(REMOTE_RUNNER, 0o700)
            sftp.close()
            if mode == "status":
                self.log(f"[本地] 已上传 {REMOTE_SCRIPT}，查看状态。", "sys")
            else:
                self.log(f"[本地] 已上传 {REMOTE_SCRIPT}，开始部署。复制二进制直接可用约 1~2 分钟；若需本机编译约 10~15 分钟，请勿关闭窗口。", "sys")
            self._set_status("执行中…")

            # 用 pty：stderr 合流、行缓冲；LANG 保证中文不被 bash 转义
            chan = cli.get_transport().open_session()
            chan.get_pty(width=200)
            chan.settimeout(60)
            chan.exec_command(f"LANG=C.UTF-8 bash {REMOTE_RUNNER}")
            buf = b""
            while True:
                try:
                    data = chan.recv(4096)
                except socket.timeout:
                    if chan.exit_status_ready():
                        break
                    continue
                if not data:
                    break
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    self.log(line.decode("utf-8", "replace"))
            if buf:
                self.log(buf.decode("utf-8", "replace"))
            rc = chan.recv_exit_status()
            chan.close()
        except paramiko.AuthenticationException:
            self.log("[本地] ❌ SSH 认证失败：新机 root 密码不对，或该机禁止 root 密码登录", "bad")
        except Exception as e:  # noqa: BLE001
            self.log(f"[本地] ❌ 出错: {type(e).__name__}: {e}", "bad")
        finally:
            try:
                if cli:
                    cli.close()
            except Exception:
                pass
            if rc == 0:
                self.log("[本地] ✅ 脚本执行完毕。记得去云控制台安全组放行 TCP 1935/1985/7001、UDP 7999；后台「SRS 节点」可看到本机。", "ok")
                self._set_status("完成")
            else:
                self.log(f"[本地] ❌ 脚本返回 {rc}，看上面的 [FAIL] 行；服务器上完整日志 /root/srs-node-install.log", "bad")
                self._set_status(f"失败（返回 {rc}）")
            if self.log_fp:
                try:
                    self.log_fp.close()
                except Exception:
                    pass
                self.log_fp = None
            self.running = False
            self.after(0, lambda: (self.btn_go.configure(state="normal"), self.btn_status.configure(state="normal")))

    def _on_close(self):
        if self.running and not messagebox.askyesno(APP_TITLE, "部署正在进行，关闭窗口会中断 SSH（服务器上的脚本也会随之被杀）。确定关闭？"):
            return
        self.destroy()


if __name__ == "__main__":
    App().mainloop()
