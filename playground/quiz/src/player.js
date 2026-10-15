import * as game from './game.js'
import * as ui   from './ui.js'
import { createPipe, fetchToken, randomId } from './pipes.js'

const HUB_URL  = window.__PIPESHUB_URL__
const AUTH_URL = window.__PIPESHUB_AUTH_URL__

const JOIN_TIMEOUT_MS   = 10_000
const ANSWER_TIMEOUT_MS = 8_000

const JOIN_ERRORS = {
  NICKNAME_TAKEN:    'That nickname is taken in this game. Pick another.',
  NICKNAME_EMPTY:    'Enter a nickname.',
  NICKNAME_TOO_LONG: `Nicknames can be up to ${game.NICKNAME_MAX} characters.`,
  NICKNAME_INVALID:  'That nickname has characters we cannot show.',
  GAME_OVER:         'That game has already ended.',
  BAD_UNIT:          'The host rejected this connection.',
  NO_GAME:           'No game found with that PIN.',
  TIMEOUT:           'No game found with that PIN.',
  CONNECT_TIMEOUT:   'Could not reach the quiz server. Check your connection.',
}

// ── State ────────────────────────────────────────────────────────────────────

let pipe      = null
let pin       = null
let hostUnit  = null
let nickname  = null

let question     = null   // last QUESTION input
let answeredQid  = null   // qid this player answered (or tried to)
let pickedOption = null
let lastAckMs    = null   // previous ANSWER round trip, reported to the host
let lastRank     = null
let lastTotal    = 0
let timer        = null
let onHubNotice  = null

// ── DOM refs ─────────────────────────────────────────────────────────────────

const $conn         = ui.$('conn')
const $joinForm     = ui.$('join-form')
const $pin          = ui.$('pin')
const $nickname     = ui.$('nickname')
const $joinBtn      = ui.$('join-btn')
const $joinStatus   = ui.$('join-status')
const $waitingNick  = ui.$('waiting-nick')
const $waitingText  = ui.$('waiting-text')
const $waitingCount = ui.$('waiting-count')
const $qIndex       = ui.$('q-index')
const $qSeconds     = ui.$('q-seconds')
const $qTimer       = ui.$('q-timer')
const $qText        = ui.$('q-text')
const $answers      = ui.$('answers')
const $answerStatus = ui.$('answer-status')

// ── Boot ─────────────────────────────────────────────────────────────────────

function boot() {
  ui.initThemeToggle(ui.$('theme-toggle'))
  const pinParam = new URLSearchParams(location.search).get('pin')
  if (pinParam && /^\d{6}$/.test(pinParam)) $pin.value = pinParam

  $joinForm.addEventListener('submit', onJoinSubmit)
  ui.$('play-again').addEventListener('click', () => { location.href = location.pathname })

  ui.showScreen('join')
  ;($pin.value ? $nickname : $pin).focus()
}

// ── Join ─────────────────────────────────────────────────────────────────────

async function onJoinSubmit(e) {
  e.preventDefault()
  const pinValue = $pin.value.trim()
  if (!/^\d{6}$/.test(pinValue)) { setJoinStatus('The PIN has 6 digits.', true); return }
  const nick = game.validateNickname($nickname.value)
  if (!nick.ok) { setJoinStatus(JOIN_ERRORS[nick.reason], true); return }

  $joinBtn.disabled = true
  setJoinStatus('Connecting…')

  pin      = pinValue
  hostUnit = `quiz-host-${pin}`
  nickname = nick.nickname
  const unitName = `quiz-p-${pin}-${randomId(12)}`

  try {
    pipe = createPipe({
      hubUrl:   HUB_URL,
      unitName,
      getToken: () => fetchToken(AUTH_URL, unitName),
      onMessage,
      onStatus,
      onNotice: v => onHubNotice?.(v),
    })
    await pipe.connect()
    setJoinStatus('Joining…')
    const res = await sendJoin(false)
    if (!res?.ok) throw { code: res?.reason }
    applyState(res.state)
  } catch (err) {
    setJoinStatus(JOIN_ERRORS[err?.code] ?? 'Could not join. Try again.', true)
    pipe?.close()
    pipe = null
  } finally {
    $joinBtn.disabled = false
  }
}

