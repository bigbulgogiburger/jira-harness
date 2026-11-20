// issue-worktree.test.mjs — issue-start.mjs --worktree · --remove-worktree 통합 테스트.
// 판정축: 지금 트리(브랜치·인덱스·작업 파일)는 그대로 · 작업트리는 <메인>/.claude/worktrees/<이름> 에 하나만 · 상태는 메인 runtime ·
//         base 는 지금 브랜치가 아니라 default_branch(또는 --base) · 등록 안 된 폴더는 지우지 않는다 ·
//         지울 때 링크가 가리키던 바깥 내용과 브랜치·상태는 남는다.
import './fixtures/no-queue.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState } from '../lib/config.mjs';
import { listWorktrees, samePath, harvestWorktree } from '../lib/worktree.mjs';
import { laneLedgerFile, lanePatchFile } from '../lib/lanes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;

function sh(cmd, args, cwd) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }

const MARK = `node -e "require('fs').writeFileSync('init-marker.txt', process.cwd())"`;

/** 임시 저장소(main 1커밋) — 무시 파일 하나(.claude/harness.env.local)와 worktree_copy·worktree_init 설정을 둔다. patch 는 harness.json 에 덮어쓸 값 */
function makeRepo({ init = [MARK], patch = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-issue-wt-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'core.autocrlf', 'false');
  for (const d of ['docs', 'backend', '.claude']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'docs/README.md'), '# docs\n');
  writeFileSync(join(dir, 'backend/App.java'), 'class App {}\n');
  // runtime(상태 JSON)·초기화 표식·링크 이름은 실제 프로젝트처럼 무시한다 — 그래야 "작업트리 폴더가 비추적으로 안 잡힌다" 만 따로 볼 수 있다
  writeFileSync(join(dir, '.gitignore'), '.claude/harness.env.local\n.claude/runtime/\ninit-marker.txt\nnode_modules/\n');
  const cfg = JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8'));
  cfg.herdr = { worktree_copy: ['.claude/harness.env.local'], worktree_init: init };
  Object.assign(cfg, patch);
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  writeFileSync(join(dir, '.claude/harness.env.local'), 'SECRET_FILE=1\n'); // 커밋되지 않는 로컬 파일 — 준비가 복사해 줄 것
  return dir;
}
const stateFile = (dir, slug) => join(dir, '.claude/runtime/issues', `${slug}.json`);
const wtOf = (dir, name) => join(dir, '.claude', 'worktrees', name);

function run(dir, args, procCwd = dir) {
  const r = sh(NODE, [join(SCRIPTS, 'issue-start.mjs'), ...args, '--cwd', dir, '--json'], procCwd);
  let out = null;
  try { out = JSON.parse(r.stdout.trim()); } catch { /* not json */ }
  return { status: r.status, out, raw: r.stdout, err: r.stderr };
}
const startWt = (dir, keys, extra = []) => run(dir, [keys, '--worktree', ...extra]);
const removeWt = (dir, target, extra = []) => run(dir, ['--remove-worktree', target, ...extra]);

test('--worktree: 메인 체크아웃(main)에서 → 작업트리에 feat/ABC-7 · 메인은 main 그대로 · 상태는 메인 runtime · 준비(복사·초기화)가 작업트리에서 돈다', () => {
  const dir = makeRepo();
  const r = startWt(dir, 'ABC-7');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.code, 'STARTED');
  assert.equal(r.out.branch, 'feat/ABC-7');
  const wt = wtOf(dir, 'ABC-7');
  assert.ok(samePath(r.out.worktree.path, wt), r.out.worktree.path);
  assert.ok(!r.out.worktree.path.includes('\\'), '경로는 / 구분');
  assert.equal(r.out.worktree.created, true);
  assert.equal(r.out.worktree.base, 'main');
  assert.equal(r.out.worktree.ignored, 'added');
  assert.equal(g(wt, 'symbolic-ref', '--short', 'HEAD'), 'feat/ABC-7');
  assert.equal(g(dir, 'symbolic-ref', '--short', 'HEAD'), 'main', '메인 체크아웃의 브랜치는 그대로');
  assert.equal(readState(stateFile(dir, 'feat-ABC-7')).branch, 'feat/ABC-7', '상태는 메인 runtime 에');
  assert.equal(r.out.state_path, '.claude/runtime/issues/feat-ABC-7.json');
  assert.equal(existsSync(stateFile(wt, 'feat-ABC-7')), false, '작업트리 쪽 runtime 에는 쓰지 않는다');
  assert.equal(g(dir, 'status', '--porcelain'), '', '작업트리 폴더가 메인의 비추적 파일로 잡히지 않는다');
  assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.claude\/worktrees\/$/m);
  assert.equal(readFileSync(join(wt, '.claude/harness.env.local'), 'utf8'), 'SECRET_FILE=1\n', 'worktree_copy 의 무시 파일이 복사됐다');
  assert.deepEqual(r.out.worktree.prepared.copied, ['.claude/harness.env.local']);
  assert.deepEqual(r.out.worktree.prepared.init.map(i => i.exit), [0]);
  assert.ok(samePath(readFileSync(join(wt, 'init-marker.txt'), 'utf8'), wt), 'worktree_init 은 작업트리 안에서 돈다');
});

test('--worktree: 다시 부르면 RESUMED · 같은 경로 · created:false · 작업트리가 둘이 되지 않는다', () => {
  const dir = makeRepo();
  const r1 = startWt(dir, 'ABC-7');
  assert.equal(r1.out.code, 'STARTED', r1.err);
  const r2 = startWt(dir, 'ABC-7');
  assert.equal(r2.status, 0, r2.err);
  assert.equal(r2.out.code, 'RESUMED');
  assert.equal(r2.out.created, false);
  assert.equal(r2.out.worktree.created, false);
  assert.ok(samePath(r2.out.worktree.path, r1.out.worktree.path));
  assert.equal(r2.out.worktree.prepared, null, '있던 작업트리는 다시 준비하지 않는다');
  assert.equal(listWorktrees(dir).length, 2);
});

