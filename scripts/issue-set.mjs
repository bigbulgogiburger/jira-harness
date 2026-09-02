#!/usr/bin/env node
// issue-set.mjs — 브랜치 상태 JSON 에 결정·계획·리뷰 기록을 쓰는 유일한 경로(gate 키는 gate.mjs 만 쓴다).
// 여러 필드 플래그(--stage·--decision·--guide·--touched·--lane·--dod·--dod-result)는 한 호출에 조합할 수 있고,
// --merge·--review 는 파일을 읽어 병합/기록하는 별도 동작이다. --print 는 마지막에 현재 상태를 그대로 찍는다.
//
// 사용:
//   node issue-set.mjs [--cwd <dir>] [--json] [--branch <name>]
//        [--stage <stage> [--note "..."]]
//        [--decision "<q>" "<a>"]...
//        [--guide KEY=path]...
//        [--touched <path>]...
//        [--lane '<json>']...
//        [--dod '<json>']...
//        [--dod-result <id> <PASS|FAIL|SKIPPED>]...
//        [--merge <file.json> [--from plan]]
//        [--review <file.json> [--delta]]
//        [--print]
//
// 종료 코드: 0 정상 · 1 도메인 위반(잘못된 stage·JSON 파싱 실패·금지 키·알 수 없는 dod id 등) · 2 사용법/설정/상태 없음.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { locateProject, loadConfig, parseBranch, branchSlug, statePath, readState, writeState, deepMerge } from './lib/config.mjs';
import { currentBranch, changedVsHead, stagedFiles, pinRef } from './lib/git.mjs';
import { fingerprintTree } from './lib/tree.mjs';

const STAGES = ['start', 'grill', 'plan', 'implement', 'review', 'gate', 'complete', 'archived'];
const DOD_STATUSES = ['PASS', 'FAIL', 'SKIPPED'];

function fail(code, msg) { console.error(`[issue-set] ${msg}`); process.exit(code); }

function parseArgs(argvList) {
  const out = {
    cwd: process.cwd(), json: false, branch: null, print: false,
    merge: null, mergeFrom: null, review: null, reviewDelta: false,
    stage: null, note: null, decisions: [], guides: {}, touched: [], lanes: [], dod: [], dodResults: [],
  };
  for (let i = 0; i < argvList.length; i++) {
    const t = argvList[i];
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
      case '--decision': out.decisions.push({ q: argvList[++i], a: argvList[++i] }); break;
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

// ---------- --decision ----------
for (const d of args.decisions) {
  state.decisions = [...(state.decisions ?? []), { q: d.q, a: d.a, at: now() }];
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
  list[idx] = { ...list[idx], last: r.status, at: now() };
  state.dod = list;
  mutated = true;
}

// ---------- --merge ----------
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
  state = deepMerge(state, patch);
  if (args.mergeFrom === 'plan') {
    state.history = [...(state.history ?? []), { stage: state.stage, at: now(), note: 'plan merged' }];
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
  const prevRound = state.review?.round ?? 0;
  const round = patch.round != null ? patch.round : (args.reviewDelta ? prevRound : prevRound + 1);
  const deltaPasses = args.reviewDelta ? (state.review?.delta_passes ?? 0) + 1 : 0;

  state.review = {
    tree, files, at: now(),
    ...(patch.codex !== undefined ? { codex: patch.codex } : {}),
    ...(patch.lanes !== undefined ? { lanes: patch.lanes } : {}),
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
}

// ---------- 출력 ----------
const relPath = relative(configRoot, sPath).replace(/\\/g, '/');
const out = args.print
  ? state
  : { code: mutated ? 'OK' : 'NOOP', branch, slug, state_path: relPath, stage: state.stage, mutated };

if (args.json) console.log(JSON.stringify(out, null, 2));
else console.log(`[issue-set] stage=${state.stage} mutated=${mutated}`);
process.exit(0);
