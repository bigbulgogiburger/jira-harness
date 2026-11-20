#!/usr/bin/env node
// herdr-lanes.mjs — Herdr pane 을 하네스의 역할(reviewer · runner · lane · implement)로 쓰는 실행기.
//
// 왜: Workflow 서브에이전트는 안 보이고·세션과 함께 죽고·Claude 모델뿐이다. 리뷰(verify)만큼은 다른 모델이 심판해야 maker≠verifier 가 성립하고,
//     긴 출력(전량 게이트 9~15분·리뷰 본문)은 driver(Claude) 컨텍스트 밖에 있어야 한다. Herdr 안에서는 워크스페이스가 통제면이고 pane 이 역할이다.
//     구현(implement)도 같다 — 메인 Claude 는 오케스트레이션(계약·배정·회수·게이트·커밋)만 하고, 레인은 claude/grok/codex 중 그 일에 맞는 kind 가
//     **자기 worktree** 에서 고친다. 결과는 화면이 아니라 diff(패치)와 사이드카 JSON 으로 돌아온다.
//
// 역할
//   reviewer   codex(기본)·grok pane. **있으면 재사용, 없으면 띄운다**(같은 워크스페이스·같은 kind·idle/done 일 때만 — working 이면 하나 더).
//              컨텍스트는 `herdr.reviewer_context`(issue: 이슈가 바뀌면 /new · always: 매번 · never) 로 비운다.
//   runner     셸 pane. 게이트를 여기서 돌리고 driver 는 완료 표식(GATE_DONE_<nonce>)만 기다린다(또는 --no-wait 로 바로 돌아와 토스트를 받는다).
//   lane       임의 spec(run --spec) — 리뷰 밖 용도.
//   implement  상태 JSON 의 레인 선언(plan 이 만든 lanes[])을 레인마다 **worktree + kind** 로 띄우고, 끝나면 worktree 의 변경을 패치로 회수해
//              메인 체크아웃에 적용한다(`git apply --3way`). 레인은 커밋하지 않는다 — 커밋 권한은 언제나 메인(훅·게이트)이다.
//              배치(herdr.lane_placement) — split(기본): worktree 는 git 이 <runtime>/herdr/worktrees/<slug>/<lane> 에 파고 pane 은 driver **옆 2행 격자**에 쪼갠다(1번 right · 2번 그 아래 · 이후 행 번갈아 right — 새 워크스페이스 없음)
//                                          workspace: `herdr worktree create` 로 레인마다 워크스페이스를 연다
//   ★기동 직후 다이얼로그(codex "Do you trust the contents of this directory?" · 업데이트 안내 · claude teach)는 프롬프트 **전에** 걷는다.
//     그 상태에서 프롬프트를 보내면 글자가 선택키로 먹혀 에이전트가 quit 하고 남은 텍스트가 셸에서 실행된다(2026-09-14 실측). 에이전트가 사라졌으면 절대 입력을 보내지 않는다.
//
// 레인 1개의 절차(startLane → finishLane):
//   1. pane 확보 — 재사용(agent list) / split / worktree(create · 이미 열려 있으면 open 재사용)
//   2. `agent start <name> --kind <kind> --pane <id> -- <kind_args>` (kind 별 네이티브 인자 — Windows codex 는 샌드박스 해제가 필수)
//   3. 프롬프트는 argv 가 아니라 파일로 — `<out>.prompt.md` 를 쓰고 "그 파일을 읽고 따르라" 한 줄만 보낸다.
//      ★보내기 전에 지난 라운드의 `<out>`·`<out>.error.txt` 를 `.prev` 로 치운다 — out 경로는 라운드마다 같아서 남겨 두면 6 이 지난 결과를 이번 것으로 읽는다
//   4. ★제출 확인 — `agent prompt` 의 성공 응답은 제출을 증명하지 않는다(codex·grok 실측). `agent get` 이 working/blocked 로 바뀌었는지 보고,
//      아니면 화면에 남은 프롬프트를 `send-keys enter` 로 밀어 넣는다(1회)
//   5. `agent wait` 로 settled 대기. blocked 면 화면을 읽어 **"Teach auto mode" 다이얼로그일 때만** `esc`(그 외 승인·권한 UI 는 사람 몫).
//      ★settled(idle·done)는 끝이 아니다 — 끝의 신호는 결과 파일 하나다. 제출 직후 남아 있던 idle 에 wait 가 풀리기도 하고, 긴 명령을 돌려 두고 쉬는 레인도 유휴로 보인다.
//      결과 없이 settled 면 settle_grace_s(기본 30 · harness.json herdr.settle_grace_s) 동안 지켜보고, 그래도 유휴면 한 번 알린 뒤(끝났으면 결과를 쓰라) 상한(timeout_s)까지 결과 파일을 기다린다.
//      상한 전에 닫는 것은 에이전트가 사라졌을 때 · blocked · 사용량 한도 화면뿐이다
//   6. ★결과는 화면이 아니라 파일 — 레인이 `<out>` 에 쓴 JSON 을 읽는다(alt-screen 스크롤백은 회수되지 않는다). **제출 뒤에 생긴 파일만** 결과다. 없으면 failed
//   7. `close_panes` 면 pane 을 닫는다(기본 false — 사람이 화면을 본다). 재사용한 pane 은 닫지 않는다
//   spec 의 레인들은 **전부 띄운 뒤 기다린다**(spec.parallel 기본 true) — 레인이 셋이면 벽시계는 셋의 최대값이다.
//
// 사용:
//   node herdr-lanes.mjs codex-review [--since <tree>] [--diff-ref <ref>] [--files a,b] [--slug s] [--kind codex] [--cwd] [--json]
//       → 마지막 줄 CODEX_RESULT={"status":"ok|limit|fail|missing",…} (codex-review.sh 와 같은 계약 — 라우터는 구분하지 않는다)
//   node herdr-lanes.mjs verify|plan --diff-ref <ref> --files a,b --slug s [--kinds codex,grok] [--axes "…"] [--cwd] [--json]
//       → harness.json.herdr.kinds.verify 레인들을 돌려 findings 를 verify.js 모양으로 합친다
//   node herdr-lanes.mjs implement [--slug s] [--lanes a,b] [--contracts-file <md>] [--fresh] [--no-apply] [--dry-run] [--harvest] [--cwd] [--json]
//       → 상태 JSON lanes[] 를 worktree 레인으로 돌리고 패치를 회수·적용한다. 레인 기록은 issue-set.mjs --lane 으로 상태 JSON 에 남긴다
//         --harvest: 레인을 띄우지 않고 이미 있는 결과 파일·레인 작업트리만 회수·적용한다(실행기가 먼저 죽었거나 시간 초과 뒤에 결과가 온 경우 · Herdr 밖에서도 된다)
//   상태·결과·장부·패치(runtime)는 작업트리 세션에서 불러도 메인 저장소의 runtime 에 둔다. 레인의 시작점·패치를 적용할 곳은 지금 일하는 트리다.
//   node herdr-lanes.mjs gate --full|--related|--dod|--main|--commit [--stage-all] [--no-wait] [--cwd] [--json]
//       → runner pane 에서 gate.mjs 를 돌린다. 기록·토스트는 gate.mjs 가 한다
//   node herdr-lanes.mjs run --spec <spec.json> [--cwd] [--json]
//       spec = { lanes: [{ name, kind, prompt | prompt_file, out, cwd?, worktree_branch?, placement?: split|workspace, worktree_dir?, args?[], reuse?, fresh? }], timeout_s?, settle_grace_s?, close_panes?, parallel?, auto_trust? }
// 종료 코드: 0 (레인 실패는 결과 JSON 의 status 로 본다 — 리뷰 레인이 죽었다고 라우터를 죽이지 않는다) · 2 사용법/설정
// Herdr 밖(HERDR_PANE_ID 없음)이면 status:"failed" reason:"outside herdr" — 라우터는 그때 exec/Workflow 경로로 돌아간다.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { locateProject, loadConfig, branchSlug, statePath, readState } from './lib/config.mjs';
import { currentBranch, git } from './lib/git.mjs';
import { herdr, herdrEnv, herdrConfig, herdrPing } from './lib/herdr.mjs';
import { laneName, herdrImplementOn, laneBranch, laneLedgerFile, lanePatchFile, laneWorktreeRoot } from './lib/lanes.mjs';
import { listWorktrees, prepareWorktree, removeWorktree, removeDirSafely, harvestWorktree } from './lib/worktree.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv.find(a => !a.startsWith('--'));
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const asJson = flag('--json');
const cwd = resolve(opt('--cwd') ?? process.cwd());
function fail(code, msg) { console.error(`[herdr-lanes] ${msg}`); process.exit(code); }
function fwd(p) { return String(p).replace(/\\/g, '/'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function readJson(p) { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } }
function writeJson(p, v) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8'); }
function sameDir(a, b) { return a && b && fwd(resolve(a)).toLowerCase() === fwd(resolve(b)).toLowerCase(); }
export { laneName }; // 규칙은 lib/lanes.mjs — 계획 점검이 같은 규칙으로 이름 겹침을 본다

/** kind 별 기본 네이티브 인자 — 실측 함정을 기본값으로 박는다. harness.json.herdr.kind_args 가 덮어쓴다 */
export const DEFAULT_KIND_ARGS = {
  codex: process.platform === 'win32' ? ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'] : ['--ask-for-approval', 'never'],
  // claude: acceptEdits 는 worktree 밖(런타임 디렉토리의 프롬프트 파일) 읽기와 Bash(테스트 실행)마다 승인 UI 를 띄워 레인이 멈춘다
  //   (2026-09-14 실측 — 두 레인이 "Do you want to proceed?" 에서 30분 대기). 레인은 격리 worktree 에서만 일하고 커밋하지 않으므로 bypassPermissions.
  claude: ['--permission-mode', 'bypassPermissions'],
  grok: [],
};
/** Codex 판정 모델·effort(review.codex_model·codex_effort) → codex 네이티브 인자. codex 가 아닌 kind 나 미설정이면 [] — codex 기본값을 쓴다(codex-review.sh 와 같은 규칙) */
export function reviewModelArgs(cfg, kind) {
  if (kind !== 'codex') return [];
  const { codex_model: m, codex_effort: e } = cfg.review ?? {};
  return [...(m ? ['--model', m] : []), ...(e ? ['-c', `model_reasoning_effort=${e}`] : [])];
}
/**
 * kind 별 "무엇을 맡기나" 한 줄 — plan 이 레인에 kind 를 고를 때 읽는 재료. harness.json.herdr.kinds.profiles 가 덮어쓴다.
 * ⚠ 이것은 **가설**이지 측정치가 아니다. 어느 kind 가 어느 일을 잘하는지는 레인 기록(상태 JSON lanes[].result 의 kind·status·tests·seconds)이
 *   쌓여야 말할 수 있다 — 표에 박아 두면 그대로 규약이 되므로, 근거가 생기기 전까지는 설정으로 바꿀 수 있는 기본값에 둔다.
 */
export const DEFAULT_KIND_PROFILES = {
  claude: '여러 파일에 걸친 계약·문맥을 맞추는 변경, 저장소 규약·문서를 따르는 일(이 하네스의 스킬·훅이 Claude 기준으로 쓰였다)',
  codex: '범위가 닫힌 구현을 테스트 실행과 함께 끝까지 미는 일, 실측이 필요한 진단(설정·훅·빌드)',
  grok: '작고 빠른 변경, 탐색적 시도(근거 가장 얇음 — 레인 기록으로 채운다)',
};
const TEACH_DIALOG = /teach auto mode|teach .* about your environment/i;
// claude 기동 직후 프로젝트 .mcp.json 이 있으면 "MCP servers … Do you want to use them?" — enter(기본 Yes). 이 위에 프롬프트를 보내면 글자만 남고 제출되지 않는다(2026-09-14 실측).
const MCP_DIALOG = /mcp server|use these mcp|\.mcp\.json/i;
const INPUT_READY = /❯|>\s*$/m;
const UPDATE_DIALOG = /update now|skip/i;
// codex 기동 직후 "Do you trust the contents of this directory?" — 새 worktree 마다 뜬다(신뢰는 저장소 루트 단위인데 임시·새 저장소면 루트도 미신뢰).
// ★이 상태에서 프롬프트를 보내면 글자가 선택키로 먹혀 codex 가 quit 하고, 남은 텍스트가 **셸에서 실행된다**(2026-09-14 실측). 그래서 프롬프트 전에 반드시 걷는다.
const TRUST_DIALOG = /do you trust the contents of this directory|trusting the directory allows|trust the contents of this/i;
const LIMIT_PATTERN = /usage limit|rate limit|quota|exceeded your|too many requests/i;

function agentState(name, env) {
  const r = herdr(['agent', 'get', name], { cwd, env, timeout: 5000 });
  if (!r.ok) return null;
  const a = r.value?.result?.agent ?? r.value?.result ?? r.value;
  return a?.state ?? a?.status ?? a?.agent_status ?? null;
}
function screen(name, env, lines = 40) {
  const r = herdr(['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', String(lines)], { cwd, env, timeout: 5000 });
  return r.ok ? (r.out ?? '') : '';
}
const READY = new Set(['idle', 'done']);
// 화면 판정용 정규화 — codex 입력창은 스피너 점자(U+2800~)가 글자 사이에 끼어 "Read the⠄file" 로 보인다(실측). 점자를 걷고 공백을 접는다
function cleanScreen(s) { return String(s ?? '').replace(/[⠀-⣿]/g, '').replace(/\s+/g, ' '); }
const PROMPT_TOKEN = 'do exactly what it says'; // 제출 문장에 항상 들어가는 고정 토큰 — 입력창에 이게 남아 있으면 미제출
function promptStillTyped(name, env) { return cleanScreen(screen(name, env, 12)).includes(PROMPT_TOKEN); }
function paneTail(pane, env, lines = 15) {
  const r = herdr(['pane', 'read', pane, '--lines', String(lines)], { cwd, env, timeout: 5000 });
  return r.ok ? (r.out ?? '').slice(-600) : '';
}

/** `<out>` → 지난 라운드 보존 경로. a.json → a.prev.json */
function prevPath(out) { return /\.json$/i.test(out) ? out.replace(/\.json$/i, '.prev.json') : `${out}.prev`; }
/**
 * 지난 라운드의 결과·오류 파일을 치운다. out 경로는 라운드마다 같아서(<slug>.herdr-<kind>.json) 남겨 두면 wait 가 풀린 직후 그 파일을
 * 이번 결과로 읽는다(2026-09-23 실측: 델타 리뷰가 23초 만에 지난 라운드 findings 를 반환). 지우지 않고 `.prev` 로 1벌 보존한다.
 * 못 옮기면(잠김) 지우고, 그것도 못 하면 finishLane 이 그 파일이 다시 쓰였을 때만 읽는다(isNew). 반환 = 치운 경로들
 */
export function setAsidePrevious(out) {
  const moved = [];
  for (const [from, to] of [[out, prevPath(out)], [`${out}.error.txt`, `${prevPath(out)}.error.txt`]]) {
    if (!existsSync(from)) continue;
    try { rmSync(to, { force: true }); renameSync(from, to); moved.push(fwd(to)); }
    catch { try { rmSync(from, { force: true }); moved.push(`(삭제) ${fwd(from)}`); } catch { /* isNew 가 막는다 */ } }
  }
  return moved;
}
function mtimeOf(p) { try { return statSync(p).mtimeMs; } catch { return null; } }
/**
 * 이번 결과인가 — 제출 때 없던 파일이면 존재만으로, (못 치워서) 남아 있던 파일이면 그 뒤에 다시 쓰였을 때만(leftover = 제출 때의 mtime).
 * 제출 시각과 비교하지 않는다 — 에이전트가 파일을 복사해 만들면 mtime 이 원본 것이라(Windows copy 는 시각을 보존한다) 새 결과를 지난 것으로 오판한다
 */
function isNew(p, leftover) { const m = mtimeOf(p); return m != null && (leftover == null || m > leftover); }
/**
 * settled 인데 이번 결과가 없을 때 until(ms epoch)까지 지켜본다 — 'file'(결과가 생겼다) · 'working'(일을 한다 — 다시 기다린다) · 'gone'(에이전트가 사라졌다) · 'idle'(끝까지 유휴).
 * 유휴가 끝을 뜻하지 않는 형태가 둘 있다: 제출 직후 남아 있던 idle 에 `agent wait` 가 곧바로 풀린다(2026-09-23 실측: 레인 18.4초에 "결과 파일 없음", 에이전트는 8분 뒤 결과를 썼다) ·
 * 긴 명령을 돌려 두고 턴을 끝낸 채 완료를 기다린다(그동안 상태는 idle 이고 결과는 몇 분 뒤에 온다).
 * 상태 조회 한 번의 실패를 "사라졌다" 로 읽지 않는다 — 잠깐 뒤에 한 번 더 본다.
 */
async function watchIdle(name, env, hasResult, until) {
  let gap = 1000;
  while (Date.now() < until) {
    await sleep(Math.max(200, Math.min(gap, until - Date.now())));
    if (hasResult()) return 'file';
    let s = agentState(name, env);
    if (s == null) { await sleep(1500); if (hasResult()) return 'file'; s = agentState(name, env); if (s == null) return 'gone'; }
    if (s === 'working' || s === 'blocked') return 'working';
    gap = Math.min(10000, gap * 2);
  }
  return hasResult() ? 'file' : 'idle';
}
// 결과 없이 유휴인 레인에 한 번 보내는 알림. 끝났는데 결과를 안 쓴 레인은 이걸 받고 쓰고, 돌려 둔 명령을 기다리는 레인은 계속 기다린다
const REMIND_TOKEN = 'result file is still missing';
function remindText(out) { return `The ${REMIND_TOKEN}: ${fwd(out)}. If your work is finished, write the result JSON there now. If you are waiting for a command you started, keep waiting and write the file when it finishes.`; }

/**
 * 기동 직후 다이얼로그 사다리 — 프롬프트를 보내기 *전에* 화면을 읽어 알려진 다이얼로그만 걷는다(최대 4회).
 *   디렉터리 신뢰(codex) → enter(1. Yes 가 기본 선택 — 레인 cwd 는 언제나 이 하네스 프로젝트 자신 또는 그 worktree) · autoTrust=false 면 blocked
 *   업데이트 안내(codex "1.Update now / 2.Skip") → down+enter(Skip) · teach(claude) → esc
 * 승인·권한 UI 는 여기서 답하지 않는다. 에이전트가 사라졌으면(gone) 호출자는 프롬프트를 보내면 안 된다 — 그 입력은 셸로 간다.
 */
async function settleStartupDialogs(name, env, { autoTrust = true } = {}) {
  const seen = [];
  for (let i = 0; i < 12; i++) {
    const state = agentState(name, env);
    if (state == null) return { seen, gone: true };
    if (state === 'working') break;
    const s = screen(name, env, 25);
    if (MCP_DIALOG.test(s) && /do you want|use them|1\. yes/i.test(s)) { herdr(['agent', 'send-keys', name, 'enter'], { cwd, env }); seen.push('mcp'); }
    else if (TRUST_DIALOG.test(s)) {
      if (!autoTrust) return { seen, blocked: 'trust', screen: s };
      herdr(['agent', 'send-keys', name, 'enter'], { cwd, env }); seen.push('trust');
    } else if (/update now/i.test(s) && UPDATE_DIALOG.test(s)) { herdr(['agent', 'send-keys', name, 'down', 'enter'], { cwd, env }); seen.push('update'); }
    else if (TEACH_DIALOG.test(s)) { herdr(['agent', 'send-keys', name, 'esc'], { cwd, env }); seen.push('teach'); }
    else if (!INPUT_READY.test(s) && i < 8) { await sleep(2000); continue; } // 아직 UI 가 안 그려졌다 — 빈 화면을 "다이얼로그 없음" 으로 읽지 않는다
    else break;
    await sleep(2000);
  }
  return { seen };
}

/** 살아 있는 에이전트 중 재사용할 것 — 이름이 같거나(kind 같고 · cwd 같고 · idle/done) */
export function findReusable(lane, workDir, env) {
  const r = herdr(['agent', 'list'], { cwd, env, timeout: 5000 });
  const agents = r.ok ? (r.value?.result?.agents ?? []) : [];
  const norm = a => ({ name: a.name ?? null, kind: a.agent ?? a.kind ?? null, state: a.agent_status ?? a.state ?? null, pane: a.pane_id ?? null, cwd: a.cwd ?? null });
  const list = agents.map(norm);
  const byName = list.find(a => a.name === lane.name);
  if (byName) return READY.has(byName.state) ? byName : { ...byName, busy: true };
  if (lane.worktree_branch) return null; // worktree 레인은 이름으로만 — 다른 레인의 pane 을 kind 가 같다고 빼앗지 않는다
  const byKind = list.find(a => a.kind === lane.kind && READY.has(a.state) && sameDir(a.cwd, workDir));
  return byKind ?? null;
}

// ---------------------------------------------------------------- worktree

/** `herdr worktree list` 에서 이 브랜치의 체크아웃 — {path, workspace} · 없으면 null */
function findWorktree(branch, repoDir, env) {
  const r = herdr(['worktree', 'list', '--cwd', repoDir], { cwd, env, timeout: 15000 });
  const list = r.ok ? (r.value?.result?.worktrees ?? []) : [];
  const w = list.find(x => x.branch === branch);
  return w ? { path: fwd(w.path), workspace: w.open_workspace_id ?? null } : null;
}
/** 브랜치가 있고 HEAD 에 없는 커밋이 없으면(레인은 커밋하지 않으므로 보통 그렇다) 지운다 — 낡은 베이스로 다시 체크아웃되는 것을 막는다 */
function dropStaleBranch(branch, repoDir) {
  const has = git(['show-ref', '--verify', '-q', `refs/heads/${branch}`], { cwd: repoDir, allowFail: true });
  if (has.status !== 0) return { existed: false };
  const anc = git(['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd: repoDir, allowFail: true });
  if (anc.status !== 0) return { existed: true, kept: true, reason: `브랜치 ${branch} 에 HEAD 에 없는 커밋이 있어 지우지 않았다` };
  const d = git(['branch', '-D', branch], { cwd: repoDir, allowFail: true });
  return { existed: true, dropped: d.status === 0 };
}
/** worktree 응답에서 pane·path·workspace 를 읽는다(create·open 공통 모양 — 실측 0.9.x) */
function worktreeInfo(value) {
  const r = value?.result ?? {};
  const pane = r.root_pane?.pane_id ?? r.pane?.pane_id ?? null;
  const path = r.worktree?.path ?? r.workspace?.worktree?.checkout_path ?? r.root_pane?.cwd ?? null;
  return { pane, path: path ? fwd(path).replace(/\/+$/, '') : null, workspace: r.workspace?.workspace_id ?? r.root_pane?.workspace_id ?? null, alreadyOpen: !!r.already_open };
}
/**
 * worktree 레인의 pane — 순서: ① 브랜치 체크아웃이 이미 열려 있으면 open(already_open) 으로 그 pane ② `fresh` 면 있던 체크아웃을 지우고 ③ 없으면 create.
 * 낡은 브랜치(HEAD 에 없는 커밋 0)는 create 전에 지운다 — 그대로 두면 create 가 옛 베이스를 체크아웃한다(실측).
 */
function acquireWorktree(lane, repoDir, env, { fresh = false, prep = null } = {}) {
  const branch = lane.worktree_branch;
  const existing = findWorktree(branch, repoDir, env);
  if (existing && fresh && existing.workspace) {
    const rm = herdr(['worktree', 'remove', '--workspace', existing.workspace, '--force'], { cwd, env, timeout: 30000 });
    if (!rm.ok) return { error: `worktree remove 실패(fresh): ${rm.reason}` };
  } else if (existing) {
    const op = herdr(['worktree', 'open', '--cwd', repoDir, '--branch', branch, '--label', lane.name, '--no-focus'], { cwd, env, timeout: 30000 });
    if (op.ok) { const w = worktreeInfo(op.value); if (w.pane && w.path) return { ...w, mode: w.alreadyOpen ? 'already-open' : 'opened' }; }
    return { error: `worktree open 실패: ${op.reason ?? 'pane/path 없음'}` };
  }
  const stale = dropStaleBranch(branch, repoDir);
  if (stale.kept) return { error: stale.reason };
  const cr = herdr(['worktree', 'create', '--cwd', repoDir, '--branch', branch, '--label', lane.name, '--no-focus'], { cwd, env, timeout: 60000 });
  if (!cr.ok) return { error: `worktree create 실패: ${cr.reason}` };
  const w = worktreeInfo(cr.value);
  if (!w.pane || !w.path) return { error: 'worktree create 응답에서 pane/path 를 못 읽음' };
  const prepared = prep ? prepareWorktree(w.path, { repoDir, env, ...prep }) : null;
  return { ...w, mode: 'created', prepared, dropped_stale: !!stale.dropped, placement: 'workspace' };
}

/** `git worktree list --porcelain` 에서 이 브랜치의 체크아웃 경로 — split 배치용(Herdr 워크스페이스가 아니라 git 이 정본) */
function localWorktree(branch, repoDir) {
  const w = listWorktrees(repoDir).find(x => x.branch === branch);
  return w ? { path: w.path } : null;
}

// ---------------------------------------------------------------- 레인 pane 격자 배치
// 레인 pane 을 driver 오른쪽 한 줄로만 쪼개지 않는다(오너 지시 2026-09-14 — "세로로만 만들지 말고 밑에도 배치").
// 규칙: 1번 레인 = driver 오른쪽(row0) · 2번 = 그 아래(row1) · 그 뒤로는 row0/row1 을 번갈아 **그 행의 마지막 pane 오른쪽**.
// driver 열은 세로 전체를 유지하고 레인들은 오른쪽에 2행 격자로 쌓인다. 상태는 한 프로세스(run/implement/verify 한 번) 안에서만 산다.
const laneGrid = { rows: [[], []], n: 0 };
export function resetLaneGrid() { laneGrid.rows = [[], []]; laneGrid.n = 0; }
function laneSplitSlot(h) {
  const i = laneGrid.n++;
  const driver = h.pane ? ['--pane', h.pane] : ['--current'];
  if (i === 0) return { anchor: driver, direction: 'right', row: 0 };
  const row0 = laneGrid.rows[0];
  if (i === 1 && row0.length) return { anchor: ['--pane', row0[row0.length - 1]], direction: 'down', row: 1 };
  const row = i % 2;
  const last = laneGrid.rows[row][laneGrid.rows[row].length - 1];
  if (!last) return { anchor: driver, direction: row === 1 ? 'down' : 'right', row }; // 앞 레인이 pane 을 못 만든 경우 — driver 기준으로 복귀
  return { anchor: ['--pane', last], direction: 'right', row };
}
/** 격자 규칙대로 pane 을 하나 쪼개고 자리를 기록한다 — {pane, workspace, direction} | {error} */
function splitLanePane(h, path, env) {
  const slot = laneSplitSlot(h);
  const r = herdr(['pane', 'split', ...slot.anchor, '--direction', slot.direction, '--cwd', path, '--no-focus'], { cwd, env, timeout: 15000 });
  if (!r.ok) return { error: `pane split 실패: ${r.reason}` };
  const pane = r.value?.result?.pane?.pane_id ?? null;
  if (!pane) return { error: 'pane id 를 응답에서 못 읽음' };
  laneGrid.rows[slot.row].push(pane);
  return { pane, workspace: r.value?.result?.pane?.workspace_id ?? null, direction: slot.direction };
}
/**
 * split 배치(기본) — worktree 는 git 이 `<worktree_dir>/<lane>` 에 직접 파고, pane 은 **지금 워크스페이스의 driver 옆 격자**에 쪼갠다(새 워크스페이스를 열지 않는다 · 자리는 splitLanePane).
 * 순서: ① 브랜치 체크아웃이 이미 있으면 그 경로(existing · fresh 면 `git worktree remove --force` 뒤 새로) ② 낡은 브랜치는 지우고 ③ `git worktree add -b` ④ pane split --cwd <경로>.
 */
function acquireLocalWorktree(lane, repoDir, env, { fresh = false, prep = null, dir }) {
  const branch = lane.worktree_branch;
  let existing = localWorktree(branch, repoDir);
  if (existing && fresh) {
    // 링크를 먼저 끊고 지운다(lib/worktree.mjs) — 준비 명령이 걸어 둔 링크를 따라 메인 쪽 폴더가 지워지거나, 폴더가 남은 채 성공으로 끝나는 것을 막는다
    const rm = removeWorktree(existing.path, { repoDir, force: true });
    if (!rm.ok) return { error: `작업트리 제거 실패(fresh): ${rm.reason}` };
    existing = null;
  }
  let path, mode, prepared = null, droppedStale = false;
  if (existing) { path = existing.path; mode = 'existing'; }
  else {
    const stale = dropStaleBranch(branch, repoDir);
    if (stale.kept) return { error: stale.reason };
    droppedStale = !!stale.dropped;
    path = fwd(resolve(repoDir, dir, laneName(lane.lane ?? lane.name)));
    if (existsSync(path)) { // 등록 안 된 잔재 — 같은 이유로 링크부터 끊고 지운다
      git(['worktree', 'prune'], { cwd: repoDir, allowFail: true });
      const left = removeDirSafely(path);
      if (!left.ok) return { error: `남은 폴더를 지우지 못했다(${path}): ${left.reason}` };
    }
    mkdirSync(dirname(path), { recursive: true });
    const add = git(['worktree', 'add', '-q', '-b', branch, path, 'HEAD'], { cwd: repoDir, allowFail: true });
    if (add.status !== 0) return { error: `git worktree add 실패: ${add.err}` };
    mode = 'created';
    prepared = prep ? prepareWorktree(path, { repoDir, env, ...prep }) : null;
  }
  const s = splitLanePane(herdrEnv(env), path, env);
  if (s.error) return { error: s.error };
  return { pane: s.pane, path, workspace: s.workspace, mode, prepared, dropped_stale: droppedStale, placement: 'split', direction: s.direction };
}

// ---------------------------------------------------------------- lane

/**
 * 레인을 띄우고 프롬프트를 제출한다(1~4). 절대 throw 하지 않는다.
 * 반환 ctx — { res, done:true } 면 이미 끝난 것(실패·busy), 아니면 finishLane 으로 기다린다.
 */
export async function startLane(lane, { env = process.env, kindArgs = {}, laneCwd, fresh = false, prep = null, autoTrust = true } = {}) {
  const t0 = Date.now();
  const res = { name: lane.name, kind: lane.kind, status: 'failed', pane: null, out: fwd(lane.out), seconds: 0, reused: false };
  const ctx = { lane, res, env, t0, name: lane.name, pane: null, done: false };
  const finish = (patch) => { Object.assign(res, patch); res.seconds = +((Date.now() - t0) / 1000).toFixed(1); ctx.done = true; return ctx; };
  const h = herdrEnv(env);
  if (!h.inside) return finish({ reason: 'outside herdr' });
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(lane.name)) return finish({ reason: `레인 이름 형식 오류: ${lane.name} (Herdr 규칙 [a-z][a-z0-9_-]{0,31})` });
  const workDir = lane.cwd ?? laneCwd ?? cwd;
  const name = lane.name;

  // 1. pane — 재사용 / split / worktree
  let pane = null;
  if (lane.reuse !== false) {
    const found = findReusable(lane, workDir, env);
    if (found?.busy) return finish({ status: 'busy', reason: `${lane.name} 이 이미 working 상태 — 끝나길 기다리거나 다른 이름으로 하나 더 띄울 것`, pane: found.pane });
    if (found && fresh && lane.worktree_branch) {
      // worktree 를 새로 파야 하는데 지난 레인 pane 이 그 디렉터리에 앉아 있다 — Windows 는 cwd 점유 중인 디렉터리를 못 지운다. pane 을 닫고 새로 띄운다
      herdr(['pane', 'close', found.pane], { cwd, env, timeout: 5000 }); await sleep(1000); res.closed_previous = found.pane;
    } else if (found) {
      pane = found.pane; res.reused = true;
      if (found.name !== lane.name) herdr(['agent', 'rename', pane, lane.name], { cwd, env, timeout: 5000 });
      if (lane.fresh) { herdr(['agent', 'prompt', name, '/new'], { cwd, env, timeout: 15000 }); await sleep(1500); res.fresh = true; }
      if (lane.worktree_branch) {
        const wt = lane.placement === 'workspace' ? findWorktree(lane.worktree_branch, workDir, env) : localWorktree(lane.worktree_branch, workDir);
        res.worktree = { branch: lane.worktree_branch, path: wt?.path ?? found.cwd ?? null, workspace: wt?.workspace ?? null, mode: 'reused-agent', placement: lane.placement ?? 'split' };
      }
    }
  }
  if (!pane) {
    if (lane.worktree_branch) {
      const w = lane.placement === 'workspace'
        ? acquireWorktree(lane, workDir, env, { fresh, prep })
        : acquireLocalWorktree(lane, workDir, env, { fresh, prep, dir: lane.worktree_dir ?? '.herdr-lanes' });
      if (w.error) return finish({ reason: w.error });
      pane = w.pane;
      res.worktree = { branch: lane.worktree_branch, path: w.path, workspace: w.workspace, mode: w.mode, placement: w.placement, ...(w.prepared ? { prepared: w.prepared } : {}), ...(w.dropped_stale ? { dropped_stale: true } : {}) };
    } else {
      const s = splitLanePane(h, workDir, env);
      if (s.error) return finish({ reason: s.error });
      pane = s.pane; res.split = s.direction;
    }
    if (!pane) return finish({ reason: 'pane id 를 응답에서 못 읽음' });
    res.pane = pane;
    herdr(['pane', 'rename', pane, `lane:${lane.name}`], { cwd, env, timeout: 5000 });

    // 2. agent start
    const nativeArgs = lane.args ?? kindArgs[lane.kind] ?? DEFAULT_KIND_ARGS[lane.kind] ?? [];
    let st = herdr(['agent', 'start', lane.name, '--kind', lane.kind, '--pane', pane, '--timeout', '60000', ...(nativeArgs.length ? ['--', ...nativeArgs] : [])], { cwd, env, timeout: 75000 });
    if (!st.ok && /agent_not_ready/.test(st.reason ?? '')) {
      // 기동 직후 업데이트 안내(codex "1.Update now / 2.Skip") — Skip 만 골라 준다. 그 외 다이얼로그는 사람 몫
      const s = screen(lane.name, env, 20);
      if (UPDATE_DIALOG.test(s)) { herdr(['agent', 'send-keys', lane.name, 'down', 'enter'], { cwd, env }); await sleep(2000); st = { ok: agentState(lane.name, env) != null }; }
    }
    if (!st.ok) return finish({ reason: `agent start 실패: ${st.reason}`, screen_tail: screen(lane.name, env, 15).slice(-600) });
    // 기동 직후 다이얼로그 — 프롬프트를 보내기 전에 걷는다(신뢰·업데이트·teach). 사라졌으면 여기서 끝: 셸에 입력을 보내지 않는다
    const d = await settleStartupDialogs(lane.name, env, { autoTrust });
    if (d.seen.length) res.dialogs = d.seen;
    if (d.gone) return finish({ pane, reason: '에이전트가 기동 직후 종료됐다(pane 이 셸로 돌아옴) — 프롬프트를 보내지 않았다. pane 화면을 볼 것', screen_tail: paneTail(pane, env) });
    if (d.blocked) return finish({ pane, status: 'blocked', reason: `codex 디렉터리 신뢰 다이얼로그 — herdr.auto_trust=false 라 사람이 답한다(pane ${pane})`, screen_tail: (d.screen ?? '').slice(-600) });
  }
  res.pane = pane; ctx.pane = pane;
  // 프롬프트를 보내기 직전 생존 확인 — 재사용한 에이전트가 그새 죽었을 수도 있다. 죽은 pane 에 보낸 글은 셸 명령이 된다
  if (agentState(name, env) == null) return finish({ reason: `에이전트 ${name} 이 없다(종료됨) — 프롬프트를 보내지 않았다`, screen_tail: paneTail(pane, env) });

  // 3. 지난 라운드 결과를 치우고(setAsidePrevious) 프롬프트 파일 — prompt_of(worktreePath) 는 pane 을 잡은 뒤에야 경로를 알 수 있는 레인(implement)용
  const setAside = setAsidePrevious(resolve(lane.out));
  if (setAside.length) res.set_aside = setAside;
  ctx.leftover = { out: mtimeOf(resolve(lane.out)), err: mtimeOf(`${resolve(lane.out)}.error.txt`) }; // 보통 둘 다 null — 못 치운 파일이 있으면 그 시각
  const promptText = lane.prompt ?? (typeof lane.prompt_of === 'function' ? lane.prompt_of(res.worktree?.path ?? workDir) : lane.prompt_file ? readFileSync(resolve(lane.prompt_file), 'utf8') : '');
  if (!promptText.trim()) return finish({ reason: '프롬프트가 비었다' });
  const promptFile = resolve(`${lane.out}.prompt.md`);
  mkdirSync(dirname(promptFile), { recursive: true });
  const full = `${promptText.trim()}\n\n---\n결과 규약(반드시):\n- 결과 JSON 을 파일 \`${fwd(resolve(lane.out))}\` 에 쓴다(UTF-8, 그 파일이 유일한 산출물 — 화면 출력은 회수되지 않는다).\n- 다 쓰면 마지막 줄에 \`DONE ${fwd(resolve(lane.out))}\` 만 출력하고 멈춘다. 파일을 못 쓰면 이유를 \`${fwd(resolve(lane.out))}.error.txt\` 에 쓴다.\n- 사용량 한도·요금 한도에 걸려 일을 못 하면 파일에 \`{"status":"limit","summary":"<사유>"}\` 만 쓴다 — 한도를 감추고 빈 findings 를 내지 않는다.\n`;
  writeFileSync(promptFile, full, 'utf8');
  const submit = `Read the file ${fwd(promptFile)} and do exactly what it says. The only deliverable is the JSON file it names.`;

  // 4. 제출 + 확인
  const pr = herdr(['agent', 'prompt', name, submit], { cwd, env, timeout: 30000 });
  if (!pr.ok && !/agent_blocked/.test(pr.reason ?? '')) return finish({ reason: `agent prompt 실패: ${pr.reason}` });
  let state = null; let nudged = false;
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    state = agentState(name, env);
    if (state == null) return finish({ reason: '제출 뒤 에이전트가 사라졌다 — pane 이 셸로 돌아왔다(입력이 셸로 갔을 수 있다). pane 화면을 볼 것', screen_tail: paneTail(pane, env) });
    if (state === 'working' || state === 'blocked') break;
    if (i === 2 && !nudged && (state === 'idle' || state === 'done' || state === 'unknown')) {
      // 텍스트만 들어가고 제출이 안 된 형태(codex·grok 실측) — 화면에 우리 문장이 남아 있으면 enter 한 번
      if (promptStillTyped(name, env)) { herdr(['agent', 'send-keys', name, 'enter'], { cwd, env }); nudged = true; }
    }
  }
  // 6초가 지나도 안 움직였고 아직 안 밀어 넣었으면 마지막으로 한 번 — 이 뒤는 finishLane 의 wait 가 본다
  if (!nudged && state !== 'working' && state !== 'blocked' && promptStillTyped(name, env)) { herdr(['agent', 'send-keys', name, 'enter'], { cwd, env }); nudged = true; }
  res.nudged = nudged;
  return ctx;
}

/** 띄운 레인을 끝까지 기다리고 결과 파일을 읽는다(5~7). deadline(ms epoch) 이 있으면 남은 시간만 기다린다 */
export async function finishLane(ctx, { timeoutS = 900, closePanes = false, deadline = null, settleGraceS = 30 } = {}) {
  const { lane, res, env, name, pane, t0 } = ctx;
  if (ctx.done) return res;
  const done = (patch) => { Object.assign(res, patch); res.seconds = +((Date.now() - t0) / 1000).toFixed(1); return res; };
  const end = deadline ?? Date.now() + timeoutS * 1000;
  const waitMs = () => Math.max(5000, end - Date.now());
  const outPath = resolve(lane.out);
  const errFile = `${outPath}.error.txt`;
  const left = ctx.leftover ?? {};
  const hasResult = () => isNew(outPath, left.out) || isNew(errFile, left.err);
  let state = null;

  // 5. 끝의 신호는 결과 파일 하나다 — settled(idle·done)는 끝이 아니다.
  //    긴 명령(테스트)을 돌려 두고 턴을 끝낸 채 완료를 기다리는 레인은 그동안 유휴로 보이고 결과는 몇 분 뒤에 온다. 유휴 30초에 "결과 파일 없음" 으로 닫았던
  //    레인들이 그 뒤에 결과를 썼다 — 일은 끝났는데 패치는 적용되지 않았다. 그래서 결과 없이 settled 면 settleGraceS 동안 지켜보고, 그래도 유휴면 한 번 알리고
  //    (끝났으면 결과를 쓰고, 기다리는 중이면 계속 기다리라), 그 뒤로는 상한(end)까지 결과 파일을 기다린다.
  //    상한 전에 닫는 것은 셋뿐이다 — 에이전트가 사라졌다 · 승인/질문 UI 에서 멈췄다(blocked) · 알린 뒤에도 유휴인데 화면이 사용량 한도다.
  //    (한도 문구는 알리기 전에는 닫는 근거로 쓰지 않는다 — 기다리는 레인의 마지막 말에 같은 단어가 있을 수 있다. 알린 뒤의 화면 꼬리는 알림과 그 답이다.)
  //    (teach 다이얼로그만 자동 esc 1회 · 곧바로 settled 됐는데 입력창에 제출 문장이 그대로면 enter 1회)
  //    결과가 이미 있어도 바퀴는 `agent wait` 로 시작한다 — 턴이 끝난 뒤에 읽어야 쓰는 도중의 파일이나 아직 손대고 있는 작업트리를 건드리지 않는다.
  //    lane.idle_cap_s 가 있으면(리뷰 레인) 알린 뒤 그만큼 유휴가 이어질 때 닫는다 — 리뷰어는 명령을 돌려 두고 기다릴 일이 없어 유휴는 멈춘 것이다.
  let escaped = false; let renudged = false; let reminded = false; let rewaits = 0; let stop = null;
  let idleSince = null; // 알린 뒤 유휴가 이어지기 시작한 때
  const idleCapS = Number.isFinite(lane.idle_cap_s) ? lane.idle_cap_s : null;
  const watchMs = Math.max(1, settleGraceS) * 1000;
  for (;;) {
    const ms = waitMs();
    const w = herdr(['agent', 'wait', name, '--timeout', String(ms)], { cwd, env, timeout: ms + 5000 });
    state = w.ok ? (w.value?.result?.state ?? w.value?.result?.agent?.state ?? agentState(name, env)) : agentState(name, env);
    if (!w.ok && /timeout/i.test(w.reason ?? '')) {
      // 상한까지 일하고 있다. 그래도 결과가 와 있으면 읽는다 — 끝의 신호는 결과 파일이고, 같은 상한을 나눠 쓰는 뒤쪽 레인은 남은 시간이 거의 없이 여기에 온다
      if (hasResult()) break;
      return done({ reason: `레인 시간 초과 ${timeoutS}s`, state, screen_tail: screen(name, env, 15).slice(-600) });
    }
    if (state === 'blocked') {
      const s = screen(name, env, 25);
      if (!escaped && TEACH_DIALOG.test(s)) { herdr(['agent', 'send-keys', name, 'esc'], { cwd, env }); escaped = true; await sleep(1000); continue; }
      return done({ status: 'blocked', reason: '에이전트가 승인/질문 UI 에서 멈춤 — 사람이 pane 을 볼 것', state, screen_tail: s.slice(-600) });
    }
    if (hasResult()) break;
    if (end - Date.now() <= 0) { stop = { reason: `레인 시간 초과 ${timeoutS}s` }; break; }
    if (!renudged && promptStillTyped(name, env)) {
      // 제출이 안 된 채 idle 로 굳은 형태(codex 실측) — 결과도 없고 문장이 그대로면 enter 한 번 더 넣고 다시 기다린다
      herdr(['agent', 'send-keys', name, 'enter'], { cwd, env }); renudged = true; res.nudged = true; await sleep(2000); continue;
    }
    // 알리기 전에는 settleGraceS 만 지켜보고, 알린 뒤에는 그 두 배씩 끊어 상한까지 본다(끊을 때마다 한도 화면인지 확인한다)
    const seen = await watchIdle(name, env, hasResult, Math.min(end, Date.now() + (reminded ? 2 * watchMs : watchMs)));
    if (seen === 'file') continue; // 결과가 생겼다 — 턴이 끝나길 한 번 더 기다린 뒤 읽는다
    if (seen === 'working') { rewaits++; idleSince = null; continue; }
    if (seen === 'gone') { stop = { reason: '에이전트가 사라졌다(pane 이 셸로 돌아왔다)', screen_tail: paneTail(pane, env) }; break; }
    if (reminded) {
      const tail = screen(name, env, 15).slice(-600);
      if (LIMIT_PATTERN.test(tail)) { stop = { status: 'limit', reason: '사용량 한도 화면에서 멈췄다', screen_tail: tail }; break; }
      idleSince ??= Date.now() - 2 * watchMs; // 일하다 다시 유휴가 됐다 — 방금 본 조각 내내 유휴였다
      if (idleCapS != null && Date.now() - idleSince >= idleCapS * 1000) { stop = { reason: `알린 뒤에도 ${idleCapS}s 넘게 유휴였다`, screen_tail: tail }; break; }
      continue; // 상한까지 결과 파일을 기다린다 — 위의 시간 검사가 닫는다
    }
    if (agentState(name, env) == null) continue; // 그새 사라졌다 — 죽은 pane 에 보낸 글은 셸 명령이 된다. 다음 바퀴가 gone 으로 닫는다
    herdr(['agent', 'prompt', name, remindText(outPath)], { cwd, env, timeout: 30000 });
    reminded = true; res.reminded = true; idleSince = Date.now();
    await sleep(2000);
    // 글자만 들어가고 제출이 안 된 형태(제출 문장과 같은 실측) — 아직 안 움직이고 알림 문장이 화면에 있으면 enter 한 번
    if (!hasResult() && agentState(name, env) !== 'working' && cleanScreen(screen(name, env, 12)).includes(REMIND_TOKEN)) herdr(['agent', 'send-keys', name, 'enter'], { cwd, env });
  }
  res.escaped = escaped;
  if (rewaits) res.rewaits = rewaits;

  // 6. 결과 파일 — 제출 뒤에 쓰인 것만
  if (!isNew(outPath, left.out)) {
    const tail = stop?.screen_tail ?? screen(name, env, 15).slice(-600);
    const stale = left.out != null ? ' (제출 전부터 있던 파일(못 치움)이 그대로다 — 지난 결과라 읽지 않았다)' : '';
    const why = stop?.reason ? ` — ${stop.reason}${reminded && /시간 초과/.test(stop.reason) ? ' · 유휴라 한 번 알렸지만 결과가 오지 않았다' : ''}` : '';
    return done({ status: stop?.status ?? (LIMIT_PATTERN.test(tail) ? 'limit' : 'failed'), reason: isNew(errFile, left.err) ? `레인 보고 오류: ${readFileSync(errFile, 'utf8').slice(0, 300)}` : `결과 파일 없음: ${fwd(outPath)}${stale}${why}`, state, screen_tail: tail });
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(outPath, 'utf8')); } catch (e) { return done({ reason: `결과 JSON 파싱 실패: ${e.message}`, state }); }
  if (parsed && parsed.status === 'limit') return done({ status: 'limit', reason: `사용량 한도: ${parsed.summary ?? ''}`, result: parsed, state });
  if (closePanes && !res.reused) herdr(['pane', 'close', pane], { cwd, env });
  return done({ status: 'done', result: parsed, state });
}

