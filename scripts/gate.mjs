#!/usr/bin/env node
// gate.mjs — 게이트 러너. 브랜치 상태 JSON 의 gate 기록을 쓰는 유일한 경로.
//   --commit : 경량(건드린 스택의 compile·lint) — 목표 ≤ gate.commit_budget_s. DoD 는 돌리지 않는다 — 커밋마다 DoD 를 전부 다시 돌린 것이
//              경량 게이트 시간의 86%였다(2026-10-12 실측: 171회 15.0시간 중 12.9시간). DoD 는 전량 게이트에서 한 번 돈다.
//   --full   : 전량(DoD 프로브 → 모든 스택의 compile·lint·build·test·extra → DoD tests 항목) — push/complete 전제(gate.push_level=full · 기본).
//              DoD 프로브가 하나라도 FAIL 이면 스택 단계를 건너뛰고 끝낸다 — 늦게 발견된 DoD 실패가 전체 테스트를 헛돌게 하지 않는다.
//   --related: 관련 테스트(DoD 프로브 → 이 브랜치가 바꾼 스택의 compile·lint·**관련 테스트** → DoD tests 항목) — gate.push_level=related 일 때의
//              push/complete 전제. 선택은 lib/related-tests.mjs(바뀐 클래스를 쓰는 테스트 · vitest related · 전역 파일이 바뀌면 그 스택 전체).
//              build·extra·전체 테스트는 --main 이 머지 뒤 한 번에 돈다 — 이슈마다 1시간짜리 전체 스위트를 돌리지 않는다.
//   --dod    : 경량+DoD(DoD 프로브 → 이 브랜치가 바꾼 스택의 compile·lint → DoD tests 항목) — gate.push_level=dod 일 때의 push/complete 전제.
//              관련 테스트 선택 단계도 없다(공용 파일을 건드리면 관련 테스트가 스택 전체로 불어난다). 테스트는 DoD tests 항목뿐이고,
//              전체 검증은 여러 이슈를 머지한 뒤 --main 1회가 맡는다(필수). DoD tests 가 0개면 요약에 경고를 남긴다(「검사 0」의 초록).
//   --main   : 기본 브랜치 배치 전량(모든 스택의 compile·lint·build·test·extra) — 여러 이슈를 머지한 뒤 1회. 이슈 상태 JSON 이 아니라
//              <runtime>/main-gate.json 에 기록한다(head·결과·직전 PASS 이후 커밋). --main --status 는 기록만 읽는다.
// 옵션: --stage-all(git add -A 후 검증) · --dry-run(계획만) · --stacks a,b · --cwd <dir> · --json
//      --full 의 --stacks 는 이 브랜치가 바꾼 스택을 뺄 수 없다(빼면 그 스택을 검증한 것처럼 기록이 남는다).
// 지문 = 실행 전 인덱스 트리(런타임 경로 제외). 실행 중 인덱스가 바뀌면 기록하지 않는다.
// DoD: `tests: {stack, select[]}` 항목은 스택별로 **한 번에** 돌려 리포트로 항목마다 판정한다(lib/dod-tests.mjs · stacks.<name>.dod_tests).
//      그 스택 test 단계의 리포트에 걸린 항목은 리포트를 그대로 읽는다 — 다시 돌리지 않는다. `probe` 문자열 항목은 항목마다 돈다.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { locateProject, loadConfig, parseBranch, statePath, readState, writeState, stacksTouched, matchesAny } from './lib/config.mjs';
import { currentBranch, git, stagedFiles, untrackedFiles, changedVsHead, branchChangedFiles, pinRef } from './lib/git.mjs';
import { fingerprintTree } from './lib/tree.mjs';
import { parseTestCount, stripAnsi } from './lib/probe.mjs';
import { resolveShell as resolveShellLib } from './lib/shell.mjs';
import { herdrPing } from './lib/herdr.mjs';
import { batchCommand, collectEntries, judgeTests, vitestReportArgs } from './lib/dod-tests.mjs';
import { selectRelated, relatedCommand } from './lib/related-tests.mjs';
import { REQUIRED_KEYS } from './lib/gate-core.mjs';

// ---------- 인자 ----------
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const level = flag('--main') ? 'main' : flag('--full') ? 'full' : flag('--related') ? 'related' : flag('--dod') ? 'dod' : flag('--commit') ? 'commit' : null;
if (!level) fail(2, '사용법: gate.mjs --commit | --dod | --related | --full | --main [--status] [--stage-all] [--dry-run] [--stacks a,b] [--cwd <dir>] [--json]');
const json = flag('--json');
const cwd = resolve(opt('--cwd') ?? process.cwd());

