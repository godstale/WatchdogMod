import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WdActive, WdAgent, WdLog, WdTodo, WdTurn, WdUsage, WdWait } from '../types'
import { ART_WIDTH, dog, dogRows } from './art'
import type { DogSize, PixelRow } from './art'
import { helpFor } from './help'
import { LOG_KEEP, parseLogArgs, renderLog } from './log'
import { notifyCommand } from './notify'
import type { Os } from './notify'
import { basename, fit, HELP, parseArgs } from './util'
import type { Scope } from './util'
import { buildRows, moodColor, moodOf, warningsOf } from './view'
import type { Row, Seg, Snap } from './view'

// ---- the session's values (declared in ../types) ----

const EMPTY_TURN: WdTurn = { isRunning: false, id: '', text: '', startedAt: 0, steps: 0, model: '', effort: '', last: '' }
const EMPTY_USAGE: WdUsage = { ctxPercent: 0, ctxTokens: 0, ctxWindow: 0, limits: [], usd: 0 }

const turnA = atom({ plugin: 'watchdog', key: 'turn' } as const, EMPTY_TURN)
const agentsA = atom({ plugin: 'watchdog', key: 'agents' } as const, {} as Record<string, WdAgent>)
const activeA = atom({ plugin: 'watchdog', key: 'active' } as const, {} as Record<string, WdActive>)
const countsA = atom({ plugin: 'watchdog', key: 'counts' } as const, {} as Record<string, number>)
const todosA = atom({ plugin: 'watchdog', key: 'todos' } as const, {} as Record<string, WdTodo>)
const stopsA = atom({ plugin: 'watchdog', key: 'stops' } as const, {} as Record<string, number>)
const pausedA = atom({ plugin: 'watchdog', key: 'paused' } as const, {} as Record<string, number>)
const logA = atom({ plugin: 'watchdog', key: 'log' } as const, {} as Record<string, WdLog[]>)
const waitingA = atom({ plugin: 'watchdog', key: 'waiting' } as const, {} as Record<string, WdWait>)
const usageA = atom({ plugin: 'watchdog', key: 'usage' } as const, EMPTY_USAGE)
const sentA = atom({ plugin: 'watchdog', key: 'sent' } as const, 0)
const nowA = atom({ plugin: 'watchdog', key: 'now' } as const, 0)

async function snapOf($: EngineInterface): Promise<Snap> {
  return {
    turn: await read($, turnA),
    agents: await read($, agentsA),
    active: await read($, activeA),
    counts: await read($, countsA),
    todos: await read($, todosA),
    stops: await read($, stopsA),
    paused: await read($, pausedA),
    log: await read($, logA),
    waiting: await read($, waitingA),
    usage: await read($, usageA),
    sent: await read($, sentA),
    now: await read($, nowA),
  }
}

// ---- graceful stop ----

/** What a loop under a stop request may still call: looking, and keeping its list. */
const STOP_ALLOW = new Set(['Read', 'Grep', 'Glob', 'TodoWrite', 'TaskGet', 'TaskList', 'TaskUpdate', 'ToolSearch'])
const STOP_HINT_MS = 45_000
const ENDED = new Set(['completed', 'failed', 'killed'])
const KEEP_ENDED_MS = 600_000

const noteOf = (kind: 'say' | 'stop-main' | 'stop-agent', text = ''): string => {
  if (kind === 'say') {
    return [
      '[Watch Dog: a message from the user, sent while you were working]',
      text,
      'Treat this as a new instruction from the user. Finish the step you are on, fold the request into your plan, and mention briefly that you picked it up.',
    ].join('\n')
  }
  const who = kind === 'stop-main' ? 'then end your turn' : 'then end your run so your final answer reaches your parent'
  return [
    '[Watch Dog: the user asked you to stop gracefully]',
    'Do not start any new work. Calls other than Read, Grep, Glob and todo updates will be refused.',
    `Reply now with a short wrap-up: what is done, what remains, and any half-finished state the user should know about; ${who}.`,
  ].join('\n')
}

// ---- tool call labels ----

