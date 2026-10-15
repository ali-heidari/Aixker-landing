# AI Agent Instructions — Quiz Rush
## Live multiplayer quiz on PipesHub + Aixker-Agent

---

## What you are building

A real-time quiz game in the style of Kahoot. A **host** opens a game and shows
a 6-digit PIN. **Players** join from their phones. The host runs timed
multiple-choice questions, everyone answers at once, and a live leaderboard
shows after each question.

It lives in the `Aixker-landing` repo at `playground/quiz/` and is served at
`https://aixker.com/playground/quiz/`.

This project is a **reference workload** for two other projects:

- **PipesHub** (`github.com/ali-heidari/PipesHub`) — the real-time message hub
  every browser talks through.
- **Aixker-Agent** (`github.com/ali-heidari/Aixker-Agent`) — an RL-driven L4
  load balancer (eBPF/XDP) that runs on every PipesHub node and moves new TCP
  connections away from busy nodes.

The quiz was chosen because its normal use creates the load Aixker is built
for: a **join spike** when the PIN appears, and an **answer burst** every
round when thousands of players answer within the same few seconds. Design
every part so that this load is real, measurable and visible.

---

## Hard rules

1. **The app never knows Aixker exists.** It knows one PipesHub socket URL and
   one auth URL, nothing else. Aixker is invisible at the network layer.
2. **No build step, no framework.** Plain HTML, CSS and ES modules, the same as
   `dots-and-boxes/`. Third-party browser code loads from a CDN with a pinned
   version (Socket.io client 4.8.x, a small QR-code library). The site is
   static and deployed as-is.
3. **Do not modify the PipesHub or Aixker-Agent repos.** If the quiz needs a
   PipesHub change, stop, describe the change in
   `playground/quiz/KNOWN_LIMITATIONS.md`, and continue with a workaround
   inside the quiz only where this file allows one.
4. **WebSocket-only transport.** Clients must connect with
   `transports: ['websocket']` and send the JWT as `auth: { token }`. Never
   rely on HTTP long-polling: behind Aixker, polling requests from one session
   can land on different nodes and break the session.
5. **Do not add files outside `playground/quiz/`** except the one change to
   `playground/index.html` described in Phase 5.
6. **Never guess an API.** Read the source listed below before using it.

---

## Before you write code

**Step 1 — Ask about repo rules.** Look for `CONTRIBUTING.md`,
`CODE_OF_CONDUCT.md` and any `.agent/` instructions in the repo root and in
`dots-and-boxes/`. Tell the developer what you found and ask whether to follow
those rules. Wait for the answer.

**Step 2 — Read the existing game.** Read all of `dots-and-boxes/src/`
(`pipes.js`, `app.js`, `game.js`, `store.js`, `ui.js`),
`dots-and-boxes/index.html` and `dots-and-boxes/.agent/agent-instructions.md`.
Match their code style, naming and file layout. Note how `index.html` sets
`window.__PIPESHUB_URL__` and `window.__PIPESHUB_AUTH_URL__`; do the same.

**Step 3 — Read PipesHub's server.** Clone `github.com/ali-heidari/PipesHub`
(branch `develop`) and read in full:
- `src/modules/connection_manager.js` — how messages are routed
- `src/services/authenticator.js` — how the JWT is checked
- `src/modules/data.js` — how units are stored in Redis
- `src/routes/auth/index.js` — the `POST /auth` endpoint

**Step 4 — Confirm the facts below against that source.** If any of them is
wrong, stop and tell the developer before writing code.

---

## PipesHub facts this design depends on

These were read from the `develop` branch. Re-check them in Step 4.

- **Message envelope.** A client emits `gateway` with
  `{ senderId, receiverId, operation, input, awaiting }`. The hub looks up the
  receiver's socket id by unit name in Redis and emits `gateway` to it. A reply
  is emitted as `responseGateway` and routed back by `senderId`.
- **Unit names are the address.** A socket registers under
  `handshake.query.name`. A second socket with the same name **overwrites** the
  first one's socket id. So every unit name must be unique per game.
- **`senderId` is set by the client** and the hub does not check it. Any client
  can claim to be the host. Treat this as a known limitation for a demo; record
  it in `KNOWN_LIMITATIONS.md`.
- **Auth.** The socket middleware accepts `handshake.auth.token` (preferred) or
  the `authorization` header. `POST /auth` with form field `name` returns a JWT
  as plain text.
- **There is no broadcast or room primitive.** To reach N players, the host
  sends N messages.
