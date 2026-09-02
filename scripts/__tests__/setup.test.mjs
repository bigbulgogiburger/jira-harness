// setup.mjs 통합 테스트 — 임시 git 저장소(gradle + npm 모노레포 흉내)에서 detect·write·check·upgrade·inject 를 실제로 돌린다.
// 거부 케이스(스키마 위반 · 절대 경로 · diff 덮어쓰기 거부 · 게이트 명령 실패 주입)를 반드시 포함한다 — "존재 ≠ 실효".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, '..', 'setup.mjs');
const NODE = process.execPath;

function sh(cmd, args, cwd, input) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', input, windowsHide: true }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function setup(dir, ...args) { return sh(NODE, [SETUP, ...args, '--cwd', dir], dir); }
function setupJson(dir, ...args) {
  const r = setup(dir, ...args, '--json');
  const line = r.stdout.trim().split('\n').pop() ?? '';
  let value = null;
  try { value = JSON.parse(r.stdout.trim()); } catch { try { value = JSON.parse(line); } catch { value = null; } }
  return { ...r, value };
}
function writeJson(file, value) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }

/** gradle(backend) + npm/vitest(frontend) 모노레포 흉내. commit=false 면 커밋 0건 저장소. */
function makeRepo({ commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-setup-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'core.autocrlf', 'false');
  for (const d of ['backend/src', 'frontend/src', 'docs']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'backend/build.gradle'), "plugins { id 'java' }\n");
  writeFileSync(join(dir, 'backend/gradlew'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'backend/src/App.java'), 'class App {}\n');
  writeJson(join(dir, 'frontend/package.json'), {
    name: 'front', private: true,
    scripts: { lint: 'eslint .', build: 'vue-cli-service build', test: 'vitest run' },
    devDependencies: { vitest: '^1.0.0' },
  });
  writeFileSync(join(dir, 'frontend/src/app.js'), 'export default 1\n');
  writeFileSync(join(dir, 'docs/README.md'), '# docs\n');
  if (commit) { g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init'); }
  return dir;
}

/** echo 만 쓰는 유효한 harness.json — 게이트가 실제로 도는지 보되 빌드 도구는 부르지 않는다. */
function validConfig(overrides = {}) {
  return {
    version: 3,
    mode: 'auto',
    issue_prefix: 'ABC',
    branch_pattern: '^(feat|fix)/(?<keys>ABC-\\d+(?:-\\d+)*)(?:-[a-z0-9]+)*$',
    default_branch: 'main',
    stacks: {
      backend: { dir: 'backend', compile: 'echo compile-ok', lint: null, build: 'echo build-ok', test: "echo 'BUILD SUCCESSFUL' && echo '3 tests completed'", extra: [] },
      frontend: { dir: 'frontend', compile: 'echo lint-ok', lint: null, build: 'echo build-ok', test: "echo 'Tests  7 passed'", extra: [] },
    },
    docs_only_paths: ['docs/**', '**/*.md'],
    fingerprint_exclude: ['.claude/runtime/**', '**/*.draft'],
    ...overrides,
  };
}
function writeConfigFile(dir, cfg, name = 'cfg.json') { const f = join(dir, name); writeFileSync(f, JSON.stringify(cfg, null, 2), 'utf8'); return f; }

// ---------------------------------------------------------------- detect

