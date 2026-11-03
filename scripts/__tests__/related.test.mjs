// 관련 테스트 게이트(--related) · 경량+DoD 게이트(--dod) · push_level · 기본 브랜치 배치(--main)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newState, writeState, readState } from '../lib/config.mjs';
import { selectRelated, relatedCommand } from '../lib/related-tests.mjs';
import { pushLevels, pushGateCommand, REQUIRED_KEYS } from '../lib/gate-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;
const sh = (cmd, args, cwd, input) => spawnSync(cmd, args, { cwd, encoding: 'utf8', input, windowsHide: true });
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function put(dir, rel, text) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }

// ---------- 선택 규칙 ----------
function gradleTree() {
  const d = mkdtempSync(join(tmpdir(), 'jh-rel-'));
  put(d, 'src/main/java/a/Foo.java', 'package a; public class Foo {}\n');
  put(d, 'src/main/java/a/FooBar.java', 'package a; public class FooBar {}\n');
  put(d, 'src/test/java/a/FooTest.java', 'package a; class FooTest { Foo f; }\n');
  put(d, 'src/test/java/a/FooBarTest.java', 'package a; class FooBarTest { FooBar f; }\n');
  put(d, 'src/test/java/b/OtherTest.java', 'package b; class OtherTest {}\n');
  put(d, 'src/test/java/b/Fixtures.java', 'package b; class Fixtures { a.Foo f; }\n');
  return d;
}

test('gradle — 바뀐 클래스를 단어 단위로 쓰는 테스트만 고른다(FooBar 는 Foo 에 안 걸린다) · 헬퍼(이름이 Test 아님)는 고르지 않는다', () => {
  const d = gradleTree();
  const r = selectRelated({ adapter: 'gradle-junit', stackDir: d, files: ['src/main/java/a/Foo.java'] });
  assert.equal(r.mode, 'selected', r.reason);
  assert.deepEqual(r.select, ['a.FooTest']);
});

test('gradle — 바뀐 테스트 파일은 그 자체가 선택된다 · 바뀐 헬퍼는 그 헬퍼를 쓰는 테스트로 넘어간다', () => {
  const d = gradleTree();
  put(d, 'src/test/java/b/UsesFixturesTest.java', 'package b; class UsesFixturesTest { Fixtures x; }\n');
  const r = selectRelated({ adapter: 'gradle-junit', stackDir: d, files: ['src/test/java/b/OtherTest.java', 'src/test/java/b/Fixtures.java'] });
  assert.deepEqual(r.select, ['b.OtherTest', 'b.UsesFixturesTest']);
});

test('gradle — 전역 파일(build.gradle · resources)이 바뀌면 그 스택은 전체 테스트', () => {
  const d = gradleTree();
  for (const f of ['build.gradle', 'src/main/resources/application.yml', 'src/main/resources/db/migration/V2__x.sql']) {
    const r = selectRelated({ adapter: 'gradle-junit', stackDir: d, files: ['src/main/java/a/Foo.java', f] });
    assert.equal(r.mode, 'full', f);
  }
});

test('gradle — 고를 것이 없으면 none(검사 0 을 드러낸다) · 상한을 넘으면 full', () => {
  const d = gradleTree();
  put(d, 'src/main/java/a/Lonely.java', 'package a; class Lonely {}\n');
  assert.equal(selectRelated({ adapter: 'gradle-junit', stackDir: d, files: ['src/main/java/a/Lonely.java'] }).mode, 'none');
  assert.equal(selectRelated({ adapter: 'gradle-junit', stackDir: d, files: ['README.txt'] }).mode, 'none');
  const many = selectRelated({ adapter: 'gradle-junit', stackDir: d, files: ['src/main/java/a/Foo.java', 'src/main/java/a/FooBar.java'], related: { max_selected: 1 } });
  assert.equal(many.mode, 'full', many.reason);
});

