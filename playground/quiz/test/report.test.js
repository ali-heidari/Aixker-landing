import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildReport, toMarkdown } from '../loadgen/report.js'

const bot = (over = {}) => ({
  nickname: 'b', unitName: 'u', hubUrl: 'http://a', connectMs: 5, joinMs: 9, joinOk: true, joinError: null,
  received: { LOBBY: 1, QUESTION: 10, REVEAL: 10, LEADERBOARD: 10, END: 1, PING: 0 },
  sent: { question: 10, reveal: 10, leaderboard: 10 },
  answersSent: 10, ackMs: [3, 4], accepted: 10, late: 0, rejected: 0, ackTimeouts: 0, ackOffline: 0,
  disconnects: 0, rejoinsOk: 0, rejoinsFailed: 0, finalRank: 1, finalTotal: 100,
  ...over,
})

const run = bots => buildReport({
  config: { players: bots.length, pin: '123456', rampSeconds: 0, answerDelayMs: [0, 1], correctRate: 1, hubUrls: ['http://a'] },
  startedAt: new Date(0), finishedAt: new Date(1000), bots,
  loadgenLoopDelayMs: { p50: 1, p99: 2, max: 3 },
})

test('lost = host sent (from END) − received, per bot that got END', () => {
  const r = run([
    bot(),
    bot({ hubUrl: 'http://b', received: { ...bot().received, QUESTION: 7, REVEAL: 9 } }),
  ])
  assert.deepEqual(r.messages.sent, { question: 20, reveal: 20 })
  assert.deepEqual(r.messages.received, { question: 17, reveal: 19 })
  assert.deepEqual(r.messages.lost, { question: 3, reveal: 1, total: 4 })
  assert.equal(r.messages.lostPercent, 10)
  assert.equal(r.messages.botsWithLoss, 1)
  assert.equal(r.byHub['http://b'].lostQR, 4)
  assert.equal(r.byHub['http://a'].lostQR, 0)
})

test('bots without END are reported separately, not guessed', () => {
  const r = run([bot(), bot({ sent: null, received: { ...bot().received, QUESTION: 4, REVEAL: 3, END: 0 } })])
  assert.equal(r.messages.botsWithoutEnd, 1)
  assert.deepEqual(r.messages.lost, { question: 0, reveal: 0, total: 0 })
  assert.deepEqual(r.messages.receivedByBotsWithoutEnd, { question: 4, reveal: 3 })
  assert.match(toMarkdown(r), /never got END: 1/)
})

test('failed joins are counted by reason', () => {
  const r = run([bot(), bot({ joinOk: false, joinError: 'TIMEOUT', sent: null }), bot({ joinOk: false, joinError: 'TIMEOUT', sent: null })])
  assert.equal(r.joins.failed, 2)
  assert.deepEqual(r.joins.failReasons, { TIMEOUT: 2 })
  assert.equal(r.joins.joinMs.n, 1)
})