test('detect: 모노레포 루트+1단계 하위에서 gradle·npm 스택을 찾고, 모르는 값은 채우지 않는다', () => {
  const dir = makeRepo();
  const r = setupJson(dir, 'detect');
  assert.equal(r.status, 0, r.stderr);
  const { stacks, suggested, unknown, existing } = r.value;

  assert.deepEqual(Object.keys(stacks).sort(), ['backend', 'frontend']);
  assert.equal(stacks.backend.dir, 'backend');
  assert.equal(stacks.backend.compile, './gradlew compileJava compileTestJava -q');
  assert.equal(stacks.backend.build, './gradlew build -x test');
  assert.equal(stacks.backend.test, './gradlew test');
  assert.equal(stacks.backend.lint, null, 'gradle lint 는 추측하지 않는다');

  assert.equal(stacks.frontend.dir, 'frontend');
  assert.equal(stacks.frontend.lint, 'npm run lint');
  assert.equal(stacks.frontend.build, 'npm run build');
  assert.equal(stacks.frontend.test, 'npx vitest run', 'vitest 는 npm run test 가 아니라 직접 실행');
  assert.equal(stacks.frontend.compile, null, 'typecheck 스크립트가 없으면 compile 은 비운다');

  assert.equal(suggested.version, 3);
  assert.equal(suggested.mode, 'auto');
  assert.equal(suggested.issue_prefix, '???', '접두사를 모르면 인터뷰 대상으로 남긴다');
  assert.ok(suggested.branch_pattern.includes('(?<keys>???-'), suggested.branch_pattern);
  assert.equal(suggested.default_branch, 'main');
  assert.equal(suggested.runtime_dir, '.claude/runtime');
  assert.deepEqual(suggested.stacks, stacks);
  assert.ok(unknown.includes('issue_prefix'));
  assert.ok(unknown.includes('stacks.backend.lint'));
  assert.ok(unknown.includes('stacks.frontend.compile'));
  assert.equal(existing, null);
});

test('detect: 패키지 매니저·기존 harness.json·브랜치에서 접두사 추정', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'frontend/pnpm-lock.yaml'), 'lockfileVersion: 6\n');
  g(dir, 'branch', 'feat/XYZ-42-something');
  const cfg = validConfig();
  writeJson(join(dir, '.claude/harness.json'), cfg);
  const r = setupJson(dir, 'detect');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.value.stacks.frontend.lint, 'pnpm run lint');
  assert.equal(r.value.suggested.issue_prefix, 'XYZ', '기존 브랜치 이름에서 접두사를 읽는다');
  assert.ok(r.value.suggested.branch_pattern.includes('(?<keys>XYZ-'));
  assert.ok(!r.value.unknown.includes('issue_prefix'));
  assert.equal(r.value.existing.issue_prefix, 'ABC', '기존 설정은 그대로 돌려준다');
});

// ---------------------------------------------------------------- write

test('write: 최초 쓰기 · settings 병합(다른 키 보존) · .gitignore 보강 · 멱등', () => {
  const dir = makeRepo();
  writeJson(join(dir, '.claude/settings.json'), { permissions: { allow: ['Bash(ls:*)'] }, enabledPlugins: { 'other@mkt': true } });
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.claude/runtime/\n');
  const cfgFile = writeConfigFile(dir, validConfig());

  const r = setupJson(dir, 'write', '--config', cfgFile);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.value.config.status, 'created');

  const written = JSON.parse(readFileSync(join(dir, '.claude/harness.json'), 'utf8'));
  assert.equal(written.issue_prefix, 'ABC');

  const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions.allow, ['Bash(ls:*)'], '다른 키 보존');
  assert.equal(settings.enabledPlugins['other@mkt'], true, '다른 플러그인 항목 보존');
  assert.equal(settings.enabledPlugins['jira-harness@jira-harness'], true);
  assert.deepEqual(settings.extraKnownMarketplaces['jira-harness'], { source: { source: 'github', repo: 'bigbulgogiburger/jira-harness' } });

  const ignore = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.ok(ignore.includes('.claude/harness.env.local'), '없던 줄은 추가');
  assert.equal(ignore.split('\n').filter(l => l.trim() === '.claude/runtime/').length, 1, '있던 줄은 중복 추가하지 않는다');

  const again = setupJson(dir, 'write', '--config', cfgFile);
  assert.equal(again.status, 0);
  assert.equal(again.value.config.status, 'unchanged', '멱등');
  assert.equal(again.value.settings.changed, false);
  assert.deepEqual(again.value.gitignore.added, []);
});

test('write: --marketplace/--plugin/--repo 지정', () => {
  const dir = makeRepo();
  const cfgFile = writeConfigFile(dir, validConfig());
  const r = setupJson(dir, 'write', '--config', cfgFile, '--marketplace', 'team-mp', '--plugin', 'jira-harness', '--repo', 'acme/harness');
  assert.equal(r.status, 0, r.stderr);
  const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(settings.extraKnownMarketplaces['team-mp'], { source: { source: 'github', repo: 'acme/harness' } });
  assert.equal(settings.enabledPlugins['jira-harness@team-mp'], true);
});

