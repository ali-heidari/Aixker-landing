"""Job state: the only authority on which tile is where.

Pure and synchronous. No sockets, no timers of its own: the caller passes
messages in, reads replies back, calls tick() now and then so leases can
expire, and drains `outbox` for messages the coordinator wants to send. A
clock function is injected so tests control time.

A tile moves through these states:

    queued ──LEASE──▶ leased ──valid SUBMIT──▶ done
      ▲                 │
      └──lease expires──┘   (5 expiries: failed, queued again only once
                             every other tile is done)

While the queue is empty but tiles are still leased, idle workers get backup
copies of the oldest leases. The first valid result wins; later ones are
dropped as duplicates.
"""

from __future__ import annotations

import base64
import binascii
import colorsys
import hashlib
import heapq
import re
import secrets
import statistics
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

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
    busy_wait_ms: int = 500        # same, while tiles are still out (one may expire soon)
    catchup_bytes: int = 512_000   # max tile data per catch-up TILE_DONE (hub cap is 1 MB)
    lease_factor: float = 3.0      # lease = factor × median tile time …
    lease_min_s: float = 5.0       # … clamped to these bounds
    lease_max_s: float = 60.0
    lease_default_s: float = 20.0  # before any tile has finished
    tile_time_window: int = 50     # tiles the median is taken over
    max_expiries: int = 5          # expiries before a tile is marked failed
    backup_copies: int = 1         # extra leases per straggling tile


@dataclass
class Lease:
    id: str
    tile_id: int
    unit: str
    granted_at: float
    expires_at: float
    backup: bool = False
    active: bool = True


@dataclass
class TileState:
    done: bool = False
    queued: bool = True
    failed: bool = False           # expired max_expiries times
    expiries: int = 0
    grants: int = 0
    active: dict[str, Lease] = field(default_factory=dict)   # lease id → lease
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