test('--worktree: 다른 이슈 브랜치(feat/ABC-1) 위에서도 거부 없이 만들고, 지금 트리의 브랜치·인덱스·작업 파일과 base(main)는 그대로다', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  writeFileSync(join(dir, 'backend/App.java'), 'class App { int a; }\n');
  g(dir, 'commit', '-q', '-am', 'ABC-1 work');
  writeFileSync(join(dir, 'backend/App.java'), 'class App { int b; }\n'); // 커밋 안 된 수정
  writeFileSync(join(dir, 'docs/staged.md'), 'x\n'); g(dir, 'add', 'docs/staged.md'); // 인덱스에만 있는 파일
  const before = g(dir, 'status', '--porcelain');
  const r = startWt(dir, 'ABC-8');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.code, 'STARTED');
  assert.equal(r.out.branch, 'feat/ABC-8');
  assert.equal(g(dir, 'symbolic-ref', '--short', 'HEAD'), 'feat/ABC-1');
  assert.equal(g(dir, 'status', '--porcelain'), before, '지금 트리의 인덱스·작업 파일은 그대로');
  assert.equal(g(wtOf(dir, 'ABC-8'), 'rev-parse', 'HEAD'), g(dir, 'rev-parse', 'main'), 'base 는 지금 브랜치가 아니라 default_branch');
  assert.notEqual(g(dir, 'rev-parse', 'main'), g(dir, 'rev-parse', 'feat/ABC-1'));
  assert.ok(existsSync(stateFile(dir, 'feat-ABC-8')));
  assert.equal(existsSync(stateFile(dir, 'feat-ABC-1')), false, '지금 브랜치의 상태를 만들지 않는다');
});

test('--worktree: 다른 작업트리 안에서 불러도 자리는 메인 아래다 · 그 안에서 --status 는 그 이슈의 상태를 읽는다', () => {
  const dir = makeRepo();
  assert.equal(startWt(dir, 'ABC-7').out.code, 'STARTED');
  const wt7 = wtOf(dir, 'ABC-7');
  const st = run(wt7, ['--status']);
  assert.equal(st.status, 0, st.err);
  assert.equal(st.out.code, 'OK');
  assert.equal(st.out.slug, 'feat-ABC-7');
  assert.deepEqual(st.out.keys, ['ABC-7']);
  assert.equal(st.out.branch, 'feat/ABC-7');

  const r = startWt(wt7, 'ABC-8');
  assert.equal(r.status, 0, r.err);
  assert.ok(samePath(r.out.worktree.path, wtOf(dir, 'ABC-8')), r.out.worktree.path);
  assert.equal(existsSync(join(wt7, '.claude', 'worktrees', 'ABC-8')), false, '부른 작업트리 아래에 파지 않는다');
  assert.ok(existsSync(stateFile(dir, 'feat-ABC-8')), '상태는 메인 runtime 에');
  assert.equal(g(wt7, 'symbolic-ref', '--short', 'HEAD'), 'feat/ABC-7');
});

test('--worktree: 브랜치는 있고 작업트리만 지웠으면 그 브랜치로 다시 판다(base 미적용 · 커밋 유지 · RESUMED)', () => {
  const dir = makeRepo({ init: [] });
  assert.equal(startWt(dir, 'ABC-7').out.code, 'STARTED');
  const wt = wtOf(dir, 'ABC-7');
  g(wt, 'commit', '-q', '--allow-empty', '-m', 'ABC-7 work');
  const tip = g(wt, 'rev-parse', 'HEAD');
  assert.equal(removeWt(dir, 'ABC-7').out.code, 'REMOVED');
  const r = startWt(dir, 'ABC-7');
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'RESUMED', '상태는 남아 있었다');
  assert.equal(r.out.worktree.created, true);
  assert.equal(r.out.worktree.base, null, '있는 브랜치에는 base 를 쓰지 않는다');
  assert.equal(g(wt, 'rev-parse', 'HEAD'), tip, '브랜치의 커밋 그대로');
  assert.notEqual(tip, g(dir, 'rev-parse', 'main'));
});

test('--worktree: 손으로 판 작업트리(다른 자리 · 상태 없음)는 브랜치로 찾아 그대로 쓰고 상태만 만든다', () => {
  const dir = makeRepo({ init: [] });
  const elsewhere = join(mkdtempSync(join(tmpdir(), 'jh-issue-wt-hand-')), 'w');
  g(dir, 'worktree', 'add', '-q', '-b', 'feat/ABC-20', elsewhere, 'main');
  const r = startWt(dir, 'ABC-20');
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'STARTED');
  assert.equal(r.out.created, true);
  assert.equal(r.out.worktree.created, false);
  assert.ok(samePath(r.out.worktree.path, elsewhere), r.out.worktree.path);
  assert.equal(existsSync(wtOf(dir, 'ABC-20')), false, '새로 파지 않는다');
  assert.ok(existsSync(stateFile(dir, 'feat-ABC-20')));
});

test('--worktree: 준비 명령이 실패해도 시작은 끝나고(exit 0) 결과가 출력에 실린다', () => {
  const dir = makeRepo({ init: ['node -e "process.exit(3)"'] });
  const r = startWt(dir, 'ABC-21');
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'STARTED');
  assert.deepEqual(r.out.worktree.prepared.init.map(i => i.exit), [3]);
  assert.ok(existsSync(stateFile(dir, 'feat-ABC-21')));
  assert.ok(existsSync(wtOf(dir, 'ABC-21')));
});

test('--worktree --base <ref>: 새 브랜치는 그 ref 에서 시작한다(기본값 main 과 구분) · 없는 ref 는 WORKTREE_ADD_FAILED 이고 상태를 만들지 않는다', () => {
  const dir = makeRepo();
  const first = g(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'docs/second.md'), '2\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'second');
  const r = startWt(dir, 'ABC-9', ['--base', first]);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.worktree.base, first);
  assert.equal(g(wtOf(dir, 'ABC-9'), 'rev-parse', 'HEAD'), first);
  assert.notEqual(g(dir, 'rev-parse', 'main'), first);

  const bad = startWt(dir, 'ABC-10', ['--base', 'no-such-ref']);
  assert.equal(bad.status, 1, bad.raw);
  assert.equal(bad.out.code, 'WORKTREE_ADD_FAILED');
  assert.ok(bad.out.reason.length > 0);
  assert.equal(existsSync(stateFile(dir, 'feat-ABC-10')), false);
  assert.equal(existsSync(wtOf(dir, 'ABC-10')), false);
});