/** 레인 하나를 끝까지. 절대 throw 하지 않는다 — {name, kind, status, reason?, result?, pane?, reused?, screen_tail?} */
export async function runLane(lane, opts = {}) {
  const ctx = await startLane(lane, opts);
  return finishLane(ctx, opts);
}

/** spec 의 레인들 — 기본은 전부 띄운 뒤 기다린다(parallel). 결과 파일이 겹치는 레인·같은 이름의 레인은 spec 을 만드는 쪽이 피한다 */
export async function runSpec(spec, opts = {}) {
  const lanes = Array.isArray(spec.lanes) ? spec.lanes : [];
  const o = { ...opts, timeoutS: spec.timeout_s ?? opts.timeoutS ?? 900, closePanes: spec.close_panes ?? opts.closePanes ?? false, autoTrust: spec.auto_trust ?? opts.autoTrust ?? true, ...(spec.settle_grace_s != null ? { settleGraceS: spec.settle_grace_s } : {}) };
  const results = [];
  if (spec.parallel === false) {
    for (const l of lanes) results.push(await runLane(l, o));
  } else {
    const started = [];
    for (const l of lanes) started.push(await startLane(l, o));
    const deadline = Date.now() + o.timeoutS * 1000;
    for (const c of started) results.push(await finishLane(c, { ...o, deadline }));
  }
  return { lanes: results, done: results.filter(r => r.status === 'done').map(r => r.name), failed: results.filter(r => r.status !== 'done').map(r => `${r.name}: ${r.reason ?? r.status}`) };
}

