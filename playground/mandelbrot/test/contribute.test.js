import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createContributor } from '../src/contribute.js'

// A coordinator with `tiles` tasks to hand out, and Web Workers that answer
// on the next tick.
function setup({ tiles = 20, threads = 2, reply } = {}) {
  let next = 0
  const leases = []
  const submits = []
  const pipe = {
    isReady: () => true,
    async ask(_to, op, input) {
      if (op === 'LEASE') {
        leases.push(input.capacity)
        if (reply) return reply(input)
        const tasks = []
        while (tasks.length < input.capacity && next < tiles) tasks.push({ jobId: 'j1', tileId: next++, leaseId: `L${next}` })
        return tasks.length ? { tasks } : { tasks: [], wait: 5 }
      }
      submits.push(input.tileId)
      return { accepted: true }
    },
  }
  const makeWorker = () => {
    const w = { onmessage: null, terminate() {}, postMessage({ task }) { setTimeout(() => w.onmessage?.({ data: { data: 'AAAA', ms: 1 } }), 1) } }
    return w
  }
  const c = createContributor({ pipe, coordinator: 'coord', threads, makeWorker })
  return { c, leases, submits }
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 2)) }
}

test('every leased tile is computed and submitted once', async () => {
  const { c, submits } = setup({ tiles: 20, threads: 2 })
  c.start()
  await until(() => submits.length === 20)
  c.stop()
  assert.deepEqual([...submits].sort((a, b) => a - b), [...Array(20).keys()])
})

test('it keeps a spare task per thread and never asks for more than 4', async () => {
  const { c, leases } = setup({ tiles: 40, threads: 3 })
  c.start()
  await until(() => leases.length >= 10)
  c.stop()
  assert.equal(leases[0], 4)                                // 3 threads × 2 = 6 wanted, capped at 4
  assert.ok(leases.every(n => n >= 1 && n <= 4))
})

test('fewer LEASE calls than tiles: leases are batched', async () => {
  const { c, leases, submits } = setup({ tiles: 40, threads: 2 })
  c.start()
  await until(() => submits.length === 40)
  c.stop()
  assert.ok(leases.length < 40 * 0.75, `${leases.length} LEASE calls for 40 tiles`)
})

test('a wait reply is honoured', async () => {
  let calls = 0
  const { c } = setup({ reply: () => { calls++; return { tasks: [], wait: 50 } } })
  c.start()
  await new Promise(r => setTimeout(r, 120))
  c.stop()
  assert.ok(calls >= 2 && calls <= 4, `${calls} calls in 120 ms with wait 50`)
})
