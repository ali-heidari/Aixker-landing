const CELL = 64       // px between dots
const DOT_R = 4       // dot radius
const EDGE_W = 4      // drawn edge stroke width
const GHOST_W = 1     // undrawn edge stroke width
const HIT = 14        // hit-target width

const COLOR_A = 'var(--color-a)'
const COLOR_B = 'var(--color-b)'
const COLOR_DOT  = '#94a3b8'
const COLOR_EDGE = '#f1f5f9'
const COLOR_GHOST = 'rgba(148,163,184,0.18)'

let _svg = null
let _state = null
let _options = {}
let _toastTimer = null

// ── Helpers ─────────────────────────────────────────────────────────────────

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

function dotX(col) { return (col + 1) * CELL }
function dotY(row) { return (row + 1) * CELL }

function hEdgeKey(r, c) { return `h-${r}-${c}` }
function vEdgeKey(r, c) { return `v-${r}-${c}` }
function boxKey(r, c)   { return `box-${r}-${c}` }
function hitHKey(r, c)  { return `hit-h-${r}-${c}` }
function hitVKey(r, c)  { return `hit-v-${r}-${c}` }

// ── renderBoard ──────────────────────────────────────────────────────────────

export function renderBoard(container, state, options = {}) {
  _state = state
  _options = options
  const { grid } = state
  const W = (grid + 2) * CELL

  _svg = svgEl('svg', {
    id: 'board',
    viewBox: `0 0 ${W} ${W}`,
    role: 'group',
    'aria-label': 'Dots and Boxes game board',
  })

  const gBoxes   = svgEl('g', { id: 'boxes' })
  const gEdges   = svgEl('g', { id: 'edges' })
  const gDots    = svgEl('g', { id: 'dots' })
  const gTargets = svgEl('g', { id: 'hit-targets' })

  // Box fills
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      const rect = svgEl('rect', {
        id: boxKey(r, c),
        x: dotX(c),
        y: dotY(r),
        width: CELL,
        height: CELL,
        fill: _boxFill(state.boxes[r][c]),
        opacity: 0.25,
      })
      gBoxes.appendChild(rect)
    }
  }

  // Horizontal edges + hit targets
  for (let r = 0; r <= grid; r++) {
    for (let c = 0; c < grid; c++) {
      const drawn = state.hEdges[r][c]
      const line = svgEl('line', {
        id: hEdgeKey(r, c),
        x1: dotX(c),      y1: dotY(r),
        x2: dotX(c + 1),  y2: dotY(r),
        stroke: drawn ? _edgeColor(drawn) : COLOR_GHOST,
        'stroke-width': drawn ? EDGE_W : GHOST_W,
        'stroke-linecap': 'round',
      })
      gEdges.appendChild(line)

      if (!drawn) {
        const hit = _makeHitH(r, c, grid)
        gTargets.appendChild(hit)
      }
    }
  }

  // Vertical edges + hit targets
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c <= grid; c++) {
      const drawn = state.vEdges[r][c]
      const line = svgEl('line', {
        id: vEdgeKey(r, c),
        x1: dotX(c),  y1: dotY(r),
        x2: dotX(c),  y2: dotY(r + 1),
        stroke: drawn ? _edgeColor(drawn) : COLOR_GHOST,
        'stroke-width': drawn ? EDGE_W : GHOST_W,
        'stroke-linecap': 'round',
      })
      gEdges.appendChild(line)

      if (!drawn) {
        const hit = _makeHitV(r, c, grid)
        gTargets.appendChild(hit)
      }
    }
  }

  // Dots (always on top)
  for (let r = 0; r <= grid; r++) {
    for (let c = 0; c <= grid; c++) {
      gDots.appendChild(svgEl('circle', {
        cx: dotX(c), cy: dotY(r), r: DOT_R,
        fill: COLOR_DOT,
      }))
    }
  }

  _svg.appendChild(gBoxes)
  _svg.appendChild(gEdges)
  _svg.appendChild(gDots)
  _svg.appendChild(gTargets)

  container.innerHTML = ''
  container.appendChild(_svg)
}

// ── updateBoard ──────────────────────────────────────────────────────────────