test('--worktree: 자리에 등록 안 된 폴더가 있으면 WORKTREE_PATH_TAKEN 이고 폴더는 그대로 · --worktree --adopt 는 exit 2', () => {
  const dir = makeRepo();
  const taken = wtOf(dir, 'ABC-9');
  mkdirSync(taken, { recursive: true }); writeFileSync(join(taken, 'keep.txt'), 'keep');
  const r = startWt(dir, 'ABC-9');
  assert.equal(r.status, 1, r.raw);
  assert.equal(r.out.code, 'WORKTREE_PATH_TAKEN');
  assert.equal(readFileSync(join(taken, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(stateFile(dir, 'feat-ABC-9')), false, '상태를 만들지 않는다');
  assert.equal(sh('git', ['show-ref', '--verify', '--quiet', 'refs/heads/feat/ABC-9'], dir).status, 1, '브랜치를 만들지 않는다');

  const both = run(dir, ['ABC-11', '--worktree', '--adopt']);
  assert.equal(both.status, 2, both.raw);
  assert.equal(existsSync(wtOf(dir, 'ABC-11')), false);
});

test('--remove-worktree <KEY>: REMOVED · 폴더·등록이 없어지고 브랜치·상태는 남는다 · 링크가 가리키던 바깥 파일은 그대로', () => {
  const dir = makeRepo({ init: [] });
  const shared = mkdtempSync(join(tmpdir(), 'jh-issue-wt-shared-'));
  writeFileSync(join(shared, 'keep.txt'), 'keep');
  assert.equal(startWt(dir, 'ABC-7').out.code, 'STARTED');
  const wt = wtOf(dir, 'ABC-7');
  symlinkSync(shared, join(wt, 'node_modules'), 'junction');

  const r = removeWt(dir, 'ABC-7');
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'REMOVED');
  assert.equal(r.out.branch, 'feat/ABC-7');
  assert.deepEqual(r.out.unlinked, ['node_modules']);
  assert.equal(existsSync(wt), false);
  assert.equal(listWorktrees(dir).some(w => samePath(w.path, wt)), false, '등록이 풀렸다');
  assert.equal(sh('git', ['show-ref', '--verify', '--quiet', 'refs/heads/feat/ABC-7'], dir).status, 0, '브랜치는 남는다');
  assert.ok(existsSync(stateFile(dir, 'feat-ABC-7')), '상태 JSON 은 남는다');
  assert.equal(readFileSync(join(shared, 'keep.txt'), 'utf8'), 'keep', '링크 대상은 그대로');

  const none = removeWt(dir, 'ABC-99');
  assert.equal(none.status, 1, none.raw);
  assert.equal(none.out.code, 'NO_WORKTREE');
});

test('--remove-worktree: 작업트리 안에 260자를 넘는 경로가 있어 git 이 등록만 풀고 실패로 끝나도 남은 폴더를 마저 치운다 · 링크 대상은 그대로', () => {
  const dir = makeRepo({ init: [] });
  g(dir, 'config', 'core.longpaths', 'false'); // 이 PC 의 전역 설정과 무관하게 — Windows 의 git 은 이 설정 없이 260자를 넘는 경로를 지우지 못한다(다른 OS 는 그냥 지운다)
  const shared = mkdtempSync(join(tmpdir(), 'jh-issue-wt-shared-'));
  writeFileSync(join(shared, 'keep.txt'), 'keep');
  assert.equal(startWt(dir, 'ABC-21').out.code, 'STARTED');
  const wt = wtOf(dir, 'ABC-21');
  symlinkSync(shared, join(wt, 'node_modules'), 'junction');
  let deep = join(wt, 'build'); // 깊은 빌드 산출물 — 커밋 안 된 변경이라 --force 로 지운다
  while (deep.length < 300) deep = join(deep, 'd'.repeat(40));
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'Long$Name.class'), 'x');

  const r = removeWt(dir, 'ABC-21', ['--force']);
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'REMOVED');
  assert.deepEqual(r.out.unlinked, ['node_modules']);
  assert.equal(existsSync(wt), false, '남은 폴더까지 치웠다');
  assert.equal(listWorktrees(dir).some(w => samePath(w.path, wt)), false, '등록이 풀렸다');
  assert.equal(sh('git', ['show-ref', '--verify', '--quiet', 'refs/heads/feat/ABC-21'], dir).status, 0, '브랜치는 남는다');
  assert.equal(readFileSync(join(shared, 'keep.txt'), 'utf8'), 'keep', '링크 대상은 그대로');
});

test('--remove-worktree: git 이 거절한 작업트리(잠금)는 지우지 않는다 — REMOVE_FAILED · 폴더와 등록이 그대로', () => {
  const dir = makeRepo({ init: [] });
  assert.equal(startWt(dir, 'ABC-22').out.code, 'STARTED');
  const wt = wtOf(dir, 'ABC-22');
  g(dir, 'worktree', 'lock', wt);

  const r = removeWt(dir, 'ABC-22');
  assert.equal(r.status, 1, r.raw + r.err);
  assert.equal(r.out.code, 'REMOVE_FAILED');
  assert.ok(existsSync(join(wt, 'backend/App.java')), '폴더는 그대로');
  assert.ok(listWorktrees(dir).some(w => samePath(w.path, wt)), '등록도 그대로');
});

