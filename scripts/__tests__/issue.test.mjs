// issue.test.mjs — issue-start.mjs · issue-set.mjs 통합 테스트. gate.test.mjs 의 makeRepo 패턴을 복제한다
// (기존 테스트 파일은 수정하지 않는다는 규칙 때문에 여기서 자체 헬퍼를 둔다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState } from '../lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;

function sh(cmd, args, cwd) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }

function makeRepo({ mode = 'auto', harness = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-issue-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'core.autocrlf', 'false');
  for (const d of ['docs', 'backend', 'frontend', '.claude']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'docs/README.md'), '# docs\n');
  writeFileSync(join(dir, 'backend/App.java'), 'class App {}\n');
  writeFileSync(join(dir, 'frontend/app.js'), 'export default 1\n');
  writeFileSync(join(dir, '.gitignore'), '.claude/harness.env.local\n');
  if (harness) {
    const cfg = JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8'));
    cfg.mode = mode;
    writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg, null, 2) + '\n');
  }
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function edit(dir, rel, text) { writeFileSync(join(dir, rel), text); }
const stateFile = (dir, slug) => join(dir, '.claude/runtime/issues', `${slug}.json`);

function start(dir, keysArg, extra = []) {
  const r = sh(NODE, [join(SCRIPTS, 'issue-start.mjs'), keysArg, ...extra, '--cwd', dir, '--json'], dir);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout.trim()); } catch { /* not json */ }
  return { status: r.status, out: parsed, raw: r.stdout, err: r.stderr };
}
function status(dir, extra = []) {
  const r = sh(NODE, [join(SCRIPTS, 'issue-start.mjs'), '--status', ...extra, '--cwd', dir, '--json'], dir);
  return { status: r.status, out: JSON.parse(r.stdout.trim()), raw: r.stdout, err: r.stderr };
}
function setCmd(dir, args) {
  const r = sh(NODE, [join(SCRIPTS, 'issue-set.mjs'), ...args, '--cwd', dir, '--json'], dir);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout.trim()); } catch { /* not json */ }
  return { status: r.status, out: parsed, raw: r.stdout, err: r.stderr };
}

test('start: main 에서 단일 키 → feat/ABC-1 생성 · 상태 · STARTED · jira.comment', () => {
  const dir = makeRepo();
  const r = start(dir, 'ABC-1');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.code, 'STARTED');
  assert.equal(r.out.branch, 'feat/ABC-1');
  assert.deepEqual(r.out.keys, ['ABC-1']);
  assert.equal(r.out.created, true);
  assert.equal(g(dir, 'symbolic-ref', '--short', 'HEAD'), 'feat/ABC-1');
  const st = readState(stateFile(dir, 'feat-ABC-1'));
  assert.equal(st.stage, 'start');
  assert.deepEqual(st.keys, ['ABC-1']);
  assert.ok(r.out.jira.comment.includes('feat/ABC-1'), r.out.jira.comment);
  assert.ok(r.out.jira.comment.includes('ABC-1'), r.out.jira.comment);
  assert.ok(r.out.jira.comment.includes('jira-harness v3'), r.out.jira.comment);
  assert.equal(r.out.jira.transition, 'In Progress');
});

test('start: 다중 키 → feat/ABC-1-2 브랜치 하나', () => {
  const dir = makeRepo();
  const r = start(dir, 'ABC-1,ABC-2');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.code, 'STARTED');
  assert.equal(r.out.branch, 'feat/ABC-1-2');
  assert.deepEqual(r.out.keys, ['ABC-1', 'ABC-2']);
  assert.equal(g(dir, 'symbolic-ref', '--short', 'HEAD'), 'feat/ABC-1-2');
});

