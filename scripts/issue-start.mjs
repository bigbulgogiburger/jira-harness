#!/usr/bin/env node
// issue-start.mjs — 이슈 브랜치 채택/생성 + 상태 JSON 골격. 커밋/게이트/리뷰 기록은 건드리지 않는다(그건 gate.mjs·issue-set.mjs 의 일).
//
// 사용:
//   node issue-start.mjs --status [--cwd <dir>] [--json]
//   node issue-start.mjs <KEY[,KEY…]> [--adopt] [--cwd <dir>] [--json]
//
// 종료 코드: --status 는 항상 0(정보 조회, code 필드로 상태 판단). 시작 모드는 0(STARTED/ADOPTED/RESUMED) ·
//            1(ON_OTHER_BRANCH — 실패가 아니라 안내) · 2(사용법/설정 오류).
import { relative, resolve } from 'node:path';
import { locateProject, loadConfig, parseBranch, branchSlug, statePath, readState, writeState, newState, matchesAny, DEFAULTS } from './lib/config.mjs';
import { currentBranch, git, unstagedFiles, untrackedFiles } from './lib/git.mjs';
import { fingerprintTree } from './lib/tree.mjs';
import { treeAccepted } from './lib/gate-core.mjs';

// ---------- 인자 ----------
const argv = process.argv.slice(2);
let cwdArg = process.cwd();
let json = false, adopt = false, statusMode = false, keysArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--cwd') cwdArg = argv[++i];
  else if (a === '--json') json = true;
  else if (a === '--adopt') adopt = true;
  else if (a === '--status') statusMode = true;
  else if (!a.startsWith('--')) keysArg = a;
  else fail(2, `알 수 없는 옵션: ${a}`);
}
const cwd = resolve(cwdArg);

function fail(code, msg) { console.error(`[issue-start] ${msg}`); process.exit(code); }
function emit(obj, code = 0) { if (json) console.log(JSON.stringify(obj, null, 2)); else console.log(humanLine(obj)); process.exit(code); }
function humanLine(obj) {
  const parts = [`[issue-start] ${obj.code}`];
  if (obj.branch) parts.push(obj.branch);
  if (obj.stage) parts.push(`stage=${obj.stage}`);
  if (obj.next) parts.push(`next=${obj.next}`);
  if (obj.message) parts.push(obj.message);
  return parts.join(' · ');
}

const NEXT_HINTS = {
  start: keys => (keys.length >= 3 ? 'recon(선택) 후 grill' : 'grill'),
  grill: () => 'plan',
  plan: () => 'approve(승인 대기)',
  implement: () => 'verify',
  review: () => 'gate',
  gate: () => 'commit/push',
  complete: () => 'archived',
  archived: () => '(완료)',
};

function dirtyCounts(root, excludes) {
  return {
    unstaged: unstagedFiles(root).filter(p => !matchesAny(p, excludes)).length,
    untracked: untrackedFiles(root).filter(p => !matchesAny(p, excludes)).length,
  };
}

function gateReviewInfo(state, cfg, root) {
  const tree = fingerprintTree({ cwd: root, base: 'index', excludes: cfg.fingerprint_exclude });
  const gate = state.gate ? {
    level: state.gate.level,
    fresh: treeAccepted(state.gate.tree, tree, cfg, root).ok,
    results: state.gate.results,
    at: state.gate.at,
    human_pending: (state.dod ?? []).filter(d => d.human && d.last !== 'PASS').length,
  } : null;
  const review = state.review ? {
    fresh: treeAccepted(state.review.tree, tree, cfg, root).ok,
    blockers_open: state.review.blockers_open ?? 0,
    round: state.review.round ?? null,
    at: state.review.at,
  } : null;
  return { gate, review };
}

