# Known limitations

Quiz Rush is a demo and a load-test workload. These are the limits we know
about. Most come from PipesHub (`ali-heidari/PipesHub`, branch `develop`,
read at commit `87bbbdd`). The quiz does not patch around PipesHub; each item
says what PipesHub would need to change.

## PipesHub

### 1. Messages between nodes are dropped

Each PipesHub node runs its own Socket.io server and delivers with
`io.to(socketId)` on that server only. There is no Socket.io Redis adapter.
Unit lookups go through the shared Redis, so a node finds the receiver's
socket id, but if that socket lives on another node the emit goes nowhere.
No error is raised on either side.

- **Effect on the quiz:** on a multi-node cluster, any QUESTION, REVEAL,
  LEADERBOARD, END, JOIN reply or ANSWER ack between a host and a player on
  different nodes is lost. The first casualty is JOIN: a player on another
  node than the host never gets in, so the host never counts it and its loss
  does not show up as missing QUESTIONs. See [Multi-node test](#multi-node-test-phase-4).
- **What the quiz does:** nothing to hide it. The load generator counts
  QUESTION and REVEAL messages received against the count the host puts in
  END, and reports the loss.
- **PipesHub change needed:** add `@socket.io/redis-adapter` (or another
  cross-node adapter) so `io.to(socketId)` reaches sockets on every node.

### 2. Anyone can claim to be the host

`senderId` is set by the client and the hub does not check it. Also, the JWT
from `POST /auth` is not tied to a unit name: `verifySocketIO` checks the
signature only, so any valid token can register any `handshake.query.name`.

- **Effect:** a client can send messages that claim to come from
  `quiz-host-<pin>`, and can even register as `quiz-host-<pin>` and take over
  the host's routing (the second socket with a name overwrites the first).
- **What the quiz does:** players accept game messages only when
  `senderId === 'quiz-host-<pin>'`. That stops honest mistakes, not attacks.
- **PipesHub change needed:** put the unit name in the JWT (e.g. as `aud` or
  `sub`), reject a socket whose `query.name` does not match, and set
  `senderId` on the server from the socket's own unit name.

### 3. Messages sent right after connecting can be lost

In `connection_manager.js` the `gateway` and `responseGateway` listeners are
attached after an awaited Redis lookup. Anything the client emits before that
is dropped by Socket.io. The Redis write of the new socket id (`addUnit` /
`updateSocketId`) is not awaited either, so a reply routed to the new unit
during that window can go to its old socket id.

- **What the quiz does:** `src/pipes.js` sends nothing until the hub's
  `gateway` 200 arrives (the hub sends it after the lookup). JOIN is safe to
  retry, so a lost reply only costs a timeout and one more try.
- **PipesHub change needed:** attach listeners before any `await`, await the
  Redis write, and only then emit 200.

### 4. A reconnect can be routed to a dead socket

`disconnectUnit` reads the unit, sets `disconnectDate`, and writes the whole
record back. If that read happens before a fast reconnect's `updateSocketId`
and the write lands after it, the record goes back to the old socket id.
Messages to that unit are then lost until it reconnects again.

- **PipesHub change needed:** update single fields (`HSET`) or compare the
  socket id before writing on disconnect.

### 5. No broadcast

There is no room or broadcast primitive, so the host sends one message per
player. With N players a question costs N sends from one browser tab.

- **What the quiz does:** all one-to-many sends go through one function so a
  hub-side broadcast can replace it later.
- **PipesHub change needed:** a broadcast or group operation.

### 6. Redis keeps every unit and user forever

`unit:<name>` and `user:<name>` keys are never deleted or given a TTL. Every
player of every game adds two keys; a 1,000-bot load test adds 2,000.

- **PipesHub change needed:** a TTL on unit and user keys, or delete the unit
  on disconnect after a grace period.

### 7. Tokens never expire

The JWT has no `exp`. A leaked token works until `JWT_SECRET` changes.

## Quiz

- **The host tab holds the whole game.** If the host closes or reloads the
  tab, the game is gone. Players stay on their current screen because no more
  messages arrive.
- **PIN collisions are not checked.** A PIN is 6 random digits. Two hosts with
  the same PIN would overwrite each other's routing (see item 2).
- **Keep the host tab in the foreground.** Browsers slow down timers and stop
  animation frames in background tabs, which delays the host's sends and
  screen updates.
- **ANSWER ack time comes from the players.** The host cannot see when its
  reply reaches a phone, so each player sends the round trip of its previous
  ANSWER inside the next one. The number lags by one question, and a player
  could send a fake value. It is for the metrics panel only, never scoring.
- **"Seen in last 30 s" is not "connected".** The host has no view of player
  sockets; it counts players it heard from (JOIN, ANSWER or a PING reply).
- **After a hub restart, players need a few seconds.** Socket.io retries with
  1–5 s of randomized backoff, then the player rejoins. A question that ends
  during that time counts as unanswered for them.

## Multi-node test (Phase 4)

Run on 2026-10-15 against PipesHub's own `docker-compose.yml` (develop
`87bbbdd`): Redis plus three nodes, each with the Aixker agent
(`ghcr.io/ali-heidari/aixker-agent:latest`, XDP attached to `eth0`). The
compose file needed an override to start at all: it builds from a
`pipeshub-dockerfile` that does not exist (the file is `Dockerfile`), and it
mounts TLS certificates from `./certs` that are not in the repo. The override
uses `Dockerfile`, turns TLS off, and publishes no host ports; every node was
reached on its bridge IP (node-a `192.168.102.2`, b `.3`, c `.4`).

