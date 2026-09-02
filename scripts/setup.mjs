#!/usr/bin/env node
// setup.mjs — setup 스킬의 결정론 부분. 인터뷰(모르는 값 묻기)와 보고 문장은 스킬이, 측정·쓰기는 여기가 한다.
//   detect  : 스택 감지 → harness.json 제안 + 모르는 값 목록
//   write   : harness.json 멱등 쓰기(스키마 검증 · 절대 경로/자격증명 거부) + .claude/settings.json 병합 + .gitignore 보강
//   check   : 전제 체크리스트(node·git·bash·codex·harness.json·게이트 dry-run) — 미충족 항목에 fail-closed 단계 표시
//   upgrade : v2 잔재 감지·이관(기본 dry-run, --apply 로 실행 — 삭제가 아니라 archive 로 이동)
//   inject  : 위반 주입 — 프로젝트를 임시 clone 해 게이트가 **실제로 막는지** 실측(존재 ≠ 실효)
//             케이스 이름·기대값은 skills/setup/references/injection.md 를 따른다(+ 브랜치 패턴 축 1건)
// 공통 옵션: --cwd <dir> · --json(마지막 줄이 JSON 한 덩어리). 종료코드 0=정상 · 1=문제 검출/거부 · 2=사용법·치명적 오류.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, copyFileSync, rmSync, appendFileSync } from 'node:fs';
import { join, resolve, relative, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, CONFIG_REL, loadConfig, parseBranch, statePath, newState, writeState, readState, matchesAny } from './lib/config.mjs';
import { assertValid } from './lib/schema.mjs';
import { git } from './lib/git.mjs';
import { findBash } from './lib/shell.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const NODE = process.execPath;

// ---------- 인자 ----------
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
const flag = n => argv.includes(n);
const opt = (n, dflt = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };
const json = flag('--json');
const cwd = norm(resolve(opt('--cwd') ?? process.cwd()));

function norm(p) { return String(p).replace(/\\/g, '/'); }
function die(msg) { console.error(`[setup] ${msg}`); process.exit(2); }
function emit(payload, exitCode = 0, lines = []) {
  if (json) console.log(JSON.stringify(payload, null, 2));
  else for (const l of lines) console.log(l);
  process.exit(exitCode);
}
function readJson(file) {
  if (!existsSync(file)) return { ok: false, missing: true, value: null };
  try { return { ok: true, missing: false, value: JSON.parse(readFileSync(file, 'utf8')) }; }
  catch (e) { return { ok: false, missing: false, value: null, error: e.message }; }
}
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
function run(file, args, { cwd: d, input } = {}) {
  const r = spawnSync(file, args, { cwd: d, input, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, out: (r.stdout ?? '').replace(/\r\n/g, '\n'), err: (r.stderr ?? '').replace(/\r\n/g, '\n') };
}

// ================================================================= detect

const SKIP_DIRS = new Set(['.git', '.claude', '.idea', '.vscode', 'node_modules', 'build', 'dist', 'out', 'target', '.gradle', '.venv', 'venv', '__pycache__', 'vendor', 'coverage', 'tmp']);

function packageManager(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/** 한 디렉터리의 스택 종류를 우선순위로 하나 고른다. 없으면 null. */
function detectKind(dir) {
  if (existsSync(join(dir, 'build.gradle')) || existsSync(join(dir, 'build.gradle.kts'))) return 'gradle';
  if (existsSync(join(dir, 'pom.xml'))) return 'maven';
  if (existsSync(join(dir, 'package.json'))) return packageManager(dir);
  if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'requirements.txt'))) return 'python';
  if (existsSync(join(dir, 'pubspec.yaml'))) return 'flutter';
  return null;
}

