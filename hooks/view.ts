import type { WdActive, WdAgent, WdLog, WdTodo, WdTurn, WdUsage, WdWait } from '../types'
import type { Mood } from './art'
import { bar, cells, clock, fit, kilo, shortModel, untilReset } from './util'

export type Snap = {
  turn: WdTurn
  agents: Record<string, WdAgent>
  active: Record<string, WdActive>
  counts: Record<string, number>
  todos: Record<string, WdTodo>
  stops: Record<string, number>
  paused: Record<string, number>
  log: Record<string, WdLog[]>
  waiting: Record<string, WdWait>
  usage: WdUsage
  sent: number
  now: number
}

export type Seg = { t: string; c?: string; dim?: boolean; bold?: boolean }
export type Row = Seg[]

const LIVE = new Set(['running', 'waiting', 'pending', 'idle'])
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function rowWidth(row: Row): number {
  return row.reduce((n, s) => n + cells(s.t), 0)
}

/** Cuts a row to `width` cells; the segment that overflows ends in an ellipsis. */
export function fitRow(row: Row, width: number): Row {
  const out: Row = []
  let left = width
  for (const seg of row) {
    if (left <= 0) break
    const w = cells(seg.t)
    if (w <= left) {
      out.push(seg)
      left -= w
    } else {
      out.push({ ...seg, t: fit(seg.t, left) })
      left = 0
    }
  }
  return out
}

const dot: Seg = { t: ' │ ', dim: true }

export const WARN_PERCENT = 90
const FAIL_WARN_MS = 60_000

export type Warning = { key: string; text: string }

const limitName = (kind: string): string => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'spend' : kind)

/** What deserves a look now: a limit or the context nearly full, a sub-agent that just failed. */
export function warningsOf(s: Snap): Warning[] {
  const out: Warning[] = []
  for (const l of s.usage.limits) {
    if (l.percent >= WARN_PERCENT) out.push({ key: `limit:${l.kind}`, text: `${limitName(l.kind)} limit ${Math.round(l.percent)}%` })
  }
  if (s.usage.ctxWindow > 0 && s.usage.ctxPercent >= WARN_PERCENT) {
    out.push({ key: 'ctx', text: `context ${Math.round(s.usage.ctxPercent)}%` })
  }
  for (const a of Object.values(s.agents)) {
    if (a.status === 'failed' && s.now - a.endedAt < FAIL_WARN_MS) out.push({ key: `failed:${a.id}`, text: `agent #${a.n} failed` })
  }
  return out
}

/** The dog's state. What needs the person comes first, then the person's own stop, then trouble, then work. */
export function moodOf(s: Snap): Mood {
  if (Object.keys(s.waiting).length > 0) return 'input'
  if (Object.keys(s.stops).length > 0 || Object.keys(s.paused).length > 0) return 'stopping'
  if (warningsOf(s).length > 0) return 'warning'
  if (s.turn.isRunning || Object.values(s.agents).some(a => LIVE.has(a.status) && a.status !== 'idle')) {
    return 'working'
  }
  return 'idle'
}

export function moodColor(m: Mood): string {
  switch (m) {
    case 'working': return 'claude'
    case 'input': return 'permission'
    case 'stopping': return 'warning'
    case 'warning': return 'error'
    default: return 'inactive'
  }
}

export function activeAgents(s: Snap): WdAgent[] {
  return Object.values(s.agents)
    .filter(a => LIVE.has(a.status))
    .sort((a, b) => a.n - b.n)
}

function finishedAgents(s: Snap): WdAgent[] {
  return Object.values(s.agents).filter(a => !LIVE.has(a.status))
}

function statusGlyph(a: WdAgent, isStopping: boolean, isPaused = false): Seg {
  if (isStopping) return { t: '■', c: 'warning' }
  if (isPaused) return { t: '⏸', c: 'warning' }
  switch (a.status) {
    case 'running': return { t: '●', c: 'success' }
    case 'waiting': return { t: '◌', c: 'warning' }
    case 'idle': return { t: '◌', c: 'subtle' }
    case 'pending': return { t: '○', c: 'subtle' }
    case 'completed': return { t: '✓', c: 'success' }
    case 'failed': return { t: '✗', c: 'error' }
    default: return { t: '■', c: 'error' }
  }
}

/** `haiku5.5/low`, for an agent's row. */
function modelEffort(model: string, effort: string): string {
  if (model === '' && effort === '') return '—'
  return effort === '' ? shortModel(model) : `${shortModel(model)}/${effort}`
}

