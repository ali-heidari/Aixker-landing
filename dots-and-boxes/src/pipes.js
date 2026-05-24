import { io } from 'https://cdn.socket.io/4.8.3/socket.io.esm.min.js'

const PIPESHUB_URL = window.__PIPESHUB_URL__
const AUTH_URL     = window.__PIPESHUB_AUTH_URL__

const SESSION_KEY = 'dotsboxes.jwt'

let _socket    = null   // Socket.io socket
let _unitName  = null   // registered unit name
let _onMessage = null   // inbound message callback
let _handlers  = {}     // operation name → handler fn (for add())

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Connect to PipesHub and register as a persistent unit.
 * Retries up to 3 times with 2s backoff before rejecting.
 */
export async function connect(unitName, onMessage) {
  _unitName  = unitName
  _onMessage = onMessage

  const token = await _getToken(unitName)
  await _openSocket(token, unitName, PIPESHUB_URL)
}

/**
 * Send a challenge to targetUnitName and await ACCEPT/DECLINE.
 * Rejects with { code: 'TIMEOUT' } after 15s.
 */
export function challenge(targetUnitName, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject({ code: 'TIMEOUT' }), 15_000)

    _socket.emit('gateway', {
      senderId:   _unitName,
      receiverId: targetUnitName,
      operation:  'CHALLENGE',
      input:      payload,
      awaiting:   true,
    })

    _socket.once('responseGateway', data => {
      clearTimeout(timer)
      resolve(data.res ?? data)
    })
  })
}

/** Fire-and-forget move delivery. */
export function sendMove(targetUnitName, move) {
  _safeSend(targetUnitName, 'MOVE', move)
}

/** Fire-and-forget for any message type. */
export function send(targetUnitName, payload) {
  const { type, ...rest } = payload
  _safeSend(targetUnitName, type, rest)
}

/** Disconnect cleanly. */
export function disconnect() {
  if (_socket) { _socket.disconnect(); _socket = null }
}

/** True when the socket exists and is connected. */
export function isConnected() {
  return !!(_socket && _socket.connected)
}

// ── Private ──────────────────────────────────────────────────────────────────

async function _getToken(unitName) {
  const cached = sessionStorage.getItem(SESSION_KEY)
  if (cached !== null) return cached

  const res = await fetch(`${AUTH_URL}/auth`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `name=${encodeURIComponent(unitName)}`,
  })
  if (!res.ok) throw new Error(`auth ${res.status}`)
  const token = await res.text()
  sessionStorage.setItem(SESSION_KEY, token)
  return token
}

function _openSocket(token, unitName, hubUrl) {
  return new Promise((resolve, reject) => {
    _socket = io(hubUrl, {
      query: { name: unitName },
      transportOptions: {
        polling: {
          extraHeaders: { authorization: token },
        },
      },
    })

    _socket.once('connect', () => {
      _socket.on('gateway', _handleGateway)
      _socket.on('disconnect', _handleDisconnect)
      resolve()
    })

    _socket.once('connect_error', err => {
      sessionStorage.removeItem(SESSION_KEY)  // stale token — force re-auth on next attempt
      reject(err)
    })
  })
}

function _handleGateway(data) {
  if (!data || typeof data !== 'object') return
  if (data.receiverId !== _unitName) return

  // Inject pushResponse so inbound ask handlers can reply
  if (data.awaiting) {
    if (!data.input) data.input = {}
    data.input.pushResponse = res => {
      data.res = res
      _socket.emit('responseGateway', data)
    }
  }

  // Route to registered handler or generic onMessage callback
  const handler = _handlers[data.operation]
  if (handler) {
    handler(data.input)
  } else if (_onMessage) {
    _onMessage({ type: data.operation, ...(data.input ?? {}), _raw: data })
  }
}

function _handleDisconnect() {
  document.dispatchEvent(new CustomEvent('pipes-disconnect'))
}

function _safeSend(targetUnitName, operation, input) {
  try {
    _socket.emit('gateway', {
      senderId:   _unitName,
      receiverId: targetUnitName,
      operation,
      input,
      awaiting:   false,
    })
  } catch (err) {
    document.dispatchEvent(new CustomEvent('pipes-error', { detail: err }))
  }
}

