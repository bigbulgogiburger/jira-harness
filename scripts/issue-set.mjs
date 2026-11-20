#!/usr/bin/env node
// issue-set.mjs — 브랜치 상태 JSON 에 결정·계획·리뷰 기록을 쓰는 유일한 경로(gate 키는 gate.mjs 만 쓴다).
// 여러 필드 플래그(--stage·--decision·--guide·--touched·--lane·--dod·--dod-result)는 한 호출에 조합할 수 있고,
// --merge·--review 는 파일을 읽어 병합/기록하는 별도 동작이다. --print 는 마지막에 현재 상태를 그대로 찍는다.
//
// 사용:
//   node issue-set.mjs [--cwd <dir>] [--json] [--branch <name>]
//        [--stage <stage> [--note "..."]]
//        [--decision "<q>" "<a>"]...
//        [--assume "<갈림길>" "<고른 해석 — 근거>"]...   ← 사람 결정 없이 드라이버가 고른 해석(assumed: true) — 마감 댓글 맨 위에 올라간다
//        [--guide KEY=path]...
//        [--touched <path>]...
//        [--lane '<json>']...
//        [--dod '<json>']...
//        [--dod-result <id> <PASS|FAIL|SKIPPED> [--evidence "<어디서 무엇을 봤나>"]]...   ← human 항목의 PASS 는 --evidence 필수
//        [--merge <file.json> [--from plan [--no-check "<사유>"]]]   ← --from plan 은 반영 전에 lib/plan-check 를 돌려 오류가 있으면 쓰지 않는다
//        [--review <file.json> [--delta]]   ← 파일 키: round? · codex(string) · lanes(integer) · lanes_reason? · findings(array|integer) · blockers_open?
//        [--print]
//
// 종료 코드: 0 정상 · 1 도메인 위반(잘못된 stage·JSON 파싱 실패·금지 키·알 수 없는 dod id·계획 점검 오류·근거 없는 사람 확인 PASS 등) · 2 사용법/설정/상태 없음.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { locateProject, loadConfig, parseBranch, branchSlug, statePath, readState, writeState, deepMerge } from './lib/config.mjs';
import { checkPlan, loadGuideText, isHumanDod } from './lib/plan-check.mjs';
import { currentBranch, changedVsHead, stagedFiles, pinRef } from './lib/git.mjs';
import { fingerprintTree } from './lib/tree.mjs';
import { herdrPing, herdrEnv } from './lib/herdr.mjs';

const STAGES = ['start', 'grill', 'plan', 'implement', 'review', 'gate', 'complete', 'archived'];
const DOD_STATUSES = ['PASS', 'FAIL', 'SKIPPED'];

function fail(code, msg) { console.error(`[issue-set] ${msg}`); process.exit(code); }

function parseArgs(argvList) {
  const out = {
    cwd: process.cwd(), json: false, branch: null, print: false,
    merge: null, mergeFrom: null, noCheck: null, review: null, reviewDelta: false,
    stage: null, note: null, decisions: [], guides: {}, touched: [], lanes: [], dod: [], dodResults: [],
  };
  let prev = null; // --evidence 는 바로 앞 옵션이 --dod-result 일 때만 붙는다
  for (let i = 0; i < argvList.length; i++) {
    const t = argvList[i];
    const before = prev;
    prev = t;
    switch (t) {
      case '--cwd': out.cwd = argvList[++i]; break;
      case '--json': out.json = true; break;
      case '--branch': out.branch = argvList[++i]; break;
      case '--print': out.print = true; break;
      case '--merge': out.merge = argvList[++i]; break;
      case '--from': out.mergeFrom = argvList[++i]; break;
      case '--review': out.review = argvList[++i]; break;
      case '--delta': out.reviewDelta = true; break;
      case '--stage': out.stage = argvList[++i]; break;
      case '--note': out.note = argvList[++i]; break;
      case '--no-check': {
        const why = argvList[++i];
        if (!why || why.startsWith('--')) fail(2, '--no-check 에 사유가 없다 — --no-check "<점검을 건너뛰는 이유>"');
        out.noCheck = why;
        break;
      }
      case '--decision': out.decisions.push({ q: argvList[++i], a: argvList[++i] }); break;
      case '--assume': out.decisions.push({ q: argvList[++i], a: argvList[++i], assumed: true }); break;
      case '--evidence': {
        if (before !== '--dod-result') fail(2, '--evidence 는 --dod-result <id> <상태> 바로 뒤에만 쓴다');
        const ev = argvList[++i];
        if (!ev) fail(2, '--evidence 에 값이 없다');
        out.dodResults[out.dodResults.length - 1].evidence = ev;
        break;
      }
      case '--guide': {
        const kv = argvList[++i];
        const eq = kv ? kv.indexOf('=') : -1;
        if (eq < 0) fail(2, `--guide 형식 오류: "${kv}" (기대: KEY=path)`);
        out.guides[kv.slice(0, eq)] = kv.slice(eq + 1);
        break;
      }
      case '--touched': out.touched.push(argvList[++i]); break;
      case '--lane': out.lanes.push(parseJsonArg(argvList[++i], '--lane')); break;
      case '--dod': out.dod.push(parseJsonArg(argvList[++i], '--dod')); break;
      case '--dod-result': out.dodResults.push({ id: argvList[++i], status: argvList[++i] }); break;
      default: fail(2, `알 수 없는 옵션: ${t}`);
    }
  }
  return out;
}
function parseJsonArg(str, flagName) {
  try { return JSON.parse(str); } catch (e) { fail(1, `${flagName} JSON 파싱 실패: ${e.message}`); }
}

