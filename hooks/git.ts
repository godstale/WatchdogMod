/**
 * `/wd-git-graph`: the repo's branches and history as one picture, like the Git Graph of VS Code.
 * It only reads (git log, status, for-each-ref), asks no model, and works mid-turn.
 */

import { cells, fit, pad } from './util'
import type { Seg } from './view'

export const GRAPH_DEFAULT = 30
const GRAPH_MAX = 200
/** Local branches listed in the header before the rest is summed up. */
const BRANCHES_SHOWN = 8
const FIELD = '\x1f'

// ---- arguments ----

export type GraphScope = 'all' | 'local'
export type GraphArgs = { count: number; scope: GraphScope } | { error: string }

/** `[count] [local|all]`, in either order. */
export function parseGraphArgs(args: string): GraphArgs {
  let count = GRAPH_DEFAULT
  let scope: GraphScope = 'all'
  for (const word of args.trim().split(/\s+/).filter(w => w !== '')) {
    if (/^local$/i.test(word)) scope = 'local'
    else if (/^all$/i.test(word)) scope = 'all'
    else if (/^\d{1,3}$/.test(word)) count = Math.max(1, Math.min(GRAPH_MAX, Number(word)))
    else return { error: `unknown "${word}". usage: /wd-git-graph [count] [local]` }
  }
  return { count, scope }
}

// ---- what git says ----

export type GitRef = { kind: 'head' | 'branch' | 'remote' | 'tag'; name: string }

export type GitCommit = {
  hash: string
  parents: string[]
  refs: GitRef[]
  author: string
  /** Seconds since the epoch. */
  at: number
  subject: string
}

/** `HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1` (git log --decorate=full %D). */
export function parseRefs(decoration: string): GitRef[] {
  const refs: GitRef[] = []
  for (const item of decoration.split(', ').map(s => s.trim()).filter(s => s !== '')) {
    if (item === 'HEAD') refs.push({ kind: 'head', name: 'HEAD' })
    else if (item.startsWith('HEAD -> refs/heads/')) refs.push({ kind: 'head', name: item.slice('HEAD -> refs/heads/'.length) })
    else if (item.startsWith('refs/heads/')) refs.push({ kind: 'branch', name: item.slice('refs/heads/'.length) })
    else if (item.startsWith('refs/remotes/')) {
      if (!item.endsWith('/HEAD')) refs.push({ kind: 'remote', name: item.slice('refs/remotes/'.length) })
    } else if (item.startsWith('tag: refs/tags/')) refs.push({ kind: 'tag', name: item.slice('tag: refs/tags/'.length) })
  }
  const order = { head: 0, branch: 1, remote: 2, tag: 3 }
  return refs.sort((a, b) => order[a.kind] - order[b.kind])
}

export const LOG_FORMAT = ['%H', '%P', '%D', '%an', '%at', '%s'].join('%x1f')

export function parseGitLog(stdout: string): GitCommit[] {
  const out: GitCommit[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const f = line.split(FIELD)
    if (f.length < 6 || (f[0] ?? '') === '') continue
    out.push({
      hash: f[0] ?? '',
      parents: (f[1] ?? '').split(' ').filter(p => p !== ''),
      refs: parseRefs(f[2] ?? ''),
      author: f[3] ?? '',
      at: Number(f[4]) || 0,
      subject: f.slice(5).join(FIELD),
    })
  }
  return out
}

export type GitHead = {
  /** The branch name; empty when HEAD is detached. */
  branch: string
  oid: string
  upstream: string
  ahead: number
  behind: number
  stash: number
  staged: number
  modified: number
  untracked: number
  conflicted: number
}

