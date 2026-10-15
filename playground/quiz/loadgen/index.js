#!/usr/bin/env node
// Quiz Rush load generator. Spawns bot players against a game that a real
// host page is running, then writes a JSON report and a Markdown summary.

import { parseArgs } from 'node:util'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createBot } from './bot.js'
import { buildReport, toMarkdown } from './report.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const HELP = `Usage: node index.js --pin <6 digits> [options]

Bots join the game a host page is running and answer every question.
Open host.html, note the PIN, start this, then press Start on the host
(tick Auto-advance on the host to run the game hands-free).

Options
  --host-url <url[,url…]>    PipesHub Socket.io URL. Several URLs are used
                             round-robin, one per bot.  [http://localhost:3000]
  --auth-url <url[,url…]>    PipesHub auth URL (POST /auth). Paired with
                             --host-url by position.   [http://localhost:16916]
  --pin <digits>             Game PIN shown on the host (required)
  --players <n>              Number of bots                          [100]
  --ramp-seconds <s>         Spread the joins over this many seconds [10]
  --answer-delay-ms <a,b>    Answer after a random delay in [a, b]   [500,4000]
  --correct-rate <0-1>       Share of answers that are correct       [0.7]
  --quiz <file>              Quiz the host is running, so bots know the
                             right answers           [../samples/networking.json]
  --out <dir>                Where to write report.json and summary.md
                                                     [results/<timestamp>]
  --max-minutes <m>          Stop waiting for END after this long    [30]
  --yes                      Required when a URL is not on localhost
  --help                     Show this help
`

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

async function main() {
  const { values } = parseArgs({
    options: {
      'host-url':        { type: 'string', default: 'http://localhost:3000' },
      'auth-url':        { type: 'string', default: 'http://localhost:16916' },
      'pin':             { type: 'string' },
      'players':         { type: 'string', default: '100' },
      'ramp-seconds':    { type: 'string', default: '10' },
      'answer-delay-ms': { type: 'string', default: '500,4000' },
      'correct-rate':    { type: 'string', default: '0.7' },
      'quiz':            { type: 'string', default: path.join(HERE, '..', 'samples', 'networking.json') },
      'out':             { type: 'string' },
      'max-minutes':     { type: 'string', default: '30' },
      'yes':             { type: 'boolean', default: false },
      'help':            { type: 'boolean', default: false },
    },
  })
  if (values.help) { process.stdout.write(HELP); return }

  const config = readConfig(values)
  guardTarget(config, values.yes)

  const answers = await loadAnswers(config.quiz)
  const out = config.out ?? path.join(HERE, 'results', new Date().toISOString().replace(/[:.]/g, '-'))

  log(`${config.players} bots → PIN ${config.pin}, hub ${config.hubUrls.join(', ')}, ramp ${config.rampSeconds}s`)
  if (!answers.size) log('No quiz file answers loaded; bots will answer at random.')

  const loopDelay = monitorEventLoopDelay({ resolution: 1 })
  loopDelay.enable()

  const bots = []
  let endedCount = 0
  let firstEndAt = null
  const startedAt = new Date()
  const gap = config.players > 1 ? (config.rampSeconds * 1000) / (config.players - 1) : 0

  for (let i = 0; i < config.players; i++) {
    const k = i % config.hubUrls.length
    const bot = createBot({
      hubUrl:        config.hubUrls[k],
      authUrl:       config.authUrls[k % config.authUrls.length],
      pin:           config.pin,
      nickname:      `bot-${String(i + 1).padStart(String(config.players).length, '0')}`,
      answerDelayMs: config.answerDelayMs,
      correctRate:   config.correctRate,
      answers,
      onEnd: () => { endedCount++; firstEndAt ??= performance.now() },
    })
    bots.push(bot)
    setTimeout(() => bot.start(), i * gap)
  }

  // Progress, and the stop rule: everyone saw END, or 15 s after the first
  // END (the rest are counted as missing END), or --max-minutes.
  const deadline = performance.now() + config.maxMinutes * 60_000
  let lastLine = ''
  while (true) {
    await sleep(1_000)
    const joined = bots.filter(b => b.stats.joinOk).length
    const failed = bots.filter(b => b.stats.joinError).length
    const q = bots.reduce((a, b) => a + b.stats.received.QUESTION, 0)
    const line = `joined ${joined}/${config.players} (failed ${failed}) · QUESTIONs received ${q} · END ${endedCount}`
    if (line !== lastLine) { log(line); lastLine = line }
    if (endedCount === joined && joined + failed === config.players && endedCount > 0) break
    if (firstEndAt && performance.now() - firstEndAt > 15_000) { log('Some bots never got END; stopping.'); break }
    if (performance.now() > deadline) { log('--max-minutes reached; stopping.'); break }
  }

  loopDelay.disable()
  for (const b of bots) b.stop()

  const report = buildReport({
    config: { ...config, quiz: path.relative(process.cwd(), config.quiz) },
    startedAt,
    finishedAt: new Date(),
    bots: bots.map(b => b.stats),
    loadgenLoopDelayMs: {
      p50: loopDelay.percentile(50) / 1e6,
      p99: loopDelay.percentile(99) / 1e6,
      max: loopDelay.max / 1e6,
    },
  })

  await mkdir(out, { recursive: true })
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(path.join(out, 'summary.md'), toMarkdown(report))
  process.stdout.write('\n' + toMarkdown(report) + '\n')
  log(`Wrote ${path.join(out, 'report.json')} and summary.md`)
  setTimeout(() => process.exit(0), 200)
}

// ── Config ───────────────────────────────────────────────────────────────────

function readConfig(v) {
  const fail = msg => { process.stderr.write(`${msg}\n\n${HELP}`); process.exit(2) }

  if (!/^\d{6}$/.test(v.pin ?? '')) fail('--pin must be the 6-digit PIN shown on the host.')
  const players = Number(v.players)
  if (!Number.isInteger(players) || players < 1) fail('--players must be a positive integer.')
  const rampSeconds = Number(v['ramp-seconds'])
  if (!(rampSeconds >= 0)) fail('--ramp-seconds must be 0 or more.')
  const delay = v['answer-delay-ms'].split(',').map(Number)
  if (delay.length !== 2 || delay.some(n => !(n >= 0)) || delay[0] > delay[1]) fail('--answer-delay-ms must be "min,max" in ms.')
  const correctRate = Number(v['correct-rate'])
  if (!(correctRate >= 0 && correctRate <= 1)) fail('--correct-rate must be between 0 and 1.')
  const maxMinutes = Number(v['max-minutes'])
  if (!(maxMinutes > 0)) fail('--max-minutes must be positive.')

  const list = s => s.split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean)
  const hubUrls = list(v['host-url'])
  const authUrls = list(v['auth-url'])
  for (const u of [...hubUrls, ...authUrls]) {
    try { new URL(u) } catch { fail(`Not a URL: ${u}`) }
  }

  return {
    pin: v.pin, players, rampSeconds, answerDelayMs: delay, correctRate, maxMinutes,
    hubUrls, authUrls, quiz: path.resolve(v.quiz), out: v.out ? path.resolve(v.out) : null,
  }
}

/** Never load-test someone else's server by accident. */
function guardTarget(config, yes) {
  const remote = [...config.hubUrls, ...config.authUrls].filter(u => !LOCAL_HOSTS.has(new URL(u).hostname))
  if (!remote.length) return
  process.stderr.write(`\nWARNING: these targets are not on localhost:\n  ${remote.join('\n  ')}\n` +
    `This opens ${config.players} connections and sends real traffic to them.\n`)
  if (!yes) {
    process.stderr.write('Re-run with --yes if you own these servers and mean it.\n')
    process.exit(2)
  }
  process.stderr.write('--yes given; continuing.\n\n')
}

async function loadAnswers(file) {
  const answers = new Map()
  try {
    const quiz = JSON.parse(await readFile(file, 'utf8'))
    quiz.questions.forEach((q, i) => answers.set(`q${i + 1}`, { text: String(q.text).trim(), correct: q.correct }))
  } catch (err) {
    log(`Could not read --quiz ${file}: ${err.message}`)
  }
  return answers
}

function log(msg) {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(err => { console.error(err); process.exit(1) })
