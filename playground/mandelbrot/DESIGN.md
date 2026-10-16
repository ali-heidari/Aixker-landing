# Crowd Mandelbrot: design

This is a volunteer-computing job on PipesHub. Untrusted browsers compute
tiles; one coordinator decides which results count. Each section below says
what a mechanism does, why, what it costs, and what I rejected. The chaos-test
numbers are at the end. [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) lists
what is not solved.

## The pieces

```
 browser tab (unit mandel-v-<12 random>)          coordinator (unit mandel-coordinator)
 ┌───────────────────────────────┐               ┌──────────────────────────────────┐
 │ viewer: canvas, leaderboard   │◀─ TILE_DONE ──│ state.py: tiles, leases, scores  │
 │                               │◀─ JOB, STATS ─│   pure, synchronous, clock is    │
 │ worker (Contribute CPU):      │── HELLO ─────▶│   injected → every rule is a     │
 │   loop: LEASE → compute in a  │── LEASE ─────▶│   unit test                      │
 │   Web Worker → SUBMIT         │── SUBMIT ────▶│ main.py: hub I/O, fan-out timer, │
 │                               │── BYE ───────▶│   judge thread, PNG, --check     │
 └───────────────────────────────┘   PipesHub    └──────────────────────────────────┘
```

All traffic goes through one PipesHub node. `state.py` never touches a socket:
`main.py` passes messages in, reads replies, and drains an outbox. That split
is why the coordinator has 99 unit tests that run in 3 seconds.

A tile's life:

```
queued ──LEASE──▶ leased ──valid SUBMIT──────────────────────────────▶ done
  ▲                 │  │                                                ▲
  └──lease expires──┘  └─ picked for verification: held ─▶ 2nd result ─┤ equal, no suspect
     (5 expiries:          (waits for another worker;        │          │
      failed, last)         judged if none comes)            └─ differ ─▶ judged by coordinator
```

## Pull, not push

**What.** Workers ask for work (`LEASE`). The coordinator never sends a task
on its own.

**Why.** The coordinator does not know how fast a phone or a laptop is, or
whether a tab is about to close. With pull, a fast worker asks more often and
a slow one less, so the work balances itself without any speed model. It also
fits PipesHub well: the coordinator only answers asks, so a dead tab costs it
nothing beyond one lease.

**Trade-off.** Every tile costs a round trip before computing starts. A tab
hides that by keeping spare tasks: about two per Web Worker, at least 4, and
it asks again only when the spares are gone, for up to 4 at once. Spares hold
leases a little longer, but lease length follows the measured tile time, which
includes that wait.

**Rejected.** Push with per-worker queues. That needs speed estimates,
rebalancing when a worker slows down, and a way to take queued work back from
a worker that left. Pull gets all three for free.

## Leases

**What.** A leased tile belongs to one worker until its lease runs out. The
lease is 3× the median tile time of the last 50 accepted tiles, held between
5 and 60 s (20 s before any tile has finished). On expiry, the tile goes back
to the front of the queue. Expiry is a heap of `(expires_at, lease_id)`,
checked every 50 ms.

**Why.** A worker that crashes, closes its tab or loses its network sends
nothing. Without a deadline its tile would be lost forever. A tab that closes
cleanly sends `BYE` on `pagehide` and gives its leases back at once.

**Trade-off.** One lease length for everyone. A slow phone on a deep zoom can
need more than 3× the median and lose its lease; its late result is still
accepted if nobody finished the tile first (see the next sections). The
5 s floor also means a vanished worker's tile waits at least 5 s.

**Rejected.** Heartbeats from workers that hold leases. They tell you a tab is
alive, not that it is making progress, and they cost a message per worker per
interval through the hub. A per-worker lease length (based on each worker's
own speed) was also rejected: new workers have no history, and a liar can
claim to be slow to keep tiles.

## Retries

**What.** Every expiry puts the tile back in the queue. After 5 expiries the
tile is marked `failed`, counted in the metrics, and handed out again only
once every other tile is done.

**Why.** A tile that keeps expiring may be special: very slow at deep zoom,
or a tile that crashes some browser. Retrying it at the front of the queue
would let one bad tile hold the queue and keep tripping the same workers.
Pushing it to the end lets the rest of the image finish first.

