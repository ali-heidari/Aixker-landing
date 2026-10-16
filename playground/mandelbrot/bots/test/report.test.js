import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildReport, summarizeBots, toMarkdown } from '../report.js'
import { assignBehaviors } from '../index.js'

const config = { workers: 4, slowRate: 0.25, dropRate: 0.25, corruptRate: 0, corruptProb: 1, disconnectRate: 0 }

test('behaviours are assigned in exact numbers, the rest honest', () => {
  const list = assignBehaviors({ workers: 50, slowRate: 0.1, dropRate: 0.1, corruptRate: 0.05, disconnectRate: 0.05 })
  const count = name => list.filter(x => x === name).length
  assert.equal(list.length, 50)
  assert.deepEqual([count('slow'), count('drop'), count('corrupt'), count('disconnect'), count('honest')],
                   [5, 5, 3, 3, 34])   // 2.5 rounds up
})

test('bot stats are summed per behaviour', () => {
  const s = summarizeBots([
    { behavior: 'slow', tasks: 2, submitted: 2, accepted: 1, rejected: { ALREADY_DONE: 1 } },
    { behavior: 'slow', tasks: 3, submitted: 3, accepted: 3, rejected: {} },
    { behavior: 'drop', tasks: 1, held: 1 },
  ])
  assert.equal(s.slow.bots, 2)
  assert.equal(s.slow.tasks, 5)
  assert.deepEqual(s.slow.rejected, { ALREADY_DONE: 1 })
  assert.equal(s.drop.held, 1)
})

test('the report takes wrong tiles and timing from the check report', () => {
  const r = buildReport({
    config, startedAt: 0, endedAt: 60_000, jobId: 'j7', jobDoneAt: 50_000, firstLeaseAt: 5_000,
    lastStats: { total: 1024, metrics: { leaseExpiries: 9, suspects: 2, notAKey: 1 } },
    botStats: [], check: { name: 'Seahorse', wrongTiles: 0, missingTiles: 0, wrongTileIds: [], jobSeconds: 40 },
    loopDelay: { p50: 1, p99: 2, max: 3 },
  })
  assert.equal(r.wrongTiles, 0)
  assert.equal(r.completionSeconds, 40)
  assert.equal(r.tilesPerSecond, 25.6)
  assert.deepEqual(r.coordinator, { leaseExpiries: 9, suspects: 2 })
  assert.match(toMarkdown(r), /\*\*Wrong tiles in the final image\*\* \| \*\*0\*\*/)
})

test('without a check report the wrong-tile count says so instead of claiming 0', () => {
  const r = buildReport({
    config, startedAt: 0, endedAt: 1, jobId: 'j1', jobDoneAt: null, lastStats: null,
    botStats: [], check: null, loopDelay: {},
  })
  assert.equal(r.wrongTiles, null)
  assert.match(toMarkdown(r), /not checked/)
})