function fail(code, msg) { console.error(`[gate] ${msg}`); process.exit(code); }
function nowIso() { return new Date().toISOString(); }
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

// ---------- 셸 ---------- (탐색은 lib/shell.mjs — setup.mjs check 와 같은 축)
function resolveShell(cfg) {
  try { return resolveShellLib(cfg); }
  catch (e) { if (e.code === 'NO_BASH') fail(2, e.message); throw e; }
}
function loadEnvFile(root, rel) {
  if (!rel) return {};
  const file = join(root, rel);
  if (!existsSync(file)) return {};
  const env = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}
function runCmd(shell, cmd, { cwd, env, timeoutS }) {
  const t0 = Date.now();
  const r = spawnSync(shell.file, shell.args(cmd), { cwd, env, encoding: 'utf8', timeout: timeoutS * 1000, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const out = ((r.stdout ?? '') + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).replace(/\r\n/g, '\n');
  return { status: timedOut ? -2 : (r.status ?? -1), out, seconds: +((Date.now() - t0) / 1000).toFixed(1), timedOut, error: r.error?.message ?? null };
}

// ---------- 본체 ----------
const proj = locateProject(cwd);
if (!proj || !proj.configPath) fail(2, 'harness.json 이 없다 — /jira-harness:setup 으로 설치할 것');
let cfg; try { cfg = loadConfig(proj.configPath); } catch (e) { fail(2, `harness.json 이 유효하지 않다(${proj.configPath}): ${e.message}`); }
const root = proj.toplevel;
const configRoot = proj.configRoot;
const branch = currentBranch(root);
if (level === 'main') runMainGate(); // 이슈 상태와 무관한 경로 — 끝나면 프로세스를 끝낸다
const parsed = parseBranch(branch, cfg);
if (!parsed && !flag('--dry-run')) fail(2, `브랜치 "${branch ?? '(detached)'}" 가 branch_pattern 밖이다`);
const sPath = statePath(cfg, configRoot, parsed ? parsed.slug : 'dry-run'); // dry-run 은 상태·브랜치 없이도 계획만 보여준다(setup check 가 이슈 전에 부른다)
const state = readState(sPath);
if (!state && !flag('--dry-run')) fail(2, `상태 JSON 이 없다(${relative(configRoot, sPath)}) — /jira-harness:issue ${parsed.keys[0]} 로 시작할 것`);

if (flag('--stage-all')) git(['add', '-A'], { cwd: root });

const changed = [...new Set([...stagedFiles(root), ...changedVsHead(root), ...untrackedFiles(root)])];
const wanted = opt('--stacks') ? opt('--stacks').split(',').map(s => s.trim()).filter(Boolean) : null;
// 관련 테스트·dod 게이트는 "이 브랜치가 바꾼 것" 전체(커밋된 것 + 작업트리)를 본다 — 마지막 커밋만 보면 앞 커밋의 변경이 빠진다
const branchScoped = level === 'related' || level === 'dod';
const branchFiles = branchScoped || (level === 'full' && wanted) ? branchChangedFiles(root, cfg.default_branch) : null;
const branchCode = branchFiles ? [...new Set([...branchFiles, ...changed])].filter(p => !matchesAny(p, cfg.docs_only_paths)) : null;
if (branchScoped && !branchFiles) fail(2, `${cfg.default_branch} 와의 merge-base 를 못 구해 이 브랜치가 바꾼 스택을 알 수 없다 — --full 로 돌릴 것`);
let stackNames = wanted ?? (level === 'full' ? Object.keys(cfg.stacks) : branchScoped ? stacksTouched(branchCode, cfg) : stacksTouched(changed, cfg));
for (const n of stackNames) if (!cfg.stacks[n]) fail(2, `알 수 없는 스택 "${n}" (harness.json.stacks: ${Object.keys(cfg.stacks).join(', ')})`);
if ((level === 'full' || branchScoped) && wanted) {
  // push·complete 는 기록의 결과만 보고 어느 스택이 돌았는지는 보지 않는다 — 바뀐 스택을 뺀 --stacks 는 기록을 남기기 전에 여기서 막는다
  if (!branchCode) fail(2, `${cfg.default_branch} 와의 merge-base 를 못 구해 --stacks 를 검증할 수 없다 — --stacks 없이 돌릴 것`);
  const missing = stacksTouched(branchCode, cfg).filter(n => !wanted.includes(n));
  if (missing.length) fail(2, `--stacks 가 이 브랜치에서 바뀐 스택을 뺐다: ${missing.join(', ')} — ${level} 게이트는 바뀐 스택을 모두 돌아야 한다(--stacks ${[...wanted, ...missing].join(',')} 또는 --stacks 없이)`);
}
const steps = level === 'full' ? ['compile', 'lint', 'build', 'test', 'extra'] : level === 'related' ? ['compile', 'lint', 'test'] : ['compile', 'lint'];
// DoD 는 push 전제 게이트(전량·관련 테스트·dod)에서만 돈다 — 경량(커밋) 게이트는 compile·lint 만 본다(dod 도 스택 단계는 compile·lint 뿐)
const pushLevel = level === 'full' || level === 'related' || level === 'dod';
const dodItems = pushLevel ? ((state && state.dod) || []) : [];
const probes = dodItems.filter(d => (d.probe || d.tests) && !d.human);
const humans = dodItems.filter(d => d.human || (!d.probe && !d.tests));
// 구조화 테스트 항목 — 그 스택에 dod_tests 어댑터가 있을 때만. 없으면 probe 문자열로 돌고, probe 도 없으면 FAIL
const testItems = probes.filter(d => d.tests && cfg.stacks[d.tests.stack]?.dod_tests);
const probeItems = probes.filter(d => !testItems.includes(d));
const byStack = new Map();
for (const d of testItems) byStack.set(d.tests.stack, [...(byStack.get(d.tests.stack) ?? []), d]);

/** 관련 테스트 게이트의 스택 test 단계 — {mode, select, reason, cmd} · cmd=null 이면 돌 것이 없다 */
function relatedPlan(name) {
  const s = cfg.stacks[name];
  if (!s.test) return { mode: 'none', select: [], reason: 'test 명령 없음', cmd: null };
  const dt = s.dod_tests;
  if (!dt) return { mode: 'full', select: [], reason: 'dod_tests 어댑터가 없어 관련 테스트를 고를 수 없다 → 전체 테스트', cmd: s.test };
  const prefix = s.dir === '.' ? '' : s.dir.replace(/\/$/, '') + '/';
  const files = branchCode.filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length));
  const r = selectRelated({ adapter: dt.adapter, stackDir: resolve(root, s.dir), files, related: s.related });
  const cmd = r.mode === 'full' ? s.test : r.mode === 'selected' ? relatedCommand({ adapter: dt.adapter, run: dt.run, select: r.select, related: s.related }) : null;
  return { ...r, cmd };
}
const relatedPlans = level === 'related' ? Object.fromEntries(stackNames.map(n => [n, relatedPlan(n)])) : {};

