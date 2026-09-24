"""免费生图：HuggingFace 上 black-forest-labs 官方的 FLUX.1-schnell Space（gradio，匿名可用，有每日 GPU 配额；
配了 HF_TOKEN 环境变量配额更多）。

连续图片靠三件事保持一致：每张提示词都带同一段「人物设定 + 画风」、同一个 seed、同一尺寸。
"""
from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

from PIL import Image

SPACE = "black-forest-labs/FLUX.1-schnell"
_client = None


def _get_client():
    global _client
    if _client is None:
        from gradio_client import Client

        token = os.environ.get("HF_TOKEN")
        _client = Client(SPACE, token=token) if token else Client(SPACE)
    return _client


def generate_pollinations(prompt: str, out: Path, seed: int = 42, width: int = 720, height: int = 1280, retries: int = 2) -> Path:
    """Pollinations 免费接口（无 key，右下角带水印）：多出 64px 高度再把底部裁掉"""
    import requests
    from urllib.parse import quote

    pad = 64
    url = f"https://image.pollinations.ai/prompt/{quote(prompt)}?width={width}&height={height + pad}&seed={seed}&nologo=true&model=flux"
    last: Exception | None = None
    for i in range(retries + 1):
        try:
            r = requests.get(url, timeout=180)
            r.raise_for_status()
            out.parent.mkdir(parents=True, exist_ok=True)
            tmp = out.with_suffix(".raw")
            tmp.write_bytes(r.content)
            im = Image.open(tmp).convert("RGB")
            im.crop((0, 0, im.width, im.height - pad * im.height // (height + pad))).save(out, quality=92)
            tmp.unlink(missing_ok=True)
            return out
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"生图失败：{last}")


def generate(prompt: str, out: Path, seed: int = 42, width: int = 720, height: int = 1280, retries: int = 2) -> Path:
    last: Exception | None = None
    for i in range(retries + 1):
        try:
            r = _get_client().predict(prompt=prompt, seed=seed, randomize_seed=False, width=width, height=height, num_inference_steps=4, api_name="/infer")
            src = r[0] if isinstance(r, (list, tuple)) else r
            out.parent.mkdir(parents=True, exist_ok=True)
            if str(src).lower().endswith((".jpg", ".jpeg")):
                shutil.copy(src, out)
            else:
                Image.open(src).convert("RGB").save(out, quality=92)
            return out
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"生图失败：{last}")


def storyboard(scenes: list[str], characters: str, style: str, out_dir: Path, seed: int = 42, backend: str = "pollinations") -> list[Path]:
    """scenes：每张图的画面描述（英文效果最好）；characters / style 拼进每一张。已经出过的图不重出"""
    gen = generate_pollinations if backend == "pollinations" else generate
    paths = []
    for i, scene in enumerate(scenes):
        out = out_dir / f"{i + 1:02d}.jpg"
        if not out.exists():
            gen(f"{scene}. {style}" + (f". Characters: {characters}" if characters else ""), out, seed=seed)
        paths.append(out)
    return paths
