export type Mood = 'idle' | 'working' | 'stopping' | 'warning' | 'input'

/** One run of equal cells of a pixel row: `fg` is the upper half block's color, `bg` the lower. */
export type Cell = { t: string; fg?: string; bg?: string }
export type PixelRow = Cell[]

/** The dog takes columns 0-11; a 3-column sign (`z`, `?`, `!`, pause) stands to its right. */
export const ART_WIDTH = 15
const SIGN_X = 12

/** `full`: head, body and paws (4 rows); `head`: the head alone (3 rows); `mini`: a small face (2 rows). */
export type DogSize = 'full' | 'head' | 'mini'

// A front-facing pixel dog: big head, floppy ears, cream muzzle, a collar and two paws.
// 12 x 8 pixels (4 terminal rows); asleep, only the head shows (12 x 6, 3 rows).
//   O coat  D ear  W muzzle  K eye/nose  P tongue  C collar  G tag
//   Q question mark  R alarm mark  A pause bars

const BASE = [
  '.DD......DD.',
  '.DDOOOOOODD.',
  '.DDOKOOKODD.',
  '.DDOWWWWODD.',
  '..OOWKKWOO..',
  '...OWWWWO...',
  '....CCCC....',
  '..OO.GG.OO..',
]

// The mini face, for a band squeezed to a few rows (an agent list under the prompt takes the rest).
const MINI = [
  '.DDOOOOOODD.',
  '.DDOKOOKODD.',
  '..OOWKKWOO..',
  '...OWWWWO...',
]

type Sign = 'q' | 'bang' | 'pause'

// `tall` beside a head or body (5 pixel rows), `short` beside the mini face (4).
const SIGNS: Record<Sign, { tall: string[]; short: string[] }> = {
  q: { tall: ['QQQ', '..Q', '.Q.', '...', '.Q.'], short: ['QQQ', '..Q', '.Q.', '.Q.'] },
  bang: { tall: ['.R.', '.R.', '.R.', '...', '.R.'], short: ['.R.', '.R.', '...', '.R.'] },
  pause: { tall: ['A.A', 'A.A', 'A.A', 'A.A', 'A.A'], short: ['A.A', 'A.A', 'A.A', 'A.A'] },
}

type Look = {
  eyes: 'open' | 'shut'
  tongue: boolean
  paws: 'A' | 'B'
  tail: 'none' | 'up' | 'down'
  ears: 'down' | 'flick'
  brows: boolean
  sign?: Sign
  /** The sign hops one pixel down (not beside the mini face: no room). */
  hop?: boolean
  rows: number
  mini?: boolean
}

function build(look: Look): string[] {
  const mini = look.mini === true
  const g = (mini ? MINI : BASE.slice(0, look.rows)).map(r => r.padEnd(ART_WIDTH, '.').split(''))
  const eyeY = mini ? 1 : 2
  const browY = mini ? 0 : 1
  const tongueY = mini ? 3 : 5
  const set = (x: number, y: number, ch: string) => {
    const row = g[y]
    if (row !== undefined && x >= 0 && x < ART_WIDTH) row[x] = ch
  }
  if (look.eyes === 'shut') {
    for (const x of [4, 7]) set(x, eyeY, 'D') // dimmer than an open eye
  }
  if (look.brows) {
    set(4, browY, 'D')
    set(7, browY, 'D')
  }
  if (look.ears === 'flick') {
    for (const x of [1, 10]) set(x, 0, '.')
  }
  if (look.tongue) {
    set(5, tongueY, 'P')
    set(6, tongueY, 'P')
  }
  if (!mini && look.rows > 6) {
    if (look.paws === 'B') g[7] = '.OO..GG..OO.'.padEnd(ART_WIDTH, '.').split('')
    if (look.tail === 'up') {
      set(10, 6, 'O')
      set(11, 5, 'O')
    } else if (look.tail === 'down') {
      set(10, 6, 'O')
      set(11, 6, 'O')
    }
  }
  if (look.sign !== undefined) {
    const shape = SIGNS[look.sign][mini ? 'short' : 'tall']
    const y0 = look.hop === true && !mini ? 1 : 0
    shape.forEach((line, dy) => {
      for (let dx = 0; dx < line.length; dx++) if (line[dx] !== '.') set(SIGN_X + dx, y0 + dy, line[dx] ?? '.')
    })
  }
  return g.map(r => r.join(''))
}

type Pose = Omit<Look, 'rows' | 'mini'>

const POSE: Pose = { eyes: 'open', tongue: false, paws: 'A', tail: 'none', ears: 'down', brows: false }