if (flag('--dry-run')) {
  const dodBatches = Object.fromEntries([...byStack].map(([n, items]) => [n, { ids: items.map(d => d.id), cmd: batchCommand(cfg.stacks[n].dod_tests, items.flatMap(d => d.tests.select), `<runtime>/gate/<slug>-${n}-dod.vitest.json`) }]));
  const plan = { level, branch, keys: parsed ? parsed.keys : [], changed_files: changed.length, stacks: Object.fromEntries(stackNames.map(n => [n, Object.fromEntries(steps.map(s => [s, s === 'test' && level === 'related' ? relatedPlans[n].cmd : cfg.stacks[n][s] ?? null]))])), related: level === 'related' ? Object.fromEntries(Object.entries(relatedPlans).map(([n, r]) => [n, { mode: r.mode, reason: r.reason, selected: r.select.length }])) : undefined, dod_probes: probes.map(d => ({ id: d.id, probe: d.probe ?? null, tests: d.tests ?? null, cwd: d.cwd ?? null })), dod_batches: dodBatches, dod_human: humans.map(d => d.id), shell: resolveShell(cfg).name };
  console.log(json ? JSON.stringify(plan, null, 2) : `[gate] dry-run ${level}\n` + JSON.stringify(plan, null, 2));
  process.exit(0);
}

const shell = resolveShell(cfg);
const tree = fingerprintTree({ cwd: root, base: 'index', excludes: cfg.fingerprint_exclude });
const OKSET = new Set(['PASS', 'SKIPPED']);
const prev = state.gate;
if (level === 'commit' && prev && ['full', 'related', 'dod'].includes(prev.level) && prev.tree === tree && ['compile', 'lint'].every(k => OKSET.has(prev.results?.[k] ?? 'NOT_RUN'))) {
  console.log(`[gate] 같은 트리(${tree.slice(0, 12)})가 이미 ${prev.level} 게이트를 통과했다(${prev.at}) — 재실행 생략`);
  process.exit(0);
}

