// lint-changed.test.mjs — lib/lint-changed.mjs(이슈 게이트의 lint 를 바뀐 파일로 좁히기). 좁히는 경우와 **좁히지 않는 경우**(대상 없음 · 전체로 넘김)를
// 함께 본다 — 좁히는 경우만 재면 「아무것도 검사하지 않은 초록」과 구분되지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { planLint, LINT_FALLBACK_FULL, LINT_MAX_FILES } from '../lib/lint-changed.mjs';
import { normStackDir, underStack, aboveStack } from '../lib/config.mjs';

function stackDir(files) {
  const d = mkdtempSync(join(tmpdir(), 'jh-lint-'));
  for (const f of files) { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), 'x\n'); }
  return d;
}
const lc = (patch = {}) => ({ run: 'npx eslint {files}', match: ['**/*.js', '**/*.vue'], ...patch });
const STACK = { lint: 'npm run lint', lint_changed: lc() };

test('바뀐 파일만: match 에 걸리고 디스크에 있는 파일만 스택 dir 기준 경로로 넘긴다(정렬 · 중복 제거 · 역슬래시 정리) · always 는 그 뒤에 돈다', () => {
  const dir = stackDir(['app.js', 'src/a.vue', 'src/b.js', 'readme.txt', 'src/locales/ko.json']);
  const files = ['src/b.js', 'src/a.vue', 'app.js', 'readme.txt', 'src/locales/ko.json', 'src\\b.js'];
  const r = planLint({ stack: STACK, stackDir: dir, files });
  assert.equal(r.mode, 'changed');
  assert.equal(r.files, 3);
  assert.deepEqual(r.cmds, ["npx eslint 'app.js' 'src/a.vue' 'src/b.js'"]);
  assert.match(r.reason, /바뀐 파일 3개/);
  const withAlways = planLint({ stack: { lint: 'L', lint_changed: lc({ always: 'npm run lint:i18n' }) }, stackDir: dir, files });
  assert.deepEqual(withAlways.cmds, ["npx eslint 'app.js' 'src/a.vue' 'src/b.js'", 'npm run lint:i18n']);
});

test('match 는 스택 dir 기준이다 — 폴더를 한정한 패턴은 그 폴더의 파일만, 한 단계 패턴(*.js)은 루트 파일만 고른다', () => {
  const dir = stackDir(['vue.config.js', '.eslintrc-local.js', 'src/a.js', 'src/deep/b.vue', 'e2e/c.js', 'scripts/d.js']);
  const stack = { lint: 'L', lint_changed: lc({ match: ['src/**/*.js', 'src/**/*.vue', '*.js', '.*.js'], fallback_full: [] }) };
  const r = planLint({ stack, stackDir: dir, files: ['vue.config.js', '.eslintrc-local.js', 'src/a.js', 'src/deep/b.vue', 'e2e/c.js', 'scripts/d.js'] });
  assert.deepEqual(r.cmds, ["npx eslint '.eslintrc-local.js' 'src/a.js' 'src/deep/b.vue' 'vue.config.js'"], '전체 lint 가 안 보는 폴더(e2e · scripts)는 넘기지 않는다');
});

test('지운 파일은 넘기지 않는다 · 따옴표가 든 이름도 한 인자로 간다 · {files} 가 두 번이면 둘 다 채운다', () => {
  const dir = stackDir(['app.js', "src/it's.js"]);
  const r = planLint({ stack: { lint: 'L', lint_changed: lc({ run: 'lintA {files}; lintB {files}' }) }, stackDir: dir, files: ['app.js', 'gone.js', "src/it's.js"] });
  assert.equal(r.mode, 'changed');
  assert.deepEqual(r.cmds, ["lintA 'app.js' 'src/it'\\''s.js'; lintB 'app.js' 'src/it'\\''s.js'"]);
});

test('대상 0개(none): 전체로 넘기지 않는다 — always 가 있으면 그것만, 없으면 돌 명령이 없다(게이트가 SKIPPED 로 남긴다) · 까닭에 「검사 0」이 적힌다', () => {
  const dir = stackDir(['app.js', 'data.txt', 'src/locales/ko.json']);
  for (const files of [['data.txt'], ['gone.js'], ['src/locales/ko.json'], []]) {
    const r = planLint({ stack: STACK, stackDir: dir, files });
    assert.deepEqual([r.mode, r.cmds, r.files], ['none', [], 0], JSON.stringify(files));
    assert.match(r.reason, /lint 대상이 없다 — lint 를 돌리지 않았다\(검사 0\)/);
  }
  const r = planLint({ stack: { lint: 'L', lint_changed: lc({ always: 'npm run lint:i18n' }) }, stackDir: dir, files: ['src/locales/ko.json'] });
  assert.deepEqual([r.mode, r.cmds, r.files], ['none', ['npm run lint:i18n'], 0]);
  assert.match(r.reason, /파일과 무관한 검사\(always\)만 돌았다/);
});

