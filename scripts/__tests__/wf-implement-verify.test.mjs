// A3+A4 워크플로 테스트 — wf-sim(에이전트 스텁)으로 implement.js / verify.js 의 **제어 흐름**을 검사한다.
// 모델을 부르지 않으므로 판정 대상은 "레인 수·격리 플래그·반환 모양·거부" 뿐이다. 리뷰 품질은 여기서 못 잰다.
// 통과 케이스만 세면 게이트가 아무것도 안 봐도 초록이므로, 거부(필수 args 누락)와 죽은 레인도 함께 단언한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SIM = join(ROOT, 'scripts/dev/wf-sim.mjs');
const WF = (name) => join(ROOT, 'workflows', name);
const RESP = (name) => join(HERE, 'wf', name);
const NODE = process.execPath;

// wf-sim 은 meta 를 리터럴이 평가되는 자리에서 잡는다 — 경고는 한 건도 허용하지 않는다(meta 미수집도 실패).
function sim(file, args, responses, extra = []) {
  const argv = [SIM, WF(file), '--args', JSON.stringify(args), '--json', ...extra];
  if (responses) argv.push('--responses', RESP(responses));
  const r = spawnSync(NODE, argv, { encoding: 'utf8', windowsHide: true });
  assert.ok(r.stdout, `wf-sim 이 출력을 내지 않았다: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  out.exitCode = r.status;
  out.realWarnings = out.warnings;
  return out;
}
function ok(out) {
  assert.equal(out.error, null, `워크플로가 throw 했다: ${out.error}`);
  assert.deepEqual(out.realWarnings, [], 'model 누락·짧은 프롬프트 등 규칙 위반 경고');
  return out;
}

const IMPL_ARGS = {
  lanes: [
    { name: 'be', model: 'opus', files: ['backend/src/A.java'], worktree: false, brief: '엔티티와 서비스를 계약대로 구현한다' },
    { name: 'fe', model: 'sonnet', files: ['frontend/src/App.vue'], brief: '화면에서 실패를 보이게 한다' }
  ],
  guidePaths: { 'ABC-1': 'docs/ABC-1-dev-guide.md' },
  contracts: { dto: 'RepairView', api: 'GET /repairs/{id}' },
  sidecarDir: '.claude/runtime/issues',
  sidecarPrefix: 'feat-ABC-1',
  repoRoot: 'C:\\work\\demo',
  ts: '2026-01-01T00:00:00Z'
};

const VERIFY_ARGS = {
  diffRef: 'main...HEAD',
  repoRoot: '/work/demo',
  changedFiles: ['backend/src/entity/User.java', 'frontend/src/App.vue', 'docs/note.md'],
  dispatch: {
    'backend/**/entity/**': ['a-rev'],
    'frontend/**': ['b-rev'],
    '**/*.md': ['c-rev']
  },
  axes: ['보안', '성능'],
  lanesMax: 2,
  laneModel: 'sonnet',
  ts: '2026-01-01T00:00:00Z'
};

// ── (a) implement: 레인 2개 → agent 2회 · 전부 한 작업트리 · 반환 모양
test('implement: 레인마다 1콜, 선언한 모델로 — 레인은 전부 한 작업트리에서 돈다(격리 작업트리를 붙이지 않는다)', () => {
  const out = ok(sim('implement.js', IMPL_ARGS));
  assert.equal(out.calls.length, 2);
  assert.deepEqual(out.calls.map(c => c.label), ['lane:be', 'lane:fe']);
  assert.deepEqual(out.calls.map(c => c.model), ['opus', 'sonnet']);
  assert.deepEqual(out.calls.map(c => c.isolation), [null, null], '격리 작업트리의 변경을 메인으로 가져오는 단계가 없다 — 붙이면 구현이 떠 버린다');
  assert.ok(out.calls.every(c => c.hasSchema), '레인 반환은 schema 로 받는다');
  assert.deepEqual(out.phases, ['레인 구현']);

  assert.equal(out.result.lanes.length, 2);
  assert.deepEqual(out.result.lanes.map(l => l.name), ['be', 'fe']);
  assert.deepEqual(out.result.failed, []);
  assert.deepEqual(out.result.sidecars, [
    '.claude/runtime/issues/feat-ABC-1.lane-be.json',
    '.claude/runtime/issues/feat-ABC-1.lane-fe.json'
  ]);
  for (const l of out.result.lanes) {
    assert.equal(l.status, 'done');
    assert.equal(typeof l.tests.passed, 'number');
    assert.equal(l.sidecar, `.claude/runtime/issues/feat-ABC-1.lane-${l.name}.json`);
  }
});

test('implement: worktree: true 레인은 받지 않는다 — 에이전트를 하나도 띄우지 않고 멈추며, 고칠 곳(사이드카의 worktree · 계획 점검 다시)을 알린다', () => {
  const args = { ...IMPL_ARGS, lanes: [{ ...IMPL_ARGS.lanes[0], worktree: true }, IMPL_ARGS.lanes[1]] };
  const out = sim('implement.js', args);
  assert.match(String(out.error), /implement: 레인 be 가 worktree: true 다 — 워크플로 레인은 전부 한 작업트리에서 돈다/);
  assert.match(String(out.error), /issue-set\.mjs --merge <사이드카> --from plan/);
  assert.match(String(out.error), /LANE_OVERLAP/);
  assert.equal(out.calls.length, 0, '겹치는 파일을 허용한 계획일 수 있다 — 한 레인이라도 띄우면 서로의 수정을 덮는다');
  // 여러 개면 전부 이름을 든다 · worktree 가 없거나 false 인 레인은 그대로 돈다
  const both = sim('implement.js', { ...IMPL_ARGS, lanes: IMPL_ARGS.lanes.map(l => ({ ...l, worktree: true })) });
  assert.match(String(both.error), /레인 be, fe 가 worktree: true 다/);
  assert.equal(ok(sim('implement.js', IMPL_ARGS)).calls.length, 2);
});

test('implement: 프롬프트에 가이드 경로·계약·담당 파일·경계 금지가 들어가고, 레인은 빌드·테스트를 돌리지 않는다(돌리지 않아도 done — 검증은 전부 돌아온 뒤 메인이 한 번)', () => {
  const args = { ...IMPL_ARGS, lanes: [IMPL_ARGS.lanes[0], { ...IMPL_ARGS.lanes[1], key: 'ABC-2', dod: ['D2', { id: 'D3' }] }] };
  const out = ok(sim('implement.js', args, null, ['--prompts']));
  const [be, fe] = out.calls.map(c => c.prompt);
  for (const p of [be, fe]) {
    assert.match(p, /docs\/ABC-1-dev-guide\.md/);
    assert.match(p, /RepairView/);
    assert.match(p, /담당 파일 밖은 수정하지 않는다/);
    assert.match(p, /## 검증/);
    assert.doesNotMatch(p, /실행하지 않았으면 tests\.command 를 빈 문자열로 두고 status 는 partial/, '테스트를 못 돌리는 레인을 전부 partial 로 몰던 규칙');
  }
  // 레인은 전부 한 작업트리에서 돈다 — 남이 반쯤 쓴 파일까지 컴파일되므로 어느 레인도 돌리지 않는다
  for (const p of [be, fe]) {
    assert.match(p, /\*\*빌드·테스트·lint 를 돌리지 않는다\.\*\*/);
    assert.match(p, /테스트를 돌리지 않은 것은 미완이 아니다 — 맡은 구현과 테스트 코드를 다 썼으면 status 는 done 이다/);
    assert.match(p, /메인이 돌려야 할 테스트/);
    assert.doesNotMatch(p, /그 스택의 러너로 한 번에 묶어 돌리고/, '자기 테스트를 돌리라는 규칙은 자기 작업트리가 있는 레인(Herdr 실행기)의 것이다');
  }
  assert.match(fe, /너는 이슈 ABC-2 의 구현 레인 "fe" 이다/);
  assert.match(fe, /## 이 레인이 닫아야 할 DoD\n가이드 `## DoD` 의 D2, D3/);
  assert.doesNotMatch(be, /이 레인이 닫아야 할 DoD/, 'dod 를 안 준 레인에는 그 절을 만들지 않는다');
});

