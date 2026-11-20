// herdr-lanes.mjs implement 실측 — 상태 JSON 의 레인 선언을 worktree + kind 레인으로 띄우고, 패치를 회수해 메인에 적용하는 경로.
// Herdr 는 대역(fake-herdr)이다. 기본 배치(split)에서는 worktree 를 실행기가 git 으로 직접 파므로 진짜 worktree 가 생긴다 — 레인 에이전트가 고친 것처럼
// 테스트가 그 worktree 에 파일을 바꿔 두고(그러려면 미리 판다 → mode existing) 사이드카를 써 둔다. workspace 배치는 대역의 worktree 명령으로 검사한다.
// 판정축: kind 배정(plan 선언 > 풀 순서) · 전부 띄운 뒤 기다림 · 패치 회수(add→diff→reset) · 적용 yes/conflict/skipped/empty/no-apply · 상태 JSON lanes[] · 장부 · 커밋 0.
import './fixtures/no-queue.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate, loadSchema } from '../lib/schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;
const FAKE = `node:${join(HERE, 'fixtures/fake-herdr.mjs')}`;
const SLUG = 'feat-ABC-5';
const fwd = p => String(p).replace(/\\/g, '/');
/** 메인에 들어간 파일은 저장소의 core.autocrlf 를 따른다(git apply 도 checkout 변환을 탄다) — 비교는 줄끝을 정규화해서 */
const txt = p => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

