import { test } from 'node:test'
import assert from 'node:assert/strict'

import { configureFanout, fanout } from '../src/fanout.js'
import { percentile, createSamples, createRate } from '../src/metrics.js'

test('fanout sends one message per unit in batches, yielding between them', async () => {
  const log = []
  let ticks = 0
  const timer = setInterval(() => ticks++, 0)
  configureFanout({ batchSize: 3, send: (u, op, input) => { log.push({ u, op, input, ticks }); return true } })

  const units = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const r = await fanout(units, 'QUESTION', u => ({ to: u }))
  clearInterval(timer)

  assert.deepEqual(log.map(x => x.u), units)
  assert.equal(log[0].op, 'QUESTION')
  assert.deepEqual(log[4].input, { to: 'e' })
  assert.equal(r.sent, 7)
  assert.equal(r.batches, 3)
  assert.ok(r.durationMs >= 0)
  // The event loop ran between batch 1 and batch 2.
  assert.ok(log[3].ticks > log[2].ticks || log[6].ticks > log[0].ticks)
})

test('fanout skips null inputs and counts failed sends', async () => {
  let done
  configureFanout({ send: u => u !== 'down', onDone: r => { done = r } })
  const r = await fanout(['a', 'skip', 'down', 'b'], 'REVEAL', u => (u === 'skip' ? null : {}))
  assert.deepEqual({ sent: r.sent, failed: r.failed, skipped: r.skipped }, { sent: 2, failed: 1, skipped: 1 })
  assert.equal(done, r)
})

test('fanout of nobody is a no-op', async () => {
  configureFanout({ send: () => { throw new Error('should not send') } })
  const r = await fanout([], 'LOBBY', () => ({}))
  assert.equal(r.sent, 0)
  assert.equal(r.batches, 0)
})

test('percentile uses nearest rank', () => {
  const v = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10]
  assert.equal(percentile(v, 50), 5)
  assert.equal(percentile(v, 95), 10)
  assert.equal(percentile(v, 0), 1)
  assert.equal(percentile([], 50), null)
})

test('createSamples keeps the last N values', () => {
  const s = createSamples(3)
  for (const v of [100, 1, 2, 3, NaN]) s.add(v)
  assert.deepEqual(s.values(), [1, 2, 3])
  assert.equal(s.total, 4)
  assert.equal(s.p(50), 2)
})

test('createRate counts events in the last second', () => {
  const r = createRate(1000, 100)
  r.hit(0, 5)
  r.hit(450, 5)
  assert.equal(r.perSecond(900), 10)
  assert.equal(r.perSecond(1_050), 5)
  assert.equal(r.perSecond(5_000), 0)
})