// ---------------------------------------------------------------- 리뷰 spec

const REVIEW_SCHEMA = '{ "findings": [ { "severity": "BLOCKER|MAJOR|MINOR", "file": "path", "line": 0, "claim": "한 줄 주장", "evidence": "근거(코드·재현)", "axis": "관점" } ], "summary": "한 줄" }';

function reviewPrompt({ root, diffCmd, files, axes }) {
  return [
    `당신은 이 저장소의 코드 리뷰어다. 저장소 루트: ${fwd(root)}.`,
    `대상: \`${diffCmd}\`. 바뀐 파일: ${files.length ? files.join(', ') : '(diff 로 확인)'}.`,
    axes ? `이번에 볼 관점: ${axes}.` : '관점: 정확성(값·경계·에러 경로) · 계약(호출자↔피호출자 시그니처·경로·파트명) · 보안(입력 검증·권한) · 회귀(기존 테스트가 이 변경을 잡는가).',
    '규칙: 실제로 diff 와 그 주변 코드를 읽고 판단한다. 추측을 finding 으로 적지 않는다. finding 마다 file·line·claim·evidence 를 채운다. 근거 없는 항목은 내지 않는다. 코드를 고치지 않는다(읽기 전용). 이전 라운드의 판단을 그대로 반복하지 말고 지금 diff 를 다시 본다.',
    `출력 JSON 모양: ${REVIEW_SCHEMA}. finding 이 없으면 findings: [] 와 summary 만.`,
  ].join('\n');
}