test('전체 lint 로 넘기는 경우 — lint 설정·의존성 변경(대상이 0개여도) · 파일 수 상한 · 명령줄 길이', () => {
  const dir = stackDir(['app.js', 'src/a.vue', 'package.json', '.eslintrc.js', 'conf/rules.yml']);
  const full = (files, stack = STACK, extra = {}) => { const r = planLint({ stack, stackDir: dir, files, ...extra }); assert.equal(r.mode, 'full', JSON.stringify(r)); assert.deepEqual(r.cmds, [stack.lint]); assert.equal(r.files, 0); return r.reason; };
  // 규칙·린터가 바뀌면 안 바뀐 파일의 판정도 달라진다(기본 목록) — 바뀐 lint 대상이 없어도 전체다
  assert.match(full(['app.js', 'package.json']), /lint 설정·의존성이 바뀌었다\(package\.json\)/);
  assert.match(full(['package.json']), /package\.json/);
  assert.match(full(['app.js', '.eslintrc.js']), /\.eslintrc\.js/);
  assert.ok(LINT_FALLBACK_FULL.includes('eslint.config.*') && LINT_FALLBACK_FULL.includes('package-lock.json'));
  // 설정의 fallback_full 은 기본 목록을 바꾼다
  const custom = { lint: 'npm run lint', lint_changed: lc({ fallback_full: ['conf/**'] }) };
  assert.match(full(['app.js', 'conf/rules.yml'], custom), /conf\/rules\.yml/);
  assert.equal(planLint({ stack: custom, stackDir: dir, files: ['app.js', 'package.json'] }).mode, 'changed', '기본 목록은 더 이상 보지 않는다');
  // 상한
  assert.match(full(['app.js', 'src/a.vue'], { lint: 'npm run lint', lint_changed: lc({ max_files: 1 }) }), /lint 대상 2개 > 1/);
  assert.equal(planLint({ stack: { lint: 'L', lint_changed: lc({ max_files: 2 }) }, stackDir: dir, files: ['app.js', 'src/a.vue'] }).mode, 'changed', '상한과 같으면 좁힌다');
  assert.equal(LINT_MAX_FILES, 200);
  assert.match(full(['app.js', 'src/a.vue'], STACK, { maxCmdChars: 20 }), /명령줄 \d+자 > 20/);
  // 스택 dir 의 조상 폴더에 놓인 lint 설정·의존성 — 린터는 위 폴더의 설정도 읽는다. 스택 안에서 바뀐 lint 대상이 없어도 전체다
  assert.match(full(['app.js'], STACK, { above: ['eslint.config.mjs'] }), /\(상위 폴더\) eslint\.config\.mjs/);
  assert.match(full([], STACK, { above: ['package.json', 'README.md'] }), /\(상위 폴더\) package\.json\)/);
  assert.equal(planLint({ stack: STACK, stackDir: dir, files: ['app.js'], above: ['README.md', 'main.js'] }).mode, 'changed', '설정이 아닌 상위 폴더 파일은 무관하다 — lint 대상이 되지도 않는다');
  assert.deepEqual(planLint({ stack: STACK, stackDir: dir, files: ['app.js'], above: ['main.js'] }).cmds, ["npx eslint 'app.js'"]);
  // 셸이 cmd 면 좁혀 돌지 않는다 — 작은따옴표가 인자에 그대로 남고 한 줄 상한(8,191자)도 다르다
  assert.match(full(['app.js'], STACK, { shell: 'cmd' }), /셸이 cmd 라/);
  for (const shell of ['bash', 'sh']) assert.equal(planLint({ stack: STACK, stackDir: dir, files: ['app.js'], shell }).mode, 'changed');
});

test('스택 dir 표기: `./frontend` · `frontend/` · `frontend\\` 는 같은 폴더다 — 변경 경로를 그 스택 기준으로 옮길 때 철자 때문에 하나도 못 찾는 일이 없다 · 조상 폴더에 바로 놓인 파일만 「위」다', () => {
  for (const d of ['frontend', './frontend', 'frontend/', './frontend/', '.\\frontend\\']) assert.equal(normStackDir(d), 'frontend', d);
  for (const d of ['.', './', '']) assert.equal(normStackDir(d), '.');
  assert.equal(normStackDir('apps\\web/'), 'apps/web');
  const paths = ['frontend/src/a.js', 'frontend/package.json', 'backend/App.java', 'package.json', 'docs/x.md', 'apps/web/src/b.js', 'apps/tsconfig.json', 'apps/other/c.js'];
  for (const d of ['frontend', './frontend', 'frontend/']) assert.deepEqual(underStack(paths, d), ['src/a.js', 'package.json'], d);
  assert.deepEqual(underStack(paths, '.'), paths, '루트 스택은 전부');
  assert.deepEqual(aboveStack(paths, './frontend'), ['package.json'], '루트에 바로 놓인 파일만 — 다른 폴더(docs · backend) 안의 파일은 아니다');
  assert.deepEqual(aboveStack(paths, 'apps/web'), ['package.json', 'tsconfig.json'], '루트와 apps/ 에 바로 놓인 파일 — 형제 폴더(apps/other) 안은 아니다');
  assert.deepEqual(aboveStack(paths, '.'), [], '루트 스택 위에는 아무것도 없다');
});

test('lint_changed 가 없으면 종전대로 전체 · lint 명령이 없으면 lint_changed 만으로 돌지 않는다(좁힐 전체가 없다)', () => {
  const dir = stackDir(['app.js']);
  const a = planLint({ stack: { lint: 'npm run lint' }, stackDir: dir, files: ['app.js'] });
  assert.deepEqual([a.mode, a.cmds], ['full', ['npm run lint']]);
  const b = planLint({ stack: { lint: null, lint_changed: lc({ always: 'x' }) }, stackDir: dir, files: ['app.js'] });
  assert.deepEqual([b.mode, b.cmds], ['full', []]);
});
