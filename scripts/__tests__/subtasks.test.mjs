// subtasks.test.mjs — 하위이슈 기본 처리: lib/subtasks.mjs · issue-subtasks.mjs · issue-start --group · 스키마 · plan.js 프롬프트.
// 기존 테스트 파일은 건드리지 않는다 — 헬퍼는 여기서 자체로 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState } from '../lib/config.mjs';
import { assertValid } from '../lib/schema.mjs';
import { resolveSubtasks, findResumable } from '../lib/subtasks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const ROOT = join(HERE, '..', '..').replace(/\\/g, '/');
const NODE = process.execPath;

function sh(cmd, args, cwd, input) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, input }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }

function makeRepo(patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-subtasks-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'core.autocrlf', 'false');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# x\n');
  const cfg = { ...JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8')), ...patch };
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// getJiraIssue 응답 모양(MCP): { key, fields: { subtasks: [{ key, fields: { summary, status: { name, statusCategory: { key } } } }] } }
const sub = (key, summary, status = '해야 할 일', category = 'new') => ({ key, fields: { summary, status: { name: status, statusCategory: { key: category } } } });
const issue = (key, ...subtasks) => ({ key, fields: { subtasks } });

function resolver(dir, issues, extra = []) {
  const r = sh(NODE, [join(SCRIPTS, 'issue-subtasks.mjs'), '--in', '-', ...extra, '--cwd', dir], dir, JSON.stringify(issues));
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* not json */ }
  return { status: r.status, out, err: r.stderr };
}
function start(dir, keysArg, extra = []) {
  const r = sh(NODE, [join(SCRIPTS, 'issue-start.mjs'), keysArg, ...extra, '--cwd', dir, '--json'], dir);
  let out = null;
  try { out = JSON.parse(r.stdout.trim()); } catch { /* not json */ }
  return { status: r.status, out, err: r.stderr };
}
const stateFile = (dir, slug) => join(dir, '.claude/runtime/issues', `${slug}.json`);

// ---------- lib ----------

test('resolveSubtasks: 이슈가 몇 개든 각각의 하위를 같이 꺼낸다 — 부모가 앞, 하위는 번호 순', () => {
  const r = resolveSubtasks([
    issue('ABC-10', sub('ABC-13', 'c'), sub('ABC-11', 'a'), sub('ABC-12', 'b')),
    issue('ABC-20', sub('ABC-21', 'x')),
    issue('ABC-30'), // 하위 없음 — 그냥 키만
  ], { prefix: 'ABC' });
  assert.deepEqual(r.keys, ['ABC-10', 'ABC-20', 'ABC-30', 'ABC-11', 'ABC-12', 'ABC-13', 'ABC-21']);
  assert.deepEqual(r.groups, [{ parent: 'ABC-10', children: ['ABC-11', 'ABC-12', 'ABC-13'] }, { parent: 'ABC-20', children: ['ABC-21'] }]);
});

test('resolveSubtasks: 끝난 하위·다른 프로젝트·이미 준 키·match 밖은 빼고 사유를 남긴다', () => {
  const r = resolveSubtasks([
    issue('ABC-10',
      sub('ABC-11', '[DDL] 컬럼'),
      sub('ABC-12', '[server] 엔티티'),
      sub('ABC-13', '[mobile] 미러링'),
      sub('ABC-14', '[server] 끝난 것', '완료', 'done'),
      sub('ABC-15', '[server] QA 로 넘긴 것', 'QA', 'indeterminate'),
      sub('XYZ-1', '[server] 남의 프로젝트'),
      sub('ABC-16', '[server] 사용자가 직접 준 키')),
    { key: 'ABC-16', fields: { subtasks: [] } },
  ], { prefix: 'ABC', match: '^\\[(DDL|server)\\]', doneTransition: 'QA' });
  assert.deepEqual(r.keys, ['ABC-10', 'ABC-16', 'ABC-11', 'ABC-12']);
  const why = Object.fromEntries(r.children.map((c) => [c.key, c.reason]));
  assert.deepEqual(why, { 'ABC-11': null, 'ABC-12': null, 'ABC-13': 'no-match', 'ABC-14': 'done', 'ABC-15': 'done', 'ABC-16': 'already', 'XYZ-1': 'other-project' });
});