const t0 = Date.now();
const logChunks = [`# jira-harness gate ${level} · ${branch} · ${nowIso()} · tree ${tree}\n`];
const results = { compile: 'NOT_RUN', lint: 'NOT_RUN', build: 'NOT_RUN', test: 'NOT_RUN', extra: 'NOT_RUN', dod: 'NOT_RUN' };
const perKey = { compile: [], lint: [], build: [], test: [], extra: [] };
const stacksOut = {};
const logDir = join(configRoot, cfg.runtime_dir, 'gate');
mkdirSync(logDir, { recursive: true });
const harvest = {}; // 전량·관련: 스택 test 단계의 리포트 — DoD 테스트 항목을 다시 돌리지 않고 여기서 판정한다
const relatedOut = {}; // 관련 테스트: 스택별 {mode, selected, tests, failed, reason} — 기록·요약에 남겨 "검사 0" 을 드러낸다
for (const [n, r] of Object.entries(relatedPlans)) relatedOut[n] = { mode: r.mode, selected: r.select.length, tests: 0, failed: 0, reason: r.reason };

let dodPass = 0, dodFail = 0;
const judgedNow = new Set(); // 이번 실행이 판정한 DoD 항목 — 상태에 얹는 것은 이것뿐이다
function recordDod(d, verdict, note) { d.last = verdict; d.at = nowIso(); judgedNow.add(d.id); if (verdict === 'PASS') dodPass++; else dodFail++; logChunks.push(note); }

// DoD ① 프로브 문자열 — 항목마다, 스택 단계보다 먼저(경량 게이트는 DoD 가 없어 probeItems 가 비어 있다)
for (const d of probeItems) {
  if (!d.probe) { recordDod(d, 'FAIL', `\n## dod ${d.id} → FAIL (tests.stack=${d.tests?.stack} 에 dod_tests 어댑터가 없고 probe 도 없다 — harness.json stacks.<name>.dod_tests)\n`); continue; }
  const dir = resolve(root, d.cwd ?? '.');
  console.error(`[gate] dod ${d.id}: ${d.probe}`);
  const r = runCmd(shell, d.probe, { cwd: dir, env: { ...process.env, JIRA_HARNESS_GATE: level }, timeoutS: cfg.gate.timeout_s });
  const reasons = [];
  const out = stripAnsi(r.out); // 러너 색상 코드가 숫자·문구 사이에 끼면 정규식이 조용히 빗나간다
  if (r.status !== 0) reasons.push(`exit ${r.status}`);
  if (d.expect?.pattern && !new RegExp(d.expect.pattern, 'm').test(out)) reasons.push(`pattern /${d.expect.pattern}/ 없음`);
  if (d.expect?.min_tests != null) {
    const n = parseTestCount(out);
    if (n == null) reasons.push('실행 건수(분모) 미확인 — 테스트를 도는 프로브는 러너 요약(`Tests N passed`·`N tests completed`)이나 숫자 한 줄을 찍어야 한다. 건수가 없는 sentinel 프로브(위반 주입·존재 검사)는 min_tests 를 빼고 pattern 만 둔다');
    else if (n < d.expect.min_tests) reasons.push(`실행 건수 ${n} < ${d.expect.min_tests}`);
  }
  const verdict = reasons.length ? 'FAIL' : 'PASS';
  recordDod(d, verdict, `\n## dod ${d.id} $ ${d.probe}\n## exit=${r.status} ${r.seconds}s → ${verdict}${reasons.length ? ' (' + reasons.join('; ') + ')' : ''}\n${r.out.slice(0, 200_000)}\n`);
}
// 프로브가 하나라도 FAIL 이면 스택 단계·DoD tests 를 건너뛴다 — 고친 뒤 어차피 전량을 다시 돌아야 하니 이번 빌드·전체 테스트는 헛돈다
const probeFailed = dodFail > 0;
if (probeFailed) {
  console.error(`[gate] DoD 프로브 FAIL ${dodFail}건 — 스택 단계(빌드·전체 테스트)를 건너뛴다`);
  logChunks.push(`\n## 스택 단계 건너뜀 — DoD 프로브 FAIL ${dodFail}건을 먼저 고칠 것\n`);
}

