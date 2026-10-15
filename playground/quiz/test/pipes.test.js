import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createPipe, randomId, fetchToken } from '../src/pipes.js'

// A stand-in for a Socket.io client socket. The test plays the hub.
function fakeIo() {
  const sockets = []
  const io = (url, opts) => {
    const handlers = {}
    const socket = {
      url, opts,
      auth: opts.auth,
      connected: true,
      emitted: [],
      on(ev, fn) { (handlers[ev] ??= []).push(fn); return socket },
      emit(ev, data) { socket.emitted.push({ ev, data }) },
      removeAllListeners() { for (const k of Object.keys(handlers)) delete handlers[k] },
      disconnect() { socket.connected = false },
      connect() { socket.connected = true },
      // test side: the hub sends an event to this client
      fire(ev, data) { for (const fn of handlers[ev] ?? []) fn(data) },
    }
    sockets.push(socket)
    return socket
  }
  return { io, sockets }
}

async function readyPipe(extra = {}) {
  const { io, sockets } = fakeIo()
  const pipe = createPipe({ hubUrl: 'ws://hub', unitName: 'me', token: 'jwt', io, ...extra })
  const connecting = pipe.connect()
  await Promise.resolve()
  sockets[0].fire('gateway', 200)   // hub: unit registered
  await connecting
  return { pipe, socket: sockets[0] }
}

const sent = (socket, ev = 'gateway') => socket.emitted.filter(e => e.ev === ev).map(e => e.data)

test('connects WebSocket-only with the JWT in auth and the unit name in query', async () => {
  const { socket } = await readyPipe()
  assert.deepEqual(socket.opts.transports, ['websocket'])
  assert.deepEqual(socket.opts.auth, { token: 'jwt' })
  assert.deepEqual(socket.opts.query, { name: 'me' })
})

test('connect() waits for the hub ready signal', async () => {
  const { io, sockets } = fakeIo()
  const pipe = createPipe({ hubUrl: 'ws://hub', unitName: 'me', token: 'jwt', io })
  let done = false
  const p = pipe.connect().then(() => { done = true })
  await new Promise(r => setTimeout(r, 5))
  assert.equal(done, false)
  assert.equal(pipe.isReady(), false)
  sockets[0].fire('gateway', 200)
  await p
  assert.equal(pipe.isReady(), true)
})

test('connect() rejects with CONNECT_TIMEOUT if the hub never says ready', async () => {
  const { io } = fakeIo()
  const pipe = createPipe({ hubUrl: 'ws://hub', unitName: 'me', token: 'jwt', io })
  await assert.rejects(pipe.connect({ timeoutMs: 10 }), { code: 'CONNECT_TIMEOUT' })
})

test('two concurrent asks each resolve with their own reply', async () => {
  const { pipe, socket } = await readyPipe()
  const a = pipe.ask('host', 'JOIN', { nickname: 'a' })
  const b = pipe.ask('host', 'ANSWER', { option: 1 })

  const [ga, gb] = sent(socket)
  assert.equal(ga.awaiting, true)
  assert.equal(ga.senderId, 'me')
  assert.equal(ga.receiverId, 'host')
  assert.ok(ga.input.correlationId)
  assert.notEqual(ga.input.correlationId, gb.input.correlationId)

  // The hub routes replies back in the opposite order.
  socket.fire('responseGateway', { ...gb, res: { reply: 'B' } })
  socket.fire('responseGateway', { ...ga, res: { reply: 'A' } })

  assert.deepEqual(await a, { reply: 'A' })
  assert.deepEqual(await b, { reply: 'B' })
  assert.equal(pipe.pendingCount(), 0)
})

test('ask() rejects with TIMEOUT and ignores the late reply', async () => {
  const { pipe, socket } = await readyPipe()
  const slow = pipe.ask('host', 'ANSWER', {}, { timeoutMs: 15 })
  const fast = pipe.ask('host', 'JOIN', {}, { timeoutMs: 1_000 })
  await assert.rejects(slow, { code: 'TIMEOUT' })
  assert.equal(pipe.pendingCount(), 1)

  const [gSlow, gFast] = sent(socket)
  socket.fire('responseGateway', { ...gSlow, res: 'too late' })   // must not resolve `fast`
  socket.fire('responseGateway', { ...gFast, res: 'ok' })
  assert.equal(await fast, 'ok')
})