**Trade-off.** A failed tile is never abandoned, so a tile that no browser can
compute would stall the image forever. In practice the coordinator's judge
(below) could compute it, but that is not wired up for failed tiles.

**Rejected.** Dropping a failed tile and leaving a hole. The target is a
complete, correct image.

## Results applied at most once

**What.** `SUBMIT` counts only with a lease this coordinator issued, for that
tile, to that unit, in the current job. The lease may be active or expired;
an expired lease still counts if nobody finished the tile meanwhile. The
first valid result wins. Any later result for that tile is answered
`ALREADY_DONE`, counted as a duplicate, and dropped. Viewers get each tile
once.

**Why.** Expiry and backup tasks mean two workers can hold the same tile, and
a slow worker's result often arrives after its lease ran out. Throwing away a
correct late result wastes the work; applying two results would make credit
and the image depend on timing.

**Trade-off.** Accepting expired leases means a lease is a promise of
exclusivity only until it expires. After that it is a race, by design.

**Rejected.** Rejecting every result from an expired lease. On a deep image
that turns slow-but-honest browsers into pure waste.

## Backup tasks

**What.** When the queue is empty but tiles are still leased, an idle worker
gets a copy of the oldest lease. The limits: one copy per tile, never to the
worker that holds it, and only once the lease is older than the median tile
time. Whichever result arrives first wins; the other is a duplicate.

**Why.** At the end of an image, everyone waits for the slowest few tiles.
This is the straggler problem MapReduce solved the same way. Idle workers
have nothing better to do.

**Trade-off.** Wasted compute: in the chaos runs, about half of the backups
lost the race. The "older than the median" rule keeps fast workers from
copying tiles that were granted a moment ago. Before any tile has finished,
there are no backups.

**Rejected.** Giving copies to every idle worker at once, and starting
backups before the queue runs dry. Both burn far more compute for little
gain.

## Validation

**What.** A result is rejected if it is not valid base64, if its length is
not `width × height × 2` bytes, or if any value is above `maxIter`. Results
over 64 KB are rejected before decoding. A rejected result ends its lease and
the tile is queued again at the front.

**Why.** These checks are cheap and catch bugs and lazy cheating (random
bytes, a wrong tile size).

**Trade-off.** Validation cannot tell a correct tile from a wrong tile of the
right shape. That is what verification is for.

**Rejected.** Plausibility checks on the values, such as smoothness or
symmetry. Fractal tiles are not smooth, and the checks would be easy to
satisfy with wrong data anyway.

## Verification and suspects

**What.**
- A random 5% of tiles are marked at job start. A result for a marked tile is
  held, not accepted, until a second result arrives from a different
  contributor.
- **Probation:** a contributor's first 3 results are also held that way, and
  so is every result from a suspect.
- If the two SHA-256 hashes match and neither sender is a suspect, the first
  result is accepted. Otherwise the coordinator computes the tile itself
  (numpy, in a worker thread) and judges.
- Whoever sent a wrong result becomes a **suspect**: all its tiles in the
  current image are thrown out (viewers get a `revoked` list and clear them),
  and all its later results are verified.
- If no other worker is around, or nobody gives a second opinion within 15 s,
  the coordinator judges the held result alone. Without this, a lone worker
  could never finish an image.

**Why.** PipesHub does not check `senderId`, so any result may be a lie, and
validation cannot see a wrong-but-plausible tile. Recomputing everything
centrally would defeat the point of the crowd.

**Probation is my addition** to the 5% rule in the brief. The first chaos runs
showed why: with 5% random sampling only, a cheater that sends 20 tiles has a
36% chance (0.95²⁰) of never being sampled, and in one 10-bot test a cheater
sent 12 results unseen and 14 wrong tiles stayed in the image. With probation,
a cheater that lies on every result is caught on its first one, before any of
its tiles count. `--probation 0` restores the brief's exact rule.