test('--remove-worktree: 커밋 안 된 변경이 있으면 DIRTY(exit 1) · --force 면 지운다(경로로도 받는다) · 작업트리 안에서 부르면 IN_WORKTREE', () => {
  const dir = makeRepo({ init: [] });
  assert.equal(startWt(dir, 'ABC-12').out.code, 'STARTED');
  const wt = wtOf(dir, 'ABC-12');
  writeFileSync(join(wt, 'new.txt'), 'new\n');

  const inside = removeWt(wt, 'ABC-12');
  assert.equal(inside.status, 1, inside.raw);
  assert.equal(inside.out.code, 'IN_WORKTREE');
  assert.ok(existsSync(join(wt, 'new.txt')));
  // 셸은 작업트리 안에 선 채 --cwd 로 메인을 준 경우 — 그대로 지우면 Windows 에서 파일·등록만 지워지고 빈 폴더가 남는다
  const shellInside = run(dir, ['--remove-worktree', 'ABC-12', '--force'], wt);
  assert.equal(shellInside.status, 1, shellInside.raw);
  assert.equal(shellInside.out.code, 'IN_WORKTREE');
  assert.ok(existsSync(join(wt, 'new.txt')), '--force 여도 안에서는 지우지 않는다');
  assert.ok(listWorktrees(dir).some(w => samePath(w.path, wt)), '등록도 그대로');

  const dirty = removeWt(dir, 'ABC-12');
  assert.equal(dirty.status, 1, dirty.raw);
  assert.equal(dirty.out.code, 'DIRTY');
  assert.equal(dirty.out.dirty.length, 1);
  assert.ok(dirty.out.message.includes('--force'), dirty.out.message);
  assert.ok(existsSync(join(wt, 'new.txt')), '거부했으면 지우지 않는다');

  const forced = removeWt(dir, wt, ['--force']);
  assert.equal(forced.status, 0, forced.raw + forced.err);
  assert.equal(forced.out.code, 'REMOVED');
  assert.equal(forced.out.branch, 'feat/ABC-12');
  assert.equal(existsSync(wt), false);
});

test('--worktree: 폴더만 손으로 지워진 등록 잔재는 치우고 같은 자리에 다시 판다(브랜치의 커밋은 그대로) · 그 브랜치가 메인 체크아웃에 걸려 있으면 그곳을 돌려준다(main)', () => {
  // (a) 등록은 남고 폴더만 사라진 작업트리 — 없는 경로를 돌려주면 다음 명령이 전부 헛돈다
  const dir = makeRepo();
  assert.equal(startWt(dir, 'ABC-7').out.code, 'STARTED');
  const wt = wtOf(dir, 'ABC-7');
  writeFileSync(join(wt, 'backend/App.java'), 'class App { int kept; }\n');
  g(wt, 'commit', '-q', '-am', 'ABC-7 work');
  const tip = g(wt, 'rev-parse', 'HEAD');
  rmSync(wt, { recursive: true, force: true });
  assert.equal(listWorktrees(dir).some(w => w.branch === 'feat/ABC-7'), true, '등록은 아직 남아 있다');
  const r = startWt(dir, 'ABC-7');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.code, 'RESUMED');
  assert.equal(r.out.worktree.created, true, '없는 경로를 돌려주지 않고 다시 판다');
  assert.ok(samePath(r.out.worktree.path, wt));
  assert.equal(g(wt, 'rev-parse', 'HEAD'), tip, '브랜치의 커밋은 그대로');
  assert.equal(listWorktrees(dir).filter(w => w.branch === 'feat/ABC-7').length, 1);
  // (b) 이슈 브랜치가 메인 체크아웃에 걸려 있다 — 따로 파지 않고 그곳을 돌려준다 · 지우려 하면 거부
  const d2 = makeRepo();
  g(d2, 'checkout', '-q', '-b', 'feat/ABC-9');
  const r2 = startWt(d2, 'ABC-9');
  assert.equal(r2.status, 0, r2.err);
  assert.equal(r2.out.worktree.created, false);
  assert.equal(r2.out.worktree.main, true);
  assert.ok(samePath(r2.out.worktree.path, d2));
  assert.equal(existsSync(wtOf(d2, 'ABC-9')), false);
  const rm = run(d2, ['--remove-worktree', 'ABC-9'], tmpdir());
  assert.equal(rm.status, 1);
  assert.equal(existsSync(join(d2, 'backend/App.java')), true, '메인 체크아웃은 지우지 않는다');
});

// ---------------------------------------------------------------- 구현 레인이 남긴 작업트리·레인 브랜치
// 판정축: 지우는 기준은 장부가 아니라 지금 그 작업트리에 있는 것(변경이 없다 · 회수해 둔 패치와 글자까지 같다) · 레인 브랜치는 lane/ 밖의 브랜치가
//         그 커밋을 갖고 있을 때만 · 이슈 브랜치가 아직 머지되지 않았어도 된다 · 이슈 작업트리가 거부되면 레인에 손대지 않는다.
const rtOf = dir => join(dir, '.claude', 'runtime');
const fwd = p => String(p).replace(/\\/g, '/');
const hasBranch = (dir, b) => sh('git', ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], dir).status === 0;
/**
 * 구현 레인이 남긴 것을 실행기와 같은 자리에 만든다 — 작업트리 <runtime>/herdr/worktrees/<slug>/<name>(브랜치 lane/<slug>/<name> · base 에서 갈린다).
 * change 가 있으면 커밋 안 된 파일 하나, harvest 면 실행기와 같은 함수로 패치를 뽑아 두고, ledger 면 장부에 적는다(entry 로 덮어쓴다).
 */
function makeLane(dir, slug, name, { base, change = null, harvest = false, ledger = true, entry = {} } = {}) {
  const path = fwd(join(rtOf(dir), 'herdr', 'worktrees', slug, name));
  mkdirSync(dirname(path), { recursive: true });
  g(dir, 'worktree', 'add', '-q', '-b', `lane/${slug}/${name}`, path, base);
  if (change != null) writeFileSync(join(path, 'backend', `${name}.txt`), change);
  let applied = 'skipped';
  if (harvest) applied = harvestWorktree(path, lanePatchFile(rtOf(dir), slug, name)).empty ? 'empty' : 'yes';
  if (ledger) {
    const file = laneLedgerFile(rtOf(dir), slug);
    const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { slug, lanes: {} };
    cur.lanes[name] = { branch: `lane/${slug}/${name}`, path, workspace: null, placement: 'split', pane: null, applied, ...entry };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cur, null, 2));
  }
  return path;
}

