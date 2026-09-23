#!/usr/bin/env node
// gate.mjs — 게이트 러너. 브랜치 상태 JSON 의 gate 기록을 쓰는 유일한 경로.
//   --commit : 경량(건드린 스택의 compile·lint + DoD 프로브) — 목표 ≤ gate.commit_budget_s
//   --full   : 전량(모든 스택의 compile·lint·build·test·extra + DoD 프로브) — push/complete 전제
// 옵션: --stage-all(git add -A 후 검증) · --dry-run(계획만) · --stacks a,b · --cwd <dir> · --json
// 지문 = 실행 전 인덱스 트리(런타임 경로 제외). 실행 중 인덱스가 바뀌면 기록하지 않는다.
// DoD: `tests: {stack, select[]}` 항목은 스택별로 **한 번에** 돌려 리포트로 항목마다 판정한다(lib/dod-tests.mjs · stacks.<name>.dod_tests).
//      전량 게이트는 그 스택 test 단계의 리포트를 그대로 읽는다 — 다시 돌리지 않는다. `probe` 문자열 항목은 종전대로 항목마다 돈다.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { locateProject, loadConfig, parseBranch, statePath, readState, writeState, stacksTouched } from './lib/config.mjs';
import { currentBranch, git, stagedFiles, untrackedFiles, changedVsHead, pinRef } from './lib/git.mjs';
import { fingerprintTree } from './lib/tree.mjs';
import { parseTestCount, stripAnsi } from './lib/probe.mjs';
import { resolveShell as resolveShellLib } from './lib/shell.mjs';
import { herdrPing } from './lib/herdr.mjs';
import { batchCommand, collectEntries, judgeTests, vitestReportArgs } from './lib/dod-tests.mjs';

// ---------- 인자 ----------
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const level = flag('--full') ? 'full' : flag('--commit') ? 'commit' : null;
if (!level) fail(2, '사용법: gate.mjs --commit | --full [--stage-all] [--dry-run] [--stacks a,b] [--cwd <dir>] [--json]');
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
const parsed = parseBranch(branch, cfg);
if (!parsed && !flag('--dry-run')) fail(2, `브랜치 "${branch ?? '(detached)'}" 가 branch_pattern 밖이다`);
const sPath = statePath(cfg, configRoot, parsed ? parsed.slug : 'dry-run'); // dry-run 은 상태·브랜치 없이도 계획만 보여준다(setup check 가 이슈 전에 부른다)
const state = readState(sPath);
if (!state && !flag('--dry-run')) fail(2, `상태 JSON 이 없다(${relative(configRoot, sPath)}) — /jira-harness:issue ${parsed.keys[0]} 로 시작할 것`);

if (flag('--stage-all')) git(['add', '-A'], { cwd: root });

const changed = [...new Set([...stagedFiles(root), ...changedVsHead(root), ...untrackedFiles(root)])];
const wanted = opt('--stacks') ? opt('--stacks').split(',').map(s => s.trim()).filter(Boolean) : null;
let stackNames = wanted ?? (level === 'full' ? Object.keys(cfg.stacks) : stacksTouched(changed, cfg));
for (const n of stackNames) if (!cfg.stacks[n]) fail(2, `알 수 없는 스택 "${n}" (harness.json.stacks: ${Object.keys(cfg.stacks).join(', ')})`);
const steps = level === 'full' ? ['compile', 'lint', 'build', 'test', 'extra'] : ['compile', 'lint'];
const probes = ((state && state.dod) || []).filter(d => (d.probe || d.tests) && !d.human);
const humans = ((state && state.dod) || []).filter(d => d.human || (!d.probe && !d.tests));
// 구조화 테스트 항목 — 그 스택에 dod_tests 어댑터가 있을 때만. 없으면 probe 문자열로 돌고, probe 도 없으면 FAIL
const testItems = probes.filter(d => d.tests && cfg.stacks[d.tests.stack]?.dod_tests);
const probeItems = probes.filter(d => !testItems.includes(d));
const byStack = new Map();
for (const d of testItems) byStack.set(d.tests.stack, [...(byStack.get(d.tests.stack) ?? []), d]);

