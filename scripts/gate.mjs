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
//   --try    : 구현 중 확인 — DoD tests 항목을 스택마다 **한 번에** 묶어 돌리고 항목별 판정만 낸다. **게이트가 아니다**: 상태 JSON·판정·ref 를
//              쓰지 않고 훅도 이 결과를 보지 않는다(push 전제는 여전히 --dod/--related/--full). 남기는 것은 로그 파일 하나뿐이다.
//              구현하는 쪽(드라이버·구현 레인)이 러너 명령을 손으로 조립해 여러 번 띄우는 대신 쓴다 — 게이트의 DoD 배치와 같은 명령 ·
//              환경 파일(env_file) · 판정(분모·하한)으로 돈다(다른 것은 러너에 주는 JIRA_HARNESS_GATE 값이 `try` 라는 것 하나다).
//              같은 작업트리에서 --try 를 동시에 두 개 돌리지 않는다 — 러너의 빌드 폴더와 gradle 리포트 폴더는 작업트리마다 하나다
//              (레인은 각자 작업트리에서 돈다. vitest 리포트 파일만 실행마다 이름이 다르다).
//                --try [--ids D1,D3]        이 브랜치 이슈의 DoD tests 항목 전부(--ids 면 그 항목만 — probe 항목도 지목하면 돈다)
//                --try --lane <레인>        그 레인의 lanes[].dod 에 적힌 항목만
//                --try --stack <스택> --select <패턴> [--select …]   상태와 무관하게 그 선택만(실패한 것만 다시 · 고친 파일을 덮는 기존 테스트)
//                --slug <slug>              이슈 브랜치가 아닌 트리(구현 레인의 작업트리)에서 어느 이슈인지 — 테스트는 --cwd 의 트리에서 돈다
// 옵션: --stage-all(git add -A 후 검증) · --dry-run(계획만) · --stacks a,b · --cwd <dir> · --json · --no-queue
//      --full 의 --stacks 는 이 브랜치가 바꾼 스택을 뺄 수 없다(빼면 그 스택을 검증한 것처럼 기록이 남는다).
// 대기열: 무거운 게이트(--full · --related · --main)는 이 PC 에서 한 번에 하나만 돈다(lib/queue.mjs) — 다른 작업공간의 게이트가 돌고 있으면
//      먼저 온 순서대로 기다린다. 줄을 서지 않으려면 --no-queue · GATE_QUEUE=off · harness.json gate.queue=false.
//      gate.queue_max_wait_s 를 넘기면 게이트를 돌리지 않고 exit 75 로 끝난다. 기다린 시간은 기록의 queue_wait_s 에 남는다.
// 지문 = 실행 전 인덱스 트리(런타임 경로 제외). 실행 중 인덱스가 바뀌면 기록하지 않는다.
// DoD: `tests: {stack, select[]}` 항목은 스택별로 **한 번에** 돌려 리포트로 항목마다 판정한다(lib/dod-tests.mjs · stacks.<name>.dod_tests).
//      그 스택 test 단계가 테스트 **전부**를 돌았으면 그 리포트에 걸린 항목은 리포트를 그대로 읽는다 — 다시 돌리지 않는다.
//      관련 테스트로 고른 것만 돈 리포트는 판정에 쓰지 않는다(항목의 선택 중 돌지 않은 테스트가 빠진다) — 그때는 항목들을 배치로 돈다.
//      `probe` 문자열 항목은 항목마다 돈다.
// lint 범위: 스택에 `lint_changed` 가 있으면 이슈 게이트(--commit · --dod · --related)의 lint 는 그 게이트가 보는 변경 파일만 넘겨 돈다
//      (lib/lint-changed.mjs — lint 설정 변경·상한 초과면 전체로 넘어가고, 바뀐 대상이 없으면 파일과 무관한 검사만 돌거나 SKIPPED 다).
//      --full 과 --main 은 언제나 전체 lint 다.
//      어느 쪽으로 돌았는지는 dry-run 계획 · 로그 · 기록(gate.lint_scope) · 요약의 `lint 범위` 줄에 남는다.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, resolve, basename } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { locateProject, loadConfig, parseBranch, statePath, readState, writeState, stacksTouched, matchesAny, underStack, aboveStack } from './lib/config.mjs';
import { currentBranch, git, stagedFiles, untrackedFiles, changedVsHead, branchChangedFiles, pinRef } from './lib/git.mjs';
import { fingerprintTree } from './lib/tree.mjs';
import { parseTestCount, stripAnsi } from './lib/probe.mjs';
import { resolveShell as resolveShellLib } from './lib/shell.mjs';
import { herdrPing } from './lib/herdr.mjs';
import { batchCommand, collectEntries, judgeTests, snapshotReports, vitestReportArgs } from './lib/dod-tests.mjs';
import { selectRelated, relatedCommand } from './lib/related-tests.mjs';
import { planLint } from './lib/lint-changed.mjs';
import { REQUIRED_KEYS } from './lib/gate-core.mjs';
import { acquire, queueOff, queueHeld } from './lib/queue.mjs';
import { killTree, killOrphans } from './lib/proctree.mjs';

