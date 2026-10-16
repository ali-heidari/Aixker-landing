// Tile results travel as base64 of little-endian uint16 escape counts. The
// byte order is written explicitly so the bytes (and their SHA-256) do not
// depend on the machine.

/** Uint16Array → base64 string. */
export function encodeCounts(counts) {
  const bytes = new Uint8Array(counts.length * 2)
  const view  = new DataView(bytes.buffer)
  for (let i = 0; i < counts.length; i++) view.setUint16(i * 2, counts[i], true)
  return bytesToBase64(bytes)
}

/** base64 string → Uint16Array. Throws on bad base64 or an odd byte count. */
export function decodeCounts(b64) {
  const bytes = base64ToBytes(b64)
  if (bytes.length % 2) throw new Error('odd byte count')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out  = new Uint16Array(bytes.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true)
  return out
}

function bytesToBase64(bytes) {
  let bin = ''
  const CHUNK = 0x8000   // stay under the argument limit of fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function base64ToBytes(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