**The coordinator can judge** because its numpy code gives the same bytes as
the browser. Both run the same escape-time loop on IEEE-754 doubles, in the
same order, with no fused multiply-add (JavaScript never fuses, numpy applies
each operator separately). A node test compares SHA-256 hashes of both sides
for 28 tiles, from the whole set down to a 1e-12 zoom, and another pins two
known hashes. Task coordinates travel as JSON numbers, which both sides print
and parse as the shortest round-trip form, so the doubles arrive exactly.

**Trade-off.**
- Cost: a verified tile is computed twice, and a judged one three times. In
  the 50-bot runs that was 10–30% extra compute (more with probation, which
  checks each of 50 newcomers 3 times). With one worker, the coordinator
  computed 57 and 69 tiles per image itself in two runs.
- Coverage is a probability, not a guarantee. A cheater that lies only
  sometimes can pass probation clean, and after that only 5% of its results
  are checked. Run D below shows exactly that.
- A suspect stays a suspect until the coordinator restarts, even if it was a
  one-off bug. Its earlier images are not cleaned up.
- Two cheaters sending the same wrong bytes would agree. That needs
  collusion; a suspect in the pair still forces judging.

**Rejected.**
- Verifying every tile twice. It halves throughput, and a single cheater
  paired with itself under two unit names would still pass, because unit
  names are free.
- Trust scores that slowly raise or lower a contributor's sampling rate.
  Better in the long run, but needs identities that survive a tab reload,
  and PipesHub gives none.

## Limits

**What.** At most 4 tasks per `LEASE`. `LEASE` is rate-limited per unit with a
token bucket: 30 calls a second, bursts of 60; over the limit gets
`{ tasks: [], wait, reason: RATE_LIMIT }`. At most 200 active workers (a
`LEASE` or `SUBMIT` in the last 30 s); a new worker past that gets
`WORKERS_FULL` and a 10 s wait. Results over 64 KB are rejected.

**Why.** One Python process answers every ask. These limits stop one unit
from taking the whole queue, flooding the coordinator, or sending huge
messages.

**Trade-off.** The rate limit was 10 calls a second at first, and that
throttled a real tab to 10 tiles a second on an image it computes 10× faster.
The fix was batching on the client (above) plus 30/s. A unit can still dodge
per-unit limits by using many unit names, because names are free.

**Rejected.** A global limit only: one greedy unit could then starve the rest.

## Fan-out to viewers

**What.** Accepted tiles collect for 250 ms, then each viewer gets one
`TILE_DONE` with all of them, split so that no message passes 512 KB (the hub
drops messages over 1 MB). Only 500 viewers get tiles; the others get `STATS`
(every 2 s) and a note. A new or behind viewer gets the done tiles as
`TILE_DONE` batches after `HELLO`. Tabs repeat `HELLO` every 30 s with their job
and tile count; the coordinator drops viewers silent for 75 s and resends
tiles to a tab that is missing some, which also repairs a tab after a
coordinator restart. Fan-out time per batch is measured and shown.

**Why.** PipesHub has no broadcast, so every viewer costs one message per
batch. One message per tile per viewer would be 25× more messages at 100
tiles a second.

**Trade-off.** Up to 250 ms of extra delay, and bandwidth still grows with
viewers × tiles. In the chaos runs each bot, as a viewer, received about 11 MB
in 15 s. 500 viewers at that rate would push about 375 MB/s through one hub.
That is the scaling limit of this design.

**Rejected.** Sending only tile ids and letting viewers fetch data on demand:
the fetch would be another ask per tile per viewer. Compressing tiles before
sending would help a lot (iteration counts compress well) but is not done
yet.

## Job rollover

**What.** When the last tile is accepted, the job is frozen (results,
credits, its own counters), saved as a PNG, and checked with `--check` if
asked. The finished image stays up for 10 s, then `JOB` goes out with the
next zoom from `jobs.py`. Results for the old job get `STALE_JOB`.

**Why.** Viewers should see the finished picture, and each image's report
must describe that image only.

**Trade-off.** Workers sit idle for those 10 s.

## Chaos-test numbers

