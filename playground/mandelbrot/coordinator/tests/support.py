"""Helpers shared by the coordinator tests."""

import base64

from compute import counts_to_bytes, task_counts
from state import Config, Coordinator

W1, W2, W3, V1 = ("mandel-v-aaaaaaaaaaaa", "mandel-v-bbbbbbbbbbbb",
                  "mandel-v-dddddddddddd", "mandel-v-cccccccccccc")


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


def small(clock, **overrides):
    """A 64×64 job in 16 px tiles: 16 tiles, center ones are 5, 6, 9, 10.

    Silent units are never dropped and the next job never starts, unless
    a test overrides that.
    """
    base = {"width": 64, "height": 64, "tile_size": 16, "viewer_ttl_s": 1e9, "rollover_delay_s": 1e9}
    return Coordinator(Config(**{**base, **overrides}), clock=clock)


def good_data(task):
    return base64.b64encode(counts_to_bytes(task_counts(task))).decode()


def submit(coord, unit, task, data=None):
    return coord.handle("SUBMIT", unit, {
        "jobId": task["jobId"], "tileId": task["tileId"], "leaseId": task["leaseId"],
        "data": good_data(task) if data is None else data,
    })


def worker(coord, unit=W1, nickname="w"):
    res = coord.handle("HELLO", unit, {"nickname": nickname, "role": "worker"})
    assert res["ok"]
    return res


def lease(coord, unit=W1, capacity=1):
    return coord.handle("LEASE", unit, {"capacity": capacity})["tasks"]


def finish_all(coord, unit=W1):
    """Lease and submit until nothing is handed out."""
    while tasks := lease(coord, unit, 4):
        for t in tasks:
            submit(coord, unit, t)


def finish_queue(coord, unit=W1):
    """finish_all() without taking backup copies of other units' leases."""
    saved, coord.config.backup_copies = coord.config.backup_copies, 0
    try:
        finish_all(coord, unit)
    finally:
        coord.config.backup_copies = saved


def set_median(coord, seconds):
    coord.tile_times.clear()
    coord.tile_times.extend([seconds] * 5)