test('write 거부: 기존과 다르면 diff 만 내고 덮어쓰지 않는다 — --force 로만 갱신', () => {
  const dir = makeRepo();
  const cfgFile = writeConfigFile(dir, validConfig());
  assert.equal(setupJson(dir, 'write', '--config', cfgFile).status, 0);

  const changed = writeConfigFile(dir, validConfig({ mode: 'suggest' }), 'cfg2.json');
  const refused = setupJson(dir, 'write', '--config', changed);
  assert.equal(refused.status, 1, '덮어쓰기 거부는 exit 1');
  assert.equal(refused.value.config.status, 'refused');
  assert.ok(refused.value.diff.some(d => d.path === 'mode' && d.from === 'auto' && d.to === 'suggest'), JSON.stringify(refused.value.diff));
  assert.equal(JSON.parse(readFileSync(join(dir, '.claude/harness.json'), 'utf8')).mode, 'auto', '디스크는 그대로');

  const forced = setupJson(dir, 'write', '--config', changed, '--force');
  assert.equal(forced.status, 0);
  assert.equal(forced.value.config.status, 'updated');
  assert.equal(JSON.parse(readFileSync(join(dir, '.claude/harness.json'), 'utf8')).mode, 'suggest');
});

test('write 거부: 스키마 위반(미결정 접두사) · 절대 경로 · 자격증명 — 아무것도 쓰지 않는다', () => {
  const dir = makeRepo();
  const before = existsSync(join(dir, '.claude/harness.json'));
  assert.equal(before, false);

  const bad = writeConfigFile(dir, validConfig({ issue_prefix: '???' }), 'bad1.json');
  const r1 = setupJson(dir, 'write', '--config', bad);
  assert.equal(r1.status, 2, '스키마 위반은 exit 2');
  assert.equal(r1.value.config.status, 'rejected');
  assert.ok(r1.value.errors.length > 0, JSON.stringify(r1.value));
  assert.equal(existsSync(join(dir, '.claude/harness.json')), false, '거부되면 파일을 만들지 않는다');
  assert.equal(existsSync(join(dir, '.claude/settings.json')), false, '거부되면 settings 도 건드리지 않는다');

  const absCfg = validConfig();
  absCfg.stacks.backend.compile = 'C:/tools/gradle/bin/gradle compileJava';
  const r2 = setupJson(dir, 'write', '--config', writeConfigFile(dir, absCfg, 'bad2.json'));
  assert.equal(r2.status, 2);
  assert.ok(r2.value.forbidden.some(f => f.path === 'stacks.backend.compile'), JSON.stringify(r2.value.forbidden));
  assert.ok(r2.value.hint.includes('env_file'));

  const homeCfg = validConfig();
  homeCfg.stacks.backend.env_file = '~/secrets/harness.env';
  const r3 = setupJson(dir, 'write', '--config', writeConfigFile(dir, homeCfg, 'bad3.json'));
  assert.equal(r3.status, 2);
  assert.ok(r3.value.forbidden.some(f => f.path === 'stacks.backend.env_file'));

  const secretCfg = validConfig();
  secretCfg.jira = { project: 'ABC', token: 'super-secret-value' };
  const r4 = setupJson(dir, 'write', '--config', writeConfigFile(dir, secretCfg, 'bad4.json'));
  assert.equal(r4.status, 2);
  assert.ok(r4.value.forbidden.some(f => f.path === 'jira.token'), JSON.stringify(r4.value.forbidden));

  const noKeys = validConfig({ branch_pattern: '^feat/ABC-\\d+$' });
  const r5 = setupJson(dir, 'write', '--config', writeConfigFile(dir, noKeys, 'bad5.json'));
  assert.equal(r5.status, 2);
  assert.ok(r5.value.errors.some(e => e.includes('keys')), JSON.stringify(r5.value.errors));

  assert.equal(existsSync(join(dir, '.claude/harness.json')), false, '거부 5건 뒤에도 여전히 없다');
});

// ---------------------------------------------------------------- check

