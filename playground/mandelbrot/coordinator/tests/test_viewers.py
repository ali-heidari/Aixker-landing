"""Fan-out to viewers, viewer cap and liveness, STATS, job rollover."""

import pytest

from support import V1, W1, W2, Clock, finish_all, lease, small, submit, worker

V2 = "mandel-v-eeeeeeeeeeee"


@pytest.fixture
def clock():
    return Clock()


def viewer(coord, unit=V1, **extra):
    return coord.handle("HELLO", unit, {"role": "viewer", **extra})


# ── Batched TILE_DONE ───────────────────────────────────────────────────────

def test_tiles_are_batched_one_message_per_viewer(clock):
    c = small(clock)
    viewer(c, V1)
    viewer(c, V2)
    worker(c, W1)
    c.drain()
    for t in lease(c, W1, 4):
        submit(c, W1, t)
    assert not [m for m in c.drain() if m[1] == "TILE_DONE"]   # nothing until the flush
    sent = c.tile_batches()
    assert sorted(u for u, _, _ in sent) == sorted([V1, V2, W1])
    assert all(len(inp["tiles"]) == 4 for _, _, inp in sent)
    assert c.tile_batches() == []                               # flushed once


def test_a_batch_is_split_to_stay_under_the_size_cap(clock):
    c = small(clock, batch_bytes=1500)                          # 16×16 tile ≈ 684 chars
    viewer(c, V1)
    worker(c, W1)
    for t in lease(c, W1, 4):
        submit(c, W1, t)
    sent = [inp for u, _, inp in c.tile_batches() if u == V1]
    assert [len(inp["tiles"]) for inp in sent] == [2, 2]


# ── Viewer cap ──────────────────────────────────────────────────────────────

def test_viewers_over_the_cap_get_stats_only(clock):
    c = small(clock, viewer_cap=1)
    viewer(c, V1)
    res = viewer(c, V2)
    assert res["ok"] and res["overflow"] is True and res["doneTiles"] == []
    worker(c, W1)                                               # also over the cap
    for t in lease(c, W1, 2):
        submit(c, W1, t)
    assert {u for u, _, _ in c.tile_batches()} == {V1}
    stats = {u: inp for u, op, inp in c.stats_messages()}
    assert set(stats) == {V1, V2, W1}
    assert stats[V2]["overflow"] is True and "overflow" not in stats[V1]


def test_overflow_viewer_moves_in_when_a_slot_frees(clock):
    c = small(clock, viewer_cap=1)
    viewer(c, V1)
    assert viewer(c, V2)["overflow"]
    c.handle("BYE", V1, {})
    res = viewer(c, V2)
    assert "overflow" not in res
    assert V2 in c.viewers and V2 not in c.overflow


# ── Keepalive and liveness ──────────────────────────────────────────────────

def done_some(c, n=4):
    worker(c, W1)
    for t in lease(c, W1, n):
        submit(c, W1, t)
    c.tile_batches()
    c.drain()


def test_keepalive_hello_is_short_when_the_tab_is_up_to_date(clock):
    c = small(clock)
    viewer(c, V1)
    done_some(c)
    clock.advance(30)
    res = viewer(c, V1, jobId=c.job.id, have=4)
    assert res["resumed"] is True and res["doneTiles"] == []
    assert c.drain() == []


def test_keepalive_hello_resends_tiles_when_the_tab_is_behind(clock):
    c = small(clock)
    viewer(c, V1)
    done_some(c)
    clock.advance(30)
    res = viewer(c, V1, jobId=c.job.id, have=1)
    assert len(res["doneTiles"]) == 4
    assert sum(len(inp["tiles"]) for u, op, inp in c.drain() if op == "TILE_DONE") == 4


def test_tiles_still_in_flight_do_not_trigger_a_resend(clock):
    c = small(clock)
    viewer(c, V1)
    done_some(c)                                                # just accepted
    res = viewer(c, V1, jobId=c.job.id, have=0)
    assert res.get("resumed") is True


def test_after_a_coordinator_restart_the_tab_gets_everything(clock):
    c = small(clock)                                            # knows nothing of V1
    done_some(c)
    res = viewer(c, V1, jobId=c.job.id, have=4)
    assert "resumed" not in res and len(res["doneTiles"]) == 4