/** 리뷰 레인이 알린 뒤에도 유휴일 때 닫는 시간 — 지켜보는 시간(settle_grace_s)의 4배(기본 120초). 리뷰어는 돌려 둔 명령을 기다릴 일이 없다 */
function reviewIdleCapS(hc) { return 4 * Math.max(1, hc.settle_grace_s ?? 30); }

/** @param rt runtime 폴더의 절대 경로(메인 저장소 것 — main 이 넘긴다). 없으면 root 아래의 runtime_dir */
export function buildVerifySpec({ cfg, root, diffRef, files, slug, kinds, axes, runtimeDir, rt }) {
  const hc = herdrConfig(cfg);
  const useKinds = kinds?.length ? kinds : (hc.kinds?.verify ?? ['codex']);
  const outDir = join(rt ?? join(root, runtimeDir ?? cfg.runtime_dir), 'issues');
  const lanes = useKinds.map(kind => ({
    name: `review-${kind}`.replace(/[^a-z0-9_-]/g, '-').slice(0, 32),
    kind,
    reuse: true,
    idle_cap_s: reviewIdleCapS(hc),
    out: fwd(join(outDir, `${slug}.herdr-${kind}.json`)),
    prompt: reviewPrompt({ root, diffCmd: `git diff ${diffRef}`, files, axes }),
  }));
  return { lanes, timeout_s: hc.lane_timeout_s ?? 900, close_panes: hc.close_panes ?? false, kind_args: hc.kind_args ?? {}, ...(hc.settle_grace_s != null ? { settle_grace_s: hc.settle_grace_s } : {}) };
}

