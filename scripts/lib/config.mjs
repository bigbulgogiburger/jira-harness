// config.mjs — harness.json 로드·브랜치 해석·상태 JSON 읽기/쓰기(원자)·glob.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { assertValid } from './schema.mjs';
import { repoRoots } from './git.mjs';

export const CONFIG_REL = '.claude/harness.json';

export const DEFAULTS = Object.freeze({
  default_branch: 'main',
  default_branch_policy: 'deny',
  branch_template: 'feat/{keys}',
  shell: 'auto',
  runtime_dir: '.claude/runtime',
  docs_only_paths: ['docs/**', '**/*.md'],
  fingerprint_exclude: ['.claude/runtime/**', '**/*.draft'],
  review: { codex: true, codex_timeout: 2400, lanes_max: 4, lanes_when: 'codex_gap', lane_model: 'sonnet', rounds_max: 2, code_review: false },
  models: { orchestrate: 'inherit', design: 'opus', recon: 'sonnet', implement: 'opus', verify: 'sonnet' },
  wiki: { index: 'docs/INDEX.md', log: 'docs/LOG.md', schema: 'docs/INDEX-SCHEMA.md', dev_guide: 'docs/{KEY}-dev-guide.md', synthesis_dir: null, max_pages_per_closure: 3, claude_md_max_lines: 150 },
  jira: { start_transition: 'In Progress', done_transition: 'QA', comment_lang: 'ko' },
  gate: { timeout_s: 1800, commit_budget_s: 180 },
});

/**
 * cwd 에서 프로젝트를 찾는다. 설정은 작업트리(toplevel) 것을 읽되, 상태·로그(runtime) 는 항상 **메인 저장소**(configRoot) 에 둔다 —
 * worktree 마다 runtime 이 갈리면 같은 브랜치의 게이트 기록을 worktree 와 메인이 서로 못 본다. 없으면 configPath=null.
 */
export function locateProject(cwd = process.cwd()) {
  const roots = repoRoots(cwd);
  if (!roots) return null;
  const inMain = existsSync(join(roots.mainRoot, CONFIG_REL));
  const inTop = existsSync(join(roots.toplevel, CONFIG_REL));
  if (!inMain && !inTop) return { ...roots, configPath: null, configRoot: null };
  return {
    ...roots,
    configPath: join(inTop ? roots.toplevel : roots.mainRoot, CONFIG_REL),
    configRoot: inMain ? roots.mainRoot : roots.toplevel,
  };
}

export function loadConfig(configPath) {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  assertValid(raw, 'harness', configPath);
  const cfg = { ...DEFAULTS, ...raw };
  for (const k of ['review', 'models', 'wiki', 'jira', 'gate']) cfg[k] = { ...DEFAULTS[k], ...(raw[k] ?? {}) };
  for (const [name, s] of Object.entries(cfg.stacks)) {
    cfg.stacks[name] = { compile: null, lint: null, build: null, test: null, extra: [], env_file: null, ...s };
    if (!cfg.stacks[name].paths) cfg.stacks[name].paths = s.dir === '.' ? ['**'] : [`${s.dir.replace(/\/$/, '')}/**`];
  }
  return cfg;
}

/** 브랜치 이름 → { keys[], slug } — 패턴 밖이면 null */
export function parseBranch(branch, cfg) {
  if (!branch) return null;
  const m = new RegExp(cfg.branch_pattern).exec(branch);
  if (!m || !m.groups?.keys) return null;
  const keys = expandKeys(m.groups.keys, cfg.issue_prefix);
  return { branch, keys, slug: branchSlug(branch) };
}

/** "ABC-696-940-943" → ["ABC-696","ABC-940","ABC-943"] · "ABC-1-DEF-2" 처럼 접두사가 반복돼도 처리 */
export function expandKeys(captured, prefix) {
  const keys = [];
  let current = prefix;
  for (const tok of captured.split('-')) {
    if (/^\d+$/.test(tok)) keys.push(`${current}-${tok}`);
    else current = tok;
  }
  return keys;
}

export function branchSlug(branch) {
  return branch.replace(/[\/\\]/g, '-').replace(/[^A-Za-z0-9._-]/g, '_');
}

export function statePath(cfg, root, slug) {
  return join(root, cfg.runtime_dir, 'issues', `${slug}.json`);
}

/** issue-complete 가 옮긴 아카이브 상태 중 이 슬러그의 최신 파일(루트 기준 상대 경로). 없으면 null. */
export function latestArchivedState(cfg, root, slug) {
  const dir = join(root, cfg.runtime_dir, 'issues', 'archive');
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter(f => f.startsWith(`${slug}-`) && f.endsWith('.json')).sort();
  return names.length ? `${cfg.runtime_dir}/issues/archive/${names[names.length - 1]}` : null;
}

export function readState(file) {
  if (!existsSync(file)) return null;
  const st = JSON.parse(readFileSync(file, 'utf8'));
  assertValid(st, 'state', file);
  return st;
}

/** 원자 쓰기: tmp + rename. 검증 실패면 쓰지 않는다. */
export function writeState(file, state) {
  state.updated_at = new Date().toISOString();
  assertValid(state, 'state', file);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return state;
}

/** 깊은 병합(객체는 재귀, 배열·원시값은 교체). null 은 "지움"이 아니라 값이다. */
export function deepMerge(base, patch) {
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
  return out;
}

export function newState(branch, keys) {
  const now = new Date().toISOString();
  return { version: 3, branch, keys, stage: 'start', started_at: now, updated_at: now, guides: {}, decisions: [], touched: [], lanes: [], dod: [], gate: null, review: null, history: [{ stage: 'start', at: now }] };
}

// ---- glob ----
export function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(re + '$');
}

export function matchesAny(path, globs) {
  const p = path.replace(/\\/g, '/');
  return globs.some(g => globToRegExp(g).test(p));
}

/** 경로 목록이 전부 docs_only 인가 (빈 목록은 false — "바뀐 게 없다" 는 별도 판정) */
export function allDocsOnly(paths, cfg) {
  return paths.length > 0 && paths.every(p => matchesAny(p, cfg.docs_only_paths));
}

export function stacksTouched(paths, cfg) {
  const names = new Set();
  for (const [name, s] of Object.entries(cfg.stacks)) if (paths.some(p => matchesAny(p, s.paths))) names.add(name);
  return [...names];
}

export function listStates(cfg, root) {
  const dir = join(root, cfg.runtime_dir, 'issues');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => join(dir, f));
}

export function resolveIn(root, rel) { return resolve(root, rel); }
