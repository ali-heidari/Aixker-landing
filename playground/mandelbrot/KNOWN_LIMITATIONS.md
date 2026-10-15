# Known limitations

Crowd Mandelbrot runs on PipesHub (`ali-heidari/PipesHub`, branch `develop`,
read at commit `87bbbdd`). These are the limits we know about. None of the
PipesHub repos are patched; workarounds live in this folder.

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
