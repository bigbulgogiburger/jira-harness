// S2 통합 테스트 — 실제 임시 git 저장소에서 훅(commit-gate.mjs)과 러너(gate.mjs)를 실행한다.
import './fixtures/no-queue.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, readdirSync, utimesSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newState, writeState, readState } from '../lib/config.mjs';
import { detectGitOp, detectGitOps, effectiveCwd, SHELL_TOOLS } from '../lib/gate-core.mjs';
import { parseTestCount } from '../lib/probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;

function sh(cmd, args, cwd, input) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', input, windowsHide: true }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }

function makeRepo({ mode = 'auto', harness = true, defaultBranchPolicy = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-gate-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'core.autocrlf', 'false');
  for (const d of ['docs', 'backend', 'frontend', '.claude']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'docs/README.md'), '# docs\n');
  writeFileSync(join(dir, 'backend/App.java'), 'class App {}\n');
  writeFileSync(join(dir, 'frontend/app.js'), 'export default 1\n');
  writeFileSync(join(dir, '.gitignore'), '.claude/harness.env.local\n');
  if (harness) {
    const cfg = JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8'));
    cfg.mode = mode;
    if (defaultBranchPolicy) cfg.default_branch_policy = defaultBranchPolicy;
    writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg, null, 2) + '\n');
  }
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function hook(dir, command, cwd = dir, toolName = 'Bash') {
  const r = sh(NODE, [join(SCRIPTS, 'commit-gate.mjs')], cwd, JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd }));
  assert.equal(r.status, 0, `훅 프로세스는 항상 exit 0: ${r.stderr}`);
  const out = r.stdout.trim();
  if (!out) return { decision: 'pass', reason: r.stderr.trim() };
  const j = JSON.parse(out);
  if (j.hookSpecificOutput?.permissionDecision === 'deny') return { decision: 'deny', reason: j.hookSpecificOutput.permissionDecisionReason };
  if (j.systemMessage) return { decision: 'warn', reason: j.systemMessage };
  return { decision: 'pass', reason: JSON.stringify(j) };
}
function gate(dir, ...args) { return sh(NODE, [join(SCRIPTS, 'gate.mjs'), ...args, '--cwd', dir], dir); }
const stateFile = (dir, slug = 'feat-ABC-1') => join(dir, '.claude/runtime/issues', `${slug}.json`);
function startIssue(dir, branch = 'feat/ABC-1', keys = ['ABC-1']) { writeState(stateFile(dir, branch.replace('/', '-')), newState(branch, keys)); }
function edit(dir, rel, text) { writeFileSync(join(dir, rel), text); }
function addReview(dir, slug = 'feat-ABC-1', patch = {}) {
  const st = readState(stateFile(dir, slug));
  st.review = { tree: st.gate.tree, files: [], codex: 'skipped', lanes: 1, findings: 0, blockers_open: 0, round: 1, delta_passes: 0, at: new Date().toISOString(), ...patch };
  writeState(stateFile(dir, slug), st);
}

test('감지: git commit/push 만, -C·cd 접두, 비-git 명령 무시', () => {
  assert.equal(detectGitOp('git commit -m "x"'), 'commit');
  assert.equal(detectGitOp('cd backend && git push origin HEAD'), 'push');
  assert.equal(detectGitOp('git -C sub commit -q'), 'commit');
  assert.equal(detectGitOp('git status && git log'), null);
  assert.equal(detectGitOp('echo "git commit"'), null);
  assert.equal(detectGitOp('ls -la'), null);
  assert.ok(effectiveCwd('cd backend && git commit -m x', '/r').replace(/\\/g, '/').endsWith('/r/backend'));
  assert.ok(effectiveCwd('git -C frontend commit -m x', '/r').replace(/\\/g, '/').endsWith('/r/frontend'));
  // -C 는 git 의 것만 — grep -C 2 를 디렉토리로 읽으면 없는 경로가 되어 NO_HARNESS 통과(fail-open)였다
  assert.ok(effectiveCwd('grep -C 2 foo x.js; git commit -m x', '/r').replace(/\\/g, '/').endsWith('/r'));
  // cd 가 줄바꿈 뒤(heredoc 다음 줄)에 오거나 줄바꿈으로 끝나도 첫머리다 — 놓치면 세션 cwd 의 다른 저장소를 판정한다
  assert.ok(effectiveCwd('cat > f <<EOF\nx\nEOF\ncd sub && git commit -m x', '/r').replace(/\\/g, '/').endsWith('/r/sub'));
  assert.ok(effectiveCwd('cd sub\ngit commit -m x', '/r').replace(/\\/g, '/').endsWith('/r/sub'));
  // 절대 경로는 cwd 뒤에 이어 붙이지 않는다(join 이 그랬다) · Git Bash 의 /d/… 는 Windows 에서 D:/…
  const abs = process.platform === 'win32' ? 'D:/other' : '/other';
  assert.equal(effectiveCwd('cd ' + abs + ' && git commit -m x', '/r').replace(/\\/g, '/'), abs);
  if (process.platform === 'win32') assert.equal(effectiveCwd('cd /d/other && git commit -m x', '/r').replace(/\\/g, '/'), 'D:/other');
  assert.equal(parseTestCount('BUILD SUCCESSFUL\n12 tests completed'), 12);
  assert.equal(parseTestCount('Tests  7 passed (7)'), 7);
  assert.equal(parseTestCount('tests=3'), 3);
  assert.equal(parseTestCount('BUILD SUCCESSFUL'), null);
});

test('감지(복합): 명령 안의 모든 git op 를 등장 순서로 · push 앞에 commit 이 있으면 afterCommit · 같은 (op, afterCommit) 는 한 번', () => {
  const C = { op: 'commit', afterCommit: false };
  assert.deepEqual(detectGitOps('git commit -m x'), [C]);
  assert.deepEqual(detectGitOps('git commit -m x && git push'), [C, { op: 'push', afterCommit: true }]);
  assert.deepEqual(detectGitOps('git add -A; git commit -m x; git push origin HEAD'), [C, { op: 'push', afterCommit: true }]);
  assert.deepEqual(detectGitOps('git push && git commit -m x'), [{ op: 'push', afterCommit: false }, C], 'push 가 먼저면 커밋 전 HEAD 를 올리는 것이라 afterCommit 이 아니다');
  assert.deepEqual(detectGitOps('git push; git commit -m x; git push'), [{ op: 'push', afterCommit: false }, C, { op: 'push', afterCommit: true }]);
  assert.deepEqual(detectGitOps('git commit -m x; git push; git push --tags'), [C, { op: 'push', afterCommit: true }], '같은 push 는 한 번만');
  assert.deepEqual(detectGitOps('& git commit -m x; & git.exe push'), [C, { op: 'push', afterCommit: true }], 'PowerShell 호출 연산자·git.exe');
  assert.deepEqual(detectGitOps('git commit -m x; if ($?) { git push }'), [C, { op: 'push', afterCommit: true }], 'PowerShell 스크립트블록 안의 push');
  assert.deepEqual(detectGitOps('git commit -m x; if ($LASTEXITCODE -eq 0) {git push origin HEAD}'), [C, { op: 'push', afterCommit: true }], '중괄호 바로 뒤도 같다');
  assert.deepEqual(detectGitOps("echo '{git commit}'; git push"), [C, { op: 'push', afterCommit: false }], '따옴표 안의 가짜 commit 은 판정 대상엔 들어가되 뒤의 push 를 afterCommit 으로 만들지 않는다');
  assert.deepEqual(detectGitOps('git commit -m "fix: x" && git push'), [C, { op: 'push', afterCommit: true }], '메시지 뒤의 진짜 push 는 그대로 afterCommit');
  assert.deepEqual(detectGitOps('git status && git log'), []);
  assert.deepEqual(detectGitOps('echo "git commit"; echo "git push"'), [], '따옴표가 바로 앞에 붙은 문구는 명령이 아니다');
  assert.deepEqual(detectGitOps(''), []);
  assert.equal(detectGitOp('git commit -m x && git push'), 'commit', 'detectGitOp 은 첫 op 그대로');
  assert.equal(effectiveCwd('git.exe -C frontend commit -m x', '/r').replace(/\\/g, '/').endsWith('/r/frontend'), true, 'git.exe -C 도 실행 디렉토리로 읽는다');
});

test('commit && push 복합 명령 — push 도 전량 게이트로 판정한다(커밋 뒤 인덱스 트리 기준) · docs-only 는 그대로 통과', () => {
  const dir = makeRepo();
  // docs-only 복합은 어느 브랜치든 통과 — closure 문서 커밋+push 흐름이 막히면 안 된다
  edit(dir, 'docs/README.md', '# docs v2\n'); g(dir, 'add', '-A');
  const docs = hook(dir, 'git commit -m docs && git push');
  assert.equal(docs.decision, 'pass', docs.reason); assert.ok(docs.reason.includes('DOCS_ONLY'), docs.reason);
  g(dir, 'commit', '-q', '-m', 'docs');

  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  const compound = 'git commit -m x && git push -u origin feat/ABC-1';
  const noGate = hook(dir, compound);
  assert.equal(noGate.decision, 'deny'); assert.ok(noGate.reason.includes('git commit') && noGate.reason.includes('NO_GATE'), '둘 다 막히면 앞선 commit 의 사유가 나온다: ' + noGate.reason);

  assert.equal(gate(dir, '--commit').status, 0);
  addReview(dir);
  assert.equal(hook(dir, 'git commit -m x').decision, 'pass', 'commit 단독은 경량 게이트로 통과');
  // 같은 명령의 push 는 경량 기록으로 못 나간다 — 종전엔 첫 op(commit)만 봐서 통과했다
  const light = hook(dir, compound);
  assert.equal(light.decision, 'deny'); assert.ok(light.reason.includes('git push') && light.reason.includes('GATE_LEVEL'), light.reason);
  const ps = hook(dir, 'git commit -m x; git push', dir, 'PowerShell');
  assert.equal(ps.decision, 'deny'); assert.ok(ps.reason.includes('git push') && ps.reason.includes('GATE_LEVEL'), 'PowerShell `;` 복합도 같다: ' + ps.reason);

  // 전량 게이트(스테이징된 트리)와 리뷰가 있으면 통과 — 판정 기준이 아직 HEAD 가 아니라 커밋 뒤 인덱스 트리여야 GATE_STALE 이 안 난다
  assert.equal(gate(dir, '--full').status, 0);
  addReview(dir);
  const full = hook(dir, compound);
  assert.equal(full.decision, 'pass', full.reason);

  // 전량 게이트 뒤 코드가 또 바뀌면 복합 명령의 push 도 GATE_STALE
  edit(dir, 'frontend/app.js', 'export default 9\n'); g(dir, 'add', '-A');
  const stale = hook(dir, compound);
  assert.equal(stale.decision, 'deny'); assert.ok(stale.reason.includes('GATE_STALE'), stale.reason);
});

test('따옴표 안의 가짜 commit 이 뒤의 진짜 push 를 느슨하게 만들지 않는다 — 인덱스 기준은 진짜 commit 뒤에서만', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  assert.equal(gate(dir, '--commit').status, 0);
  addReview(dir);
  g(dir, 'commit', '-q', '-m', 'c1'); // HEAD = 경량 게이트만 통과한 C1
  edit(dir, 'frontend/app.js', 'export default 2\n'); g(dir, 'add', '-A'); // 인덱스 = C1 + Y
  assert.equal(gate(dir, '--full').status, 0);
  addReview(dir); // 전량 게이트·리뷰는 "인덱스 = C1 + Y" 트리에 있다

  const alone = hook(dir, 'git push');
  assert.equal(alone.decision, 'deny'); assert.ok(alone.reason.includes('GATE_STALE'), 'HEAD(C1)에는 Y 가 없으니 push 는 막힌다: ' + alone.reason);
  const fake = hook(dir, "echo '{git commit}'; git push");
  assert.equal(fake.decision, 'deny'); assert.ok(fake.reason.includes('git push') && fake.reason.includes('GATE_STALE'), '따옴표 안의 commit 문구로 push 가 인덱스 기준이 되면 안 된다: ' + fake.reason);
  const real = hook(dir, 'git commit -m y && git push');
  assert.equal(real.decision, 'pass', '진짜 commit 뒤의 push 는 인덱스 기준 — 전량 게이트가 그 트리에 있다: ' + real.reason);
});

test('셸 툴 둘 다 판정 — PowerShell 로 git commit 해도 같은 게이트 · & git / git.exe 도 감지 · 비-셸 툴은 판정 안 함', () => {
  const dir = makeRepo();
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  const ps = hook(dir, 'git commit -m code', dir, 'PowerShell');
  assert.equal(ps.decision, 'deny', 'PowerShell 툴의 커밋도 막혀야 한다(한 셸만 보면 다른 셸로 뚫린다)');
  assert.ok(ps.reason.includes('BRANCH_PATTERN'), ps.reason);
  assert.equal(hook(dir, '& git commit -m code', dir, 'PowerShell').decision, 'deny');
  assert.equal(hook(dir, 'git.exe commit -m code', dir, 'PowerShell').decision, 'deny');
  assert.equal(detectGitOp('Set-Location backend; git commit -m x'), 'commit');
  const other = hook(dir, 'git commit -m code', dir, 'Edit');
  assert.equal(other.decision, 'pass');
  assert.ok(!other.reason.includes('[jira-harness]'), '비-셸 툴엔 판정 없음');
});

