#!/usr/bin/env node
// herdr-lanes.mjs — Herdr pane 의 **다른 에이전트**(codex·grok·claude …)를 레인으로 돌리는 실행기.
//
// 왜: Workflow 서브에이전트는 안 보이고·세션과 함께 죽고·Claude 모델뿐이다. 리뷰(verify)만큼은 다른 모델이 심판해야 maker≠verifier 가 성립한다.
// 어떻게(레인 1개):
//   1. pane 확보 — 현재 pane 옆에 split(기본) 또는 `worktree_branch` 가 있으면 worktree 워크스페이스
//   2. `agent start <name> --kind <kind> --pane <id> -- <kind_args>` (kind 별 네이티브 인자 — Windows codex 는 샌드박스 해제가 필수)
//   3. 프롬프트는 argv 가 아니라 파일로 — `<out>.prompt.md` 를 쓰고 "그 파일을 읽고 따르라" 한 줄만 보낸다(인자 한계·Codex Windows 제출 지연 회피)
//   4. ★제출 확인 — `agent prompt` 의 성공 응답은 제출을 증명하지 않는다(codex·grok 실측). `agent get` 이 working/blocked 로 바뀌었는지 보고,
//      아니면 화면에 남은 프롬프트를 `send-keys enter` 로 밀어 넣는다(1회)
//   5. `agent wait` 로 settled 상태 대기. blocked 면 화면을 읽어 **"Teach auto mode" 다이얼로그일 때만** `esc`(그 외 승인·권한 UI 는 사람 몫 — 레인을 blocked 로 보고)
//   6. ★결과는 화면이 아니라 파일 — 레인이 `<out>` 에 쓴 JSON 을 읽는다(alt-screen 스크롤백은 회수되지 않는다). 없으면 failed
//   7. `close_panes` 면 pane 을 닫는다(기본 false — 사람이 화면을 본다)
//
// 사용:
//   node herdr-lanes.mjs run --spec <spec.json> [--cwd <dir>] [--json]
//     spec = { lanes: [{ name, kind, prompt | prompt_file, out, cwd?, worktree_branch?, args?[] }], timeout_s?, close_panes? }
//   node herdr-lanes.mjs verify --diff-ref <ref> --files <a,b,…> --slug <slug> [--kinds codex,grok] [--axes "…"] [--cwd <dir>] [--json]
//     harness.json.herdr 로 리뷰 레인 spec 을 만들어 run 하고, findings 를 verify.js 와 같은 모양으로 합쳐 낸다
//   node herdr-lanes.mjs plan --diff-ref … (verify 와 같되 spec 만 출력, 실행 없음)
// 종료 코드: 0 (레인 실패는 결과 JSON 의 lanes[].status 로 본다 — 리뷰 레인이 죽었다고 라우터를 죽이지 않는다) · 2 사용법/설정
// Herdr 밖(HERDR_PANE_ID 없음)이면 모든 레인이 status:"failed" reason:"outside herdr" 다 — 라우터는 그때 Workflow 레인으로 돌아간다.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { locateProject, loadConfig, branchSlug } from './lib/config.mjs';
import { herdr, herdrEnv, herdrConfig, herdrPing } from './lib/herdr.mjs';

