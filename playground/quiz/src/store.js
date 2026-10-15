// sessionStorage helpers. A player who refreshes or reconnects rejoins as
// the same unit, so the host gives back their score.

const KEY_SESSION = 'quiz.session'

/** session = { pin, unitName, nickname, token } */
export function saveSession(session) {
  try {
    sessionStorage.setItem(KEY_SESSION, JSON.stringify(session))
  } catch { /* storage blocked: rejoin after refresh will not work */ }
}

export function loadSession() {
  try {
    const raw = sessionStorage.getItem(KEY_SESSION)
    const s = raw ? JSON.parse(raw) : null
    if (s && /^\d{6}$/.test(s.pin) && s.unitName && s.token) return s
  } catch { /* fall through */ }
  return null
}

export function clearSession() {
  try { sessionStorage.removeItem(KEY_SESSION) } catch { /* ignore */ }
}
