import { describe, expect, test } from 'claude-code/testing'

import type { WdAgent, WdLog } from '../types'
import { cells, fit, parseArgs, shortModel, untilReset } from '../hooks/util'
import { helpFor } from '../hooks/help'
import { parseLogArgs, renderLog } from '../hooks/log'
import { buildRows, fitRow, moodOf, rowWidth, warningsOf } from '../hooks/view'
import { ART_WIDTH, dog, dogGridOf, dogRows } from '../hooks/art'
import { notifyCommand } from '../hooks/notify'
import type { Mood } from '../hooks/art'
import type { Snap } from '../hooks/view'

const MOODS: readonly Mood[] = ['idle', 'working', 'stopping', 'warning', 'input']

const agent = (n: number, over: Partial<WdAgent> = {}): WdAgent => ({
  id: `a${n}`,
  n,
  name: `worker${n}`,
  type: 'Explore',
  desc: 'scan the repo for usages',
  status: 'running',
  model: 'claude-haiku-5-5',
  effort: 'low',
  tools: 4 + n,
  lastTool: 'Grep',
  firstSeen: 0,
  endedAt: 0,
  ...over,
})

const snap = (over: Partial<Snap> = {}): Snap => ({
  turn: { isRunning: true, id: 't1', text: '인증 모듈을 리팩터링해줘', startedAt: 0, steps: 7, model: 'claude-opus-5-5', effort: 'high', last: '' },
  agents: {},
  active: {},
  counts: { Bash: 3, Edit: 2, Read: 5 },
  todos: {},
  stops: {},
  paused: {},
  log: {},
  waiting: {},
  usage: { ctxPercent: 42, ctxTokens: 84_000, ctxWindow: 200_000, limits: [{ kind: 'five_hour', percent: 23, resetsAt: '' }], usd: 1.23 },
  sent: 0,
  now: 47_000,
  ...over,
})

describe('/wd arguments', () => {
  test('no arguments or "help" shows the help', () => {
    expect(parseArgs('').kind).toBe('help')
    expect(parseArgs('  help ').kind).toBe('help')
  })

  test('say goes to the main loop or to #n', () => {
    expect(parseArgs('say 테스트도 돌려줘')).toEqual({ kind: 'say', target: 'main', text: '테스트도 돌려줘' })
    expect(parseArgs('say #2 stop scanning tests')).toEqual({ kind: 'say', target: 2, text: 'stop scanning tests' })
  })

  test('stop scopes', () => {
    expect(parseArgs('stop')).toEqual({ kind: 'stop', scope: 'all' })
    expect(parseArgs('stop main')).toEqual({ kind: 'stop', scope: 'main' })
    expect(parseArgs('stop agents')).toEqual({ kind: 'stop', scope: 'agents' })
    expect(parseArgs('stop #3')).toEqual({ kind: 'stop', scope: 3 })
  })

  test('pause and resume take the same targets as stop', () => {
    expect(parseArgs('pause')).toEqual({ kind: 'pause', scope: 'all' })
    expect(parseArgs('pause main')).toEqual({ kind: 'pause', scope: 'main' })
    expect(parseArgs('resume #2')).toEqual({ kind: 'resume', scope: 2 })
    expect(parseArgs('resume agents')).toEqual({ kind: 'resume', scope: 'agents' })
    expect(parseArgs('pause everyone').kind).toBe('error')
  })

  test('the verb is case-blind and the message keeps its own spacing', () => {
    expect(parseArgs('SAY   keep   two spaces')).toEqual({ kind: 'say', target: 'main', text: 'keep   two spaces' })
  })

  test('an empty say, or a say to #n with nothing after it, is an error', () => {
    expect(parseArgs('say').kind).toBe('error')
    expect(parseArgs('say #2').kind).toBe('error')
    expect(parseArgs('dance').kind).toBe('error')
  })

  test('the old form with a six-digit code is refused with the new usage', () => {
    const r = parseArgs('123456 say hello')
    expect(r.kind).toBe('error')
    expect(r.kind === 'error' && r.message).toContain('no code needed')
    expect(parseArgs('123456').kind).toBe('error')
  })
})

