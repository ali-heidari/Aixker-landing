// One chaos bot. Speaks the same protocol as src/app.js and src/contribute.js
// through the same client (src/pipes.js), and misbehaves on purpose:
//
//   honest      lease, compute, submit
//   slow        holds every result for a random 2–20 s before submitting,
//               often past its lease
//   drop        works for 2–10 s, then takes a lease and goes silent for
//               good (socket stays open, nothing more is sent)
//   corrupt     computes, then changes a few pixels to wrong but in-range
//               values, so the result passes validation (each result with
//               probability corruptProb)
//   disconnect  works, and after 2–8 s and then every 5–12 s drops its
//               socket while holding a lease, waits 1–5 s, reconnects as the
//               same unit and goes on

import { io } from 'socket.io-client'
import { createPipe, fetchToken, randomId } from '../src/pipes.js'
import { decodeCounts, encodeCounts } from '../src/codec.js'

const COORDINATOR = 'mandel-coordinator'
const ASK_TIMEOUT_MS = 10_000
const KEEPALIVE_MS = 30_000

const sleep = ms => new Promise(r => setTimeout(r, ms))
const between = (a, b) => a + Math.random() * (b - a)

/**
 * opts: { hubUrl, authUrl, behavior, index, pool, corruptProb, onStats }
 *   onStats(stats)  every STATS the coordinator sends this bot
 */
export function createBot({ hubUrl, authUrl, behavior, index, pool, corruptProb = 1, onStats = () => {} }) {
  const unitName = `mandel-v-${randomId(12)}`
  const nickname = `bot-${behavior}-${index}`
  const stats = {
    unitName, behavior, nickname,
    leases: 0, tasks: 0, submitted: 0, accepted: 0, verifying: 0,
    rejected: {},               // reason → count
    waits: {},                  // LEASE reason → count (RATE_LIMIT, WORKERS_FULL, …)
    corruptSent: 0,
    held: 0,                    // tasks never submitted (drop bots)
    disconnects: 0,
    askErrors: {},              // TIMEOUT, OFFLINE, CLOSED
    tilesReceived: 0, tileBytesReceived: 0,
  }
  let pipe = null
  let running = false
  let silent = false
  let jobId = null
  let have = 0
  let keepalive = null

  function count(map, key) { map[key] = (map[key] ?? 0) + 1 }

  function onMessage({ operation, input, senderId }) {
    if (senderId !== COORDINATOR || silent) return
    if (operation === 'TILE_DONE') {
      if (input.jobId === jobId) have += input.tiles?.length ?? 0
      stats.tilesReceived += input.tiles?.length ?? 0
      for (const t of input.tiles ?? []) stats.tileBytesReceived += t.data?.length ?? 0
    } else if (operation === 'JOB') {
      jobId = input.jobId
      have = 0
    } else if (operation === 'STATS') {
      onStats(input)
    }
  }

  async function connect() {
    pipe = createPipe({
      hubUrl, unitName, io, onMessage,
      getToken: () => fetchToken(authUrl, unitName),
      socketOptions: { reconnection: behavior !== 'disconnect' },
    })
    await pipe.connect()
    const res = await pipe.ask(COORDINATOR, 'HELLO', { nickname, role: 'worker' }, { timeoutMs: ASK_TIMEOUT_MS })
    if (!res?.ok) throw new Error(`HELLO refused: ${res?.reason}`)
    if (res.job?.jobId !== jobId) { jobId = res.job.jobId; have = 0 }
    have = Math.max(have, res.doneTiles?.length ?? 0)
  }

  async function ask(operation, input) {
    try {
      return await pipe.ask(COORDINATOR, operation, input, { timeoutMs: ASK_TIMEOUT_MS })
    } catch (err) {
      count(stats.askErrors, err?.code ?? 'ERROR')
      return null
    }
  }

  function corrupt(data, maxIter) {
    const counts = decodeCounts(data)
    const n = 1 + Math.floor(Math.random() * 8)
    for (let k = 0; k < n; k++) {
      const i = Math.floor(Math.random() * counts.length)
      counts[i] = (counts[i] + 1 + Math.floor(Math.random() * 5)) % (maxIter + 1)
    }
    return encodeCounts(counts)
  }

  async function run(task) {
    const { data } = await pool.compute(task)
    let out = data
    if (behavior === 'corrupt' && Math.random() < corruptProb) {
      out = corrupt(data, task.maxIter)
      stats.corruptSent++
    }
    if (behavior === 'slow') await sleep(between(2_000, 20_000))
    if (!running || silent) return
    stats.submitted++
    const res = await ask('SUBMIT', { jobId: task.jobId, tileId: task.tileId, leaseId: task.leaseId, data: out })
    if (res?.accepted && res.verifying) stats.verifying++
    else if (res?.accepted) stats.accepted++
    else if (res) count(stats.rejected, res.reason ?? 'UNKNOWN')
  }

  async function reconnect() {
    stats.disconnects++
    pipe.close()
    await sleep(between(1_000, 5_000))
    while (running) {
      try { await connect(); return } catch { await sleep(2_000) }
    }
  }

  async function loop() {
    const startedAt = Date.now()
    const goSilentAt = startedAt + between(2_000, 10_000)
    let nextDrop = startedAt + between(2_000, 8_000)

    while (running) {
      if (!pipe.isReady()) { await sleep(500); continue }
      const res = await ask('LEASE', { capacity: 1 })
      if (!running) break
      if (!res) { await sleep(1_000); continue }
      const tasks = Array.isArray(res.tasks) ? res.tasks : []
      if (res.reason) count(stats.waits, res.reason)
      if (res.reason === 'HELLO_FIRST') { try { await connect() } catch { /* retry next round */ } continue }
      if (!tasks.length) { await sleep(res.wait ?? 1_000); continue }
      stats.leases++
      stats.tasks += tasks.length

      if (behavior === 'drop' && Date.now() >= goSilentAt) {
        silent = true                      // keep the lease, never speak again
        stats.held += tasks.length
        clearInterval(keepalive)
        return
      }
      if (behavior === 'disconnect' && Date.now() >= nextDrop) {
        // drop the socket while the tile is out; the lease must expire
        stats.held += tasks.length
        await reconnect()
        nextDrop = Date.now() + between(5_000, 12_000)
        continue
      }
      for (const task of tasks) await run(task)
    }
  }

  return {
    stats,
    async start() {
      running = true
      await connect()
      keepalive = setInterval(() => {
        if (!silent && pipe?.isReady()) {
          pipe.ask(COORDINATOR, 'HELLO', { nickname, role: 'worker', jobId, have }, { timeoutMs: ASK_TIMEOUT_MS })
            .catch(() => {})
        }
      }, KEEPALIVE_MS)
      loop().catch(err => count(stats.askErrors, `LOOP:${err?.message ?? err}`))
    },
    stop() {
      running = false
      clearInterval(keepalive)
      if (!silent && pipe?.isReady()) pipe.request(COORDINATOR, 'BYE')
      setTimeout(() => pipe?.close(), 200)
    },
  }
}
