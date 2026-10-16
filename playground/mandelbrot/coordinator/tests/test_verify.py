"""Verification, suspects and limits."""

import base64
import random

import numpy as np
import pytest

from compute import counts_to_bytes, task_counts
from support import V1, W1, W2, W3, Clock, finish_all, lease, small, submit, worker


@pytest.fixture
def clock():
    return Clock()


def bad_data(task):
    """Wrong but valid-looking: one pixel off by one."""
    counts = task_counts(task).copy()
    counts[0] = (int(counts[0]) + 1) % (task["maxIter"] + 1)
    return base64.b64encode(counts_to_bytes(counts)).decode()


def truth(task):
    return counts_to_bytes(task_counts(task))


def judge_all(c):
    """What main.py does: compute every queued tile and hand back the result."""
    while c.judge_queue:
        item = c.judge_queue.pop(0)
        c.resolve(item["jobId"], item["tileId"], truth(item["task"]))


def all_verified(clock, **kw):
    c = small(clock, verify_rate=1.0, **kw)
    for u in (W1, W2, W3):
        worker(c, u)
    return c


# ── Sampling ────────────────────────────────────────────────────────────────

def test_about_5_percent_of_tiles_are_verified(clock):
    from state import Config, Coordinator
    c = Coordinator(Config(), clock=clock, rng=random.Random(7))
    n = sum(ts.verify for ts in c.tiles)
    assert 30 <= n <= 75                                # 1024 × 5% ≈ 51


# ── Two results agree ───────────────────────────────────────────────────────

def test_verified_tile_waits_for_a_second_contributor(clock):
    c = all_verified(clock)
    [t] = lease(c, W1)
    assert submit(c, W1, t) == {"accepted": True, "verifying": True}
    assert c.done_count == 0
    # W1 never gets its own tile back for the second opinion
    assert t["tileId"] not in {x["tileId"] for x in lease(c, W1, 4)}
    [t2] = lease(c, W2)
    assert t2["tileId"] == t["tileId"]
    assert submit(c, W2, t2) == {"accepted": True}
    assert c.done_count == 1
    assert c.tiles[t["tileId"]].contributor_id == c.contributors[W1].id   # first result is credited
    assert c.counters["verifyChecks"] == 1 and c.counters["verifyMismatches"] == 0
    assert c.judge_queue == []


def test_whole_job_with_every_tile_verified(clock):
    c = all_verified(clock)
    while c.done_count < 16:
        for u in (W1, W2):
            for t in lease(c, u, 4):
                submit(c, u, t)
    assert c.counters["verifyChecks"] == 16
    assert len(c.finished) == 1


# ── Mismatch ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("liar_first", [True, False])
def test_mismatch_is_judged_and_the_liar_flagged(clock, liar_first):
    c = all_verified(clock)
    liar, honest = (W1, W2) if liar_first else (W2, W1)
    [t] = lease(c, liar if liar_first else honest)
    submit(c, liar if liar_first else honest, t, data=bad_data(t) if liar_first else None)
    [t2] = lease(c, honest if liar_first else liar)
    submit(c, honest if liar_first else liar, t2, data=None if liar_first else bad_data(t2))
    assert c.counters["verifyMismatches"] == 1
    assert c.tiles[t["tileId"]].judging and c.done_count == 0
    judge_all(c)
    assert c.done_count == 1
    ts = c.tiles[t["tileId"]]
    assert base64.b64decode(ts.data_b64) == truth(t)
    assert ts.contributor_id == c.contributors[honest].id
    assert c.contributors[liar].suspect and not c.contributors[honest].suspect
    assert c.counters["suspects"] == 1 and c.counters["judged"] == 1


def test_when_both_are_wrong_the_coordinators_result_is_used(clock):
    c = all_verified(clock)
    [t] = lease(c, W1)
    submit(c, W1, t, data=bad_data(t))
    [t2] = lease(c, W2)
    counts = task_counts(t2).copy()
    counts[1] = (int(counts[1]) + 2) % (t2["maxIter"] + 1)
    submit(c, W2, t2, data=base64.b64encode(counts_to_bytes(counts)).decode())
    judge_all(c)
    ts = c.tiles[t["tileId"]]
    assert ts.done and ts.contributor_id is None
    assert base64.b64decode(ts.data_b64) == truth(t)
    assert c.counters["coordinatorTiles"] == 1 and c.counters["suspects"] == 2