test('--remove-worktree <KEY>: 그 이슈의 레인 작업트리·레인 브랜치도 함께 치운다 — 이슈 브랜치가 아직 머지되지 않았어도 · 회수해 둔 패치와 같은 변경은 지운다 · 링크 대상과 패치 파일은 남는다', () => {
  const dir = makeRepo({ init: [] });
  assert.equal(startWt(dir, 'ABC-7').out.code, 'STARTED');
  const wt = wtOf(dir, 'ABC-7');
  g(wt, 'commit', '-q', '--allow-empty', '-m', 'phase 0');
  assert.equal(sh('git', ['merge-base', '--is-ancestor', 'feat/ABC-7', 'main'], dir).status, 1, '픽스처: 레인의 시작점은 아직 main 에 없다');
  const shared = mkdtempSync(join(tmpdir(), 'jh-lane-shared-'));
  writeFileSync(join(shared, 'keep.txt'), 'keep');
  const a = makeLane(dir, 'feat-ABC-7', 'a', { base: 'feat/ABC-7', change: 'lane a\n', harvest: true });
  symlinkSync(shared, join(a, 'node_modules'), 'junction');
  const b = makeLane(dir, 'feat-ABC-7', 'b', { base: 'feat/ABC-7' });
  const patch = lanePatchFile(rtOf(dir), 'feat-ABC-7', 'a');
  assert.ok(existsSync(patch), '픽스처: 레인 a 의 변경은 패치로 회수돼 있다');

  const r = removeWt(dir, 'ABC-7');
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'REMOVED');
  assert.ok(samePath(r.out.path, wt));
  assert.deepEqual(r.out.lanes.removed.map(x => x.branch).sort(), ['lane/feat-ABC-7/a', 'lane/feat-ABC-7/b']);
  assert.deepEqual([...r.out.lanes.branches].sort(), ['lane/feat-ABC-7/a', 'lane/feat-ABC-7/b']);
  assert.deepEqual(r.out.lanes.kept, []);
  for (const p of [wt, a, b]) assert.equal(existsSync(p), false, p);
  assert.equal(listWorktrees(dir).length, 1, '메인 체크아웃만 남는다');
  assert.equal(hasBranch(dir, 'lane/feat-ABC-7/a'), false);
  assert.equal(hasBranch(dir, 'lane/feat-ABC-7/b'), false);
  assert.equal(hasBranch(dir, 'feat/ABC-7'), true, '이슈 브랜치는 남는다');
  assert.equal(readFileSync(join(shared, 'keep.txt'), 'utf8'), 'keep', '링크 대상은 그대로');
  assert.ok(existsSync(patch), '회수해 둔 패치는 지우지 않는다');
  assert.equal(g(dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('--remove-worktree <KEY>: 레인 작업트리의 무시되는 폴더(빌드 산출물)에 260자를 넘는 경로가 있어도 한 번에 치운다 — 장부에 없는 레인도 · 남긴 것이 없다', () => {
  const dir = makeRepo({ init: [] });
  g(dir, 'config', 'core.longpaths', 'false'); // Windows 의 git 은 이 설정 없이 260자를 넘는 경로를 지우지 못하고 등록만 푼 채 실패로 끝난다
  assert.equal(startWt(dir, 'ABC-23').out.code, 'STARTED');
  const wt = wtOf(dir, 'ABC-23');
  g(wt, 'commit', '-q', '--allow-empty', '-m', 'phase 0');
  const a = makeLane(dir, 'feat-ABC-23', 'a', { base: 'feat/ABC-23' });
  const b = makeLane(dir, 'feat-ABC-23', 'b', { base: 'feat/ABC-23', ledger: false });
  for (const lane of [a, b]) { // node_modules/ 는 픽스처의 .gitignore 가 무시한다 — 변경으로 잡히지 않는 깊은 산출물
    let deep = join(lane, 'node_modules');
    while (deep.length < 300) deep = join(deep, 'd'.repeat(40));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'Long$Name.class'), 'x');
    assert.equal(g(lane, 'status', '--porcelain'), '', '픽스처: 깊은 폴더는 변경으로 잡히지 않는다');
  }

  const r = removeWt(dir, 'ABC-23');
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'REMOVED');
  assert.deepEqual(r.out.lanes.removed.map(x => x.branch).sort(), ['lane/feat-ABC-23/a', 'lane/feat-ABC-23/b']);
  assert.deepEqual([...r.out.lanes.branches].sort(), ['lane/feat-ABC-23/a', 'lane/feat-ABC-23/b']);
  assert.deepEqual(r.out.lanes.kept, [], '실패 사유가 함께 실리지 않는다');
  for (const p of [wt, a, b]) assert.equal(existsSync(p), false, p);
  assert.equal(listWorktrees(dir).length, 1, '메인 체크아웃만 남는다');
});

test('--remove-worktree <KEY>: 회수되지 않은 레인 변경은 지우지 않는다 — 장부가 「적용됨」이어도 지금 내용이 회수해 둔 패치와 다르면 남긴다 · 장부에 없는 레인도 남긴다 · --force 는 레인에 듣지 않는다', () => {
  const dir = makeRepo({ init: [] });
  assert.equal(startWt(dir, 'ABC-7').out.code, 'STARTED');
  const wt = wtOf(dir, 'ABC-7');
  // a: 회수(장부 applied yes · 패치 있음) 뒤에 더 고쳤다 — 같은 레인을 다시 파서 새로 일하다 실행기가 죽은 경우와 같다(장부·패치는 지난 것 그대로)
  const a = makeLane(dir, 'feat-ABC-7', 'a', { base: 'feat/ABC-7', change: 'round 1\n', harvest: true });
  writeFileSync(join(a, 'backend', 'a.txt'), 'round 2 - not harvested\n');
  // b: 장부는 적용됨이라는데 회수한 패치가 없다
  const b = makeLane(dir, 'feat-ABC-7', 'b', { base: 'feat/ABC-7', change: 'lane b\n', entry: { applied: 'yes' } });
  // c: 장부에 없다(실행기가 장부를 쓰기 전에 죽었다)
  const c = makeLane(dir, 'feat-ABC-7', 'c', { base: 'feat/ABC-7', change: 'lane c\n', ledger: false });

  const r = removeWt(dir, 'ABC-7');
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'REMOVED', '이슈 작업트리는 지웠다');
  assert.equal(existsSync(wt), false);
  assert.deepEqual(r.out.lanes.removed, []);
  assert.deepEqual(r.out.lanes.branches, []);
  assert.deepEqual(r.out.lanes.kept.map(k => k.branch).sort(), ['lane/feat-ABC-7/a', 'lane/feat-ABC-7/b', 'lane/feat-ABC-7/c']);
  assert.match(r.out.lanes.kept.find(k => k.branch.endsWith('/a')).reason, /다르다/);
  assert.match(r.out.lanes.kept.find(k => k.branch.endsWith('/b')).reason, /회수되지 않은/);
  assert.match(r.out.lanes.kept.find(k => k.branch.endsWith('/c')).reason, /회수되지 않은/);
  assert.equal(readFileSync(join(a, 'backend', 'a.txt'), 'utf8'), 'round 2 - not harvested\n');
  assert.equal(readFileSync(join(b, 'backend', 'b.txt'), 'utf8'), 'lane b\n');
  assert.equal(readFileSync(join(c, 'backend', 'c.txt'), 'utf8'), 'lane c\n');
  for (const n of ['a', 'b', 'c']) assert.equal(hasBranch(dir, `lane/feat-ABC-7/${n}`), true);

  // 하나도 못 치우면 실패로 알린다 — --force 를 붙여도 레인의 회수되지 않은 변경은 지우지 않는다
  const again = removeWt(dir, 'ABC-7', ['--force']);
  assert.equal(again.status, 1, again.raw);
  assert.equal(again.out.code, 'LANES_KEPT');
  assert.equal(again.out.lanes.kept.length, 3);
  assert.equal(readFileSync(join(c, 'backend', 'c.txt'), 'utf8'), 'lane c\n');
  // 확인한 뒤 경로로 강제하면 그 하나가 지워지고(브랜치는 남는다), 남은 브랜치는 다음 정리가 치운다
  assert.equal(removeWt(dir, c, ['--force']).out.code, 'REMOVED');
  assert.equal(hasBranch(dir, 'lane/feat-ABC-7/c'), true);
  const third = removeWt(dir, 'ABC-7');
  assert.equal(third.status, 0, third.raw + third.err);
  assert.equal(third.out.code, 'REMOVED');
  assert.equal(third.out.path, null);
  assert.deepEqual(third.out.lanes.branches, ['lane/feat-ABC-7/c']);
  assert.equal(third.out.lanes.kept.length, 2);
});