function briefOf(tool: string, i: Record<string, unknown>): string {
  const s = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '')
  switch (tool) {
    case 'Bash':
      return fit(s('command'), 26)
    case 'Read':
    case 'Edit':
    case 'Write':
      return basename(s('file_path'))
    case 'NotebookEdit':
      return basename(s('notebook_path'))
    case 'Grep':
    case 'Glob':
      return fit(s('pattern'), 22)
    case 'WebFetch':
      return fit(s('url'), 26)
    case 'WebSearch':
      return fit(s('query'), 26)
    case 'Agent':
      return fit(s('description'), 22)
    default:
      return fit(s('description') || s('file_path') || s('pattern') || s('query'), 22)
  }
}

function nameOf(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const parts = tool.split('__')
  return `${parts[1] ?? 'mcp'}:${parts.slice(2).join('__')}`
}

type TodoInput = { content?: string; status?: string; activeForm?: string }

function todoOf(input: Record<string, unknown>): WdTodo | undefined {
  const list = input.todos
  if (!Array.isArray(list)) return undefined
  const todos = list as TodoInput[]
  const doing = todos.find(t => t.status === 'in_progress')
  return {
    total: todos.length,
    done: todos.filter(t => t.status === 'completed').length,
    current: fit(doing?.activeForm ?? doing?.content ?? '', 30),
  }
}

// ---- keeping the numbers fresh ----

/** A failure of the dashboard must never hold up the work it watches. */
async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch {
    // the dashboard may be stale, the session goes on
  }
}

// ---- pausing ----

/**
 * Who is held, and whether the main loop is busy. What a waiting call reads is this variable of the
 * module, not `$.state`: a read inside a hook that is already waiting does not see a later write.
 * The atom mirrors it for the window.
 */
const holds = new Map<string, number>()
let isMainBusy = false

async function mirrorHolds($: EngineInterface): Promise<void> {
  const copy = Object.fromEntries(holds)
  await update($, pausedA, () => copy)
}

async function hold($: EngineInterface, keys: string[], now: number): Promise<void> {
  for (const k of keys) if (!holds.has(k)) holds.set(k, now)
  await mirrorHolds($)
}

async function unhold($: EngineInterface, keys: string[]): Promise<void> {
  if (!keys.some(k => holds.delete(k))) return
  await mirrorHolds($)
}

/** Who was let go from a pause, when, and whether the person sent them a message while they were held. */
const released = new Map<string, { at: number; isRedirect: boolean }>()
/** Loops that were sent a message while held. */
const saidWhileHeld = new Set<string>()

/**
 * One second of waiting that costs the calling hook nothing. `$.clock.sleep` is the hook's own
 * time and a hook has 10s in all, so a pause that polled with it would let go after ten seconds;
 * the time of a `$` call such as a process is not counted.
 */
async function nap($: EngineInterface): Promise<void> {
  try {
    const argv = (await hostOs($)) === 'windows' ? ['ping', '-n', '2', '127.0.0.1'] : ['sleep', '1']
    await $.process.run(argv, { timeoutMs: 5000 })
  } catch {
    await $.clock.sleep(250)
  }
}

/**
 * Holds the call of loop `key` for as long as that loop is paused. Gives `redirect` when the person
 * sent the loop a message meanwhile: the call should not run on the old plan.
 */
async function holdWhilePaused($: EngineInterface, key: string, signal: AbortSignal): Promise<'go' | 'redirect'> {
  const entered = await $.clock.now()
  let isHeld = false
  for (;;) {
    if (!holds.has(key) || signal.aborted) break
    if (key === 'main' && !isMainBusy) break
    isHeld = true
    await nap($)
  }
  const r = released.get(key)
  return isHeld && r !== undefined && r.at >= entered && r.isRedirect ? 'redirect' : 'go'
}

/** The call log `/wd-log` reads: the latest calls of each loop. */
async function logStart($: EngineInterface, key: string, entry: WdLog): Promise<void> {
  await update($, logA, m => ({ ...m, [key]: [...(m[key] ?? []), entry].slice(-LOG_KEEP) }))
}

async function logEnd($: EngineInterface, key: string, id: string, state: WdLog['state']): Promise<void> {
  const endedAt = await $.clock.now()
  await update($, logA, m => {
    const list = m[key]
    return list === undefined ? m : { ...m, [key]: list.map(x => (x.id === id ? { ...x, state, endedAt } : x)) }
  })
}