function activeLabel(s: Snap, loop: string): string {
  let last: WdActive | undefined
  for (const a of Object.values(s.active)) if (a.agentId === loop) last = a
  return last === undefined ? '' : `${last.tool} ${last.label}`.trim()
}

// ---- rows ----

/** `sonnet5.5/high`, beside the title; nothing until the model is known. */
function modelSegs(s: Snap): Row {
  if (s.turn.model === '') return []
  const row: Row = [{ t: shortModel(s.turn.model), bold: true }]
  if (s.turn.effort !== '') row.push({ t: `/${s.turn.effort}`, dim: true })
  return row
}

/** `main, #2`: who is held. */
function pausedNames(s: Snap): string {
  return Object.keys(s.paused)
    .map(k => (k === 'main' ? 'main' : `#${s.agents[k]?.n ?? '?'}`))
    .join(', ')
}

function headerRow(s: Snap, width: number, mood: Mood): Row {
  const running = s.turn.isRunning
  const stopping = Object.keys(s.stops).length > 0
  const waiting = Object.values(s.waiting)[0]
  const paused = Object.entries(s.paused)
  const left: Row = [{ t: 'WATCH DOG', c: moodColor(mood), bold: true }, { t: '  ' }, ...modelSegs(s)]
  if (left.length > 2) left.push({ t: '  ' })
  if (waiting !== undefined) {
    left.push({ t: `? Waiting for you: ${waiting.tool}`, c: 'permission', bold: true })
  } else if (stopping) {
    left.push({ t: '■ Stopping gracefully', c: 'warning', bold: true })
  } else if (paused.length > 0) {
    const since = Math.min(...paused.map(([, at]) => at))
    left.push({ t: `⏸ Paused ${pausedNames(s)} ${clock(s.now - since)}`, c: 'warning', bold: true })
  } else if (running) {
    left.push({ t: `${SPIN[Math.floor(s.now / 1000) % SPIN.length]} Working ${clock(s.now - s.turn.startedAt)}`, c: 'success' })
  } else {
    left.push({ t: '○ Idle', c: 'subtle' })
  }
  const warning = warningsOf(s)[0]
  if (warning !== undefined && waiting === undefined && !stopping && paused.length === 0) left.push({ t: `  ⚠ ${warning.text}`, c: 'error', bold: true })
  if (s.sent > 0) left.push({ t: `  ✉ ${s.sent}`, c: 'suggestion' })
  return fitRow(left, width)
}

/** What the main loop is doing right now: a running tool, the agents it waits for, the todo in progress, or what it did last. */
function currentSegs(s: Snap, width: number): Row {
  const mine = Object.values(s.active).filter(a => a.agentId === '')
  const tools = mine.filter(a => a.tool !== 'Agent')
  const running = activeAgents(s).filter(a => a.status !== 'idle').length
  const waiting = running > 0 ? running : mine.length - tools.length
  const todo = s.todos.main
  const last = tools[tools.length - 1]
  if (last !== undefined) {
    const more = tools.length > 1 ? ` +${tools.length - 1}` : ''
    return [{ t: fit(`⚙ ${last.tool} ${last.label}`.trim(), width - more.length), c: 'success', bold: true }, { t: more, dim: true }]
  }
  if (waiting > 0) return [{ t: fit(`⏳ waiting for ${waiting} agent${waiting > 1 ? 's' : ''}`, width), c: 'warning', bold: true }]
  if (todo !== undefined && todo.current !== '') return [{ t: fit(`→ ${todo.current}`, width), c: 'suggestion', bold: true }]
  if (s.turn.last !== '') return [{ t: fit(`✓ ${s.turn.last}`, width), dim: true }]
  return [{ t: '… thinking', dim: true }]
}

function taskRow(s: Snap, width: number): Row {
  const t = s.turn
  const row: Row = [{ t: '▶ ', c: 'claude' }, ...currentSegs(s, Math.max(14, Math.floor(width / 2.5))), { t: '  ' }]
  const todo = s.todos.main
  if (todo !== undefined && todo.total > 0) {
    const pct = Math.round((todo.done / todo.total) * 100)
    row.push({ t: bar(pct, 10), c: 'success' }, { t: ` ${todo.done}/${todo.total} ${pct}%`, bold: true })
  } else {
    row.push({ t: `step ${t.steps} · tools ${Object.values(s.counts).reduce((n, v) => n + v, 0)}`, c: 'subtle' })
  }
  // the request that started it all comes last: it is the first thing cut
  if (t.text !== '') row.push({ t: `  “${fit(t.text, 28)}”`, dim: true })
  return fitRow(row, width)
}

