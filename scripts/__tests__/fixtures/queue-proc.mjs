// queue 테스트용 프로세스 — 대기열(GATE_QUEUE_DIR)에서 자리를 잡고, 지정한 방식으로 쥐고 있다가 끝난다.
// 사건을 한 줄에 JSON 하나씩 stdout 으로 알린다: wait(기다리는 중 알림) · acquired · timeout · grandchild · done
// 사용: node queue-proc.mjs --name <이름> [--hold sync|async] [--hold-ms N] [--max-wait S] [--grandchild] [--no-release]
import { spawnSync } from 'node:child_process';
import { acquire } from '../../lib/queue.mjs';

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const flag = n => argv.includes(n);
const say = o => process.stdout.write(JSON.stringify({ at: Date.now(), ...o }) + '\n');

const q = await acquire({
  info: { project: opt('--name', 'p'), what: 'test' },
  maxWaitS: Number(opt('--max-wait', '0')),
  pollMs: 100, noticeMs: 300,
  log: line => say({ ev: 'wait', line }),
});
if (!q.ok) { say({ ev: 'timeout', waited_s: q.waited_s, holder: q.holder }); process.exit(75); }
say({ ev: 'acquired', waited_s: q.waited_s, ahead: q.ahead, broken: q.broken ?? null });

if (flag('--grandchild')) {
  // 러너가 띄운 명령이 남기는 프로세스(빌드 데몬) 흉내 — 자식을 stdio 상속으로 띄우고, 그 자식이 분리된 손자를 남긴 채 끝난다
  const code = "const {spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore',windowsHide:true});g.unref();console.log(JSON.stringify({at:Date.now(),ev:'grandchild',pid:g.pid}));";
  spawnSync(process.execPath, ['-e', code], { stdio: 'inherit', windowsHide: true });
}
const ms = Number(opt('--hold-ms', '0'));
if (ms > 0) {
  if (opt('--hold', 'sync') === 'sync') spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`], { windowsHide: true }); // 러너처럼 동기 실행에 막힌다(타이머가 돌지 않는다)
  else await new Promise(r => setTimeout(r, ms));
}
if (!flag('--no-release')) q.release();
say({ ev: 'done' });
process.exit(0);
