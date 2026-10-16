// Builds the chaos report from what the bots saw, the coordinator's last
// STATS and (if given) the coordinator's --check report. Pure: no I/O.

const COORDINATOR_KEYS = [
  'accepted', 'leasesGranted', 'leaseExpiries', 'retries', 'failedTiles', 'released',
  'duplicates', 'rejectedStale', 'rejectedInvalid', 'rejectedTooLarge',
  'backupsIssued', 'backupsWon',
  'verifyChecks', 'verifyMismatches', 'judged', 'suspects', 'revokedTiles', 'coordinatorTiles',
  'rateLimited', 'workersFull', 'viewersDropped',
  'turnaroundP50Ms', 'turnaroundP95Ms', 'fanoutMsP95', 'viewers', 'overflowViewers',
]

function addCounts(into, from) {
  for (const [k, v] of Object.entries(from ?? {})) into[k] = (into[k] ?? 0) + v
}

export function summarizeBots(botStats) {
  const byBehavior = {}
  for (const s of botStats) {
    const b = byBehavior[s.behavior] ??= {
      bots: 0, leases: 0, tasks: 0, submitted: 0, accepted: 0, verifying: 0,
      corruptSent: 0, held: 0, disconnects: 0, rejected: {}, waits: {}, askErrors: {},
      tilesReceived: 0, tileBytesReceived: 0,
    }
    b.bots++
    for (const k of ['leases', 'tasks', 'submitted', 'accepted', 'verifying', 'corruptSent', 'held',
                     'disconnects', 'tilesReceived', 'tileBytesReceived']) b[k] += s[k] ?? 0
    addCounts(b.rejected, s.rejected)
    addCounts(b.waits, s.waits)
    addCounts(b.askErrors, s.askErrors)
  }
  return byBehavior
}

/**
 * input: { config, startedAt, endedAt, jobId, jobDoneAt, firstLeaseAt, lastStats,
 *          botStats, check, loopDelay }
 */
export function buildReport(input) {
  const { config, startedAt, endedAt, jobId, jobDoneAt, lastStats, botStats, check, loopDelay } = input
  const m = lastStats?.metrics ?? {}
  const total = lastStats?.total ?? null
  const completionSeconds = check?.jobSeconds
    ?? (jobDoneAt && input.firstLeaseAt ? (jobDoneAt - input.firstLeaseAt) / 1000 : null)
  const coordinator = Object.fromEntries(COORDINATOR_KEYS.filter(k => k in m).map(k => [k, m[k]]))
  return {
    startedAt: new Date(startedAt).toISOString(),
    runSeconds: round((endedAt - startedAt) / 1000),
    config,
    job: { jobId, name: check?.name ?? null, tiles: total, finished: !!jobDoneAt },
    completionSeconds: round(completionSeconds),
    tilesPerSecond: completionSeconds && total ? round(total / completionSeconds) : null,
    wrongTiles: check ? check.wrongTiles : null,
    missingTiles: check ? check.missingTiles : null,
    wrongTileIds: check?.wrongTileIds ?? null,
    coordinator,
    bots: summarizeBots(botStats),
    botEventLoopDelayMs: loopDelay,
  }
}

function round(x, digits = 2) {
  return x === null || x === undefined ? null : Math.round(x * 10 ** digits) / 10 ** digits
}

const show = v => (v === null || v === undefined ? '–' : String(v))

export function toMarkdown(r) {
  const c = r.coordinator
  const lines = [
    `# Crowd Mandelbrot chaos run`,
    '',
    `${r.startedAt} · ${r.config.workers} bots (slow ${r.config.slowRate}, drop ${r.config.dropRate}, ` +
      `corrupt ${r.config.corruptRate} × ${r.config.corruptProb}, disconnect ${r.config.disconnectRate}) · ` +
      `job ${show(r.job.jobId)}${r.job.name ? ` (${r.job.name})` : ''}, ${show(r.job.tiles)} tiles`,
    '',
    '| | |',
    '|---|---|',
    `| **Wrong tiles in the final image** | **${r.wrongTiles === null ? 'not checked' : r.wrongTiles}** |`,
    `| Missing tiles | ${show(r.missingTiles)} |`,
    `| Job finished | ${r.job.finished ? 'yes' : 'no'} |`,
    `| Job completion time | ${show(r.completionSeconds)} s |`,
    `| Tiles per second | ${show(r.tilesPerSecond)} |`,
    `| Lease expiries | ${show(c.leaseExpiries)} |`,
    `| Retries | ${show(c.retries)} |`,
    `| Duplicates dropped | ${show(c.duplicates)} |`,
    `| Backup tasks issued / won | ${show(c.backupsIssued)} / ${show(c.backupsWon)} |`,
    `| Verification checks / mismatches | ${show(c.verifyChecks)} / ${show(c.verifyMismatches)} |`,
    `| Tiles judged by the coordinator | ${show(c.judged)} |`,
    `| Suspects flagged | ${show(c.suspects)} |`,
    `| Tiles thrown out (suspects) | ${show(c.revokedTiles)} |`,
    `| Invalid / stale results rejected | ${show(c.rejectedInvalid)} / ${show(c.rejectedStale)} |`,
    `| LEASE rate-limited / workers full | ${show(c.rateLimited)} / ${show(c.workersFull)} |`,
    `| Tile turnaround p50 / p95 | ${show(c.turnaroundP50Ms)} / ${show(c.turnaroundP95Ms)} ms |`,
    `| Fan-out p95 | ${show(c.fanoutMsP95)} ms |`,
    `| Bot process event-loop delay p50 / p99 / max | ${show(r.botEventLoopDelayMs?.p50)} / ${show(r.botEventLoopDelayMs?.p99)} / ${show(r.botEventLoopDelayMs?.max)} ms |`,
    '',
    '| Behavior | Bots | Tasks | Submitted | Accepted | Held for verification | Corrupt sent | Held back | Disconnects | Rejected |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(r.bots).map(([name, b]) =>
      `| ${name} | ${b.bots} | ${b.tasks} | ${b.submitted} | ${b.accepted} | ${b.verifying} | ${b.corruptSent} | ` +
      `${b.held} | ${b.disconnects} | ${Object.entries(b.rejected).map(([k, v]) => `${k} ${v}`).join(', ') || '0'} |`),
    '',
  ]
  if (r.wrongTileIds?.length) lines.push(`Wrong tile ids: ${r.wrongTileIds.join(', ')}`, '')
  return lines.join('\n')
}