for (const name of stackNames) {
  const s = cfg.stacks[name];
  const dir = resolve(root, s.dir);
  const env = { ...process.env, ...loadEnvFile(configRoot, s.env_file), JIRA_HARNESS_GATE: level };
  stacksOut[name] = {};
  for (const step of steps) {
    if (probeFailed) { stacksOut[name][step] = 'NOT_RUN'; continue; }
    const rp = level === 'related' && step === 'test' ? relatedPlans[name] : null;
    if (rp) logChunks.push(`\n## ${name}.related mode=${rp.mode} selected=${rp.select.length} — ${rp.reason}\n${rp.select.slice(0, 400).join('\n')}\n`);
    let cmds = rp ? (rp.cmd ? [rp.cmd] : []) : step === 'extra' ? (s.extra ?? []) : (s[step] ? [s[step]] : []);
    if (!cmds.length) { stacksOut[name][step] = 'SKIPPED'; perKey[step].push('SKIPPED'); continue; }
    // test 명령이 DoD 어댑터의 run 과 같을 때만 거둔다(다른 명령이면 리포트가 같은 모집단이라는 보장이 없다) — vitest 는 JSON 리포터를 덧붙인다
    // 관련 테스트는 게이트가 어댑터로 만든 명령이라 리포트 모양이 같다 — 거두어 DoD 판정과 "관련 테스트 N건" 에 쓴다
    const dt = s.dod_tests;
    const reuse = step === 'test' && !!dt && ((level === 'full' && byStack.has(name) && cmds.length === 1 && cmds[0].trim() === dt.run.trim()) || (rp && rp.mode !== 'none' && (rp.mode === 'selected' || cmds[0].trim() === dt.run.trim())));
    const reportPath = reuse && dt.adapter === 'vitest' ? join(logDir, `${parsed.slug}-${name}-${level}.vitest.json`) : null;
    if (reportPath) { rmSync(reportPath, { force: true }); cmds = [cmds[0] + vitestReportArgs(reportPath)]; }
    const since = Date.now();
    let verdict = 'PASS', lastExit = 0;
    for (const cmd of cmds) {
      console.error(`[gate] ${name}.${step}: ${cmd}`);
      const r = runCmd(shell, cmd, { cwd: dir, env, timeoutS: cfg.gate.timeout_s });
      logChunks.push(`\n## ${name}.${step} $ ${cmd}\n## exit=${r.status} ${r.seconds}s${r.timedOut ? ' TIMEOUT' : ''}${r.error ? ' error=' + r.error : ''}\n${r.out.length > 200_000 ? r.out.slice(0, 200_000) + '\n…(truncated)' : r.out}\n`);
      lastExit = r.status;
      if (r.status !== 0) { verdict = 'FAIL'; console.error(`[gate] ${name}.${step} FAIL (exit ${r.status}${r.timedOut ? ', timeout' : ''})`); break; }
    }
    if (reuse) harvest[name] = collectEntries(dt, dir, { reportPath, exit: lastExit, since });
    if (rp) {
      const got = harvest[name] ?? [];
      relatedOut[name] = { mode: rp.mode, selected: rp.select.length, tests: got.reduce((n, e) => n + e.passed + e.failed, 0), failed: got.reduce((n, e) => n + e.failed, 0), reason: rp.reason };
    }
    stacksOut[name][step] = verdict;
    perKey[step].push(verdict);
  }
}
if (!probeFailed) for (const step of steps) {
  const vs = perKey[step];
  results[step] = vs.includes('FAIL') ? 'FAIL' : vs.includes('PASS') ? 'PASS' : 'SKIPPED';
}

// DoD ② 구조화 테스트 항목 — 스택별 1회(test 단계 리포트에 걸린 항목은 그걸로 판정하고, 안 걸린 항목만 배치로 돈다)
if (!probeFailed) for (const [name, items] of byStack) {
  const s = cfg.stacks[name];
  const dt = s.dod_tests;
  const dir = resolve(root, s.dir);
  const judged = (d, j, via) => recordDod(d, j.verdict, `\n## dod ${d.id} [${name} ${via}] select=${JSON.stringify(d.tests.select)} → ${j.verdict} · 통과 ${j.passed} · 실패 ${j.failed} · 걸린 ${dt.adapter === 'vitest' ? '파일' : '스위트'} ${j.matched}${j.reasons.length ? ' (' + j.reasons.join('; ') + ')' : ''}\n`);
  let pending = items;
  if (harvest[name]) {
    pending = [];
    for (const d of items) { const j = judgeTests(dt, d, harvest[name]); if (j.matched) judged(d, j, '전량 test 리포트'); else pending.push(d); }
  }
  if (!pending.length) continue;
  const reportPath = dt.adapter === 'vitest' ? join(logDir, `${parsed.slug}-${name}-dod.vitest.json`) : null;
  if (reportPath) rmSync(reportPath, { force: true });
  const cmd = batchCommand(dt, pending.flatMap(d => d.tests.select), reportPath);
  console.error(`[gate] dod ${name} 배치 ${pending.map(d => d.id).join(',')}: ${cmd}`);
  const since = Date.now();
  const r = runCmd(shell, cmd, { cwd: dir, env: { ...process.env, ...loadEnvFile(configRoot, s.env_file), JIRA_HARNESS_GATE: level }, timeoutS: cfg.gate.timeout_s });
  logChunks.push(`\n## dod-batch ${name} $ ${cmd}\n## exit=${r.status} ${r.seconds}s${r.timedOut ? ' TIMEOUT' : ''}${r.error ? ' error=' + r.error : ''}\n${r.out.slice(0, 200_000)}\n`);
  const got = collectEntries(dt, dir, { reportPath, exit: r.status, since });
  for (const d of pending) {
    const j = judgeTests(dt, d, got);
    if (r.status !== 0 && !j.matched) j.reasons.push(`배치 exit ${r.status}${r.timedOut ? '(timeout)' : ''} — 이번 실행 결과 없음`);
    judged(d, j, '배치');
  }
}