/** `git status --porcelain=v2 --branch --show-stash`. */
export function parseStatus(stdout: string): GitHead {
  const head: GitHead = { branch: '', oid: '', upstream: '', ahead: 0, behind: 0, stash: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0 }
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.oid ')) head.oid = line.slice(13).trim()
    else if (line.startsWith('# branch.head ')) head.branch = line.slice(14).trim() === '(detached)' ? '' : line.slice(14).trim()
    else if (line.startsWith('# branch.upstream ')) head.upstream = line.slice(18).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)/.exec(line)
      head.ahead = Number(m?.[1] ?? 0)
      head.behind = Number(m?.[2] ?? 0)
    } else if (line.startsWith('# stash ')) head.stash = Number(line.slice(8)) || 0
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      if (line[2] !== '.') head.staged += 1
      if (line[3] !== '.') head.modified += 1
    } else if (line.startsWith('u ')) head.conflicted += 1
    else if (line.startsWith('? ')) head.untracked += 1
  }
  return head
}

export type GitBranch = { isHead: boolean; name: string; upstream: string; ahead: number; behind: number; isGone: boolean; oid: string }

export const BRANCH_FORMAT = ['%(HEAD)', '%(refname:short)', '%(upstream:short)', '%(upstream:track)', '%(objectname:short)'].join('%09')

/** `git for-each-ref refs/heads` in BRANCH_FORMAT; the caller sorts them. */
export function parseBranches(stdout: string): GitBranch[] {
  const out: GitBranch[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const f = line.split('\t')
    if (f.length < 5 || (f[1] ?? '') === '') continue
    const track = f[3] ?? ''
    out.push({
      isHead: f[0] === '*',
      name: f[1] ?? '',
      upstream: f[2] ?? '',
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      isGone: track.includes('gone'),
      oid: f[4] ?? '',
    })
  }
  return out
}

// ---- lanes ----

// the four arms of a cell of the picture
const U = 1
const D = 2
const L = 4
const R = 8
const GLYPH: Record<number, string> = {
  [U]: '│', [D]: '│', [U | D]: '│',
  [L]: '─', [R]: '─', [L | R]: '─',
  [D | R]: '╭', [D | L]: '╮', [U | R]: '╰', [U | L]: '╯',
  [U | D | R]: '├', [U | D | L]: '┤', [L | R | D]: '┬', [L | R | U]: '┴', [U | D | L | R]: '┼',
}

/** The colours of the branches, in the order the Git Graph of VS Code hands them out. */
export const LANE_COLORS = ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#9aa0ff', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00']
const TAG_COLOR = '#d7ba7d'
/** The lane of the main branch: always red, a colour no other lane gets. */
export const MAIN_LANE = -2
const MAIN_COLOR = '#ff3b30'
const NO_COLOR = -1
export const laneColor = (n: number): string => (n === MAIN_LANE ? MAIN_COLOR : (LANE_COLORS[n % LANE_COLORS.length] ?? '#888888'))

/** `main` or `master`, local or on a remote (`origin/main`). */
const isMainRef = (r: GitRef): boolean => (r.kind === 'remote' ? /^[^/]+\/(?:main|master)$/ : /^(?:main|master)$/).test(r.name) && r.kind !== 'tag'

/** A line from lane `from` on the row above to lane `to` on the row below, in a branch's colour. */
type Edge = [from: number, to: number, color: number]

/** One cell of the picture; `color` numbers the branch it belongs to, -1 for none. */
export type GraphCell = { ch: string; color: number }

/** Lanes sit two cells apart; each edge sets the arms of the cells it crosses, and the arms pick the glyph. */
function drawEdges(edges: Edge[]): GraphCell[] {
  const width = edges.reduce((n, [a, b]) => Math.max(n, 2 * Math.max(a, b) + 1), 0)
  const arms = new Array<number>(width).fill(0)
  const colors = new Array<number>(width).fill(-1)
  const weight = new Array<number>(width).fill(0)
  // where lines meet in one cell the strongest keeps it: a lane, then the end of a branch, then a line passing over
  const set = (x: number, bits: number, color: number, strength: number): void => {
    arms[x] = (arms[x] ?? 0) | bits
    if (strength >= (weight[x] ?? 0)) {
      colors[x] = color
      weight[x] = strength
    }
  }
  for (const [from, to, color] of edges) {
    const x1 = 2 * from
    const x2 = 2 * to
    if (from === to) {
      set(x1, U | D, color, 3)
      continue
    }
    const right = to > from
    set(x1, U | (right ? R : L), color, 2)
    set(x2, D | (right ? L : R), color, 2)
    for (let x = Math.min(x1, x2) + 1; x < Math.max(x1, x2); x++) set(x, L | R, color, 1)
  }
  return arms.map((a, x) => ({ ch: GLYPH[a] ?? ' ', color: colors[x] ?? -1 }))
}

