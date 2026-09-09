#!/usr/bin/env node
// herdr-lanes.mjs — Herdr pane 을 하네스의 역할(reviewer · runner · lane)로 쓰는 실행기.
//
// 왜: Workflow 서브에이전트는 안 보이고·세션과 함께 죽고·Claude 모델뿐이다. 리뷰(verify)만큼은 다른 모델이 심판해야 maker≠verifier 가 성립하고,
//     긴 출력(전량 게이트 9~15분·리뷰 본문)은 driver(Claude) 컨텍스트 밖에 있어야 한다. Herdr 안에서는 워크스페이스가 통제면이고 pane 이 역할이다.
//
// 역할
//   reviewer  codex(기본)·grok pane. **있으면 재사용, 없으면 띄운다**(같은 워크스페이스·같은 kind·idle/done 일 때만 — working 이면 하나 더).
//             컨텍스트는 `herdr.reviewer_context`(issue: 이슈가 바뀌면 /new · always: 매번 · never) 로 비운다.
//   runner    셸 pane. 게이트를 여기서 돌리고 driver 는 완료 표식(GATE_DONE_<nonce>)만 기다린다(또는 --no-wait 로 바로 돌아와 토스트를 받는다).
//   lane      임의 spec(run --spec) — 리뷰 밖 용도.
//
// 레인 1개의 절차(runLane):
//   1. pane 확보 — 재사용(agent list) / split / worktree
//   2. `agent start <name> --kind <kind> --pane <id> -- <kind_args>` (kind 별 네이티브 인자 — Windows codex 는 샌드박스 해제가 필수)
//   3. 프롬프트는 argv 가 아니라 파일로 — `<out>.prompt.md` 를 쓰고 "그 파일을 읽고 따르라" 한 줄만 보낸다
//   4. ★제출 확인 — `agent prompt` 의 성공 응답은 제출을 증명하지 않는다(codex·grok 실측). `agent get` 이 working/blocked 로 바뀌었는지 보고,
//      아니면 화면에 남은 프롬프트를 `send-keys enter` 로 밀어 넣는다(1회)
//   5. `agent wait` 로 settled 대기. blocked 면 화면을 읽어 **"Teach auto mode" 다이얼로그일 때만** `esc`(그 외 승인·권한 UI 는 사람 몫)
//   6. ★결과는 화면이 아니라 파일 — 레인이 `<out>` 에 쓴 JSON 을 읽는다(alt-screen 스크롤백은 회수되지 않는다). 없으면 failed
//   7. `close_panes` 면 pane 을 닫는다(기본 false — 사람이 화면을 본다). 재사용한 pane 은 닫지 않는다
//
// 사용:
//   node herdr-lanes.mjs codex-review [--since <tree>] [--diff-ref <ref>] [--files a,b] [--slug s] [--kind codex] [--cwd] [--json]
//       → 마지막 줄 CODEX_RESULT={"status":"ok|limit|fail|missing",…} (codex-review.sh 와 같은 계약 — 라우터는 구분하지 않는다)
//   node herdr-lanes.mjs verify|plan --diff-ref <ref> --files a,b --slug s [--kinds codex,grok] [--axes "…"] [--cwd] [--json]
//       → harness.json.herdr.kinds.verify 레인들을 돌려 findings 를 verify.js 모양으로 합친다
//   node herdr-lanes.mjs gate --full|--commit [--stage-all] [--no-wait] [--cwd] [--json]
//       → runner pane 에서 gate.mjs 를 돌린다. 기록·토스트는 gate.mjs 가 한다
//   node herdr-lanes.mjs run --spec <spec.json> [--cwd] [--json]
//       spec = { lanes: [{ name, kind, prompt | prompt_file, out, cwd?, worktree_branch?, args?[], reuse?, fresh? }], timeout_s?, close_panes? }
// 종료 코드: 0 (레인 실패는 결과 JSON 의 status 로 본다 — 리뷰 레인이 죽었다고 라우터를 죽이지 않는다) · 2 사용법/설정
// Herdr 밖(HERDR_PANE_ID 없음)이면 status:"failed" reason:"outside herdr" — 라우터는 그때 exec/Workflow 경로로 돌아간다.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { locateProject, loadConfig, branchSlug } from './lib/config.mjs';
import { currentBranch } from './lib/git.mjs';
import { herdr, herdrEnv, herdrConfig, herdrPing } from './lib/herdr.mjs';

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

