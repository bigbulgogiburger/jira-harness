#!/usr/bin/env node
// issue-subtasks.mjs — 하위이슈 확장 해석기. 사용자가 준 이슈(몇 개든)의 하위이슈를 같이 처리할 키 목록으로 풀어 준다.
// Jira 를 부르지 않는다 — 라우터가 키마다 MCP getJiraIssue(fields 에 subtasks 포함)를 불러 그 응답 배열을 값으로 준다.
//
// 사용:
//   node issue-subtasks.mjs --in <파일|-> [--match <정규식>] [--cwd <dir>] [--json]
//   --in   getJiraIssue 응답 배열(또는 한 건) JSON. - 이면 stdin.
//   --match 하위 summary 에 거는 정규식(harness.json subtasks.match 보다 우선) — 안 걸린 하위는 뺀다.
//
// 출력 code: RESUME(이미 진행 중인 브랜치가 있다 — keys 는 그 상태의 것) · EXPANDED(하위가 붙었다) · NO_SUBTASKS(하위 없음/전부 제외).
// 종료 코드: 0 · 2(사용법/설정 오류).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { locateProject, loadConfig, readState } from './lib/config.mjs';
import { resolveSubtasks, findResumable } from './lib/subtasks.mjs';

const argv = process.argv.slice(2);
let cwdArg = process.cwd(), inArg = null, matchArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--cwd') cwdArg = argv[++i];
  else if (a === '--in') inArg = argv[++i];
  else if (a === '--match') matchArg = argv[++i];
  else if (a === '--json') { /* 항상 JSON — 다른 스크립트와 인자만 맞춘다 */ }
  else fail(`알 수 없는 옵션: ${a}`);
}
function fail(msg) { console.error(`[issue-subtasks] ${msg}`); process.exit(2); }
if (!inArg) fail('사용법: issue-subtasks.mjs --in <파일|-> [--match <정규식>] [--cwd <dir>]');

const proj = locateProject(resolve(cwdArg));
if (!proj || !proj.configPath) fail('harness.json 이 없다 — /jira-harness:setup 으로 설치할 것');
const cfg = loadConfig(proj.configPath);

let issues;
try {
  const parsed = JSON.parse(readFileSync(inArg === '-' ? 0 : inArg, 'utf8'));
  issues = Array.isArray(parsed) ? parsed : [parsed];
} catch (e) { fail(`입력 JSON 을 읽을 수 없다: ${e.message}`); }
if (!issues.length || issues.some((i) => !i?.key)) fail('입력은 key 가 있는 getJiraIssue 응답(배열)이어야 한다');

const match = matchArg ?? cfg.subtasks.match ?? null;
if (match) { try { new RegExp(match); } catch { fail(`match 정규식이 올바르지 않다: ${match}`); } }

// 진행 중인 브랜치가 있으면 Jira 의 현재 하위 구성과 무관하게 그걸 이어 간다.
const issuesDir = join(proj.configRoot, cfg.runtime_dir, 'issues');
const states = existsSync(issuesDir)
  ? readdirSync(issuesDir).filter((f) => f.endsWith('.json')).map((f) => { try { return readState(join(issuesDir, f)); } catch { return null; } }) // 사이드카(.plan.json 등)는 상태 스키마 위반 → 건너뜀
  : [];
const given = issues.map((i) => String(i.key).toUpperCase());
const resume = findResumable(states, given);

const out = { match, match_source: matchArg ? 'flag' : cfg.subtasks.match ? 'config' : null };
if (resume) {
  console.log(JSON.stringify({ code: 'RESUME', ...out, keys: resume.keys, groups: resume.subtasks, children: [], resume, keys_arg: resume.keys.join(','), group_args: [] }, null, 2));
  process.exit(0);
}
const r = resolveSubtasks(issues, { prefix: cfg.issue_prefix, match, doneTransition: cfg.jira.done_transition });
console.log(JSON.stringify({
  code: r.groups.length ? 'EXPANDED' : 'NO_SUBTASKS',
  ...out,
  keys: r.keys,
  groups: r.groups,
  children: r.children,
  resume: null,
  // match 가 없으면 어느 레포 것인지 모른다 — 라우터가 표를 한 번 보이고 확인한다(무인이면 전부 포함).
  confirm: r.groups.length > 0 && !match,
  keys_arg: r.keys.join(','),
  group_args: r.groups.map((g) => `${g.parent}=${g.children.join(',')}`),
}, null, 2));