test('replies without a known correlation id are ignored', async () => {
  const { pipe, socket } = await readyPipe()
  const p = pipe.ask('host', 'JOIN', {}, { timeoutMs: 30 })
  socket.fire('responseGateway', { input: { correlationId: 'someone-else' }, res: 'x' })
  socket.fire('responseGateway', { input: {}, res: 'y' })
  socket.fire('responseGateway', null)
  await assert.rejects(p, { code: 'TIMEOUT' })
})

test('ask() before ready rejects with OFFLINE and sends nothing', async () => {
  const { io, sockets } = fakeIo()
  const pipe = createPipe({ hubUrl: 'ws://hub', unitName: 'me', token: 'jwt', io })
  pipe.connect().catch(() => {})
  await Promise.resolve()
  await assert.rejects(pipe.ask('host', 'JOIN'), { code: 'OFFLINE' })
  assert.equal(pipe.request('host', 'X'), false)
  assert.equal(sent(sockets[0]).length, 0)
  pipe.close()
})

test('close() rejects pending asks with CLOSED', async () => {
  const { pipe } = await readyPipe()
  const p = pipe.ask('host', 'JOIN')
  pipe.close()
  await assert.rejects(p, { code: 'CLOSED' })
  assert.equal(pipe.isReady(), false)
})

test('disconnect drops ready; the next 200 restores it', async () => {
  const statuses = []
  const { pipe, socket } = await readyPipe({ onStatus: s => statuses.push(s) })
  socket.fire('disconnect', 'transport close')
  assert.equal(pipe.isReady(), false)
  socket.fire('connect')
  socket.fire('gateway', 200)
  assert.equal(pipe.isReady(), true)
  assert.deepEqual(statuses, ['ready', 'disconnected', 'connecting', 'ready'])
})

test('server-side disconnect asks Socket.io to reconnect', async () => {
  const { socket } = await readyPipe()
  socket.connected = false
  socket.fire('disconnect', 'io server disconnect')
  assert.equal(socket.connected, true)
})

test('inbound messages: only for this unit, with reply() for asks', async () => {
  const got = []
  const { socket } = await readyPipe({ onMessage: m => got.push(m) })
  socket.fire('gateway', { senderId: 'host', receiverId: 'other', operation: 'X', input: {} })
  socket.fire('gateway', { senderId: 'host', receiverId: 'me', operation: 'LOBBY', input: { playerCount: 3 }, awaiting: false })
  socket.fire('gateway', { senderId: 'host', receiverId: 'me', operation: 'PING', input: { seq: 7, correlationId: 'c1' }, awaiting: true })

  assert.equal(got.length, 2)
  assert.deepEqual(got[0].input, { playerCount: 3 })
  assert.equal(got[0].reply, null)
  assert.equal(got[1].senderId, 'host')
  assert.equal(got[1].reply({ seq: 7 }), true)

  const [resp] = sent(socket, 'responseGateway')
  assert.equal(resp.senderId, 'host')               // the hub routes the reply by senderId
  assert.equal(resp.input.correlationId, 'c1')
  assert.deepEqual(resp.res, { seq: 7 })
})

test('hub notices go to onNotice, not onMessage', async () => {
  const notices = [], got = []
  const { socket } = await readyPipe({ onNotice: v => notices.push(v), onMessage: m => got.push(m) })
  socket.fire('gateway', 'No unit found with given name.')
  assert.deepEqual(notices, ['No unit found with given name.'])
  assert.equal(got.length, 0)
})

test('a rejected token is refreshed for the next attempt', async () => {
  const { io, sockets } = fakeIo()
  let calls = 0
  const pipe = createPipe({ hubUrl: 'ws://hub', unitName: 'me', io, getToken: async () => `jwt-${++calls}` })
  const connecting = pipe.connect()
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(sockets[0].opts.auth, { token: 'jwt-1' })
  sockets[0].fire('connect_error', new Error('Invalid token'))
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(sockets[0].auth, { token: 'jwt-2' })
  sockets[0].fire('gateway', 200)
  await connecting
})

test('randomId uses the [a-z2-7] alphabet', () => {
  const id = randomId(12)
  assert.match(id, /^[a-z2-7]{12}$/)
  assert.notEqual(randomId(12), id)
})

test('fetchToken posts the unit name as a form field', async () => {
  let seen
  const fake = async (url, init) => { seen = { url, init }; return { ok: true, text: async () => 'tok' } }
  assert.equal(await fetchToken('http://auth', 'quiz-p-1', fake), 'tok')
  assert.equal(seen.url, 'http://auth/auth')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.body, 'name=quiz-p-1')
  await assert.rejects(fetchToken('http://auth', 'x', async () => ({ ok: false, status: 400 })), /auth 400/)
})