def test_judged_tile_is_not_leased_or_backed_up(clock):
    c = all_verified(clock)
    [t] = lease(c, W1)
    submit(c, W1, t, data=bad_data(t))
    [t2] = lease(c, W2)
    submit(c, W2, t2)
    c.tile_times.extend([0.0] * 5)
    handed = {x["tileId"] for u in (W1, W2, W3) for x in lease(c, u, 4)}
    assert t["tileId"] not in handed


def test_late_result_for_a_judged_tile_is_a_duplicate(clock):
    c = all_verified(clock, backup_copies=0)
    [t] = lease(c, W1)
    submit(c, W1, t, data=bad_data(t))
    [t2] = lease(c, W2)
    clock.advance(25)                                  # W2's lease expires …
    c.tick()
    [t3] = lease(c, W3)                                # … and W3 takes it
    submit(c, W3, t3)                                  # mismatch → judging
    assert submit(c, W2, t2)["reason"] == "ALREADY_DONE"


def test_job_finishes_only_after_judging(clock):
    c = small(clock, verify_rate=0.0)
    worker(c, W1)
    worker(c, W2)
    tasks = []
    while ts := lease(c, W1, 4):
        tasks += ts
    last = tasks.pop()
    for t in tasks:
        submit(c, W1, t)
    c.tiles[last["tileId"]].verify = True
    submit(c, W1, last, data=bad_data(last))
    [t2] = lease(c, W2)
    submit(c, W2, t2)
    assert c.finished == []
    judge_all(c)
    # W1 lied, so all 16 of its tiles are revoked; the job is far from done
    assert c.finished == [] and c.done_count == 1
    finish_all(c, W2)
    assert len(c.finished) == 1


# ── Suspects ────────────────────────────────────────────────────────────────

def make_suspect(c, unit, other):
    """Get `unit` caught lying on a verified tile."""
    saved = c.config.verify_rate
    [t] = lease(c, unit)
    c.tiles[t["tileId"]].verify = True
    submit(c, unit, t, data=bad_data(t))
    [t2] = lease(c, other)
    assert t2["tileId"] == t["tileId"]
    submit(c, other, t2)
    judge_all(c)
    c.config.verify_rate = saved
    assert c.contributors[unit].suspect


def test_suspects_earlier_tiles_are_thrown_out_and_viewers_told(clock):
    c = small(clock)
    c.handle("HELLO", V1, {"role": "viewer"})
    worker(c, W1)
    worker(c, W2)
    good = lease(c, W1, 3)
    for t in good:
        submit(c, W1, t)
    c.tile_batches()
    assert c.done_count == 3 and c.contributors[W1].tiles_job == 3
    make_suspect(c, W1, W2)
    # W1's 3 tiles are gone; only the judged tile (W2's) is done
    assert c.done_count == 1
    assert c.contributors[W1].tiles_job == 0 and c.contributors[W1].tiles_total == 0
    assert c.counters["revokedTiles"] == 3
    sent = [inp for u, op, inp in c.tile_batches() if u == V1]
    assert sorted(sent[0]["revoked"]) == sorted(t["tileId"] for t in good)
    # the revoked tiles go out again, to someone else
    again = {t["tileId"] for t in lease(c, W2, 4)}
    assert {t["tileId"] for t in good} <= again


def test_revoked_tile_not_yet_sent_is_never_sent(clock):
    c = small(clock)
    c.handle("HELLO", V1, {"role": "viewer"})
    worker(c, W1)
    worker(c, W2)
    [t] = lease(c, W1)
    submit(c, W1, t)                                   # accepted, still in the pending batch
    make_suspect(c, W1, W2)
    sent = [inp for u, op, inp in c.tile_batches() if u == V1]
    tiles = [x["tileId"] for inp in sent for x in inp["tiles"]]
    assert t["tileId"] not in tiles


def test_suspects_results_are_always_verified(clock):
    c = small(clock)
    worker(c, W1)
    worker(c, W2)
    make_suspect(c, W1, W2)
    [t] = lease(c, W1)
    assert submit(c, W1, t) == {"accepted": True, "verifying": True}   # even a correct one
    [t2] = lease(c, W2)
    submit(c, W2, t2)
    # equal hashes, but a suspect is involved: judged, not trusted
    assert c.tiles[t["tileId"]].judging
    judge_all(c)
    assert c.tiles[t["tileId"]].contributor_id == c.contributors[W1].id   # it was right
    assert c.contributors[W1].suspect                                     # and stays a suspect


