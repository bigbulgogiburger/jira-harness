// Herdr 연동 실측 — herdr CLI 대역(fixtures/fake-herdr.mjs)으로 호출 인자를 검사한다.
//   herdr-report(사이드바 토큰·알림) · gate/issue-set/commit-gate 의 자동 보고 · Herdr 플러그인 진입점(herdr-plugin.mjs) · 매니페스트 정합
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newState, writeState, statePath, loadConfig } from '../lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const ROOT = join(SCRIPTS, '..');
const NODE = process.execPath;
const FAKE = `node:${join(HERE, 'fixtures/fake-herdr.mjs')}`;

function sh(cmd, args, cwd, input, env = {}) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', input, windowsHide: true, env: { ...process.env, ...env } }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function node(script, args, cwd, env = {}, input) { return sh(NODE, [join(SCRIPTS, script), ...args], cwd, input, env); }

/** Herdr 밖처럼 보이게: 이 테스트 프로세스가 Herdr pane 안에서 돌아도 환경을 지운다 */
const OUTSIDE = { HERDR_PANE_ID: '', HERDR_WORKSPACE_ID: '', HERDR_ENV: '', HERDR_SOCKET_PATH: '', JIRA_HARNESS_HERDR: FAKE };
function inside(log, extra = {}) { return { ...OUTSIDE, HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1', HERDR_ENV: '1', FAKE_HERDR_LOG: log, ...extra }; }
function calls(log) { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }
function tokensOf(call) { const t = {}; for (let i = 0; i < call.length; i++) if (call[i] === '--token') { const [k, v] = call[i + 1].split(/=(.*)/s); t[k] = v; } return t; }

function makeRepo(cfgPatch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-herdr-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  for (const d of ['backend', 'frontend', '.claude', 'docs']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'backend/App.java'), 'class App {}\n');
  writeFileSync(join(dir, 'frontend/app.js'), 'export default 1\n');
  const cfg = { ...JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8')), ...cfgPatch };
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function withIssue(dir, branch = 'feat/ABC-7', stage = 'implement') {
  g(dir, 'checkout', '-q', '-b', branch);
  const cfg = loadConfig(join(dir, '.claude/harness.json'));
  const st = newState(branch, ['ABC-7']); st.stage = stage;
  writeState(statePath(cfg, dir, branch.replace('/', '-')), st);
  return cfg;
}

// ---------------------------------------------------------------- herdr-report

test('herdr-report: Herdr 밖이면 아무 호출도 없이 exit 0 · 하네스 밖도 무동작', () => {
  const dir = makeRepo();
  const log = join(dir, 'h.log');
  const r = node('herdr-report.mjs', ['--cwd', dir], dir, { ...OUTSIDE, FAKE_HERDR_LOG: log });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /outside herdr/);
  assert.equal(calls(log).length, 0);
  const plain = mkdtempSync(join(tmpdir(), 'cw-noh-'));
  g(plain, 'init', '-q');
  const p = node('herdr-report.mjs', ['--cwd', plain, '--json'], plain, inside(log));
  assert.equal(p.status, 0);
  assert.equal(JSON.parse(p.stdout).reason, 'no harness');
  assert.equal(calls(log).length, 0);
});

test('herdr-report: 이슈 브랜치에서 pane·workspace 메타데이터 토큰(case/stage/gate/review/loop)과 상태 라벨을 보고하고 --notify 는 토스트를 띄운다', () => {
  const dir = makeRepo();
  withIssue(dir);
  const log = join(dir, 'h.log');
  const r = node('herdr-report.mjs', ['--cwd', dir, '--event', 'stage implement', '--notify', 'ABC-7 계획 승인 대기', '--sound', 'request', '--json'], dir, inside(log));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.pane, 'w1:p1');
  const c = calls(log);
  const pane = c.find(a => a[0] === 'pane' && a[1] === 'report-metadata');
  assert.ok(pane, JSON.stringify(c));
  assert.equal(pane[2], 'w1:p1');
  assert.deepEqual(pane.slice(3, 5), ['--source', 'jira-harness']);
  const t = tokensOf(pane);
  assert.equal(t.case, 'ABC-7');
  assert.equal(t.stage, 'implement');
  assert.equal(t.gate, '-');
  assert.equal(t.review, '-');
  assert.equal(t.loop, '-');
  assert.equal(t.event, 'stage implement');
  assert.ok(pane.includes('--state-label') && pane.some(a => /^working=ABC-7 · implement$/.test(a)), '상태 라벨');
  assert.ok(pane.includes('--title'));
  const ws = c.find(a => a[0] === 'workspace' && a[1] === 'report-metadata');
  assert.equal(ws[2], 'w1');
  assert.equal(tokensOf(ws).case, 'ABC-7');
  const n = c.find(a => a[0] === 'notification');
  assert.deepEqual(n.slice(0, 3), ['notification', 'show', 'ABC-7 계획 승인 대기']);
  assert.ok(n.includes('--sound') && n.includes('request'));
});

test('herdr-report: herdr.enabled=false 면 건너뛰고, herdr.notify=false 면 토큰은 올리되 토스트만 뺀다 · herdr 실패는 exit 0', () => {
  const off = makeRepo({ herdr: { enabled: false } });
  withIssue(off);
  const log1 = join(off, 'h.log');
  const r1 = node('herdr-report.mjs', ['--cwd', off, '--json'], off, inside(log1));
  assert.equal(JSON.parse(r1.stdout).reason, 'herdr.enabled=false');
  assert.equal(calls(log1).length, 0);
  const quiet = makeRepo({ herdr: { notify: false } });
  withIssue(quiet);
  const log2 = join(quiet, 'h.log');
  node('herdr-report.mjs', ['--cwd', quiet, '--notify', 'x'], quiet, inside(log2));
  const c = calls(log2);
  assert.ok(c.some(a => a[1] === 'report-metadata'));
  assert.ok(!c.some(a => a[0] === 'notification'), '알림 없음');
  const r3 = node('herdr-report.mjs', ['--cwd', quiet, '--json'], quiet, inside(log2, { FAKE_HERDR_FAIL: '1' }));
  assert.equal(r3.status, 0);
  assert.equal(JSON.parse(r3.stdout).results.pane.ok, false);
});

test('herdr-report --status: Herdr 호출 없이 토큰만 계산한다(다중 키는 +n)', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1-2-3');
  const cfg = loadConfig(join(dir, '.claude/harness.json'));
  writeState(statePath(cfg, dir, 'feat-ABC-1-2-3'), newState('feat/ABC-1-2-3', ['ABC-1', 'ABC-2', 'ABC-3']));
  const log = join(dir, 'h.log');
  const r = node('herdr-report.mjs', ['--status', '--cwd', dir, '--json'], dir, inside(log));
  const out = JSON.parse(r.stdout);
  assert.equal(out.tokens.case, 'ABC-1+2');
  assert.equal(out.tokens.stage, 'start');
  assert.equal(calls(log).length, 0);
});