describe('text fitting', () => {
  test('Korean counts two cells a letter', () => {
    expect(cells('작업')).toBe(4)
    expect(cells('ab')).toBe(2)
  })

  test('fit never exceeds the width', () => {
    for (const w of [1, 5, 9, 20]) {
      expect(cells(fit('인증 모듈을 리팩터링해줘 and then some english', w))).toBeLessThanOrEqual(w)
    }
  })
})

describe('the window', () => {
  const widths = [50, 80, 120]

  test('idle is a three-row window ending in a hint', () => {
    const s = snap({ turn: { ...snap().turn, isRunning: false } })
    const rows = buildRows(s, 120, 5, moodOf(s))
    expect(rows.length).toBe(3)
    expect(rows[2]?.map(x => x.t).join('')).toContain('/wd say')
  })

  test('the model and effort sit beside the title, not in the rows below', () => {
    const s = snap({ turn: { ...snap().turn, model: 'claude-sonnet-5-5', effort: 'high' } })
    const rows = buildRows(s, 140, 5, moodOf(s)).map(r => r.map(x => x.t).join(''))
    expect(rows[0]).toMatch(/^WATCH DOG {2}sonnet5\.5\/high {2}/)
    expect(rows.slice(1).join('\n')).not.toContain('sonnet5.5')
    const idle = snap({ turn: { ...snap().turn, isRunning: false, model: 'claude-sonnet-5-5', effort: '' } })
    expect(buildRows(idle, 140, 5, moodOf(idle))[0]?.map(x => x.t).join('')).toMatch(/^WATCH DOG {2}sonnet5\.5 {2}○ Idle/)
    const unknown = snap({ turn: { ...snap().turn, model: '' } })
    expect(buildRows(unknown, 140, 5, moodOf(unknown))[0]?.map(x => x.t).join('')).toMatch(/^WATCH DOG {2}[⠀-⣿] Working/)
  })

  test('the usage line reads as asked', () => {
    const s = snap({
      turn: { ...snap().turn, isRunning: false, model: 'claude-sonnet-5-5', effort: 'high' },
      usage: { ctxPercent: 24, ctxTokens: 239_000, ctxWindow: 1_000_000, usd: 3.23, limits: [
        { kind: 'five_hour', percent: 9, resetsAt: new Date(snap().now + (3 * 60 + 12) * 60_000).toISOString() },
        { kind: 'seven_day', percent: 1, resetsAt: new Date(snap().now + 6 * 86_400_000).toISOString() },
      ] },
    })
    const line = buildRows(s, 200, 5, moodOf(s))[1]?.map(x => x.t).join('')
    expect(line).toBe('ctx 24%, 239k/1.0M │ limit 5h(9%), 7d(1%), reset(3h 12m) │ Used $3.23')
  })

  test('busy with todos shows the progress', () => {
    const s = snap({ todos: { main: { done: 7, total: 10, current: 'Run the tests' } } })
    const text = buildRows(s, 100, 5, moodOf(s)).map(r => r.map(x => x.t).join('')).join('\n')
    expect(text).toContain('7/10')
    expect(text).toContain('70%')
  })

  test('rows stay between one and five and never overflow, whatever the room', () => {
    const agents = Object.fromEntries([1, 2, 3, 4].map(n => [`a${n}`, agent(n)]))
    const done = agent(5, { status: 'completed', endedAt: 1 })
    const s = snap({ agents: { ...agents, a5: done }, stops: { a2: 1 } })
    for (const width of widths) {
      for (const room of [1, 2, 3, 4, 5, 9]) {
        const rows = buildRows(s, width, room, moodOf(s))
        expect(rows.length).toBeGreaterThanOrEqual(1)
        expect(rows.length).toBeLessThanOrEqual(Math.min(5, room))
        for (const row of rows) expect(rowWidth(row)).toBeLessThanOrEqual(width)
      }
    }
  })

  test('live agents come before the tools row when room is short', () => {
    const agents = Object.fromEntries([1, 2, 3].map(n => [`a${n}`, agent(n)]))
    const s = snap({ agents })
    const text = buildRows(s, 120, 4, moodOf(s)).map(r => r.map(x => x.t).join('')).join('\n')
    expect(text).toContain('#1')
    expect(text).toContain('#2')
    expect(text).not.toContain('tools Bash')
  })

  test('finished agents are summarised, not listed', () => {
    const s = snap({ agents: { a1: agent(1), a2: agent(2, { status: 'completed', endedAt: 1 }), a3: agent(3, { status: 'failed', endedAt: 1 }) } })
    const text = buildRows(s, 120, 5, moodOf(s)).map(r => r.map(x => x.t).join('')).join('\n')
    expect(text).toContain('✓ 1')
    expect(text).toContain('✗ 1')
    expect(text).not.toContain('#2')
  })

  test('fitRow cuts at the width', () => {
    expect(rowWidth(fitRow([{ t: 'abcdefghij' }, { t: 'klmnop' }], 12))).toBeLessThanOrEqual(12)
  })
})