- **Cross-node delivery does not work today.** Each node runs its own
  Socket.io server and calls `io.to(socketId)` on its own instance, with no
  Socket.io Redis adapter. If the host is on node A and a player is on node B,
  the message is dropped without an error. The quiz will work on a single node
  and will lose messages on a multi-node cluster until PipesHub fixes this.
  **Do not work around this in the quiz.** Build the quiz so the loss is
  measured and reported (see the load generator), and record it in
  `KNOWN_LIMITATIONS.md`.

---

## Architecture

### Roles

- **Host** — one browser tab. It is the game authority: it holds the
  questions, runs the timer, scores answers and keeps the player list. All
  game state lives in the host.
- **Player** — one browser per person, mobile-first.

There is no server-side game code. PipesHub only moves messages.

### Unit names

- Host: `quiz-host-<pin>`
- Player: `quiz-p-<pin>-<random>` where `<random>` is 12 characters from
  `crypto.getRandomValues`. The nickname is data inside messages, never part
  of the unit name.
- Store `{ pin, unitName, nickname, token }` in `sessionStorage` so a player
  who refreshes or loses connection rejoins as the same unit.

### Request correlation

`dots-and-boxes/src/pipes.js` resolves an `ask` with
`socket.once('responseGateway')`. With several asks in flight, the first reply
resolves the wrong promise. The quiz client must:
- add a `correlationId` (random string) to `input` on every `ask`
- keep a `Map<correlationId, { resolve, reject, timer }>`
- listen to `responseGateway` once, permanently, and resolve by
  `correlationId`
- reject with `{ code: 'TIMEOUT' }` after a per-call timeout

Write this as `playground/quiz/src/pipes.js`. Start from the dots-and-boxes
version, then apply rule 4 and this section.

### Protocol

| Operation | Direction | Mode | Payload (in `input`) | Reply |
|---|---|---|---|---|
| `JOIN` | player → host | ask | `nickname`, `rejoin: bool` | `{ ok, reason?, playerId, state }` |
| `LOBBY` | host → player | request | `playerCount` | — |
| `QUESTION` | host → player | request | `qid`, `index`, `total`, `text`, `options[]`, `durationMs` | — |
| `ANSWER` | player → host | ask | `qid`, `option` | `{ accepted, late }` |
| `REVEAL` | host → player | request | `qid`, `correct`, `yourPoints`, `yourTotal`, `yourRank` | — |
| `LEADERBOARD` | host → player | request | `top10[]`, `playerCount` | — |
| `END` | host → player | request | `top10[]`, `yourRank`, `yourTotal` | — |
| `PING` | host → player | ask | `seq` | `{ seq }` |

Rules:
- Players accept messages only when `senderId === 'quiz-host-<pin>'`.
- `JOIN` with `rejoin: true` and a known unit name restores the player's score
  and sends the current state (lobby, question in progress with time left, or
  reveal).
- A player who joins during a question waits for the next one.
- `PING` runs every 10 s to a sample of up to 50 players. The host uses the
  round-trip times for its live latency number. It never pings everyone.

### Timing and scoring

- The host stamps each question with its own `performance.now()` start time.
  All timing uses the host's receive time. Player clocks are never trusted.
- The answer window is `durationMs + 500 ms` grace, measured at the host.
- Points: wrong or late = 0. Correct =
  `round(1000 * (1 - 0.5 * elapsed / durationMs))`, so between 500 and 1000.
- Only the first answer per player per question counts.
- Keep scoring and the state machine in `src/game.js` as pure functions with
  no DOM and no network, so they can be unit-tested.

### Fan-out

Sending one message per player blocks the host tab if done in one loop.
- Put all host-to-many sends in `src/fanout.js`.
- Send in batches (default 200 per batch), yielding with `setTimeout(0)`
  between batches.
- Expose one function, `fanout(units, operation, inputFn)`, so it can later be
  replaced by a hub-side broadcast without touching game code.
- Record fan-out duration per question for the host metrics panel.

---

## Screens

Mobile-first for players, large-screen for the host (it goes on a projector).
Follow the visual style of `playground/index.html` (Inter, JetBrains Mono,
existing colors). Use color **and** a shape or letter on each answer button,
so the game works for color-blind players.

### Host (`host.html`)
1. **Setup** — load questions from a JSON file, paste JSON, or use the built-in
   sample quiz. Validate and show clear errors.
2. **Lobby** — big PIN, a QR code linking to the player page with the PIN
   filled in, live player count, nickname cloud (latest 50).
3. **Question** — text, options, countdown, live "answered N / M" counter.
4. **Reveal** — correct answer and a bar per option showing how many chose it.
5. **Leaderboard** — top 10.
6. **End** — podium and final top 10.

