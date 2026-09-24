"""AI 生图小工具：手动输入提示词调阿里云百炼万相（默认 wan2.7-image），看效果用。

打包成 AI生图.exe（build-exe.ps1），双击即用。API Key 存同目录 config.json（不进 git），出图存 output/，每张旁边一个同名 .txt 记提示词和参数。
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import sys
import threading
import time
import tkinter as tk
from datetime import datetime
from io import BytesIO
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import requests
from PIL import Image, ImageTk

ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CONFIG = ROOT / "config.json"
OUTPUT = ROOT / "output"
BASE = "https://dashscope.aliyuncs.com/api/v1"
MODELS = ["wan2.7-image"]
SIZES = ["1080*1920（竖 9:16）", "1080*1440（竖 3:4）", "1440*1440（方）", "1920*1080（横 16:9）"]
PRICE = 0.2
THUMB = 220


def load_cfg() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def save_cfg(cfg: dict) -> None:
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def to_data_url(path: str) -> str:
    mime = mimetypes.guess_type(path)[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(Path(path).read_bytes()).decode()}"


def generate(key: str, model: str, prompt: str, size: str, n: int, sequential: bool, refs: list[str], on_status) -> list[bytes]:
    """提交异步任务 → 每 5 秒查一次 → 下载图片。返回图片字节"""
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    content = [{"image": to_data_url(p)} for p in refs] + [{"text": prompt}]
    params = {"n": n, "size": size, "watermark": False}
    if sequential:
        params["enable_sequential"] = True
    r = requests.post(
        f"{BASE}/services/aigc/image-generation/generation",
        headers={**headers, "X-DashScope-Async": "enable"},
        json={"model": model, "input": {"messages": [{"role": "user", "content": content}]}, "parameters": params},
        timeout=60,
    )
    d = r.json() if r.content else {}
    task = (d.get("output") or {}).get("task_id")
    if not task:
        raise RuntimeError(f"提交失败 {r.status_code} {d.get('code', '')} {d.get('message', '')}".strip())
    start = time.time()
    while time.time() - start < 900:
        time.sleep(5)
        t = requests.get(f"{BASE}/tasks/{task}", headers=headers, timeout=30).json()
        out = t.get("output") or {}
        st = out.get("task_status")
        on_status(f"生成中…（{st}，已等 {int(time.time() - start)} 秒）")
        if st == "SUCCEEDED":
            urls = [c.get("image") for ch in out.get("choices") or [] for c in (ch.get("message") or {}).get("content") or [] if c.get("image")]
            if not urls:
                raise RuntimeError("任务成功但没有返回图片（可能被内容审核拦了）")
            on_status(f"下载 {len(urls)} 张图…")
            return [requests.get(u, timeout=120).content for u in urls]
        if st in ("FAILED", "CANCELED", "UNKNOWN"):
            raise RuntimeError(f"任务 {st}：{out.get('code', '')} {out.get('message', '')}".strip())
    raise RuntimeError("等了 15 分钟还没出图")


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("AI 生图（阿里云百炼 · 万相）")
        self.geometry("1000x760")
        self.minsize(820, 600)
        self.cfg = load_cfg()
        self.refs: list[str] = []
        self.thumbs: list[ImageTk.PhotoImage] = []
        self.busy = False
        self._build()

    def _build(self):
        top = ttk.Frame(self, padding=10)
        top.pack(fill="x")
        ttk.Label(top, text="API Key：").grid(row=0, column=0, sticky="w")
        self.var_key = tk.StringVar(value=self.cfg.get("key", ""))
        self.ent_key = ttk.Entry(top, textvariable=self.var_key, width=60, show="•")
        self.ent_key.grid(row=0, column=1, columnspan=4, sticky="we", padx=4)
        ttk.Button(top, text="显示", command=lambda: self.ent_key.configure(show="" if self.ent_key.cget("show") else "•")).grid(row=0, column=5, padx=2)
        ttk.Button(top, text="保存", command=self.save_key).grid(row=0, column=6, padx=2)

        ttk.Label(top, text="模型：").grid(row=1, column=0, sticky="w", pady=(8, 0))
        self.var_model = tk.StringVar(value=self.cfg.get("model", MODELS[0]))
        ttk.Combobox(top, textvariable=self.var_model, values=MODELS, width=18).grid(row=1, column=1, sticky="w", padx=4, pady=(8, 0))
        ttk.Label(top, text="尺寸：").grid(row=1, column=2, sticky="e", pady=(8, 0))
        self.var_size = tk.StringVar(value=self.cfg.get("size", SIZES[0]))
        ttk.Combobox(top, textvariable=self.var_size, values=SIZES, width=20).grid(row=1, column=3, sticky="w", padx=4, pady=(8, 0))
        ttk.Label(top, text="张数：").grid(row=1, column=4, sticky="e", pady=(8, 0))
        self.var_n = tk.IntVar(value=int(self.cfg.get("n", 1)))
        ttk.Spinbox(top, from_=1, to=6, textvariable=self.var_n, width=4, command=self.update_cost).grid(row=1, column=5, sticky="w", pady=(8, 0))
        self.var_seq = tk.BooleanVar(value=bool(self.cfg.get("sequential", False)))
        ttk.Checkbutton(top, text="组图（多张人物 / 画风保持一致）", variable=self.var_seq).grid(row=1, column=6, sticky="w", pady=(8, 0))
        top.columnconfigure(1, weight=1)

        box = ttk.LabelFrame(self, text="提示词（中文就行；组图时可以写「第1张：… 第2张：…」）", padding=8)
        box.pack(fill="x", padx=10)
        self.txt = tk.Text(box, height=7, wrap="word", font=("Microsoft YaHei", 10))
        self.txt.pack(fill="x")
        self.txt.insert("1.0", self.cfg.get("prompt", "电影感写实，竖版，35mm胶片质感，自然光。一位二十多岁的年轻中国女性坐在雨后的咖啡馆窗边，看着窗外，神情若有所思。"))

        row = ttk.Frame(self, padding=(10, 6))
        row.pack(fill="x")
        ttk.Button(row, text="加参考图（可选，最多 3 张）", command=self.add_ref).pack(side="left")
        ttk.Button(row, text="清空参考图", command=self.clear_ref).pack(side="left", padx=4)
        self.lbl_refs = ttk.Label(row, text="没有参考图（纯文字生图）", foreground="#8e8e93")
        self.lbl_refs.pack(side="left", padx=8)
        ttk.Button(row, text="打开输出文件夹", command=lambda: (OUTPUT.mkdir(exist_ok=True), os.startfile(str(OUTPUT)))).pack(side="right")
        self.btn = ttk.Button(row, text="生成", command=self.start)
        self.btn.pack(side="right", padx=6)
        self.lbl_cost = ttk.Label(row, text="", foreground="#8e8e93")
        self.lbl_cost.pack(side="right", padx=6)
        self.var_n.trace_add("write", lambda *_: self.update_cost())
        self.update_cost()

        self.status = ttk.Label(self, text="", padding=(10, 0))
        self.status.pack(anchor="w")

        wrap = ttk.Frame(self)
        wrap.pack(fill="both", expand=True, padx=10, pady=(4, 10))
        self.canvas = tk.Canvas(wrap, bg="#f4f4f6", highlightthickness=0)
        sb = ttk.Scrollbar(wrap, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=sb.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.grid_frame = ttk.Frame(self.canvas)
        self.canvas.create_window((0, 0), window=self.grid_frame, anchor="nw")
        self.grid_frame.bind("<Configure>", lambda _e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind_all("<MouseWheel>", lambda e: self.canvas.yview_scroll(int(-e.delta / 120), "units"))

    # ---------- 动作 ----------
    def update_cost(self):
        try:
            n = int(self.var_n.get())
        except Exception:  # noqa: BLE001
            n = 1
        self.lbl_cost.configure(text=f"约 {n * PRICE:.1f} 元")

    def save_key(self):
        self.cfg["key"] = self.var_key.get().strip()
        save_cfg(self.cfg)
        self.status.configure(text="Key 已保存到 config.json")

    def add_ref(self):
        files = filedialog.askopenfilenames(title="选参考图", filetypes=[("图片", "*.png *.jpg *.jpeg *.webp")])
        self.refs = (self.refs + list(files))[:3]
        self.lbl_refs.configure(text="参考图：" + "、".join(Path(f).name for f in self.refs) if self.refs else "没有参考图（纯文字生图）")

    def clear_ref(self):
        self.refs = []
        self.lbl_refs.configure(text="没有参考图（纯文字生图）")

    def set_status(self, text: str):
        self.after(0, lambda: self.status.configure(text=text))

    def start(self):
        if self.busy:
            return
        key = self.var_key.get().strip()
        prompt = self.txt.get("1.0", "end").strip()
        if not key:
            messagebox.showwarning("缺 Key", "先填阿里云百炼的 API Key（sk- 开头）")
            return
        if not prompt:
            messagebox.showwarning("缺提示词", "写点提示词")
            return
        size = self.var_size.get().split("（")[0].strip()
        n = max(1, min(6, int(self.var_n.get() or 1)))
        model = self.var_model.get().strip() or MODELS[0]
        seq = bool(self.var_seq.get())
        self.cfg.update(key=key, model=model, size=self.var_size.get(), n=n, sequential=seq, prompt=prompt)
        save_cfg(self.cfg)
        self.busy = True
        self.btn.configure(state="disabled")
        self.set_status("提交任务…")
        refs = list(self.refs)

        def work():
            t0 = time.time()
            try:
                imgs = generate(key, model, prompt, size, n, seq, refs, self.set_status)
                paths = self.save(imgs, dict(model=model, size=size, n=n, sequential=seq, refs=[Path(r).name for r in refs], prompt=prompt))
                self.set_status(f"完成：{len(paths)} 张，用时 {int(time.time() - t0)} 秒，已存到 output/（点图看大图）")
                self.after(0, lambda: self.show(paths))
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                self.set_status(f"失败：{msg[:200]}")
                self.after(0, lambda: messagebox.showerror("生成失败", msg[:800]))
            finally:
                self.busy = False
                self.after(0, lambda: self.btn.configure(state="normal"))

        threading.Thread(target=work, daemon=True).start()

    def save(self, imgs: list[bytes], meta: dict) -> list[Path]:
        OUTPUT.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        paths = []
        for i, b in enumerate(imgs, 1):
            p = OUTPUT / f"{stamp}-{i}.png"
            p.write_bytes(b)
            p.with_suffix(".txt").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            paths.append(p)
        return paths

    def show(self, paths: list[Path]):
        """新结果插在最上面一行，旧的往下挪"""
        row = ttk.Frame(self.grid_frame, padding=(0, 6))
        children = self.grid_frame.winfo_children()
        row.pack(fill="x", before=children[0] if children else None)
        ttk.Label(row, text=datetime.now().strftime("%H:%M:%S"), foreground="#8e8e93").pack(anchor="w")
        line = ttk.Frame(row)
        line.pack(fill="x")
        for p in paths:
            im = Image.open(BytesIO(p.read_bytes()))
            im.thumbnail((THUMB, THUMB * 2))
            ph = ImageTk.PhotoImage(im)
            self.thumbs.append(ph)
            b = tk.Label(line, image=ph, cursor="hand2", bd=0)
            b.pack(side="left", padx=4)
            b.bind("<Button-1>", lambda _e, f=p: os.startfile(str(f)))


if __name__ == "__main__":
    App().mainloop()
