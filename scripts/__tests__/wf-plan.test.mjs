// A2 워크플로 테스트 — workflows/plan.js 의 **제어 흐름**을 wf-sim 으로 실행해 검사한다.
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

function sim(file, args, responses, extra = []) {
  const argv = [SIM, file, '--args', JSON.stringify(args), '--json', ...extra];
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

test('plan (e) herdrKinds 가 오면 Design 프롬프트에 kind 선택 지시·프로파일이 붙고, 없으면 붙지 않는다', () => {
  const base = sim(WF('plan.js'), PLAN_ARGS, RESP('plan-design-ok.json'));
  const withKinds = sim(WF('plan.js'), planArgs({ herdrKinds: ['codex', 'claude', 'grok'], herdrProfiles: { codex: '닫힌 구현', grok: '작은 변경' } }), RESP('plan-design-ok.json'));
  assert.equal(withKinds.error, null, withKinds.error ?? '');
  const d0 = base.calls.find((c) => c.label === 'design').promptChars;
  const d1 = withKinds.calls.find((c) => c.label === 'design').promptChars;
  assert.ok(d1 > d0 + 150, `kind 지시가 Design 프롬프트에 붙지 않았다(${d0} → ${d1})`);
  assert.equal(withKinds.result.verdict, 'PASS');
  // 다른 레인의 프롬프트는 그대로다 — kind 는 Design 만의 관심사
  for (const label of ['understand:code', 'verify:scope']) {
    assert.equal(withKinds.calls.find((c) => c.label === label).promptChars, base.calls.find((c) => c.label === label).promptChars, label);
  }
  // 빈 배열·문자열 아님 은 "없음" 과 같다
  const empty = sim(WF('plan.js'), planArgs({ herdrKinds: [] }), RESP('plan-design-ok.json'));
  assert.equal(empty.calls.find((c) => c.label === 'design').promptChars, d0);
});

test('plan (f) 구현 레인의 단위 — 이슈 1건은 「레인 1개」(직접 구현), 이슈 여러 건(다중 키 · 하위이슈)은 「이슈마다 레인 하나」 · Herdr 구현 레인이 꺼져 있으면 한 작업트리(worktree 전부 false)', () => {
  const design = (args) => sim(WF('plan.js'), args, RESP('plan-design-ok.json'), ['--prompts']).calls.find((c) => c.label === 'design').prompt;
  const subtasks = [{ parent: 'ABC-123', children: [{ key: 'ABC-124', summary: '서버' }, { key: 'ABC-125', summary: '화면' }] }];
  const multiKey = { keys: ['ABC-123', 'ABC-200'], issueBodies: { 'ABC-123': '요금 표시', 'ABC-200': '알림 문구' } };
  const PER_ISSUE = /\*\*이슈마다 레인 하나\*\*를 두고 동시에 구현한다/;
  const ONE_TREE = /\*\*모든 레인의 worktree 는 false\*\*/;

  // 이슈 1건 · Herdr 꺼짐 — 드라이버가 직접 구현한다. 나누는 길은 사용자의 명시뿐이다
  const off = design(PLAN_ARGS);
  assert.match(off, /\*\*레인은 1개로 둔다\*\* — 이슈 1건은 드라이버 세션 하나가 한 작업트리에서 직접 구현한다/);
  assert.match(off, /사용자가 이 이슈의 병렬 구현을 명시했을 때만 2개 이상/);
  assert.ok(!PER_ISSUE.test(off) && !off.includes('Herdr 구현 레인이 켜져 있다'));

  // 이슈 여러 건 · Herdr 꺼짐 — 이슈마다 레인 하나, 한 작업트리에서 동시에(파일 소유가 겹치면 합친다)
  for (const args of [planArgs(multiKey), planArgs({ subtasks })]) {
    const p = design(args);
    assert.match(p, PER_ISSUE);
    assert.match(p, ONE_TREE);
    assert.match(p, /레인 객체에 `key`/);
    assert.match(p, /Phase 0 — 메인이 먼저 구현하고 커밋/);
    assert.match(p, /레인이 4개를 넘으면/, '레인 수가 불어나지 않게 묶는 기준이 있다');
    assert.match(p, /레인이 2개 이상이면 레인마다 `dod` 를 쓴다 — 그 레인이 통과시켜야 하는 DoD 의 id 배열/, '레인이 구현 중 돌릴 「자기 테스트」의 근거');
    assert.ok(!p.includes('레인은 1개로 둔다'), '이슈 여러 건을 차례로 하라고 지시하지 않는다');
  }
  assert.match(design(planArgs(multiKey)), /ABC-123, ABC-200/, '어느 키들인지 프롬프트에 실린다');

  // Herdr 켜짐 — 이슈 1건의 지시는 그대로이고, 이슈 여러 건이면 이슈마다 레인(각자 worktree 라 「전부 false」 지시는 없다)
  const on = design(planArgs({ herdrKinds: ['codex', 'claude'] }));
  assert.ok(!on.includes('레인은 1개로 둔다') && !PER_ISSUE.test(on));
  assert.match(on, /나눌 근거가 없으면 레인 1개로 둔다/);
  assert.match(on, /\*\*Herdr 구현 레인이 켜져 있다\*\*/);
  for (const args of [planArgs({ herdrKinds: ['codex'], subtasks }), planArgs({ herdrKinds: ['codex'], ...multiKey })]) {
    const p = design(args);
    assert.match(p, PER_ISSUE);
    assert.ok(!ONE_TREE.test(p));
    assert.match(p, /\*\*Herdr 구현 레인이 켜져 있다\*\*/);
  }
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