function sh(cmd, args, cwd, env = {}) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function lanes(cwd, args, env) { const r = sh(NODE, [join(SCRIPTS, 'herdr-lanes.mjs'), ...args, '--cwd', cwd, '--json'], cwd, env); let value = null; try { value = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1)); } catch { /* */ } return { ...r, value }; }
const OUTSIDE = { HERDR_PANE_ID: '', HERDR_WORKSPACE_ID: '', HERDR_ENV: '', HERDR_SOCKET_PATH: '', JIRA_HARNESS_HERDR: FAKE, FAKE_HERDR_AGENTS: '', FAKE_HERDR_WORKTREES: '', FAKE_HERDR_STATES: '', FAKE_HERDR_READ: '', FAKE_HERDR_READ_SEQ: '', FAKE_HERDR_GET_FAIL: '' };
function inside(dir, extra = {}) {
  const tag = Math.random().toString(36).slice(2);
  const log = join(dir, `h.${tag}.log`); const counter = join(dir, `h.count.${tag}`);
  const wtDir = mkdtempSync(join(tmpdir(), 'cw-impl-wt-'));
  return { env: { ...OUTSIDE, HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1', HERDR_ENV: '1', FAKE_HERDR_LOG: log, FAKE_HERDR_STATE_FILE: counter, FAKE_HERDR_WORKTREE_DIR: wtDir, ...extra }, log, wtDir };
}
function calls(log) { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }
const state = dir => JSON.parse(readFileSync(join(dir, '.claude/runtime/issues', `${SLUG}.json`), 'utf8'));
const ok = (name, files) => ({ name, status: 'done', files, tests: { command: 'echo test', passed: 1, failed: 0 }, notes: '' });
/** split 배치의 기본 worktree 경로 */
const splitPath = (dir, lane) => join(dir, '.claude/runtime/herdr/worktrees', SLUG, lane);

/** 임시 저장소 + 이슈 브랜치 + 상태 JSON(레인 2개 — fe 는 plan 이 kind 를 골랐고 be 는 풀에 맡긴다) */
function makeRepo(herdrPatch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-impl-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  for (const d of ['backend', 'frontend', '.claude']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'backend/App.java'), 'class App {}\n');
  writeFileSync(join(dir, 'frontend/app.js'), 'export default 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.claude/runtime/\n');
  const cfg = { ...JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8')), herdr: { lanes: 'implement', kinds: { implement: ['codex', 'claude'] }, settle_grace_s: 1, ...herdrPatch } };
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-5');
  const st = sh(NODE, [join(SCRIPTS, 'issue-start.mjs'), 'ABC-5', '--cwd', dir, '--json'], dir, OUTSIDE);
  assert.equal(st.status, 0, st.stderr);
  const set = sh(NODE, [join(SCRIPTS, 'issue-set.mjs'), '--cwd', dir,
    '--lane', JSON.stringify({ name: 'be', model: 'opus', files: ['backend/**'], worktree: true, brief: '서버 쪽을 고친다' }),
    '--lane', JSON.stringify({ name: 'fe', model: 'sonnet', files: ['frontend/**'], worktree: true, brief: '화면 쪽을 고친다', kind: 'grok', kind_reason: '작은 변경' })], dir, OUTSIDE);
  assert.equal(set.status, 0, set.stderr);
  return dir;
}
/** split 배치: 실행기가 쓸 경로에 그 브랜치의 worktree 를 미리 판다(→ mode existing) — 레인 에이전트가 고친 상태를 만들기 위해 */
function plantSplit(dir, lane) {
  const p = splitPath(dir, lane);
  mkdirSync(dirname(p), { recursive: true });
  g(dir, 'worktree', 'add', '-q', '-b', `lane/${SLUG}/${lane}`, p, 'HEAD');
  return p;
}
/** workspace 배치: 대역이 돌려줄 경로에 detached worktree 를 판다 */
function plantFake(dir, wtDir, lane) {
  const p = join(wtDir, `lane-${SLUG}-${lane}`);
  g(dir, 'worktree', 'add', '-q', '--detach', p, 'HEAD');
  return p;
}
/** 레인 사이드카 — 에이전트가 제출 뒤에 쓰는 것을 흉내(대역이 <f>.agent 를 prompt 때 <f> 로 복사). 미리 <f> 에 두면 실행기가 지난 결과로 치운다 */
function sidecar(dir, lane, body) {
  const f = join(dir, '.claude/runtime/issues', `${SLUG}.lane-${lane}.json`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(`${f}.agent`, JSON.stringify(body));
  return f;
}

test('스키마: herdr.lanes 에 implement · lane_placement · auto_trust · kinds.implement/profiles · worktree_copy/init/dir 이 들어가고 엉뚱한 값은 잡힌다 · 상태 lanes[] 의 kind·kind_reason·kind_source', () => {
  const h = JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8'));
  h.herdr = { lanes: 'implement', lane_placement: 'split', auto_trust: true, worktree_dir: '.claude/runtime/lanes', kinds: { implement: ['codex'], profiles: { codex: '닫힌 구현' } }, worktree_copy: ['.claude/harness.env.local'], worktree_init: ['npm ci'] };
  assert.deepEqual(validate(h, loadSchema('harness')), []);
  h.herdr.lanes = 'bogus';
  assert.ok(validate(h, loadSchema('harness')).some(e => e.includes('$.herdr.lanes')));
  h.herdr.lanes = 'all'; h.herdr.lane_placement = 'tab';
  assert.ok(validate(h, loadSchema('harness')).some(e => e.includes('lane_placement')));
  h.herdr.lane_placement = 'workspace'; h.herdr.kinds.profiles = { codex: 3 };
  assert.ok(validate(h, loadSchema('harness')).some(e => e.includes('profiles.codex')));
  const s = JSON.parse(readFileSync(join(HERE, 'fixtures/state.json'), 'utf8'));
  s.lanes[0] = { ...s.lanes[0], kind: 'codex', kind_reason: '테스트까지 미는 일', kind_source: 'plan', brief: 'x', result: { status: 'done', applied: 'yes' } };
  assert.deepEqual(validate(s, loadSchema('state')), []);
  s.lanes[0].kind_source = 'guess';
  assert.ok(validate(s, loadSchema('state')).some(e => e.includes('kind_source')));
});

test('implement: herdr.lanes 가 verify 면 ok:false · Herdr 밖이면 outside herdr · --dry-run 은 배치·kind 배정(plan 선언 > 풀 순서)·worktree 브랜치·프롬프트를 보여주고 herdr 를 부르지 않는다', () => {
  const off = makeRepo({ lanes: 'verify' });
  const r0 = lanes(off, ['implement', '--slug', SLUG], inside(off).env);
  assert.equal(r0.status, 0, r0.stderr);
  assert.equal(r0.value.ok, false);
  assert.match(r0.value.reason, /herdr\.lanes=verify/);

  const dir = makeRepo();
  const o = lanes(dir, ['implement', '--slug', SLUG], { ...OUTSIDE, FAKE_HERDR_LOG: join(dir, 'o.log') });
  assert.equal(o.value.ok, false);
  assert.match(o.value.reason, /outside herdr/);
  assert.equal(calls(join(dir, 'o.log')).length, 0);

  const { env, log } = inside(dir);
  const r = lanes(dir, ['implement', '--slug', SLUG, '--dry-run', '--contracts', 'DTO FeeRes {id, amount}'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.value.dry_run, true);
  assert.equal(r.value.placement, 'split');
  assert.equal(fwd(r.value.worktree_dir).toLowerCase(), fwd(join(dir, '.claude/runtime/herdr/worktrees', SLUG)).toLowerCase(), '레인 작업트리 자리는 메인 저장소 runtime 아래의 절대 경로');
  assert.deepEqual(r.value.lanes.map(l => [l.lane, l.name, l.kind, l.kind_source, l.worktree_branch]), [
    ['be', 'impl-be', 'codex', 'pool', `lane/${SLUG}/be`],
    ['fe', 'impl-fe', 'grok', 'plan', `lane/${SLUG}/fe`],
  ]);
  assert.equal(r.value.lanes[1].kind_reason, '작은 변경');
  const p = r.value.lanes[0].prompt;
  assert.match(p, /Phase 0 공통 계약[\s\S]*DTO FeeRes \{id, amount\}/);
  assert.match(p, /backend\/\*\*/);
  assert.match(p, /서버 쪽을 고친다/);
  assert.match(p, /git commit · git push · git stash · 브랜치 전환을 하지 않는다/);
  assert.match(p, /lane\/feat-ABC-5\/be/);
  assert.match(r.value.lanes[1].prompt, /화면 쪽을 고친다/);
  assert.match(r.value.lanes[0].out, /feat-ABC-5\.lane-be\.json$/);
  assert.equal(calls(log).length, 0, 'dry-run 은 herdr 를 부르지 않는다');
  assert.ok(!existsSync(splitPath(dir, 'be')), 'dry-run 은 worktree 도 파지 않는다');

  const only = lanes(dir, ['implement', '--slug', SLUG, '--dry-run', '--lanes', 'fe'], env);
  assert.deepEqual(only.value.lanes.map(l => l.lane), ['fe']);
  assert.deepEqual(only.value.skipped, ['be']);
  const none = lanes(dir, ['implement', '--slug', SLUG, '--lanes', 'zz'], env);
  assert.equal(none.value.ok, false);
  assert.match(none.value.reason, /--lanes zz/);
  const ws = lanes(makeRepo({ lane_placement: 'workspace' }), ['implement', '--slug', SLUG, '--dry-run'], env);
  assert.equal(ws.value.placement, 'workspace');
});

test('implement 프롬프트의 검증 규칙: 레인의 DoD 테스트는 gate --try --lane 하나로 묶어 돌린다(전체 테스트·lint·build·위반 주입은 레인이 돌리지 않는다) · dod 가 없는 레인은 선택 실행 · dod_tests 없는 프로젝트는 러너 직접 · 시간 상한은 lane_timeout_s 가 작아도 3600 이상', () => {
  // (a) dod_tests 가 없는 프로젝트 — 진입점 안내 없이 「자기 테스트만 한 번에」 규칙만. 시간 상한은 기본값(900)이 아니라 3600
  const plain = makeRepo();
  const a = lanes(plain, ['implement', '--slug', SLUG, '--dry-run'], inside(plain).env);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.value.timeout_s, 3600, '리뷰 레인 기준인 lane_timeout_s 기본값(900)을 구현 레인에 그대로 쓰지 않는다');
  const pa = a.value.lanes[0].prompt;
  assert.match(pa, /## 검증 — 자기 테스트만, 한 번에 묶어서/);
  assert.match(pa, /자기가 쓰거나 고친 테스트만\*\* 그 스택의 러너로 한 번에 묶어 돌린다/);
  assert.doesNotMatch(pa, /gate\.mjs" --try/, 'dod_tests 가 없으면 --try 로 돌릴 것이 없다');
  assert.match(pa, /돌리지 않는 것: 전체 테스트 · 전체 lint · build · 위반 주입 프로브/);
  assert.match(pa, /테스트 실행은 통틀어 3번 안팎에서 끝낸다/);
  assert.doesNotMatch(pa, /실행하지 않았으면 tests\.command 를 빈 문자열로 두고 status 는 partial/, '돌릴 테스트가 없는 레인을 partial 로 몰지 않는다');
  assert.equal(lanes(makeRepo({ lane_timeout_s: 7200 }), ['implement', '--slug', SLUG, '--dry-run'], inside(plain).env).value.timeout_s, 7200, '더 길게 준 설정은 그대로');
  assert.equal(lanes(makeRepo({ lane_timeout_s: 600 }), ['implement', '--slug', SLUG, '--dry-run'], inside(plain).env).value.timeout_s, 3600, '짧게 준 설정은 하한까지 올린다');

  // (b) dod_tests 가 있는 프로젝트 — 레인의 dod(id)가 있으면 --lane, 없으면 --stack/--select
  const dir = makeRepo();
  const cfgPath = join(dir, '.claude/harness.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.stacks.be.dod_tests = { adapter: 'gradle-junit', run: './gradlew test' };
  cfg.stacks.fe.dod_tests = { adapter: 'vitest', run: 'npx vitest run' };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  const set = sh(NODE, [join(SCRIPTS, 'issue-set.mjs'), '--cwd', dir,
    '--dod', JSON.stringify({ id: 'D1', text: '[ABC-5] 수수료 계산', tests: { stack: 'be', select: ['*FeeTest*'] }, expect: { min_tests: 3 } }),
    '--dod', JSON.stringify({ id: 'D2', text: '[ABC-5] 위반 주입', probe: 'echo INJECTION_FIRED', expect: { pattern: 'INJECTION_FIRED' } }),
    '--lane', JSON.stringify({ name: 'be', model: 'opus', files: ['backend/**'], worktree: true, brief: '서버 쪽을 고친다', dod: ['D1', 'D2'] })], dir, OUTSIDE);
  assert.equal(set.status, 0, set.stderr);
  const b = lanes(dir, ['implement', '--slug', SLUG, '--dry-run'], inside(dir).env);
  assert.equal(b.status, 0, b.stderr);
  const [be, fe] = b.value.lanes.map(l => l.prompt);
  assert.match(be, /## 이 레인이 닫아야 할 DoD\n- D1 \[ABC-5\] 수수료 계산 \(be: \*FeeTest\*\)\n- D2 \[ABC-5\] 위반 주입/, 'DoD id 를 상태의 문구·선택으로 풀어 보여준다');
  assert.match(be, /node ".*\/scripts\/gate\.mjs" --try --slug feat-ABC-5 --lane be --cwd "<worktree>"/);
  assert.match(be, /「다시」 줄에 나온 명령으로 \*\*실패한 것만\*\* 다시 돌린다/);
  assert.match(be, /gate\.mjs" --try --stack <스택> --select '<패턴>'/);
  assert.match(be, /스택과 패턴: be = 테스트 클래스 패턴\(예 '\*FeeTest\*'\) · fe = 테스트 파일 경로\(그 스택 폴더 기준\)/);
  assert.doesNotMatch(fe, /--try --slug/, 'dod 가 없는 레인에는 --lane 을 권하지 않는다(돌리면 exit 2 다)');
  assert.match(fe, /자기가 쓰거나 고친 테스트만\*\* 아래 명령으로 한 번에 묶어 돌린다/);
  assert.match(fe, /gate\.mjs" --try --stack <스택> --select '<패턴>'/);
  for (const p of [be, fe]) assert.doesNotMatch(p, /의 테스트를 돌리지 못한다/, '모든 스택이 묶어 돌 수 있으면 그 안내는 없다');

  // (c) dod_tests 가 한 스택에만 있는 프로젝트 — --try 가 묶어 돌리지 못하는 스택을 이름으로 알린다(그 스택을 --stack 으로 지목하면 exit 2 다)
  delete cfg.stacks.fe.dod_tests;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  const c = lanes(dir, ['implement', '--slug', SLUG, '--dry-run'], inside(dir).env);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(c.value.lanes.length, 2);
  for (const p of c.value.lanes.map(l => l.prompt)) {
    assert.match(p, /위 명령은 스택 fe 의 테스트를 돌리지 못한다\(그 스택에는 묶어 돌리는 설정이 없다 — `--stack fe` 은 실패한다\)/);
    assert.match(p, /그 스택의 러너를 직접 불러 \*\*자기 테스트만 한 번에 묶어\*\* 돌린다/);
    assert.match(p, /스택과 패턴: be = 테스트 클래스 패턴/);
    assert.doesNotMatch(p, /fe = 테스트 파일 경로/, '묶어 돌 수 없는 스택을 「스택과 패턴」에 올리지 않는다');
  }
});

test('implement(split): 레인 2개를 git worktree + driver 옆 pane 으로 띄워(전부 start 뒤 wait) 패치를 회수·적용하고 상태 JSON lanes[] 와 장부에 kind·결과를 남긴다 · 새 워크스페이스 없음 · 커밋은 0', () => {
  const dir = makeRepo();
  const { env, log } = inside(dir, { FAKE_HERDR_STATES: 'working,working,done,done' });
  const be = plantSplit(dir, 'be');
  const fe = plantSplit(dir, 'fe');
  writeFileSync(join(be, 'backend/App.java'), 'class App { int fee; }\n');
  writeFileSync(join(be, 'backend/Fee.java'), 'class Fee {}\n');
  writeFileSync(join(fe, 'frontend/app.js'), 'export default 2;\n');
  sidecar(dir, 'be', { name: 'be', status: 'done', files: ['backend/App.java', 'backend/Fee.java'], tests: { command: 'gradle test', passed: 3, failed: 0 }, notes: 'FeeRes 는 fe 가 받는다' });
  sidecar(dir, 'fe', ok('fe', ['frontend/app.js']));

  const r = lanes(dir, ['implement', '--slug', SLUG], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.value.ok, true, JSON.stringify(r.value).slice(0, 800));
  assert.equal(r.value.applied, 2);
  assert.equal(r.value.conflicts, 0);
  assert.deepEqual(r.value.failed, []);
  assert.deepEqual(r.value.lanes.map(l => [l.lane, l.kind, l.status, l.sidecar.status, l.applied, l.patch.files.length]), [
    ['be', 'codex', 'done', 'done', 'yes', 2],
    ['fe', 'grok', 'done', 'done', 'yes', 1],
  ]);
  assert.equal(r.value.lanes[0].worktree.mode, 'existing');
  assert.equal(r.value.lanes[0].worktree.placement, 'split');
  assert.equal(fwd(r.value.lanes[0].worktree.path), fwd(be));
  // 메인 체크아웃에 들어왔고(작업트리), 커밋은 아무도 하지 않았다
  assert.equal(txt(join(dir, 'backend/App.java')), 'class App { int fee; }\n');
  assert.equal(txt(join(dir, 'backend/Fee.java')), 'class Fee {}\n');
  assert.equal(txt(join(dir, 'frontend/app.js')), 'export default 2;\n');
  assert.equal(g(dir, 'rev-list', '--count', 'HEAD'), '1', '레인도 메인도 커밋하지 않는다');
  assert.equal(g(be, 'rev-list', '--count', 'HEAD'), '1');
  // 회수 뒤 worktree 인덱스는 비어 있다(add → diff → reset) · 변경은 그대로
  assert.equal(g(be, 'diff', '--cached', '--name-only'), '');
  assert.match(g(be, 'status', '--porcelain'), /Fee\.java/);
  // 상태 JSON — plan 의 선언은 보존되고 kind·result 가 붙는다
  const st = state(dir);
  const lb = st.lanes.find(l => l.name === 'be');
  assert.equal(lb.model, 'opus'); assert.deepEqual(lb.files, ['backend/**']); assert.equal(lb.brief, '서버 쪽을 고친다');
  assert.equal(lb.kind, 'codex'); assert.equal(lb.kind_source, 'pool');
  assert.equal(lb.result.status, 'done'); assert.equal(lb.result.applied, 'yes'); assert.equal(lb.result.tests.passed, 3); assert.match(lb.result.patch, /lane-be\.patch$/);
  const lf = st.lanes.find(l => l.name === 'fe');
  assert.equal(lf.kind, 'grok'); assert.equal(lf.kind_source, 'plan'); assert.equal(lf.kind_reason, '작은 변경');
  // 장부·패치 파일
  const ledger = JSON.parse(readFileSync(join(dir, '.claude/runtime/herdr', `implement-${SLUG}.json`), 'utf8'));
  assert.equal(ledger.lanes.be.applied, 'yes'); assert.equal(ledger.lanes.fe.branch, `lane/${SLUG}/fe`); assert.equal(ledger.lanes.be.placement, 'split');
  assert.match(readFileSync(join(dir, '.claude/runtime/herdr/patches', `${SLUG}.lane-be.patch`), 'utf8'), /\+class Fee \{\}/);
  assert.ok(existsSync(join(dir, '.claude/runtime/issues', `${SLUG}.lane-be.json.prompt.md`)), '프롬프트는 파일로');
  // herdr 호출 — pane split 2(driver 옆 격자 · --cwd worktree) · worktree 명령 0 · start 2(kind 순서) · 전부 띄운 뒤 wait · 완료 토스트
  const c = calls(log);
  const names = c.map(a => `${a[0]} ${a[1]}`);
  assert.equal(names.filter(n => n === 'pane split').length, 2);
  assert.ok(!names.some(n => n.startsWith('worktree ')), 'split 배치는 Herdr worktree 명령을 쓰지 않는다(새 워크스페이스 없음)');
  const splits = c.filter(a => a[0] === 'pane' && a[1] === 'split');
  // 격자: 1번 레인은 driver(w1:p1) 오른쪽, 2번 레인은 1번 pane(fake 는 w1:p9) 아래 — 세로 한 줄이 아니라 2행(2026-09-14 오너 지시)
  assert.deepEqual(splits.map(s => [s[s.indexOf('--pane') + 1], s[s.indexOf('--direction') + 1]]), [['w1:p1', 'right'], ['w1:p9', 'down']], '격자 배치');
  for (const s of splits) assert.ok(s.includes('--no-focus'), '초점은 driver 에 남는다');
  assert.deepEqual(splits.map(s => fwd(s[s.indexOf('--cwd') + 1])), [fwd(be), fwd(fe)]);
  assert.equal(names.filter(n => n === 'agent start').length, 2);
  assert.equal(names.filter(n => n === 'agent wait').length, 2);
  assert.ok(names.lastIndexOf('agent start') < names.indexOf('agent wait'), '두 레인을 다 띄운 뒤에 기다린다');
  const starts = c.filter(a => a[0] === 'agent' && a[1] === 'start');
  assert.deepEqual(starts.map(a => a[2]), ['impl-be', 'impl-fe']);
  assert.deepEqual(starts.map(a => a[4]), ['codex', 'grok']);
  assert.ok(c.some(a => a[0] === 'notification' && /적용 2/.test(a[2])), `완료 토스트: ${JSON.stringify(c.filter(a => a[0] === 'notification'))}`);
  assert.match(r.value.next, /issue-start\.mjs --remove-worktree <KEY>/, '작업트리는 안전 제거로 안내한다');
  assert.doesNotMatch(r.value.next, /git worktree remove/);
});

test('implement(split): 체크아웃이 없으면 실행기가 git worktree add 로 판다(created · 브랜치 생성) · 장부 applied 면 remove --force 뒤 새로 판다(fresh · 지난 변경 소멸) · 낡은 브랜치는 지우고 · HEAD 밖 커밋이 있으면 보존하고 failed', () => {
  const dir = makeRepo();
  const a = inside(dir, { FAKE_HERDR_STATES: 'working,done' });
  sidecar(dir, 'be', ok('be', []));
  const r1 = lanes(dir, ['implement', '--slug', SLUG, '--lanes', 'be'], a.env);
  assert.equal(r1.status, 0, r1.stderr);
  const w1 = r1.value.lanes[0].worktree;
  assert.equal(w1.mode, 'created', JSON.stringify(r1.value.lanes[0]));
  assert.equal(fwd(w1.path), fwd(splitPath(dir, 'be')));
  assert.ok(existsSync(join(w1.path, 'backend/App.java')));
  assert.equal(g(dir, 'rev-parse', '--abbrev-ref', `lane/${SLUG}/be`), `lane/${SLUG}/be`, '브랜치가 생겼다');
  assert.match(g(dir, 'worktree', 'list'), /lane\/feat-ABC-5\/be/);
  assert.equal(r1.value.lanes[0].applied, 'empty');
  assert.equal(g(dir, 'status', '--porcelain', '--', 'backend', 'frontend'), '', '메인은 그대로');

  // 장부 applied(empty 포함) → 다음 실행은 fresh: 지난 변경이 있는 worktree 를 지우고 다시 판다
  writeFileSync(join(w1.path, 'backend/App.java'), 'class App { int stale; }\n');
  const b = inside(dir, { FAKE_HERDR_STATES: 'working,done' });
  const r2 = lanes(dir, ['implement', '--slug', SLUG, '--lanes', 'be'], b.env);
  const w2 = r2.value.lanes[0].worktree;
  assert.equal(w2.mode, 'created', JSON.stringify(r2.value.lanes[0]));
  assert.equal(txt(join(w2.path, 'backend/App.java')), 'class App {}\n', '새로 판 worktree 에는 지난 변경이 없다');
  assert.equal(r2.value.lanes[0].applied, 'empty');
  assert.ok(!calls(b.log).some(x => x[0] === 'worktree'), 'git 이 worktree 를 관리한다 — Herdr worktree 명령 0');

  // 낡은 브랜치(체크아웃 없음 · HEAD 와 같은 지점)는 지우고 판다
  const d3 = makeRepo();
  g(d3, 'branch', `lane/${SLUG}/be`);
  sidecar(d3, 'be', ok('be', []));
  const r3 = lanes(d3, ['implement', '--slug', SLUG, '--lanes', 'be'], inside(d3, { FAKE_HERDR_STATES: 'working,done' }).env);
  assert.equal(r3.value.lanes[0].worktree.dropped_stale, true, JSON.stringify(r3.value.lanes[0]));
  assert.equal(r3.value.lanes[0].worktree.mode, 'created');
  // HEAD 밖 커밋이 있는 브랜치는 보존하고 그 레인은 failed
  const d4 = makeRepo();
  g(d4, 'checkout', '-q', '-b', `lane/${SLUG}/fe`);
  writeFileSync(join(d4, 'frontend/app.js'), 'export default 9;\n');
  g(d4, 'commit', '-q', '-am', 'lane commit');
  g(d4, 'checkout', '-q', 'feat/ABC-5');
  const r4 = lanes(d4, ['implement', '--slug', SLUG, '--lanes', 'fe'], inside(d4, { FAKE_HERDR_STATES: 'working,done' }).env);
  assert.equal(r4.value.lanes[0].status, 'failed');
  assert.match(r4.value.lanes[0].reason, /HEAD 에 없는 커밋/);
  assert.equal(sh('git', ['show-ref', '--verify', '-q', `refs/heads/lane/${SLUG}/fe`], d4).status, 0, '브랜치는 남는다');
});

test('implement: 사이드카 failed/결과 없음이면 패치는 뽑되 적용하지 않는다(skipped/empty) · --no-apply · 메인이 같은 파일을 고쳐 두면 conflict(메인 수정을 덮지 않는다)', () => {
  // (a) sidecar failed(be) + 결과 없이 오류 파일만(fe) — 결과도 오류도 없는 레인은 lane_timeout_s 까지 기다린다(그 경로는 herdr-lanes.test 의 run 이 짧은 상한으로 본다)
  const d1 = makeRepo();
  const a = inside(d1, { FAKE_HERDR_STATES: 'working,working,done,done' });
  const be1 = plantSplit(d1, 'be'); plantSplit(d1, 'fe');
  writeFileSync(join(be1, 'backend/App.java'), 'class App { int x; }\n');
  sidecar(d1, 'be', { name: 'be', status: 'failed', files: [], tests: { command: '', passed: 0, failed: 0 }, notes: '테스트를 못 돌렸다' });
  writeFileSync(join(d1, '.claude/runtime/issues', `${SLUG}.lane-fe.json.error.txt.agent`), '담당 파일을 찾지 못했다');
  const r1 = lanes(d1, ['implement', '--slug', SLUG], a.env);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.value.ok, false);
  const be = r1.value.lanes.find(l => l.lane === 'be');
  assert.equal(be.status, 'done'); assert.equal(be.sidecar.status, 'failed'); assert.equal(be.applied, 'skipped');
  assert.equal(be.patch.files.length, 1, '패치는 뽑아 둔다(적용만 안 한다)');
  const fe = r1.value.lanes.find(l => l.lane === 'fe');
  assert.equal(fe.status, 'failed'); assert.match(fe.reason, /레인 보고 오류: 담당 파일을 찾지 못했다/); assert.equal(fe.applied, 'empty'); assert.equal(fe.sidecar, null);
  assert.equal(txt(join(d1, 'backend/App.java')), 'class App {}\n', '메인은 그대로');
  assert.deepEqual(r1.value.failed.map(s => s.split(':')[0]), ['impl-fe']);
  assert.equal(state(d1).lanes.find(l => l.name === 'fe').result.status, 'failed');
  assert.equal(state(d1).lanes.find(l => l.name === 'be').result.status, 'failed');
  assert.ok(calls(a.log).some(x => x[0] === 'notification' && /미완 1/.test(x[2])));

  // (b) --no-apply
  const d2 = makeRepo();
  const b = inside(d2, { FAKE_HERDR_STATES: 'working,working,done,done' });
  const be2 = plantSplit(d2, 'be'); plantSplit(d2, 'fe');
  writeFileSync(join(be2, 'backend/App.java'), 'class App { int y; }\n');
  sidecar(d2, 'be', ok('be', ['backend/App.java'])); sidecar(d2, 'fe', ok('fe', []));
  const r2 = lanes(d2, ['implement', '--slug', SLUG, '--no-apply'], b.env);
  assert.equal(r2.value.ok, true);
  assert.equal(r2.value.lanes.find(l => l.lane === 'be').applied, 'no-apply');
  assert.equal(r2.value.lanes.find(l => l.lane === 'fe').applied, 'empty');
  assert.equal(txt(join(d2, 'backend/App.java')), 'class App {}\n');

  // (c) 충돌 — 메인 작업트리가 같은 파일을 다르게 고쳐 둔 상태. 메인의 수정을 조용히 덮어쓰면 안 된다
  const d3 = makeRepo();
  const c = inside(d3, { FAKE_HERDR_STATES: 'working,done' });
  const be3 = plantSplit(d3, 'be');
  writeFileSync(join(be3, 'backend/App.java'), 'class App { int lane; }\n');
  writeFileSync(join(d3, 'backend/App.java'), 'class App { int main; }\n');
  sidecar(d3, 'be', ok('be', ['backend/App.java']));
  const r3 = lanes(d3, ['implement', '--slug', SLUG, '--lanes', 'be'], c.env);
  assert.deepEqual(r3.value.skipped, ['fe']);
  assert.ok(r3.value.dirty_base.includes('backend/App.java'), '커밋 안 된 메인 수정은 dirty_base 로 보인다');
  const be3r = r3.value.lanes[0];
  assert.equal(be3r.applied, 'conflict', JSON.stringify(be3r).slice(0, 600));
  assert.ok(be3r.apply_error);
  assert.equal(r3.value.conflicts, 1);
  assert.match(r3.value.next, /충돌/);
  const mainNow = txt(join(d3, 'backend/App.java'));
  assert.ok(mainNow === 'class App { int main; }\n' || /<<<<<<<|>>>>>>>/.test(mainNow), `메인 수정이 조용히 덮이지 않는다: ${mainNow}`);
  assert.ok(calls(c.log).some(x => x[0] === 'notification' && /충돌 1/.test(x[2])));
});

test('implement(workspace 배치): herdr worktree create 로 워크스페이스를 열고 · 열려 있으면 open 재사용(already-open) · 장부 applied 면 remove --force 뒤 create', () => {
  const dir = makeRepo({ lane_placement: 'workspace' });
  const first = inside(dir, { FAKE_HERDR_STATES: 'working,done' });
  const be = plantFake(dir, first.wtDir, 'be');
  writeFileSync(join(be, 'backend/App.java'), 'class App { int z; }\n');
  sidecar(dir, 'be', ok('be', ['backend/App.java']));
  const r1 = lanes(dir, ['implement', '--slug', SLUG, '--lanes', 'be'], first.env);
  assert.equal(r1.status, 0, r1.stderr);
  const l1 = r1.value.lanes[0];
  assert.equal(l1.applied, 'yes', JSON.stringify(l1).slice(0, 500));
  assert.equal(l1.worktree.mode, 'created'); assert.equal(l1.worktree.placement, 'workspace'); assert.equal(l1.pane, 'w2:p1');
  assert.equal(txt(join(dir, 'backend/App.java')), 'class App { int z; }\n');
  const c1 = calls(first.log);
  const create = c1.find(a => a[0] === 'worktree' && a[1] === 'create');
  assert.ok(create && create.includes('--branch') && create.includes(`lane/${SLUG}/be`) && create.includes('--no-focus'));
  assert.ok(!c1.some(a => a[0] === 'pane' && a[1] === 'split'), 'workspace 배치는 split 하지 않는다');
  assert.match(r1.value.next, /herdr worktree remove/);
  // 장부 applied → fresh: 열려 있는 worktree 를 remove --force 하고 다시 create
  const second = inside(dir, { FAKE_HERDR_STATES: 'working,done', FAKE_HERDR_WORKTREE_DIR: first.wtDir, FAKE_HERDR_WORKTREES: JSON.stringify([{ branch: `lane/${SLUG}/be`, path: fwd(be), open_workspace_id: 'w7' }]) });
  const r2 = lanes(dir, ['implement', '--slug', SLUG, '--lanes', 'be'], second.env);
  const c2 = calls(second.log);
  const rm = c2.find(x => x[0] === 'worktree' && x[1] === 'remove');
  assert.ok(rm && rm.includes('w7') && rm.includes('--force'), `remove 호출: ${JSON.stringify(c2.map(x => x.slice(0, 2)))}`);
  assert.ok(c2.findIndex(x => x[1] === 'remove') < c2.findIndex(x => x[1] === 'create'), 'remove 뒤 create');
  assert.ok(!c2.some(x => x[0] === 'worktree' && x[1] === 'open'));
  assert.equal(r2.value.lanes[0].worktree.mode, 'created');
  // 장부에 applied 가 없고 열려 있으면 open 으로 그 pane 을 재사용
  const d5 = makeRepo({ lane_placement: 'workspace' });
  const e = inside(d5, { FAKE_HERDR_STATES: 'working,done' });
  const be5 = plantFake(d5, e.wtDir, 'be');
  sidecar(d5, 'be', ok('be', []));
  const r6 = lanes(d5, ['implement', '--slug', SLUG, '--lanes', 'be'], { ...e.env, FAKE_HERDR_WORKTREES: JSON.stringify([{ branch: `lane/${SLUG}/be`, path: fwd(be5), open_workspace_id: 'w8', pane_id: 'w8:p1' }]) });
  assert.equal(r6.value.lanes[0].worktree.mode, 'already-open');
  assert.equal(r6.value.lanes[0].pane, 'w8:p1');
  assert.equal(r6.value.lanes[0].applied, 'empty');
  const c6 = calls(e.log);
  assert.ok(c6.some(x => x[0] === 'worktree' && x[1] === 'open'));
  assert.ok(!c6.some(x => x[0] === 'worktree' && x[1] === 'create'));
});

test('implement(작업트리 세션): 이슈를 별도 작업트리에서 돌려도 상태·결과·장부·패치·레인 작업트리는 메인 저장소 runtime 에 놓이고, 패치는 지금 일하는 작업트리에 들어간다(메인 체크아웃은 그대로)', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', 'main');
  const wt = join(mkdtempSync(join(tmpdir(), 'cw-impl-iss-')), 'ABC-5');
  g(dir, 'worktree', 'add', '-q', wt, 'feat/ABC-5');
  const { env, log } = inside(dir, { FAKE_HERDR_STATES: 'working,done' });
  sidecar(dir, 'be', ok('be', ['backend/Fee.java']));
  // (1) 실행기가 레인 작업트리를 판다 — 메인 runtime 아래, 이슈 작업트리의 HEAD 에서
  const r1 = lanes(wt, ['implement', '--slug', SLUG, '--lanes', 'be'], env);
  assert.equal(r1.status, 0, r1.stderr);
  const l1 = r1.value.lanes[0];
  assert.equal(l1.status, 'done', JSON.stringify(l1).slice(0, 600));
  assert.equal(l1.worktree.mode, 'created');
  assert.equal(fwd(l1.worktree.path).toLowerCase(), fwd(splitPath(dir, 'be')).toLowerCase(), '레인 작업트리는 메인 저장소 runtime 아래');
  assert.equal(fwd(l1.out).toLowerCase(), fwd(join(dir, '.claude/runtime/issues', `${SLUG}.lane-be.json`)).toLowerCase(), '결과 파일도 메인 runtime');
  assert.ok(!existsSync(join(wt, '.claude/runtime')), '이슈 작업트리에는 runtime 이 생기지 않는다');
  assert.ok(existsSync(join(dir, '.claude/runtime/herdr', `implement-${SLUG}.json`)), '장부는 메인 runtime');
  const split = calls(log).find(a => a[0] === 'pane' && a[1] === 'split');
  assert.equal(fwd(split[split.indexOf('--cwd') + 1]).toLowerCase(), fwd(splitPath(dir, 'be')).toLowerCase(), '레인 pane 의 cwd 는 그 레인 작업트리');
  // (2) 레인이 고친 것을 다시 돌려 회수 — 패치는 이슈 작업트리에 들어가고 메인 체크아웃(main 브랜치)은 그대로
  //     (1)의 장부가 empty 라 다음 실행은 작업트리를 새로 판다 → 레인이 고친 상태를 만들려면 장부를 지우고 기존 작업트리를 쓴다
  rmSync(join(dir, '.claude/runtime/herdr', `implement-${SLUG}.json`));
  writeFileSync(join(l1.worktree.path, 'backend/Fee.java'), 'class Fee {}\n');
  const second = inside(dir, { FAKE_HERDR_STATES: 'working,done' });
  const r2 = lanes(wt, ['implement', '--slug', SLUG, '--lanes', 'be'], second.env);
  const l2 = r2.value.lanes[0];
  assert.equal(l2.applied, 'yes', JSON.stringify(l2).slice(0, 600));
  assert.equal(txt(join(wt, 'backend/Fee.java')), 'class Fee {}\n', '패치는 일하는 작업트리에');
  assert.ok(!existsSync(join(dir, 'backend/Fee.java')), '메인 체크아웃은 건드리지 않는다');
  assert.match(fwd(l2.patch.file).toLowerCase(), new RegExp(`${fwd(dir).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.claude/runtime/herdr/patches/`), '패치 파일도 메인 runtime');
  assert.equal(state(dir).lanes.find(l => l.name === 'be').result.applied, 'yes', '상태 JSON 은 메인 runtime 의 그 이슈 것');
  assert.ok(!existsSync(join(wt, '.claude/runtime')));
});

test('implement --harvest: 레인을 띄우지 않고 이미 온 결과만 회수한다(Herdr 밖에서도) — 결과가 없는 레인의 작업트리는 건드리지 않고 · 이미 들어간 레인은 다시 넣지 않는다', () => {
  const dir = makeRepo();
  const be = plantSplit(dir, 'be'); const fe = plantSplit(dir, 'fe');
  writeFileSync(join(be, 'backend/Fee.java'), 'class Fee {}\n');
  writeFileSync(join(fe, 'frontend/app.js'), 'export default 3;\n');
  g(fe, 'add', '-A'); // 레인이 인덱스에 올려 둔 상태 — 회수가 손대면 풀린다
  const outOf = lane => join(dir, '.claude/runtime/issues', `${SLUG}.lane-${lane}.json`);
  mkdirSync(dirname(outOf('be')), { recursive: true });
  writeFileSync(outOf('be'), JSON.stringify(ok('be', ['backend/Fee.java']))); // 실행기가 닫은 뒤에 온 결과
  const log = join(dir, 'h.harvest.log');
  const env = { ...OUTSIDE, FAKE_HERDR_LOG: log };
  // (1) be 는 결과가 있다 → 회수·적용. fe 는 아직 없다 → 보고만(작업트리·장부·상태에 손대지 않는다)
  const r1 = lanes(dir, ['implement', '--slug', SLUG, '--harvest'], env);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.value.ok, true, JSON.stringify(r1.value).slice(0, 800));
  const be1 = r1.value.lanes.find(l => l.lane === 'be'); const fe1 = r1.value.lanes.find(l => l.lane === 'fe');
  assert.equal(be1.applied, 'yes'); assert.equal(be1.worktree.mode, 'harvest'); assert.equal(be1.sidecar.status, 'done');
  assert.equal(txt(join(dir, 'backend/Fee.java')), 'class Fee {}\n');
  assert.equal(fe1.status, 'failed'); assert.match(fe1.reason, /결과 파일 없음.*끝난 뒤 다시 회수/); assert.equal(fe1.patch, null); assert.equal(fe1.applied, 'skipped');
  assert.equal(g(fe, 'diff', '--cached', '--name-only'), 'frontend/app.js', '결과 없는 레인의 인덱스는 그대로');
  assert.equal(txt(join(dir, 'frontend/app.js')), 'export default 1;\n');
  const ledger1 = JSON.parse(readFileSync(join(dir, '.claude/runtime/herdr', `implement-${SLUG}.json`), 'utf8'));
  assert.equal(ledger1.lanes.be.applied, 'yes'); assert.equal(ledger1.lanes.fe, undefined);
  assert.equal(state(dir).lanes.find(l => l.name === 'be').result.applied, 'yes');
  assert.equal(state(dir).lanes.find(l => l.name === 'fe').result, undefined, '아직 도는 레인의 상태 기록을 덮지 않는다');
  assert.equal(calls(log).length, 0, 'Herdr 를 부르지 않는다');
  // (2) fe 결과가 왔다 → fe 만 회수 · be 는 다시 넣지 않는다
  writeFileSync(outOf('fe'), JSON.stringify(ok('fe', ['frontend/app.js'])));
  const r2 = lanes(dir, ['implement', '--slug', SLUG, '--harvest'], env);
  assert.deepEqual(r2.value.lanes.map(l => [l.lane, l.applied]), [['fe', 'yes']]);
  assert.deepEqual(r2.value.skipped, ['be(이미 적용)']);
  assert.equal(txt(join(dir, 'frontend/app.js')), 'export default 3;\n');
  // (3) 전부 들어갔다 → 회수할 것이 없다
  const r3 = lanes(dir, ['implement', '--slug', SLUG, '--harvest'], env);
  assert.equal(r3.value.ok, false);
  assert.match(r3.value.reason, /회수할 레인이 없다/);
  assert.equal(g(dir, 'rev-list', '--count', 'HEAD'), '1', '커밋은 아무도 하지 않는다');
});
