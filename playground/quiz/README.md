# Quiz Rush

A live multiplayer quiz in the style of Kahoot. A host opens a game and shows
a 6-digit PIN and a QR code; players join from their phones, answer timed
multiple-choice questions, and score points for being right and fast.

It is also a load-test workload for [PipesHub](https://github.com/ali-heidari/PipesHub)
and [Aixker-Agent](https://github.com/ali-heidari/Aixker-Agent): one host
sending to many players at once, with a load generator that measures what
arrives.

Plain HTML, CSS and ES modules. No build step. Libraries come from a CDN with
pinned versions (Socket.io client 4.8.3, qrcode-generator 1.4.4).

Live: <https://aixker.com/playground/quiz/host.html> (host),
<https://aixker.com/playground/quiz/> (players).

## Files

| Path | What it is |
|---|---|
| `host.html`, `src/host.js` | Host screen. Holds the game state, the clock and the scores. |
| `index.html`, `src/player.js` | Player screen (phones). |
| `src/game.js` | Game rules and scoring. Pure functions, no I/O. |
| `src/questions.js` | Quiz file validation. |
| `src/pipes.js` | The only file that talks to PipesHub. |
| `src/fanout.js` | Sends one message to many players in batches. |
| `src/metrics.js`, `src/store.js`, `src/ui.js` | Metrics, session storage, DOM helpers. |
| `samples/networking.json` | Sample quiz (10 questions). |
| `loadgen/` | Bot players for load tests (Node). |
| `test/` | Unit tests (`node:test`). |
| [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) | What does not work, and the load-test results. |

## Run it locally

You need Node 20.19 or newer, Redis, and a PipesHub checkout.

1. **Start Redis** on `127.0.0.1:6379` (any way you like, e.g.
   `docker run -p 6379:6379 redis:7-alpine`).

2. **Start one PipesHub node**, plain HTTP, no TLS:

   ```bash
   git clone -b develop https://github.com/ali-heidari/PipesHub.git
   cd PipesHub && npm ci
   PORT=16916 SOCKET_PORT=3000 JWT_SECRET=dev-secret \
     REDIS_URL=redis://127.0.0.1:6379/0 node src/main.js
   ```

   Socket.io is now on `http://localhost:3000` and `POST /auth` on
   `http://localhost:16916`.

3. **Serve this repo** from its root:

   ```bash
   python3 -m http.server 8000
   ```

4. **Open the host:** <http://localhost:8000/playground/quiz/host.html>.
   Load a quiz (*Use the sample*, a `.json` file, or pasted JSON), then
   *Open lobby*.

5. **Join as players:** scan the QR code, or open
   <http://localhost:8000/playground/quiz/> in other tabs and type the PIN.
   To join from a phone on your network, open the host page through your
   machine's LAN IP instead of `localhost`.

When a page is served from `localhost` or a private IP, it talks to the hub on
the same host (ports 3000 and 16916). Add `?hub=` and `?auth=` to point it at
another hub, for example
`host.html?hub=http://192.168.102.2:3000&auth=http://192.168.102.2:16916`.
The host passes them on in the join link. On any other host the pages use
`https://playground.aixker.com:3000` and `https://playground.aixker.com`.

Press **M** on the host to show the metrics panel (players, joins and answers
per second, ANSWER ack and PING round-trip times, last fan-out). Tick
*Auto-advance* to run a game hands-free.

### Quiz file

```json
{
  "title": "My quiz",
  "questions": [
    { "text": "2 + 2?", "options": ["3", "4"], "correct": 1, "durationMs": 10000 }
  ]
}
```

1–50 questions, 2–4 options each, `correct` is the index of the right option,
`durationMs` is 5000–60000 (default 20000).

### Tests

```bash
cd playground/quiz
node --test
```

## Load generator

Bots that join a game a real host page is running, answer every question, and
write a report. The host page must be open and in the lobby first.

```bash
cd playground/quiz/loadgen
npm ci
```

1. Open `host.html`, load the sample quiz, tick *Auto-advance*, *Open lobby*,
   and note the PIN.
2. Start the bots:

   ```bash
   node index.js --pin 123456 --players 1000 --ramp-seconds 10 \
     --answer-delay-ms 500,4000 --correct-rate 0.7 --out results/run1
   ```

3. When the host shows everyone joined, press *Start*. The generator stops
   when every bot has seen END and writes `report.json` and `summary.md`.

| Flag | Default | |
|---|---|---|
| `--host-url` | `http://localhost:3000` | PipesHub Socket.io URL. Comma-separate several to spread bots round-robin. |
| `--auth-url` | `http://localhost:16916` | PipesHub auth URL, paired with `--host-url` by position. |
| `--pin` | (required) | Game PIN from the host. |
| `--players` | 100 | Number of bots. |
| `--ramp-seconds` | 10 | Spread the joins over this many seconds. |
| `--answer-delay-ms` | `500,4000` | Each answer waits a random time in this range. |
| `--correct-rate` | 0.7 | Share of correct answers. |
| `--quiz` | `../samples/networking.json` | The quiz the host runs, so bots know the answers. |
| `--out` | `results/<time>` | Report folder. |
| `--max-minutes` | 30 | Give up waiting for END after this long. |
| `--yes` | | Required when a URL is not on localhost. |

The report has join time and failures, ANSWER ack time (p50, p95, p99) and
timeouts, disconnects and rejoins, and **lost messages**: END carries how many
QUESTION and REVEAL messages the host sent each player, and each bot compares
that with what it received. Losses are reported as measured.

## How it uses PipesHub

- Every page and bot is one PipesHub *unit*. It gets a JWT with
  `POST /auth` (`name=<unit>`), then connects with Socket.io using
  `transports: ['websocket']`, `auth: { token }` and `query: { name }`.
  WebSocket only, so a session never spans nodes behind Aixker.
- The host is unit `quiz-host-<pin>`. A player is `quiz-p-<pin>-<random>`;
  the name is kept in `sessionStorage`, so a refreshed player rejoins with the
  same score.
- Messages go through PipesHub's `gateway` event. Requests that need an
  answer (JOIN, ANSWER, PING) carry a correlation id and get their reply on
  `responseGateway`. Nothing is sent until the hub's `gateway` 200 arrives.
- Operations: JOIN, LOBBY, QUESTION, ANSWER, REVEAL, LEADERBOARD, END, PING.
- The host tab is the only authority: it keeps the clock, accepts the first
  answer per question within the time limit plus 500 ms, and scores
  `round(1000 × (1 − 0.5 × elapsed / duration))` for a correct answer.
- PipesHub has no broadcast, so the host sends one message per player, 200
  per batch, yielding to the browser between batches.
- The app knows one Socket.io URL and one auth URL. It does not know Aixker
  exists.

PipesHub delivers only to sockets on the node that received the message, so
on a cluster, players on a different node from the host cannot join. This and
the other limits, with the Phase 3 and Phase 4 load-test numbers, are in
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
