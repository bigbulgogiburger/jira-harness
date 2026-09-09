// herdr.mjs — Herdr(터미널 워크스페이스 매니저) 연동. 전부 **표시·알림 전용**이고 실패는 조용히 삼킨다.
//
// 원칙
//   - Herdr 밖(HERDR_PANE_ID 없음)에서는 아무것도 하지 않는다 — 훅·스크립트 어디서 불러도 무해.
//   - lifecycle 권위(`pane report-agent` 의 idle/working/blocked)는 건드리지 않는다. 통합 훅·화면 매니페스트가 그 축의 주인이라
//     우리가 덮으면 대기(agent wait)·알림이 어긋난다. 우리는 `pane report-metadata`(토큰·상태 라벨·제목 — 표시만) 와
//     `notification show` 만 쓴다.
//   - herdr 바이너리는 HERDR_BIN_PATH → PATH 의 herdr. 테스트 셈: JIRA_HARNESS_HERDR=node:<script.mjs>.
//   - 호출은 3초 타임아웃. 판정 경로(훅)에서 불려도 30초 훅 타임아웃을 먹지 않는다.
//
// 토큰(사이드바 커스텀 토큰 — `[ui.sidebar.agents] rows = [["state_icon","$case","$stage"],["$gate","$review","$loop"]]`):
//   case   = 이슈 키(다중이면 "+n")          stage  = 상태 JSON 의 stage
//   gate   = "<level> <PASS|FAIL>" · 낡으면 뒤에 "(stale)" · 없으면 "-"
//   review = "r<round> b<blockers>" · 낡으면 "(stale)" · 없으면 "-"
//   loop   = "R<n> <active> <verdict>" · .loop/ 가 없는 프로젝트(이 플러그인 기본)는 "-"
//   event  = 마지막 사건 한 줄(예: "gate commit FAIL")
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { locateProject, loadConfig, parseBranch, branchSlug, statePath, readState } from './config.mjs';
import { currentBranch } from './git.mjs';
import { fingerprintTree } from './tree.mjs';
import { treeAccepted } from './gate-core.mjs';

const OKSET = new Set(['PASS', 'SKIPPED']);
/** gate 기록의 결과 한 단어 — gate.mjs 와 같은 축(레벨에 속한 키만 본다. NOT_RUN 은 그 레벨의 키가 아니다) */
export function gateOverall(gate) {
  if (!gate) return null;
  const keys = gate.level === 'full' ? ['compile', 'lint', 'build', 'test', 'extra', 'dod'] : ['compile', 'lint', 'dod'];
  return keys.every(k => OKSET.has(gate.results?.[k])) ? 'PASS' : 'FAIL';
}

export const SOURCE = 'jira-harness';
const TIMEOUT_MS = 3000;

/** Herdr 안인가 + 호출에 필요한 식별자 */
export function herdrEnv(env = process.env) {
  const pane = env.HERDR_PANE_ID || null;
  const inside = !!(pane || env.HERDR_ENV === '1' || env.HERDR_SOCKET_PATH);
  return { inside, pane, workspace: env.HERDR_WORKSPACE_ID || null, tab: env.HERDR_TAB_ID || null, bin: env.JIRA_HARNESS_HERDR || env.HERDR_BIN_PATH || 'herdr' };
}

/** harness.json.herdr 설정(기본 enabled·notify 모두 true) */
export function herdrConfig(cfg) { return { enabled: true, notify: true, ...(cfg?.herdr ?? {}) }; }

/** herdr CLI 한 번. {ok, value(JSON 이면 파싱), out, reason}. 절대 throw 하지 않는다. */
export function herdr(args, { cwd, env = process.env, timeout = TIMEOUT_MS } = {}) {
  const bin = env.JIRA_HARNESS_HERDR || env.HERDR_BIN_PATH || 'herdr';
  let r;
  try {
    r = bin.startsWith('node:')
      ? spawnSync(process.execPath, [bin.slice(5), ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout, env })
      : spawnSync(bin, args, { cwd, encoding: 'utf8', windowsHide: true, timeout, env, shell: false });
  } catch (e) { return { ok: false, reason: `herdr 실행 불가: ${e.message}` }; }
  if (r.error) return { ok: false, reason: `herdr 실행 불가: ${r.error.message}` };
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0) return { ok: false, reason: `herdr ${args.slice(0, 2).join(' ')} exit ${r.status}: ${(r.stderr || out).trim().slice(0, 200)}`, out };
  let value = null;
  try { value = out ? JSON.parse(out) : null; } catch { value = null; }
  return { ok: true, value, out };
}

