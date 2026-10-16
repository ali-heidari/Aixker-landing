import hashlib

import numpy as np

from compute import compute_tile, counts_to_bytes, task_counts
from jobs import make_job


def sha(counts):
    return hashlib.sha256(counts_to_bytes(counts)).hexdigest()


def test_known_tiles_have_known_hashes():
    # Same tasks and hashes as test/mandel.test.js on the browser side.
    whole = make_job(0)
    assert sha(task_counts(whole.task(whole.tiles[524], "x"))) == \
        "b6e3820929cfb104ed82170730a7512b7bd52a7befa7515e1abceda51cd42eb3"
    deepest = make_job(6)
    assert sha(task_counts(deepest.task(deepest.tiles[528], "x"))) == \
        "d3042491961883bb79839b10c4a5dc288eba16ab9076d1b83f81d998332ef594"


def scalar(x0, y0, dx, dy, w, h, max_iter):
    """The JS loop, written out in plain Python floats."""
    out = []
    for py in range(h):
        cy = y0 + py * dy
        for px in range(w):
            cx = x0 + px * dx
            zx = zy = 0.0
            i = 0
            while i < max_iter:
                zx2, zy2 = zx * zx, zy * zy
                if zx2 + zy2 > 4:
                    break
                zy = 2 * zx * zy + cy
                zx = zx2 - zy2 + cx
                i += 1
            out.append(i)
    return np.array(out, dtype=np.uint16)


def test_numpy_matches_the_scalar_loop():
    for args in [(-2.0, 1.5, 0.05, -0.05, 20, 13, 300),
                 (-0.7436438870371587, 0.131825904205312, 2.44e-15, -2.44e-15, 9, 7, 3000)]:
        assert np.array_equal(compute_tile(*args), scalar(*args))


def test_bytes_are_little_endian():
    assert counts_to_bytes(np.array([1, 256], dtype=np.uint16)) == b"\x01\x00\x00\x01"
