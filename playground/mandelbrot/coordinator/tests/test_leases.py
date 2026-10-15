"""Leases, retries, idempotent submit, backup tasks and validation."""

import base64

import numpy as np
import pytest

from support import (V1, W1, W2, W3, Clock, finish_all, finish_queue, good_data, lease,
                     set_median, small, submit, worker)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def coord(clock):
    c = small(clock)
    worker(c, W1)
    worker(c, W2)
    return c


def record_tile_times(coord, clock, seconds, n=3):
    """Finish n tiles that each took `seconds`, to set the median."""
    for _ in range(n):
        [t] = lease(coord, W2)
        clock.advance(seconds)
        assert submit(coord, W2, t)["accepted"]


# ── Leases ──────────────────────────────────────────────────────────────────

def test_lease_is_exclusive_until_it_expires(coord, clock):
    [t] = lease(coord, W1)
    others = lease(coord, W2, 4)
    assert t["tileId"] not in {x["tileId"] for x in others}
    for x in others:
        submit(coord, W2, x)
    clock.advance(coord.config.lease_default_s + 0.1)
    coord.tick()
    assert coord.counters["leaseExpiries"] == 1
    # back at the front of the queue
    assert lease(coord, W2)[0]["tileId"] == t["tileId"]
    assert coord.counters["retries"] == 1


def test_lease_does_not_expire_early(coord, clock):
    lease(coord, W1)
    clock.advance(coord.config.lease_default_s - 0.1)
    coord.tick()
    assert coord.counters["leaseExpiries"] == 0


def test_lease_length_is_3x_median_clamped(coord, clock):
    assert coord.lease_seconds() == 20.0          # default before any tile
    record_tile_times(coord, clock, 4.0)
    assert coord.lease_seconds() == 12.0
    record_tile_times(coord, clock, 0.1, n=6)     # median 0.1 → 0.3 → clamp to 5
    assert coord.lease_seconds() == 5.0


def test_lease_length_caps_at_60s(clock):
    c = small(clock)
    worker(c, W2)
    record_tile_times(c, clock, 30.0)
    assert c.lease_seconds() == 60.0


def test_median_uses_only_the_last_50_tiles(clock):
    c = small(clock, width=128, height=128)       # 64 tiles
    worker(c, W2)
    record_tile_times(c, clock, 30.0, n=10)
    record_tile_times(c, clock, 1.0, n=50)
    assert c.lease_seconds() == 5.0


# ── Retries ─────────────────────────────────────────────────────────────────

def expire_tile(coord, clock, unit=W1):
    [t] = lease(coord, unit)
    clock.advance(coord.lease_seconds() + 1)
    coord.tick()
    return t["tileId"]


def test_tile_fails_after_5_expiries_and_waits_for_the_rest(coord, clock):
    tile = expire_tile(coord, clock)
    for _ in range(4):
        assert expire_tile(coord, clock) == tile  # requeued at the front each time
    assert coord.counters["failedTiles"] == 1
    assert coord.failed_pending() == 1

    handed = []
    while tasks := lease(coord, W2, 4):
        handed += tasks
        for t in tasks:
            assert t["tileId"] != tile or len(handed) == 16
            submit(coord, W2, t)
    # every other tile was done before the failed one went out again
    assert handed[-1]["tileId"] == tile
    assert coord.done_count == 16 and coord.failed_pending() == 0


def test_failed_tile_is_not_handed_out_while_others_are_leased(coord, clock):
    tile = None
    for _ in range(5):
        tile = expire_tile(coord, clock)
    [held] = lease(coord, W2)                      # another tile still out
    finish_queue(coord, W1)
    assert coord.done_count == 14                  # all but `held` and the failed one
    coord.config.backup_copies = 0
    assert lease(coord, W1, 4) == []
    submit(coord, W2, held)
    assert [t["tileId"] for t in lease(coord, W1, 4)] == [tile]


# ── Idempotent results ──────────────────────────────────────────────────────

def test_first_result_wins_and_later_ones_are_duplicates(coord, clock):
    [t] = lease(coord, W1)
    clock.advance(coord.lease_seconds() + 1)
    coord.tick()
    [t2] = lease(coord, W2)                        # same tile, new lease
    assert t2["tileId"] == t["tileId"]
    assert submit(coord, W2, t2) == {"accepted": True}
    assert submit(coord, W1, t) == {"accepted": False, "reason": "ALREADY_DONE"}
    assert submit(coord, W2, t2) == {"accepted": False, "reason": "ALREADY_DONE"}
    assert coord.counters["duplicates"] == 2
    assert coord.done_count == 1
    assert coord.contributors[W2].tiles_job == 1 and coord.contributors[W1].tiles_job == 0


