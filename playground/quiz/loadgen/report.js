// Turns per-bot stats into the run report. Numbers are reported as measured:
// no smoothing, no dropping of outliers, no estimating of missing data.

import { percentile } from '../src/metrics.js'

const pcts = values => ({
  n:   values.length,
  p50: round(percentile(values, 50)),
  p95: round(percentile(values, 95)),
  p99: round(percentile(values, 99)),
  max: round(values.length ? Math.max(...values) : null),
})

const round = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10)

export function buildReport({ config, startedAt, finishedAt, bots, loadgenLoopDelayMs }) {
  const joined   = bots.filter(b => b.joinOk)
  const withEnd  = joined.filter(b => b.sent)
  const noEnd    = joined.filter(b => !b.sent)

  const failReasons = {}
  for (const b of bots) if (b.joinError) failReasons[b.joinError] = (failReasons[b.joinError] ?? 0) + 1

  // Lost messages: what the host says it sent each bot (in END) minus what
  // that bot received. Only bots that got END have a sent count.
  const sum = (list, f) => list.reduce((a, b) => a + f(b), 0)
  const sent     = { question: sum(withEnd, b => b.sent.question), reveal: sum(withEnd, b => b.sent.reveal) }
  const received = { question: sum(withEnd, b => b.received.QUESTION), reveal: sum(withEnd, b => b.received.REVEAL) }
  const lost     = { question: sent.question - received.question, reveal: sent.reveal - received.reveal }
  lost.total = lost.question + lost.reveal
  const botsWithLoss = withEnd.filter(b => b.sent.question > b.received.QUESTION || b.sent.reveal > b.received.REVEAL).length

  const ack = joined.flatMap(b => b.ackMs)

  return {
    tool:        'quiz-rush-loadgen',
    startedAt:   startedAt.toISOString(),
    finishedAt:  finishedAt.toISOString(),
    durationSec: round((finishedAt - startedAt) / 1000),
    config,
    joins: {
      attempted: bots.length,
      ok:        joined.length,
      failed:    bots.length - joined.length,
      failReasons,
      connectMs: pcts(joined.map(b => b.connectMs)),
      joinMs:    pcts(joined.map(b => b.joinMs)),
    },
    answers: {
      sent:     sum(joined, b => b.answersSent),
      acked:    ack.length,
      accepted: sum(joined, b => b.accepted),
      late:     sum(joined, b => b.late),
      rejected: sum(joined, b => b.rejected),
      timeouts: sum(joined, b => b.ackTimeouts),
      notSent:  sum(joined, b => b.ackOffline),
      ackMs:    pcts(ack),
    },
    messages: {
      botsWithEnd:    withEnd.length,
      botsWithoutEnd: noEnd.length,
      sent,
      received,
      lost,
      lostPercent:    sent.question + sent.reveal ? round((100 * lost.total) / (sent.question + sent.reveal)) : null,
      botsWithLoss,
      // Bots without END cannot be compared with a sent count; their raw
      // receive counts are listed so nothing disappears from the report.
      receivedByBotsWithoutEnd: {
        question: sum(noEnd, b => b.received.QUESTION),
        reveal:   sum(noEnd, b => b.received.REVEAL),
      },
      otherReceived: {
        lobby:       sum(joined, b => b.received.LOBBY),
        leaderboard: sum(joined, b => b.received.LEADERBOARD),
        ping:        sum(joined, b => b.received.PING),
      },
    },
    connection: {
      disconnects:   sum(bots, b => b.disconnects),
      rejoinsOk:     sum(bots, b => b.rejoinsOk),
      rejoinsFailed: sum(bots, b => b.rejoinsFailed),
    },
    byHub: byHub(bots),
    loadgenLoopDelayMs: {
      p50: round(loadgenLoopDelayMs.p50),
      p99: round(loadgenLoopDelayMs.p99),
      max: round(loadgenLoopDelayMs.max),
    },
    bots: bots.map(b => ({
      nickname: b.nickname, unitName: b.unitName, hubUrl: b.hubUrl,
      joinOk: b.joinOk, joinError: b.joinError, joinMs: round(b.joinMs),
      received: b.received, sent: b.sent,
      answersSent: b.answersSent, accepted: b.accepted, ackTimeouts: b.ackTimeouts,
      disconnects: b.disconnects, rejoinsOk: b.rejoinsOk,
      finalRank: b.finalRank, finalTotal: b.finalTotal,
    })),
  }
}