// ---------- 인자 ----------
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const optAll = n => argv.flatMap((a, i) => (a === n && argv[i + 1] != null ? [argv[i + 1]] : []));
const level = flag('--try') ? 'try' : flag('--main') ? 'main' : flag('--full') ? 'full' : flag('--related') ? 'related' : flag('--dod') ? 'dod' : flag('--commit') ? 'commit' : null;
if (!level) fail(2, '사용법: gate.mjs --commit | --dod | --related | --full | --main [--status] | --try [--ids a,b | --lane <이름> | --stack <스택> --select <패턴>…] [--slug <slug>] [--stage-all] [--dry-run] [--stacks a,b] [--no-queue] [--cwd <dir>] [--json]');
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
  const t1 = Date.now(); // 셸이 끝난 것을 안 시각 — 이 뒤에 그 pid 의 자식으로 태어난 프로세스는 셸의 것이 아니다(pid 재사용)
  const timedOut = r.error?.code === 'ETIMEDOUT';
  // 시간 상한에 걸리면 spawnSync 는 직접 자식(셸)만 끝낸다 — 그 아래 러너가 남으면 자리를 넘겨받은 다음 게이트와 겹쳐 돈다.
  // 이 단계는 이미 FAIL 이라 여기서 무엇을 끝내도 판정은 달라지지 않는다
  if (timedOut) killOrphans(r.pid, t0, t1);
  const stdout = (r.stdout ?? '').replace(/\r\n/g, '\n'), stderr = (r.stderr ?? '').replace(/\r\n/g, '\n');
  const out = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
  return { status: timedOut ? -2 : (r.status ?? -1), out, log: clipStreams(stdout, stderr), seconds: +((Date.now() - t0) / 1000).toFixed(1), timedOut, error: r.error?.message ?? null };
}
/** DoD 프로브 한 건을 돌려 판정한다 — 종료 코드 · expect.pattern · expect.min_tests(분모). 게이트와 --try 가 같은 판정을 쓴다 */
function runProbe(shell, d) {
  const r = runCmd(shell, d.probe, { cwd: resolve(root, d.cwd ?? '.'), env: { ...process.env, JIRA_HARNESS_GATE: level }, timeoutS: cfg.gate.timeout_s });
  const reasons = [];
  const out = stripAnsi(r.out); // 러너 색상 코드가 숫자·문구 사이에 끼면 정규식이 조용히 빗나간다
  if (r.status !== 0) reasons.push(`exit ${r.status}`);
  if (d.expect?.pattern && !new RegExp(d.expect.pattern, 'm').test(out)) reasons.push(`pattern /${d.expect.pattern}/ 없음`);
  if (d.expect?.min_tests != null) {
    const n = parseTestCount(out);
    if (n == null) reasons.push('실행 건수(분모) 미확인 — 테스트를 도는 프로브는 러너 요약(`Tests N passed`·`N tests completed`)이나 숫자 한 줄을 찍어야 한다. 건수가 없는 sentinel 프로브(위반 주입·존재 검사)는 min_tests 를 빼고 pattern 만 둔다');
    else if (n < d.expect.min_tests) reasons.push(`실행 건수 ${n} < ${d.expect.min_tests}`);
  }
  return { r, reasons, verdict: reasons.length ? 'FAIL' : 'PASS' };
}

// ---------- 기록 ----------
/** 긴 출력은 머리와 꼬리를 남긴다 — 실패 요약과 실패한 테스트 이름은 출력 끝에 있다. 머리만 남기면 그 부분이 잘려 원인을 보려고 게이트를 다시 돌리게 된다 */
const LOG_BUDGET = 200_000; // 명령 하나가 로그에 남기는 글자 수 — 넘치면 머리 1/4 · 꼬리 3/4
function clip(out, budget = LOG_BUDGET) {
  if (out.length <= budget) return out;
  const head = Math.floor(budget / 4), tail = budget - head;
  return `${out.slice(0, head)}\n…(가운데 ${out.length - budget}자 생략 — 전체 ${out.length}자 중 앞 ${head}자 · 뒤 ${tail}자만 남긴다)…\n${out.slice(-tail)}`;
}
/** 표준 출력과 표준 오류를 따로 자른다 — 합쳐서 자르면 긴 stderr 가 stdout 끝의 실패 요약을 밀어낸다. 짧은 쪽은 그대로 두고 남는 몫을 긴 쪽에 준다 */
function clipStreams(stdout, stderr) {
  if (!stderr) return clip(stdout);
  const half = LOG_BUDGET / 2;
  const so = clip(stdout, LOG_BUDGET - Math.min(stderr.length, half)), se = clip(stderr, LOG_BUDGET - Math.min(stdout.length, half));
  return `${so}\n[stderr]\n${se}`;
}
/**
 * 러너 리포트에서 실패한 스위트(gradle: FQCN) · 파일(vitest: 스택 dir 기준 경로)을 뽑는다 — 단독 재실행에 필요한 이름이다.
 * 판정에는 쓰지 않는다(판정은 종료 코드다). 이름은 실패 건수가 많은 순으로 FAILED_NAMES_MAX 개까지, 개수(suites · tests)는 전부 센다.
 * 알려 주기만 하는 기록이다: 이름을 읽으려고 test 명령을 바꾸지 않고(명령의 종료 코드가 판정이다), 리포트를 읽다 무슨 일이 나도 판정·기록을 끊지 않는다.
 * 그래서 gradle 은 러너가 늘 쓰는 XML 을 읽고, vitest 는 DoD 판정 때문에 이미 JSON 리포터가 붙은 실행의 리포트만 읽는다(그 밖에는 로그 꼬리를 본다).
 */
const FAILED_NAMES_MAX = 30;
function failedTests(read) {
  let entries;
  try { entries = read(); } catch { return null; }
  const bad = (Array.isArray(entries) ? entries : []).filter(e => e?.failed > 0).sort((a, b) => b.failed - a.failed || (a.name < b.name ? -1 : 1));
  if (!bad.length) return null;
  return { suites: bad.length, tests: bad.reduce((n, e) => n + e.failed, 0), names: bad.slice(0, FAILED_NAMES_MAX).map(e => e.name) };
}
const failedLine = (n, f) => `${n}: 스위트·파일 ${f.suites}개 · 테스트 ${f.tests}건 — ${f.names.slice(0, 10).join(', ')}${f.suites > 10 ? ` 외 ${f.suites - 10}개` : ''}`;

// ---------- 대기열 ----------
/** 한 번에 하나만 도는 단계 — 빌드·전체(또는 그만큼 불어날 수 있는) 테스트를 도는 것들. 경량(--commit)·--dod 는 줄을 서지 않는다 */
const HEAVY = new Set(['full', 'related', 'main']);
// 줄을 서서 기다린 시간(초) — 아래 viaQueue 가 이 게이트를 다시 띄우며 넘긴다. null = 줄을 서지 않은 실행
// 값은 자리를 쥐고 이 게이트를 띄운 쪽(viaQueue · queue-run.mjs)만 넘긴다. 유한한 0 이상의 수가 아니면 기록하지 않는다 —
// 상태 JSON 에 null·음수가 실리면 다음 게이트가 스키마 오류로 선다
const waitedEnv = process.env.GATE_QUEUE_WAITED_S;
delete process.env.GATE_QUEUE_WAITED_S; // 이 게이트가 돌리는 명령들(그 안의 다른 게이트)에 새지 않게
const queueWaitS = queueHeld() && waitedEnv != null && waitedEnv.trim() !== '' && Number.isFinite(Number(waitedEnv)) && Number(waitedEnv) >= 0 ? Number(waitedEnv) : null;
/**
 * 무거운 게이트는 대기열에서 차례를 받은 뒤, **새 프로세스로** 이 게이트를 다시 띄우고 그것이 끝날 때까지 자리를 쥔다.
 * 다시 띄우는 까닭: 기다리는 동안 작업트리가 바뀔 수 있다. 줄을 서기 전에 세운 계획(바뀐 스택·관련 테스트 선택)으로 기다린 뒤의 트리를 재면
 * 돌지 않은 검사를 돈 것으로 기록한다. 사용법·설정·브랜치 오류는 여기 오기 전에 이미 걸러져 기다리기 전에 끝난다.
 * 계획만 보는 --dry-run·--status 와 줄을 서지 않는 단계는 이 함수에 오지 않거나 곧바로 돌아간다.
 */
