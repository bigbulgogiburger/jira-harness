// plan-check.test.mjs — lib/plan-check.mjs(계획 기계 점검) · plan-check.mjs CLI · issue-set 의 반영 전 점검·--assume·--evidence ·
// issue-complete 의 가정·사람 확인 집계. 판정마다 **그 규칙만 어긴 계획에서 코드가 실제로 나오는지** 보고, 고친 계획에서는 사라지는지 본다
// (통과 사례만 있는 테스트는 검사 0건과 구분되지 않는다).
import './fixtures/no-queue.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, newState, writeState, readState } from '../lib/config.mjs';
import { checkPlan, loadGuideText, isAssumption } from '../lib/plan-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;

function sh(cmd, args, cwd) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function put(dir, rel, text) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }

const GUIDE = [
  '# ABC-1 개발 가이드',
  '## 요구',
  '- R1 수수료를 계산한다(ABC-1)',
  '- R2 음수 금액은 거부한다(결정 1)',
  '## 작업 항목',
  '- be: 계산기 · fe: 화면 (R1 은 여기 말고 DoD 절에서만 센다)',
  '## DoD',
  '- D1 (R1) 계산기 단위 테스트',
  '- D2 (R1) 화면 테스트',
  '- D3 (R2) 음수 주입이 걸린다',
  '- D4 (R1) 실화면 확인',
  '',
].join('\n');

/** dod_tests 가 붙은 하네스(be=gradle-junit · fe=vitest) + 실제 테스트 파일이 있는 임시 저장소 */
function makeRepo({ guide = GUIDE, harness = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-plancheck-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'core.autocrlf', 'false');
  put(dir, 'docs/README.md', '# docs\n');
  put(dir, 'backend/App.java', 'class App {}\n');
  put(dir, 'backend/src/main/java/app/FeeCalculator.java', 'package app; class FeeCalculator {}\n');
  put(dir, 'backend/src/test/java/app/FeeCalculatorTest.java', 'package app; class FeeCalculatorTest {}\n');
  put(dir, 'frontend/app.js', 'export default 1\n');
  put(dir, 'frontend/src/views/fee.js', 'export const fee = 1\n');
  put(dir, 'frontend/src/views/__tests__/fee.spec.js', 'test("fee", () => {})\n');
  put(dir, '.gitignore', '.claude/harness.env.local\n');
  if (harness) {
    const cfg = JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8'));
    cfg.stacks.be.dod_tests = { adapter: 'gradle-junit', run: './gradlew test' };
    cfg.stacks.fe.dod_tests = { adapter: 'vitest', run: 'npx vitest run' };
    put(dir, '.claude/harness.json', JSON.stringify(cfg, null, 2) + '\n');
  }
  if (guide != null) put(dir, 'docs/ABC-1-dev-guide.md.draft', guide);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function cleanPlan() {
  return {
    guides: { 'ABC-1': 'docs/ABC-1-dev-guide.md' },
    touched: ['backend/src/main/java/app/FeeCalculator.java', 'backend/src/test/java/app/FeeCalculatorTest.java', 'frontend/src/views/fee.js'],
    lanes: [{ name: 'be', model: 'opus', files: ['backend/**'], dod: ['D1'] }, { name: 'fe', model: 'opus', files: ['frontend/**'], dod: ['D2'] }],
    dod: [
      { id: 'D1', text: '계산기 단위 테스트', probe: null, tests: { stack: 'be', select: ['*FeeCalculatorTest*'] }, expect: { min_tests: 3 } },
      { id: 'D2', text: '화면 테스트', probe: null, tests: { stack: 'fe', select: ['src/views/__tests__/fee.spec.js'] }, expect: { min_tests: 1 } },
      { id: 'D3', text: '음수 주입이 걸린다(거부 케이스)', probe: "cp src/main/java/app/FeeCalculator.java /tmp/f.bak && sed -i 's/x/y/' src/main/java/app/FeeCalculator.java && ./gradlew test --tests '*FeeCalculatorTest*' | grep -q FAILED && echo INJECTION_FIRED; mv /tmp/f.bak src/main/java/app/FeeCalculator.java", cwd: 'backend', expect: { pattern: 'INJECTION_FIRED' } },
      { id: 'D4', text: '실화면 확인', probe: null, human: true },
    ],
  };
}

const DIR = makeRepo();
const CFG = loadConfig(join(DIR, '.claude/harness.json'));
function run(mut = () => {}, { state = null, guideText, cfg = CFG, root = DIR } = {}) {
  const plan = cleanPlan();
  const st = state ?? { decisions: [] };
  mut(plan, st);
  const gt = guideText === undefined ? loadGuideText({ root, plan }) : guideText;
  return checkPlan({ cfg, root, state: st, plan, guideText: gt });
}
const codes = list => list.map(x => x.code);
function fires(code, mut, opts, kind = 'errors') {
  const r = run(mut, opts);
  assert.ok(codes(r[kind]).includes(code), `${code} 가 나와야 한다: ${JSON.stringify(r[kind])}`);
  return r;
}
function silent(code, mut, opts, kind = 'errors') {
  const r = run(mut, opts);
  assert.ok(!codes(r[kind]).includes(code), `${code} 가 나오면 안 된다: ${JSON.stringify(r[kind])}`);
  return r;
}

// ---------------- 깨끗한 계획 ----------------

test('깨끗한 계획(R1·R2 대응 · tests 항목 · 주입 프로브 · human 1) → errors 0 · summary 집계', () => {
  const r = run();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.summary, { requirements: 2, dod: 4, tests_items: 2, probes: 1, human: 1, lanes: 2, touched: 3, assumptions: [] });
});

// ---------------- 오류 코드 ----------------

test('PLAN_EMPTY — dod 가 비었거나 touched 가 비었다', () => {
  fires('PLAN_EMPTY', p => { p.dod = []; });
  fires('PLAN_EMPTY', p => { p.touched = []; });
  silent('PLAN_EMPTY');
});

test('DOD_ID — id 없음 · 중복', () => {
  const r = fires('DOD_ID', p => { p.dod[1].id = 'D1'; });
  assert.equal(r.errors.find(e => e.code === 'DOD_ID').id, 'D1');
  fires('DOD_ID', p => { delete p.dod[3].id; });
  silent('DOD_ID');
});

test('TESTS_STACK — 없는 스택 · dod_tests 없는 스택', () => {
  fires('TESTS_STACK', p => { p.dod[0].tests.stack = 'backend'; });
  const noAdapter = structuredClone(CFG);
  delete noAdapter.stacks.fe.dod_tests;
  fires('TESTS_STACK', () => {}, { cfg: noAdapter });
  silent('TESTS_STACK');
});

test('TESTS_MIN — min_tests 가 있는데 1 이상 정수가 아니면 오류 · 아예 없으면 게이트 기본값(1)이라 오류가 아니고 한 줄 경고(TESTS_MIN_DEFAULT)', () => {
  fires('TESTS_MIN', p => { p.dod[0].expect.min_tests = 0; });
  fires('TESTS_MIN', p => { p.dod[0].expect.min_tests = '3'; });
  silent('TESTS_MIN');
  // 없으면: 오류 아님 · 경고 한 줄에 항목을 모은다
  const r = silent('TESTS_MIN', p => { delete p.dod[0].expect; p.dod[1].expect = {}; });
  const w = r.warnings.filter(x => x.code === 'TESTS_MIN_DEFAULT');
  assert.equal(w.length, 1, JSON.stringify(r.warnings));
  assert.match(w[0].msg, /tests 항목 2건\(D1, D2\)/);
  silent('TESTS_MIN_DEFAULT', () => {}, undefined, 'warnings');
});

