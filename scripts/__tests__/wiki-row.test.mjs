// wiki-row.mjs 시험 — 표 행 upsert 의 멱등·보존·거부 축.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'wiki-row.mjs');
const FIX = join(HERE, 'fixtures');

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** 픽스처를 임시 디렉토리로 복사한다. crlf=true 면 줄끝을 CRLF 로 바꿔 쓴다. */
function copyFixture(name, { crlf = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-row-'));
  const dst = join(dir, name);
  let text = readFileSync(join(FIX, name), 'utf8');
  if (crlf) text = text.replace(/\r?\n/g, '\r\n');
  writeFileSync(dst, text, 'utf8');
  return dst;
}

describe('wiki-row — upsert', () => {
  test('기존 행 갱신 — 다른 행은 바이트 그대로, 두 번째 실행은 변경 없음(멱등)', () => {
    const f = copyFixture('table-single.md');
    const before = readFileSync(f, 'utf8');
    const otherRow = before.split('\n').find(l => l.includes('ABC-2'));

    const r1 = run(['--index', f, '--key', 'ABC-1', '--set', 'Status=closed', '--set', 'Note=고침']);
    assert.equal(r1.code, 0, r1.err);
    const after1 = readFileSync(f, 'utf8');
    assert.match(after1, /\| ABC-1 \| closed \| 고침 \|/);
    assert.ok(after1.split('\n').includes(otherRow), '건드리지 않은 행이 보존돼야 한다');
    assert.match(after1, /표 뒤의 본문은 그대로 보존돼야 한다/);

    const r2 = run(['--index', f, '--key', 'ABC-1', '--set', 'Status=closed', '--set', 'Note=고침', '--json']);
    assert.equal(r2.code, 0, r2.err);
    assert.equal(JSON.parse(r2.out).action, 'unchanged');
    assert.equal(readFileSync(f, 'utf8'), after1, '두 번 실행해도 파일이 같아야 한다');
  });

  test('새 행 추가 — 미지정 열은 "-", 정렬 규약 없으면 표 끝', () => {
    const f = copyFixture('table-single.md');
    const r = run(['--index', f, '--key', 'ABC-9', '--set', 'Status=open', '--json']);
    assert.equal(r.code, 0, r.err);
    const res = JSON.parse(r.out);
    assert.equal(res.action, 'inserted');
    assert.deepEqual(res.columns, ['Key', 'Status', 'Note']);
    const lines = readFileSync(f, 'utf8').split('\n');
    const idx = lines.findIndex(l => l.startsWith('| ABC-9 '));
    assert.equal(lines[idx], '| ABC-9 | open | - |');
    assert.ok(lines[idx - 1].includes('ABC-2'), '표 끝에 붙어야 한다');
  });

  test('정렬이 내림차순인 표에는 맨 위로 추가된다', () => {
    const f = copyFixture('table-multi.md');
    const r = run(['--index', f, '--section', '이슈 가이드', '--key', 'ABC-130', '--set', 'Status=planned', '--set', 'Title=새 이슈']);
    assert.equal(r.code, 0, r.err);
    const lines = readFileSync(f, 'utf8').split('\n');
    const sep = lines.findIndex(l => /^\|-+\|/.test(l));
    assert.equal(lines[sep + 1], '| ABC-130 | planned | 새 이슈 | - |');
  });

  test('--insert end 로 강제하면 표 끝에 붙는다', () => {
    const f = copyFixture('table-multi.md');
    run(['--index', f, '--section', '이슈 가이드', '--key', 'ABC-130', '--set', 'Status=planned', '--insert', 'end']);
    const lines = readFileSync(f, 'utf8').split('\n');
    const idx = lines.findIndex(l => l.startsWith('| ABC-130 '));
    assert.ok(lines[idx - 1].includes('ABC-123'), '표 끝(마지막 본문 행 뒤)에 붙어야 한다');
  });

  test('--key-col 로 키 열을 바꿀 수 있다', () => {
    const f = copyFixture('table-single.md');
    const r = run(['--index', f, '--key-col', 'Note', '--key', '둘째 행', '--set', 'Status=hold', '--json']);
    assert.equal(r.code, 0, r.err);
    const res = JSON.parse(r.out);
    assert.equal(res.action, 'updated');
    assert.equal(res.key_col, 'Note');
    assert.match(readFileSync(f, 'utf8'), /\| ABC-2 \| hold \| 둘째 행 \|/);
  });
});

describe('wiki-row — 표 본문의 빈 줄', () => {
  // 실물 INDEX 회귀 — 빈 줄 아래 행을 못 보면 "행이 없다" 며 중복 행을 새로 만든다.
  test('빈 줄 아래의 행도 찾아서 갱신한다 (중복 생성 금지)', () => {
    const f = copyFixture('table-gap.md');
    const r = run(['--index', f, '--key', 'ABC-3', '--set', 'Status=closed', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).action, 'updated', '빈 줄 아래 행을 못 보면 inserted 가 된다');
    const text = readFileSync(f, 'utf8');
    assert.equal(text.split('\n').filter(l => l.startsWith('| ABC-3 ')).length, 1);
    assert.match(text, /\| ABC-3 \| closed \| 그 다음 행 \|/);
    assert.match(text, /빈 줄 위 \|\n\n\| ABC-2 /, '빈 줄 자체는 그대로 둔다 (lint L11 이 보고)');
  });

  test('빈 줄이 있어도 표 끝 추가는 마지막 행 뒤다', () => {
    const f = copyFixture('table-gap.md');
    run(['--index', f, '--key', 'ABC-9', '--set', 'Status=open', '--insert', 'end']);
    const lines = readFileSync(f, 'utf8').split('\n');
    const idx = lines.findIndex(l => l.startsWith('| ABC-9 '));
    assert.ok(lines[idx - 1].includes('ABC-3'));
  });
});

describe('wiki-row — 거부(fail-closed)', () => {
  test('표가 여러 개인데 --section 이 없으면 exit 1 + 섹션 안내', () => {
    const f = copyFixture('table-multi.md');
    const before = readFileSync(f, 'utf8');
    const r = run(['--index', f, '--key', 'ABC-130', '--set', 'Status=planned']);
    assert.equal(r.code, 1);
    assert.match(r.err, /표가 여러 개/);
    assert.match(r.err, /이슈 가이드/);
    assert.match(r.err, /회의 \(결정 기록\)/);
    assert.equal(readFileSync(f, 'utf8'), before, '거부 시 파일을 건드리지 않는다');
  });

  test('모르는 열 이름이면 exit 1 + 실제 열 목록', () => {
    const f = copyFixture('table-single.md');
    const before = readFileSync(f, 'utf8');
    const r = run(['--index', f, '--key', 'ABC-1', '--set', 'Owner=나']);
    assert.equal(r.code, 1);
    assert.match(r.err, /모르는 열 "Owner"/);
    assert.match(r.err, /Key, Status, Note/);
    assert.equal(readFileSync(f, 'utf8'), before);
  });

  test('없는 섹션이면 exit 1 + 후보 나열', () => {
    const f = copyFixture('table-multi.md');
    const r = run(['--index', f, '--section', '없는섹션', '--key', 'ABC-1', '--set', 'Status=open']);
    assert.equal(r.code, 1);
    assert.match(r.err, /해당하는 섹션이 없습니다/);
  });

  test('행이 없고 --set 도 없으면 새 행을 만들지 않고 exit 1', () => {
    const f = copyFixture('table-single.md');
    const r = run(['--index', f, '--key', 'ABC-99']);
    assert.equal(r.code, 1);
    assert.match(r.err, /--set/);
  });

  test('--dry-run 은 파일을 바꾸지 않는다', () => {
    const f = copyFixture('table-single.md');
    const before = readFileSync(f, 'utf8');
    const r = run(['--index', f, '--key', 'ABC-1', '--set', 'Status=closed', '--dry-run']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /dry-run/);
    assert.equal(readFileSync(f, 'utf8'), before);
  });
});

describe('wiki-row — 형식 보존', () => {
  test('CRLF 파일은 CRLF 로 유지된다', () => {
    const f = copyFixture('table-multi.md', { crlf: true });
    const r = run(['--index', f, '--section', '이슈 가이드', '--key', 'ABC-130', '--set', 'Status=planned']);
    assert.equal(r.code, 0, r.err);
    const text = readFileSync(f, 'utf8');
    assert.ok(text.includes('ABC-130'));
    assert.equal(text.match(/(?<!\r)\n/g), null, 'LF 단독 줄끝이 생기면 안 된다');
  });

  test('값 안의 파이프는 이스케이프되고, 다시 읽어도 같은 값이다', () => {
    const f = copyFixture('table-single.md');
    const r1 = run(['--index', f, '--key', 'ABC-1', '--set', 'Note=a|b']);
    assert.equal(r1.code, 0, r1.err);
    const text = readFileSync(f, 'utf8');
    assert.match(text, /\| ABC-1 \| open \| a\\\|b \|/);
    const rows = text.split('\n').filter(l => l.startsWith('| ABC-'));
    assert.equal(rows.length, 2, '셀 경계가 깨져 행이 늘어나면 안 된다');

    const r2 = run(['--index', f, '--key', 'ABC-1', '--set', 'Note=a|b', '--json']);
    assert.equal(JSON.parse(r2.out).action, 'unchanged');
  });
});

describe('wiki-row — 로그 append', () => {
  test('--log --event 는 형식을 갖춘 한 줄을 덧붙이고, 같은 줄은 다시 붙이지 않는다', () => {
    const f = copyFixture('table-single.md');
    const log = copyFixture('log-fixture.md');
    const args = [
      '--index', f, '--key', 'ABC-1', '--set', 'Status=closed',
      '--log', log, '--event', 'index_row=updated wiki=alpha',
      '--date', '2026-01-06', '--time', '11:00', '--mode', 'INGEST', '--phase', 'closure', '--json',
    ];
    const r1 = run(args);
    assert.equal(r1.code, 0, r1.err);
    assert.equal(JSON.parse(r1.out).log.action, 'appended');
    const text = readFileSync(log, 'utf8');
    assert.match(text, /^\[2026-01-06 11:00 KST INGEST ABC-1 closure\] index_row=updated wiki=alpha$/m);
    assert.match(text, /\[2026-01-04 10:00 KST INGEST ABC-123 forecast\]/, '기존 라인 보존');

    const r2 = run(args);
    assert.equal(JSON.parse(r2.out).log.action, 'duplicate-skipped');
    assert.equal(readFileSync(log, 'utf8'), text, '두 번 실행해도 로그가 같아야 한다');
  });

  test('--event 가 "[" 로 시작하면 완성된 라인으로 그대로 붙인다', () => {
    const f = copyFixture('table-single.md');
    const log = copyFixture('log-fixture.md');
    const line = '[2026-01-07 09:00 KST LINT - baseline] score=100';
    const r = run(['--index', f, '--key', 'ABC-1', '--set', 'Status=closed', '--log', log, '--event', line]);
    assert.equal(r.code, 0, r.err);
    assert.ok(readFileSync(log, 'utf8').includes(line));
  });
});