async function viaQueue() {
  if (!HEAVY.has(level) || queueHeld()) return; // queueHeld: 바깥에서 이미 자리를 쥐고 띄운 실행(이 함수가 띄운 자식 · queue-run.mjs 안)
  if (flag('--no-queue') || cfg.gate?.queue === false || queueOff()) return;
  const maxWaitS = cfg.gate?.queue_max_wait_s ?? 0;
  const q = await acquire({ info: { project: basename(configRoot), what: `gate --${level}`, branch, cwd: root.replace(/\\/g, '/') }, maxWaitS, log: line => console.error(`[gate] ${line}`) });
  if (!q.ok) {
    const h = q.holder;
    console.error(`[gate] 대기열에서 ${q.waited_s}s 기다렸지만 차례가 오지 않았다(gate.queue_max_wait_s=${maxWaitS})${h ? ` — 지금 도는 것: ${h.project} 의 ${h.what} (pid ${h.pid})` : ''}. 게이트는 돌지 않았고 기록도 없다 — 백그라운드로 다시 실행해 기다릴 것`);
    process.exit(75);
  }
  if (q.broken) console.error(`[gate] ⚠ 대기열을 쓸 수 없어 줄을 서지 않고 돈다 — ${q.broken}`);
  else if (q.waited_s >= 1) console.error(`[gate] 대기열: ${q.waited_s}s 기다린 뒤 시작한다`);
  // 대기열을 쓰지 못해 줄 없이 도는 실행(broken)은 기다린 시간을 넘기지 않는다 — 줄을 서지 않은 실행의 기록에 「대기 0초」가 실리지 않게
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv], { stdio: 'inherit', windowsHide: true, env: { ...process.env, GATE_QUEUE_HELD: '1', ...(q.broken ? {} : { GATE_QUEUE_WAITED_S: String(q.waited_s) }) } });
  // 신호를 받으면 게이트를 트리째 끝낸다 — 게이트 프로세스만 끝내면 그 아래 러너가 남은 채 자리가 다음 차례로 넘어간다
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => killTree(child.pid, sig));
  const code = await new Promise(done => {
    child.on('error', e => { console.error(`[gate] 게이트 프로세스를 띄우지 못했다: ${e.message}`); done(2); });
    child.on('exit', c => done(c ?? 1));
  });
  q.release();
  process.exit(code);
}

// ---------- 본체 ----------
const proj = locateProject(cwd);
if (!proj || !proj.configPath) fail(2, 'harness.json 이 없다 — /jira-harness:setup 으로 설치할 것');
let cfg; try { cfg = loadConfig(proj.configPath); } catch (e) { fail(2, `harness.json 이 유효하지 않다(${proj.configPath}): ${e.message}`); }
const root = proj.toplevel;
const configRoot = proj.configRoot;
const branch = currentBranch(root);
if (level === 'main') await runMainGate(); // 이슈 상태와 무관한 경로 — 끝나면 프로세스를 끝낸다
if (level === 'try') runTry(); // 기록을 남기지 않는 경로 — 끝나면 프로세스를 끝낸다
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
  const r = selectRelated({ adapter: dt.adapter, stackDir: resolve(root, s.dir), files: underStack(branchCode, s.dir), related: s.related });
  const cmd = r.mode === 'full' ? s.test : r.mode === 'selected' ? relatedCommand({ adapter: dt.adapter, run: dt.run, select: r.select, related: s.related }) : null;
  return { ...r, cmd };
}
const relatedPlans = level === 'related' ? Object.fromEntries(stackNames.map(n => [n, relatedPlan(n)])) : {};

// 이슈 게이트의 lint 범위 — 스택에 lint_changed 가 있으면 이 게이트가 보는 변경 파일만 넘긴다(커밋 게이트 = 작업트리 변경 · dod/related = 이 브랜치가
// 바꾼 것 전부). 전체 lint 는 --full 과 --main 이 돈다. {mode: changed|none|full, cmds, files, reason} — 돌리지 않았거나 전체로 넘어간 까닭도 여기 남는다
// 스택 이름으로 찾는 표라 원형 없는 객체에 담는다(스택 이름이 constructor 같은 물려받은 속성 이름이어도 「계획 있음」으로 읽히지 않게)
const shell = resolveShell(cfg); // lint 계획이 셸을 본다(cmd 면 좁혀 돌지 않는다) — 그래서 계획보다 먼저 고른다
const lintPlans = Object.create(null);
if (level === 'commit' || branchScoped) for (const n of stackNames) {
  const s = cfg.stacks[n];
  if (!s.lint || !s.lint_changed) continue;
  const scope = branchScoped ? branchCode : changed;
  lintPlans[n] = planLint({ stack: s, stackDir: resolve(root, s.dir), files: underStack(scope, s.dir), above: aboveStack(scope, s.dir), shell: shell.name });
}
const lintScope = l => ({ mode: l.mode, files: l.files, reason: l.reason });

if (flag('--dry-run')) {
  const dodBatches = Object.fromEntries([...byStack].map(([n, items]) => [n, { ids: items.map(d => d.id), cmd: batchCommand(cfg.stacks[n].dod_tests, items.flatMap(d => d.tests.select), `<runtime>/gate/<slug>-${n}-dod.vitest.json`) }]));
  const plan = { level, branch, keys: parsed ? parsed.keys : [], changed_files: changed.length, stacks: Object.fromEntries(stackNames.map(n => [n, Object.fromEntries(steps.map(s => [s, s === 'test' && level === 'related' ? relatedPlans[n].cmd : s === 'lint' && lintPlans[n] ? (lintPlans[n].cmds.join(' && ') || null) : cfg.stacks[n][s] ?? null]))])), lint_scope: Object.keys(lintPlans).length ? Object.fromEntries(Object.entries(lintPlans).map(([n, l]) => [n, lintScope(l)])) : undefined, related: level === 'related' ? Object.fromEntries(Object.entries(relatedPlans).map(([n, r]) => [n, { mode: r.mode, reason: r.reason, selected: r.select.length }])) : undefined, dod_probes: probes.map(d => ({ id: d.id, probe: d.probe ?? null, tests: d.tests ?? null, cwd: d.cwd ?? null })), dod_batches: dodBatches, dod_human: humans.map(d => d.id), shell: shell.name };
  console.log(json ? JSON.stringify(plan, null, 2) : `[gate] dry-run ${level}\n` + JSON.stringify(plan, null, 2));
  process.exit(0);
}

