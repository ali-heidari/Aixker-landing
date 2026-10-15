"""Crowd Mandelbrot coordinator: one PipesHub unit, `mandel-coordinator`.

  python main.py --hub-url http://localhost:3000 --auth-url http://localhost:16916

--check computes every finished job itself and compares it tile by tile with
what the crowd sent. --jobs N stops after N jobs (0 = run forever).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import time
from pathlib import Path

from compute import counts_to_bytes, task_counts
from jobs import Job
from pipes_client import PipeClient
from state import Config, Coordinator

UNIT_NAME = "mandel-coordinator"
FLUSH_INTERVAL_S = 0.05
STATUS_INTERVAL_S = 5.0

log = logging.getLogger("coordinator")


def check_job(job: Job, results: list[bytes | None]) -> dict:
    """Recompute every tile and count the ones the crowd got wrong."""
    t0 = time.perf_counter()
    wrong, missing = [], []
    for tile, got in zip(job.tiles, results):
        if got is None:
            missing.append(tile.id)
            continue
        want = counts_to_bytes(task_counts(job.task(tile, "check")))
        if got != want:
            wrong.append(tile.id)
    return {
        "jobId": job.id, "name": job.name, "tiles": len(job.tiles),
        "wrongTiles": len(wrong), "missingTiles": len(missing),
        "wrongTileIds": wrong, "missingTileIds": missing,
        "checkSeconds": round(time.perf_counter() - t0, 2),
    }


async def run(args: argparse.Namespace) -> int:
    config = Config(width=args.width, height=args.height, tile_size=args.tile)
    coord = Coordinator(config, first_job=args.first_job)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    stop = asyncio.Event()
    exit_code = 0
    job_started = time.monotonic()
    jobs_done = 0

    def on_message(operation, inp, sender_id, reply):
        try:
            res = coord.handle(operation, sender_id, inp)
        except Exception:
            log.exception("handling %s from %s", operation, sender_id)
            res = {"ok": False, "accepted": False, "reason": "INTERNAL"}
        if reply and res is not None:
            reply(res)

    pipe = PipeClient(args.hub_url, args.auth_url, UNIT_NAME, on_message,
                      on_status=lambda s, d: log.info("hub: %s %s", s, d or ""))

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    await pipe.connect()
    log.info("registered as %s; job %s (%s), %d tiles",
             UNIT_NAME, coord.job.id, coord.job.name, len(coord.job.tiles))

    async def on_job_finished(job: Job) -> None:
        nonlocal jobs_done, exit_code, job_started
        seconds = time.monotonic() - job_started
        log.info("job %s done in %.1f s", job.id, seconds)
        if args.check:
            results = [coord.result_bytes(i) for i in range(len(job.tiles))]
            report = await asyncio.to_thread(check_job, job, results)
            report["jobSeconds"] = round(seconds, 2)
            (out_dir / f"check-{job.id}.json").write_text(json.dumps(report, indent=2))
            log.info("check %s: %d wrong, %d missing of %d tiles (%.1f s)", job.id,
                     report["wrongTiles"], report["missingTiles"], report["tiles"],
                     report["checkSeconds"])
            if report["wrongTiles"] or report["missingTiles"]:
                exit_code = 1
        jobs_done += 1
        job_started = time.monotonic()
        if args.jobs and jobs_done >= args.jobs:
            stop.set()

    async def flush_loop() -> None:
        last_status = 0.0
        while not stop.is_set():
            for unit, operation, inp in coord.drain():
                await pipe.request(unit, operation, inp)
            while coord.finished:
                await on_job_finished(coord.finished.pop(0))
            now = time.monotonic()
            if now - last_status >= STATUS_INTERVAL_S:
                last_status = now
                workers = sum(1 for c in coord.contributors.values() if c.role == "worker")
                log.info("job %s: %d/%d tiles, %d viewers, %d workers", coord.job.id,
                         coord.done_count, len(coord.job.tiles), len(coord.viewers), workers)
            await asyncio.sleep(FLUSH_INTERVAL_S)

    flusher = asyncio.create_task(flush_loop())
    await stop.wait()
    flusher.cancel()
    await pipe.close()
    return exit_code


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--hub-url", default="http://localhost:3000", help="PipesHub Socket.io URL")
    p.add_argument("--auth-url", default="http://localhost:16916", help="PipesHub REST URL (POST /auth)")
    p.add_argument("--width", type=int, default=2048)
    p.add_argument("--height", type=int, default=2048)
    p.add_argument("--tile", type=int, default=64, help="tile edge in pixels")
    p.add_argument("--first-job", type=int, default=0, help="index into jobs.TARGETS to start from")
    p.add_argument("--jobs", type=int, default=0, help="stop after this many jobs (0 = never)")
    p.add_argument("--check", action="store_true", help="recompute each finished job and count wrong tiles")
    p.add_argument("--out", default="out", help="directory for check reports and PNGs")
    p.add_argument("--log-level", default="INFO")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
