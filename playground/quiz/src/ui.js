// Shared DOM helpers for the host and player pages.

// Each option has a colour, a shape and a letter, so no one has to tell
// options apart by colour alone.
export const OPTION_STYLES = [
  { letter: 'A', shape: '▲', name: 'triangle' },
  { letter: 'B', shape: '◆', name: 'diamond'  },
  { letter: 'C', shape: '●', name: 'circle'   },
  { letter: 'D', shape: '■', name: 'square'   },
]

let _toastTimer = null

export function $(id) {
  return document.getElementById(id)
}

/** Show the section with data-screen="name" and hide the others. */
export function showScreen(name) {
  for (const el of document.querySelectorAll('section[data-screen]')) {
    el.hidden = el.dataset.screen !== name
  }
  document.body.dataset.view = name
}

export function showToast(message, durationMs = 3000) {
  const el = $('toast')
  if (!el) return
  el.textContent = message
  el.hidden = false
  clearTimeout(_toastTimer)
  _toastTimer = setTimeout(() => { el.hidden = true }, durationMs)
}

export function announce(message) {
  const el = $('announcer')
  if (!el) return
  el.textContent = ''
  requestAnimationFrame(() => { el.textContent = message })
}

/** Build an element: el('li', { class: 'x' }, 'text', childEl). Text is never parsed as HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : String(child))
  }
  return node
}

/** The coloured shape + letter badge for option i. */
export function optionBadge(i) {
  const s = OPTION_STYLES[i]
  return el('span', { class: 'opt-badge', 'aria-hidden': 'true' },
    el('span', { class: 'opt-shape' }, s.shape),
    el('span', { class: 'opt-letter' }, s.letter),
  )
}

/** Accessible label for option i, e.g. "A (triangle): XDP". */
export function optionLabel(i, text) {
  const s = OPTION_STYLES[i]
  return `${s.letter} (${s.name}): ${text}`
}

/** Render a list of top players into an <ol>. */
export function renderTopList(listEl, top, highlightRank = null) {
  listEl.replaceChildren(...top.map(p => el('li', { class: p.rank === highlightRank ? 'me' : null },
    el('span', { class: 'rank' }, `#${p.rank}`),
    el('span', { class: 'nick' }, p.nickname),
    el('span', { class: 'score' }, formatScore(p.score)),
  )))
}

export function formatScore(n) {
  return Number(n ?? 0).toLocaleString('en-US')
}

export function formatSeconds(ms) {
  return String(Math.ceil(Math.max(0, ms) / 1000))
}

/** Same behaviour and storage key as the landing page's theme toggle. */
export function initThemeToggle(button) {
  if (!button) return
  const html = document.documentElement
  const sync = () => {
    const dark = html.classList.contains('dark')
    button.textContent = dark ? '☀' : '☾'
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode')
  }
  button.addEventListener('click', () => {
    const toLight = html.classList.contains('dark')
    html.classList.replace(toLight ? 'dark' : 'light', toLight ? 'light' : 'dark')
    try { localStorage.setItem('theme', toLight ? 'light' : 'dark') } catch { /* private mode */ }
    sync()
  })
  sync()
}
