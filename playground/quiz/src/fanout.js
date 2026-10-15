// Every host-to-many send goes through fanout(). PipesHub has no broadcast,
// so the host sends one message per player. Doing that in one loop blocks the
// tab for thousands of players, so sends go out in batches with a yield in
// between. If PipesHub gains a broadcast, only this file changes (per-player
// messages such as REVEAL and END would still need one send each).

export const DEFAULT_BATCH_SIZE = 200

let _send      = null
let _batchSize = DEFAULT_BATCH_SIZE
let _onDone    = null

/**
 * send(unit, operation, input) => boolean   true if the message left
 * onDone(result)                            called after every fanout()
 */
export function configureFanout({ send, batchSize = DEFAULT_BATCH_SIZE, onDone = null }) {
  _send      = send
  _batchSize = batchSize
  _onDone    = onDone
}

/**
 * Send `operation` to every unit. inputFn(unit) builds that unit's input;
 * returning null or undefined skips the unit.
 * Resolves to { operation, sent, failed, skipped, batches, durationMs }.
 */
export async function fanout(units, operation, inputFn) {
  if (!_send) throw new Error('fanout: call configureFanout() first')

  const t0 = performance.now()
  let sent = 0, failed = 0, skipped = 0, batches = 0

  for (let i = 0; i < units.length; i += _batchSize) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 0))
    batches++
    const end = Math.min(i + _batchSize, units.length)
    for (let j = i; j < end; j++) {
      const input = inputFn(units[j])
      if (input === null || input === undefined) { skipped++; continue }
      if (_send(units[j], operation, input)) sent++
      else failed++
    }
  }

  const result = { operation, sent, failed, skipped, batches, durationMs: performance.now() - t0 }
  _onDone?.(result)
  return result
}
