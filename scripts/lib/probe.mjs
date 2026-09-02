// probe.mjs — DoD 프로브 출력에서 "실행 건수(분모)" 를 읽는다. 0 이나 미확인은 초록이 아니다.
//
// 테스트 러너는 요약 줄에 색상(ANSI escape)을 섞어 찍는다 — vitest 는 `Tests \x1b[1m\x1b[32m3 passed\x1b[39m…` 처럼
// 숫자 앞뒤에 코드가 끼어 정규식이 조용히 빗나간다(9/02 실측: 프로브 5건이 전부 통과했는데 게이트가 5건 FAIL).
// 그래서 판정은 항상 색을 벗긴 텍스트로 한다.

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s) {
  return (s ?? '').replace(ANSI_RE, '');
}

export function parseTestCount(out) {
  const text = stripAnsi(out);
  const pats = [
    /Tests:?\s+(\d+)\s+passed/i,                        // vitest · jest ("Tests: 3 passed")
    /Tests run:\s*(\d+)/i,                              // JUnit/surefire
    /(\d+)\s+tests?\s+(?:completed|passed|executed|run)/i, // gradle/junit 류 문장
    /^\s*=+.*?\b(\d+)\s+passed\b.*=+\s*$/mi,            // pytest "==== 3 passed in 0.1s ===="
    /^\s*tests?\s*[=:]\s*(\d+)\s*$/mi,                  // tests=12
    /^\s*(\d+)\s*$/m,                                   // 프로브가 직접 찍은 숫자 한 줄
  ];
  for (const re of pats) { const m = re.exec(text); if (m) return parseInt(m[1], 10); }
  return null;
}
