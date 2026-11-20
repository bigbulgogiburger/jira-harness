// 경로 목록 — git 이 ASCII 밖 글자가 든 경로를 따옴표·8진수로 바꿔 내는 설정(core.quotepath=true · git 기본값)에서도 경로를 글자 그대로 받는다.
// 줄 단위로 받으면 그 경로가 스택 paths · docs_only_paths · lint 대상 glob · 지문 제외 glob 어디에도 걸리지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { stagedFiles, unstagedFiles, untrackedFiles, changedVsHead, branchChangedFiles, pushChangedFiles, changedBetweenTrees } from '../lib/git.mjs';
import { fingerprintTree } from '../lib/tree.mjs';

function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function put(dir, rel, text) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'jh-paths-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com'); g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'config', 'core.quotepath', 'true'); // 사용자 전역 설정이 꺼 두었어도 이 테스트는 git 기본 동작(따옴표)을 잰다
  put(dir, 'src/app.js', '1\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const KO = 'src/한글 이름.js';

test('경로 목록 7종: 한글·공백이 든 경로를 글자 그대로 낸다 — git 이 줄 단위 출력에서 따옴표·8진수로 바꿔 내는 설정에서도', () => {
  const dir = repo();
  put(dir, KO, 'x\n');
  // 대조군: 이 저장소에서 줄 단위 출력은 정말로 따옴표가 붙는다 — 재려는 조건이 켜져 있다
  assert.match(g(dir, 'ls-files', '--others', '--exclude-standard'), /^"src\/\\355/m);
  assert.deepEqual(untrackedFiles(dir), [KO]);
  const t0 = g(dir, 'rev-parse', 'HEAD^{tree}');
  g(dir, 'add', '-A');
  assert.deepEqual(stagedFiles(dir), [KO]);
  assert.deepEqual(changedVsHead(dir), [KO]);
  assert.deepEqual(changedBetweenTrees(t0, g(dir, 'write-tree'), dir), [KO]);
  g(dir, 'checkout', '-q', '-b', 'feat/x');
  g(dir, 'commit', '-q', '-m', 'ko');
  assert.deepEqual(branchChangedFiles(dir, 'main'), [KO]);
  assert.deepEqual(pushChangedFiles(dir, 'main'), [KO], 'upstream 이 없으면 기본 브랜치와의 merge-base 기준');
  put(dir, KO, 'y\n');
  assert.deepEqual(unstagedFiles(dir), [KO]);
});

test('지문: 제외 glob 에 걸린 한글 이름 파일도 지문에서 빠진다 · 제외하지 않은 파일은 지문을 바꾼다', () => {
  const dir = repo();
  const excludes = ['**/*.draft'];
  const base = fingerprintTree({ cwd: dir, base: 'index', excludes });
  put(dir, 'docs/가이드 초안.md.draft', 'draft\n'); g(dir, 'add', '-A');
  assert.equal(fingerprintTree({ cwd: dir, base: 'index', excludes }), base, '제외한 파일은 지문을 바꾸지 않는다');
  put(dir, 'docs/plain.md.draft', 'draft\n'); g(dir, 'add', '-A');
  assert.equal(fingerprintTree({ cwd: dir, base: 'index', excludes }), base, 'ASCII 이름도 종전대로 빠진다');
  put(dir, 'docs/가이드.md', 'doc\n'); g(dir, 'add', '-A');
  assert.notEqual(fingerprintTree({ cwd: dir, base: 'index', excludes }), base);
});