/** 종류별 게이트 명령. 모르는 값은 null 로 두고 unknown 에 올린다(추측으로 채우지 않는다). */
function commandsFor(kind, dir) {
  const notes = [];
  if (kind === 'gradle') {
    if (!existsSync(join(dir, 'gradlew')) && !existsSync(join(dir, 'gradlew.bat'))) notes.push('gradle wrapper(gradlew) 없음 — 명령을 gradle 로 바꿔야 할 수 있다');
    return { cmds: { compile: './gradlew compileJava compileTestJava -q', lint: null, build: './gradlew build -x test', test: './gradlew test' }, notes };
  }
  if (kind === 'maven') {
    const mvn = existsSync(join(dir, 'mvnw')) || existsSync(join(dir, 'mvnw.cmd')) ? './mvnw' : 'mvn';
    return { cmds: { compile: `${mvn} -q -DskipTests compile`, lint: null, build: `${mvn} -DskipTests package`, test: `${mvn} test` }, notes };
  }
  if (kind === 'npm' || kind === 'pnpm' || kind === 'yarn') {
    const pkg = readJson(join(dir, 'package.json'));
    if (!pkg.ok) notes.push('package.json 을 읽을 수 없다');
    const scripts = pkg.value?.scripts ?? {};
    const deps = { ...(pkg.value?.dependencies ?? {}), ...(pkg.value?.devDependencies ?? {}) };
    const script = name => (scripts[name] ? `${kind} run ${name}` : null);
    const usesVitest = 'vitest' in deps || /\bvitest\b/.test(scripts.test ?? '');
    // vue-cli-service lint 와 `eslint --fix` 는 **기본이 자동 수정**이다 — 게이트가 파일을 고쳐 놓고 초록을 내면
    // 커밋될 트리가 게이트가 본 트리와 달라진다. 검사만 하도록 `--no-fix` 를 붙인다(vue-cli 는 그 플래그를 받는다).
    const lintScript = scripts.lint ?? '';
    const vueCliLint = /vue-cli-service\s+lint/.test(lintScript);
    const eslintFix = /\beslint\b[^&|;]*--fix\b/.test(lintScript);
    let lint = script('lint');
    if (vueCliLint) { lint = `${kind} run lint -- --no-fix`; notes.push('vue-cli-service lint 는 기본이 자동 수정이라 게이트 명령에 `-- --no-fix` 를 붙였다'); }
    else if (eslintFix) { lint = null; notes.push('lint 스크립트가 `eslint --fix` 라 게이트에 쓸 수 없다 — 검사 전용 명령(예: `npx eslint .`)을 stacks.<name>.lint 에 직접 적을 것'); }
    return {
      cmds: {
        compile: script('typecheck'),
        lint,
        build: script('build'),
        test: usesVitest ? 'npx vitest run' : script('test'),
      },
      notes,
    };
  }
  if (kind === 'python') return { cmds: { compile: null, lint: null, build: null, test: 'pytest -q' }, notes };
  if (kind === 'flutter') return { cmds: { compile: null, lint: 'flutter analyze', build: null, test: 'flutter test' }, notes };
  return { cmds: { compile: null, lint: null, build: null, test: null }, notes };
}

function pickStackName(rel, kind, used) {
  let base = rel === '.' ? kind : basename(rel).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  if (!base) base = kind;
  let name = base, i = 2;
  while (used.has(name)) name = `${base}${i++}`;
  used.add(name);
  return name;
}

/** 루트와 1단계 하위 디렉터리만 본다(dir 은 상대 경로). */
function detectStacks(root) {
  const dirs = ['.'];
  for (const name of readdirSync(root)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    let st;
    try { st = statSync(join(root, name)); } catch { continue; }
    if (st.isDirectory()) dirs.push(name);
  }
  const stacks = {};
  const unknown = [];
  const used = new Set();
  for (const rel of dirs) {
    const abs = join(root, rel);
    const kind = detectKind(abs);
    if (!kind) continue;
    const name = pickStackName(rel, kind, used);
    const { cmds, notes } = commandsFor(kind, abs);
    stacks[name] = { dir: rel, ...cmds, extra: [] };
    for (const step of ['compile', 'lint', 'build', 'test']) if (cmds[step] == null) unknown.push(`stacks.${name}.${step}`);
    for (const n of notes) unknown.push(`stacks.${name}: ${n}`);
  }
  return { stacks, unknown };
}

/** 기존 브랜치 이름에서 이슈 접두사를 추정한다. 못 찾으면 null. */
function guessPrefix(root) {
  const r = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], { cwd: root, allowFail: true });
  if (r.status !== 0) return null;
  const count = new Map();
  for (const line of r.out.split('\n')) {
    const m = /^(?:origin\/)?(?:feat|fix|feature|bugfix)\/([A-Z][A-Z0-9]+)-\d+/.exec(line.trim());
    if (m) count.set(m[1], (count.get(m[1]) ?? 0) + 1);
  }
  let best = null;
  for (const [k, v] of count) if (!best || v > best[1]) best = [k, v];
  return best ? best[0] : null;
}

function guessDefaultBranch(root) {
  const head = git(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { cwd: root, allowFail: true });
  if (head.status === 0 && head.out) return head.out.replace(/^origin\//, '');
  for (const cand of ['main', 'master']) {
    const r = git(['rev-parse', '--verify', '-q', `refs/heads/${cand}`], { cwd: root, allowFail: true });
    if (r.status === 0) return cand;
  }
  const cur = git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, allowFail: true });
  return cur.status === 0 && cur.out ? cur.out : null;
}

function branchPatternFor(prefix) {
  return `^(feat|fix)/(?<keys>${prefix}-\\d+(?:-\\d+)*)(?:-[a-z0-9]+)*$`;
}