test('--remove-worktree <KEY>: 이슈를 메인 체크아웃에서 했어도 레인 잔재는 치운다 · 레인이 커밋한 작업은 브랜치에 남긴다 · 작업트리 없이 브랜치만 남은 것도 치운다', () => {
  const dir = makeRepo({ init: [] });
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-9');
  g(dir, 'commit', '-q', '--allow-empty', '-m', 'phase 0');
  const a = makeLane(dir, 'feat-ABC-9', 'a', { base: 'feat/ABC-9' });
  writeFileSync(join(a, 'backend', 'a.txt'), 'committed by the lane\n');
  g(a, 'add', '-A'); g(a, 'commit', '-q', '-m', 'lane a committed');
  const tip = g(a, 'rev-parse', 'HEAD');
  g(dir, 'branch', 'lane/feat-ABC-9/b', 'feat/ABC-9'); // 작업트리 없이 브랜치만

  const r = run(dir, ['--remove-worktree', 'ABC-9'], tmpdir());
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'REMOVED');
  assert.equal(r.out.path, null, '지운 이슈 작업트리는 없다');
  assert.equal(existsSync(a), false, '변경이 없는 레인 작업트리는 지운다');
  assert.deepEqual(r.out.lanes.branches, ['lane/feat-ABC-9/b']);
  assert.deepEqual(r.out.lanes.kept.map(k => k.branch), ['lane/feat-ABC-9/a']);
  assert.match(r.out.lanes.kept[0].reason, /커밋/);
  assert.equal(g(dir, 'rev-parse', 'lane/feat-ABC-9/a'), tip, '레인이 커밋한 작업은 브랜치에 그대로');
  assert.equal(g(dir, 'symbolic-ref', '--short', 'HEAD'), 'feat/ABC-9', '메인 체크아웃은 그대로');
  assert.ok(existsSync(join(dir, 'backend/App.java')));
});

test('--remove-worktree: 이슈 작업트리가 DIRTY 로 거부되면 레인에도 손대지 않는다 · Herdr 워크스페이스로 연 레인 작업트리는 남긴다', () => {
  const dir = makeRepo({ init: [] });
  assert.equal(startWt(dir, 'ABC-12').out.code, 'STARTED');
  const wt = wtOf(dir, 'ABC-12');
  const a = makeLane(dir, 'feat-ABC-12', 'a', { base: 'feat/ABC-12' });
  const w = makeLane(dir, 'feat-ABC-12', 'w', { base: 'feat/ABC-12', entry: { placement: 'workspace', workspace: 'w9', pane: 'w9:p1' } });
  writeFileSync(join(wt, 'new.txt'), 'new\n');

  const dirty = removeWt(dir, 'ABC-12');
  assert.equal(dirty.status, 1, dirty.raw);
  assert.equal(dirty.out.code, 'DIRTY');
  assert.equal(dirty.out.lanes, undefined);
  assert.ok(existsSync(a), '레인 작업트리는 그대로');
  assert.equal(hasBranch(dir, 'lane/feat-ABC-12/a'), true);

  const forced = removeWt(dir, 'ABC-12', ['--force']);
  assert.equal(forced.status, 0, forced.raw + forced.err);
  assert.equal(forced.out.code, 'REMOVED');
  assert.equal(existsSync(a), false);
  assert.equal(hasBranch(dir, 'lane/feat-ABC-12/a'), false);
  assert.ok(existsSync(w), 'workspace 배치는 손대지 않는다');
  assert.equal(hasBranch(dir, 'lane/feat-ABC-12/w'), true);
  assert.equal(forced.out.lanes.kept.length, 1);
  assert.equal(forced.out.lanes.kept[0].pane, 'w9:p1');
  assert.match(forced.out.lanes.kept[0].reason, /herdr worktree remove/);
});

test('--remove-worktree <KEY>: 다른 이름의 브랜치(--adopt)에서 돌린 레인도 상태의 키로 찾는다 · 다른 이슈의 레인은 건드리지 않는다', () => {
  const dir = makeRepo({ init: [] });
  g(dir, 'checkout', '-q', '-b', 'fix/ABC-30-hot');
  assert.equal(run(dir, ['ABC-30']).out.code, 'STARTED'); // 상태: branch fix/ABC-30-hot · keys [ABC-30]
  const mine = makeLane(dir, 'fix-ABC-30-hot', 'a', { base: 'fix/ABC-30-hot' });
  g(dir, 'branch', 'feat/ABC-31', 'main');
  const other = makeLane(dir, 'feat-ABC-31', 'a', { base: 'feat/ABC-31' });
  g(dir, 'checkout', '-q', 'main');

  const r = removeWt(dir, 'ABC-30');
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'REMOVED');
  assert.equal(existsSync(mine), false);
  assert.equal(hasBranch(dir, 'lane/fix-ABC-30-hot/a'), false);
  assert.ok(existsSync(other), '다른 이슈의 레인 작업트리는 그대로');
  assert.equal(hasBranch(dir, 'lane/feat-ABC-31/a'), true);
});

