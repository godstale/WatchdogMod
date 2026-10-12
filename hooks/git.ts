/**
 * `/wd-git-graph`: the repo's branches and history as one picture, like the Git Graph of VS Code.
 * It only reads (git log, status, for-each-ref), asks no model, and works mid-turn.
 */

import { cells, fit, pad } from './util'

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

/** A line from lane `from` on the row above to lane `to` on the row below. */
type Edge = [from: number, to: number]

/** Lanes sit two cells apart; each edge sets the arms of the cells it crosses, and the arms pick the glyph. */
function drawEdges(edges: Edge[]): string {
  const width = edges.reduce((n, [a, b]) => Math.max(n, 2 * Math.max(a, b) + 1), 0)
  const arms = new Array<number>(width).fill(0)
  for (const [from, to] of edges) {
    const x1 = 2 * from
    const x2 = 2 * to
    if (from === to) {
      arms[x1] = (arms[x1] ?? 0) | U | D
      continue
    }
    const right = to > from
    arms[x1] = (arms[x1] ?? 0) | U | (right ? R : L)
    arms[x2] = (arms[x2] ?? 0) | D | (right ? L : R)
    for (let x = Math.min(x1, x2) + 1; x < Math.max(x1, x2); x++) arms[x] = (arms[x] ?? 0) | L | R
  }
  return arms.map(a => GLYPH[a] ?? ' ').join('')
}

export type GraphLine = { text: string; commit?: number }

/**
 * The picture of the history, newest on top, one line per commit and a connector line where lanes
 * join (a branch point) or part (a merge). `commit` names the line of a commit in `commits`.
 * Needs the commits in topological order (children before parents), as `git log --topo-order` gives.
 */