if (flag('--dry-run')) {
  const dodBatches = Object.fromEntries([...byStack].map(([n, items]) => [n, { ids: items.map(d => d.id), cmd: batchCommand(cfg.stacks[n].dod_tests, items.flatMap(d => d.tests.select), `<runtime>/gate/<slug>-${n}-dod.vitest.json`) }]));
  const plan = { level, branch, keys: parsed ? parsed.keys : [], changed_files: changed.length, stacks: Object.fromEntries(stackNames.map(n => [n, Object.fromEntries(steps.map(s => [s, cfg.stacks[n][s] ?? null]))])), dod_probes: probes.map(d => ({ id: d.id, probe: d.probe ?? null, tests: d.tests ?? null, cwd: d.cwd ?? null })), dod_batches: dodBatches, dod_human: humans.map(d => d.id), shell: resolveShell(cfg).name };
  console.log(json ? JSON.stringify(plan, null, 2) : `[gate] dry-run ${level}\n` + JSON.stringify(plan, null, 2));
  process.exit(0);
}

const shell = resolveShell(cfg);
const tree = fingerprintTree({ cwd: root, base: 'index', excludes: cfg.fingerprint_exclude });
const OKSET = new Set(['PASS', 'SKIPPED']);
const prev = state.gate;
if (level === 'commit' && prev && prev.level === 'full' && prev.tree === tree && Object.values(prev.results ?? {}).every(v => OKSET.has(v))) {
  console.log(`[gate] 같은 트리(${tree.slice(0, 12)})가 이미 전량 게이트를 통과했다(${prev.at}) — 재실행 생략`);
  process.exit(0);
}

const t0 = Date.now();
const logChunks = [`# jira-harness gate ${level} · ${branch} · ${nowIso()} · tree ${tree}\n`];
const results = { compile: 'NOT_RUN', lint: 'NOT_RUN', build: 'NOT_RUN', test: 'NOT_RUN', extra: 'NOT_RUN', dod: 'NOT_RUN' };
const perKey = { compile: [], lint: [], build: [], test: [], extra: [] };
const stacksOut = {};
const logDir = join(configRoot, cfg.runtime_dir, 'gate');
mkdirSync(logDir, { recursive: true });
const harvest = {}; // 전량: 스택 test 단계의 리포트 — DoD 테스트 항목을 다시 돌리지 않고 여기서 판정한다

for (const name of stackNames) {
  const s = cfg.stacks[name];
  const dir = resolve(root, s.dir);
  const env = { ...process.env, ...loadEnvFile(configRoot, s.env_file), JIRA_HARNESS_GATE: level };
  stacksOut[name] = {};
  for (const step of steps) {
    let cmds = step === 'extra' ? (s.extra ?? []) : (s[step] ? [s[step]] : []);
    if (!cmds.length) { stacksOut[name][step] = 'SKIPPED'; perKey[step].push('SKIPPED'); continue; }
    // test 명령이 DoD 어댑터의 run 과 같을 때만 거둔다(다른 명령이면 리포트가 같은 모집단이라는 보장이 없다) — vitest 는 JSON 리포터를 덧붙인다
    const dt = s.dod_tests;
    const reuse = level === 'full' && step === 'test' && byStack.has(name) && cmds.length === 1 && cmds[0].trim() === dt.run.trim();
    const reportPath = reuse && dt.adapter === 'vitest' ? join(logDir, `${parsed.slug}-${name}-full.vitest.json`) : null;
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
    stacksOut[name][step] = verdict;
    perKey[step].push(verdict);
  }
}
for (const step of steps) {
  const vs = perKey[step];
  results[step] = vs.includes('FAIL') ? 'FAIL' : vs.includes('PASS') ? 'PASS' : 'SKIPPED';
}

