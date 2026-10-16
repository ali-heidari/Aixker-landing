import { createPipe, fetchToken } from './pipes.js'
import { decodeCounts } from './codec.js'
import { createTileCanvas } from './canvas.js'
import { createContributor } from './contribute.js'
import * as store from './store.js'

const HUB_URL     = window.__PIPESHUB_URL__
const AUTH_URL    = window.__PIPESHUB_AUTH_URL__
const COORDINATOR = 'mandel-coordinator'

const HELLO_TIMEOUT_MS   = 8_000
const HELLO_RETRY_MS     = 5_000
const KEEPALIVE_MS       = 30_000   // the coordinator drops viewers silent for 75 s

const METRIC_LABELS = [
  ['activeWorkers',    'Active workers'],
  ['viewers',          'Viewers'],
  ['overflowViewers',  'Viewers over the cap'],
  ['tilesPerSecond',   'Tiles per second'],
  ['turnaroundP50Ms',  'Tile turnaround p50', 'ms'],
  ['turnaroundP95Ms',  'Tile turnaround p95', 'ms'],
  ['leaseSeconds',     'Lease length', 's'],
  ['leased',           'Tiles leased now'],
  ['leaseExpiries',    'Lease expiries'],
  ['retries',          'Retries'],
  ['failedTiles',      'Tiles failed (5 expiries)'],
  ['released',         'Leases given back'],
  ['duplicates',       'Duplicates dropped'],
  ['rejectedStale',    'Stale results rejected'],
  ['rejectedInvalid',  'Invalid results rejected'],
  ['backupsIssued',    'Backup tasks issued'],
  ['backupsWon',       'Backup tasks won'],
  ['verifyChecks',     'Verification checks'],
  ['verifyMismatches', 'Verification mismatches'],
  ['suspects',         'Suspect contributors'],
  ['fanoutMsLast',     'Fan-out, last batch', 'ms'],
  ['fanoutMsP95',      'Fan-out p95', 'ms'],
  ['viewersDropped',   'Silent viewers dropped'],
  ['jobsFinished',     'Images finished'],
]

const $ = id => document.getElementById(id)

const unit   = store.unitName()
const people = new Map()   // contributorId → { nickname, color }
const tiles  = createTileCanvas($('canvas'), $('overlay'), id => people.get(id)?.color)

let pipe         = null
let contributor  = null
let myId         = null      // contributorId the coordinator gave this tab
let role         = 'viewer'
let mine         = 0         // tiles computed by this tab in this job
let helloTimer   = null
let helloRunning = null      // the HELLO in flight, so callers share it
let leaving      = false     // pagehide sent BYE
let lastStats    = null
let board        = 'job'     // leaderboard tab: 'job' | 'all'
const notes      = new Map() // key → text shown under the image

// ── Connection ───────────────────────────────────────────────────────────────

async function boot() {
  setupTheme()
  setupContribute()
  setupView()
  // Give leases back at once instead of letting them run out. Best effort:
  // a crashed tab sends nothing, and its leases expire instead.
  addEventListener('pagehide', () => {
    leaving = true                  // nothing may HELLO us back in after this
    contributor?.setPaused(true)
    pipe?.request(COORDINATOR, 'BYE')
  })
  addEventListener('pageshow', e => {
    if (!e.persisted) return       // restored from the back/forward cache
    leaving = false
    contributor?.setPaused(document.hidden)
    if (pipe?.isReady()) hello()
  })
  setInterval(() => { if (pipe?.isReady()) hello() }, KEEPALIVE_MS)

  pipe = createPipe({
    hubUrl:   HUB_URL,
    unitName: unit,
    getToken: () => fetchToken(AUTH_URL, unit),
    onMessage,
    onStatus,
  })
  try {
    await pipe.connect()
  } catch (err) {
    setNote('offline', err?.code === 'CONNECT_TIMEOUT' || err?.code === 'AUTH_TIMEOUT'
      ? 'Could not reach the hub. Reload to try again.'
      : 'Could not connect to the hub.')
  }
}

function onStatus(status) {
  const conn = $('conn')
  conn.dataset.state = status
  conn.textContent = { ready: 'online', connecting: 'connecting', disconnected: 'offline', error: 'offline' }[status] ?? status
  if (status === 'ready') hello()
}

/**
 * Register with the coordinator, or tell it we are still here. Sends the job
 * we show and how many tiles we have, so it only resends tiles if we are
 * missing some. Repeats until the coordinator answers; resolves to true if
 * it did.
 */
function hello({ fresh = false } = {}) {
  if (fresh && helloRunning) return helloRunning.then(() => hello())   // it may carry the old role
  helloRunning ??= sayHello().finally(() => { helloRunning = null })
  return helloRunning
}

