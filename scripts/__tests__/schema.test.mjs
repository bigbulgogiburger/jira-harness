// S1 계약 테스트 — 스키마·브랜치 해석·glob·상태 쓰기.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validate, loadSchema, assertValid } from '../lib/schema.mjs';
import { parseBranch, expandKeys, globToRegExp, matchesAny, allDocsOnly, stacksTouched, deepMerge, writeState, readState, newState, branchSlug } from '../lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = name => JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));

test('픽스처 harness.json / state.json 은 스키마를 통과한다', () => {
  assert.deepEqual(validate(fixture('harness.json'), loadSchema('harness')), []);
  assert.deepEqual(validate(fixture('state.json'), loadSchema('state')), []);
});

test('위반 주입: 잘못된 mode · 필수 키 누락 · 트리 id 형식 · enum 밖 결과값이 각각 잡힌다', () => {
  const h = fixture('harness.json');
  h.mode = 'yolo';
  delete h.issue_prefix;
  const he = validate(h, loadSchema('harness'));
  assert.ok(he.some(e => e.includes('$.mode')), he.join('\n'));
  assert.ok(he.some(e => e.includes('issue_prefix')), he.join('\n'));

  const s = fixture('state.json');
  s.gate.tree = 'not-a-sha';
  s.gate.results.compile = 'GREEN';
  s.stage = 'done';
  const se = validate(s, loadSchema('state'));
  assert.ok(se.some(e => e.includes('$.gate.tree')), se.join('\n'));
  assert.ok(se.some(e => e.includes('$.gate.results.compile')), se.join('\n'));
  assert.ok(se.some(e => e.includes('$.stage')), se.join('\n'));
  assert.throws(() => assertValid(s, 'state'), /스키마 위반/);
});

test('브랜치 해석: 단일 키 · 다중 키 · 접미사 · 패턴 밖', () => {
  const cfg = fixture('harness.json');
  assert.deepEqual(parseBranch('feat/ABC-950', cfg).keys, ['ABC-950']);
  assert.deepEqual(parseBranch('feat/ABC-696-940-943', cfg).keys, ['ABC-696', 'ABC-940', 'ABC-943']);
  assert.deepEqual(parseBranch('fix/ABC-12-hotfix', cfg).keys, ['ABC-12']);
  assert.equal(parseBranch('feature/ABC-1', cfg), null);
  assert.equal(parseBranch('main', cfg), null);
  assert.equal(parseBranch(null, cfg), null);
  assert.equal(branchSlug('feat/ABC-696-940-943'), 'feat-ABC-696-940-943');
  assert.deepEqual(expandKeys('ABC-1-XYZ-2', 'ABC'), ['ABC-1', 'XYZ-2']);
});

test('glob: **/*.md · docs/** · 스택 경로', () => {
  assert.ok(globToRegExp('**/*.md').test('a/b/c.md'));
  assert.ok(globToRegExp('**/*.md').test('README.md'));
  assert.ok(!globToRegExp('**/*.md').test('a/b.mdx'));
  assert.ok(globToRegExp('docs/**').test('docs/x/y.txt'));
  assert.ok(!globToRegExp('docs/**').test('backend/docs.txt'));
  const cfg = fixture('harness.json');
  assert.equal(allDocsOnly(['docs/a.md', 'README.md'], cfg), true);
  assert.equal(allDocsOnly(['docs/a.md', 'backend/App.java'], cfg), false);
  assert.equal(allDocsOnly([], cfg), false);
  const loaded = { ...cfg, stacks: { be: { ...cfg.stacks.be, paths: ['backend/**'] }, fe: { ...cfg.stacks.fe, paths: ['frontend/**'] } } };
  assert.deepEqual(stacksTouched(['backend/App.java', 'docs/a.md'], loaded), ['be']);
  assert.deepEqual(stacksTouched(['frontend/App.vue', 'backend/App.java'], loaded).sort(), ['be', 'fe']);
});

test('deepMerge: 객체 재귀 · 배열 교체 · null 은 값', () => {
  const base = { a: { x: 1, y: 2 }, list: [1, 2], keep: true };
  const out = deepMerge(base, { a: { y: 3, z: 4 }, list: [9], gone: null });
  assert.deepEqual(out, { a: { x: 1, y: 3, z: 4 }, list: [9], keep: true, gone: null });
  assert.deepEqual(base.a, { x: 1, y: 2 }, '원본 불변');
});

test('writeState: 원자 쓰기 · 검증 실패면 파일을 만들지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jh-state-'));
  const file = join(dir, 'issues', 'feat-ABC-1.json');
  const st = newState('feat/ABC-1', ['ABC-1']);
  writeState(file, st);
  assert.ok(existsSync(file));
  assert.equal(readState(file).branch, 'feat/ABC-1');
  assert.ok(!readdirSync(join(dir, 'issues')).some(f => f.endsWith('.tmp')), 'tmp 파일 잔존 없음');
  const bad = { ...readState(file), stage: 'nope' };
  assert.throws(() => writeState(join(dir, 'issues', 'bad.json'), bad), /스키마 위반/);
  assert.ok(!existsSync(join(dir, 'issues', 'bad.json')));
});