test('check: 항목 {id, ok, detail, failClosedStage} · 게이트 dry-run 2종을 실제로 실행', () => {
  const dir = makeRepo();
  writeJson(join(dir, '.claude/harness.json'), validConfig());
  const r = setupJson(dir, 'check');
  assert.ok([0, 1].includes(r.status), `exit ${r.status}: ${r.stderr}`);
  const ids = r.value.items.map(i => i.id);
  for (const id of ['node', 'git', 'codex', 'harness', 'gate-commit-dry', 'gate-full-dry']) assert.ok(ids.includes(id), `${id} 누락: ${ids.join(',')}`);
  for (const item of r.value.items) {
    assert.equal(typeof item.ok, 'boolean');
    assert.equal(typeof item.detail, 'string');
    assert.equal(typeof item.failClosedStage, 'string');
  }
  const byId = Object.fromEntries(r.value.items.map(i => [i.id, i]));
  assert.equal(byId.node.ok, true);
  assert.equal(byId.git.ok, true);
  assert.equal(byId.harness.ok, true);
  assert.equal(byId['gate-commit-dry'].ok, true, byId['gate-commit-dry'].detail);
  assert.equal(byId['gate-full-dry'].ok, true, byId['gate-full-dry'].detail);
  assert.ok(byId['gate-full-dry'].detail.includes('명령'), byId['gate-full-dry'].detail);
  assert.equal(byId.codex.failClosedStage, 'verify');
});

test('check 거부: harness.json 이 없으면 게이트 항목까지 fail-closed 로 떨어진다', () => {
  const dir = makeRepo();
  const r = setupJson(dir, 'check');
  assert.equal(r.status, 1, '미충족 항목이 있으면 exit 1');
  const byId = Object.fromEntries(r.value.items.map(i => [i.id, i]));
  assert.equal(byId.harness.ok, false);
  assert.equal(byId['gate-commit-dry'].ok, false);
  assert.equal(byId['gate-commit-dry'].failClosedStage, 'commit');
  assert.ok(r.value.failed.includes('harness'));
});

// ---------------------------------------------------------------- upgrade

function seedV2(dir) {
  writeJson(join(dir, '.claude/settings.local.json'), {
    env: { HARNESS_MODE: 'auto', OTHER_KEY: 'keepme-not-a-secret' },
    permissions: { allow: ['Bash(git status:*)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'python .claude/hooks/compile-check.py' }, { type: 'command', command: 'echo keep-me' }] },
      ],
      UserPromptSubmit: [
        { matcher: '*', hooks: [{ type: 'command', command: 'python .claude/hooks/harness-context-inject.py' }] },
      ],
      Stop: [
        { matcher: '*', hooks: [{ type: 'command', command: 'bash .claude/hooks/review-gate.sh' }] },
      ],
    },
  });
  mkdirSync(join(dir, '.claude/runtime/phases/ABC-1'), { recursive: true });
  writeFileSync(join(dir, '.claude/runtime/phases/ABC-1/index.json'), '{}\n');
  writeFileSync(join(dir, '.claude/runtime/sprint-contract-ABC-1.md'), '# contract\n');
  writeFileSync(join(dir, '.claude/runtime/workflow-state-ABC-1.json'), '{}\n');
  writeFileSync(join(dir, '.claude/runtime/aggregate-verdict.md'), '# verdict\n');
  writeFileSync(join(dir, '.claude/runtime/changed-files.txt'), 'a.java\n');
  writeFileSync(join(dir, '.claude/runtime/keep-me.json'), '{}\n');
  mkdirSync(join(dir, '.claude/scripts'), { recursive: true });
  writeFileSync(join(dir, '.claude/scripts/phase-execute.py'), '# v2 runner\n');
  writeFileSync(join(dir, '.claude/scripts/helper.py'), '# not a runner\n');
  mkdirSync(join(dir, '.claude/hooks'), { recursive: true });
  writeFileSync(join(dir, '.claude/hooks/compile-check.py'), '# v2 hook\n');
  writeFileSync(join(dir, '.claude/hooks/other-hook.py'), '# keep\n');
}