async function syncAgents($: EngineInterface): Promise<void> {
  const list = await $.agent.list()
  const now = await $.clock.now()
  await update($, agentsA, known => {
    const out: Record<string, WdAgent> = {}
    let top = Object.values(known).reduce((n, a) => Math.max(n, a.n), 0)
    for (const [id, a] of Object.entries(known)) {
      const isStale = a.endedAt > 0 && now - a.endedAt > KEEP_ENDED_MS
      if (!isStale) out[id] = a
    }
    for (const a of list) {
      const prev = out[a.id]
      top = prev === undefined ? top + 1 : top
      out[a.id] = {
        id: a.id,
        n: prev?.n ?? top,
        name: a.name ?? '',
        type: a.type,
        desc: a.description,
        status: a.status,
        model: prev?.model ?? '',
        effort: prev?.effort ?? '',
        tools: prev?.tools ?? 0,
        lastTool: prev?.lastTool ?? '',
        firstSeen: prev?.firstSeen ?? now,
        endedAt: ENDED.has(a.status) ? prev?.endedAt || now : 0,
      }
    }
    return out
  })
  // a stop request lapses once its loop is over
  const agents = await read($, agentsA)
  await update($, stopsA, stops => {
    const next: Record<string, number> = {}
    for (const [key, at] of Object.entries(stops)) {
      const a = agents[key]
      if (key === 'main' || (a !== undefined && !ENDED.has(a.status))) next[key] = at
    }
    return Object.keys(next).length === Object.keys(stops).length ? stops : next
  })
  // so do a pause and the log of an agent that was dropped
  const kept = await read($, agentsA)
  await unhold($, [...holds.keys()].filter(key => key !== 'main' && (kept[key] === undefined || ENDED.has(kept[key].status))))
  await update($, logA, all => {
    const next = Object.fromEntries(Object.entries(all).filter(([key]) => key === 'main' || kept[key] !== undefined))
    return Object.keys(next).length === Object.keys(all).length ? all : next
  })
}

async function refreshUsage($: EngineInterface): Promise<void> {
  const u = await $.session.usage()
  // resets come as wall-clock times; the clock may not be on the epoch, so remember the gap
  const clockNow = await $.clock.now()
  const skew = clockNow > 1e12 ? 0 : Date.now() - clockNow
  await update($, usageA, () => ({
    skew,
    ctxPercent: u.context.percent ?? 0,
    ctxTokens: u.context.tokens ?? 0,
    ctxWindow: u.context.window,
    limits: u.rateLimits.map(l => ({ kind: l.kind, percent: l.percentUsed, resetsAt: l.resetsAt ?? '' })),
    usd: u.cost?.usd ?? 0,
  }))
}

// ---- desktop notifications ----

let osOf: Promise<Os> | undefined

async function detectOs($: EngineInterface): Promise<Os> {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  const { stdout } = await $.process.run(['uname', '-s'], { timeoutMs: 5000 })
  return stdout.trim() === 'Darwin' ? 'mac' : 'other'
}

/** The OS the session runs on, detected once per reload. */
function hostOs($: EngineInterface): Promise<Os> {
  osOf ??= detectOs($).catch(() => 'other' as const)
  return osOf
}

/**
 * A notification on the desktop (Windows toast, macOS banner); elsewhere, or if that fails,
 * through the terminal's own channel. Never throws: it must not hold up the work it reports on.
 */
async function notifyDesktop($: EngineInterface, title: string, body: string): Promise<void> {
  try {
    const cmd = notifyCommand(await hostOs($), title, body)
    if (cmd !== undefined) {
      const r = await $.process.run(cmd.argv, { timeoutMs: 15_000, ...(cmd.env === undefined ? {} : { env: cmd.env }) })
      if (r.exitCode === 0) return
    }
    await $.ui.notify(body, { title })
  } catch {
    // no notification is better than a failed session
  }
}

// ---- drawing ----

function segProps(seg: Seg): { color?: string; dimColor?: boolean; bold?: boolean } {
  const p: { color?: string; dimColor?: boolean; bold?: boolean } = {}
  if (seg.c !== undefined) p.color = seg.c
  if (seg.dim === true) p.dimColor = true
  if (seg.bold === true) p.bold = true
  return p
}

let tickN = 0
const hinted = new Set<string>()
/** Warnings already announced on the desktop; one is announced again only after it cleared. */
const warned = new Set<string>()

