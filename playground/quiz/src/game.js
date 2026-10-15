// Quiz rules: state machine, joining, scoring and ranking.
// Pure functions — no DOM, no network, no clocks. Callers pass `now`
// (the host's performance.now()) and get new objects back; inputs are never
// mutated. The host keeps players in its own Map and swaps in the records
// these functions return, so a 10,000-player game never copies the whole roster
// per answer.

export const GRACE_MS   = 500
export const MAX_POINTS = 1000
export const NICKNAME_MAX = 20

export const PHASE = Object.freeze({
  LOBBY:       'lobby',
  QUESTION:    'question',
  REVEAL:      'reveal',
  LEADERBOARD: 'leaderboard',
  END:         'end',
})

// ── Game flow ────────────────────────────────────────────────────────────────
//
//   lobby ─start─▶ question ─reveal─▶ reveal ─leaderboard─▶ leaderboard
//                     ▲                                        │
//                     └────────────── next (more left) ────────┤
//                                                              └─ end (last)
//   Any phase except end can also go straight to end.

export function createGame(quiz) {
  return {
    title:     quiz.title,
    questions: quiz.questions,
    phase:     PHASE.LOBBY,
    index:     -1,     // index of the current / last question
    startedAt: null,   // host performance.now() when the current question opened
  }
}

/** Open the next question. Valid from lobby or leaderboard while questions remain. */
export function startQuestion(game, now) {
  if (game.phase !== PHASE.LOBBY && game.phase !== PHASE.LEADERBOARD) {
    throw new Error(`Cannot start a question from "${game.phase}"`)
  }
  if (!hasNextQuestion(game)) throw new Error('No questions left')
  return { ...game, phase: PHASE.QUESTION, index: game.index + 1, startedAt: now }
}

export function revealQuestion(game) {
  if (game.phase !== PHASE.QUESTION) throw new Error(`Cannot reveal from "${game.phase}"`)
  return { ...game, phase: PHASE.REVEAL }
}

export function showLeaderboard(game) {
  if (game.phase !== PHASE.REVEAL) throw new Error(`Cannot show leaderboard from "${game.phase}"`)
  return { ...game, phase: PHASE.LEADERBOARD }
}

export function endGame(game) {
  if (game.phase === PHASE.END) throw new Error('Game already ended')
  return { ...game, phase: PHASE.END }
}

export function hasNextQuestion(game) {
  return game.index + 1 < game.questions.length
}

export function currentQuestion(game) {
  return game.index >= 0 ? game.questions[game.index] : null
}

/** Milliseconds left on the current question (0 when not in a question). */
export function remainingMs(game, now) {
  const q = currentQuestion(game)
  if (game.phase !== PHASE.QUESTION || !q) return 0
  return Math.max(0, q.durationMs - (now - game.startedAt))
}

/** The host closes answers at durationMs + GRACE_MS after the start stamp. */
export function answerWindowMs(question) {
  return question.durationMs + GRACE_MS
}

// ── Players ──────────────────────────────────────────────────────────────────

export function validateNickname(raw) {
  const nickname = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  if (!nickname) return { ok: false, reason: 'NICKNAME_EMPTY' }
  if ([...nickname].length > NICKNAME_MAX) return { ok: false, reason: 'NICKNAME_TOO_LONG' }
  if (/[\u0000-\u001f\u007f]/.test(nickname)) return { ok: false, reason: 'NICKNAME_INVALID' }
  return { ok: true, nickname }
}

export function nicknameKey(nickname) {
  return nickname.toLocaleLowerCase()
}

export function createPlayer({ unitName, nickname, firstIndex, joinedAt }) {
  return {
    unitName,
    nickname,
    score:        0,
    timeMs:       0,      // total answer time, used to break score ties
    firstIndex,           // first question this player can answer
    joinedAt,
    settledIndex: -1,     // last question added to score / timeMs
    lastPoints:   0,
    lastCorrect:  false,
  }
}

/** The first question a player joining now may answer. */
export function firstEligibleIndex(game) {
  return game.phase === PHASE.LOBBY ? 0 : game.index + 1
}

export function isInRound(game, player) {
  return game.index >= 0 && player.firstIndex <= game.index
}

/**
 * Decide a JOIN.
 *   existing      — the player record already stored for this unit name, or null
 *   nicknameTaken — true when another unit already uses this nickname
 * Returns { ok, reason?, player, restored }.
 *
 * A known unit name always gets its old record back, whether or not it says
 * rejoin. That makes JOIN safe to retry after a timeout.
 */
export function joinPlayer(game, existing, { unitName, nickname }, nicknameTaken, now) {
  if (existing) return { ok: true, player: existing, restored: true }

  if (game.phase === PHASE.END) return { ok: false, reason: 'GAME_OVER', player: null, restored: false }

  const nick = validateNickname(nickname)
  if (!nick.ok) return { ok: false, reason: nick.reason, player: null, restored: false }
  if (nicknameTaken) return { ok: false, reason: 'NICKNAME_TAKEN', player: null, restored: false }

  const player = createPlayer({
    unitName,
    nickname:   nick.nickname,
    firstIndex: firstEligibleIndex(game),
    joinedAt:   now,
  })
  return { ok: true, player, restored: false }
}

// ── Answers ──────────────────────────────────────────────────────────────────

export function pointsFor(elapsedMs, durationMs) {
  const t = Math.min(Math.max(elapsedMs, 0), durationMs)
  return Math.round(MAX_POINTS * (1 - 0.5 * t / durationMs))
}

