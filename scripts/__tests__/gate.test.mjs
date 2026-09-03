// S2 통합 테스트 — 실제 임시 git 저장소에서 훅(commit-gate.mjs)과 러너(gate.mjs)를 실행한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newState, writeState, readState } from '../lib/config.mjs';
import { detectGitOp, effectiveCwd } from '../lib/gate-core.mjs';
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
function hook(dir, command, cwd = dir) {
  const r = sh(NODE, [join(SCRIPTS, 'commit-gate.mjs')], cwd, JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }));
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

test('DoD 프로브: 분모(min_tests) 없으면 FAIL → GATE_FAIL, 건수를 찍으면 PASS · 위반 주입(명령 실패)도 FAIL', () => {
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
  const r1 = gate(dir, '--commit', '--json');
  assert.equal(r1.status, 1, '분모 미확인 → FAIL');
  let s = readState(stateFile(dir));
  assert.equal(s.gate.results.dod, 'FAIL'); assert.equal(s.dod[0].last, 'FAIL'); assert.equal(s.gate.dod, '0/1 (human 1 제외)');
  addReview(dir);
  const h = hook(dir, 'git commit -m x');
  assert.equal(h.decision, 'deny'); assert.ok(h.reason.includes('GATE_FAIL') && h.reason.includes('dod=FAIL'), h.reason);

  s.dod[0].probe = 'echo BUILD SUCCESSFUL && echo "3 tests completed"';
  writeState(stateFile(dir), s);
  assert.equal(gate(dir, '--commit').status, 0);
  s = readState(stateFile(dir));
  assert.equal(s.gate.results.dod, 'PASS'); assert.equal(s.gate.dod, '1/1 (human 1 제외)');
  addReview(dir);
  assert.equal(hook(dir, 'git commit -m x').decision, 'pass');

  s.dod[0].probe = 'echo BUILD SUCCESSFUL && echo "3 tests completed" && exit 7';
  writeState(stateFile(dir), s);
  assert.equal(gate(dir, '--commit').status, 1, '프로브 실패 주입 → FAIL');
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
  assert.equal(gate(dir, '--commit').status, 0, 'ANSI 를 벗겨 3건을 읽고, sentinel 은 pattern 만으로 PASS');
  let s = readState(stateFile(dir));
  assert.equal(s.gate.results.dod, 'PASS'); assert.equal(s.gate.dod, '2/2');

  // 위반 주입 ① 색상 낀 요약이 하한 미달(3 < 5) → FAIL
  s.dod[0].expect.min_tests = 5;
  writeState(stateFile(dir), s);
  assert.equal(gate(dir, '--commit').status, 1, '실행 건수 3 < 5');
  s = readState(stateFile(dir));
  assert.equal(s.dod[0].last, 'FAIL'); assert.equal(s.dod[1].last, 'PASS');

  // 위반 주입 ② sentinel 프로브가 성공 문구를 못 찍으면 exit 0 이어도 FAIL
  s.dod[0].expect.min_tests = 3;
  s.dod[1].probe = 'echo nothing-fired';
  writeState(stateFile(dir), s);
  assert.equal(gate(dir, '--commit').status, 1, 'sentinel pattern 없음 → FAIL');
  assert.equal(readState(stateFile(dir)).dod[1].last, 'FAIL');
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
  writeFileSync(join(archive, 'feat-ABC-1-20260101T000000Z.json'), JSON.stringify(newState('feat/ABC-1', ['ABC-1'])) + '\n');
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