await viaQueue(); // 무거운 게이트는 여기서 줄을 선다 — 차례가 오면 새 프로세스가 처음부터 돌고, 이 프로세스는 자리를 쥔 채 그 종료 코드로 끝난다
const tree = fingerprintTree({ cwd: root, base: 'index', excludes: cfg.fingerprint_exclude });
const OKSET = new Set(['PASS', 'SKIPPED']);
const prev = state.gate;
if (level === 'commit' && prev && ['full', 'related', 'dod'].includes(prev.level) && prev.tree === tree && ['compile', 'lint'].every(k => OKSET.has(prev.results?.[k] ?? 'NOT_RUN'))) {
  console.log(`[gate] 같은 트리(${tree.slice(0, 12)})가 이미 ${prev.level} 게이트를 통과했다(${prev.at}) — 재실행 생략`);
  process.exit(0);
}

const t0 = Date.now();
const logChunks = [`# jira-harness gate ${level} · ${branch} · ${nowIso()} · tree ${tree}\n`];
if (queueWaitS >= 1) logChunks.push(`# queue wait ${queueWaitS}s\n`);
const results = { compile: 'NOT_RUN', lint: 'NOT_RUN', build: 'NOT_RUN', test: 'NOT_RUN', extra: 'NOT_RUN', dod: 'NOT_RUN' };
const perKey = { compile: [], lint: [], build: [], test: [], extra: [] };
const stacksOut = {};
const logDir = join(configRoot, cfg.runtime_dir, 'gate');
mkdirSync(logDir, { recursive: true });
// 스택 이름으로 찾는 표는 원형 없는 객체로 둔다 — 스택 이름이 constructor·toString 같은 물려받은 속성 이름이어도 「있다」로 읽히지 않게
const harvest = Object.create(null); // 전량·관련: 스택 test 단계의 리포트 — 실패한 스위트 이름과 「관련 테스트 N건」에 쓴다
// 그 리포트가 스택의 테스트 **전부**를 돈 것인 스택 — DoD 테스트 항목을 다시 돌리지 않고 그 리포트로 판정해도 되는 것은 이때뿐이다.
// 고른 테스트만 돈 리포트(관련 테스트 선택)로 판정하면 항목의 선택 중 돌지 않은 테스트가 빠진다: 실패할 테스트가 안 돌아 PASS 가 되거나, 통과 건수가 모자라 FAIL 이 된다
const harvestWhole = new Set();
const relatedOut = {}; // 관련 테스트: 스택별 {mode, selected, tests, failed, reason} — 기록·요약에 남겨 "검사 0" 을 드러낸다
for (const [n, r] of Object.entries(relatedPlans)) relatedOut[n] = { mode: r.mode, selected: r.select.length, tests: 0, failed: 0, reason: r.reason };
const lintOut = {}; // lint_changed 가 있는 스택: {mode, files, reason} — lint 단계에 이른 스택만(프로브 FAIL 로 건너뛴 스택은 없다). 좁혀 돈 초록·돌리지 않은 것을 전체 lint 의 초록과 구분해 남긴다
const failedOut = {}; // 스택별 실패한 스위트·파일 이름 — test 단계가 실패했을 때만(판정에는 쓰지 않는다)
const timedOut = []; // 시간 상한(gate.timeout_s)에 걸려 죽은 단계 — 「테스트가 깨졌다」와 「시간이 모자랐다」를 요약에서 가른다

let dodPass = 0, dodFail = 0;
const judgedNow = new Set(); // 이번 실행이 판정한 DoD 항목 — 상태에 얹는 것은 이것뿐이다
function recordDod(d, verdict, note) { d.last = verdict; d.at = nowIso(); judgedNow.add(d.id); if (verdict === 'PASS') dodPass++; else dodFail++; logChunks.push(note); }

// DoD ① 프로브 문자열 — 항목마다, 스택 단계보다 먼저(경량 게이트는 DoD 가 없어 probeItems 가 비어 있다)
for (const d of probeItems) {
  if (!d.probe) { recordDod(d, 'FAIL', `\n## dod ${d.id} → FAIL (tests.stack=${d.tests?.stack} 에 dod_tests 어댑터가 없고 probe 도 없다 — harness.json stacks.<name>.dod_tests)\n`); continue; }
  console.error(`[gate] dod ${d.id}: ${d.probe}`);
  const { r, reasons, verdict } = runProbe(shell, d);
  if (r.timedOut) timedOut.push(`dod ${d.id}`);
  recordDod(d, verdict, `\n## dod ${d.id} $ ${d.probe}\n## exit=${r.status} ${r.seconds}s${r.timedOut ? ' TIMEOUT' : ''} → ${verdict}${reasons.length ? ' (' + reasons.join('; ') + ')' : ''}\n${r.log}\n`);
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
    const lp = step === 'lint' ? lintPlans[name] : null;
    if (lp) { logChunks.push(`\n## ${name}.lint 범위 mode=${lp.mode} files=${lp.files} — ${lp.reason}\n`); lintOut[name] = lintScope(lp); }
    let cmds = rp ? (rp.cmd ? [rp.cmd] : []) : lp ? lp.cmds : step === 'extra' ? (s.extra ?? []) : (s[step] ? [s[step]] : []);
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
      logChunks.push(`\n## ${name}.${step} $ ${cmd}\n## exit=${r.status} ${r.seconds}s${r.timedOut ? ' TIMEOUT' : ''}${r.error ? ' error=' + r.error : ''}\n${r.log}\n`);
      lastExit = r.status;
      if (r.timedOut) timedOut.push(`${name}.${step}`);
      if (r.status !== 0) { verdict = 'FAIL'; console.error(`[gate] ${name}.${step} FAIL (exit ${r.status}${r.timedOut ? ', timeout' : ''})`); break; }
    }
    if (reuse) {
      harvest[name] = collectEntries(dt, dir, { reportPath, exit: lastExit, since });
      if (!rp || rp.mode === 'full') harvestWhole.add(name);
    }
    if (step === 'test' && verdict === 'FAIL' && dt) {
      // 이번 실행의 리포트만 — gradle 은 exit≠0 이면 실행 뒤에 쓰인 XML 만 읽는다(collectEntries). 리포트가 없으면(컴파일 실패·시간 초과) 비워 둔다.
      // vitest 는 위에서 DoD 판정 때문에 리포터를 붙인 실행(reuse)만 읽는다 — 이름을 읽자고 명령에 인자를 덧붙이지 않는다
      const f = failedTests(() => reuse ? harvest[name] : dt.adapter === 'gradle-junit' ? collectEntries(dt, dir, { exit: lastExit, since }) : null);
      if (f) failedOut[name] = f;
    }
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

