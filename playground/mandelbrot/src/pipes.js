// PipesHub client for Crowd Mandelbrot. A copy of playground/quiz/src/pipes.js
// (kept in this folder so each demo stands alone), which itself is based on
// dots-and-boxes/src/pipes.js, with:
//  - WebSocket-only transport and the JWT sent as auth.token, so a session
//    never spreads across hub nodes the way HTTP long-polling can
//  - correlation ids, so many asks can be in flight at once
//  - a factory instead of module state, so the load generator can run
//    thousands of clients in one Node process
//
// The browser loads Socket.io from the CDN on first connect. Node callers pass
// their own `io` (from socket.io-client).

const SOCKET_IO_URL      = 'https://cdn.socket.io/4.8.3/socket.io.esm.min.js'
const DEFAULT_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 15_000
const AUTH_TIMEOUT_MS    = 10_000

// PipesHub emits `gateway` with 200 once it has looked up the unit. Its
// `gateway` listener is attached after that lookup, so anything sent before
// the 200 can be dropped. Nothing is sent until it arrives.
const HUB_READY = 200

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'   // 32 chars: no modulo bias

// ── Public API ───────────────────────────────────────────────────────────────

/** Random [a-z2-7] string from crypto.getRandomValues. */
export function randomId(length = 12) {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let id = ''
  for (const b of bytes) id += ID_ALPHABET[b & 31]
  return id
}

/**
 * POST /auth with form field `name`. Resolves to the JWT (plain text).
 * Rejects with { code: 'AUTH_TIMEOUT' } if the auth server does not answer,
 * so an unreachable hub fails in seconds instead of the browser's minutes.
 */
export async function fetchToken(authUrl, unitName, fetchFn = globalThis.fetch, { timeoutMs = AUTH_TIMEOUT_MS } = {}) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const res = await fetchFn(`${authUrl}/auth`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    `name=${encodeURIComponent(unitName)}`,
      signal:  abort.signal,
    })
    if (!res.ok) throw new Error(`auth ${res.status}`)
    return await res.text()
  } catch (err) {
    if (abort.signal.aborted) throw { code: 'AUTH_TIMEOUT' }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create a client for one unit. Nothing connects until connect().
 *
 * options:
 *   hubUrl     PipesHub Socket.io URL
 *   unitName   unit name to register under
 *   token      JWT, or omit and pass getToken
 *   getToken   async () => JWT; called when there is no token or the hub
 *              rejects it
 *   io         Socket.io client factory (optional in the browser)
 *   onMessage  ({ operation, input, senderId, reply }) => void
 *              reply(res) is set only when the sender used ask()
 *   onStatus   (status, detail) => void
 *              status: 'connecting' | 'ready' | 'disconnected' | 'error'
 *   onNotice   (value) => void — non-object `gateway` payloads from the hub,
 *              e.g. 'No unit found with given name.'
 *   socketOptions  extra Socket.io client options
 */
export function createPipe(options) {
  const {
    hubUrl, unitName, getToken, io,
    onMessage, onStatus, onNotice, socketOptions = {},
  } = options

  let _token  = options.token ?? null
  let _socket = null
  let _ready  = false
  let _firstReady = null       // resolves connect() on the first HUB_READY
  let _connectFail = null       // rejects connect() if closed before that
  const _pending = new Map()   // correlationId → { resolve, reject, timer }

  async function connect({ timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
    if (_socket) throw new Error('already connected')
    const ioFn = io ?? (await import(SOCKET_IO_URL)).io
    if (!_token) _token = await getToken()

    _socket = ioFn(hubUrl, {
      transports:           ['websocket'],
      auth:                 { token: _token },
      query:                { name: unitName },
      reconnectionDelay:    1_000,
      reconnectionDelayMax: 5_000,
      randomizationFactor:  0.5,
      ...socketOptions,
    })

    _socket.on('gateway',         _handleGateway)
    _socket.on('responseGateway', _handleResponse)
    _socket.on('connect',         () => _status('connecting'))
    _socket.on('disconnect',      _handleDisconnect)
    _socket.on('connect_error',   _handleConnectError)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => _connectFail?.({ code: 'CONNECT_TIMEOUT' }), timeoutMs)
      const settle = () => { clearTimeout(timer); _firstReady = null; _connectFail = null }
      _firstReady  = () => { settle(); resolve() }
      _connectFail = err => { settle(); close(); reject(err) }
    })
  }

  /**
   * Send and wait for the receiver's reply.
   * Rejects with { code: 'TIMEOUT' }, { code: 'OFFLINE' } or { code: 'CLOSED' }.
   */
  function ask(receiverId, operation, input = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      if (!_ready) { reject({ code: 'OFFLINE' }); return }
      const correlationId = randomId(16)
      const timer = setTimeout(() => {
        _pending.delete(correlationId)
        reject({ code: 'TIMEOUT' })
      }, timeoutMs)
      _pending.set(correlationId, { resolve, reject, timer })
      _socket.emit('gateway', {
        senderId:   unitName,
        receiverId,
        operation,
        input:      { ...input, correlationId },
        awaiting:   true,
      })
    })
  }

  /** Fire-and-forget. Returns false when not connected (nothing was sent). */
  function request(receiverId, operation, input = {}) {
    if (!_ready) return false
    _socket.emit('gateway', {
      senderId:   unitName,
      receiverId,
      operation,
      input,
      awaiting:   false,
    })
    return true
  }

  /** Disconnect and reject every pending ask with { code: 'CLOSED' }. */
  function close() {
    _connectFail?.({ code: 'CLOSED' })
    _ready = false
    for (const { reject, timer } of _pending.values()) { clearTimeout(timer); reject({ code: 'CLOSED' }) }
    _pending.clear()
    if (_socket) { _socket.removeAllListeners(); _socket.disconnect(); _socket = null }
  }

  function isReady() { return _ready }

  function pendingCount() { return _pending.size }

  // ── Private ────────────────────────────────────────────────────────────────

  function _status(status, detail) {
    onStatus?.(status, detail)
  }

  function _handleGateway(data) {
    if (data === HUB_READY) {
      _ready = true
      _status('ready')
      _firstReady?.()
      return
    }
    if (!data || typeof data !== 'object') { onNotice?.(data); return }
    if (data.receiverId !== unitName) return

    const reply = data.awaiting
      ? res => {
          if (!_ready) return false
          _socket.emit('responseGateway', { ...data, res })
          return true
        }
      : null

    onMessage?.({ operation: data.operation, input: data.input ?? {}, senderId: data.senderId, reply })
  }

  function _handleResponse(data) {
    const id = data?.input?.correlationId
    const entry = id && _pending.get(id)
    if (!entry) return   // late reply after timeout, or not ours
    clearTimeout(entry.timer)
    _pending.delete(id)
    entry.resolve(data.res)
  }

  function _handleDisconnect(reason) {
    _ready = false
    _status('disconnected', reason)
    // Socket.io does not retry after a server-side disconnect; ask it to.
    if (reason === 'io server disconnect') _socket?.connect()
  }

  async function _handleConnectError(err) {
    _ready = false
    _status('error', err?.message)
    // A rejected token (e.g. the hub secret changed) needs a fresh one.
    if (getToken && /token/i.test(err?.message ?? '')) {
      try {
        _token = await getToken({ refresh: true })
        if (_socket) _socket.auth = { token: _token }
      } catch { /* the next reconnect attempt will try again */ }
    }
  }

  return { unitName, connect, ask, request, close, isReady, pendingCount }
}
