"""Job state: the only authority on which tile is where.

Pure and synchronous. No sockets, no timers of its own: the caller passes
messages in, reads replies back, and drains `outbox` for messages the
coordinator wants to send. A clock function is injected so tests control
time.
"""

from __future__ import annotations

import base64
import binascii
import colorsys
import hashlib
import re
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable

from jobs import Job, center_out_order, make_job

UNIT_RE = re.compile(r"^mandel-v-[a-z2-7]{12}$")
NICKNAME_MAX = 20


@dataclass
class Config:
    width: int = 2048
    height: int = 2048
    tile_size: int = 64
    max_capacity: int = 4          # tasks per LEASE
    wait_ms: int = 1000            # LEASE reply when there is nothing to hand out
    catchup_bytes: int = 512_000   # max tile data per catch-up TILE_DONE (hub cap is 1 MB)


@dataclass
class Lease:
    id: str
    tile_id: int
    unit: str
    granted_at: float


@dataclass
class TileState:
    status: str = "pending"        # pending | leased | done
    leases: dict[str, Lease] = field(default_factory=dict)
    data_b64: str | None = None
    sha256: str | None = None
    contributor_id: str | None = None


@dataclass
class Contributor:
    id: str
    unit: str
    nickname: str
    color: str
    role: str = "viewer"
    tiles_job: int = 0
    tiles_total: int = 0


def contributor_color(n: int) -> str:
    """Distinct, readable colours: golden-angle hue steps."""
    h = (n * 0.618033988749895) % 1.0
    r, g, b = colorsys.hls_to_rgb(h, 0.58, 0.72)
    return "#{:02x}{:02x}{:02x}".format(round(r * 255), round(g * 255), round(b * 255))


def clean_nickname(raw) -> str:
    text = "".join(ch for ch in str(raw or "") if ch.isprintable()).strip()
    return text[:NICKNAME_MAX] or "anonymous"


