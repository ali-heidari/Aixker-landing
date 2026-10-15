import { createPipe, fetchToken } from './pipes.js'
import { decodeCounts } from './codec.js'
import { createTileCanvas } from './canvas.js'
import { createContributor } from './contribute.js'
import * as store from './store.js'

const HUB_URL     = window.__PIPESHUB_URL__
const AUTH_URL    = window.__PIPESHUB_AUTH_URL__
const COORDINATOR = 'mandel-coordinator'

const HELLO_TIMEOUT_MS = 8_000
const HELLO_RETRY_MS   = 5_000

const $ = id => document.getElementById(id)

const unit  = store.unitName()
const tiles = createTileCanvas($('canvas'))

let pipe        = null
let contributor = null
let myId        = null    // contributorId the coordinator gave this tab
let role        = 'viewer'
let mine        = 0       // tiles computed by this tab in this job
let helloTimer  = null

// ── Connection ───────────────────────────────────────────────────────────────

async function boot() {
  setupTheme()
  setupContribute()
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
    setStatus(err?.code === 'CONNECT_TIMEOUT' || err?.code === 'AUTH_TIMEOUT'
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

/** Register with the coordinator; repeat until it answers. Resolves to true if it did. */
async function hello() {
  clearTimeout(helloTimer)
  try {
    const res = await pipe.ask(COORDINATOR, 'HELLO',
      { nickname: $('nickname').value, role }, { timeoutMs: HELLO_TIMEOUT_MS })
    if (!res?.ok) throw new Error(res?.reason ?? 'rejected')
    myId = res.contributorId
    document.documentElement.style.setProperty('--me', res.color)
    if (tiles.job?.jobId !== res.job.jobId) startJob(res.job)
    setStatus('')
    return true
  } catch {
    setStatus('Waiting for the coordinator…')
    helloTimer = setTimeout(hello, HELLO_RETRY_MS)
    return false
  }
}

function onMessage({ operation, input, senderId }) {
  if (senderId !== COORDINATOR) return   // stops mistakes, not attacks: senderId is unchecked
  if (operation === 'TILE_DONE') onTilesDone(input)
}

// ── Job and tiles ────────────────────────────────────────────────────────────

function startJob(job) {
  tiles.setJob(job)
  mine = 0
  $('job-name').textContent = job.name
  $('job-meta').textContent = `${job.width}×${job.height} · ${job.tileCount} tiles · max ${job.maxIter} iterations`
  updateProgress()
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

function updateProgress() {
  const job = tiles.job
  if (!job) return
  const done = tiles.doneCount
  $('progress-text').textContent = `${done} / ${job.tileCount} tiles`
  $('progress-bar').style.transform = `scaleX(${done / job.tileCount})`
  $('mine').textContent = String(mine)
  $('share').textContent = done ? `${((mine / job.tileCount) * 100).toFixed(1)}%` : '0%'
}

// ── Contribute CPU ───────────────────────────────────────────────────────────

function setupContribute() {
  $('nickname').value = store.loadNickname()
  const max = Math.max(1, (navigator.hardwareConcurrency ?? 2) - 1)
  for (let n = 1; n <= max; n++) $('threads').append(new Option(n === 1 ? '1 thread' : `${n} threads`, n))
  $('threads').addEventListener('change', () => contributor?.setThreads(Number($('threads').value)))
  $('contribute-form').addEventListener('submit', e => { e.preventDefault(); toggleContribute() })
}

async function toggleContribute() {
  if (contributor?.running) {
    contributor.stop()
    contributor = null
    role = 'viewer'
    renderContribute()
    hello()
    return
  }
  store.saveNickname($('nickname').value.trim())
  role = 'worker'
  if (!(await hello())) { role = 'viewer'; return }
  contributor = createContributor({
    pipe,
    coordinator: COORDINATOR,
    threads:     Number($('threads').value),
    makeWorker:  () => new Worker(new URL('./compute-worker.js', import.meta.url), { type: 'module' }),
    onEvent,
  })
  contributor.start()
  renderContribute()
}

function onEvent(type, detail) {
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

// ── Misc ─────────────────────────────────────────────────────────────────────

function setStatus(text) {
  $('status').textContent = text
  $('status').hidden = !text
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
