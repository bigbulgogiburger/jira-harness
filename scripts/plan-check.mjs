#!/usr/bin/env node
// plan-check.mjs — 계획 사이드카를 상태에 반영하기 전에 기계로 볼 수 있는 것만 본다(판정은 lib/plan-check.mjs).
// issue-set --merge --from plan 이 같은 판정을 반영 전에 돌린다 — 이 CLI 는 반영 없이 미리 보는 용도다.
//
// 사용: node plan-check.mjs [--sidecar <path>] [--cwd <dir>] [--branch <name>] [--json]
//   --sidecar 가 없으면 <runtime>/issues/<slug>.plan.json, 그것도 없으면 상태 JSON 의 guides·touched·lanes·dod 를 본다.
// 출력: { code: OK|PLAN_ISSUES, errors, warnings, summary, sidecar } — --json 이면 마지막 줄 JSON 한 덩어리.
// 종료 코드: 0 오류 없음 · 1 오류 있음 · 2 사용법/설정/상태 없음.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { locateProject, loadConfig, parseBranch, branchSlug, statePath, readState } from './lib/config.mjs';
import { currentBranch } from './lib/git.mjs';
import { checkPlan, loadGuideText } from './lib/plan-check.mjs';
import { herdrEnv } from './lib/herdr.mjs';

function fail(msg) { console.error(`[plan-check] ${msg}`); process.exit(2); }

const args = { cwd: process.cwd(), sidecar: null, branch: null, json: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const t = argv[i];
  if (t === '--json') args.json = true;
  else if (t === '--cwd' || t === '--sidecar' || t === '--branch') {
    const v = argv[++i];
    if (!v) fail(`${t} 에 값이 없다`);
    args[t.slice(2)] = v;
  } else fail(`알 수 없는 옵션: ${t}`);
}

const cwd = resolve(args.cwd);
const proj = locateProject(cwd);
if (!proj || !proj.configPath) fail('harness.json 이 없다 — /jira-harness:setup 으로 설치할 것');
let cfg;
try { cfg = loadConfig(proj.configPath); } catch (e) { fail(`harness.json 이 유효하지 않다: ${e.message}`); }
const root = proj.toplevel;          // 가이드 초안·추적 파일은 작업트리에서
const configRoot = proj.configRoot;  // 상태·사이드카는 메인 저장소 runtime 에서

const branch = args.branch ?? currentBranch(root);
if (!branch) fail('브랜치를 확인할 수 없다(detached) — --branch 로 지정할 것');
const parsed = parseBranch(branch, cfg);
const slug = parsed ? parsed.slug : branchSlug(branch);
let state;
try { state = readState(statePath(cfg, configRoot, slug)); } catch (e) { fail(`상태 JSON 이 유효하지 않다: ${e.message}`); }
if (!state) fail(`이슈 상태가 없다(${branch}) — issue-start 로 먼저 시작할 것`);

const defaultSidecar = join(configRoot, cfg.runtime_dir, 'issues', `${slug}.plan.json`);
const sidecarPath = args.sidecar ? resolve(args.sidecar) : (existsSync(defaultSidecar) ? defaultSidecar : null);
let plan;
if (sidecarPath) {
  try { plan = JSON.parse(readFileSync(sidecarPath, 'utf8')); } catch (e) { fail(`사이드카 읽기/파싱 실패(${sidecarPath}): ${e.message}`); }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail(`사이드카가 객체가 아니다(${sidecarPath})`);
} else {
  plan = { guides: state.guides ?? {}, touched: state.touched ?? [], lanes: state.lanes ?? [], dod: state.dod ?? [] };
}

const res = checkPlan({ cfg, root, state, plan, guideText: loadGuideText({ root, plan }), herdrInside: herdrEnv().inside });
const sidecar = sidecarPath ? relative(configRoot, sidecarPath).replace(/\\/g, '/') : null;
const out = { code: res.errors.length ? 'PLAN_ISSUES' : 'OK', ...res, sidecar };

if (args.json) console.log(JSON.stringify(out));
else {
  const line = (kind, x) => console.log(`[plan-check] ${kind} ${x.code}${x.id != null ? ` ${x.id}` : ''}: ${x.msg}`);
  for (const e of res.errors) line('오류', e);
  for (const w of res.warnings) line('경고', w);
  const s = res.summary;
  console.log(`[plan-check] ${out.code} · ${sidecar ?? '상태 JSON'} · 요구 ${s.requirements} · DoD ${s.dod}(tests ${s.tests_items} · 프로브 ${s.probes} · 사람 ${s.human}) · 레인 ${s.lanes} · touched ${s.touched} · 가정 ${s.assumptions.length}`);
  for (const a of s.assumptions) console.log(`  가정: ${a.q} → ${a.a}`);
}
process.exit(res.errors.length ? 1 : 0);
