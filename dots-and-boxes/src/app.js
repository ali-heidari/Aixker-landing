
import * as game  from './game.js'
import * as ui    from './ui.js'
import * as pipes from './pipes.js'
import * as store from './store.js'


const GRID = 4

// ── State ────────────────────────────────────────────────────────────────────

let myUuid       = null
let myRole       = null   // 'A' | 'B'
let opponentUuid = null
let state        = null
let reconnectTimer = null

// ── DOM refs ─────────────────────────────────────────────────────────────────

const $myUuid       = document.getElementById('my-uuid')
const $copyUuid     = document.getElementById('copy-uuid')
const $opponentUuid = document.getElementById('opponent-uuid')
const $connectBtn   = document.getElementById('connect-btn')
const $connectStatus= document.getElementById('connect-status')
const $connectPanel = document.getElementById('connect-panel')
const $gamePanel    = document.getElementById('game-panel')
const $boardContainer = document.getElementById('board-container')
const $scoreA       = document.getElementById('score-a')
const $scoreB       = document.getElementById('score-b')
const $turnStatus   = document.getElementById('turn-status')

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  myUuid = store.getOrCreateUUID()
  $myUuid.textContent = myUuid

  $copyUuid.addEventListener('click', () => {
    navigator.clipboard?.writeText(myUuid)
    ui.showToast('ID copied to clipboard')
  })

  $connectBtn.addEventListener('click', onChallengeClick)

  setConnectStatus('<span class="spinner"></span>Connecting…', false)
  try {
    await pipes.connect(`player-${myUuid}`, handleInboundMessage)
    setConnectStatus('Connected. Enter an opponent UUID to challenge.')
  } catch {
    setConnectStatus('Could not connect to PipesHub. Retrying…')
    scheduleReconnect()
    return
  }

  document.addEventListener('pipes-disconnect', onDisconnect)
  document.addEventListener('pipes-error', e => ui.showToast(`Connection error: ${e.detail?.message ?? 'unknown'}`))

  const saved = store.loadGameState()
  if (saved) offerResume(saved)
}

// ── Challenge flow ────────────────────────────────────────────────────────────

async function onChallengeClick() {
  const target = $opponentUuid.value.trim()
  if (!target) { ui.showToast('Enter an opponent UUID first'); return }

  $connectBtn.disabled = true
  setConnectStatus('<span class="spinner"></span>Challenging…', false)

  try {
    const res = await pipes.challenge(`player-${target}`, {
      type: 'CHALLENGE', from: myUuid, grid: GRID,
    })
    if (res?.type === 'ACCEPT') {
      startGame({ role: 'A', opponentUuid: target, grid: GRID })
    } else {
      setConnectStatus('Challenge declined.')
      $connectBtn.disabled = false
    }
  } catch (err) {
    if (err?.code === 'TIMEOUT') setConnectStatus('No response — challenge timed out.')
    else setConnectStatus('Challenge failed.')
    $connectBtn.disabled = false
  }
}

// ── Inbound message dispatcher ────────────────────────────────────────────────

function handleInboundMessage(msg) {
  switch (msg.type) {
    case 'CHALLENGE':      handleInboundChallenge(msg); break
    case 'MOVE':           handleInboundMove(msg);       break
    case 'RESIGN':         handleResign();                break
    case 'REMATCH_REQUEST': handleRematchRequest();       break
    case 'REMATCH_ACCEPT': if (opponentUuid) startGame({ role: myRole === 'A' ? 'B' : 'A', opponentUuid, grid: GRID }); break
    default: break
  }
}

function handleInboundChallenge(msg) {
  ui.showOverlay(`
    <h2>Challenge!</h2>
    <p>Player <code>${msg.from}</code> wants to play a ${msg.grid ?? GRID}×${msg.grid ?? GRID} game.</p>
    <div class="overlay-actions">
      <button class="btn-primary" id="ov-accept">Accept</button>
      <button class="btn-outline" id="ov-decline">Decline</button>
    </div>
  `)
  document.getElementById('ov-accept').onclick = () => {
    msg._raw.input.pushResponse({ type: 'ACCEPT' })
    ui.hideOverlay()
    startGame({ role: 'B', opponentUuid: msg.from, grid: msg.grid ?? GRID })
  }
  document.getElementById('ov-decline').onclick = () => {
    msg._raw.input.pushResponse({ type: 'DECLINE' })
    ui.hideOverlay()
  }
}

function handleInboundMove(msg) {
  if (!state) return
  const move = { axis: msg.axis, row: msg.row, col: msg.col }
  if (!game.isValidMove(state, move)) return
  const { newState } = game.applyMove(state, move)
  state = newState
  ui.updateBoard(state)
  updateScoreUI()
  ui.announce(`Opponent drew an edge. Score: A ${state.scoreA} – B ${state.scoreB}`)
  store.saveGameState(state, opponentUuid)
  if (game.isGameOver(state)) { endGame(); return }
  ui.setDisabled(state.turn !== myRole)
  updateTurnStatus()
}

function handleResign() {
  ui.showOverlay(`
    <h2>Opponent resigned</h2>
    <p>You win!</p>
    <div class="overlay-actions"><button class="btn-primary" id="ov-new">New game</button></div>
  `)
  document.getElementById('ov-new').onclick = resetToLobby
  store.clearGameState()
}

