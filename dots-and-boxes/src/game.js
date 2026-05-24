export function createState(grid = 4) {
  return {
    grid,
    hEdges: Array.from({ length: grid + 1 }, () => Array(grid).fill(false)),
    vEdges: Array.from({ length: grid }, () => Array(grid + 1).fill(false)),
    boxes:  Array.from({ length: grid }, () => Array(grid).fill(null)),
    scoreA: 0,
    scoreB: 0,
    turn:   'A',
    status: 'playing',
    winner: null,
  }
}

function isBoxComplete(state, r, c) {
  return (
    state.hEdges[r][c]     &&   // top
    state.hEdges[r + 1][c] &&   // bottom
    state.vEdges[r][c]     &&   // left
    state.vEdges[r][c + 1]      // right
  )
}

export function getCompletedBoxes(state, move) {
  const { axis, row, col } = move
  const { grid } = state
  const candidates = []

  if (axis === 'H') {
    if (row < grid) candidates.push({ r: row,     c: col })   // top edge of box
    if (row > 0)    candidates.push({ r: row - 1, c: col })   // bottom edge of box above
  } else {
    if (col < grid) candidates.push({ r: row, c: col })       // left edge of box
    if (col > 0)    candidates.push({ r: row, c: col - 1 })   // right edge of box to left
  }

  return candidates.filter(({ r, c }) => isBoxComplete(state, r, c))
}

export function isValidMove(state, move) {
  if (state.status !== 'playing') return false
  const { axis, row, col } = move
  const { grid } = state

  if (axis === 'H') {
    return row >= 0 && row <= grid && col >= 0 && col < grid && !state.hEdges[row][col]
  }
  return row >= 0 && row < grid && col >= 0 && col <= grid && !state.vEdges[row][col]
}

export function isGameOver(state) {
  const { grid, hEdges, vEdges } = state
  for (let r = 0; r <= grid; r++)
    for (let c = 0; c < grid; c++)
      if (!hEdges[r][c]) return false
  for (let r = 0; r < grid; r++)
    for (let c = 0; c <= grid; c++)
      if (!vEdges[r][c]) return false
  return true
}

export function applyMove(state, move) {
  if (!isValidMove(state, move)) throw new Error('Invalid move')

  const newState = {
    ...state,
    hEdges: state.hEdges.map(row => [...row]),
    vEdges: state.vEdges.map(row => [...row]),
    boxes:  state.boxes.map(row => [...row]),
  }

  if (move.axis === 'H') {
    newState.hEdges[move.row][move.col] = newState.turn
  } else {
    newState.vEdges[move.row][move.col] = newState.turn
  }

  const boxesClaimed = getCompletedBoxes(newState, move)

  for (const { r, c } of boxesClaimed) {
    newState.boxes[r][c] = newState.turn
    if (newState.turn === 'A') newState.scoreA++
    else newState.scoreB++
  }

  const turnChanged = boxesClaimed.length === 0
  if (turnChanged) newState.turn = newState.turn === 'A' ? 'B' : 'A'

  if (isGameOver(newState)) {
    newState.status = 'finished'
    if (newState.scoreA > newState.scoreB)      newState.winner = 'A'
    else if (newState.scoreB > newState.scoreA) newState.winner = 'B'
    else                                         newState.winner = 'tie'
  }

  return { newState, boxesClaimed, turnChanged }
}
