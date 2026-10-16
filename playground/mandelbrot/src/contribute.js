// The worker loop: lease tiles, compute them in Web Workers, submit results.
// Pull, not push: the loop asks only when it is running low, so a slow
// machine simply asks less often. It keeps a few spare tasks, so a worker
// never waits for a LEASE round trip, and asks again only when the spares are
// gone, for several at once, to stay under the coordinator's LEASE rate.
// Spares do not hurt the lease: its length follows the median tile time,
// which includes the wait in this backlog.

const LEASE_TIMEOUT_MS  = 8_000
const SUBMIT_TIMEOUT_MS = 10_000
const RETRY_MS          = 1_000
const MAX_PER_LEASE     = 4       // the coordinator's cap

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
 *                 'forgotten' {}  the coordinator does not know this unit as
 *                                 a worker (e.g. it restarted): HELLO again
 *                 'lease'     { tasks, reason }  every LEASE reply
 *                                 (reason WORKERS_FULL: the coordinator has
 *                                 enough workers; RATE_LIMIT: asked too often)
 */
export function createContributor({ pipe, coordinator, threads = 1, makeWorker, onEvent = () => {} }) {
  let pool    = []
  let backlog = []      // leased tasks waiting for a free Web Worker
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
    feed()
    signal()
  }

  async function loop(my) {
    while (running && my === gen) {
      if (paused || !pipe.isReady()) { await nap(500); continue }
      // in flight: at least 4, or two per Web Worker
      const busy = pool.filter(p => p.busy).length
      const want = Math.max(MAX_PER_LEASE, 2 * pool.length) - busy - backlog.length
      if (want <= 0 || backlog.length) { await nap(null); continue }

      let reply
      try {
        reply = await pipe.ask(coordinator, 'LEASE', { capacity: Math.min(want, MAX_PER_LEASE) },
                               { timeoutMs: LEASE_TIMEOUT_MS })
      } catch (err) {
        onEvent('error', { stage: 'lease', error: err })
        await nap(RETRY_MS)
        continue
      }
      if (!running || my !== gen) break
      const tasks = Array.isArray(reply?.tasks) ? reply.tasks : []
      if (reply?.reason === 'HELLO_FIRST') onEvent('forgotten', {})
      onEvent('lease', { tasks: tasks.length, reason: reply?.reason })
      if (!tasks.length) { await nap(reply?.wait ?? RETRY_MS); continue }
      backlog.push(...tasks)
      feed()
    }
  }

  /** Start backlog tasks on free Web Workers. */
  function feed() {
    for (const slot of pool) {
      if (!backlog.length) break
      if (!slot.busy) runTask(slot, backlog.shift())
    }
  }

  function runTask(slot, task) {
    slot.busy = true
    slot.worker.onmessage = ({ data }) => {
      slot.busy = false
      feed()
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
      onEvent('submitted', { task, accepted: !!res?.accepted, verifying: !!res?.verifying,
                             reason: res?.reason, ms: performance.now() - t0 })
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
      backlog = []          // HELLO as viewer gives these leases back
      signal()
    },
    setThreads(n) { threads = n; if (running) setThreads(n) },
    setPaused(value) { paused = value; signal() },   // the backlog still drains
    get running() { return running },
    get busy() { return pool.filter(p => p.busy).length },
  }
}