const args = parseArgs(process.argv.slice(2));
const cwd = resolve(args.cwd);

const proj = locateProject(cwd);
if (!proj || !proj.configPath) fail(2, 'harness.json 이 없다 — /jira-harness:setup 으로 설치할 것');
const cfg = loadConfig(proj.configPath);
const root = proj.toplevel;
const configRoot = proj.configRoot;

const branch = args.branch ?? currentBranch(root);
if (!branch) fail(2, '브랜치를 확인할 수 없다(detached) — --branch 로 지정할 것');
const parsed = parseBranch(branch, cfg);
const slug = parsed ? parsed.slug : branchSlug(branch);
const sPath = statePath(cfg, configRoot, slug);
let state = readState(sPath);
if (!state) fail(2, `이슈 상태가 없다(${branch}) — issue-start 로 먼저 시작할 것`);

let mutated = false;
const now = () => new Date().toISOString();

// ---------- --stage / --note ----------
if (args.stage !== null) {
  if (!STAGES.includes(args.stage)) fail(1, `잘못된 stage 값: "${args.stage}" (허용: ${STAGES.join(', ')})`);
  state.stage = args.stage;
  const entry = { stage: args.stage, at: now() };
  if (args.note) entry.note = args.note;
  state.history = [...(state.history ?? []), entry];
  mutated = true;
}

// ---------- --decision · --assume ----------
for (const d of args.decisions) {
  state.decisions = [...(state.decisions ?? []), { q: d.q, a: d.a, at: now(), ...(d.assumed ? { assumed: true } : {}) }];
  mutated = true;
}

// ---------- --guide ----------
if (Object.keys(args.guides).length) {
  state.guides = { ...(state.guides ?? {}), ...args.guides };
  mutated = true;
}

// ---------- --touched (합집합) ----------
if (args.touched.length) {
  state.touched = [...new Set([...(state.touched ?? []), ...args.touched])];
  mutated = true;
}

// ---------- --lane (name 같으면 교체) ----------
for (const lane of args.lanes) {
  if (!lane || typeof lane !== 'object' || !lane.name) fail(1, `--lane 값에 name 이 없다: ${JSON.stringify(lane)}`);
  const list = [...(state.lanes ?? [])];
  const idx = list.findIndex(l => l.name === lane.name);
  if (idx >= 0) list[idx] = lane; else list.push(lane);
  state.lanes = list;
  mutated = true;
}

// ---------- --dod (id 같으면 교체) ----------
for (const d of args.dod) {
  if (!d || typeof d !== 'object' || !d.id) fail(1, `--dod 값에 id 가 없다: ${JSON.stringify(d)}`);
  const list = [...(state.dod ?? [])];
  const idx = list.findIndex(x => x.id === d.id);
  if (idx >= 0) list[idx] = d; else list.push(d);
  state.dod = list;
  mutated = true;
}

// ---------- --dod-result ----------
for (const r of args.dodResults) {
  if (!DOD_STATUSES.includes(r.status)) fail(1, `--dod-result 상태값 오류: "${r.status}" (허용: ${DOD_STATUSES.join('|')})`);
  const list = [...(state.dod ?? [])];
  const idx = list.findIndex(x => x.id === r.id);
  if (idx < 0) fail(1, `--dod-result: 알 수 없는 dod id "${r.id}"`);
  if (isHumanDod(list[idx]) && r.status === 'PASS' && !r.evidence) {
    fail(1, `--dod-result ${r.id} PASS: 사람 확인 항목은 어디서 무엇을 봤는지 한 줄이 있어야 PASS 로 남긴다 — --evidence "<근거>" 를 바로 뒤에 붙일 것`);
  }
  // 근거는 그 결과의 것이다 — 새 결과에 근거가 없으면 지난 근거를 남기지 않는다
  const { evidence: _old, ...rest } = list[idx];
  list[idx] = { ...rest, last: r.status, at: now(), ...(r.evidence ? { evidence: r.evidence } : {}) };
  state.dod = list;
  mutated = true;
}

