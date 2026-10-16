# Known limitations

Crowd Mandelbrot runs on PipesHub (`ali-heidari/PipesHub`, branch `develop`,
read at commit `87bbbdd`). These are the limits we know about. None of the
PipesHub repos are patched; workarounds live in this folder. Each PipesHub
item says what PipesHub would need to change.

## PipesHub

### 1. Anyone can claim to be anyone, including the coordinator

`senderId` is set by the client and the hub does not check it. The JWT from
`POST /auth` is not tied to a unit name either: `verifySocketIO` checks only
the signature, so any valid token can register any `handshake.query.name`.
A second socket with the same name takes over the first one's routing.

- **Worst case:** a client registers as `mandel-coordinator`. From then on it
  receives every `HELLO`, `LEASE` and `SUBMIT`, and can send any picture to
  every viewer. Nothing in this folder can stop that.
- **Milder cases:** a client sends `TILE_DONE`, `JOB` or `STATS` with
  `senderId: 'mandel-coordinator'` straight to a viewer. Viewers check the
  `senderId`, which stops mistakes, not attacks. Colours from `STATS` must
  look like `#rrggbb` before they reach a `style` attribute, so a fake
  `STATS` cannot inject CSS.
- **What this folder does:** treats every result as untrusted (verification,
  [DESIGN.md](DESIGN.md)). Lease ids are 64-bit random and bound to the unit
  that leased them, so guessing another worker's lease is not practical. But
  a client that registers under a victim's unit name gets the victim's
  messages, leases included.
- **PipesHub change needed:** put the unit name in the JWT (`sub`), reject a
  socket whose `query.name` does not match, set `senderId` on the server from
  the socket's own unit, and reserve names such as `mandel-coordinator`.

### 2. Messages between nodes are dropped

Each node delivers with `io.to(socketId)` on its own Socket.io server. There
is no cross-node adapter, so a tab on another node than the coordinator never
reaches it, and no error is raised. This demo runs on one node only and does
not try to hide that.

- **PipesHub change needed:** `@socket.io/redis-adapter` or similar.

### 3. No broadcast: bandwidth grows with viewers × tiles

Every viewer costs one message per `TILE_DONE` batch. In the chaos runs each
bot (also a viewer) received about 11 MB of tile data in 15 s, about
0.75 MB/s. At the 500-viewer cap that would be about 375 MB/s through one hub
and one Python process. The cap protects the coordinator, but the real limit
is lower and depends on the network. Not measured above 50 viewers.

- **What would help here:** compressing tile data (iteration counts compress
  well), or sending viewers a smaller preview.
- **PipesHub change needed:** a broadcast or group operation.

### 4. The coordinator is not told when a tab goes away

The hub never tells a unit that another unit disconnected. The coordinator
learns of a dead tab only when its lease expires (5–60 s) or it stays silent
for 75 s. A tab that closes without `pagehide` (a crash, a killed browser)
keeps a viewer slot and gets `TILE_DONE` messages that go nowhere until then.

### 5. Messages right after connecting can be lost

The hub attaches its `gateway` listeners after an awaited Redis lookup. The
client sends nothing until the hub's `gateway` 200 arrives (same as the
quiz). A reconnect can also race with `disconnectUnit` and route a unit's
messages to its dead socket until it reconnects again; the 30 s `HELLO`
keepalive repairs a viewer, and lease expiry repairs a worker.

### 6. Messages over 1 MB are dropped

The hub uses Socket.io's default `maxHttpBufferSize` of 1 MB. A full image is
about 8 MB of tile data, so `HELLO` returns tile ids only and the data
follows in `TILE_DONE` batches of at most 512 KB.

### 7. Redis keeps every unit forever, and tokens never expire

Each tab adds `unit:` and `user:` keys that are never deleted; a 50-bot run
adds 100. The JWT has no `exp`.

## PipesClientPython is not used

The coordinator needs a Python client that uses WebSocket only, sends the JWT
as `auth: { token }`, answers inbound asks, and matches replies to concurrent
asks. `ali-heidari/PipesClientPython` (master, `a7a46d5`) does none of these:

