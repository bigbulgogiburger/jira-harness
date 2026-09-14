// herdr-lanes.mjs 실측 — herdr CLI 대역으로 pane split → agent start → 프롬프트 파일 → 제출 확인(nudge) → wait → 결과 파일 회수 순서와 함정 처리를 검사한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;
const FAKE = `node:${join(HERE, 'fixtures/fake-herdr.mjs')}`;

function sh(cmd, args, cwd, env = {}) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function lanes(cwd, args, env) { const r = sh(NODE, [join(SCRIPTS, 'herdr-lanes.mjs'), ...args, '--cwd', cwd, '--json'], cwd, env); let value = null; try { value = JSON.parse(r.stdout); } catch { /* */ } return { ...r, value }; }
const OUTSIDE = { HERDR_PANE_ID: '', HERDR_WORKSPACE_ID: '', HERDR_ENV: '', HERDR_SOCKET_PATH: '', JIRA_HARNESS_HERDR: FAKE };
function inside(dir, extra = {}) {
  const log = join(dir, 'h.log'); const counter = join(dir, 'h.count');
  return { env: { ...OUTSIDE, HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1', HERDR_ENV: '1', FAKE_HERDR_LOG: log, FAKE_HERDR_STATE_FILE: counter, ...extra }, log };
}
function calls(log) { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }

function makeRepo(herdrPatch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-lanes-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  for (const d of ['backend', '.claude']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'backend/App.java'), 'class App {}\n');
  const cfg = { ...JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8')), herdr: { lanes: 'verify', kinds: { verify: ['codex', 'grok'] }, ...herdrPatch } };
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-5');
  return dir;
}
function spec(dir, laneList, extra = {}) {
  const p = join(dir, 'spec.json');
  writeFileSync(p, JSON.stringify({ lanes: laneList, ...extra }));
  return p;
}

test('run: Herdr 밖이면 모든 레인이 failed(outside herdr) · exit 0 · herdr 호출 0', () => {
  const dir = makeRepo();
  const out = join(dir, 'out.json');
  const r = lanes(dir, ['run', '--spec', spec(dir, [{ name: 'a', kind: 'codex', prompt: 'x', out }])], { ...OUTSIDE, FAKE_HERDR_LOG: join(dir, 'h.log') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.value.lanes[0].status, 'failed');
  assert.equal(r.value.lanes[0].reason, 'outside herdr');
  assert.equal(calls(join(dir, 'h.log')).length, 0);
});

test('run: 정상 경로 — split → start(kind_args 기본) → 프롬프트 파일 + 한 줄 제출 → get(working) → wait → 결과 파일 파싱 → done · pane 은 닫지 않는다', () => {
  const dir = makeRepo();
  const out = join(dir, '.claude/runtime/lanes/a.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ findings: [{ severity: 'MAJOR', file: 'backend/App.java', line: 1, claim: 'c', evidence: 'e', axis: 'x' }], summary: 's' }));
  const { env, log } = inside(dir, { FAKE_HERDR_STATES: 'working,done' });
  const r = lanes(dir, ['run', '--spec', spec(dir, [{ name: 'a', kind: 'codex', prompt: '리뷰해라', out }])], env);
  assert.equal(r.status, 0, r.stderr);
  const l = r.value.lanes[0];
  assert.equal(l.status, 'done', JSON.stringify(l));
  assert.equal(l.pane, 'w1:p9');
  assert.equal(l.result.findings.length, 1);
  assert.equal(l.nudged, false);
  const c = calls(log);
  const names = c.map(a => `${a[0]} ${a[1]}`);
  assert.deepEqual(names.slice(0, 4), ['agent list', 'pane split', 'pane rename', 'agent start']);
  // start 와 prompt 사이는 기동 다이얼로그 사다리·생존 확인(agent get / agent read)뿐 — 다이얼로그가 없으니 send-keys 는 없다
  const between = names.slice(4, names.indexOf('agent prompt'));
  assert.ok(between.length > 0 && between.every(n => n === 'agent get' || n === 'agent read'), `start→prompt 사이: ${between.join(', ')}`);
  const split = c[1];
  assert.ok(split.includes('--pane') && split.includes('w1:p1') && split.includes('--no-focus') && split.includes('--cwd'));
  const start = c[3];
  assert.deepEqual(start.slice(0, 7), ['agent', 'start', 'a', '--kind', 'codex', '--pane', 'w1:p9']);
  if (process.platform === 'win32') assert.ok(start.includes('--sandbox') && start.includes('danger-full-access'), 'Windows codex 샌드박스 해제 기본값');
  const prompt = c.find(a => a[0] === 'agent' && a[1] === 'prompt');
  assert.match(prompt[3], /^Read the file .*a\.json\.prompt\.md and do exactly/);
  const pf = readFileSync(`${out}.prompt.md`, 'utf8');
  assert.match(pf, /리뷰해라/);
  assert.match(pf, /DONE .*a\.json/);
  assert.ok(names.includes('agent get') && names.includes('agent wait'));
  assert.ok(!names.includes('pane close'), '기본은 pane 을 남긴다');
  assert.ok(!names.includes('agent send-keys'), '정상 제출이면 nudge 없음');
});

test('run: 제출이 안 된 형태(idle 유지 + 화면에 프롬프트 잔존)면 send-keys enter 로 밀어 넣는다(nudged) · close_panes 면 닫는다', () => {
  const dir = makeRepo();
  const out = join(dir, 'b.json');
  writeFileSync(out, JSON.stringify({ findings: [], summary: 'ok' }));
  // get 순서: 사다리 1 · 제출 전 생존 확인 1 · 제출 뒤 폴링(3번째에서 nudge) — 그 뒤 working
  const { env, log } = inside(dir, { FAKE_HERDR_STATES: 'idle,idle,idle,idle,idle,working,done', FAKE_HERDR_READ: '> Read the file …prompt.md and do exactly what it says' });
  const r = lanes(dir, ['run', '--spec', spec(dir, [{ name: 'b', kind: 'grok', prompt: 'x', out }], { close_panes: true })], env);
  const l = r.value.lanes[0];
  assert.equal(l.status, 'done', JSON.stringify(l));
  assert.equal(l.nudged, true);
  const c = calls(log);
  assert.ok(c.some(a => a[0] === 'agent' && a[1] === 'send-keys' && a[3] === 'enter'));
  assert.ok(c.some(a => a[0] === 'pane' && a[1] === 'close' && a[2] === 'w1:p9'));
});

test('run: blocked — teach 다이얼로그면 esc 1회 후 계속, 그 외 승인 UI 면 status blocked 로 보고(자동 응답 없음)', () => {
  const teach = makeRepo();
  const out1 = join(teach, 't.json');
  writeFileSync(out1, JSON.stringify({ findings: [] }));
  // get 순서: 사다리 1 · 생존 확인 1 · 폴링 1(working) → wait 가 blocked(teach) → esc → wait 가 done
  const a = inside(teach, { FAKE_HERDR_STATES: 'working,working,working,blocked,done', FAKE_HERDR_READ: 'Teach auto mode about your environment? (y/n)' });
  const r1 = lanes(teach, ['run', '--spec', spec(teach, [{ name: 't', kind: 'claude', prompt: 'x', out: out1 }])], a.env);
  assert.equal(r1.value.lanes[0].status, 'done', JSON.stringify(r1.value.lanes[0]));
  assert.equal(r1.value.lanes[0].escaped, true);
  assert.ok(calls(a.log).some(c => c[1] === 'send-keys' && c[3] === 'esc'));
  const perm = makeRepo();
  const out2 = join(perm, 'p.json');
  const b = inside(perm, { FAKE_HERDR_STATES: 'working,blocked,blocked', FAKE_HERDR_READ: 'Allow Bash(rm -rf)? 1. Yes 2. No' });
  const r2 = lanes(perm, ['run', '--spec', spec(perm, [{ name: 'p', kind: 'claude', prompt: 'x', out: out2 }])], b.env);
  assert.equal(r2.value.lanes[0].status, 'blocked');
  assert.match(r2.value.lanes[0].screen_tail, /Allow Bash/);
  assert.ok(!calls(b.log).some(c => c[1] === 'send-keys'), '승인 UI 에 키를 보내지 않는다');
});

test('run: 기동 직후 다이얼로그 사다리 — 업데이트 안내는 Skip, 디렉터리 신뢰는 enter, 그 뒤에야 프롬프트 · auto_trust:false 면 blocked(프롬프트 없음) · 에이전트가 사라졌으면 아무 입력도 보내지 않고 failed', () => {
  const TRUST = '  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk\n› 1. Yes, continue\n  2. No, quit\n  Press enter to continue';
  // (a) update → trust → 정상
  const dir = makeRepo();
  const out = join(dir, 'd.json');
  writeFileSync(out, JSON.stringify({ findings: [], summary: 'ok' }));
  const a = inside(dir, { FAKE_HERDR_STATES: 'idle,idle,working,done', FAKE_HERDR_READ_SEQ: JSON.stringify(['  1. Update now\n  2. Skip', TRUST, '']) });
  const r = lanes(dir, ['run', '--spec', spec(dir, [{ name: 'd', kind: 'codex', prompt: 'x', out }])], a.env);
  const l = r.value.lanes[0];
  assert.equal(l.status, 'done', JSON.stringify(l));
  assert.deepEqual(l.dialogs, ['update', 'trust']);
  const c = calls(a.log);
  const keys = c.filter(x => x[0] === 'agent' && x[1] === 'send-keys').map(x => x.slice(3).join('+'));
  assert.deepEqual(keys, ['down+enter', 'enter']);
  const lastKey = c.map((x, i) => (x[0] === 'agent' && x[1] === 'send-keys' ? i : -1)).filter(i => i >= 0).pop();
  const promptAt = c.findIndex(x => x[0] === 'agent' && x[1] === 'prompt');
  assert.ok(lastKey < promptAt, '다이얼로그를 다 걷은 뒤에 프롬프트');
  // (b) auto_trust:false → blocked · 프롬프트 없음
  const d2 = makeRepo();
  const b = inside(d2, { FAKE_HERDR_STATES: 'idle', FAKE_HERDR_READ: TRUST });
  const r2 = lanes(d2, ['run', '--spec', spec(d2, [{ name: 'e', kind: 'codex', prompt: 'x', out: join(d2, 'e.json') }], { auto_trust: false })], b.env);
  assert.equal(r2.value.lanes[0].status, 'blocked');
  assert.match(r2.value.lanes[0].reason, /auto_trust=false/);
  assert.ok(!calls(b.log).some(x => x[1] === 'prompt' || x[1] === 'send-keys'), '입력을 보내지 않는다');
  // (c) 에이전트 소실(agent get 실패) → failed · 프롬프트·send-keys 0 · pane 화면 꼬리
  const d3 = makeRepo();
  const g3 = inside(d3, { FAKE_HERDR_GET_FAIL: '1', FAKE_HERDR_READ: 'PS C:\\> ' });
  const r3 = lanes(d3, ['run', '--spec', spec(d3, [{ name: 'f', kind: 'codex', prompt: 'x', out: join(d3, 'f.json') }])], g3.env);
  assert.equal(r3.value.lanes[0].status, 'failed');
  assert.match(r3.value.lanes[0].reason, /종료됐다/);
  assert.equal(r3.value.lanes[0].pane, 'w1:p9');
  const c3 = calls(g3.log);
  assert.ok(!c3.some(x => x[1] === 'prompt' || x[1] === 'send-keys'), '죽은 pane 에 입력을 보내지 않는다');
  assert.ok(c3.some(x => x[0] === 'pane' && x[1] === 'read'), '진단은 pane 화면으로');
});

test('run: 결과 파일이 없으면 failed(사유에 경로) · .error.txt 가 있으면 그 내용 · start 실패도 failed', () => {
  const dir = makeRepo();
  const out = join(dir, 'missing.json');
  const { env } = inside(dir, { FAKE_HERDR_STATES: 'working,done' });
  const r = lanes(dir, ['run', '--spec', spec(dir, [{ name: 'm', kind: 'codex', prompt: 'x', out }])], env);
  assert.equal(r.value.lanes[0].status, 'failed');
  assert.match(r.value.lanes[0].reason, /결과 파일 없음/);
  writeFileSync(`${out}.error.txt`, '파일 쓰기 권한 없음');
  const r2 = lanes(dir, ['run', '--spec', spec(dir, [{ name: 'm2', kind: 'codex', prompt: 'x', out }])], inside(dir, { FAKE_HERDR_STATES: 'working,done' }).env);
  assert.match(r2.value.lanes[0].reason, /레인 보고 오류: 파일 쓰기 권한 없음/);
  const r3 = lanes(dir, ['run', '--spec', spec(dir, [{ name: 'Bad Name', kind: 'codex', prompt: 'x', out }])], env);
  assert.match(r3.value.lanes[0].reason, /레인 이름 형식/);
});

test('verify: herdr.lanes=off 면 실행 없이 ok:false · plan 은 kinds 만큼 레인 spec(프롬프트에 diff-ref·파일·규약) · verify 는 findings 를 verify.js 모양으로 합치고 lanes_reason 을 낸다', () => {
  const off = makeRepo({ lanes: 'off' });
  const r0 = lanes(off, ['verify', '--diff-ref', 'main...HEAD', '--files', 'backend/App.java', '--slug', 'feat-ABC-5'], inside(off).env);
  assert.equal(r0.value.ok, false);
  assert.match(r0.value.reason, /herdr\.lanes=off/);
  const dir = makeRepo();
  const plan = lanes(dir, ['plan', '--diff-ref', 'main...HEAD', '--files', 'backend/App.java', '--slug', 'feat-ABC-5', '--axes', '보안'], inside(dir).env);
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(plan.value.lanes.map(l => l.kind), ['codex', 'grok']);
  assert.match(plan.value.lanes[0].prompt, /git diff main\.\.\.HEAD/);
  assert.match(plan.value.lanes[0].prompt, /backend\/App\.java/);
  assert.match(plan.value.lanes[0].prompt, /보안/);
  assert.match(plan.value.lanes[0].out, /feat-ABC-5\.herdr-codex\.json$/);
  // 실행 — codex 레인은 결과를 미리 써 두고, grok 레인은 결과 없음(failed) → ok:true(1개 완주) · failed 에 grok
  const outCodex = join(dir, '.claude/runtime/issues/feat-ABC-5.herdr-codex.json');
  mkdirSync(dirname(outCodex), { recursive: true });
  writeFileSync(outCodex, JSON.stringify({ findings: [{ severity: 'blocker', file: 'backend\\App.java', line: '3', claim: 'NPE', evidence: 'x', axis: '정확성' }], summary: '1건' }));
  const { env, log } = inside(dir, { FAKE_HERDR_STATES: 'working,done,working,done' });
  const v = lanes(dir, ['verify', '--diff-ref', 'main...HEAD', '--files', 'backend/App.java', '--slug', 'feat-ABC-5'], env);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.value.ok, true);
  assert.equal(v.value.findings.length, 1);
  assert.deepEqual(v.value.findings[0], { severity: 'BLOCKER', file: 'backend/App.java', line: 3, claim: 'NPE', evidence: 'x', axis: '정확성', lane: 'review-codex' });
  assert.equal(v.value.blockers, 1);
  assert.match(v.value.lanes_reason, /herdr lanes: codex\+grok/);
  assert.equal(v.value.failed.length, 1);
  assert.match(v.value.failed[0], /^review-grok/);
  const c = calls(log);
  assert.ok(c.some(a => a[0] === 'notification' && /blocker 1/.test(a[2])), 'blocker 토스트');
  assert.equal(c.filter(a => a[1] === 'start').length, 2);
});
