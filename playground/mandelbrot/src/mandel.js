// Escape-time Mandelbrot for one tile. Pure: no DOM, no network, so the Web
// Worker, the bots and the tests all run the same code.
//
// The coordinator checks results byte for byte against its own numpy version
// (coordinator/compute.py), so the arithmetic here is fixed:
//  - plain JS numbers (IEEE-754 doubles); JS never fuses a*b+c into one FMA
//  - each value is computed in the order written below; change one side and
//    the other must change with it
//  - no smooth colouring, no Math.fround

/**
 * task: { x0, y0, dx, dy, width, height, maxIter }
 * Pixel (px, py) is the point c = (x0 + px*dx) + (y0 + py*dy)i.
 * Returns a Uint16Array of width*height escape counts, row by row.
 * A count of maxIter means the point did not escape.
 */
export function computeTile({ x0, y0, dx, dy, width, height, maxIter }) {
  const out = new Uint16Array(width * height)
  let k = 0
  for (let py = 0; py < height; py++) {
    const cy = y0 + py * dy
    for (let px = 0; px < width; px++) {
      const cx = x0 + px * dx
      let zx = 0, zy = 0, i = 0
      while (i < maxIter) {
        const zx2 = zx * zx
        const zy2 = zy * zy
        if (zx2 + zy2 > 4) break
        zy = 2 * zx * zy + cy
        zx = zx2 - zy2 + cx
        i++
      }
      out[k++] = i
    }
  }
  return out
}