test('vitest — vitest related --run 으로 바꾸고 바뀐(존재하는) 파일을 넘긴다 · package.json 은 전체', () => {
  const d = mkdtempSync(join(tmpdir(), 'jh-relv-'));
  put(d, 'src/a.js', 'export default 1\n');
  const r = selectRelated({ adapter: 'vitest', stackDir: d, files: ['src/a.js', 'src/deleted.js'] });
  assert.deepEqual(r.select, ['src/a.js']);
  assert.equal(relatedCommand({ adapter: 'vitest', run: 'npx vitest run', select: r.select }), "npx vitest related --run --passWithNoTests 'src/a.js'");
  assert.equal(selectRelated({ adapter: 'vitest', stackDir: d, files: ['package.json', 'src/a.js'] }).mode, 'full');
  assert.throws(() => relatedCommand({ adapter: 'vitest', run: 'npm test', select: ['x'] }), /related\.command/);
  assert.equal(relatedCommand({ adapter: 'vitest', run: 'npm test', select: ['x'], related: { command: 'npm test -- related {files}' } }), "npm test -- related 'x'");
  assert.equal(relatedCommand({ adapter: 'gradle-junit', run: './gradlew test', select: ['a.FooTest'] }), "./gradlew test --tests 'a.FooTest'");
});

// ---------- 게이트·훅 통합 ----------
function makeRepo(pushLevel) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-relg-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@e.com'); g(dir, 'config', 'user.name', 't'); g(dir, 'config', 'core.autocrlf', 'false');
  put(dir, 'docs/README.md', '# d\n'); put(dir, 'backend/App.java', 'class App {}\n'); put(dir, 'frontend/app.js', 'export default 1\n');
  const cfg = JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8'));
  if (pushLevel) cfg.gate = { push_level: pushLevel };
  put(dir, '.claude/harness.json', JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const gate = (dir, ...a) => sh(NODE, [join(SCRIPTS, 'gate.mjs'), ...a, '--cwd', dir], dir);
const stateFile = dir => join(dir, '.claude/runtime/issues/feat-ABC-1.json');
function hook(dir, command) {
  const r = sh(NODE, [join(SCRIPTS, 'commit-gate.mjs')], dir, JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir }));
  const out = r.stdout.trim();
  if (!out) return { decision: 'pass', reason: r.stderr.trim() };
  const j = JSON.parse(out);
  return j.hookSpecificOutput?.permissionDecision === 'deny' ? { decision: 'deny', reason: j.hookSpecificOutput.permissionDecisionReason } : { decision: 'pass', reason: JSON.stringify(j) };
}
function review(dir) {
  const st = readState(stateFile(dir));
  st.review = { tree: st.gate.tree, files: [], codex: 'skipped', lanes: 1, findings: 0, blockers_open: 0, round: 1, delta_passes: 0, at: new Date().toISOString() };
  writeState(stateFile(dir), st);
}
function branchWithChange(pushLevel) {
  const dir = makeRepo(pushLevel);
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  writeState(stateFile(dir), newState('feat/ABC-1', ['ABC-1']));
  put(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'c1');
  return dir;
}

test('push_level=related — 관련 테스트 게이트로 push 통과 · 바뀐 스택(be)만 돈다 · build·extra 는 NOT_RUN 인데도 통과', () => {
  const dir = branchWithChange('related');
  const r = gate(dir, '--related', '--json');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const st = readState(stateFile(dir));
  assert.equal(st.gate.level, 'related');
  assert.deepEqual(Object.keys(st.gate.stacks), ['be'], '이 브랜치는 backend 만 바꿨다');
  assert.equal(st.gate.results.test, 'PASS');
  assert.equal(st.gate.results.build, 'NOT_RUN');
  assert.equal(st.gate.related.be.mode, 'full', 'dod_tests 어댑터가 없으면 그 스택 전체 테스트로 돈다');
  review(dir);
  const p = hook(dir, 'git push -u origin feat/ABC-1');
  assert.equal(p.decision, 'pass', p.reason);
});

test('push_level=full(기본) — 관련 테스트 기록으로는 push 가 GATE_LEVEL 로 막힌다', () => {
  const dir = branchWithChange(null);
  assert.equal(gate(dir, '--related').status, 0);
  review(dir);
  const p = hook(dir, 'git push -u origin feat/ABC-1');
  assert.equal(p.decision, 'deny'); assert.ok(p.reason.includes('GATE_LEVEL') && p.reason.includes('gate.mjs --full'), p.reason);
});