/** Drops the held-up calls `isDone` names: the loop went on, so the person answered. */
async function clearWaiting($: EngineInterface, isDone: (id: string, w: WdWait) => boolean): Promise<void> {
  await safe(() =>
    update($, waitingA, m => {
      const kept = Object.entries(m).filter(([id, w]) => !isDone(id, w))
      return kept.length === Object.keys(m).length ? m : Object.fromEntries(kept)
    }),
  )
}

async function tick($: EngineInterface): Promise<void> {
  await safe(async () => {
    const now = await $.clock.now()
    tickN += 1
    await update($, nowA, () => now)
    if (tickN % 4 === 0) await syncAgents($)
    if (tickN % 8 === 0) await refreshUsage($)

    const warnings = warningsOf(await snapOf($))
    for (const w of warnings) {
      if (!warned.has(w.key)) {
        warned.add(w.key)
        void notifyDesktop($, 'Watch Dog: warning', w.text)
      }
    }
    for (const key of [...warned]) if (!warnings.some(w => w.key === key)) warned.delete(key)

    const stops = await read($, stopsA)
    for (const [key, at] of Object.entries(stops)) {
      if (now - at > STOP_HINT_MS && !hinted.has(key)) {
        hinted.add(key)
        $.ui.toast(`Watch Dog: ${key === 'main' ? 'the main loop' : `agent ${key.slice(0, 8)}`} is slow to wrap up. Press Esc to stop it at once.`)
      }
    }
    for (const key of [...hinted]) if (stops[key] === undefined) hinted.delete(key)
  })
}

function cellProps(cell: { fg?: string; bg?: string }): { color?: string; backgroundColor?: string } {
  const p: { color?: string; backgroundColor?: string } = {}
  if (cell.fg !== undefined) p.color = cell.fg
  if (cell.bg !== undefined) p.backgroundColor = cell.bg
  return p
}