test('start: 이슈 브랜치 아닌 곳에선 --adopt 없이 ON_OTHER_BRANCH(exit 1), --adopt 면 ADOPTED', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'hotfix/misc');
  const r1 = start(dir, 'ABC-9');
  assert.equal(r1.status, 1);
  assert.equal(r1.out.code, 'ON_OTHER_BRANCH');
  assert.equal(r1.out.branch, 'hotfix/misc');
  assert.equal(g(dir, 'symbolic-ref', '--short', 'HEAD'), 'hotfix/misc', '브랜치는 그대로');
  assert.equal(readState(stateFile(dir, 'hotfix-misc')) ?? null, null, '상태는 만들어지지 않는다');

  const r2 = start(dir, 'ABC-9', ['--adopt']);
  assert.equal(r2.status, 0, r2.err);
  assert.equal(r2.out.code, 'ADOPTED');
  assert.equal(r2.out.branch, 'hotfix/misc');
  assert.equal(r2.out.created, true);
  const st = readState(stateFile(dir, 'hotfix-misc'));
  assert.deepEqual(st.keys, ['ABC-9']);
});

test('start: 두 번째 호출은 RESUMED — 아무것도 바꾸지 않는다', () => {
  const dir = makeRepo();
  const r1 = start(dir, 'ABC-1');
  assert.equal(r1.out.code, 'STARTED');
  const before = readState(stateFile(dir, 'feat-ABC-1'));
  const r2 = start(dir, 'ABC-1');
  assert.equal(r2.status, 0, r2.err);
  assert.equal(r2.out.code, 'RESUMED');
  assert.equal(r2.out.created, false);
  const after = readState(stateFile(dir, 'feat-ABC-1'));
  assert.equal(after.started_at, before.started_at);
  assert.equal(after.stage, before.stage);
});

test('status: NO_STATE(패턴 일치·상태 없음) · OUTSIDE_PATTERN(패턴 밖·상태 없음) · OK(시작 후)', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-5');
  const noState = status(dir);
  assert.equal(noState.out.code, 'NO_STATE');
  assert.deepEqual(noState.out.keys, ['ABC-5']);
  assert.equal(noState.out.gate, null);
  assert.equal(noState.out.review, null);

  g(dir, 'checkout', '-q', '-b', 'random/other');
  const outside = status(dir);
  assert.equal(outside.out.code, 'OUTSIDE_PATTERN');
  assert.deepEqual(outside.out.keys, []);

  g(dir, 'checkout', '-q', 'main');
  const r = start(dir, 'ABC-1');
  assert.equal(r.out.code, 'STARTED');
  const ok = status(dir);
  assert.equal(ok.out.code, 'OK');
  assert.equal(ok.out.stage, 'start');
  assert.equal(ok.out.branch, 'feat/ABC-1');
  assert.ok(ok.out.next.includes('grill'), ok.out.next);
  assert.equal(ok.out.dirty.unstaged, 0);
  assert.equal(ok.out.dirty.untracked, 0);
});

test('status: 3키 이상이면 next 힌트가 recon 을 언급한다', () => {
  const dir = makeRepo();
  const r = start(dir, 'ABC-1,ABC-2,ABC-3');
  assert.equal(r.out.code, 'STARTED');
  const ok = status(dir);
  assert.equal(ok.out.code, 'OK');
  assert.ok(ok.out.next.includes('recon'), ok.out.next);
});

test('issue-set --stage · --decision', () => {
  const dir = makeRepo();
  start(dir, 'ABC-1');
  const s1 = setCmd(dir, ['--stage', 'grill', '--note', 'grill 시작']);
  assert.equal(s1.status, 0, s1.err);
  assert.equal(s1.out.mutated, true);
  assert.equal(s1.out.stage, 'grill');
  let st = readState(stateFile(dir, 'feat-ABC-1'));
  assert.equal(st.stage, 'grill');
  assert.ok(st.history.some(h => h.stage === 'grill' && h.note === 'grill 시작'));

  const s2 = setCmd(dir, ['--decision', '화면을 두 개로 나눌까?', '아니오, 하나로']);
  assert.equal(s2.status, 0, s2.err);
  st = readState(stateFile(dir, 'feat-ABC-1'));
  assert.equal(st.decisions.length, 1);
  assert.equal(st.decisions[0].q, '화면을 두 개로 나눌까?');
  assert.equal(st.decisions[0].a, '아니오, 하나로');
  assert.ok(st.decisions[0].at);
});

