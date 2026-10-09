// ---- text width (Korean/CJK are two cells wide) ----

function cellOf(cp: number): number {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) {
    return 0
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

export function cells(text: string): number {
  let n = 0
  for (const ch of text) n += cellOf(ch.codePointAt(0) ?? 0)
  return n
}

/** Cuts `text` to at most `width` cells, ending in an ellipsis when cut. */
export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const flat = text.replace(/\s+/g, ' ')
  if (cells(flat) <= width) return flat
  let out = ''
  let used = 0
  for (const ch of flat) {
    const w = cellOf(ch.codePointAt(0) ?? 0)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return out + '…'
}

export function pad(text: string, width: number): string {
  const gap = width - cells(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

// ---- small formatters ----

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m % 60)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`
}

export function bar(percent: number, width: number): string {
  const p = Math.max(0, Math.min(100, percent))
  const full = Math.round((p / 100) * width)
  return '█'.repeat(full) + '░'.repeat(Math.max(0, width - full))
}

export function kilo(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function untilReset(iso: string, now: number): string {
  if (iso === '') return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const m = Math.max(0, Math.round((at - now) / 60_000))
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${m}m`
}

/** claude-sonnet-5-5 -> sonnet5.5; names it cannot read are kept, trimmed. */
export function shortModel(model: string): string {
  const m = /^(?:claude-)?([a-z]+)-(\d+)-(\d+)/.exec(model)
  if (m !== null) return `${m[1]}${m[2]}.${m[3]}`
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')
}

export function basename(path: string): string {
  const flat = path.replace(/\\/g, '/')
  return flat.slice(flat.lastIndexOf('/') + 1)
}

// ---- /wd arguments ----

export type Scope = 'all' | 'main' | 'agents' | number

export type WdCommand =
  | { kind: 'help' }
  | { kind: 'say'; target: 'main' | number; text: string }
  | { kind: 'stop' | 'pause' | 'resume'; scope: Scope }
  | { kind: 'error'; message: string }

/** (nothing) or all | main | agents | #n; undefined when it is none of these. */
function parseScope(rest: string): Scope | undefined {
  if (rest === '' || /^all$/i.test(rest)) return 'all'
  if (/^main$/i.test(rest)) return 'main'
  if (/^agents?$/i.test(rest)) return 'agents'
  const t = /^#?(\d+)$/.exec(rest)
  return t === null ? undefined : Number(t[1])
}

export function parseArgs(args: string): WdCommand {
  const text = args.trim()
  if (text === '' || /^(help|\?|-h|--help)$/i.test(text)) return { kind: 'help' }

  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  const verb = (m?.[1] ?? '').toLowerCase()
  const rest = (m?.[2] ?? '').trim()

  // the code of the earlier form: say what replaced it, rather than calling the code an unknown command
  if (/^\d{6}$/.test(verb)) return { kind: 'error', message: 'no code needed any more. e.g. /wd say also run the tests' }

  if (verb === 'say') {
    const t = /^#(\d+)\s+([\s\S]+)$/.exec(rest)
    if (t !== null) return { kind: 'say', target: Number(t[1]), text: (t[2] ?? '').trim() }
    if (/^#\d+$/.test(rest)) return { kind: 'error', message: `nothing to send to ${rest}. e.g. /wd say ${rest} also run the tests` }
    if (rest === '') return { kind: 'error', message: 'nothing to send. e.g. /wd say also run the tests' }
    return { kind: 'say', target: 'main', text: rest }
  }

  if (verb === 'stop' || verb === 'pause' || verb === 'resume') {
    const scope = parseScope(rest)
    if (scope === undefined) return { kind: 'error', message: `${verb} target: (none)=everything | main | agents | #n` }
    return { kind: verb, scope }
  }

  return { kind: 'error', message: `unknown command "${verb}". use say, pause, resume or stop.` }
}

export const HELP = [
  'Watch Dog commands:',
  '  /wd say <message>               slip a request into the running work',
  '  /wd say #2 <message>            send it to sub-agent #2',
  '  /wd pause [main|agents|#2]      hold before the next tool call (say still works while held)',
  '  /wd resume [main|agents|#2]     let it go on',
  '  /wd stop [main|agents|#2]       wrap up and stop (no new work, then a report)',
  '  /wd-log [main|agents|#2] [n]    the last actions of the main loop and the sub-agents (default 5)',
  '  /wd-help <what you want to do>  which command to use, ready to copy',
].join('\n')
