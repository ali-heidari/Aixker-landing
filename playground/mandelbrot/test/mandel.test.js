import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { computeTile } from '../src/mandel.js'
import { encodeCounts, decodeCounts } from '../src/codec.js'

const COORD_DIR = fileURLToPath(new URL('../coordinator/', import.meta.url))
const PYTHON    = process.env.MANDEL_PYTHON ?? `${COORD_DIR}.venv/bin/python`

const sha256 = b64 => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex')

// Tasks exactly as coordinator/jobs.py builds them (job 1 and job 7, center tiles).
const WHOLE_SET = { x0: -1.125, y0: 0.0, dx: 0.00146484375, dy: -0.00146484375, width: 64, height: 64, maxIter: 256 }
const DEEPEST   = { x0: -0.7436438870371587, y0: 0.131825904205312, dx: 2.44140625e-15, dy: -2.44140625e-15, width: 64, height: 64, maxIter: 6000 }

test('a known tile gives a known hash', () => {
  assert.equal(sha256(encodeCounts(computeTile(WHOLE_SET))),
    'b6e3820929cfb104ed82170730a7512b7bd52a7befa7515e1abceda51cd42eb3')
  assert.equal(sha256(encodeCounts(computeTile(DEEPEST))),
    'd3042491961883bb79839b10c4a5dc288eba16ab9076d1b83f81d998332ef594')
})

test('counts stay within 0..maxIter and fill the tile', () => {
  const t = { ...WHOLE_SET, width: 37, height: 21 }
  const counts = computeTile(t)
  assert.equal(counts.length, 37 * 21)
  assert.ok(counts.every(c => c >= 0 && c <= t.maxIter))
})

test('a point inside the set reaches maxIter; one far outside escapes at 0', () => {
  const inside = computeTile({ x0: 0, y0: 0, dx: 1, dy: 1, width: 1, height: 1, maxIter: 500 })
  assert.equal(inside[0], 500)
  const outside = computeTile({ x0: 3, y0: 3, dx: 1, dy: 1, width: 1, height: 1, maxIter: 500 })
  // z0 = 0 never escapes at i = 0; z1 = c does, at i = 1
  assert.equal(outside[0], 1)
})

test('codec round-trips and is little-endian', () => {
  const counts = Uint16Array.from([0, 1, 255, 256, 65535])
  const b64 = encodeCounts(counts)
  assert.deepEqual([...Buffer.from(b64, 'base64')], [0, 0, 1, 0, 255, 0, 0, 1, 255, 255])
  assert.deepEqual(decodeCounts(b64), counts)
  assert.throws(() => decodeCounts(Buffer.from([1, 2, 3]).toString('base64')))
})

// The coordinator settles verification mismatches and runs --check with its
// own numpy code. It is only a judge if it agrees with the browser bit for bit.
const PY_HASHES = `
import hashlib, json, sys
from compute import counts_to_bytes, task_counts
for t in json.loads(sys.stdin.read()):
    print(hashlib.sha256(counts_to_bytes(task_counts(t))).hexdigest())
`

function seededRandom(seed) {
  return () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 }
}

test('browser worker and coordinator numpy give identical bytes', { skip: !existsSync(PYTHON) && `no Python at ${PYTHON}` }, () => {
  const rand = seededRandom(42)
  const tasks = [WHOLE_SET, DEEPEST]
  // Random windows from the whole set down to the deepest zoom this demo uses
  for (let i = 0; i < 24; i++) {
    const span = 3 * 10 ** (-12 * rand())
    const cx = -0.7436438870371587 + (rand() - 0.5) * span * 4
    const cy = 0.1318259042053120 + (rand() - 0.5) * span * 4
    const dx = span / 2048
    tasks.push({ x0: cx, y0: cy, dx, dy: -dx, width: 16 + Math.floor(rand() * 49),
                 height: 16 + Math.floor(rand() * 49), maxIter: 200 + Math.floor(rand() * 4000) })
  }
  // Edge cases: odd sizes, one pixel, a band crossing the real axis
  tasks.push({ x0: -2.1, y0: 0.0001, dx: 0.003, dy: -0.000001, width: 64, height: 3, maxIter: 1000 })
  tasks.push({ x0: 0.25, y0: 0, dx: 1e-9, dy: 1e-9, width: 1, height: 1, maxIter: 65535 })

  const py = execFileSync(PYTHON, ['-c', PY_HASHES], { cwd: COORD_DIR, input: JSON.stringify(tasks) })
    .toString().trim().split('\n')
  const js = tasks.map(t => sha256(encodeCounts(computeTile(t))))
  assert.equal(py.length, js.length)
  for (let i = 0; i < js.length; i++) assert.equal(js[i], py[i], `task ${i}: ${JSON.stringify(tasks[i])}`)
})

// The PNGs the coordinator saves use the same colours as the page.
const PY_PALETTE = `
import json, sys
from render import palette
print(json.dumps([palette(m).ravel().tolist() for m in json.loads(sys.stdin.read())]))
`

test('canvas palette and coordinator PNG palette are the same', { skip: !existsSync(PYTHON) && `no Python at ${PYTHON}` }, async () => {
  const { buildPalette } = await import('../src/canvas.js')
  const sizes = [256, 600, 6000]
  const py = JSON.parse(execFileSync(PYTHON, ['-c', PY_PALETTE], { cwd: COORD_DIR, input: JSON.stringify(sizes) }))
  sizes.forEach((m, i) => assert.deepEqual([...buildPalette(m)], py[i], `maxIter ${m}`))
})
