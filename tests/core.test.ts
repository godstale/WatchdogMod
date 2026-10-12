import { describe, expect, test } from 'claude-code/testing'

import type { WdAgent, WdLog } from '../types'
import { cells, fit, parseArgs, shortModel, untilReset } from '../hooks/util'
import { helpFor } from '../hooks/help'
import { parseLogArgs, renderLog } from '../hooks/log'
import { agoShort, gitGraph, gitRows, laneColor, layoutGraph, parseBranches, parseGitLog, parseGraphArgs, parseRefs, parseStatus, renderGitGraph, rowsText } from '../hooks/git'
import type { GitCommit, GitData, GitHead } from '../hooks/git'
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
  test('Windows runs the toast through wscript (no console window) and passes the text through the environment', () => {
    const cmd = notifyCommand('windows', 'Watch Dog', 'say "hi" & <b>', 'C:\\p')
    expect(cmd?.argv).toEqual(['wscript.exe', '//B', '//Nologo', 'C:\\p\\hooks\\win\\toast.vbs'])
    expect(cmd?.env).toEqual({ WD_TITLE: 'Watch Dog', WD_BODY: 'say "hi" & <b>' })
    expect(cmd?.argv.join(' ')).not.toContain('say "hi"')
  })

  test('macOS runs osascript with the text as arguments', () => {
    const cmd = notifyCommand('mac', 'Watch Dog', "it's here", '/p')
    expect(cmd?.argv[0]).toBe('osascript')
    expect(cmd?.argv.slice(-2)).toEqual(['Watch Dog', "it's here"])
  })

  test('elsewhere there is no command: the terminal channel is used', () => {
    expect(notifyCommand('other', 'a', 'b', '/p')).toBeUndefined()
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

describe('/wd-git-graph', () => {
  const commit = (hash: string, parents: string[], over: Partial<GitCommit> = {}): GitCommit => ({ hash, parents, refs: [], author: 'dev', at: 1_000, subject: `commit ${hash}`, ...over })
  const text = (lines: { text: string }[]) => lines.map(l => l.text.trimEnd())
  const rowText0 = (row: { t: string }[]) => row.map(x => x.t).join('')
  const forkAndMerge = () => [commit('m', ['b', 'f']), commit('f', ['base']), commit('b', ['base']), commit('base', [])]

  test('arguments: count and scope in either order, nothing else', () => {
    expect(parseGraphArgs('')).toEqual({ count: 30, scope: 'all' })
    expect(parseGraphArgs('local 50')).toEqual({ count: 50, scope: 'local' })
    expect(parseGraphArgs('999')).toEqual({ count: 200, scope: 'all' })
    expect(parseGraphArgs('0')).toEqual({ count: 1, scope: 'all' })
    expect('error' in parseGraphArgs('remote')).toBe(true)
  })

  test('refs are told apart by their full names, the current branch first, origin/HEAD left out', () => {
    const refs = parseRefs('tag: refs/tags/v1.0, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/heads/feat/x, HEAD -> refs/heads/main')
    expect(refs).toEqual([
      { kind: 'head', name: 'main' },
      { kind: 'branch', name: 'feat/x' },
      { kind: 'remote', name: 'origin/main' },
      { kind: 'tag', name: 'v1.0' },
    ])
    expect(parseRefs('HEAD')).toEqual([{ kind: 'head', name: 'HEAD' }])
    expect(parseRefs('')).toEqual([])
  })

  test('the log, the status and the branch list are read as git prints them', () => {
    const log = ['aaa', 'bbb ccc', 'HEAD -> refs/heads/main', 'Dev', '1700000000', 'Merge: a | b'].join('\x1f')
    expect(parseGitLog(`${log}\r\n`)).toEqual([
      { hash: 'aaa', parents: ['bbb', 'ccc'], refs: [{ kind: 'head', name: 'main' }], author: 'Dev', at: 1_700_000_000, subject: 'Merge: a | b' },
    ])
    const status = parseStatus(
      ['# branch.oid abc1234', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1', '# stash 3', '1 M. N... 100644 100644 100644 a b f1', '1 .M N... 100644 100644 100644 a b f2', '1 MM N... 100644 100644 100644 a b f3', 'u UU N... 1 2 3 4 a b c f4', '? new.txt'].join('\n'),
    )
    expect(status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, stash: 3, staged: 2, modified: 2, conflicted: 1, untracked: 1 })
    expect(parseStatus('# branch.oid abc\n# branch.head (detached)').branch).toBe('')
    const branches = parseBranches('*\tmain\torigin/main\t[ahead 2, behind 1]\tabc1234\n \tfeat\t\t\tdef5678\n \told\torigin/old\t[gone]\t0000000')
    expect(branches.map(b => [b.name, b.isHead, b.ahead, b.behind, b.isGone])).toEqual([
      ['main', true, 2, 1, false],
      ['feat', false, 0, 0, false],
      ['old', false, 0, 0, true],
    ])
  })

  test('a straight history is one lane, newest on top', () => {
    const { lines, width } = layoutGraph([commit('c', ['b']), commit('b', ['a']), commit('a', [])])
    expect(text(lines)).toEqual(['●', '●', '●'])
    expect(lines.map(l => l.commit)).toEqual([0, 1, 2])
    expect(width).toBe(1)
  })

  test('a merge parts into two lanes and a fork joins them again', () => {
    const { lines } = layoutGraph(forkAndMerge())
    expect(text(lines)).toEqual(['●', '├─╮', '│ ●', '● │', '├─╯', '●'])
    expect(lines.filter(l => l.commit !== undefined).map(l => l.commit)).toEqual([0, 1, 2, 3])
  })

  test('an octopus merge opens a lane for each parent', () => {
    const { lines } = layoutGraph([commit('m', ['a', 'b', 'c']), commit('c', ['a']), commit('b', ['a']), commit('a', [])])
    const rows = text(lines)
    expect(rows[0]).toBe('●')
    expect(rows[1]).toBe('├─┬─╮')
    expect(rows.filter(r => r.includes('●')).length).toBe(4)
  })

  test('the commit HEAD is on is marked, and a lane of a cut history stays open', () => {
    const { lines } = layoutGraph([commit('b', ['a']), commit('x', ['gone'])], 'x')
    expect(text(lines)).toEqual(['●', '│ ◉'])
  })

  test('the picture is made of box lines and commit marks only, and no row is wider than the picture', () => {
    const { lines, width } = layoutGraph(forkAndMerge())
    for (const l of lines) {
      expect(l.text).toMatch(/^[●◉│├╮╯╭╰┤┬┴┼─ ]+$/)
      expect(cells(l.text)).toBeLessThanOrEqual(width)
    }
  })

  const head = (over: Partial<GitHead> = {}): GitHead => ({ branch: 'main', oid: 'b', upstream: 'origin/main', ahead: 0, behind: 0, stash: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0, ...over })
  const data = (over: Partial<GitData> = {}): GitData => ({
    commits: [
      commit('b', ['a'], { refs: [{ kind: 'head', name: 'main' }, { kind: 'remote', name: 'origin/main' }, { kind: 'tag', name: 'v1.0' }], subject: 'Add the thing' }),
      commit('a', [], { subject: 'Initial commit' }),
    ],
    head: head(),
    branches: [{ isHead: true, name: 'main', upstream: 'origin/main', ahead: 0, behind: 0, isGone: false, oid: 'bbbbbbb' }],
    count: 30,
    scope: 'all',
    ...over,
  })

  test('the picture has a header with the state of the repo, the graph, and a legend', () => {
    const out = renderGitGraph(data(), 100, 1_000_000)
    expect(out).toContain('HEAD      main → origin/main in sync')
    expect(out).toContain('Work tree clean')
    expect(out).toContain('[HEAD → main] [origin/main] (v1.0) Add the thing')
    expect(out).toContain('Initial commit')
    expect(out).toContain('◉  ')
    expect(out).toContain('● commit')
    const dirty = renderGitGraph(data({ head: head({ branch: '', oid: 'b', staged: 2, modified: 1, untracked: 3, stash: 1, upstream: '' }) }), 100, 1_000_000)
    expect(dirty).toContain('detached at b')
    expect(dirty).toContain('2 staged, 1 modified, 3 untracked | stash 1')
  })

  test('a full page says there may be more commits', () => {
    expect(renderGitGraph(data({ count: 2 }), 100, 1_000_000)).toContain('/wd-git-graph <n> for more')
    expect(renderGitGraph(data({ count: 30 }), 100, 1_000_000)).not.toContain('for more')
  })

  test('the author column shows only with several authors and room to spare', () => {
    const two = data({ commits: [commit('b', ['a'], { author: 'Alice Anderson', subject: 'Add the thing' }), commit('a', [], { author: 'Bob', subject: 'Initial commit' })] })
    expect(renderGitGraph(two, 140, 1_000_000)).toContain('Alice Ander…')
    expect(renderGitGraph(two, 60, 1_000_000)).not.toContain('Alice')
    expect(renderGitGraph(data(), 140, 1_000_000)).not.toContain('dev')
  })

  test('every line fits the width, in English and in Korean, wide or narrow', () => {
    const korean = data({
      commits: [
        commit('b', ['a'], {
          subject: '인증 모듈을 리팩터링하고 테스트를 추가했습니다 그리고 더 길게',
          refs: [{ kind: 'head', name: 'feature/아주-긴-브랜치-이름' }, { kind: 'remote', name: 'origin/main' }, { kind: 'tag', name: 'v1' }],
        }),
        commit('a', []),
      ],
    })
    for (const cols of [50, 80, 140]) {
      for (const d of [data(), korean]) {
        for (const line of renderGitGraph(d, cols, 1_000_000).split('\n')) expect(cells(line)).toBeLessThanOrEqual(Math.max(40, cols - 6))
      }
    }
  })

  test('the lines of the screen are English: nothing is Korean but the commits themselves', () => {
    expect(renderGitGraph(data(), 100, 1_000_000)).not.toMatch(/[가-힣]/)
    expect(renderGitGraph(data({ commits: [] }), 100, 1_000_000)).toContain('(no commits)')
  })

  test('how long ago, in a few characters', () => {
    expect([5, 90, 7_200, 3 * 86_400, 70 * 86_400, 800 * 86_400].map(agoShort)).toEqual(['5s ago', '1m ago', '2h ago', '3d ago', '2mo ago', '2y ago'])
  })

  test('a failed git comes back as a sentence, not a throw', async () => {
    const fail = (stderr: string) => async () => ({ exitCode: 128, stdout: '', stderr })
    const args = { count: 5, scope: 'all' } as const
    expect((await gitGraph(fail('fatal: not a git repository (or any of the parent directories): .git'), args, 100, 0)).text).toContain('not inside a git repository')
    expect((await gitGraph(fail("fatal: your current branch 'main' does not have any commits yet"), args, 100, 0)).text).toContain('no commits yet')
    const broken = async (): Promise<never> => {
      throw new Error('spawn git ENOENT')
    }
    expect((await gitGraph(broken, args, 100, 0)).text).toContain('could not run git')
  })

  test('local scope leaves the remotes out of the log call, all excludes the stash', async () => {
    const calls: string[][] = []
    const run = async (argv: string[]) => {
      calls.push(argv)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    await gitGraph(run, { count: 7, scope: 'local' }, 100, 0)
    await gitGraph(run, { count: 7, scope: 'all' }, 100, 0)
    const logs = calls.filter(c => c[1] === 'log')
    expect(logs[0]).toContain('--branches')
    expect(logs[0]).not.toContain('--all')
    expect(logs[0]).toContain('7')
    expect(logs[1]).toContain('--all')
    expect(logs[1]).toContain('--exclude=refs/stash')
  })

  test('each branch has a colour of its own, and a lane keeps it down the page', () => {
    // main (m, b, base) with a side branch f that is merged into it: two lanes, two colours
    const lines = layoutGraph(forkAndMerge()).lines
    const node = (i: number) => lines.find(l => l.commit === i)?.color
    expect(node(0)).toBe(node(2)) // m and b are on main
    expect(node(1)).not.toBe(node(0)) // f is a branch of its own
    expect(node(3)).toBe(node(0)) // the fork point is on main again
  })

  test('two tips side by side get two colours, and the colours cycle through the palette', () => {
    const tips = layoutGraph([commit('x', ['base']), commit('y', ['base']), commit('base', [])]).lines.filter(l => l.commit !== undefined)
    expect(tips[0]?.color).not.toBe(tips[1]?.color)
    expect(laneColor(0)).not.toBe(laneColor(1))
    expect(laneColor(0)).toBe(laneColor(12))
  })

  test('the rows are the same text as the plain answer, and carry the colour of their branch', () => {
    const d = data({
      commits: [
        commit('m', ['b', 'f'], { subject: 'Merge feature', refs: [{ kind: 'head', name: 'main' }] }),
        commit('f', ['base'], { subject: 'Feature work', refs: [{ kind: 'branch', name: 'feature' }] }),
        commit('b', ['base'], { subject: 'Main work' }),
        commit('base', [], { subject: 'Start', refs: [{ kind: 'tag', name: 'v1' }] }),
      ],
      head: head({ oid: 'm' }),
      branches: [
        { isHead: true, name: 'main', upstream: '', ahead: 0, behind: 0, isGone: false, oid: 'mmmmmmm' },
        { isHead: false, name: 'feature', upstream: 'origin/feature', ahead: 2, behind: 0, isGone: false, oid: 'fffffff' },
      ],
    })
    const rows = gitRows(d, 100, 1_000_000)
    expect(rowsText(rows)).toBe(renderGitGraph(d, 100, 1_000_000))
    const colorOf = (needle: string) => rows.flat().find(s => s.t.includes(needle))?.c
    expect(colorOf('[HEAD → main]')).toBe(laneColor(0))
    expect(colorOf('[feature]')).toBe(laneColor(1))
    expect(colorOf('[feature]')).not.toBe(colorOf('[HEAD → main]'))
    expect(colorOf('(v1)')).not.toBe(laneColor(0)) // a tag has its own colour
    // the merge line parting to the side branch is in that branch's colour, the node of main in main's
    const merge = rows.find(r => rowText0(r).startsWith('├─╮'))
    expect(merge?.[0]?.c).toBe(laneColor(0))
    expect(merge?.find(s => s.t.includes('╮'))?.c).toBe(laneColor(1))
    // the branch list names the branch in the colour of its lane, and flags what is not in sync
    expect(rows.flat().find(s => s.t === 'feature')?.c).toBe(laneColor(1))
    expect(rows.flat().find(s => s.t.includes('origin/feature'))?.c).toBe('warning')
  })

  test('/wd-help points to it', () => {
    expect(helpFor('git 브랜치 그래프 보여줘')).toContain('/wd-git-graph')
    expect(helpFor('show me the branches and merges')).toContain('/wd-git-graph')
    expect(helpFor('')).toContain('/wd-git-graph')
  })
})
