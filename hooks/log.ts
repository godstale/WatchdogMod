import type { WdAgent, WdLog } from '../types'
import { activeAgents } from './view'
import type { Snap } from './view'
import { clock, fit, pad, shortModel } from './util'

export const LOG_KEEP = 20
export const LOG_DEFAULT = 5
const LOG_MAX = 20
/** Finished agents listed after the live ones. */
const ENDED_SHOWN = 3

export type LogArgs = { target: 'all' | 'main' | 'agents' | number; count: number } | { error: string }

/** `[main|agents|#n|all] [count]`, in either order. */
export function parseLogArgs(args: string): LogArgs {
  let target: 'all' | 'main' | 'agents' | number = 'all'
  let count = LOG_DEFAULT
  for (const word of args.trim().split(/\s+/).filter(w => w !== '')) {
    const agent = /^#(\d+)$/.exec(word)
    if (/^main$/i.test(word)) target = 'main'
    else if (/^agents?$/i.test(word)) target = 'agents'
    else if (/^all$/i.test(word)) target = 'all'
    else if (agent !== null) target = Number(agent[1])
    else if (/^\d{1,2}$/.test(word)) count = Math.max(1, Math.min(LOG_MAX, Number(word)))
    else return { error: `unknown "${word}". usage: /wd-log [main|agents|#n] [count]` }
  }
  return { target, count }
}

/** `5s ago`, `2m 03s ago`. */
function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s ago`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s ago`
}

function entryLine(e: WdLog, now: number): string {
  const glyph = e.state === 'run' ? '⚙' : e.state === 'done' ? '✓' : '✗'
  const what = fit(`${e.tool} ${e.label}`.trim(), 48)
  const tail =
    e.state === 'run' ? 'running' : e.state === 'denied' ? 'refused' : e.endedAt > e.at ? `${clock(e.endedAt - e.at)}` : ''
  return `    ${glyph} ${pad(what, 48)} ${ago(now - e.at).padStart(11)}${tail === '' ? '' : `  ${tail}`}`
}

function section(title: string, state: string, entries: WdLog[], count: number, now: number): string[] {
  const out = [`  ${title}  ${state}`]
  const last = entries.slice(-count)
  if (last.length === 0) out.push('    (no tool calls yet)')
  for (const e of last) out.push(entryLine(e, now))
  return out
}

function agentTitle(a: WdAgent): string {
  const name = a.name !== '' ? a.name : a.type
  const model = a.model === '' ? '' : `  ${shortModel(a.model)}${a.effort === '' ? '' : `/${a.effort}`}`
  return `#${a.n} ${name}${a.desc === '' ? '' : ` “${fit(a.desc, 24)}”`}${model}`
}

function agentState(s: Snap, a: WdAgent): string {
  const parts = [a.status]
  if (s.paused[a.id] !== undefined) parts.push('paused')
  if (s.stops[a.id] !== undefined) parts.push('stopping')
  return `(${parts.join(', ')}, tools ${a.tools})`
}

/** What the main loop and the sub-agents did last, as plain text for a command's output. */
export function renderLog(s: Snap, args: Extract<LogArgs, { target: unknown }>, now: number): string {
  const { target, count } = args
  const lines: string[] = [`Watch Dog log: last ${count} tool call${count === 1 ? '' : 's'} of each loop`]
  const wantMain = target === 'all' || target === 'main'
  if (wantMain) {
    const parts = [s.turn.isRunning ? 'running' : 'idle']
    if (s.paused.main !== undefined) parts.push('paused')
    if (s.stops.main !== undefined) parts.push('stopping')
    const model = s.turn.model === '' ? '' : `  ${shortModel(s.turn.model)}${s.turn.effort === '' ? '' : `/${s.turn.effort}`}`
    lines.push(...section(`main${model}`, `(${parts.join(', ')})`, s.log.main ?? [], count, now))
  }

  const live = activeAgents(s)
  const ended = Object.values(s.agents)
    .filter(a => !live.includes(a))
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, ENDED_SHOWN)
    .sort((a, b) => a.n - b.n)
  let agents: WdAgent[] = []
  if (typeof target === 'number') {
    const one = Object.values(s.agents).find(a => a.n === target)
    if (one === undefined) return `Watch Dog: no agent #${target}.`
    agents = [one]
  } else if (target === 'all' || target === 'agents') {
    agents = [...live, ...ended]
  }
  for (const a of agents) lines.push(...section(agentTitle(a), agentState(s, a), s.log[a.id] ?? [], count, now))
  if (agents.length === 0 && target !== 'main') lines.push('  (no sub-agents)')
  return lines.join('\n')
}