const argv = process.argv.slice(2);
const cmd = argv.find(a => !a.startsWith('--'));
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const asJson = flag('--json');
const cwd = resolve(opt('--cwd') ?? process.cwd());
function fail(code, msg) { console.error(`[herdr-lanes] ${msg}`); process.exit(code); }
function fwd(p) { return String(p).replace(/\\/g, '/'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** kind 별 기본 네이티브 인자 — 실측 함정을 기본값으로 박는다. harness.json.herdr.kind_args 가 덮어쓴다 */
export const DEFAULT_KIND_ARGS = {
  codex: process.platform === 'win32' ? ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'] : ['--ask-for-approval', 'never'],
  claude: ['--permission-mode', 'acceptEdits'],
  grok: [],
};
const TEACH_DIALOG = /teach auto mode|teach .* about your environment/i;
const UPDATE_DIALOG = /update now|skip/i;

function agentState(name, env) {
  const r = herdr(['agent', 'get', name], { cwd, env, timeout: 5000 });
  if (!r.ok) return null;
  const a = r.value?.result?.agent ?? r.value?.result ?? r.value;
  return a?.state ?? a?.status ?? null;
}
function screen(name, env, lines = 40) {
  const r = herdr(['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', String(lines)], { cwd, env, timeout: 5000 });
  return r.ok ? (r.out ?? '') : '';
}

/** 레인 하나를 끝까지. 절대 throw 하지 않는다 — {name, kind, status, reason?, result?, pane?, screen_tail?} */
export async function runLane(lane, { env = process.env, timeoutS = 900, kindArgs = {}, closePanes = false, laneCwd } = {}) {
  const t0 = Date.now();
  const res = { name: lane.name, kind: lane.kind, status: 'failed', pane: null, out: fwd(lane.out), seconds: 0 };
  const done = (patch) => { Object.assign(res, patch); res.seconds = +((Date.now() - t0) / 1000).toFixed(1); return res; };
  const h = herdrEnv(env);
  if (!h.inside) return done({ reason: 'outside herdr' });
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(lane.name)) return done({ reason: `레인 이름 형식 오류: ${lane.name} (Herdr 규칙 [a-z][a-z0-9_-]{0,31})` });
  const workDir = lane.cwd ?? laneCwd ?? cwd;

  // 1. pane
  let pane;
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

  // 3. 프롬프트 파일
  const promptText = lane.prompt ?? (lane.prompt_file ? readFileSync(resolve(lane.prompt_file), 'utf8') : '');
  if (!promptText.trim()) return done({ reason: '프롬프트가 비었다' });
  const promptFile = resolve(`${lane.out}.prompt.md`);
  mkdirSync(dirname(promptFile), { recursive: true });
  const full = `${promptText.trim()}\n\n---\n결과 규약(반드시):\n- 결과 JSON 을 파일 \`${fwd(resolve(lane.out))}\` 에 쓴다(UTF-8, 그 파일이 유일한 산출물 — 화면 출력은 회수되지 않는다).\n- 다 쓰면 마지막 줄에 \`DONE ${fwd(resolve(lane.out))}\` 만 출력하고 멈춘다. 파일을 못 쓰면 이유를 \`${fwd(resolve(lane.out))}.error.txt\` 에 쓴다.\n`;
  writeFileSync(promptFile, full, 'utf8');
  const submit = `Read the file ${fwd(promptFile)} and do exactly what it says. The only deliverable is the JSON file it names.`;

  // 4. 제출 + 확인
  const pr = herdr(['agent', 'prompt', lane.name, submit], { cwd, env, timeout: 30000 });
  if (!pr.ok && !/agent_blocked/.test(pr.reason ?? '')) return done({ reason: `agent prompt 실패: ${pr.reason}` });
  let state = null; let nudged = false;
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    state = agentState(lane.name, env);
    if (state === 'working' || state === 'blocked') break;
    if (i === 2 && !nudged && (state === 'idle' || state === 'done' || state === 'unknown')) {
      // 텍스트만 들어가고 제출이 안 된 형태(codex·grok 실측) — 화면에 우리 문장이 남아 있으면 enter 한 번
      if (screen(lane.name, env, 10).includes('Read the file')) { herdr(['agent', 'send-keys', lane.name, 'enter'], { cwd, env }); nudged = true; }
    }
  }
  res.nudged = nudged;

  // 5. settled 대기 (+ teach 다이얼로그만 자동 esc, 1회)
  let escaped = false;
  for (let round = 0; round < 2; round++) {
    const w = herdr(['agent', 'wait', lane.name, '--timeout', String(timeoutS * 1000)], { cwd, env, timeout: timeoutS * 1000 + 5000 });
    state = w.ok ? (w.value?.result?.state ?? w.value?.result?.agent?.state ?? agentState(lane.name, env)) : agentState(lane.name, env);
    if (!w.ok && /timeout/i.test(w.reason ?? '')) return done({ reason: `레인 시간 초과 ${timeoutS}s`, state, screen_tail: screen(lane.name, env, 15).slice(-600) });
    if (state === 'blocked') {
      const s = screen(lane.name, env, 25);
      if (!escaped && TEACH_DIALOG.test(s)) { herdr(['agent', 'send-keys', lane.name, 'esc'], { cwd, env }); escaped = true; await sleep(1000); continue; }
      return done({ status: 'blocked', reason: '에이전트가 승인/질문 UI 에서 멈춤 — 사람이 pane 을 볼 것', state, screen_tail: s.slice(-600) });
    }
    break;
  }
  res.escaped = escaped;

  // 6. 결과 파일
  const outPath = resolve(lane.out);
  if (!existsSync(outPath)) {
    const errFile = `${outPath}.error.txt`;
    return done({ reason: existsSync(errFile) ? `레인 보고 오류: ${readFileSync(errFile, 'utf8').slice(0, 300)}` : `결과 파일 없음: ${fwd(outPath)}`, state, screen_tail: screen(lane.name, env, 15).slice(-600) });
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(outPath, 'utf8')); } catch (e) { return done({ reason: `결과 JSON 파싱 실패: ${e.message}`, state }); }
  if (closePanes) herdr(['pane', 'close', pane], { cwd, env });
  return done({ status: 'done', result: parsed, state });
}

