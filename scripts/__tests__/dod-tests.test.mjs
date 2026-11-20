// dod-tests.test.mjs — 리포트 거두기의 「이번 실행이 쓴 것」 판정(lib/dod-tests.mjs collectEntries · snapshotReports).
// 게이트 수준 테스트(gate.test.mjs)는 러너 대역을 띄워 같은 성질을 보지만, 여기서는 시각에 기대지 않고 함수만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectEntries, snapshotReports, judgeTests } from '../lib/dod-tests.mjs';

const SPEC = { adapter: 'gradle-junit', run: './gradlew test' };

function reports() {
  const dir = mkdtempSync(join(tmpdir(), 'jh-dodtests-'));
  const rep = join(dir, 'build/test-results/test');
  mkdirSync(rep, { recursive: true });
  const file = name => join(rep, `TEST-${name}.xml`);
  const xml = (name, tests, failures = 0) => writeFileSync(file(name), `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${name}" tests="${tests}" skipped="0" failures="${failures}" errors="0">\n</testsuite>\n`);
  return { dir, file, xml };
}

test('gradle-junit: 비정상 종료한 실행은 「실행 전과 달라진 XML」만 거둔다 — 직전 실행이 방금 쓴 XML(시작 시각보다 늦게 찍힌 것 포함)은 이번 실행의 결과가 아니다', () => {
  const { dir, file, xml } = reports();
  try {
    // 직전 실행(예: 관련 테스트 단계)이 FooTest 를 돌려 통과시켰다. mtime 은 이 실행의 시작 시각보다 뒤다 — 시각만으로는 가려낼 수 없다
    xml('com.x.FooTest', 2);
    const later = new Date(Date.now() + 600_000);
    utimesSync(file('com.x.FooTest'), later, later);
    const before = snapshotReports(SPEC, dir);
    const since = Date.now();
    assert.deepEqual([...before.keys()], ['com.x.FooTest']);

    // ① 이번 실행이 리포트를 쓰지 못하고 죽었다 — 거둘 것이 없다
    assert.deepEqual(collectEntries(SPEC, dir, { exit: 1, since, before }), []);
    // 그 XML 로 항목을 판정하면 통과가 된다 — 실행 전 상태를 주지 않았을 때(시각만 볼 때) 벌어지는 일이고, 이 테스트가 막는 것이다
    const item = { id: 'D1', tests: { stack: 'be', select: ['*FooTest*', '*BarTest*'] } };
    assert.equal(judgeTests(SPEC, item, collectEntries(SPEC, dir, { exit: 1, since })).verdict, 'PASS', '시각만 보면 직전 실행의 통과가 이번 판정이 된다');
    assert.equal(judgeTests(SPEC, item, collectEntries(SPEC, dir, { exit: 1, since, before })).matched, 0, '실행 전 상태를 주면 분모 0 — 게이트가 「이번 실행 결과 없음」으로 FAIL 을 낸다');

    // ② 이번 실행이 BarTest 만 새로 쓰고(실패) 끝났다 — 새로 생긴 것만
    xml('com.x.BarTest', 2, 1);
    assert.deepEqual(collectEntries(SPEC, dir, { exit: 1, since, before }).map(e => [e.name, e.failed]), [['com.x.BarTest', 1]]);

    // ③ FooTest 도 다시 썼다(mtime 이 달라졌다) — 둘 다 이번 실행의 것
    xml('com.x.FooTest', 2);
    assert.deepEqual(collectEntries(SPEC, dir, { exit: 1, since, before }).map(e => e.name).sort(), ['com.x.BarTest', 'com.x.FooTest']);

    // ④ 정상 종료면 남은 XML 전부가 이번 실행의 것이다(Gradle 은 쓰기 전에 지난 XML 을 지운다) — 실행 전 상태와 무관
    assert.equal(collectEntries(SPEC, dir, { exit: 0, since, before }).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('snapshotReports — 리포트 폴더가 없으면 빈 상태 · vitest 는 리포트 파일을 실행 전에 지우므로 기준이 없다(null)', () => {
  const { dir, xml } = reports();
  try {
    assert.equal(snapshotReports({ adapter: 'vitest', run: 'npx vitest run' }, dir), null);
    assert.equal(snapshotReports({ ...SPEC, reports: 'no/such/dir' }, dir).size, 0);
    // 처음 도는 실행: 실행 전에는 아무것도 없었다 → 비정상 종료여도 새로 쓴 XML 은 전부 이번 실행의 것
    const before = snapshotReports({ ...SPEC, reports: 'build/test-results/test' }, dir);
    assert.equal(before.size, 0);
    xml('com.x.FooTest', 3, 1);
    assert.deepEqual(collectEntries(SPEC, dir, { exit: 1, since: Date.now(), before }).map(e => e.name), ['com.x.FooTest']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
