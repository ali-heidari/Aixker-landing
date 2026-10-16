"""The fixed list of images the crowd computes, and how a job is cut into tiles.

Every job after the first zooms deeper into the same point in Seahorse Valley,
then the list starts over. The deepest span keeps about 20 doubles between
neighbouring pixels; deeper than that needs more than double precision, which
is out of scope.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

# (name, center x, center y, span across the image width, max iterations)
SEAHORSE = (-0.7436438870371587, 0.1318259042053120)
TARGETS: list[tuple[str, float, float, float, int]] = [
    ("Whole set",        -0.75,       0.0,         3.0,    256),
    ("Seahorse Valley",  *SEAHORSE,                5e-2,   600),
    ("Seahorse ×1e3",    *SEAHORSE,                5e-4,  1200),
    ("Seahorse ×1e5",    *SEAHORSE,                5e-6,  2000),
    ("Seahorse ×1e7",    *SEAHORSE,                5e-8,  3000),
    ("Seahorse ×1e9",    *SEAHORSE,                5e-10, 4000),
    ("Seahorse ×1e11",   *SEAHORSE,                5e-12, 6000),
]


@dataclass
class Tile:
    id: int
    col: int
    row: int
    x0: float
    y0: float
    width: int
    height: int


@dataclass
class Job:
    id: str
    seq: int            # 0, 1, 2, … since the coordinator started
    name: str
    center_x: float
    center_y: float
    span: float
    width: int
    height: int
    tile_size: int
    max_iter: int
    dx: float
    dy: float
    cols: int
    rows: int
    tiles: list[Tile] = field(default_factory=list)

    def spec(self) -> dict:
        """What viewers need to place and colour tiles (sent in HELLO and JOB)."""
        return {
            "jobId": self.id, "seq": self.seq, "name": self.name,
            "centerX": self.center_x, "centerY": self.center_y, "span": self.span,
            "width": self.width, "height": self.height, "tileSize": self.tile_size,
            "cols": self.cols, "rows": self.rows, "tileCount": len(self.tiles),
            "maxIter": self.max_iter,
        }

    def task(self, tile: Tile, lease_id: str) -> dict:
        """The task a worker computes. It never derives coordinates itself."""
        return {
            "jobId": self.id, "tileId": tile.id, "leaseId": lease_id,
            "x0": tile.x0, "y0": tile.y0, "dx": self.dx, "dy": self.dy,
            "width": tile.width, "height": tile.height, "maxIter": self.max_iter,
        }


def make_job(seq: int, width: int = 2048, height: int = 2048, tile_size: int = 64,
             targets: list = TARGETS) -> Job:
    name, cx, cy, span, max_iter = targets[seq % len(targets)]
    if not 1 <= max_iter <= 0xFFFF:
        raise ValueError("max_iter must fit in uint16")
    dx = span / width
    dy = -dx                                  # row 0 is the top of the image
    left = cx - span / 2
    top = cy + (span * height / width) / 2
    cols = math.ceil(width / tile_size)
    rows = math.ceil(height / tile_size)

    job = Job(id=f"j{seq + 1}", seq=seq, name=name, center_x=cx, center_y=cy, span=span,
              width=width, height=height, tile_size=tile_size, max_iter=max_iter,
              dx=dx, dy=dy, cols=cols, rows=rows)
    for row in range(rows):
        for col in range(cols):
            job.tiles.append(Tile(
                id=row * cols + col, col=col, row=row,
                x0=left + (col * tile_size) * dx,
                y0=top + (row * tile_size) * dy,
                width=min(tile_size, width - col * tile_size),
                height=min(tile_size, height - row * tile_size),
            ))
    return job


def center_out_order(job: Job) -> list[int]:
    """Tile ids nearest the image center first, so the picture grows outward."""
    mid_c, mid_r = (job.cols - 1) / 2, (job.rows - 1) / 2
    return sorted((t.id for t in job.tiles),
                  key=lambda i: ((job.tiles[i].col - mid_c) ** 2 + (job.tiles[i].row - mid_r) ** 2, i))