if (pushLevel) results.dod = dodFail ? 'FAIL' : dodPass ? 'PASS' : 'SKIPPED';
const dodSummary = pushLevel ? `${dodPass}/${probes.length}${humans.length ? ` (human ${humans.length} 제외)` : ''}` : 'push 전 게이트에서';
// dod 게이트는 테스트 단계가 없다 — DoD tests 항목이 0개면 이 게이트는 테스트를 하나도 돌리지 않았다(초록이어도 「검사 0」). 실패는 아니고 경고만
const dodTestCount = probes.filter(d => d.tests).length;
const warnings = level === 'dod' && dodTestCount === 0 ? [`DoD tests 항목 0개 — 이 게이트는 테스트를 하나도 돌리지 않았다(compile·lint${probes.length ? ` · 프로브 ${probes.length}건` : ''}만). 초록이어도 「검사 0」이다 — 테스트 검증은 ${cfg.default_branch} 의 gate.mjs --main 에서`] : [];

// 로그 기록
const logPath = join(logDir, `${parsed.slug}-${level}-${nowIso().replace(/[:.]/g, '-')}.log`);
const logText = logChunks.join('');
writeFileSync(logPath, logText, 'utf8');
const logRel = relative(configRoot, logPath).replace(/\\/g, '/');

// 실행 중 트리 변경 감지
const tree2 = fingerprintTree({ cwd: root, base: 'index', excludes: cfg.fingerprint_exclude });
if (tree2 !== tree) fail(1, `게이트 실행 중 인덱스가 바뀌었다(${tree.slice(0, 12)} → ${tree2.slice(0, 12)}) — 기록하지 않음. 재실행할 것`);

const overallKeys = REQUIRED_KEYS[level];
const overall = overallKeys.every(k => OKSET.has(results[k])) ? 'PASS' : 'FAIL';
const at = nowIso();
const duration_s = +((Date.now() - t0) / 1000).toFixed(1);
// 쓰기 직전에 다시 읽고 게이트 몫(gate · history · DoD 판정)만 얹는다 — 게이트가 도는 동안 다른 경로(issue-set --review 등)가 상태를 고쳤을 수 있고,
// 시작 때 읽은 사본을 통째로 쓰면 그 기록이 사라진다(2026-09-23 실측: 94분 전량 게이트 도중 기록한 델타 리뷰가 게이트 종료와 함께 지난 기록으로 되돌아가 훅이 REVIEW_STALE)
const latest = readState(sPath) ?? state;
// 얹는 것은 이번 실행이 판정한 항목뿐 — 경량 게이트나 프로브 FAIL 로 건너뛴 항목의 지난 판정을 다시 쓰지 않는다
const judged = new Map((state.dod ?? []).filter(d => judgedNow.has(d.id)).map(d => [d.id, d]));
for (const d of latest.dod ?? []) {
  const j = judged.get(d.id);
  // 판정한 뒤 그 항목의 검사 자체가 바뀌었으면(plan 재병합 등) 옛 판정을 얹지 않는다
  if (j && (j.probe ?? null) === (d.probe ?? null) && JSON.stringify(j.tests ?? null) === JSON.stringify(d.tests ?? null)) { d.last = j.last; d.at = j.at; }
}
latest.gate = {
  level, tree, results, stacks: stacksOut, dod: dodSummary, ...(level === 'related' ? { related: relatedOut } : {}),
  log: logRel, log_sha256: sha256(Buffer.from(logText, 'utf8')), duration_s, at,
  full_at: level === 'full' ? at : (prev && prev.tree === tree ? prev.full_at ?? null : null),
};
latest.history = [...(latest.history ?? []), { stage: 'gate', at, note: `${level} ${overall} ${duration_s}s` }];
writeState(sPath, latest);
try { pinRef(`refs/harness/${parsed.slug}/gate`, tree, root); } catch (e) { console.error(`[gate] ref 고정 실패(무시): ${e.message}`); }
// Herdr 사이드바·알림(Herdr 밖이면 무동작). FAIL 은 사람을 부르고(request), 전량 PASS 는 끝났다고 알린다(done).
herdrPing(cwd, `gate ${level} ${overall}`, overall === 'FAIL'
  ? { title: `${latest.keys.join(',')} gate ${level} FAIL`, body: Object.entries(results).filter(([, v]) => v === 'FAIL').map(([k]) => k).join(', ') || 'FAIL', sound: 'request' }
  : pushLevel ? { title: `${latest.keys.join(',')} gate ${level} PASS`, body: `${duration_s}s · push 가능`, sound: 'done' } : null);

