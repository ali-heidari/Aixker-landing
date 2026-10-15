// sessionStorage helpers. One unit name per tab, kept across reloads so the
// coordinator credits the same contributor after a refresh.

import { randomId } from './pipes.js'

const KEY_UNIT = 'mandel.unit'
const KEY_NICK = 'mandel.nickname'
const UNIT_RE  = /^mandel-v-[a-z2-7]{12}$/

export function unitName() {
  try {
    const saved = sessionStorage.getItem(KEY_UNIT)
    if (saved && UNIT_RE.test(saved)) return saved
    const fresh = `mandel-v-${randomId(12)}`
    sessionStorage.setItem(KEY_UNIT, fresh)
    return fresh
  } catch {
    return `mandel-v-${randomId(12)}`   // storage blocked: new contributor per reload
  }
}

export function loadNickname() {
  try { return localStorage.getItem(KEY_NICK) ?? '' } catch { return '' }
}

export function saveNickname(nickname) {
  try { localStorage.setItem(KEY_NICK, nickname) } catch { /* ignore */ }
}