export function updateBoard(state) {
  if (!_svg) return
  const prev = _state
  _state = state
  const { grid } = state

  // Update changed box fills and recolor all 4 edges to the box owner
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      if (state.boxes[r][c] !== prev.boxes[r][c]) {
        const el = _svg.getElementById(boxKey(r, c))
        if (el) el.setAttribute('fill', _boxFill(state.boxes[r][c]))

        const owner = state.boxes[r][c]
        const color = _edgeColor(owner)
        const edges = [
          _svg.getElementById(hEdgeKey(r,     c)),
          _svg.getElementById(hEdgeKey(r + 1, c)),
          _svg.getElementById(vEdgeKey(r, c)),
          _svg.getElementById(vEdgeKey(r, c + 1)),
        ]
        for (const edge of edges) {
          if (edge) edge.setAttribute('stroke', color)
        }
      }
    }
  }

  // Update newly drawn horizontal edges + remove their hit targets
  for (let r = 0; r <= grid; r++) {
    for (let c = 0; c < grid; c++) {
      if (state.hEdges[r][c] && !prev.hEdges[r][c]) {
        const line = _svg.getElementById(hEdgeKey(r, c))
        if (line) {
          line.setAttribute('stroke', _edgeColor(state.hEdges[r][c]))
          line.setAttribute('stroke-width', EDGE_W)
        }
        const hit = _svg.getElementById(hitHKey(r, c))
        if (hit) hit.remove()
      }
    }
  }

  // Update newly drawn vertical edges + remove their hit targets
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c <= grid; c++) {
      if (state.vEdges[r][c] && !prev.vEdges[r][c]) {
        const line = _svg.getElementById(vEdgeKey(r, c))
        if (line) {
          line.setAttribute('stroke', _edgeColor(state.vEdges[r][c]))
          line.setAttribute('stroke-width', EDGE_W)
        }
        const hit = _svg.getElementById(hitVKey(r, c))
        if (hit) hit.remove()
      }
    }
  }

  // Sync hit-target disabled state with current turn
  _syncHitTargets()
}

// ── setDisabled ──────────────────────────────────────────────────────────────

export function setDisabled(disabled) {
  _options.disabled = disabled
  _syncHitTargets()
}

// ── showToast ────────────────────────────────────────────────────────────────

export function showToast(message, durationMs = 3000) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = message
  el.hidden = false
  clearTimeout(_toastTimer)
  _toastTimer = setTimeout(() => { el.hidden = true }, durationMs)
}

// ── showOverlay / hideOverlay ────────────────────────────────────────────────

export function showOverlay(html) {
  const overlay = document.getElementById('overlay')
  const content = document.getElementById('overlay-content')
  if (!overlay || !content) return
  content.innerHTML = html
  overlay.hidden = false
}

export function hideOverlay() {
  const overlay = document.getElementById('overlay')
  if (overlay) overlay.hidden = true
}

// ── announce (aria-live) ──────────────────────────────────────────────────────

export function announce(message) {
  const el = document.getElementById('announcer')
  if (!el) return
  el.textContent = ''
  requestAnimationFrame(() => { el.textContent = message })
}

// ── Private helpers ──────────────────────────────────────────────────────────

function _boxFill(owner) {
  if (owner === 'A') return COLOR_A
  if (owner === 'B') return COLOR_B
  return 'transparent'
}

function _edgeColor(player) {
  if (player === 'A') return COLOR_A
  if (player === 'B') return COLOR_B
  return COLOR_EDGE
}

function _makeHitH(r, c, grid) {
  const x = dotX(c)
  const y = dotY(r) - HIT / 2
  const hit = svgEl('rect', {
    id: hitHKey(r, c),
    x,
    y,
    width: CELL,
    height: HIT,
    fill: 'transparent',
    role: 'button',
    'aria-label': `Draw horizontal edge at row ${r} column ${c}`,
    tabindex: '0',
    cursor: 'pointer',
    'data-axis': 'H',
    'data-row': r,
    'data-col': c,
  })
  _attachHitListeners(hit)
  return hit
}

function _makeHitV(r, c, grid) {
  const x = dotX(c) - HIT / 2
  const y = dotY(r)
  const hit = svgEl('rect', {
    id: hitVKey(r, c),
    x,
    y,
    width: HIT,
    height: CELL,
    fill: 'transparent',
    role: 'button',
    'aria-label': `Draw vertical edge at row ${r} column ${c}`,
    tabindex: '0',
    cursor: 'pointer',
    'data-axis': 'V',
    'data-row': r,
    'data-col': c,
  })
  _attachHitListeners(hit)
  return hit
}

function _attachHitListeners(el) {
  const fire = () => {
    if (_options.disabled) return
    _svg.dispatchEvent(new CustomEvent('edge-click', {
      bubbles: true,
      detail: {
        axis: el.dataset.axis,
        row:  Number(el.dataset.row),
        col:  Number(el.dataset.col),
      },
    }))
  }
  el.addEventListener('click', fire)
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire() } })
}

function _syncHitTargets() {
  if (!_svg) return
  const targets = _svg.getElementById('hit-targets')
  if (!targets) return
  const disabled = !!_options.disabled
  for (const el of targets.children) {
    el.setAttribute('cursor', disabled ? 'not-allowed' : 'pointer')
    el.setAttribute('aria-disabled', disabled ? 'true' : 'false')
  }
}
