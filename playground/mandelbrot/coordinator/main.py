"""Crowd Mandelbrot coordinator: one PipesHub unit, `mandel-coordinator`.

  python main.py --hub-url http://localhost:3000 --auth-url http://localhost:16916

Every finished image is saved as a PNG in --out. --check also recomputes
each finished job and compares it tile by tile with what the crowd sent.
--jobs N stops after N jobs (0 = run forever).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import re
import signal
import time
from pathlib import Path

from compute import counts_to_bytes, task_counts
from pipes_client import PipeClient
from render import render_png
from state import Config, Coordinator, FinishedJob

UNIT_NAME = "mandel-coordinator"
TICK_S = 0.05             # leases, outbox (replies' catch-up, JOB)
BATCH_S = 0.25            # TILE_DONE fan-out
STATS_S = 2.0             # STATS fan-out
LOG_S = 5.0

log = logging.getLogger("coordinator")


def check_job(done: FinishedJob) -> dict:
    """Recompute every tile and count the ones the crowd got wrong."""
    t0 = time.perf_counter()
    wrong, missing = [], []
    for tile, b64 in zip(done.job.tiles, done.results_b64):
        if b64 is None:
            missing.append(tile.id)
            continue
        want = counts_to_bytes(task_counts(done.job.task(tile, "check")))
        if base64.b64decode(b64) != want:
            wrong.append(tile.id)
    return {
        "jobId": done.job.id, "name": done.job.name, "tiles": len(done.job.tiles),
        "wrongTiles": len(wrong), "missingTiles": len(missing),
        "wrongTileIds": wrong, "missingTileIds": missing,
        "checkSeconds": round(time.perf_counter() - t0, 2),
        "jobSeconds": round(done.seconds, 2),
    }


def png_name(done: FinishedJob) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", done.job.name.lower()).strip("-")
    return f"{done.job.id}-{slug}.png"


async def run(args: argparse.Namespace) -> int:
    config = Config(width=args.width, height=args.height, tile_size=args.tile,
                    rollover_delay_s=args.rollover_delay, viewer_cap=args.viewer_cap,
                    verify_rate=args.verify_rate, probation=args.probation, max_workers=args.max_workers)
    coord = Coordinator(config, first_job=args.first_job)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    stop = asyncio.Event()
    exit_code = 0
    jobs_done = 0

    def on_message(operation, inp, sender_id, reply):
        if operation in ("HELLO", "BYE") and not inp.get("jobId"):   # not the 30 s keepalives
            log.info("%s from %s %s", operation, sender_id, inp.get("role", ""))
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

    async def send(messages) -> None:
        for unit, operation, inp in messages:
            await pipe.request(unit, operation, inp)

    async def on_job_finished(done: FinishedJob) -> None:
        nonlocal jobs_done, exit_code
        log.info("job %s done in %.1f s", done.job.id, done.seconds)
        png = await asyncio.to_thread(render_png, done.job, done.results_b64, out_dir / png_name(done))
        log.info("saved %s", png)
        if args.check:
            report = await asyncio.to_thread(check_job, done)
            report["counters"] = done.counters
            (out_dir / f"check-{done.job.id}.json").write_text(json.dumps(report, indent=2))
            log.info("check %s: %d wrong, %d missing of %d tiles (%.1f s)", done.job.id,
                     report["wrongTiles"], report["missingTiles"], report["tiles"], report["checkSeconds"])
            if report["wrongTiles"] or report["missingTiles"]:
                exit_code = 1
        jobs_done += 1
        if args.jobs and jobs_done >= args.jobs:
            stop.set()

    async def main_loop() -> None:
        last_batch = last_stats = last_log = 0.0
        while not stop.is_set():
            now = time.monotonic()
            coord.tick()
            await send(coord.drain())
            if now - last_batch >= BATCH_S:
                last_batch = now
                batches = coord.tile_batches()
                if batches:
                    t0 = time.perf_counter()
                    await send(batches)
                    coord.record_fanout((time.perf_counter() - t0) * 1000)
            if now - last_stats >= STATS_S:
                last_stats = now
                await send(coord.stats_messages())
            while coord.finished:
                # a task, so a long --check never stalls leases or fan-out
                asyncio.create_task(on_job_finished(coord.finished.pop(0)))
            if now - last_log >= LOG_S:
                last_log = now
                m = coord.stats()["metrics"]
                log.info("job %s: %d/%d done, %d leased, %d failed; %d viewers (+%d over cap), "
                         "%d active workers; %.1f tiles/s, turnaround p50 %s p95 %s ms; lease %.1f s; "
                         "expiries %d, retries %d, dup %d, stale %d, invalid %d, backups %d/%d won; "
                         "verify %d checks, %d mismatches, %d suspects, %d revoked; "
                         "fan-out p95 %s ms", coord.job.id, coord.done_count, len(coord.job.tiles),
                         m["leased"], m["failedPending"], m["viewers"], m["overflowViewers"],
                         m["activeWorkers"], m["tilesPerSecond"], m["turnaroundP50Ms"], m["turnaroundP95Ms"],
                         m["leaseSeconds"], m["leaseExpiries"], m["retries"], m["duplicates"],
                         m["rejectedStale"], m["rejectedInvalid"], m["backupsWon"], m["backupsIssued"],
                         m["verifyChecks"], m["verifyMismatches"], m["suspects"], m["revokedTiles"],
                         m["fanoutMsP95"])
            await asyncio.sleep(TICK_S)

    async def judge_loop() -> None:
        """Compute tiles whose results disagree; one at a time, off the event loop."""
        while not stop.is_set():
            if not coord.judge_queue:
                await asyncio.sleep(TICK_S)
                continue
            item = coord.judge_queue.pop(0)
            truth = await asyncio.to_thread(lambda t=item["task"]: counts_to_bytes(task_counts(t)))
            before = coord.counters["suspects"]
            coord.resolve(item["jobId"], item["tileId"], truth)
            if coord.counters["suspects"] > before:
                log.info("tile %s/%s judged: %d suspect(s) so far, %d tiles revoked", item["jobId"],
                         item["tileId"], coord.counters["suspects"], coord.counters["revokedTiles"])

    tasks = [asyncio.create_task(main_loop()), asyncio.create_task(judge_loop())]
    await stop.wait()
    for t in tasks:
        t.cancel()
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
    p.add_argument("--rollover-delay", type=float, default=10.0,
                   help="seconds a finished image stays up before the next job")
    p.add_argument("--viewer-cap", type=int, default=500, help="viewers that get tiles; the rest get STATS only")
    p.add_argument("--verify-rate", type=float, default=0.05, help="share of tiles computed by two workers")
    p.add_argument("--probation", type=int, default=3,
                   help="a contributor's first N results are always verified (0 = off)")
    p.add_argument("--max-workers", type=int, default=200, help="active workers that get tiles")
    p.add_argument("--check", action="store_true", help="recompute each finished job and count wrong tiles")
    p.add_argument("--out", default="out", help="directory for PNGs and check reports")
    p.add_argument("--log-level", default="INFO")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
