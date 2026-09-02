// wiki-lint.mjs 시험 — 점검 16종이 "실제로 검출하는지"를 위반 주입 픽스처로 증명한다.
// clean 픽스처는 전부 OK/SKIPPED, dirty 픽스처는 점검마다 최소 1건이 잡혀야 한다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'wiki-lint.mjs');
const CLEAN = join(HERE, 'fixtures', 'clean');
const DIRTY = join(HERE, 'fixtures', 'dirty');

function lint(rootDir, extra = []) {
  const args = [
    SCRIPT,
    '--docs', join(rootDir, 'docs'),
    '--memory', join(rootDir, 'memory'),
    '--root', rootDir,
    '--today', '2026-02-01',
    '--json',
    ...extra,
  ];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: r.status, json: JSON.parse(r.stdout), err: r.stderr };
}

function ruleOf(res, id) {
  const r = res.json.rules.find(x => x.id === id);
  assert.ok(r, `${id} 이 보고서에 없다 — 조용히 빠진 점검이 있다`);
  return r;
}

const IMPLEMENTED = ['L01', 'L02', 'L03', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10', 'L11', 'L12', 'L15', 'L16', 'L17'];
const ALWAYS_SKIPPED = ['L04', 'L13', 'L14'];

describe('wiki-lint — 보고 계약', () => {
  test('규칙 17행(구현 14 + 미구현 3)이 모두 출력되고, 미구현은 사유와 함께 SKIPPED 다', () => {
    const res = lint(CLEAN);
    assert.equal(res.json.rules.length, 17);
    for (const id of ALWAYS_SKIPPED) {
      const r = ruleOf(res, id);
      assert.equal(r.status, 'SKIPPED', `${id} 은 SKIPPED 여야 한다`);
      assert.ok(r.reason && r.reason.length > 5, `${id} 은 사유를 밝혀야 한다`);
    }
    assert.match(ruleOf(res, 'L14').reason, /트래커|네트워크/);
    assert.match(ruleOf(res, 'L13').reason, /git/);
  });

  test('clean 픽스처는 위반 0 · 종료 코드 0', () => {
    const res = lint(CLEAN);
    assert.equal(res.code, 0);
    assert.equal(res.json.summary.high_violations, 0);
    for (const id of IMPLEMENTED) {
      const r = ruleOf(res, id);
      assert.equal(r.status, 'OK', `${id} 이 clean 에서 위반을 냈다: ${JSON.stringify(r.violations)}`);
    }
  });

  test('사람이 읽는 표 출력에 점검코드·상태·건수·예시가 있다', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--docs', join(DIRTY, 'docs'), '--today', '2026-02-01'], { encoding: 'utf8' });
    assert.equal(r.status, 1, 'high 위반이 있으면 종료 코드 1');
    assert.match(r.stdout, /L01\s+high\s+VIOLATION\s+\d+\s+\S/);
    assert.match(r.stdout, /L14\s+medium\s+SKIPPED\s+-\s+SKIP 사유:/);
    assert.match(r.stdout, /wiki-lint: FAIL/);
  });

  test('--severity high 는 high 규칙만 보고한다', () => {
    const res = lint(DIRTY, ['--severity', 'high']);
    const ids = res.json.rules.map(r => r.id);
    assert.deepEqual(ids, ['L01', 'L02', 'L05', 'L09', 'L10', 'L13', 'L17']);
  });

  test('--memory 없이 돌리면 L10 은 위반 0 이 아니라 SKIPPED 다', () => {
    const r = spawnSync(process.execPath,
      [SCRIPT, '--docs', join(DIRTY, 'docs'), '--root', DIRTY, '--today', '2026-02-01', '--json'],
      { encoding: 'utf8' });
    const rule = JSON.parse(r.stdout).rules.find(x => x.id === 'L10');
    assert.equal(rule.status, 'SKIPPED');
    assert.match(rule.reason, /memory/);
  });
});

