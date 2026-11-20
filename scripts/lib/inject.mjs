// inject.mjs — setup inject 의 위반 주입 케이스. 게이트가 「심겨 있다」가 아니라 「실제로 막는다」를 임시 clone 에서 실측한다(존재 ≠ 실효).
// Claude 판 setup.mjs 와 Codex 판(codex-overlay/scripts/setup.mjs)이 같이 쓴다 — 케이스를 두 파일에 베껴 두면 한쪽만 고쳐진다.
// 케이스 이름·기대값의 설명은 skills/setup/references/injection.md.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, parseBranch, branchSlug, statePath, newState, writeState, readState, matchesAny } from './config.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

function run(file, args, { cwd, input } = {}) {
  const r = spawnSync(file, args, { cwd, input, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, out: (r.stdout ?? '').replace(/\r\n/g, '\n'), err: (r.stderr ?? '').replace(/\r\n/g, '\n') };
}

/** branch_pattern 에 맞는 프로브용 이슈 브랜치 이름. 만들 수 없으면 null */
export function probeBranch(cfg) {
  const cands = [String(cfg.branch_template ?? DEFAULTS.branch_template).replace('{keys}', `${cfg.issue_prefix}-1`), `feat/${cfg.issue_prefix}-1`];
  for (const b of cands) if (parseBranch(b, cfg)) return b;
  return null;
}

/** 코드 변경으로 인정되는(=docs_only 가 아닌) 프로브 파일 경로를 고른다. */
export function probeFile(cfg) {
  const stack = Object.values(cfg.stacks ?? {})[0];
  const cands = [stack && stack.dir && stack.dir !== '.' ? `${String(stack.dir).replace(/\/$/, '')}/.jira-harness-probe` : null, '.jira-harness-probe', 'src/.jira-harness-probe'].filter(Boolean);
  for (const p of cands) if (!matchesAny(p, cfg.docs_only_paths)) return p;
  return null;
}

/** 훅(commit-gate.mjs)에 셸 툴 이벤트를 그대로 넣어 판정을 받는다 — 실제 훅이 받는 것과 같은 입력이다. */
export function runHook(dir, op = 'commit', toolName = 'Bash') {
  const command = op === 'push' ? 'git push -u origin HEAD' : 'git commit -m probe';
  const event = JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd: dir });
  const r = run(NODE, [join(SCRIPTS, 'commit-gate.mjs')], { cwd: dir, input: event });
  const out = r.out.trim();
  let decision = 'pass', reason = r.err.trim();
  if (out) {
    try {
      const j = JSON.parse(out);
      if (j.hookSpecificOutput?.permissionDecision === 'deny') { decision = 'deny'; reason = j.hookSpecificOutput.permissionDecisionReason; }
      else if (j.systemMessage) { decision = 'warn'; reason = j.systemMessage; }
    } catch { reason = out.slice(0, 200); }
  }
  const m = new RegExp(`git ${op}: ([A-Z_]+) —`).exec(reason);
  return { decision, code: m ? m[1] : 'UNKNOWN', reason };
}

/**
 * clone(dir) 안에서 케이스를 돌린다. clone 은 호출자가 만들고 지운다(원본 저장소는 건드리지 않는다).
 * @returns {{case:string, expected:string, got:string, ok:boolean, decision?:string, detail?:string}[]}
 */
export function injectCases(cfg, dir) {
  const cases = [];
  const record = (name, expected, got, extra = {}) => cases.push({ case: name, expected, got, ok: got === expected, ...extra });
  const git = (...args) => run('git', args, { cwd: dir });
  const probe = probeFile(cfg);
  const branch = probeBranch(cfg);
  if (!probe) record('branch-pattern', 'BRANCH_PATTERN', 'INCONCLUSIVE', { detail: 'docs_only_paths 밖의 프로브 파일 경로를 만들 수 없다' });
  if (!branch) record('commit-without-gate', 'NO_GATE', 'INCONCLUSIVE', { detail: 'branch_pattern 에 맞는 이슈 브랜치 이름을 만들 수 없다' });
  if (!probe || !branch) return cases;

  const write = text => { mkdirSync(dirname(join(dir, probe)), { recursive: true }); writeFileSync(join(dir, probe), text, 'utf8'); };

  // (a) 패턴 밖 브랜치에서 코드 커밋 → BRANCH_PATTERN deny
  git('checkout', '-q', '-b', 'jira-harness-probe-outside');
  write('probe a\n');
  git('add', '-A');
  const a = runHook(dir);
  record('branch-pattern', 'BRANCH_PATTERN', a.code, { decision: a.decision });

  // (b) 이슈 브랜치 + 상태 JSON + 게이트 기록 없음 → NO_GATE deny
  git('checkout', '-q', '-b', branch);
  const sPath = statePath(cfg, dir, branchSlug(branch));
  writeState(sPath, newState(branch, [`${cfg.issue_prefix}-1`]));
  const b = runHook(dir);
  record('commit-without-gate', 'NO_GATE', b.code, { decision: b.decision });

  // (b') 같은 상태에서 PowerShell 툴로 커밋 → 같은 NO_GATE deny. 한 셸만 보는 훅은 다른 셸로 그냥 뚫린다(존재 ≠ 실효)
  const bp = runHook(dir, 'commit', 'PowerShell');
  record('powershell-commit-without-gate', 'NO_GATE', bp.code, { decision: bp.decision });

  // (c) gate.mjs --commit 실행 후 → 통과(OK). 프로젝트 게이트 명령이 실제로 실패하면 GATE_FAIL 이 나온다.
  const g = run(NODE, [join(SCRIPTS, 'gate.mjs'), '--commit', '--json', '--cwd', dir], { cwd: dir });
  let gateNote = null;
  if (g.status !== 0) gateNote = (g.err.trim().split('\n').filter(l => /FAIL|오류|실패/.test(l)).pop() ?? `gate exit ${g.status}`).slice(0, 200);
  const st = readState(sPath);
  if (st?.gate?.tree) {
    st.review = { tree: st.gate.tree, files: [], codex: 'skipped', lanes: 0, findings: 0, blockers_open: 0, round: 1, delta_passes: 0, at: new Date().toISOString() };
    writeState(sPath, st);
  }
  const c = runHook(dir);
  record('commit-after-gate', 'OK', c.code, { decision: c.decision, detail: gateNote });

  // (d) 경량 게이트만 통과한 상태의 push → GATE_LEVEL deny. push 판정은 **커밋된** 변경을 보므로 clone 안에서 실제로 커밋한다.
  if (c.code === 'OK') {
    const commit = git('commit', '-q', '-m', 'jira-harness probe');
    if (commit.status !== 0) record('push-without-full-gate', 'GATE_LEVEL', 'INCONCLUSIVE', { detail: `clone 안 커밋 실패: ${commit.err.trim().slice(0, 160)}` });
    else {
      const d = runHook(dir, 'push');
      record('push-without-full-gate', 'GATE_LEVEL', d.code, { decision: d.decision });
    }
  } else record('push-without-full-gate', 'GATE_LEVEL', 'INCONCLUSIVE', { detail: '커밋 게이트가 통과하지 못해 push 축을 볼 수 없다' });
  return cases;
}