// ---------- --merge ----------
/**
 * 계획을 다시 반영해도 이미 남긴 기록은 지우지 않는다 — 병합은 배열을 통째로 바꾸므로 여기서 id·이름으로 옮겨 둔다.
 * 구현 중 검사가 바뀌어 사이드카를 고쳐 다시 반영할 때, 손대지 않은 항목의 판정과 사람 확인 근거까지 사라지면 안 된다.
 *  · dod: 검사(probe·tests·cwd·expect·human)가 그대로인 항목의 last·at·evidence — 검사가 바뀐 항목은 다시 재야 하므로 옮기지 않는다
 *  · lanes: 실행기가 남긴 result(+ 새 계획이 kind 를 안 적었으면 kind·kind_source)
 *  · touched: 구현 중 더한 경로를 잃지 않게 합집합
 */
function carryRecords(state, patch) {
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const sameCheck = (a, b) => (a.probe ?? null) === (b.probe ?? null) && same(a.tests, b.tests) && (a.cwd ?? null) === (b.cwd ?? null) && same(a.expect, b.expect) && (a.human === true) === (b.human === true);
  if (Array.isArray(patch.dod)) {
    const old = new Map((state.dod ?? []).filter(d => d?.id).map(d => [d.id, d]));
    patch.dod = patch.dod.map((d) => {
      const o = d && typeof d === 'object' ? old.get(d.id) : null;
      if (!o || o.last == null || d.last != null || !sameCheck(o, d)) return d;
      return { ...d, last: o.last, ...(o.at ? { at: o.at } : {}), ...(o.evidence ? { evidence: o.evidence } : {}) };
    });
  }
  if (Array.isArray(patch.lanes)) {
    const old = new Map((state.lanes ?? []).filter(l => l?.name).map(l => [l.name, l]));
    patch.lanes = patch.lanes.map((l) => {
      const o = l && typeof l === 'object' ? old.get(l.name) : null;
      if (!o) return l;
      const kind = !l.kind && o.kind ? { kind: o.kind, ...(o.kind_source ? { kind_source: o.kind_source } : {}) } : {};
      return { ...l, ...kind, ...(o.result != null && l.result == null ? { result: o.result } : {}) };
    });
  }
  if (Array.isArray(patch.touched)) patch.touched = [...new Set([...patch.touched, ...(state.touched ?? [])])];
}

if (args.merge) {
  let patch;
  try { patch = JSON.parse(readFileSync(resolve(args.merge), 'utf8')); }
  catch (e) { fail(1, `--merge 파일 읽기/파싱 실패(${args.merge}): ${e.message}`); }
  if (patch && typeof patch === 'object' && 'gate' in patch) fail(1, '--merge 파일에 "gate" 키가 있다 — gate 기록은 gate.mjs 만 쓴다');
  if (patch && typeof patch === 'object' && 'review' in patch) fail(1, '--merge 파일에 "review" 키가 있다 — 리뷰 기록은 --review 로만 쓴다');
  for (const k of ['version', 'branch', 'keys', 'started_at']) {
    if (patch && typeof patch === 'object' && k in patch) {
      console.error(`[issue-set] --merge: "${k}" 는 불변 필드라 무시한다`);
      delete patch[k];
    }
  }
  // 계획은 반영하기 전에 기계 점검 — 오류가 있으면 상태를 쓰지 않는다(이 호출의 다른 플래그도 같이 버려진다)
  if (args.mergeFrom === 'plan' && args.noCheck == null) {
    const plan = { guides: patch?.guides ?? {}, touched: patch?.touched, lanes: patch?.lanes, dod: patch?.dod };
    const res = checkPlan({ cfg, root, state, plan, guideText: loadGuideText({ root, plan }), herdrInside: herdrEnv().inside });
    const line = (x, tag = '') => `[issue-set] plan-check ${tag}${x.code}${x.id != null ? ` ${x.id}` : ''}: ${x.msg}`;
    for (const w of res.warnings) console.error(line(w, '경고 '));
    if (res.errors.length) {
      for (const e of res.errors) console.error(line(e));
      fail(1, `계획 점검 오류 ${res.errors.length}건 — 상태에 반영하지 않았다. 사이드카·가이드를 고쳐 다시 --merge 하거나, 점검을 건너뛰려면 --no-check "<사유>"`);
    }
  }
  if (args.mergeFrom === 'plan' && patch && typeof patch === 'object') carryRecords(state, patch);
  state = deepMerge(state, patch);
  if (args.mergeFrom === 'plan') {
    const note = args.noCheck != null ? `plan merged (check skipped: ${args.noCheck})` : 'plan merged';
    state.history = [...(state.history ?? []), { stage: state.stage, at: now(), note }];
  }
  mutated = true;
}

