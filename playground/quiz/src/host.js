// Host page: the game authority. Holds the questions, runs the timer,
// scores answers and keeps the player list. PipesHub only moves messages.

import * as game from './game.js'
import * as ui   from './ui.js'
import { parseQuiz } from './questions.js'
import { createPipe, fetchToken } from './pipes.js'
import { configureFanout, fanout } from './fanout.js'
import { createRate, createSamples } from './metrics.js'

const HUB_URL  = window.__PIPESHUB_URL__
const AUTH_URL = window.__PIPESHUB_AUTH_URL__

const LOBBY_UPDATE_MS = 2_000   // LOBBY count goes out at most this often
const AUTO_REVEAL_MS  = 5_000   // auto-advance: reveal → leaderboard
const AUTO_NEXT_MS    = 5_000   // auto-advance: leaderboard → next question
const CLOUD_SIZE      = 50

const PING_INTERVAL_MS = 10_000
const PING_SAMPLE      = 50       // never ping everyone
const PING_TIMEOUT_MS  = 5_000
const SEEN_WINDOW_MS   = 30_000   // "seen recently" in the metrics panel
const METRICS_MS       = 500

const params = new URLSearchParams(location.search)

// ── State ────────────────────────────────────────────────────────────────────

let quiz     = null
let state    = null              // game.createGame() object
let pipe     = null
let pin      = null
let hostUnit = null

const players    = new Map()     // unitName → player record (game.createPlayer)
const nicknames  = new Set()     // nicknameKey() of every player
const sentCounts = new Map()     // unitName → { QUESTION, REVEAL, LEADERBOARD }
let answers      = new Map()     // unitName → accepted answer, current question
let roundUnits   = []            // players who may answer the current question
let ranked       = []
let rankOf       = new Map()
let top10        = []
let recentNicks  = []

let autoAdvance    = false
let questionTimer  = null
let autoTimer      = null
let tickTimer      = null
let lobbyTimer     = null
let lobbyCountSent = -1
let renderQueued   = false
let sendChain      = Promise.resolve()   // keeps fan-outs in order

// Metrics (panel toggled with M)
const lastSeen   = new Map()            // unitName → performance.now() of last message
const joinRate   = createRate()
const answerRate = createRate()
const ackMs      = createSamples()      // ANSWER round trips reported by players
const pingMs     = createSamples()
let pingSeq      = 0
let pingTimeouts = 0
let pingTimer    = null
let metricsTimer = null
let lastFanout   = null
let fanoutFailed = 0

// ── DOM refs ─────────────────────────────────────────────────────────────────

const $conn        = ui.$('conn')
const $setupErrors = ui.$('setup-errors')
const $setupStatus = ui.$('setup-status')
const $quizReady   = ui.$('quiz-ready')
const $openLobby   = ui.$('open-lobby')
const $playerCount = ui.$('player-count')
const $nickCloud   = ui.$('nick-cloud')
const $startBtn    = ui.$('start-btn')
const $hqSeconds   = ui.$('hq-seconds')
const $hqTimer     = ui.$('hq-timer')
const $hqAnswered  = ui.$('hq-answered')
const $hqEligible  = ui.$('hq-eligible')
const $metrics     = ui.$('metrics')

// ── Boot ─────────────────────────────────────────────────────────────────────

function boot() {
  ui.initThemeToggle(ui.$('theme-toggle'))

  ui.$('sample-btn').addEventListener('click', async () => {
    try {
      const res = await fetch('samples/networking.json')
      loadQuiz(await res.text())
    } catch {
      showSetupErrors(['Could not load the sample quiz.'])
    }
  })
  ui.$('file-input').addEventListener('change', async e => {
    const file = e.target.files?.[0]
    if (file) loadQuiz(await file.text())
  })
  ui.$('paste-btn').addEventListener('click', () => loadQuiz(ui.$('paste').value))
  $openLobby.addEventListener('click', openLobby)

  $startBtn.addEventListener('click', () => startNextQuestion())
  ui.$('reveal-btn').addEventListener('click', () => reveal())
  ui.$('to-leaderboard-btn').addEventListener('click', () => showLeaderboard())
  ui.$('next-btn').addEventListener('click', () => next())
  ui.$('new-game').addEventListener('click', () => { location.reload() })
  for (const btn of document.querySelectorAll('.end-btn')) {
    btn.addEventListener('click', () => { if (confirm('End the game for everyone?')) finish() })
  }

  document.addEventListener('keydown', e => {
    if (e.key.toLowerCase() !== 'm' || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.target.closest?.('input, textarea')) return
    toggleMetrics()
  })

  window.addEventListener('beforeunload', e => {
    if (state && state.phase !== game.PHASE.END) e.preventDefault()
  })

  ui.showScreen('setup')
}

