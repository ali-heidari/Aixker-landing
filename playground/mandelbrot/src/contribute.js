// The worker loop: lease tiles, compute them in Web Workers, submit results.
// Pull, not push: the loop asks only when a Web Worker is idle, so a slow
// machine simply asks less often.

const LEASE_TIMEOUT_MS  = 8_000
const SUBMIT_TIMEOUT_MS = 10_000
const RETRY_MS          = 1_000

/**
 * options:
 *   pipe          a connected createPipe() client
 *   coordinator   coordinator unit name
 *   threads       number of Web Workers
 *   makeWorker    () => Worker   (a module worker running compute-worker.js)
 *   onEvent       (type, detail) => void
 *                 'computed'  { task, ms }
 *                 'submitted' { task, accepted, reason, ms }
 *                 'error'     { stage, error }
 */
export function createContributor({ pipe, coordinator, threads = 1, makeWorker, onEvent = () => {} }) {
  let pool    = []
  let running = false
  let paused  = false
  let wake    = null
  let gen     = 0       // a stop() then start() must not leave two loops running

  function signal() {
    const w = wake
    wake = null
    w?.()
  }

  function nap(ms) {
    return new Promise(resolve => {
      const timer = ms == null ? null : setTimeout(() => { wake = null; resolve() }, ms)
      wake = () => { clearTimeout(timer); resolve() }
    })
  }

  function setThreads(n) {
    while (pool.length < n) pool.push({ worker: makeWorker(), busy: false })
    while (pool.length > n) {
      const i = pool.findIndex(p => !p.busy)
      const [gone] = pool.splice(i >= 0 ? i : pool.length - 1, 1)
      gone.worker.terminate()   // a busy one loses its task; the lease runs out
    }
    signal()
  }

  async function loop(my) {
    while (running && my === gen) {
      const idle = pool.filter(p => !p.busy)
      if (paused || !pipe.isReady()) { await nap(500); continue }
      if (!idle.length)              { await nap(null); continue }

      let reply
      try {
        reply = await pipe.ask(coordinator, 'LEASE', { capacity: Math.min(idle.length, 4) },
                               { timeoutMs: LEASE_TIMEOUT_MS })
      } catch (err) {
        onEvent('error', { stage: 'lease', error: err })
        await nap(RETRY_MS)
        continue
      }
      if (!running || my !== gen) break
      const tasks = Array.isArray(reply?.tasks) ? reply.tasks : []
      if (!tasks.length) { await nap(reply?.wait ?? RETRY_MS); continue }
      const free = pool.filter(p => !p.busy)   // the pool may have shrunk meanwhile
      tasks.slice(0, free.length).forEach((task, i) => runTask(free[i], task))
    }
  }

  function runTask(slot, task) {
    slot.busy = true
    slot.worker.onmessage = ({ data }) => {
      slot.busy = false
      signal()
      if (data.error) { onEvent('error', { stage: 'compute', error: data.error }); return }
      onEvent('computed', { task, ms: data.ms })
      submit(task, data.data)
    }
    slot.worker.postMessage({ task })
  }

  async function submit(task, data) {
    const t0 = performance.now()
    try {
      const res = await pipe.ask(coordinator, 'SUBMIT',
        { jobId: task.jobId, tileId: task.tileId, leaseId: task.leaseId, data },
        { timeoutMs: SUBMIT_TIMEOUT_MS })
      onEvent('submitted', { task, accepted: !!res?.accepted, reason: res?.reason, ms: performance.now() - t0 })
    } catch (err) {
      onEvent('error', { stage: 'submit', error: err })
    }
  }

  return {
    start() {
      if (running) return
      running = true
      setThreads(threads)
      loop(++gen)
    },
    stop() {
      running = false
      for (const p of pool) p.worker.terminate()
      pool = []
      signal()
    },
    setThreads(n) { threads = n; if (running) setThreads(n) },
    setPaused(value) { paused = value; signal() },
    get running() { return running },
    get busy() { return pool.filter(p => p.busy).length },
  }
}
