// memory-index.mjs 의 node --test 스위트.
// 블랙박스로 검증한다(자식 프로세스로 CLI 실행 + --json 출력 파싱) — --add 동시성 시험이
// 실제 OS 프로세스 2개를 요구하므로, 다른 시험도 같은 방식으로 통일했다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'memory-index.mjs');
const FIXTURES = join(__dirname, 'fixtures', 'memory');

function freshDir(fixtureName) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-index-test-'));
  cpSync(join(FIXTURES, fixtureName), dir, { recursive: true });
  return dir;
}

function run(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  assert.equal(res.error, undefined, `spawn 에러: ${res.error}`);
  return res;
}

function runJson(args) {
  const res = run(args);
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    throw new Error(`--json 출력이 JSON 이 아님: ${err.message}\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  }
  return { ...res, parsed };
}

function spawnAsync(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => resolve(code));
  });
}

// ---------- check 모드: basic 픽스처(위반 포함) ----------

test('check: basic 픽스처에서 고아 1건(orphan-d.md)을 검출한다', () => {
  const dir = freshDir('basic');
  const { parsed } = runJson(['--dir', dir, '--json']);
  assert.deepEqual(parsed.orphans, ['orphan-d.md']);
  rmSync(dir, { recursive: true, force: true });
});

test('check: basic 픽스처에서 깨진 인덱스 링크 1건(topic-missing.md)을 검출한다', () => {
  const dir = freshDir('basic');
  const { parsed } = runJson(['--dir', dir, '--json']);
  assert.equal(parsed.broken_index_links.length, 1);
  assert.equal(parsed.broken_index_links[0].source, 'MEMORY.md');
  assert.equal(parsed.broken_index_links[0].target, 'topic-missing.md');
  rmSync(dir, { recursive: true, force: true });
});

test('check: basic 픽스처에서 깨진 [[name]] 링크 1건(topic-b.md 안의 [[topic-ghost]])을 검출한다', () => {
  const dir = freshDir('basic');
  const { parsed } = runJson(['--dir', dir, '--json']);
  assert.equal(parsed.broken_wiki_links.length, 1);
  assert.equal(parsed.broken_wiki_links[0].source, 'topic-b.md');
  assert.equal(parsed.broken_wiki_links[0].name, 'topic-ghost');
  assert.equal(parsed.broken_wiki_links[0].expected, 'topic-ghost.md');
  rmSync(dir, { recursive: true, force: true });
});

test('check: MEMORY.md -> ARCHIVE.md -> topic-b.md 의 2단 도달을 따라가 topic-b.md 는 고아로 잡지 않는다', () => {
  const dir = freshDir('basic');
  const { parsed } = runJson(['--dir', dir, '--json']);
  assert.ok(!parsed.orphans.includes('topic-b.md'), '2단 도달한 파일이 orphan 으로 잘못 잡힘');
  assert.ok(!parsed.orphans.includes('ARCHIVE.md'), 'ARCHIVE.md 자체도 MEMORY.md 에서 직접 링크되어 orphan 이 아님');
  rmSync(dir, { recursive: true, force: true });
});

test('check: basic 픽스처는 깨진 링크가 있어 exit 1', () => {
  const dir = freshDir('basic');
  const { status } = run(['--dir', dir, '--json']);
  assert.equal(status, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- check 모드: clean 픽스처(위반 없음) ----------

test('check: clean 픽스처는 orphan/깨진 링크가 0건이고 exit 0', () => {
  const dir = freshDir('clean');
  const { parsed, status } = runJson(['--dir', dir, '--json']);
  assert.deepEqual(parsed.orphans, []);
  assert.deepEqual(parsed.broken_index_links, []);
  assert.deepEqual(parsed.broken_wiki_links, []);
  assert.equal(parsed.ok, true);
  assert.equal(status, 0);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- 위반 주입: limit 초과 ----------

test('위반 주입: --limit 을 파일 크기보다 작게 주면 over_limit=true 이고 exit 1', () => {
  const dir = freshDir('clean'); // 링크 위반이 섞이지 않도록 clean 픽스처에 순수 크기 위반만 주입
  const before = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  const chars = Array.from(before).length;
  assert.ok(chars > 5, '픽스처 MEMORY.md 가 너무 작아 limit 위반 시험이 무의미함');

  const { parsed, status } = runJson(['--dir', dir, '--limit', String(chars - 1), '--target', '1', '--json']);
  assert.equal(parsed.size.over_limit, true);
  assert.equal(status, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('반증: 위반 없이 넉넉한 --limit 을 주면 clean 픽스처는 exit 0 그대로', () => {
  const dir = freshDir('clean');
  const { parsed, status } = runJson(['--dir', dir, '--limit', '999999', '--json']);
  assert.equal(parsed.size.over_limit, false);
  assert.equal(status, 0);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- --add ----------

test('--add: 인덱스 맨 위에 새 줄을 추가한다', () => {
  const dir = freshDir('clean');
  const before = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  const line = '- [새 항목](topic-a.md)';

  const { parsed } = runJson(['--dir', dir, '--add', line, '--json']);
  assert.equal(parsed.add.added, true);

  const after = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  assert.equal(after, `${line}\n${before}`);
  rmSync(dir, { recursive: true, force: true });
});

test('--add: 같은 줄이 이미 있으면 멱등 — 파일이 바뀌지 않는다', () => {
  const dir = freshDir('clean');
  const before = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  const firstLine = before.split('\n')[0];

  const { parsed } = runJson(['--dir', dir, '--add', firstLine, '--json']);
  assert.equal(parsed.add.added, false);
  assert.equal(parsed.add.reason, 'duplicate');

  const after = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  assert.equal(after, before);
  rmSync(dir, { recursive: true, force: true });
});

test('--add: MEMORY.md 가 아직 없는 폴더에서도 새로 만들어 한 줄을 넣는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-index-test-'));
  const line = '- [첫 항목](topic-a.md)';
  const { parsed, status } = runJson(['--dir', dir, '--add', line, '--json']);
  assert.equal(parsed.add.added, true);
  assert.equal(status, 1); // topic-a.md 가 실존하지 않아 broken_index_links 1건 — add 자체는 성공
  const after = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  assert.equal(after, `${line}\n`);
  rmSync(dir, { recursive: true, force: true });
});

test('--add 동시성: 두 프로세스가 동시에 --add 해도 두 줄이 모두 남는다(잠금으로 유실 방지)', async () => {
  const dir = freshDir('clean');
  const lineA = '- [동시성 A](topic-a.md)';
  const lineB = '- [동시성 B](topic-b.md)';

  const [codeA, codeB] = await Promise.all([
    spawnAsync(['--dir', dir, '--add', lineA]),
    spawnAsync(['--dir', dir, '--add', lineB]),
  ]);
  assert.equal(codeA, 0);
  assert.equal(codeB, 0);

  const after = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  const lines = after.split('\n').filter(Boolean);
  assert.ok(after.includes(lineA), `A 줄이 없음:\n${after}`);
  assert.ok(after.includes(lineB), `B 줄이 없음:\n${after}`);
  // 원래 3줄 + 새 줄 2개 = 5줄. 유실됐다면 4줄 이하가 된다.
  assert.equal(lines.length, 5, `줄 수가 안 맞음(유실 의심):\n${after}`);
  rmSync(dir, { recursive: true, force: true });
});

// 위 단일 실행 시험은 통과해도, 잠금 안의 "stat 이 그 사이 release 로 ENOENT 될 수 있다" 류의
// 좁은 레이스는 한 번으로는 거의 안 걸린다(실측 ~1%) — 새 임시 폴더로 여러 판을 돌려
// 누적 유실 0건을 확인해야 회귀 방지 효과가 있다.
test('--add 동시성(반복): 새 폴더로 40판을 돌려도 누적 유실 0건', async () => {
  const ROUNDS = 40;
  let lost = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const dir = freshDir('clean');
    const lineA = `- [반복 동시성 A ${i}](topic-a.md)`;
    const lineB = `- [반복 동시성 B ${i}](topic-b.md)`;
    const [codeA, codeB] = await Promise.all([
      spawnAsync(['--dir', dir, '--add', lineA]),
      spawnAsync(['--dir', dir, '--add', lineB]),
    ]);
    const after = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
    const ok = codeA === 0 && codeB === 0 && after.includes(lineA) && after.includes(lineB);
    if (!ok) {
      lost++;
      console.error(`  round ${i}: codeA=${codeA} codeB=${codeB} hasA=${after.includes(lineA)} hasB=${after.includes(lineB)}`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(lost, 0, `${ROUNDS}판 중 ${lost}판에서 동시-add 유실 발생`);
});

// ---------- 사용법 오류 ----------

test('--dir 없이 실행하면 exit 2(실행 오류)', () => {
  const { status, stderr } = run(['--json']);
  assert.equal(status, 2);
  assert.match(stderr, /--dir/);
});

test('존재하지 않는 디렉터리를 --dir 로 주면 exit 2', () => {
  const { status } = run(['--dir', join(tmpdir(), 'memory-index-does-not-exist-xyz'), '--json']);
  assert.equal(status, 2);
});