/**
 * Ask the host to (re)join. The hub answers an unknown receiver with a
 * notice instead of an error, so a wrong PIN fails fast rather than after
 * the full timeout.
 */
function sendJoin(rejoin) {
  const noGame = new Promise((_, reject) => {
    onHubNotice = v => { if (/no unit found/i.test(String(v))) reject({ code: 'NO_GAME' }) }
  })
  const ask = pipe.ask(hostUnit, 'JOIN', { nickname, rejoin }, { timeoutMs: JOIN_TIMEOUT_MS })
  return Promise.race([ask, noGame]).finally(() => { onHubNotice = null })
}

/** Show whatever the host says is happening now (JOIN reply). */
function applyState(state) {
  lastRank  = state.yourRank ?? lastRank
  lastTotal = state.yourTotal ?? lastTotal
  switch (state.phase) {
    case 'lobby':
      showWaiting(state.playerCount, 'Waiting for the host to start…'); break
    case 'waiting':
      showWaiting(state.playerCount, 'A question is running. You can answer from the next one.'); break
    case 'question':
      showQuestion(state.question, state.answered); break
    case 'reveal':
      showReveal(state.reveal); break
    case 'leaderboard':
      showLeaderboard(state); break
    case 'end':
      showEnd(state); break
    default:
      showWaiting(state.playerCount, 'Waiting for the host…')
  }
}

// ── Inbound ──────────────────────────────────────────────────────────────────

function onMessage({ operation, input, senderId, reply }) {
  if (senderId !== hostUnit) return   // only the host of this PIN may drive us
  switch (operation) {
    case 'LOBBY':       $waitingCount.textContent = ui.formatScore(input.playerCount); break
    case 'QUESTION':    showQuestion(input, false); break
    case 'REVEAL':      showReveal(input);          break
    case 'LEADERBOARD': showLeaderboard(input);     break
    case 'END':         showEnd(input);             break
    case 'PING':        reply?.({ seq: input.seq }); break
    default: break
  }
}

function onStatus(status) {
  const labels = { connecting: 'connecting', ready: 'live', disconnected: 'offline', error: 'offline' }
  $conn.dataset.state = status
  $conn.textContent   = labels[status] ?? status
}

// ── Screens ──────────────────────────────────────────────────────────────────

function showWaiting(playerCount, text) {
  stopTimer()
  $waitingNick.textContent  = nickname
  $waitingText.textContent  = text
  $waitingCount.textContent = ui.formatScore(playerCount)
  ui.showScreen('waiting')
}

function showQuestion(q, alreadyAnswered) {
  question     = q
  answeredQid  = alreadyAnswered ? q.qid : null
  pickedOption = null

  $qIndex.textContent = `Question ${q.index + 1} / ${q.total}`
  $qText.textContent  = q.text
  $answers.className  = `answers count-${q.options.length}`
  $answers.replaceChildren(...q.options.map((text, i) => ui.el('button', {
    class:        `answer-btn opt-${i}`,
    type:         'button',
    'aria-label': ui.optionLabel(i, text),
    onclick:      () => pick(i),
  }, ui.optionBadge(i), ui.el('span', {}, text))))

  setAnswerStatus(alreadyAnswered ? 'Your answer is in. Waiting for the others…' : '')
  if (alreadyAnswered) lockAnswers()
  ui.showScreen('question')
  ui.announce(`Question ${q.index + 1}: ${q.text}`)
  startTimer(q.remainingMs ?? q.durationMs, q.durationMs)
}

async function pick(option) {
  if (!question || answeredQid === question.qid) return
  const q = question
  answeredQid  = q.qid
  pickedOption = option
  lockAnswers(option)
  setAnswerStatus('Sending…')

  const t0 = performance.now()
  try {
    const res = await pipe.ask(hostUnit, 'ANSWER', { qid: q.qid, option, lastAckMs }, { timeoutMs: ANSWER_TIMEOUT_MS })
    lastAckMs = Math.round(performance.now() - t0)
    if (question !== q) return
    if (res?.accepted)  setAnswerStatus('Locked in. Waiting for the others…')
    else if (res?.late) setAnswerStatus('Too late. Time ran out.')
    else                setAnswerStatus('That answer was not counted.')
  } catch (err) {
    if (question !== q) return
    if (err?.code === 'OFFLINE') {
      // Nothing left this device; let the player try again.
      answeredQid = null
      pickedOption = null
      unlockAnswers()
      setAnswerStatus('You are offline. Answer not sent.')
    } else {
      setAnswerStatus('No reply from the host. Your answer may still count.')
    }
  }
}