function suggestConfig(root, stacks) {
  const prefix = guessPrefix(root);
  const branch = guessDefaultBranch(root);
  const suggested = {
    version: 3,
    mode: 'auto',
    issue_prefix: prefix ?? '???',
    branch_pattern: branchPatternFor(prefix ?? '???'),
    default_branch: branch ?? DEFAULTS.default_branch,
    branch_template: DEFAULTS.branch_template,
    shell: DEFAULTS.shell,
    runtime_dir: DEFAULTS.runtime_dir,
    stacks,
    docs_only_paths: [...DEFAULTS.docs_only_paths],
    fingerprint_exclude: [...DEFAULTS.fingerprint_exclude],
    review: { ...DEFAULTS.review },
    models: { ...DEFAULTS.models },
    wiki: { ...DEFAULTS.wiki },
    jira: { ...DEFAULTS.jira },
    gate: { ...DEFAULTS.gate },
  };
  const unknown = [];
  if (!prefix) unknown.push('issue_prefix');
  if (!branch) unknown.push('default_branch');
  unknown.push('dispatch');
  return { suggested, unknown };
}

function cmdDetect() {
  if (!existsSync(cwd)) die(`디렉터리가 없다: ${cwd}`);
  const { stacks, unknown: stackUnknown } = detectStacks(cwd);
  const { suggested, unknown: cfgUnknown } = suggestConfig(cwd, stacks);
  const existing = readJson(join(cwd, CONFIG_REL));
  const payload = {
    root: cwd,
    stacks,
    suggested,
    unknown: [...cfgUnknown, ...stackUnknown],
    existing: existing.ok ? existing.value : null,
    existing_error: existing.ok || existing.missing ? null : existing.error,
  };
  const lines = [
    `[setup] 스택 ${Object.keys(stacks).length}개: ${Object.entries(stacks).map(([n, s]) => `${n}(${s.dir})`).join(', ') || '없음'}`,
    `[setup] 모르는 값 ${payload.unknown.length}개: ${payload.unknown.join(', ') || '없음'}`,
    existing.ok ? '[setup] 기존 harness.json 있음 — write 는 diff 를 먼저 보여준다' : '[setup] 기존 harness.json 없음',
  ];
  emit(payload, 0, lines);
}

// ================================================================= write

