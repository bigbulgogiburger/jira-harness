#!/usr/bin/env node
// gate.mjs — 게이트 러너. 브랜치 상태 JSON 의 gate 기록을 쓰는 유일한 경로.
//   --commit : 경량(건드린 스택의 compile·lint + DoD 프로브) — 목표 ≤ gate.commit_budget_s
//   --full   : 전량(모든 스택의 compile·lint·build·test·extra + DoD 프로브) — push/complete 전제
// 옵션: --stage-all(git add -A 후 검증) · --dry-run(계획만) · --stacks a,b · --cwd <dir> · --json
// 지문 = 실행 전 인덱스 트리(런타임 경로 제외). 실행 중 인덱스가 바뀌면 기록하지 않는다.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { locateProject, loadConfig, parseBranch, statePath, readState, writeState, stacksTouched } from './lib/config.mjs';
import { currentBranch, git, stagedFiles, untrackedFiles, changedVsHead, pinRef } from './lib/git.mjs';
import { fingerprintTree } from './lib/tree.mjs';
import { parseTestCount, stripAnsi } from './lib/probe.mjs';
import { resolveShell as resolveShellLib } from './lib/shell.mjs';

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
const probes = ((state && state.dod) || []).filter(d => d.probe && !d.human);
const humans = ((state && state.dod) || []).filter(d => d.human || !d.probe);

if (flag('--dry-run')) {
  const plan = { level, branch, keys: parsed ? parsed.keys : [], changed_files: changed.length, stacks: Object.fromEntries(stackNames.map(n => [n, Object.fromEntries(steps.map(s => [s, cfg.stacks[n][s] ?? null]))])), dod_probes: probes.map(d => ({ id: d.id, probe: d.probe, cwd: d.cwd ?? null })), dod_human: humans.map(d => d.id), shell: resolveShell(cfg).name };
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

for (const name of stackNames) {
  const s = cfg.stacks[name];
  const dir = resolve(root, s.dir);
  const env = { ...process.env, ...loadEnvFile(configRoot, s.env_file), JIRA_HARNESS_GATE: level };
  stacksOut[name] = {};
  for (const step of steps) {
    const cmds = step === 'extra' ? (s.extra ?? []) : (s[step] ? [s[step]] : []);
    if (!cmds.length) { stacksOut[name][step] = 'SKIPPED'; perKey[step].push('SKIPPED'); continue; }
    let verdict = 'PASS';
    for (const cmd of cmds) {
      console.error(`[gate] ${name}.${step}: ${cmd}`);
      const r = runCmd(shell, cmd, { cwd: dir, env, timeoutS: cfg.gate.timeout_s });
      logChunks.push(`\n## ${name}.${step} $ ${cmd}\n## exit=${r.status} ${r.seconds}s${r.timedOut ? ' TIMEOUT' : ''}${r.error ? ' error=' + r.error : ''}\n${r.out.length > 200_000 ? r.out.slice(0, 200_000) + '\n…(truncated)' : r.out}\n`);
      if (r.status !== 0) { verdict = 'FAIL'; console.error(`[gate] ${name}.${step} FAIL (exit ${r.status}${r.timedOut ? ', timeout' : ''})`); break; }
    }
    stacksOut[name][step] = verdict;
    perKey[step].push(verdict);
  }
}
for (const step of steps) {
  const vs = perKey[step];
  results[step] = vs.includes('FAIL') ? 'FAIL' : vs.includes('PASS') ? 'PASS' : 'SKIPPED';
}

// DoD 프로브
let dodPass = 0, dodFail = 0;
for (const d of probes) {
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
  d.last = reasons.length ? 'FAIL' : 'PASS';
  d.at = nowIso();
  if (d.last === 'PASS') dodPass++; else dodFail++;
  logChunks.push(`\n## dod ${d.id} $ ${d.probe}\n## exit=${r.status} ${r.seconds}s → ${d.last}${reasons.length ? ' (' + reasons.join('; ') + ')' : ''}\n${r.out.slice(0, 200_000)}\n`);
}
results.dod = dodFail ? 'FAIL' : dodPass ? 'PASS' : 'SKIPPED';
const dodSummary = `${dodPass}/${probes.length}${humans.length ? ` (human ${humans.length} 제외)` : ''}`;

// 로그 기록
const logDir = join(configRoot, cfg.runtime_dir, 'gate');
mkdirSync(logDir, { recursive: true });
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
state.gate = {
  level, tree, results, stacks: stacksOut, dod: dodSummary,
  log: logRel, log_sha256: sha256(Buffer.from(logText, 'utf8')), duration_s, at,
  full_at: level === 'full' ? at : (prev && prev.tree === tree ? prev.full_at ?? null : null),
};
state.history = [...(state.history ?? []), { stage: 'gate', at, note: `${level} ${overall} ${duration_s}s` }];
writeState(sPath, state);
try { pinRef(`refs/harness/${parsed.slug}/gate`, tree, root); } catch (e) { console.error(`[gate] ref 고정 실패(무시): ${e.message}`); }

const summary = { level, overall, tree, results, stacks: stacksOut, dod: dodSummary, duration_s, log: logRel, state: relative(configRoot, sPath).replace(/\\/g, '/') };
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`[gate] ${level} ${overall} · ${duration_s}s · tree ${tree.slice(0, 12)} · dod ${dodSummary}`);
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(8)} ${v}`);
  console.log(`  log      ${logRel}`);
  if (level === 'commit' && duration_s > cfg.gate.commit_budget_s) console.log(`  ⚠ 경량 게이트 목표 ${cfg.gate.commit_budget_s}s 초과`);
}
process.exit(overall === 'PASS' ? 0 : 1);