// DoD ② 구조화 테스트 항목 — 스택별 1회(스택의 테스트 전부를 돈 test 단계 리포트에 걸린 항목은 그걸로 판정하고, 나머지는 배치로 돈다)
if (!probeFailed) for (const [name, items] of byStack) {
  const s = cfg.stacks[name];
  const dt = s.dod_tests;
  const dir = resolve(root, s.dir);
  const judged = (d, j, via) => recordDod(d, j.verdict, `\n## dod ${d.id} [${name} ${via}] select=${JSON.stringify(d.tests.select)} → ${j.verdict} · 통과 ${j.passed} · 실패 ${j.failed} · 걸린 ${dt.adapter === 'vitest' ? '파일' : '스위트'} ${j.matched}${j.reasons.length ? ' (' + j.reasons.join('; ') + ')' : ''}\n`);
  let pending = items;
  if (harvestWhole.has(name)) {
    pending = [];
    for (const d of items) { const j = judgeTests(dt, d, harvest[name]); if (j.matched) judged(d, j, '전량 test 리포트'); else pending.push(d); }
  }
  if (!pending.length) continue;
  const reportPath = dt.adapter === 'vitest' ? join(logDir, `${parsed.slug}-${name}-dod.vitest.json`) : null;
  if (reportPath) rmSync(reportPath, { force: true });
  const cmd = batchCommand(dt, pending.flatMap(d => d.tests.select), reportPath);
  console.error(`[gate] dod ${name} 배치 ${pending.map(d => d.id).join(',')}: ${cmd}`);
  // 이 스택의 test 단계가 같은 리포트 폴더에 방금 썼을 수 있다(관련 테스트로 고른 것만 돈 경우 — 그 항목들이 전부 이 배치로 온다).
  // 배치가 리포트를 쓰지 못하고 죽으면 그 실행이 남긴 통과가 이번 판정으로 읽히지 않게, 실행 전 상태를 찍어 두고 달라진 XML 만 센다
  const before = snapshotReports(dt, dir);
  const since = Date.now();
  const r = runCmd(shell, cmd, { cwd: dir, env: { ...process.env, ...loadEnvFile(configRoot, s.env_file), JIRA_HARNESS_GATE: level }, timeoutS: cfg.gate.timeout_s });
  if (r.timedOut) timedOut.push(`dod-batch ${name}`);
  logChunks.push(`\n## dod-batch ${name} $ ${cmd}\n## exit=${r.status} ${r.seconds}s${r.timedOut ? ' TIMEOUT' : ''}${r.error ? ' error=' + r.error : ''}\n${r.log}\n`);
  const got = collectEntries(dt, dir, { reportPath, exit: r.status, since, before });
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
// 실패했을 때 로그를 열기 전에 볼 것 — 실패한 스위트·파일 이름과 시간 상한에 걸린 단계
const whyFailed = { ...(Object.keys(failedOut).length ? { failed_tests: failedOut } : {}), ...(timedOut.length ? { timed_out: timedOut } : {}) };
const lintNote = Object.keys(lintOut).length ? { lint_scope: lintOut } : {};
latest.gate = {
  level, tree, results, stacks: stacksOut, dod: dodSummary, ...(level === 'related' ? { related: relatedOut } : {}), ...lintNote, ...whyFailed,
  log: logRel, log_sha256: sha256(Buffer.from(logText, 'utf8')), duration_s, ...(queueWaitS != null ? { queue_wait_s: queueWaitS } : {}), at,
  full_at: level === 'full' ? at : (prev && prev.tree === tree ? prev.full_at ?? null : null),
};
latest.history = [...(latest.history ?? []), { stage: 'gate', at, note: `${level} ${overall} ${duration_s}s${queueWaitS >= 1 ? ` wait ${queueWaitS}s` : ''}` }];
writeState(sPath, latest);
try { pinRef(`refs/harness/${parsed.slug}/gate`, tree, root); } catch (e) { console.error(`[gate] ref 고정 실패(무시): ${e.message}`); }
// Herdr 사이드바·알림(Herdr 밖이면 무동작). FAIL 은 사람을 부르고(request), 전량 PASS 는 끝났다고 알린다(done).
herdrPing(cwd, `gate ${level} ${overall}`, overall === 'FAIL'
  ? { title: `${latest.keys.join(',')} gate ${level} FAIL`, body: Object.entries(results).filter(([, v]) => v === 'FAIL').map(([k]) => k).join(', ') || 'FAIL', sound: 'request' }
  : pushLevel ? { title: `${latest.keys.join(',')} gate ${level} PASS`, body: `${duration_s}s · push 가능`, sound: 'done' } : null);

const summary = { level, overall, tree, results, stacks: stacksOut, ...(level === 'related' ? { related: relatedOut } : {}), ...lintNote, ...whyFailed, dod: dodSummary, ...(warnings.length ? { warnings } : {}), duration_s, ...(queueWaitS != null ? { queue_wait_s: queueWaitS } : {}), log: logRel, state: relative(configRoot, sPath).replace(/\\/g, '/') };
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`[gate] ${level} ${overall} · ${duration_s}s${queueWaitS >= 1 ? ` (대기 ${queueWaitS}s)` : ''} · tree ${tree.slice(0, 12)} · dod ${dodSummary}`);
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(8)} ${v}`);
  for (const [n, r] of Object.entries(relatedOut)) console.log(`  related  ${n}: ${r.mode} · 클래스/파일 ${r.selected} · 테스트 ${r.tests}건${r.failed ? ` · 실패 ${r.failed}` : ''} — ${r.reason}`);
  for (const [n, l] of Object.entries(lintOut)) console.log(`  lint 범위 ${n}: ${l.mode === 'changed' ? `${l.reason}만` : l.reason}${l.mode === 'full' ? '' : ' · 전체 lint 는 --full·--main 에서'}`);
  for (const [n, f] of Object.entries(failedOut)) console.log(`  실패     ${failedLine(n, f)}`);
  if (timedOut.length) console.log(`  시간초과 ${timedOut.join(', ')} — gate.timeout_s=${cfg.gate.timeout_s} 에 걸려 중단됐다(테스트 실패와 다르다)`);
  console.log(`  log      ${logRel}`);
  if (level === 'commit' && duration_s > cfg.gate.commit_budget_s) console.log(`  ⚠ 경량 게이트 목표 ${cfg.gate.commit_budget_s}s 초과`);
  if (level === 'related') console.log(`  전체 스위트·build·extra 는 ${cfg.default_branch} 에서 배치로: gate.mjs --main (여러 이슈를 머지한 뒤 1회)`);
  if (level === 'dod') console.log(`  테스트(관련·전체)·build·extra 는 돌지 않았다 — 여러 이슈를 머지한 뒤 ${cfg.default_branch} 에서 gate.mjs --main 1회 필수(배포·릴리즈 전)`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}
process.exit(overall === 'PASS' ? 0 : 1);

// ---------- --try: 구현 중 확인(상태·판정 기록 없음 — 로그 파일만 남긴다) ----------
// 게이트가 아니다 — 상태 JSON · DoD 판정 · ref · 알림을 쓰지 않는다. 구현하는 쪽이 자기 테스트를 게이트와 같은 명령·환경·판정으로 한 번에 돌려 보는 길이다.
// 줄을 서지 않는다(대기열 밖) — 다른 작업공간의 1시간짜리 배치 뒤에서 기다리면 구현 레인의 시간 상한에 걸린다.
function runTry() {
  const slug = opt('--slug') ?? parseBranch(branch, cfg)?.slug ?? null;
  const stackOpt = opt('--stack');
  const selects = optAll('--select').map(s => s.trim()).filter(Boolean);
  const idsOpt = opt('--ids') ? opt('--ids').split(',').map(s => s.trim()).filter(Boolean) : null;
  const laneOpt = opt('--lane');
  let items;
  if (stackOpt || selects.length) {
    if (!stackOpt || !selects.length) fail(2, '--stack <스택> 과 --select <패턴> 은 함께 쓴다(--select 는 여러 번 줄 수 있다)');
    if (idsOpt || laneOpt) fail(2, '--stack/--select 는 --ids·--lane 과 함께 쓰지 않는다');
    const s = cfg.stacks[stackOpt];
    if (!s) fail(2, `알 수 없는 스택 "${stackOpt}" (harness.json.stacks: ${Object.keys(cfg.stacks).join(', ')})`);
    if (!s.dod_tests) fail(2, `스택 "${stackOpt}" 에 dod_tests 설정이 없어 선택 실행을 못 한다 — 그 스택의 테스트 명령을 직접 돌릴 것`);
    items = [{ id: '(select)', tests: { stack: stackOpt, select: selects } }];
  } else {
    if (!slug) fail(2, `브랜치 "${branch ?? '(detached)'}" 가 이슈 브랜치가 아니다 — --slug <slug> 로 어느 이슈인지 알려 줄 것`);
    const sPath = statePath(cfg, configRoot, slug);
    let state; try { state = readState(sPath); } catch (e) { fail(2, `상태 JSON 을 읽지 못했다(${relative(configRoot, sPath)}): ${e.message}`); }
    if (!state) fail(2, `상태 JSON 이 없다(${relative(configRoot, sPath)})`);
    let pool = (state.dod ?? []).filter(d => d && !d.human);
    if (laneOpt) {
      const lane = (state.lanes ?? []).find(l => l?.name === laneOpt);
      if (!lane) fail(2, `레인 "${laneOpt}" 이 상태 JSON 에 없다(있는 것: ${(state.lanes ?? []).map(l => l.name).join(', ') || '없음'})`);
      const own = (Array.isArray(lane.dod) ? lane.dod : []).map(x => (typeof x === 'string' ? x : x?.id)).filter(Boolean);
      if (!own.length) fail(2, `레인 "${laneOpt}" 에 dod 가 없다(plan 이 그 레인의 DoD id 를 적지 않았다) — 자기가 쓴 테스트를 --stack <스택> --select <패턴> 으로 돌릴 것`);
      pool = pool.filter(d => own.includes(d.id));
    }
    if (idsOpt) {
      const unknown = idsOpt.filter(id => !pool.some(d => d.id === id));
      if (unknown.length) fail(2, `--ids 의 ${unknown.join(', ')} 가 ${laneOpt ? `레인 "${laneOpt}" 의 ` : ''}자동 DoD 항목에 없다(있는 것: ${pool.map(d => d.id).join(', ') || '없음'})`);
      pool = pool.filter(d => idsOpt.includes(d.id));
    }
    // 지목하지 않았으면 tests 항목만 돈다 — 프로브(위반 주입 등)는 push 전 게이트가 한 번 돈다. --ids 로 지목한 프로브는 돈다(프로브를 처음 만들 때의 확인)
    items = idsOpt ? pool.filter(d => d.probe || d.tests) : pool.filter(d => d.tests);
    if (!items.length) fail(2, `돌릴 DoD tests 항목이 없다${laneOpt ? `(레인 "${laneOpt}")` : ''} — 자기가 쓴 테스트를 --stack <스택> --select <패턴> 으로 돌릴 것`);
  }
  const batchItems = items.filter(d => d.tests && cfg.stacks[d.tests.stack]?.dod_tests);
  const byStack = new Map();
  for (const d of batchItems) byStack.set(d.tests.stack, [...(byStack.get(d.tests.stack) ?? []), d]);
  if (flag('--dry-run')) {
    const plan = {
      level: 'try', branch, slug, recorded: false,
      batches: Object.fromEntries([...byStack].map(([n, group]) => [n, { ids: group.map(d => d.id), cmd: batchCommand(cfg.stacks[n].dod_tests, group.flatMap(d => d.tests.select), `<runtime>/gate/<slug>-${n}-try-<pid>.vitest.json`) }])),
      probes: items.filter(x => !batchItems.includes(x)).map(d => ({ id: d.id, probe: d.probe ?? null, cwd: d.cwd ?? null })),
    };
    console.log(json ? JSON.stringify(plan, null, 2) : `[gate] dry-run try\n${JSON.stringify(plan, null, 2)}`);
    process.exit(0);
  }
  const shell = resolveShell(cfg);
  const t0 = Date.now();
  const logDir = join(configRoot, cfg.runtime_dir, 'gate');
  mkdirSync(logDir, { recursive: true });
  const chunks = [`# jira-harness gate try · ${branch ?? '(detached)'} · ${nowIso()} · ${root.replace(/\\/g, '/')}\n`];
  const out = []; // {id, verdict, stack?, passed?, failed?, reasons[]}
  const failedOut = {}, timedOut = [];
  for (const d of items.filter(x => !batchItems.includes(x))) {
    if (!d.probe) { out.push({ id: d.id, verdict: 'FAIL', reasons: [`tests.stack=${d.tests?.stack} 에 dod_tests 어댑터가 없고 probe 도 없다`] }); continue; }
    console.error(`[gate] try dod ${d.id}: ${d.probe}`);
    const { r, reasons, verdict } = runProbe(shell, d);
    if (r.timedOut) timedOut.push(`dod ${d.id}`);
    chunks.push(`\n## dod ${d.id} $ ${d.probe}\n## exit=${r.status} ${r.seconds}s${r.timedOut ? ' TIMEOUT' : ''} → ${verdict}${reasons.length ? ' (' + reasons.join('; ') + ')' : ''}\n${r.log}\n`);
    out.push({ id: d.id, verdict, reasons });
  }
  for (const [name, group] of byStack) {
    const s = cfg.stacks[name], dt = s.dod_tests, dir = resolve(root, s.dir);
    // 리포트 파일 이름에 pid 를 넣는다 — 같은 이슈의 레인들이 runtime 을 같이 써서, 이름이 같으면 동시에 도는 레인끼리 서로의 리포트를 덮는다
    const reportPath = dt.adapter === 'vitest' ? join(logDir, `${slug ?? 'select'}-${name}-try-${process.pid}.vitest.json`) : null;
    const cmd = batchCommand(dt, group.flatMap(d => d.tests.select), reportPath);
    console.error(`[gate] try ${name} 배치 ${group.map(d => d.id).join(',')}: ${cmd}`);
    const before = snapshotReports(dt, dir); // 잇달아 부른 --try 의 지난 XML 이 이번 판정으로 읽히지 않게(배치가 리포트를 못 쓰고 죽은 경우)
    const since = Date.now();
    const r = runCmd(shell, cmd, { cwd: dir, env: { ...process.env, ...loadEnvFile(configRoot, s.env_file), JIRA_HARNESS_GATE: 'try' }, timeoutS: cfg.gate.timeout_s });
    if (r.timedOut) timedOut.push(`dod-batch ${name}`);
    chunks.push(`\n## dod-batch ${name} $ ${cmd}\n## exit=${r.status} ${r.seconds}s${r.timedOut ? ' TIMEOUT' : ''}${r.error ? ' error=' + r.error : ''}\n${r.log}\n`);
    const got = collectEntries(dt, dir, { reportPath, exit: r.status, since, before });
    if (reportPath) rmSync(reportPath, { force: true });
    for (const d of group) {
      const j = judgeTests(dt, d, got);
      if (r.status !== 0 && !j.matched) j.reasons.push(`배치 exit ${r.status}${r.timedOut ? '(timeout)' : ''} — 이번 실행 결과 없음(컴파일 실패면 log 를 볼 것)`);
      out.push({ id: d.id, stack: name, verdict: j.verdict, passed: j.passed, failed: j.failed, reasons: j.reasons });
    }
    const f = failedTests(() => got);
    if (f) failedOut[name] = f;
  }
  const overall = out.every(o => o.verdict === 'PASS') ? 'PASS' : 'FAIL';
  const duration_s = +((Date.now() - t0) / 1000).toFixed(1);
  const logPath = join(logDir, `${slug ?? 'select'}-try-${nowIso().replace(/[:.]/g, '-')}-${process.pid}.log`);
  writeFileSync(logPath, chunks.join(''), 'utf8');
  const log = relative(configRoot, logPath).replace(/\\/g, '/');
  // 실패한 것만 다시 도는 명령을 그대로 낸다 — 손으로 조립하지 않게
  const self = `node "${fileURLToPath(import.meta.url).replace(/\\/g, '/')}" --try`;
  const where = opt('--cwd') ? ` --cwd "${root.replace(/\\/g, '/')}"` : '';
  const rerun = Object.entries(failedOut).map(([n, f]) => `${self} --stack ${n} ${f.names.map(x => `--select '${x}'`).join(' ')}${where}`);
  // 「다시」는 실패한 스위트·파일만 돈다(빠르다) — 항목의 분모·통과 건수 하한은 다시 재지 않고, 하한만 모자란 항목은 실패한 스위트가 없어 그 줄이 아예 없다.
  // 그래서 통과하지 못한 항목을 **항목째** 다시 재는 명령을 따로 낸다(상태와 무관한 선택 실행에는 항목이 없다)
  const failedIds = out.filter(o => o.verdict !== 'PASS' && o.id !== '(select)').map(o => o.id);
  // id·slug 는 임의 문자열이다 — 공백 등이 들어 있으면 따옴표로 감싸야 그대로 붙여 넣어도 같은 항목을 가리킨다(D1 꼴이면 그대로 둔다)
  const arg = v => (/^[\w.,:-]+$/.test(v) ? v : `'${String(v).replace(/'/g, `'\\''`)}'`);
  const rerunItems = failedIds.length ? `${self}${opt('--slug') ? ` --slug ${arg(opt('--slug'))}` : ''} --ids ${arg(failedIds.join(','))}${where}` : null;
  const summary = { level: 'try', overall, recorded: false, items: out, ...(Object.keys(failedOut).length ? { failed_tests: failedOut, rerun } : {}), ...(rerunItems ? { rerun_items: rerunItems } : {}), ...(timedOut.length ? { timed_out: timedOut } : {}), duration_s, log };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[gate] try ${overall} · ${duration_s}s · 항목 ${out.filter(o => o.verdict === 'PASS').length}/${out.length} — 상태·판정을 기록하지 않는다(로그만 남긴다 · push 전 게이트가 아니다)`);
    for (const o of out) console.log(`  ${o.verdict.padEnd(4)} ${o.id}${o.stack ? ` [${o.stack}] 통과 ${o.passed} · 실패 ${o.failed}` : ''}${o.reasons.length ? ` — ${o.reasons.join('; ')}` : ''}`);
    for (const [n, f] of Object.entries(failedOut)) console.log(`  실패     ${failedLine(n, f)}`);
    for (const c of rerun) console.log(`  다시     ${c}`);
    if (rerunItems) console.log(`  항목판정 ${rerunItems}   ← 고친 뒤 통과하지 못한 항목을 항목째 다시 잰다(「다시」는 실패한 테스트만 돌아 통과 건수 하한을 재지 않는다)`);
    if (timedOut.length) console.log(`  시간초과 ${timedOut.join(', ')} — gate.timeout_s=${cfg.gate.timeout_s} 에 걸려 중단됐다(테스트 실패와 다르다)`);
    console.log(`  log      ${log}`);
  }
  process.exit(overall === 'PASS' ? 0 : 1);
}

