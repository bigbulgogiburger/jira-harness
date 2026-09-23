// fake-herdr.mjs — Herdr CLI 대역. 호출 인자를 FAKE_HERDR_LOG 에 한 줄씩 남기고 명령별로 고정 JSON 을 낸다.
//   FAKE_HERDR_FAIL=1              모든 호출 exit 1
//   FAKE_HERDR_STATES=working,done  `agent get` 이 호출마다 순서대로 돌려줄 상태(마지막 값 반복). 기본 done
//   FAKE_HERDR_STATE_FILE=<path>    호출 횟수 카운터 파일(순서 상태용)
//   FAKE_HERDR_READ=<text>          `agent read`/`pane read` 본문
//   FAKE_HERDR_READ_SEQ=<json>      `agent read` 가 호출마다 순서대로 돌려줄 본문 배열(마지막 값 반복 · FAKE_HERDR_READ 보다 우선) — 기동 다이얼로그 사다리용
//   FAKE_HERDR_GET_FAIL=1           `agent get` 이 agent_not_found exit 1 — 에이전트가 사라진 형태
//   FAKE_HERDR_AGENTS=<json>        `agent list` 응답(재사용 판정용) · FAKE_HERDR_PANE_MISSING=1 이면 `pane get` 이 not_found
//   FAKE_HERDR_WORKTREE_DIR=<dir>   `worktree create` 가 돌려줄 경로의 부모 — <dir>/<branch 의 / 를 - 로>. 없으면 FAKE_HERDR_WORKTREE 또는 C:/tmp/wt
//   FAKE_HERDR_WORKTREES=<json>     `worktree list` 의 worktrees 배열(기본 []) — [{branch, path, open_workspace_id?, pane_id?}].
//                                   `worktree open --branch` 는 여기 있으면 already_open 으로 그 pane/path 를, 없으면 worktree_not_found exit 1
//   <out>.agent · <out>.error.txt.agent  있으면 `agent prompt`(제출 문장에서 <out> 을 읽는다)를 받을 때 <out>·<out>.error.txt 로 복사한다 —
//                                   에이전트가 **제출 뒤에** 결과를 쓰는 것을 흉내. 실행기는 제출 전에 지난 결과를 치우므로 결과를 미리 <out> 에 두면 안 된다
//   FAKE_HERDR_WRITE_AT=<n>         그 복사를 prompt 때가 아니라 n 번째(0부터) 상태 조회(agent get/wait) 때 한다 — 일찍 settle 된 뒤에야 결과가 생기는 형태.
//                                   FAKE_HERDR_STATE_FILE 필요(<STATE_FILE>.out 에 <out> 을 적어 둔다)
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_HERDR_LOG) appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(args) + '\n');
if (process.env.FAKE_HERDR_FAIL) { process.stderr.write('{"error":{"code":"not_found","message":"boom"}}\n'); process.exit(1); }
const [a, b] = args;
const out = o => process.stdout.write(JSON.stringify(o));
function agentWrites(outBase) {
  for (const p of [outBase, `${outBase}.error.txt`]) if (existsSync(`${p}.agent`)) writeFileSync(p, readFileSync(`${p}.agent`)); // 새로 쓴다(copy 는 원본 시각을 보존한다)
}
function nextState() {
  const seq = (process.env.FAKE_HERDR_STATES ?? 'done').split(',');
  let n = 0;
  const f = process.env.FAKE_HERDR_STATE_FILE;
  if (f) { n = existsSync(f) ? Number(readFileSync(f, 'utf8') || 0) : 0; writeFileSync(f, String(n + 1)); }
  if (f && process.env.FAKE_HERDR_WRITE_AT && n >= Number(process.env.FAKE_HERDR_WRITE_AT) && existsSync(`${f}.out`)) agentWrites(readFileSync(`${f}.out`, 'utf8'));
  return seq[Math.min(n, seq.length - 1)];
}
function onPrompt(text) {
  const m = /^Read the file (.+)\.prompt\.md and do exactly/.exec(String(text ?? ''));
  if (!m) return; // /new 같은 명령
  const f = process.env.FAKE_HERDR_STATE_FILE;
  if (process.env.FAKE_HERDR_WRITE_AT && f) writeFileSync(`${f}.out`, m[1]);
  else agentWrites(m[1]);
}
function fakeWorktrees() { return process.env.FAKE_HERDR_WORKTREES ? JSON.parse(process.env.FAKE_HERDR_WORKTREES) : []; }
function fakeWorktreePath(branch) {
  const dir = process.env.FAKE_HERDR_WORKTREE_DIR;
  return dir ? `${dir.replace(/\\/g, '/')}/${String(branch).replace(/\//g, '-')}` : (process.env.FAKE_HERDR_WORKTREE ?? 'C:/tmp/wt');
}
const optArg = n => args[args.indexOf(n) + 1];
function nextRead() {
  if (!process.env.FAKE_HERDR_READ_SEQ) return process.env.FAKE_HERDR_READ ?? '';
  const seq = JSON.parse(process.env.FAKE_HERDR_READ_SEQ);
  let n = 0;
  const f = process.env.FAKE_HERDR_STATE_FILE ? `${process.env.FAKE_HERDR_STATE_FILE}.read` : null;
  if (f) { n = existsSync(f) ? Number(readFileSync(f, 'utf8') || 0) : 0; writeFileSync(f, String(n + 1)); }
  return seq[Math.min(n, seq.length - 1)] ?? '';
}
if (a === 'pane' && b === 'split') out({ result: { pane: { pane_id: 'w1:p9', workspace_id: 'w1', tab_id: 'w1:t1' } } });
else if (a === 'pane' && b === 'get') { if (process.env.FAKE_HERDR_PANE_MISSING) { process.stderr.write('{"error":{"code":"not_found"}}'); process.exit(1); } out({ result: { pane: { pane_id: args[2] } } }); }
else if (a === 'pane' && b === 'wait-output') out({ result: { matched: true } });
else if (a === 'agent' && b === 'rename') out({ result: { renamed: true } });
else if (a === 'pane' && b === 'close') out({ result: { closed: args[2] } });
else if (a === 'pane' && (b === 'report-metadata' || b === 'run' || b === 'send-keys')) out({ result: { ok: true } });
else if (a === 'pane' && b === 'read') process.stdout.write(process.env.FAKE_HERDR_READ ?? '');
else if (a === 'workspace' && b === 'report-metadata') out({ result: { ok: true } });
else if (a === 'worktree' && b === 'list') out({ result: { type: 'worktree_list', worktrees: fakeWorktrees() } });
else if (a === 'worktree' && b === 'create') { const branch = optArg('--branch'); out({ result: { workspace: { workspace_id: 'w2' }, root_pane: { pane_id: 'w2:p1', workspace_id: 'w2' }, worktree: { path: fakeWorktreePath(branch), branch } } }); }
else if (a === 'worktree' && b === 'open') {
  const branch = optArg('--branch'); const w = fakeWorktrees().find(x => x.branch === branch);
  if (!w) { process.stderr.write('{"error":{"code":"worktree_not_found"}}'); process.exit(1); }
  out({ result: { already_open: true, workspace: { workspace_id: w.open_workspace_id ?? 'w3' }, root_pane: { pane_id: w.pane_id ?? 'w3:p1' }, worktree: { path: w.path, branch } } });
}
else if (a === 'worktree' && b === 'remove') out({ result: { removed: true, workspace_id: optArg('--workspace') } });
else if (a === 'notification') out({ result: { shown: true } });
else if (a === 'agent' && b === 'start') out({ result: { agent: { name: args[2], pane_id: args[args.indexOf('--pane') + 1], kind: args[args.indexOf('--kind') + 1], state: 'idle' } } });
else if (a === 'agent' && b === 'prompt') { onPrompt(args[3]); out({ result: { status: 'agent_prompted' } }); }
else if (a === 'agent' && b === 'get') { if (process.env.FAKE_HERDR_GET_FAIL) { process.stderr.write('{"error":{"code":"agent_not_found"}}'); process.exit(1); } out({ result: { agent: { name: args[2], state: nextState() } } }); }
else if (a === 'agent' && b === 'wait') out({ result: { state: nextState() } });
else if (a === 'agent' && b === 'read') process.stdout.write(nextRead());
else if (a === 'agent' && b === 'send-keys') out({ result: { sent: args.slice(3) } });
else if (a === 'agent' && b === 'list') out({ result: { agents: process.env.FAKE_HERDR_AGENTS ? JSON.parse(process.env.FAKE_HERDR_AGENTS) : [] } });
else out({ result: {} });
process.exit(0);