/** kind 별 기본 네이티브 인자 — 실측 함정을 기본값으로 박는다. harness.json.herdr.kind_args 가 덮어쓴다 */
export const DEFAULT_KIND_ARGS = {
  codex: process.platform === 'win32' ? ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'] : ['--ask-for-approval', 'never'],
  claude: ['--permission-mode', 'acceptEdits'],
  grok: [],
};
const TEACH_DIALOG = /teach auto mode|teach .* about your environment/i;
const UPDATE_DIALOG = /update now|skip/i;
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

/** 살아 있는 에이전트 중 재사용할 것 — 이름이 같거나(kind 같고 · cwd 같고 · idle/done) */
export function findReusable(lane, workDir, env) {
  const r = herdr(['agent', 'list'], { cwd, env, timeout: 5000 });
  const agents = r.ok ? (r.value?.result?.agents ?? []) : [];
  const norm = a => ({ name: a.name ?? null, kind: a.agent ?? a.kind ?? null, state: a.agent_status ?? a.state ?? null, pane: a.pane_id ?? null, cwd: a.cwd ?? null });
  const list = agents.map(norm);
  const byName = list.find(a => a.name === lane.name);
  if (byName) return READY.has(byName.state) ? byName : { ...byName, busy: true };
  const byKind = list.find(a => a.kind === lane.kind && READY.has(a.state) && sameDir(a.cwd, workDir));
  return byKind ?? null;
}

