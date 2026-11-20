// lib/worktree.mjs 실측 — 작업트리 준비·안전 제거.
// 판정축: 링크는 끊되 가리키는 쪽 내용은 남는다 · 커밋 안 된 변경이 있으면 force 없이는 안 지운다(링크도 그대로) · 메인 체크아웃과 미등록 경로는 거부 ·
//         준비(복사·초기화)는 작업트리 안에서 돈다 · 로컬 제외 목록은 커밋되는 .gitignore 를 건드리지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, symlinkSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { listWorktrees, prepareWorktree, unlinkLinks, removeDirSafely, removeWorktree, ensureLocallyIgnored, samePath } from '../lib/worktree.mjs';

function g(cwd, ...args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

/** 임시 저장소(main 1커밋) + 링크가 가리킬 바깥 폴더(대상) */
function makeRepo() {
  const base = mkdtempSync(join(tmpdir(), 'cw-wt-'));
  const repo = join(base, 'repo'); const target = join(base, 'shared');
  mkdirSync(repo, { recursive: true }); mkdirSync(join(target, 'pkg'), { recursive: true });
  writeFileSync(join(target, 'pkg', 'keep.txt'), 'keep');
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'test@example.com');
  g(repo, 'config', 'user.name', 'test');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\nlocal.env\n');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  writeFileSync(join(repo, 'local.env'), 'K=V\n'); // git 이 무시하는 로컬 파일 — 준비가 복사해 줄 것
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'init');
  return { base, repo, target, kept: join(target, 'pkg', 'keep.txt') };
}
/** 작업트리를 하나 파고, 그 안 두 자리(루트·하위 폴더)에 대상 폴더로 가는 링크를 건다 */
function addWorktree(r, name) {
  const wt = join(r.base, name);
  g(r.repo, 'worktree', 'add', '-q', '-b', `lane/${name}`, wt, 'HEAD');
  symlinkSync(r.target, join(wt, 'node_modules'), 'junction');
  mkdirSync(join(wt, 'sub', 'deep'), { recursive: true });
  symlinkSync(r.target, join(wt, 'sub', 'deep', 'node_modules'), 'junction');
  return wt;
}

test('unlinkLinks — 링크만 끊고 가리키는 쪽은 남긴다(하위 폴더의 링크까지 · 링크 안으로는 들어가지 않는다)', () => {
  const r = makeRepo(); const wt = addWorktree(r, 'w1');
  const out = unlinkLinks(wt);
  assert.deepEqual(out.cut.sort(), ['node_modules', 'sub/deep/node_modules']);
  assert.deepEqual(out.failed, []);
  assert.equal(isLink(join(wt, 'node_modules')), false);
  assert.equal(existsSync(join(wt, 'sub', 'deep')), true, '링크가 아닌 폴더는 남는다');
  assert.equal(readFileSync(r.kept, 'utf8'), 'keep', '대상 폴더의 내용은 그대로다');
});

test('removeWorktree — 링크가 있어도 폴더까지 지우고, 대상 내용과 브랜치는 남는다', () => {
  const r = makeRepo(); const wt = addWorktree(r, 'w2');
  const out = removeWorktree(wt, { repoDir: r.repo });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.unlinked.sort(), ['node_modules', 'sub/deep/node_modules']);
  assert.equal(existsSync(wt), false, '작업트리 폴더가 남지 않는다');
  assert.equal(readFileSync(r.kept, 'utf8'), 'keep');
  assert.equal(listWorktrees(r.repo).some(w => samePath(w.path, wt)), false, '등록이 풀렸다');
  assert.match(g(r.repo, 'branch', '--list', 'lane/w2'), /lane\/w2/, '브랜치는 지우지 않는다');
});

