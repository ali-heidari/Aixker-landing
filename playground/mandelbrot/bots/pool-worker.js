// One compute thread for the bots. Same code as the browser's Web Worker.
import { parentPort } from 'node:worker_threads'
import { computeTile } from '../src/mandel.js'
import { encodeCounts } from '../src/codec.js'

parentPort.on('message', ({ id, task }) => {
  const t0 = performance.now()
  const counts = computeTile(task)
  parentPort.postMessage({ id, data: encodeCounts(counts), ms: performance.now() - t0 })
})