test('SELECT_EMPTY — tests.select 가 비었다', () => {
  fires('SELECT_EMPTY', p => { p.dod[0].tests.select = []; });
  fires('SELECT_EMPTY', p => { p.dod[0].tests.select = ['  ']; });
  silent('SELECT_EMPTY');
});

test('SELECT_NO_MATCH — gradle 클래스 패턴: 맞으면 통과 · 한 글자 다르면 오류 · main 소스 이름만 맞는 것도 오류', () => {
  silent('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['*FeeCalculatorTest*']; });
  silent('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['FeeCalculatorTest']; });
  silent('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['app.FeeCalculatorTest']; });
  const r = fires('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['*FeeCalculaterTest*']; });
  assert.match(r.errors.find(e => e.code === 'SELECT_NO_MATCH').msg, /FeeCalculaterTest/);
  // 러너는 테스트 루트 밖(main) 클래스를 수집하지 않는다 — 추적 파일 전체로 맞추면 여기서 거짓 통과한다
  fires('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['FeeCalculator']; });
});

test('SELECT_NO_MATCH — vitest 경로 필터: 스택 dir 기준이면 통과 · 루트 기준·오타는 오류', () => {
  silent('SELECT_NO_MATCH', p => { p.dod[1].tests.select = ['src/views/__tests__']; });
  fires('SELECT_NO_MATCH', p => { p.dod[1].tests.select = ['src/views/__tests__/fee.spek.js']; });
  fires('SELECT_NO_MATCH', p => { p.dod[1].tests.select = ['frontend/src/views/__tests__/fee.spec.js']; });
  // *.test.*·*.spec.* 가 아닌 파일은 vitest 가 수집하지 않는다
  fires('SELECT_NO_MATCH', p => { p.dod[1].tests.select = ['src/views/fee.js']; });
});

test('SELECT_NO_MATCH — 게이트처럼 항목 단위: select 가 전부 0건이면 오류 · 일부만 0건이면(다른 select 는 걸린다) 죽은 필터 경고', () => {
  const r = silent('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['*FeeCalculatorTest*', '*NoSuchTest*']; });
  const w = r.warnings.find(x => x.code === 'SELECT_NO_MATCH');
  assert.ok(w && w.id === 'D1' && /NoSuchTest/.test(w.msg) && !/FeeCalculatorTest/.test(w.msg), JSON.stringify(r.warnings));
  const r2 = fires('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['*NoSuchTest*', '*AlsoMissing*']; });
  assert.match(r2.errors.find(e => e.code === 'SELECT_NO_MATCH').msg, /NoSuchTest.*AlsoMissing/);
  silent('SELECT_NO_MATCH', () => {}, undefined, 'warnings');
});

test('SELECT_NO_MATCH — 저장소에 없어도 touched 에 있는 새 테스트는 통과', () => {
  fires('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['*RefundPolicyTest*']; });
  silent('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['*RefundPolicyTest*']; p.touched.push('backend/src/test/java/app/RefundPolicyTest.java'); });
  fires('SELECT_NO_MATCH', p => { p.dod[1].tests.select = ['src/views/__tests__/refund.spec.js']; });
  silent('SELECT_NO_MATCH', p => { p.dod[1].tests.select = ['src/views/__tests__/refund.spec.js']; p.touched.push('frontend/src/views/__tests__/refund.spec.js'); });
});

test('SELECT_UNCHECKED — 러너 종류를 모르면 오류가 아니라 경고', () => {
  const odd = structuredClone(CFG);
  odd.stacks.be.dod_tests.adapter = 'unknown-runner';
  const r = run(p => { p.dod[0].tests.select = ['*Nothing*']; }, { cfg: odd });
  assert.ok(codes(r.warnings).includes('SELECT_UNCHECKED'), JSON.stringify(r.warnings));
  assert.ok(!codes(r.errors).includes('SELECT_NO_MATCH'), JSON.stringify(r.errors));
  silent('SELECT_UNCHECKED', () => {}, undefined, 'warnings');
});

test('SELECT_UNCHECKED — 그 스택에서 테스트 파일을 하나도 못 찾으면(배치가 기본 규칙과 다르다) 전부 오류로 내지 않고 경고', () => {
  // 테스트 루트가 다른 곳에 있는 프로젝트 — 후보 0건은 "select 가 틀렸다" 가 아니라 "배치를 못 알아봤다" 이다
  const elsewhere = structuredClone(CFG);
  elsewhere.stacks.be.related = { test_roots: ['src/it/java'] };
  const r = run(() => {}, { cfg: elsewhere });
  assert.ok(codes(r.warnings).includes('SELECT_UNCHECKED'), JSON.stringify(r.warnings));
  assert.ok(!codes(r.errors).includes('SELECT_NO_MATCH'), JSON.stringify(r.errors));
  // 후보가 하나라도 있으면 다시 오류로 잡는다(경고로 새지 않는다)
  const r2 = run(p => { p.dod[0].tests.select = ['*Nothing*']; });
  assert.ok(codes(r2.errors).includes('SELECT_NO_MATCH'));
});

test('SELECT_NO_MATCH — 다중 모듈 gradle: 테스트 루트가 모듈 폴더 아래에 있어도 클래스를 찾는다', () => {
  silent('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['*ModTest*']; p.touched.push('backend/module-a/src/test/java/app/ModTest.java'); });
  silent('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['app.ModTest']; p.touched.push('backend/module-a/src/test/java/app/ModTest.java'); });
  fires('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['*ModTest*']; });
  // 폴더 이름이 테스트 루트로 "끝나기만" 하는 곳(xsrc/test/java)은 루트가 아니다
  fires('SELECT_NO_MATCH', p => { p.dod[0].tests.select = ['*ModTest*']; p.touched.push('backend/xsrc/test/javax/app/ModTest.java'); });
});

test('DOD_NO_CHECK — probe · tests · human 이 모두 없는 항목(게이트가 말없이 사람 확인으로 건너뛴다)', () => {
  const r = fires('DOD_NO_CHECK', p => { p.dod[3] = { id: 'D4', text: '실화면 확인', probe: null }; });
  assert.equal(r.errors.find(e => e.code === 'DOD_NO_CHECK').id, 'D4');
  assert.equal(r.summary.human, 1, '집계는 게이트와 같이 사람 확인으로 센다');
  silent('DOD_NO_CHECK');
});

test('PROBE_MIN — 러너를 부르는 probe 에 min_tests·pattern 이 둘 다 없다', () => {
  const runners = ['./gradlew test --tests X', 'npx vitest run src/a', 'npx jest a', 'pytest -k a', 'mvn test', 'go test ./...', 'npm test', 'npm run test', 'node --test a.test.mjs'];
  for (const probe of runners) fires('PROBE_MIN', p => { p.dod[2] = { id: 'D3', text: 'x', probe }; });
  silent('PROBE_MIN', p => { p.dod[2] = { id: 'D3', text: 'x', probe: './gradlew test --tests X', expect: { min_tests: 1 } }; });
  silent('PROBE_MIN', p => { p.dod[2] = { id: 'D3', text: 'x', probe: './gradlew test --tests X', expect: { pattern: 'BUILD SUCCESSFUL' } }; });
  // 러너가 아닌 것 — compileTestJava·echo 로 찍은 숫자
  silent('PROBE_MIN', p => { p.dod[2] = { id: 'D3', text: 'x', probe: './gradlew compileTestJava' }; });
  silent('PROBE_MIN', p => { p.dod[2] = { id: 'D3', text: 'x', probe: "echo '3 tests completed'" }; });
  silent('PROBE_MIN', p => { p.dod[2] = { id: 'D3', text: 'x', probe: 'test -f frontend/vitest.config.ts' }; });
});

test('INJECT_RESTORE — git checkout -- · restore · stash · reset --hard 로 원복', () => {
  for (const undo of ['git checkout -- src/A.java', 'git checkout HEAD -- src/A.java', 'git restore src/A.java', 'git stash pop', 'git reset --hard']) {
    fires('INJECT_RESTORE', p => { p.dod[2].probe = `sed -i 's/a/b/' src/A.java && ./gradlew test; ${undo}`; });
  }
  silent('INJECT_RESTORE');
  silent('INJECT_RESTORE', p => { p.dod[2].probe = 'git checkout -b x'; });
});

test('LANE_OVERLAP — 같은 glob 이 두 레인에 · touched 한 파일이 두 레인 glob 에: 둘 다 작업트리가 없으면 오류 · 한쪽이라도 작업트리면 경고 · 레인 쌍마다 한 줄', () => {
  fires('LANE_OVERLAP', p => { p.lanes[1].files.push('backend/**'); });
  const r = fires('LANE_OVERLAP', p => { p.lanes[1].files = ['frontend/**', 'backend/src/main/**']; });
  assert.equal(r.errors.filter(e => e.code === 'LANE_OVERLAP').length, 1, '레인 쌍마다 한 줄');
  assert.match(r.errors.find(e => e.code === 'LANE_OVERLAP').msg, /레인 be·fe .*FeeCalculator\.java/);
  silent('LANE_OVERLAP');
  silent('LANE_OVERLAP', p => { p.lanes = [{ name: 'only', model: 'opus', files: ['backend/**', 'backend/src/**'] }]; });
  // 자기 작업트리에서 도는 레인끼리는 서로 덮지 않는다 — 패치를 합칠 때의 충돌 위험만 알린다
  const wt = silent('LANE_OVERLAP', p => { p.lanes[0].worktree = true; p.lanes[1].worktree = true; p.lanes[1].files.push('backend/**'); });
  assert.ok(codes(wt.warnings).includes('LANE_OVERLAP'), JSON.stringify(wt.warnings));
  const mixed = silent('LANE_OVERLAP', p => { p.lanes[0].worktree = true; p.lanes[1].files.push('backend/**'); });
  assert.ok(codes(mixed.warnings).includes('LANE_OVERLAP'));
  silent('LANE_OVERLAP', p => { p.lanes[0].worktree = true; p.lanes[1].worktree = true; }, undefined, 'warnings');
});

test('LANES_SERIAL — 이슈 여러 건(다중 키 · 하위이슈)인데 레인이 0~1개면 경고(오류는 아니다) · 이슈 1건이거나 레인이 2개 이상이면 조용하다', () => {
  const multi = { decisions: [], keys: ['ABC-1', 'ABC-2'] };
  const r = fires('LANES_SERIAL', p => { delete p.lanes; }, { state: structuredClone(multi) }, 'warnings');
  assert.ok(!codes(r.errors).includes('LANES_SERIAL'), '반영을 막지 않는다 — 승인 전에 드러내기만 한다');
  assert.match(r.warnings.find(w => w.code === 'LANES_SERIAL').msg, /이슈 2건.*레인이 0개/);
  fires('LANES_SERIAL', p => { p.lanes = [p.lanes[0]]; }, { state: structuredClone(multi) }, 'warnings');
  fires('LANES_SERIAL', p => { delete p.lanes; p.dod[3].text = '[ABC-2] 실화면 확인'; }, { state: { decisions: [], keys: ['ABC-1'], subtasks: [{ parent: 'ABC-1', children: ['ABC-2'] }] } }, 'warnings');
  silent('LANES_SERIAL', () => {}, { state: structuredClone(multi) }, 'warnings');
  silent('LANES_SERIAL', p => { delete p.lanes; }, { state: { decisions: [], keys: ['ABC-1'] } }, 'warnings');
  silent('LANES_SERIAL', p => { delete p.lanes; }, undefined, 'warnings');
});

test('LANE_DOD — 레인의 dod 는 사이드카 DoD 의 id 만 가리킨다(없는 id · 배열 아님은 오류) · 어느 레인도 맡지 않은 tests 항목은 경고 — 레인이 전부 dod 를 빠뜨렸을 때도', () => {
  // 맞게 나눈 계획(깨끗한 계획이 그렇다) — 조용하다(프로브·사람 확인 항목은 어느 레인에도 없어도 된다)
  const r0 = silent('LANE_DOD');
  assert.deepEqual(r0.warnings, []);
  // 없는 id — 그 레인은 구현 중 돌릴 테스트를 못 찾는다
  const r = fires('LANE_DOD', p => { p.lanes[1].dod = ['D2', 'D9']; });
  assert.match(r.errors.find(e => e.code === 'LANE_DOD').msg, /레인 fe 의 dod 가 사이드카 dod 에 없는 id 를 가리킨다\(D9\).*있는 것: D1, D2, D3, D4/);
  fires('LANE_DOD', p => { p.lanes[0].dod = 'D1'; });
  fires('LANE_DOD', p => { p.lanes[0].dod = [{ text: 'id 없는 객체' }]; });
  silent('LANE_DOD', p => { p.lanes[0].dod = [{ id: 'D1' }, 'D3']; }, undefined);
  // 한 레인만 dod 를 적었다 — 남은 tests 항목(D2)은 어느 레인도 돌리지 않는다
  const w = fires('LANE_DOD_UNOWNED', p => { delete p.lanes[1].dod; }, undefined, 'warnings');
  assert.match(w.warnings.find(x => x.code === 'LANE_DOD_UNOWNED').msg, /어느 레인의 dod 에도 없는 tests 항목: D2 /);
  assert.ok(!codes(w.errors).includes('LANE_DOD_UNOWNED'));
  // 레인이 전부 dod 를 빠뜨렸다(빈 배열 포함) — 레인마다 「자기 테스트」가 없다. 오류는 아니지만 조용히 지나가지 않는다
  for (const mut of [p => { delete p.lanes[0].dod; delete p.lanes[1].dod; }, p => { p.lanes[0].dod = []; p.lanes[1].dod = []; }]) {
    const none = fires('LANE_DOD_UNOWNED', mut, undefined, 'warnings');
    assert.match(none.warnings.find(x => x.code === 'LANE_DOD_UNOWNED').msg, /레인이 2개인데 어느 레인에도 dod 가 없다\(tests 항목: D1, D2\)/);
    assert.ok(!codes(none.errors).includes('LANE_DOD_UNOWNED'));
  }
  // 레인이 하나거나 없으면(드라이버가 직접 구현한다) · tests 항목이 없으면 조용하다
  silent('LANE_DOD_UNOWNED', p => { p.lanes = [{ name: 'only', model: 'opus', files: ['**'] }]; }, undefined, 'warnings');
  silent('LANE_DOD_UNOWNED', p => { delete p.lanes; }, undefined, 'warnings');
  silent('LANE_DOD_UNOWNED', p => { delete p.lanes[0].dod; delete p.lanes[1].dod; delete p.dod[0].tests; p.dod[0].human = true; delete p.dod[1].tests; p.dod[1].human = true; }, undefined, 'warnings');
});

test('LANE_NAME — 이름 없는 레인 · 파일 이름으로 못 쓰는 글자 · 겹치는 이름은 오류(결과 파일은 대소문자를 가리지 않는다) · Herdr 구현 레인이 켜져 있으면 깎은 뒤 같아지는 이름(한글·숫자뿐인 이름 · 앞 27자가 같은 이름)도', () => {
  silent('LANE_NAME');
  fires('LANE_NAME', p => { delete p.lanes[1].name; });
  fires('LANE_NAME', p => { p.lanes[1].name = '  '; });
  // 앞뒤 공백도 그대로 본다 — 잘라 내고 보면 통과하지만, 상태에는 적힌 그대로 들어가 실행기가 `be ` 와 `be-` 를 같은 브랜치(be-)로 깎는다
  for (const bad of ['be/api', 'be api', 'be:api', '.hidden', 'be.', 'be ', ' be']) {
    const r = fires('LANE_NAME', p => { p.lanes[0].name = bad; });
    assert.match(r.errors.find(e => e.code === 'LANE_NAME').msg, /파일 이름으로 쓸 수 없는 글자/, bad);
  }
  // 같은 이름 · 대소문자만 다른 이름 — 두 레인이 같은 결과 파일에 쓴다
  const same = fires('LANE_NAME', p => { p.lanes[1].name = 'be'; });
  assert.match(same.errors.find(e => e.code === 'LANE_NAME').msg, /레인 이름 겹침 — "be" · "be" 의 결과 파일: "be"/);
  assert.equal(same.errors.filter(e => e.code === 'LANE_NAME').length, 1, '같은 묶음은 한 줄');
  fires('LANE_NAME', p => { p.lanes[0].name = 'Impl'; p.lanes[1].name = 'impl'; });
  // Herdr 가 꺼진 프로젝트(워크플로 레인) — 한글 이름·숫자 이름은 서로 다르면 그대로 쓸 수 있다
  silent('LANE_NAME', p => { p.lanes[0].name = '결제'; p.lanes[1].name = '화면'; });
  silent('LANE_NAME', p => { p.lanes[0].name = '1982'; p.lanes[1].name = '1995'; });
  // Herdr 구현 레인이 켜진 프로젝트 — 이름을 [a-z][a-z0-9_-]{0,31} 로 깎아 브랜치·pane 이름을 만든다
  const herdr = structuredClone(CFG); herdr.herdr = { ...herdr.herdr, lanes: 'all' };
  const ko = fires('LANE_NAME', p => { p.lanes[0].name = '결제'; p.lanes[1].name = '화면'; }, { cfg: herdr });
  assert.match(ko.errors.find(e => e.code === 'LANE_NAME').msg, /"결제" · "화면" 의 Herdr 작업트리 브랜치: "lane"/);
  fires('LANE_NAME', p => { p.lanes[0].name = '1982'; p.lanes[1].name = '1995'; }, { cfg: herdr });
  const long = 'abcdefghijklmnopqrstuvwxyz0'; // 27자 — pane 이름은 `impl-` 을 붙여 32자에서 잘린다
  const cut = fires('LANE_NAME', p => { p.lanes[0].name = `${long}-one`; p.lanes[1].name = `${long}-two`; }, { cfg: herdr });
  assert.match(cut.errors.find(e => e.code === 'LANE_NAME').msg, /Herdr pane 이름/);
  silent('LANE_NAME', p => { p.lanes[0].name = 'abc-1982'; p.lanes[1].name = 'abc-1995'; }, { cfg: herdr });
  silent('LANE_NAME', p => { p.lanes[0].name = `${long}-one`; p.lanes[1].name = `${long}-two`; }, undefined);
  // herdr.enabled=false 면 lanes 가 all 이어도 Herdr 실행기는 돌지 않는다 — 결과 파일 축만 본다
  const disabled = structuredClone(herdr); disabled.herdr.enabled = false;
  silent('LANE_NAME', p => { p.lanes[0].name = '결제'; p.lanes[1].name = '화면'; }, { cfg: disabled });
});

test('LANE_WORKTREE — worktree: true 인 레인이 있는데 이 세션이 Herdr 구현 레인을 쓰지 못하면(Herdr 밖 · 설정 꺼짐) 경고 — 설정만 보고 세운 계획이 Herdr 밖에서 그대로 실행되지 않게 · Herdr 여부를 모르면 보지 않는다', () => {
  const wt = p => { p.lanes[0].worktree = true; p.lanes[1].worktree = true; };
  const on = structuredClone(CFG); on.herdr = { ...on.herdr, lanes: 'all' };
  const check = (mut, cfg, herdrInside) => { const plan = cleanPlan(); mut(plan); return checkPlan({ cfg, root: DIR, state: { decisions: [] }, plan, guideText: loadGuideText({ root: DIR, plan }), herdrInside }); };
  const msg = r => r.warnings.find(w => w.code === 'LANE_WORKTREE')?.msg ?? null;
  assert.match(msg(check(wt, on, false)), /레인 be, fe 가 worktree: true 인데 .*Herdr 밖이다/);
  assert.match(msg(check(wt, CFG, true)), /herdr\.lanes 가 implement·all 이 아니다/);
  assert.match(msg(check(wt, CFG, false)), /Herdr 밖이다/, '둘 다 해당하면 실행기가 말하는 순서대로 Herdr 밖을 먼저 든다');
  const disabled = structuredClone(on); disabled.herdr.enabled = false;
  assert.match(msg(check(wt, disabled, true)), /herdr\.enabled 가 false 다/, 'lanes 가 all 이어도 enabled=false 면 실행기는 돌지 않는다');
  assert.ok(!codes(check(wt, on, false).errors).includes('LANE_WORKTREE'), '반영을 막지 않는다');
  assert.equal(msg(check(wt, on, true)), null, 'Herdr 안이고 설정이 켜져 있으면 맞는 계획이다');
  assert.equal(msg(check(() => {}, on, false)), null, 'worktree 가 false 면 어디서든 조용하다');
  assert.equal(msg(check(wt, on, null)), null, 'Herdr 여부를 모르면(값을 받지 못했다) 보지 않는다');
  assert.equal(msg(run(wt)), null, 'herdrInside 를 넘기지 않은 호출도 같다');
});

test('SUBTASK_DOD — [KEY] 로 시작하는 DoD 가 없는 하위이슈 · 한 괄호에 여러 하위를 묶은 표기([KEY·번호·번호])도 덮은 것으로 본다', () => {
  const state = { decisions: [], subtasks: [{ parent: 'ABC-1', children: ['ABC-2'] }] };
  const r = fires('SUBTASK_DOD', () => {}, { state });
  assert.equal(r.errors.find(e => e.code === 'SUBTASK_DOD').id, 'ABC-2');
  silent('SUBTASK_DOD', p => { p.dod[3].text = '[ABC-2] 실화면 확인'; }, { state: structuredClone(state) });
  silent('SUBTASK_DOD');
  const many = { decisions: [], subtasks: [{ parent: 'ABC-1', children: ['ABC-12', 'ABC-13', 'ABC-14'] }] };
  silent('SUBTASK_DOD', p => { p.dod[0].text = '[ABC-12·13] 계산기'; p.dod[1].text = '[ABC-14, ABC-12] 화면'; }, { state: structuredClone(many) });
  const miss = fires('SUBTASK_DOD', p => { p.dod[0].text = '[ABC-12·13] 계산기'; }, { state: structuredClone(many) });
  assert.deepEqual(miss.errors.filter(e => e.code === 'SUBTASK_DOD').map(e => e.id), ['ABC-14']);
  // 번호가 다른 수의 일부로만 들어 있으면(113 안의 13) 덮은 것이 아니다 · 괄호가 맨 앞이 아니면 표기가 아니다
  fires('SUBTASK_DOD', p => { p.dod[0].text = '[ABC-12·113·14] 계산기'; }, { state: structuredClone(many) });
  fires('SUBTASK_DOD', p => { p.dod[0].text = '계산기 [ABC-12·13·14]'; }, { state: structuredClone(many) });
});

test('REQ_UNCOVERED — ## 요구 의 R 번호가 ## DoD 절에 안 나온다(다른 절에 나온 것은 세지 않는다)', () => {
  const guide = GUIDE.replace('- R2 음수', '- R3 환불은 별도(R3)\n- R2 음수');
  const r = fires('REQ_UNCOVERED', () => {}, { guideText: guide });
  assert.deepEqual(r.errors.filter(e => e.code === 'REQ_UNCOVERED').map(e => e.id), ['R3']);
  silent('REQ_UNCOVERED', () => {}, { guideText: guide.replace('- D4 (R1)', '- D4 (R1, R3)') });
  // R1 이 작업 항목 절에만 나오고 DoD 에서는 빠지면 걸린다
  fires('REQ_UNCOVERED', () => {}, { guideText: GUIDE.replace(/- D(\d) \(R1\)/g, '- D$1') });
  // DoD 절에 요구 번호가 하나도 없으면(표기 자체를 안 썼다) 요구마다가 아니라 한 줄로 알린다
  const none = fires('REQ_UNCOVERED', () => {}, { guideText: GUIDE.replace(/- D(\d) \(R\d\)/g, '- D$1') });
  const errs = none.errors.filter(e => e.code === 'REQ_UNCOVERED');
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0].msg, /요구 번호가 하나도 없다\(요구 2건\)/);
});

test('DOD_GUIDE_MISMATCH — 가이드에만 있는 항목은 오류(승인한 검사가 돌지 않는다) · 사이드카에만 있는 항목은 경고(승인 문서에 안 보인다)', () => {
  const r = fires('DOD_GUIDE_MISMATCH', () => {}, { guideText: GUIDE + '- D5 (R2) 가이드에만 있는 항목\n' });
  assert.match(r.errors.find(e => e.code === 'DOD_GUIDE_MISMATCH').msg, /가이드 ## DoD 에만 있고 사이드카 dod 에 없는 항목: D5/);
  const r2 = silent('DOD_GUIDE_MISMATCH', p => { p.dod.push({ id: 'D9', text: 'x', probe: 'echo ok', expect: { pattern: 'ok' } }); });
  assert.match(r2.warnings.find(w => w.code === 'DOD_GUIDE_MISMATCH').msg, /사이드카 dod 에만 있고 가이드 ## DoD 에 없는 항목: D9/);
  // 글자가 붙은 id(D7f)도 토큰 단위로 대조한다 — 가이드의 D7 은 사이드카 D7f 를 덮지 않는다
  const r3 = silent('DOD_GUIDE_MISMATCH', p => { p.dod.push({ id: 'D4f', text: 'x', probe: 'echo ok', expect: { pattern: 'ok' } }); });
  assert.match(r3.warnings.find(w => w.code === 'DOD_GUIDE_MISMATCH').msg, /D4f/);
  silent('DOD_GUIDE_MISMATCH', p => { p.dod.push({ id: 'D4f', text: 'x', probe: 'echo ok', expect: { pattern: 'ok' } }); }, { guideText: GUIDE + '- D4f (R1) 화면 문구\n' }, 'warnings');
  silent('DOD_GUIDE_MISMATCH');
  silent('DOD_GUIDE_MISMATCH', () => {}, undefined, 'warnings');
  // 코드 펜스 안의 `# 주석` 은 제목이 아니다 — 펜스 뒤 D4 줄까지 DoD 절로 읽는다(어긋내면 여전히 걸린다)
  const fenced = GUIDE.replace('- D4 (R1)', '```sh\n# 주입 예시\n./gradlew test\n```\n- D4 (R1)');
  silent('DOD_GUIDE_MISMATCH', () => {}, { guideText: fenced });
  fires('DOD_GUIDE_MISMATCH', () => {}, { guideText: fenced.replace('- D4 (R1)', '- D7 (R1)') });
  // 가이드 DoD 에 D 번호가 하나도 없으면 보지 않는다
  silent('DOD_GUIDE_MISMATCH', () => {}, { guideText: '## 요구\n- R1 a\n## DoD\n- (R1) 아무 번호 없음\n' });
});

// ---------------- 경고 코드 ----------------

test('GUIDE_MISSING — 초안도 확정본도 없다', () => {
  fires('GUIDE_MISSING', p => { p.guides = { 'ABC-1': 'docs/NOPE.md' }; }, undefined, 'warnings');
  silent('GUIDE_MISSING', () => {}, undefined, 'warnings');
});

test('REQ_NO_IDS — ## 요구 에 R 번호가 없다', () => {
  const guide = GUIDE.replace(/- R(\d) /g, '- ').replace(/\(R\d\) /g, '');
  const r = fires('REQ_NO_IDS', () => {}, { guideText: guide }, 'warnings');
  assert.ok(!codes(r.errors).includes('REQ_UNCOVERED'));
  silent('REQ_NO_IDS', () => {}, undefined, 'warnings');
});

test('HUMAN_HEAVY — human 항목이 절반을 넘는다', () => {
  fires('HUMAN_HEAVY', p => { p.dod[0] = { id: 'D1', text: 'a', probe: null, human: true }; p.dod[1] = { id: 'D2', text: 'b', probe: null, human: true }; }, undefined, 'warnings');
  silent('HUMAN_HEAVY', p => { p.dod[0] = { id: 'D1', text: 'a', probe: null, human: true }; }, undefined, 'warnings'); // 2/4 는 절반이지 넘은 것이 아니다
});

test('HUMAN_HAS_PROBE — human 인데 probe/tests 가 있다', () => {
  fires('HUMAN_HAS_PROBE', p => { p.dod[3].probe = 'echo ok'; }, undefined, 'warnings');
  fires('HUMAN_HAS_PROBE', p => { p.dod[3].tests = { stack: 'fe', select: ['src/views'] }; }, undefined, 'warnings');
  silent('HUMAN_HAS_PROBE', () => {}, undefined, 'warnings');
});

test('MIN_ON_SENTINEL — 러너를 부르지 않는 probe 에 min_tests', () => {
  fires('MIN_ON_SENTINEL', p => { p.dod[2] = { id: 'D3', text: 'x', probe: 'grep -q FeeCalculator src/main/java/app/FeeCalculator.java && echo FOUND', expect: { pattern: 'FOUND', min_tests: 1 } }; }, undefined, 'warnings');
  silent('MIN_ON_SENTINEL', p => { p.dod[2] = { id: 'D3', text: 'x', probe: './gradlew test --tests X', expect: { min_tests: 1 } }; }, undefined, 'warnings');
  silent('MIN_ON_SENTINEL', () => {}, undefined, 'warnings');
});

test('TOUCHED_PATH — 경로도 부모 폴더도 없다(glob 은 보지 않는다)', () => {
  const r = fires('TOUCHED_PATH', p => { p.touched.push('backend/srcx/app/Nope.java'); }, undefined, 'warnings');
  assert.match(r.warnings.find(w => w.code === 'TOUCHED_PATH').msg, /srcx/);
  silent('TOUCHED_PATH', p => { p.touched.push('backend/src/main/java/app/NewOne.java'); }, undefined, 'warnings');
  silent('TOUCHED_PATH', p => { p.touched.push('nowhere/**/*.java'); }, undefined, 'warnings');
});

// ---------------- 가정 · 가이드 찾기 ----------------

test('isAssumption · summary.assumptions — assumed:true 또는 (unattended) 로 끝나는 답', () => {
  assert.equal(isAssumption({ q: 'a', a: 'b', assumed: true }), true);
  assert.equal(isAssumption({ q: 'a', a: '권장안 (unattended)' }), true);
  assert.equal(isAssumption({ q: 'a', a: '(unattended) 가 앞에 오면 아님' }), false);
  assert.equal(isAssumption({ q: 'a', a: 'b' }), false);
  const state = { decisions: [{ q: '사람', a: '정함' }, { q: '갈림길1', a: '해석 — 근거', assumed: true }, { q: '갈림길2', a: '권장안 (unattended)' }] };
  assert.deepEqual(run(() => {}, { state }).summary.assumptions, [{ q: '갈림길1', a: '해석 — 근거' }, { q: '갈림길2', a: '권장안 (unattended)' }]);
});

test('loadGuideText — .draft 를 먼저, 없으면 확정본, 둘 다 없으면 null', () => {
  const dir = makeRepo({ guide: null });
  const plan = { guides: { 'ABC-1': 'docs/ABC-1-dev-guide.md' } };
  assert.equal(loadGuideText({ root: dir, plan }), null);
  put(dir, 'docs/ABC-1-dev-guide.md', '확정본');
  assert.equal(loadGuideText({ root: dir, plan }), '확정본');
  put(dir, 'docs/ABC-1-dev-guide.md.draft', '초안');
  assert.equal(loadGuideText({ root: dir, plan }), '초안');
});

// ---------------- CLI ----------------

function startIssue(dir, decisions = []) {
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  const st = newState('feat/ABC-1', ['ABC-1']);
  st.decisions = decisions;
  writeState(join(dir, '.claude/runtime/issues/feat-ABC-1.json'), st);
}
const sidecarPath = dir => join(dir, '.claude/runtime/issues/feat-ABC-1.plan.json');
function cli(dir, ...args) {
  const r = sh(NODE, [join(SCRIPTS, 'plan-check.mjs'), ...args, '--cwd', dir], dir);
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* 사람이 읽는 출력 */ }
  return { status: r.status, json, out: r.stdout, err: r.stderr };
}

test('CLI plan-check — 종료 코드 0/1/2 · --json 모양 · 기본 사이드카 · 상태 JSON 대체', () => {
  const dir = makeRepo();
  assert.equal(cli(dir, '--json').status, 2, '상태가 없으면 2');
  startIssue(dir, [{ q: '갈림길', a: '해석', at: 'x', assumed: true }]);
  assert.equal(cli(dir, '--bogus').status, 2, '모르는 옵션은 2');

  // 사이드카가 없으면 상태 JSON(빈 계획) — PLAN_EMPTY 로 1
  const empty = cli(dir, '--json');
  assert.equal(empty.status, 1, empty.err);
  assert.equal(empty.json.code, 'PLAN_ISSUES');
  assert.equal(empty.json.sidecar, null);
  assert.ok(codes(empty.json.errors).includes('PLAN_EMPTY'));

  writeFileSync(sidecarPath(dir), JSON.stringify(cleanPlan()));
  const ok = cli(dir, '--json');
  assert.equal(ok.status, 0, ok.out + ok.err);
  assert.deepEqual(Object.keys(ok.json).sort(), ['code', 'errors', 'sidecar', 'summary', 'warnings']);
  assert.equal(ok.json.code, 'OK');
  assert.equal(ok.json.sidecar, '.claude/runtime/issues/feat-ABC-1.plan.json');
  assert.deepEqual(ok.json.summary.assumptions, [{ q: '갈림길', a: '해석' }]);

  const bad = cleanPlan();
  bad.dod[0].tests.select = ['*FeeCalculaterTest*'];
  const badFile = join(dir, 'bad.plan.json');
  writeFileSync(badFile, JSON.stringify(bad));
  const b = cli(dir, '--sidecar', badFile, '--json');
  assert.equal(b.status, 1);
  assert.equal(b.json.code, 'PLAN_ISSUES');
  assert.deepEqual(b.json.errors.map(e => [e.code, e.id]), [['SELECT_NO_MATCH', 'D1']]);

  const human = cli(dir, '--sidecar', badFile);
  assert.equal(human.status, 1);
  assert.match(human.out, /\[plan-check\] 오류 SELECT_NO_MATCH D1: /);
  assert.match(human.out, /PLAN_ISSUES/);

  assert.equal(cli(dir, '--sidecar', join(dir, 'nope.json')).status, 2, '읽을 수 없는 사이드카는 2');
  assert.equal(cli(dir, '--branch', 'feat/ABC-9', '--json').status, 2, '그 브랜치 상태가 없으면 2');
});

test('CLI — Herdr 안인지는 설정이 아니라 세션의 환경에서 읽는다: herdr.lanes 가 all 인 프로젝트라도 Herdr 밖 세션이면 plan-check · issue-set 이 LANE_WORKTREE 를 내고, Herdr 안이면 조용하다', () => {
  const dir = makeRepo();
  const cfgPath = join(dir, '.claude/harness.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.herdr = { ...(cfg.herdr ?? {}), lanes: 'all' };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  startIssue(dir);
  const plan = cleanPlan();
  for (const l of plan.lanes) l.worktree = true;
  writeFileSync(sidecarPath(dir), JSON.stringify(plan));
  // 이 테스트를 Herdr pane 안에서 돌려도 결과가 같도록 Herdr 표식 셋을 전부 지우고 필요한 것만 넣는다.
  // Herdr 바이너리는 대역으로 바꾼다 — issue-set 은 Herdr 안이면 상태를 보고하는데, 테스트가 진짜 pane 을 건드리면 안 된다
  const FAKE = `node:${join(HERE, 'fixtures/fake-herdr.mjs')}`;
  const envOf = extra => { const e = { ...process.env }; for (const k of ['HERDR_PANE_ID', 'HERDR_ENV', 'HERDR_SOCKET_PATH']) delete e[k]; return { ...e, JIRA_HARNESS_HERDR: FAKE, ...extra }; };
  const at = (script, args, extra) => spawnSync(NODE, [join(SCRIPTS, script), ...args, '--cwd', dir], { cwd: dir, encoding: 'utf8', windowsHide: true, env: envOf(extra) });
  const warned = extra => codes(JSON.parse(at('plan-check.mjs', ['--json'], extra).stdout.trim().split('\n').pop()).warnings).includes('LANE_WORKTREE');
  assert.equal(warned({}), true, 'Herdr 밖 — 설정이 켜져 있어도 이 세션은 워크플로 레인으로 돈다');
  for (const mark of [{ HERDR_PANE_ID: 'w1:p1' }, { HERDR_ENV: '1' }, { HERDR_SOCKET_PATH: '/tmp/herdr.sock' }]) {
    assert.equal(warned(mark), false, `Herdr 안(${Object.keys(mark)[0]}) — 레인마다 작업트리를 파는 실행기가 돈다`);
  }
  // 반영 경로(issue-set)도 같은 값을 읽는다 — 경고는 반영을 막지 않는다
  const out = at('issue-set.mjs', ['--merge', sidecarPath(dir), '--from', 'plan', '--json'], {});
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /\[issue-set\] plan-check 경고 LANE_WORKTREE: 레인 be, fe 가 worktree: true 인데 .*Herdr 밖이다/);
  const inside = at('issue-set.mjs', ['--merge', sidecarPath(dir), '--from', 'plan', '--json'], { HERDR_PANE_ID: 'w1:p1' });
  assert.equal(inside.status, 0, inside.stderr);
  assert.doesNotMatch(inside.stderr, /LANE_WORKTREE/);
});

// ---------------- issue-set ----------------

function setCmd(dir, args) {
  const r = sh(NODE, [join(SCRIPTS, 'issue-set.mjs'), ...args, '--cwd', dir, '--json'], dir);
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const stateFile = dir => join(dir, '.claude/runtime/issues/feat-ABC-1.json');

test('issue-set --merge --from plan — 오류면 exit 1 · 상태 그대로 / 깨끗하면 반영 / --no-check 는 반영+note / --from plan 없으면 점검 안 함', () => {
  const dir = makeRepo();
  startIssue(dir);
  const bad = cleanPlan();
  bad.dod[0].expect = { min_tests: 0 }; // TESTS_MIN
  bad.lanes[1].files.push('backend/**'); // LANE_OVERLAP(둘 다 작업트리 없음)
  const badFile = join(dir, 'bad.plan.json');
  writeFileSync(badFile, JSON.stringify(bad));

  const before = readFileSync(stateFile(dir), 'utf8');
  const r = setCmd(dir, ['--merge', badFile, '--from', 'plan', '--stage', 'plan']);
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /\[issue-set\] plan-check TESTS_MIN D1: /);
  assert.match(r.err, /\[issue-set\] plan-check LANE_OVERLAP: /);
  assert.equal(readFileSync(stateFile(dir), 'utf8'), before, '거부되면 상태 파일이 한 글자도 바뀌지 않는다');

  // 사유 없는 --no-check 는 사용법 오류
  assert.equal(setCmd(dir, ['--merge', badFile, '--from', 'plan', '--no-check']).status, 2);
  assert.equal(readFileSync(stateFile(dir), 'utf8'), before);

  const skip = setCmd(dir, ['--merge', badFile, '--from', 'plan', '--no-check', '급한 핫픽스']);
  assert.equal(skip.status, 0, skip.err);
  let st = readState(stateFile(dir));
  assert.equal(st.dod.length, 4);
  assert.ok(st.history.some(h => h.note === 'plan merged (check skipped: 급한 핫픽스)'), JSON.stringify(st.history));

  // --from plan 이 아닌 병합(레인 사이드카 등)은 점검하지 않는다
  const dir2 = makeRepo();
  startIssue(dir2);
  const plain = setCmd(dir2, ['--merge', badFile]);
  assert.equal(plain.status, 0, plain.err);
  assert.ok(!plain.err.includes('plan-check'), plain.err);

  // 깨끗한 계획은 반영된다(경고는 stderr 로 내고 진행)
  const dir3 = makeRepo();
  startIssue(dir3);
  const goodFile = join(dir3, 'good.plan.json');
  const good = cleanPlan();
  good.touched.push('backend/srcx/Typo.java'); // TOUCHED_PATH 경고
  writeFileSync(goodFile, JSON.stringify(good));
  const ok = setCmd(dir3, ['--merge', goodFile, '--from', 'plan']);
  assert.equal(ok.status, 0, ok.err);
  assert.match(ok.err, /plan-check 경고 TOUCHED_PATH/);
  st = readState(stateFile(dir3));
  assert.equal(st.dod.length, 4);
  assert.equal(st.lanes.length, 2);
  assert.ok(st.history.some(h => h.note === 'plan merged'));
});

test('issue-set --merge --from plan 재반영 — 검사가 그대로인 항목의 판정·근거와 구현 중 기록은 남고, 검사가 바뀐 항목만 비워진다', () => {
  const dir = makeRepo();
  startIssue(dir);
  const file = join(dir, 'p.plan.json');
  writeFileSync(file, JSON.stringify(cleanPlan()));
  assert.equal(setCmd(dir, ['--merge', file, '--from', 'plan']).status, 0);

  // 구현 중에 쌓인 기록 — 사람 확인 PASS+근거 · 자동 항목 판정 2건 · 더한 경로 · 레인 결과
  const rec = setCmd(dir, [
    '--dod-result', 'D4', 'PASS', '--evidence', '요금 화면에서 음수 입력이 거부되는 것을 봤다',
    '--dod-result', 'D1', 'PASS', '--dod-result', 'D2', 'PASS',
    '--touched', 'backend/src/main/java/app/FeeExporter.java',
    '--lane', JSON.stringify({ name: 'be', model: 'opus', kind: 'codex', kind_source: 'pool', result: { status: 'done', applied: 'yes' } }),
  ]);
  assert.equal(rec.status, 0, rec.err);

  // 검사가 바뀌어 다시 반영한다 — D1 은 기대 건수를 올렸고(다시 재야 한다) D5 가 새로 생겼다. D2·D4 는 그대로다
  const next = cleanPlan();
  next.dod[0].expect = { min_tests: 5 };
  next.dod.push({ id: 'D5', text: '내보내기 파일 확인', probe: null, human: true });
  writeFileSync(file, JSON.stringify(next));
  const again = setCmd(dir, ['--merge', file, '--from', 'plan']);
  assert.equal(again.status, 0, again.err);

  const st = readState(stateFile(dir));
  const by = Object.fromEntries(st.dod.map(d => [d.id, d]));
  assert.equal(by.D4.last, 'PASS');
  assert.equal(by.D4.evidence, '요금 화면에서 음수 입력이 거부되는 것을 봤다', '손대지 않은 사람 확인의 근거가 남는다');
  assert.equal(by.D2.last, 'PASS', '검사가 그대로인 자동 항목의 판정이 남는다');
  assert.equal(by.D1.last, undefined, '검사(기대 건수)가 바뀐 항목은 지난 판정을 옮기지 않는다');
  assert.equal(by.D1.expect.min_tests, 5);
  assert.equal(by.D5.last, undefined);
  assert.ok(st.touched.includes('backend/src/main/java/app/FeeExporter.java'), '구현 중 더한 경로가 남는다');
  assert.equal(st.touched.filter(t => t === 'frontend/src/views/fee.js').length, 1, '합집합이라 겹치지 않는다');
  const be = st.lanes.find(l => l.name === 'be');
  assert.deepEqual(be.result, { status: 'done', applied: 'yes' }, '실행기가 남긴 레인 결과가 남는다');
  assert.equal(be.kind, 'codex');
  assert.equal(be.kind_source, 'pool');
});

test('issue-set --assume → assumed:true · human 의 PASS 는 --evidence 필수 · probe 항목은 근거 없이 PASS', () => {
  const dir = makeRepo();
  startIssue(dir);
  const a = setCmd(dir, ['--decision', '사람이 정함', '예', '--assume', '목록 정렬 기준', '최신순 — 기존 화면과 같게']);
  assert.equal(a.status, 0, a.err);
  let st = readState(stateFile(dir));
  assert.equal(st.decisions[0].assumed, undefined);
  assert.equal(st.decisions[1].assumed, true);
  assert.equal(st.decisions[1].a, '최신순 — 기존 화면과 같게');
  assert.ok(st.decisions[1].at);

  assert.equal(setCmd(dir, ['--dod', JSON.stringify({ id: 'D1', text: 'p', probe: 'echo ok' }), '--dod', JSON.stringify({ id: 'D2', text: 'h', probe: null, human: true }), '--dod', JSON.stringify({ id: 'D3', text: '확인 방법 없음', probe: null })]).status, 0);
  const before = readFileSync(stateFile(dir), 'utf8');
  const noEv = setCmd(dir, ['--dod-result', 'D2', 'PASS']);
  assert.equal(noEv.status, 1);
  assert.match(noEv.err, /사람 확인 항목은 어디서 무엇을 봤는지 한 줄이 있어야 PASS 로 남긴다/);
  // probe·tests 가 없는 항목은 human 표시가 없어도 게이트가 사람 확인으로 친다 — 같은 기준으로 근거를 요구한다
  assert.equal(setCmd(dir, ['--dod-result', 'D3', 'PASS']).status, 1);
  assert.equal(readFileSync(stateFile(dir), 'utf8'), before);

  assert.equal(setCmd(dir, ['--evidence', '근거만']).status, 2, '앞에 --dod-result 가 없으면 사용법 오류');
  assert.equal(setCmd(dir, ['--dod-result', 'D2', 'PASS', '--stage', 'review', '--evidence', 'x']).status, 2, '바로 앞이 --dod-result 여야 한다');

  assert.equal(setCmd(dir, ['--dod-result', 'D2', 'FAIL']).status, 0, 'FAIL 은 근거 없이도 된다');
  const ev = setCmd(dir, ['--dod-result', 'D2', 'PASS', '--evidence', 'QA 정산 화면에서 합계 12,000 확인', '--dod-result', 'D1', 'PASS']);
  assert.equal(ev.status, 0, ev.err);
  st = readState(stateFile(dir));
  const d2 = st.dod.find(d => d.id === 'D2');
  assert.equal(d2.last, 'PASS');
  assert.equal(d2.evidence, 'QA 정산 화면에서 합계 12,000 확인');
  const d1 = st.dod.find(d => d.id === 'D1');
  assert.equal(d1.last, 'PASS');
  assert.equal(d1.evidence, undefined);
});

// ---------------- issue-complete ----------------

test('issue-complete --dry-run --json — 가정이 맨 위 · tests 항목은 사람 확인이 아니다 · 확인한 human 근거가 보인다', () => {
  // 게이트는 fixture 그대로(dod_tests 없음)로 돌리고, DoD 는 게이트 뒤에 얹는다(runtime 은 지문 밖)
  const dir = mkdtempSync(join(tmpdir(), 'jh-plancheck-complete-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'core.autocrlf', 'false');
  put(dir, 'docs/README.md', '# docs\n');
  put(dir, 'backend/App.java', 'class App {}\n');
  put(dir, 'frontend/app.js', 'export default 1\n');
  put(dir, '.gitignore', '.claude/harness.env.local\n');
  put(dir, '.claude/harness.json', readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8'));
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  put(dir, 'backend/App.java', 'class App { int x; }\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'feat: ABC-1');
  writeState(stateFile(dir), newState('feat/ABC-1', ['ABC-1']));
  const gr = sh(NODE, [join(SCRIPTS, 'gate.mjs'), '--full', '--cwd', dir], dir);
  assert.equal(gr.status, 0, gr.stderr + gr.stdout);

  const st = readState(stateFile(dir));
  st.review = { tree: st.gate.tree, files: [], codex: 'skipped', lanes: 0, findings: 0, blockers_open: 0, round: 1, delta_passes: 0, at: new Date().toISOString() };
  st.decisions = [
    { q: '사람이 정한 것', a: '예', at: 't0' },
    { q: '목록 정렬 기준', a: '최신순 — 기존 화면과 같게', at: 't1', assumed: true },
    { q: '빈 값 표시', a: '대시(-) (unattended)', at: 't2' },
  ];
  st.dod = [
    { id: 'D1', text: 't1', probe: null, tests: { stack: 'be', select: ['*A*'] }, expect: { min_tests: 1 }, last: 'PASS' },
    { id: 'D2', text: 't2', probe: null, tests: { stack: 'fe', select: ['src'] }, expect: { min_tests: 1 }, last: 'FAIL' },
    { id: 'D3', text: 'h', probe: null, human: true, last: 'PASS', evidence: 'QA 화면에서 합계 확인' },
  ];
  writeState(stateFile(dir), st);

  const r = sh(NODE, [join(SCRIPTS, 'issue-complete.mjs'), '--dry-run', '--json', '--cwd', dir], dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = JSON.parse(r.stdout.trim().split('\n').pop());
  const lines = j.jira.comment.split('\n');
  assert.equal(lines[1], '- 확인이 필요한 가정 2건(사람 결정 없이 고른 해석):', j.jira.comment);
  assert.equal(lines[2], '  - 목록 정렬 기준 → 최신순 — 기존 화면과 같게');
  assert.equal(lines[3], '  - 빈 값 표시 → 대시(-) (unattended)');
  assert.deepEqual(j.summary.assumptions, [
    { q: '목록 정렬 기준', a: '최신순 — 기존 화면과 같게', at: 't1' },
    { q: '빈 값 표시', a: '대시(-) (unattended)', at: 't2' },
  ]);
  // tests 항목 2 + human 1 → 사람 확인 분모는 1
  assert.ok(lines.includes('- DoD: 테스트 항목 1/2 PASS · 사람 확인 1/1 확인'), j.jira.comment);
  assert.ok(lines.includes('  - D3: QA 화면에서 합계 확인'), j.jira.comment);
  assert.ok(!lines.find(l => l.startsWith('- DoD:')).includes('SKIPPED'), j.jira.comment);
  assert.deepEqual(j.summary.dod_human_pending, []);
  assert.deepEqual(j.summary.dod_human, [{ id: 'D3', last: 'PASS', evidence: 'QA 화면에서 합계 확인' }]);
  assert.equal(j.summary.gate.dod_human, 1);

  // 가정이 없으면 아무 줄도 넣지 않는다 — 둘째 줄은 종전대로 게이트 줄
  st.decisions = [{ q: '사람이 정한 것', a: '예', at: 't0' }];
  writeState(stateFile(dir), st);
  const r2 = sh(NODE, [join(SCRIPTS, 'issue-complete.mjs'), '--dry-run', '--json', '--cwd', dir], dir);
  const j2 = JSON.parse(r2.stdout.trim().split('\n').pop());
  assert.match(j2.jira.comment.split('\n')[1], /^- 게이트: /);
  assert.ok(!j2.jira.comment.includes('확인이 필요한 가정'));
  assert.deepEqual(j2.summary.assumptions, []);
});