// ---------------------------------------------------------------- 스크립트가 스스로 보고한다

test('gate.mjs: Herdr 안에서 돌면 gate 토큰을 갱신하고, FAIL 이면 request 토스트 · commit PASS 는 토스트 없음', () => {
  const dir = makeRepo();
  withIssue(dir);
  writeFileSync(join(dir, 'backend/App.java'), 'class App { int x; }\n');
  g(dir, 'add', '-A');
  const log = join(dir, 'h.log');
  const ok = node('gate.mjs', ['--commit', '--cwd', dir, '--json'], dir, inside(log));
  assert.equal(ok.status, 0, ok.stderr);
  let c = calls(log);
  const pane = c.filter(a => a[1] === 'report-metadata' && a[0] === 'pane').pop();
  assert.equal(tokensOf(pane).gate, 'commit PASS');
  assert.equal(tokensOf(pane).event, 'gate commit PASS');
  assert.ok(!c.some(a => a[0] === 'notification'), 'commit PASS 는 조용하다');
  // FAIL — compile 을 실패시킨다
  const cfgPath = join(dir, '.claude/harness.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.stacks.be.compile = 'exit 1';
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A');
  const bad = node('gate.mjs', ['--commit', '--cwd', dir, '--json'], dir, inside(log));
  assert.equal(bad.status, 1);
  c = calls(log);
  const n = c.filter(a => a[0] === 'notification').pop();
  assert.ok(n, '토스트');
  assert.match(n[2], /ABC-7 gate commit FAIL/);
  assert.ok(n.includes('request'));
  assert.equal(tokensOf(c.filter(a => a[1] === 'report-metadata' && a[0] === 'pane').pop()).gate, 'commit FAIL');
});

test('issue-set --stage · issue-start · commit-gate deny 도 Herdr 에 보고한다 (Herdr 밖이면 호출 0)', () => {
  const dir = makeRepo();
  const log = join(dir, 'h.log');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-9');
  // 훅 deny: 상태 없음 → NO_STATE → 토스트
  const hook = node('commit-gate.mjs', [], dir, inside(log), JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: dir }));
  assert.match(hook.stdout, /"permissionDecision":"deny"/);
  let c = calls(log);
  assert.ok(c.some(a => a[0] === 'notification' && /git commit 거부 — NO_STATE/.test(a[2])), JSON.stringify(c));
  // start → 토큰 stage=start
  const st = node('issue-start.mjs', ['ABC-9', '--cwd', dir, '--json'], dir, inside(log));
  assert.equal(st.status, 0, st.stderr);
  c = calls(log);
  assert.equal(tokensOf(c.filter(a => a[1] === 'report-metadata' && a[0] === 'pane').pop()).stage, 'start');
  // stage 전이
  const set = node('issue-set.mjs', ['--stage', 'plan', '--cwd', dir, '--json'], dir, inside(log));
  assert.equal(set.status, 0, set.stderr);
  c = calls(log);
  const last = tokensOf(c.filter(a => a[1] === 'report-metadata' && a[0] === 'pane').pop());
  assert.equal(last.stage, 'plan');
  assert.equal(last.event, 'stage plan');
  // Herdr 밖: 호출 없음
  const before = c.length;
  node('issue-set.mjs', ['--stage', 'implement', '--cwd', dir, '--json'], dir, { ...OUTSIDE, FAKE_HERDR_LOG: log });
  assert.equal(calls(log).length, before);
});

