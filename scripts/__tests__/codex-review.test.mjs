// codex-review.test.mjs — scripts/codex-review.sh 통합 테스트.
// 임시 git 저장소 + PATH 맨 앞에 가짜 `codex` 실행 파일을 두고, FAKE_CODEX_MODE 로 4가지 시나리오를 재현한다.
// win32 이면 Git Bash 를 직접 호출한다(bash.exe 를 spawnSync 의 실행 파일로 — PATH lookup 이 필요 없다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'codex-review.sh');
const BASH = process.platform === 'win32'
  ? (existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash')
  : 'bash';

function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const CODEX_FAKE = `#!/usr/bin/env bash
case "\${FAKE_CODEX_MODE:-2}" in
  1)
    echo "BLOCKER: a.txt:1 — 문제 X"
    echo "BLOCKER: b.txt:3 — 문제 Y"
    echo "Verdict: BLOCK"
    exit 0
    ;;
  2)
    echo "이슈를 찾지 못했습니다"
    echo "Verdict: PASS"
    exit 0
    ;;
  3)
    echo "You have hit your usage limit. Please try again later."
    exit 1
    ;;
  4)
    sleep 30
    exit 0
    ;;
esac
`;

/** 임시 git 저장소: main 에 a.txt 커밋 → feat/ABC-1 브랜치 → a.txt 수정 커밋(=sinceTree 지점) → b.txt 스테이징(미커밋). */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'jh-codex-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'core.autocrlf', 'false');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify({
    version: 3, mode: 'auto', issue_prefix: 'ABC',
    branch_pattern: '^(feat|fix)/(?<keys>ABC-\\d+(?:-\\d+)*)(?:-[a-z0-9]+)*$',
    default_branch: 'main', runtime_dir: '.claude/rt',
    stacks: {},
  }, null, 2) + '\n');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  writeFileSync(join(dir, 'a.txt'), 'hello\nworld\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'change a');
  const sinceTree = g(dir, 'rev-parse', 'HEAD^{tree}');
  writeFileSync(join(dir, 'b.txt'), 'extra\n');
  g(dir, 'add', '-A'); // staged, uncommitted
  return { dir, sinceTree };
}

function makeFixtureBin() {
  const bin = mkdtempSync(join(tmpdir(), 'jh-codex-bin-'));
  const file = join(bin, 'codex');
  writeFileSync(file, CODEX_FAKE);
  chmodSync(file, 0o755);
  return bin;
}

/**
 * PATH 에서 실제 codex 가 설치된 디렉터리를 제거 — "codex 가 PATH 에 없다" 를 진짜로 재현한다.
 * ⚠ existsSync 로 PATH 전체를 스캔하면 도메인 환경의 매핑된 네트워크 경로에서 무한정 걸릴 수 있어
 *   파일시스템 접근 없이 문자열 매칭만 한다(npm 전역 설치 경로 nodejs/nvm 배제로 충분).
 */
function pathWithoutRealCodex() {
  return process.env.PATH.split(delimiter).filter(dir => dir && !/[\\/](nodejs|nvm)(?:[\\/]|$)/i.test(dir)).join(delimiter);
}
function pathWithFixture(binDir) {
  return [binDir, pathWithoutRealCodex()].join(delimiter);
}

// 부하가 심한 환경에서는 프로세스 기동 자체가 오래 걸릴 수 있어 여유 있게(3분) 잡는다 —
// 진짜 무응답이면 ETIMEDOUT 으로 명확히 드러나고, r.error 를 실패 메시지에 실어 진단 가능하게 한다.
function run(dir, args, env) {
  const r = spawnSync(BASH, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 180_000, env: { ...process.env, ...env } });
  const stdout = r.stdout ?? '';
  const lastLine = stdout.trim().split(/\r?\n/).pop() ?? '';
  const m = /^CODEX_RESULT=(\{.*\})$/.exec(lastLine);
  if (!m) {
    throw new Error(`CODEX_RESULT 파싱 실패 (status=${r.status} error=${r.error?.message ?? '-'})\n--- stdout ---\n${stdout}\n--- stderr ---\n${r.stderr ?? ''}`);
  }
  return { status: r.status, stderr: r.stderr, stdout, result: JSON.parse(m[1]) };
}

