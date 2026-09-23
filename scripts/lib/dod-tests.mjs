// dod-tests.mjs — 구조화 DoD 테스트 항목(`tests: {stack, select[]}`)을 스택별로 **한 번에** 돌리고, 러너 리포트를 항목마다 나눠 판정한다.
//
// 왜: 프로브 문자열은 항목마다 러너를 새로 띄운다 — gradle 26건이면 기동·컨텍스트 로딩 26번, vitest 15건이면 수집·변환 15번이다
//     (2026-09-23 실측: 경량 게이트 31.5분의 대부분이 이 반복). 같은 러너의 선택을 합쳐 1회 돌리고 리포트(JUnit XML · vitest JSON)를
//     나눠 읽으면 판정은 같고 기동은 1번이다. 전량 게이트는 스택 test 단계가 이미 전부를 돌렸으므로 그 리포트를 읽기만 한다.
//
// 어댑터 — harness.json `stacks.<name>.dod_tests = {adapter, run, reports?}`:
//   gradle-junit  `<run> --tests '<p>' …` · 리포트 = `<reports>/TEST-*.xml`(스택 dir 기준, 기본 build/test-results/test)의 <testsuite> 속성.
//                 패턴은 Gradle --tests 문법(`*` 와일드카드 · 대문자로 시작하면 단순 클래스명)을 **클래스 단위**로 맞춘다 — 메서드 단위 선택은
//                 어떤 스위트에도 안 걸려 "분모 0" 으로 FAIL 한다(클래스 패턴으로 쓸 것).
//                 Gradle 은 XML 을 쓰기 전에 지난 TEST-*.xml 을 지우므로(Binary2JUnitXmlReportGenerator) exit 0 이면 남은 XML 이 이번 실행
//                 (또는 입력이 같은 UP-TO-DATE 실행)의 것이다. exit≠0 이면 이번 실행 뒤에 쓰인 XML 만 믿는다(컴파일 실패면 지난 XML 이 남는다).
//   vitest        `<run> <경로 필터> … --reporter=default --reporter=json --outputFile.json=<파일>` · 필터는 vitest 와 같은 규칙(파일 경로 부분 문자열).
//                 리포트 파일은 실행 전에 지운다 — 없으면 이번 실행 결과가 없는 것이다.
// 판정: 선택에 걸린 것 1건 이상(분모) · 실패 0 · 통과 건수 ≥ expect.min_tests(없으면 1).
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

export const ADAPTERS = ['gradle-junit', 'vitest'];
export const DEFAULT_JUNIT_REPORTS = 'build/test-results/test';

const fwd = p => String(p).replace(/\\/g, '/');
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** vitest 에 붙이는 리포터 인자 — 화면 출력(default)은 그대로 두고 JSON 을 파일로 */
export function vitestReportArgs(reportPath) { return ` --reporter=default --reporter=json --outputFile.json=${shq(fwd(reportPath))}`; }

/** 선택들을 합친 배치 명령 한 줄 */
export function batchCommand(spec, selects, reportPath) {
  const sel = [...new Set(selects.map(s => String(s).trim()).filter(Boolean))];
  if (spec.adapter === 'gradle-junit') return `${spec.run} ${sel.map(p => `--tests ${shq(p)}`).join(' ')}`;
  if (spec.adapter === 'vitest') return `${spec.run} ${sel.map(shq).join(' ')}${vitestReportArgs(reportPath)}`;
  throw new Error(`알 수 없는 dod_tests.adapter: ${spec.adapter} (지원: ${ADAPTERS.join(', ')})`);
}

function readHead(p, n) {
  const fd = openSync(p, 'r');
  try { const buf = Buffer.alloc(n); const len = readSync(fd, buf, 0, n, 0); return buf.toString('utf8', 0, len); }
  finally { closeSync(fd); }
}
const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** JUnit XML 디렉터리의 스위트 — [{name(FQCN), passed, failed, skipped, mtime}]. 파일 머리의 <testsuite …> 만 읽는다(system-out 이 커도 무관) */
export function readJunitSuites(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!/^TEST-.*\.xml$/.test(f)) continue;
    const p = join(dir, f);
    const m = /<testsuite\b([^>]*)>/.exec(readHead(p, 8192));
    if (!m) continue;
    const attr = n => { const a = new RegExp(`\\s${n}="([^"]*)"`).exec(m[1]); return a ? a[1] : null; };
    const tests = Number(attr('tests')) || 0, skipped = Number(attr('skipped')) || 0;
    const failed = (Number(attr('failures')) || 0) + (Number(attr('errors')) || 0);
    out.push({ name: decodeXml(attr('name') ?? f.slice(5, -4)), passed: Math.max(0, tests - skipped - failed), failed, skipped, mtime: statSync(p).mtimeMs });
  }
  return out;
}

