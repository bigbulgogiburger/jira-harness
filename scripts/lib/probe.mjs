// probe.mjs — DoD 프로브 출력에서 "실행 건수(분모)" 를 읽는다. 0 이나 미확인은 초록이 아니다.
export function parseTestCount(out) {
  const pats = [
    /Tests\s+(\d+)\s+passed/i,                          // vitest
    /(\d+)\s+tests?\s+(?:completed|passed|executed|run)/i, // gradle/junit 류 문장
    /^\s*tests?\s*[=:]\s*(\d+)\s*$/mi,                  // tests=12
    /^\s*(\d+)\s*$/m,                                   // 프로브가 직접 찍은 숫자 한 줄
  ];
  for (const re of pats) { const m = re.exec(out ?? ''); if (m) return parseInt(m[1], 10); }
  return null;
}