/** 레인 하나를 끝까지. 절대 throw 하지 않는다 — {name, kind, status, reason?, result?, pane?, reused?, screen_tail?} */
export async function runLane(lane, { env = process.env, timeoutS = 900, kindArgs = {}, closePanes = false, laneCwd } = {}) {
  const t0 = Date.now();
  const res = { name: lane.name, kind: lane.kind, status: 'failed', pane: null, out: fwd(lane.out), seconds: 0, reused: false };
  const done = (patch) => { Object.assign(res, patch); res.seconds = +((Date.now() - t0) / 1000).toFixed(1); return res; };
  const h = herdrEnv(env);
  if (!h.inside) return done({ reason: 'outside herdr' });
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(lane.name)) return done({ reason: `레인 이름 형식 오류: ${lane.name} (Herdr 규칙 [a-z][a-z0-9_-]{0,31})` });
  const workDir = lane.cwd ?? laneCwd ?? cwd;
  let name = lane.name;

  // 1. pane — 재사용 / split / worktree
  let pane = null;
  if (lane.reuse !== false && !lane.worktree_branch) {
    const found = findReusable(lane, workDir, env);
    if (found?.busy) return done({ status: 'busy', reason: `${lane.name} 이 이미 working 상태 — 끝나길 기다리거나 다른 이름으로 하나 더 띄울 것`, pane: found.pane });
    if (found) {
      pane = found.pane; res.reused = true;
      if (found.name !== lane.name) herdr(['agent', 'rename', pane, lane.name], { cwd, env, timeout: 5000 });
      if (lane.fresh) { herdr(['agent', 'prompt', name, '/new'], { cwd, env, timeout: 15000 }); await sleep(1500); res.fresh = true; }
    }
  }
  if (!pane) {
    if (lane.worktree_branch) {
      const r = herdr(['worktree', 'create', '--cwd', workDir, '--branch', lane.worktree_branch, '--label', lane.name, '--no-focus'], { cwd, env, timeout: 60000 });
      if (!r.ok) return done({ reason: `worktree create 실패: ${r.reason}` });
      pane = r.value?.result?.root_pane?.pane_id ?? r.value?.result?.pane?.pane_id ?? null;
    } else {
      const anchor = h.pane ? ['--pane', h.pane] : ['--current'];
      const r = herdr(['pane', 'split', ...anchor, '--direction', 'right', '--cwd', workDir, '--no-focus'], { cwd, env, timeout: 15000 });
      if (!r.ok) return done({ reason: `pane split 실패: ${r.reason}` });
      pane = r.value?.result?.pane?.pane_id ?? null;
    }
    if (!pane) return done({ reason: 'pane id 를 응답에서 못 읽음' });
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
    if (!st.ok) return done({ reason: `agent start 실패: ${st.reason}`, screen_tail: screen(lane.name, env, 15).slice(-600) });
  }
  res.pane = pane;

  // 3. 프롬프트 파일
  const promptText = lane.prompt ?? (lane.prompt_file ? readFileSync(resolve(lane.prompt_file), 'utf8') : '');
  if (!promptText.trim()) return done({ reason: '프롬프트가 비었다' });
  const promptFile = resolve(`${lane.out}.prompt.md`);
  mkdirSync(dirname(promptFile), { recursive: true });
  const full = `${promptText.trim()}\n\n---\n결과 규약(반드시):\n- 결과 JSON 을 파일 \`${fwd(resolve(lane.out))}\` 에 쓴다(UTF-8, 그 파일이 유일한 산출물 — 화면 출력은 회수되지 않는다).\n- 다 쓰면 마지막 줄에 \`DONE ${fwd(resolve(lane.out))}\` 만 출력하고 멈춘다. 파일을 못 쓰면 이유를 \`${fwd(resolve(lane.out))}.error.txt\` 에 쓴다.\n- 사용량 한도·요금 한도에 걸려 일을 못 하면 파일에 \`{"status":"limit","summary":"<사유>"}\` 만 쓴다 — 한도를 감추고 빈 findings 를 내지 않는다.\n`;
  writeFileSync(promptFile, full, 'utf8');
  const submit = `Read the file ${fwd(promptFile)} and do exactly what it says. The only deliverable is the JSON file it names.`;

  // 4. 제출 + 확인
  const pr = herdr(['agent', 'prompt', name, submit], { cwd, env, timeout: 30000 });
  if (!pr.ok && !/agent_blocked/.test(pr.reason ?? '')) return done({ reason: `agent prompt 실패: ${pr.reason}` });
  let state = null; let nudged = false;
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    state = agentState(name, env);
    if (state === 'working' || state === 'blocked') break;
    if (i === 2 && !nudged && (state === 'idle' || state === 'done' || state === 'unknown')) {
      // 텍스트만 들어가고 제출이 안 된 형태(codex·grok 실측) — 화면에 우리 문장이 남아 있으면 enter 한 번
      if (screen(name, env, 10).includes('Read the file')) { herdr(['agent', 'send-keys', name, 'enter'], { cwd, env }); nudged = true; }
    }
  }
  res.nudged = nudged;

  // 5. settled 대기 (+ teach 다이얼로그만 자동 esc, 1회)
  let escaped = false;
  for (let round = 0; round < 2; round++) {
    const w = herdr(['agent', 'wait', name, '--timeout', String(timeoutS * 1000)], { cwd, env, timeout: timeoutS * 1000 + 5000 });
    state = w.ok ? (w.value?.result?.state ?? w.value?.result?.agent?.state ?? agentState(name, env)) : agentState(name, env);
    if (!w.ok && /timeout/i.test(w.reason ?? '')) return done({ reason: `레인 시간 초과 ${timeoutS}s`, state, screen_tail: screen(name, env, 15).slice(-600) });
    if (state === 'blocked') {
      const s = screen(name, env, 25);
      if (!escaped && TEACH_DIALOG.test(s)) { herdr(['agent', 'send-keys', name, 'esc'], { cwd, env }); escaped = true; await sleep(1000); continue; }
      return done({ status: 'blocked', reason: '에이전트가 승인/질문 UI 에서 멈춤 — 사람이 pane 을 볼 것', state, screen_tail: s.slice(-600) });
    }
    break;
  }
  res.escaped = escaped;

  // 6. 결과 파일
  const outPath = resolve(lane.out);
  if (!existsSync(outPath)) {
    const errFile = `${outPath}.error.txt`;
    const tail = screen(name, env, 15).slice(-600);
    return done({ status: LIMIT_PATTERN.test(tail) ? 'limit' : 'failed', reason: existsSync(errFile) ? `레인 보고 오류: ${readFileSync(errFile, 'utf8').slice(0, 300)}` : `결과 파일 없음: ${fwd(outPath)}`, state, screen_tail: tail });
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(outPath, 'utf8')); } catch (e) { return done({ reason: `결과 JSON 파싱 실패: ${e.message}`, state }); }
  if (parsed && parsed.status === 'limit') return done({ status: 'limit', reason: `사용량 한도: ${parsed.summary ?? ''}`, result: parsed, state });
  if (closePanes && !res.reused) herdr(['pane', 'close', pane], { cwd, env });
  return done({ status: 'done', result: parsed, state });
}