/** vitest JSON 리포트 → [{name(스택 dir 기준 경로), passed, failed, skipped}] · 파일이 없거나 깨졌으면 null */
export function readVitestReport(reportPath, stackDir) {
  let j;
  try { j = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { return null; }
  return (Array.isArray(j.testResults) ? j.testResults : []).map(t => {
    const abs = String(t.name ?? '');
    const ar = Array.isArray(t.assertionResults) ? t.assertionResults : [];
    const n = st => ar.filter(a => a.status === st).length;
    // 파일 자체가 못 뜬 경우(import 실패 등)는 assertion 0 · status failed — 그 파일에 걸린 항목은 실패다
    const loadFailed = t.status === 'failed' && n('failed') === 0 ? 1 : 0;
    return { name: fwd(isAbsolute(abs) ? relative(stackDir, abs) : abs), passed: n('passed'), failed: n('failed') + loadFailed, skipped: ar.length - n('passed') - n('failed') };
  });
}

const rx = glob => glob.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
/** Gradle --tests 패턴이 스위트(FQCN — 중첩 클래스는 `Outer$Inner`)에 걸리는가. 대문자로 시작하면 단순 클래스명 기준 */
export function gradleMatches(pattern, fqcn) {
  const p = String(pattern).trim();
  const target = /^[A-Z]/.test(p) ? fqcn.slice(fqcn.lastIndexOf('.') + 1) : fqcn;
  return new RegExp(`^${rx(p)}(\\$.*)?$`).test(target);
}
/** vitest 경로 필터가 파일(스택 dir 기준 경로)에 걸리는가 — vitest 와 같이 부분 문자열 */
export function vitestMatches(filter, rel) {
  const f = fwd(String(filter).trim()).replace(/^\.\//, '');
  return f.length > 0 && fwd(rel).includes(f);
}

/** 이번 실행의 리포트를 거둔다 — gradle 은 exit≠0 이면 실행 뒤에 쓰인 XML 만, vitest 는 리포트 파일(없으면 []) */
export function collectEntries(spec, stackDir, { reportPath = null, exit = 0, since = 0 } = {}) {
  if (spec.adapter === 'gradle-junit') {
    const all = readJunitSuites(join(stackDir, spec.reports ?? DEFAULT_JUNIT_REPORTS));
    return exit === 0 ? all : all.filter(s => s.mtime >= since - 1000);
  }
  if (spec.adapter === 'vitest') return (reportPath && readVitestReport(reportPath, stackDir)) || [];
  return [];
}

/** 항목 하나 — entries 중 선택에 걸린 것으로 판정. {verdict, reasons[], passed, failed, matched} */
export function judgeTests(spec, item, entries) {
  const sel = Array.isArray(item.tests?.select) ? item.tests.select : [];
  const hits = sel.length ? entries.filter(e => sel.some(s => (spec.adapter === 'gradle-junit' ? gradleMatches(s, e.name) : vitestMatches(s, e.name)))) : [];
  const passed = hits.reduce((n, e) => n + e.passed, 0);
  const failed = hits.reduce((n, e) => n + e.failed, 0);
  const floor = item.expect?.min_tests ?? 1;
  const reasons = [];
  if (!hits.length) reasons.push(`선택 ${JSON.stringify(sel)} 이 이번 실행의 어떤 테스트에도 안 걸렸다(분모 0)`);
  else {
    if (failed) reasons.push(`실패 ${failed}건: ${hits.filter(e => e.failed).map(e => e.name).slice(0, 5).join(', ')}`);
    if (passed < floor) reasons.push(`통과 ${passed}건 < ${floor}`);
  }
  return { verdict: reasons.length ? 'FAIL' : 'PASS', reasons, passed, failed, matched: hits.length };
}