test('resolveSubtasks: fields 없이 subtasks 만 와도, 두 부모에 걸린 같은 하위는 한 번만', () => {
  const r = resolveSubtasks([
    { key: 'abc-1', subtasks: [{ key: 'abc-5', summary: 's', status: { name: '해야 할 일' } }] },
    { key: 'ABC-2', fields: { subtasks: [sub('ABC-5', 's')] } },
  ], { prefix: 'ABC' });
  assert.deepEqual(r.keys, ['ABC-1', 'ABC-2', 'ABC-5']);
  assert.deepEqual(r.groups, [{ parent: 'ABC-1', children: ['ABC-5'] }]);
});

test('findResumable: 진행 중 상태의 첫 키가 주어진 키 중 하나면 그 브랜치를 이어 간다 — 아카이브는 제외', () => {
  const states = [
    { branch: 'feat/ABC-1', keys: ['ABC-1'], stage: 'archived' },
    { branch: 'feat/ABC-10-11-12', keys: ['ABC-10', 'ABC-11', 'ABC-12'], stage: 'plan', subtasks: [{ parent: 'ABC-10', children: ['ABC-11', 'ABC-12'] }] },
  ];
  assert.equal(findResumable(states, ['ABC-1']), null);
  assert.equal(findResumable(states, ['ABC-11']), null, '하위 키만으로는 부모 브랜치를 가로채지 않는다');
  const hit = findResumable(states, ['abc-10']);
  assert.equal(hit.branch, 'feat/ABC-10-11-12');
  assert.deepEqual(hit.keys, ['ABC-10', 'ABC-11', 'ABC-12']);
});

// ---------- issue-subtasks.mjs · issue-start --group ----------

test('issue-subtasks: 여러 이슈의 하위를 확장하고 match 가 없으면 confirm=true, flag match 면 false', () => {
  const dir = makeRepo();
  const issues = [issue('ABC-10', sub('ABC-11', '[DDL] a'), sub('ABC-12', '[mobile] b')), issue('ABC-20', sub('ABC-21', '[server] c'))];
  const r = resolver(dir, issues);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.code, 'EXPANDED');
  assert.deepEqual(r.out.keys, ['ABC-10', 'ABC-20', 'ABC-11', 'ABC-12', 'ABC-21']);
  assert.equal(r.out.keys_arg, 'ABC-10,ABC-20,ABC-11,ABC-12,ABC-21');
  assert.deepEqual(r.out.group_args, ['ABC-10=ABC-11,ABC-12', 'ABC-20=ABC-21']);
  assert.equal(r.out.confirm, true);
  assert.equal(r.out.match_source, null);

  const m = resolver(dir, issues, ['--match', '^\\[(DDL|server)\\]']);
  assert.deepEqual(m.out.keys, ['ABC-10', 'ABC-20', 'ABC-11', 'ABC-21']);
  assert.equal(m.out.confirm, false);
  assert.equal(m.out.match_source, 'flag');
});

test('issue-subtasks: harness.json subtasks.match 를 읽는다 · 하위가 없으면 NO_SUBTASKS · 깨진 입력은 exit 2', () => {
  const dir = makeRepo({ subtasks: { match: '^\\[server\\]' } });
  const r = resolver(dir, [issue('ABC-10', sub('ABC-11', '[server] a'), sub('ABC-12', '[DDL] b'))]);
  assert.equal(r.out.match_source, 'config');
  assert.deepEqual(r.out.keys, ['ABC-10', 'ABC-11']);
  assert.equal(r.out.confirm, false);

  const none = resolver(dir, [issue('ABC-30')]);
  assert.equal(none.out.code, 'NO_SUBTASKS');
  assert.deepEqual(none.out.keys, ['ABC-30']);
  assert.deepEqual(none.out.group_args, []);

  assert.equal(sh(NODE, [join(SCRIPTS, 'issue-subtasks.mjs'), '--in', '-', '--cwd', dir], dir, 'not json').status, 2);
  assert.equal(resolver(dir, [{ summary: 'key 없음' }]).status, 2);
  assert.equal(resolver(dir, [issue('ABC-1')], ['--match', '(']).status, 2);
});