// ── (b) implement: 레인 하나가 죽으면(반환 null) 조용히 빠지지 않는다
test('implement: 죽은 레인은 status failed 로 채워 failed 에 이름이 남는다', () => {
  const out = ok(sim('implement.js', IMPL_ARGS, 'implement-lane-dead.json'));
  assert.equal(out.calls.length, 2);
  assert.equal(out.result.lanes.length, 2, '죽은 레인을 목록에서 빠뜨리면 안 된다');
  assert.deepEqual(out.result.failed, ['fe']);

  const be = out.result.lanes[0];
  assert.equal(be.status, 'done');
  assert.equal(be.tests.passed, 12);
  assert.deepEqual(be.files, ['backend/src/A.java']);

  const fe = out.result.lanes[1];
  assert.equal(fe.status, 'failed');
  assert.deepEqual(fe.files, []);
  assert.match(fe.notes, /반환/);
  assert.equal(fe.sidecar, '.claude/runtime/issues/feat-ABC-1.lane-fe.json', '죽은 레인도 사이드카 경로는 알려준다(파일 존재 ≠ 완주)');
});

// ── (c) verify: dispatch 매칭 · 레인 수 상한 · 무음 절단 금지
test('verify: dispatch 로 묶고 상한을 넘긴 레인은 dropped 와 log 에 남는다', () => {
  const out = ok(sim('verify.js', VERIFY_ARGS));
  assert.equal(out.calls.length, 2, 'lanesMax 를 넘겨선 안 된다');
  assert.deepEqual(out.result.lanes, [
    { label: 'verify:a-rev', agentType: 'a-rev', count: 0 },
    { label: 'verify:b-rev', agentType: 'b-rev', count: 0 }
  ]);
  assert.deepEqual(out.result.dropped, ['verify:c-rev', 'verify:보안', 'verify:성능']);
  assert.ok(out.logs.some(l => l.includes('verify:c-rev') && l.includes('뺀 레인')), '무음 절단 금지 — 뺀 레인을 log 로 남긴다');
  assert.equal(out.result.delta, false);
  assert.ok(out.calls.every(c => c.model === 'sonnet'));
});

