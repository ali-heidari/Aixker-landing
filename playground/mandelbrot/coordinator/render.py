"""PNG of a finished job, coloured like the browser does (src/canvas.js)."""

from __future__ import annotations

import base64
from pathlib import Path

import numpy as np
from PIL import Image

from jobs import Job


def palette(max_iter: int) -> np.ndarray:
    """Same cyclic cosine palette as buildPalette() in src/canvas.js."""
    period = 32 + round(max_iter / 40)
    t = (np.arange(max_iter) % period) / period
    lut = np.zeros((max_iter + 1, 3), dtype=np.uint8)
    for ch, phase in enumerate((0.55, 0.70, 0.90)):
        lut[:max_iter, ch] = np.rint(255 * (0.5 + 0.5 * np.cos(2 * np.pi * (t + phase))))
    return lut                                    # lut[max_iter] stays black: inside the set


def render_png(job: Job, results_b64: list[str], path: Path) -> Path:
    lut = palette(job.max_iter)
    img = np.zeros((job.height, job.width, 3), dtype=np.uint8)
    for tile, b64 in zip(job.tiles, results_b64):
        if b64 is None:
            continue
        counts = np.frombuffer(base64.b64decode(b64), dtype="<u2").reshape(tile.height, tile.width)
        y = tile.row * job.tile_size
        x = tile.col * job.tile_size
        img[y:y + tile.height, x:x + tile.width] = lut[np.minimum(counts, job.max_iter)]
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img, "RGB").save(path, optimize=True)
    return path