/** The tree branch before a sub-agent's row: it hangs under the main task row. */
const branch = (isLast: boolean): Seg => ({ t: isLast ? '└─ ' : '├─ ', dim: true })

function agentDetail(s: Snap, a: WdAgent, width: number, isLast: boolean): Row {
  const stopping = s.stops[a.id] !== undefined
  const row: Row = [branch(isLast), { t: `#${a.n} `, bold: true }, statusGlyph(a, stopping, s.paused[a.id] !== undefined), { t: ' ' }]
  row.push({ t: a.name !== '' ? a.name : a.type, c: 'suggestion' })
  if (a.desc !== '') row.push({ t: ` ${fit(a.desc, 22)}`, dim: true })
  row.push({ t: `  ${modelEffort(a.model, a.effort)}`, dim: true })
  const todo = s.todos[a.id]
  if (todo !== undefined && todo.total > 0) {
    row.push({ t: `  ${bar(Math.round((todo.done / todo.total) * 100), 6)} ${todo.done}/${todo.total}`, c: 'success' })
  } else {
    row.push({ t: `  tools ${a.tools}`, dim: true })
  }
  const now = activeLabel(s, a.id)
  if (now !== '') row.push({ t: `  ⚙ ${now}`, dim: true })
  row.push({ t: `  ${clock(s.now - a.firstSeen)}`, dim: true })
  return fitRow(row, width)
}

function agentCell(s: Snap, a: WdAgent): Row {
  return [
    { t: `#${a.n}`, bold: true },
    statusGlyph(a, s.stops[a.id] !== undefined, s.paused[a.id] !== undefined),
    { t: `${a.name !== '' ? a.name : a.type} ${a.tools}`, dim: true },
  ]
}

function doneCell(s: Snap): Row {
  const done = finishedAgents(s)
  if (done.length === 0) return []
  const failed = done.filter(a => a.status === 'failed' || a.status === 'killed').length
  const row: Row = [{ t: `✓ ${done.length - failed}`, c: 'success' }]
  if (failed > 0) row.push({ t: ` ✗ ${failed}`, c: 'error' })
  return row
}

/** `rowsLeft` agent rows: every live agent on its own row when they fit, else packed. */
export function agentRows(s: Snap, rowsLeft: number, width: number): Row[] {
  const live = activeAgents(s)
  const done = doneCell(s)
  if (live.length === 0) {
    return done.length === 0 ? [] : [fitRow([branch(true), { t: 'agents ', dim: true }, ...done, { t: ' finished', dim: true }], width)]
  }
  if (live.length <= rowsLeft) {
    const rows = live.map((a, i) => agentDetail(s, a, width, i === live.length - 1))
    if (done.length > 0) {
      const last = rows[rows.length - 1] ?? []
      rows[rows.length - 1] = fitRow([...last, dot, ...done], width)
    }
    return rows
  }
  // too many for their own rows: show the first ones in detail, pack the rest
  const rows: Row[] = []
  const detailed = Math.max(0, rowsLeft - 1)
  for (const a of live.slice(0, detailed)) rows.push(agentDetail(s, a, width, false))
  const rest = live.slice(detailed)
  const packed: Row = [branch(true), { t: `agents +${rest.length} `, dim: true }]
  for (const a of rest) packed.push(...agentCell(s, a), { t: '  ' })
  if (done.length > 0) packed.push(dot, ...done)
  rows.push(fitRow(packed, width))
  return rows
}

