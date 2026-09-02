// A6 통합 테스트 — 실제 임시 git 저장소 + bare origin 에서 issue-complete.mjs 를 돌린다.
// 통과 경로만이 아니라 **거부 경로마다 위반을 주입**해 그 코드가 실제로 발화하는지 본다(존재 ≠ 실효).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newState, writeState, readState } from '../lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;

function sh(cmd, args, cwd) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function edit(dir, rel, text) { writeFileSync(join(dir, rel), text); }

const stateFile = (dir, slug = 'feat-ABC-1') => join(dir, '.claude/runtime/issues', `${slug}.json`);
const archiveDir = dir => join(dir, '.claude/runtime/issues/archive');

/** 저장소 + (선택) bare origin. gate.test.mjs 의 헬퍼 패턴을 이 레인 안에서 복제한다(기존 파일은 건드리지 않는다). */
function makeRepo({ mode = 'auto', harness = true, origin = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-complete-'));
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
  let bare = null;
  if (origin) {
    bare = mkdtempSync(join(tmpdir(), 'jh-origin-'));
    g(bare, 'init', '--bare', '-q');
    g(dir, 'remote', 'add', 'origin', bare.replace(/\\/g, '/'));
  }
  return { dir, bare };
}

function gate(dir, ...args) { return sh(NODE, [join(SCRIPTS, 'gate.mjs'), ...args, '--cwd', dir], dir); }
function complete(dir, ...args) { return sh(NODE, [join(SCRIPTS, 'issue-complete.mjs'), ...args, '--cwd', dir, '--json'], dir); }
function out(r) { return JSON.parse(r.stdout.trim().split('\n').pop()); }

function startIssue(dir, branch = 'feat/ABC-1', keys = ['ABC-1']) {
  writeState(stateFile(dir, branch.replace('/', '-')), newState(branch, keys));
}
function addReview(dir, slug = 'feat-ABC-1', patch = {}) {
  const st = readState(stateFile(dir, slug));
  st.review = { tree: st.gate.tree, files: [], codex: 'skipped', lanes: 1, findings: 0, blockers_open: 0, round: 1, delta_passes: 0, at: new Date().toISOString(), ...patch };
  writeState(stateFile(dir, slug), st);
}

/** 브랜치 + 코드 커밋 + 상태 JSON. runtime 은 커밋하지 않는다(fingerprint_exclude 축을 실제로 태우기 위해). */
function begin(opts) {
  const { dir, bare } = makeRepo(opts);
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  edit(dir, 'backend/App.java', 'class App { int x; }\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'feat: ABC-1 구현');
  startIssue(dir);
  return { dir, bare };
}

test('하네스 미설치 → NO_HARNESS exit 2 (거부 exit 1 과 구분된다)', () => {
  const { dir } = makeRepo({ harness: false, origin: false });
  const r = complete(dir);
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.stderr.includes('[jira-harness] complete: NO_HARNESS'), r.stderr);
  assert.equal(out(r).code, 'NO_HARNESS');
});

test('상태 JSON 없음 → NO_STATE · 게이트 기록 없음 → NO_GATE', () => {
  const { dir } = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  const noState = complete(dir);
  assert.equal(noState.status, 1);
  assert.equal(out(noState).code, 'NO_STATE');
  startIssue(dir);
  const noGate = complete(dir);
  assert.equal(noGate.status, 1);
  assert.equal(out(noGate).code, 'NO_GATE');
  assert.ok(noGate.stderr.includes('[jira-harness] complete: NO_GATE — '), noGate.stderr);
});

test('(a) 경량 게이트만 → GATE_LEVEL', () => {
  const { dir } = begin();
  assert.equal(gate(dir, '--commit').status, 0);
  assert.equal(readState(stateFile(dir)).gate.level, 'commit');
  const r = complete(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(out(r).code, 'GATE_LEVEL');
  assert.ok(r.stderr.includes('GATE_LEVEL'), r.stderr);
});

test('(b) 전량 게이트 후 리뷰 없음 → NO_REVIEW', () => {
  const { dir } = begin();
  const f = gate(dir, '--full', '--json');
  assert.equal(f.status, 0, f.stderr + f.stdout);
  const r = complete(dir);
  assert.equal(r.status, 1);
  assert.equal(out(r).code, 'NO_REVIEW');
});

test('(c) 리뷰 blockers_open 1 → REVIEW_BLOCKERS', () => {
  const { dir } = begin();
  assert.equal(gate(dir, '--full').status, 0);
  addReview(dir, 'feat-ABC-1', { blockers_open: 1 });
  const r = complete(dir);
  assert.equal(r.status, 1);
  assert.equal(out(r).code, 'REVIEW_BLOCKERS');
  addReview(dir); // blocker 해소 → 같은 트리에서 통과로 뒤집힌다(가드가 blocker 축을 실제로 보고 있다)
  assert.equal(complete(dir, '--dry-run').status, 0);
});

test('작업트리가 더러우면 DIRTY_TREE — 단 fingerprint_exclude(runtime) 는 분모 밖', () => {
  const { dir } = begin();
  assert.equal(gate(dir, '--full').status, 0);
  addReview(dir);
  // runtime 상태·로그가 untracked 로 남아 있어도 통과해야 한다
  assert.equal(complete(dir, '--dry-run').status, 0);
  edit(dir, 'frontend/app.js', 'export default 2\n'); // unstaged
  let r = complete(dir, '--dry-run');
  assert.equal(r.status, 1);
  assert.equal(out(r).code, 'DIRTY_TREE');
  g(dir, 'checkout', '--', 'frontend/app.js');
  writeFileSync(join(dir, 'backend/New.java'), 'class New {}\n'); // untracked
  r = complete(dir, '--dry-run');
  assert.equal(out(r).code, 'DIRTY_TREE');
  g(dir, 'add', 'backend/New.java'); // staged 만 있어도 (커밋 전이므로) 거부
  r = complete(dir, '--dry-run');
  assert.equal(out(r).code, 'DIRTY_TREE');
});

test('(d) 전부 갖추고 --dry-run → exit 0 · 파일 불변 · push 없음', () => {
  const { dir, bare } = begin();
  assert.equal(gate(dir, '--full').status, 0);
  addReview(dir);
  const before = readFileSync(stateFile(dir), 'utf8');
  const r = complete(dir, '--dry-run');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = out(r);
  assert.equal(j.code, 'OK');
  assert.equal(j.dry_run, true);
  assert.equal(j.pushed, false);
  assert.equal(j.archived_to, null);
  assert.ok(j.plan.archive_to.includes('issues/archive/feat-ABC-1-'), j.plan.archive_to);
  assert.equal(readFileSync(stateFile(dir), 'utf8'), before, 'dry-run 은 상태 JSON 을 건드리지 않는다');
  assert.ok(!existsSync(archiveDir(dir)), 'dry-run 은 archive 디렉토리도 만들지 않는다');
  assert.equal(sh('git', ['rev-parse', '--verify', '-q', 'refs/heads/feat/ABC-1'], bare).status, 1, 'dry-run 은 push 하지 않는다');
});

test('(e) 실행 → origin 브랜치 · archive 파일 · 원래 상태 파일 삭제 · code OK · jira.comment 에 브랜치명', () => {
  const { dir, bare } = begin();
  assert.equal(gate(dir, '--full').status, 0);
  addReview(dir, 'feat-ABC-1', { round: 2, delta_passes: 1, codex: 'ok(120s)', findings: 3 });
  // 사이드카도 같이 옮겨진다
  writeFileSync(join(dir, '.claude/runtime/issues/feat-ABC-1.plan.json'), '{"lanes":[]}\n');
  const st = readState(stateFile(dir));
  st.dod = [
    { id: 'D1', text: '프로브', probe: 'echo 1', last: 'PASS' },
    { id: 'D2', text: '사람 확인', probe: null, human: true, last: 'PENDING' },
  ];
  writeState(stateFile(dir), st);

  const r = complete(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = out(r);
  assert.equal(j.code, 'OK');
  assert.equal(j.pushed, true);
  assert.equal(g(bare, 'rev-parse', 'refs/heads/feat/ABC-1'), g(dir, 'rev-parse', 'HEAD'), 'origin 에 브랜치가 올라갔다');
  assert.ok(!existsSync(stateFile(dir)), '원래 상태 파일은 남지 않는다');
  const archived = join(dir, '.claude', ...j.archived_to.split('/').slice(1));
  assert.ok(existsSync(archived), `archive 파일 없음: ${j.archived_to}`);
  const arch = JSON.parse(readFileSync(archived, 'utf8'));
  assert.equal(arch.stage, 'archived');
  assert.ok(arch.history.some(h => h.stage === 'archived'), 'history 에 archived 기록');
  assert.equal(j.sidecars.length, 1);
  assert.ok(readdirSync(archiveDir(dir)).some(f => f.endsWith('.plan.json')), '사이드카도 아카이브로 이동');
  assert.ok(!existsSync(join(dir, '.claude/runtime/issues/feat-ABC-1.plan.json')));

  assert.equal(j.jira.transition, 'QA');
  assert.ok(j.jira.comment.includes('feat/ABC-1'), j.jira.comment);
  assert.ok(j.jira.comment.includes('be(') && j.jira.comment.includes('fe('), `스택별 분모: ${j.jira.comment}`);
  assert.ok(j.jira.comment.includes('프로브 1/1 PASS') && j.jira.comment.includes('사람 확인 1건 SKIPPED'), j.jira.comment);
  assert.ok(j.jira.comment.includes('라운드 2') && j.jira.comment.includes('델타 패스 1') && j.jira.comment.includes('ok(120s)'), j.jira.comment);
  assert.ok(j.jira.comment.includes('main 머지는 사람이'), j.jira.comment);
  assert.ok(j.jira.comment.includes('- 소요: 총'), `소요 시간 줄이 댓글에 남는다: ${j.jira.comment}`);
  assert.equal(typeof j.summary.timing.total_s, 'number', 'summary.timing.total_s');
  assert.ok(j.summary.timing.stage_offsets_s && !('start' in j.summary.timing.stage_offsets_s), 'stage_offsets_s 는 start 를 뺀 단계별 첫 도달 초');
  assert.deepEqual(j.summary.dod_human_pending, ['D2']);
  assert.equal(j.summary.gate.level, 'full');
  assert.equal(j.summary.review.blockers_open, 0);
});

test('--no-push 는 push 없이 아카이브만 · origin 이 없으면 PUSH_FAILED 이고 아카이브하지 않는다', () => {
  const noRemote = begin({ origin: false }).dir;
  assert.equal(gate(noRemote, '--full').status, 0);
  addReview(noRemote);
  const bad = complete(noRemote);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.equal(out(bad).code, 'PUSH_FAILED');
  assert.ok(existsSync(stateFile(noRemote)), 'push 실패 시 아카이브하지 않는다');
  assert.ok(!existsSync(archiveDir(noRemote)));

  const ok = complete(noRemote, '--no-push');
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(out(ok).pushed, false);
  assert.ok(!existsSync(stateFile(noRemote)));
  assert.ok(existsSync(archiveDir(noRemote)));
});

test('(f) CLAUDE.md 가 상한을 넘으면 CLAUDE_MD_TOO_LONG — 줄이면 통과로 뒤집힌다', () => {
  const { dir } = begin();
  assert.equal(gate(dir, '--full').status, 0);
  addReview(dir);
  writeFileSync(join(dir, 'CLAUDE.md'), Array.from({ length: 200 }, (_, i) => `줄 ${i + 1}`).join('\n') + '\n');
  g(dir, 'add', 'CLAUDE.md'); // docs_only 라 게이트 지문은 유지된다
  g(dir, 'commit', '-q', '-m', 'docs: CLAUDE.md');
  const r = complete(dir, '--dry-run');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const j = out(r);
  assert.equal(j.code, 'CLAUDE_MD_TOO_LONG');
  assert.equal(j.claude_md_lines, 200);
  assert.equal(j.claude_md_max_lines, 150);
  writeFileSync(join(dir, 'CLAUDE.md'), Array.from({ length: 150 }, (_, i) => `줄 ${i + 1}`).join('\n') + '\n');
  g(dir, 'add', 'CLAUDE.md');
  g(dir, 'commit', '-q', '-m', 'docs: CLAUDE.md 축약');
  assert.equal(complete(dir, '--dry-run').status, 0, '상한 이하면 통과');
});

test('(g) 게이트 후 코드 커밋 → GATE_STALE · 문서 커밋은 통과(docs_only)', () => {
  const { dir } = begin();
  assert.equal(gate(dir, '--full').status, 0);
  addReview(dir);
  edit(dir, 'docs/README.md', '# docs v2\n');
  g(dir, 'add', 'docs/README.md');
  g(dir, 'commit', '-q', '-m', 'docs');
  assert.equal(complete(dir, '--dry-run').status, 0, 'docs-only 후속 커밋은 지문을 무효화하지 않는다');

  edit(dir, 'backend/App.java', 'class App { int x, y; }\n');
  g(dir, 'add', 'backend/App.java');
  g(dir, 'commit', '-q', '-m', 'feat: 추가 변경');
  const r = complete(dir, '--dry-run');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(out(r).code, 'GATE_STALE');
  assert.ok(r.stderr.includes('backend/App.java'), r.stderr);
});

test('게이트 결과 FAIL 주입 → GATE_FAIL · 게이트 로그 변조 → GATE_LOG_MISMATCH', () => {
  const { dir } = begin();
  assert.equal(gate(dir, '--full').status, 0);
  addReview(dir);
  let st = readState(stateFile(dir));
  const good = st.gate.results.test;
  st.gate.results.test = 'FAIL';
  writeState(stateFile(dir), st);
  const fail = complete(dir, '--dry-run');
  assert.equal(fail.status, 1);
  assert.equal(out(fail).code, 'GATE_FAIL');
  assert.ok(fail.stderr.includes('test=FAIL'), fail.stderr);

  st = readState(stateFile(dir));
  st.gate.results.test = good;
  writeState(stateFile(dir), st);
  writeFileSync(join(dir, st.gate.log), '변조된 로그\n');
  const tampered = complete(dir, '--dry-run');
  assert.equal(tampered.status, 1);
  assert.equal(out(tampered).code, 'GATE_LOG_MISMATCH');
});

test('리뷰가 낡으면 REVIEW_STALE (게이트만 다시 돌려서는 통과하지 못한다)', () => {
  const { dir } = begin();
  assert.equal(gate(dir, '--full').status, 0);
  addReview(dir);
  edit(dir, 'frontend/app.js', 'export default 9\n');
  g(dir, 'add', 'frontend/app.js');
  g(dir, 'commit', '-q', '-m', 'feat: fe 변경');
  assert.equal(gate(dir, '--full').status, 0); // 게이트만 갱신 — 리뷰는 옛 트리 그대로
  const r = complete(dir, '--dry-run');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(out(r).code, 'REVIEW_STALE');
  addReview(dir); // 델타 패스 기록
  assert.equal(complete(dir, '--dry-run').status, 0);
});