describe('wording and the dog', () => {
  test('model names and resets are short', () => {
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet5.5')
    expect(shortModel('claude-fable-5-1')).toBe('fable5.1')
    expect(untilReset(new Date(60_000 * 75).toISOString(), 0)).toBe('1h 15m')
    expect(untilReset(new Date(60_000 * 45).toISOString(), 0)).toBe('45m')
    expect(untilReset(new Date(60_000 * (1440 * 2 + 180)).toISOString(), 0)).toBe('2d 3h')
  })

  test('nothing on screen is Korean', () => {
    const agents = { a1: agent(1), a2: agent(2, { status: 'completed', endedAt: 1 }) }
    const en = { ...snap().turn, text: 'refactor the auth module' }
    for (const s of [snap({ turn: en }), snap({ turn: en, agents }), snap({ turn: { ...en, isRunning: false } }), snap({ turn: en, stops: { main: 1 } })]) {
      const text = buildRows(s, 140, 5, moodOf(s)).map(r => r.map(x => x.t).join('')).join('\n')
      expect(text).not.toMatch(/[가-힣]/)
    }
  })

  test('every pose has a full grid and every frame is as wide as the art', () => {
    for (const mood of MOODS) {
      for (let f = 0; f < 8; f++) {
        const grid = dogGridOf(mood, f)
        expect(grid.length).toBe(dogRows(mood) * 2)
        for (const row of grid) expect(row.length).toBe(ART_WIDTH)
        const rows = dog(mood, f)
        expect(rows.length).toBe(dogRows(mood))
        for (const row of rows) expect(row.reduce((n, c) => n + c.t.length, 0)).toBe(ART_WIDTH)
      }
    }
  })

  test('a working dog moves: its frames differ', () => {
    const frames = new Set([0, 1, 2, 3].map(f => dogGridOf('working', f).join('/')))
    expect(frames.size).toBe(4)
  })

  test('an idle dog is a still picture', () => {
    for (const size of ['full', 'head', 'mini'] as const) {
      const frames = new Set([0, 1, 2, 3, 4, 5].map(f => JSON.stringify(dog('idle', f, size))))
      expect(frames.size).toBe(1)
    }
  })

  test('every state has a picture of its own, and the alerting ones move', () => {
    const looks = MOODS.map(m => dogGridOf(m, 0).join('/'))
    expect(new Set(looks).size).toBe(MOODS.length)
    for (const mood of ['stopping', 'warning', 'input'] as const) {
      expect(new Set([0, 1, 2, 3].map(f => JSON.stringify(dog(mood, f)))).size).toBeGreaterThan(1)
    }
  })

  test('a squeezed band still gets a moving dog: the head and the mini face', () => {
    for (const size of ['head', 'mini'] as const) {
      for (const mood of MOODS) {
        for (let f = 0; f < 4; f++) {
          expect(dogGridOf(mood, f, size).length).toBe(dogRows(mood, size) * 2)
          const rows = dog(mood, f, size)
          expect(rows.length).toBe(dogRows(mood, size))
          for (const row of rows) expect(row.reduce((n, c) => n + c.t.length, 0)).toBe(ART_WIDTH)
        }
      }
      const frames = new Set([0, 1, 2, 3].map(f => dogGridOf('working', f, size).join('/')))
      expect(frames.size).toBe(4)
    }
  })

  test('the task row names what is running now, not just the prompt', () => {
    const line = (s: Snap) => (buildRows(s, 120, 5, moodOf(s))[1] ?? []).map(x => x.t).join('')
    const run = { tool: 'Bash', label: 'sleep 5', agentId: '' }
    expect(line(snap({ active: { u1: run } }))).toContain('⚙ Bash sleep 5')
    const agentCall = { tool: 'Agent', label: 'wd-long', agentId: '' }
    const live = { a1: agent(1), a2: agent(2) }
    expect(line(snap({ active: { u1: agentCall }, agents: live }))).toContain('waiting for 2 agents')
    expect(line(snap({ todos: { main: { done: 1, total: 3, current: 'Run the tests' } } }))).toContain('→ Run the tests')
    expect(line(snap({ turn: { ...snap().turn, last: 'Edit auth.ts' } }))).toContain('✓ Edit auth.ts')
    expect(line(snap())).toContain('thinking')
  })

  test('the reset time counts from wall time even when the clock is not on the epoch', () => {
    const wall = Date.now()
    const s = snap({
      turn: { ...snap().turn, isRunning: false },
      usage: { ctxPercent: 24, ctxTokens: 1, ctxWindow: 100, usd: 0, skew: wall - 47_000, limits: [
        { kind: 'five_hour', percent: 9, resetsAt: new Date(wall + (3 * 60 + 24) * 60_000).toISOString() },
      ] },
    })
    const line = buildRows(s, 200, 5, moodOf(s))[1]?.map(x => x.t).join('')
    expect(line).toContain('reset(3h 24m)')
  })

  test('sub-agents hang under the task row as a tree', () => {
    const s = snap({ agents: { a1: agent(1), a2: agent(2), a3: agent(3) } })
    const rows = buildRows(s, 140, 5, moodOf(s)).map(r => r.map(x => x.t).join(''))
    const tree = rows.filter(r => /^[├└]─ /.test(r))
    expect(tree.length).toBeGreaterThan(0)
    expect(tree.slice(0, -1).every(r => r.startsWith('├─ '))).toBe(true)
    expect(tree[tree.length - 1]?.startsWith('└─ ')).toBe(true)
    expect(rows.findIndex(r => r.startsWith('▶'))).toBeLessThan(rows.findIndex(r => r.startsWith('├─ ') || r.startsWith('└─ ')))
  })
})

