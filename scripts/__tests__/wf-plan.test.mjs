// A2 워크플로 테스트 — workflows/plan.js · workflows/recon.js 의 **제어 흐름**을 wf-sim 으로 실행해 검사한다.
// 모델을 부르지 않으므로 검증 대상은 레인 수·순서·model 명시·schema 유무·반환 모양·거부 경로다(품질 판정이 아니다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const ROOT = join(HERE, '..', '..').replace(/\\/g, '/');
const SIM = `${ROOT}/scripts/dev/wf-sim.mjs`;
const WF = (name) => `${ROOT}/workflows/${name}`;
const RESP = (name) => `${HERE}/wf/${name}`;
const NODE = process.execPath;

// wf-sim 은 meta 를 리터럴이 평가되는 자리에서 잡는다(top-level return 뒤가 아니라) — 경고는 전부 실패로 본다.
const realWarnings = (out) => out.warnings;

function sim(file, args, responses) {
  const argv = [SIM, file, '--args', JSON.stringify(args), '--json'];
  if (responses) argv.push('--responses', responses);
  const r = spawnSync(NODE, argv, { encoding: 'utf8', windowsHide: true });
  assert.ok(r.stdout.trim(), `wf-sim 이 출력을 내지 않았다: ${r.stderr}`);
  return { ...JSON.parse(r.stdout), exit: r.status };
}

