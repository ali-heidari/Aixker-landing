# AI Agent Instructions — Dots and Boxes
## Production sample for PipesHub + Aixker-Agent

---

## What you are building

A **Progressive Web App (PWA)** where two people play
[Dots and Boxes](https://en.wikipedia.org/wiki/Dots_and_boxes) in real time.

This is a **production-quality reference project** that demonstrates:

- **PipesHub** ([github.com/ali-heidari/PipesHub](https://github.com/ali-heidari/PipesHub))
  as the real-time messaging fabric between browser peers.
- **Aixker-Agent** ([github.com/ali-heidari/Aixker-Agent](https://github.com/ali-heidari/Aixker-Agent))
  as the kernel-level L4 load balancer routing traffic across multiple PipesHub
  nodes using eBPF/XDP.

The application code must **never be aware of Aixker**. Aixker sits at the
network layer and is invisible to the app. The app only knows a single
`PIPESHUB_URL` and talks to it — Aixker handles everything underneath.

---

## Before you write a single line of code

**Step 1 — Read the PipesClientJS source.**
Clone or fetch `https://github.com/ali-heidari/PipesClientJS` and read
`index.js` in full. Understand the exact method signatures for `request`,
`ask`, and `persist` before you use them. Do not assume — read the source.

**Step 2 — Read the PipesHub README.**
Fetch `https://github.com/ali-heidari/PipesHub` and understand:
- How JWT authentication works (`POST /auth` on the REST port).
- What a unit registration looks like (unit name format, uniqueness rules).
- How the Socket.io connection is established after auth.

**Step 3 — Verify your local environment.**
You need Docker, Node.js ≥ 18, and a Linux host (or VM) with kernel ≥ 5.15
for Aixker. Confirm before proceeding:
```bash
docker --version
node --version
uname -r   # must be 5.15+
```

---

## Project structure

Create this directory layout exactly. Do not add files not listed here unless
a phase explicitly requires it.

```
dots-and-boxes/
├── index.html
├── manifest.json
├── sw.js
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
├── src/
│   ├── app.js          # Entry point
│   ├── game.js         # Pure game logic — no DOM, no network
│   ├── ui.js           # DOM / SVG rendering
│   ├── pipes.js        # PipesHub wrapper
│   └── store.js        # localStorage + sessionStorage helpers
├── styles/
│   └── main.css
└── docker/
    ├── Dockerfile
    ├── docker-compose.yml
    └── nginx.conf
```

---

## Game rules (implement exactly as specified)

### Grid

For an **N×N box grid** (default N = 4):

| Entity | Formula | N=4 |
|---|---|---|
| Dots | (N+1)×(N+1) | 25 |
| Horizontal edges | N×(N+1) | 20 |
| Vertical edges | (N+1)×N | 20 |
| Total edges | 2N(N+1) | 40 |
| Boxes | N×N | 16 |

### Turn logic

1. **Player A (red)** = the challenger (person who typed the UUID). Goes first.
2. **Player B (blue)** = the challenged player.
3. On each turn, the active player draws one edge.
4. After drawing, check all boxes that share that edge (at most 2).
5. If **one or more boxes are newly completed**, the same player goes again.
6. If **no box was completed**, the turn passes to the opponent.
7. Game ends when all edges are drawn. Most boxes wins. Ties are allowed.

### Box completion check

A box at grid position `(r, c)` is complete when all four edges exist:
- **Top**: `hEdges[r][c] === true`
- **Bottom**: `hEdges[r+1][c] === true`
- **Left**: `vEdges[r][c] === true`
- **Right**: `vEdges[r][c+1] === true`

A horizontal edge `hEdges[r][c]` is the edge between dot `(r,c)` and
dot `(r, c+1)`. It is the top edge of box `(r,c)` and the bottom edge of
box `(r-1, c)` (if r > 0).

A vertical edge `vEdges[r][c]` is the edge between dot `(r,c)` and
dot `(r+1, c)`. It is the left edge of box `(r,c)` and the right edge of
box `(r, c-1)` (if c > 0).

---

## Implementation phases

Complete phases in order. Do not begin a phase until the previous one passes
its acceptance check.

---

### Phase 1 — Game logic (`src/game.js`)

Implement all game logic as **pure functions with no side effects**. No DOM,
no network, no globals. This module must be independently testable.

```js
// src/game.js

export function createState(grid = 4) {
  return {
    grid,
    hEdges: Array.from({ length: grid + 1 }, () => Array(grid).fill(false)),
    vEdges: Array.from({ length: grid }, () => Array(grid + 1).fill(false)),
    boxes: Array.from({ length: grid }, () => Array(grid).fill(null)),
    scoreA: 0,
    scoreB: 0,
    turn: 'A',         // 'A' | 'B'
    status: 'playing', // 'playing' | 'finished'
    winner: null,      // 'A' | 'B' | 'tie' | null
  }
}

// Apply a move. Returns { newState, boxesClaimed, turnChanged }.
// Does NOT mutate the input state — return a new state object.
export function applyMove(state, move) { ... }

// move = { axis: 'H'|'V', row: number, col: number }
export function isValidMove(state, move) { ... }

// Returns array of { r, c } for all boxes completed by this edge.
export function getCompletedBoxes(state, move) { ... }

// Returns true if the game is over (all edges drawn).
export function isGameOver(state) { ... }
```

**Acceptance check — Phase 1:**
Open a Node.js REPL and manually verify:
```js
import { createState, applyMove, isValidMove } from './src/game.js'
const s = createState(2)
// Draw 3 edges of the top-left box, then draw the 4th
// Confirm boxesClaimed.length === 1 and turnChanged === false on the 4th move
// Confirm turnChanged === true on a move that completes no box
```

---

### Phase 2 — Static shell (`index.html`, `styles/main.css`, `manifest.json`)

Build the full HTML/CSS shell with hardcoded placeholder content.
**No JavaScript logic yet.** The page must look correct with static data.

**`index.html` requirements:**
- Single `<div id="app">` root.
- Load `src/app.js` as `type="module"`.
- Register the service worker in an inline `<script>` block.
- Link `manifest.json`.
- No external CSS or JS frameworks. Tailwind, Bootstrap, React — none of these.

**`styles/main.css` requirements:**
- Mobile-first. Base layout must work at 375px width.
- Use CSS custom properties for the two player colours:
  `--color-a: #ef4444` (red) and `--color-b: #3b82f6` (blue).
- The board area must use `aspect-ratio: 1` and fill available width up to
  `min(80vw, 80vh, 480px)`.
- No external fonts. Use `system-ui, sans-serif`.

**`manifest.json` requirements:**
```json
{
  "name": "Dots & Boxes",
  "short_name": "DotsBoxes",
  "display": "standalone",
  "start_url": "/",
  "background_color": "#0f172a",
  "theme_color": "#0f172a",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

Generate placeholder icons using Canvas or a simple SVG-to-PNG script.
They do not need to be polished — a coloured square with "D&B" is enough.

**Acceptance check — Phase 2:**
```bash
npx serve .
# Open https://localhost:3000 — page loads, no console errors, looks reasonable
# Open DevTools → Application → Manifest — no errors
```

---

### Phase 3 — SVG board (`src/ui.js`)

Render the interactive game board as an SVG element injected into the DOM.
**No network calls here.** Accept state as a parameter, render from it.

**SVG structure:**
```
<svg id="board" viewBox="0 0 W W">
  <!-- Edges (drawn as lines) -->
  <g id="h-edges"> ... </g>
  <g id="v-edges"> ... </g>
  <!-- Box fills -->
  <g id="boxes"> ... </g>
  <!-- Dots (always on top) -->
  <g id="dots"> ... </g>
  <!-- Hit targets (invisible, capture clicks) -->
  <g id="hit-targets"> ... </g>
</svg>
```

Use a `CELL` constant (e.g. 64px) for the spacing between dots. Total SVG
dimension = `(N + 1) * CELL`. Dots are `<circle r="4">`. Drawn edges are
`<line stroke-width="4">`. Undrawn edges show as thin `stroke-width="1"
opacity="0.15"` lines to hint clickability.

Hit targets are transparent `<rect>` or `<line>` elements sized 12px wide
centered on each undrawn edge. They carry `data-axis`, `data-row`, `data-col`
attributes and emit a `"edge-click"` custom event on the SVG element.

**`ui.js` exports:**
```js
export function renderBoard(container, state, options = {})
// options.onEdgeClick = ({ axis, row, col }) => void
// options.disabled = bool  — disables hit targets when not your turn

export function updateBoard(state)
// Fast update — patches only changed elements, does not re-render from scratch

export function showToast(message, durationMs = 3000)
export function showOverlay(html)  // win screen, disconnect notice
export function hideOverlay()
```

**Accessibility requirements:**
- Each hit target must have `role="button"` and
  `aria-label="Draw edge at row R column C"`.
- An `aria-live="polite"` region must announce score changes and turn changes.

**Acceptance check — Phase 3:**
Open `index.html` in a browser. Call `renderBoard` from the console with a
`createState(4)` result. Confirm dots render, edges are clickable (custom
event fires on click), and box fills appear when you manually set
`state.boxes[0][0] = 'A'` and call `updateBoard`.

---

### Phase 4 — PipesHub integration (`src/pipes.js`)

**Read the PipesClientJS `index.js` source before writing this module.**

This module owns all communication with PipesHub. The rest of the app must
not import PipesClientJS directly.

```js
// src/pipes.js

const PIPESHUB_URL = window.__PIPESHUB_URL__ ?? 'https://localhost:3000'
const AUTH_URL     = window.__PIPESHUB_AUTH_URL__ ?? 'https://localhost:16916'

let _unit = null   // PipesClientJS Unit instance — module-private

// Connect to PipesHub and register as a persistent unit.
// unitName = 'player-{uuid}'
// onMessage = ({ type, ...payload }) => void
// Returns a Promise that resolves when registration is confirmed.
export async function connect(unitName, onMessage) { ... }

// Send a challenge to another player. Returns the opponent's response
// ({ type: 'ACCEPT' } or { type: 'DECLINE' }) or throws on timeout.
export async function challenge(targetUnitName, payload) { ... }

// Send a game move (fire-and-forget).
export function sendMove(targetUnitName, move) { ... }

// Send any fire-and-forget message.
export function send(targetUnitName, payload) { ... }

// Disconnect cleanly.
export function disconnect() { ... }

// Returns true if currently connected to PipesHub.
export function isConnected() { ... }
```

**Error handling rules:**
- `connect()` must retry up to 3 times with 2-second backoff before rejecting.
- `challenge()` must time out after 15 seconds and reject with
  `{ code: 'TIMEOUT' }` if no response arrives.
- All send operations must catch errors and emit a `"pipes-error"` custom event
  on `document` rather than throwing. The UI layer listens for this event and
  shows a toast.

**Authentication:**
PipesHub requires a JWT. `POST /auth` on the REST port returns a token.
Read the PipesHub auth flow from the repo before implementing — use the
exact request format it expects. Store the token in `sessionStorage` under
`dotsboxes.jwt` so reconnects within the same session skip re-auth.

**Acceptance check — Phase 4:**
```bash
# Start a local PipesHub instance (see PipesHub README)
node src/main.js

# Open two browser tabs on index.html
# In tab 1 console:
import { connect } from '/src/pipes.js'
await connect('player-test-a', msg => console.log('received', msg))
# In tab 2 console: register 'player-test-b', then call challenge('player-test-a', { type: 'CHALLENGE' })
# Confirm tab 1 logs the received challenge
```

---

### Phase 5 — App wiring (`src/app.js`, `src/store.js`)

This is the integration layer. It orchestrates game.js + ui.js + pipes.js.

**`src/store.js`:**
```js
// UUID persists across sessions so a player's ID never changes.
export function getOrCreateUUID() {
  let id = localStorage.getItem('dotsboxes.uuid')
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('dotsboxes.uuid', id) }
  return id
}

// Game state survives page refresh during a session (for reconnect recovery).
export function saveGameState(state, opponentUuid) { ... }
export function loadGameState() { ... }   // returns null if none
export function clearGameState() { ... }
```

**`src/app.js` — startup sequence:**
1. Call `getOrCreateUUID()`. Display UUID in the UI.
2. Call `pipes.connect('player-{uuid}', handleInboundMessage)`.
   Show a "Connecting…" spinner until resolved.
3. Check `store.loadGameState()` — if a game was in progress (page refreshed
   mid-game), offer to resume or abandon.
4. Wire the Connect button to call `pipes.challenge(...)` with the typed UUID.
5. Handle inbound messages via `handleInboundMessage`:

```js
function handleInboundMessage(msg) {
  switch (msg.type) {
    case 'CHALLENGE':      handleInboundChallenge(msg); break
    case 'MOVE':           handleInboundMove(msg); break
    case 'RESIGN':         handleResign(); break
    case 'REMATCH_REQUEST': handleRematchRequest(); break
    case 'REMATCH_ACCEPT': startGame(rematchConfig); break
    default: break   // unknown types silently ignored
  }
}
```

**Challenge flow (outbound):**
1. Disable the Connect button, show "Challenging…".
2. `await pipes.challenge('player-{targetUuid}', { type: 'CHALLENGE', from: myUuid, grid: N })`.
3. On `ACCEPT`: call `startGame({ role: 'A', opponentUuid, grid: N })`.
4. On `DECLINE` or timeout: re-enable the Connect button, show a toast.

**Challenge flow (inbound):**
1. Show a modal: "Player {uuid} wants to play. Accept / Decline".
2. Respond via the `ask` reply mechanism (read PipesClientJS for how `ask`
   responses are sent).
3. On accept: call `startGame({ role: 'B', opponentUuid, grid })`.

**`startGame(config)`:**
1. Create `game.createState(config.grid)`.
2. Set `myRole` to `config.role`.
3. Call `ui.renderBoard(boardEl, state, { onEdgeClick: handleEdgeClick,
   disabled: myRole !== state.turn })`.
4. Call `store.saveGameState(state, config.opponentUuid)`.

**`handleEdgeClick({ axis, row, col })`:**
1. If `state.turn !== myRole` — ignore (should not happen; hit targets are
   disabled, but guard defensively).
2. Validate with `game.isValidMove(state, move)`.
3. Apply locally: `state = game.applyMove(state, move).newState`.
4. Send to opponent: `pipes.sendMove('player-{opponentUuid}', move)`.
5. Update UI: `ui.updateBoard(state)`.
6. If `game.isGameOver(state)`: call `endGame()`.
7. Update hit-target disabled state based on new `state.turn`.

**`handleInboundMove(msg)`:**
1. Validate the move is legal for the opponent's role.
2. `state = game.applyMove(state, move).newState`.
3. `ui.updateBoard(state)`.
4. If game over: `endGame()`.
5. Persist updated state.

**Disconnect recovery:**
If `pipes.isConnected()` returns false mid-game, show the overlay:
"Reconnecting…". Attempt `pipes.connect()` every 5 seconds for 60 seconds.
On reconnect, re-register the unit. The opponent's client does the same.
If 60 seconds pass with no reconnect, declare the waiting player the winner.

**Acceptance check — Phase 5:**
Open two browser windows. Connect them to each other. Play a full 4×4 game
to completion. Verify: correct turn alternation, chain reactions grant extra
turns, final scores are correct, win overlay appears.

---

### Phase 6 — Service worker (`sw.js`)

```js
const CACHE = 'dotsboxes-v1'
const SHELL = ['/', '/index.html', '/manifest.json', '/styles/main.css',
               '/src/app.js', '/src/game.js', '/src/ui.js',
               '/src/pipes.js', '/src/store.js',
               '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(SHELL))
))

self.addEventListener('fetch', e => {
  // Network-first for PipesHub URLs, cache-first for shell assets
  if (e.request.url.includes('localhost:3000') ||
      e.request.url.includes('localhost:16916')) return
  e.respondWith(
    caches.match(e.request).then(r => r ?? fetch(e.request))
  )
})
```

**Acceptance check — Phase 6:**
DevTools → Application → Service Workers — status is "activated and running".
Throttle to Offline in DevTools — the app shell loads with an "Offline" banner.
PipesHub connection attempts fail gracefully with a toast, not a crash.

---

### Phase 7 — Docker deployment (`docker/`)

**`docker/Dockerfile`** — serves the PWA via nginx:
```dockerfile
FROM nginx:1.25-alpine
COPY . /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
```

**`docker/nginx.conf`:**
```nginx
server {
    listen 8080;
    root /usr/share/nginx/html;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
    add_header Cache-Control "no-cache" always;
}
```

**`docker/docker-compose.yml`:**
```yaml
version: '3.9'

networks:
  game-net:
    driver: macvlan
    driver_opts:
      parent: eth0
    ipam:
      config:
        - subnet: 192.168.100.0/24

services:
  pwa:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    ports:
      - "8080:8080"
    environment:
      # Inject PipesHub address at runtime via envsubst or nginx template
      - PIPESHUB_URL=https://192.168.100.50:3000
      - PIPESHUB_AUTH_URL=https://192.168.100.50:16916

  mongo:
    image: mongo:7
    networks:
      game-net:
        ipv4_address: 192.168.100.20

  hub1:
    image: pipeshub:latest
    networks:
      game-net:
        ipv4_address: 192.168.100.51
    environment:
      - MONGO_URI=mongodb://192.168.100.20/pipeshub
      - PORT=16916
      - SOCKET_PORT=3000
    depends_on: [mongo]

  hub2:
    image: pipeshub:latest
    networks:
      game-net:
        ipv4_address: 192.168.100.52
    environment:
      - MONGO_URI=mongodb://192.168.100.20/pipeshub
      - PORT=16916
      - SOCKET_PORT=3000
    depends_on: [mongo]

  aixker1:
    image: aixker-agent:latest
    network_mode: host
    cap_add: [NET_ADMIN, SYS_ADMIN]
    environment:
      - AIXKER_BACKENDS=192.168.100.51:3000,192.168.100.52:3000
      - AIXKER_LISTEN_PORT=3000
      - AIXKER_VIRTUAL_IP=192.168.100.50
    privileged: true
    depends_on: [hub1, hub2]
```

The **virtual IP `192.168.100.50:3000`** is the Aixker VIP. The PWA connects
to this address. Aixker routes connections to `hub1` or `hub2` based on load.
Neither hub address is ever exposed to the browser.

**Acceptance check — Phase 7:**
```bash
cd docker && docker compose up -d --build
# Open https://localhost:8080 in two browser tabs
# Play a full game — confirm it works
# docker compose stop hub1
# Confirm clients reconnect within 3 seconds and can continue playing
```

---

## Environment variables injected into the PWA

The nginx container uses `envsubst` to write these into a `<script>` block in
`index.html` at container startup:

```html
<script>
  window.__PIPESHUB_URL__      = "${PIPESHUB_URL}";
  window.__PIPESHUB_AUTH_URL__ = "${PIPESHUB_AUTH_URL}";
</script>
```

Add this block to `index.html` **above** the `src/app.js` module script.
For local dev (no Docker), the defaults in `pipes.js` (`localhost:3000` and
`localhost:16916`) are used.

---

## Message protocol reference

### Challenge handshake

```
Player A  ──ask──>  player-{uuid-b}   { type: "CHALLENGE", from: uuid-a, grid: N }
Player B  ──(ask response)──>  A      { type: "ACCEPT" }   or   { type: "DECLINE" }
```

### Game moves

```
Active player  ──request──>  opponent  { type: "MOVE", axis: "H"|"V", row: R, col: C }
```

### Control messages (all via `request`)

```
{ type: "RESIGN" }
{ type: "REMATCH_REQUEST" }
{ type: "REMATCH_ACCEPT" }
```

### Heartbeat (optional, implement last)

```
{ type: "PING" }      — sent every 10s by each client
{ type: "PONG" }      — sent immediately on receipt of PING
```

If no PING is received for 30 seconds, treat the opponent as disconnected.

---

## Hard rules — do not break these

1. **No game server.** All game logic runs in the browser. PipesHub is a
   relay, not a referee. If you find yourself adding server-side game logic,
   you are doing it wrong.

2. **No Aixker awareness in app code.** The app connects to one URL. It does
   not know how many hub nodes exist. It does not implement retry logic that
   targets a specific hub. Reconnects always go back to the same
   `PIPESHUB_URL` (the Aixker VIP).

3. **No frameworks.** Vanilla JS ES modules only. No bundler (Vite, Webpack,
   Rollup). No React, Vue, Svelte. The PWA must load by opening `index.html`
   directly in a browser or via `npx serve .`.

4. **Immutable state in game.js.** `applyMove` must return a new state object.
   Never mutate the input. This makes reconnect state serialisation trivial.

5. **UUID is stable.** Once generated, the UUID stored in `localStorage` never
   changes. A player can share their UUID once and it will still work tomorrow.

---

## What this project demonstrates

| Observable moment | PipesHub capability | Aixker capability |
|---|---|---|
| Player opens the app — unit registers instantly | `persist` mode — open channel | — |
| Player challenges opponent by UUID | `ask` mode — request/response | — |
| Move delivered in < 100ms | `request` mode — fire-and-forget | — |
| Chain reaction: 5 moves in rapid succession | Message burst on `request` | RL state flips BUSY |
| 50 concurrent games | High connection count | Load distributed across hub nodes |
| Hub node killed mid-game | — | Dead node evicted; clients reconnect < 3s |
| Full game played on mobile | PWA standalone mode | — |

This table is the demo script. Every row is something you can show a
non-technical observer and explain in one sentence.