/** 표시 메타데이터 보고(pane). tokens 값 null 은 --clear-token. */
export function reportPane({ pane, title, displayAgent, stateLabels, tokens, ttlMs, source = SOURCE }, opts = {}) {
  if (!pane) return { ok: false, reason: 'pane 없음' };
  const args = ['pane', 'report-metadata', pane, '--source', source];
  if (title) args.push('--title', String(title).slice(0, 120));
  if (displayAgent) args.push('--display-agent', String(displayAgent).slice(0, 60));
  for (const [k, v] of Object.entries(stateLabels ?? {})) if (v) args.push('--state-label', `${k}=${String(v).slice(0, 80)}`);
  for (const [k, v] of Object.entries(tokens ?? {})) {
    if (v === null || v === undefined) args.push('--clear-token', k);
    else args.push('--token', `${k}=${String(v).slice(0, 80)}`);
  }
  if (ttlMs) args.push('--ttl-ms', String(ttlMs));
  return herdr(args, opts);
}

/** 워크스페이스 토큰(사이드바 space 행 — `$case` 등) */
export function reportWorkspace({ workspace, tokens, ttlMs, source = SOURCE }, opts = {}) {
  if (!workspace) return { ok: false, reason: 'workspace 없음' };
  const args = ['workspace', 'report-metadata', workspace, '--source', source];
  for (const [k, v] of Object.entries(tokens ?? {})) {
    if (v === null || v === undefined) args.push('--clear-token', k);
    else args.push('--token', `${k}=${String(v).slice(0, 80)}`);
  }
  if (ttlMs) args.push('--ttl-ms', String(ttlMs));
  return herdr(args, opts);
}

/** 토스트 알림. sound: none|done|request */
export function notify(title, { body, sound = 'none', position } = {}, opts = {}) {
  const args = ['notification', 'show', String(title).slice(0, 120)];
  if (body) args.push('--body', String(body).slice(0, 300));
  if (sound && sound !== 'none') args.push('--sound', sound);
  if (position) args.push('--position', position);
  return herdr(args, opts);
}

function readJson(p) { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } }

/**
 * 현재 디렉터리의 이슈·게이트·리뷰·루프 상태를 토큰으로 요약한다. 하네스 밖이면 null.
 * session-brief 와 같은 재료를 보되, 사람 문장이 아니라 사이드바 한 칸에 들어갈 짧은 값이다.
 */
export function buildStatus(cwd) {
  const proj = locateProject(cwd);
  if (!proj || !proj.configPath) return null;
  const cfg = loadConfig(proj.configPath);
  const root = proj.configRoot;
  const branch = currentBranch(cwd);
  const parsed = branch ? parseBranch(branch, cfg) : null;
  const s = { cfg, root, branch, keys: [], stage: null, gate: '-', review: '-', loop: '-', blocked: null, tracker: 'jira' };
  if (parsed) {
    const st = readState(statePath(cfg, root, parsed.slug ?? branchSlug(branch)));
    s.keys = st?.keys ?? parsed.keys;
    if (st) {
      // 신선도 = 게이트가 본 인덱스 지문 vs 지금 인덱스 지문(훅과 같은 축) — HEAD 트리와 비교하면 항상 낡은 것으로 보인다
      let fresh = () => false;
      try { const tree = fingerprintTree({ cwd: proj.toplevel, base: 'index', excludes: cfg.fingerprint_exclude }); fresh = rec => treeAccepted(rec, tree, cfg, proj.toplevel).ok; } catch { /* 지문 실패 = 낡음 */ }
      s.stage = st.stage;
      if (st.gate) s.gate = `${st.gate.level ?? '?'} ${gateOverall(st.gate)}${fresh(st.gate.tree) ? '' : ' (stale)'}`;
      if (st.review) s.review = `r${st.review.round ?? '?'} b${st.review.blockers_open ?? '?'}${fresh(st.review.tree) ? '' : ' (stale)'}`;
      const humans = (st.dod ?? []).filter(d => d.human && d.last !== 'PASS').map(d => d.id);
      if (humans.length) s.blocked = `사람 확인 DoD ${humans.join(',')}`;
    }
  }
  const sc = readJson(join(root, '.loop', 'scorecard.json'));
  const ck = readJson(join(root, '.loop', 'checkpoint.json'));
  if (sc || ck) s.loop = `R${sc?.round ?? 0} ${sc?.active_total ?? '-'} ${ck?.last_verdict ?? ''}`.trim();
  return s;
}

