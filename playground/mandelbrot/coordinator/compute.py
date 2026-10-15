"""Escape-time Mandelbrot for one tile, in numpy.

Must give the same bytes as src/mandel.js for the same task, so the
coordinator can settle a verification mismatch and --check can judge the
crowd's image. Every operation below matches the JS loop one for one, in the
same order, on float64. numpy applies each operator separately with
round-to-nearest and never fuses a*b+c, the same as JS.
"""

from __future__ import annotations

import numpy as np


def compute_tile(x0: float, y0: float, dx: float, dy: float,
                 width: int, height: int, max_iter: int) -> np.ndarray:
    """Return a (height*width,) uint16 array of escape counts, row by row."""
    px = np.arange(width, dtype=np.float64)
    py = np.arange(height, dtype=np.float64)
    cx = np.tile(x0 + px * dx, height)        # JS: x0 + px * dx
    cy = np.repeat(y0 + py * dy, width)       # JS: y0 + py * dy

    out = np.full(width * height, max_iter, dtype=np.uint16)
    idx = np.arange(width * height)           # pixels that have not escaped
    zx = np.zeros_like(cx)
    zy = np.zeros_like(cy)

    for i in range(max_iter):
        zx2 = zx * zx
        zy2 = zy * zy
        escaped = zx2 + zy2 > 4.0
        if escaped.any():
            out[idx[escaped]] = i
            keep = ~escaped
            idx, zx, zy, zx2, zy2, cx, cy = (
                a[keep] for a in (idx, zx, zy, zx2, zy2, cx, cy))
            if idx.size == 0:
                break
        zy = 2.0 * zx * zy + cy               # JS: 2 * zx * zy + cy
        zx = zx2 - zy2 + cx                   # JS: zx2 - zy2 + cx

    return out


def task_counts(task: dict) -> np.ndarray:
    """compute_tile() for a task dict as sent to workers."""
    return compute_tile(task["x0"], task["y0"], task["dx"], task["dy"],
                        task["width"], task["height"], task["maxIter"])


def counts_to_bytes(counts: np.ndarray) -> bytes:
    """Little-endian uint16 bytes, as the browser sends them (base64-decoded)."""
    return counts.astype("<u2", copy=False).tobytes()