/** Per hub URL, so a multi-node run shows where the losses are. */
function byHub(bots) {
  const groups = {}
  for (const b of bots) {
    const g = groups[b.hubUrl] ??= { bots: 0, joined: 0, withEnd: 0, sentQR: 0, receivedQR: 0 }
    g.bots++
    if (b.joinOk) g.joined++
    if (b.sent) {
      g.withEnd++
      g.sentQR     += b.sent.question + b.sent.reveal
      g.receivedQR += b.received.QUESTION + b.received.REVEAL
    }
  }
  for (const g of Object.values(groups)) g.lostQR = g.sentQR - g.receivedQR
  return groups
}

export function toMarkdown(r) {
  const ms = p => (p.n ? `${p.p50} / ${p.p95} / ${p.p99} (max ${p.max}, n=${p.n})` : 'no samples')
  const m = r.messages
  const lines = [
    `# Quiz Rush load test — ${r.startedAt}`,
    '',
    `${r.config.players} bots, PIN ${r.config.pin}, ramp ${r.config.rampSeconds} s, ` +
      `answer delay ${r.config.answerDelayMs.join('–')} ms, correct rate ${r.config.correctRate}. ` +
      `Hub: ${r.config.hubUrls.join(', ')}. Run took ${r.durationSec} s.`,
    '',
    '## Joins',
    '',
    '| | |',
    '|---|---|',
    `| Joined | ${r.joins.ok} / ${r.joins.attempted} |`,
    `| Failed joins | ${r.joins.failed}${Object.keys(r.joins.failReasons).length ? ` (${Object.entries(r.joins.failReasons).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''} |`,
    `| Connect ms p50 / p95 / p99 | ${ms(r.joins.connectMs)} |`,
    `| Join ms (connect + JOIN reply) p50 / p95 / p99 | ${ms(r.joins.joinMs)} |`,
    '',
    '## Answers',
    '',
    '| | |',
    '|---|---|',
    `| Sent | ${r.answers.sent} |`,
    `| Acked (accepted / late / rejected) | ${r.answers.acked} (${r.answers.accepted} / ${r.answers.late} / ${r.answers.rejected}) |`,
    `| Ack timeouts | ${r.answers.timeouts} |`,
    `| Not sent (offline) | ${r.answers.notSent} |`,
    `| ANSWER ack ms p50 / p95 / p99 | ${ms(r.answers.ackMs)} |`,
    '',
    '## Lost messages (QUESTION + REVEAL)',
    '',
    '| | QUESTION | REVEAL |',
    '|---|---|---|',
    `| Host sent (from END) | ${m.sent.question} | ${m.sent.reveal} |`,
    `| Bots received | ${m.received.question} | ${m.received.reveal} |`,
    `| **Lost** | **${m.lost.question}** | **${m.lost.reveal}** |`,
    '',
    `Lost ${m.lost.total} of ${m.sent.question + m.sent.reveal} (${m.lostPercent ?? '–'} %). ` +
      `${m.botsWithLoss} of ${m.botsWithEnd} bots lost at least one.`,
    `Bots that never got END: ${m.botsWithoutEnd} (they received ${m.receivedByBotsWithoutEnd.question} QUESTION and ` +
      `${m.receivedByBotsWithoutEnd.reveal} REVEAL; with no sent count, their loss is not in the numbers above).`,
    '',
    '## Connections',
    '',
    `Disconnects ${r.connection.disconnects}, rejoins OK ${r.connection.rejoinsOk}, rejoins failed ${r.connection.rejoinsFailed}.`,
    '',
  ]
  const hubs = Object.entries(r.byHub)
  if (hubs.length > 1) {
    lines.push('## By hub URL', '', '| Hub | Bots | Joined | Got END | Sent Q+R | Received Q+R | Lost |', '|---|---|---|---|---|---|---|')
    for (const [url, g] of hubs) lines.push(`| ${url} | ${g.bots} | ${g.joined} | ${g.withEnd} | ${g.sentQR} | ${g.receivedQR} | ${g.lostQR} |`)
    lines.push('')
  }
  lines.push(
    '## Load generator health',
    '',
    `Event-loop delay p50 ${r.loadgenLoopDelayMs.p50} ms, p99 ${r.loadgenLoopDelayMs.p99} ms, max ${r.loadgenLoopDelayMs.max} ms. ` +
      'Sampled every 1 ms, so about 1 ms means idle. High values mean the bots themselves were overloaded and the latencies above are inflated.',
    '',
  )
  return lines.join('\n')
}