function handleRematchRequest() {
  ui.showOverlay(`
    <h2>Rematch?</h2>
    <p>Your opponent wants a rematch.</p>
    <div class="overlay-actions">
      <button class="btn-primary" id="ov-rematch-yes">Accept</button>
      <button class="btn-outline"  id="ov-rematch-no">Decline</button>
    </div>
  `)
  document.getElementById('ov-rematch-yes').onclick = () => {
    pipes.send(`player-${opponentUuid}`, { type: 'REMATCH_ACCEPT' })
    ui.hideOverlay()
    startGame({ role: myRole === 'A' ? 'B' : 'A', opponentUuid, grid: GRID })
  }
  document.getElementById('ov-rematch-no').onclick = () => {
    ui.hideOverlay()
    resetToLobby()
  }
}

// ── Game lifecycle ────────────────────────────────────────────────────────────

function startGame(config) {
  myRole       = config.role
  opponentUuid = config.opponentUuid
  state        = game.createState(config.grid ?? GRID)

  $connectPanel.hidden = true
  $gamePanel.hidden    = false

  ui.renderBoard($boardContainer, state, {
    onEdgeClick: handleEdgeClick,
    disabled:    myRole !== state.turn,
  })
  $boardContainer.querySelector('#board').addEventListener('edge-click', e => handleEdgeClick(e.detail))

  updateScoreUI()
  updateTurnStatus()
  store.saveGameState(state, opponentUuid)
}

function handleEdgeClick({ axis, row, col }) {
  if (!state || state.turn !== myRole) return
  const move = { axis, row, col }
  if (!game.isValidMove(state, move)) return

  const { newState } = game.applyMove(state, move)
  state = newState
  ui.updateBoard(state)
  updateScoreUI()
  pipes.sendMove(`player-${opponentUuid}`, move)
  ui.announce(`You drew an edge. Score: A ${state.scoreA} – B ${state.scoreB}`)
  store.saveGameState(state, opponentUuid)
  if (game.isGameOver(state)) { endGame(); return }
  ui.setDisabled(state.turn !== myRole)
  updateTurnStatus()
}

function endGame() {
  store.clearGameState()
  const { winner, scoreA, scoreB } = state
  const msg = winner === 'tie'
    ? 'It\'s a tie!'
    : winner === myRole ? 'You win! 🎉' : 'Opponent wins.'
  ui.showOverlay(`
    <h2>${msg}</h2>
    <p>A: ${scoreA} &nbsp;–&nbsp; B: ${scoreB}</p>
    <div class="overlay-actions">
      <button class="btn-primary" id="ov-rematch">Rematch</button>
      <button class="btn-outline"  id="ov-lobby">Lobby</button>
    </div>
  `)
  document.getElementById('ov-rematch').onclick = () => {
    pipes.send(`player-${opponentUuid}`, { type: 'REMATCH_REQUEST' })
    ui.showOverlay('<p>Waiting for opponent to accept…</p>')
  }
  document.getElementById('ov-lobby').onclick = resetToLobby
}

// ── Disconnect recovery ───────────────────────────────────────────────────────

function onDisconnect() {
  if (!state) return
  ui.showOverlay('<p><span class="spinner"></span>Reconnecting…</p>')
  let elapsed = 0
  reconnectTimer = setInterval(async () => {
    elapsed += 5
    if (elapsed > 60) {
      clearInterval(reconnectTimer)
      ui.showOverlay(`
        <h2>Connection lost</h2>
        <p>Could not reconnect. You win by default.</p>
        <div class="overlay-actions"><button class="btn-primary" id="ov-lobby2">Lobby</button></div>
      `)
      document.getElementById('ov-lobby2').onclick = resetToLobby
      return
    }
    try {
      await pipes.connect(`player-${myUuid}`, handleInboundMessage)
      clearInterval(reconnectTimer)
      ui.hideOverlay()
    } catch { /* keep retrying */ }
  }, 5000)
}

// ── Resume saved game ─────────────────────────────────────────────────────────

function offerResume({ state: savedState, opponentUuid: savedOpp }) {
  ui.showOverlay(`
    <h2>Resume game?</h2>
    <p>You have an unfinished game against <code>${savedOpp}</code>.</p>
    <div class="overlay-actions">
      <button class="btn-primary" id="ov-resume">Resume</button>
      <button class="btn-outline"  id="ov-abandon">Abandon</button>
    </div>
  `)
  document.getElementById('ov-resume').onclick = () => {
    ui.hideOverlay()
    opponentUuid = savedOpp
    state = savedState
    $connectPanel.hidden = true
    $gamePanel.hidden    = false
    ui.renderBoard($boardContainer, state, { onEdgeClick: handleEdgeClick, disabled: true })
    $boardContainer.querySelector('#board').addEventListener('edge-click', e => handleEdgeClick(e.detail))
    updateScoreUI()
    updateTurnStatus()
  }
  document.getElementById('ov-abandon').onclick = () => {
    store.clearGameState()
    ui.hideOverlay()
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetToLobby() {
  ui.hideOverlay()
  state = null; myRole = null; opponentUuid = null
  $gamePanel.hidden    = true
  $connectPanel.hidden = false
  $connectBtn.disabled = false
  setConnectStatus('')
  store.clearGameState()
}

function updateScoreUI() {
  if (!state) return
  $scoreA.textContent = state.scoreA
  $scoreB.textContent = state.scoreB
}

function updateTurnStatus() {
  if (!state) return
  $turnStatus.textContent = state.turn === myRole ? 'Your turn' : "Opponent's turn"
}

function setConnectStatus(html, escape = true) {
  $connectStatus.innerHTML = escape
    ? html.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    : html
}

// ── Start ─────────────────────────────────────────────────────────────────────

function scheduleReconnect() {
  setTimeout(async () => {
    try {
      await pipes.connect(`player-${myUuid}`, handleInboundMessage)
      setConnectStatus('Connected. Enter an opponent UUID to challenge.')
    } catch {
      scheduleReconnect()
    }
  }, 5000)
}

boot()
