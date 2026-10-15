import pytest

from jobs import make_job
from state import Config, Coordinator
from support import V1, W1, W2, Clock, small, submit, worker

@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def coord(clock):
    return small(clock)


# ── HELLO ───────────────────────────────────────────────────────────────────

def test_hello_returns_job_and_contributor(coord):
    res = worker(coord)
    assert res["contributorId"] == "c1"
    assert res["color"].startswith("#")
    assert res["job"]["tileCount"] == 16
    assert res["doneTiles"] == []


def test_hello_rejects_unit_names_outside_the_scheme(coord):
    assert coord.handle("HELLO", "quiz-host-123456", {})["ok"] is False


def test_hello_cleans_the_nickname(coord):
    coord.handle("HELLO", W1, {"nickname": "  a\x00b" + "x" * 50})
    assert coord.contributors[W1].nickname == "ab" + "x" * 18
    coord.handle("HELLO", W2, {"nickname": ""})
    assert coord.contributors[W2].nickname == "anonymous"


def test_same_unit_keeps_its_contributor_id(coord):
    a = worker(coord)
    b = coord.handle("HELLO", W1, {"role": "viewer"})
    assert a["contributorId"] == b["contributorId"]


# ── LEASE and SUBMIT, happy path ────────────────────────────────────────────

def test_lease_needs_a_worker_hello(coord):
    coord.handle("HELLO", V1, {"role": "viewer"})
    assert coord.handle("LEASE", V1, {"capacity": 1})["tasks"] == []


def test_lease_hands_out_up_to_capacity_capped_at_4(coord):
    worker(coord)
    assert len(coord.handle("LEASE", W1, {"capacity": 2})["tasks"]) == 2
    assert len(coord.handle("LEASE", W1, {"capacity": 99})["tasks"]) == 4
    assert len(coord.handle("LEASE", W1, {"capacity": "x"})["tasks"]) == 1


def test_task_carries_the_tile_coordinates(coord):
    worker(coord)
    task = coord.handle("LEASE", W1, {"capacity": 1})["tasks"][0]
    tile = coord.job.tiles[task["tileId"]]
    assert task["x0"] == tile.x0 and task["y0"] == tile.y0
    assert task["dx"] == coord.job.dx and task["dy"] == coord.job.dy
    assert (task["width"], task["height"]) == (16, 16)


def test_first_tiles_are_near_the_center(coord):
    worker(coord)
    ids = {t["tileId"] for t in coord.handle("LEASE", W1, {"capacity": 4})["tasks"]}
    assert ids == {5, 6, 9, 10}


def test_whole_job_completes_and_viewers_get_every_tile(coord):
    coord.handle("HELLO", V1, {"role": "viewer"})
    worker(coord)
    while True:
        tasks = coord.handle("LEASE", W1, {"capacity": 4})["tasks"]
        if not tasks:
            break
        for t in tasks:
            assert submit(coord, W1, t) == {"accepted": True}
    assert coord.done_count == 16
    assert coord.finished == [coord.job]
    sent = [m for m in coord.drain() if m[0] == V1 and m[1] == "TILE_DONE"]
    assert sorted(t["tileId"] for _, _, inp in sent for t in inp["tiles"]) == list(range(16))
    assert coord.contributors[W1].tiles_job == 16


def test_empty_queue_says_wait(coord):
    worker(coord)
    for _ in range(4):
        coord.handle("LEASE", W1, {"capacity": 4})
    res = coord.handle("LEASE", W1, {"capacity": 4})
    assert res["tasks"] == [] and res["wait"] > 0


def test_submit_rejects_garbage_base64(coord):
    worker(coord)
    task = coord.handle("LEASE", W1, {"capacity": 1})["tasks"][0]
    assert submit(coord, W1, task, data="not base64!") == {"accepted": False, "reason": "BAD_DATA"}


def test_submit_rejects_another_units_lease(coord):
    worker(coord)
    worker(coord, W2)
    task = coord.handle("LEASE", W1, {"capacity": 1})["tasks"][0]
    assert submit(coord, W2, task)["reason"] == "NO_LEASE"


# ── Catch-up for late viewers ───────────────────────────────────────────────

def test_late_viewer_gets_done_tiles_in_chunks_under_the_cap(clock):
    coord = Coordinator(Config(width=64, height=64, tile_size=16, catchup_bytes=2000), clock=clock)
    worker(coord)
    for t in coord.handle("LEASE", W1, {"capacity": 4})["tasks"]:
        submit(coord, W1, t)
    coord.drain()
    res = coord.handle("HELLO", V1, {"role": "viewer"})
    assert len(res["doneTiles"]) == 4 and "data" not in res["doneTiles"][0]
    chunks = [inp for unit, op, inp in coord.drain() if unit == V1 and op == "TILE_DONE"]
    # a 16×16 tile is 684 base64 chars, so at most 2 fit under 2000
    assert [len(c["tiles"]) for c in chunks] == [2, 2]


def test_make_job_covers_the_image_exactly():
    job = make_job(0, width=100, height=70, tile_size=32)
    assert (job.cols, job.rows) == (4, 3)
    assert sum(t.width * t.height for t in job.tiles) == 100 * 70
    assert job.tiles[-1].width == 4 and job.tiles[-1].height == 6