// ── Setup ────────────────────────────────────────────────────────────────────

function loadQuiz(text) {
  const res = parseQuiz(text)
  if (!res.ok) {
    quiz = null
    $quizReady.hidden = true
    showSetupErrors(res.errors)
    return
  }
  quiz = res.quiz
  showSetupErrors([])
  ui.$('quiz-summary').textContent = `${quiz.title} — ${quiz.questions.length} question${quiz.questions.length === 1 ? '' : 's'}`
  $quizReady.hidden = false
  $openLobby.focus()
}

function showSetupErrors(errors) {
  $setupErrors.replaceChildren(...errors.map(e => ui.el('li', {}, e)))
}

async function openLobby() {
  $openLobby.disabled = true
  $setupStatus.textContent = 'Connecting to PipesHub…'
  autoAdvance = ui.$('auto-advance').checked

  pin      = /^\d{6}$/.test(params.get('pin') ?? '') ? params.get('pin') : randomPin()
  hostUnit = `quiz-host-${pin}`

  try {
    pipe = createPipe({
      hubUrl:   HUB_URL,
      unitName: hostUnit,
      getToken: () => fetchToken(AUTH_URL, hostUnit),
      onMessage,
      onStatus,
    })
    await pipe.connect()
  } catch (err) {
    $setupStatus.textContent = `Could not connect (${err?.code ?? err?.message ?? 'error'}). Try again.`
    $openLobby.disabled = false
    pipe?.close()
    pipe = null
    return
  }

  configureFanout({
    send:   sendOne,
    onDone: r => { lastFanout = r; fanoutFailed += r.failed },
  })

  state = game.createGame(quiz)
  $setupStatus.textContent = ''
  renderLobby()
  lobbyTimer = setInterval(sendLobbyCount, LOBBY_UPDATE_MS)
  pingTimer  = setInterval(pingSample, PING_INTERVAL_MS)
  ui.showScreen('lobby')
}

function randomPin() {
  return String(100_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900_000))
}

// ── Inbound ──────────────────────────────────────────────────────────────────

function onMessage({ operation, input, senderId, reply }) {
  switch (operation) {
    case 'JOIN':   handleJoin(senderId, input, reply);   break
    case 'ANSWER': handleAnswer(senderId, input, reply); break
    default: break
  }
}

function onStatus(status) {
  const labels = { connecting: 'connecting', ready: 'live', disconnected: 'offline', error: 'offline' }
  const was = $conn.dataset.state
  $conn.dataset.state = status
  $conn.textContent   = labels[status] ?? status
  if (status === 'disconnected') ui.showToast('Lost the connection to PipesHub. Reconnecting…', 5000)
  if (status === 'ready' && (was === 'disconnected' || was === 'error' || was === 'connecting') && state) {
    ui.showToast('Reconnected.')
  }
}

function handleJoin(unitName, input, reply) {
  if (typeof unitName !== 'string' || !unitName.startsWith(`quiz-p-${pin}-`)) {
    reply?.({ ok: false, reason: 'BAD_UNIT' })
    return
  }
  const now = performance.now()
  joinRate.hit(now)
  lastSeen.set(unitName, now)

  const existing = players.get(unitName) ?? null
  const nick     = game.validateNickname(input.nickname)
  const taken    = nick.ok && nicknames.has(game.nicknameKey(nick.nickname))
  const res      = game.joinPlayer(state, existing, { unitName, nickname: input.nickname }, taken, now)

  if (!res.ok) {
    reply?.({ ok: false, reason: res.reason })
    return
  }
  if (!res.restored) {
    players.set(unitName, res.player)
    nicknames.add(game.nicknameKey(res.player.nickname))
    recentNicks.push(res.player.nickname)
    if (recentNicks.length > CLOUD_SIZE) recentNicks = recentNicks.slice(-CLOUD_SIZE)
    queueRender()
  }
  reply?.({ ok: true, playerId: unitName, state: viewFor(res.player) })
}