test('hooks.json matcher 는 gate-core 의 SHELL_TOOLS 와 같은 집합이다 — 한쪽에만 있는 셸 툴은 게이트가 아예 안 돈다', () => {
  const hooks = JSON.parse(readFileSync(join(HERE, '../../hooks/hooks.json'), 'utf8'));
  const entry = hooks.hooks.PreToolUse.find(h => h.hooks.some(x => x.command.includes('commit-gate.mjs')));
  assert.ok(entry, 'commit-gate 를 부르는 PreToolUse 항목이 있어야 한다');
  assert.deepEqual([...entry.matcher.split('|')].sort(), [...SHELL_TOOLS].sort());
});

test('harness.json 없는 저장소 · mode=off 는 통과, 비-git 명령은 판정 자체를 안 한다', () => {
  const plain = makeRepo({ harness: false });
  edit(plain, 'backend/App.java', 'class App { int x; }\n'); g(plain, 'add', '-A');
  assert.equal(hook(plain, 'git commit -m x').decision, 'pass');
  const off = makeRepo({ mode: 'off' });
  edit(off, 'backend/App.java', 'class App { int x; }\n'); g(off, 'add', '-A');
  assert.equal(hook(off, 'git commit -m x').decision, 'pass');
  const r = hook(off, 'ls -la');
  assert.equal(r.decision, 'pass');
  assert.ok(!r.reason.includes('[jira-harness]'), '비-git 명령엔 태그 출력 없음');
});

test('docs-only 커밋은 main 에서도 통과 · 코드 커밋은 브랜치 패턴 밖이면 deny(adopt) · suggest 는 warn', () => {
  const dir = makeRepo();
  edit(dir, 'docs/README.md', '# docs v2\n'); g(dir, 'add', '-A');
  const d = hook(dir, 'git commit -m docs');
  assert.equal(d.decision, 'pass'); assert.ok(d.reason.includes('DOCS_ONLY'), d.reason);
  g(dir, 'commit', '-q', '-m', 'docs');
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  const c = hook(dir, 'git commit -m code');
  assert.equal(c.decision, 'deny'); assert.ok(c.reason.includes('BRANCH_PATTERN'), c.reason);
  const sug = makeRepo({ mode: 'suggest' });
  edit(sug, 'backend/App.java', 'class App { int x; }\n'); g(sug, 'add', '-A');
  const w = hook(sug, 'git commit -m code');
  assert.equal(w.decision, 'warn'); assert.ok(w.reason.includes('BRANCH_PATTERN'), w.reason);
});

test('커밋 사다리: 상태 없음 → 더러운 트리 → 게이트 없음 → 리뷰 없음 → 통과 → 코드 변경 시 GATE_STALE', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  assert.ok(hook(dir, 'git commit -m x').reason.includes('NO_STATE'));
  startIssue(dir);
  edit(dir, 'frontend/app.js', 'export default 2\n'); // unstaged
  const dirty = hook(dir, 'git commit -m x');
  assert.equal(dirty.decision, 'deny'); assert.ok(dirty.reason.includes('DIRTY_TREE'), dirty.reason);
  g(dir, 'add', '-A');
  writeFileSync(join(dir, 'backend/New.java'), 'class New {}\n'); // untracked
  assert.ok(hook(dir, 'git commit -m x').reason.includes('DIRTY_TREE'));
  g(dir, 'add', '-A');
  assert.ok(hook(dir, 'git commit -m x').reason.includes('NO_GATE'));

  const r = gate(dir, '--commit', '--json');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const st = readState(stateFile(dir));
  assert.equal(st.gate.level, 'commit');
  assert.equal(st.gate.results.compile, 'PASS');
  assert.equal(st.gate.results.lint, 'SKIPPED', 'be.lint=null 이고 fe 는 compile 만 → lint 는 SKIPPED');
  assert.equal(st.gate.results.build, 'NOT_RUN');
  assert.match(st.gate.tree, /^[0-9a-f]{40}$/);
  assert.ok(st.gate.log_sha256);
  assert.equal(g(dir, 'rev-parse', 'refs/harness/feat-ABC-1/gate'), st.gate.tree, 'refs/harness 고정');

  assert.ok(hook(dir, 'git commit -m x').reason.includes('NO_REVIEW'));
  addReview(dir);
  const ok = hook(dir, 'git commit -m x');
  assert.equal(ok.decision, 'pass', ok.reason); assert.ok(ok.reason.includes('OK'), ok.reason);
  const sub = hook(dir, 'git commit -m x', join(dir, 'backend'));
  assert.equal(sub.decision, 'pass', '하위 디렉토리 cwd 에서도 같은 판정');

  edit(dir, 'backend/App.java', 'class App { int x, y; }\n'); g(dir, 'add', '-A');
  const stale = hook(dir, 'git commit -m x');
  assert.equal(stale.decision, 'deny'); assert.ok(stale.reason.includes('GATE_STALE'), stale.reason);
  addReview(dir, 'feat-ABC-1', { blockers_open: 2 });
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A'); // 게이트가 본 내용으로 복구 → 이제 blocker 가 막는다
  const bl = hook(dir, 'git commit -m x');
  assert.ok(bl.reason.includes('REVIEW_BLOCKERS'), bl.reason);
});

test('push 사다리: 경량 기록 → GATE_LEVEL · 전량 후 통과 · docs 후속 커밋은 델타로 통과 · 코드 후속 커밋은 GATE_STALE · 로그 변조는 GATE_LOG_MISMATCH', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  assert.equal(gate(dir, '--commit').status, 0);
  addReview(dir);
  g(dir, 'commit', '-q', '-m', 'code');
  const lvl = hook(dir, 'git push -u origin feat/ABC-1');
  assert.equal(lvl.decision, 'deny'); assert.ok(lvl.reason.includes('GATE_LEVEL'), lvl.reason);

  const full = gate(dir, '--full', '--json');
  assert.equal(full.status, 0, full.stderr + full.stdout);
  const st = readState(stateFile(dir));
  assert.deepEqual(Object.values(st.gate.results).filter(v => v === 'PASS').length >= 4, true, JSON.stringify(st.gate.results));
  assert.equal(st.gate.level, 'full'); assert.ok(st.gate.full_at);
  addReview(dir);
  const ok = hook(dir, 'git push');
  assert.equal(ok.decision, 'pass', ok.reason);

  const again = gate(dir, '--commit');
  assert.equal(again.status, 0); assert.ok(again.stdout.includes('생략'), '같은 트리 전량 통과 → 경량 재실행 생략');

  edit(dir, 'docs/README.md', '# docs v3\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'docs');
  const delta = hook(dir, 'git push');
  assert.equal(delta.decision, 'pass', delta.reason);

  edit(dir, 'frontend/app.js', 'export default 3\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'code2');
  const stale = hook(dir, 'git push');
  assert.equal(stale.decision, 'deny'); assert.ok(stale.reason.includes('GATE_STALE'), stale.reason);

  assert.equal(gate(dir, '--full').status, 0);
  addReview(dir);
  assert.equal(hook(dir, 'git push').decision, 'pass');
  appendFileSync(join(dir, readState(stateFile(dir)).gate.log), '\ntampered\n');
  const tam = hook(dir, 'git push');
  assert.equal(tam.decision, 'deny'); assert.ok(tam.reason.includes('GATE_LOG_MISMATCH'), tam.reason);
});

test('DoD 프로브: 경량 게이트는 DoD 를 돌리지 않는다 · 전량에서 분모(min_tests) 없으면 FAIL → push GATE_FAIL, 건수를 찍으면 PASS · 위반 주입(명령 실패)도 FAIL', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  const st = readState(stateFile(dir));
  st.dod = [
    { id: 'D1', text: '불변식', probe: 'echo BUILD SUCCESSFUL', cwd: 'backend', expect: { pattern: 'BUILD SUCCESSFUL', min_tests: 1 }, last: 'PENDING' },
    { id: 'D2', text: '사람 확인', probe: null, human: true, last: 'PENDING' },
  ];
  writeState(stateFile(dir), st);
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  // 경량 게이트: 분모 없는 프로브가 있어도 compile·lint 만 보고 통과 — DoD 판정은 남기지 않는다
  const c = gate(dir, '--commit', '--json');
  assert.equal(c.status, 0, c.stderr + c.stdout);
  let s = readState(stateFile(dir));
  assert.equal(s.gate.results.dod, 'NOT_RUN'); assert.equal(s.dod[0].last, 'PENDING'); assert.equal(s.gate.dod, 'push 전 게이트에서');
  addReview(dir);
  assert.equal(hook(dir, 'git commit -m x').decision, 'pass');
  g(dir, 'commit', '-q', '-m', 'code');

  const r1 = gate(dir, '--full', '--json');
  assert.equal(r1.status, 1, '분모 미확인 → FAIL');
  s = readState(stateFile(dir));
  assert.equal(s.gate.results.dod, 'FAIL'); assert.equal(s.dod[0].last, 'FAIL'); assert.equal(s.gate.dod, '0/1 (human 1 제외)');
  addReview(dir);
  const h = hook(dir, 'git push');
  assert.equal(h.decision, 'deny'); assert.ok(h.reason.includes('GATE_FAIL') && h.reason.includes('dod=FAIL'), h.reason);

  s.dod[0].probe = 'echo BUILD SUCCESSFUL && echo "3 tests completed"';
  writeState(stateFile(dir), s);
  assert.equal(gate(dir, '--full').status, 0);
  s = readState(stateFile(dir));
  assert.equal(s.gate.results.dod, 'PASS'); assert.equal(s.gate.dod, '1/1 (human 1 제외)');
  addReview(dir);
  assert.equal(hook(dir, 'git push').decision, 'pass');

  s.dod[0].probe = 'echo BUILD SUCCESSFUL && echo "3 tests completed" && exit 7';
  writeState(stateFile(dir), s);
  assert.equal(gate(dir, '--full').status, 1, '프로브 실패 주입 → FAIL');
  assert.equal(readState(stateFile(dir)).dod[0].last, 'FAIL');
});

test('DoD 프로브: 러너 색상 코드(ANSI)가 낀 요약 줄도 건수·pattern 을 읽는다 · sentinel 프로브는 min_tests 없이 pattern 만으로 판정', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  const st = readState(stateFile(dir));
  // vitest 실출력 형태: "Tests \x1b[1m\x1b[32m3 passed\x1b[39m\x1b[22m | 28 skipped (31)"
  const vitestLine = 'Tests \\033[1m\\033[32m3 passed\\033[39m\\033[22m\\033[2m | \\033[22m\\033[33m28 skipped\\033[39m\\033[90m (31)\\033[39m';
  st.dod = [
    { id: 'D1', text: '색상 낀 vitest 요약', probe: `printf '${vitestLine}\\n'`, cwd: 'backend', expect: { pattern: 'Tests +[0-9]+ passed', min_tests: 3 }, last: 'PENDING' },
    { id: 'D2', text: 'sentinel(위반 주입)', probe: 'echo INJECTION_FIRED', cwd: 'backend', expect: { pattern: 'INJECTION_FIRED' }, last: 'PENDING' },
  ];
  writeState(stateFile(dir), st);
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  assert.equal(gate(dir, '--full').status, 0, 'ANSI 를 벗겨 3건을 읽고, sentinel 은 pattern 만으로 PASS');
  let s = readState(stateFile(dir));
  assert.equal(s.gate.results.dod, 'PASS'); assert.equal(s.gate.dod, '2/2');

  // 위반 주입 ① 색상 낀 요약이 하한 미달(3 < 5) → FAIL
  s.dod[0].expect.min_tests = 5;
  writeState(stateFile(dir), s);
  assert.equal(gate(dir, '--full').status, 1, '실행 건수 3 < 5');
  s = readState(stateFile(dir));
  assert.equal(s.dod[0].last, 'FAIL'); assert.equal(s.dod[1].last, 'PASS');

  // 위반 주입 ② sentinel 프로브가 성공 문구를 못 찍으면 exit 0 이어도 FAIL
  s.dod[0].expect.min_tests = 3;
  s.dod[1].probe = 'echo nothing-fired';
  writeState(stateFile(dir), s);
  assert.equal(gate(dir, '--full').status, 1, 'sentinel pattern 없음 → FAIL');
  assert.equal(readState(stateFile(dir)).dod[1].last, 'FAIL');
});

