// 프로세스 트리 정리(lib/proctree.mjs) — 자손 고르기는 순수 함수라 표로 검사한다. 실제로 끝내는 것은 gate.test.mjs 의 시간 상한 테스트가 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descendants } from '../lib/proctree.mjs';

test('자손 고르기: 죽은 root 의 자식·손자를 따라간다 · 부모보다 먼저 태어난 「자식」은 그 pid 의 예전 임자가 낳은 남이라 고르지 않는다', () => {
  const T = 1_000_000; // root(셸)가 태어난 시각
  const rows = [
    { pid: 10, ppid: 5, born: T + 50 },     // 셸의 자식(러너)
    { pid: 11, ppid: 10, born: T + 300 },   // 러너의 자식(워커)
    { pid: 12, ppid: 11, born: T + 900 },   // 워커의 자식
    { pid: 20, ppid: 5, born: T - 60_000 }, // pid 5 의 예전 임자가 1분 전에 낳은 프로세스 — 셸과 무관하다
    { pid: 21, ppid: 20, born: T + 500 },   // 그 무관한 프로세스의 자식 — 따라가지 않는다
    { pid: 30, ppid: 11, born: T - 5_000 }, // pid 11 의 예전 임자가 낳은 프로세스
    { pid: 40, ppid: 99, born: T + 100 },   // 다른 트리
  ];
  assert.deepEqual(descendants(rows, 5, T).sort((a, b) => a - b), [10, 11, 12]);
  assert.deepEqual(descendants(rows, 99, T), [40]);
  assert.deepEqual(descendants(rows, 7, T), [], '자식이 없으면 비어 있다');
  assert.deepEqual(descendants([{ pid: 10, ppid: 5, born: T - 400 }], 5, T), [10], '시계 오차(1초 이내)는 봐준다');
  // 목록에 돌고 도는 부모 관계가 있어도(재사용된 pid) 끝난다
  assert.deepEqual(descendants([{ pid: 2, ppid: 1, born: T }, { pid: 1, ppid: 2, born: T }], 1, T), [2]);
});

test('자손 고르기: 죽은 root 의 pid 를 새로 받은 남의 프로세스가 낳은 자식은 고르지 않는다 — root 가 죽은 뒤에 태어났다 · 살아남은 러너가 그 뒤에 낳은 워커는 따라간다', () => {
  const T = 1_000_000, DIED = T + 60_000; // 셸이 태어난 시각 · 시간 상한에 걸려 죽은 시각
  const rows = [
    { pid: 10, ppid: 5, born: T + 50 },        // 셸의 자식(러너) — 셸이 죽기 전에 태어났다
    { pid: 11, ppid: 10, born: DIED + 5_000 }, // 러너는 살아 있어 셸이 죽은 뒤에도 워커를 낳는다
    { pid: 5, ppid: 1, born: DIED + 200 },     // 죽은 셸의 pid 를 새로 받은 남의 프로세스
    { pid: 50, ppid: 5, born: DIED + 400 },    // 그 남의 프로세스의 자식 — 셸과 무관하다
    { pid: 51, ppid: 50, born: DIED + 600 },   // 그 아래도 따라가지 않는다
  ];
  assert.deepEqual(descendants(rows, 5, T, { rootDiedMs: DIED }).sort((a, b) => a - b), [10, 11]);
  assert.deepEqual(descendants(rows, 5, T).sort((a, b) => a - b), [10, 11, 50, 51], '죽은 시각을 주지 않으면 상한이 없다');
  assert.deepEqual(descendants([{ pid: 10, ppid: 5, born: DIED }], 5, T, { rootDiedMs: DIED }), [10], '죽은 바로 그 시각에 태어난 것까지는 셸의 자식이다');
  assert.deepEqual(descendants([{ pid: 10, ppid: 5, born: DIED + 1 }], 5, T, { rootDiedMs: DIED }), [], '상한에는 여유를 두지 않는다');
});
