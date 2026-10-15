// Draws the job on a <canvas>, one tile at a time. Escape counts arrive from
// the coordinator; colour is decided here only.

const INSIDE = [0, 0, 0]

/**
 * A cyclic palette: the colour repeats every `period` iterations, so deep
 * zooms (where every count is in the thousands) still show bands.
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

export function createTileCanvas(canvas) {
  const ctx = canvas.getContext('2d')
  let job = null
  let palette = null
  const tiles = new Map()   // tileId → { counts, contributorId }

  function setJob(next) {
    job = next
    palette = buildPalette(job.maxIter)
    tiles.clear()
    canvas.width  = job.width
    canvas.height = job.height
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  function geometry(tileId) {
    const col = tileId % job.cols
    const row = Math.floor(tileId / job.cols)
    const x = col * job.tileSize
    const y = row * job.tileSize
    return { x, y, w: Math.min(job.tileSize, job.width - x), h: Math.min(job.tileSize, job.height - y) }
  }

  /** Returns false (and draws nothing) if the counts do not fit the tile. */
  function drawTile(tileId, counts, contributorId) {
    if (!job || !Number.isInteger(tileId) || tileId < 0 || tileId >= job.cols * job.rows) return false
    const { x, y, w, h } = geometry(tileId)
    if (counts.length !== w * h) return false
    tiles.set(tileId, { counts, contributorId })
    paint(tileId, x, y, w, h, counts)
    return true
  }

  function paint(tileId, x, y, w, h, counts) {
    const img = ctx.createImageData(w, h)
    const px  = img.data
    const max = job.maxIter
    for (let i = 0; i < counts.length; i++) {
      const c = Math.min(counts[i], max) * 3
      px[i * 4]     = palette[c]
      px[i * 4 + 1] = palette[c + 1]
      px[i * 4 + 2] = palette[c + 2]
      px[i * 4 + 3] = 255
    }
    ctx.putImageData(img, x, y)
  }

  return {
    setJob,
    drawTile,
    get job() { return job },
    get doneCount() { return tiles.size },
    has(tileId) { return tiles.has(tileId) },
  }
}
