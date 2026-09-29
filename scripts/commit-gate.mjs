#!/usr/bin/env node
// commit-gate.mjs — PreToolUse(Bash|PowerShell) 훅 본체. stdin 으로 훅 이벤트 JSON 을 받아 git commit / git push 를 판정한다.
// 판정 순서는 설계 문서 §3.5 (lib/gate-core.mjs). 통과면 stdout 에 아무것도 내지 않는다(stderr 한 줄만).
// 판정 중 예외는 fail-open 이 아니라 deny 다 — 판정할 수 없으면 커밋을 막는 편이 안전하다.
//
// ⚠ 셸 툴은 둘이다(Bash · PowerShell). 한쪽만 보면 다른 쪽으로 커밋할 때 게이트가 아예 돌지 않는다.
//   hooks/hooks.json 의 matcher 와 gate-core 의 SHELL_TOOLS 는 항상 같은 집합이어야 한다 — gate.test 가 대조하고,
//   setup inject 의 powershell 케이스가 이 스크립트가 PowerShell 이벤트도 판정하는지 실측한다.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { decide, detectGitOps, effectiveCwd, SHELL_TOOLS } from './lib/gate-core.mjs';
import { herdrPing } from './lib/herdr.mjs';

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
let event = {};
try { event = raw ? JSON.parse(raw) : {}; } catch { event = {}; }

if (event.tool_name && !SHELL_TOOLS.has(event.tool_name)) process.exit(0);
const command = event.tool_input?.command ?? '';
// `git commit … && git push` 처럼 한 명령에 op 가 둘이면 둘 다 판정한다 — 첫 op 만 보면 push 의 전량 게이트가 통째로 빠진다
const jobs = detectGitOps(command);
if (!jobs.length) process.exit(0);

const baseCwd = event.cwd && isAbsolute(event.cwd) ? event.cwd : process.cwd();
const cwd = effectiveCwd(command, baseCwd);

const RANK = { deny: 0, warn: 1, pass: 2 };
let op, verdict;
for (const job of jobs) {
  let v;
  // 판정할 디렉토리가 없으면(cd 경로 오타·MSYS 경로 오인) fail-open 이 아니라 fail-closed — 없는 경로는 NO_HARNESS 로 통과해 버린다
  try {
    if (!existsSync(cwd)) throw new Error(`판정할 디렉토리가 없다(${cwd}) — cd/-C 경로를 확인할 것`);
    v = decide(job.op, cwd, { command, afterCommit: job.afterCommit });
  } catch (e) {
    v = { decision: 'deny', code: 'HOOK_ERROR', reason: `판정 중 오류(fail-closed): ${e.message}` };
  }
  // 가장 무거운 판정(deny > warn > pass)이 대표다 — 같으면 앞선 op
  if (!verdict || RANK[v.decision] < RANK[verdict.decision]) { op = job.op; verdict = v; }
}

const tag = `[jira-harness] git ${op}: ${verdict.code} — ${verdict.reason}`;
if (verdict.decision === 'deny') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: tag } }));
  // Herdr 토스트(Herdr 밖이면 무동작) — 무인 pane 에서 훅이 막았을 때 사람이 사이드바에서 알아채게. 판정은 이미 끝났으니 실패해도 무관.
  herdrPing(existsSync(cwd) ? cwd : baseCwd, `git ${op} 거부 ${verdict.code}`, { title: `git ${op} 거부 — ${verdict.code}`, body: verdict.reason, sound: 'request' });
} else if (verdict.decision === 'warn') {
  process.stdout.write(JSON.stringify({ systemMessage: `⚠ ${tag} (mode=suggest 라 차단하지 않음)` }));
} else {
  process.stderr.write(tag + '\n');
}
process.exit(0);