function mergeFindings(run) {
  const findings = [];
  for (const l of run.lanes) {
    if (l.status !== 'done') continue;
    for (const f of (Array.isArray(l.result?.findings) ? l.result.findings : [])) {
      findings.push({ severity: String(f.severity ?? 'MINOR').toUpperCase(), file: fwd(f.file ?? ''), line: Number(f.line ?? 0) || 0, claim: String(f.claim ?? ''), evidence: String(f.evidence ?? ''), axis: String(f.axis ?? ''), lane: l.name });
    }
  }
  return findings;
}

/** reviewer 컨텍스트 정책(issue|always|never) → 이번 호출에서 /new 를 보낼지. 장부 <runtime>/herdr/reviewer-<kind>.json */
export function reviewerFresh({ cfg, root, kind, slug, rt }) {
  const policy = herdrConfig(cfg).reviewer_context ?? 'issue';
  const file = join(rt ?? join(root, cfg.runtime_dir), 'herdr', `reviewer-${kind}.json`);
  const last = readJson(file);
  const fresh = policy === 'always' ? true : policy === 'never' ? false : (last?.slug ?? null) !== slug;
  writeJson(file, { slug, rounds: (last?.slug === slug ? (last.rounds ?? 0) : 0) + 1, at: new Date().toISOString(), policy });
  return fresh;
}

// ---------------------------------------------------------------- implement spec

const LANE_RESULT_SHAPE = '{"name": "<레인 이름>", "status": "done|partial|failed", "files": ["<고친 파일, worktree 루트 기준>"], "tests": {"command": "<실행한 명령>", "passed": 0, "failed": 0}, "notes": "<seam·못 끝낸 것·다음 레인에 줄 말>"}';

/** 구현 레인의 시간 상한 하한(초) — lane_timeout_s 의 기본값(900)은 리뷰 레인 기준이라, 구현하고 자기 테스트를 한 번 도는 레인은 그 안에 못 끝난다 */
export const IMPLEMENT_TIMEOUT_FLOOR_S = 3600;

const laneDodIds = lane => (Array.isArray(lane?.dod) ? lane.dod : []).map(d => (typeof d === 'string' ? d : d?.id)).filter(Boolean);

/**
 * 구현 레인의 검증 규칙 — 자기 테스트만, 한 번에 묶어서. 진입점은 게이트의 --try(상태·판정 기록 없음 · 게이트의 DoD 배치와 같은 명령·환경 파일·판정)다.
 * 왜: 레인이 러너 명령을 손으로 조립해 여러 번 띄우고, 전체 lint·위반 주입까지 레인마다 돌린 시간이 레인 벽시계의 절반을 넘었다.
 *     그 검사들은 메인이 레인을 합친 트리의 게이트에서 어차피 한 번 돈다.
 */
function verifyRules({ lane, slug, wtPath, cfg, dodItems }) {
  const gateCmd = `node "${fwd(join(PLUGIN_ROOT, 'scripts', 'gate.mjs'))}" --try`;
  const where = `--cwd "${fwd(wtPath)}"`;
  const adapters = Object.entries(cfg?.stacks ?? {}).filter(([, s]) => s?.dod_tests).map(([n, s]) => `${n} = ${s.dod_tests.adapter === 'gradle-junit' ? "테스트 클래스 패턴(예 '*FeeTest*')" : '테스트 파일 경로(그 스택 폴더 기준)'}`);
  // dod_tests 가 없는 스택은 --try 가 묶어 돌리지 못한다(--stack 으로 지목하면 exit 2) — 그 스택의 테스트는 러너를 직접 부르라고 따로 알린다
  const bare = Object.entries(cfg?.stacks ?? {}).filter(([, s]) => !s?.dod_tests).map(([n]) => n);
  const own = new Set(laneDodIds(lane));
  const hasOwnTests = (dodItems ?? []).some(d => d && own.has(d.id) && !d.human && d.tests && cfg?.stacks?.[d.tests.stack]?.dod_tests);
  const common = [
    '- 돌리지 않는 것: 전체 테스트 · 전체 lint · build · 위반 주입 프로브. 전부 메인이 레인들을 합친 트리의 게이트에서 **한 번** 돈다 — 레인마다 돌리면 같은 검사가 레인 수만큼 반복되고, 동시에 도는 러너끼리 서로를 느리게 한다.',
    '- 띄운 명령은 끝날 때까지 기다린다. 오래 걸린다고 같은 테스트를 또 띄우지 않는다(두 벌이 겹쳐 둘 다 느려진다).',
    '- 테스트 실행은 통틀어 3번 안팎에서 끝낸다. 그 안에 초록이 안 되면 더 돌리지 말고 status 를 partial 로 두고 notes 에 무엇이 왜 실패하는지 적는다 — 메인이 합친 트리에서 이어 한다.',
    '- 결과 JSON 의 tests 에는 마지막으로 돌린 명령과 그 통과/실패 건수를 적는다. 돌릴 테스트가 없는 변경(문서·설정)이면 tests.command 를 빈 문자열로 두고 notes 에 그 이유를 적는다.',
  ];
  if (!adapters.length) return [
    '- 구현을 끝낸 뒤 **자기가 쓰거나 고친 테스트만** 그 스택의 러너로 한 번에 묶어 돌린다. 실패하면 고치고 실패한 것만 다시 돌린다.',
    ...common,
  ];
  const select = `${gateCmd} --stack <스택> --select '<패턴>' [--select '<패턴>' …] ${where}`;
  return [
    ...(hasOwnTests ? [
      '- 구현을 끝낸 뒤 아래 명령 **하나**로 이 레인의 DoD 테스트를 한 번에 돌린다. push 전 게이트가 DoD 를 재는 것과 같은 명령·환경 파일·판정(분모·통과 건수 하한)으로 돈다 — 러너 명령을 손으로 조립하지 않는다:',
      `  \`${gateCmd} --slug ${slug} --lane ${lane.name} ${where}\``,
      '- 실패하면 고친 뒤 출력의 「다시」 줄에 나온 명령으로 **실패한 것만** 다시 돌린다. 끝으로 위 명령을 한 번 더 돌려 전부 초록인지 본다(「다시」는 실패한 테스트만 돌아 항목의 통과 건수 하한을 재지 않는다).',
      `- DoD 에 없는 테스트(고친 파일을 덮는 기존 테스트)를 돌려야 하면: \`${select}\``,
    ] : [
      '- 구현을 끝낸 뒤 **자기가 쓰거나 고친 테스트만** 아래 명령으로 한 번에 묶어 돌린다(게이트와 같은 환경 파일로 러너를 띄운다 — 러너 명령을 손으로 조립하지 않는다). 실패하면 고친 뒤 출력의 「다시」 줄에 나온 명령으로 실패한 것만 다시 돌린다:',
      `  \`${select}\``,
    ]),
    `  스택과 패턴: ${adapters.join(' · ')}`,
    ...(bare.length ? [`- 위 명령은 스택 ${bare.join(' · ')} 의 테스트를 돌리지 못한다(그 스택에는 묶어 돌리는 설정이 없다 — \`--stack ${bare[0]}\` 은 실패한다). 그 스택의 테스트를 쓰거나 고쳤으면 그 스택의 러너를 직접 불러 **자기 테스트만 한 번에 묶어** 돌린다.`] : []),
    ...common,
  ];
}

