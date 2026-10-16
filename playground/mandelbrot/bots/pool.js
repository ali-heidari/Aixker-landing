// A small worker_threads pool, so 50 bots in one process can use every core.

import { Worker } from 'node:worker_threads'

export function createPool(size) {
  const workers = []
  const idle = []
  const queue = []
  const pending = new Map()
  let nextId = 0

  for (let i = 0; i < size; i++) {
    const w = new Worker(new URL('./pool-worker.js', import.meta.url))
    w.on('message', ({ id, data, ms }) => {
      const p = pending.get(id)
      pending.delete(id)
      p.resolve({ data, ms })
      idle.push(w)
      pump()
    })
    w.on('error', err => { for (const p of pending.values()) p.reject(err) })
    workers.push(w)
    idle.push(w)
  }

  function pump() {
    while (idle.length && queue.length) {
      const { id, task } = queue.shift()
      idle.pop().postMessage({ id, task })
    }
  }

  return {
    /** Resolves to { data: base64 counts, ms }. */
    compute(task) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        queue.push({ id, task })
        pump()
      })
    },
    get queued() { return queue.length },
    close() { return Promise.all(workers.map(w => w.terminate())) },
  }
}