def test_expired_lease_is_accepted_if_tile_not_done(coord, clock):
    [t] = lease(coord, W1)
    clock.advance(coord.lease_seconds() + 1)
    coord.tick()
    [t2] = lease(coord, W2)                        # re-leased to W2
    assert submit(coord, W1, t) == {"accepted": True}
    # W2's lease ended with it, so its result is a duplicate
    assert submit(coord, W2, t2)["reason"] == "ALREADY_DONE"
    assert coord.leased_count() == 0


def test_tile_done_goes_to_viewers_once(coord, clock):
    coord.handle("HELLO", V1, {"role": "viewer"})
    [t] = lease(coord, W1)
    clock.advance(coord.lease_seconds() + 1)
    coord.tick()
    [t2] = lease(coord, W2)
    coord.drain()
    submit(coord, W1, t)
    submit(coord, W2, t2)
    sent = [m for m in coord.drain() if m[0] == V1 and m[1] == "TILE_DONE"]
    assert len(sent) == 1


@pytest.mark.parametrize("change,reason", [
    ({"leaseId": "nope"}, "NO_LEASE"),
    ({"jobId": "j99"}, "STALE_JOB"),
    ({"tileId": 999}, "BAD_TILE"),
    ({"tileId": True}, "BAD_TILE"),
])
def test_stale_or_unknown_leases_are_rejected(coord, change, reason):
    [t] = lease(coord, W1)
    assert submit(coord, W1, {**t, **change}, data=good_data(t)) == {"accepted": False, "reason": reason}
    assert coord.counters["rejectedStale"] == 1
    assert coord.done_count == 0


def test_lease_for_another_tile_is_rejected(coord):
    a, b = lease(coord, W1, 2)
    assert submit(coord, W1, {**a, "tileId": b["tileId"]}, data=good_data(b))["reason"] == "NO_LEASE"


def test_lease_from_another_unit_is_rejected(coord):
    [t] = lease(coord, W1)
    assert submit(coord, W2, t)["reason"] == "NO_LEASE"


# ── Backup tasks ────────────────────────────────────────────────────────────

def backup_setup(coord, clock):
    """W1 holds one straggling tile; everything else is done."""
    record_tile_times(coord, clock, 1.0)           # median 1 s, lease 5 s
    [slow] = lease(coord, W1)
    finish_queue(coord, W2)
    assert coord.done_count == 15
    set_median(coord, 1.0)
    clock.advance(2.0)                             # older than the median
    return slow


def test_no_backups_while_the_queue_has_work(coord, clock):
    record_tile_times(coord, clock, 1.0)
    lease(coord, W1)
    clock.advance(2.0)
    assert not any(t["tileId"] == 0 for t in lease(coord, W2, 4))
    assert coord.counters["backupsIssued"] == 0


def test_idle_worker_gets_a_backup_of_the_oldest_lease(coord, clock):
    slow = backup_setup(coord, clock)
    [copy] = lease(coord, W2, 4)
    assert copy["tileId"] == slow["tileId"] and copy["leaseId"] != slow["leaseId"]
    assert coord.counters["backupsIssued"] == 1
    # one backup per tile: a third worker gets nothing
    worker(coord, W3)
    assert lease(coord, W3, 4) == []


def test_backup_is_not_given_to_the_holder(coord, clock):
    backup_setup(coord, clock)
    assert lease(coord, W1, 4) == []


def test_no_backup_for_a_lease_younger_than_the_median(coord, clock):
    [slow] = lease(coord, W1)
    finish_queue(coord, W2)
    set_median(coord, 3.0)
    clock.advance(2.9)
    assert lease(coord, W2, 4) == []
    clock.advance(0.1)
    assert [t["tileId"] for t in lease(coord, W2, 4)] == [slow["tileId"]]


def test_no_backups_before_any_tile_time_is_known(coord, clock):
    lease(coord, W1, 4)
    finish_queue(coord, W2)
    coord.tile_times.clear()
    clock.advance(10)
    assert lease(coord, W2, 4) == []