function handleAnswer(unitName, input, reply) {
  const now    = performance.now()
  const player = players.get(unitName)
  const result = game.scoreAnswer(state, player, input, answers.has(unitName), now)

  answerRate.hit(now)
  if (player) lastSeen.set(unitName, now)
  // The player's own measurement of its previous ANSWER round trip.
  if (Number.isFinite(input.lastAckMs) && input.lastAckMs >= 0 && input.lastAckMs < 120_000) ackMs.add(input.lastAckMs)

  if (result.accepted) answers.set(unitName, result)
  reply?.({ accepted: result.accepted, late: result.late })

  if (result.accepted) {
    queueRender()
    if (answers.size >= roundUnits.length) reveal()
  }
}

function viewFor(player) {
  return game.playerView(state, player, {
    answer:      answers.get(player.unitName),
    rank:        rankOf.get(player.unitName) ?? null,
    top10,
    playerCount: players.size,
    now:         performance.now(),
  })
}

// ── Game flow ────────────────────────────────────────────────────────────────

function startNextQuestion() {
  clearTimeout(autoTimer)
  clearInterval(lobbyTimer)
  state      = game.startQuestion(state, performance.now())
  answers    = new Map()
  roundUnits = [...players.values()].filter(p => game.isInRound(state, p)).map(p => p.unitName)

  const q = game.currentQuestion(state)
  renderQuestion(q)
  ui.showScreen('question')

  sendEach(roundUnits, 'QUESTION', () => game.questionPayload(state, q, game.remainingMs(state, performance.now())))

  questionTimer = setTimeout(reveal, game.answerWindowMs(q))
  tickTimer     = setInterval(tickQuestion, 100)
  tickQuestion()
}

function reveal() {
  if (state.phase !== game.PHASE.QUESTION) return
  clearTimeout(questionTimer)
  clearInterval(tickTimer)

  state = game.revealQuestion(state)
  for (const [unit, p] of players) players.set(unit, game.settlePlayer(state, p, answers.get(unit)))
  rerank()

  const q = game.currentQuestion(state)
  renderReveal(q, game.tallyAnswers(answers.values(), q.options.length))
  ui.showScreen('reveal')

  sendEach(roundUnits, 'REVEAL', unit => game.revealPayload(q, players.get(unit), rankOf.get(unit) ?? null))

  if (autoAdvance) autoTimer = setTimeout(showLeaderboard, AUTO_REVEAL_MS)
}

function showLeaderboard() {
  if (state.phase !== game.PHASE.REVEAL) return
  clearTimeout(autoTimer)
  state = game.showLeaderboard(state)

  ui.renderTopList(ui.$('hl-list'), top10)
  ui.$('next-btn').textContent = game.hasNextQuestion(state) ? 'Next question' : 'Final results'
  ui.showScreen('leaderboard')

  const input = { top10, playerCount: players.size }
  sendEach([...players.keys()], 'LEADERBOARD', () => input)

  if (autoAdvance) autoTimer = setTimeout(next, AUTO_NEXT_MS)
}

function next() {
  if (state.phase !== game.PHASE.LEADERBOARD) return
  if (game.hasNextQuestion(state)) startNextQuestion()
  else finish()
}

function finish() {
  if (!state || state.phase === game.PHASE.END) return
  clearTimeout(questionTimer)
  clearTimeout(autoTimer)
  clearInterval(tickTimer)
  clearInterval(lobbyTimer)
  clearInterval(pingTimer)
  state = game.endGame(state)
  rerank()

  renderEnd()
  ui.showScreen('end')

  sendEach([...players.keys()], 'END', unit => ({
    top10,
    yourRank:  rankOf.get(unit) ?? null,
    yourTotal: players.get(unit)?.score ?? 0,
    sent:      sentCountsFor(unit),
  }))
}

function rerank() {
  ranked = game.rankPlayers(players.values())
  rankOf = new Map(ranked.map(p => [p.unitName, p.rank]))
  top10  = game.topN(ranked, 10)
}