test('issue-set --merge 는 gate 키가 있는 파일을 거부한다(exit 1) · 정상 파일은 touched·lanes·dod·guides 를 반영한다', () => {
  const dir = makeRepo();
  start(dir, 'ABC-1');

  const badFile = join(dir, 'bad.plan.json');
  writeFileSync(badFile, JSON.stringify({ touched: ['x'], gate: { level: 'commit' } }));
  const bad = setCmd(dir, ['--merge', badFile]);
  assert.equal(bad.status, 1);
  assert.ok(bad.err.includes('gate'), bad.err);
  let st = readState(stateFile(dir, 'feat-ABC-1'));
  assert.equal(st.gate, null, '거부된 병합은 상태를 바꾸지 않는다');

  const okFile = join(dir, 'ok.plan.json');
  writeFileSync(okFile, JSON.stringify({
    touched: ['backend/App.java'],
    lanes: [{ name: 'be', model: 'opus' }],
    dod: [{ id: 'D1', text: '컴파일 통과', probe: 'echo ok' }],
    guides: { 'ABC-1': 'docs/ABC-1-dev-guide.md' },
  }));
  const ok = setCmd(dir, ['--merge', okFile, '--from', 'plan']);
  assert.equal(ok.status, 0, ok.err);
  st = readState(stateFile(dir, 'feat-ABC-1'));
  assert.deepEqual(st.touched, ['backend/App.java']);
  assert.equal(st.lanes.length, 1);
  assert.equal(st.lanes[0].name, 'be');
  assert.equal(st.dod.length, 1);
  assert.equal(st.guides['ABC-1'], 'docs/ABC-1-dev-guide.md');
  assert.ok(st.history.some(h => h.note === 'plan merged'));

  const withReview = join(dir, 'bad2.json');
  writeFileSync(withReview, JSON.stringify({ review: { tree: '0'.repeat(40) } }));
  const bad2 = setCmd(dir, ['--merge', withReview]);
  assert.equal(bad2.status, 1);
  assert.ok(bad2.err.includes('review'), bad2.err);
});

test('issue-set --review 는 현재 인덱스 지문을 트리로 쓰고 blockers_open 을 findings 에서 계산한다', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  start(dir, 'ABC-1');
  edit(dir, 'backend/App.java', 'class App { int x; }\n');
  g(dir, 'add', '-A');

  const reviewFile = join(dir, 'review.json');
  writeFileSync(reviewFile, JSON.stringify({
    codex: 'ok(0)',
    findings: [
      { severity: 'BLOCKER', file: 'backend/App.java', claim: 'x', evidence: 'y' },
      { severity: 'MINOR', file: 'backend/App.java', claim: 'z', evidence: 'w' },
    ],
  }));
  const r = setCmd(dir, ['--review', reviewFile]);
  assert.equal(r.status, 0, r.err);
  const st = readState(stateFile(dir, 'feat-ABC-1'));
  assert.match(st.review.tree, /^[0-9a-f]{40}$/);
  assert.equal(st.review.findings, 2);
  assert.equal(st.review.blockers_open, 1);
  assert.equal(st.review.round, 1);
  assert.equal(st.review.delta_passes, 0);
  assert.equal(g(dir, 'rev-parse', `refs/harness/feat-ABC-1/review`), st.review.tree);

  // 델타 패스: round 는 유지, delta_passes 증가
  writeFileSync(reviewFile, JSON.stringify({ findings: [] }));
  const r2 = setCmd(dir, ['--review', reviewFile, '--delta']);
  assert.equal(r2.status, 0, r2.err);
  const st2 = readState(stateFile(dir, 'feat-ABC-1'));
  assert.equal(st2.review.round, 1);
  assert.equal(st2.review.delta_passes, 1);
  assert.equal(st2.review.blockers_open, 0);
});

test('issue-set --stage 잘못된 값 → exit 1', () => {
  const dir = makeRepo();
  start(dir, 'ABC-1');
  const r = setCmd(dir, ['--stage', 'not-a-stage']);
  assert.equal(r.status, 1);
  assert.ok(r.err.includes('not-a-stage'), r.err);
  const st = readState(stateFile(dir, 'feat-ABC-1'));
  assert.equal(st.stage, 'start', '거부된 stage 는 반영되지 않는다');
});
