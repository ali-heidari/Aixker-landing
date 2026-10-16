// Draws the job on a <canvas>, one tile at a time, plus an overlay canvas
// with outlines of tiles in progress. Escape counts arrive from the
// coordinator; colour is decided here only.
//
// Modes:
//   'fractal'  the palette below
//   'who'      each tile in its contributor's colour, shaded by the fractal

const INSIDE = [0, 0, 0]
const UNKNOWN_COLOR = [128, 128, 128]

/**
 * A cyclic palette: the colour repeats every `period` iterations, so deep
 * zooms (where every count is in the thousands) still show bands.
 * coordinator/render.py builds the same one for the saved PNGs.
 */
export function buildPalette(maxIter) {
  const period = 32 + Math.round(maxIter / 40)
  const lut = new Uint8ClampedArray((maxIter + 1) * 3)
  for (let i = 0; i < maxIter; i++) {
    const t = (i % period) / period
    lut[i * 3]     = 255 * (0.5 + 0.5 * Math.cos(2 * Math.PI * (t + 0.55)))
    lut[i * 3 + 1] = 255 * (0.5 + 0.5 * Math.cos(2 * Math.PI * (t + 0.70)))
    lut[i * 3 + 2] = 255 * (0.5 + 0.5 * Math.cos(2 * Math.PI * (t + 0.90)))
  }
  lut.set(INSIDE, maxIter * 3)
  return lut
}

/** '#rrggbb' → [r, g, b], or null. */
export function parseColor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? '')
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}

/**
 * canvas    the image
 * overlay   a canvas of the same size on top, for outlines
 * colorOf   contributorId => '#rrggbb' | undefined
 */
export function createTileCanvas(canvas, overlay, colorOf = () => undefined) {
  const ctx  = canvas.getContext('2d')
  const octx = overlay.getContext('2d')
  let job = null
  let palette = null
  let shade = null          // per-count brightness 0.35–1, for 'who' mode
  let mode = 'fractal'
  const tiles = new Map()   // tileId → { counts, contributorId, colored }

  function setJob(next) {
    job = next
    palette = buildPalette(job.maxIter)
    shade = new Float32Array(job.maxIter + 1)
    for (let i = 0; i <= job.maxIter; i++) {
      const lum = (0.299 * palette[i * 3] + 0.587 * palette[i * 3 + 1] + 0.114 * palette[i * 3 + 2]) / 255
      shade[i] = 0.35 + 0.65 * lum
    }
    tiles.clear()
    for (const c of [canvas, overlay]) { c.width = job.width; c.height = job.height }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    octx.clearRect(0, 0, overlay.width, overlay.height)
  }

  function geometry(tileId) {
    const col = tileId % job.cols
    const row = Math.floor(tileId / job.cols)
    const x = col * job.tileSize
    const y = row * job.tileSize
    return { x, y, w: Math.min(job.tileSize, job.width - x), h: Math.min(job.tileSize, job.height - y) }
  }

  function validTile(tileId) {
    return job && Number.isInteger(tileId) && tileId >= 0 && tileId < job.cols * job.rows
  }

  /** Returns false (and draws nothing) if the counts do not fit the tile. */
  function drawTile(tileId, counts, contributorId) {
    if (!validTile(tileId)) return false
    const g = geometry(tileId)
    if (counts.length !== g.w * g.h) return false
    const entry = { counts, contributorId, colored: false }
    tiles.set(tileId, entry)
    paint(entry, g)
    return true
  }

  function paint(entry, { x, y, w, h }) {
    const img = ctx.createImageData(w, h)
    const px  = img.data
    const max = job.maxIter
    const { counts } = entry
    if (mode === 'who') {
      const rgb = parseColor(colorOf(entry.contributorId))
      entry.colored = !!rgb
      const [r, g, b] = rgb ?? UNKNOWN_COLOR
      for (let i = 0; i < counts.length; i++) {
        const s = shade[Math.min(counts[i], max)]
        px[i * 4] = r * s; px[i * 4 + 1] = g * s; px[i * 4 + 2] = b * s; px[i * 4 + 3] = 255
      }
    } else {
      for (let i = 0; i < counts.length; i++) {
        const c = Math.min(counts[i], max) * 3
        px[i * 4] = palette[c]; px[i * 4 + 1] = palette[c + 1]; px[i * 4 + 2] = palette[c + 2]; px[i * 4 + 3] = 255
      }
    }
    ctx.putImageData(img, x, y)
  }

  function repaint(filter = () => true) {
    for (const [tileId, entry] of tiles) if (filter(entry)) paint(entry, geometry(tileId))
  }

  return {
    setJob,
    drawTile,
    setMode(next) {
      if (next === mode) return
      mode = next
      repaint()
    },
    /** In 'who' mode, colour tiles whose contributor colour arrived late. */
    refreshColors() {
      if (mode === 'who') repaint(e => !e.colored && colorOf(e.contributorId))
    },
    /** Outline tiles in progress: [[tileId, contributorId], …]. */
    drawLeased(leased) {
      if (!job) return
      octx.clearRect(0, 0, overlay.width, overlay.height)
      const lw = Math.max(2, Math.round(job.width / 512))
      octx.lineWidth = lw
      octx.globalAlpha = 0.85
      for (const [tileId, contributorId] of leased) {
        if (!validTile(tileId) || tiles.has(tileId)) continue
        const { x, y, w, h } = geometry(tileId)
        octx.strokeStyle = colorOf(contributorId) ?? '#888888'
        octx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw)
      }
    },
    get job() { return job },
    get mode() { return mode },
    get doneCount() { return tiles.size },
    has(tileId) { return tiles.has(tileId) },
  }
}