// DoD tests 항목 — 가짜 러너(fixtures/fake-runner.mjs)를 dod_tests.run 으로 건다. 러너 설정은 스택 dir 의 .fake-runner.json, 호출 기록은 .fake-runner.log
const FAKE_RUNNER = `node '${join(HERE, 'fixtures/fake-runner.mjs').replace(/\\/g, '/')}'`;
function dodTestsRepo({ full = false, suites, files }) {
  const dir = makeRepo();
  const cfgPath = join(dir, '.claude/harness.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.stacks.be.dod_tests = { adapter: 'gradle-junit', run: `${FAKE_RUNNER} gradle` };
  cfg.stacks.fe.dod_tests = { adapter: 'vitest', run: `${FAKE_RUNNER} vitest` };
  if (full) { cfg.stacks.be.test = cfg.stacks.be.dod_tests.run; cfg.stacks.fe.test = cfg.stacks.fe.dod_tests.run; }
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  writeFileSync(join(dir, 'backend/.fake-runner.json'), JSON.stringify({ suites }));
  writeFileSync(join(dir, 'frontend/.fake-runner.json'), JSON.stringify({ files }));
  appendFileSync(join(dir, '.gitignore'), '.fake-runner.log\nbuild/\n.claude/runtime/\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'dod_tests');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  return dir;
}
const runnerCalls = (dir, stack) => readFileSync(join(dir, stack, '.fake-runner.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
function setDod(dir, dod) { const st = readState(stateFile(dir)); st.dod = dod; writeState(stateFile(dir), st); }
function setRunner(dir, stack, patch) { const f = join(dir, stack, '.fake-runner.json'); writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch })); }

test('DoD tests: 게이트는 스택마다 러너를 한 번만 띄우고(선택 합집합) 리포트로 항목마다 판정한다 — 분모 0·실패·하한 미달은 그 항목만 FAIL · 컴파일 실패면 지난 XML 을 믿지 않는다 · 클래스 이름은 파일명(<testsuite name> 은 @DisplayName 일 수 있다)', () => {
  const dir = dodTestsRepo({
    suites: [{ name: 'com.x.FeeTest', tests: 3, display: '수수료 계산 — 기본료' }, { name: 'com.x.OrderTest', tests: 2 }, { name: 'com.x.OrderTest$Nested', tests: 1, display: '취소된 주문' }, { name: 'com.x.OtherTest', tests: 9 }],
    files: [{ name: 'src/a/x.spec.js', passed: 2 }, { name: 'src/a/y.spec.js', passed: 2 }, { name: 'src/b/z.spec.js', passed: 5 }],
  });
  const dod = [
    { id: 'D1', text: '수수료', tests: { stack: 'be', select: ['*FeeTest*'] }, expect: { min_tests: 3 }, last: 'PENDING' },
    { id: 'D2', text: '주문(중첩 클래스 포함)', tests: { stack: 'be', select: ['*OrderTest*'] }, expect: { min_tests: 3 }, last: 'PENDING' },
    { id: 'D3', text: '화면 a', tests: { stack: 'fe', select: ['src/a'] }, expect: { min_tests: 4 }, last: 'PENDING' },
    { id: 'D4', text: 'sentinel 은 종전대로', probe: 'echo INJECTION_FIRED', cwd: 'backend', expect: { pattern: 'INJECTION_FIRED' }, last: 'PENDING' },
  ];
  setDod(dir, dod);
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  const r = gate(dir, '--full');
  assert.equal(r.status, 0, r.stderr);
  let s = readState(stateFile(dir));
  assert.deepEqual(s.dod.map(d => d.last), ['PASS', 'PASS', 'PASS', 'PASS']);
  assert.equal(s.gate.dod, '4/4');
  assert.deepEqual(runnerCalls(dir, 'backend'), [['gradle', '--tests', '*FeeTest*', '--tests', '*OrderTest*']], 'be 러너는 한 번 — 선택 합집합');
  const fe = runnerCalls(dir, 'frontend');
  assert.equal(fe.length, 1, 'fe 러너도 한 번');
  assert.ok(fe[0].includes('src/a') && fe[0].some(a => a.startsWith('--outputFile.json=')), JSON.stringify(fe[0]));

  // 위반 주입 ① 어디에도 안 걸리는 선택 → 그 항목만 FAIL(분모 0) · 러너는 여전히 스택당 한 번
  setDod(dir, [...dod, { id: 'D5', text: '없는 클래스', tests: { stack: 'be', select: ['*MissingTest*'] }, last: 'PENDING' }]);
  assert.equal(gate(dir, '--full').status, 1);
  s = readState(stateFile(dir));
  assert.deepEqual(s.dod.map(d => d.last), ['PASS', 'PASS', 'PASS', 'PASS', 'FAIL']);
  assert.equal(runnerCalls(dir, 'backend').length, 2);
  assert.match(readFileSync(join(dir, s.gate.log), 'utf8'), /dod D5 \[be 배치\].*분모 0/);

  // 위반 주입 ② 한 스위트 실패 → 그 항목만 FAIL(배치 exit 1 이어도 다른 항목은 이번 실행 결과로 PASS)
  setDod(dir, dod);
  setRunner(dir, 'backend', { suites: [{ name: 'com.x.FeeTest', tests: 3, failures: 1, display: '수수료 계산 — 기본료' }, { name: 'com.x.OrderTest', tests: 2 }, { name: 'com.x.OrderTest$Nested', tests: 1 }] });
  assert.equal(gate(dir, '--full').status, 1);
  s = readState(stateFile(dir));
  assert.deepEqual(s.dod.map(d => d.last), ['FAIL', 'PASS', 'PASS', 'PASS']);
  assert.match(readFileSync(join(dir, s.gate.log), 'utf8'), /dod D1 \[be 배치\].*실패 1건: com\.x\.FeeTest/);

  // 위반 주입 ③ 통과 건수가 하한 미달 → FAIL
  setRunner(dir, 'backend', { suites: [{ name: 'com.x.FeeTest', tests: 3 }, { name: 'com.x.OrderTest', tests: 2 }, { name: 'com.x.OrderTest$Nested', tests: 1 }] });
  setDod(dir, dod.map(d => (d.id === 'D3' ? { ...d, expect: { min_tests: 5 } } : d)));
  assert.equal(gate(dir, '--full').status, 1);
  s = readState(stateFile(dir));
  assert.deepEqual(s.dod.map(d => d.last), ['PASS', 'PASS', 'FAIL', 'PASS']);
  assert.match(readFileSync(join(dir, s.gate.log), 'utf8'), /dod D3 \[fe 배치\].*통과 4건 < 5/);

  // 위반 주입 ④ 컴파일 실패(러너가 아무것도 안 쓰고 exit 1) — 지난 실행의 XML 이 통과로 남아 있어도 믿지 않는다
  setDod(dir, dod);
  const xmlDir = join(dir, 'backend/build/test-results/test');
  const old = new Date(Date.now() - 3600_000);
  for (const f of readdirSync(xmlDir)) utimesSync(join(xmlDir, f), old, old);
  setRunner(dir, 'backend', { compile_error: true });
  assert.equal(gate(dir, '--full').status, 1);
  s = readState(stateFile(dir));
  assert.deepEqual(s.dod.map(d => d.last), ['FAIL', 'FAIL', 'PASS', 'PASS'], '지난 XML(통과)을 이번 결과로 읽지 않는다');
  assert.match(readFileSync(join(dir, s.gate.log), 'utf8'), /dod D1 \[be 배치\].*배치 exit 1 — 이번 실행 결과 없음/);
});

test('DoD tests 전량: 스택 test 명령이 dod_tests.run 과 같으면 그 리포트로 판정하고 다시 돌리지 않는다 · 리포트에 안 걸린 항목(기본 test 밖)만 배치 · vitest 는 test 단계에 JSON 리포터가 붙는다', () => {
  const dir = dodTestsRepo({
    full: true,
    suites: [{ name: 'com.x.FeeTest', tests: 3, display: '수수료 계산 — 기본료' }, { name: 'com.x.SlowIT', tests: 2, default: false }],
    files: [{ name: 'src/a/x.spec.js', passed: 2 }, { name: 'src/b/z.spec.js', passed: 5 }],
  });
  setDod(dir, [
    { id: 'D1', text: '수수료', tests: { stack: 'be', select: ['*FeeTest*'] }, expect: { min_tests: 3 }, last: 'PENDING' },
    { id: 'D2', text: '기본 test 밖(IT)', tests: { stack: 'be', select: ['*SlowIT*'] }, expect: { min_tests: 2 }, last: 'PENDING' },
    { id: 'D3', text: '화면 a', tests: { stack: 'fe', select: ['src/a'] }, expect: { min_tests: 2 }, last: 'PENDING' },
  ]);
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  const r = gate(dir, '--full');
  assert.equal(r.status, 0, r.stderr);
  const s = readState(stateFile(dir));
  assert.deepEqual(s.dod.map(d => d.last), ['PASS', 'PASS', 'PASS']);
  assert.equal(s.gate.results.test, 'PASS');
  assert.deepEqual(runnerCalls(dir, 'backend'), [['gradle'], ['gradle', '--tests', '*SlowIT*']], 'test 단계 1번 + 리포트에 안 걸린 D2 만 배치');
  const fe = runnerCalls(dir, 'frontend');
  assert.equal(fe.length, 1, 'fe 는 test 단계 한 번뿐 — DoD 배치 없음');
  assert.ok(fe[0].some(a => a.startsWith('--outputFile.json=')), 'test 단계에 JSON 리포터가 붙는다');
  const log = readFileSync(join(dir, s.gate.log), 'utf8');
  assert.match(log, /dod D1 \[be 전량 test 리포트\] .* → PASS/);
  assert.match(log, /dod D2 \[be 배치\] .* → PASS/);
  assert.match(log, /dod D3 \[fe 전량 test 리포트\] .* → PASS/);
});

test('관련 테스트 게이트: 고른 테스트만 돈 리포트로 DoD 항목을 판정하지 않는다(항목의 선택 중 돌지 않은 테스트가 실패해도 PASS 가 되던 길) — 항목은 배치로 돈다 · 스택 전체를 돈 리포트는 그대로 읽고 다시 돌리지 않는다', () => {
  const dir = dodTestsRepo({
    full: true,
    suites: [{ name: 'com.x.FooTest', tests: 2 }, { name: 'com.x.BarTest', tests: 2, failures: 1 }],
    files: [{ name: 'src/a/x.spec.js', passed: 2 }],
  });
  const d1 = { id: 'D1', text: 'Foo 와 Bar 둘 다', tests: { stack: 'be', select: ['*FooTest*', '*BarTest*'] }, last: 'PENDING' };
  setDod(dir, [d1]);
  // 이 브랜치는 FooTest 만 고쳤다 → 관련 테스트로 고르는 것은 FooTest 하나다. BarTest(실패 중)는 관련 테스트 단계에서 돌지 않는다
  mkdirSync(join(dir, 'backend/src/test/java/com/x'), { recursive: true });
  edit(dir, 'backend/src/test/java/com/x/FooTest.java', 'class FooTest {}\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'foo');
  let r = gate(dir, '--related', '--json');
  assert.equal(r.status, 1, `BarTest 가 실패 중이면 D1 은 FAIL 이어야 한다(FooTest 의 통과 2건만 보고 PASS 로 넘기면 안 된다): ${r.stdout}`);
  let s = readState(stateFile(dir));
  assert.equal(s.gate.results.test, 'PASS', '관련 테스트 단계(FooTest)는 통과했다');
  assert.equal(s.gate.results.dod, 'FAIL');
  assert.deepEqual([s.gate.related.be.mode, s.gate.related.be.selected, s.gate.related.be.tests], ['selected', 1, 2], '「관련 테스트 N건」은 종전대로 그 리포트에서 센다');
  assert.deepEqual(runnerCalls(dir, 'backend'), [['gradle', '--tests', 'com.x.FooTest'], ['gradle', '--tests', '*FooTest*', '--tests', '*BarTest*']], '관련 테스트 1번 + DoD 배치 1번(항목의 선택 전부)');
  assert.match(readFileSync(join(dir, s.gate.log), 'utf8'), /dod D1 \[be 배치\].*실패 1건: com\.x\.BarTest/);

  // 고친 뒤 — 통과 건수도 항목의 선택 전부(4건)에서 센다. 관련 테스트의 2건으로 세면 하한 4 에 모자라 거짓 FAIL 이다
  setRunner(dir, 'backend', { suites: [{ name: 'com.x.FooTest', tests: 2 }, { name: 'com.x.BarTest', tests: 2 }] });
  setDod(dir, [{ ...d1, expect: { min_tests: 4 } }]);
  r = gate(dir, '--related', '--json');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  s = readState(stateFile(dir));
  assert.equal(s.dod[0].last, 'PASS');
  assert.match(readFileSync(join(dir, s.gate.log), 'utf8'), /dod D1 \[be 배치\].*통과 4 /);

  // 전역 파일이 바뀌면 관련 테스트가 그 스택 전체로 넘어간다 — 그 리포트는 전부를 돈 것이라 DoD 판정에 그대로 쓰고 배치를 또 띄우지 않는다
  edit(dir, 'backend/build.gradle', '// deps\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'gradle');
  const before = runnerCalls(dir, 'backend').length;
  r = gate(dir, '--related', '--json');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  s = readState(stateFile(dir));
  assert.equal(s.gate.related.be.mode, 'full');
  assert.deepEqual(runnerCalls(dir, 'backend').slice(before), [['gradle']], '스택 전체 1번뿐 — DoD 배치 없음');
  assert.match(readFileSync(join(dir, s.gate.log), 'utf8'), /dod D1 \[be 전량 test 리포트\] .* → PASS/);
});

test('관련 테스트 뒤의 DoD 배치가 리포트를 쓰지 못하고 죽으면 항목은 FAIL 이다 — 관련 테스트 단계가 같은 폴더에 방금 쓴 XML(통과)을 이번 판정으로 읽지 않는다', () => {
  const dir = dodTestsRepo({
    full: true,
    suites: [{ name: 'com.x.FooTest', tests: 2 }, { name: 'com.x.BarTest', tests: 2 }],
    files: [{ name: 'src/a/x.spec.js', passed: 2 }],
  });
  // *BarTest* 가 선택에 든 호출(DoD 배치)만 리포트를 쓰기 전에 죽는다. 관련 테스트 단계가 쓴 XML 의 mtime 은 배치 시작 시각보다 뒤로 찍힌다 —
  // 「시작 시각 이후에 쓰인 것」으로는 이번 실행의 리포트와 구분되지 않는 상태다(부하가 없으면 실제로도 1초 안에 이어 돈다)
  setRunner(dir, 'backend', { crash_on: '*BarTest*', mtime_skew_ms: 600_000 });
  setDod(dir, [{ id: 'D1', text: 'Foo 와 Bar 둘 다', tests: { stack: 'be', select: ['*FooTest*', '*BarTest*'] }, last: 'PENDING' }]);
  mkdirSync(join(dir, 'backend/src/test/java/com/x'), { recursive: true });
  edit(dir, 'backend/src/test/java/com/x/FooTest.java', 'class FooTest {}\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'foo');
  const r = gate(dir, '--related', '--json');
  assert.equal(r.status, 1, `배치가 죽었는데 통과로 끝났다(BarTest 는 한 번도 돌지 않았다): ${r.stdout}`);
  const s = readState(stateFile(dir));
  assert.equal(s.gate.results.test, 'PASS', '관련 테스트 단계(FooTest)는 통과했다');
  assert.equal(s.dod[0].last, 'FAIL');
  assert.deepEqual(runnerCalls(dir, 'backend'), [['gradle', '--tests', 'com.x.FooTest'], ['gradle', '--tests', '*FooTest*', '--tests', '*BarTest*']]);
  assert.match(readFileSync(join(dir, s.gate.log), 'utf8'), /dod D1 \[be 배치\].*배치 exit 1 — 이번 실행 결과 없음/);
});

test('--try 를 잇달아 부를 때 — 뒤 실행의 배치가 리포트를 쓰지 못하고 죽으면 앞 실행이 남긴 XML(통과)로 판정하지 않는다 · 「항목판정」 명령은 공백이 든 id 를 따옴표로 감싼다', () => {
  const dir = dodTestsRepo({
    suites: [{ name: 'com.x.FeeTest', tests: 3 }, { name: 'com.x.OrderTest', tests: 2 }],
    files: [{ name: 'src/a/x.spec.js', passed: 2 }],
  });
  setRunner(dir, 'backend', { crash_on: '*OrderTest*', mtime_skew_ms: 600_000 });
  setDod(dir, [
    { id: 'D1', text: '수수료', tests: { stack: 'be', select: ['*FeeTest*'] }, expect: { min_tests: 3 }, last: 'PENDING' },
    { id: 'smoke web', text: '주문(공백이 든 id)', tests: { stack: 'be', select: ['*OrderTest*'] }, expect: { min_tests: 2 }, last: 'PENDING' },
  ]);
  const tryJson = (...a) => { const r = gate(dir, '--try', '--json', ...a); return { r, j: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null }; };
  // 앞 실행: D1 만 — 통과하고 FeeTest 의 XML 을 남긴다
  let { r, j } = tryJson('--ids', 'D1');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(j.items.map(o => [o.id, o.verdict]), [['D1', 'PASS']]);
  // 뒤 실행: 두 항목을 한 번에 — 러너가 리포트를 쓰기 전에 죽는다. 남아 있는 FeeTest XML 은 앞 실행의 것이다
  ({ r, j } = tryJson());
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(j.items.map(o => [o.id, o.verdict]), [['D1', 'FAIL'], ['smoke web', 'FAIL']], '앞 실행의 통과를 이번 판정으로 읽지 않는다');
  assert.match(j.items[0].reasons.join(' '), /이번 실행 결과 없음/);
  // 통과하지 못한 항목을 다시 재는 명령 — 그대로 붙여 넣어도 같은 항목을 가리키게 공백이 든 id 는 따옴표로 감싼다
  assert.match(j.rerun_items, /--try --ids 'D1,smoke web' --cwd "/);
  ({ r, j } = tryJson('--ids', 'smoke web'));
  assert.deepEqual(j?.items.map(o => o.id), ['smoke web'], `공백이 든 id 도 한 인자로 오면 그 항목을 고른다: ${r.stderr}`);
});

test('--try: 구현 중 확인 — DoD tests 를 스택마다 한 번에 돌려 항목별로 판정하되 상태·판정을 기록하지 않는다(로그만 남긴다) · 프로브는 --ids 로 지목했을 때만 · 실패하면 그것만 다시 도는 명령을 낸다 · 잘못된 지목은 exit 2', () => {
  const dir = dodTestsRepo({
    suites: [{ name: 'com.x.FeeTest', tests: 3 }, { name: 'com.x.OrderTest', tests: 2 }, { name: 'com.x.OtherTest', tests: 9 }],
    files: [{ name: 'src/a/x.spec.js', passed: 2 }, { name: 'src/b/z.spec.js', passed: 5 }],
  });
  setDod(dir, [
    { id: 'D1', text: '수수료', tests: { stack: 'be', select: ['*FeeTest*'] }, expect: { min_tests: 3 }, last: 'PENDING' },
    { id: 'D2', text: '주문', tests: { stack: 'be', select: ['*OrderTest*'] }, expect: { min_tests: 2 }, last: 'PENDING' },
    { id: 'D3', text: '화면 a', tests: { stack: 'fe', select: ['src/a'] }, expect: { min_tests: 2 }, last: 'PENDING' },
    { id: 'D4', text: 'sentinel', probe: 'echo INJECTION_FIRED > probe-ran.txt && echo INJECTION_FIRED', cwd: 'backend', expect: { pattern: 'INJECTION_FIRED' }, last: 'PENDING' },
    { id: 'D5', text: '사람 확인', human: true, last: 'PENDING' },
  ]);
  const before = readFileSync(stateFile(dir), 'utf8');
  const unchanged = why => assert.equal(readFileSync(stateFile(dir), 'utf8'), before, why);
  const tryJson = (...a) => { const r = gate(dir, '--try', '--json', ...a); return { r, j: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null }; };

  // ⓪ --dry-run — 무엇을 어떻게 묶어 돌릴지만 보여주고 러너를 띄우지 않는다
  const dry = tryJson('--dry-run');
  assert.equal(dry.r.status, 0, dry.r.stderr);
  assert.deepEqual(Object.fromEntries(Object.entries(dry.j.batches).map(([n, b]) => [n, b.ids])), { be: ['D1', 'D2'], fe: ['D3'] });
  assert.match(dry.j.batches.be.cmd, /gradle --tests '\*FeeTest\*' --tests '\*OrderTest\*'$/);
  assert.deepEqual(dry.j.probes, [], '지목하지 않은 프로브는 계획에도 없다');
  assert.ok(!existsSync(join(dir, 'backend/.fake-runner.log')), 'dry-run 은 러너를 띄우지 않는다');

  // ① 전부 — 스택마다 러너 한 번, 항목마다 판정, 프로브·사람 항목은 돌지 않는다
  let { r, j } = tryJson();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(j.level, 'try'); assert.equal(j.overall, 'PASS'); assert.equal(j.recorded, false);
  assert.deepEqual(j.items.map(o => [o.id, o.verdict, o.passed]), [['D1', 'PASS', 3], ['D2', 'PASS', 2], ['D3', 'PASS', 2]]);
  assert.deepEqual(runnerCalls(dir, 'backend'), [['gradle', '--tests', '*FeeTest*', '--tests', '*OrderTest*']], 'be 러너는 한 번 — 선택 합집합');
  assert.equal(runnerCalls(dir, 'frontend').length, 1, 'fe 러너도 한 번');
  assert.ok(!existsSync(join(dir, 'backend/probe-ran.txt')), '프로브는 지목하지 않으면 돌지 않는다');
  unchanged('상태 JSON 은 한 글자도 안 바뀐다(gate 기록 · DoD 판정 · history 없음)');
  assert.equal(readState(stateFile(dir)).gate, null);
  assert.equal(g(dir, 'for-each-ref', 'refs/harness'), '', '게이트 ref 를 박지 않는다');
  const gateDir = join(dir, '.claude/runtime/gate');
  assert.deepEqual(readdirSync(gateDir).filter(f => f.endsWith('.vitest.json')), [], '리포트 파일은 읽고 지운다');
  assert.ok(existsSync(join(dir, j.log)) && /-try-/.test(j.log), `로그는 남긴다: ${j.log}`);
  // 훅은 이 결과를 게이트로 보지 않는다
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  assert.ok(hook(dir, 'git commit -m x').reason.includes('NO_GATE'), '--try 가 초록이어도 커밋 게이트는 따로 돌아야 한다');

  // ② --ids — 그 항목만. 프로브도 지목하면 돈다
  ({ r, j } = tryJson('--ids', 'D4,D1'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(j.items.map(o => [o.id, o.verdict]), [['D4', 'PASS'], ['D1', 'PASS']]);
  assert.ok(existsSync(join(dir, 'backend/probe-ran.txt')), '지목한 프로브는 돈다');
  assert.deepEqual(runnerCalls(dir, 'backend').at(-1), ['gradle', '--tests', '*FeeTest*'], '지목한 항목의 선택만');
  assert.equal(runnerCalls(dir, 'frontend').length, 1, '지목하지 않은 스택은 띄우지 않는다');

  // ③ 실패 — 그 항목만 FAIL · 실패한 스위트 이름과 그것만 다시 도는 명령
  setRunner(dir, 'backend', { suites: [{ name: 'com.x.FeeTest', tests: 3, failures: 1 }, { name: 'com.x.OrderTest', tests: 2 }] });
  ({ r, j } = tryJson());
  assert.equal(r.status, 1);
  assert.deepEqual(j.items.map(o => [o.id, o.verdict]), [['D1', 'FAIL'], ['D2', 'PASS'], ['D3', 'PASS']]);
  assert.deepEqual(j.failed_tests.be.names, ['com.x.FeeTest']);
  assert.match(j.rerun[0], /gate\.mjs" --try --stack be --select 'com\.x\.FeeTest' --cwd "/);
  assert.match(j.rerun_items, /gate\.mjs" --try --ids D1 --cwd "/, '통과하지 못한 항목을 항목째 다시 재는 명령');
  const plain = gate(dir, '--try');
  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /try FAIL .* 항목 2\/3 — 상태·판정을 기록하지 않는다\(로그만 남긴다/);
  assert.match(plain.stdout, /FAIL D1 \[be\] 통과 2 · 실패 1 — 실패 1건: com\.x\.FeeTest/);
  assert.match(plain.stdout, /다시 {5}node ".*gate\.mjs" --try --stack be --select 'com\.x\.FeeTest'/);
  assert.match(plain.stdout, /항목판정 node ".*gate\.mjs" --try --ids D1 /);

  // ④ 실패한 것만 다시 — 상태와 무관한 선택 실행
  ({ r, j } = tryJson('--stack', 'be', '--select', 'com.x.FeeTest'));
  assert.equal(r.status, 1, '아직 고치지 않았다');
  assert.deepEqual(runnerCalls(dir, 'backend').at(-1), ['gradle', '--tests', 'com.x.FeeTest']);
  assert.equal(j.rerun_items, undefined, '상태와 무관한 선택 실행에는 다시 잴 항목이 없다');
  setRunner(dir, 'backend', { suites: [{ name: 'com.x.FeeTest', tests: 3 }, { name: 'com.x.OrderTest', tests: 2 }] });
  ({ r, j } = tryJson('--stack', 'be', '--select', 'com.x.FeeTest', '--select', '*OrderTest*'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(j.items.map(o => [o.verdict, o.passed]), [['PASS', 5]]);
  assert.equal(tryJson('--stack', 'be', '--select', '*MissingTest*').r.status, 1, '어디에도 안 걸리는 선택은 초록이 아니다(분모 0)');

  // ④-2 실패한 테스트는 없는데 통과 건수가 하한에 못 미친다 — 「다시」(실패한 스위트만)는 낼 것이 없지만 항목째 다시 재는 명령은 나온다.
  //      실패한 것만 다시 돌아 초록을 봐도 항목은 여전히 FAIL 일 수 있다 — 그 차이를 이 줄이 메운다
  const raw5 = readFileSync(stateFile(dir), 'utf8'); // 끝에서 글자 그대로 되돌린다(이 테스트는 상태 JSON 이 한 글자도 안 바뀌는지를 끝까지 본다)
  const st5 = JSON.parse(raw5);
  writeState(stateFile(dir), { ...st5, dod: st5.dod.map(d => (d.id === 'D2' ? { ...d, expect: { min_tests: 9 } } : d)) });
  ({ r, j } = tryJson());
  assert.equal(r.status, 1);
  assert.deepEqual(j.items.filter(o => o.verdict === 'FAIL').map(o => [o.id, o.reasons[0]]), [['D2', '통과 2건 < 9']]);
  assert.equal(j.rerun, undefined, '실패한 스위트가 없다');
  assert.match(j.rerun_items, /--try --ids D2 --cwd "/);
  writeFileSync(stateFile(dir), raw5);

  // ⑤ 잘못된 지목 — 돌리지 않고 exit 2
  const calls = runnerCalls(dir, 'backend').length;
  for (const [a, re] of [
    [['--ids', 'D9'], /D9 가 자동 DoD 항목에 없다/],
    [['--ids', 'D5'], /D5 가 자동 DoD 항목에 없다/],
    [['--lane', 'nope'], /레인 "nope" 이 상태 JSON 에 없다/],
    [['--stack', 'nope', '--select', 'x'], /알 수 없는 스택 "nope"/],
    [['--stack', 'be'], /--stack <스택> 과 --select <패턴> 은 함께 쓴다/],
    [['--stack', 'be', '--select', 'x', '--ids', 'D1'], /--ids·--lane 과 함께 쓰지 않는다/],
  ]) {
    const x = gate(dir, '--try', ...a);
    assert.equal(x.status, 2, `${a.join(' ')}: ${x.stderr}`);
    assert.match(x.stderr, re);
  }
  assert.equal(runnerCalls(dir, 'backend').length, calls, '잘못된 지목은 러너를 띄우지 않는다');
  unchanged('끝까지 상태 JSON 은 그대로다');
});

test('--try 레인: 구현 레인의 작업트리(lane/<slug>/<이름> 브랜치)에서 --slug 로 이슈를 찾고 --lane 의 DoD 만 **그 트리에서** 돈다 · 레인끼리 리포트 파일이 겹치지 않는다 · dod 가 없는 레인은 선택 실행으로 안내한다', () => {
  const dir = dodTestsRepo({
    suites: [{ name: 'com.x.FeeTest', tests: 3 }, { name: 'com.x.OrderTest', tests: 2 }],
    files: [{ name: 'src/a/x.spec.js', passed: 2 }, { name: 'src/b/z.spec.js', passed: 5 }],
  });
  const st = readState(stateFile(dir));
  st.dod = [
    { id: 'D1', text: '[ABC-1] 수수료', tests: { stack: 'be', select: ['*FeeTest*'] }, expect: { min_tests: 3 }, last: 'PENDING' },
    { id: 'D2', text: '[ABC-2] 주문', tests: { stack: 'be', select: ['*OrderTest*'] }, expect: { min_tests: 2 }, last: 'PENDING' },
    { id: 'D3', text: '[ABC-2] 화면 a', tests: { stack: 'fe', select: ['src/a'] }, expect: { min_tests: 2 }, last: 'PENDING' },
    { id: 'D4', text: '[ABC-2] 위반 주입', probe: 'echo INJECTION_FIRED > probe-ran.txt', cwd: 'backend', expect: { pattern: 'x' }, last: 'PENDING' },
  ];
  st.lanes = [
    { name: 'abc-1', key: 'ABC-1', model: 'opus', files: ['backend/fee/**'], worktree: true, dod: ['D1'] },
    { name: 'abc-2', key: 'ABC-2', model: 'opus', files: ['backend/order/**', 'frontend/**'], worktree: true, dod: ['D2', { id: 'D3' }, 'D4'] },
    { name: 'abc-3', model: 'sonnet', files: ['docs/**'], worktree: true },
  ];
  writeState(stateFile(dir), st);
  const before = readFileSync(stateFile(dir), 'utf8');
  const base = dir.split(/[\\/]/).pop();
  const wt1 = join(dirname(dir), `${base}-lane1`), wt2 = join(dirname(dir), `${base}-lane2`);
  g(dir, 'worktree', 'add', '-q', '-b', 'lane/feat-ABC-1/abc-1', wt1);
  g(dir, 'worktree', 'add', '-q', '-b', 'lane/feat-ABC-1/abc-2', wt2);

  // 이슈 브랜치가 아닌 트리 — --slug 없이는 어느 이슈인지 모른다
  const noSlug = gate(wt1, '--try', '--lane', 'abc-1');
  assert.equal(noSlug.status, 2); assert.match(noSlug.stderr, /이슈 브랜치가 아니다 — --slug <slug>/);

  const r1 = gate(wt1, '--try', '--slug', 'feat-ABC-1', '--lane', 'abc-1', '--json');
  assert.equal(r1.status, 0, r1.stderr);
  const j1 = JSON.parse(r1.stdout);
  assert.deepEqual(j1.items.map(o => [o.id, o.verdict]), [['D1', 'PASS']]);
  assert.deepEqual(runnerCalls(wt1, 'backend'), [['gradle', '--tests', '*FeeTest*']], '레인의 DoD 만');
  assert.ok(!existsSync(join(wt1, 'frontend/.fake-runner.log')), '그 레인에 fe 항목이 없으면 fe 러너를 띄우지 않는다');
  assert.ok(!existsSync(join(dir, 'backend/.fake-runner.log')), '테스트는 레인의 작업트리에서 돈다 — 메인 트리가 아니다');
  assert.ok(existsSync(join(dir, j1.log)), '로그는 메인 저장소 runtime 에 남는다');

  // 다른 레인 — 프로브(위반 주입)는 레인의 dod 에 있어도 지목하지 않으면 돌지 않는다(합친 뒤 게이트가 한 번 돈다)
  const r2 = gate(wt2, '--try', '--slug', 'feat-ABC-1', '--lane', 'abc-2', '--json');
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout).items.map(o => [o.id, o.verdict]), [['D2', 'PASS'], ['D3', 'PASS']]);
  assert.deepEqual(runnerCalls(wt2, 'backend'), [['gradle', '--tests', '*OrderTest*']]);
  const feCall = runnerCalls(wt2, 'frontend')[0];
  // 리포트 파일 이름에 **그 실행의** pid 가 들어간다 — 동시에 도는 레인(서로 다른 프로세스)끼리 같은 파일을 쓰지 않는다. 숫자이기만 한지 보면 고정 숫자여도 통과한다
  assert.ok(Number.isInteger(r2.pid) && r2.pid > 0);
  assert.ok(feCall.find(a => a.startsWith('--outputFile.json=')).endsWith(`feat-ABC-1-fe-try-${r2.pid}.vitest.json`), `리포트 경로에 이 실행의 pid(${r2.pid})가 없다: ${feCall.join(' ')}`);
  assert.ok(!existsSync(join(wt2, 'backend/probe-ran.txt')));
  // 레인의 작업트리에서 실패하면 — 항목째 다시 재는 명령이 --slug 를 그대로 싣는다(이슈 브랜치가 아닌 트리라 없으면 어느 이슈인지 모른다)
  setRunner(wt2, 'backend', { suites: [{ name: 'com.x.FeeTest', tests: 3 }, { name: 'com.x.OrderTest', tests: 2, failures: 1 }] });
  const r2f = gate(wt2, '--try', '--slug', 'feat-ABC-1', '--lane', 'abc-2', '--json');
  assert.equal(r2f.status, 1);
  assert.match(JSON.parse(r2f.stdout).rerun_items, /--try --slug feat-ABC-1 --ids D2 --cwd "/);
  setRunner(wt2, 'backend', { suites: [{ name: 'com.x.FeeTest', tests: 3 }, { name: 'com.x.OrderTest', tests: 2 }] });
  // 남의 레인 항목을 --ids 로 지목하면 거절
  const cross = gate(wt1, '--try', '--slug', 'feat-ABC-1', '--lane', 'abc-1', '--ids', 'D2');
  assert.equal(cross.status, 2); assert.match(cross.stderr, /D2 가 레인 "abc-1" 의 자동 DoD 항목에 없다/);

  // dod 가 없는 레인 — 선택 실행으로 안내하고, 선택 실행은 --slug 없이도 돈다
  const noDod = gate(wt1, '--try', '--slug', 'feat-ABC-1', '--lane', 'abc-3');
  assert.equal(noDod.status, 2); assert.match(noDod.stderr, /레인 "abc-3" 에 dod 가 없다.*--stack <스택> --select <패턴>/);
  const adhoc = gate(wt1, '--try', '--stack', 'fe', '--select', 'src/b', '--json');
  assert.equal(adhoc.status, 0, adhoc.stderr);
  assert.deepEqual(JSON.parse(adhoc.stdout).items.map(o => [o.verdict, o.passed]), [['PASS', 5]]);

  assert.equal(readFileSync(stateFile(dir), 'utf8'), before, '레인이 무엇을 돌려도 상태 JSON 은 그대로다');
});

test('기록: test 단계가 실패하면 실패한 스위트·파일 이름을 요약·상태에 싣는다 — gradle 은 늘, vitest 는 DoD 판정으로 리포터가 이미 붙은 실행만 · 지난 실행의 리포트는 읽지 않는다 · 통과하면 싣지 않는다 · --main 도 같다', () => {
  const failing = {
    suites: [{ name: 'com.x.FeeTest', tests: 3, failures: 1 }, { name: 'com.x.OrderTest', tests: 2 }, { name: 'com.x.PayTest', tests: 4, failures: 2 }],
    files: [{ name: 'src/a/x.spec.js', passed: 2, failed: 1 }, { name: 'src/b/z.spec.js', passed: 5 }],
  };
  const be = { suites: 2, tests: 3, names: ['com.x.PayTest', 'com.x.FeeTest'] }, fe = { suites: 1, tests: 1, names: ['src/a/x.spec.js'] };
  const dir = dodTestsRepo({ full: true, ...failing });
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  // DoD tests 항목이 없다 — vitest 명령은 설정 그대로 돈다. 이름을 읽자고 리포터 인자를 붙이지 않으므로 이름은 gradle 쪽만 실린다
  const r = gate(dir, '--full', '--json');
  assert.equal(r.status, 1, r.stderr);
  const sum = JSON.parse(r.stdout);
  assert.equal(sum.results.test, 'FAIL');
  assert.deepEqual(sum.failed_tests, { be }, '실패 건수가 많은 순 · 통과한 스위트는 없다 · vitest 는 리포트가 없으니 이름도 없다');
  assert.deepEqual(readState(stateFile(dir)).gate.failed_tests, { be }, '상태 기록에도 남는다');
  assert.equal('timed_out' in sum, false, '시간 초과가 아니다');
  assert.deepEqual(runnerCalls(dir, 'frontend').at(-1), ['vitest'], 'DoD tests 항목이 없으면 test 명령에 아무것도 덧붙이지 않는다');
  assert.match(gate(dir, '--full').stdout, /실패\s+be: 스위트·파일 2개 · 테스트 3건 — com\.x\.PayTest, com\.x\.FeeTest/, '사람이 읽는 출력에도');

  // fe 에 DoD tests 항목이 생기면 test 단계에 리포터가 붙는다(DoD 판정용 — 종전 동작). 그 리포트에서 vitest 파일 이름도 읽는다
  setDod(dir, [{ id: 'D1', text: '화면 a', tests: { stack: 'fe', select: ['src/a'] }, expect: { min_tests: 1 }, last: 'PENDING' }]);
  const withDod = JSON.parse(gate(dir, '--full', '--json').stdout);
  assert.ok(runnerCalls(dir, 'frontend').at(-1).some(a => a.startsWith('--outputFile.json=')), 'DoD 판정에 쓰는 실행에는 리포터가 붙는다');
  assert.deepEqual(withDod.failed_tests, { be, fe });

  // 컴파일 실패(러너가 아무것도 안 쓰고 exit 1) — 지난 실행의 XML(실패 2개 스위트)이 남아 있어도 이번 실패로 읽지 않는다
  const xmlDir = join(dir, 'backend/build/test-results/test');
  const old = new Date(Date.now() - 3600_000);
  for (const f of readdirSync(xmlDir)) utimesSync(join(xmlDir, f), old, old);
  setRunner(dir, 'backend', { compile_error: true });
  const ce = JSON.parse(gate(dir, '--full', '--json').stdout);
  assert.equal(ce.stacks.be.test, 'FAIL');
  assert.deepEqual(ce.failed_tests, { fe }, 'be 는 이번 실행의 리포트가 없으니 이름도 없다');

  // 고치면 사라진다 — 지난 실행의 이름이 기록에 남지 않는다
  setRunner(dir, 'backend', { compile_error: false, suites: [{ name: 'com.x.FeeTest', tests: 3 }] });
  setRunner(dir, 'frontend', { files: [{ name: 'src/a/x.spec.js', passed: 3 }] });
  const ok = gate(dir, '--full', '--json');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal('failed_tests' in JSON.parse(ok.stdout), false);
  assert.equal('failed_tests' in readState(stateFile(dir)).gate, false);

  // --main: 명령을 바꾸지 않고 읽을 수 있는 gradle 이름만 — 출력과 main-gate.json 의 last 에 같은 모양
  const m = dodTestsRepo({ full: true, ...failing });
  g(m, 'checkout', '-q', 'main');
  const mr = gate(m, '--main', '--json');
  assert.equal(mr.status, 1, mr.stderr);
  assert.deepEqual(JSON.parse(mr.stdout).failed_tests, { be });
  assert.deepEqual(JSON.parse(readFileSync(join(m, '.claude/runtime/main-gate.json'), 'utf8')).last.failed_tests, { be });
  assert.deepEqual(runnerCalls(m, 'frontend').at(-1), ['vitest'], '--main 도 test 명령을 바꾸지 않는다');
  assert.match(gate(m, '--main').stdout, /실패\s+be: 스위트·파일 2개 · 테스트 3건 — com\.x\.PayTest, com\.x\.FeeTest/);
});

test('기록은 판정을 바꾸지 않는다: 덧붙은 인자를 거부하는 러너도 종전대로 PASS(--main · --full) · 리포트가 깨져 있어도 죽지 않고 FAIL 을 기록한다', () => {
  const dir = makeRepo();
  const cfgPath = join(dir, '.claude/harness.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  // 인자가 하나라도 더 붙으면 exit 9 — dod_tests 를 선언만 해 두고 DoD tests 항목은 쓰지 않는 프로젝트의 래퍼 스크립트가 이렇다.
  // 이름을 읽으려고 test 명령에 리포터 인자를 붙이면 통과하던 게이트가 FAIL 로 바뀐다
  const strict = `node -e "process.exit(process.argv.length > 1 ? 9 : 0)"`;
  cfg.stacks.fe.test = strict;
  cfg.stacks.fe.dod_tests = { adapter: 'vitest', run: strict };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  appendFileSync(join(dir, '.gitignore'), '.claude/runtime/\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'strict runner');
  const mr = gate(dir, '--main', '--json');
  assert.equal(mr.status, 0, mr.stdout + mr.stderr);
  assert.equal(JSON.parse(mr.stdout).stacks.fe.test, 'PASS');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1'); startIssue(dir);
  edit(dir, 'frontend/app.js', 'export default 2\n'); g(dir, 'add', '-A');
  const r = gate(dir, '--full', '--json');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).stacks.fe.test, 'PASS');

  // 리포트 자리에 JSON `null` 을 쓰고 실패하는 러너 — DoD 판정 때문에 리포터가 붙는 실행. 읽다가 죽으면 FAIL 요약도 기록도 남지 않는다
  const broken = `node -e "const a = process.argv.find(x => x.startsWith('--outputFile.json=')); if (a) require('fs').writeFileSync(a.slice(18), 'null'); process.exit(8)"`;
  cfg.stacks.fe.test = broken;
  cfg.stacks.fe.dod_tests = { adapter: 'vitest', run: broken };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A');
  setDod(dir, [{ id: 'D1', text: '화면', tests: { stack: 'fe', select: ['src/a'] }, last: 'PENDING' }]);
  const b = gate(dir, '--full', '--json');
  assert.equal(b.status, 1, b.stdout + b.stderr);
  const bs = JSON.parse(b.stdout);
  assert.equal(bs.stacks.fe.test, 'FAIL');
  assert.equal('failed_tests' in bs, false, '읽을 리포트가 없으면 이름을 싣지 않는다');
  const st = readState(stateFile(dir));
  assert.equal(st.gate.results.test, 'FAIL', '판정이 상태에 기록된다');
  assert.equal(st.dod[0].last, 'FAIL', 'DoD 항목은 「이번 실행에 안 걸렸다」로 FAIL');

  // 리포트 자리를 읽을 수 없다(reports 가 디렉토리가 아니라 파일) — 이름을 읽다 난 오류가 FAIL 요약·기록을 끊지 않는다
  const x = makeRepo();
  const xPath = join(x, '.claude/harness.json');
  const xCfg = JSON.parse(readFileSync(xPath, 'utf8'));
  xCfg.stacks.be.test = `node -e "process.exit(4)"`;
  xCfg.stacks.be.dod_tests = { adapter: 'gradle-junit', run: `node -e "process.exit(0)"`, reports: 'App.java' };
  writeFileSync(xPath, JSON.stringify(xCfg, null, 2) + '\n');
  appendFileSync(join(x, '.gitignore'), '.claude/runtime/\n');
  g(x, 'add', '-A'); g(x, 'commit', '-q', '-m', 'unreadable reports');
  const xr = gate(x, '--main', '--json');
  assert.equal(xr.status, 1, xr.stdout + xr.stderr);
  const xs = JSON.parse(xr.stdout);
  assert.equal(xs.stacks.be.test, 'FAIL');
  assert.equal('failed_tests' in xs, false);
  assert.equal(JSON.parse(readFileSync(join(x, '.claude/runtime/main-gate.json'), 'utf8')).last.overall, 'FAIL', '기록이 남는다');
});

test('기록: 긴 출력은 로그에 머리와 꼬리를 남긴다(끝의 실패 요약이 잘리지 않는다 — 긴 stderr 가 stdout 의 끝을 밀어내지도 않는다) · 시간 상한에 걸린 단계는 timed_out 으로 따로 보이고 그 프로세스는 트리째 끝난다', async () => {
  const dir = makeRepo();
  const cfgPath = join(dir, '.claude/harness.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  // 약 37만 자 — 남기는 양(20만 자)을 넘긴다. 실패 요약은 러너가 그러듯 맨 끝에 찍는다.
  // 표식은 실행 중에 이어 붙인다 — 로그 머리에는 명령 줄도 그대로 찍히므로, 명령에 글자 그대로 있으면 출력이 잘려도 단언이 걸린다
  cfg.stacks.be.test = `node -e "console.log('HEAD' + '_MARK_' + 42); for (let i = 0; i < 6000; i++) console.log('x'.repeat(60)); console.log('TAIL' + '_MARK_' + 42 + ' 3 tests failed'); process.exit(1)"`;
  // stdout 6만 자 끝에 요약, 그 뒤 stderr 17만 자 — 둘을 합쳐서 자르면 stdout 의 끝이 가운데로 밀려 잘린다
  cfg.stacks.be.lint = `node -e "console.log('o'.repeat(60000)); console.log('SO' + '_END_' + 7); console.error('e'.repeat(170000)); console.error('SE' + '_END_' + 7)"`;
  // 상한(30초 — 스키마 하한)보다 오래 도는 단계. 셸 → 이 프로세스 → 손자 트리를 만들고, 손자는 48초 뒤에 끝 표식을 쓴다
  const marker = join(mkdtempSync(join(tmpdir(), 'jh-linger-')), 'end').replace(/\\/g, '/');
  cfg.stacks.fe.test = `node '${join(HERE, 'fixtures/lingering.mjs').replace(/\\/g, '/')}' '${marker}' 48000 60000`;
  cfg.gate = { timeout_s: 30 };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  appendFileSync(join(dir, '.gitignore'), '.claude/runtime/\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'long output');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1'); startIssue(dir);
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  const r = gate(dir, '--full', '--json');
  assert.equal(r.status, 1, r.stderr);
  const sum = JSON.parse(r.stdout);
  const log = readFileSync(join(dir, sum.log), 'utf8');
  assert.match(log, /HEAD_MARK_42/, '머리가 남는다');
  assert.match(log, /TAIL_MARK_42 3 tests failed/, '출력의 끝(실패 요약)이 로그에 남는다');
  assert.match(log, /가운데 \d+자 생략/, '잘랐다는 표식');
  assert.match(log, /SO_END_7/, 'stdout 의 끝은 긴 stderr 에 밀려 잘리지 않는다');
  assert.match(log, /SE_END_7/, 'stderr 의 끝도 남는다');
  for (const sec of log.split(/\n(?=## \w+\.\w+ \$ )/)) assert.ok(sec.length < 205_000, `명령 하나의 로그 크기는 묶여 있다: ${sec.length} — ${sec.slice(0, 40)}`);
  assert.deepEqual(sum.timed_out, ['fe.test'], '시간 상한에 걸린 단계');
  assert.deepEqual(readState(stateFile(dir)).gate.timed_out, ['fe.test']);
  assert.equal('failed_tests' in sum, false, '어댑터가 없는 스택은 이름을 읽지 못한다 — 로그를 본다');
  // 셸만 끝내면 그 아래 프로세스가 남아, 자리를 넘겨받은 다음 게이트와 겹쳐 돈다. 손자가 살아 있다면 끝 표식을 쓸 시각(시작 48초 뒤)을 넘겨 본다
  assert.ok(existsSync(`${marker}.started`), '손자 프로세스는 실제로 떠 있었다');
  if (process.platform === 'win32') {
    await new Promise(res => setTimeout(res, 20_000));
    assert.equal(existsSync(marker), false, '시간 상한에 걸린 단계의 프로세스는 트리째 끝난다');
  }
});

test('전량: DoD 프로브가 스택 단계보다 먼저 돌고, FAIL 이면 스택 단계·DoD tests 를 건너뛴다(NOT_RUN) · 이번에 판정하지 않은 항목의 지난 판정은 그대로', () => {
  const dir = dodTestsRepo({ full: true, suites: [{ name: 'com.x.FeeTest', tests: 3 }], files: [{ name: 'src/a/x.spec.js', passed: 2 }] });
  const fee = { id: 'D2', text: '수수료', tests: { stack: 'be', select: ['*FeeTest*'] }, expect: { min_tests: 3 }, last: 'PASS', at: '2026-10-01T00:00:00.000Z' };
  setDod(dir, [{ id: 'D1', text: '위반 주입', probe: 'echo nothing-fired', cwd: 'backend', expect: { pattern: 'INJECTION_FIRED' }, last: 'PENDING' }, fee]);
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  assert.equal(gate(dir, '--full').status, 1);
  let s = readState(stateFile(dir));
  assert.equal(s.gate.results.dod, 'FAIL');
  for (const k of ['compile', 'lint', 'build', 'test', 'extra']) assert.equal(s.gate.results[k], 'NOT_RUN', `${k} 는 건너뛴다`);
  assert.equal(s.gate.stacks.be.test, 'NOT_RUN');
  assert.ok(!existsSync(join(dir, 'backend/.fake-runner.log')), '스택 test 도 DoD 배치도 러너를 띄우지 않았다');
  assert.deepEqual(s.dod.map(d => [d.last, d.at ?? null]).slice(1), [['PASS', '2026-10-01T00:00:00.000Z']], 'D2 는 이번에 판정하지 않았다');
  let log = readFileSync(join(dir, s.gate.log), 'utf8');
  assert.match(log, /스택 단계 건너뜀 — DoD 프로브 FAIL 1건/);
  assert.doesNotMatch(log, /^## be\.compile /m);
  g(dir, 'commit', '-q', '-m', 'code'); addReview(dir);
  const h = hook(dir, 'git push');
  assert.equal(h.decision, 'deny'); assert.ok(h.reason.includes('GATE_FAIL') && h.reason.includes('dod=FAIL'), h.reason);

  // 프로브를 고치면 스택 단계 → DoD tests(test 리포트) 까지 돈다
  setDod(dir, [{ id: 'D1', text: '위반 주입', probe: 'echo INJECTION_FIRED', cwd: 'backend', expect: { pattern: 'INJECTION_FIRED' }, last: 'FAIL' }, fee]);
  assert.equal(gate(dir, '--full').status, 0);
  s = readState(stateFile(dir));
  assert.equal(s.gate.results.test, 'PASS'); assert.deepEqual(s.dod.map(d => d.last), ['PASS', 'PASS']);
  assert.notEqual(s.dod[1].at, '2026-10-01T00:00:00.000Z', '이번엔 D2 도 판정했다');
  log = readFileSync(join(dir, s.gate.log), 'utf8');
  assert.ok(log.indexOf('## dod D1 $') < log.indexOf('## be.compile $'), 'DoD 프로브가 스택 단계보다 먼저');
  assert.match(log, /dod D2 \[be 전량 test 리포트\] .* → PASS/);
});

test('전량 --stacks: 브랜치가 바꾼 스택(커밋·작업트리)을 빼면 exit 2·기록 없음 · 바뀐 스택만 돌면 push 된다 · 문서만 바뀐 스택은 요구하지 않는다', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  edit(dir, 'frontend/app.js', 'export default 2\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'fe');
  mkdirSync(join(dir, 'backend/notes'), { recursive: true });
  edit(dir, 'backend/notes/NOTE.md', '# note\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'be docs');
  const ok = gate(dir, '--full', '--stacks', 'fe', '--json');
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const st = readState(stateFile(dir));
  assert.deepEqual(Object.keys(st.gate.stacks), ['fe']);
  addReview(dir);
  assert.equal(hook(dir, 'git push').decision, 'pass', 'FE 만 바꾼 브랜치는 FE 한정 전량으로 push 된다');

  edit(dir, 'backend/App.java', 'class App { int y; }\n'); g(dir, 'add', '-A'); // 아직 커밋 안 한 BE 변경
  const dirty = gate(dir, '--full', '--stacks', 'fe');
  assert.equal(dirty.status, 2);
  assert.match(dirty.stderr, /--stacks 가 이 브랜치에서 바뀐 스택을 뺐다: be/);
  g(dir, 'commit', '-q', '-m', 'be');
  const committed = gate(dir, '--full', '--stacks', 'fe');
  assert.equal(committed.status, 2, '커밋된 BE 변경도 센다');
  assert.equal(readState(stateFile(dir)).gate.at, st.gate.at, '거부된 실행은 기록을 남기지 않는다');
  assert.equal(gate(dir, '--full', '--stacks', 'fe,be').status, 0);
});

test('이름 바꾸기: 코드 파일을 docs 로 옮겨도 docs-only 로 통과하지 않는다 — 옛 경로까지 센다(commit·경량 게이트 스택·push)', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  g(dir, 'mv', 'backend/App.java', 'docs/App.md');
  const c = hook(dir, 'git commit -m x');
  assert.equal(c.decision, 'deny', c.reason); assert.ok(c.reason.includes('NO_GATE'), c.reason);
  assert.equal(gate(dir, '--commit').status, 0);
  assert.ok('be' in readState(stateFile(dir)).gate.stacks, '경량 게이트도 옛 경로의 스택을 건드린 것으로 본다');
  g(dir, 'commit', '-q', '-m', 'mv');
  const p = hook(dir, 'git push');
  assert.equal(p.decision, 'deny', p.reason); assert.ok(p.reason.includes('GATE_LEVEL'), p.reason);
});

test('한글 파일 이름: git 이 경로를 따옴표·8진수로 바꿔 내는 설정에서도 그 파일은 자기 스택의 변경이다(그 파일만 고쳐도 컴파일·lint 가 돈다 — 스택 없이 초록으로 지나가지 않는다) · 문서면 docs-only 다 · lint_changed 대상에도 들어간다', () => {
  const dir = makeRepo();
  g(dir, 'config', 'core.quotepath', 'true'); // git 기본값 — 줄 단위 출력에서 한글 경로에 따옴표가 붙는다
  const cfgPath = join(dir, '.claude/harness.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.stacks.fe.lint = 'echo FULL';
  cfg.stacks.fe.lint_changed = { run: 'echo CHANGED {files}', match: ['src/**/*.js'] };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'cfg');

  // 문서 — 기본 브랜치에서도 docs-only 로 통과한다(코드로 읽히면 브랜치 패턴 밖이라 막힌다)
  edit(dir, 'docs/회의록 1차.md', '# 회의\n'); g(dir, 'add', '-A');
  const d = hook(dir, 'git commit -m docs');
  assert.equal(d.decision, 'pass', d.reason);
  g(dir, 'commit', '-q', '-m', 'docs');

  // 코드 — 그 파일 하나만 바꿔도 fe 스택이 잡히고 lint 대상에 들어간다
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  mkdirSync(join(dir, 'frontend/src'), { recursive: true });
  edit(dir, 'frontend/src/한글 화면.js', 'export default 2\n');
  const dry = JSON.parse(gate(dir, '--commit', '--stage-all', '--dry-run', '--json').stdout);
  assert.deepEqual(Object.keys(dry.stacks), ['fe'], '한글 이름 파일 하나만 바뀌어도 그 스택이 잡힌다');
  assert.deepEqual([dry.lint_scope.fe.mode, dry.lint_scope.fe.files], ['changed', 1]);
  const r = gate(dir, '--commit', '--stage-all');
  assert.equal(r.status, 0, r.stderr);
  let s = readState(stateFile(dir));
  assert.deepEqual(s.gate.stacks, { fe: { compile: 'PASS', lint: 'PASS' } });
  assert.deepEqual([s.gate.lint_scope.fe.mode, s.gate.lint_scope.fe.files], ['changed', 1]);
  // 커밋한 뒤 — 브랜치 범위(--dod)도 같은 파일을 본다
  g(dir, 'commit', '-q', '-m', 'ko');
  const dod = JSON.parse(gate(dir, '--dod', '--dry-run', '--json').stdout);
  assert.deepEqual(Object.keys(dod.stacks), ['fe']);
  assert.deepEqual([dod.lint_scope.fe.mode, dod.lint_scope.fe.files], ['changed', 1]);
});

test('lint_changed 보강: 스택 dir 을 `./frontend` 로 적어도 바뀐 파일을 찾는다(대상 0 으로 지나가지 않는다) · 스택 위 폴더의 lint 설정이 바뀌면 전체 lint · 스택 이름이 constructor 여도 게이트가 죽지 않는다', () => {
  const dir = makeRepo();
  const cfgPath = join(dir, '.claude/harness.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  Object.assign(cfg.stacks.fe, { dir: './frontend', paths: ['frontend/**', 'eslint.config.mjs'], lint: 'echo FULL >> .lint-calls', lint_changed: { run: 'echo CHANGED {files} >> .lint-calls', match: ['**/*.js'] } });
  cfg.stacks.constructor = { dir: 'ctor', lint: 'echo ctor-lint' };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  appendFileSync(join(dir, '.gitignore'), '.lint-calls\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'cfg');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  const dry = () => JSON.parse(gate(dir, '--commit', '--stage-all', '--dry-run', '--json').stdout);

  // ① `./frontend` — 변경 경로(git 은 `frontend/…` 로 낸다)와 철자가 달라도 그 스택의 파일이다
  edit(dir, 'frontend/app.js', 'export default 2\n');
  let d = dry();
  assert.deepEqual(d.lint_scope, { fe: { mode: 'changed', files: 1, reason: '바뀐 파일 1개' } });
  assert.equal(d.stacks.fe.lint, "echo CHANGED 'app.js' >> .lint-calls");

  // ② 스택 위 폴더(저장소 루트)의 lint 설정 — 스택 안에서 바뀐 것과 무관하게 전체 lint
  edit(dir, 'eslint.config.mjs', 'export default []\n');
  d = dry();
  assert.equal(d.lint_scope.fe.mode, 'full');
  assert.match(d.lint_scope.fe.reason, /\(상위 폴더\) eslint\.config\.mjs/);
  assert.equal(d.stacks.fe.lint, 'echo FULL >> .lint-calls');

  // ③ 스택 이름이 물려받은 속성 이름(constructor)이어도 lint 단계가 제 명령으로 돈다 — 「lint 계획 있음」으로 잘못 읽혀 죽지 않는다
  mkdirSync(join(dir, 'ctor'), { recursive: true });
  edit(dir, 'ctor/x.txt', 'x\n');
  const r = gate(dir, '--commit', '--stage-all', '--json');
  assert.equal(r.status, 0, r.stderr);
  const s = readState(stateFile(dir));
  assert.equal(s.gate.stacks.constructor.lint, 'PASS');
  assert.deepEqual(Object.keys(s.gate.lint_scope), ['fe'], 'lint_changed 가 없는 스택은 범위 기록도 없다');
  assert.deepEqual(readFileSync(join(dir, 'frontend/.lint-calls'), 'utf8').trim().split(/\r?\n/).map(l => l.trim()), ['FULL']);
});

test('게이트 도중 다른 경로가 쓴 상태(리뷰 기록)를 게이트 종료가 덮어쓰지 않는다 — 쓰기 직전에 다시 읽고 gate·history·DoD 판정만 얹는다', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  // 게이트가 도는 사이 issue-set --review 가 기록하는 것을 흉내 — DoD 프로브가 상태 파일의 review 를 쓴다
  writeFileSync(join(dir, 'backend/write-review.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
const f = '../.claude/runtime/issues/feat-ABC-1.json';
const s = JSON.parse(readFileSync(f, 'utf8'));
s.review = { tree: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', files: [], codex: 'skipped', lanes: 1, findings: 0, blockers_open: 0, round: 7, delta_passes: 2, at: '2026-09-23T05:15:43.000Z' };
writeFileSync(f, JSON.stringify(s, null, 2));
console.log('REVIEW_WRITTEN');
`);
  const st = readState(stateFile(dir));
  st.dod = [{ id: 'D1', text: '게이트 도중 리뷰 기록', probe: 'node write-review.mjs', cwd: 'backend', expect: { pattern: 'REVIEW_WRITTEN' }, last: 'PENDING' }];
  writeState(stateFile(dir), st);
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  assert.equal(gate(dir, '--full').status, 0);
  const s = readState(stateFile(dir));
  assert.equal(s.review?.round, 7, '게이트가 시작 때 읽은 사본으로 리뷰 기록을 덮어썼다');
  assert.equal(s.review.delta_passes, 2);
  assert.equal(s.gate.level, 'full');
  assert.equal(s.dod[0].last, 'PASS', 'DoD 판정은 얹힌다');
  assert.ok(s.history.some(h => h.stage === 'gate'));
});

test('스택 명령 실패 주입 → compile FAIL 기록 + hook GATE_FAIL · dry-run 은 기록하지 않는다', () => {
  const dir = makeRepo();
  const cfg = JSON.parse(readFileSync(join(dir, '.claude/harness.json'), 'utf8'));
  cfg.stacks.be.compile = 'echo compiling && exit 3';
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg));
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'cfg');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  const dry = gate(dir, '--commit', '--dry-run', '--json');
  assert.equal(dry.status, 0); assert.equal(readState(stateFile(dir)).gate, null, 'dry-run 은 기록 없음');
  assert.ok(JSON.parse(dry.stdout).stacks.be.compile.includes('exit 3'));
  const r = gate(dir, '--commit', '--json');
  assert.equal(r.status, 1);
  const st = readState(stateFile(dir));
  assert.equal(st.gate.results.compile, 'FAIL'); assert.equal(st.gate.stacks.be.compile, 'FAIL');
  addReview(dir);
  const h = hook(dir, 'git commit -m x');
  assert.equal(h.decision, 'deny'); assert.ok(h.reason.includes('GATE_FAIL') && h.reason.includes('compile=FAIL'), h.reason);
});

test('lint_changed: 이슈 게이트(--commit · --dod · --related)의 lint 는 그 게이트가 보는 변경 파일만 넘겨 돈다 · 바뀐 대상이 없으면 always 만 돌거나 SKIPPED(전체로 넘기지 않는다) · lint 설정 변경은 전체 lint · --full 은 언제나 전체 · 좁힌 명령의 실패도 lint FAIL · 어느 쪽으로 돌았는지 계획·로그·기록·요약에 남는다 · {files} 없는 run 은 설정 오류', () => {
  const dir = makeRepo();
  const setFe = (patch) => { const f = join(dir, '.claude/harness.json'); const cfg = JSON.parse(readFileSync(f, 'utf8')); Object.assign(cfg.stacks.fe, patch); writeFileSync(f, JSON.stringify(cfg)); };
  const MATCH = ['**/*.js', '**/*.vue'];
  // lint 가 무엇으로 불렸는지 스택 dir 의 파일에 남긴다 — 전체는 FULL, 좁힌 것은 CHANGED <파일…>
  setFe({ lint: 'echo FULL >> .lint-calls', lint_changed: { run: 'echo CHANGED {files} >> .lint-calls', match: MATCH } });
  appendFileSync(join(dir, '.gitignore'), '.lint-calls\n');
  mkdirSync(join(dir, 'frontend/src'), { recursive: true });
  edit(dir, 'frontend/src/a.vue', '<template></template>\n'); edit(dir, 'frontend/src/b.js', 'export const b = 1\n'); edit(dir, 'frontend/data.txt', 'x\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'cfg');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  startIssue(dir);
  const callsFile = join(dir, 'frontend/.lint-calls');
  const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean) : []);
  const run = (...args) => { const r = gate(dir, ...args, '--json'); assert.ok(r.stdout.trim().startsWith('{'), `요약 JSON 이 없다: ${r.stderr}`); return { r, j: JSON.parse(r.stdout) }; };
  const commit = (m) => g(dir, 'commit', '-q', '-m', m);

  // ① 커밋 게이트 — 작업트리에서 바뀐 lint 대상만(match 밖 data.txt 는 넘기지 않는다)
  edit(dir, 'frontend/app.js', 'export default 2\n'); edit(dir, 'frontend/src/a.vue', '<template><p/></template>\n'); edit(dir, 'frontend/data.txt', 'y\n');
  g(dir, 'add', '-A');
  const dry = JSON.parse(gate(dir, '--commit', '--dry-run', '--json').stdout);
  assert.equal(dry.stacks.fe.lint, "echo CHANGED 'app.js' 'src/a.vue' >> .lint-calls", 'dry-run 은 실제로 돌 명령을 보여 준다');
  assert.deepEqual(dry.lint_scope, { fe: { mode: 'changed', files: 2, reason: '바뀐 파일 2개' } });
  assert.deepEqual(calls(), [], 'dry-run 은 돌리지 않는다');
  const c1 = run('--commit');
  assert.equal(c1.r.status, 0, c1.r.stderr);
  assert.deepEqual(calls(), ['CHANGED app.js src/a.vue']);
  assert.equal(c1.j.results.lint, 'PASS');
  assert.deepEqual(c1.j.lint_scope, { fe: { mode: 'changed', files: 2, reason: '바뀐 파일 2개' } });
  assert.deepEqual(readState(stateFile(dir)).gate.lint_scope, c1.j.lint_scope, '기록에도 남는다 — 좁혀 돈 초록을 전체 lint 의 초록과 구분한다');
  assert.match(readFileSync(join(dir, c1.j.log), 'utf8'), /## fe\.lint 범위 mode=changed files=2 — 바뀐 파일 2개/);
  commit('c1');

  // ② 스택은 바뀌었는데 바뀐 lint 대상이 없다 — 전체로 넘기지 않고 돌리지 않는다. 초록(PASS)이 아니라 SKIPPED 와 「검사 0」으로 남는다
  let n = calls().length;
  edit(dir, 'frontend/data.txt', 'z\n'); g(dir, 'add', '-A');
  const c2 = gate(dir, '--commit');
  assert.equal(c2.status, 0, c2.stderr);
  assert.equal(calls().length, n, 'lint 명령을 띄우지 않는다');
  assert.match(c2.stdout, /lint 범위 fe: 바뀐 파일 중 lint 대상이 없다 — lint 를 돌리지 않았다\(검사 0\) · 전체 lint 는 --full·--main 에서/);
  const st2 = readState(stateFile(dir));
  assert.equal(st2.gate.results.lint, 'SKIPPED'); assert.equal(st2.gate.stacks.fe.lint, 'SKIPPED');
  assert.deepEqual([st2.gate.lint_scope.fe.mode, st2.gate.lint_scope.fe.files], ['none', 0]);
  // always — 파일 목록과 무관한 검사는 바뀐 대상이 없어도 돈다(그것만)
  setFe({ lint_changed: { run: 'echo CHANGED {files} >> .lint-calls', match: MATCH, always: 'echo ALWAYS >> .lint-calls' } });
  const dry2 = JSON.parse(gate(dir, '--commit', '--dry-run', '--json').stdout);
  assert.equal(dry2.stacks.fe.lint, 'echo ALWAYS >> .lint-calls');
  const c2b = run('--commit');
  assert.equal(c2b.r.status, 0, c2b.r.stderr);
  assert.deepEqual(calls().slice(n), ['ALWAYS']);
  assert.equal(c2b.j.results.lint, 'PASS');
  assert.match(c2b.j.lint_scope.fe.reason, /파일과 무관한 검사\(always\)만 돌았다/);
  commit('c2');

  // ③ --dod · --related 는 이 브랜치가 바꾼 것 전부 — 앞 커밋의 파일 + 작업트리. always 는 좁힌 명령 뒤에 돈다
  edit(dir, 'frontend/src/b.js', 'export const b = 2\n'); g(dir, 'add', '-A');
  n = calls().length;
  const d1 = gate(dir, '--dod');
  assert.equal(d1.status, 0, d1.stderr);
  assert.deepEqual(calls().slice(n), ['CHANGED app.js src/a.vue src/b.js', 'ALWAYS']);
  assert.match(d1.stdout, /lint 범위 fe: 바뀐 파일 3개만 · 전체 lint 는 --full·--main 에서/);
  n = calls().length;
  const r1 = run('--related');
  assert.equal(r1.r.status, 0, r1.r.stderr);
  assert.deepEqual(calls().slice(n), ['CHANGED app.js src/a.vue src/b.js', 'ALWAYS']);
  assert.equal(r1.j.lint_scope.fe.files, 3);

  // ④ --full 은 lint_changed 를 보지 않는다 — 언제나 전체, 범위 기록도 없다
  n = calls().length;
  const f1 = run('--full');
  assert.equal(f1.r.status, 0, f1.r.stderr);
  assert.deepEqual(calls().slice(n), ['FULL']);
  assert.equal(f1.j.lint_scope, undefined);
  assert.equal(readState(stateFile(dir)).gate.lint_scope, undefined);
  commit('c3');

  // ⑤ lint 설정·의존성이 바뀌면 규칙이 달라진다 — 안 바뀐 파일의 판정도 바뀔 수 있으니 전체
  edit(dir, 'frontend/package.json', '{}\n'); edit(dir, 'frontend/app.js', 'export default 3\n'); g(dir, 'add', '-A');
  const c5 = run('--commit');
  assert.equal(c5.r.status, 0, c5.r.stderr);
  assert.equal(calls().at(-1), 'FULL');
  assert.match(c5.j.lint_scope.fe.reason, /lint 설정·의존성이 바뀌었다\(package\.json\)/);
  commit('c5');

  // ⑥ 좁힌 명령이 실패하면 lint FAIL — 좁혔다고 느슨해지지 않는다(실패한 뒤의 always 는 돌지 않는다)
  setFe({ lint_changed: { run: 'echo CHANGED {files} >> .lint-calls && exit 4', match: MATCH, always: 'echo ALWAYS >> .lint-calls' } });
  edit(dir, 'frontend/src/b.js', 'export const b = 3\n'); g(dir, 'add', '-A');
  n = calls().length;
  const c6 = run('--commit');
  assert.equal(c6.r.status, 1);
  assert.deepEqual(calls().slice(n), ['CHANGED src/b.js']);
  assert.equal(c6.j.results.lint, 'FAIL'); assert.equal(c6.j.stacks.fe.lint, 'FAIL');
  assert.equal(c6.j.lint_scope.fe.mode, 'changed');

  // ⑦ {files} 자리가 없는 run 은 아무것도 좁히지 못한다 — 설정을 읽을 때 막는다
  n = calls().length;
  setFe({ lint_changed: { run: 'echo CHANGED >> .lint-calls', match: MATCH } });
  const bad = gate(dir, '--commit');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /lint_changed\.run/);
  assert.equal(calls().length, n, '설정 오류면 lint 를 돌리지 않는다');
});

test('worktree: 메인 저장소의 harness.json·상태를 쓴다 (설계 §7 ② 위반 주입 축)', () => {
  const dir = makeRepo();
  const wt = join(dirname(dir), `${dir.split(/[\\/]/).pop()}-wt`);
  g(dir, 'worktree', 'add', '-q', '-b', 'feat/ABC-2', wt);
  startIssue(dir, 'feat/ABC-2', ['ABC-2']);
  edit(wt, 'backend/App.java', 'class App { int wt; }\n'); g(wt, 'add', '-A');
  const h1 = hook(wt, 'git commit -m x');
  assert.equal(h1.decision, 'deny'); assert.ok(h1.reason.includes('NO_GATE'), `worktree 에서 메인 상태를 찾았다: ${h1.reason}`);
  const r = gate(wt, '--commit');
  assert.equal(r.status, 0, r.stderr);
  const st = readState(stateFile(dir, 'feat-ABC-2'));
  assert.equal(st.gate.level, 'commit', '상태는 메인 저장소 runtime 에 기록');
  assert.ok(hook(wt, 'git commit -m x').reason.includes('NO_REVIEW'));
  addReview(dir, 'feat-ABC-2');
  assert.equal(hook(wt, 'git commit -m x').decision, 'pass');
});

test('adopt: 패턴 밖 브랜치라도 상태 JSON 이 있으면 BRANCH_PATTERN 이 아니라 다음 판정(NO_GATE)으로 간다', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'hotfix/no-key');
  edit(dir, 'backend/App.java', 'class App { int a; }\n'); g(dir, 'add', '-A');
  let r = hook(dir, 'git commit -m x');
  assert.equal(r.decision, 'deny'); assert.ok(r.reason.includes('BRANCH_PATTERN'), r.reason);
  startIssue(dir, 'hotfix/no-key', ['ABC-9']); // issue-start --adopt 가 하는 일
  r = hook(dir, 'git commit -m x');
  assert.equal(r.decision, 'deny'); assert.ok(r.reason.includes('NO_GATE'), r.reason);
});

test('safe-commit: 훅 없이도 같은 판정 — 게이트 전 거부(exit 1), 게이트+리뷰 후 커밋(exit 0)', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  edit(dir, 'backend/App.java', 'class App { int a; }\n'); g(dir, 'add', '-A');
  startIssue(dir);
  const run = () => sh(NODE, [join(SCRIPTS, 'safe-commit.mjs'), '-m', 'feat: ABC-1 x', '--cwd', dir, '--json'], dir);
  let r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stderr.includes('NO_GATE'), r.stderr);
  assert.equal(g(dir, 'log', '-1', '--format=%s'), 'init');
  const gr = gate(dir, '--commit'); assert.equal(gr.status, 0, gr.stdout + gr.stderr);
  addReview(dir);
  r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(g(dir, 'log', '-1', '--format=%s'), 'feat: ABC-1 x');
  assert.ok(JSON.parse(r.stdout.trim().split('\n').pop()).commit.sha);
});

test('default_branch_policy: allow 면 main 의 코드 커밋·push 가 통과 · 기본(deny)은 그대로 막고 · 이슈 브랜치 사다리는 안 바뀐다', () => {
  // 기본값(deny) — 켜지 않은 프로젝트의 동작이 변하지 않는다
  const den = makeRepo();
  edit(den, 'backend/App.java', 'class App { int x; }\n'); g(den, 'add', '-A');
  const d = hook(den, 'git commit -m code');
  assert.equal(d.decision, 'deny'); assert.ok(d.reason.includes('BRANCH_PATTERN'), d.reason);

  // allow — main 에서 코드 커밋 통과
  const dir = makeRepo({ defaultBranchPolicy: 'allow' });
  edit(dir, 'backend/App.java', 'class App { int x; }\n'); g(dir, 'add', '-A');
  const c = hook(dir, 'git commit -m code');
  assert.equal(c.decision, 'pass'); assert.ok(c.reason.includes('DEFAULT_BRANCH_ALLOWED'), c.reason);
  g(dir, 'commit', '-q', '-m', 'code');

  // allow — main push 통과. upstream 이 뒤처진 실제 상황을 만들어야 NOTHING_TO_PUSH 로 새지 않는다
  const remote = mkdtempSync(join(tmpdir(), 'jh-remote-'));
  g(remote, 'init', '-q', '--bare', '-b', 'main');
  g(dir, 'remote', 'add', 'origin', remote);
  g(dir, 'push', '-q', '-u', 'origin', 'main');
  edit(dir, 'backend/App.java', 'class App { int y; }\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'code2');
  const pu = hook(dir, 'git push origin main');
  assert.equal(pu.decision, 'pass'); assert.ok(pu.reason.includes('DEFAULT_BRANCH_ALLOWED'), pu.reason);

  // allow 를 켜도 이슈 브랜치 판정은 그대로 — 상태 JSON 이 없으면 막힌다
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  edit(dir, 'backend/App.java', 'class App { int z; }\n'); g(dir, 'add', '-A');
  const iss = hook(dir, 'git commit -m code');
  assert.equal(iss.decision, 'deny'); assert.ok(iss.reason.includes('NO_STATE'), iss.reason);
});

test('add 와 commit 이 한 명령이면 docs-only 는 스테이징 예정 파일로 판정한다(-a/--all 포함) — 훅은 명령 실행 전에 본다', () => {
  const dir = makeRepo();
  edit(dir, 'docs/README.md', '# docs v3\n'); // unstaged — 인덱스는 아직 비어 있다
  const a = hook(dir, 'git add -A && git status --short && git commit -q -m docs');
  assert.equal(a.decision, 'pass'); assert.ok(a.reason.includes('DOCS_ONLY'), a.reason);
  const b = hook(dir, 'git commit -am docs');
  assert.equal(b.decision, 'pass'); assert.ok(b.reason.includes('DOCS_ONLY'), b.reason);
  const plain = hook(dir, 'git commit -m docs'); // 스테이징도 -a 도 없으면 docs-only 아님 → main 정책 그대로
  assert.equal(plain.decision, 'deny'); assert.ok(plain.reason.includes('BRANCH_PATTERN'), plain.reason);
  edit(dir, 'backend/App.java', 'class App { int q; }\n'); // 코드가 섞이면 docs-only 아님
  const mixed = hook(dir, 'git add -A && git commit -m mixed');
  assert.equal(mixed.decision, 'deny'); assert.ok(mixed.reason.includes('BRANCH_PATTERN'), mixed.reason);
});

test('complete 뒤(상태 아카이브) 같은 브랜치: closure docs 커밋은 통과, 코드 커밋은 COMPLETED 로 안내', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  const archive = join(dir, '.claude/runtime/issues/archive');
  mkdirSync(archive, { recursive: true });
  // issue-complete 가 쓰는 이름 그대로(`<slug>-<YYYYMMDD-HHMM>.json`) — latestArchivedState 는 이 꼴만 상태 아카이브로 본다
  writeFileSync(join(archive, 'feat-ABC-1-20260101-0000.json'), JSON.stringify(newState('feat/ABC-1', ['ABC-1'])) + '\n');
  edit(dir, 'docs/README.md', '# closure\n');
  const docs = hook(dir, "git add -A && git commit -q -F - <<'EOF'\ndocs: closure\nEOF");
  assert.equal(docs.decision, 'pass'); assert.ok(docs.reason.includes('DOCS_ONLY'), docs.reason);
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'docs');
  edit(dir, 'backend/App.java', 'class App { int c; }\n'); g(dir, 'add', '-A');
  const code = hook(dir, 'git commit -m code');
  assert.equal(code.decision, 'deny'); assert.ok(code.reason.includes('COMPLETED'), code.reason);
  assert.ok(code.reason.includes('--adopt'), code.reason);
});

test('훅이 보는 디렉토리: 줄바꿈 뒤 cd 도 우선 · grep -C 는 무시 · 없는 경로는 fail-closed', () => {
  const p = d => d.split(String.fromCharCode(92)).join('/');
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');   // 상태 없음 → 코드 커밋은 NO_STATE
  edit(dir, 'backend/App.java', 'class App { int x; }\n');
  g(dir, 'add', '-A');
  // grep -C 2 의 -C 를 디렉토리로 읽으면 없는 경로 → NO_HARNESS 통과(우회)였다. 지금은 git 자신의 -C 만 본다
  const stray = hook(dir, 'grep -C 2 foo x.js; git commit -m x');
  assert.equal(stray.decision, 'deny'); assert.ok(stray.reason.includes('NO_STATE'), stray.reason);
  // heredoc 다음 줄의 cd 도 첫머리 — 세션 cwd(harness 없는 다른 저장소)가 아니라 cd 한 저장소를 판정한다
  const other = makeRepo({ harness: false });
  const viaCd = hook(other, `cat > f <<X
x
X
cd ${p(dir)} && git commit -m x`);
  assert.equal(viaCd.decision, 'deny'); assert.ok(viaCd.reason.includes('NO_STATE'), viaCd.reason);
  // 없는 경로는 NO_HARNESS 통과가 아니라 HOOK_ERROR(fail-closed)
  const missing = hook(dir, 'cd ' + p(join(dir, 'nope')) + ' && git commit -m x');
  assert.equal(missing.decision, 'deny'); assert.ok(missing.reason.includes('HOOK_ERROR'), missing.reason);
});
