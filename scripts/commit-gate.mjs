#!/usr/bin/env node
// commit-gate.mjs — PreToolUse(Bash) 훅 본체. stdin 으로 훅 이벤트 JSON 을 받아 git commit / git push 를 판정한다.
// 판정 순서는 설계 문서 §3.5 (lib/gate-core.mjs). 통과면 stdout 에 아무것도 내지 않는다(stderr 한 줄만).
// 판정 중 예외는 fail-open 이 아니라 deny 다 — 판정할 수 없으면 커밋을 막는 편이 안전하다.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { decide, detectGitOp, effectiveCwd } from './lib/gate-core.mjs';

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
let event = {};
try { event = raw ? JSON.parse(raw) : {}; } catch { event = {}; }

if (event.tool_name && event.tool_name !== 'Bash') process.exit(0);
const command = event.tool_input?.command ?? '';
const op = detectGitOp(command);
if (!op) process.exit(0);

const baseCwd = event.cwd && isAbsolute(event.cwd) ? event.cwd : process.cwd();
const cwd = effectiveCwd(command, baseCwd);

let verdict;
try {
  verdict = decide(op, cwd);
} catch (e) {
  verdict = { decision: 'deny', code: 'HOOK_ERROR', reason: `판정 중 오류(fail-closed): ${e.message}` };
}

const tag = `[jira-harness] git ${op}: ${verdict.code} — ${verdict.reason}`;
if (verdict.decision === 'deny') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: tag } }));
} else if (verdict.decision === 'warn') {
  process.stdout.write(JSON.stringify({ systemMessage: `⚠ ${tag} (mode=suggest 라 차단하지 않음)` }));
} else {
  process.stderr.write(tag + '\n');
}
process.exit(0);