export async function runSpec(spec, opts = {}) {
  const lanes = Array.isArray(spec.lanes) ? spec.lanes : [];
  const results = [];
  for (const l of lanes) results.push(await runLane(l, { ...opts, timeoutS: spec.timeout_s ?? opts.timeoutS, closePanes: spec.close_panes ?? opts.closePanes }));
  return { lanes: results, done: results.filter(r => r.status === 'done').map(r => r.name), failed: results.filter(r => r.status !== 'done').map(r => `${r.name}: ${r.reason ?? r.status}`) };
}

// ---------------------------------------------------------------- verify spec

const REVIEW_SCHEMA = '{ "findings": [ { "severity": "BLOCKER|MAJOR|MINOR", "file": "path", "line": 0, "claim": "한 줄 주장", "evidence": "근거(코드·재현)", "axis": "관점" } ], "summary": "한 줄" }';

export function buildVerifySpec({ cfg, root, diffRef, files, slug, kinds, axes, runtimeDir }) {
  const hc = herdrConfig(cfg);
  const useKinds = kinds?.length ? kinds : (hc.kinds?.verify ?? ['codex']);
  const outDir = join(root, runtimeDir ?? cfg.runtime_dir, 'issues');
  const lanes = useKinds.map(kind => ({
    name: `review-${kind}`.replace(/[^a-z0-9_-]/g, '-').slice(0, 32),
    kind,
    out: fwd(join(outDir, `${slug}.herdr-${kind}.json`)),
    prompt: [
      `당신은 이 저장소의 코드 리뷰어다. 저장소 루트: ${fwd(root)}.`,
      `대상: \`git diff ${diffRef}\` (작업트리 변경 포함). 바뀐 파일: ${files.length ? files.join(', ') : '(git diff 로 확인)'}.`,
      axes ? `이번에 볼 관점: ${axes}.` : '관점: 정확성(값·경계·에러 경로) · 계약(호출자↔피호출자 시그니처·경로·파트명) · 보안(입력 검증·권한) · 회귀(기존 테스트가 이 변경을 잡는가).',
      '규칙: 실제로 diff 와 그 주변 코드를 읽고 판단한다. 추측을 finding 으로 적지 않는다. finding 마다 file·line·claim·evidence 를 채운다. 근거 없는 항목은 내지 않는다. 코드를 고치지 않는다(읽기 전용).',
      `출력 JSON 모양: ${REVIEW_SCHEMA}. finding 이 없으면 findings: [] 와 summary 만.`,
    ].join('\n'),
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

// ---------------------------------------------------------------- main

async function main() {
  if (!cmd || !['run', 'verify', 'plan'].includes(cmd)) fail(2, '사용법: herdr-lanes.mjs run --spec <file> | verify|plan --diff-ref <ref> --files a,b --slug <slug> [--kinds codex,grok] [--axes "…"] [--cwd <dir>] [--json]');
  if (cmd === 'run') {
    const specPath = opt('--spec');
    if (!specPath) fail(2, '--spec <file> 이 필요하다');
    let spec; try { spec = JSON.parse(readFileSync(resolve(specPath), 'utf8')); } catch (e) { fail(2, `spec 읽기 실패: ${e.message}`); }
    const r = await runSpec(spec, { kindArgs: spec.kind_args ?? {} });
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else for (const l of r.lanes) console.log(`[herdr-lanes] ${l.name} (${l.kind}) ${l.status}${l.reason ? ` — ${l.reason}` : ''} · ${l.seconds}s · pane ${l.pane ?? '-'}`);
    return;
  }
  const proj = locateProject(cwd);
  if (!proj || !proj.configPath) fail(2, 'harness.json 이 없다');
  const cfg = loadConfig(proj.configPath);
  const hc = herdrConfig(cfg);
  if (cmd === 'verify' && (hc.enabled === false || !['verify', 'all'].includes(hc.lanes ?? 'off'))) {
    const out = { ok: false, reason: `herdr.lanes=${hc.lanes ?? 'off'} — Herdr 리뷰 레인은 꺼져 있다(harness.json.herdr.lanes 를 verify 로)`, lanes: [], findings: [] };
    if (asJson) console.log(JSON.stringify(out)); else console.log(`[herdr-lanes] ${out.reason}`);
    return;
  }
  const diffRef = opt('--diff-ref') ?? `${cfg.default_branch}...HEAD`;
  const files = (opt('--files') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const slug = opt('--slug') ?? branchSlug((await import('./lib/git.mjs')).currentBranch(cwd) ?? 'work');
  const kinds = (opt('--kinds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const spec = buildVerifySpec({ cfg, root: proj.toplevel, diffRef, files, slug, kinds, axes: opt('--axes') });
  if (cmd === 'plan') { if (asJson) console.log(JSON.stringify(spec, null, 2)); else console.log(`[herdr-lanes] plan: ${spec.lanes.map(l => `${l.name}(${l.kind}) → ${l.out}`).join(' · ')}`); return; }
  herdrPing(cwd, `verify lanes ${spec.lanes.map(l => l.kind).join('+')}`);
  const run = await runSpec(spec, { kindArgs: spec.kind_args, laneCwd: proj.toplevel });
  const findings = mergeFindings(run);
  const out = { ok: run.done.length > 0, diffRef, lanes: run.lanes.map(l => ({ name: l.name, kind: l.kind, status: l.status, reason: l.reason, pane: l.pane, out: l.out, seconds: l.seconds, count: Array.isArray(l.result?.findings) ? l.result.findings.length : 0, summary: l.result?.summary })), failed: run.failed, findings, blockers: findings.filter(f => f.severity === 'BLOCKER').length, lanes_reason: `herdr lanes: ${spec.lanes.map(l => l.kind).join('+')} (Codex 밖의 심판 — 다른 모델)` };
  herdrPing(cwd, `verify lanes done ${run.done.length}/${run.lanes.length} · findings ${findings.length}`, out.blockers > 0 ? { title: `리뷰 레인 blocker ${out.blockers}`, sound: 'request' } : null);
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    for (const l of out.lanes) console.log(`[herdr-lanes] ${l.name} ${l.status}${l.reason ? ` — ${l.reason}` : ` · finding ${l.count}`} · ${l.seconds}s`);
    console.log(`[herdr-lanes] findings ${findings.length} (blocker ${out.blockers}) — 확정/기각은 메인이 한다`);
  }
}
main().catch(e => fail(2, e.message));