Each run: a fresh coordinator with `--check`, one image (Seahorse ×1e5, 1,024
tiles, 2,000 iterations), and 50 bots on one 4-core laptop: 10% slow, 10%
drop, 5% corrupt, 5% disconnect, the rest honest. The bots share 3 compute
threads. "Wrong" is the coordinator's own recomputation of the final image,
tile by tile.

| Run | Wrong tiles | Time | Tiles/s | Lease expiries | Retries | Duplicates | Backups won / issued | Checks / mismatches | Judged | Suspects | Tiles thrown out |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **A: 5% random sampling only** (`--probation 0`, the brief's rule) | | | | | | | | | | | |
| A1 | **27** | 17.97 s | 56.98 | 13 | 11 | 8 | 4 / 9 | 103 / 52 | 52 | 2 | 2 |
| A2 | **0** | 15.49 s | 66.11 | 10 | 10 | 2 | 4 / 4 | 97 / 50 | 50 | 3 | 30 |
| A3 | **0** | 18.55 s | 55.2 | 10 | 13 | 5 | 3 / 9 | 92 / 50 | 50 | 3 | 29 |
| **B: defaults** (5% sampling + probation 3) | | | | | | | | | | | |
| B1 | **0** | 16.01 s | 63.96 | 13 | 14 | 6 | 3 / 7 | 216 / 84 | 84 | 3 | 0 |
| B2 | **0** | 17.4 s | 58.85 | 14 | 17 | 14 | 1 / 14 | 217 / 93 | 93 | 3 | 0 |
| B3 | **0** | 16.63 s | 61.58 | 13 | 15 | 27 | 4 / 26 | 221 / 87 | 87 | 3 | 0 |
| **D: defaults, but cheaters lie on 20% of results** (`--corrupt-prob 0.2`) | | | | | | | | | | | |
| D1 | **0** | 18.64 s | 54.94 | 13 | 13 | 4 | 2 / 2 | 203 / 14 | 73 | 3 | 3 |
| D2 | **6** | 14.83 s | 69.05 | 9 | 7 | 5 | 6 / 10 | 158 / 5 | 19 | 1 | 3 |
| D3 | **0** | 25.23 s | 40.59 | 16 | 16 | 8 | 4 / 6 | 204 / 17 | 85 | 3 | 4 |

Every run finished its image (0 missing tiles), and the coordinator logged no
errors. None hit the rate limit, the worker cap or the 64 KB limit; unit tests
cover those.

The same settings ran earlier on the Phase 4 code. The bots were the same;
the coordinator did not yet judge held results that get no second opinion,
and its rate limit was 10 calls a second (the bots make about 1). Results:
A 0 wrong tiles in 5 runs, B 0 in 5, D wrong tiles in 2 of 3 runs (3
and 4), and one run on the deepest image (6,000 iterations) with 0. Across
both sets:

| Setting | Runs with wrong tiles |
|---|---|
| A: 5% sampling only | 1 of 8 (27 wrong tiles) |
| B: defaults | **0 of 8** |
| D: cheaters lie on 20% of results | 3 of 6 (3, 4 and 6 wrong tiles) |

**Why A1 has wrong tiles.** Only 2 of its 3 cheaters were ever sampled. The
third sent its whole share unchecked, and 27 of its tiles stayed in the image.
With 5% sampling and 25–30 results per cheater, each cheater has a 20–30%
chance (0.95²⁵ to 0.95³⁰) of never being checked. Probation closes that gap for
cheaters that always lie: in B, every cheater was caught on its first result
and nothing had to be thrown out.

**Why D has wrong tiles.** In run D, cheaters corrupt only 20% of their
results. Such a cheater sends all three probation results clean 51% of
the time (0.8³), and after that only 5% of its results are checked. Each
corrupt result that is not checked stays in the image. Sampling lowers the
odds; it cannot make them zero. A higher `--verify-rate` buys more coverage
with more compute.

Other runs worth knowing about:
- A lone browser tab (Seahorse Valley, 600 iterations, one thread) finished
  the image in 9.6 s with 0 wrong tiles; the coordinator judged 69 held
  results itself. Before the lease batching fix, the same run took 101 s.
- Earlier Phase 2 test: four tabs, two closed mid-job and one browser killed;
  the last tab finished the deepest image with 0 wrong tiles.
