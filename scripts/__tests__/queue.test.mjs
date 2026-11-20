// 무거운 검사 대기열(lib/queue.mjs) — 실제 프로세스 여럿으로 자리·순서·풀림을 실측한다.
// 이 파일은 진짜 대기열(~/.gate-queue)을 절대 쓰지 않는다 — 테스트마다 임시 디렉토리를 GATE_QUEUE_DIR 로 준다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newState, writeState, readState } from '../lib/config.mjs';
import { fingerprintTree } from '../lib/tree.mjs';
import { queueOff } from '../lib/queue.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;
const PROC = join(HERE, 'fixtures', 'queue-proc.mjs');

delete process.env.GATE_QUEUE; // 바깥에서 off 로 돌려도 이 파일은 대기열을 실제로 탄다
delete process.env.GATE_QUEUE_HELD;
delete process.env.GATE_QUEUE_DIR; // 진짜 대기열을 가리키는 값이 새어 들어오지 않게 — 아래는 전부 임시 디렉토리를 직접 준다

const newQueueDir = () => mkdtempSync(join(tmpdir(), 'jh-queue-'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** fixture 프로세스를 띄우고 사건을 모은다 */
function proc(dir, ...args) {
  const child = spawn(NODE, [PROC, ...args], { env: { ...process.env, GATE_QUEUE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const events = [];
  const waiters = [];
  let buf = '', err = '';
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { events.push(JSON.parse(line)); } catch { /* 사건이 아닌 줄 */ }
    }
    for (const w of waiters.splice(0)) w();
  });
  child.stderr.on('data', d => { err += d; });
  const exit = new Promise(res => child.on('exit', code => { for (const w of waiters.splice(0)) w(); res(code); }));
  /** 그 사건이 올 때까지 기다린다 — 안 오면 실패 */
  const until = async (ev, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.find(e => e.ev === ev);
      if (hit) return hit;
      if (Date.now() > end || child.exitCode != null) {
        const late = events.find(e => e.ev === ev);
        if (late) return late;
        throw new Error(`"${ev}" 사건이 오지 않았다(${ms}ms · exit ${child.exitCode}) — 받은 것: ${JSON.stringify(events)} ${err}`);
      }
      await new Promise(r => { waiters.push(r); setTimeout(r, 200); });
    }
  };
  return { child, events, until, exit, has: ev => events.some(e => e.ev === ev) };
}

test('자리: 임자가 동기 실행에 막혀 있어도 다음 프로세스는 기다린다 · 끝나면 넘어간다 · 기다리는 동안 누가 도는지 알린다', async () => {
  const dir = newQueueDir();
  const a = proc(dir, '--name', 'alpha', '--hold', 'sync', '--hold-ms', '2500');
  const aGot = await a.until('acquired');
  assert.equal(aGot.waited_s < 1, true, '빈 대기열은 곧바로 잡는다');
  assert.equal(aGot.broken, null);

  const b = proc(dir, '--name', 'beta');
  const note = await b.until('wait');
  assert.match(note.line, /alpha 의 test/, '기다리는 쪽은 지금 누가 도는지 본다: ' + note.line);
  assert.match(note.line, /--no-queue/, '줄을 서지 않는 방법을 알려 준다');
  assert.equal(b.has('acquired'), false, '임자가 있는 동안은 잡지 못한다');

  const bGot = await b.until('acquired');
  const aDone = await a.until('done');
  assert.ok(bGot.at >= aDone.at - 50, `임자가 끝난 뒤에 잡는다(임자 끝 ${aDone.at} · 다음 잡음 ${bGot.at})`);
  assert.ok(bGot.waited_s >= 1.5, `기다린 시간이 남는다: ${bGot.waited_s}`);
  assert.equal(await a.exit, 0); assert.equal(await b.exit, 0);
  assert.deepEqual(readdirSync(join(dir, 'tickets')), [], '번호표가 남지 않는다');
  assert.equal(existsSync(join(dir, 'holder-heavy.json')), false, '끝난 임자의 안내 파일은 지워진다');
});

test('순서: 먼저 온 쪽이 먼저 잡는다(번호표) — 나중에 온 쪽이 새치기하지 못한다', async () => {
  const dir = newQueueDir();
  const a = proc(dir, '--name', 'first', '--hold', 'sync', '--hold-ms', '2000');
  await a.until('acquired');
  const b = proc(dir, '--name', 'second', '--hold', 'async', '--hold-ms', '1200');
  await b.until('wait'); // 번호표가 섰다
  const c = proc(dir, '--name', 'third');
  const cNote = await c.until('wait');
  assert.match(cNote.line, /내 앞에 1개/, '뒤에 온 쪽은 앞에 몇이 있는지 본다: ' + cNote.line);
  const bGot = await b.until('acquired');
  const cGot = await c.until('acquired');
  const bDone = await b.until('done');
  assert.ok(cGot.at >= bDone.at - 50, `셋째는 둘째가 끝난 뒤에 잡는다(둘째 끝 ${bDone.at} · 셋째 잡음 ${cGot.at})`);
  assert.ok(bGot.at < cGot.at);
  assert.ok(cGot.ahead >= 1);
  for (const p of [a, b, c]) assert.equal(await p.exit, 0);
});

test('풀림: 임자가 강제 종료되면 자리는 OS 가 놓는다 — 남이 풀어 줄 잠금 파일이 없다', async () => {
  const dir = newQueueDir();
  const a = proc(dir, '--name', 'doomed', '--hold', 'async', '--hold-ms', '120000');
  await a.until('acquired');
  const b = proc(dir, '--name', 'next');
  await b.until('wait');
  a.child.kill('SIGKILL');
  await a.exit;
  const got = await b.until('acquired', 8000);
  assert.ok(got.waited_s < 15);
  assert.equal(await b.exit, 0);
});

test('풀림: 임자가 분리된 손자 프로세스를 남기고 끝나도 자리가 풀린다 — 빌드 데몬이 자리를 물려받아 PC 전체를 세우지 않는다', async () => {
  const dir = newQueueDir();
  const a = proc(dir, '--name', 'daemon-parent', '--grandchild', '--no-release');
  const gc = await a.until('grandchild');
  assert.equal(await a.exit, 0);
  try {
    assert.equal(alive(gc.pid), true, '손자 프로세스가 살아 있는 상태에서 재야 한다');
    const b = proc(dir, '--name', 'after-daemon');
    const got = await b.until('acquired', 8000);
    assert.equal(alive(gc.pid), true, '잡은 시점에도 손자는 살아 있다');
    assert.ok(got.waited_s < 5, `손자를 기다리지 않는다: ${got.waited_s}`);
    assert.equal(await b.exit, 0);
  } finally { try { process.kill(gc.pid); } catch { /* 이미 끝났다 */ } }
});

test('상한: 기다리는 시간이 상한을 넘으면 포기하고 누가 쥐고 있는지 알려 준다', async () => {
  const dir = newQueueDir();
  const a = proc(dir, '--name', 'long', '--hold', 'sync', '--hold-ms', '5000');
  await a.until('acquired');
  const b = proc(dir, '--name', 'impatient', '--max-wait', '1');
  const out = await b.until('timeout', 8000);
  assert.equal(await b.exit, 75);
  assert.equal(out.holder?.project, 'long');
  assert.ok(out.waited_s >= 1 && out.waited_s < 4, String(out.waited_s));
  assert.deepEqual(readdirSync(join(dir, 'tickets')), [], '포기한 쪽의 번호표는 남지 않는다');
  a.child.kill('SIGKILL'); await a.exit;
});

test('고장: 대기열 디렉토리를 만들 수 없으면 막지 않고 통과시킨다(fail-open) · 디렉토리가 다르면 서로 기다리지 않는다', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jh-queue-bad-')), 'not-a-dir');
  writeFileSync(file, 'x');
  const bad = proc(join(file, 'sub'), '--name', 'broken');
  const got = await bad.until('acquired');
  assert.ok(got.broken, '대기열을 쓰지 못했다는 사실이 남는다');
  assert.equal(await bad.exit, 0);

  const d1 = newQueueDir(), d2 = newQueueDir();
  const a = proc(d1, '--name', 'one', '--hold', 'sync', '--hold-ms', '2000');
  await a.until('acquired');
  const b = proc(d2, '--name', 'two');
  const bGot = await b.until('acquired');
  assert.ok(bGot.waited_s < 1.5, `다른 대기열의 임자를 기다리지 않는다: ${bGot.waited_s}`);
  assert.equal(a.has('done'), false, '첫 대기열의 임자는 아직 돌고 있다');
  assert.equal(await b.exit, 0); assert.equal(await a.exit, 0);
});