describe('states', () => {
  const idle = snap({ turn: { ...snap().turn, isRunning: false } })
  const wait = { u1: { tool: 'Bash', label: 'npm test', agentId: '', since: 1 } }

  test('idle, working, stopping and input', () => {
    expect(moodOf(idle)).toBe('idle')
    expect(moodOf(snap())).toBe('working')
    expect(moodOf(snap({ stops: { main: 1 } }))).toBe('stopping')
    expect(moodOf(snap({ waiting: wait }))).toBe('input')
  })

  test('a person to answer outranks everything, a stop outranks a warning', () => {
    const full = { ...snap().usage, ctxPercent: 95 }
    expect(moodOf(snap({ usage: full, stops: { main: 1 }, waiting: wait }))).toBe('input')
    expect(moodOf(snap({ usage: full, stops: { main: 1 } }))).toBe('stopping')
  })

  test('a nearly full limit or context, or a fresh failure, is a warning', () => {
    expect(warningsOf(idle)).toEqual([])
    const limit = snap({ usage: { ...idle.usage, limits: [{ kind: 'five_hour', percent: 93, resetsAt: '' }] } })
    expect(warningsOf(limit).map(w => w.text)).toEqual(['5h limit 93%'])
    expect(moodOf(limit)).toBe('warning')
    expect(warningsOf(snap({ usage: { ...idle.usage, ctxPercent: 91 } })).map(w => w.key)).toEqual(['ctx'])
    const failed = snap({ agents: { a3: agent(3, { status: 'failed', endedAt: 40_000 }) } })
    expect(warningsOf(failed).map(w => w.text)).toEqual(['agent #3 failed'])
    const old = snap({ agents: { a3: agent(3, { status: 'failed', endedAt: 1 }), a4: agent(4, { status: 'killed', endedAt: 46_000 }) }, now: 200_000 })
    expect(warningsOf(old)).toEqual([])
  })

  test('the window says what it waits for, and keeps the working timer under a warning', () => {
    const header = (s: Snap) => (buildRows(s, 140, 5, moodOf(s))[0] ?? []).map(x => x.t).join('')
    expect(header(snap({ waiting: wait }))).toContain('Waiting for you: Bash')
    const limit = snap({ usage: { ...snap().usage, limits: [{ kind: 'seven_day', percent: 95, resetsAt: '' }] } })
    expect(header(limit)).toContain('Working')
    expect(header(limit)).toContain('⚠ 7d limit 95%')
  })
})