export type GraphLine = {
  cells: GraphCell[]
  /** The cells as plain text. */
  text: string
  /** The commit this line is the row of (an index of `commits`); none for a connector line. */
  commit?: number
  /** The colour of that commit's lane. */
  color: number
}

/**
 * The picture of the history, newest on top, one line per commit and a connector line under each,
 * straight where lanes go on and bent where they join (a branch point) or part (a merge). Every lane has a colour of its own: a branch tip opens
 * a lane with a new colour, its first parent goes on in it, and the lane a merge parts into is new.
 * Needs the commits in topological order (children before parents), as `git log --topo-order` gives.
 */
export function layoutGraph(commits: GitCommit[], headHash = ''): { lines: GraphLine[]; width: number } {
  /** The commit each lane waits for; null is a free lane. */
  let lanes: (string | null)[] = []
  /** The colour of each lane (`lanes` side by side). */
  let colors: number[] = []
  let fresh = 0
  const lines: GraphLine[] = []
  const line = (cs: GraphCell[], commit?: number, color = -1): void => {
    lines.push({ cells: cs, text: cs.map(x => x.ch).join(''), color, ...(commit === undefined ? {} : { commit }) })
  }

  commits.forEach((cm, index) => {
    // a commit is waited for in one lane at most (a parent found in a lane is shared, never added twice)
    let c = lanes.indexOf(cm.hash)
    if (c < 0) {
      // nobody asked for it: the tip of a branch takes the first free lane and a colour of its own
      c = lanes.indexOf(null)
      if (c < 0) c = lanes.length
      lanes[c] = cm.hash
      colors[c] = fresh++
    }
    // from the tip of main down, its line is red (above it the line still belongs to the branch built on it)
    if (cm.refs.some(isMainRef)) colors[c] = MAIN_LANE
    const mine = colors[c] ?? 0

    const row: GraphCell[] = new Array<GraphCell>(2 * lanes.length - 1).fill({ ch: ' ', color: -1 })
    lanes.forEach((h, i) => {
      if (h !== null) row[2 * i] = { ch: '│', color: colors[i] ?? 0 }
    })
    row[2 * c] = { ch: cm.hash === headHash ? '◉' : '●', color: mine }
    line(row, index, mine)

    // the parents: the first goes on in the lane of the commit, the others part from it (a merge)
    const next = lanes.slice()
    const nextColors = colors.slice()
    next[c] = null
    const edges: Edge[] = []
    lanes.forEach((h, i) => {
      if (i !== c && h !== null) edges.push([i, i, colors[i] ?? 0])
    })
    ;[...new Set(cm.parents)].forEach((p, k) => {
      let j = next.indexOf(p)
      if (k === 0 && j > c) {
        // the first parent is already awaited to the right: that lane runs into this one, so the main line stays on the left
        next[c] = p
        nextColors[c] = mine
        next[j] = null
        const at = edges.findIndex(([a, b]) => a === j && b === j)
        if (at >= 0) edges.splice(at, 1)
        edges.push([c, c, mine], [j, c, colors[j] ?? 0])
        return
      }
      if (j < 0) {
        j = next.findIndex((h, i) => h === null && i >= c)
        if (j < 0) j = next.length
        next[j] = p
        nextColors[j] = k === 0 ? mine : fresh++
      }
      edges.push([c, j, k === 0 ? mine : (nextColors[j] ?? 0)])
    })
    // a line between every two commits, as in VS Code: without it a straight history is a column of loose dots
    if (edges.length > 0) line(drawEdges(edges))
    while (next.length > 0 && next[next.length - 1] === null) next.pop()
    lanes = next
    colors = nextColors.slice(0, next.length)
  })

  const width = lines.reduce((n, l) => Math.max(n, l.cells.length), 0)
  return { lines, width }
}