describe('wiki-lint — 위반 주입 검출 (점검마다 1건)', () => {
  const res = () => lint(DIRTY);
  const expect = (id, needle) => {
    const r = ruleOf(res(), id);
    assert.equal(r.status, 'VIOLATION', `${id} 이 주입된 위반을 못 잡았다`);
    assert.ok(r.count >= 1);
    const all = JSON.stringify(r.violations);
    assert.ok(all.includes(needle), `${id} 검출 내용에 "${needle}" 이 없다: ${all}`);
  };

  test('L01 — INDEX 미등재 가이드', () => expect('L01', 'ABC-777-dev-guide.md'));
  test('L02 — 대응 문서 없는 INDEX 행', () => expect('L02', 'ABC-901'));
  test('L03 — planned 방치', () => expect('L03', 'ABC-902'));
  test('L05 — 없는 ADR 인용', () => expect('L05', 'ADR-099'));
  test('L06 — 가이드 본문의 미등재 키', () => expect('L06', 'ABC-555'));
  test('L07 — 형제 단방향', () => expect('L07', 'ABC-903'));
  test('L08 — frontmatter 누락', () => expect('L08', 'ABC-905-dev-guide.md'));
  test('L09 — 같은 ADR 을 반전/적용으로 갈라 인용', () => expect('L09', 'ADR-002'));
  test('L10 — memory 가 없는 파일을 인용', () => expect('L10', 'GhostService'));
  test('L11 — 중복 행', () => expect('L11', '중복 행'));
  test('L12 — LOG 형식 일탈', () => expect('L12', 'LOG.md'));
  test('L15 — 주차 파일 미인용', () => expect('L15', 'ABC-906'));
  test('L16 — closure 라인에 wiki= 없음', () => expect('L16', 'wiki= 필드 없음'));
  test('L17 — wiki 페이지 출처 결박 깨짐', () => expect('L17', 'ADR-999'));

  test('L11 은 빈 셀도 잡는다', () => expect('L11', '빈 셀'));
  test('L11 은 표 본문 안의 빈 줄도 잡는다', () => expect('L11', '표 본문 안의 빈 줄'));
  test('L16 은 미등재 wiki 페이지와 무단 도메인을 함께 잡는다', () => {
    const r = ruleOf(res(), 'L16');
    const msgs = r.violations.map(v => `${v.file} ${v.message}`);
    assert.ok(msgs.some(m => m.includes('gamma.md') && m.includes('orphan wiki page')));
    assert.ok(msgs.some(m => m.includes('domain "gamma"') && m.includes('domains 에 없다')));
  });
  test('L17 은 없는 sources 경로와 출처 없는 규칙 서술을 함께 잡는다', () => {
    const r = ruleOf(res(), 'L17');
    const all = JSON.stringify(r.violations);
    assert.ok(all.includes('sources 경로 부재'));
    assert.ok(all.includes('출처 표기 없는 규칙 서술'));
  });
});

describe('wiki-lint — 분모(면제) 규율', () => {
  test('스키마가 면제한 행(row_description_only)은 L02 위반이 아니다', () => {
    const r = ruleOf(lint(DIRTY), 'L02');
    assert.ok(!JSON.stringify(r.violations).includes('ABC-900'), '면제 키를 위반으로 세면 분모가 틀린다');
  });

  test('umbrella 가이드 본문이 덮는 행은 L02 위반이 아니다 (파일명만 보면 오탐)', () => {
    const all = JSON.stringify(ruleOf(lint(DIRTY), 'L02').violations);
    for (const k of ['ABC-520', 'ABC-522', 'ABC-525']) {
      assert.ok(!all.includes(k), `${k} — 파일명이 아니라 본문이 덮는 행까지 세면 분모가 틀린다`);
    }
  });

  test('L16 은 synthesis 활성 이전 라인을 세지 않는다 (--synthesis-since)', () => {
    const res = lint(DIRTY, ['--synthesis-since', '2026-12-31']);
    const all = JSON.stringify(ruleOf(res, 'L16').violations);
    assert.ok(!all.includes('wiki= 필드 없음'), '활성 이전 closure 라인까지 세면 분모가 폭증한다');
  });
});
