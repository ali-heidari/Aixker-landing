import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { parseQuiz, validateQuiz, DEFAULT_DURATION_MS } from '../src/questions.js'

const q = (over = {}) => ({ text: 'Q?', options: ['a', 'b'], correct: 0, durationMs: 10_000, ...over })
const quiz = (questions, over = {}) => ({ title: 'T', questions, ...over })

function errorsOf(raw) {
  const r = validateQuiz(raw)
  assert.equal(r.ok, false)
  return r.errors.join('\n')
}

test('the shipped sample quiz is valid', async () => {
  const text = await readFile(new URL('../samples/networking.json', import.meta.url), 'utf8')
  const r = parseQuiz(text)
  assert.equal(r.ok, true, r.errors?.join('\n'))
  assert.equal(r.quiz.questions.length, 10)
})

test('valid quiz is normalized with qids', () => {
  const r = validateQuiz(quiz([q({ text: '  First  ' }), q({ options: [' x ', 'y', 'z'], correct: 2 })]))
  assert.equal(r.ok, true)
  assert.deepEqual(r.quiz.questions.map(x => x.qid), ['q1', 'q2'])
  assert.equal(r.quiz.questions[0].text, 'First')
  assert.deepEqual(r.quiz.questions[1].options, ['x', 'y', 'z'])
})

test('durationMs defaults when missing', () => {
  const { durationMs, ...noDuration } = q()
  const r = validateQuiz(quiz([noDuration]))
  assert.equal(r.quiz.questions[0].durationMs, DEFAULT_DURATION_MS)
})

test('bad JSON gives a clear error', () => {
  const r = parseQuiz('{ "title": ')
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /Not valid JSON/)
})

test('rejects non-objects and missing fields', () => {
  assert.match(errorsOf(null), /JSON object/)
  assert.match(errorsOf([]), /JSON object/)
  assert.match(errorsOf({ questions: [q()] }), /"title"/)
  assert.match(errorsOf({ title: 'T' }), /"questions" must be an array/)
})

test('question count must be 1–50', () => {
  assert.match(errorsOf(quiz([])), /1–50 items \(found 0\)/)
  assert.match(errorsOf(quiz(Array.from({ length: 51 }, () => q()))), /found 51/)
  assert.equal(validateQuiz(quiz(Array.from({ length: 50 }, () => q()))).ok, true)
})

test('options must be 2–4 distinct non-empty strings', () => {
  assert.match(errorsOf(quiz([q({ options: ['a'] })])), /Question 1: "options" must have 2–4 items/)
  assert.match(errorsOf(quiz([q({ options: ['a', 'b', 'c', 'd', 'e'] })])), /found 5/)
  assert.match(errorsOf(quiz([q({ options: ['a', ''] })])), /option 2 must be a non-empty string/)
  assert.match(errorsOf(quiz([q({ options: ['a', 3] })])), /option 2/)
  assert.match(errorsOf(quiz([q({ options: ['Yes', 'yes'] })])), /different/)
  assert.match(errorsOf(quiz([q({ options: 'a,b' })])), /array of strings/)
})

test('correct must index an option', () => {
  assert.match(errorsOf(quiz([q({ correct: 2 })])), /"correct" must be an integer from 0 to 1/)
  assert.match(errorsOf(quiz([q({ correct: -1 })])), /"correct"/)
  assert.match(errorsOf(quiz([q({ correct: '0' })])), /"correct"/)
  assert.match(errorsOf(quiz([q({ correct: 0.5 })])), /"correct"/)
})

test('durationMs must be 5000–60000', () => {
  assert.match(errorsOf(quiz([q({ durationMs: 4_999 })])), /"durationMs" must be an integer from 5000 to 60000/)
  assert.match(errorsOf(quiz([q({ durationMs: 60_001 })])), /durationMs/)
  assert.match(errorsOf(quiz([q({ durationMs: '10000' })])), /durationMs/)
  assert.equal(validateQuiz(quiz([q({ durationMs: 5_000 }), q({ durationMs: 60_000 })])).ok, true)
})

test('errors name the question they belong to', () => {
  const text = errorsOf(quiz([q(), q({ text: '' }), q({ correct: 9 })]))
  assert.match(text, /Question 2: "text"/)
  assert.match(text, /Question 3: "correct"/)
  assert.doesNotMatch(text, /Question 1:/)
})

test('rejects over-long text', () => {
  assert.match(errorsOf(quiz([q({ text: 'x'.repeat(301) })])), /300 characters/)
  assert.match(errorsOf(quiz([q()], { title: 'x'.repeat(121) })), /120 characters/)
})
