// 워크플로 테스트 — workflows/plan-check.js 의 **제어 흐름**을 wf-sim 으로 실행해 검사한다.
// 모델을 부르지 않으므로 검증 대상은 레인 수·model 명시·schema 유무·반환 모양·거부 경로다(반증의 품질 판정이 아니다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const ROOT = join(HERE, '..', '..').replace(/\\/g, '/');
const SIM = `${ROOT}/scripts/dev/wf-sim.mjs`;
const WF = `${ROOT}/workflows/plan-check.js`;
const RESP = (name) => `${HERE}/wf/${name}`;

function sim(args, responses, extra = []) {
  const argv = [SIM, WF, '--args', JSON.stringify(args), '--json', ...extra];
  if (responses) argv.push('--responses', responses);
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', windowsHide: true });
  assert.ok(r.stdout.trim(), `wf-sim 이 출력을 내지 않았다: ${r.stderr}`);
  return { ...JSON.parse(r.stdout), exit: r.status };
}

const ARGS = {
  repoRoot: '/tmp/project',
  keys: ['ABC-123'],
  issueBodies: { 'ABC-123': '요금 표시 칸이 계산 결과와 다르다. 잘못된 입력은 거부돼야 한다.' },
  decisions: [
    { q: '고객 청구액을 깎는가', a: '깎는다', at: '2026-01-01T00:00:00Z' },
    { q: '내보내기 파일도 같이 고치는가', a: '화면만 — 본문에 내보내기 언급이 없다', at: '2026-01-01T00:00:00Z', assumed: true },
  ],
  draftPaths: ['docs/ABC-123-dev-guide.md.draft'],
  sidecarPath: '.claude/runtime/issues/feat-ABC-123.plan.json',
};

test('plan-check (a) 정상 — 에이전트 1개·model 명시(기본 opus)·schema·phase 「반증」·PASS 반환 모양', () => {
  const out = sim(ARGS, RESP('plan-check-pass.json'));
  assert.equal(out.error, null, out.error ?? '');
  assert.equal(out.exit, 0);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].label, 'plan-check');
  assert.equal(out.calls[0].model, 'opus');
  assert.ok(out.calls[0].hasSchema);
  assert.deepEqual(out.phases, ['반증']);
  assert.equal(out.meta.name, 'plan-check');
  assert.deepEqual(out.meta.phases.map((p) => p.title), ['반증']);
  assert.equal(out.result.verdict, 'PASS');
  assert.deepEqual(out.result.blockers, []);
  assert.equal(out.result.looked.length, 3);
  assert.equal(out.result.dead, undefined);
});

test('plan-check meta 는 순수 리터럴이다(변수·전개·호출 없음)', () => {
  const src = readFileSync(WF, 'utf8');
  const i = src.indexOf('export const meta =');
  assert.equal(src.slice(0, i).split('\n').every((l) => l.trim() === '' || l.trim().startsWith('//')), true, 'meta 앞에는 주석만 온다');
  const literal = src.slice(src.indexOf('{', i), src.indexOf('};', i) + 1);
  assert.ok(!/[`$]\{|\.\.\.|\(\)/.test(literal), 'meta 는 순수 리터럴이어야 한다');
});

test('plan-check (b) 프롬프트 — 원문·결정이 값으로 실리고 가정은 [가정] 으로 표시되며 경로는 읽으라고만 한다', () => {
  const out = sim({ ...ARGS, wikiHits: ['docs/INDEX.md:12 | ABC-123 | 요금'], mechanical: 'REQ_NO_IDS 경고 1건' }, RESP('plan-check-pass.json'), ['--prompts']);
  const p = out.calls[0].prompt;
  assert.match(p, /### ABC-123\n요금 표시 칸이 계산 결과와 다르다/);
  assert.match(p, /- 고객 청구액을 깎는가 → 깎는다/);
  assert.match(p, /- \[가정\] 내보내기 파일도 같이 고치는가 → 화면만/);
  assert.match(p, /가이드 초안\(직접 읽는다\): docs\/ABC-123-dev-guide\.md\.draft/);
  assert.match(p, /사이드카\(직접 읽는다\): \.claude\/runtime\/issues\/feat-ABC-123\.plan\.json/);
  assert.match(p, /docs\/INDEX\.md:12/);
  assert.match(p, /REQ_NO_IDS 경고 1건/);
  assert.match(p, /읽기 전용/);
});

test('plan-check (c) 무인 표기 `(unattended)` 로 끝나는 옛 결정도 가정으로 읽는다', () => {
  const out = sim({ ...ARGS, decisions: [{ q: '소급하는가', a: '소급하지 않는다 (unattended)' }] }, RESP('plan-check-pass.json'), ['--prompts']);
  assert.match(out.calls[0].prompt, /- \[가정\] 소급하는가 → 소급하지 않는다 \(unattended\)/);
});

test('plan-check (d) model 은 args 로 덮는다', () => {
  const out = sim({ ...ARGS, model: 'sonnet' }, RESP('plan-check-pass.json'));
  assert.equal(out.calls[0].model, 'sonnet');
});

test('plan-check (e) blocker 가 있으면 에이전트가 verdict 를 PASS 라고 적어도 BLOCK 이다 · 빈 blocker 는 버린다', () => {
  const out = sim(ARGS, RESP('plan-check-block.json'));
  assert.equal(out.error, null, out.error ?? '');
  assert.equal(out.result.verdict, 'BLOCK');
  assert.equal(out.result.blockers.length, 1);
  assert.match(out.result.blockers[0].where, /ReportExporter/);
  assert.equal(out.result.dead, undefined);
});

test('plan-check 위반 주입 ① 에이전트가 죽으면 통과가 아니라 BLOCK(dead)', () => {
  const out = sim(ARGS, RESP('plan-check-dead.json'));
  assert.equal(out.error, null, out.error ?? '');
  assert.equal(out.result.verdict, 'BLOCK');
  assert.equal(out.result.dead, true);
  assert.match(out.result.blockers[0].what, /결과를 내지 못했다/);
});

test('plan-check 위반 주입 ② 아무것도 열어 보지 않은 PASS(검사 0건)는 BLOCK(dead)', () => {
  // 응답 파일 없이 돌리면 wf-sim 이 schema 에서 최소 객체(PASS · 빈 배열)를 합성한다 — 그게 곧 「검사 0건의 초록」이다.
  const out = sim(ARGS);
  assert.equal(out.error, null, out.error ?? '');
  assert.equal(out.result.verdict, 'BLOCK');
  assert.equal(out.result.dead, true);
  assert.match(out.result.blockers[0].what, /아무것도 열어 보지 않고/);
});

test('plan-check (f) 필수 args 누락은 에이전트를 띄우기 전에 명확한 메시지로 throw 한다', () => {
  const cases = [
    ['repoRoot', /args\.repoRoot/],
    ['keys', /args\.keys/],
    ['issueBodies', /args\.issueBodies/],
    ['draftPaths', /args\.draftPaths/],
    ['sidecarPath', /args\.sidecarPath/],
  ];
  for (const [k, re] of cases) {
    const a = { ...ARGS };
    delete a[k];
    const out = sim(a);
    assert.ok(out.error, `${k} 없이 throw 하지 않았다`);
    assert.match(out.error, /plan-check\.js:/);
    assert.match(out.error, re);
    assert.equal(out.calls.length, 0);
  }
});