def test_silent_viewers_are_dropped_and_their_leases_released(clock):
    c = small(clock, viewer_ttl_s=75)
    viewer(c, V1)
    worker(c, W1)
    worker(c, W2)
    lease(c, W1, 2)
    for _ in range(7):                                          # W2 keeps talking
        clock.advance(10)
        lease(c, W2)
        c.tick()
    assert V1 in c.viewers and W1 in c.viewers                  # silent 70 s: kept
    clock.advance(6)
    c.tick()                                                    # 76 s: dropped
    assert V1 not in c.viewers and W1 not in c.viewers
    assert W2 in c.viewers
    assert c.counters["viewersDropped"] == 2
    assert c.contributors[W1].role == "viewer"


# ── STATS ───────────────────────────────────────────────────────────────────

def test_stats_show_leases_leaderboards_and_people(clock):
    c = small(clock)
    worker(c, W1, nickname="ann")
    worker(c, W2, nickname="bob")
    a = lease(c, W1, 3)
    [b] = lease(c, W2, 1)
    for t in a:
        clock.advance(0.5)
        submit(c, W1, t)
    s = c.stats()
    c1, c2 = c.contributors[W1].id, c.contributors[W2].id
    assert s["done"] == 3 and s["total"] == 16
    assert s["leased"] == [[b["tileId"], c2]]
    assert s["leaderboard"]["job"] == [[c1, 3]]
    assert s["people"][c1] == ["ann", c.contributors[W1].color]
    assert c2 in s["people"]                                    # leasing counts too
    m = s["metrics"]
    assert m["accepted"] == 3 and m["activeWorkers"] == 2 and m["viewers"] == 2
    assert m["turnaroundP50Ms"] == 1000 and m["turnaroundP95Ms"] == 1500
    assert m["tilesPerSecond"] == 0.3


def test_leaderboards_keep_the_top_10(clock):
    c = small(clock, width=128, height=128)                     # 64 tiles
    units = [f"mandel-v-{chr(97 + i) * 12}" for i in range(12)]
    for i, u in enumerate(units):
        worker(c, u)
        for t in lease(c, u, min(4, i + 1)):
            submit(c, u, t)
    board = c.stats()["leaderboard"]["job"]
    assert len(board) == 10
    assert [n for _, n in board] == sorted((n for _, n in board), reverse=True)


# ── Job rollover ────────────────────────────────────────────────────────────

def test_finished_job_rests_then_rolls_over(clock):
    c = small(clock, rollover_delay_s=10)
    viewer(c, V1)
    worker(c, W1)
    finish_all(c, W1)
    [done] = c.finished
    assert done.job.id == "j1" and all(done.results_b64) and set(done.contributor_ids) == {"c2"}
    assert done.counters["accepted"] == 16 and done.counters["jobsFinished"] == 1
    assert c.resting

    res = c.handle("LEASE", W1, {"capacity": 4})
    assert res["tasks"] == [] and 250 <= res["wait"] <= 5000
    assert c.stats()["nextJobInMs"] == 10_000

    clock.advance(10)
    c.tick()
    assert c.job.id == "j2" and not c.resting
    out = c.drain()
    # the last tiles of j1 go out before the JOB message
    ops = [(op, inp.get("jobId")) for u, op, inp in out if u == V1]
    assert ops[-1] == ("JOB", "j2") and ("TILE_DONE", "j1") in ops
    assert c.contributors[W1].tiles_job == 0 and c.contributors[W1].tiles_total == 16
    assert len(lease(c, W1, 4)) == 4


def test_results_for_the_old_job_are_stale_after_rollover(clock):
    c = small(clock, rollover_delay_s=1)
    worker(c, W1)
    worker(c, W2)
    [slow] = lease(c, W2)
    c.config.backup_copies = 0
    finish_all(c, W1)
    submit(c, W2, slow)                                         # completes j1
    clock.advance(1)
    c.tick()
    assert c.job.id == "j2"
    assert submit(c, W2, slow) == {"accepted": False, "reason": "STALE_JOB"}


def test_rollover_cycles_through_the_job_list(clock):
    c = small(clock, rollover_delay_s=1)
    worker(c, W1)
    seen = []
    for _ in range(9):
        seen.append(c.job.name)
        finish_all(c, W1)
        clock.advance(1)
        c.tick()
    assert seen[7] == seen[0] and len(set(seen[:7])) == 7
    assert [f.counters["accepted"] for f in c.finished] == [16] * 9
