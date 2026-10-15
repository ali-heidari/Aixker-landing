// One bot player. Speaks the same protocol as src/player.js, through the
// same client (src/pipes.js), and records what happened to it.

import { io } from 'socket.io-client'
import { createPipe, fetchToken, randomId } from '../src/pipes.js'

const JOIN_TIMEOUT_MS   = 10_000
const ANSWER_TIMEOUT_MS = 8_000
const REJOIN_TIMEOUT_MS = 4_000
const REJOIN_TRIES      = 6

/**
 * opts:
 *   hubUrl, authUrl, pin, nickname
 *   answerDelayMs  [min, max]
 *   correctRate    0–1
 *   answers        Map qid → { text, correct } from the quiz file (may be empty)
 *   onEnd          () => void, called once when END arrives
 */
export function createBot(opts) {
  const { hubUrl, authUrl, pin, nickname, answerDelayMs, correctRate, answers, onEnd } = opts
  const hostUnit = `quiz-host-${pin}`
  const unitName = `quiz-p-${pin}-${randomId(12)}`

  const stats = {
    nickname,
    unitName,
    hubUrl,
    connectMs:     null,     // start → hub ready
    joinMs:        null,     // start → JOIN reply (connect + JOIN)
    joinOk:        false,
    joinError:     null,
    received:      { LOBBY: 0, QUESTION: 0, REVEAL: 0, LEADERBOARD: 0, END: 0, PING: 0 },
    sent:          null,     // host's sent counts from END
    answersSent:   0,
    ackMs:         [],
    accepted:      0,
    late:          0,
    rejected:      0,
    ackTimeouts:   0,
    ackOffline:    0,
    disconnects:   0,
    rejoinsOk:     0,
    rejoinsFailed: 0,
    finalRank:     null,
    finalTotal:    null,
  }

  let pipe       = null
  let joined     = false
  let rejoining  = false
  let lastAckMs  = null
  let lastQid    = null
  let ended      = false
  const timers   = new Set()

  async function start() {
    const t0 = performance.now()
    try {
      pipe = createPipe({
        hubUrl,
        unitName,
        getToken: () => fetchToken(authUrl, unitName),
        io,
        onMessage,
        onStatus,
        socketOptions: { forceNew: true },   // one connection per bot, like separate phones
      })
      await pipe.connect()
      stats.connectMs = performance.now() - t0
      const res = await pipe.ask(hostUnit, 'JOIN', { nickname, rejoin: false }, { timeoutMs: JOIN_TIMEOUT_MS })
      if (!res?.ok) throw { code: res?.reason ?? 'BAD_REPLY' }
      stats.joinMs = performance.now() - t0
      stats.joinOk = true
      joined = true
      applyState(res.state)
    } catch (err) {
      stats.joinError = err?.code ?? err?.message ?? String(err)
      stop()
    }
  }

  function stop() {
    for (const t of timers) clearTimeout(t)
    timers.clear()
    pipe?.close()
    pipe = null
  }

  function applyState(state) {
    if (state?.phase === 'question' && !state.answered) scheduleAnswer(state.question)
    if (state?.phase === 'end' && !ended) markEnded(state)
  }

  function onMessage({ operation, input, senderId, reply }) {
    if (senderId !== hostUnit) return
    if (operation in stats.received) stats.received[operation]++
    switch (operation) {
      case 'QUESTION': scheduleAnswer(input); break
      case 'PING':     reply?.({ seq: input.seq }); break
      case 'END':      markEnded(input); break
      default: break
    }
  }

  function markEnded(input) {
    if (ended) return
    ended = true
    stats.sent       = input.sent ?? null
    stats.finalRank  = input.yourRank ?? null
    stats.finalTotal = input.yourTotal ?? null
    onEnd?.()
  }

  function onStatus(status) {
    if (!joined) return
    if (status === 'disconnected') stats.disconnects++
    if (status === 'ready') rejoin()
  }

  /** Same idea as the player page: after a new socket, tell the host we are back. */
  async function rejoin() {
    if (rejoining || ended) return
    rejoining = true
    for (let i = 0; i < REJOIN_TRIES && pipe; i++) {
      try {
        const res = await pipe.ask(hostUnit, 'JOIN', { nickname, rejoin: true }, { timeoutMs: REJOIN_TIMEOUT_MS })
        if (res?.ok) {
          stats.rejoinsOk++
          rejoining = false
          applyState(res.state)
          return
        }
        break
      } catch {
        await sleep(Math.min(1_000 * 2 ** i, 8_000))
      }
    }
    stats.rejoinsFailed++
    rejoining = false
  }

  function scheduleAnswer(q) {
    if (!q || q.qid === lastQid) return
    lastQid = q.qid
    const [min, max] = answerDelayMs
    const delay = min + Math.random() * (max - min)
    const t = setTimeout(() => { timers.delete(t); answer(q) }, delay)
    timers.add(t)
  }

  async function answer(q) {
    if (!pipe) return
    stats.answersSent++
    const known = answers.get(q.qid)
    const knowsAnswer = known && known.text === q.text
    let option
    if (knowsAnswer && Math.random() < correctRate) {
      option = known.correct
    } else if (knowsAnswer) {
      const wrong = q.options.map((_, i) => i).filter(i => i !== known.correct)
      option = wrong[Math.floor(Math.random() * wrong.length)]
    } else {
      option = Math.floor(Math.random() * q.options.length)
    }

    const t0 = performance.now()
    try {
      const res = await pipe.ask(hostUnit, 'ANSWER', { qid: q.qid, option, lastAckMs }, { timeoutMs: ANSWER_TIMEOUT_MS })
      lastAckMs = Math.round(performance.now() - t0)
      stats.ackMs.push(performance.now() - t0)
      if (res?.accepted) stats.accepted++
      else if (res?.late) stats.late++
      else stats.rejected++
    } catch (err) {
      if (err?.code === 'TIMEOUT') stats.ackTimeouts++
      else stats.ackOffline++
    }
  }

  return { start, stop, stats, get ended() { return ended } }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