test('upgrade dry-run: 잔재를 찾되 파일·설정은 하나도 바꾸지 않는다', () => {
  const dir = makeRepo();
  writeJson(join(dir, '.claude/harness.json'), validConfig());
  seedV2(dir);
  const settingsBefore = readFileSync(join(dir, '.claude/settings.local.json'), 'utf8');

  const r = setupJson(dir, 'upgrade');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.value.apply, false);
  for (const f of ['.claude/runtime/sprint-contract-ABC-1.md', '.claude/runtime/workflow-state-ABC-1.json', '.claude/runtime/aggregate-verdict.md', '.claude/runtime/changed-files.txt', '.claude/runtime/phases', '.claude/scripts/phase-execute.py', '.claude/hooks/compile-check.py']) {
    assert.ok(r.value.found.includes(f), `${f} 미검출: ${r.value.found.join(', ')}`);
    assert.ok(existsSync(join(dir, f)), `${f} 는 dry-run 에서 그대로 있어야 한다`);
  }
  assert.ok(!r.value.found.includes('.claude/runtime/keep-me.json'), 'v2 목록 밖 파일은 건드리지 않는다');
  assert.ok(!r.value.found.includes('.claude/scripts/helper.py'));
  assert.equal(r.value.moved.every(m => m.applied === false), true);
  assert.equal(readFileSync(join(dir, '.claude/settings.local.json'), 'utf8'), settingsBefore, 'dry-run 은 설정 파일을 쓰지 않는다');
  assert.equal(existsSync(join(dir, '.claude/runtime/archive/v2')), false);
});

test('upgrade --apply: archive 로 이동(삭제 아님) · v2 훅 3종 제거 · 다른 env 키는 값까지 보존하고 출력에는 안 싣는다', () => {
  const dir = makeRepo();
  writeJson(join(dir, '.claude/harness.json'), validConfig());
  seedV2(dir);

  const r = setupJson(dir, 'upgrade', '--apply');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.value.apply, true);

  for (const [from, to] of [
    ['.claude/runtime/sprint-contract-ABC-1.md', '.claude/runtime/archive/v2/runtime/sprint-contract-ABC-1.md'],
    ['.claude/runtime/phases', '.claude/runtime/archive/v2/runtime/phases'],
    ['.claude/scripts/phase-execute.py', '.claude/runtime/archive/v2/scripts/phase-execute.py'],
    ['.claude/hooks/compile-check.py', '.claude/runtime/archive/v2/hooks/compile-check.py'],
  ]) {
    assert.equal(existsSync(join(dir, from)), false, `${from} 는 원래 자리에서 사라져야 한다`);
    assert.ok(existsSync(join(dir, to)), `${to} 로 이동해야 한다(삭제 아님)`);
  }
  assert.ok(statSync(join(dir, '.claude/runtime/archive/v2/runtime/phases/ABC-1/index.json')).isFile(), '디렉터리는 내용째 이동');
  assert.ok(existsSync(join(dir, '.claude/runtime/keep-me.json')), '목록 밖 파일은 그대로');
  assert.ok(existsSync(join(dir, '.claude/hooks/other-hook.py')));

  const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.local.json'), 'utf8'));
  assert.equal(settings.env.HARNESS_MODE, undefined, 'HARNESS_MODE 제거');
  assert.equal(settings.env.OTHER_KEY, 'keepme-not-a-secret', '다른 env 키는 값까지 보존');
  assert.deepEqual(settings.permissions.allow, ['Bash(git status:*)']);
  assert.equal(settings.hooks.UserPromptSubmit, undefined, 'harness-context-inject 만 있던 이벤트는 통째로 제거');
  assert.equal(settings.hooks.Stop, undefined, 'review-gate 만 있던 이벤트는 통째로 제거');
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks, [{ type: 'command', command: 'echo keep-me' }], 'v2 아닌 훅은 남는다');

  const markers = r.value.removedHooks.map(h => h.marker).sort();
  assert.deepEqual(markers, ['HARNESS_MODE', 'compile-check', 'harness-context-inject', 'review-gate']);
  assert.ok(!JSON.stringify(r.value).includes('keepme-not-a-secret'), 'env 값은 출력에 싣지 않는다(비밀일 수 있다)');
  assert.deepEqual(r.value.warnings, [], 'plugin.json 과 harness.json.version 이 맞으면 경고 없음');

  const second = setupJson(dir, 'upgrade', '--apply');
  assert.deepEqual(second.value.found, [], '두 번째 실행은 이관할 것이 없다(멱등)');
});