async function sayHello() {
  clearTimeout(helloTimer)
  if (leaving) return false
  try {
    const res = await pipe.ask(COORDINATOR, 'HELLO', {
      nickname: $('nickname').value,
      role,
      jobId: tiles.job?.jobId,
      have:  tiles.doneCount,
    }, { timeoutMs: HELLO_TIMEOUT_MS })
    if (!res?.ok) throw new Error(res?.reason ?? 'rejected')
    myId = res.contributorId
    people.set(myId, { nickname: $('nickname').value || 'anonymous', color: res.color })
    document.documentElement.style.setProperty('--me', res.color)
    if (tiles.job?.jobId !== res.job.jobId) startJob(res.job)
    setNote('offline', '')
    setNote('overflow', res.overflow
      ? 'A lot of people are watching right now, so this tab gets the numbers only. Reload in a while to see the image.'
      : '')
    return true
  } catch {
    setNote('offline', 'Waiting for the coordinator…')
    helloTimer = setTimeout(hello, HELLO_RETRY_MS)
    return false
  }
}

function onMessage({ operation, input, senderId }) {
  if (senderId !== COORDINATOR) return   // stops mistakes, not attacks: senderId is unchecked
  if (operation === 'TILE_DONE') onTilesDone(input)
  else if (operation === 'JOB') onJob(input)
  else if (operation === 'STATS') onStats(input)
}

// ── Job and tiles ────────────────────────────────────────────────────────────

function startJob(job) {
  tiles.setJob(job)
  mine = 0
  $('job-name').textContent = job.name
  $('job-meta').textContent = `${job.width}×${job.height} · ${job.tileCount} tiles · max ${job.maxIter} iterations`
  setNote('resting', '')
  updateProgress()
}

function onJob(job) {
  if (!job?.jobId || job.jobId === tiles.job?.jobId) return
  startJob(job)
}

function onTilesDone({ jobId, tiles: batch }) {
  if (!tiles.job || jobId !== tiles.job.jobId || !Array.isArray(batch)) return
  for (const t of batch) {
    if (tiles.has(t.tileId)) continue
    let counts
    try { counts = decodeCounts(t.data) } catch { continue }
    tiles.drawTile(t.tileId, counts, t.contributorId)
  }
  updateProgress()
}

/** done: tiles to show as finished; a tab over the viewer cap has none drawn, so it uses STATS. */
function updateProgress(done = tiles.doneCount) {
  const job = tiles.job
  if (!job) return
  $('progress-text').textContent = `${done} / ${job.tileCount} tiles`
  $('progress-bar').style.transform = `scaleX(${done / job.tileCount})`
  $('mine').textContent = String(mine)
  $('share').textContent = `${((mine / job.tileCount) * 100).toFixed(1)}%`
}

// ── STATS: outlines, leaderboard, metrics ────────────────────────────────────

function onStats(stats) {
  if (!stats || typeof stats !== 'object') return
  lastStats = stats
  for (const [id, [nickname, color]] of Object.entries(stats.people ?? {})) people.set(id, { nickname, color })
  if (tiles.job && stats.jobId !== tiles.job.jobId) { hello(); return }   // missed a JOB
  if (stats.overflow && Number.isInteger(stats.done)) updateProgress(stats.done)
  tiles.refreshColors()
  tiles.drawLeased(Array.isArray(stats.leased) ? stats.leased : [])
  setNote('resting', Number.isFinite(stats.nextJobInMs)
    ? `Done! The next image starts in ${Math.ceil(stats.nextJobInMs / 1000)} s.` : '')
  renderBoard()
  renderMetrics()
}

function renderBoard() {
  const rows = lastStats?.leaderboard?.[board] ?? []
  const list = $('board-list')
  list.replaceChildren(...rows.map(([id, count]) => {
    const p = people.get(id)
    const color = /^#[0-9a-f]{6}$/i.test(p?.color ?? '') ? p.color : '#888888'   // STATS is unauthenticated
    const li = el('li', { class: id === myId ? 'me' : null },
      el('span', { class: 'swatch', style: `background:${color}` }),
      el('span', { class: 'who' }, p?.nickname ?? id),
      el('span', { class: 'mono' }, String(count)))
    return li
  }))
  $('board-empty').hidden = rows.length > 0
}

function renderMetrics() {
  const m = lastStats?.metrics
  if (!m || $('metrics').hidden) return
  $('metrics-list').replaceChildren(...METRIC_LABELS
    .filter(([key]) => key in m)
    .flatMap(([key, label, unitText]) => [
      el('dt', {}, label),
      el('dd', { class: 'mono' }, m[key] === null ? '–' : `${m[key]}${unitText ? ` ${unitText}` : ''}`),
    ]))
}