def test_suspects_are_left_off_the_leaderboards(clock):
    c = small(clock)
    worker(c, W1)
    worker(c, W2)
    for t in lease(c, W2, 2):
        submit(c, W2, t)
    make_suspect(c, W1, W2)
    ids = {i for board in c.stats()["leaderboard"].values() for i, _ in board}
    assert c.contributors[W1].id not in ids
    assert c.stats()["metrics"]["suspectContributors"] == 1


def test_judge_result_for_an_old_job_is_ignored(clock):
    c = all_verified(clock, rollover_delay_s=1)
    [t] = lease(c, W1)
    submit(c, W1, t, data=bad_data(t))
    [t2] = lease(c, W2)
    submit(c, W2, t2)
    item = c.judge_queue.pop()
    c._next_job()
    c.resolve(item["jobId"], item["tileId"], truth(item["task"]))
    assert c.counters["judged"] == 0 and c.done_count == 0


# ── Limits ──────────────────────────────────────────────────────────────────

def test_results_over_64_kb_are_rejected(clock):
    c = small(clock)
    worker(c)
    [t] = lease(c)
    res = submit(c, W1, t, data="A" * (64 * 1024 + 4))
    assert res == {"accepted": False, "reason": "TOO_LARGE"}
    assert c.counters["rejectedTooLarge"] == 1
    assert lease(c)[0]["tileId"] == t["tileId"]


def test_lease_is_rate_limited_per_unit(clock):
    c = small(clock, lease_rate=10.0, lease_burst=20.0, width=256, height=256)   # 256 tiles
    worker(c, W1)
    worker(c, W2)
    for _ in range(20):
        assert lease(c, W1)
    res = c.handle("LEASE", W1, {"capacity": 1})
    assert res["reason"] == "RATE_LIMIT" and res["tasks"] == [] and res["wait"] == 100
    assert lease(c, W2)                                # other units are not affected
    clock.advance(0.1)                                 # one token back
    assert lease(c, W1)
    assert c.handle("LEASE", W1, {"capacity": 1})["reason"] == "RATE_LIMIT"
    assert c.counters["rateLimited"] == 2


def test_at_most_max_workers_get_work(clock):
    c = small(clock, max_workers=2)
    for u in (W1, W2, W3):
        worker(c, u)
    assert lease(c, W1) and lease(c, W2)
    res = c.handle("LEASE", W3, {"capacity": 1})
    assert res["reason"] == "WORKERS_FULL" and res["wait"] == 10_000
    assert lease(c, W1)                                # already-active workers continue
    clock.advance(31)                                  # W1 and W2 go quiet
    lease(c, W1)
    assert lease(c, W3)                                # W2's slot is free again
    assert c.counters["workersFull"] == 1


# ── Probation ───────────────────────────────────────────────────────────────

def test_new_contributors_results_are_verified_until_proven(clock):
    c = small(clock, probation=2)
    worker(c, W1)
    worker(c, W2)
    for _ in range(2):                                 # two rounds of mutual checking
        [a] = lease(c, W1)
        assert submit(c, W1, a)["verifying"]
        [b] = lease(c, W2)
        assert b["tileId"] == a["tileId"]
        assert submit(c, W2, b) == {"accepted": True}
    assert c.contributors[W1].proven == 2 and c.contributors[W2].proven == 2
    [t] = lease(c, W1)
    assert submit(c, W1, t) == {"accepted": True}      # off probation now


def test_a_cheater_is_caught_on_its_first_result(clock):
    c = small(clock, probation=3)
    for u in (W1, W2):
        worker(c, u)
    [t] = lease(c, W1)
    submit(c, W1, t, data=bad_data(t))
    [t2] = lease(c, W2)
    submit(c, W2, t2)
    judge_all(c)
    assert c.contributors[W1].suspect
    assert c.contributors[W2].proven == 1 and c.contributors[W1].proven == 0
    assert c.done_count == 1 and c.tiles[t["tileId"]].contributor_id == c.contributors[W2].id