test('push_level=related — 관련 테스트가 실패하면 GATE_FAIL · 경량 기록뿐이면 GATE_LEVEL 사유가 --related 를 안내한다', () => {
  const dir = branchWithChange('related');
  assert.equal(gate(dir, '--commit').status, 0);
  review(dir);
  const lvl = hook(dir, 'git push');
  assert.equal(lvl.decision, 'deny'); assert.ok(lvl.reason.includes('GATE_LEVEL') && lvl.reason.includes('--related'), lvl.reason);
  const cfgPath = join(dir, '.claude/harness.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); cfg.stacks.be.test = 'exit 3';
  writeFileSync(cfgPath, JSON.stringify(cfg)); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'break');
  assert.equal(gate(dir, '--related').status, 1);
  review(dir);
  const bad = hook(dir, 'git push');
  assert.equal(bad.decision, 'deny'); assert.ok(bad.reason.includes('GATE_STALE') || bad.reason.includes('GATE_FAIL'), bad.reason);
});

test('--related --stacks 로 바뀐 스택을 뺄 수 없다', () => {
  const dir = branchWithChange('related');
  const r = gate(dir, '--related', '--stacks', 'fe');
  assert.equal(r.status, 2); assert.match(r.stderr, /바뀐 스택을 뺐다: be/);
});

test('--main — 기본 브랜치에서만 · 전 스택 전 단계 · main-gate.json 에 직전 PASS 이후 커밋을 남긴다 · --status', () => {
  const dir = branchWithChange('related');
  const off = gate(dir, '--main');
  assert.equal(off.status, 2); assert.match(off.stderr, /main 에서 돈다/);
  g(dir, 'checkout', '-q', 'main'); g(dir, 'merge', '-q', '--no-ff', '-m', 'merge ABC-1', 'feat/ABC-1');
  const r1 = gate(dir, '--main', '--json');
  assert.equal(r1.status, 0, r1.stderr + r1.stdout);
  const j1 = JSON.parse(r1.stdout);
  assert.equal(j1.overall, 'PASS'); assert.equal(j1.results.build, 'PASS'); assert.equal(j1.results.extra, 'PASS');
  const rec = JSON.parse(readFileSync(join(dir, '.claude/runtime/main-gate.json'), 'utf8'));
  assert.equal(rec.last_pass.head, g(dir, 'rev-parse', 'HEAD'));
  put(dir, 'frontend/app.js', 'export default 2\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'second');
  const s = JSON.parse(gate(dir, '--main', '--status', '--json').stdout);
  assert.equal(s.pending_commits, 1);
  put(dir, 'frontend/dirty.js', 'x\n');
  assert.equal(gate(dir, '--main').status, 2, '작업트리가 더러우면 거부');
  assert.ok(existsSync(join(dir, '.claude/runtime/main-gate.json')));
});

// ---------- push_level=dod: 이슈 게이트는 compile·lint·DoD 만 · 전체 검증은 --main ----------
test('pushLevels·pushGateCommand — dod 는 dod·related·full 을 받는다 · related·full(기본) 는 종전 그대로', () => {
  const c = l => (l ? { gate: { push_level: l } } : {});
  assert.deepEqual(pushLevels(c('dod')), ['dod', 'related', 'full']);
  assert.deepEqual(pushLevels(c('related')), ['related', 'full']);
  assert.deepEqual(pushLevels(c('full')), ['full']);
  assert.deepEqual(pushLevels(c(null)), ['full']);
  assert.equal(pushGateCommand(c('dod')), 'gate.mjs --dod');
  assert.equal(pushGateCommand(c('related')), 'gate.mjs --related');
  assert.equal(pushGateCommand(c(null)), 'gate.mjs --full');
  assert.deepEqual(REQUIRED_KEYS.dod, ['compile', 'lint', 'dod']);
});

test('push_level=dod — 경량 기록뿐이면 GATE_LEVEL(--dod 안내) · --dod 기록이면 push 통과 · 바뀐 스택만 compile·lint · 테스트 단계 없음 · DoD tests 0개 경고', () => {
  const dir = branchWithChange('dod');
  assert.equal(gate(dir, '--commit').status, 0);
  review(dir);
  const lvl = hook(dir, 'git push -u origin feat/ABC-1');
  assert.equal(lvl.decision, 'deny'); assert.ok(lvl.reason.includes('GATE_LEVEL') && lvl.reason.includes('gate.mjs --dod'), lvl.reason);
  const r = gate(dir, '--dod', '--json');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.level, 'dod'); assert.equal(j.overall, 'PASS');
  assert.ok(j.warnings?.some(w => w.includes('DoD tests 항목 0개')), JSON.stringify(j.warnings));
  const st = readState(stateFile(dir));
  assert.equal(st.gate.level, 'dod');
  assert.deepEqual(Object.keys(st.gate.stacks), ['be'], '이 브랜치는 backend 만 바꿨다');
  assert.deepEqual(Object.keys(st.gate.stacks.be), ['compile', 'lint']);
  assert.equal(st.gate.results.test, 'NOT_RUN'); assert.equal(st.gate.results.build, 'NOT_RUN');
  assert.equal(st.gate.results.dod, 'SKIPPED');
  review(dir);
  const p = hook(dir, 'git push -u origin feat/ABC-1');
  assert.equal(p.decision, 'pass', p.reason);
  const text = gate(dir, '--dod');
  assert.match(text.stdout, /gate\.mjs --main 1회 필수/); assert.match(text.stdout, /⚠ DoD tests 항목 0개/);
});

