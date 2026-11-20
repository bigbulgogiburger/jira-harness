#!/usr/bin/env node
// queue-run.mjs — 게이트가 아닌 무거운 명령을 게이트와 같은 대기열(lib/queue.mjs)에 줄 세워 돌린다.
//   node queue-run.mjs [--what <라벨>] [--max-wait <초>] [--cwd <dir>] [--no-queue] -- <명령 한 줄>
// gate.mjs --full·--related·--main 은 스스로 줄을 선다. 이 스크립트는 그 밖의 길 — 스택 전체 테스트를 직접 돌리는 프로젝트 스크립트·수동 실행 — 을 위한 것이다.
// 줄을 서지 않은 무거운 명령은 대기열이 보지 못한다: 차례를 받은 게이트와 겹쳐 돌면 둘 다 느려지고 부하로 깨진다.
// `--` 뒤는 한 줄로 이어 붙여 게이트와 같은 셸(harness.json.shell)로 돌린다. 종료 코드는 그 명령의 것, 기다리다 상한을 넘기면 75(명령은 돌지 않는다).
// --no-queue 는 이번 한 번 줄을 서지 않고 돌린다(기다리는 동안 나오는 안내와 같은 플래그 — gate.mjs 와 같다).
// 안에서 도는 gate.mjs 는 다시 줄을 서지 않는다(GATE_QUEUE_HELD) — 자기 자신을 기다리지 않게. 여기서 기다린 시간은 그 게이트의 기록(queue_wait_s)에 실린다.
import { spawn } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { locateProject, loadConfig } from './lib/config.mjs';
import { resolveShell } from './lib/shell.mjs';
import { acquire, queueOff, queueHeld } from './lib/queue.mjs';
import { killTree } from './lib/proctree.mjs';

const USAGE = '[queue-run] 사용법: queue-run.mjs [--what <라벨>] [--max-wait <초>] [--cwd <dir>] [--no-queue] -- <명령 한 줄>';
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep < 0 ? argv : argv.slice(0, sep);
const cmd = sep < 0 ? '' : argv.slice(sep + 1).join(' ');
const opt = n => { const i = own.indexOf(n); return i >= 0 ? own[i + 1] : null; };
if (!cmd.trim()) { console.error(USAGE); process.exit(2); }
// 모르는 옵션을 조용히 넘기지 않는다 — 오타 난 플래그가 「줄을 서지 않는다」로도 「선다」로도 읽히지 않게
for (let i = 0; i < own.length; i++) {
  if (['--what', '--max-wait', '--cwd'].includes(own[i])) { i++; continue; }
  if (own[i] !== '--no-queue') { console.error(`[queue-run] 모르는 옵션: ${own[i]}\n${USAGE}`); process.exit(2); }
}
const cwd = resolve(opt('--cwd') ?? process.cwd());
delete process.env.GATE_QUEUE_WAITED_S; // 바깥에서 새어 든 값을 안의 게이트에 넘기지 않는다 — 아래에서 실제로 기다린 값만 넘긴다

let cfg = null, project = basename(cwd);
try {
  const proj = locateProject(cwd);
  if (proj?.configPath) { cfg = loadConfig(proj.configPath); project = basename(proj.configRoot); }
} catch { /* 하네스 설정이 없거나 깨졌어도 명령은 돈다 — 기본 셸·기본 대기열로 */ }
let shell;
try { shell = resolveShell(cfg); } catch (e) { console.error(`[queue-run] ${e.message}`); process.exit(2); }

let q = null;
if (!own.includes('--no-queue') && !queueHeld() && !queueOff() && cfg?.gate?.queue !== false) {
  const maxWaitS = opt('--max-wait') != null ? Number(opt('--max-wait')) || 0 : (cfg?.gate?.queue_max_wait_s ?? 0);
  q = await acquire({ info: { project, what: opt('--what') ?? cmd.slice(0, 60), cwd: cwd.replace(/\\/g, '/') }, maxWaitS, log: line => console.error(`[queue-run] ${line}`) });
  if (!q.ok) {
    console.error(`[queue-run] 대기열에서 ${q.waited_s}s 기다렸지만 차례가 오지 않았다${q.holder ? ` — 지금 도는 것: ${q.holder.project} 의 ${q.holder.what} (pid ${q.holder.pid})` : ''}. 명령은 돌지 않았다`);
    process.exit(75);
  }
  if (q.broken) console.error(`[queue-run] ⚠ 대기열을 쓸 수 없어 줄을 서지 않고 돈다 — ${q.broken}`);
  else if (q.waited_s >= 1) console.error(`[queue-run] 대기열: ${q.waited_s}s 기다린 뒤 시작한다`);
}

const t0 = Date.now();
const child = spawn(shell.file, shell.args(cmd), { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, GATE_QUEUE_HELD: '1', ...(q && !q.broken ? { GATE_QUEUE_WAITED_S: String(q.waited_s) } : {}) } });
// 신호를 받으면 명령을 트리째 끝낸다 — 셸만 끝내면 그 아래 러너가 남은 채 자리가 다음 차례로 넘어간다
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => killTree(child.pid, sig));
const code = await new Promise(done => {
  child.on('error', e => { console.error(`[queue-run] 명령을 띄우지 못했다: ${e.message}`); done(127); });
  child.on('exit', c => done(c ?? 1));
});
q?.release();
console.error(`[queue-run] exit ${code} · ${((Date.now() - t0) / 1000).toFixed(1)}s${q && q.waited_s >= 1 ? ` · 대기 ${q.waited_s}s` : ''}`);
process.exit(code);
