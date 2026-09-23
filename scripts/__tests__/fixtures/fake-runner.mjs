// fake-runner.mjs — DoD 배치 실행 대역. gradle(JUnit XML) · vitest(JSON 리포트) 흉내. 설정은 cwd 의 .fake-runner.json, 호출은 .fake-runner.log 에 한 줄씩.
//   node fake-runner.mjs gradle [--tests '<p>']…   .fake-runner.json { suites: [{name, tests, failures?, skipped?, default?}], compile_error? }
//        지난 TEST-*.xml 을 지우고(Gradle 과 같다) 선택에 걸린 스위트만 쓴다. 선택이 없으면 default !== false 인 스위트 전부. 실패가 있으면 exit 1.
//        compile_error 면 아무것도 지우거나 쓰지 않고 exit 1 — 지난 XML 이 남은 형태
//   node fake-runner.mjs vitest [<경로 필터>]… [--reporter=…] [--outputFile.json=<파일>]   .fake-runner.json { files: [{name, passed, failed?}] }
//        필터가 없으면 전부 · 있으면 경로에 부분 문자열로 걸리는 파일만. 실패가 있으면 exit 1
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [mode, ...args] = process.argv.slice(2);
appendFileSync('.fake-runner.log', JSON.stringify([mode, ...args]) + '\n');
const cfg = existsSync('.fake-runner.json') ? JSON.parse(readFileSync('.fake-runner.json', 'utf8')) : {};
const rx = g => new RegExp(`^${g.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}(\\$.*)?$`);

if (mode === 'gradle') {
  if (cfg.compile_error) { console.log('> Task :compileTestJava FAILED'); process.exit(1); }
  const pats = []; for (let i = 0; i < args.length; i++) if (args[i] === '--tests') pats.push(args[++i]);
  const dir = 'build/test-results/test';
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/^TEST-.*\.xml$/.test(f)) rmSync(join(dir, f));
  const chosen = (cfg.suites ?? []).filter(s => (pats.length ? pats.some(p => rx(p).test(s.name)) : s.default !== false));
  for (const s of chosen) writeFileSync(join(dir, `TEST-${s.name}.xml`), `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${s.name}" tests="${s.tests}" skipped="${s.skipped ?? 0}" failures="${s.failures ?? 0}" errors="0" timestamp="2026-09-23T00:00:00" hostname="h" time="0.1">\n</testsuite>\n`);
  console.log(`${chosen.reduce((n, s) => n + s.tests, 0)} tests completed`);
  process.exit(chosen.some(s => s.failures) ? 1 : 0);
}
if (mode === 'vitest') {
  const out = args.find(a => a.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length);
  const filters = args.filter(a => !a.startsWith('--'));
  const chosen = (cfg.files ?? []).filter(f => !filters.length || filters.some(x => f.name.includes(x)));
  const testResults = chosen.map(f => ({
    name: resolve(f.name).replace(/\\/g, '/'),
    status: f.failed ? 'failed' : 'passed',
    assertionResults: [...Array(f.passed).fill({ status: 'passed' }), ...Array(f.failed ?? 0).fill({ status: 'failed' })],
  }));
  if (out) writeFileSync(out, JSON.stringify({ numTotalTests: 0, testResults }));
  console.log(` Tests  ${chosen.reduce((n, f) => n + f.passed, 0)} passed`);
  process.exit(chosen.some(f => f.failed) ? 1 : 0);
}
console.error(`unknown mode ${mode}`); process.exit(2);
