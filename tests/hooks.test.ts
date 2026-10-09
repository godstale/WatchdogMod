import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

declare function setTimeout(run: () => void, ms: number): unknown

const COMPOSER = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: true, columns: 120 } as never

/** What the engine answers beneath the plugin, so the session can start. */
function bottom(on: On) {
  mock.clock(on, { now: 1_000 })
  const session = mock.session(on)
  on('session.start', () => ({ cwd: '/' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 20_000, percent: 10 }, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'wd' } }))
  on('turn.start', () => ({ turnId: 't1' }))
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
  return session
}

test('the old form with a code is refused, and says the code is gone', async ($, on) => {
  const session = bottom(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'wd', args: '123456 say hi', origin: COMPOSER, presentation: PRESENTATION })
  expect(r.text).toContain('no code needed')
  expect(session.appended().length).toBe(0)
})

test('help needs no code', async ($, on) => {
  bottom(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'wd', args: '', origin: COMPOSER, presentation: PRESENTATION })
  expect(r.text).toContain('/wd say')
})

test('a command that did not come from the person is refused', async ($, on) => {
  bottom(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'wd', args: 'stop', origin: { kind: 'sdk' }, presentation: PRESENTATION })
  expect(r.text).toContain('typed by the user')
})

const BAND = {
  plugin: 'watchdog',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 7,
    bodyColumns: 110,
    scroll: { offset: 0, bodyRows: 7 },
    view: {},
  } as never,
} as const

async function say($: Engine, args: string) {
  return $.command.run({ command: 'wd', args, origin: COMPOSER, presentation: PRESENTATION })
}

test('say reaches a running turn', async ($, on) => {
  const session = bottom(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'refactor auth', turnId: 't1' })

  const r = await say($, 'say also add tests')
  expect(r.text).toContain('slipped into')
  const rows = session.appended()
  expect(rows.length).toBe(1)
  expect(JSON.stringify(rows[0]?.message.content)).toContain('also add tests')
})

test('stop lets looking tools through and refuses new work', async ($, on) => {
  const session = bottom(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'refactor auth', turnId: 't1' })

  const before = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(before.deny).toBeUndefined()

  const r = await say($, 'stop')
  expect(r.text).toContain('wrap up and stop')
  expect(session.appended().length).toBe(1)

  const bash = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(bash.deny).toContain('graceful stop')
  const edit = await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' })
  expect(edit.deny).toContain('graceful stop')
  const read = await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  expect(read.deny).toBeUndefined()
})

test('nothing running means nothing to stop', async ($, on) => {
  bottom(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await say($, 'stop')
  expect(r.text).toContain('nothing is running')
})

test('the window draws on the terminal, idle and busy, and carries no code', async ($, on) => {
  bottom(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const idle = await $.ui.mount({ ...BAND, surface })
    expect(await idle.find({ type: 'Text', text: 'WATCH DOG' })).toBeDefined()
    expect(await idle.find({ type: 'Text', text: /\/wd say/ })).toBeDefined()
    expect(await idle.find({ type: 'Text', text: /^\d{6}$/ })).toBeUndefined()
    await idle.unmount()
  }
  await $.turn.start({ text: '인증 모듈 리팩터링', turnId: 't1' })
  const busy = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await busy.find({ type: 'Text', text: /Working/ })).toBeDefined()
  expect(await busy.find({ type: 'Text', text: /인증 모듈/ })).toBeDefined()
  expect(await busy.find({ type: 'Text', text: /^\d{6}$/ })).toBeUndefined()
  await busy.unmount()
})

