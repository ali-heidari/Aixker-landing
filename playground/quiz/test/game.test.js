import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as game from '../src/game.js'

const QUIZ = {
  title: 'Test',
  questions: [
    { qid: 'q1', text: 'One?',   options: ['a', 'b', 'c', 'd'], correct: 2, durationMs: 10_000 },
    { qid: 'q2', text: 'Two?',   options: ['a', 'b'],           correct: 0, durationMs: 20_000 },
    { qid: 'q3', text: 'Three?', options: ['a', 'b', 'c'],      correct: 1, durationMs: 5_000 },
  ],
}

function lobbyWith(...names) {
  let g = game.createGame(QUIZ)
  const players = new Map()
  names.forEach((name, i) => {
    const res = game.joinPlayer(g, null, { unitName: `u-${name}`, nickname: name }, false, i)
    players.set(res.player.unitName, res.player)
  })
  return { g, players }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

test('pointsFor: 1000 at once, 500 at the deadline, linear between', () => {
  assert.equal(game.pointsFor(0, 10_000), 1000)
  assert.equal(game.pointsFor(5_000, 10_000), 750)
  assert.equal(game.pointsFor(10_000, 10_000), 500)
  assert.equal(game.pointsFor(2_345, 10_000), Math.round(1000 * (1 - 0.5 * 0.2345)))
})

test('pointsFor: clamps to 500–1000 outside the window', () => {
  assert.equal(game.pointsFor(-50, 10_000), 1000)
  assert.equal(game.pointsFor(10_400, 10_000), 500)
})

test('scoreAnswer: correct answer scores by host receive time', () => {
  const { g: lobby, players } = lobbyWith('ann')
  const g = game.startQuestion(lobby, 1_000)
  const r = game.scoreAnswer(g, players.get('u-ann'), { qid: 'q1', option: 2 }, false, 3_000)
  assert.deepEqual(
    { accepted: r.accepted, late: r.late, correct: r.correct, points: r.points, elapsedMs: r.elapsedMs },
    { accepted: true, late: false, correct: true, points: 900, elapsedMs: 2_000 },
  )
})

test('scoreAnswer: wrong answer is accepted with 0 points', () => {
  const { g: lobby, players } = lobbyWith('ann')
  const g = game.startQuestion(lobby, 0)
  const r = game.scoreAnswer(g, players.get('u-ann'), { qid: 'q1', option: 0 }, false, 100)
  assert.equal(r.accepted, true)
  assert.equal(r.correct, false)
  assert.equal(r.points, 0)
})

test('scoreAnswer: inside the 500 ms grace counts, with minimum points', () => {
  const { g: lobby, players } = lobbyWith('ann')
  const g = game.startQuestion(lobby, 0)
  const r = game.scoreAnswer(g, players.get('u-ann'), { qid: 'q1', option: 2 }, false, 10_000 + game.GRACE_MS)
  assert.equal(r.accepted, true)
  assert.equal(r.points, 500)
})

test('scoreAnswer: after the grace window is late and scores 0', () => {
  const { g: lobby, players } = lobbyWith('ann')
  const g = game.startQuestion(lobby, 0)
  const r = game.scoreAnswer(g, players.get('u-ann'), { qid: 'q1', option: 2 }, false, 10_000 + game.GRACE_MS + 1)
  assert.equal(r.accepted, false)
  assert.equal(r.late, true)
  assert.equal(r.points, 0)
  assert.equal(r.reason, 'LATE')
})

test('scoreAnswer: answer after reveal is late', () => {
  const { g: lobby, players } = lobbyWith('ann')
  const g = game.revealQuestion(game.startQuestion(lobby, 0))
  const r = game.scoreAnswer(g, players.get('u-ann'), { qid: 'q1', option: 2 }, false, 100)
  assert.equal(r.accepted, false)
  assert.equal(r.late, true)
})

test('scoreAnswer: only the first answer counts', () => {
  const { g: lobby, players } = lobbyWith('ann')
  const g = game.startQuestion(lobby, 0)
  const first  = game.scoreAnswer(g, players.get('u-ann'), { qid: 'q1', option: 0 }, false, 100)
  const second = game.scoreAnswer(g, players.get('u-ann'), { qid: 'q1', option: 2 }, true, 200)
  assert.equal(first.accepted, true)
  assert.equal(second.accepted, false)
  assert.equal(second.late, false)
  assert.equal(second.reason, 'DUPLICATE')
})

test('scoreAnswer: rejects unknown questions, bad options and unknown players', () => {
  const { g: lobby, players } = lobbyWith('ann')
  const g = game.startQuestion(lobby, 0)
  const ann = players.get('u-ann')
  assert.equal(game.scoreAnswer(g, ann, { qid: 'nope', option: 0 }, false, 1).reason, 'UNKNOWN_QUESTION')
  assert.equal(game.scoreAnswer(g, ann, { qid: 'q2', option: 0 }, false, 1).reason, 'UNKNOWN_QUESTION')
  assert.equal(game.scoreAnswer(g, ann, { qid: 'q1', option: 4 }, false, 1).reason, 'BAD_OPTION')
  assert.equal(game.scoreAnswer(g, ann, { qid: 'q1', option: '1' }, false, 1).reason, 'BAD_OPTION')
  assert.equal(game.scoreAnswer(g, undefined, { qid: 'q1', option: 0 }, false, 1).reason, 'NOT_IN_ROUND')
})

test('settlePlayer: adds points and time once per question', () => {
  const { g: lobby, players } = lobbyWith('ann')
  const g = game.revealQuestion(game.startQuestion(lobby, 0))
  const answer = { accepted: true, correct: true, points: 900, elapsedMs: 2_000, option: 2 }
  const once  = game.settlePlayer(g, players.get('u-ann'), answer)
  const twice = game.settlePlayer(g, once, answer)
  assert.equal(once.score, 900)
  assert.equal(once.timeMs, 2_000)
  assert.equal(once.lastPoints, 900)
  assert.equal(twice, once)
})

test('settlePlayer: no answer adds the full duration to time', () => {
  const { g: lobby, players } = lobbyWith('ann')
  const g = game.revealQuestion(game.startQuestion(lobby, 0))
  const p = game.settlePlayer(g, players.get('u-ann'), undefined)
  assert.equal(p.score, 0)
  assert.equal(p.timeMs, 10_000)
})

test('settlePlayer: does not mutate the input player', () => {
  const { g: lobby, players } = lobbyWith('ann')
  const g = game.revealQuestion(game.startQuestion(lobby, 0))
  const before = players.get('u-ann')
  const copy = structuredClone(before)
  game.settlePlayer(g, before, { accepted: true, correct: true, points: 700, elapsedMs: 6_000, option: 2 })
  assert.deepEqual(before, copy)
})

// ── Joining ──────────────────────────────────────────────────────────────────

test('joinPlayer: new player in the lobby can answer from question 1', () => {
  const g = game.createGame(QUIZ)
  const res = game.joinPlayer(g, null, { unitName: 'u1', nickname: '  Ann  Lee ' }, false, 5)
  assert.equal(res.ok, true)
  assert.equal(res.restored, false)
  assert.equal(res.player.nickname, 'Ann Lee')
  assert.equal(res.player.firstIndex, 0)
})

test('joinPlayer: late joiner waits for the next question', () => {
  const g = game.startQuestion(game.createGame(QUIZ), 0)
  const res = game.joinPlayer(g, null, { unitName: 'late', nickname: 'Late' }, false, 50)
  assert.equal(res.player.firstIndex, 1)
  assert.equal(game.isInRound(g, res.player), false)
  assert.equal(game.scoreAnswer(g, res.player, { qid: 'q1', option: 2 }, false, 60).reason, 'NOT_IN_ROUND')
  assert.equal(game.playerView(g, res.player, { playerCount: 2, now: 60 }).phase, 'waiting')

  // ...and plays from the next question.
  const next = game.startQuestion(game.showLeaderboard(game.revealQuestion(g)), 20_000)
  assert.equal(game.isInRound(next, res.player), true)
  assert.equal(game.scoreAnswer(next, res.player, { qid: 'q2', option: 0 }, false, 21_000).accepted, true)
})

test('joinPlayer: rejects taken, empty and too-long nicknames', () => {
  const g = game.createGame(QUIZ)
  assert.equal(game.joinPlayer(g, null, { unitName: 'a', nickname: 'Ann' }, true, 0).reason, 'NICKNAME_TAKEN')
  assert.equal(game.joinPlayer(g, null, { unitName: 'a', nickname: '   ' }, false, 0).reason, 'NICKNAME_EMPTY')
  assert.equal(game.joinPlayer(g, null, { unitName: 'a', nickname: 'x'.repeat(21) }, false, 0).reason, 'NICKNAME_TOO_LONG')
  assert.equal(game.joinPlayer(g, null, { unitName: 'a', nickname: 'a\u0007b' }, false, 0).reason, 'NICKNAME_INVALID')
})

test('joinPlayer: new players cannot join a finished game', () => {
  const g = game.endGame(game.createGame(QUIZ))
  assert.equal(game.joinPlayer(g, null, { unitName: 'a', nickname: 'Ann' }, false, 0).reason, 'GAME_OVER')
})

test('rejoin restores the score and the current question', () => {
  const { g: lobby, players } = lobbyWith('ann')
  let g = game.startQuestion(lobby, 0)
  const answer = game.scoreAnswer(g, players.get('u-ann'), { qid: 'q1', option: 2 }, false, 1_000)
  g = game.revealQuestion(g)
  players.set('u-ann', game.settlePlayer(g, players.get('u-ann'), answer))
  g = game.startQuestion(game.showLeaderboard(g), 30_000)

  const res = game.joinPlayer(g, players.get('u-ann'), { unitName: 'u-ann', nickname: 'ignored', rejoin: true }, true, 31_000)
  assert.equal(res.ok, true)
  assert.equal(res.restored, true)
  assert.equal(res.player.score, 950)
  assert.equal(res.player.nickname, 'ann')

  const view = game.playerView(g, res.player, { rank: 1, top10: [], playerCount: 1, now: 34_000 })
  assert.equal(view.phase, 'question')
  assert.equal(view.yourTotal, 950)
  assert.equal(view.question.qid, 'q2')
  assert.equal(view.question.remainingMs, 16_000)
  assert.equal(view.answered, false)
  assert.equal('correct' in view.question, false)
})

test('rejoin during reveal shows that player\'s result', () => {
  const { g: lobby, players } = lobbyWith('ann')
  let g = game.startQuestion(lobby, 0)
  const answer = game.scoreAnswer(g, players.get('u-ann'), { qid: 'q1', option: 2 }, false, 0)
  g = game.revealQuestion(g)
  const ann = game.settlePlayer(g, players.get('u-ann'), answer)
  const view = game.playerView(g, ann, { rank: 1, top10: [], playerCount: 1, now: 1 })
  assert.equal(view.phase, 'reveal')
  assert.deepEqual(view.reveal, { qid: 'q1', correct: 2, yourPoints: 1000, yourTotal: 1000, yourRank: 1 })
})

test('rejoin works after the game ends', () => {
  const { g: lobby, players } = lobbyWith('ann')
  const g = game.endGame(lobby)
  const res = game.joinPlayer(g, players.get('u-ann'), { unitName: 'u-ann', nickname: 'ann' }, true, 1)
  assert.equal(res.ok, true)
  assert.equal(game.playerView(g, res.player, { top10: [], playerCount: 1, now: 1 }).phase, 'end')
})

// ── State machine ────────────────────────────────────────────────────────────

test('state machine: full game path', () => {
  let g = game.createGame(QUIZ)
  assert.equal(g.phase, 'lobby')
  for (let i = 0; i < QUIZ.questions.length; i++) {
    g = game.startQuestion(g, i * 100)
    assert.equal(g.phase, 'question')
    assert.equal(g.index, i)
    g = game.revealQuestion(g)
    assert.equal(g.phase, 'reveal')
    g = game.showLeaderboard(g)
    assert.equal(g.phase, 'leaderboard')
  }
  assert.equal(game.hasNextQuestion(g), false)
  assert.throws(() => game.startQuestion(g, 0), /No questions left/)
  g = game.endGame(g)
  assert.equal(g.phase, 'end')
})

test('state machine: rejects transitions out of order', () => {
  const lobby = game.createGame(QUIZ)
  assert.throws(() => game.revealQuestion(lobby))
  assert.throws(() => game.showLeaderboard(lobby))
  const q = game.startQuestion(lobby, 0)
  assert.throws(() => game.startQuestion(q, 0))
  assert.throws(() => game.showLeaderboard(q))
  assert.throws(() => game.endGame(game.endGame(q)))
})

test('state machine: transitions return new objects', () => {
  const lobby = game.createGame(QUIZ)
  const q = game.startQuestion(lobby, 0)
  assert.notEqual(q, lobby)
  assert.equal(lobby.phase, 'lobby')
  assert.equal(lobby.index, -1)
})

test('remainingMs counts down from the host start stamp', () => {
  const g = game.startQuestion(game.createGame(QUIZ), 1_000)
  assert.equal(game.remainingMs(g, 1_000), 10_000)
  assert.equal(game.remainingMs(g, 7_500), 3_500)
  assert.equal(game.remainingMs(g, 99_000), 0)
  assert.equal(game.remainingMs(game.revealQuestion(g), 1_000), 0)
})

// ── Ranking ──────────────────────────────────────────────────────────────────

const P = (unitName, score, timeMs, joinedAt = 0) => ({ unitName, nickname: unitName, score, timeMs, joinedAt })

test('rankPlayers: higher score first', () => {
  const r = game.rankPlayers([P('a', 500, 1), P('b', 900, 9), P('c', 700, 5)])
  assert.deepEqual(r.map(p => [p.unitName, p.rank]), [['b', 1], ['c', 2], ['a', 3]])
})

test('rankPlayers: same score, earlier total answer time ranks first', () => {
  const r = game.rankPlayers([P('slow', 800, 9_000), P('fast', 800, 3_000), P('mid', 800, 5_000)])
  assert.deepEqual(r.map(p => [p.unitName, p.rank]), [['fast', 1], ['mid', 2], ['slow', 3]])
})

test('rankPlayers: equal score and time share a rank', () => {
  const r = game.rankPlayers([P('a', 800, 3_000, 2), P('b', 800, 3_000, 1), P('c', 100, 1)])
  assert.deepEqual(r.map(p => [p.unitName, p.rank]), [['b', 1], ['a', 1], ['c', 3]])
})

test('rankPlayers: does not mutate its input', () => {
  const input = [P('a', 1, 1), P('b', 2, 2)]
  game.rankPlayers(input)
  assert.deepEqual(input.map(p => p.unitName), ['a', 'b'])
  assert.equal('rank' in input[0], false)
})

test('topN and tallyAnswers', () => {
  const ranked = game.rankPlayers([P('a', 3, 0), P('b', 2, 0), P('c', 1, 0)])
  assert.deepEqual(game.topN(ranked, 2), [{ rank: 1, nickname: 'a', score: 3 }, { rank: 2, nickname: 'b', score: 2 }])
  const answers = [
    { accepted: true, option: 0 }, { accepted: true, option: 2 },
    { accepted: true, option: 2 }, { accepted: false, option: 1 },
  ]
  assert.deepEqual(game.tallyAnswers(answers, 4), [1, 0, 2, 0])
})