/** What the dog does in a mood at one beat of the animation (`f`, 0-3). */
function poseOf(mood: Mood, f: number): Pose {
  const odd = f % 2 === 1
  switch (mood) {
    case 'working': {
      // panting, wagging, padding in place, ears flicking; a blink on the last beat
      const poses: Pose[] = [
        { ...POSE, tongue: true, tail: 'up' },
        { ...POSE, paws: 'B', tail: 'down', ears: 'flick' },
        { ...POSE, tongue: true, paws: 'B', tail: 'up', ears: 'flick' },
        { ...POSE, paws: 'B', tail: 'down', eyes: 'shut', ears: 'flick' },
      ]
      return poses[f] ?? POSE
    }
    case 'stopping':
      // sitting still beside pause bars (they pulse in the palette); a slow blink
      return { ...POSE, eyes: f === 3 ? 'shut' : 'open', sign: 'pause' }
    case 'warning':
      // brows down, barking, an alarm mark that blinks
      return { ...POSE, tongue: true, brows: true, paws: odd ? 'B' : 'A', tail: 'up', ...(odd ? {} : { sign: 'bang' as const }) }
    case 'input':
      // ears up, tail wagging, a question mark that hops: the dog is waiting for you
      return { ...POSE, tongue: !odd, ears: odd ? 'flick' : 'down', tail: odd ? 'down' : 'up', sign: 'q', hop: odd }
    default:
      // idle: a still picture, asleep with the eyes shut
      return { ...POSE, eyes: 'shut' }
  }
}

function rowsOf(mood: Mood, size: DogSize): number {
  if (size === 'mini') return 4
  if (size === 'head') return 6
  return mood === 'idle' ? 6 : 8
}

function gridFor(mood: Mood, frame: number, size: DogSize): string[] {
  return build({ ...poseOf(mood, frame % 4), rows: rowsOf(mood, size), mini: size === 'mini' })
}

// ---- palettes ----

type Palette = Record<string, string>

const COLORS: Palette = {
  O: '#B9763A',
  D: '#6E3B1C',
  W: '#F3E3C3',
  K: '#1B1B1B',
  P: '#F08A9A',
  C: '#D13B3B',
  G: '#F2C230',
  Q: '#5AA9FF',
  R: '#FF4A3A',
  A: '#F2A530',
}

function palette(mood: Mood, frame: number): Palette {
  const even = frame % 2 === 0
  switch (mood) {
    case 'idle':
      return { ...COLORS, O: '#9C7650', D: '#5E4630', W: '#D8CDB8' }
    case 'stopping':
      return { ...COLORS, C: '#F2A530', A: even ? '#F2A530' : '#7A5A1C' }
    case 'warning':
      return { ...COLORS, C: even ? '#D13B3B' : '#F2C230' }
    case 'input':
      return { ...COLORS, Q: even ? '#5AA9FF' : '#A8D4FF' }
    default:
      return COLORS
  }
}

/** Two pixel rows become one terminal row of half blocks. */
function pack(grid: readonly string[], p: Palette): PixelRow[] {
  const out: PixelRow[] = []
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y] ?? ''
    const bottom = grid[y + 1] ?? ''
    const cells: PixelRow = []
    for (let x = 0; x < ART_WIDTH; x++) {
      const upKey = top[x] ?? '.'
      const downKey = bottom[x] ?? '.'
      const up = upKey === '.' ? undefined : p[upKey]
      const down = downKey === '.' ? undefined : p[downKey]
      let cell: Cell
      if (up === undefined && down === undefined) cell = { t: ' ' }
      else if (up === undefined) cell = { t: '▄', fg: down }
      else if (down === undefined) cell = { t: '▀', fg: up }
      else if (up === down) cell = { t: '█', fg: up }
      else cell = { t: '▀', fg: up, bg: down }
      const last = cells[cells.length - 1]
      if (last !== undefined && last.t === cell.t && last.fg === cell.fg && last.bg === cell.bg) last.t += cell.t
      else cells.push(cell)
    }
    out.push(cells)
  }
  return out
}

/** How many terminal rows the pixel dog of a mood takes. */
export function dogRows(mood: Mood, size: DogSize = 'full'): number {
  return rowsOf(mood, size) / 2
}

/** The dog for a mood at an animation frame (any non-negative integer). */
export function dog(mood: Mood, frame: number, size: DogSize = 'full'): PixelRow[] {
  const f = Math.max(0, Math.floor(frame))
  return pack(gridFor(mood, f, size), palette(mood, f))
}

/** The pixel grid itself, for tests and previews. */
export function dogGridOf(mood: Mood, frame: number, size: DogSize = 'full'): string[] {
  return gridFor(mood, Math.max(0, Math.floor(frame)), size)
}

