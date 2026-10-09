export type WdTurn = {
  isRunning: boolean
  id: string
  text: string
  startedAt: number
  steps: number
  model: string
  effort: string
  /** The main loop's latest tool call, `Edit auth.ts`: what it did last, or is doing. */
  last: string
}

export type WdTodo = { done: number; total: number; current: string }

export type WdAgent = {
  id: string
  n: number
  name: string
  type: string
  desc: string
  status: string
  model: string
  effort: string
  tools: number
  lastTool: string
  firstSeen: number
  endedAt: number
}

export type WdActive = { tool: string; label: string; agentId: string }

/** A call held up for the person (a permission or a question), keyed by its tool_use_id. */
export type WdWait = { tool: string; label: string; agentId: string; since: number }

/** One tool call of a loop, for `/wd-log`: `run` while it runs, `done` once it returned, `denied` when Watch Dog refused it. */
export type WdLog = { id: string; at: number; tool: string; label: string; state: 'run' | 'done' | 'denied'; endedAt: number }

export type WdLimit = { kind: string; percent: number; resetsAt: string }

export type WdUsage = {
  ctxPercent: number
  ctxTokens: number
  ctxWindow: number
  limits: WdLimit[]
  usd: number
  /** Wall time less the clock's time, ms: 0 when the clock is on the epoch. */
  skew?: number
}

declare module 'claude-code' {
  interface PluginState {
    watchdog: {
      turn: WdTurn
      agents: Record<string, WdAgent>
      active: Record<string, WdActive>
      counts: Record<string, number>
      todos: Record<string, WdTodo>
      stops: Record<string, number>
      /** Loops held by `/wd pause`, by `main` or agent id, with the time the hold began. */
      paused: Record<string, number>
      /** The latest calls of each loop (`main` or agent id), oldest first. */
      log: Record<string, WdLog[]>
      waiting: Record<string, WdWait>
      usage: WdUsage
      sent: number
      now: number
    }
  }
}