// ---------- --review ----------
if (args.review) {
  let patch;
  try { patch = JSON.parse(readFileSync(resolve(args.review), 'utf8')); }
  catch (e) { fail(1, `--review 파일 읽기/파싱 실패(${args.review}): ${e.message}`); }
  const tree = fingerprintTree({ cwd: root, base: 'index', excludes: cfg.fingerprint_exclude });
  const files = [...new Set([...changedVsHead(root), ...stagedFiles(root)])];
  const findingsArr = Array.isArray(patch.findings) ? patch.findings : null;
  const findingsCount = findingsArr ? findingsArr.length
    : (typeof patch.findings === 'number' ? patch.findings : (state.review?.findings ?? 0));
  const blockersOpen = patch.blockers_open != null ? patch.blockers_open
    : (findingsArr ? findingsArr.filter(f => String(f.severity ?? '').toUpperCase() === 'BLOCKER').length : (state.review?.blockers_open ?? 0));
  // Codex 판정 위에 Claude 레인을 더 돌렸으면 이유를 기록하게 한다 — 같은 diff 를 두 번 심판하는 것이 기본값이 되지 않도록(review.lanes_when).
  const lanesUsed = typeof patch.lanes === 'number' ? patch.lanes : 0;
  const lanesWhen = cfg.review.lanes_when ?? 'codex_gap';
  if (lanesUsed > 0 && lanesWhen === 'never') fail(1, `review.lanes_when=never 인데 레인 ${lanesUsed}개를 기록하려 한다 — 리뷰는 Codex 판정으로 끝낸다`);
  if (lanesUsed > 0 && lanesWhen === 'codex_gap' && !patch.lanes_reason) {
    fail(1, `레인 ${lanesUsed}개를 돌렸으면 lanes_reason 이 필요하다 — Codex 가 판정을 냈으면 같은 diff 를 Claude 레인으로 다시 심판하지 않는다. 이유 예: "codex limit", "codex 가 못 보는 축: 브라우저 실측". 매번 돌리려면 harness.json 의 review.lanes_when=always`);
  }
  const prevRound = state.review?.round ?? 0;
  const round = patch.round != null ? patch.round : (args.reviewDelta ? prevRound : prevRound + 1);
  const deltaPasses = args.reviewDelta ? (state.review?.delta_passes ?? 0) + 1 : 0;

  state.review = {
    tree, files, at: now(),
    ...(patch.codex !== undefined ? { codex: patch.codex } : {}),
    ...(patch.lanes !== undefined ? { lanes: patch.lanes } : {}),
    ...(patch.lanes_reason !== undefined ? { lanes_reason: patch.lanes_reason } : {}),
    findings: findingsCount,
    blockers_open: blockersOpen,
    round,
    delta_passes: deltaPasses,
  };
  try { pinRef(`refs/harness/${slug}/review`, tree, root); } catch (e) { console.error(`[issue-set] ref 고정 실패(무시): ${e.message}`); }
  mutated = true;
}

// ---------- 쓰기 ----------
if (mutated) {
  try { writeState(sPath, state); }
  catch (e) { fail(1, `상태 저장 실패(스키마 위반 가능): ${e.message}`); }
  // Herdr 사이드바(Herdr 밖이면 무동작). 리뷰에 blocker 가 남으면 사람을 부른다.
  const ev = args.review ? `review r${state.review.round} b${state.review.blockers_open}` : args.stage !== null ? `stage ${args.stage}` : args.merge ? 'plan merged' : null;
  if (ev) herdrPing(root, ev, args.review && state.review.blockers_open > 0 ? { title: `${state.keys.join(',')} 리뷰 blocker ${state.review.blockers_open}`, sound: 'request' } : null);
}

// ---------- 출력 ----------
const relPath = relative(configRoot, sPath).replace(/\\/g, '/');
const out = args.print
  ? state
  : { code: mutated ? 'OK' : 'NOOP', branch, slug, state_path: relPath, stage: state.stage, mutated };

if (args.json) console.log(JSON.stringify(out, null, 2));
else console.log(`[issue-set] stage=${state.stage} mutated=${mutated}`);
process.exit(0);
