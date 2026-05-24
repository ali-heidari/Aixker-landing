const KEY_UUID  = 'dotsboxes.uuid'
const KEY_GAME  = 'dotsboxes.game'
const KEY_OPP   = 'dotsboxes.opponent'

export function getOrCreateUUID() {
  let id = localStorage.getItem(KEY_UUID)
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY_UUID, id) }
  return id
}

export function saveGameState(state, opponentUuid) {
  sessionStorage.setItem(KEY_GAME, JSON.stringify(state))
  sessionStorage.setItem(KEY_OPP,  opponentUuid)
}

export function loadGameState() {
  const raw = sessionStorage.getItem(KEY_GAME)
  if (!raw) return null
  return { state: JSON.parse(raw), opponentUuid: sessionStorage.getItem(KEY_OPP) }
}

export function clearGameState() {
  sessionStorage.removeItem(KEY_GAME)
  sessionStorage.removeItem(KEY_OPP)
}