export async function runSpec(spec, opts = {}) {
  const lanes = Array.isArray(spec.lanes) ? spec.lanes : [];
  const results = [];
  for (const l of lanes) results.push(await runLane(l, { ...opts, timeoutS: spec.timeout_s ?? opts.timeoutS, closePanes: spec.close_panes ?? opts.closePanes }));
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

export function buildVerifySpec({ cfg, root, diffRef, files, slug, kinds, axes, runtimeDir }) {
  const hc = herdrConfig(cfg);
  const useKinds = kinds?.length ? kinds : (hc.kinds?.verify ?? ['codex']);
  const outDir = join(root, runtimeDir ?? cfg.runtime_dir, 'issues');
  const lanes = useKinds.map(kind => ({
    name: `review-${kind}`.replace(/[^a-z0-9_-]/g, '-').slice(0, 32),
    kind,
    reuse: true,
    out: fwd(join(outDir, `${slug}.herdr-${kind}.json`)),
    prompt: reviewPrompt({ root, diffCmd: `git diff ${diffRef}`, files, axes }),
  }));
  return { lanes, timeout_s: hc.lane_timeout_s ?? 900, close_panes: hc.close_panes ?? false, kind_args: hc.kind_args ?? {} };
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
export function reviewerFresh({ cfg, root, kind, slug }) {
  const policy = herdrConfig(cfg).reviewer_context ?? 'issue';
  const file = join(root, cfg.runtime_dir, 'herdr', `reviewer-${kind}.json`);
  const last = readJson(file);
  const fresh = policy === 'always' ? true : policy === 'never' ? false : (last?.slug ?? null) !== slug;
  writeJson(file, { slug, rounds: (last?.slug === slug ? (last.rounds ?? 0) : 0) + 1, at: new Date().toISOString(), policy });
  return fresh;
}

// ---------------------------------------------------------------- runner(게이트)

function runnerPane(cfg, root, env) {
  const file = join(root, cfg.runtime_dir, 'herdr', 'runner.json');
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
  const USAGE = '사용법: herdr-lanes.mjs codex-review|verify|plan|gate|gate-run|run … [--cwd <dir>] [--json]';
  if (!cmd || !['run', 'verify', 'plan', 'codex-review', 'gate', 'gate-run'].includes(cmd)) fail(2, USAGE);
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
  const root = proj.toplevel;
  const hc = herdrConfig(cfg);

  // gate-run: runner pane 안에서 실제로 도는 명령(셸 무관 — 한 프로세스가 gate.mjs 실행·결과 파일·완료 표식까지)
  if (cmd === 'gate-run') {
    const level = flag('--full') ? '--full' : '--commit';
    const out = opt('--out'); const nonce = opt('--nonce') ?? 'x';
    if (!out) fail(2, '--out 이 필요하다');
    const args = [join(PLUGIN_ROOT, 'scripts', 'gate.mjs'), level, '--cwd', root, '--json', ...(flag('--stage-all') ? ['--stage-all'] : [])];
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    let summary = null; try { summary = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { summary = null; }
    writeJson(resolve(out), { exit: r.status ?? 1, level: level.slice(2), at: new Date().toISOString(), summary, stdout_tail: (r.stdout ?? '').slice(-2000) });
    if (summary) console.log(`[gate] ${summary.level} ${summary.overall} · ${summary.duration_s}s · dod ${summary.dod}`);
    console.log(`GATE_DONE_${nonce}`);
    process.exit(0);
  }

  if (cmd === 'gate') {
    const level = flag('--full') ? 'full' : 'commit';
    const h = herdrEnv(env);
    if (!h.inside || hc.enabled === false) { const o = { ok: false, reason: !h.inside ? 'outside herdr' : 'herdr.enabled=false' }; if (asJson) console.log(JSON.stringify(o)); else console.log(`[herdr-lanes] gate: ${o.reason} — gate.mjs 를 직접 돌릴 것`); return; }
    const rp = runnerPane(cfg, root, env);
    if (rp.error) { const o = { ok: false, reason: rp.error }; if (asJson) console.log(JSON.stringify(o)); else console.log(`[herdr-lanes] gate: ${rp.error}`); return; }
    const nonce = `${Date.now().toString(36)}`;
    const out = join(root, cfg.runtime_dir, 'herdr', `gate-${level}-${nonce}.json`);
    const cmdLine = `node "${fwd(join(PLUGIN_ROOT, 'scripts', 'herdr-lanes.mjs'))}" gate-run --${level}${flag('--stage-all') ? ' --stage-all' : ''} --cwd "${fwd(root)}" --out "${fwd(out)}" --nonce ${nonce}`;
    const run = herdr(['pane', 'run', rp.pane, cmdLine], { cwd, env, timeout: 10000 });
    if (!run.ok) { const o = { ok: false, reason: `pane run 실패: ${run.reason}` }; if (asJson) console.log(JSON.stringify(o)); else console.log(`[herdr-lanes] ${o.reason}`); return; }
    herdrPing(cwd, `gate ${level} → runner ${rp.pane}`);
    const base = { ok: true, pane: rp.pane, reused: rp.reused, level, out: fwd(out), nonce, wait: `herdr pane wait-output ${rp.pane} --match GATE_DONE_${nonce}` };
    if (flag('--no-wait')) { if (asJson) console.log(JSON.stringify(base)); else console.log(`[herdr-lanes] gate ${level} 시작 — runner ${rp.pane}${rp.reused ? '(재사용)' : ''} · 완료 토스트를 기다리거나: ${base.wait}`); return; }
    const timeoutMs = (cfg.gate?.timeout_s ?? 1800) * 1000 + 60000;
    const w = herdr(['pane', 'wait-output', rp.pane, '--match', `GATE_DONE_${nonce}`, '--timeout', String(timeoutMs)], { cwd, env, timeout: timeoutMs + 5000 });
    const result = readJson(out);
    const o = { ...base, waited: w.ok, summary: result?.summary ?? null, exit: result?.exit ?? null, reason: w.ok ? undefined : `wait-output: ${w.reason}` };
    if (asJson) console.log(JSON.stringify(o, null, 2));
    else console.log(o.summary ? `[herdr-lanes] gate ${o.summary.level} ${o.summary.overall} · ${o.summary.duration_s}s · runner ${rp.pane}` : `[herdr-lanes] gate 결과 없음 — ${o.reason ?? '결과 파일 미생성'} (runner ${rp.pane} 화면을 볼 것)`);
    return;
  }

  const diffRef = opt('--diff-ref') ?? `${cfg.default_branch}...HEAD`;
  const files = (opt('--files') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const slug = opt('--slug') ?? branchSlug(currentBranch(cwd) ?? 'work');

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
    const out = fwd(join(root, cfg.runtime_dir, 'issues', `${slug}.herdr-${kind}${since ? '-delta' : ''}.json`));
    const fresh = reviewerFresh({ cfg, root, kind, slug });
    const lane = { name: `review-${kind}`, kind, reuse: true, fresh, out, prompt: reviewPrompt({ root, diffCmd, files, axes: opt('--axes') }) };
    herdrPing(cwd, `codex-review ${kind}${fresh ? ' (/new)' : ''}`);
    const l = await runLane(lane, { env, timeoutS: hc.lane_timeout_s ?? 900, kindArgs: hc.kind_args ?? {}, closePanes: false, laneCwd: root });
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
    if (cmd === 'verify') { const o = { ok: false, reason: `herdr.lanes=${hc.lanes ?? 'off'} — Herdr 리뷰 레인은 꺼져 있다(harness.json.herdr.lanes 를 verify 로)`, lanes: [], findings: [] }; if (asJson) console.log(JSON.stringify(o)); else console.log(`[herdr-lanes] ${o.reason}`); return; }
  }
  const kinds = (opt('--kinds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const spec = buildVerifySpec({ cfg, root, diffRef, files, slug, kinds, axes: opt('--axes') });
  if (cmd === 'plan') { if (asJson) console.log(JSON.stringify(spec, null, 2)); else console.log(`[herdr-lanes] plan: ${spec.lanes.map(l => `${l.name}(${l.kind}) → ${l.out}`).join(' · ')}`); return; }
  for (const l of spec.lanes) l.fresh = reviewerFresh({ cfg, root, kind: l.kind, slug });
  herdrPing(cwd, `verify lanes ${spec.lanes.map(l => l.kind).join('+')}`);
  const run = await runSpec(spec, { kindArgs: spec.kind_args, laneCwd: root });
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