test('--remove-worktree <KEY>: 마감해 아카이브로 옮긴 이슈도 채택한 브랜치(--adopt)의 레인을 찾는다 — 함께 옮긴 사이드카(….plan.json)를 상태로 읽지 않는다', () => {
  const dir = makeRepo({ init: [] });
  g(dir, 'checkout', '-q', '-b', 'fix/ABC-30-hot');
  assert.equal(run(dir, ['ABC-30']).out.code, 'STARTED');
  const mine = makeLane(dir, 'fix-ABC-30-hot', 'a', { base: 'fix/ABC-30-hot' });
  g(dir, 'checkout', '-q', 'main');
  // issue-complete 가 옮기는 모양 그대로 — 상태는 archive/<slug>-<YYYYMMDD-HHMM>.json, 사이드카는 같은 이름에 .plan.json(이름순으로 상태보다 뒤다)
  const arch = join(rtOf(dir), 'issues', 'archive');
  mkdirSync(arch, { recursive: true });
  renameSync(stateFile(dir, 'fix-ABC-30-hot'), join(arch, 'fix-ABC-30-hot-20261101-0900.json'));
  writeFileSync(join(arch, 'fix-ABC-30-hot-20261101-0900.plan.json'), JSON.stringify({ guides: {}, touched: [], dod: [] }));

  const r = removeWt(dir, 'ABC-30');
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'REMOVED');
  assert.equal(existsSync(mine), false, '마감한 뒤에도 그 이슈의 레인 작업트리를 치운다');
  assert.equal(hasBranch(dir, 'lane/fix-ABC-30-hot/a'), false);
});

test('--remove-worktree <KEY>: 등록은 풀렸는데 폴더만 남은 레인 자리는 치운다 — 실행기가 레인 작업트리를 파는 자리일 때만 · 장부가 가리키는 다른 폴더와 체크아웃이 든 폴더는 손대지 않는다', () => {
  const dir = makeRepo({ init: [] });
  assert.equal(startWt(dir, 'ABC-7').out.code, 'STARTED');
  const left = makeLane(dir, 'feat-ABC-7', 'a', { base: 'feat/ABC-7' });
  g(dir, 'worktree', 'remove', '--force', left); // 등록이 풀렸다
  mkdirSync(left, { recursive: true });
  writeFileSync(join(left, 'stray.log'), 'x'); // pane 이 그 폴더에 서 있어 폴더만 남은 모양
  const file = laneLedgerFile(rtOf(dir), 'feat-ABC-7');
  const cur = JSON.parse(readFileSync(file, 'utf8'));
  // y: 장부의 경로가 레인과 무관한 폴더를 가리킨다(장부가 틀렸다 — 손상 · 옛 설정 · 누가 고쳐 쓴 값). .git 이 없는 보통 폴더여도 지우면 안 된다
  const foreign = mkdtempSync(join(tmpdir(), 'jh-lane-foreign-'));
  writeFileSync(join(foreign, 'keep.txt'), 'keep');
  cur.lanes.y = { branch: 'lane/feat-ABC-7/y', path: fwd(foreign), placement: 'split', applied: 'yes' };
  // g: 레인 자리에 있지만 체크아웃이 들어 있다(등록만 풀린 작업트리 — 회수되지 않은 작업일 수 있다)
  const co = join(dirname(left), 'g');
  mkdirSync(co, { recursive: true });
  writeFileSync(join(co, '.git'), 'gitdir: elsewhere\n');
  writeFileSync(join(co, 'work.txt'), 'work');
  cur.lanes.g = { branch: 'lane/feat-ABC-7/g', path: fwd(co), placement: 'split', applied: 'skipped' };
  writeFileSync(file, JSON.stringify(cur));

  const r = removeWt(dir, 'ABC-7');
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(existsSync(left), false, '남은 폴더를 치운다');
  assert.ok(r.out.lanes.removed.some(x => x.leftover && samePath(x.path, left)), JSON.stringify(r.out.lanes));
  assert.ok(existsSync(join(foreign, 'keep.txt')), '장부가 가리킨 레인 밖의 폴더는 그대로');
  assert.ok(existsSync(join(co, 'work.txt')), '체크아웃이 든 폴더는 그대로');
  assert.equal(r.out.lanes.removed.filter(x => x.leftover).length, 1, JSON.stringify(r.out.lanes));
  assert.equal(hasBranch(dir, 'lane/feat-ABC-7/a'), false);
});

test('--remove-worktree <KEY>: herdr.worktree_dir 을 설정한 프로젝트는 그 자리에 남은 레인 폴더도 치운다 · 그 부모 폴더는 쓸지 않는다', () => {
  const dir = makeRepo({ init: [], patch: { herdr: { worktree_copy: [], worktree_init: [], worktree_dir: '.claude/runtime/lanes' } } });
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-9');
  const left = join(dir, '.claude/runtime/lanes', 'a');
  const sibling = join(dir, '.claude/runtime/lanes', 'other-issue-lane');
  for (const d of [left, sibling]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'stray.log'), 'x'); }
  const file = laneLedgerFile(rtOf(dir), 'feat-ABC-9');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ slug: 'feat-ABC-9', lanes: { a: { branch: 'lane/feat-ABC-9/a', path: fwd(left), placement: 'split', applied: 'yes' } } }));

  const r = removeWt(dir, 'ABC-9');
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'REMOVED');
  assert.equal(r.out.path, null);
  assert.equal(existsSync(left), false, '설정한 자리의 남은 레인 폴더를 치운다');
  assert.ok(existsSync(join(sibling, 'stray.log')), '같은 부모 아래 다른 폴더는 그대로');
});