// ---------------------------------------------------------------- gate.mjs · queue-run.mjs 연결

function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
/** echo 만 도는 스택 둘(be·fe)짜리 임시 저장소. gate 는 harness.json 의 gate 절에 얹는다 */
function makeRepo(gate = null) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-queue-repo-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'core.autocrlf', 'false');
  for (const d of ['docs', 'backend', 'frontend', '.claude']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'docs/README.md'), '# docs\n');
  writeFileSync(join(dir, 'backend/App.java'), 'class App {}\n');
  writeFileSync(join(dir, 'frontend/app.js'), 'export default 1\n');
  writeFileSync(join(dir, '.gitignore'), '.claude/harness.env.local\n');
  const cfg = JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8'));
  if (gate) cfg.gate = gate;
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const stateFile = dir => join(dir, '.claude/runtime/issues/feat-ABC-1.json');
/** 이슈 브랜치 + 상태 JSON + backend 코드 변경 1건(스테이징까지) */
function startIssue(dir) {
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  writeState(stateFile(dir), newState('feat/ABC-1', ['ABC-1']));
  writeFileSync(join(dir, 'backend/App.java'), 'class App { int v = 2; }\n');
  g(dir, 'add', '-A');
}
/** 스크립트를 비동기로 띄운다 — 기다리는 동안 테스트가 다른 일을 할 수 있게 */
function run(script, args, { cwd, qdir, env = {} }) {
  // GATE_QUEUE=on — Windows 밖에서는 대기열의 기본이 꺼짐이다. 이 파일은 대기열을 실제로 타야 한다
  const child = spawn(NODE, [join(SCRIPTS, script), ...args], { cwd, env: { ...process.env, GATE_QUEUE: 'on', GATE_QUEUE_DIR: qdir, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const r = { child, out: '', err: '', done: false };
  child.stdout.on('data', d => { r.out += d; });
  child.stderr.on('data', d => { r.err += d; });
  r.exit = new Promise(res => child.on('exit', status => { r.done = true; r.status = status; res(r); }));
  return r;
}
const gate = (dir, qdir, args, env) => run('gate.mjs', [...args, '--cwd', dir], { cwd: dir, qdir, env });
/** 곧바로 끝나야 하는 실행 — ms 안에 안 끝나면 죽이고 실패시킨다. 줄을 서면 안 되는 길이 줄을 섰을 때 임자가 풀릴 때까지 매달리지 않게 */
async function within(r, label, ms = 90_000) {
  let timer;
  const late = new Promise(res => { timer = setTimeout(() => res(null), ms); });
  const got = await Promise.race([r.exit, late]);
  clearTimeout(timer);
  if (got) return got;
  r.child.kill('SIGKILL');
  await r.exit;
  throw new Error(`${label}: ${ms / 1000}s 안에 끝나지 않았다 — 기다리면 안 되는 실행이 줄을 섰다. stderr: ${r.err.slice(-600)}`);
}
/** 대기열에 번호표가 설 때까지(= 그 프로세스가 줄을 섰다) */
async function ticketSeen(qdir, ms = 30_000) {
  const end = Date.now() + ms;
  const tdir = join(qdir, 'tickets');
  while (Date.now() < end) {
    if (existsSync(tdir) && readdirSync(tdir).length) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('번호표가 서지 않았다 — 게이트가 줄을 서지 않았다');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** 오래 쥐고 있는 임자 — stop() 으로 강제 종료한다 */
async function holder(qdir, name = 'other-project') {
  const p = proc(qdir, '--name', name, '--hold', 'async', '--hold-ms', '600000');
  await p.until('acquired');
  return { ...p, stop: async () => { p.child.kill('SIGKILL'); await p.exit; } };
}

test('게이트: 자리가 차 있으면 무거운 게이트는 기다렸다가 돌고 기다린 시간을 기록한다 · 경량·계획 보기·--no-queue·GATE_QUEUE=off·gate.queue=false 는 줄을 서지 않는다 · 상한을 넘기면 돌지 않고 exit 75', async () => {
  const qdir = newQueueDir();
  const dir = makeRepo(); startIssue(dir);
  const off = makeRepo({ queue: false }); startIssue(off);
  const capped = makeRepo({ queue_max_wait_s: 1 }); startIssue(capped);
  const h = await holder(qdir);
  try {
    // 줄을 서지 않는 길 — 임자가 쥐고 있는 동안에도 곧바로 끝난다
    for (const [label, where, args, env] of [
      ['경량(--commit)', dir, ['--commit'], {}],
      ['--dry-run', dir, ['--full', '--dry-run'], {}],
      ['--no-queue', dir, ['--full', '--no-queue', '--json'], {}],
      ['GATE_QUEUE=off', dir, ['--full', '--json'], { GATE_QUEUE: 'off' }],
      ['gate.queue=false', off, ['--full', '--json'], {}],
    ]) {
      const r = await within(gate(where, qdir, args, env), label);
      assert.equal(r.status, 0, `${label}: ${r.err}`);
      assert.ok(!r.err.includes('대기열'), `${label} 은 줄을 서지 않는다: ${r.err}`);
      if (args.includes('--json') && !args.includes('--dry-run')) assert.equal('queue_wait_s' in JSON.parse(r.out), false, `${label}: 줄을 서지 않은 실행에는 대기 시간이 없다`);
    }
    assert.equal(h.has('done'), false, '그동안 임자는 계속 쥐고 있었다');

    // 상한 — 게이트를 돌리지 않고, 기록도 남기지 않는다
    const c = await within(gate(capped, qdir, ['--full', '--json']), '상한(queue_max_wait_s=1)');
    assert.equal(c.status, 75, c.err);
    assert.match(c.err, /차례가 오지 않았다/); assert.match(c.err, /other-project 의 test/);
    assert.equal(readState(stateFile(capped)).gate ?? null, null, '돌지 않은 게이트는 기록이 없다');

    // 기다렸다가 돈다
    const before = readState(stateFile(dir)).history.length;
    const w = gate(dir, qdir, ['--full', '--json']);
    await ticketSeen(qdir);
    await sleep(1500);
    assert.equal(w.done, false, '임자가 있는 동안은 시작하지 않는다');
    assert.match(w.err, /대기열: 무거운 검사는 이 PC 에서 한 번에 하나만 돈다 — 지금 other-project 의 test/);
    await h.stop();
    const r = await w.exit;
    assert.equal(r.status, 0, r.err);
    const sum = JSON.parse(r.out);
    assert.equal(sum.overall, 'PASS');
    assert.ok(sum.queue_wait_s >= 1, `기다린 시간: ${sum.queue_wait_s}`);
    assert.match(r.err, /기다린 뒤 시작한다/);
    const st = readState(stateFile(dir));
    assert.equal(st.gate.queue_wait_s, sum.queue_wait_s, '상태 기록에도 같은 값');
    assert.equal(st.history.length, before + 1, '기록은 한 번만 남는다(줄을 선 프로세스와 실제로 돈 프로세스가 둘이어도)');
    assert.match(st.history.at(-1).note, /^full PASS [\d.]+s wait [\d.]+s$/);
    assert.match(readFileSync(join(dir, st.gate.log), 'utf8').split('\n')[1], /^# queue wait [\d.]+s$/);
    assert.deepEqual(readdirSync(join(qdir, 'tickets')), []);
  } finally { await h.stop(); }
});

test('게이트: 줄을 선 사이 작업트리가 바뀌면 바뀐 트리로 처음부터 다시 잰다 — 기다리기 전에 세운 계획으로 기록하지 않는다', async () => {
  const qdir = newQueueDir();
  const dir = makeRepo(); startIssue(dir); // 줄을 설 때는 be 만 바뀌어 있다
  const cfg = JSON.parse(readFileSync(join(dir, '.claude/harness.json'), 'utf8'));
  const h = await holder(qdir);
  try {
    const w = gate(dir, qdir, ['--related', '--json']);
    await ticketSeen(qdir);
    writeFileSync(join(dir, 'frontend/app.js'), 'export default 2\n'); // 기다리는 동안 fe 도 바뀐다
    g(dir, 'add', '-A');
    const expected = fingerprintTree({ cwd: dir, base: 'index', excludes: cfg.fingerprint_exclude });
    await h.stop();
    const r = await w.exit;
    assert.equal(r.status, 0, r.err);
    const sum = JSON.parse(r.out);
    assert.equal(sum.tree, expected, '기록의 트리는 기다린 뒤의 트리다');
    assert.deepEqual(Object.keys(sum.stacks).sort(), ['be', 'fe'], '기다리는 동안 바뀐 스택도 돈다 — 줄 서기 전 계획(be 뿐)이 아니다');
    assert.equal(readState(stateFile(dir)).gate.tree, expected);
  } finally { await h.stop(); }
});

test('게이트 --main: 같은 줄에 선다 · --status 는 서지 않는다 · 기록(main-gate.json)에 기다린 시간이 남는다', async () => {
  const qdir = newQueueDir();
  const dir = makeRepo();
  const h = await holder(qdir);
  try {
    const s = await within(gate(dir, qdir, ['--main', '--status', '--json']), '--main --status');
    assert.equal(s.status, 0, s.err); assert.ok(!s.err.includes('대기열'));
    const w = gate(dir, qdir, ['--main', '--json']);
    await ticketSeen(qdir);
    await sleep(1200);
    assert.equal(w.done, false);
    await h.stop();
    const r = await w.exit;
    assert.equal(r.status, 0, r.err);
    const sum = JSON.parse(r.out);
    assert.equal(sum.overall, 'PASS');
    assert.ok(sum.queue_wait_s >= 1, String(sum.queue_wait_s));
    const rec = JSON.parse(readFileSync(join(dir, '.claude/runtime/main-gate.json'), 'utf8'));
    assert.equal(rec.last.queue_wait_s, sum.queue_wait_s);
    assert.equal(rec.history.at(-1).queue_wait_s, sum.queue_wait_s);
  } finally { await h.stop(); }
});

test('queue-run: 게이트가 아닌 명령도 같은 줄에 선다 · 종료 코드를 그대로 돌려준다 · 안에서 도는 게이트는 자기 자신을 기다리지 않는다', async () => {
  const qdir = newQueueDir();
  const node = `"${NODE.replace(/\\/g, '/')}"`;
  const dir = makeRepo(); startIssue(dir);
  const code3 = await run('queue-run.mjs', ['--', node, '-e', '"process.exit(3)"'], { cwd: dir, qdir }).exit;
  assert.equal(code3.status, 3, code3.err);
  assert.equal((await run('queue-run.mjs', ['--what', 'x'], { cwd: dir, qdir }).exit).status, 2, '명령이 없으면 사용법 오류');

  const h = await holder(qdir);
  try {
    const w = run('queue-run.mjs', ['--what', '전체 테스트', '--', node, '-e', '"console.log(\'ran\')"'], { cwd: dir, qdir });
    await ticketSeen(qdir);
    await sleep(1200);
    assert.equal(w.done, false, '임자가 있는 동안은 명령을 돌리지 않는다');
    assert.ok(!w.out.includes('ran'));
    await h.stop();
    const r = await w.exit;
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /ran/);
    assert.match(r.err, /대기열: 무거운 검사/); assert.match(r.err, /대기 [\d.]+s/);
  } finally { await h.stop(); }

  // --no-queue: 기다리는 동안 나오는 안내와 같은 플래그 — 임자가 있어도 곧바로 돈다. 모르는 옵션은 조용히 넘기지 않는다
  const h1 = await holder(qdir);
  try {
    const nq = await within(run('queue-run.mjs', ['--no-queue', '--', node, '-e', '"console.log(\'no-line\')"'], { cwd: dir, qdir }), 'queue-run --no-queue');
    assert.equal(nq.status, 0, nq.err);
    assert.match(nq.out, /no-line/); assert.ok(!nq.err.includes('대기열: 무거운 검사'), nq.err);
    const typo = await within(run('queue-run.mjs', ['--no-que', '--', node, '-e', '"console.log(\'ran-anyway\')"'], { cwd: dir, qdir }), 'queue-run 모르는 옵션');
    assert.equal(typo.status, 2, typo.err); assert.match(typo.err, /모르는 옵션: --no-que/); assert.ok(!typo.out.includes('ran-anyway'));
  } finally { await h1.stop(); }

  // 자리를 쥔 채 그 안에서 무거운 게이트를 돌린다 — 다시 줄을 서면 자기 자신을 영원히 기다린다. 감싼 쪽이 기다린 시간은 안의 게이트 기록에 실린다
  const h2 = await holder(qdir);
  let nested;
  try {
    const w = run('queue-run.mjs', ['--', node, `"${join(SCRIPTS, 'gate.mjs').replace(/\\/g, '/')}"`, '--full', '--json', '--cwd', `"${dir.replace(/\\/g, '/')}"`], { cwd: dir, qdir });
    await ticketSeen(qdir);
    await sleep(1500);
    assert.equal(w.done, false, '임자가 있는 동안은 감싼 게이트도 시작하지 않는다');
    await h2.stop();
    nested = await within(w, '자리를 쥔 채 도는 게이트');
  } finally { await h2.stop(); }
  assert.equal(nested.status, 0, nested.err);
  const nsum = JSON.parse(nested.out);
  assert.equal(nsum.overall, 'PASS');
  assert.ok(nsum.queue_wait_s >= 1, `감싼 쪽이 기다린 시간: ${nsum.queue_wait_s}`);
  assert.equal(readState(stateFile(dir)).gate.level, 'full');
  assert.equal(readState(stateFile(dir)).gate.queue_wait_s, nsum.queue_wait_s);
});

test('자리: 같은 대기열 디렉토리를 다른 경로(junction·심볼릭 링크)로 열어도 같은 자리를 다툰다', async () => {
  const dir = newQueueDir();
  const link = join(mkdtempSync(join(tmpdir(), 'jh-queue-link-')), 'q');
  symlinkSync(dir, link, 'junction'); // Windows: 관리자 권한 없이 만들 수 있는 junction · 그 밖: 심볼릭 링크
  const a = proc(dir, '--name', 'alpha', '--hold', 'async', '--hold-ms', '600000');
  try {
    await a.until('acquired');
    const b = proc(link, '--name', 'beta');
    await b.until('wait');
    await sleep(1500);
    assert.equal(b.has('acquired'), false, '경로 표기가 달라도 임자가 있는 동안은 잡지 못한다');
    a.child.kill('SIGKILL'); await a.exit;
    await b.until('acquired');
    await b.exit;
  } finally { a.child.kill('SIGKILL'); }
});

test('끄기: GATE_QUEUE=off 는 어디서나 끈다 · Windows 밖에서는 기본이 꺼짐이고 GATE_QUEUE=on 으로 켠다(실행으로 검증하지 못한 잠금을 기본으로 켜지 않는다)', () => {
  assert.equal(queueOff({}, 'win32'), false);
  for (const v of ['off', '0', 'false', 'no', 'OFF']) assert.equal(queueOff({ GATE_QUEUE: v }, 'win32'), true, v);
  assert.equal(queueOff({ GATE_QUEUE: 'on' }, 'win32'), false);
  for (const p of ['linux', 'darwin']) {
    assert.equal(queueOff({}, p), true, `${p} 기본`);
    assert.equal(queueOff({ GATE_QUEUE: 'on' }, p), false, `${p} on`);
    assert.equal(queueOff({ GATE_QUEUE: 'off' }, p), true, `${p} off`);
  }
});

test('기록: 기다린 시간은 자리를 쥐고 띄운 쪽이 넘긴 유한한 0 이상의 수만 싣는다 — 엉뚱한 값이 상태에 실려 다음 게이트를 세우지 않는다', async () => {
  const qdir = newQueueDir();
  const dir = makeRepo(); startIssue(dir);
  for (const [raw, want] of [['Infinity', undefined], ['-3', undefined], ['abc', undefined], ['', undefined], ['12.5', 12.5]]) {
    const r = await within(gate(dir, qdir, ['--full', '--json'], { GATE_QUEUE_HELD: '1', GATE_QUEUE_WAITED_S: raw }), `GATE_QUEUE_WAITED_S=${JSON.stringify(raw)}`);
    assert.equal(r.status, 0, `${JSON.stringify(raw)}: ${r.err}`);
    assert.equal(JSON.parse(r.out).queue_wait_s, want, `요약 — ${JSON.stringify(raw)}`);
    assert.equal(readState(stateFile(dir)).gate.queue_wait_s, want, `상태 — ${JSON.stringify(raw)}`);
  }
  // 자리를 쥐었다는 표시 없이 값만 들어오면 믿지 않는다 — 이 게이트가 스스로 줄을 서고 실제로 기다린 시간을 싣는다
  const lone = await within(gate(dir, qdir, ['--full', '--json'], { GATE_QUEUE_WAITED_S: '999' }), '값만 들어온 실행');
  assert.equal(lone.status, 0, lone.err);
  assert.ok(JSON.parse(lone.out).queue_wait_s < 60, String(JSON.parse(lone.out).queue_wait_s));
});