export const register: Register = on => {
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wd',
      description: 'Watch Dog: slip a request into running work, pause/resume it, or stop it gracefully',
      argumentHint: 'say <message> | pause | resume | stop [main|agents|#n]',
      immediate: true,
    })
    await $.command.register({
      name: 'wd-log',
      description: 'Watch Dog: what the main loop and the sub-agents did last (default 5 calls each)',
      argumentHint: '[main|agents|#n] [count]',
      immediate: true,
    })
    await $.command.register({
      name: 'wd-help',
      description: 'Watch Dog: which command does what you want, ready to copy',
      argumentHint: '<what you want to do>',
      immediate: true,
    })

    const now = await $.clock.now()
    await update($, nowA, () => now)
    // a reload starts the module over: what it held is forgotten, and the window must not keep saying so
    holds.clear()
    await update($, pausedA, () => ({}))
    isMainBusy = (await read($, turnA)).isRunning
    await safe(async () => {
      const model = await $.session.model()
      await update($, turnA, t => ({ ...t, model }))
    })
    await safe(() => refreshUsage($))

    timer?.cancel()
    timer = $.clock.every(500, () => {
      void tick($)
    })

    return next(e)
  })

  on('session.end', ($, e, next) => {
    timer?.cancel()
    timer = undefined
    return next(e)
  })

  // ---- watching the work ----

  on('turn.start', async ($, e, next) => {
    await safe(async () => {
      const now = await $.clock.now()
      const model = await $.session.model()
      await update($, turnA, t => ({ ...t, isRunning: true, id: e.turnId, text: e.text, startedAt: now, steps: 0, model, last: '' }))
      await update($, countsA, () => ({}))
      await update($, activeA, () => ({}))
      await update($, sentA, () => 0)
      await update($, waitingA, () => ({}))
      await update($, stopsA, s => {
        const { main: _main, ...rest } = s
        return rest
      })
      isMainBusy = true
      await unhold($, ['main'])
      released.delete('main')
      saidWhileHeld.delete('main')
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // a model request follows only once every call of the loop was answered
    await clearWaiting($, (_id, w) => w.agentId === (e.agentId ?? ''))
    await safe(async () => {
      const effort = e.effort === undefined ? '' : String(e.effort)
      if (e.agentId === undefined) {
        await update($, turnA, t => ({ ...t, steps: e.index + 1, model: e.model, effort: effort || t.effort }))
        return
      }
      const id = e.agentId
      await update($, agentsA, m => {
        const a = m[id]
        return a === undefined ? m : { ...m, [id]: { ...a, model: e.model, effort: effort || a.effort } }
      })
    })
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await clearWaiting($, (_id, w) => w.agentId === (e.agentId ?? ''))
    await safe(async () => {
      if (e.agentId === undefined) {
        await update($, turnA, t => ({ ...t, isRunning: false }))
        await update($, activeA, () => ({}))
        await update($, stopsA, s => {
          const { main: _main, ...rest } = s
          return rest
        })
        isMainBusy = false
        await unhold($, ['main'])
      } else {
        const id = e.agentId
        await update($, stopsA, s => {
          const { [id]: _gone, ...rest } = s
          return rest
        })
        await unhold($, [id])
        await syncAgents($)
      }
      await refreshUsage($)
    })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const loop = e.agentId ?? ''
    const key = loop === '' ? 'main' : loop
    const input = e as unknown as Record<string, unknown>
    const label = nameOf(e.tool)
    const brief = briefOf(e.tool, input)
    const refused = async (deny: string) => {
      await safe(async () => logStart($, key, { id: e.tool_use_id, at: await $.clock.now(), tool: label, label: brief, state: 'denied', endedAt: 0 }))
      return { deny }
    }

    // a pause holds the call here until /wd resume; the call in flight is not touched
    if (holds.has(key) && (await holdWhilePaused($, key, next.signal)) === 'redirect') {
      return refused(
        `[Watch Dog] The user paused you and sent a new message meanwhile, so ${e.tool} was not run. Read the user's latest message, fold it into your plan, and continue from there.`,
      )
    }

    // a graceful stop lets the call in flight finish and refuses the next ones
    const stops = await read($, stopsA).catch(() => ({}) as Record<string, number>)
    if (stops[key] !== undefined && !STOP_ALLOW.has(e.tool)) {
      return refused(
        `[Watch Dog] The user asked for a graceful stop, so ${e.tool} was not run. Do not start new work. Reply now with a short wrap-up (done / remaining / unfinished state) and end your turn.`,
      )
    }

    await clearWaiting($, id => id === e.tool_use_id) // it is running: the person said yes
    await safe(async () => {
      await update($, activeA, m => ({ ...m, [e.tool_use_id]: { tool: label, label: brief, agentId: loop } }))
      await update($, countsA, m => ({ ...m, [label]: (m[label] ?? 0) + 1 }))
      await logStart($, key, { id: e.tool_use_id, at: await $.clock.now(), tool: label, label: brief, state: 'run', endedAt: 0 })
      if (loop === '') await update($, turnA, t => ({ ...t, last: `${label} ${brief}`.trim() }))
      if (loop !== '') {
        if ((await read($, agentsA))[loop] === undefined) await syncAgents($)
        await update($, agentsA, m => {
          const a = m[loop]
          return a === undefined ? m : { ...m, [loop]: { ...a, tools: a.tools + 1, lastTool: label } }
        })
      }
      if (e.tool === 'TodoWrite') {
        const todo = todoOf(input)
        if (todo !== undefined) await update($, todosA, m => ({ ...m, [key]: todo }))
      }
    })

    let state: WdLog['state'] = 'done'
    try {
      const ran = await next(e)
      if ('deny' in ran && ran.deny !== undefined) state = 'denied'
      return ran
    } finally {
      await safe(() =>
        update($, activeA, m => {
          const { [e.tool_use_id]: _done, ...rest } = m
          return rest
        }),
      )
      await safe(() => logEnd($, key, e.tool_use_id, state))
    }
  }).catch((_$, e, next) => {
    // this hook is what enforces pause and stop: if it fails before the call went on, the call is refused, not run
    return next.called ? next(e) : { deny: `[Watch Dog] The pause/stop check failed, so ${e.tool} was not run. Tell the user that Watch Dog hit an error before you go on.` }
  })

  // ---- waiting for the person ----

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    // `ask` on a real call puts a dialog (a permission, a question) in front of the person
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      const id = e.tool_use_id
      const input = (typeof e.input === 'object' && e.input !== null ? e.input : {}) as Record<string, unknown>
      const label = briefOf(e.tool, input)
      await safe(async () => {
        const since = await $.clock.now()
        await update($, waitingA, m => ({ ...m, [id]: { tool: nameOf(e.tool), label, agentId: e.agentId ?? '', since } }))
      })
      const body = e.tool === 'AskUserQuestion' ? 'Claude has a question for you.' : `Approve ${nameOf(e.tool)} ${label}?`.replace(/ \?$/, '?')
      void notifyDesktop($, 'Watch Dog: your input is needed', body)
    }
    return verdict
  })

  // ---- the /wd command ----

  on('command.run', { command: 'wd' }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'help') return { text: HELP }
    if (cmd.kind === 'error') return { text: `Watch Dog: ${cmd.message}` }
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') {
      return { text: 'Watch Dog: only a command typed by the user is accepted.' }
    }

    const now = await $.clock.now()
    await safe(() => syncAgents($))
    const agents = Object.values(await read($, agentsA))
    const isLive = (a: WdAgent): boolean => !ENDED.has(a.status)
    const turn = await read($, turnA)
    const heldNow = Object.fromEntries(holds)
    const nameOfKey = (k: string): string => (k === 'main' ? 'main' : `#${agents.find(a => a.id === k)?.n ?? '?'}`)
    const named = (keys: string[]): string => keys.map(nameOfKey).join(', ')

    if (cmd.kind === 'say') {
      if (cmd.target === 'main') {
        if (!turn.isRunning) {
          // nothing is running, so it is an ordinary prompt; not awaited: it starts a turn after this command ends
          void $.prompt.submit({ text: cmd.text }).catch(() => undefined)
          return { text: 'Watch Dog: nothing is running, so it was submitted as an ordinary prompt.' }
        }
        const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: noteOf('say', cmd.text) }] } })
        if ('deny' in r && r.deny !== undefined) return { text: `Watch Dog: the message was refused (${r.deny}).` }
        await update($, sentA, n => n + 1)
        if (heldNow.main !== undefined) {
          saidWhileHeld.add('main')
          return { text: 'Watch Dog: request stored while main is paused; /wd resume makes the model read it before it goes on.' }
        }
        return { text: 'Watch Dog: request slipped into the running work; it is read from the next model call.' }
      }
      const target = agents.find(a => a.n === cmd.target && isLive(a))
      if (target === undefined) return { text: `Watch Dog: no running agent #${cmd.target}.` }
      try {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: noteOf('say', cmd.text) }] }, agentId: target.id })
      } catch (err) {
        return { text: `Watch Dog: could not reach agent #${target.n} (${err instanceof Error ? err.message : 'refused'}).` }
      }
      await update($, sentA, n => n + 1)
      if (heldNow[target.id] !== undefined) {
        saidWhileHeld.add(target.id)
        return { text: `Watch Dog: request stored while agent #${target.n} is paused; /wd resume #${target.n} makes it read the request first.` }
      }
      return { text: `Watch Dog: request slipped into agent #${target.n}.` }
    }

    const live = agents.filter(isLive)

    // the loops a target names: for pause and stop the ones running, for resume the ones held
    const isInScope = (key: string, scope: Scope): boolean => {
      if (scope === 'all') return true
      if (scope === 'main') return key === 'main'
      if (scope === 'agents') return key !== 'main'
      return key !== 'main' && agents.find(a => a.id === key)?.n === scope
    }

    if (cmd.kind === 'resume') {
      const keys = Object.keys(heldNow).filter(k => isInScope(k, cmd.scope))
      if (keys.length === 0) return { text: 'Watch Dog: nothing is paused there.' }
      const isRedirect = keys.some(k => saidWhileHeld.has(k))
      for (const k of keys) {
        released.set(k, { at: now, isRedirect: saidWhileHeld.has(k) })
        saidWhileHeld.delete(k)
      }
      await unhold($, keys)
      return {
        text: `Watch Dog: resumed ${named(keys)}.${isRedirect ? ' The held call is refused once so the model re-plans around your message.' : ''}`,
      }
    }

    const keys: string[] = []
    if ((cmd.scope === 'all' || cmd.scope === 'main') && turn.isRunning) keys.push('main')
    if (cmd.scope === 'all' || cmd.scope === 'agents') keys.push(...live.map(a => a.id))
    if (typeof cmd.scope === 'number') {
      const a = live.find(x => x.n === cmd.scope)
      if (a === undefined) return { text: `Watch Dog: no running agent #${cmd.scope}.` }
      keys.push(a.id)
    }
    if (keys.length === 0) return { text: `Watch Dog: nothing is running to ${cmd.kind}.` }

    if (cmd.kind === 'pause') {
      await hold($, keys, now)
      for (const k of keys) saidWhileHeld.delete(k)
      return {
        text: `Watch Dog: paused ${named(keys)}. The call in flight finishes; the next tool call waits. /wd say ... still works; /wd resume continues.`,
      }
    }

    // stop: it also lets go of a pause, so the loop can wrap up
    await update($, stopsA, s => ({ ...s, ...Object.fromEntries(keys.map(k => [k, now])) }))
    await unhold($, keys)
    for (const k of keys) {
      released.set(k, { at: now, isRedirect: false })
      saidWhileHeld.delete(k)
    }
    const failed: string[] = []
    for (const key of keys) {
      const text = noteOf(key === 'main' ? 'stop-main' : 'stop-agent')
      try {
        await $.session.append({
          message: { type: 'user', content: [{ type: 'text', text }] },
          ...(key === 'main' ? {} : { agentId: key }),
        })
      } catch {
        failed.push(key) // the gate on tool calls still holds the loop
      }
    }
    return {
      text: `Watch Dog: asked ${named(keys)} to wrap up and stop. Calls in flight finish; new work is refused.${failed.length > 0 ? ' (the notice could not be delivered to some; the tool block still applies)' : ''}`,
    }
  })

  // ---- /wd-log and /wd-help (they only read) ----

  on('command.run', { command: 'wd-log' }, async ($, e) => {
    const args = parseLogArgs(e.args)
    if ('error' in args) return { text: `Watch Dog: ${args.error}` }
    await safe(() => syncAgents($))
    return { text: renderLog(await snapOf($), args, await $.clock.now()) }
  })

  on('command.run', { command: 'wd-help' }, (_$, e) => ({ text: helpFor(e.args) }))

  // ---- the window ----

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const snap = await snapOf($)
    const { Box, Text } = $.ui.resolve(e)
    const mood = moodOf(snap)
    const color = moodColor(mood)
    const cols = e.props.bodyColumns
    const maxRows = e.props.maxRows

    const textRow = (row: Row) => (
      <Box>
        {row.map(seg => (
          <Text {...segProps(seg)}>{seg.t}</Text>
        ))}
      </Box>
    )

    // too little room for a frame: one plain line
    if (maxRows < 3 || cols < 30) {
      const rows = buildRows(snap, Math.max(10, cols - 8), 1, mood)
      return textRow(rows[0] ?? [])
    }

    const contentMax = Math.min(5, maxRows - 2)
    const frameWidth = cols - 4 // border and padding
    const GAP = 2
    const MIN_TEXT = 44

    // the pixel dog beside the rows, as big as the room allows: the agent list under
    // the prompt eats rows, so a busy band shrinks the dog instead of dropping it
    const pixelFrame = Math.floor(snap.now / 500)
    let art: PixelRow[] | undefined
    let rows: Row[] = []
    if (frameWidth - ART_WIDTH - GAP >= MIN_TEXT) {
      const size = (['full', 'head', 'mini'] as const).find((z: DogSize) => maxRows >= dogRows(mood, z) + 2)
      if (size !== undefined) {
        rows = buildRows(snap, frameWidth - ART_WIDTH - GAP - 1, size === 'full' ? contentMax : Math.min(contentMax, dogRows(mood, size)), mood)
        art = dog(mood, pixelFrame, size)
      }
    }
    // no room for the dog: the text takes the whole frame
    if (art === undefined) rows = buildRows(snap, frameWidth, contentMax, mood)

    return (
      <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="row">
        {art !== undefined && (
          <Box flexDirection="column" width={ART_WIDTH} marginRight={GAP}>
            {art.map(line => (
              <Box>
                {line.map(cell => (
                  <Text {...cellProps(cell)}>{cell.t}</Text>
                ))}
              </Box>
            ))}
          </Box>
        )}
        <Box flexDirection="column" flexGrow={1}>
          {rows.map(textRow)}
        </Box>
      </Box>
    )
  })
}