test('--remove-worktree <경로>: 레인 작업트리의 경로를 주면 그 하나만 지운다 · 이슈 작업트리의 경로로 불러도 그 브랜치의 레인 잔재는 함께 치운다', () => {
  const dir = makeRepo({ init: [] });
  assert.equal(startWt(dir, 'ABC-7').out.code, 'STARTED');
  const wt = wtOf(dir, 'ABC-7');
  const a = makeLane(dir, 'feat-ABC-7', 'a', { base: 'feat/ABC-7' });
  const b = makeLane(dir, 'feat-ABC-7', 'b', { base: 'feat/ABC-7' });

  const one = removeWt(dir, a);
  assert.equal(one.status, 0, one.raw + one.err);
  assert.equal(one.out.code, 'REMOVED');
  assert.equal(one.out.lanes, undefined, '레인 작업트리의 경로는 그 하나만 지운다');
  assert.equal(existsSync(a), false);
  assert.ok(existsSync(b), '다른 레인은 그대로');
  assert.ok(existsSync(wt), '이슈 작업트리도 그대로');
  assert.equal(hasBranch(dir, 'lane/feat-ABC-7/a'), true, '브랜치는 남는다 — 이슈를 정리할 때 치운다');

  const r = removeWt(dir, wt);
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'REMOVED');
  assert.ok(samePath(r.out.path, wt));
  assert.ok(r.out.lanes, '이슈 작업트리의 경로로 불러도 레인 잔재를 본다');
  assert.deepEqual(r.out.lanes.removed.map(x => x.branch), ['lane/feat-ABC-7/b']);
  assert.deepEqual([...r.out.lanes.branches].sort(), ['lane/feat-ABC-7/a', 'lane/feat-ABC-7/b']);
  assert.deepEqual(r.out.lanes.kept, []);
  assert.equal(existsSync(b), false);
});

// ---------------------------------------------------------------- issue_worktree: always
test('issue_worktree: always — 플래그 없는 시작도 작업트리를 파고 메인 체크아웃의 브랜치는 그대로다 · 기본값(flag)은 지금 트리에서 브랜치를 만든다 · --status 가 그 자리를 안내한다', () => {
  const dir = makeRepo({ patch: { issue_worktree: 'always' } });
  const st = run(dir, ['--status']);
  assert.equal(st.out.code, 'OUTSIDE_PATTERN');
  assert.match(st.out.next, /작업트리/);
  const r = run(dir, ['ABC-7']);
  assert.equal(r.status, 0, r.raw + r.err);
  assert.equal(r.out.code, 'STARTED');
  assert.ok(samePath(r.out.worktree?.path, wtOf(dir, 'ABC-7')), JSON.stringify(r.out.worktree));
  assert.equal(r.out.worktree.created, true);
  assert.equal(g(dir, 'symbolic-ref', '--short', 'HEAD'), 'main', '메인 체크아웃의 브랜치는 그대로');
  assert.equal(g(wtOf(dir, 'ABC-7'), 'symbolic-ref', '--short', 'HEAD'), 'feat/ABC-7');
  assert.ok(existsSync(stateFile(dir, 'feat-ABC-7')), '상태는 메인 runtime 에');

  // 대조군 — 설정이 없으면(기본 flag) 지금 트리에서 브랜치를 만든다
  const d2 = makeRepo();
  assert.doesNotMatch(run(d2, ['--status']).out.next, /작업트리/);
  const r2 = run(d2, ['ABC-7']);
  assert.equal(r2.out.code, 'STARTED', r2.raw + r2.err);
  assert.equal(r2.out.worktree, undefined);
  assert.equal(g(d2, 'symbolic-ref', '--short', 'HEAD'), 'feat/ABC-7');
  assert.equal(existsSync(wtOf(d2, 'ABC-7')), false);
});

test('issue_worktree: always — 지금 트리가 이미 그 키의 이슈 브랜치면(템플릿 밖 이름이어도) 제자리에서 잇는다 · 다른 브랜치 위에서는 작업트리를 판다 · --adopt 는 지금 브랜치를 채택한다', () => {
  const dir = makeRepo({ patch: { issue_worktree: 'always' }, init: [] });
  // (a) 브랜치는 있고 상태만 없는 경우 — 새 작업트리를 파지 않는다
  g(dir, 'checkout', '-q', '-b', 'fix/ABC-9-hot');
  const keep = run(dir, ['ABC-9']);
  assert.equal(keep.status, 0, keep.raw + keep.err);
  assert.equal(keep.out.code, 'STARTED');
  assert.equal(keep.out.branch, 'fix/ABC-9-hot');
  assert.equal(keep.out.worktree, undefined);
  assert.equal(existsSync(wtOf(dir, 'ABC-9')), false);
  assert.equal(listWorktrees(dir).length, 1);
  // (b) 다른 이슈의 브랜치 위에서 새 이슈 — 지금 트리는 그대로 두고 작업트리를 판다
  const other = run(dir, ['ABC-10']);
  assert.equal(other.out.code, 'STARTED', other.raw + other.err);
  assert.ok(samePath(other.out.worktree?.path, wtOf(dir, 'ABC-10')), JSON.stringify(other.out.worktree));
  assert.equal(g(dir, 'symbolic-ref', '--short', 'HEAD'), 'fix/ABC-9-hot');
  // (c) 패턴 밖 브랜치 — 플래그가 없으면 작업트리(ON_OTHER_BRANCH 로 멈추지 않는다) · --adopt 면 그 브랜치를 채택한다
  g(dir, 'checkout', '-q', '-b', 'spike/x');
  const wt11 = run(dir, ['ABC-11']);
  assert.equal(wt11.out.code, 'STARTED', wt11.raw + wt11.err);
  assert.ok(samePath(wt11.out.worktree?.path, wtOf(dir, 'ABC-11')), JSON.stringify(wt11.out.worktree));
  const ad = run(dir, ['ABC-12', '--adopt']);
  assert.equal(ad.status, 0, ad.raw + ad.err);
  assert.equal(ad.out.code, 'ADOPTED');
  assert.equal(ad.out.branch, 'spike/x');
  assert.equal(ad.out.worktree, undefined);
  assert.equal(existsSync(wtOf(dir, 'ABC-12')), false);
  assert.equal(g(dir, 'symbolic-ref', '--short', 'HEAD'), 'spike/x');
});
