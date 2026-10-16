# AI Agent Instructions — Crowd Mandelbrot
## Volunteer computing in the browser, on PipesHub

---

## What you are building

Visitors open a page and see a Mandelbrot image being drawn live, tile by
tile. Anyone can press **Contribute CPU**: their browser becomes a worker,
asks a coordinator for a tile, computes it, and sends the result back. The
image fills in as results arrive. A toggle colors each tile by the visitor who
computed it, and a leaderboard shows who contributed most. When an image is
done, the coordinator starts the next one, zoomed deeper.

It lives in the `Aixker-landing` repo at `playground/mandelbrot/` and is
served at `https://aixker.com/playground/mandelbrot/`.

This is a **distributed-systems showcase** built on **PipesHub**
(`github.com/ali-heidari/PipesHub`). The interesting part is not the fractal.
It is what keeps the job correct when workers are slow, disappear mid-task,
or send wrong results: leases, retries, idempotent results, backup tasks for
stragglers, and result verification. Every one of these must be real,
tested, measured and explained in `DESIGN.md`.

Aixker-Agent is not part of this project's claims. The app must not mention it
and must not depend on it.

---

## Hard rules

1. **Browser code: no build step, no framework.** Plain HTML, CSS and ES
   modules, matching `dots-and-boxes/` and `playground/quiz/`. Third-party
   browser code loads from a CDN with a pinned version.
2. **Coordinator: Python ≥ 3.11**, in `playground/mandelbrot/coordinator/`,
   with pinned dependencies and a Dockerfile.
3. **Do not modify the PipesHub, PipesClientJS or PipesClientPython repos.**
   If one of them blocks you, describe the problem in
   `playground/mandelbrot/KNOWN_LIMITATIONS.md` and work around it inside
   this folder only.
4. **WebSocket-only transport** with the JWT sent as `auth: { token }`. Never
   rely on HTTP long-polling.
5. **Run against one PipesHub node.** PipesHub does not deliver messages
   across nodes today (see facts below). Do not try to fix or hide that here.
6. **Do not add files outside `playground/mandelbrot/`** except the one change
   to `playground/index.html` in Phase 5.
7. **Never guess an API.** Read the source listed below before using it.

---

## Before you write code

**Step 1 — Ask about repo rules.** Look for `CONTRIBUTING.md`,
`CODE_OF_CONDUCT.md` and `.agent/` instructions in the repo root,
`dots-and-boxes/` and `playground/quiz/`. Tell the developer what you found
and ask whether to follow those rules. Wait for the answer.

**Step 2 — Read the existing playground code.** Read
`playground/quiz/src/pipes.js` (WebSocket-only client with correlation IDs),
`playground/quiz/src/fanout.js`, `playground/quiz/KNOWN_LIMITATIONS.md` and
`playground/index.html`. If `playground/quiz/` is not on your branch, ask the
developer which branch to start from. Reuse the quiz's `pipes.js` approach;
do not reintroduce the `socket.once('responseGateway')` pattern from
`dots-and-boxes`.

**Step 3 — Read PipesHub's server** (branch `develop`):
`src/modules/connection_manager.js`, `src/services/authenticator.js`,
`src/modules/data.js`, `src/routes/auth/index.js`.

**Step 4 — Read PipesClientPython** (`github.com/ali-heidari/PipesClientPython`).
Check whether it supports WebSocket-only transport, `auth: { token }`,
handling inbound `ask` calls, and matching replies to concurrent asks. If it
falls short on any of these, write a thin client in
`coordinator/pipes_client.py` on top of `python-socketio` that speaks the
same envelope, and record why in `KNOWN_LIMITATIONS.md`.

**Step 5 — Confirm the facts below.** If any is wrong, stop and tell the
developer.

---

## PipesHub facts this design depends on

- **Envelope.** A client emits `gateway` with
  `{ senderId, receiverId, operation, input, awaiting }`. The hub looks up the
  receiver's socket id by unit name in Redis. Replies go out as
  `responseGateway`, routed back by `senderId`.
- **Unit names are addresses** (`handshake.query.name`). A second socket with
  the same name overwrites the first.
- **`senderId` is set by the client and not checked.** Any client can claim
  any identity.
- **Auth.** `handshake.auth.token` is accepted. `POST /auth` with form field
  `name` returns a JWT as plain text.