function toolsSegs(s: Snap): Row {
  const top = Object.entries(s.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
  if (top.length === 0) return [{ t: 'tools ', dim: true }, { t: '—', dim: true }]
  const more = Object.keys(s.counts).length - top.length
  const row: Row = [{ t: 'tools ', dim: true }]
  for (const [name, n] of top) row.push({ t: `${name}`, c: 'suggestion' }, { t: `×${n} `, dim: true })
  if (more > 0) row.push({ t: `+${more}`, dim: true })
  return row
}

function modelToolRow(s: Snap, width: number): Row {
  const row: Row = [...toolsSegs(s)]
  const now = activeLabel(s, '')
  if (now !== '') row.push(dot, { t: `⚙ ${now}`, c: 'success' })
  return fitRow(row, width)
}

const percentColor = (p: number): string => (p >= 90 ? 'error' : p >= 70 ? 'warning' : 'success')

/** `ctx 24%, 239k/1.0M` */
function ctxSegs(s: Snap): Row {
  const u = s.usage
  if (u.ctxWindow <= 0) return [{ t: 'ctx ', dim: true }, { t: '—', dim: true }]
  return [
    { t: 'ctx ', dim: true },
    { t: `${Math.round(u.ctxPercent)}%`, c: percentColor(u.ctxPercent), bold: true },
    { t: `, ${kilo(u.ctxTokens)}/${kilo(u.ctxWindow)}`, dim: true },
  ]
}

/** `limit 5h(9%), 7d(1%), reset (3h 12m)`: the reset is the nearest one. */
function limitSegs(s: Snap): Row {
  const list = s.usage.limits
  if (list.length === 0) return []
  const row: Row = [{ t: 'limit ', dim: true }]
  list.forEach((l, i) => {
    if (i > 0) row.push({ t: ', ', dim: true })
    row.push({ t: `${limitName(l.kind)}(`, dim: true }, { t: `${Math.round(l.percent)}%`, c: percentColor(l.percent), bold: true }, { t: ')', dim: true })
  })
  const resets = list.map(l => (l.resetsAt === '' ? NaN : Date.parse(l.resetsAt))).filter(t => !Number.isNaN(t))
  if (resets.length > 0) {
    const first = new Date(Math.min(...resets)).toISOString()
    row.push({ t: `, reset(${untilReset(first, s.now + (s.usage.skew ?? 0))})`, dim: true })
  }
  return row
}

function costSegs(s: Snap): Row {
  return s.usage.usd > 0 ? [{ t: `Used $${s.usage.usd.toFixed(2)}`, dim: true }] : []
}

/** `ctx 24%, 239k/1.0M | limit 5h(9%), 7d(1%), reset (3h 12m) | Used $3.23` */
function usageRow(s: Snap, width: number): Row {
  const row: Row = [...ctxSegs(s)]
  const limits = limitSegs(s)
  if (limits.length > 0) row.push(dot, ...limits)
  const cost = costSegs(s)
  if (cost.length > 0) row.push(dot, ...cost)
  return fitRow(row, width)
}

function hintRow(width: number): Row {
  return fitRow([{ t: '/wd say <message> · pause · resume · stop [main|agents|#n]  ·  /wd-log  ·  /wd-help', dim: true }], width)
}

/**
 * The band's content rows for `maxRows` rows of room (1 to 5).
 *
 * Idle shows the status, the one-line summary and a hint. Busy fills, by
 * priority: status, task, usage, first agent row, tool row, second agent row;
 * with two or more live agents the agents outrank the tool row.
 */
export function buildRows(s: Snap, width: number, maxRows: number, mood: Mood): Row[] {
  const rows = Math.max(1, Math.min(5, maxRows))
  const live = activeAgents(s)
  const isBusy = s.turn.isRunning || live.length > 0
  const header = headerRow(s, width, mood)
  if (!isBusy) return [header, usageRow(s, width), hintRow(width)].slice(0, rows)

  type Slot = 'header' | 'task' | 'usage' | 'agent1' | 'agent2' | 'tools'
  const order: Slot[] =
    live.length >= 2
      ? ['header', 'task', 'usage', 'agent1', 'agent2', 'tools']
      : ['header', 'task', 'usage', 'agent1', 'tools', 'agent2']
  const hasAgents = live.length > 0 || finishedAgents(s).length > 0
  const wanted = order.filter(slot => (slot === 'agent1' || slot === 'agent2' ? hasAgents && (slot === 'agent1' || live.length >= 2) : true))
  const picked = new Set(wanted.slice(0, rows))
  const agentSlots = (picked.has('agent1') ? 1 : 0) + (picked.has('agent2') ? 1 : 0)

  const out: Row[] = []
  if (picked.has('header')) out.push(header)
  if (picked.has('task')) out.push(taskRow(s, width))
  if (agentSlots > 0) out.push(...agentRows(s, agentSlots, width))
  if (picked.has('tools')) out.push(modelToolRow(s, width))
  if (picked.has('usage')) out.push(usageRow(s, width))
  return out
}
