# Watch Dog 프로젝트 지침

Claude Code 플러그인 `watchdog` (마켓플레이스 배포용). 사용자 안내는 README.md 에 있고, 이 파일은 작업 방식을 적습니다.

## 작업 흐름 (필수)

1. `main` 에 직접 커밋하거나 푸시하지 않습니다. 모든 변경은 브랜치에서 합니다.
   * 브랜치 이름: `feat/<주제>`, `fix/<주제>`, `docs/<주제>`, `chore/<주제>`, 릴리스 준비는 `release/vX.Y.Z`
2. 브랜치에서 작업하고 커밋합니다. 커밋 메시지는 무엇을 왜 바꿨는지 한두 줄로 씁니다.
3. 푸시한 뒤 `main` 을 대상으로 PR 을 엽니다. PR 본문에는 변경 요약과 검증 결과를 씁니다.
4. 아래 검증을 모두 통과한 뒤 PR 을 머지합니다. 머지 후 브랜치는 지웁니다.
5. 릴리스는 `main` 에 버전 태그를 긋는 것으로 끝납니다 (아래 "버전과 태그").

```
git switch -c feat/<주제> main
# 작업 → 검증 → 커밋
git push -u origin feat/<주제>
gh pr create --base main --title "<제목>" --body "<본문>"
gh pr merge --squash --delete-branch
```

## 머지 전 검증

```
claude plugin validate .
claude plugin test .
```

* `validate` 는 경고가 없어야 합니다. 경고가 남으면 PR 본문에 이유를 적습니다.
* `test` 는 55개 이상이 모두 통과해야 합니다 (`0 fail`).
* 화면이 바뀌었으면 `claude --plugin-dir .` 로 `/watchdog:wd-test basic` 등을 실제로 띄워 확인합니다.

## 버전과 태그

* 버전은 `.claude-plugin/plugin.json` 의 `version` 이 기준입니다 (semver).
* 버전을 올리지 않으면 사용자의 설치본이 새 내용으로 갱신되지 않을 수 있습니다. 배포 내용이 바뀔 때마다 `version` 을 올립니다.
* 태그는 `v<version>` 형식입니다 (예: `0.2.1` → `v0.2.1`). 태그는 머지된 `main` 의 커밋에 긋습니다.
* 주석 태그를 씁니다: `git tag -a v0.2.1 -m "Watch Dog 0.2.1" && git push origin v0.2.1`

## 저장소 구조

| 경로 | 내용 |
| --- | --- |
| `.claude-plugin/plugin.json` | 플러그인 매니페스트 (이름, 버전, 작성자, 타입 선언 경로) |
| `.claude-plugin/marketplace.json` | 마켓플레이스 등록 정보 |
| `hooks/register.tsx` | 진입점. 훅, `/wd` `/wd-log` `/wd-help` 명령, 화면 렌더 |
| `hooks/view.ts` | 화면 행(row) 구성과 상태(mood) 판정 |
| `hooks/art.ts` | 픽셀 강아지 그림 (상태별 포즈와 색) |
| `hooks/log.ts`, `hooks/help.ts` | `/wd-log`, `/wd-help` 출력 |
| `hooks/notify.ts` | 데스크톱 알림 명령 (Windows 토스트, macOS osascript) |
| `hooks/util.ts` | 글자 폭, 시간·모델 이름 포맷, `/wd` 인자 파싱 |
| `commands/wd-test.md` | 대시보드 시험용 명령 (`/watchdog:wd-test`) |
| `types/index.d.ts` | 플러그인 상태(`watchdog.*`) 타입 선언 |
| `tests/` | `claude plugin test .` 가 도는 테스트 |

`.claude-plugin/types/` 는 Claude Code SDK 타입의 로컬 사본입니다. 커밋하지 않습니다 (`.gitignore` 로 제외).

## 코드 규칙

* 화면(상태 창)에 출력되는 문구는 영어입니다. 테스트가 "화면에 한글이 없음"을 확인합니다. 한국어는 `/wd-help` 응답에서만 씁니다.
* 훅은 대시보드 때문에 작업이 멈추면 안 됩니다. 대시보드 쪽 호출은 `safe()` 로 감싸고, 실패는 조용히 넘깁니다.
* 상태 값은 `atom` 으로 선언하고 `types/index.d.ts` 의 `PluginState` 와 맞춥니다. 키 이름을 바꾸면 양쪽을 같이 고칩니다.
* 주석은 기존 파일처럼 짧게, 이유가 드러나지 않는 곳에만 씁니다.
* 기능이나 명령이 바뀌면 README 의 해당 항목도 같은 PR 에서 고칩니다.