test('start --group: 하위 묶음이 상태에 기록되고 브랜치에 모든 키가 들어간다 · --status 가 보여 준다', () => {
  const dir = makeRepo();
  const r = start(dir, 'ABC-10,ABC-11,ABC-12', ['--group', 'ABC-10=ABC-11,ABC-12']);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.code, 'STARTED');
  assert.equal(r.out.branch, 'feat/ABC-10-11-12');
  assert.deepEqual(r.out.subtasks, [{ parent: 'ABC-10', children: ['ABC-11', 'ABC-12'] }]);
  const st = readState(stateFile(dir, 'feat-ABC-10-11-12'));
  assert.deepEqual(st.keys, ['ABC-10', 'ABC-11', 'ABC-12']);
  assert.deepEqual(st.subtasks, [{ parent: 'ABC-10', children: ['ABC-11', 'ABC-12'] }]);
  const s = sh(NODE, [join(SCRIPTS, 'issue-start.mjs'), '--status', '--cwd', dir, '--json'], dir);
  assert.deepEqual(JSON.parse(s.stdout.trim()).subtasks, [{ parent: 'ABC-10', children: ['ABC-11', 'ABC-12'] }]);
});

test('start --group: 키 목록 밖의 키·빈 하위·형식 오류는 exit 2 이고 브랜치를 만들지 않는다', () => {
  const dir = makeRepo();
  for (const bad of ['ABC-10=ABC-99', 'ABC-99=ABC-11', 'ABC-10=', 'ABC-10']) {
    const r = start(dir, 'ABC-10,ABC-11', ['--group', bad]);
    assert.equal(r.status, 2, `${bad}: ${r.err}`);
  }
  assert.equal(g(dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('재개: 진행 중 브랜치가 있으면 Jira 하위 구성이 바뀌어도 RESUME 으로 같은 keys — start 는 RESUMED 이고 group 을 덮지 않는다', () => {
  const dir = makeRepo();
  assert.equal(start(dir, 'ABC-10,ABC-11,ABC-12', ['--group', 'ABC-10=ABC-11,ABC-12']).out.code, 'STARTED');
  g(dir, 'checkout', '-q', 'main');
  // 그 사이 Jira 에서 ABC-11 이 끝나고 ABC-13 이 새로 생겼다 — 그래도 이어 간다
  const r = resolver(dir, [issue('ABC-10', sub('ABC-11', 'a', '완료', 'done'), sub('ABC-12', 'b'), sub('ABC-13', 'c'))]);
  assert.equal(r.out.code, 'RESUME');
  assert.deepEqual(r.out.keys, ['ABC-10', 'ABC-11', 'ABC-12']);
  assert.equal(r.out.resume.branch, 'feat/ABC-10-11-12');
  assert.equal(r.out.keys_arg, 'ABC-10,ABC-11,ABC-12');
  assert.deepEqual(r.out.group_args, []);
  const again = start(dir, r.out.keys_arg, ['--group', 'ABC-10=ABC-12']);
  assert.equal(again.out.code, 'RESUMED');
  assert.deepEqual(again.out.keys, ['ABC-10', 'ABC-11', 'ABC-12']);
  assert.deepEqual(readState(stateFile(dir, 'feat-ABC-10-11-12')).subtasks, [{ parent: 'ABC-10', children: ['ABC-11', 'ABC-12'] }]);
});

// ---------- 스키마 ----------

test('스키마: 상태 subtasks·레인 key, harness subtasks.match 를 받는다 — 모양이 틀리면 거부', () => {
  const base = { version: 3, branch: 'feat/ABC-1-2', keys: ['ABC-1', 'ABC-2'], stage: 'plan', started_at: 'x', updated_at: 'x', history: [] };
  assertValid({ ...base, subtasks: [{ parent: 'ABC-1', children: ['ABC-2'] }], lanes: [{ name: 'abc-2', model: 'opus', key: 'ABC-2' }] }, 'state');
  assert.throws(() => assertValid({ ...base, subtasks: [{ parent: 'ABC-1' }] }, 'state'), /스키마 위반/);
  assert.throws(() => assertValid({ ...base, lanes: [{ name: 'a', model: 'opus', key: 2 }] }, 'state'), /스키마 위반/);
  const cfg = JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8'));
  assertValid({ ...cfg, subtasks: { match: '^\\[server\\]' } }, 'harness');
  assertValid({ ...cfg, subtasks: { match: null } }, 'harness');
  assert.throws(() => assertValid({ ...cfg, subtasks: { match: 3 } }, 'harness'), /스키마 위반/);
});

// ---------- plan.js ----------

function simPlan(args) {
  const argv = [`${ROOT}/scripts/dev/wf-sim.mjs`, `${ROOT}/workflows/plan.js`, '--args', JSON.stringify(args), '--json', '--prompts', '--responses', `${HERE.replace(/\\/g, '/')}/wf/plan-design-ok.json`];
  const r = spawnSync(NODE, argv, { encoding: 'utf8', windowsHide: true });
  assert.ok(r.stdout.trim(), r.stderr);
  const out = JSON.parse(r.stdout);
  return { out, prompt: (label) => out.calls.find((c) => c.label === label).prompt };
}

test('plan.js: 하위 구성이 Design·scope 프롬프트에 붙고, Herdr 꺼짐(A)/켜짐(B)에서 레인 규칙이 갈린다', () => {
  const subtasks = [{ parent: 'ABC-10', children: [{ key: 'ABC-11', summary: '[DDL] 컬럼 추가' }, { key: 'ABC-12', summary: '[server] soft delete' }] }];
  const common = {
    keys: ['ABC-10', 'ABC-11', 'ABC-12'], issueBodies: { 'ABC-10': '부모', 'ABC-11': 'DDL', 'ABC-12': '엔티티' }, guidePaths: { 'ABC-10': 'docs/ABC-10-dev-guide.md' },
    hasWiki: false, hasMemory: false, wikiHits: [], decisions: [], sidecarPath: 'runtime/issues/feat-ABC-10-11-12.plan.json', repoRoot: '/tmp/project', ts: '2026-01-01T00:00:00Z',
  };
  const none = simPlan({ ...common, keys: ['ABC-10'], issueBodies: { 'ABC-10': '부모' } });
  const a = simPlan({ ...common, subtasks });
  const b = simPlan({ ...common, subtasks, herdrKinds: ['claude', 'codex'] });
  for (const s of [a, b]) {
    assert.equal(s.out.error, null, s.out.error ?? '');
    assert.equal(s.out.result.verdict, 'PASS');
    const design = s.prompt('design');
    assert.ok(design.includes('하위이슈 구성') && design.includes('ABC-10 의 하위: ABC-11 ([DDL] 컬럼 추가) · ABC-12 ([server] soft delete)'), '하위 목록이 Design 프롬프트에 없다');
    assert.ok(design.includes('Phase 0'), '선행 하위 Phase 0 지시가 없다');
    assert.ok(s.prompt('verify:scope').includes('ABC-11, ABC-12'), 'scope 검증에 하위 DoD 누락 기준이 없다');
  }
  assert.ok(!none.prompt('design').includes('하위이슈 구성'), '하위가 없으면 프롬프트가 안 바뀐다');
  assert.ok(!none.prompt('verify:scope').includes('[KEY]'));
  assert.ok(a.prompt('design').includes('모든 레인의 worktree 는 false') && !a.prompt('design').includes('하위이슈마다 레인 하나'), '전략 A: worktree 금지');
  assert.ok(b.prompt('design').includes('하위이슈마다 레인 하나') && !b.prompt('design').includes('모든 레인의 worktree 는 false'), '전략 B: 하위마다 레인');
  // 문자열 키만 와도 받고, 하위가 빈 묶음은 무시한다
  const s = simPlan({ ...common, subtasks: [{ parent: 'ABC-10', children: ['ABC-11'] }, { parent: 'ABC-99', children: [] }] });
  assert.ok(s.prompt('design').includes('ABC-10 의 하위: ABC-11') && !s.prompt('design').includes('ABC-99'));
});