function implementPrompt({ lane, keys, wtPath, branch, guides, contracts, maxTurns, slug, cfg, dodItems }) {
  const guideText = Object.keys(guides).length ? Object.entries(guides).map(([k, p]) => `- ${k}: ${fwd(join(wtPath, p))}`).join('\n') : '- (가이드 경로가 없다 — 계약과 레인 지시만으로 진행한다)';
  const files = (lane.files ?? []).length ? lane.files.map(f => `- ${fwd(f)}`).join('\n') : '- (파일 목록이 비었다 — 레인 지시의 범위 안에서만 만든다)';
  // 레인의 dod 는 DoD id 배열이다(plan) — 상태의 DoD 에서 문구와 선택을 찾아 붙인다. 못 찾으면 적힌 그대로
  const byId = new Map((dodItems ?? []).filter(d => d?.id).map(d => [d.id, d]));
  const dod = (lane.dod ?? []).length ? lane.dod.map((d) => {
    const it = byId.get(typeof d === 'string' ? d : d?.id);
    if (it) return `- ${it.id} ${it.text ?? ''}${it.tests ? ` (${it.tests.stack}: ${(it.tests.select ?? []).join(', ')})` : ''}`.trimEnd();
    return `- ${typeof d === 'string' ? d : `${d.id ?? ''} ${d.text ?? ''}`.trim()}`;
  }).join('\n') : null;
  return [
    // 이슈마다 레인 하나일 때(lane.key) — 이 레인이 맡은 이슈와, 같은 브랜치의 다른 이슈는 다른 레인의 몫임을 첫 줄에 밝힌다
    lane.key && keys.length > 1
      ? `너는 이슈 ${lane.key} 의 구현 레인 "${lane.name}" 이다. 이 브랜치가 한 번에 처리하는 이슈: ${keys.join(', ')} — 나머지 이슈는 다른 레인이 맡는다.`
      : `너는 이슈 ${lane.key ?? (keys.join(', ') || '(키 없음)')} 의 구현 레인 "${lane.name}" 이다.`,
    `작업 디렉터리는 git worktree \`${fwd(wtPath)}\`(브랜치 \`${branch}\`) 이고, 모든 파일 경로는 이 디렉터리 기준이다. 이 디렉터리 밖은 읽기만 한다(끝의 결과 규약이 지정한 결과 파일만 예외다).`,
    '',
    '## 개발 가이드 (먼저 정독한다)',
    guideText,
    '',
    '## Phase 0 공통 계약 — 이미 확정·커밋된 것이다. 바꾸지 말고 그대로 따른다',
    contracts?.trim() ? contracts.trim() : '(별도 계약 없음 — 가이드의 계약 절을 따른다)',
    '',
    '## 담당 파일',
    files,
    '',
    '## 레인 지시',
    typeof lane.brief === 'string' && lane.brief.trim() ? lane.brief.trim() : '(지시 없음 — 담당 파일과 가이드로 판단한다)',
    ...(dod ? ['', '## 이 레인이 닫아야 할 DoD', dod] : []),
    '',
    '## 규율',
    '- 담당 파일 밖은 수정하지 않는다. 다른 레인이 **다른 worktree** 에서 같은 브랜치의 다른 몫을 동시에 구현한다 — 겹치면 메인이 패치를 합칠 때 충돌한다.',
    '- 경계(seam — 한쪽이 부르고 다른 쪽이 받는 곳)에서 상대 레인의 파일을 고쳐야 하면 고치지 말고 notes 에 적는다.',
    '- **git commit · git push · git stash · 브랜치 전환을 하지 않는다.** 변경은 worktree 에 그대로 둔다 — 메인 세션이 diff 를 패치로 회수해 게이트·리뷰·커밋한다. `git add` 도 필요 없다.',
    '- 실패를 숨기지 않는다 — 못 끝냈으면 status 는 partial 또는 failed 다. 초록으로 보이게 테스트를 지우거나 게이트 명령을 바꾸지 않는다.',
    `- 턴 상한 ${maxTurns} — 넘기기 전에 결과 JSON 을 쓰고 멈춘다.`,
    '',
    '## 검증 — 자기 테스트만, 한 번에 묶어서',
    ...verifyRules({ lane, slug, wtPath, cfg, dodItems }),
    '',
    '## 산출물',
    '1) worktree 안의 코드 변경(커밋하지 않은 상태 그대로)',
    `2) 결과 JSON — 아래 모양. 결과 규약이 지정한 파일에 쓴다: ${LANE_RESULT_SHAPE}`,
  ].join('\n');
}

/** 레인 선언 → kind. plan 이 골랐으면 그대로, 아니면 풀에서 순서대로(기계적·재현 가능) */
export function assignKind(lane, i, pool) {
  if (lane.kind) return { kind: lane.kind, source: lane.kind_source === 'pool' ? 'pool' : 'plan' }; // 지난 실행이 기록한 pool 배정을 plan 선언으로 둔갑시키지 않는다
  const p = pool?.length ? pool : ['claude'];
  return { kind: p[i % p.length], source: 'pool' };
}

/** @param rt runtime 폴더의 절대 경로(메인 저장소 것 — main 이 넘긴다). 없으면 root 아래의 runtime_dir. 레인 결과 파일과 레인 작업트리가 그 아래에 놓인다 */
export function buildImplementSpec({ cfg, root, slug, state, only = [], contracts = '', maxTurns, rt }) {
  const hc = herdrConfig(cfg);
  const pool = hc.kinds?.implement ?? ['claude'];
  const declared = (state?.lanes ?? []).filter(l => l && l.name);
  const picked = only.length ? declared.filter(l => only.includes(l.name)) : declared;
  const outDir = join(rt ?? join(root, cfg.runtime_dir), 'issues');
  const placement = hc.lane_placement === 'workspace' ? 'workspace' : 'split';
  // 절대 경로면 acquireLocalWorktree 가 그대로 쓴다(상대 경로는 일하는 트리 기준) — 작업트리 세션에서도 레인 작업트리는 메인 저장소 runtime 아래에 판다
  const worktreeDir = hc.worktree_dir ?? fwd(laneWorktreeRoot(rt ?? cfg.runtime_dir, slug)); // 이슈를 마감할 때의 정리(removeLaneLeftovers)가 같은 자리에서 남은 폴더를 찾는다
  const lanes = picked.map((l, i) => {
    const { kind, source } = assignKind(l, i, pool);
    const branch = laneBranch(slug, l.name);
    return {
      name: laneName(`impl-${l.name}`), lane: l.name, kind, kind_source: source, kind_reason: l.kind_reason ?? null,
      reuse: true, worktree_branch: branch, placement, worktree_dir: worktreeDir,
      out: fwd(join(outDir, `${slug}.lane-${l.name}.json`)),
      // 프롬프트의 worktree 경로는 pane 을 잡은 뒤에야 안다 — startLane 직전에 채운다(prompt_of)
      prompt_of: (wtPath) => implementPrompt({ lane: l, keys: state?.keys ?? [], wtPath, branch, guides: state?.guides ?? {}, contracts, maxTurns: maxTurns ?? 60, slug, cfg, dodItems: state?.dod ?? [] }),
    };
  });
  return {
    lanes, parallel: true, timeout_s: Math.max(hc.lane_timeout_s ?? 900, IMPLEMENT_TIMEOUT_FLOOR_S), close_panes: hc.close_panes ?? false, kind_args: hc.kind_args ?? {}, auto_trust: hc.auto_trust !== false, ...(hc.settle_grace_s != null ? { settle_grace_s: hc.settle_grace_s } : {}),
    placement, worktree_dir: worktreeDir,
    prep: { copy: hc.worktree_copy ?? [], init: hc.worktree_init ?? [], cfg },
    skipped: only.length ? declared.filter(l => !only.includes(l.name)).map(l => l.name) : [],
  };
}

// 레인 작업트리의 변경을 패치로 뽑는 것(harvestWorktree)은 lib/worktree.mjs 에 있다 — 이슈를 마감할 때의 레인 정리가 「회수해 둔 패치와 지금 내용이 같은가」를 같은 함수로 잰다.

/** 패치를 메인 체크아웃에 적용한다. 깨끗이 안 들어가면 3-way — 충돌 표식이 파일에 남고 'conflict' 로 보고한다(사람·메인이 푼다) */
export function applyPatch(root, patchFile) {
  const plain = git(['apply', '--whitespace=nowarn', patchFile], { cwd: root, allowFail: true });
  if (plain.status === 0) return { applied: 'yes' };
  const three = git(['apply', '--3way', '--whitespace=nowarn', patchFile], { cwd: root, allowFail: true });
  if (three.status === 0) return { applied: 'yes', three_way: true };
  return { applied: 'conflict', error: (three.err || plain.err).split('\n').filter(Boolean).slice(0, 12).join('\n') };
}

/** 레인 결과를 상태 JSON 의 lanes[] 에 남긴다 — 쓰는 사람은 issue-set.mjs 하나다(--lane 은 이름이 같으면 교체) */
function recordLane(root, state, orig, patch) {
  const prev = (state?.lanes ?? []).find(l => l.name === orig) ?? { name: orig, model: 'unknown' };
  const rec = { ...prev, ...patch };
  // 브랜치를 못박는다 — 레인이 도는 동안 이 트리의 브랜치가 바뀌어도(다른 세션) 읽은 그 이슈의 상태에 쓴다
  const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'issue-set.mjs'), '--cwd', root, ...(state?.branch ? ['--branch', state.branch] : []), '--lane', JSON.stringify(rec)], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 ? { ok: true } : { ok: false, reason: (r.stderr || r.stdout || '').trim().slice(0, 300) };
}

// ---------------------------------------------------------------- runner(게이트)

/** runner pane 은 일하는 트리마다 하나다(장부 파일 이름에 그 트리의 브랜치 슬러그) — runtime 을 메인과 작업트리가 같이 쓰므로 한 파일이면 서로의 pane 에 명령을 보낸다 */
function runnerPane(rt, root, slug, env) {
  const file = join(rt, 'herdr', `runner-${slug}.json`);
  const saved = readJson(file);
  if (saved?.pane) {
    const g = herdr(['pane', 'get', saved.pane], { cwd, env, timeout: 5000 });
    if (g.ok) return { pane: saved.pane, reused: true };
  }
  const h = herdrEnv(env);
  const anchor = h.pane ? ['--pane', h.pane] : ['--current'];
  const r = herdr(['pane', 'split', ...anchor, '--direction', 'down', '--cwd', root, '--no-focus'], { cwd, env, timeout: 15000 });
  if (!r.ok) return { error: `pane split 실패: ${r.reason}` };
  const pane = r.value?.result?.pane?.pane_id ?? null;
  if (!pane) return { error: 'pane id 를 응답에서 못 읽음' };
  herdr(['pane', 'rename', pane, 'runner'], { cwd, env, timeout: 5000 });
  writeJson(file, { pane, at: new Date().toISOString() });
  return { pane, reused: false };
}

// ---------------------------------------------------------------- main