// meta 는 순수 리터럴 규약이므로 소스에서 그대로 떼어 평가한다(wf-sim 이 못 읽는 것을 여기서 대신 본다).
function readMeta(file) {
  const src = readFileSync(file, 'utf8');
  const i = src.indexOf('export const meta =');
  assert.notEqual(i, -1, 'export const meta 로 시작해야 한다');
  const start = src.indexOf('{', i);
  let depth = 0;
  let end = -1;
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  assert.ok(end > start, 'meta 리터럴의 끝을 찾지 못했다');
  const literal = src.slice(start, end);
  assert.ok(!/[`$]\{|\.\.\.|\(\)/.test(literal), 'meta 는 순수 리터럴이어야 한다(변수·전개·호출 금지)');
  return new Function(`return (${literal})`)();
}

const PLAN_ARGS = {
  keys: ['ABC-123'],
  issueBodies: { 'ABC-123': '요금 표시 칸이 계산 결과와 다르다. 잘못된 입력은 거부돼야 한다.' },
  guidePaths: { 'ABC-123': 'docs/ABC-123-dev-guide.md' },
  hasWiki: true,
  hasMemory: true,
  wikiHits: ['docs/INDEX.md:12 | ABC-123 | 요금'],
  decisions: [{ q: '고객 청구액을 깎는가', a: '깎는다', at: '2026-01-01T00:00:00Z' }],
  sidecarPath: 'runtime/issues/feat-ABC-123.plan.json',
  repoRoot: '/tmp/project',
  ts: '2026-01-01T00:00:00Z',
};
const planArgs = (patch = {}) => ({ ...PLAN_ARGS, ...patch });

test('plan (a) 정상 args — 레인 6개·phase 순서·model 전부 명시·반환 모양', () => {
  const out = sim(WF('plan.js'), PLAN_ARGS, RESP('plan-design-ok.json'));
  assert.equal(out.error, null, out.error ?? '');
  assert.equal(out.exit, 0);
  assert.deepEqual(realWarnings(out), []);

  assert.deepEqual(out.calls.map((c) => c.label), [
    'understand:code', 'understand:wiki', 'understand:issue', 'design', 'verify:constraints', 'verify:scope',
  ]);
  assert.deepEqual(out.calls.map((c) => c.model), ['sonnet', 'sonnet', 'haiku', 'opus', 'sonnet', 'sonnet']);
  for (const c of out.calls) {
    assert.ok(c.model, `${c.label} 에 model 이 없다`);
    assert.ok(c.hasSchema, `${c.label} 에 schema 가 없다`);
    assert.ok(c.promptChars > 200, `${c.label} 프롬프트가 너무 얇다(${c.promptChars}자)`);
  }
  assert.deepEqual(out.phases, ['Understand', 'Design', 'Verify']);
  assert.deepEqual(out.calls.map((c) => c.phase), [
    'Understand', 'Understand', 'Understand', 'Design', 'Verify', 'Verify',
  ]);

  const r = out.result;
  assert.equal(r.verdict, 'PASS');
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.guides, { 'ABC-123': 'docs/ABC-123-dev-guide.md' });
  assert.deepEqual(r.draftPaths, ['docs/ABC-123-dev-guide.md.draft']);
  assert.equal(r.sidecarPath, PLAN_ARGS.sidecarPath);
  assert.equal(r.lanes.length, 2);
  assert.equal(r.dod.length, 3);
  assert.deepEqual(r.touched, ['backend/src/FeeService.java', 'frontend/src/FeeView.vue']);
  // 사이드카는 상태 스키마의 부분집합이어야 한다 — 레인·DoD 필수 키 확인
  for (const lane of r.lanes) for (const k of ['name', 'model', 'files', 'worktree', 'brief']) assert.ok(k in lane, `lane 에 ${k} 없음`);
  for (const d of r.dod) for (const k of ['id', 'text', 'human']) assert.ok(k in d, `dod 에 ${k} 없음`);
  assert.ok(r.understand.code && 'paths' in r.understand.code);
  assert.ok(r.understand.wiki && 'decisions' in r.understand.wiki);
  assert.ok(r.understand.requirements && 'requirements' in r.understand.requirements);
});

test('plan meta 는 선언 phase 와 실제 phase() 가 일치한다', () => {
  const meta = readMeta(WF('plan.js'));
  assert.equal(meta.name, 'jira-harness-plan');
  assert.ok(meta.description);
  assert.deepEqual(meta.phases.map((p) => p.title), ['Understand', 'Design', 'Verify']);
});

test('plan (b) hasWiki=false — wiki 레인이 없고 요구 레인 매핑이 밀리지 않는다', () => {
  const out = sim(WF('plan.js'), planArgs({ hasWiki: false, wikiHits: [] }), RESP('plan-design-ok.json'));
  assert.equal(out.error, null, out.error ?? '');
  assert.deepEqual(realWarnings(out), []);
  assert.deepEqual(out.calls.map((c) => c.label), [
    'understand:code', 'understand:issue', 'design', 'verify:constraints', 'verify:scope',
  ]);
  assert.equal(out.result.understand.wiki, null);
  // 인덱스가 한 칸 밀리면 요구 레인 결과가 코드 레인 것으로 바뀐다 — 그것을 잡는다.
  assert.ok('requirements' in out.result.understand.requirements);
  assert.ok('paths' in out.result.understand.code);
  assert.equal(out.result.verdict, 'PASS');
});

test('plan (c) verify 한 레인이 BLOCK 이면 전체 BLOCK — 사유가 레인 이름과 함께 남는다', () => {
  const out = sim(WF('plan.js'), PLAN_ARGS, RESP('plan-scope-block.json'));
  assert.equal(out.error, null, out.error ?? '');
  const r = out.result;
  assert.equal(r.verdict, 'BLOCK');
  assert.equal(r.blockers.length, 2);
  for (const b of r.blockers) assert.match(b, /^verify:scope: /);
  assert.match(r.blockers.join('\n'), /범위 이탈/);
  // BLOCK 이어도 Design 을 재시도하지 않는다 — design 레인은 정확히 1회다.
  assert.equal(out.calls.filter((c) => c.label === 'design').length, 1);
  assert.equal(out.calls.length, 6);
});

test('plan 위반 주입 ① lanes·dod 가 빈 설계는 초록으로 통과하지 않는다', () => {
  // responses 없이 = schema 최소 객체(lanes: [], dod: []) 가 돌아온다. 계획이 비었는데 PASS 면 승인 게이트가 무의미하다.
  const out = sim(WF('plan.js'), PLAN_ARGS);
  assert.equal(out.result.verdict, 'BLOCK');
  const joined = out.result.blockers.join('\n');
  assert.match(joined, /lanes 가 비어 있다/);
  assert.match(joined, /dod 가 비어 있다/);
});

test('plan 위반 주입 ② Design 레인이 죽으면 BLOCK — 산출물 없음을 PASS 로 읽지 않는다', () => {
  const out = sim(WF('plan.js'), PLAN_ARGS, RESP('plan-design-dead.json'));
  assert.equal(out.result.verdict, 'BLOCK');
  assert.match(out.result.blockers.join('\n'), /Design 레인이 결과를 반환하지 않았다/);
  // 설계가 없어도 guides 는 호출자가 준 확정 경로로 되돌아온다(초안 경로가 유실되지 않는다).
  assert.deepEqual(out.result.guides, PLAN_ARGS.guidePaths);
});

test('plan (d) 필수 args 누락은 각각 명확한 메시지로 throw 한다', () => {
  const cases = [
    [{ keys: [] }, /args\.keys/],
    [{ issueBodies: undefined }, /args\.issueBodies/],
    [{ guidePaths: {} }, /args\.guidePaths/],
    [{ sidecarPath: undefined }, /args\.sidecarPath/],
    [{ repoRoot: '' }, /args\.repoRoot/],
  ];
  for (const [patch, re] of cases) {
    const a = planArgs(patch);
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete a[k];
    const out = sim(WF('plan.js'), a);
    assert.ok(out.error, `${JSON.stringify(patch)} 로 throw 하지 않았다`);
    assert.match(out.error, /plan\.js:/);
    assert.match(out.error, re);
    assert.equal(out.exit, 1);
    assert.equal(out.calls.length, 0, '인자 검증 전에 에이전트를 띄우면 안 된다');
  }
});

const RECON_ARGS = {
  keys: ['ABC-123', 'ABC-124', 'ABC-125'],
  issueBodies: { 'ABC-123': '본문 1', 'ABC-124': '본문 2', 'ABC-125': '본문 3' },
  hints: ['요금 도메인'],
  repoRoot: '/tmp/project',
};

test('recon (a) 정상 args — 1레인 sonnet·phase Recon·반환 3필드', () => {
  const out = sim(WF('recon.js'), RECON_ARGS);
  assert.equal(out.error, null, out.error ?? '');
  assert.equal(out.exit, 0);
  assert.deepEqual(realWarnings(out), []);
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].label, 'recon');
  assert.equal(out.calls[0].model, 'sonnet');
  assert.ok(out.calls[0].hasSchema);
  assert.ok(out.calls[0].promptChars > 200);
  assert.deepEqual(out.phases, ['Recon']);
  assert.deepEqual(Object.keys(out.result).sort(), ['branchPoints', 'scope', 'unknowns']);
  assert.ok(Array.isArray(out.result.branchPoints));
  assert.ok(Array.isArray(out.result.unknowns));

  const meta = readMeta(WF('recon.js'));
  assert.equal(meta.name, 'jira-harness-recon');
  assert.deepEqual(meta.phases.map((p) => p.title), ['Recon']);
});

test('recon model 은 args 로 덮을 수 있다', () => {
  const out = sim(WF('recon.js'), { ...RECON_ARGS, model: 'haiku' });
  assert.equal(out.calls[0].model, 'haiku');
});

test('recon 위반 주입 — 레인이 죽으면 빈 초록이 아니라 미확인으로 되돌린다', () => {
  const out = sim(WF('recon.js'), RECON_ARGS, RESP('recon-dead.json'));
  assert.equal(out.error, null, out.error ?? '');
  assert.deepEqual(out.result.branchPoints, []);
  assert.equal(out.result.unknowns.length, 1);
  assert.match(out.result.unknowns[0], /반환하지 않았다/);
});

test('recon (d) 필수 args 누락은 명확한 메시지로 throw 한다', () => {
  const cases = [
    [{ keys: undefined }, /args\.keys/],
    [{ issueBodies: undefined }, /args\.issueBodies/],
    [{ repoRoot: undefined }, /args\.repoRoot/],
  ];
  for (const [patch, re] of cases) {
    const a = { ...RECON_ARGS };
    for (const k of Object.keys(patch)) delete a[k];
    const out = sim(WF('recon.js'), a);
    assert.ok(out.error, `${JSON.stringify(Object.keys(patch))} 로 throw 하지 않았다`);
    assert.match(out.error, /recon\.js:/);
    assert.match(out.error, re);
    assert.equal(out.calls.length, 0);
  }
});