// ---------- --status ----------
if (statusMode) {
  const proj = locateProject(cwd);
  if (!proj) {
    emit({ code: 'NO_GIT', branch: null, keys: [], slug: null, stage: null, state_path: null, gate: null, review: null, dirty: { unstaged: 0, untracked: 0 }, next: 'git 저장소 안에서 실행할 것' });
  }
  if (!proj.configPath) {
    const root = proj.toplevel;
    const branch = currentBranch(root);
    emit({ code: 'NO_HARNESS', branch, keys: [], slug: null, stage: null, state_path: null, gate: null, review: null, dirty: dirtyCounts(root, DEFAULTS.fingerprint_exclude), next: '/jira-harness:setup 으로 harness.json 을 먼저 만들 것' });
  }
  const cfg = loadConfig(proj.configPath);
  const root = proj.toplevel;
  const configRoot = proj.configRoot;
  const branch = currentBranch(root);
  const dirty = dirtyCounts(root, cfg.fingerprint_exclude);
  if (!branch) {
    emit({ code: 'OUTSIDE_PATTERN', branch: null, keys: [], slug: null, stage: null, state_path: null, gate: null, review: null, dirty, next: '브랜치를 확인할 수 없다(detached) — 이슈 브랜치로 checkout 할 것' });
  }

  const parsed = parseBranch(branch, cfg);
  const slug = parsed ? parsed.slug : branchSlug(branch);
  const sPath = statePath(cfg, configRoot, slug);
  const state = readState(sPath);
  const relPath = relative(configRoot, sPath).replace(/\\/g, '/');

  if (!state) {
    const code = parsed ? 'NO_STATE' : 'OUTSIDE_PATTERN';
    const keys = parsed ? parsed.keys : [];
    const next = code === 'NO_STATE'
      ? `issue-start ${keys[0] ?? '<KEY>'}`
      : branch === cfg.default_branch
        ? `issue-start <KEY> (${cfg.default_branch} 에서 ${cfg.branch_template} 브랜치를 새로 만든다)`
        : `issue-start <KEY> --adopt (이 브랜치를 채택하려면) 또는 ${cfg.default_branch} 로 이동해 새로 시작`;
    emit({ code, branch, keys, slug, stage: null, state_path: relPath, gate: null, review: null, dirty, next });
  }

  const { gate, review } = gateReviewInfo(state, cfg, root);
  const nextFn = NEXT_HINTS[state.stage] ?? (() => '(알 수 없는 단계)');
  emit({ code: 'OK', branch, keys: state.keys, slug, stage: state.stage, state_path: relPath, gate, review, dirty, next: nextFn(state.keys ?? []) });
}

// ---------- 시작 모드 ----------
if (!keysArg) fail(2, '사용법: issue-start.mjs --status | <KEY[,KEY…]> [--adopt] [--cwd <dir>] [--json]');

const proj = locateProject(cwd);
if (!proj || !proj.configPath) fail(2, 'harness.json 이 없다 — /jira-harness:setup 으로 설치할 것');
const cfg = loadConfig(proj.configPath);
const root = proj.toplevel;
const configRoot = proj.configRoot;

const rawKeys = keysArg.split(',').map(k => k.trim().toUpperCase()).filter(Boolean);
const keyPattern = new RegExp(`^${cfg.issue_prefix}-\\d+$`);
const badKeys = rawKeys.filter(k => !keyPattern.test(k));
if (!rawKeys.length || badKeys.length) fail(2, `키 형식이 올바르지 않다: ${badKeys.join(', ') || '(비어 있음)'} — 기대 형식 ${cfg.issue_prefix}-숫자`);
const keys = rawKeys;

/** "ABC-696","ABC-940" → "ABC-696-940" (같은 접두사 — issue_prefix 검증을 통과했으므로 항상 같다) */
function keysToken(ks) {
  const nums = ks.map(k => k.split('-')[1]);
  return [ks[0], ...nums.slice(1)].join('-');
}

const currentB = currentBranch(root);
if (!currentB) fail(2, '현재 브랜치를 확인할 수 없다(detached HEAD)');

let targetBranch, scenario;
if (currentB === cfg.default_branch) {
  targetBranch = cfg.branch_template.replace('{keys}', keysToken(keys));
  const exists = git(['show-ref', '--verify', '--quiet', `refs/heads/${targetBranch}`], { cwd: root, allowFail: true }).status === 0;
  const co = git(['checkout', ...(exists ? [] : ['-b']), targetBranch], { cwd: root, allowFail: true });
  if (co.status !== 0) fail(1, `git checkout 실패(${targetBranch}): ${co.err}`);
  scenario = 'new';
} else if (parseBranch(currentB, cfg)) {
  targetBranch = currentB;
  scenario = 'keep';
} else {
  if (!adopt) {
    emit({
      code: 'ON_OTHER_BRANCH', branch: currentB, keys,
      message: `현재 브랜치 "${currentB}" 는 이슈 브랜치 패턴 밖이다 — ${cfg.default_branch} 로 이동해 새로 시작하거나, 이 브랜치를 쓰려면 --adopt 를 추가할 것`,
    }, 1);
  }
  targetBranch = currentB;
  scenario = 'adopt';
}

const slug = branchSlug(targetBranch);
const sPath = statePath(cfg, configRoot, slug);
let state = readState(sPath);
let created = false;
let code;
if (state) {
  code = 'RESUMED';
} else {
  state = newState(targetBranch, keys);
  writeState(sPath, state);
  created = true;
  code = scenario === 'adopt' ? 'ADOPTED' : 'STARTED';
}

const relPath = relative(configRoot, sPath).replace(/\\/g, '/');
const comment = `[jira-harness v3] 이슈 ${keys.join(', ')} 작업을 브랜치 \`${targetBranch}\` 에서 착수합니다.`;
emit({ code, branch: targetBranch, keys, slug, state_path: relPath, created, jira: { transition: cfg.jira.start_transition, comment } });
