// Small measurement helpers shared by the host metrics panel and the load
// generator. Pure apart from the state each helper owns.

/** Nearest-rank percentile (p in 0–100) of a list of numbers, or null if empty. */
export function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

/** Keeps the last `limit` samples. */
export function createSamples(limit = 2000) {
  let values = []
  let total  = 0
  return {
    add(v) {
      if (!Number.isFinite(v)) return
      values.push(v)
      total++
      if (values.length > limit) values = values.slice(-limit)
    },
    p(pct)  { return percentile(values, pct) },
    get size()  { return values.length },
    get total() { return total },
    values() { return [...values] },
  }
}

/** Events per second over a sliding window, kept in 100 ms buckets. */
export function createRate(windowMs = 1000, bucketMs = 100) {
  const n = Math.ceil(windowMs / bucketMs)
  const buckets = new Array(n).fill(0)
  let lastSlot = null

  function advance(now) {
    const slot = Math.floor(now / bucketMs)
    if (lastSlot === null) lastSlot = slot
    const steps = Math.min(slot - lastSlot, n)
    for (let i = 1; i <= steps; i++) buckets[(lastSlot + i) % n] = 0
    if (slot > lastSlot) lastSlot = slot
    return slot
  }

  return {
    hit(now, count = 1) {
      buckets[advance(now) % n] += count
    },
    perSecond(now) {
      advance(now)
      return buckets.reduce((a, b) => a + b, 0) * (1000 / windowMs)
    },
  }
}