const summary = { level, overall, tree, results, stacks: stacksOut, ...(level === 'related' ? { related: relatedOut } : {}), dod: dodSummary, ...(warnings.length ? { warnings } : {}), duration_s, log: logRel, state: relative(configRoot, sPath).replace(/\\/g, '/') };
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`[gate] ${level} ${overall} · ${duration_s}s · tree ${tree.slice(0, 12)} · dod ${dodSummary}`);
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(8)} ${v}`);
  for (const [n, r] of Object.entries(relatedOut)) console.log(`  related  ${n}: ${r.mode} · 클래스/파일 ${r.selected} · 테스트 ${r.tests}건${r.failed ? ` · 실패 ${r.failed}` : ''} — ${r.reason}`);
  console.log(`  log      ${logRel}`);
  if (level === 'commit' && duration_s > cfg.gate.commit_budget_s) console.log(`  ⚠ 경량 게이트 목표 ${cfg.gate.commit_budget_s}s 초과`);
  if (level === 'related') console.log(`  전체 스위트·build·extra 는 ${cfg.default_branch} 에서 배치로: gate.mjs --main (여러 이슈를 머지한 뒤 1회)`);
  if (level === 'dod') console.log(`  테스트(관련·전체)·build·extra 는 돌지 않았다 — 여러 이슈를 머지한 뒤 ${cfg.default_branch} 에서 gate.mjs --main 1회 필수(배포·릴리즈 전)`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}
process.exit(overall === 'PASS' ? 0 : 1);

// ---------- --main: 기본 브랜치 배치 전량 ----------
// 이슈 게이트(--related·--dod)가 뒤로 미룬 build·전체 테스트·extra 를 머지된 main 에서 한 번에 돈다. 상태 JSON 이 아니라 main-gate.json 에 남긴다 —
// 이슈 브랜치는 이미 아카이브됐고, 실패하면 "직전 PASS 이후 들어온 커밋" 이 용의자 목록이다.
function runMainGate() {
  const recPath = join(configRoot, cfg.runtime_dir, 'main-gate.json');
  let rec = { last: null, last_pass: null, history: [] };
  try { if (existsSync(recPath)) rec = { ...rec, ...JSON.parse(readFileSync(recPath, 'utf8')) }; } catch { /* 깨진 기록은 새로 쓴다 */ }
  const head = git(['rev-parse', 'HEAD'], { cwd: root }).out;
  const since = rec.last_pass?.head;
  const pending = since ? git(['log', '--first-parent', '--format=%h %s', `${since}..HEAD`], { cwd: root, allowFail: true }).out.split('\n').filter(Boolean) : null;
  if (flag('--status')) {
    const st = { last: rec.last, last_pass: rec.last_pass, head, pending_commits: pending ? pending.length : null, pending: (pending ?? []).slice(0, 30) };
    console.log(json ? JSON.stringify(st, null, 2) : `[gate] main 마지막 ${rec.last ? `${rec.last.overall} ${rec.last.head.slice(0, 8)} @${rec.last.at}` : '기록 없음'} · 마지막 PASS ${since ? since.slice(0, 8) : '없음'} · 그 뒤 커밋 ${pending ? pending.length : '?'}개`);
    process.exit(0);
  }
  if (branch !== cfg.default_branch && !flag('--any-branch')) fail(2, `--main 은 ${cfg.default_branch} 에서 돈다(지금 ${branch ?? '(detached)'}) — 머지·push 뒤 ${cfg.default_branch} 를 checkout 하고 실행할 것`);
  const dirty = [...stagedFiles(root), ...changedVsHead(root), ...untrackedFiles(root)].filter(p => !matchesAny(p, cfg.fingerprint_exclude));
  if (dirty.length) fail(2, `작업트리가 깨끗하지 않다(${dirty.slice(0, 5).join(', ')}) — 커밋된 ${cfg.default_branch} 만 잰다`);
  const names = opt('--stacks') ? opt('--stacks').split(',').map(s => s.trim()).filter(Boolean) : Object.keys(cfg.stacks);
  for (const n of names) if (!cfg.stacks[n]) fail(2, `알 수 없는 스택 "${n}"`);
  const msteps = ['compile', 'lint', 'build', 'test', 'extra'];
  if (flag('--dry-run')) {
    console.log(JSON.stringify({ level: 'main', branch, head, since: since ?? null, pending_commits: pending ? pending.length : null, stacks: Object.fromEntries(names.map(n => [n, Object.fromEntries(msteps.map(s => [s, s === 'extra' ? cfg.stacks[n].extra : cfg.stacks[n][s] ?? null]))])) }, null, 2));
    process.exit(0);
  }
  const shell = resolveShell(cfg);
  const t0 = Date.now();
  const logDir = join(configRoot, cfg.runtime_dir, 'gate');
  mkdirSync(logDir, { recursive: true });
  const chunks = [`# jira-harness gate main · ${branch} · ${nowIso()} · head ${head}\n`];
  const results = Object.fromEntries(msteps.map(s => [s, 'NOT_RUN']));
  const per = Object.fromEntries(msteps.map(s => [s, []]));
  const stacks = {};
  for (const name of names) {
    const s = cfg.stacks[name];
    const env = { ...process.env, ...loadEnvFile(configRoot, s.env_file), JIRA_HARNESS_GATE: 'main' };
    stacks[name] = {};
    for (const step of msteps) {
      const cmds = step === 'extra' ? (s.extra ?? []) : (s[step] ? [s[step]] : []);
      if (!cmds.length) { stacks[name][step] = 'SKIPPED'; per[step].push('SKIPPED'); continue; }
      let v = 'PASS';
      for (const cmd of cmds) {
        console.error(`[gate] main ${name}.${step}: ${cmd}`);
        const r = runCmd(shell, cmd, { cwd: resolve(root, s.dir), env, timeoutS: cfg.gate.timeout_s });
        chunks.push(`\n## ${name}.${step} $ ${cmd}\n## exit=${r.status} ${r.seconds}s${r.timedOut ? ' TIMEOUT' : ''}\n${r.out.length > 200_000 ? r.out.slice(0, 200_000) + '\n…(truncated)' : r.out}\n`);
        if (r.status !== 0) { v = 'FAIL'; console.error(`[gate] main ${name}.${step} FAIL (exit ${r.status}${r.timedOut ? ', timeout' : ''})`); break; }
      }
      stacks[name][step] = v; per[step].push(v);
    }
  }
  for (const step of msteps) results[step] = per[step].includes('FAIL') ? 'FAIL' : per[step].includes('PASS') ? 'PASS' : 'SKIPPED';
  const overall = msteps.every(k => results[k] === 'PASS' || results[k] === 'SKIPPED') ? 'PASS' : 'FAIL';
  const at = nowIso();
  const duration_s = +((Date.now() - t0) / 1000).toFixed(1);
  const logPath = join(logDir, `main-${at.replace(/[:.]/g, '-')}.log`);
  writeFileSync(logPath, chunks.join(''), 'utf8');
  const log = relative(configRoot, logPath).replace(/\\/g, '/');
  const entry = { head, at, overall, results, stacks, duration_s, log, since: since ?? null, commits: pending ?? null };
  rec.last = entry;
  if (overall === 'PASS') rec.last_pass = { head, at };
  rec.history = [...(rec.history ?? []), { head, at, overall, duration_s, commits: pending ? pending.length : null }].slice(-30);
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  herdrPing(cwd, `gate main ${overall}`, { title: `${cfg.default_branch} gate main ${overall}`, body: overall === 'FAIL' ? Object.entries(results).filter(([, v]) => v === 'FAIL').map(([k]) => k).join(', ') : `${duration_s}s · 커밋 ${pending ? pending.length : '?'}개 검증`, sound: overall === 'FAIL' ? 'request' : 'done' });
  const out = { level: 'main', overall, head, results, stacks, duration_s, log, since: since ?? null, pending_commits: pending ? pending.length : null, suspects: overall === 'FAIL' ? (pending ?? []).slice(0, 30) : undefined };
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`[gate] main ${overall} · ${duration_s}s · head ${head.slice(0, 8)} · 직전 PASS 이후 커밋 ${pending ? pending.length : '?'}개`);
    for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(8)} ${v}`);
    console.log(`  log      ${log}`);
    if (overall === 'FAIL' && pending?.length) console.log(`  용의 커밋(직전 PASS 이후, first-parent):\n    ${pending.slice(0, 30).join('\n    ')}`);
  }
  process.exit(overall === 'PASS' ? 0 : 1);
}