// ---- the text ----

/** `5m ago`, `3h ago`, `2d ago`, `4mo ago`. */
export function agoShort(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  if (d < 365) return `${Math.floor(d / 30)}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

/** A row of the answer as coloured pieces; its text is what the plain answer prints. */
export type GitRow = Seg[]

const dim = (t: string): Seg => ({ t, dim: true })
const rowText = (row: GitRow): string => row.map(s => s.t).join('')
const rowWidth = (row: GitRow): number => cells(rowText(row))

function refLabel(r: GitRef): string {
  if (r.kind === 'head') return r.name === 'HEAD' ? '[HEAD]' : `[HEAD → ${r.name}]`
  if (r.kind === 'tag') return `(${r.name})`
  return `[${r.name}]`
}

/** A label in the colour of the branch it sits on; the one HEAD is on is bold, a remote one dim, a tag its own. */
function refSeg(r: GitRef, color: string): Seg {
  const t = refLabel(r)
  if (r.kind === 'tag') return { t, c: TAG_COLOR }
  if (r.kind === 'head') return { t, c: color, bold: true }
  return r.kind === 'remote' ? { t, c: color, dim: true } : { t, c: color }
}

/** The labels that fit in `width`, whole; what does not fit is counted (`+2`). */
function refSegs(refs: GitRef[], width: number, color: string): Seg[] {
  const segs = refs.map(r => refSeg(r, color))
  const spaced = (list: Seg[]): Seg[] => list.flatMap((s, i) => (i === 0 ? [s] : [{ t: ' ' }, s]))
  if (cells(rowText(spaced(segs))) <= width) return spaced(segs)
  const kept: Seg[] = []
  for (const s of segs) {
    const tail = segs.length - kept.length - 1 > 0 ? ` +${segs.length - kept.length - 1}` : ''
    if (cells(rowText(spaced([...kept, s]))) + cells(tail) > width) break
    kept.push(s)
  }
  if (kept.length === 0) {
    const first = segs[0]
    return first === undefined ? [] : [{ ...first, t: fit(rowText(spaced(segs)), width) }]
  }
  return [...spaced(kept), dim(` +${segs.length - kept.length}`)]
}

function sync(ahead: number, behind: number, upstream: string, isGone = false): string {
  if (isGone) return `${upstream} (gone)`
  if (upstream === '') return 'local only'
  if (ahead === 0 && behind === 0) return `${upstream} in sync`
  return `${upstream} ${ahead > 0 ? `↑${ahead}` : ''}${ahead > 0 && behind > 0 ? ' ' : ''}${behind > 0 ? `↓${behind}` : ''}`
}

export type GitData = { commits: GitCommit[]; head: GitHead; branches: GitBranch[]; count: number; scope: GraphScope }

/** The colour of each branch name seen in the graph: the lane its commit sits in. */
function branchColors(d: GitData, lines: GraphLine[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const l of lines) {
    const cm = l.commit === undefined ? undefined : d.commits[l.commit]
    for (const r of cm?.refs ?? []) if (r.kind !== 'tag' && !out.has(r.name)) out.set(r.name, laneColor(l.color))
  }
  return out
}

function headerRows(d: GitData, room: number, colorOf: Map<string, string>): GitRow[] {
  const h = d.head
  const where = h.branch === '' ? `detached at ${h.oid.slice(0, 7)}` : h.branch
  const dirty = [
    h.conflicted > 0 ? `${h.conflicted} conflicted` : '',
    h.staged > 0 ? `${h.staged} staged` : '',
    h.modified > 0 ? `${h.modified} modified` : '',
    h.untracked > 0 ? `${h.untracked} untracked` : '',
  ].filter(s => s !== '')
  const headText = fit(`${where}${h.branch === '' ? '' : h.upstream === '' ? ' (no upstream)' : ` → ${sync(h.ahead, h.behind, h.upstream)}`}`, room - 12)
  const headColor = colorOf.get(h.branch)
  const treeText = fit(`${dirty.length === 0 ? 'clean' : dirty.join(', ')}${h.stash > 0 ? ` | stash ${h.stash}` : ''}`, room - 12)
  const rows: GitRow[] = [
    [{ t: 'Git graph', bold: true }, dim(`: ${d.scope === 'all' ? 'all' : 'local'} branches, latest ${d.count} commits`)],
    [
      dim('  HEAD      '),
      headText.startsWith(where) ? { t: where, bold: true, ...(headColor === undefined ? {} : { c: headColor }) } : { t: '' },
      { t: headText.startsWith(where) ? headText.slice(where.length) : headText },
    ],
    [dim('  Work tree '), { t: treeText, c: dirty.length === 0 ? 'success' : 'warning' }],
  ]
  if (d.branches.length > 0) {
    const shown = d.branches.slice(0, BRANCHES_SHOWN)
    const nameW = Math.min(28, shown.reduce((n, b) => Math.max(n, cells(b.name)), 0))
    rows.push([dim('  Branches')])
    for (const b of shown) {
      const state = fit(sync(b.ahead, b.behind, b.upstream, b.isGone), room - nameW - 20)
      const isCalm = b.upstream === '' || (!b.isGone && b.ahead === 0 && b.behind === 0)
      const c = colorOf.get(b.name)
      rows.push([
        { t: '    ' },
        { t: b.isHead ? '*' : ' ', bold: true },
        { t: ' ' },
        { t: pad(fit(b.name, nameW), nameW), ...(c === undefined ? {} : { c }), ...(b.isHead ? { bold: true } : {}) },
        { t: '  ' },
        dim(b.oid),
        { t: '  ' },
        isCalm ? dim(state) : { t: state, c: 'warning' },
      ])
    }
    if (d.branches.length > BRANCHES_SHOWN) rows.push([dim(`      … and ${d.branches.length - BRANCHES_SHOWN} more`)])
  }
  return rows
}

/** A line of the picture as pieces, each run of cells in the colour of its branch, padded to `width`. */
function graphSegs(line: GraphLine, width: number): Seg[] {
  const padding = Array.from({ length: Math.max(0, width - line.cells.length) }, (): GraphCell => ({ ch: ' ', color: -1 }))
  const out: Seg[] = []
  for (const cell of [...line.cells, ...padding]) {
    const c = cell.color === NO_COLOR || cell.ch === ' ' ? undefined : laneColor(cell.color)
    const last = out[out.length - 1]
    if (last !== undefined && last.c === c) last.t += cell.ch
    else out.push(c === undefined ? { t: cell.ch } : { t: cell.ch, c })
  }
  return out
}

/** The whole answer of the command as rows: a header with the state of the repo, then the graph. */
export function gitRows(d: GitData, columns: number, nowMs: number): GitRow[] {
  const { lines: graph, width } = layoutGraph(d.commits, d.head.oid)
  // the transcript marks its lines with a few cells of its own
  const room = Math.max(40, columns - 6)
  const authors = new Set(d.commits.map(c => c.author))
  const rows: GitRow[] = [...headerRows(d, room, branchColors(d, graph)), []]

  for (const g of graph) {
    const art = graphSegs(g, width)
    const cm = g.commit === undefined ? undefined : d.commits[g.commit]
    if (cm === undefined) {
      rows.push(art)
      continue
    }
    const metaOf = (isWho: boolean): string => `${cm.hash.slice(0, 7)}${isWho ? `  ${pad(fit(cm.author, 12), 12)}` : ''}  ${agoShort(nowMs / 1000 - cm.at).padStart(7)}`
    const leftOf = (meta: string): number => room - width - 2 - cells(meta) - 2
    // the author is the first column to go when the subject would be squeezed
    let meta = metaOf(authors.size > 1)
    if (authors.size > 1 && leftOf(meta) < 40) meta = metaOf(false)
    // too narrow for a column of facts: the subject keeps the room
    const hasMeta = leftOf(meta) >= 20
    const left = hasMeta ? leftOf(meta) : Math.max(10, room - width - 2)
    const refs = cm.refs.length === 0 ? [] : refSegs(cm.refs, Math.max(Math.floor(left / 2), left - 30), laneColor(g.color))
    const refsW = refs.length === 0 ? 0 : rowWidth(refs) + 1
    const subject = fit(cm.subject, left - refsW)
    const body: GitRow = [...refs, ...(refs.length === 0 ? [] : [{ t: ' ' }]), { t: subject }]
    const gap = hasMeta ? left - rowWidth(body) : 0
    rows.push([...art, { t: '  ' }, ...body, ...(hasMeta ? [{ t: ' '.repeat(Math.max(0, gap) + 2) }, dim(meta)] : [])])
  }

  if (d.commits.length === 0) rows.push([{ t: '  (no commits)' }])
  else if (d.commits.length >= d.count) rows.push([], [dim(`  latest ${d.count} shown; /wd-git-graph <n> for more (max ${GRAPH_MAX})`)])
  rows.push([], [dim('  ● commit ◉ HEAD [branch] [remote] (tag)')])
  return rows
}

/** The plain-text form of `gitRows`, for a surface that cannot draw colours. */
export function rowsText(rows: GitRow[]): string {
  return rows.map(r => rowText(r).trimEnd()).join('\n')
}

export function renderGitGraph(d: GitData, columns: number, nowMs: number): string {
  return rowsText(gitRows(d, columns, nowMs))
}

// ---- running git ----

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Run = (argv: string[]) => Promise<RunResult>

/** One line for a failure of git, as the person should read it. */
function failure(r: RunResult): string {
  const err = r.stderr.trim()
  if (/not a git repository/i.test(err)) return 'this directory is not inside a git repository.'
  if (/does not have any commits yet|bad default revision|unknown revision/i.test(err)) return 'this repository has no commits yet.'
  return `git failed (${fit(err.split(/\r?\n/)[0] ?? `exit ${r.exitCode}`, 80)}).`
}

/** What the command answers: the text, and the same as coloured rows when there is a graph to draw. */
export type GitAnswer = { text: string; rows: GitRow[] }

/** Reads the repo with three git calls and draws it; a failure comes back as a sentence, never a throw. */
export async function gitGraph(run: Run, args: { count: number; scope: GraphScope }, columns: number, nowMs: number): Promise<GitAnswer> {
  const revs = args.scope === 'all' ? ['--exclude=refs/stash', '--all'] : ['--branches', '--tags', 'HEAD']
  try {
    const [log, status, branches] = await Promise.all([
      run(['git', 'log', '--decorate=full', '--topo-order', '-n', String(args.count), `--format=${LOG_FORMAT}`, ...revs, '--']),
      run(['git', 'status', '--porcelain=v2', '--branch', '--show-stash']),
      run(['git', 'for-each-ref', 'refs/heads', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`]),
    ])
    if (log.exitCode !== 0) return { text: `Watch Dog: ${failure(log)}`, rows: [] }
    const head = parseStatus(status.exitCode === 0 ? status.stdout : '')
    const found = branches.exitCode === 0 ? parseBranches(branches.stdout) : []
    // the branch HEAD is on comes first
    const sorted = [...found.filter(b => b.isHead), ...found.filter(b => !b.isHead)]
    const rows = gitRows({ commits: parseGitLog(log.stdout), head, branches: sorted, count: args.count, scope: args.scope }, columns, nowMs)
    return { text: rowsText(rows), rows }
  } catch {
    return { text: 'Watch Dog: could not run git. Is it installed and on the PATH?', rows: [] }
  }
}