test('upgrade: harness.json 이 없으면 경고로 알린다', () => {
  const dir = makeRepo();
  const r = setupJson(dir, 'upgrade');
  assert.equal(r.status, 0);
  assert.equal(r.value.warnings.length, 1, JSON.stringify(r.value.warnings));
  assert.ok(r.value.warnings[0].includes('harness.json'));
});

// ---------------------------------------------------------------- inject (위반 주입)

test('inject: 임시 clone 에서 실측 — 패턴 밖 deny · 게이트 없음 deny · 게이트 후 통과 · 경량뿐인 push deny', () => {
  const dir = makeRepo();
  writeJson(join(dir, '.claude/harness.json'), validConfig());
  const headBefore = g(dir, 'rev-parse', 'HEAD');
  const branchBefore = g(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const statusBefore = g(dir, 'status', '--porcelain');

  const r = setupJson(dir, 'inject');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.value.clone, true);
  const byCase = Object.fromEntries(r.value.cases.map(c => [c.case, c]));
  assert.deepEqual(Object.keys(byCase).sort(), ['branch-pattern', 'commit-after-gate', 'commit-without-gate', 'push-without-full-gate']);
  assert.equal(byCase['branch-pattern'].got, 'BRANCH_PATTERN', JSON.stringify(byCase['branch-pattern']));
  assert.equal(byCase['branch-pattern'].decision, 'deny');
  assert.equal(byCase['commit-without-gate'].got, 'NO_GATE', JSON.stringify(byCase['commit-without-gate']));
  assert.equal(byCase['commit-after-gate'].got, 'OK', JSON.stringify(byCase['commit-after-gate']));
  assert.equal(byCase['push-without-full-gate'].got, 'GATE_LEVEL', JSON.stringify(byCase['push-without-full-gate']));
  assert.equal(byCase['push-without-full-gate'].decision, 'deny', '경량 게이트만 있는 상태의 push 는 막혀야 한다');
  assert.equal(r.value.cases.every(c => c.ok), true);

  assert.equal(g(dir, 'rev-parse', 'HEAD'), headBefore, '원본 저장소는 건드리지 않는다');
  assert.equal(g(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), branchBefore);
  assert.equal(g(dir, 'status', '--porcelain'), statusBefore, '원본 작업트리도 그대로(프로브 파일이 새로 생기지 않는다)');
  assert.equal(existsSync(join(dir, '.claude/runtime/issues')), false, '상태 JSON 은 clone 안에서만 만든다');
});

test('inject 위반 주입: 게이트 명령이 실패하면 (c) 가 GATE_FAIL 로 드러난다', () => {
  const dir = makeRepo();
  const cfg = validConfig();
  cfg.stacks.backend.compile = 'echo compiling && exit 3';
  writeJson(join(dir, '.claude/harness.json'), cfg);

  const r = setupJson(dir, 'inject');
  assert.equal(r.status, 1, '한 케이스라도 기대와 다르면 exit 1');
  const byCase = Object.fromEntries(r.value.cases.map(c => [c.case, c]));
  assert.equal(byCase['branch-pattern'].ok, true);
  assert.equal(byCase['commit-without-gate'].ok, true);
  assert.equal(byCase['commit-after-gate'].ok, false);
  assert.equal(byCase['commit-after-gate'].got, 'GATE_FAIL', JSON.stringify(byCase['commit-after-gate']));
  assert.equal(byCase['push-without-full-gate'].got, 'INCONCLUSIVE', '커밋 축이 막혀 있으면 push 축은 "미확인" 으로 남긴다');
});

test('inject: 커밋 0건 저장소는 clone 불가를 그대로 보고한다', () => {
  const dir = makeRepo({ commit: false });
  writeJson(join(dir, '.claude/harness.json'), validConfig());
  const r = setupJson(dir, 'inject');
  assert.equal(r.status, 1);
  assert.equal(r.value.clone, false);
  assert.ok(r.value.reason.includes('커밋'), r.value.reason);
  assert.deepEqual(r.value.cases, []);
});

test('사용법: 알 수 없는 하위 명령은 exit 2', () => {
  const dir = makeRepo();
  const r = setup(dir, 'nope');
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('사용법'), r.stderr);
});