// ── Outbound ─────────────────────────────────────────────────────────────────

/** Fan out in order: a player never gets LEADERBOARD after the next QUESTION. */
function sendEach(units, operation, inputFn) {
  sendChain = sendChain.then(() => fanout(units, operation, inputFn)).catch(err => console.error(err))
  return sendChain
}

function sendOne(unit, operation, input) {
  const ok = pipe.request(unit, operation, input)
  if (ok) countSent(unit, operation)
  return ok
}

function sendLobbyCount() {
  if (state.phase !== game.PHASE.LOBBY || players.size === lobbyCountSent) return
  lobbyCountSent = players.size
  const input = { playerCount: players.size }
  sendEach([...players.keys()], 'LOBBY', () => input)
}

// ── PING sampling ────────────────────────────────────────────────────────────

/** Ping up to PING_SAMPLE random players and record the round trips. */
function pingSample() {
  if (!pipe?.isReady() || !players.size) return
  for (const unit of sample([...players.keys()], PING_SAMPLE)) {
    const seq = ++pingSeq
    const t0  = performance.now()
    pipe.ask(unit, 'PING', { seq }, { timeoutMs: PING_TIMEOUT_MS })
      .then(res => {
        if (res?.seq !== seq) return
        const now = performance.now()
        pingMs.add(now - t0)
        lastSeen.set(unit, now)
      })
      .catch(err => { if (err?.code === 'TIMEOUT') pingTimeouts++ })
  }
}

/** k random items (partial Fisher–Yates). */
function sample(items, k) {
  const n = Math.min(k, items.length)
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (items.length - i))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items.slice(0, n)
}

function countSent(unit, operation) {
  let c = sentCounts.get(unit)
  if (!c) { c = { QUESTION: 0, REVEAL: 0, LEADERBOARD: 0 }; sentCounts.set(unit, c) }
  if (operation in c) c[operation]++
}

/** What the host sent this unit, so a client can count its own losses. */
function sentCountsFor(unit) {
  const c = sentCounts.get(unit) ?? { QUESTION: 0, REVEAL: 0, LEADERBOARD: 0 }
  return { question: c.QUESTION, reveal: c.REVEAL, leaderboard: c.LEADERBOARD }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderLobby() {
  const url = new URL('./', location.href)
  url.searchParams.set('pin', pin)
  for (const k of ['hub', 'auth']) if (params.has(k)) url.searchParams.set(k, params.get(k))
  const joinUrl = url.toString()

  ui.$('pin-big').textContent  = `${pin.slice(0, 3)} ${pin.slice(3)}`
  ui.$('join-url').textContent = joinUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, '')

  const $qr = ui.$('qr')
  if (window.qrcode) {
    const qr = window.qrcode(0, 'M')
    qr.addData(joinUrl)
    qr.make()
    $qr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  } else {
    $qr.textContent = 'QR code unavailable'
  }
  renderPlayers()
}

/** Batch DOM updates during join and answer bursts to one per frame. */
function queueRender() {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    if (state.phase === game.PHASE.LOBBY) renderPlayers()
    else if (state.phase === game.PHASE.QUESTION) $hqAnswered.textContent = ui.formatScore(answers.size)
  })
}

function renderPlayers() {
  $playerCount.textContent = ui.formatScore(players.size)
  $startBtn.disabled = players.size === 0
  $nickCloud.replaceChildren(...recentNicks.map(n => ui.el('span', {}, n)))
}

function renderQuestion(q) {
  ui.$('hq-index').textContent = `${state.index + 1} / ${state.questions.length}`
  ui.$('hq-text').textContent  = q.text
  $hqAnswered.textContent      = '0'
  $hqEligible.textContent      = ui.formatScore(roundUnits.length)
  ui.$('hq-options').replaceChildren(...q.options.map((text, i) =>
    ui.el('div', { class: `host-option opt-${i}`, 'aria-label': ui.optionLabel(i, text) },
      ui.optionBadge(i), ui.el('span', {}, text))))
}

function tickQuestion() {
  const q    = game.currentQuestion(state)
  const left = game.remainingMs(state, performance.now())
  $hqSeconds.textContent = ui.formatSeconds(left)
  $hqTimer.style.transform = `scaleX(${left / q.durationMs})`
}