@pytest.mark.parametrize("backup_first", [True, False])
def test_backup_race_first_result_wins(coord, clock, backup_first):
    slow = backup_setup(coord, clock)
    [copy] = lease(coord, W2)
    first, second = ((W2, copy), (W1, slow)) if backup_first else ((W1, slow), (W2, copy))
    assert submit(coord, *first)["accepted"] is True
    assert submit(coord, *second) == {"accepted": False, "reason": "ALREADY_DONE"}
    assert coord.done_count == 16
    assert coord.counters["backupsWon"] == (1 if backup_first else 0)
    assert coord.counters["duplicates"] == 1
    assert len(coord.finished) == 1


def test_original_lease_expiring_leaves_the_backup_running(coord, clock):
    slow = backup_setup(coord, clock)
    [copy] = lease(coord, W2)
    clock.advance(4.0)                              # the original is past its 5 s
    coord.tick()
    assert coord.counters["leaseExpiries"] == 1
    assert coord.leased_count() == 1                # the backup still holds the tile
    assert submit(coord, W2, copy)["accepted"]


# ── Validation ──────────────────────────────────────────────────────────────

def b64(arr):
    return base64.b64encode(np.asarray(arr, dtype="<u2").tobytes()).decode()


@pytest.mark.parametrize("make,reason", [
    (lambda t: b64(np.zeros(t["width"] * t["height"] - 1)), "BAD_LENGTH"),
    (lambda t: b64(np.zeros(t["width"] * t["height"] + 1)), "BAD_LENGTH"),
    (lambda t: base64.b64encode(b"\x00" * 3).decode(), "BAD_LENGTH"),
    (lambda t: b64(np.full(t["width"] * t["height"], t["maxIter"] + 1)), "BAD_VALUE"),
    (lambda t: "!!!", "BAD_DATA"),
    (lambda t: 12345, "BAD_DATA"),
    (lambda t: ["not", "a", "string"], "BAD_DATA"),
])
def test_invalid_results_are_rejected_and_the_tile_requeued(coord, make, reason):
    [t] = lease(coord, W1)
    assert submit(coord, W1, t, data=make(t)) == {"accepted": False, "reason": reason}
    assert coord.counters["rejectedInvalid"] == 1
    assert coord.done_count == 0
    assert lease(coord, W2)[0]["tileId"] == t["tileId"]


def test_values_equal_to_max_iter_are_valid(coord):
    [t] = lease(coord, W1)
    assert submit(coord, W1, t, data=b64(np.full(t["width"] * t["height"], t["maxIter"])))["accepted"]


# ── Leaving ─────────────────────────────────────────────────────────────────

def test_bye_releases_leases_at_once(coord):
    tasks = lease(coord, W1, 3)
    coord.handle("BYE", W1, {})
    assert coord.counters["released"] == 3
    assert coord.counters["leaseExpiries"] == 0
    assert {t["tileId"] for t in lease(coord, W2, 3)} == {t["tileId"] for t in tasks}
    assert W1 not in coord.viewers


def test_stop_contributing_releases_leases(coord):
    lease(coord, W1, 2)
    coord.handle("HELLO", W1, {"role": "viewer"})
    assert coord.counters["released"] == 2
    assert lease(coord, W1) == []                  # a viewer gets no work


def test_released_lease_result_still_counts_if_tile_not_done(coord):
    [t] = lease(coord, W1)
    coord.handle("HELLO", W1, {"role": "viewer"})
    coord.handle("HELLO", W1, {"role": "worker"})
    assert submit(coord, W1, t)["accepted"]


@pytest.mark.parametrize("backups", [True, False])
def test_workers_vanishing_mid_job_still_finish_the_image(clock, backups):
    """Two workers take leases and disappear; the third finishes the image."""
    c = small(clock, backup_copies=1 if backups else 0)
    for u in (W1, W2, W3):
        worker(c, u)
    lease(c, W1, 4)
    lease(c, W3, 4)
    computed = set()
    while c.done_count < 16:
        tasks = lease(c, W2, 4)
        if not tasks:
            clock.advance(1.0)
            c.tick()
            continue
        for t in tasks:
            computed.add(t["tileId"])
            assert submit(c, W2, t)["accepted"]
    assert computed == set(range(16))
    if backups:   # W2 copies the 8 stragglers as soon as its queue runs dry
        assert (c.counters["backupsWon"], c.counters["leaseExpiries"]) == (8, 0)
    else:         # W2 waits for the 8 leases to expire
        assert (c.counters["backupsIssued"], c.counters["leaseExpiries"]) == (0, 8)