function showReveal(r) {
  stopTimer()
  const q = question?.qid === r.qid ? question : null
  const $verdict = ui.$('result-verdict')

  if (r.yourPoints > 0) {
    $verdict.textContent = 'Correct!'
    $verdict.className   = 'verdict ok'
  } else if (answeredQid === r.qid && pickedOption === r.correct) {
    $verdict.textContent = 'Too late'
    $verdict.className   = 'verdict bad'
  } else if (answeredQid === r.qid) {
    $verdict.textContent = 'Wrong'
    $verdict.className   = 'verdict bad'
  } else {
    $verdict.textContent = 'No answer'
    $verdict.className   = 'verdict bad'
  }

  const s = ui.OPTION_STYLES[r.correct]
  ui.$('result-correct').textContent = q
    ? `Answer: ${s.shape} ${s.letter} — ${q.options[r.correct]}`
    : `Answer: ${s.shape} ${s.letter}`
  ui.$('result-points').textContent = `+${ui.formatScore(r.yourPoints)}`
  ui.$('result-total').textContent  = ui.formatScore(r.yourTotal)
  ui.$('result-rank').textContent   = r.yourRank ? `#${r.yourRank}` : '–'
  lastRank  = r.yourRank
  lastTotal = r.yourTotal
  ui.showScreen('result')
  ui.announce(`${$verdict.textContent}. ${r.yourPoints} points. Total ${r.yourTotal}. Rank ${r.yourRank ?? 'none'}.`)
}

function showLeaderboard({ top10 = [] }) {
  stopTimer()
  ui.renderTopList(ui.$('lb-list'), top10, lastRank)
  ui.$('lb-you').textContent = lastRank
    ? `You: #${lastRank} · ${ui.formatScore(lastTotal)} points`
    : ''
  ui.showScreen('leaderboard')
}

function showEnd({ top10 = [], yourRank, yourTotal }) {
  stopTimer()
  ui.$('end-rank').textContent  = yourRank ? `#${yourRank}` : '–'
  ui.$('end-total').textContent = ui.formatScore(yourTotal)
  ui.renderTopList(ui.$('end-list'), top10, yourRank)
  ui.showScreen('end')
  ui.announce(`Game over. You finished ${yourRank ? `number ${yourRank}` : 'unranked'} with ${yourTotal ?? 0} points.`)
}

// ── Answer helpers ───────────────────────────────────────────────────────────

function lockAnswers(picked = null) {
  $answers.classList.add('locked')
  for (const [i, btn] of [...$answers.children].entries()) {
    btn.disabled = true
    if (i === picked) btn.classList.add('picked')
  }
}

function unlockAnswers() {
  $answers.classList.remove('locked')
  for (const btn of $answers.children) { btn.disabled = false; btn.classList.remove('picked') }
}

function setAnswerStatus(text) {
  $answerStatus.textContent = text
}

function setJoinStatus(text, isError = false) {
  $joinStatus.textContent = text
  $joinStatus.classList.toggle('error', isError)
}

// ── Countdown (display only; the host decides what is late) ──────────────────

function startTimer(remaining, duration) {
  stopTimer()
  const deadline = performance.now() + remaining
  const tick = () => {
    const left = deadline - performance.now()
    $qSeconds.textContent = ui.formatSeconds(left)
    $qTimer.style.transform = `scaleX(${Math.max(0, left) / duration})`
    if (left <= 0) {
      stopTimer()
      if (answeredQid !== question?.qid) {
        lockAnswers()
        setAnswerStatus("Time's up.")
      }
    }
  }
  tick()
  timer = setInterval(tick, 100)
}

function stopTimer() {
  clearInterval(timer)
  timer = null
}

boot()
