const KEY_GAME = 'dotsboxes.game'
const KEY_OPP  = 'dotsboxes.opponent'

function generateUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for non-HTTPS contexts
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

// Generated once per page load, kept only in memory.
// localStorage and sessionStorage are both shared across same-origin iframes
// in the same tab, so storage-based UUIDs collide in the playground.
// A module-level variable is scoped to each iframe's own JS context.
const _uuid = generateUUID();

export function getOrCreateUUID() {
  return _uuid;
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