- **No broadcast.** Reaching N units takes N messages.
- **No cross-node delivery.** `io.to(socketId)` only reaches sockets on the
  same node.

---

## Architecture

### Units

- **Coordinator:** `mandel-coordinator`. One process. The only authority on
  job state.
- **Browser tab:** `mandel-v-<random>` where `<random>` is 12 characters from
  `crypto.getRandomValues`. Every tab is a **viewer**; it becomes a **worker**
  too when the visitor presses Contribute CPU. One unit name per tab, stored
  in `sessionStorage`.

### Pull, not push

Workers ask for work; the coordinator never pushes tasks. A slow worker simply
asks less often, so placement balances itself. Explain this choice and its
trade-offs in `DESIGN.md`.

### Protocol

| Operation | Direction | Mode | Payload (`input`) | Reply |
|---|---|---|---|---|
| `HELLO` | tab → coordinator | ask | `nickname`, `role` (`viewer` / `worker`) | `{ ok, contributorId, color, job, doneTiles[] }` |
| `LEASE` | worker → coordinator | ask | `capacity` (1–4) | `{ tasks[] }` or `{ wait: ms }` |
| `SUBMIT` | worker → coordinator | ask | `jobId`, `tileId`, `leaseId`, `data` | `{ accepted, reason? }` |
| `TILE_DONE` | coordinator → viewers | request | batch of `{ tileId, contributorId, data }` | — |
| `JOB` | coordinator → viewers | request | new job parameters | — |
| `STATS` | coordinator → viewers | request | leaderboard and metrics | — |
| `BYE` | tab → coordinator | request | — | — |

All asks carry a `correlationId` as in the quiz client.

A task is `{ jobId, tileId, leaseId, x0, y0, dx, dy, width, height, maxIter }`.
The worker never computes the tile's coordinates itself; it uses what the
task says.

### Job and tiles

- Default image 2048 × 2048, tiles 64 × 64 (1,024 tiles), configurable.
- A tile result is the **escape iteration count** per pixel as a
  `Uint16Array`, sent base64-encoded. Coloring happens only in viewers.
- Compute in a **Web Worker**, never on the main thread. Use plain JavaScript
  numbers (IEEE-754 doubles), the standard escape-time loop, and a fixed
  operation order, so the same task gives the same bytes in every browser.
  Do not use smooth coloring or `Math.fround` in the worker.
- Jobs come from a fixed list of zoom targets in `coordinator/jobs.py`. When a
  job finishes, the coordinator saves a PNG and starts the next job.

### Correctness mechanisms

Each one gets unit tests, a metric, and a section in `DESIGN.md`.

- **Leases.** A leased tile belongs to one worker until `leaseExpiresAt`.
  Default lease: 3× the median tile time of the last 50 tiles, clamped to
  5–60 s. On expiry the tile returns to the queue.
- **Retries.** A tile that expires 5 times is marked `failed`, shown in the
  metrics, and retried only after every other tile is done.
- **Idempotent results.** A `SUBMIT` is accepted only for an active `leaseId`
  on that tile, or for an expired lease whose tile is not yet done. The first
  valid result wins. Later results for a done tile are counted as duplicates
  and dropped, never applied twice.
- **Backup tasks.** When the queue is empty but tiles are still leased, give
  idle workers copies of the oldest leased tiles, as MapReduce does with
  stragglers. Whichever result arrives first wins.
- **Validation.** Reject a result if the decoded length is not
  `width × height` or any value exceeds `maxIter`.
- **Verification.** Because `senderId` is not trusted, send a random 5% of
  tiles (configurable) to two different workers and compare SHA-256 hashes of
  the results. On a mismatch, the coordinator computes the tile itself (numpy
  is fine) to decide which result is right, discards the wrong one, and marks
  that contributor `suspect`. A suspect contributor's later results always go
  through verification. Make sure the coordinator's own computation gives
  byte-identical results to the browser worker; test this.
- **Limits.** At most 4 tasks per lease call, at most 200 active workers,
  results above 64 KB rejected, `LEASE` calls rate-limited per unit.

### Fan-out to viewers

- Batch `TILE_DONE` every 250 ms; never one message per tile per viewer.
- Cap viewers at 500. Above that, new viewers get `STATS` only and a
  "watching too many" note.
- Measure fan-out time per batch.

---

## Screens

Follow the visual style of `playground/index.html`. One page,
`index.html`:

- **Canvas** — the image, drawn as tiles arrive. Tiles in progress show a
  faint outline in the worker's color.
- **Mode toggle** — "fractal" or "who computed it" (tile filled with the
  contributor's color).
- **Contribute CPU** — a button with nickname input. While on, show tiles
  computed by this tab and its share of the job. Use one Web Worker by
  default; offer up to `navigator.hardwareConcurrency - 1`.
- **Leaderboard** — top 10 contributors for this job and all time
  (in-memory, since the coordinator started).
- **Metrics panel** (toggle with `M`): active workers, viewers, tiles per
  second, tile turnaround p50/p95, lease expiries, retries, duplicates
  dropped, backup tasks issued and won, verification checks and mismatches,
  fan-out time.

Pause computing when the tab is hidden (`visibilitychange`) and say so on
screen. Release leases with `BYE` on `pagehide`.

---

## Chaos bots

The bots prove the correctness mechanisms work. They live in
`playground/mandelbrot/bots/` (Node.js ≥ 20, pinned `socket.io-client`) and
use the real protocol.

Flags: `--hub-url`, `--auth-url`, `--workers`, `--slow-rate`, `--drop-rate`
(take a lease, then go silent), `--corrupt-rate` (send wrong data),
`--disconnect-rate` (drop the socket mid-task), `--duration`, `--out`.
Defaults point to `localhost`; a non-localhost target needs `--yes`.

The coordinator has a `--check` mode that computes the whole job itself at the
end and compares it tile by tile with what the crowd produced.

Report (JSON plus a short Markdown summary): job completion time, tiles per
second, lease expiries, retries, duplicates, backup tasks issued and won,
verification mismatches, suspects flagged, and **wrong tiles in the final
image**. The target is zero wrong tiles. Report the real number.

---

## Tests

- Coordinator (`pytest`): lease grant and expiry, retry limit, first result
  wins, duplicate dropped, stale lease rejected, backup task race, validation,
  verification mismatch handling, rate limits, job rollover.
- Worker compute (`node:test`): a known tile gives a known hash; the browser
  worker and the coordinator's numpy version give identical bytes for a set
  of tiles, including deep-zoom ones.
- Client (`node:test`): correlation of concurrent asks and timeouts.

---

## Phases

Finish each phase, run its checks, and report to the developer before the
next. Do not start a phase early.

**Phase 1 — One job, happy path.** Coordinator, one browser worker, canvas.
Done when a full image renders and `--check` finds zero wrong tiles.

**Phase 2 — Correctness.** Leases, retries, idempotent submit, backup tasks,
validation, and all coordinator tests. Done when closing worker tabs
mid-job still finishes the image correctly.

**Phase 3 — Viewers and polish.** Batched fan-out, contributor overlay,
leaderboard, metrics panel, job rollover, PNG export.

**Phase 4 — Chaos.** Verification, suspects, limits and the bots. Run
50 bots with 10% slow, 10% drop, 5% corrupt and 5% disconnect. Done when the
report shows zero wrong tiles, or explains exactly why not. Report the numbers
as they are.

**Phase 5 — Playground and docs.**
- Add the demo to `playground/index.html` next to the others, without
  changing them.
- `README.md`: what it is, how to run it locally (PipesHub single node,
  coordinator, static page), how to run the bots.
- `DESIGN.md`: one short section per mechanism (what, why, the trade-off,
  the alternative you rejected), plus the Phase 4 numbers. Write it for a
  senior engineer who will look for weak spots.
- `KNOWN_LIMITATIONS.md`: everything that is not solved, including PipesHub's
  unchecked `senderId` and missing cross-node delivery.
- Copy this file to `playground/mandelbrot/.agent/agent-instructions.md`.

---

## Out of scope

Accounts, a database, GPU or WebAssembly compute, deep zoom beyond double
precision, payments, multi-node PipesHub, anything about Aixker.

---

## Commits

Unless the developer chose the repo's own rules in Step 1:
- Conventional Commits, for example `feat(mandelbrot): add tile leases`.
- Subject line 50 characters or fewer.
- A short body that says **why**, not what.
- No issue reference footer. No author or co-author trailer.
- One logical change per commit.

---

## When you finish

Report to the developer:
1. What works, with the commands to run it.
2. The Phase 4 numbers, unedited.
3. Everything in `KNOWN_LIMITATIONS.md`.
4. Anything in this file you could not follow, and why.