async function main() {
  const USAGE = '사용법: herdr-lanes.mjs codex-review|verify|plan|implement|gate|gate-run|run … [--cwd <dir>] [--json]';
  if (!cmd || !['run', 'verify', 'plan', 'implement', 'codex-review', 'gate', 'gate-run'].includes(cmd)) fail(2, USAGE);
  const env = process.env;

  if (cmd === 'run') {
    const specPath = opt('--spec');
    if (!specPath) fail(2, '--spec <file> 이 필요하다');
    let spec; try { spec = JSON.parse(readFileSync(resolve(specPath), 'utf8')); } catch (e) { fail(2, `spec 읽기 실패: ${e.message}`); }
    const r = await runSpec(spec, { kindArgs: spec.kind_args ?? {} });
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else for (const l of r.lanes) console.log(`[herdr-lanes] ${l.name} (${l.kind}) ${l.status}${l.reason ? ` — ${l.reason}` : ''} · ${l.seconds}s · pane ${l.pane ?? '-'}${l.reused ? ' (재사용)' : ''}`);
    return;
  }

  const proj = locateProject(cwd);
  if (!proj || !proj.configPath) fail(2, 'harness.json 이 없다');
  const cfg = loadConfig(proj.configPath);
  // root = 일하는 트리(레인의 시작점 HEAD · 패치를 적용할 곳 · 게이트가 재는 트리). rt = 상태·결과·장부를 두는 runtime — 다른 스크립트와 같이 언제나 메인 저장소 것이다
  // (lib/config.mjs locateProject). 작업트리 세션에서 runtime 을 그 작업트리 아래로 잡으면 상태 JSON 을 못 찾고 결과가 메인과 갈린다.
  const root = proj.toplevel;
  const rt = join(proj.configRoot, cfg.runtime_dir);
  const hc = herdrConfig(cfg);

  // gate-run: runner pane 안에서 실제로 도는 명령(셸 무관 — 한 프로세스가 gate.mjs 실행·결과 파일·완료 표식까지)
  if (cmd === 'gate-run') {
    const level = flag('--main') ? '--main' : flag('--full') ? '--full' : flag('--related') ? '--related' : flag('--dod') ? '--dod' : '--commit';
    const out = opt('--out'); const nonce = opt('--nonce') ?? 'x';
    if (!out) fail(2, '--out 이 필요하다');
    const args = [join(PLUGIN_ROOT, 'scripts', 'gate.mjs'), level, '--cwd', root, '--json', ...(flag('--stage-all') ? ['--stage-all'] : []), ...(opt('--stacks') ? ['--stacks', opt('--stacks')] : [])];
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    let summary = null; try { summary = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { summary = null; }
    writeJson(resolve(out), { exit: r.status ?? 1, level: level.slice(2), at: new Date().toISOString(), summary, stdout_tail: (r.stdout ?? '').slice(-2000) });
    if (summary) console.log(`[gate] ${summary.level} ${summary.overall} · ${summary.duration_s}s · dod ${summary.dod}`);
    console.log(`GATE_DONE_${nonce}`);
    process.exit(0);
  }

  if (cmd === 'gate') {
    const level = flag('--main') ? 'main' : flag('--full') ? 'full' : flag('--related') ? 'related' : flag('--dod') ? 'dod' : 'commit';
    const h = herdrEnv(env);
    if (!h.inside || hc.enabled === false) { const o = { ok: false, reason: !h.inside ? 'outside herdr' : 'herdr.enabled=false' }; if (asJson) console.log(JSON.stringify(o)); else console.log(`[herdr-lanes] gate: ${o.reason} — gate.mjs 를 직접 돌릴 것`); return; }
    const rp = runnerPane(rt, root, branchSlug(currentBranch(root) ?? 'work'), env);
    if (rp.error) { const o = { ok: false, reason: rp.error }; if (asJson) console.log(JSON.stringify(o)); else console.log(`[herdr-lanes] gate: ${rp.error}`); return; }
    const nonce = `${Date.now().toString(36)}`;
    const out = join(rt, 'herdr', `gate-${level}-${nonce}.json`);
    const cmdLine = `node "${fwd(join(PLUGIN_ROOT, 'scripts', 'herdr-lanes.mjs'))}" gate-run --${level}${flag('--stage-all') ? ' --stage-all' : ''}${opt('--stacks') ? ` --stacks ${opt('--stacks')}` : ''} --cwd "${fwd(root)}" --out "${fwd(out)}" --nonce ${nonce}`;
    const run = herdr(['pane', 'run', rp.pane, cmdLine], { cwd, env, timeout: 10000 });
    if (!run.ok) { const o = { ok: false, reason: `pane run 실패: ${run.reason}` }; if (asJson) console.log(JSON.stringify(o)); else console.log(`[herdr-lanes] ${o.reason}`); return; }
    herdrPing(cwd, `gate ${level} → runner ${rp.pane}`);
    const base = { ok: true, pane: rp.pane, reused: rp.reused, level, out: fwd(out), nonce, wait: `herdr pane wait-output ${rp.pane} --match GATE_DONE_${nonce}` };
    if (flag('--no-wait')) { if (asJson) console.log(JSON.stringify(base)); else console.log(`[herdr-lanes] gate ${level} 시작 — runner ${rp.pane}${rp.reused ? '(재사용)' : ''} · 완료 토스트를 기다리거나: ${base.wait}`); return; }
    const timeoutMs = (cfg.gate?.timeout_s ?? 1800) * 1000 + 60000;
    const w = herdr(['pane', 'wait-output', rp.pane, '--match', `GATE_DONE_${nonce}`, '--timeout', String(timeoutMs)], { cwd, env, timeout: timeoutMs + 5000 });
    const result = readJson(out);
    // 기다림이 먼저 끝났는데 결과 파일이 없으면 게이트는 pane 에서 아직 돌거나 대기열(lib/queue.mjs)에서 차례를 기다리는 중이다 — 실패가 아니다
    const pending = !w.ok && !result;
    // exit 75 = 대기열 상한(gate.queue_max_wait_s)을 넘겨 게이트가 돌지 않았다 — 결과 파일은 있고 요약만 없다
    const queueTimeout = result?.exit === 75 && !result?.summary;
    const reason = queueTimeout ? '대기열 상한(gate.queue_max_wait_s)을 넘겼다 — 게이트는 돌지 않았고 기록도 없다. 다시 실행할 것' : w.ok ? undefined : `wait-output: ${w.reason}`;
    const o = { ...base, waited: w.ok, ...(pending ? { pending: true } : {}), summary: result?.summary ?? null, exit: result?.exit ?? null, reason };
    if (asJson) console.log(JSON.stringify(o, null, 2));
    else console.log(o.summary ? `[herdr-lanes] gate ${o.summary.level} ${o.summary.overall} · ${o.summary.duration_s}s · runner ${rp.pane}`
      : pending ? `[herdr-lanes] gate 는 아직 끝나지 않았다(${o.reason}) — runner ${rp.pane} 에서 돌고 있거나 대기열에서 차례를 기다린다. 다시 띄우지 말고 결과 파일을 기다릴 것: ${base.out}`
      : queueTimeout ? `[herdr-lanes] gate 는 돌지 않았다 — ${reason}`
      : `[herdr-lanes] gate 결과 없음 — ${o.reason ?? '결과 파일 미생성'} (runner ${rp.pane} 화면을 볼 것)`);
    return;
  }

  const diffRef = opt('--diff-ref') ?? `${cfg.default_branch}...HEAD`;
  const files = (opt('--files') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const slug = opt('--slug') ?? branchSlug(currentBranch(cwd) ?? 'work');

  if (cmd === 'implement') {
    const emit = (o) => { if (asJson) console.log(JSON.stringify(o, null, 2)); else console.log(`[herdr-lanes] implement: ${o.reason}`); };
    const h = herdrEnv(env);
    const on = herdrImplementOn(cfg);
    // --harvest: 레인을 띄우지 않고 이미 있는 결과 파일과 레인 작업트리만 회수한다 — 실행기가 먼저 죽었거나(레인 pane 은 계속 돈다) 시간 초과로 닫은 뒤 결과가 온 경우. Herdr 가 필요 없다(git 만 쓴다)
    const harvestOnly = flag('--harvest');
    if (!harvestOnly && (!h.inside || !on)) { emit({ ok: false, reason: !h.inside ? 'outside herdr' : hc.enabled === false ? 'herdr.enabled=false' : `herdr.lanes=${hc.lanes ?? 'off'} — Herdr 구현 레인은 꺼져 있다(harness.json.herdr.lanes 를 implement 또는 all 로)`, lanes: [] }); return; }
    const stFile = statePath(cfg, proj.configRoot, slug);
    let state; try { state = readState(stFile); } catch (e) { emit({ ok: false, reason: `상태 JSON 읽기 실패: ${e.message}`, lanes: [] }); return; }
    if (!state) { emit({ ok: false, reason: `상태 JSON 이 없다: ${fwd(stFile)} — issue-start 먼저`, lanes: [] }); return; }
    const only = (opt('--lanes') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const contractsFile = opt('--contracts-file');
    const contracts = contractsFile ? readFileSync(resolve(contractsFile), 'utf8') : (opt('--contracts') ?? '');
    const spec = buildImplementSpec({ cfg, root, rt, slug, state, only, contracts, maxTurns: Number(opt('--max-turns')) || undefined });
    if (!spec.lanes.length) { emit({ ok: false, reason: only.length ? `--lanes ${only.join(',')} 에 맞는 레인 선언이 없다` : '상태 JSON 에 lanes 선언이 없다 — plan 이 먼저다', lanes: [], skipped: spec.skipped }); return; }
    // 베이스 — worktree 는 메인 체크아웃의 HEAD 에서 갈린다. 커밋 안 된 수정은 레인이 못 본다(계약은 먼저 커밋한다는 규율의 근거)
    const base = git(['rev-parse', '--short', 'HEAD'], { cwd: root, allowFail: true }).out || null;
    const dirty = git(['status', '--porcelain'], { cwd: root, allowFail: true }).out.split('\n').filter(Boolean).map(l => fwd(l.slice(3)));
    if (flag('--dry-run')) {
      const view = { ok: true, dry_run: true, slug, base, dirty_base: dirty, placement: spec.placement, worktree_dir: spec.worktree_dir, lanes: spec.lanes.map(l => ({ name: l.name, lane: l.lane, kind: l.kind, kind_source: l.kind_source, kind_reason: l.kind_reason, worktree_branch: l.worktree_branch, out: l.out, prompt: l.prompt_of('<worktree>') })), skipped: spec.skipped, timeout_s: spec.timeout_s, prep: { copy: spec.prep.copy, init: spec.prep.init } };
      if (asJson) console.log(JSON.stringify(view, null, 2)); else for (const l of view.lanes) console.log(`[herdr-lanes] ${l.name} ← ${l.lane} · ${l.kind}(${l.kind_source}) · ${l.worktree_branch} → ${l.out}`);
      return;
    }
    const ledgerFile = laneLedgerFile(rt, slug);
    const ledger = readJson(ledgerFile) ?? { slug, lanes: {} };
    const wasApplied = l => ['yes', 'empty'].includes(ledger.lanes?.[l.lane]?.applied);
    const results = [];
    if (harvestOnly) {
      // 이미 메인에 들어간 레인(적용됨 · 충돌 표식이 남은 것)은 건드리지 않는다 — 같은 diff 를 두 번 넣지 않는다.
      // 나머지는 결과 파일이 있으면 done 으로 읽고 아래 회수·적용을 그대로 탄다. 결과 파일이 없는 레인은 아직 돌고 있을 수 있으니 그 작업트리에 손대지 않는다(아래 pending)
      const landed = l => ['yes', 'conflict'].includes(ledger.lanes?.[l.lane]?.applied);
      spec.skipped.push(...spec.lanes.filter(landed).map(l => `${l.lane}(${ledger.lanes[l.lane].applied === 'yes' ? '이미 적용' : '충돌 표식이 메인에 남아 있다'})`));
      spec.lanes = spec.lanes.filter(l => !landed(l));
      if (!spec.lanes.length) { emit({ ok: false, reason: '회수할 레인이 없다 — 전부 이미 메인에 들어갔다(장부)', lanes: [], skipped: spec.skipped }); return; }
      for (const l of spec.lanes) {
        const known = ledger.lanes?.[l.lane] ?? {};
        const wtPath = localWorktree(l.worktree_branch, root)?.path ?? (known.path && existsSync(known.path) ? known.path : null); // workspace 배치의 작업트리는 장부의 경로로 찾는다
        const parsed = readJson(resolve(l.out));
        results.push({
          name: l.name, kind: l.kind, pane: known.pane ?? null, out: fwd(l.out), seconds: 0, reused: false,
          worktree: wtPath ? { branch: l.worktree_branch, path: wtPath, workspace: known.workspace ?? null, mode: 'harvest', placement: known.placement ?? spec.placement } : null,
          ...(!parsed ? { status: 'failed', pending: true, reason: `결과 파일 없음: ${fwd(l.out)} — 레인이 아직 돌고 있으면 끝난 뒤 다시 회수할 것` }
            : parsed.status === 'limit' ? { status: 'limit', reason: `사용량 한도: ${parsed.summary ?? ''}`, result: parsed }
            : !wtPath ? { status: 'failed', reason: `레인 작업트리를 찾지 못했다(${l.worktree_branch}) — 결과 파일만 있다`, result: parsed }
            : { status: 'done', result: parsed }),
        });
      }
    } else {
      herdrPing(cwd, `implement lanes ${spec.lanes.map(l => `${l.lane}:${l.kind}`).join('+')}`);
      // 띄우기 — 전부 띄운 뒤 기다린다. 프롬프트(worktree 경로 포함)는 startLane 이 pane 을 잡은 뒤 prompt_of 로 만든다
      const started = [];
      for (const l of spec.lanes) {
        const fresh = flag('--fresh') || wasApplied(l); // 이미 회수·적용한 worktree 는 새로 판다 — 낡은 diff 를 두 번 적용하지 않는다
        started.push(await startLane(l, { env, kindArgs: spec.kind_args, laneCwd: root, fresh, prep: spec.prep, autoTrust: spec.auto_trust }));
      }
      const deadline = Date.now() + spec.timeout_s * 1000;
      for (const c of started) results.push(await finishLane(c, { timeoutS: spec.timeout_s, closePanes: false, deadline, ...(spec.settle_grace_s != null ? { settleGraceS: spec.settle_grace_s } : {}) }));
    }

    // 회수·적용 — 순서대로. 결과 파일이 없어도(레인이 죽어도) worktree 에 남은 변경은 패치로 뽑아 둔다(적용은 안 함)
    const noApply = flag('--no-apply');
    const outLanes = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]; const l = spec.lanes[i];
      const rec = { name: r.name, lane: l.lane, kind: l.kind, kind_source: l.kind_source, status: r.status, reason: r.reason, pane: r.pane, worktree: r.worktree ?? null, out: r.out, seconds: r.seconds, sidecar: null, patch: null, applied: 'skipped' };
      const sc = r.result && typeof r.result === 'object' ? r.result : null;
      if (sc) rec.sidecar = { status: ['done', 'partial', 'failed'].includes(sc.status) ? sc.status : 'partial', files: Array.isArray(sc.files) ? sc.files.map(fwd) : [], tests: { command: String(sc.tests?.command ?? ''), passed: Number(sc.tests?.passed) || 0, failed: Number(sc.tests?.failed) || 0 }, notes: String(sc.notes ?? '') };
      if (r.pending) { outLanes.push(rec); continue; } // 아직 돌고 있을 수 있는 레인 — 작업트리·장부·상태에 손대지 않고 보고만 한다
      const wtPath = r.worktree?.path;
      if (wtPath && existsSync(wtPath)) {
        const hv = harvestWorktree(wtPath, lanePatchFile(rt, slug, l.lane));
        rec.patch = hv.ok ? { file: hv.file, files: hv.files, insertions: hv.insertions, deletions: hv.deletions, empty: hv.empty } : { error: hv.reason };
        const worth = r.status === 'done' && rec.sidecar && rec.sidecar.status !== 'failed';
        if (!hv.ok) rec.applied = 'skipped';
        else if (hv.empty) rec.applied = 'empty';
        else if (noApply) rec.applied = 'no-apply';
        else if (!worth) rec.applied = 'skipped';
        else { const ap = applyPatch(root, hv.file); rec.applied = ap.applied; if (ap.three_way) rec.three_way = true; if (ap.error) rec.apply_error = ap.error; }
      }
      ledger.lanes[l.lane] = { branch: l.worktree_branch, path: wtPath ?? null, workspace: r.worktree?.workspace ?? null, placement: r.worktree?.placement ?? spec.placement, pane: r.pane ?? null, applied: rec.applied, at: new Date().toISOString() };
      const wr = recordLane(root, state, l.lane, { kind: l.kind, kind_source: l.kind_source, worktree: true, result: { status: rec.sidecar?.status ?? (r.status === 'done' ? 'partial' : 'failed'), lane_status: r.status, reason: r.reason ?? null, kind: l.kind, seconds: r.seconds, files: rec.sidecar?.files ?? rec.patch?.files ?? [], tests: rec.sidecar?.tests ?? null, notes: rec.sidecar?.notes ?? null, patch: rec.patch?.file ?? null, applied: rec.applied, at: new Date().toISOString() } });
      if (!wr.ok) rec.record_error = wr.reason;
      outLanes.push(rec);
    }
    writeJson(ledgerFile, { ...ledger, base, at: new Date().toISOString() });
    const applied = outLanes.filter(l => l.applied === 'yes').length, conflicts = outLanes.filter(l => l.applied === 'conflict').length;
    const failed = results.filter(r => r.status !== 'done').map(r => `${r.name}: ${r.reason ?? r.status}`);
    const out = {
      ok: outLanes.some(l => l.applied === 'yes' || l.applied === 'no-apply'), slug, base, dirty_base: dirty, lanes: outLanes, failed, skipped: spec.skipped, applied, conflicts,
      next: conflicts ? '충돌 표식(<<<<<<<)을 메인이 푼 뒤 seam 대조 → gate --commit' : applied ? `seam(레인 경계) 대조 → gate --commit → commit. worktree·pane 은 남아 있다(닫기: ${spec.placement === 'workspace' ? 'herdr worktree remove --workspace <id>' : 'herdr pane close <id> — 레인 작업트리와 레인 브랜치는 이슈를 마감할 때 issue-start.mjs --remove-worktree <KEY> 가 함께 치운다'})` : '적용된 패치가 없다 — lanes[].reason · patch 를 볼 것',
    };
    herdrPing(cwd, `implement lanes done ${results.filter(r => r.status === 'done').length}/${results.length} · applied ${applied}${conflicts ? ` · conflict ${conflicts}` : ''}`, conflicts ? { title: `구현 레인 패치 충돌 ${conflicts}`, sound: 'request' } : failed.length ? { title: `구현 레인 미완 ${failed.length}`, body: failed[0], sound: 'request' } : { title: `구현 레인 완료 · 적용 ${applied}`, sound: 'done' });
    if (asJson) console.log(JSON.stringify(out, null, 2));
    else {
      for (const l of outLanes) console.log(`[herdr-lanes] ${l.name} ← ${l.lane} · ${l.kind} · ${l.status}${l.reason ? ` — ${l.reason}` : ''} · ${l.seconds}s · sidecar ${l.sidecar?.status ?? '-'} · patch ${l.patch?.files?.length ?? 0}파일 · applied ${l.applied}${l.apply_error ? `\n    ${l.apply_error.split('\n')[0]}` : ''}`);
      console.log(`[herdr-lanes] ${out.next}`);
    }
    return;
  }

  if (cmd === 'codex-review') {
    // codex-review.sh 와 같은 계약 — 마지막 줄 CODEX_RESULT={…}. Herdr 밖·설정 off 면 status:"missing" 으로 exec 경로에 넘긴다
    const kind = opt('--kind') ?? 'codex';
    const emit = (r) => { console.log(`CODEX_RESULT=${JSON.stringify(r)}`); };
    const h = herdrEnv(env);
    if (!h.inside || hc.enabled === false || (cfg.review?.codex_via ?? 'exec') !== 'herdr') {
      emit({ status: 'missing', blockers: 0, verdict: 'UNKNOWN', out: '', files: files.length, reason: !h.inside ? 'outside herdr' : hc.enabled === false ? 'herdr.enabled=false' : `review.codex_via=${cfg.review?.codex_via ?? 'exec'}` }); return;
    }
    const since = opt('--since');
    const diffCmd = since ? `git diff ${since}` : `git diff ${diffRef}`;
    const out = fwd(join(rt, 'issues', `${slug}.herdr-${kind}${since ? '-delta' : ''}.json`));
    const fresh = reviewerFresh({ cfg, root, rt, kind, slug });
    const lane = { name: `review-${kind}`, kind, reuse: true, fresh, out, idle_cap_s: reviewIdleCapS(hc), prompt: reviewPrompt({ root, diffCmd, files, axes: opt('--axes') }) };
    // 모델·effort 는 pane 을 새로 띄울 때만 먹는다 — 재사용되는 상주 reviewer 는 기동 시점 값을 유지한다
    const modelArgs = reviewModelArgs(cfg, kind);
    if (modelArgs.length) lane.args = [...((hc.kind_args ?? {})[kind] ?? DEFAULT_KIND_ARGS[kind] ?? []), ...modelArgs];
    herdrPing(cwd, `codex-review ${kind}${fresh ? ' (/new)' : ''}`);
    const l = await runLane(lane, { env, timeoutS: hc.lane_timeout_s ?? 900, kindArgs: hc.kind_args ?? {}, closePanes: false, laneCwd: root, autoTrust: hc.auto_trust !== false, ...(hc.settle_grace_s != null ? { settleGraceS: hc.settle_grace_s } : {}) });
    const findings = mergeFindings({ lanes: [l] });
    const blockers = findings.filter(f => f.severity === 'BLOCKER').length;
    const status = l.status === 'done' ? 'ok' : l.status === 'limit' ? 'limit' : 'fail';
    const r = { status, blockers, verdict: status === 'ok' ? (blockers ? 'BLOCK' : 'PASS') : 'UNKNOWN', out, files: files.length, reason: l.reason ?? '', pane: l.pane, reused: l.reused, fresh: !!l.fresh, findings };
    herdrPing(cwd, `codex-review ${status}${blockers ? ` blocker ${blockers}` : ''}`, blockers > 0 ? { title: `${kind} 리뷰 blocker ${blockers}`, sound: 'request' } : status !== 'ok' ? { title: `${kind} 리뷰 ${status}`, body: l.reason, sound: 'request' } : null);
    if (asJson) console.log(JSON.stringify(r, null, 2));
    emit({ status, blockers, verdict: r.verdict, out, files: files.length, reason: r.reason });
    return;
  }

  if (!['verify', 'all'].includes(hc.lanes ?? 'off') || hc.enabled === false) {
    if (cmd === 'verify') { const o = { ok: false, reason: `herdr.lanes=${hc.lanes ?? 'off'} — Herdr 리뷰 레인은 꺼져 있다(harness.json.herdr.lanes 를 verify 또는 all 로)`, lanes: [], findings: [] }; if (asJson) console.log(JSON.stringify(o)); else console.log(`[herdr-lanes] ${o.reason}`); return; }
  }
  const kinds = (opt('--kinds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const spec = buildVerifySpec({ cfg, root, rt, diffRef, files, slug, kinds, axes: opt('--axes') });
  if (cmd === 'plan') { if (asJson) console.log(JSON.stringify(spec, null, 2)); else console.log(`[herdr-lanes] plan: ${spec.lanes.map(l => `${l.name}(${l.kind}) → ${l.out}`).join(' · ')}`); return; }
  for (const l of spec.lanes) l.fresh = reviewerFresh({ cfg, root, rt, kind: l.kind, slug });
  herdrPing(cwd, `verify lanes ${spec.lanes.map(l => l.kind).join('+')}`);
  const run = await runSpec(spec, { kindArgs: spec.kind_args, laneCwd: root, autoTrust: hc.auto_trust !== false });
  const findings = mergeFindings(run);
  const out = { ok: run.done.length > 0, diffRef, lanes: run.lanes.map(l => ({ name: l.name, kind: l.kind, status: l.status, reason: l.reason, pane: l.pane, reused: l.reused, out: l.out, seconds: l.seconds, count: Array.isArray(l.result?.findings) ? l.result.findings.length : 0, summary: l.result?.summary })), failed: run.failed, findings, blockers: findings.filter(f => f.severity === 'BLOCKER').length, lanes_reason: `herdr lanes: ${spec.lanes.map(l => l.kind).join('+')} (Codex 밖의 심판 — 다른 모델)` };
  herdrPing(cwd, `verify lanes done ${run.done.length}/${run.lanes.length} · findings ${findings.length}`, out.blockers > 0 ? { title: `리뷰 레인 blocker ${out.blockers}`, sound: 'request' } : null);
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    for (const l of out.lanes) console.log(`[herdr-lanes] ${l.name} ${l.status}${l.reason ? ` — ${l.reason}` : ` · finding ${l.count}`} · ${l.seconds}s${l.reused ? ' (재사용)' : ''}`);
    console.log(`[herdr-lanes] findings ${findings.length} (blocker ${out.blockers}) — 확정/기각은 메인이 한다`);
  }
}
main().catch(e => fail(2, e.message));