const ABS_PATH_RULES = [
  { re: /(?:^|[\s"'=(:])[A-Za-z]:[\\/]/, why: '드라이브 문자로 시작하는 절대 경로' },
  { re: /(?:^|[\s"'=(:])~[\\/]/, why: '홈 디렉터리(~) 경로' },
  { re: /\$HOME\b|%USERPROFILE%|%HOMEPATH%/i, why: '홈 디렉터리 환경변수' },
  { re: /(?:^|[\s"'=(:])\/(?:home|Users|root)\//, why: '사용자 홈 절대 경로' },
];
const SECRET_KEY_RE = /(pass(word)?|secret|token|api[_-]?key|credential|private[_-]?key)/i;
const SECRET_VALUE_RE = /(-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/;

/** 값 전체를 훑어 절대 경로·자격증명을 찾는다. 머신별 값은 stacks.<name>.env_file 로 가야 한다. */
function scanForbidden(value, path = '', out = []) {
  if (typeof value === 'string') {
    for (const rule of ABS_PATH_RULES) if (rule.re.test(value)) { out.push({ path, why: rule.why }); break; }
    if (SECRET_VALUE_RE.test(value)) out.push({ path, why: '자격증명으로 보이는 값' });
    const leaf = path.split('.').pop() ?? '';
    if (SECRET_KEY_RE.test(leaf) && value.trim()) out.push({ path, why: '자격증명 키 이름' });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanForbidden(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scanForbidden(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

function deepDiff(a, b, path = '', out = []) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) out.push({ path: p, from: undefined, to: b[k] });
      else if (!(k in b)) out.push({ path: p, from: a[k], to: undefined });
      else deepDiff(a[k], b[k], p, out);
    }
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: path || '$', from: a, to: b });
  return out;
}

function validateConfig(cfg) {
  const errors = [];
  try { assertValid(cfg, 'harness', 'harness.json'); } catch (e) { errors.push(...(e.errors ?? [e.message])); }
  if (typeof cfg?.branch_pattern === 'string') {
    let re = null;
    try { re = new RegExp(cfg.branch_pattern); } catch (e) { errors.push(`branch_pattern 이 정규식이 아니다: ${e.message}`); }
    if (re && !/\(\?<keys>/.test(cfg.branch_pattern)) errors.push('branch_pattern 에 named group (?<keys>…) 이 없다 — 이슈 번호를 캡처하지 못한다');
  }
  return errors;
}

function mergeSettings(root, { marketplace, plugin, repo }) {
  const file = join(root, '.claude/settings.json');
  const cur = readJson(file);
  if (!cur.ok && !cur.missing) return { path: '.claude/settings.json', changed: false, added: [], error: `settings.json 을 읽을 수 없다: ${cur.error}` };
  const settings = cur.value ?? {};
  const added = [];
  const before = JSON.stringify(settings);
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces ?? {};
  const wantMarket = { source: { source: 'github', repo } };
  if (JSON.stringify(settings.extraKnownMarketplaces[marketplace]) !== JSON.stringify(wantMarket)) {
    settings.extraKnownMarketplaces[marketplace] = wantMarket;
    added.push(`extraKnownMarketplaces.${marketplace}`);
  }
  settings.enabledPlugins = settings.enabledPlugins ?? {};
  const pluginKey = `${plugin}@${marketplace}`;
  if (settings.enabledPlugins[pluginKey] !== true) {
    settings.enabledPlugins[pluginKey] = true;
    added.push(`enabledPlugins.${pluginKey}`);
  }
  const changed = JSON.stringify(settings) !== before;
  if (changed) writeJson(file, settings);
  return { path: '.claude/settings.json', changed, added, error: null };
}

const GITIGNORE_LINES = ['.claude/harness.env.local', '.claude/runtime/'];

function ensureGitignore(root) {
  const file = join(root, '.gitignore');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(text.split(/\r?\n/).map(l => l.trim()));
  const add = GITIGNORE_LINES.filter(l => !have.has(l));
  if (add.length) {
    const prefix = text && !text.endsWith('\n') ? '\n' : '';
    appendFileSync(file, `${prefix}${add.join('\n')}\n`, 'utf8');
  }
  return { path: '.gitignore', added: add };
}

function cmdWrite() {
  const src = opt('--config');
  if (!src) die('write 에는 --config <json 파일|-> 가 필요하다');
  let raw;
  try { raw = src === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(src), 'utf8'); }
  catch (e) { die(`--config 를 읽을 수 없다: ${e.message}`); }
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { die(`--config 가 JSON 이 아니다: ${e.message}`); }

  const errors = validateConfig(cfg);
  const forbidden = scanForbidden(cfg);
  if (errors.length || forbidden.length) {
    const payload = {
      config: { path: norm(join(cwd, CONFIG_REL)), status: 'rejected' },
      errors,
      forbidden,
      hint: forbidden.length ? '절대 경로·자격증명은 harness.json 에 두지 않는다 — stacks.<name>.env_file 이 가리키는 gitignore 파일(.claude/harness.env.local)로 옮길 것' : null,
    };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else {
      for (const e of errors) console.error(`[setup] 스키마: ${e}`);
      for (const f of forbidden) console.error(`[setup] 금지 값 ${f.path}: ${f.why}`);
      if (payload.hint) console.error(`[setup] ${payload.hint}`);
    }
    process.exit(2);
  }

  const file = join(cwd, CONFIG_REL);
  const cur = readJson(file);
  if (!cur.ok && !cur.missing) die(`기존 harness.json 을 읽을 수 없다(덮어쓰지 않는다): ${cur.error}`);
  let status = 'created';
  let diff = [];
  if (cur.ok) {
    diff = deepDiff(cur.value, cfg);
    if (!diff.length) status = 'unchanged';
    else if (!flag('--force')) {
      const payload = { config: { path: norm(file), status: 'refused' }, diff, hint: '--force 로 덮어쓸 것' };
      if (json) console.log(JSON.stringify(payload, null, 2));
      else {
        console.error('[setup] 기존 harness.json 과 다르다 — --force 없이는 덮어쓰지 않는다:');
        for (const d of diff) console.error(`  ${d.path}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`);
      }
      process.exit(1);
    } else status = 'updated';
  }
  if (status !== 'unchanged') writeJson(file, cfg);

  const settings = mergeSettings(cwd, {
    marketplace: opt('--marketplace', 'jira-harness'),
    plugin: opt('--plugin', 'jira-harness'),
    repo: opt('--repo', 'bigbulgogiburger/jira-harness'),
  });
  const gitignore = ensureGitignore(cwd);
  const payload = { config: { path: norm(file), status }, diff, settings, gitignore };
  emit(payload, settings.error ? 1 : 0, [
    `[setup] harness.json ${status}`,
    `[setup] settings.json ${settings.error ?? (settings.changed ? `병합: ${settings.added.join(', ')}` : '변경 없음')}`,
    `[setup] .gitignore ${gitignore.added.length ? `추가: ${gitignore.added.join(', ')}` : '변경 없음'}`,
  ]);
}

// ================================================================= 임시 clone (check·inject 공용)

// Git Bash 탐색은 lib/shell.mjs 의 findBash — gate.mjs 가 실제로 쓰는 것과 같은 함수여야 check 항목이 의미가 있다.

function hasCommand(name) {
  const w = run(process.platform === 'win32' ? 'where' : 'which', [name]);
  if (w.status !== 0) return null;
  const first = w.out.split('\n').map(s => s.trim()).find(Boolean);
  return first ? norm(first) : null;
}

/**
 * 프로젝트를 임시 디렉터리로 `git clone --local --no-hardlinks` 한다 — 작업 중인 저장소는 건드리지 않는다.
 * 커밋이 0이면 clone 이 불가능하므로 {ok:false} 를 돌려준다(그렇게 보고한다).
 */
function makeProbeClone(root) {
  const head = git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, allowFail: true });
  if (head.status !== 0) return { ok: false, reason: '커밋이 0건이라 clone 할 수 없다 — 최초 커밋 후 다시 실행할 것' };
  const dst = norm(join(tmpdir(), `jira-harness-probe-${process.pid}-${Date.now()}`));
  const r = run('git', ['clone', '--local', '--no-hardlinks', '-q', norm(root), dst]);
  if (r.status !== 0) return { ok: false, reason: `clone 실패: ${r.err.trim().slice(0, 200)}` };
  run('git', ['config', 'user.email', 'probe@example.invalid'], { cwd: dst });
  run('git', ['config', 'user.name', 'jira-harness probe'], { cwd: dst });
  // harness.json 은 아직 커밋 전일 수 있다 — 원본의 것을 그대로 복사해 같은 설정으로 판정한다.
  const srcCfg = join(root, CONFIG_REL);
  if (existsSync(srcCfg)) {
    mkdirSync(join(dst, '.claude'), { recursive: true });
    copyFileSync(srcCfg, join(dst, CONFIG_REL));
  }
  return { ok: true, dir: dst };
}

function dropProbeClone(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 임시 디렉터리는 남아도 무해 */ }
}

// ================================================================= check

function nodeMajor() { return Number(process.versions.node.split('.')[0]); }

function gateDryRun(dir, level) {
  const r = run(NODE, [join(HERE, 'gate.mjs'), level, '--dry-run', '--json', '--cwd', dir], { cwd: dir });
  if (r.status !== 0) return { ok: false, detail: (r.err.trim() || r.out.trim()).split('\n').pop()?.slice(0, 200) ?? `exit ${r.status}` };
  try {
    const plan = JSON.parse(r.out);
    const stacks = Object.keys(plan.stacks ?? {});
    const cmds = Object.values(plan.stacks ?? {}).flatMap(s => Object.values(s)).filter(Boolean).length;
    return { ok: true, detail: `스택 ${stacks.length}개(${stacks.join(', ') || '없음'}) · 명령 ${cmds}개 · DoD 프로브 ${(plan.dod_probes ?? []).length}개 · shell ${plan.shell}` };
  } catch { return { ok: false, detail: 'dry-run 출력이 JSON 이 아니다' }; }
}

/** 게이트 dry-run 은 이슈 브랜치와 상태 JSON 을 전제한다 — 임시 clone 에 합성해서 실측한다. */
function gateDryRunInClone(root, cfg) {
  const clone = makeProbeClone(root);
  if (!clone.ok) return { commit: { ok: false, detail: clone.reason }, full: { ok: false, detail: clone.reason } };
  try {
    const branch = probeBranch(cfg);
    if (!branch) return { commit: { ok: false, detail: 'branch_pattern 에 맞는 이슈 브랜치 이름을 만들 수 없다' }, full: { ok: false, detail: 'branch_pattern 불일치' } };
    const co = run('git', ['checkout', '-q', '-b', branch], { cwd: clone.dir });
    if (co.status !== 0) return { commit: { ok: false, detail: `브랜치 생성 실패: ${co.err.trim().slice(0, 160)}` }, full: { ok: false, detail: '브랜치 생성 실패' } };
    writeState(statePath(cfg, clone.dir, branch.replace(/[\/\\]/g, '-')), newState(branch, [`${cfg.issue_prefix}-1`]));
    return { commit: gateDryRun(clone.dir, '--commit'), full: gateDryRun(clone.dir, '--full') };
  } finally { dropProbeClone(clone.dir); }
}

function cmdCheck() {
  const items = [];
  const add = (id, ok, detail, failClosedStage) => items.push({ id, ok, detail, failClosedStage });

  add('node', nodeMajor() >= 20, `node ${process.versions.node} (필요 ≥ 20)`, 'all');
  const gitVer = run('git', ['--version']);
  add('git', gitVer.status === 0, gitVer.status === 0 ? gitVer.out.trim() : 'git 을 찾을 수 없다', 'all');
  if (process.platform === 'win32') {
    const bash = findBash();
    add('bash', !!bash, bash ? `Git Bash: ${bash}` : 'Git Bash 를 찾을 수 없다(WSL bash 는 제외) — JIRA_HARNESS_BASH 로 지정하거나 harness.json.shell=cmd', 'gate');
  }
  const codex = hasCommand('codex');
  add('codex', !!codex, codex ? `codex CLI: ${codex}` : 'codex CLI 없음 — 리뷰 1단계(Codex) 는 건너뛰고 워크플로 레인으로 폴백한다(review.codex=false 로 두거나 설치)', 'verify');

  const cfgPath = join(cwd, CONFIG_REL);
  let cfg = null;
  if (!existsSync(cfgPath)) add('harness', false, `${CONFIG_REL} 없음 — setup write 로 만들 것`, 'all');
  else {
    try { cfg = loadConfig(cfgPath); add('harness', true, `스택 ${Object.keys(cfg.stacks).length}개 · mode=${cfg.mode} · prefix=${cfg.issue_prefix}`, 'all'); }
    catch (e) { add('harness', false, `harness.json 무효: ${e.message.split('\n')[0]}`, 'all'); }
  }

  if (cfg) {
    const dry = gateDryRunInClone(cwd, cfg);
    add('gate-commit-dry', dry.commit.ok, dry.commit.detail, 'commit');
    add('gate-full-dry', dry.full.ok, dry.full.detail, 'push');
  } else {
    add('gate-commit-dry', false, 'harness.json 이 없어 실행할 수 없다', 'commit');
    add('gate-full-dry', false, 'harness.json 이 없어 실행할 수 없다', 'push');
  }

  const failed = items.filter(i => !i.ok);
  emit({ root: cwd, items, ok: failed.length === 0, failed: failed.map(i => i.id) }, failed.length ? 1 : 0,
    items.map(i => `${i.ok ? 'OK  ' : 'FAIL'} ${i.id.padEnd(16)} ${i.detail}${i.ok ? '' : `  [미충족 시 fail-closed: ${i.failClosedStage}]`}`));
}

// ================================================================= upgrade

const V2_HOOK_MARKERS = ['harness-context-inject', 'compile-check', 'review-gate'];
const V2_RUNTIME_GLOBS = [/^sprint-contract.*$/, /^workflow-state.*\.json$/, /^aggregate-verdict.*\.md$/, /^changed-files\.txt$/];

function archiveTarget(root, relPath) {
  // .claude/runtime/x → .claude/runtime/archive/v2/runtime/x (원래 상대 구조를 보존한 채 이동)
  const underClaude = relPath.replace(/^\.claude\//, '');
  return join(root, '.claude/runtime/archive/v2', underClaude);
}

function moveToArchive(root, relPath, apply) {
  const from = join(root, relPath);
  const to = archiveTarget(root, relPath);
  if (!apply) return { from: norm(relPath), to: norm(relative(root, to)), applied: false };
  mkdirSync(dirname(to), { recursive: true });
  try { renameSync(from, to); }
  catch { copyFileSync(from, to); rmSync(from, { force: true }); }
  return { from: norm(relPath), to: norm(relative(root, to)), applied: true };
}

/** settings 의 hooks 에서 v2 훅 항목만 뺀다. 값(특히 env)은 출력하지 않는다 — 비밀일 수 있다. */
function stripV2Hooks(settings, fileLabel) {
  const removed = [];
  const hooks = settings.hooks;
  if (hooks && typeof hooks === 'object') {
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      const keptGroups = [];
      for (const grp of groups) {
        const inner = Array.isArray(grp?.hooks) ? grp.hooks : null;
        if (!inner) { keptGroups.push(grp); continue; }
        const kept = inner.filter(h => {
          const marker = V2_HOOK_MARKERS.find(m => String(h?.command ?? '').includes(m));
          if (marker) { removed.push({ file: fileLabel, event, marker }); return false; }
          return true;
        });
        if (kept.length) keptGroups.push({ ...grp, hooks: kept });
      }
      if (keptGroups.length) hooks[event] = keptGroups; else delete hooks[event];
    }
    if (!Object.keys(hooks).length) delete settings.hooks;
  }
  let envRemoved = false;
  if (settings.env && typeof settings.env === 'object' && 'HARNESS_MODE' in settings.env) {
    delete settings.env.HARNESS_MODE; // 다른 env 키는 그대로 두고 값은 어디에도 찍지 않는다
    envRemoved = true;
    if (!Object.keys(settings.env).length) delete settings.env;
  }
  return { removed, envRemoved };
}

function cmdUpgrade() {
  const apply = flag('--apply');
  const found = [];
  const moved = [];
  const removedHooks = [];
  const warnings = [];

  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    const file = join(cwd, rel);
    if (!existsSync(file)) continue;
    const cur = readJson(file);
    if (!cur.ok) { warnings.push(`${rel} 을 읽을 수 없다 — 손대지 않았다`); continue; }
    const copy = JSON.parse(JSON.stringify(cur.value));
    const { removed, envRemoved } = stripV2Hooks(copy, rel);
    if (removed.length) { found.push(...removed.map(r => `${rel}: hooks.${r.event} → ${r.marker}`)); removedHooks.push(...removed.map(r => ({ ...r, applied: apply }))); }
    if (envRemoved) { found.push(`${rel}: env.HARNESS_MODE`); removedHooks.push({ file: rel, event: 'env', marker: 'HARNESS_MODE', applied: apply }); }
    if ((removed.length || envRemoved) && apply) writeJson(file, copy);
  }

  const runtimeDir = join(cwd, '.claude/runtime');
  if (existsSync(runtimeDir)) {
    for (const name of readdirSync(runtimeDir)) {
      if (name === 'archive') continue;
      const rel = `.claude/runtime/${name}`;
      let st; try { st = statSync(join(runtimeDir, name)); } catch { continue; }
      const isPhases = st.isDirectory() && name === 'phases';
      if (!isPhases && (st.isDirectory() || !V2_RUNTIME_GLOBS.some(re => re.test(name)))) continue;
      found.push(rel);
      moved.push(moveToArchive(cwd, rel, apply));
    }
  }
  const scriptsDir = join(cwd, '.claude/scripts');
  if (existsSync(scriptsDir)) {
    for (const name of readdirSync(scriptsDir)) {
      if (!/-execute\.py$/.test(name)) continue;
      const rel = `.claude/scripts/${name}`;
      found.push(rel);
      moved.push(moveToArchive(cwd, rel, apply));
    }
  }
  const hooksDir = join(cwd, '.claude/hooks');
  if (existsSync(hooksDir)) {
    for (const name of readdirSync(hooksDir)) {
      const stem = name.replace(/\.[^.]*$/, '');
      if (!V2_HOOK_MARKERS.includes(stem)) continue;
      const rel = `.claude/hooks/${name}`;
      found.push(rel);
      moved.push(moveToArchive(cwd, rel, apply));
    }
  }

  const pluginJson = readJson(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
  const pluginMajor = pluginJson.ok ? Number(String(pluginJson.value.version ?? '').split('.')[0]) : null;
  const cur = readJson(join(cwd, CONFIG_REL));
  if (!cur.ok) warnings.push(`${CONFIG_REL} 이 없거나 무효 — setup write 로 만들 것`);
  else if (pluginMajor != null && Number.isFinite(pluginMajor) && cur.value.version !== pluginMajor) {
    warnings.push(`플러그인 v${pluginJson.value.version} 과 harness.json.version=${cur.value.version} 이 다르다 — 설정을 v${pluginMajor} 로 올릴 것`);
  }

  emit({ root: cwd, apply, found, moved, removedHooks, warnings }, 0, [
    `[setup] v2 잔재 ${found.length}건${apply ? ' — 이관 실행' : ' (dry-run · --apply 로 실행)'}`,
    ...found.map(f => `  - ${f}`),
    ...moved.map(m => `  → ${m.from} ⇒ ${m.to}`),
    ...warnings.map(w => `  ⚠ ${w}`),
  ]);
}

// ================================================================= inject (위반 주입)

function probeBranch(cfg) {
  const cands = [String(cfg.branch_template ?? DEFAULTS.branch_template).replace('{keys}', `${cfg.issue_prefix}-1`), `feat/${cfg.issue_prefix}-1`];
  for (const b of cands) if (parseBranch(b, cfg)) return b;
  return null;
}

/** 코드 변경으로 인정되는(=docs_only 가 아닌) 프로브 파일 경로를 고른다. */
function probeFile(cfg) {
  const stack = Object.values(cfg.stacks ?? {})[0];
  const cands = [stack && stack.dir && stack.dir !== '.' ? `${String(stack.dir).replace(/\/$/, '')}/.jira-harness-probe` : null, '.jira-harness-probe', 'src/.jira-harness-probe'].filter(Boolean);
  for (const p of cands) if (!matchesAny(p, cfg.docs_only_paths)) return p;
  return null;
}

function runHook(dir, op = 'commit') {
  const command = op === 'push' ? 'git push -u origin HEAD' : 'git commit -m probe';
  const event = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir });
  const r = run(NODE, [join(HERE, 'commit-gate.mjs')], { cwd: dir, input: event });
  const out = r.out.trim();
  let decision = 'pass', reason = r.err.trim();
  if (out) {
    try {
      const j = JSON.parse(out);
      if (j.hookSpecificOutput?.permissionDecision === 'deny') { decision = 'deny'; reason = j.hookSpecificOutput.permissionDecisionReason; }
      else if (j.systemMessage) { decision = 'warn'; reason = j.systemMessage; }
    } catch { reason = out.slice(0, 200); }
  }
  const m = new RegExp(`git ${op}: ([A-Z_]+) —`).exec(reason);
  return { decision, code: m ? m[1] : 'UNKNOWN', reason };
}

function cmdInject() {
  const cfgPath = join(cwd, CONFIG_REL);
  if (!existsSync(cfgPath)) die(`${CONFIG_REL} 이 없다 — setup write 를 먼저 할 것`);
  let cfg;
  try { cfg = loadConfig(cfgPath); } catch (e) { die(`harness.json 무효: ${e.message.split('\n')[0]}`); }
  const clone = makeProbeClone(cwd);
  if (!clone.ok) emit({ root: cwd, clone: false, reason: clone.reason, cases: [] }, 1, [`[setup] 위반 주입 불가 — ${clone.reason}`]);

  const cases = [];
  const record = (name, expected, got, extra = {}) => cases.push({ case: name, expected, got, ok: got === expected, ...extra });
  try {
    const probe = probeFile(cfg);
    const branch = probeBranch(cfg);
    if (!probe) { record('branch-pattern', 'BRANCH_PATTERN', 'INCONCLUSIVE', { detail: 'docs_only_paths 밖의 프로브 파일 경로를 만들 수 없다' }); }
    if (!branch) { record('commit-without-gate', 'NO_GATE', 'INCONCLUSIVE', { detail: 'branch_pattern 에 맞는 이슈 브랜치 이름을 만들 수 없다' }); }
    if (probe && branch) {
      const write = text => { mkdirSync(dirname(join(clone.dir, probe)), { recursive: true }); writeFileSync(join(clone.dir, probe), text, 'utf8'); };

      // (a) 패턴 밖 브랜치에서 코드 커밋 → BRANCH_PATTERN deny
      run('git', ['checkout', '-q', '-b', 'jira-harness-probe-outside'], { cwd: clone.dir });
      write('probe a\n');
      run('git', ['add', '-A'], { cwd: clone.dir });
      const a = runHook(clone.dir);
      record('branch-pattern', 'BRANCH_PATTERN', a.code, { decision: a.decision });

      // (b) 이슈 브랜치 + 상태 JSON + 게이트 기록 없음 → NO_GATE deny
      run('git', ['checkout', '-q', '-b', branch], { cwd: clone.dir });
      const slug = branch.replace(/[\/\\]/g, '-');
      const sPath = statePath(cfg, clone.dir, slug);
      writeState(sPath, newState(branch, [`${cfg.issue_prefix}-1`]));
      const b = runHook(clone.dir);
      record('commit-without-gate', 'NO_GATE', b.code, { decision: b.decision });

      // (c) gate.mjs --commit 실행 후 → 통과(OK). 프로젝트 게이트 명령이 실제로 실패하면 GATE_FAIL 이 나온다.
      const g = run(NODE, [join(HERE, 'gate.mjs'), '--commit', '--json', '--cwd', clone.dir], { cwd: clone.dir });
      let gateNote = null;
      if (g.status !== 0) gateNote = (g.err.trim().split('\n').filter(l => /FAIL|오류|실패/.test(l)).pop() ?? `gate exit ${g.status}`).slice(0, 200);
      const st = readState(sPath);
      if (st?.gate?.tree) {
        st.review = { tree: st.gate.tree, files: [], codex: 'skipped', lanes: 0, findings: 0, blockers_open: 0, round: 1, delta_passes: 0, at: new Date().toISOString() };
        writeState(sPath, st);
      }
      const c = runHook(clone.dir);
      record('commit-after-gate', 'OK', c.code, { decision: c.decision, detail: gateNote });

      // (d) 경량 게이트만 통과한 상태의 push → GATE_LEVEL deny. push 판정은 **커밋된** 변경을 보므로 clone 안에서 실제로 커밋한다.
      if (c.code === 'OK') {
        const commit = run('git', ['commit', '-q', '-m', 'jira-harness probe'], { cwd: clone.dir });
        if (commit.status !== 0) record('push-without-full-gate', 'GATE_LEVEL', 'INCONCLUSIVE', { detail: `clone 안 커밋 실패: ${commit.err.trim().slice(0, 160)}` });
        else {
          const d = runHook(clone.dir, 'push');
          record('push-without-full-gate', 'GATE_LEVEL', d.code, { decision: d.decision });
        }
      } else record('push-without-full-gate', 'GATE_LEVEL', 'INCONCLUSIVE', { detail: '커밋 게이트가 통과하지 못해 push 축을 볼 수 없다' });
    }
  } finally { dropProbeClone(clone.dir); }

  const bad = cases.filter(c => !c.ok);
  emit({ root: cwd, clone: true, mode: cfg.mode, cases, ok: bad.length === 0 }, bad.length ? 1 : 0,
    cases.map(c => `${c.ok ? 'OK  ' : 'FAIL'} ${c.case.padEnd(22)} 기대 ${c.expected} · 실측 ${c.got}${c.detail ? ` (${c.detail})` : ''}`));
}

// ================================================================= 진입점

switch (cmd) {
  case 'detect': cmdDetect(); break;
  case 'write': cmdWrite(); break;
  case 'check': cmdCheck(); break;
  case 'upgrade': cmdUpgrade(); break;
  case 'inject': cmdInject(); break;
  default:
    die('사용법: setup.mjs detect | write --config <파일|-> [--force] [--marketplace <n>] [--plugin <n>] [--repo <owner/repo>] | check | upgrade [--apply] | inject   [--cwd <dir>] [--json]');
}
