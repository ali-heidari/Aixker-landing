// Host page: the game authority. Holds the questions, runs the timer,
// scores answers and keeps the player list. PipesHub only moves messages.

import * as game from './game.js'
import * as ui   from './ui.js'
import { parseQuiz } from './questions.js'
import { createPipe, fetchToken } from './pipes.js'

const HUB_URL  = window.__PIPESHUB_URL__
const AUTH_URL = window.__PIPESHUB_AUTH_URL__

const LOBBY_UPDATE_MS = 2_000   // LOBBY count goes out at most this often
const AUTO_REVEAL_MS  = 5_000   // auto-advance: reveal → leaderboard
const AUTO_NEXT_MS    = 5_000   // auto-advance: leaderboard → next question
const CLOUD_SIZE      = 50

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

  state = game.createGame(quiz)
  $setupStatus.textContent = ''
  renderLobby()
  lobbyTimer = setInterval(sendLobbyCount, LOBBY_UPDATE_MS)
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
  $conn.dataset.state = status
  $conn.textContent   = labels[status] ?? status
}

function handleJoin(unitName, input, reply) {
  if (typeof unitName !== 'string' || !unitName.startsWith(`quiz-p-${pin}-`)) {
    reply?.({ ok: false, reason: 'BAD_UNIT' })
    return
  }
  const existing = players.get(unitName) ?? null
  const nick     = game.validateNickname(input.nickname)
  const taken    = nick.ok && nicknames.has(game.nicknameKey(nick.nickname))
  const res      = game.joinPlayer(state, existing, { unitName, nickname: input.nickname }, taken, performance.now())

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
  const player = players.get(unitName)
  const result = game.scoreAnswer(state, player, input, answers.has(unitName), performance.now())
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

function sendEach(units, operation, inputFn) {
  for (const unit of units) {
    if (pipe.request(unit, operation, inputFn(unit))) countSent(unit, operation)
  }
}

function sendLobbyCount() {
  if (state.phase !== game.PHASE.LOBBY || players.size === lobbyCountSent) return
  lobbyCountSent = players.size
  const input = { playerCount: players.size }
  sendEach([...players.keys()], 'LOBBY', () => input)
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

boot()