/**
 * Judge one ANSWER at host receive time `now`.
 * Returns { accepted, late, correct, points, elapsedMs, option, reason? }.
 * Only accepted answers count; the caller stores them and passes
 * alreadyAnswered = true for any later answer from the same player.
 */
export function scoreAnswer(game, player, { qid, option }, alreadyAnswered, now) {
  const q = currentQuestion(game)
  const reject = (reason, late = false) => ({ accepted: false, late, correct: false, points: 0, elapsedMs: null, option, reason })

  const known = game.questions.findIndex(x => x.qid === qid)
  if (known < 0 || known > game.index) return reject('UNKNOWN_QUESTION')
  if (game.phase !== PHASE.QUESTION || known !== game.index) return reject('CLOSED', true)
  if (!player || !isInRound(game, player)) return reject('NOT_IN_ROUND')
  if (alreadyAnswered) return reject('DUPLICATE')
  if (!Number.isInteger(option) || option < 0 || option >= q.options.length) return reject('BAD_OPTION')

  const elapsedMs = now - game.startedAt
  if (elapsedMs > answerWindowMs(q)) return reject('LATE', true)

  const correct = option === q.correct
  return {
    accepted: true,
    late:     false,
    correct,
    points:   correct ? pointsFor(elapsedMs, q.durationMs) : 0,
    elapsedMs,
    option,
  }
}

/**
 * Add the current question's result to a player at reveal time.
 * `answer` is the accepted scoreAnswer() result, or undefined if none.
 * Unanswered questions add the full duration to timeMs, so skipping
 * never helps in a tie. Safe to call twice for the same question.
 */
export function settlePlayer(game, player, answer) {
  if (!isInRound(game, player) || player.settledIndex >= game.index) return player
  const q = currentQuestion(game)
  const points = answer?.points ?? 0
  return {
    ...player,
    score:        player.score + points,
    timeMs:       player.timeMs + (answer ? Math.min(answer.elapsedMs, q.durationMs) : q.durationMs),
    settledIndex: game.index,
    lastPoints:   points,
    lastCorrect:  !!answer?.correct,
  }
}

/** Count accepted answers per option. */
export function tallyAnswers(answers, optionCount) {
  const counts = Array(optionCount).fill(0)
  for (const a of answers) if (a.accepted && a.option >= 0 && a.option < optionCount) counts[a.option]++
  return counts
}

// ── Ranking ──────────────────────────────────────────────────────────────────

/**
 * Sort players by score (high first), then total answer time (low first).
 * Players equal on both share a rank. Returns new objects with `rank`.
 */
export function rankPlayers(players) {
  const sorted = [...players].sort(comparePlayers)
  let rank = 0
  return sorted.map((p, i) => {
    const prev = sorted[i - 1]
    if (!prev || prev.score !== p.score || prev.timeMs !== p.timeMs) rank = i + 1
    return { ...p, rank }
  })
}

export function comparePlayers(a, b) {
  return (b.score - a.score)
      || (a.timeMs - b.timeMs)
      || (a.joinedAt - b.joinedAt)
      || (a.unitName < b.unitName ? -1 : a.unitName > b.unitName ? 1 : 0)
}

export function topN(ranked, n = 10) {
  return ranked.slice(0, n).map(p => ({ rank: p.rank, nickname: p.nickname, score: p.score }))
}

// ── Player view ──────────────────────────────────────────────────────────────

/**
 * What a (re)joining player should see right now. Sent in the JOIN reply.
 *   answer — this player's accepted answer to the current question, if any
 *   rank   — this player's rank from the last ranking, or null
 *   top10  — the last topN() result
 */
export function playerView(game, player, { answer, rank, top10, playerCount, now }) {
  const base = {
    title:       game.title,
    playerCount,
    nickname:    player.nickname,
    yourTotal:   player.score,
    yourRank:    rank,
  }
  const q = currentQuestion(game)
  const inRound = isInRound(game, player)

  switch (game.phase) {
    case PHASE.LOBBY:
      return { ...base, phase: PHASE.LOBBY }

    case PHASE.QUESTION:
      if (!inRound) return { ...base, phase: 'waiting' }
      return {
        ...base,
        phase:    PHASE.QUESTION,
        question: questionPayload(game, q, remainingMs(game, now)),
        answered: !!answer,
      }

    case PHASE.REVEAL:
      if (!inRound) return { ...base, phase: 'waiting' }
      return { ...base, phase: PHASE.REVEAL, reveal: revealPayload(q, player, rank) }

    case PHASE.LEADERBOARD:
      return { ...base, phase: PHASE.LEADERBOARD, top10 }

    case PHASE.END:
      return { ...base, phase: PHASE.END, top10 }

    default:
      return { ...base, phase: game.phase }
  }
}

/** QUESTION message input. Never includes the correct answer. */
export function questionPayload(game, q, remaining) {
  return {
    qid:         q.qid,
    index:       game.index,
    total:       game.questions.length,
    text:        q.text,
    options:     q.options,
    durationMs:  q.durationMs,
    remainingMs: Math.round(remaining),
  }
}

/** REVEAL message input for one player. */
export function revealPayload(q, player, rank) {
  return {
    qid:        q.qid,
    correct:    q.correct,
    yourPoints: player.lastPoints,
    yourTotal:  player.score,
    yourRank:   rank,
  }
}