- `establish_connection()` connects with `transports='polling'` (HTTP
  long-polling) to a hard-coded `http://localhost:3000`, and sends the token
  as an `authorization` header.
- `connect()` always requests a token for the name `guest`, from a
  hard-coded `http://localhost:16916`.
- `ask()` matches a reply by `receiverId` and `operation`, so two concurrent
  asks to the same unit and operation can get each other's reply. It also
  adds a new `responseGateway` listener on every call.
- Inbound handlers run synchronously inside the Socket.io callback.
- `requirements.txt` lists `gevent_socketio==0.3.6`, but the code uses the
  `python-socketio` API.

**Workaround:** `coordinator/pipes_client.py`, a thin client on
`python-socketio` that speaks the same envelope as `src/pipes.js`: it waits
for the hub's `gateway` 200 before sending, adds a `correlationId` to every
ask, and replies by sending the received envelope back with `res`.

## Correctness

- **Verification is a probability, not a proof.** A cheater that lies on
  every result is caught on its first one (probation). A cheater that lies
  only sometimes can pass probation clean; after that only 5% of its results
  are checked, and its unchecked lies stay in the image. In 6 chaos runs with
  such cheaters, 3 ended with wrong tiles (3, 4 and 6;
  [DESIGN.md](DESIGN.md)). With probation off (`--probation 0`, the brief's
  rule), 1 of 8 runs ended with 27 wrong tiles.
- **Unit names are free.** A caught cheater can come back under a new unit
  name and start clean. Per-unit rate limits and the worker cap can be
  dodged the same way. Probation makes each new name pay 3 checked results.
- **Suspects are only cleaned up in the current image.** Tiles a suspect
  computed for earlier images stay in those images and their PNGs.
- **A failed tile is never given up.** After 5 expiries it waits until the
  rest is done and is retried; a tile no browser can finish would stall the
  image. The coordinator could compute it itself but does not.
- **Two colluding cheaters** that send the same wrong bytes for the same tile
  would pass a check between them, unless one of them is already a suspect.

## Coordinator

- **One process, all in memory.** A restart loses the job's progress, the
  leaderboards and the suspect list, and starts again at `--first-job`. Tabs
  recover on their own (their next `HELLO` registers them again), but leases
  and results in flight are rejected as stale.
- **One Python event loop** answers every ask and does every fan-out. The
  judge runs in one worker thread, one tile at a time; under many mismatches
  it falls behind (shown as "Waiting to be judged" in the metrics).
- **The rate limit** (30 `LEASE` calls a second, 4 tasks each) can still
  slow the very fastest tabs on the shallowest image, which can pass 120
  tiles a second.
- **The Docker image was written but not built here:** Docker needs root on
  the test machine.

## Page

- **One unit name per tab, kept in `sessionStorage`.** "Duplicate tab" copies
  `sessionStorage`, so the copy uses the same unit name and takes over the
  first tab's routing (PipesHub item 1). The first tab then stops getting
  messages. Not detected.
- **Contributors are per tab.** Opening the page in a new tab, or after
  closing the browser, makes a new contributor; nicknames are not unique.
- **Tiles drawn by this tab** come from the coordinator's credits, so the
  count lags by up to one 250 ms batch, and a tab over the viewer cap shows 0.
- **Hidden tabs pause** taking new tiles; tasks already leased still finish.
- **Module Web Workers** are required (Chrome 80+, Firefox 114+, Safari 15+).
- **Double precision** limits the zoom. The deepest image has about 20
  doubles between neighbouring pixels; going deeper needs arbitrary
  precision, which is out of scope.

## Tests

- The chaos runs use 50 bots in one Node process on one laptop, sharing 3
  compute threads, over localhost. They test the mechanisms, not real
  network conditions or a real crowd's spread of speeds.
- Each chaos image took 15–25 s, so slow bots finished only a few tiles per
  run.
- Browser checks ran in headless Chrome only.