describe('desktop notification', () => {
  test('Windows runs a PowerShell toast and passes the text through the environment', () => {
    const cmd = notifyCommand('windows', 'Watch Dog', 'say "hi" & <b>')
    expect(cmd?.argv[0]).toBe('powershell.exe')
    expect(cmd?.env).toEqual({ WD_TITLE: 'Watch Dog', WD_BODY: 'say "hi" & <b>' })
    expect(cmd?.argv.join(' ')).not.toContain('say "hi"')
  })

  test('macOS runs osascript with the text as arguments', () => {
    const cmd = notifyCommand('mac', 'Watch Dog', "it's here")
    expect(cmd?.argv[0]).toBe('osascript')
    expect(cmd?.argv.slice(-2)).toEqual(['Watch Dog', "it's here"])
  })

  test('elsewhere there is no command: the terminal channel is used', () => {
    expect(notifyCommand('other', 'a', 'b')).toBeUndefined()
  })
})

describe('pause', () => {
  test('a pause turns the dog to the stop pose, says who is held, and marks the agent', () => {
    const s = snap({ agents: { a1: agent(1), a2: agent(2) }, paused: { main: 40_000, a2: 40_000 } })
    expect(moodOf(s)).toBe('stopping')
    const rows = buildRows(s, 140, 5, moodOf(s)).map(r => r.map(x => x.t).join(''))
    expect(rows[0]).toContain('⏸ Paused main, #2 00:07')
    expect(rows.find(r => r.includes('#2'))).toContain('⏸')
    expect(rows.find(r => r.includes('#1'))).not.toContain('⏸')
  })

  test('a stop outranks the pause in the header, a question outranks both', () => {
    const header = (s: Snap) => (buildRows(s, 140, 5, moodOf(s))[0] ?? []).map(x => x.t).join('')
    expect(header(snap({ paused: { main: 1 }, stops: { main: 1 } }))).toContain('Stopping gracefully')
    const wait = { u1: { tool: 'Bash', label: 'npm test', agentId: '', since: 1 } }
    expect(moodOf(snap({ paused: { main: 1 }, waiting: wait }))).toBe('input')
  })
})

