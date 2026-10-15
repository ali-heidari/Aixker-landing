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
  different nodes is lost. With Aixker spreading connections, that is most
  players.
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