// ---------- --main: 기본 브랜치 배치 전량 ----------
// 이슈 게이트(--related·--dod)가 뒤로 미룬 build·전체 테스트·extra 를 머지된 main 에서 한 번에 돈다. 상태 JSON 이 아니라 main-gate.json 에 남긴다 —
// 이슈 브랜치는 이미 아카이브됐고, 실패하면 "직전 PASS 이후 들어온 커밋" 이 용의자 목록이다.
async function runMainGate() {
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
  await viaQueue(); // 줄을 선다 — 차례가 오면 새 프로세스가 처음부터 돈다(기다리는 동안 들어온 커밋까지 head·용의 커밋에 잡힌다)
  const t0 = Date.now();
  const logDir = join(configRoot, cfg.runtime_dir, 'gate');
  mkdirSync(logDir, { recursive: true });
  const chunks = [`# jira-harness gate main · ${branch} · ${nowIso()} · head ${head}\n`];
  if (queueWaitS >= 1) chunks.push(`# queue wait ${queueWaitS}s\n`);
  const results = Object.fromEntries(msteps.map(s => [s, 'NOT_RUN']));
  const per = Object.fromEntries(msteps.map(s => [s, []]));
  const stacks = {};
  const failedOut = {}, timedOut = []; // 실패한 스위트·파일 이름 · 시간 상한에 걸린 단계 — 용의 커밋을 좁힐 때 로그보다 먼저 본다
  for (const name of names) {
    const s = cfg.stacks[name];
    const dir = resolve(root, s.dir);
    const env = { ...process.env, ...loadEnvFile(configRoot, s.env_file), JIRA_HARNESS_GATE: 'main' };
    stacks[name] = {};
    for (const step of msteps) {
      const cmds = step === 'extra' ? (s.extra ?? []) : (s[step] ? [s[step]] : []);
      if (!cmds.length) { stacks[name][step] = 'SKIPPED'; per[step].push('SKIPPED'); continue; }
      // 실패한 테스트 이름은 명령을 바꾸지 않고 읽을 수 있는 리포트에서만 읽는다 — gradle 의 XML. vitest 는 리포터 인자를 붙여야 해서 여기서는 읽지 않는다(로그 꼬리를 본다)
      const dt = step === 'test' && s.dod_tests?.adapter === 'gradle-junit' ? s.dod_tests : null;
      const since = Date.now();
      let v = 'PASS', lastExit = 0;
      for (const cmd of cmds) {
        console.error(`[gate] main ${name}.${step}: ${cmd}`);
        const r = runCmd(shell, cmd, { cwd: dir, env, timeoutS: cfg.gate.timeout_s });
        chunks.push(`\n## ${name}.${step} $ ${cmd}\n## exit=${r.status} ${r.seconds}s${r.timedOut ? ' TIMEOUT' : ''}\n${r.log}\n`);
        lastExit = r.status;
        if (r.timedOut) timedOut.push(`${name}.${step}`);
        if (r.status !== 0) { v = 'FAIL'; console.error(`[gate] main ${name}.${step} FAIL (exit ${r.status}${r.timedOut ? ', timeout' : ''})`); break; }
      }
      if (dt && v === 'FAIL') { const f = failedTests(() => collectEntries(dt, dir, { exit: lastExit, since })); if (f) failedOut[name] = f; }
      stacks[name][step] = v; per[step].push(v);
    }
  }
  const whyFailed = { ...(Object.keys(failedOut).length ? { failed_tests: failedOut } : {}), ...(timedOut.length ? { timed_out: timedOut } : {}) };
  for (const step of msteps) results[step] = per[step].includes('FAIL') ? 'FAIL' : per[step].includes('PASS') ? 'PASS' : 'SKIPPED';
  const overall = msteps.every(k => results[k] === 'PASS' || results[k] === 'SKIPPED') ? 'PASS' : 'FAIL';
  const at = nowIso();
  const duration_s = +((Date.now() - t0) / 1000).toFixed(1);
  const logPath = join(logDir, `main-${at.replace(/[:.]/g, '-')}.log`);
  writeFileSync(logPath, chunks.join(''), 'utf8');
  const log = relative(configRoot, logPath).replace(/\\/g, '/');
  const waited = queueWaitS != null ? { queue_wait_s: queueWaitS } : {};
  const entry = { head, at, overall, results, stacks, ...whyFailed, duration_s, ...waited, log, since: since ?? null, commits: pending ?? null };
  rec.last = entry;
  if (overall === 'PASS') rec.last_pass = { head, at };
  rec.history = [...(rec.history ?? []), { head, at, overall, duration_s, ...waited, commits: pending ? pending.length : null }].slice(-30);
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  herdrPing(cwd, `gate main ${overall}`, { title: `${cfg.default_branch} gate main ${overall}`, body: overall === 'FAIL' ? Object.entries(results).filter(([, v]) => v === 'FAIL').map(([k]) => k).join(', ') : `${duration_s}s · 커밋 ${pending ? pending.length : '?'}개 검증`, sound: overall === 'FAIL' ? 'request' : 'done' });
  const out = { level: 'main', overall, head, results, stacks, ...whyFailed, duration_s, ...waited, log, since: since ?? null, pending_commits: pending ? pending.length : null, suspects: overall === 'FAIL' ? (pending ?? []).slice(0, 30) : undefined };
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`[gate] main ${overall} · ${duration_s}s${queueWaitS >= 1 ? ` (대기 ${queueWaitS}s)` : ''} · head ${head.slice(0, 8)} · 직전 PASS 이후 커밋 ${pending ? pending.length : '?'}개`);
    for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(8)} ${v}`);
    for (const [n, f] of Object.entries(failedOut)) console.log(`  실패     ${failedLine(n, f)}`);
    if (timedOut.length) console.log(`  시간초과 ${timedOut.join(', ')} — gate.timeout_s=${cfg.gate.timeout_s} 에 걸려 중단됐다(테스트 실패와 다르다)`);
    console.log(`  log      ${log}`);
    if (overall === 'FAIL' && pending?.length) console.log(`  용의 커밋(직전 PASS 이후, first-parent):\n    ${pending.slice(0, 30).join('\n    ')}`);
  }
  process.exit(overall === 'PASS' ? 0 : 1);
}