test('push_level=dod — related·full 기록도 push 를 통과한다(더 강한 단계)', () => {
  for (const lvl of ['--related', '--full']) {
    const dir = branchWithChange('dod');
    const r = gate(dir, lvl);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    review(dir);
    const p = hook(dir, 'git push');
    assert.equal(p.decision, 'pass', `${lvl}: ${p.reason}`);
  }
});

test('push_level=related·full — dod 기록으로는 push 가 GATE_LEVEL 로 막힌다(종전 동작 불변)', () => {
  for (const [pl, need] of [['related', 'gate.mjs --related'], [null, 'gate.mjs --full']]) {
    const dir = branchWithChange(pl);
    assert.equal(gate(dir, '--dod').status, 0);
    review(dir);
    const p = hook(dir, 'git push');
    assert.equal(p.decision, 'deny'); assert.ok(p.reason.includes('GATE_LEVEL') && p.reason.includes(need), p.reason);
  }
});

test('push_level=dod — DoD 항목이 돌고 FAIL 이면 GATE_FAIL · tests 항목이 있으면 경고 없음 · --stacks 로 바뀐 스택을 뺄 수 없다', () => {
  const dir = branchWithChange('dod');
  const st0 = readState(stateFile(dir));
  st0.dod = [{ id: 'D1', text: 'be 테스트', probe: 'echo ok', tests: { stack: 'be', select: ['a.FooTest'] }, last: 'PENDING' }];
  writeState(stateFile(dir), st0);
  const r = gate(dir, '--dod', '--json');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.results.dod, 'PASS'); assert.equal(j.warnings, undefined);
  const st1 = readState(stateFile(dir));
  st1.dod[0].probe = 'exit 4';
  writeState(stateFile(dir), st1);
  assert.equal(gate(dir, '--dod').status, 1);
  review(dir);
  const bad = hook(dir, 'git push');
  assert.equal(bad.decision, 'deny'); assert.ok(bad.reason.includes('GATE_FAIL'), bad.reason);
  const s = gate(dir, '--dod', '--stacks', 'fe');
  assert.equal(s.status, 2); assert.match(s.stderr, /바뀐 스택을 뺐다: be/);
});

test('push_level=dod — issue-complete 는 dod 기록을 받고 Jira 댓글에 --main 배치를 적는다 · 경량 기록뿐이면 GATE_LEVEL', () => {
  const dir = branchWithChange('dod');
  const complete = () => sh(NODE, [join(SCRIPTS, 'issue-complete.mjs'), '--dry-run', '--no-push', '--cwd', dir, '--json'], dir);
  assert.equal(gate(dir, '--commit').status, 0);
  review(dir);
  const lvl = complete();
  assert.equal(lvl.status, 1); assert.match(lvl.stderr, /GATE_LEVEL/); assert.match(lvl.stderr, /gate\.mjs --dod/);
  assert.equal(gate(dir, '--dod').status, 0);
  review(dir);
  const ok = complete();
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const j = JSON.parse(ok.stdout.trim().split('\n').pop());
  assert.equal(j.summary.gate.level, 'dod');
  assert.match(j.jira.comment, /경량\+DoD\(dod\)/); assert.match(j.jira.comment, /gate\.mjs --main/); assert.match(j.jira.comment, /테스트 검사 0/);
});