describe('/wd-log', () => {
  const call = (n: number, over: Partial<WdLog> = {}): WdLog => ({ id: `u${n}`, at: 1_000 * n, tool: 'Bash', label: `sleep ${n}`, state: 'done', endedAt: 1_000 * n + 5_000, ...over })
  const calls = (n: number): WdLog[] => Array.from({ length: n }, (_, i) => call(i + 1))

  test('arguments: target and count in either order, nothing else', () => {
    expect(parseLogArgs('')).toEqual({ target: 'all', count: 5 })
    expect(parseLogArgs('main 10')).toEqual({ target: 'main', count: 10 })
    expect(parseLogArgs('3 #2')).toEqual({ target: 2, count: 3 })
    expect(parseLogArgs('99')).toEqual({ target: 'all', count: 20 })
    expect('error' in parseLogArgs('whatever')).toBe(true)
  })

  test('lists the last five calls of main and of each agent, newest last', () => {
    const s = snap({
      agents: { a1: agent(1), a2: agent(2, { status: 'completed', endedAt: 30_000 }) },
      log: { main: calls(8), a1: [call(1, { state: 'run', endedAt: 0 }), call(2, { state: 'denied', endedAt: 0 })], a2: calls(2) },
      paused: { a1: 40_000 },
    })
    const text = renderLog(s, { target: 'all', count: 5 }, 47_000)
    expect(text).toContain('main  opus5.5/high  (running)')
    expect(text).toContain('sleep 8')
    expect(text).toContain('sleep 4')
    expect(text).not.toContain('sleep 3 ')
    expect(text.indexOf('sleep 4')).toBeLessThan(text.indexOf('sleep 8'))
    expect(text).toContain('#1 worker1')
    expect(text).toContain('(running, paused, tools 5)')
    expect(text).toContain('running')
    expect(text).toContain('refused')
    expect(text).toContain('#2 worker2')
    expect(text).toContain('(completed, tools 6)')
    expect(text).toContain('00:05')
    expect(text).toContain('39s ago')
  })

  test('one loop, and an unknown agent', () => {
    const s = snap({ agents: { a1: agent(1) }, log: { main: calls(2), a1: calls(3) } })
    const only = renderLog(s, { target: 1, count: 5 }, 47_000)
    expect(only).toContain('#1 worker1')
    expect(only).not.toContain('main')
    expect(renderLog(s, { target: 9, count: 5 }, 47_000)).toContain('no agent #9')
    expect(renderLog(snap(), { target: 'all', count: 5 }, 47_000)).toContain('(no tool calls yet)')
  })
})

describe('/wd-help', () => {
  test('finds the command for what the person wants, in Korean or English', () => {
    expect(helpFor('작업을 잠깐 멈추고 싶어')).toContain('/wd pause')
    expect(helpFor('다시 계속 진행해줘')).toContain('/wd resume')
    expect(helpFor('서브 에이전트한테 요청 추가하고 싶어')).toContain('/wd say #2 <메시지>')
    expect(helpFor('정리하고 끝내줘')).toContain('/wd stop')
    expect(helpFor('에이전트가 뭐 했는지 보여줘')).toContain('/wd-log')
    expect(helpFor('how do I pause everything')).toContain('hold before the next tool call')
    expect(helpFor('show me the recent history')).toContain('/wd-log')
  })

  test('commands are copyable as written, with no code to fill in', () => {
    const text = helpFor('pause')
    expect(text).not.toMatch(/\d{6}/)
    expect(text).toContain('/wd pause')
  })

  test('nothing matched, or nothing asked, lists the commands', () => {
    for (const q of ['', 'xyzzy']) {
      const text = helpFor(q)
      for (const c of ['say', 'pause', 'stop', '/wd-log']) expect(text).toContain(c)
    }
    expect(helpFor('xyzzy')).toContain('Nothing matched')
  })
})