def new_counters() -> dict[str, int]:
    return {
        "leasesGranted": 0,
        "leaseExpiries": 0,
        "retries": 0,           # grants of a tile whose earlier lease expired
        "failedTiles": 0,       # tiles that reached max_expiries
        "released": 0,          # leases given back by BYE or Stop
        "accepted": 0,
        "duplicates": 0,        # valid lease, but the tile was already done
        "rejectedStale": 0,     # unknown lease, other unit's lease, or old job
        "rejectedInvalid": 0,   # failed validation
        "backupsIssued": 0,
        "backupsWon": 0,
    }


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
        self.counters = new_counters()                   # since the coordinator started
        self.tile_times: deque[float] = deque(maxlen=self.config.tile_time_window)
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
        if c.role == "worker" and role == "viewer":
            self._release_all(unit)                      # pressed Stop
        c.nickname = clean_nickname(inp.get("nickname"))
        c.role = role
        self.viewers.add(unit)

        done = [(tid, ts) for tid, ts in enumerate(self.tiles) if ts.done]
        self._queue_catchup(unit, done)
        return {
            "ok": True,
            "contributorId": c.id,
            "color": c.color,
            "job": self.job.spec(),
            "doneTiles": [{"tileId": tid, "contributorId": ts.contributor_id} for tid, ts in done],
        }

    def lease(self, unit: str, inp: dict) -> dict:
        self.tick()
        c = self.contributors.get(unit)
        if c is None or c.role != "worker":
            return {"tasks": [], "wait": self.config.wait_ms, "reason": "HELLO_FIRST"}
        try:
            capacity = int(inp.get("capacity", 1))
        except (TypeError, ValueError):
            capacity = 1
        capacity = max(1, min(self.config.max_capacity, capacity))

        tasks = []
        while len(tasks) < capacity:
            tile_id = self._next_queued()
            if tile_id is None:
                break
            tasks.append(self._grant(unit, tile_id))
        if len(tasks) < capacity:
            for tile_id in self._backup_candidates(unit, capacity - len(tasks)):
                tasks.append(self._grant(unit, tile_id, backup=True))
        if tasks:
            return {"tasks": tasks}
        busy = any(ts.active for ts in self.tiles)
        return {"tasks": [], "wait": self.config.busy_wait_ms if busy else self.config.wait_ms}

    def submit(self, unit: str, inp: dict) -> dict:
        self.tick()
        if inp.get("jobId") != self.job.id:
            return self._reject_stale("STALE_JOB")
        tile_id = inp.get("tileId")
        if not isinstance(tile_id, int) or isinstance(tile_id, bool) or not 0 <= tile_id < len(self.tiles):
            return self._reject_stale("BAD_TILE")
        lease = self.leases.get(inp.get("leaseId"))
        if lease is None or lease.tile_id != tile_id or lease.unit != unit:
            return self._reject_stale("NO_LEASE")
        ts = self.tiles[tile_id]
        if ts.done:
            # Idempotent: a result for a done tile is never applied twice.
            self.counters["duplicates"] += 1
            self._end_lease(lease)
            return {"accepted": False, "reason": "ALREADY_DONE"}

        data_b64 = inp.get("data")
        reason = self._validate(tile_id, data_b64)
        if reason:
            self.counters["rejectedInvalid"] += 1
            self._end_lease(lease)
            self._requeue_if_orphaned(tile_id, front=True)
            return {"accepted": False, "reason": reason}

        # Accepted: an active lease, or an expired one whose tile is not done.
        now = self.clock()
        c = self.contributors[unit]
        for other in list(ts.active.values()):
            self._end_lease(other)
        lease.active = False
        ts.done = True
        ts.queued = False
        ts.data_b64 = data_b64
        ts.sha256 = hashlib.sha256(base64.b64decode(data_b64)).hexdigest()
        ts.contributor_id = c.id
        c.tiles_job += 1
        c.tiles_total += 1
        self._done_count += 1
        self.counters["accepted"] += 1
        if lease.backup:
            self.counters["backupsWon"] += 1
        self.tile_times.append(now - lease.granted_at)

        tile = {"tileId": tile_id, "contributorId": c.id, "data": data_b64}
        for viewer in self.viewers:
            self.outbox.append((viewer, "TILE_DONE", {"jobId": self.job.id, "tiles": [tile]}))
        if self._done_count == len(self.tiles):
            self.finished.append(self.job)
        return {"accepted": True}

    def bye(self, unit: str) -> None:
        self.viewers.discard(unit)
        self._release_all(unit)
        c = self.contributors.get(unit)
        if c:
            c.role = "viewer"

    # ── Time ─────────────────────────────────────────────────────────────────

    def lease_seconds(self) -> float:
        """3× the median tile time of the last 50 tiles, clamped to 5–60 s."""
        cfg = self.config
        if not self.tile_times:
            return cfg.lease_default_s
        return min(cfg.lease_max_s, max(cfg.lease_min_s, cfg.lease_factor * statistics.median(self.tile_times)))

    def tick(self) -> None:
        """Expire every lease whose time is up."""
        now = self.clock()
        while self._expiry_heap and self._expiry_heap[0][0] <= now:
            _, lease_id = heapq.heappop(self._expiry_heap)
            lease = self.leases.get(lease_id)
            if lease is None or not lease.active:
                continue
            ts = self.tiles[lease.tile_id]
            self._end_lease(lease)
            self.counters["leaseExpiries"] += 1
            ts.expiries += 1
            if ts.expiries >= self.config.max_expiries and not ts.failed:
                ts.failed = True
                self.counters["failedTiles"] += 1
            self._requeue_if_orphaned(lease.tile_id, front=True)

    # ── Queries ──────────────────────────────────────────────────────────────

    @property
    def done_count(self) -> int:
        return self._done_count

    def failed_pending(self) -> int:
        return sum(1 for ts in self.tiles if ts.failed and not ts.done)

    def leased_count(self) -> int:
        return sum(1 for ts in self.tiles if ts.active)

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
        self.leases: dict[str, Lease] = {}               # every lease of this job
        self._queue = deque(center_out_order(self.job))
        self._failed_queue: deque[int] = deque()
        self._expiry_heap: list[tuple[float, str]] = []
        self._done_count = 0
        for c in self.contributors.values():
            c.tiles_job = 0

    def _next_queued(self) -> int | None:
        while self._queue:
            tile_id = self._queue.popleft()
            ts = self.tiles[tile_id]
            if ts.queued and not ts.done and not ts.active:
                ts.queued = False
                return tile_id
        # Failed tiles go out again only once every other tile is done.
        if self._done_count + self.failed_pending() == len(self.tiles):
            while self._failed_queue:
                tile_id = self._failed_queue.popleft()
                ts = self.tiles[tile_id]
                if ts.queued and not ts.done and not ts.active:
                    ts.queued = False
                    return tile_id
        return None

    def _backup_candidates(self, unit: str, n: int) -> list[int]:
        """Oldest straggling leases this unit does not already hold."""
        if not self.tile_times:
            return []   # no idea yet what "slow" means
        min_age = statistics.median(self.tile_times)
        now = self.clock()
        out = []
        for ts_id, ts in enumerate(self.tiles):
            if ts.done or not ts.active or len(ts.active) > self.config.backup_copies:
                continue
            if any(lease.unit == unit for lease in ts.active.values()):
                continue
            oldest = min(lease.granted_at for lease in ts.active.values())
            if now - oldest >= min_age:
                out.append((oldest, ts_id))
        return [tile_id for _, tile_id in sorted(out)[:n]]

    def _grant(self, unit: str, tile_id: int, backup: bool = False) -> dict:
        now = self.clock()
        lease = Lease(id=secrets.token_hex(8), tile_id=tile_id, unit=unit,
                      granted_at=now, expires_at=now + self.lease_seconds(), backup=backup)
        ts = self.tiles[tile_id]
        ts.active[lease.id] = lease
        self.leases[lease.id] = lease
        heapq.heappush(self._expiry_heap, (lease.expires_at, lease.id))
        self.counters["leasesGranted"] += 1
        if backup:
            self.counters["backupsIssued"] += 1
        elif ts.grants and ts.expiries:
            self.counters["retries"] += 1
        ts.grants += 1
        return self.job.task(self.job.tiles[tile_id], lease.id)

    def _end_lease(self, lease: Lease) -> None:
        lease.active = False
        self.tiles[lease.tile_id].active.pop(lease.id, None)

    def _requeue_if_orphaned(self, tile_id: int, front: bool = False) -> None:
        ts = self.tiles[tile_id]
        if ts.done or ts.active or ts.queued:
            return
        ts.queued = True
        if ts.failed:
            self._failed_queue.append(tile_id)
        elif front:
            self._queue.appendleft(tile_id)
        else:
            self._queue.append(tile_id)

    def _release_all(self, unit: str) -> None:
        for ts_id, ts in enumerate(self.tiles):
            for lease in [l for l in ts.active.values() if l.unit == unit]:
                self._end_lease(lease)
                self.counters["released"] += 1
                self._requeue_if_orphaned(ts_id, front=True)

    def _validate(self, tile_id: int, data_b64) -> str | None:
        if not isinstance(data_b64, str):
            return "BAD_DATA"
        try:
            raw = base64.b64decode(data_b64, validate=True)
        except (binascii.Error, ValueError):
            return "BAD_DATA"
        tile = self.job.tiles[tile_id]
        if len(raw) != tile.width * tile.height * 2:
            return "BAD_LENGTH"
        if int(np.frombuffer(raw, dtype="<u2").max()) > self.job.max_iter:
            return "BAD_VALUE"
        return None

    def _reject_stale(self, reason: str) -> dict:
        self.counters["rejectedStale"] += 1
        return {"accepted": False, "reason": reason}

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
