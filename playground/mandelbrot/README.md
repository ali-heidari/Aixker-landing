# Crowd Mandelbrot

Visitors' browsers draw a Mandelbrot image together. The page shows the
image filling in, tile by tile. Press **Contribute CPU** and your tab starts
asking a coordinator for tiles, computing them in a Web Worker and sending
the results back. When an image is done, the next one starts, zoomed deeper.

The fractal is the easy part. The demo is about what keeps the image correct
when helpers are slow, vanish mid-tile or send wrong results: leases,
retries, results applied at most once, backup tasks for stragglers, and
verification. [DESIGN.md](DESIGN.md) explains each one and has the chaos-test
numbers. Everything runs on [PipesHub](https://github.com/ali-heidari/PipesHub).

The page is plain HTML, CSS and ES modules, with no build step. Socket.io
client 4.8.3 loads from a CDN. The coordinator is Python 3.11+.

Live: <https://aixker.com/playground/mandelbrot/>

## Files

| Path | What it is |
|---|---|
| `index.html`, `src/app.js` | The page: canvas, Contribute CPU, leaderboard, metrics. |
| `src/mandel.js` | The escape-time loop for one tile. Pure; shared by the Web Worker, the bots and the tests. |
| `src/compute-worker.js` | The Web Worker. |
| `src/contribute.js` | The worker loop: lease, compute, submit. |
| `src/canvas.js` | Draws tiles, outlines and the "who computed it" view. |
| `src/pipes.js` | PipesHub client (a copy of the quiz's). |
| `src/codec.js`, `src/store.js` | Base64 tile codec, session storage. |
| `coordinator/` | The coordinator (Python). `state.py` holds all job state; `main.py` connects it to the hub. |
| `bots/` | Chaos bots (Node). |
| `test/`, `coordinator/tests/`, `bots/test/` | Tests. |
| [`DESIGN.md`](DESIGN.md) | How each mechanism works, and the chaos-test numbers. |
| [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) | What is not solved. |

## Run it locally

You need Redis, a PipesHub checkout, Node 20 or newer, and Python 3.11 or
newer. Everything runs on one machine against **one** PipesHub node; PipesHub
does not deliver messages between nodes.

1. **Start Redis** on `127.0.0.1:6379`, for example
   `docker run -p 6379:6379 redis:7-alpine`.

2. **Start one PipesHub node**, plain HTTP:

   ```bash
   git clone -b develop https://github.com/ali-heidari/PipesHub.git
   cd PipesHub && npm ci
   PORT=16916 SOCKET_PORT=3000 JWT_SECRET=dev-secret \
     REDIS_URL=redis://127.0.0.1:6379/0 node src/main.js
   ```

   Socket.io is now on `http://localhost:3000` and `POST /auth` on
   `http://localhost:16916`.

3. **Start the coordinator:**

   ```bash
   cd playground/mandelbrot/coordinator
   python3.12 -m venv .venv         # any Python 3.11+; or: uv venv --python 3.12 .venv
   .venv/bin/pip install -r requirements-dev.txt
   .venv/bin/python main.py
   ```

   It registers as the unit `mandel-coordinator` and starts the first image.
   Finished images are saved as PNGs in `coordinator/out/`.

4. **Serve this repo** from its root: `python3 -m http.server 8000`.

5. **Open** <http://localhost:8000/playground/mandelbrot/?hub=local> in a
   few tabs and press **Contribute CPU** in some of them. Press **M** for the
   metrics panel.

By default the page uses the same PipesHub as the other playground demos
(`https://playground.aixker.com:3000`, auth at `https://playground.aixker.com`).
On `localhost` or a private IP, `?hub=local` switches to the hub on the same
host, and `?hub=<socket url>&auth=<auth url>` to any other.

### Coordinator options

| Flag | Default | |
|---|---|---|
| `--hub-url`, `--auth-url` | `http://localhost:3000`, `http://localhost:16916` | The PipesHub node. |
| `--width`, `--height`, `--tile` | 2048, 2048, 64 | Image and tile size in pixels. |
| `--first-job` | 0 | Index into the zoom list in `jobs.py` (0–6; 6 is the deepest). |
| `--jobs` | 0 | Stop after this many images (0 = run forever). |
| `--rollover-delay` | 10 | Seconds a finished image stays up. |
| `--verify-rate` | 0.05 | Share of tiles computed twice. |
| `--probation` | 3 | A new contributor's first N results are always verified. |
| `--viewer-cap` | 500 | Viewers that get tiles; the rest get stats only. |
| `--max-workers` | 200 | Active workers that get tiles. |
| `--check` | off | After each image, recompute it and count wrong tiles (`out/check-<job>.json`). |
| `--out` | `out` | Folder for PNGs and check reports. |

A Docker image builds from `coordinator/Dockerfile`; pass the same flags to
`docker run`.

### Tests

```bash
cd playground/mandelbrot
node --test                                   # page code, client, bots
cd coordinator && .venv/bin/python -m pytest  # coordinator
```

One node test runs random tiles through both the browser code and the
coordinator's numpy code and checks the bytes are identical. It needs the
coordinator's venv (or `MANDEL_PYTHON=/path/to/python`) and is skipped
without it.

## Chaos bots

Bots are real PipesHub units that speak the real protocol and compute real
tiles with the browser's code. Some of them misbehave on purpose.

| Behavior | What it does |
|---|---|
| honest | Leases, computes, submits. |
| slow | Holds every result for 2–20 s, often past its lease. |
| drop | Works for 2–10 s, then takes a lease and goes silent for good. |
| corrupt | Changes a few pixels to wrong but in-range values, so validation passes. |
| disconnect | Drops its socket while holding a lease, comes back 1–5 s later, repeats. |

```bash
cd playground/mandelbrot/bots && npm ci
# terminal 1: a coordinator that checks the image it finishes
cd ../coordinator && .venv/bin/python main.py --check --jobs 1 --first-job 3
# terminal 2: 50 bots
cd ../bots && node index.js --workers 50 --slow-rate 0.1 --drop-rate 0.1 \
  --corrupt-rate 0.05 --disconnect-rate 0.05 \
  --check-report ../coordinator/out/check-j4.json --out results/run1
```

The bots stop when the image is done, wait for the coordinator's check, and
write `report.json` and `summary.md`. The headline number is **wrong tiles in
the final image**, taken from the coordinator's own recomputation.

| Flag | Default | |
|---|---|---|
| `--hub-url`, `--auth-url` | `localhost` | The PipesHub node. |
| `--workers` | 50 | Number of bots. |
| `--slow-rate`, `--drop-rate` | 0.1, 0.1 | Share of slow and drop bots. |
| `--corrupt-rate`, `--disconnect-rate` | 0.05, 0.05 | Share of corrupt and disconnect bots. |
| `--corrupt-prob` | 1 | Chance a corrupt bot corrupts each result. Below 1, it is harder to catch. |
| `--threads` | cores − 1 | Compute threads shared by all bots. |
| `--duration` | 900 | Give up after this many seconds. |
| `--check-report`, `--check-wait` | none, 600 | The coordinator's check file to wait for and merge. |
| `--out` | `results/<time>` | Report folder. |
| `--yes` | | Required when a URL is not on localhost. The bots lie and hold leases on purpose. |