// ── Contribute CPU ───────────────────────────────────────────────────────────

function setupContribute() {
  $('nickname').value = store.loadNickname()
  const max = Math.max(1, (navigator.hardwareConcurrency ?? 2) - 1)
  for (let n = 1; n <= max; n++) $('threads').append(new Option(n === 1 ? '1 thread' : `${n} threads`, n))
  $('threads').addEventListener('change', () => contributor?.setThreads(Number($('threads').value)))
  $('contribute-form').addEventListener('submit', e => { e.preventDefault(); toggleContribute() })
  // Hidden tabs get throttled anyway; stop asking for work until we are back.
  document.addEventListener('visibilitychange', () => {
    if (!contributor?.running) return
    contributor.setPaused(document.hidden)
    setNote('paused', document.hidden ? 'Computing is paused while this tab is hidden.' : '')
  })
}

async function toggleContribute() {
  if (contributor?.running) {
    contributor.stop()
    contributor = null
    role = 'viewer'
    setNote('paused', '')
    renderContribute()
    hello({ fresh: true })
    return
  }
  store.saveNickname($('nickname').value.trim())
  role = 'worker'
  if (!(await hello({ fresh: true }))) { role = 'viewer'; return }
  contributor = createContributor({
    pipe,
    coordinator: COORDINATOR,
    threads:     Number($('threads').value),
    makeWorker:  () => new Worker(new URL('./compute-worker.js', import.meta.url), { type: 'module' }),
    onEvent,
  })
  contributor.start()
  contributor.setPaused(document.hidden)
  renderContribute()
}

function onEvent(type, detail) {
  if (type === 'forgotten') { hello(); return }
  if (type === 'submitted' && detail.accepted && detail.task.jobId === tiles.job?.jobId) {
    mine++
    updateProgress()
  }
}

function renderContribute() {
  const on = !!contributor?.running
  $('contribute-btn').textContent = on ? 'Stop contributing' : 'Contribute CPU'
  $('contribute-btn').classList.toggle('btn-primary', !on)
  $('nickname').disabled = on
  $('my-stats').hidden = !on
}

// ── View controls ────────────────────────────────────────────────────────────

function setupView() {
  for (const b of document.querySelectorAll('[data-mode]')) {
    b.addEventListener('click', () => {
      tiles.setMode(b.dataset.mode)
      for (const o of document.querySelectorAll('[data-mode]')) o.setAttribute('aria-pressed', String(o === b))
    })
  }
  for (const b of document.querySelectorAll('[data-board]')) {
    b.addEventListener('click', () => {
      board = b.dataset.board
      for (const o of document.querySelectorAll('[data-board]')) o.setAttribute('aria-selected', String(o === b))
      renderBoard()
    })
  }
  $('metrics-btn').addEventListener('click', toggleMetrics)
  $('metrics-close').addEventListener('click', toggleMetrics)
  document.addEventListener('keydown', e => {
    if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey
        && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) toggleMetrics()
  })
  $('save-btn').addEventListener('click', savePng)
}

function toggleMetrics() {
  $('metrics').hidden = !$('metrics').hidden
  $('metrics-btn').setAttribute('aria-pressed', String(!$('metrics').hidden))
  renderMetrics()
}

function savePng() {
  if (!tiles.job) return
  $('canvas').toBlob(blob => {
    if (!blob) return
    const a = el('a', { href: URL.createObjectURL(blob), download: `mandelbrot-${tiles.job.jobId}-${tiles.mode}.png` })
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }, 'image/png')
}

// ── Misc ─────────────────────────────────────────────────────────────────────

function setNote(key, text) {
  if (text) notes.set(key, text)
  else notes.delete(key)
  $('status').textContent = [...notes.values()].join(' ')
  $('status').hidden = notes.size === 0
}

/** Build an element: el('li', { class: 'x' }, 'text', childEl). Text is never parsed as HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') node.className = v
    else node.setAttribute(k, v)
  }
  for (const child of children) node.append(child instanceof Node ? child : String(child))
  return node
}

function setupTheme() {
  const html = document.documentElement
  const button = $('theme-toggle')
  const sync = () => {
    const dark = html.classList.contains('dark')
    button.textContent = dark ? '☀' : '☾'
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode')
  }
  button.addEventListener('click', () => {
    const toLight = html.classList.contains('dark')
    html.classList.replace(toLight ? 'dark' : 'light', toLight ? 'light' : 'dark')
    try { localStorage.setItem('theme', toLight ? 'light' : 'dark') } catch { /* ignore */ }
    sync()
  })
  sync()
}

boot()
