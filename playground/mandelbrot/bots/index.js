#!/usr/bin/env node
// Crowd Mandelbrot chaos bots. Spawns misbehaving workers against a running
// coordinator, stops when the current image is done, then writes a JSON
// report and a Markdown summary.

import { parseArgs } from 'node:util'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createBot } from './bot.js'
import { createPool } from './pool.js'
import { buildReport, toMarkdown } from './report.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const HELP = `Usage: node index.js [options]

Start the coordinator first (with --check to count wrong tiles), then this.
The bots work on whatever image the coordinator is computing and stop when
it is done.

Options
  --hub-url <url>           PipesHub Socket.io URL      [http://localhost:3000]
  --auth-url <url>          PipesHub auth URL (POST /auth)
                                                        [http://localhost:16916]
  --workers <n>             Number of bots                              [50]
  --slow-rate <0-1>         Share of bots that hold results 2–20 s      [0.1]
  --drop-rate <0-1>         Share that take a lease, then go silent     [0.1]
  --corrupt-rate <0-1>      Share that send wrong data                  [0.05]
  --corrupt-prob <0-1>      Chance a corrupt bot corrupts each result   [1]
  --disconnect-rate <0-1>   Share that drop their socket mid-task       [0.05]
  --threads <n>             Compute threads shared by all bots  [cores - 1]
  --duration <s>            Give up after this long                     [900]
  --check-report <file>     The coordinator's check-<job>.json; waited for
                            and merged into the report
  --check-wait <s>          How long to wait for that file              [600]
  --out <dir>               Where to write report.json and summary.md
                                                   [results/<timestamp>]
  --yes                     Required when a URL is not on localhost
  --help                    Show this help
`

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const { values } = parseArgs({
    options: {
      'hub-url':         { type: 'string', default: 'http://localhost:3000' },
      'auth-url':        { type: 'string', default: 'http://localhost:16916' },
      'workers':         { type: 'string', default: '50' },
      'slow-rate':       { type: 'string', default: '0.1' },
      'drop-rate':       { type: 'string', default: '0.1' },
      'corrupt-rate':    { type: 'string', default: '0.05' },
      'corrupt-prob':    { type: 'string', default: '1' },
      'disconnect-rate': { type: 'string', default: '0.05' },
      'threads':         { type: 'string', default: String(Math.max(1, availableParallelism() - 1)) },
      'duration':        { type: 'string', default: '900' },
      'check-report':    { type: 'string' },
      'check-wait':      { type: 'string', default: '600' },
      'out':             { type: 'string' },
      'yes':             { type: 'boolean', default: false },
      'help':            { type: 'boolean', default: false },
    },
  })
  if (values.help) { process.stdout.write(HELP); return }

  const config = readConfig(values)
  guardTarget(config, values.yes)
  const out = values.out ?? path.join(HERE, 'results', new Date().toISOString().replace(/[:.]/g, '-'))

  const behaviors = assignBehaviors(config)
  log(`${config.workers} bots (${Object.entries(countBy(behaviors)).map(([k, v]) => `${v} ${k}`).join(', ')}) → ` +
      `${config.hubUrl}, ${config.threads} compute threads`)

  const loopDelay = monitorEventLoopDelay({ resolution: 1 })
  loopDelay.enable()
  const pool = createPool(config.threads)

  const startedAt = Date.now()
  let lastStats = null
  let jobId = null
  let jobDoneAt = null
  let firstLeaseAt = null
  const onStats = s => {
    if (!lastStats || s.metrics?.leasesGranted >= (lastStats.metrics?.leasesGranted ?? 0)) lastStats = s
    jobId ??= s.jobId
    if (s.jobId === jobId && !jobDoneAt && (s.done === s.total || Number.isFinite(s.nextJobInMs))) jobDoneAt = Date.now()
    if (s.jobId !== jobId && !jobDoneAt) jobDoneAt = Date.now()       // missed the end, the next job is on
  }

  const bots = behaviors.map((behavior, index) => createBot({
    hubUrl: config.hubUrl, authUrl: config.authUrl, behavior, index, pool,
    corruptProb: config.corruptProb, onStats,
  }))
  await Promise.all(bots.map(async (b, i) => {
    await sleep(i * 50)                   // do not open 50 sockets in the same millisecond
    try { await b.start() } catch (err) { log(`bot ${i} failed to start: ${err?.message ?? err?.code ?? err}`) }
  }))
  firstLeaseAt = Date.now()

  let lastLog = 0
  while (!jobDoneAt && Date.now() - startedAt < config.duration * 1000) {
    await sleep(500)
    if (Date.now() - lastLog > 10_000 && lastStats) {
      lastLog = Date.now()
      const m = lastStats.metrics
      log(`${lastStats.jobId}: ${lastStats.done}/${lastStats.total} done; ${m.activeWorkers} workers, ` +
          `${m.tilesPerSecond} tiles/s; expiries ${m.leaseExpiries}, backups ${m.backupsWon}/${m.backupsIssued}, ` +
          `mismatches ${m.verifyMismatches}, suspects ${m.suspects}, revoked ${m.revokedTiles}`)
    }
  }
  if (jobDoneAt) {
    log(`job ${jobId} done; collecting final STATS`)
    await sleep(2_500)
  } else {
    log(`gave up after ${config.duration} s`)
  }
  for (const b of bots) b.stop()
  await sleep(500)
  await pool.close()
  loopDelay.disable()
  const endedAt = Date.now()

  let check = null
  if (config.checkReport && jobDoneAt) {
    log(`waiting for ${config.checkReport}`)
    check = await waitForJson(config.checkReport, config.checkWait * 1000)
    if (!check) log('check report did not appear')
  }

  const report = buildReport({
    config, startedAt, endedAt, jobId, jobDoneAt, firstLeaseAt, lastStats, check,
    botStats: bots.map(b => b.stats),
    loopDelay: {
      p50: +(loopDelay.percentile(50) / 1e6).toFixed(1),
      p99: +(loopDelay.percentile(99) / 1e6).toFixed(1),
      max: +(loopDelay.max / 1e6).toFixed(1),
    },
  })
  await mkdir(out, { recursive: true })
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(path.join(out, 'summary.md'), toMarkdown(report))
  process.stdout.write('\n' + toMarkdown(report) + '\n')
  log(`wrote ${out}/report.json and summary.md`)
  process.exit(0)
}

function readConfig(v) {
  const num = (name, min, max) => {
    const x = Number(v[name])
    if (!Number.isFinite(x) || x < min || x > max) fail(`--${name} must be a number from ${min} to ${max}`)
    return x
  }
  const config = {
    hubUrl: v['hub-url'], authUrl: v['auth-url'],
    workers: Math.round(num('workers', 1, 5000)),
    slowRate: num('slow-rate', 0, 1), dropRate: num('drop-rate', 0, 1),
    corruptRate: num('corrupt-rate', 0, 1), corruptProb: num('corrupt-prob', 0, 1),
    disconnectRate: num('disconnect-rate', 0, 1),
    threads: Math.round(num('threads', 1, 256)),
    duration: num('duration', 1, 86_400),
    checkReport: v['check-report'] ?? null,
    checkWait: num('check-wait', 0, 86_400),
  }
  if (config.slowRate + config.dropRate + config.corruptRate + config.disconnectRate > 1) {
    fail('the behaviour rates add up to more than 1')
  }
  return config
}

/** Exact counts per behaviour (rounded), the rest honest, in random order. */
export function assignBehaviors({ workers, slowRate, dropRate, corruptRate, disconnectRate }) {
  const list = []
  for (const [name, rate] of [['slow', slowRate], ['drop', dropRate], ['corrupt', corruptRate],
                              ['disconnect', disconnectRate]]) {
    for (let i = 0; i < Math.round(workers * rate); i++) list.push(name)
  }
  while (list.length < workers) list.push('honest')
  list.length = workers
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

function countBy(list) {
  const out = {}
  for (const x of list) out[x] = (out[x] ?? 0) + 1
  return out
}

function guardTarget(config, yes) {
  const remote = [config.hubUrl, config.authUrl].filter(u => {
    try { return !LOCAL_HOSTS.has(new URL(u).hostname) } catch { return true }
  })
  if (!remote.length) return
  process.stderr.write(`\nWARNING: these targets are not on localhost:\n  ${remote.join('\n  ')}\n` +
    'The bots send wrong results and hold leases on purpose.\n')
  if (!yes) {
    process.stderr.write('Re-run with --yes if you own these servers and mean it.\n')
    process.exit(2)
  }
  process.stderr.write('--yes given; continuing.\n\n')
}

async function waitForJson(file, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      await access(file)
      return JSON.parse(await readFile(file, 'utf8'))
    } catch { await sleep(1_000) }
  }
  return null
}

function log(msg) { process.stderr.write(`[bots ${new Date().toISOString().slice(11, 19)}] ${msg}\n`) }
function fail(msg) { process.stderr.write(`${msg}\n`); process.exit(2) }

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()