test('verify: 상한이 충분하면 dispatch 레인 뒤에 축 레인이 붙고 축 레인엔 agentType 이 없다', () => {
  const out = ok(sim('verify.js', { ...VERIFY_ARGS, lanesMax: 5 }));
  assert.equal(out.calls.length, 5);
  assert.deepEqual(out.result.lanes.map(l => l.label), ['verify:a-rev', 'verify:b-rev', 'verify:c-rev', 'verify:보안', 'verify:성능']);
  assert.deepEqual(out.result.lanes.slice(3).map(l => l.agentType), [null, null]);
  assert.deepEqual(out.result.dropped, []);
});

test('verify: glob 은 첫 매칭이 임자 — 뒤에 둔 "*" 는 폴백으로만 걸린다', () => {
  const out = ok(sim('verify.js', {
    ...VERIFY_ARGS,
    axes: [],
    lanesMax: 4,
    dispatch: { 'backend/**/entity/**': ['a-rev'], '*': ['fallback-rev'] }
  }));
  assert.deepEqual(out.result.lanes.map(l => l.label), ['verify:a-rev', 'verify:fallback-rev']);
  assert.deepEqual(out.result.lanes.map(l => l.count), [0, 0]);
});

// ── (d) verify: 델타 패스는 정확히 1레인
test('verify: delta 가 있으면 1레인 · agentType 없음 · delta true', () => {
  const out = ok(sim('verify.js', { ...VERIFY_ARGS, delta: { sinceTree: '9f1c0de', files: ['backend/src/entity/User.java'] } }));
  assert.equal(out.calls.length, 1, '델타는 레인 1개다');
  assert.equal(out.calls[0].label, 'verify:delta');
  assert.equal(out.result.delta, true);
  assert.equal(out.result.lanes[0].agentType, null);
  assert.deepEqual(out.result.dropped, []);
});

// ── (e) 중복 finding 병합
test('verify: 같은 file+line+claim 은 하나로 병합되고 severity 는 더 센 쪽으로 올라간다', () => {
  const out = ok(sim('verify.js', VERIFY_ARGS, 'verify-dup-findings.json'));
  assert.deepEqual(out.result.lanes.map(l => l.count), [1, 3], '레인별 원본 건수는 그대로 센다');
  assert.equal(out.result.findings.length, 2, '경로 구분자·대소문자·공백·마침표만 다른 주장은 같은 건이다');

  const first = out.result.findings[0];
  assert.equal(first.severity, 'BLOCKER', '먼저 온 MINOR 가 뒤의 BLOCKER 를 삼키면 병합이 결함을 지운다');
  assert.equal(first.file, 'backend/src/entity/User.java');
  assert.equal(first.line, 42);
  assert.equal(first.axis, 'a-rev');

  assert.equal(out.result.findings[1].severity, 'MAJOR');
  assert.ok(!out.result.findings.some(f => !f.file), 'file 없는 finding 은 버린다');
});

// ── (f) 필수 args 누락 = 거부(위반 주입)
test('거부: 필수 args 가 없으면 워크플로가 throw 한다', () => {
  const cases = [
    ['implement.js', { ...IMPL_ARGS, lanes: [] }, /lanes/],
    ['implement.js', { ...IMPL_ARGS, sidecarPrefix: undefined }, /sidecarPrefix/],
    ['implement.js', { ...IMPL_ARGS, repoRoot: undefined }, /repoRoot/],
    ['verify.js', { ...VERIFY_ARGS, diffRef: undefined }, /diffRef/],
    ['verify.js', { ...VERIFY_ARGS, repoRoot: undefined }, /repoRoot/],
    ['verify.js', { ...VERIFY_ARGS, changedFiles: [], delta: undefined }, /changedFiles/]
  ];
  for (const [file, args, re] of cases) {
    const out = sim(file, args);
    assert.ok(out.error, `${file} 이 잘못된 args 를 통과시켰다: ${JSON.stringify(args).slice(0, 80)}`);
    assert.match(out.error, re);
    assert.equal(out.calls.length, 0, '거부됐는데 에이전트를 띄우면 안 된다');
    assert.equal(out.exitCode, 1);
  }
});
