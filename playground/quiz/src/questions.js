// Question-file validation. Pure — no DOM, no network.

export const LIMITS = {
  minQuestions:  1,
  maxQuestions:  50,
  minOptions:    2,
  maxOptions:    4,
  minDurationMs: 5_000,
  maxDurationMs: 60_000,
  maxTitle:      120,
  maxText:       300,
  maxOption:     120,
}

export const DEFAULT_DURATION_MS = 20_000

/**
 * Parse and validate quiz JSON text.
 * Returns { ok: true, quiz } or { ok: false, errors: string[] }.
 */
export function parseQuiz(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [`Not valid JSON: ${err.message}`] }
  }
  return validateQuiz(raw)
}

/**
 * Validate a quiz object and return a normalized copy.
 * Each question gets a stable qid ('q1', 'q2', …).
 */
export function validateQuiz(raw) {
  const errors = []

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['The file must contain a JSON object with "title" and "questions".'] }
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) errors.push('"title" must be a non-empty string.')
  else if (title.length > LIMITS.maxTitle) errors.push(`"title" must be ${LIMITS.maxTitle} characters or fewer.`)

  if (!Array.isArray(raw.questions)) {
    errors.push('"questions" must be an array.')
    return { ok: false, errors }
  }

  const n = raw.questions.length
  if (n < LIMITS.minQuestions || n > LIMITS.maxQuestions) {
    errors.push(`"questions" must have ${LIMITS.minQuestions}–${LIMITS.maxQuestions} items (found ${n}).`)
  }

  const questions = raw.questions.slice(0, LIMITS.maxQuestions).map((q, i) => _validateQuestion(q, i, errors))

  if (errors.length) return { ok: false, errors }
  return { ok: true, quiz: { title, questions } }
}

// ── Private ──────────────────────────────────────────────────────────────────

function _validateQuestion(q, i, errors) {
  const where = `Question ${i + 1}`

  if (!q || typeof q !== 'object' || Array.isArray(q)) {
    errors.push(`${where}: must be an object.`)
    return null
  }

  const text = typeof q.text === 'string' ? q.text.trim() : ''
  if (!text) errors.push(`${where}: "text" must be a non-empty string.`)
  else if (text.length > LIMITS.maxText) errors.push(`${where}: "text" must be ${LIMITS.maxText} characters or fewer.`)

  let options = []
  if (!Array.isArray(q.options)) {
    errors.push(`${where}: "options" must be an array of strings.`)
  } else {
    if (q.options.length < LIMITS.minOptions || q.options.length > LIMITS.maxOptions) {
      errors.push(`${where}: "options" must have ${LIMITS.minOptions}–${LIMITS.maxOptions} items (found ${q.options.length}).`)
    }
    options = q.options.map(o => (typeof o === 'string' ? o.trim() : ''))
    options.forEach((o, j) => {
      if (!o) errors.push(`${where}: option ${j + 1} must be a non-empty string.`)
      else if (o.length > LIMITS.maxOption) errors.push(`${where}: option ${j + 1} must be ${LIMITS.maxOption} characters or fewer.`)
    })
    const seen = new Set(options.filter(Boolean).map(o => o.toLowerCase()))
    if (seen.size !== options.filter(Boolean).length) errors.push(`${where}: options must be different from each other.`)
  }

  const maxIndex = Math.max(options.length - 1, 0)
  if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > maxIndex) {
    errors.push(`${where}: "correct" must be an integer from 0 to ${maxIndex} (the index of the right option).`)
  }

  let durationMs = DEFAULT_DURATION_MS
  if (q.durationMs !== undefined) {
    if (!Number.isInteger(q.durationMs) || q.durationMs < LIMITS.minDurationMs || q.durationMs > LIMITS.maxDurationMs) {
      errors.push(`${where}: "durationMs" must be an integer from ${LIMITS.minDurationMs} to ${LIMITS.maxDurationMs}.`)
    } else {
      durationMs = q.durationMs
    }
  }

  return { qid: `q${i + 1}`, text, options, correct: q.correct, durationMs }
}
