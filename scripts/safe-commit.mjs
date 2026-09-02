#!/usr/bin/env node
// safe-commit.mjs — 훅이 발화하지 않는 경로(헤드리스 `claude -p`·무인 세션)에서 훅과 **같은 판정**(lib/gate-core)을 하고, 통과할 때만 커밋/푸시한다.
// 모델에게 맨 git 을 주는 대신 이 스크립트를 주면 무인 경로에서도 게이트 규율이 같다.
//
// 사용:
//   node scripts/safe-commit.mjs -m "<메시지>" [--push] [--cwd <dir>] [--json]
//   node scripts/safe-commit.mjs --push [--cwd <dir>] [--json]        (커밋 없이 push 만)
// 종료 코드: 0 통과·실행 · 1 거부(deny) 또는 git 실패 · 2 인자 오류
import { decide } from './lib/gate-core.mjs';
import { git, currentBranch } from './lib/git.mjs';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const message = opt('-m') ?? opt('--message');
const doPush = argv.includes('--push');
const asJson = argv.includes('--json');
const cwd = opt('--cwd') ?? process.cwd();
if (!message && !doPush) { console.error('usage: safe-commit.mjs -m "<메시지>" [--push] | --push'); process.exit(2); }

const out = { commit: null, push: null };
function finish(code) { if (asJson) console.log(JSON.stringify(out)); process.exit(code); }
function judge(op) {
  const v = decide(op, cwd);
  const tag = `[jira-harness] git ${op}: ${v.code} — ${v.reason}`;
  if (v.decision === 'deny') { console.error(tag); return { ...v, tag, ok: false }; }
  if (v.decision === 'warn') console.error(`⚠ ${tag} (mode=suggest 라 차단하지 않음)`); else console.error(tag);
  return { ...v, tag, ok: true };
}

if (message) {
  const v = judge('commit');
  out.commit = { code: v.code, decision: v.decision };
  if (!v.ok) finish(1);
  const r = git(['commit', '-m', message], { cwd, allowFail: true });
  if (r.status !== 0) { console.error(r.err || r.out); out.commit.error = r.err || r.out; finish(1); }
  out.commit.sha = git(['rev-parse', 'HEAD'], { cwd }).out;
}
if (doPush) {
  const v = judge('push');
  out.push = { code: v.code, decision: v.decision };
  if (!v.ok) finish(1);
  const branch = currentBranch(cwd);
  const r = git(['push', '-u', 'origin', branch], { cwd, allowFail: true });
  if (r.status !== 0) { console.error(r.err || r.out); out.push.error = r.err || r.out; finish(1); }
  out.push.branch = branch;
}
finish(0);