/** 토큰·라벨·제목으로 변환 */
export function toMetadata(s, event) {
  const key = s.keys.length ? (s.keys.length > 1 ? `${s.keys[0]}+${s.keys.length - 1}` : s.keys[0]) : (s.branch ?? '-');
  const stage = s.stage ?? (s.keys.length ? 'no-state' : 'no-issue');
  const tokens = { case: key, stage, gate: s.gate, review: s.review, loop: s.loop };
  if (event) tokens.event = event;
  const head = `${key} · ${stage}`;
  const stateLabels = {
    working: head,
    idle: `${head} · gate ${s.gate}`,
    done: `${head} · gate ${s.gate}`,
    blocked: s.blocked ? `${key} · ${s.blocked}` : `${head} · 입력 대기`,
  };
  return { title: head, stateLabels, tokens };
}

/**
 * 한 번에: 상태 계산 → pane/workspace 메타데이터 보고 → (선택) 알림.
 * Herdr 밖·설정 off·하네스 밖이면 {ok:false, reason} 만 돌려주고 아무것도 하지 않는다. 절대 throw 하지 않는다.
 */
export function herdrReport(cwd, { event = null, notify: n = null, env = process.env, dryRun = false, pane = null, workspace = null } = {}) {
  try {
    const h = herdrEnv(env);
    if (pane) { h.pane = pane; h.inside = true; }
    if (workspace) { h.workspace = workspace; h.inside = true; }
    if (!h.inside) return { ok: false, reason: 'outside herdr' };
    const s = buildStatus(cwd);
    if (!s) return { ok: false, reason: 'no harness' };
    const hc = herdrConfig(s.cfg);
    if (hc.enabled === false) return { ok: false, reason: 'herdr.enabled=false' };
    const meta = toMetadata(s, event);
    const calls = [];
    const run = (fn, ...a) => { if (dryRun) { calls.push(a[0]); return { ok: true, dry: true }; } return fn(...a); };
    const results = {};
    if (h.pane) results.pane = dryRun ? run(null, { pane: h.pane, ...meta }) : reportPane({ pane: h.pane, ...meta }, { cwd, env });
    if (h.workspace) results.workspace = dryRun ? run(null, { workspace: h.workspace, tokens: { case: meta.tokens.case, stage: meta.tokens.stage } }) : reportWorkspace({ workspace: h.workspace, tokens: { case: meta.tokens.case, stage: meta.tokens.stage } }, { cwd, env });
    if (n && hc.notify !== false) {
      const spec = typeof n === 'string' ? { title: n } : n;
      results.notify = dryRun ? run(null, { notify: spec }) : notify(spec.title, { body: spec.body, sound: spec.sound }, { cwd, env });
    }
    return { ok: true, pane: h.pane, workspace: h.workspace, meta, results, calls: dryRun ? calls : undefined };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** 스크립트에서 부르는 무해 래퍼 — 결과를 기다리지만 실패는 무시. `event` 한 줄과 선택 알림. */
export function herdrPing(cwd, event, notifySpec = null) {
  try { return herdrReport(cwd, { event, notify: notifySpec }); } catch { return { ok: false }; }
}