test('removeWorktree — 커밋 안 된 변경이 있으면 force 없이는 지우지 않고 링크도 그대로 둔다', () => {
  const r = makeRepo(); const wt = addWorktree(r, 'w3');
  writeFileSync(join(wt, 'a.txt'), 'changed\n');
  writeFileSync(join(wt, 'new.txt'), 'new\n');
  const refused = removeWorktree(wt, { repoDir: r.repo });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'DIRTY');
  assert.equal(refused.dirty.length, 2);
  assert.equal(existsSync(join(wt, 'new.txt')), true);
  assert.equal(isLink(join(wt, 'node_modules')), true, '거부했으면 링크를 끊지 않는다');
  const forced = removeWorktree(wt, { repoDir: r.repo, force: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(existsSync(wt), false);
  assert.equal(readFileSync(r.kept, 'utf8'), 'keep');
});

test('removeWorktree — 메인 체크아웃과 등록되지 않은 경로는 거부한다', () => {
  const r = makeRepo();
  assert.equal(removeWorktree(r.repo, { repoDir: r.repo, force: true }).code, 'MAIN_WORKTREE');
  assert.equal(existsSync(join(r.repo, 'a.txt')), true);
  const stray = join(r.base, 'stray'); mkdirSync(stray);
  assert.equal(removeWorktree(stray, { repoDir: r.repo, force: true }).code, 'NOT_A_WORKTREE');
  assert.equal(existsSync(stray), true);
});

test('removeDirSafely — 등록 안 된 잔재 폴더도 링크를 끊고 지운다', () => {
  const r = makeRepo();
  const left = join(r.base, 'leftover'); mkdirSync(join(left, 'x'), { recursive: true });
  symlinkSync(r.target, join(left, 'x', 'node_modules'), 'junction');
  const out = removeDirSafely(left);
  assert.equal(out.ok, true);
  assert.deepEqual(out.unlinked, ['x/node_modules']);
  assert.equal(existsSync(left), false);
  assert.equal(readFileSync(r.kept, 'utf8'), 'keep');
});

test('listWorktrees — 첫 항목이 메인이고 브랜치를 읽는다', () => {
  const r = makeRepo(); const wt = addWorktree(r, 'w4');
  const list = listWorktrees(r.repo);
  assert.equal(list.length, 2);
  assert.equal(list[0].main, true);
  assert.equal(list[0].branch, 'main');
  const mine = list.find(w => samePath(w.path, wt));
  assert.equal(mine.branch, 'lane/w4');
  assert.equal(mine.main, false);
});

test('prepareWorktree — 무시 파일을 복사하고(없는 것은 skipped) 초기화 명령을 작업트리 안에서 돈다 · 실패하면 그 뒤는 돌지 않는다', () => {
  const r = makeRepo(); const wt = join(r.base, 'w5');
  g(r.repo, 'worktree', 'add', '-q', '-b', 'lane/w5', wt, 'HEAD');
  const mark = `node -e "require('fs').writeFileSync('init-marker.txt', process.cwd())"`;
  const out = prepareWorktree(wt, { repoDir: r.repo, copy: ['local.env', 'missing.env'], init: [mark, 'node -e "process.exit(3)"', mark.replace('init-marker', 'never')], cfg: {}, env: process.env });
  assert.deepEqual(out.copied, ['local.env']);
  assert.deepEqual(out.skipped, ['missing.env']);
  assert.equal(readFileSync(join(wt, 'local.env'), 'utf8'), 'K=V\n');
  assert.equal(samePath(readFileSync(join(wt, 'init-marker.txt'), 'utf8'), wt), true, '초기화 명령의 cwd 는 작업트리다');
  assert.deepEqual(out.init.map(i => i.exit), [0, 3], '실패한 명령에서 멈춘다');
  assert.equal(existsSync(join(wt, 'never.txt')), false);
});

test('ensureLocallyIgnored — 무시되지 않는 폴더는 로컬 제외 목록에 더하고(.gitignore 는 그대로) 이미 무시되면 그대로 둔다', () => {
  const r = makeRepo(); const wt = join(r.base, 'w6');
  g(r.repo, 'worktree', 'add', '-q', '-b', 'lane/w6', wt, 'HEAD');
  const dir = join(r.repo, '.claude', 'worktrees');
  assert.equal(ensureLocallyIgnored(r.repo, dir), 'added');
  assert.equal(ensureLocallyIgnored(r.repo, dir), 'ignored');
  assert.match(readFileSync(join(r.repo, '.git', 'info', 'exclude'), 'utf8'), /^\/\.claude\/worktrees\/$/m);
  assert.equal(readFileSync(join(r.repo, '.gitignore'), 'utf8'), 'node_modules/\nlocal.env\n', '커밋되는 .gitignore 는 건드리지 않는다');
  mkdirSync(join(dir, 'x'), { recursive: true }); writeFileSync(join(dir, 'x', 'f.txt'), 'f');
  assert.equal(g(r.repo, 'status', '--porcelain'), '', '메인 체크아웃의 비추적 파일로 잡히지 않는다');
  assert.equal(ensureLocallyIgnored(wt, join(wt, 'tmp-out')), 'added', '작업트리에서 불러도 공용 제외 목록(<git-common-dir>/info/exclude)에 쓴다');
  assert.match(readFileSync(join(r.repo, '.git', 'info', 'exclude'), 'utf8'), /^\/tmp-out\/$/m);
  assert.equal(ensureLocallyIgnored(r.repo, join(r.base, 'outside')), 'outside', '저장소 밖 경로는 할 일이 없다');
});
