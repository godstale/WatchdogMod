/**
 * `/wd-help <what you want>`: picks the Watch Dog commands that fit the request by keyword,
 * and prints them ready to copy. No model is asked, so it costs no tokens and works mid-turn.
 */

import { pad } from './util'

type Line = { cmd: string; ko: string; en: string }
type Topic = {
  id: string
  title: { ko: string; en: string }
  /** Each pattern that matches the request adds a point. */
  keys: RegExp[]
  lines: Line[]
}

const TOPICS: Topic[] = [
  {
    id: 'say',
    title: { ko: '실행 중인 작업에 요청 끼워 넣기', en: 'Slip a request into running work' },
    keys: [/끼워|끼우|추가로?\s*(요청|지시|메시지)?|전달|메시지|지시|요청|말해|보내|알려\s*줘|바꿔|수정해/, /\b(say|tell|send|inject|add|message|instruct|change)\b/i, /서브|에이전트|agent|#\d/i],
    lines: [
      { cmd: '/wd say <메시지>', ko: '메인 작업에 끼워 넣기', en: 'to the main loop' },
      { cmd: '/wd say #2 <메시지>', ko: '2번 서브 에이전트에게', en: 'to sub-agent #2' },
    ],
  },
  {
    id: 'pause',
    title: { ko: '일시정지 / 재개', en: 'Pause and resume' },
    keys: [/일시|잠깐|잠시|멈춰|멈춤|정지|중단|재개|계속|다시\s*시작|이어/, /\b(pause|hold|wait|resume|continue|freeze|unpause)\b/i],
    lines: [
      { cmd: '/wd pause', ko: '다음 도구 호출 전에 멈춤 (메인+에이전트 전체)', en: 'hold before the next tool call (everything)' },
      { cmd: '/wd pause main', ko: '메인만 (agents, #2 도 가능)', en: 'main only (agents or #2 also work)' },
      { cmd: '/wd say <메시지>', ko: '멈춘 동안 메시지 끼워 넣기 (재개 후 모델이 읽음)', en: 'while held: slip a message in (read once resumed)' },
      { cmd: '/wd resume', ko: '재개 (main, agents, #2 지정 가능)', en: 'continue (main, agents or #2 can be named)' },
    ],
  },
  {
    id: 'stop',
    title: { ko: '정리 후 중단', en: 'Wrap up and stop' },
    keys: [/종료|끝내|그만|정리|중단|취소|죽여|kill/, /\b(stop|cancel|abort|end|quit|finish|wrap)\b/i],
    lines: [
      { cmd: '/wd stop', ko: '전체를 정리(보고) 후 중단', en: 'wrap up and stop everything' },
      { cmd: '/wd stop main', ko: '메인만 (agents, #2 도 가능)', en: 'main only (agents or #2 also work)' },
    ],
  },
  {
    id: 'log',
    title: { ko: '무슨 작업을 해왔는지 보기', en: 'See what each loop has been doing' },
    keys: [/기록|로그|히스토리|내역|이력|뭐\s*했|뭘\s*했|무슨\s*(작업|일)|활동|최근|진행/, /\b(log|history|activity|recent|doing|did|progress|what)\b/i],
    lines: [
      { cmd: '/wd-log', ko: '메인 + 서브 에이전트의 최근 5개 작업', en: 'last 5 calls of main and every sub-agent' },
      { cmd: '/wd-log main 10', ko: '메인의 최근 10개', en: 'last 10 of main' },
      { cmd: '/wd-log #2', ko: '2번 에이전트만', en: 'sub-agent #2 only' },
    ],
  },
  {
    id: 'test',
    title: { ko: '대시보드 시험', en: 'Try the dashboard' },
    keys: [/테스트|시험|시연|예제|해보|써보/, /\b(test|demo|try|example|sample)\b/i],
    lines: [
      { cmd: '/watchdog:wd-test basic', ko: '에이전트 3+1개로 표시 확인 (many, stop, solo, input 도 있음)', en: '3+1 sleeping agents (also many, stop, solo, input)' },
      { cmd: '/watchdog:wd-test stop', ko: 'pause / resume / stop / say 시험용', en: 'for trying pause, resume, stop and say' },
    ],
  },
  {
    id: 'screen',
    title: { ko: '창 보는 법', en: 'Reading the window' },
    keys: [/화면|창|표시|모델|effort|이펙트|강아지|상태|대시보드|색|알림|사용량|한도|컨텍스트|비용/, /\b(window|dashboard|screen|model|dog|status|color|notification|usage|limit|context|cost)\b/i],
    lines: [
      { cmd: '(첫 줄)', ko: 'WATCH DOG 옆: 모델/effort, 작업 상태, 경고', en: 'first row: model/effort next to WATCH DOG, state, warnings' },
      { cmd: '(둘째 줄~)', ko: '작업·진행률, 서브 에이전트(⏸=일시정지 ■=정리 중), 툴, 사용량', en: 'task and progress, sub-agents (⏸ paused, ■ stopping), tools, usage' },
    ],
  },
]

const HANGUL = /[가-힣]/

export function scoreTopics(message: string): Topic[] {
  const scored = TOPICS.map(t => ({ t, n: t.keys.filter(k => k.test(message)).length })).filter(x => x.n > 0)
  scored.sort((a, b) => b.n - a.n)
  const top = scored[0]?.n ?? 0
  // the best match, and a second one only if it is nearly as good
  return scored.filter((x, i) => i === 0 || (i === 1 && x.n >= top)).map(x => x.t)
}

function render(topics: Topic[], isKo: boolean): string[] {
  const lines: string[] = []
  for (const t of topics) {
    lines.push(isKo ? t.title.ko : t.title.en)
    for (const l of t.lines) lines.push(`  ${pad(l.cmd, 26)} ${isKo ? l.ko : l.en}`)
  }
  return lines
}

/** The reply to `/wd-help <message>`. */
export function helpFor(message: string): string {
  const text = message.trim()
  const isKo = HANGUL.test(text) || text === ''

  const found = text === '' ? [] : scoreTopics(text)
  if (found.length > 0) {
    const head = isKo ? `“${text}” 에 맞는 명령:` : `Commands for “${text}”:`
    return [head, ...render(found, isKo)].join('\n')
  }
  const head =
    text === ''
      ? isKo ? 'Watch Dog 명령 모음:' : 'Watch Dog commands:'
      : isKo ? `“${text}” 와 맞는 항목을 못 찾았습니다. 전체 명령:` : `Nothing matched “${text}”. All commands:`
  const all = TOPICS.filter(t => ['say', 'pause', 'stop', 'log'].includes(t.id))
  return [head, ...render(all, isKo), `  ${isKo ? '/wd-help <원하는 일>' : '/wd-help <what you want>'}`].join('\n')
}
