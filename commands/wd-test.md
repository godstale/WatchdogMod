---
description: Watch Dog test run — cheap haiku sub-agents that sleep, so you can watch the dashboard and try /wd say / stop
argument-hint: "[basic|many|stop|solo|input]  (default: basic)"
model: haiku
disable-model-invocation: true
allowed-tools: Agent, Bash, TodoWrite, AskUserQuestion
---

This is a Watch Dog dashboard test. Spend as few tokens as possible: no thinking aloud, no explanations, no file reads. Scenario: `$ARGUMENTS` (empty means `basic`).

First call TodoWrite once with the steps of the scenario (one item per step, first one in_progress), mark them completed as you go.

Scenarios:
- `basic`: in ONE message launch 3 Agent calls in parallel, all with `subagent_type: "general-purpose"`, `model: "haiku"`:
  1. description `wd-short`: runs Bash `sleep 5` once.
  2. description `wd-medium`: runs Bash `sleep 5` 4 times, one call each, one after another.
  3. description `wd-long`: runs Bash `sleep 5` 8 times, one call each, one after another.
  Then launch ONE more Agent `wd-late` (same type/model) that runs Bash `sleep 5` twice, so agents start and end at different times.
- `many`: in ONE message launch 6 Agent calls in parallel (same type/model), descriptions `wd-1` … `wd-6`; agent n runs Bash `sleep 5` n times, one call each, one after another.
- `stop`: in ONE message launch 2 Agent calls in parallel (same type/model), descriptions `stop-a` and `stop-b`; each runs Bash `sleep 5` 20 times, one call each, one after another. Then say only: "Now try: /wd pause | resume | stop agents | stop #1 | stop main | say #2 <text>, and /wd-log".
- `solo`: no agents. The main loop itself runs Bash `sleep 5` 10 times, one call each, one after another.
- `input`: no agents. Run Bash `sleep 5` once, then call AskUserQuestion once with the single question "Watch Dog input test: pick any" and the options "A" and "B", then run Bash `sleep 5` once more. (Shows the waiting-for-you dog and raises a desktop notification while the question is open.)

Every agent prompt must be one short sentence like "Run `sleep 5` via Bash 4 times, one call each, sequentially, then reply: done." — if a call is refused or you are told to stop, reply with the count done and end.
When everything finished, reply with one line: `wd-test <scenario>: done`.