A small **metrics panel** (toggle with the `M` key) shows: connected players,
joins per second, answers per second, ANSWER ack time p50/p95, PING round trip
p50/p95, last fan-out duration.

### Player (`index.html`)
1. **Join** — PIN (filled in from `?pin=`) and nickname.
2. **Waiting** — "You're in" and the player count.
3. **Answer** — 2 to 4 large buttons and the countdown.
4. **Result** — correct or wrong, points, total, rank.
5. **End** — final rank.
6. **Reconnecting** — shown on disconnect; retries with backoff and rejoins.

### Question file format

```json
{
  "title": "Networking basics",
  "questions": [
    {
      "text": "Which hook runs before the kernel allocates an sk_buff?",
      "options": ["XDP", "tc", "netfilter", "socket filter"],
      "correct": 0,
      "durationMs": 15000
    }
  ]
}
```

Limits: 1–50 questions, 2–4 options, `durationMs` 5000–60000. Ship
`samples/networking.json` with 10 questions about networking, Linux and eBPF.
Double-check every answer.

---

## Load generator

The load generator produces the numbers this project exists for. It lives in
`playground/quiz/loadgen/`, runs on Node.js ≥ 20, and is the only part with a
`package.json` (dependency: `socket.io-client`, pinned).

- Spawns N bot players that use the same protocol as real players.
- Flags: `--host-url`, `--auth-url`, `--pin`, `--players`, `--ramp-seconds`,
  `--answer-delay-ms min,max`, `--correct-rate`, `--out`.
- Defaults point to `localhost`. Print a warning and require `--yes` when the
  target is not localhost, so it is never pointed at a server by accident.
- A real host page runs the game; the bots join and answer.

It measures and writes to JSON plus a short Markdown summary:
- join time (connect + JOIN reply) p50 / p95 / p99, and failed joins
- ANSWER ack time p50 / p95 / p99, and timeouts
- **lost messages**: each bot counts the QUESTION and REVEAL messages it
  received against what the host sent (the host's END message carries the
  sent count)
- disconnects and successful rejoins

The lost-message count is the key number for the multi-node test. Do not hide
or smooth it.

---

## Tests

Use `node:test`. No test framework.
- `src/game.js`: scoring, late answers, duplicate answers, rejoin restoring
  score, state transitions, ranking ties (same score → earlier total answer
  time ranks first).
- Question-file validation.
- `src/pipes.js` correlation: two concurrent asks resolve to the right reply,
  and timeouts reject.

---

## Phases

Finish each phase, run its checks, and report to the developer before the next
one. Do not start a phase early.

**Phase 1 — Single game on one node.**
Host page, player page, protocol, scoring, sample quiz. Done when one host and
two player tabs on a local single PipesHub node play a full game and the
scores are right.

**Phase 2 — Resilience.**
Correlation IDs, rejoin after refresh, reconnect with backoff, late joiners,
fan-out batching, metrics panel. Done when a player can refresh mid-question
and keep their score, and all unit tests pass.

**Phase 3 — Load generator on one node.**
Done when 1,000 bots finish a 10-question game against a local single node and
the report is written. Report the numbers to the developer as they are.

**Phase 4 — Multi-node run.**
Run the load generator against the 3-node PipesHub compose setup (with Aixker
if the developer's host supports it). Expect lost messages because of the
cross-node limitation. Record the results and the cause in
`KNOWN_LIMITATIONS.md`. Do not change the quiz to hide it.

**Phase 5 — Playground and docs.**
- Add a link or tab for the quiz to `playground/index.html`, next to Dots and
  Boxes. Keep Dots and Boxes as it is.
- Write `playground/quiz/README.md`: what it is, how to run it locally, how to
  run the load generator, how it uses PipesHub, and a link to
  `KNOWN_LIMITATIONS.md`.
- Write `playground/quiz/.agent/agent-instructions.md` (copy this file).

---

## Out of scope

Do not build these: accounts or login, a database, AI question generation,
poll or Q&A modes, a cluster or node dashboard, payments, translations.

---

## Commits

Unless the developer chose the repo's own rules in Step 1:
- Conventional Commits, for example `feat(quiz): add answer scoring`.
- Subject line 50 characters or fewer.
- A short body that says **why**, not what.
- No issue reference footer. No author or co-author trailer.
- One logical change per commit.

---

## When you finish

Report to the developer:
1. What works, with the commands to run it.
2. Phase 3 and Phase 4 numbers, unedited.
3. Everything in `KNOWN_LIMITATIONS.md`.
4. Anything in this file you could not follow, and why.