test('a busy band with little room still draws the pixel dog', async ($, on) => {
  bottom(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'refactor auth', turnId: 't1' })
  for (const maxRows of [4, 5, 6]) {
    const props = { ...BAND.props, maxRows, scroll: { offset: 0, bodyRows: maxRows } } as never
    const ui = await $.ui.mount({ ...BAND, props, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /[▀▄█]/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Working/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a call that needs the person turns the dog to input, notifies the desktop, and clears once it runs', async ($, on) => {
  bottom(on)
  const ran: string[][] = []
  on('tool.check', () => ({ decision: 'ask' }))
  on('env.get', () => ({ value: 'Windows_NT' }))
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'refactor auth', turnId: 't1' })

  await $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'u1' })
  await new Promise<void>(done => setTimeout(() => done(), 50))
  const toast = ran.find(argv => argv[0] === 'powershell.exe')
  expect(toast).toBeDefined()

  const waiting = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await waiting.find({ type: 'Text', text: /Waiting for you: Bash/ })).toBeDefined()
  await waiting.unmount()

  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'u1' })
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /Working/ })).toBeDefined()
  await after.unmount()
})

const wait = (ms: number) => new Promise<void>(done => setTimeout(() => done(), ms))
const SPAWNED = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

/** A wait that takes a little real time, as `ping`/`sleep` does, so a pause does not spin. */
function slowProcess(on: On) {
  on('env.get', () => ({ value: 'Windows_NT' }))
  on('process.run', async () => {
    await wait(20)
    return { value: SPAWNED }
  })
}

test('pause holds the next tool call until resume, and the dashboard says so', async ($, on) => {
  bottom(on)
  slowProcess(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'refactor auth', turnId: 't1' })

  const paused = await say($, 'pause')
  expect(paused.text).toContain('paused main')

  let isDone = false
  const call = $.tool.call({ tool: 'Bash', command: 'ls' }).then(r => {
    isDone = true
    return r
  })
  await wait(150)
  expect(isDone).toBe(false)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Paused main/ })).toBeDefined()
  await ui.unmount()

  const resumed = await say($, 'resume')
  expect(resumed.text).toContain('resumed main')
  const r = await call
  expect(isDone).toBe(true)
  expect(r.deny).toBeUndefined()

  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /Paused/ })).toBeUndefined()
  await after.unmount()
})

test('a message sent while paused is stored, and the held call is refused once so the model re-plans', async ($, on) => {
  const session = bottom(on)
  slowProcess(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'refactor auth', turnId: 't1' })

  await say($, 'pause')
  const held = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await wait(60)

  const sent = await say($, 'say use the staging config instead')
  expect(sent.text).toContain('stored while main is paused')
  expect(session.appended().length).toBe(1)

  const resumed = await say($, 'resume')
  expect(resumed.text).toContain('re-plans')
  const r = await held
  expect(r.deny).toContain('sent a new message')

  const next = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(next.deny).toBeUndefined()
})

test('pause needs a running loop, resume needs a paused one, and stop lets a paused loop go', async ($, on) => {
  const session = bottom(on)
  slowProcess(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await say($, 'pause')).text).toContain('nothing is running')
  await $.turn.start({ text: 'refactor auth', turnId: 't1' })
  expect((await say($, 'resume')).text).toContain('nothing is paused')

  await say($, 'pause')
  const held = $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await wait(60)
  expect((await say($, 'stop')).text).toContain('wrap up and stop')
  expect(session.appended().length).toBe(1)
  const r = await held
  expect(r.deny).toBeUndefined() // Read is allowed under a stop
  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(bash.deny).toContain('graceful stop')
})

test('/wd-log lists the calls made, and /wd-help answers', async ($, on) => {
  bottom(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'refactor auth', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'u1' })
  await $.tool.call({ tool: 'Edit', file_path: 'src/auth.ts', old_string: 'a', new_string: 'b', tool_use_id: 'u2' })

  const log = await $.command.run({ command: 'wd-log', args: '', origin: { kind: 'sdk' }, presentation: PRESENTATION })
  expect(log.text).toContain('Bash npm test')
  expect(log.text).toContain('Edit auth.ts')
  expect(log.text).toContain('✓')
  const bad = await $.command.run({ command: 'wd-log', args: 'nope', origin: COMPOSER, presentation: PRESENTATION })
  expect(bad.text).toContain('usage')

  const help = await $.command.run({ command: 'wd-help', args: '작업 잠깐 멈추기', origin: COMPOSER, presentation: PRESENTATION })
  expect(help.text).toContain('/wd pause')
})
