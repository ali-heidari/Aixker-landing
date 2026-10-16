// Web Worker: computes one task at a time off the main thread.
//   in:  { task }
//   out: { task, data (base64), ms }  or  { task, error }

import { computeTile } from './mandel.js'
import { encodeCounts } from './codec.js'

self.onmessage = ({ data: { task } }) => {
  try {
    const t0 = performance.now()
    const counts = computeTile(task)
    self.postMessage({ task, data: encodeCounts(counts), ms: performance.now() - t0 })
  } catch (err) {
    self.postMessage({ task, error: String(err?.message ?? err) })
  }
}