// ---------------------------------------------------------------- Herdr 플러그인 진입점

test('herdr-plugin on-worktree-created: 문맥 JSON 의 브랜치가 패턴 안이면 상태 JSON 을 만들고 토스트 · 패턴 밖이면 채택하지 않는다', () => {
  const dir = makeRepo();
  const log = join(dir, 'h.log');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-11');
  const ctx = JSON.stringify({ event: 'worktree.created', worktree: { path: dir, branch: 'feat/ABC-11' }, workspace: { id: 'w2' } });
  const r = node('herdr-plugin.mjs', ['on-worktree-created', '--json'], tmpdir(), inside(log, { HERDR_PLUGIN_CONTEXT_JSON: ctx }));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.keys, ['ABC-11']);
  assert.ok(existsSync(join(dir, '.claude/runtime/issues/feat-ABC-11.json')), '상태 JSON');
  const c = calls(log);
  assert.ok(c.some(a => a[0] === 'notification' && /ABC-11/.test(a[2])));
  assert.ok(c.some(a => a[1] === 'report-metadata'));
  // 패턴 밖
  g(dir, 'checkout', '-q', '-b', 'spike/x');
  const r2 = node('herdr-plugin.mjs', ['on-worktree-created', '--json'], tmpdir(), inside(log, { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ worktree: { path: dir, branch: 'spike/x' } }) }));
  assert.equal(JSON.parse(r2.stdout.trim().split('\n').pop()).reason, 'branch outside pattern');
  // 하네스 없는 디렉터리
  const plain = mkdtempSync(join(tmpdir(), 'cw-nop-'));
  const r3 = node('herdr-plugin.mjs', ['report', '--cwd', plain, '--json'], plain, inside(log));
  assert.equal(r3.status, 0);
  assert.equal(JSON.parse(r3.stdout).ok, false);
});

test('herdr-plugin.toml: 필수 키·모든 command 가 실재하는 스크립트·서브커맨드를 가리킨다', () => {
  const toml = readFileSync(join(ROOT, 'herdr-plugin.toml'), 'utf8');
  for (const k of ['id', 'name', 'version', 'min_herdr_version']) assert.match(toml, new RegExp(`^${k}\\s*=`, 'm'), k);
  const entry = readFileSync(join(SCRIPTS, 'herdr-plugin.mjs'), 'utf8');
  const cmds = [...toml.matchAll(/command\s*=\s*\[([^\]]+)\]/g)].map(m => m[1].split(',').map(s => s.trim().replace(/^"|"$/g, '')));
  assert.ok(cmds.length >= 5, `command ${cmds.length}개`);
  for (const argv of cmds) {
    assert.equal(argv[0], 'node');
    assert.ok(existsSync(join(ROOT, argv[1])), `${argv[1]} 실재`);
    assert.ok(entry.includes(`case '${argv[2]}'`), `서브커맨드 ${argv[2]} 구현`);
  }
  assert.ok(/^\[\[events\]\]\s*\non\s*=\s*"worktree\.created"/m.test(toml), 'worktree.created 이벤트(필드명은 on — 0.9.0 실측)');
  assert.match(toml, /^platforms\s*=/m, 'platforms 선언(없으면 Herdr 가 경고)');
  const pv = /^version\s*=\s*"([^"]+)"/m.exec(toml)[1];
  const cv = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).version;
  assert.equal(pv, cv, 'Herdr 매니페스트와 Claude 플러그인 버전 일치');
});
