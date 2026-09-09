// fake-herdr.mjs — Herdr CLI 대역. 호출 인자를 FAKE_HERDR_LOG 에 한 줄씩 남기고 명령별로 고정 JSON 을 낸다.
//   FAKE_HERDR_FAIL=1              모든 호출 exit 1
//   FAKE_HERDR_STATES=working,done  `agent get` 이 호출마다 순서대로 돌려줄 상태(마지막 값 반복). 기본 done
//   FAKE_HERDR_STATE_FILE=<path>    호출 횟수 카운터 파일(순서 상태용)
//   FAKE_HERDR_READ=<text>          `agent read`/`pane read` 본문
//   FAKE_HERDR_AGENTS=<json>        `agent list` 응답(재사용 판정용) · FAKE_HERDR_PANE_MISSING=1 이면 `pane get` 이 not_found
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_HERDR_LOG) appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(args) + '\n');
if (process.env.FAKE_HERDR_FAIL) { process.stderr.write('{"error":{"code":"not_found","message":"boom"}}\n'); process.exit(1); }
const [a, b] = args;
const out = o => process.stdout.write(JSON.stringify(o));
function nextState() {
  const seq = (process.env.FAKE_HERDR_STATES ?? 'done').split(',');
  let n = 0;
  const f = process.env.FAKE_HERDR_STATE_FILE;
  if (f) { n = existsSync(f) ? Number(readFileSync(f, 'utf8') || 0) : 0; writeFileSync(f, String(n + 1)); }
  return seq[Math.min(n, seq.length - 1)];
}
if (a === 'pane' && b === 'split') out({ result: { pane: { pane_id: 'w1:p9', workspace_id: 'w1', tab_id: 'w1:t1' } } });
else if (a === 'pane' && b === 'get') { if (process.env.FAKE_HERDR_PANE_MISSING) { process.stderr.write('{"error":{"code":"not_found"}}'); process.exit(1); } out({ result: { pane: { pane_id: args[2] } } }); }
else if (a === 'pane' && b === 'wait-output') out({ result: { matched: true } });
else if (a === 'agent' && b === 'rename') out({ result: { renamed: true } });
else if (a === 'pane' && b === 'close') out({ result: { closed: args[2] } });
else if (a === 'pane' && (b === 'report-metadata' || b === 'run' || b === 'send-keys')) out({ result: { ok: true } });
else if (a === 'pane' && b === 'read') process.stdout.write(process.env.FAKE_HERDR_READ ?? '');
else if (a === 'workspace' && b === 'report-metadata') out({ result: { ok: true } });
else if (a === 'worktree' && b === 'create') out({ result: { workspace: { workspace_id: 'w2' }, root_pane: { pane_id: 'w2:p1' }, worktree: { path: process.env.FAKE_HERDR_WORKTREE ?? 'C:/tmp/wt', branch: args[args.indexOf('--branch') + 1] } } });
else if (a === 'notification') out({ result: { shown: true } });
else if (a === 'agent' && b === 'start') out({ result: { agent: { name: args[2], pane_id: args[args.indexOf('--pane') + 1], kind: args[args.indexOf('--kind') + 1], state: 'idle' } } });
else if (a === 'agent' && b === 'prompt') out({ result: { status: 'agent_prompted' } });
else if (a === 'agent' && b === 'get') out({ result: { agent: { name: args[2], state: nextState() } } });
else if (a === 'agent' && b === 'wait') out({ result: { state: nextState() } });
else if (a === 'agent' && b === 'read') process.stdout.write(process.env.FAKE_HERDR_READ ?? '');
else if (a === 'agent' && b === 'send-keys') out({ result: { sent: args.slice(3) } });
else if (a === 'agent' && b === 'list') out({ result: { agents: process.env.FAKE_HERDR_AGENTS ? JSON.parse(process.env.FAKE_HERDR_AGENTS) : [] } });
else out({ result: {} });
process.exit(0);