class Coordinator:
    def __init__(self, config: Config | None = None, *, clock: Callable[[], float] = time.monotonic,
                 job_factory: Callable[[int, Config], Job] | None = None, first_job: int = 0):
        self.config = config or Config()
        self.clock = clock
        self._job_factory = job_factory or (lambda seq, c: make_job(seq, c.width, c.height, c.tile_size))
        self.contributors: dict[str, Contributor] = {}   # unit → contributor
        self.viewers: set[str] = set()
        self.outbox: list[tuple[str, str, dict]] = []    # (unit, operation, input)
        self.finished: list[Job] = []                    # jobs completed, for the caller
        self._lease_seq = 0
        self._start_job(first_job)

    # ── Messages ─────────────────────────────────────────────────────────────

    def handle(self, operation: str, unit: str, inp: dict) -> dict | None:
        """Dispatch one inbound message. Returns the reply for asks."""
        if not isinstance(unit, str) or not UNIT_RE.match(unit):
            return {"ok": False, "accepted": False, "reason": "BAD_UNIT"}
        if operation == "HELLO":
            return self.hello(unit, inp)
        if operation == "LEASE":
            return self.lease(unit, inp)
        if operation == "SUBMIT":
            return self.submit(unit, inp)
        if operation == "BYE":
            self.bye(unit)
            return None
        return {"ok": False, "reason": "UNKNOWN_OPERATION"}

    def hello(self, unit: str, inp: dict) -> dict:
        role = "worker" if inp.get("role") == "worker" else "viewer"
        c = self.contributors.get(unit)
        if c is None:
            n = len(self.contributors) + 1
            c = Contributor(id=f"c{n}", unit=unit, nickname="", color=contributor_color(n))
            self.contributors[unit] = c
        c.nickname = clean_nickname(inp.get("nickname"))
        c.role = role
        self.viewers.add(unit)

        done = [(tid, ts) for tid, ts in enumerate(self.tiles) if ts.status == "done"]
        self._queue_catchup(unit, done)
        return {
            "ok": True,
            "contributorId": c.id,
            "color": c.color,
            "job": self.job.spec(),
            "doneTiles": [{"tileId": tid, "contributorId": ts.contributor_id} for tid, ts in done],
        }

    def lease(self, unit: str, inp: dict) -> dict:
        c = self.contributors.get(unit)
        if c is None or c.role != "worker":
            return {"tasks": [], "wait": self.config.wait_ms, "reason": "HELLO_FIRST"}
        try:
            capacity = int(inp.get("capacity", 1))
        except (TypeError, ValueError):
            capacity = 1
        capacity = max(1, min(self.config.max_capacity, capacity))

        tasks = []
        while len(tasks) < capacity and self._queue:
            tile_id = self._queue.popleft()
            ts = self.tiles[tile_id]
            if ts.status != "pending":
                continue
            tasks.append(self._grant(unit, tile_id))
        if not tasks:
            return {"tasks": [], "wait": self.config.wait_ms}
        return {"tasks": tasks}

    def submit(self, unit: str, inp: dict) -> dict:
        if inp.get("jobId") != self.job.id:
            return {"accepted": False, "reason": "STALE_JOB"}
        tile_id = inp.get("tileId")
        if not isinstance(tile_id, int) or not 0 <= tile_id < len(self.tiles):
            return {"accepted": False, "reason": "BAD_TILE"}
        ts = self.tiles[tile_id]
        if ts.status == "done":
            return {"accepted": False, "reason": "ALREADY_DONE"}
        lease = ts.leases.get(inp.get("leaseId"))
        if lease is None or lease.unit != unit:
            return {"accepted": False, "reason": "NO_LEASE"}
        data_b64 = inp.get("data")
        try:
            raw = base64.b64decode(data_b64, validate=True)
        except (binascii.Error, TypeError, ValueError):
            return {"accepted": False, "reason": "BAD_DATA"}

        c = self.contributors[unit]
        ts.status = "done"
        ts.leases.clear()
        ts.data_b64 = data_b64
        ts.sha256 = hashlib.sha256(raw).hexdigest()
        ts.contributor_id = c.id
        c.tiles_job += 1
        c.tiles_total += 1
        self._done_count += 1

        tile = {"tileId": tile_id, "contributorId": c.id, "data": data_b64}
        for viewer in self.viewers:
            self.outbox.append((viewer, "TILE_DONE", {"jobId": self.job.id, "tiles": [tile]}))
        if self._done_count == len(self.tiles):
            self.finished.append(self.job)
        return {"accepted": True}

    def bye(self, unit: str) -> None:
        self.viewers.discard(unit)

    # ── Queries ──────────────────────────────────────────────────────────────

    @property
    def done_count(self) -> int:
        return self._done_count

    def result_bytes(self, tile_id: int) -> bytes | None:
        ts = self.tiles[tile_id]
        return base64.b64decode(ts.data_b64) if ts.data_b64 else None

    def drain(self) -> list[tuple[str, str, dict]]:
        out, self.outbox = self.outbox, []
        return out

    # ── Internals ────────────────────────────────────────────────────────────

    def _start_job(self, seq: int) -> None:
        self.job = self._job_factory(seq, self.config)
        self.tiles = [TileState() for _ in self.job.tiles]
        self._queue = deque(center_out_order(self.job))
        self._done_count = 0
        for c in self.contributors.values():
            c.tiles_job = 0

    def _grant(self, unit: str, tile_id: int) -> dict:
        self._lease_seq += 1
        lease = Lease(id=f"L{self._lease_seq}", tile_id=tile_id, unit=unit, granted_at=self.clock())
        ts = self.tiles[tile_id]
        ts.leases[lease.id] = lease
        ts.status = "leased"
        return self.job.task(self.job.tiles[tile_id], lease.id)

    def _queue_catchup(self, unit: str, done: list[tuple[int, TileState]]) -> None:
        """Tile data for a new viewer, as TILE_DONE batches under the hub's size cap."""
        batch, size = [], 0
        for tid, ts in done:
            if batch and size + len(ts.data_b64) > self.config.catchup_bytes:
                self.outbox.append((unit, "TILE_DONE", {"jobId": self.job.id, "tiles": batch}))
                batch, size = [], 0
            batch.append({"tileId": tid, "contributorId": ts.contributor_id, "data": ts.data_b64})
            size += len(ts.data_b64)
        if batch:
            self.outbox.append((unit, "TILE_DONE", {"jobId": self.job.id, "tiles": batch}))
