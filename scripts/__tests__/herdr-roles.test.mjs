// herdr-lanes.mjs 역할 실측 — reviewer 재사용(있으면 쓰고 없으면 띄움 · /new 정책 · busy) · codex-review 의 CODEX_RESULT 계약 · runner pane 게이트
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
function lanes(cwd, args, env) { const r = sh(NODE, [join(SCRIPTS, 'herdr-lanes.mjs'), ...args, '--cwd', cwd, '--json'], cwd, env); let value = null; try { value = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1)); } catch { /* */ } return { ...r, value }; }
const OUTSIDE = { HERDR_PANE_ID: '', HERDR_WORKSPACE_ID: '', HERDR_ENV: '', HERDR_SOCKET_PATH: '', JIRA_HARNESS_HERDR: FAKE, FAKE_HERDR_AGENTS: '', FAKE_HERDR_PANE_MISSING: '' };
function inside(dir, extra = {}) {
  const tag = Math.random().toString(36).slice(2); const log = join(dir, `h.${tag}.log`); const counter = join(dir, `h.count.${Math.random().toString(36).slice(2)}`);
  return { env: { ...OUTSIDE, HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1', HERDR_ENV: '1', FAKE_HERDR_LOG: log, FAKE_HERDR_STATE_FILE: counter, ...extra }, log };
}
function calls(log) { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }
function lastLine(s) { return s.trim().split('\n').pop(); }

function makeRepo(patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-roles-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  for (const d of ['backend', '.claude']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'backend/App.java'), 'class App {}\n');
  const cfg = { ...JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8')), herdr: { lanes: 'verify' }, ...patch };
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-5');
  return dir;
}
function spec(dir, laneList, extra = {}) { const p = join(dir, 'spec.json'); writeFileSync(p, JSON.stringify({ lanes: laneList, ...extra })); return p; }
function agentsJson(list) { return JSON.stringify(list); }

test('reviewer 재사용: 같은 이름의 idle 에이전트면 split/start 없이 그 pane · fresh 면 /new · 재사용 pane 은 닫지 않는다', () => {
  const dir = makeRepo();
  const out = join(dir, 'r.json');
  writeFileSync(out, JSON.stringify({ findings: [] }));
  const { env, log } = inside(dir, { FAKE_HERDR_STATES: 'working,done', FAKE_HERDR_AGENTS: agentsJson([{ name: 'review-codex', agent: 'codex', agent_status: 'idle', pane_id: 'w1:p4', cwd: dir }]) });
  const r = lanes(dir, ['run', '--spec', spec(dir, [{ name: 'review-codex', kind: 'codex', prompt: 'x', out, reuse: true, fresh: true }], { close_panes: true })], env);
  const l = r.value.lanes[0];
  assert.equal(l.status, 'done', JSON.stringify(l));
  assert.equal(l.reused, true);
  assert.equal(l.pane, 'w1:p4');
  const c = calls(log);
  assert.ok(!c.some(a => a[1] === 'split') && !c.some(a => a[1] === 'start'), '재사용이면 split/start 없음');
  assert.ok(c.some(a => a[0] === 'agent' && a[1] === 'prompt' && a[3] === '/new'), 'fresh → /new');
  assert.ok(!c.some(a => a[1] === 'close'), '재사용 pane 은 닫지 않는다');
});

test('reviewer 재사용: kind·cwd 로 찾으면 이름을 맞춘다(rename) · working 이면 busy · 다른 cwd 의 idle 은 재사용하지 않는다', () => {
  const dir2 = makeRepo();
  const out2 = join(dir2, 'r2.json');
  writeFileSync(out2, JSON.stringify({ findings: [] }));
  const b = inside(dir2, { FAKE_HERDR_STATES: 'working,done', FAKE_HERDR_AGENTS: agentsJson([{ name: 'old', agent: 'codex', agent_status: 'done', pane_id: 'w1:p5', cwd: dir2 }]) });
  const r2 = lanes(dir2, ['run', '--spec', spec(dir2, [{ name: 'review-codex', kind: 'codex', prompt: 'x', out: out2 }])], b.env);
  assert.equal(r2.value.lanes[0].reused, true, JSON.stringify(r2.value));
  assert.ok(calls(b.log).some(a => a[0] === 'agent' && a[1] === 'rename' && a[3] === 'review-codex'));
  const dir3 = makeRepo();
  const c3 = inside(dir3, { FAKE_HERDR_AGENTS: agentsJson([{ name: 'review-codex', agent: 'codex', agent_status: 'working', pane_id: 'w1:p4', cwd: dir3 }]) });
  const r3 = lanes(dir3, ['run', '--spec', spec(dir3, [{ name: 'review-codex', kind: 'codex', prompt: 'x', out: join(dir3, 'x.json') }])], c3.env);
  assert.equal(r3.value.lanes[0].status, 'busy');
  const dir4 = makeRepo();
  writeFileSync(join(dir4, 'y.json'), '{"findings":[]}');
  const d4 = inside(dir4, { FAKE_HERDR_STATES: 'working,done', FAKE_HERDR_AGENTS: agentsJson([{ name: 'other', agent: 'codex', agent_status: 'idle', pane_id: 'w1:p6', cwd: 'C:/elsewhere' }]) });
  const r4 = lanes(dir4, ['run', '--spec', spec(dir4, [{ name: 'review-codex', kind: 'codex', prompt: 'x', out: join(dir4, 'y.json') }])], d4.env);
  assert.equal(r4.value.lanes[0].reused, false);
  assert.ok(calls(d4.log).some(a => a[1] === 'split'));
});

test('codex-review: Herdr 밖·codex_via=exec 면 status:missing(exec 폴백) · herdr 면 상주 codex 로 ok/limit 을 같은 계약으로 · 이슈가 바뀌면 /new', () => {
  const exec = makeRepo();
  const r0 = lanes(exec, ['codex-review', '--slug', 'feat-ABC-5'], inside(exec).env);
  assert.match(lastLine(r0.stdout), /^CODEX_RESULT=\{"status":"missing".*codex_via=exec/);
  const dir = makeRepo({ review: { codex: true, lanes_max: 2, codex_via: 'herdr' } });
  const outside = lanes(dir, ['codex-review', '--slug', 'feat-ABC-5'], { ...OUTSIDE, FAKE_HERDR_LOG: join(dir, 'h.log') });
  assert.match(lastLine(outside.stdout), /"status":"missing".*outside herdr/);
  const out = join(dir, '.claude/runtime/issues/feat-ABC-5.herdr-codex.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ findings: [{ severity: 'BLOCKER', file: 'a.js', line: 1, claim: 'c', evidence: 'e', axis: 'x' }], summary: 's' }));
  const a = inside(dir, { FAKE_HERDR_STATES: 'working,done' });
  const r1 = lanes(dir, ['codex-review', '--slug', 'feat-ABC-5', '--files', 'a.js'], a.env);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(lastLine(r1.stdout), /^CODEX_RESULT=\{"status":"ok","blockers":1,"verdict":"BLOCK"/);
  const c1 = calls(a.log);
  assert.ok(c1.some(x => x[1] === 'split'), '처음엔 새로 띄운다');
  assert.ok(!c1.some(x => x[1] === 'prompt' && x[3] === '/new'), '새 pane 에는 /new 없음');
  assert.ok(c1.some(x => x[0] === 'notification' && /blocker 1/.test(x[2])));
  const agents = agentsJson([{ name: 'review-codex', agent: 'codex', agent_status: 'idle', pane_id: 'w1:p4', cwd: dir }]);
  const b = inside(dir, { FAKE_HERDR_STATES: 'working,done', FAKE_HERDR_AGENTS: agents });
  const r2 = lanes(dir, ['codex-review', '--slug', 'feat-ABC-5', '--files', 'a.js'], b.env);
  assert.match(lastLine(r2.stdout), /"status":"ok"/);
  assert.ok(!calls(b.log).some(x => x[1] === 'prompt' && x[3] === '/new'), '같은 이슈면 컨텍스트 유지');
  assert.ok(calls(b.log).some(x => x[1] === 'rename') === false && !calls(b.log).some(x => x[1] === 'split'), '재사용');
  writeFileSync(join(dir, '.claude/runtime/issues/feat-ABC-6.herdr-codex.json'), JSON.stringify({ status: 'limit', summary: 'usage limit' }));
  const cEnv = inside(dir, { FAKE_HERDR_STATES: 'working,done', FAKE_HERDR_AGENTS: agents });
  const r3 = lanes(dir, ['codex-review', '--slug', 'feat-ABC-6'], cEnv.env);
  assert.ok(calls(cEnv.log).some(x => x[1] === 'prompt' && x[3] === '/new'), '이슈가 바뀌면 /new');
  assert.match(lastLine(r3.stdout), /^CODEX_RESULT=\{"status":"limit"/);
  const ledger = JSON.parse(readFileSync(join(dir, '.claude/runtime/herdr/reviewer-codex.json'), 'utf8'));
  assert.equal(ledger.slug, 'feat-ABC-6');
});

test('gate: runner pane(없으면 split down · 있으면 pane get 확인 후 재사용 · 죽었으면 재생성)에 gate-run 을 보내고 GATE_DONE 을 기다린다 · --no-wait · gate-run 은 결과 파일과 표식', () => {
  const dir = makeRepo();
  const { env, log } = inside(dir);
  const r = lanes(dir, ['gate', '--commit', '--no-wait'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.value.ok, true, JSON.stringify(r.value));
  assert.equal(r.value.pane, 'w1:p9');
  assert.equal(r.value.reused, false);
  const c = calls(log);
  assert.ok(c.find(a => a[1] === 'split').includes('down'));
  assert.ok(c.some(a => a[1] === 'rename' && a[3] === 'runner'));
  const run = c.find(a => a[0] === 'pane' && a[1] === 'run');
  assert.equal(run[2], 'w1:p9');
  assert.match(run[3], /herdr-lanes\.mjs" gate-run --commit --cwd ".*" --out ".*gate-commit-\w+\.json" --nonce \w+/);
  assert.ok(!c.some(a => a[1] === 'wait-output'), '--no-wait');
  const r2 = lanes(dir, ['gate', '--full'], env);
  const c2 = calls(log);
  assert.equal(r2.value.reused, true, JSON.stringify(r2.value));
  assert.equal(c2.filter(a => a[1] === 'split').length, 1);
  assert.ok(c2.some(a => a[1] === 'wait-output' && a[2] === 'w1:p9' && /^GATE_DONE_/.test(a[4])));
  const r3 = lanes(dir, ['gate', '--commit', '--no-wait'], { ...env, FAKE_HERDR_PANE_MISSING: '1' });
  assert.equal(r3.value.reused, false);
  const outside = lanes(dir, ['gate', '--commit'], { ...OUTSIDE, FAKE_HERDR_LOG: log });
  assert.equal(outside.value.ok, false);
  // gate-run 실제 실행: 상태 JSON 을 만든 뒤 gate.mjs 가 돌아 결과 파일·표식
  const st = sh(NODE, [join(SCRIPTS, 'issue-start.mjs'), 'ABC-5', '--cwd', dir, '--json'], dir, OUTSIDE);
  assert.equal(st.status, 0, st.stderr);
  writeFileSync(join(dir, 'backend/App.java'), 'class App { int y; }\n');
  g(dir, 'add', '-A');
  const out = join(dir, '.claude/runtime/herdr/gate-commit-t.json');
  const gr = sh(NODE, [join(SCRIPTS, 'herdr-lanes.mjs'), 'gate-run', '--commit', '--out', out, '--nonce', 'T1', '--cwd', dir], dir, OUTSIDE);
  assert.equal(gr.status, 0, gr.stderr);
  assert.match(gr.stdout, /GATE_DONE_T1\s*$/);
  const j = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(j.summary, `gate-run 결과: ${JSON.stringify(j).slice(0, 300)} · stderr ${gr.stderr.slice(0, 300)}`);
  assert.equal(j.summary.overall, 'PASS');
  assert.equal(j.exit, 0);
});