function renderReveal(q, counts) {
  const max = Math.max(1, ...counts)
  ui.$('hr-text').textContent = q.text
  ui.$('hr-bars').replaceChildren(...q.options.map((text, i) => {
    const correct = i === q.correct
    return ui.el('div', { class: `bar-row${correct ? ' correct' : ''}` },
      ui.el('div', { class: 'bar-head' },
        ui.el('span', { class: `opt-badge opt-${i}` }, ui.OPTION_STYLES[i].shape, ' ', ui.OPTION_STYLES[i].letter),
        ui.el('span', {}, text),
        correct ? ui.el('span', { class: 'mark' }, '✓ Correct') : null,
        ui.el('span', { class: 'count' }, ui.formatScore(counts[i]))),
      ui.el('div', { class: 'bar' },
        ui.el('span', { class: `fill opt-${i}`, style: `width: ${(counts[i] / max) * 100}%` })))
  }))
  ui.announce(`The answer is ${ui.optionLabel(q.correct, q.options[q.correct])}`)
}

function renderEnd() {
  const podium = [ranked[1], ranked[0], ranked[2]]
  const places = ['p2', 'p1', 'p3']
  ui.$('podium').replaceChildren(...podium.map((p, i) => ui.el('div', { class: places[i] },
    ui.el('span', { class: 'place' }, p ? `#${p.rank}` : ''),
    ui.el('span', { class: 'nick' }, p?.nickname ?? '—'),
    ui.el('span', { class: 'mono' }, p ? ui.formatScore(p.score) : ''))))
  ui.renderTopList(ui.$('end-list'), top10)
}

// ── Metrics panel ────────────────────────────────────────────────────────────

function toggleMetrics() {
  $metrics.hidden = !$metrics.hidden
  clearInterval(metricsTimer)
  if (!$metrics.hidden) {
    renderMetrics()
    metricsTimer = setInterval(renderMetrics, METRICS_MS)
  }
}

/** Snapshot of the host's numbers. Also used by load tests via window.__quizHost. */
function metricsSnapshot() {
  const now = performance.now()
  let seen = 0
  for (const t of lastSeen.values()) if (now - t <= SEEN_WINDOW_MS) seen++
  return {
    players:       players.size,
    seenRecently:  seen,
    joinsPerSec:   joinRate.perSecond(now),
    answersPerSec: answerRate.perSecond(now),
    ackP50:        ackMs.p(50),
    ackP95:        ackMs.p(95),
    ackSamples:    ackMs.total,
    pingP50:       pingMs.p(50),
    pingP95:       pingMs.p(95),
    pingSamples:   pingMs.total,
    pingTimeouts,
    lastFanout,
    fanoutFailed,
    hubReady:      !!pipe?.isReady(),
  }
}

function renderMetrics() {
  const m  = metricsSnapshot()
  const ms = v => (v === null ? '–' : `${Math.round(v)} ms`)
  const f  = m.lastFanout
  const rows = [
    ['Hub',                 m.hubReady ? 'connected' : 'offline'],
    ['Players joined',      ui.formatScore(m.players)],
    ['Seen in last 30 s',   ui.formatScore(m.seenRecently)],
    ['Joins / s',           m.joinsPerSec.toFixed(0)],
    ['Answers / s',         m.answersPerSec.toFixed(0)],
    ['ANSWER ack p50',      ms(m.ackP50)],
    ['ANSWER ack p95',      ms(m.ackP95)],
    ['PING rtt p50',        ms(m.pingP50)],
    ['PING rtt p95',        ms(m.pingP95)],
    ['PING timeouts',       `${m.pingTimeouts} / ${m.pingSamples + m.pingTimeouts}`],
    ['Last fan-out',        f ? `${f.operation} × ${f.sent}` : '–'],
    ['Fan-out time',        f ? `${f.durationMs.toFixed(1)} ms (${f.batches} batch${f.batches === 1 ? '' : 'es'})` : '–'],
    ['Sends while offline', String(m.fanoutFailed)],
  ]
  ui.$('metrics-list').replaceChildren(...rows.flatMap(([k, v]) => [ui.el('dt', {}, k), ui.el('dd', {}, v)]))
}

window.__quizHost = { metrics: metricsSnapshot }

boot()