test('BLOCK 판정: BLOCKER 2건 카운트, verdict=BLOCK, status=ok, exit 0', () => {
  const { dir } = makeRepo();
  const bin = makeFixtureBin();
  const r = run(dir, [], { PATH: pathWithFixture(bin), FAKE_CODEX_MODE: '1' });
  assert.equal(r.result.status, 'ok');
  assert.equal(r.result.verdict, 'BLOCK');
  assert.equal(r.result.blockers, 2);
  assert.equal(r.status, 0);
  assert.ok(existsSync(r.result.out), `out 파일 없음: ${r.result.out}`);
  const body = readFileSync(r.result.out, 'utf8');
  assert.match(body, /^# Codex Review/);
  assert.match(body, /- branch: feat\/ABC-1/);
  assert.match(body, /- files: \d+/);
  assert.match(body, /- model: /);
  assert.match(body, /- timestamp: \d{8}T\d{6}Z/);
  assert.match(body, /Verdict: BLOCK/);
});

test('PASS 판정: blockers=0, verdict=PASS, exit 0', () => {
  const { dir } = makeRepo();
  const bin = makeFixtureBin();
  const r = run(dir, [], { PATH: pathWithFixture(bin), FAKE_CODEX_MODE: '2' });
  assert.equal(r.result.status, 'ok');
  assert.equal(r.result.verdict, 'PASS');
  assert.equal(r.result.blockers, 0);
  assert.equal(r.status, 0);
});

test('사용량 한도 문구 → status=limit, exit 1 (codex exit code 는 1 이어도 문구로 판정)', () => {
  const { dir } = makeRepo();
  const bin = makeFixtureBin();
  const r = run(dir, [], { PATH: pathWithFixture(bin), FAKE_CODEX_MODE: '3' });
  assert.equal(r.result.status, 'limit');
  assert.equal(r.status, 1);
  assert.ok(r.result.reason && r.result.reason.length > 0);
});

test('무진행 → 하드 타임아웃 → status=fail, exit 1', () => {
  const { dir } = makeRepo();
  const bin = makeFixtureBin();
  const r = run(dir, ['--timeout', '2'], { PATH: pathWithFixture(bin), FAKE_CODEX_MODE: '4', CODEX_POLL_INTERVAL: '1' });
  assert.equal(r.result.status, 'fail');
  assert.equal(r.status, 1);
  assert.match(r.result.reason, /timeout/);
});

test('--since 는 델타 파일만 잡아 기본 모드보다 files 가 적다', () => {
  const { dir, sinceTree } = makeRepo();
  const bin = makeFixtureBin();
  const full = run(dir, [], { PATH: pathWithFixture(bin), FAKE_CODEX_MODE: '2' });
  const delta = run(dir, ['--since', sinceTree], { PATH: pathWithFixture(bin), FAKE_CODEX_MODE: '2' });
  assert.equal(full.result.status, 'ok');
  assert.equal(delta.result.status, 'ok');
  assert.equal(full.result.files, 2, 'a.txt(커밋) + b.txt(스테이징) = 2');
  assert.equal(delta.result.files, 1, 'sinceTree 이후 바뀐 건 b.txt 하나');
  assert.ok(delta.result.files < full.result.files);
});

test('codex 가 PATH 에 없으면 status=missing, exit 1, 조용히 통과시키지 않는다', () => {
  const { dir } = makeRepo();
  const r = run(dir, [], { PATH: pathWithoutRealCodex(), FAKE_CODEX_MODE: '2' });
  assert.equal(r.result.status, 'missing');
  assert.equal(r.status, 1);
  assert.ok(existsSync(r.result.out), 'missing 이어도 out 파일은 메타와 함께 남는다');
  const body = readFileSync(r.result.out, 'utf8');
  assert.match(body, /PATH 에서 찾을 수 없어/);
});

test('runtime_dir 는 harness.json 값을 따른다(기본 .claude/runtime 이 아니라 .claude/rt)', () => {
  const { dir } = makeRepo();
  const bin = makeFixtureBin();
  const r = run(dir, [], { PATH: pathWithFixture(bin), FAKE_CODEX_MODE: '2' });
  assert.match(r.result.out.replace(/\\/g, '/'), /\/\.claude\/rt\/review\//);
});