export function layoutGraph(commits: GitCommit[], headHash = ''): { lines: GraphLine[]; width: number } {
  /** The commit each lane waits for; null is a free lane. */
  let lanes: (string | null)[] = []
  const lines: GraphLine[] = []

  commits.forEach((cm, index) => {
    // a commit is waited for in one lane at most (a parent found in a lane is shared, never added twice)
    let c = lanes.indexOf(cm.hash)
    if (c < 0) {
      // nobody asked for it: the tip of a branch takes the first free lane
      c = lanes.indexOf(null)
      if (c < 0) c = lanes.length
      lanes[c] = cm.hash
    }

    const cells_ = new Array<string>(2 * lanes.length - 1).fill(' ')
    lanes.forEach((h, i) => {
      if (h !== null) cells_[2 * i] = '│'
    })
    cells_[2 * c] = cm.hash === headHash ? '◉' : '●'
    lines.push({ text: cells_.join(''), commit: index })

    // the parents: the first goes on in the lane of the commit, the others part from it (a merge)
    const next = lanes.slice()
    next[c] = null
    const edges: Edge[] = []
    lanes.forEach((h, i) => {
      if (i !== c && h !== null) edges.push([i, i])
    })
    ;[...new Set(cm.parents)].forEach((p, k) => {
      let j = next.indexOf(p)
      if (k === 0 && j > c) {
        // the first parent is already awaited to the right: that lane runs into this one, so the main line stays on the left
        next[c] = p
        next[j] = null
        const at = edges.findIndex(([a, b]) => a === j && b === j)
        if (at >= 0) edges.splice(at, 1)
        edges.push([c, c], [j, c])
        return
      }
      if (j < 0) {
        j = next.findIndex((h, i) => h === null && i >= c)
        if (j < 0) j = next.length
        next[j] = p
      }
      edges.push([c, j])
    })
    if (edges.some(([a, b]) => a !== b)) lines.push({ text: drawEdges(edges) })
    while (next.length > 0 && next[next.length - 1] === null) next.pop()
    lanes = next
  })

  const width = lines.reduce((n, l) => Math.max(n, cells(l.text)), 0)
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

function refLabel(r: GitRef): string {
  if (r.kind === 'head') return r.name === 'HEAD' ? '[HEAD]' : `[HEAD → ${r.name}]`
  if (r.kind === 'tag') return `(${r.name})`
  return `[${r.name}]`
}

/** The labels that fit in `width`, whole; what does not fit is counted (`+2`). */
function fitRefs(refs: GitRef[], width: number): string {
  const labels = refs.map(refLabel)
  const all = labels.join(' ')
  if (cells(all) <= width) return all
  const kept: string[] = []
  for (const l of labels) {
    const more = labels.length - kept.length - 1
    const tail = more > 0 ? ` +${more}` : ''
    if (cells([...kept, l].join(' ')) + cells(tail) > width) break
    kept.push(l)
  }
  if (kept.length === 0) return fit(all, width)
  return `${kept.join(' ')} +${labels.length - kept.length}`
}

function sync(ahead: number, behind: number, upstream: string, isGone = false): string {
  if (isGone) return `${upstream} (gone)`
  if (upstream === '') return 'local only'
  if (ahead === 0 && behind === 0) return `${upstream} in sync`
  return `${upstream} ${ahead > 0 ? `↑${ahead}` : ''}${ahead > 0 && behind > 0 ? ' ' : ''}${behind > 0 ? `↓${behind}` : ''}`
}

export type GitData = { commits: GitCommit[]; head: GitHead; branches: GitBranch[]; count: number; scope: GraphScope }

function headerLines(d: GitData, room: number): string[] {
  const h = d.head
  const where = h.branch === '' ? `detached at ${h.oid.slice(0, 7)}` : h.branch
  const dirty = [
    h.conflicted > 0 ? `${h.conflicted} conflicted` : '',
    h.staged > 0 ? `${h.staged} staged` : '',
    h.modified > 0 ? `${h.modified} modified` : '',
    h.untracked > 0 ? `${h.untracked} untracked` : '',
  ].filter(s => s !== '')
  const lines = [
    `Git graph: ${d.scope === 'all' ? 'all' : 'local'} branches, latest ${d.count} commits`,
    `  HEAD      ${fit(`${where}${h.branch === '' ? '' : h.upstream === '' ? ' (no upstream)' : ` → ${sync(h.ahead, h.behind, h.upstream)}`}`, room - 12)}`,
    `  Work tree ${fit(`${dirty.length === 0 ? 'clean' : dirty.join(', ')}${h.stash > 0 ? ` | stash ${h.stash}` : ''}`, room - 12)}`,
  ]
  if (d.branches.length > 0) {
    const nameW = Math.min(28, d.branches.slice(0, BRANCHES_SHOWN).reduce((n, b) => Math.max(n, cells(b.name)), 0))
    lines.push('  Branches')
    for (const b of d.branches.slice(0, BRANCHES_SHOWN)) {
      const state = fit(sync(b.ahead, b.behind, b.upstream, b.isGone), room - nameW - 20)
      lines.push(`    ${b.isHead ? '*' : ' '} ${pad(fit(b.name, nameW), nameW)}  ${b.oid}  ${state}`)
    }
    if (d.branches.length > BRANCHES_SHOWN) lines.push(`      … and ${d.branches.length - BRANCHES_SHOWN} more`)
  }
  return lines
}

/** The whole answer of the command: a header with the state of the repo, then the graph. */
export function renderGitGraph(d: GitData, columns: number, nowMs: number): string {
  const headHash = d.head.oid
  const { lines: graph, width } = layoutGraph(d.commits, headHash)
  // the transcript marks its lines with a few cells of its own
  const room = Math.max(40, columns - 6)
  const authors = new Set(d.commits.map(c => c.author))
  const out = [...headerLines(d, room), '']

  for (const g of graph) {
    const art = pad(g.text, width)
    if (g.commit === undefined) {
      out.push(art.trimEnd())
      continue
    }
    const cm = d.commits[g.commit]
    if (cm === undefined) continue
    const refs = cm.refs.map(refLabel).join(' ')
    const metaOf = (isWho: boolean): string => `${cm.hash.slice(0, 7)}${isWho ? `  ${pad(fit(cm.author, 12), 12)}` : ''}  ${agoShort(nowMs / 1000 - cm.at).padStart(7)}`
    const leftOf = (meta: string): number => room - width - 2 - cells(meta) - 2
    // the author is the first column to go when the subject would be squeezed
    let meta = metaOf(authors.size > 1)
    if (authors.size > 1 && leftOf(meta) < 40) meta = metaOf(false)
    const left = leftOf(meta)
    if (left < 20) {
      // too narrow for a column of facts: the subject keeps the room
      const text = `${refs === '' ? '' : `${refs} `}${cm.subject}`
      out.push(`${art}  ${fit(text, Math.max(10, room - width - 2))}`)
      continue
    }
    const refsCut = refs === '' ? '' : `${fitRefs(cm.refs, Math.max(Math.floor(left / 2), left - 30))} `
    out.push(`${art}  ${pad(`${refsCut}${fit(cm.subject, left - cells(refsCut))}`, left)}  ${meta}`)
  }

  if (d.commits.length === 0) out.push('  (no commits)')
  else if (d.commits.length >= d.count) out.push('', `  latest ${d.count} shown; /wd-git-graph <n> for more (max ${GRAPH_MAX})`)
  out.push('', '  ● commit ◉ HEAD [branch] [remote] (tag)')
  return out.join('\n')
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

/** Reads the repo with three git calls and draws it; a failure comes back as a sentence, never a throw. */
export async function gitGraph(run: Run, args: { count: number; scope: GraphScope }, columns: number, nowMs: number): Promise<string> {
  const revs = args.scope === 'all' ? ['--exclude=refs/stash', '--all'] : ['--branches', '--tags', 'HEAD']
  try {
    const [log, status, branches] = await Promise.all([
      run(['git', 'log', '--decorate=full', '--topo-order', '-n', String(args.count), `--format=${LOG_FORMAT}`, ...revs, '--']),
      run(['git', 'status', '--porcelain=v2', '--branch', '--show-stash']),
      run(['git', 'for-each-ref', 'refs/heads', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`]),
    ])
    if (log.exitCode !== 0) return `Watch Dog: ${failure(log)}`
    const head = parseStatus(status.exitCode === 0 ? status.stdout : '')
    const found = branches.exitCode === 0 ? parseBranches(branches.stdout) : []
    // the branch HEAD is on comes first
    const sorted = [...found.filter(b => b.isHead), ...found.filter(b => !b.isHead)]
    return renderGitGraph({ commits: parseGitLog(log.stdout), head, branches: sorted, count: args.count, scope: args.scope }, columns, nowMs)
  } catch {
    return 'Watch Dog: could not run git. Is it installed and on the PATH?'
  }
}