Each run: 1,000 bots from `loadgen/` on the same machine, ramp 10 s, answer
delay 500–4000 ms, correct rate 0.7, the sample quiz (10 questions), and a
real host page in headless Chrome connected to node-a.

| Run | Bots sent to | Joined | Failed joins | Answers acked | QUESTION + REVEAL lost |
|---|---|---|---|---|---|
| A | a, b, c round-robin | 104 / 1000 | 896 (all JOIN timeouts) | 1040 / 1040 | 0 of 2080 |
| A2 (same as A) | a, b, c round-robin | 334 / 1000 | 666 (all JOIN timeouts) | 3340 / 3340 | 0 of 6680 |
| B | node-a only | 1000 / 1000 | 0 | 10000 / 10000 | 0 of 20000 |

Per node, run A2: node-a 334 bots, 334 joined; node-b 333, 0 joined;
node-c 333, 0 joined. Run B ANSWER ack p50 / p95 / p99 was 4.4 / 10.1 /
20.1 ms (max 57.9), join p50 / p95 / p99 32.5 / 147.6 / 178.4 ms, with no
disconnects; about the same as the single-node run.

**Cause of the failed joins (b and c):** item 1 above. A bot on node-b sends
JOIN to `quiz-host-<pin>`; node-b finds the host's socket id in Redis and
emits to it on its own Socket.io server, where that socket does not exist.
Nothing arrives and nobody gets an error, so the bot times out after 10 s.
Every bot on b or c failed this way in every run. The quiz was not changed to
work around it: players can only be served by the node the host is on until
PipesHub routes between nodes.

**Run A, node-a:** only the first 104 of node-a's 334 bots joined (bots 1–104
in start order, the first ~3 s of the ramp); every later bot sent to node-a's
IP timed out on JOIN the same way as the b and c bots. The host saw only those
104 JOINs, so the later JOINs reached a node without the host's socket. The
likely cause is the Aixker agent marking node-a busy and redirecting new
connections to b or c, but this is **not confirmed**: it did not happen in
A2 or B, and the container logs have not been checked yet. During A2, a probe
that opened sockets to node-a's IP and messaged a unit known to be on node-a
found every socket on node-a.

**Aixker in run B:** all 1,000 sockets stayed on node-a and nothing was
redirected. When the agent does redirect, those players will fail to join for
the reason above, because the host is still on node-a.