// DoD ① 구조화 테스트 항목 — 스택별 1회(전량이면 test 단계 리포트로 판정하고, 거기 안 걸린 항목만 배치로 돈다)
let dodPass = 0, dodFail = 0;
function recordDod(d, verdict, note) { d.last = verdict; d.at = nowIso(); if (verdict === 'PASS') dodPass++; else dodFail++; logChunks.push(note); }
for (const [name, items] of byStack) {
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

// DoD ② 프로브 문자열 — 항목마다
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
results.dod = dodFail ? 'FAIL' : dodPass ? 'PASS' : 'SKIPPED';
const dodSummary = `${dodPass}/${probes.length}${humans.length ? ` (human ${humans.length} 제외)` : ''}`;

// 로그 기록
const logPath = join(logDir, `${parsed.slug}-${level}-${nowIso().replace(/[:.]/g, '-')}.log`);
const logText = logChunks.join('');
writeFileSync(logPath, logText, 'utf8');
const logRel = relative(configRoot, logPath).replace(/\\/g, '/');

// 실행 중 트리 변경 감지
const tree2 = fingerprintTree({ cwd: root, base: 'index', excludes: cfg.fingerprint_exclude });
if (tree2 !== tree) fail(1, `게이트 실행 중 인덱스가 바뀌었다(${tree.slice(0, 12)} → ${tree2.slice(0, 12)}) — 기록하지 않음. 재실행할 것`);

const overallKeys = level === 'full' ? ['compile', 'lint', 'build', 'test', 'extra', 'dod'] : ['compile', 'lint', 'dod'];
const overall = overallKeys.every(k => OKSET.has(results[k])) ? 'PASS' : 'FAIL';
const at = nowIso();
const duration_s = +((Date.now() - t0) / 1000).toFixed(1);
// 쓰기 직전에 다시 읽고 게이트 몫(gate · history · DoD 판정)만 얹는다 — 게이트가 도는 동안 다른 경로(issue-set --review 등)가 상태를 고쳤을 수 있고,
// 시작 때 읽은 사본을 통째로 쓰면 그 기록이 사라진다(2026-09-23 실측: 94분 전량 게이트 도중 기록한 델타 리뷰가 게이트 종료와 함께 지난 기록으로 되돌아가 훅이 REVIEW_STALE)
const latest = readState(sPath) ?? state;
const judged = new Map((state.dod ?? []).filter(d => d.at && d.last).map(d => [d.id, d]));
for (const d of latest.dod ?? []) {
  const j = judged.get(d.id);
  // 판정한 뒤 그 항목의 검사 자체가 바뀌었으면(plan 재병합 등) 옛 판정을 얹지 않는다
  if (j && (j.probe ?? null) === (d.probe ?? null) && JSON.stringify(j.tests ?? null) === JSON.stringify(d.tests ?? null)) { d.last = j.last; d.at = j.at; }
}
latest.gate = {
  level, tree, results, stacks: stacksOut, dod: dodSummary,
  log: logRel, log_sha256: sha256(Buffer.from(logText, 'utf8')), duration_s, at,
  full_at: level === 'full' ? at : (prev && prev.tree === tree ? prev.full_at ?? null : null),
};
latest.history = [...(latest.history ?? []), { stage: 'gate', at, note: `${level} ${overall} ${duration_s}s` }];
writeState(sPath, latest);
try { pinRef(`refs/harness/${parsed.slug}/gate`, tree, root); } catch (e) { console.error(`[gate] ref 고정 실패(무시): ${e.message}`); }
// Herdr 사이드바·알림(Herdr 밖이면 무동작). FAIL 은 사람을 부르고(request), 전량 PASS 는 끝났다고 알린다(done).
herdrPing(cwd, `gate ${level} ${overall}`, overall === 'FAIL'
  ? { title: `${latest.keys.join(',')} gate ${level} FAIL`, body: Object.entries(results).filter(([, v]) => v === 'FAIL').map(([k]) => k).join(', ') || 'FAIL', sound: 'request' }
  : level === 'full' ? { title: `${latest.keys.join(',')} gate full PASS`, body: `${duration_s}s · push 가능`, sound: 'done' } : null);

const summary = { level, overall, tree, results, stacks: stacksOut, dod: dodSummary, duration_s, log: logRel, state: relative(configRoot, sPath).replace(/\\/g, '/') };
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`[gate] ${level} ${overall} · ${duration_s}s · tree ${tree.slice(0, 12)} · dod ${dodSummary}`);
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(8)} ${v}`);
  console.log(`  log      ${logRel}`);
  if (level === 'commit' && duration_s > cfg.gate.commit_budget_s) console.log(`  ⚠ 경량 게이트 목표 ${cfg.gate.commit_budget_s}s 초과`);
}
process.exit(overall === 'PASS' ? 0 : 1);
