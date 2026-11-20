#!/usr/bin/env node
// issue-start.mjs — 이슈 브랜치 채택/생성 + 상태 JSON 골격. 커밋/게이트/리뷰 기록은 건드리지 않는다(그건 gate.mjs·issue-set.mjs 의 일).
//
// 사용:
//   node issue-start.mjs --status [--cwd <dir>] [--json]
//   node issue-start.mjs <KEY[,KEY…]> [--adopt] [--group <PARENT=CHILD[,CHILD…]>]… [--cwd <dir>] [--json]
//   node issue-start.mjs <KEY[,KEY…]> --worktree [--base <ref>] [--group …]… [--cwd <dir>] [--json]
//   node issue-start.mjs --remove-worktree <KEY[,KEY…]|경로> [--force] [--cwd <dir>] [--json]
//   --group: 하위이슈 묶음을 상태 JSON 의 subtasks 에 기록한다(issue-subtasks.mjs 출력의 group_args). 새 상태를 만들 때만 쓴다(RESUMED 는 무시).
//   --worktree: 지금 트리(브랜치·인덱스·작업 파일)는 그대로 두고 이슈 브랜치를 <메인>/.claude/worktrees/<이름> 작업트리에 만든다 — 이미 있으면 그것을 쓴다.
//               base 는 --base 또는 default_branch(로컬). 상태는 언제나 메인 저장소 runtime 에 쓴다.
//               harness.json 의 issue_worktree 가 "always" 면 플래그 없는 시작도 이렇게 한다 — 지금 트리가 이미 그 키의 이슈 브랜치일 때(제자리에서 잇는다)와 --adopt 만 예외.
//               일하는 자리는 플래그가 아니라 출력으로 안다: worktree.path 가 있으면 그 경로다.
//   --remove-worktree: 이슈 작업트리를 지운다(링크를 먼저 끊는다). 브랜치·상태 JSON 은 남긴다. 커밋 안 된 변경이 있으면 --force 없이는 거부.
//               그 이슈의 구현 레인이 남긴 작업트리와 레인 브랜치(lane/<slug>/…)도 함께 치운다(lib/worktree.mjs removeLaneLeftovers — 회수되지 않은 변경이나
//               레인이 커밋한 작업이 있으면 남기고 출력 lanes.kept 에 사유를 싣는다). 이슈 작업트리가 없어도(메인 체크아웃에서 한 이슈) 레인 잔재는 치운다.
//               --force 는 이슈 작업트리의 커밋 안 된 변경에만 듣는다 — 이슈 작업트리가 거부되면 레인에도 손대지 않는다.
//
// 종료 코드: --status 는 항상 0(정보 조회, code 필드로 상태 판단). 시작 모드는 0(STARTED/ADOPTED/RESUMED) ·
//            1(ON_OTHER_BRANCH — 실패가 아니라 안내 · WORKTREE_PATH_TAKEN · WORKTREE_ADD_FAILED) · 2(사용법/설정 오류).
//            --remove-worktree 는 0(REMOVED — 이슈 작업트리든 레인 잔재든 하나라도 치웠다) · 1(NO_WORKTREE · LANES_KEPT — 레인 잔재가 있는데 하나도 못 치웠다 ·
//            IN_WORKTREE · DIRTY 등 removeWorktree 의 code) · 2.
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, readFileSync } from 'node:fs';
import { relative, resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateProject, loadConfig, parseBranch, branchSlug, statePath, latestArchivedState, readState, writeState, newState, matchesAny, DEFAULTS } from './lib/config.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
import { currentBranch, git, unstagedFiles, untrackedFiles } from './lib/git.mjs';
import { fingerprintTree } from './lib/tree.mjs';
import { treeAccepted } from './lib/gate-core.mjs';
import { herdrPing, herdrEnv } from './lib/herdr.mjs';
import { laneRunner, LANE_BRANCH_ROOT } from './lib/lanes.mjs';
import { listWorktrees, prepareWorktree, removeWorktree, removeLaneLeftovers, ensureLocallyIgnored, samePath } from './lib/worktree.mjs';

// ---------- 인자 ----------
const argv = process.argv.slice(2);
let cwdArg = process.cwd();
let json = false, adopt = false, statusMode = false, keysArg = null;
let worktreeMode = false, removeMode = false, force = false, baseArg = null;
const groupArgs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--cwd') cwdArg = argv[++i];
  else if (a === '--group') groupArgs.push(argv[++i] ?? '');
  else if (a === '--json') json = true;
  else if (a === '--adopt') adopt = true;
  else if (a === '--status') statusMode = true;
  else if (a === '--worktree') worktreeMode = true;
  else if (a === '--base') baseArg = argv[++i];
  else if (a === '--remove-worktree') removeMode = true;
  else if (a === '--force') force = true;
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
  if (obj.path) parts.push(obj.path);
  if (obj.message) parts.push(obj.message);
  if (obj.reason) parts.push(obj.reason);
  let line = parts.join(' · ');
  if (obj.worktree) {
    line += `\n[issue-start] 작업트리 ${obj.worktree.path}${obj.worktree.created ? ' (새로 팠다)' : ' (있던 것)'} — 이후 명령은 이 경로에서(--cwd ${obj.worktree.path}) 돌린다`;
    const bad = obj.worktree.prepared?.init?.find(i => i.exit !== 0);
    if (bad) line += `\n[issue-start] 준비 명령 실패(exit ${bad.exit}): ${bad.cmd} — 작업트리에서 다시 돌릴 것`;
  }
  if (obj.lanes) {
    line += `\n[issue-start] 레인 잔재: 작업트리 ${obj.lanes.removed.length}개 · 브랜치 ${obj.lanes.branches.length}개를 치웠다`;
    for (const k of obj.lanes.kept) line += `\n[issue-start] 남김 ${k.path ?? k.branch}${k.pane ? ` (pane ${k.pane})` : ''} — ${k.reason}`;
  }
  return line;
}
const fwd = p => String(p).replace(/\\/g, '/');

const NEXT_HINTS = {
  start: () => 'grill',
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
      : cfg.issue_worktree === 'always'
        ? `issue-start <KEY> (작업트리에 ${cfg.branch_template} 브랜치를 새로 만든다 — 이 트리는 그대로. 출력 worktree.path 가 일하는 자리다)${branch === cfg.default_branch ? '' : ' · 이 브랜치를 채택하려면 --adopt'}`
        : branch === cfg.default_branch
          ? `issue-start <KEY> (${cfg.default_branch} 에서 ${cfg.branch_template} 브랜치를 새로 만든다)`
          : `issue-start <KEY> --adopt (이 브랜치를 채택하려면) 또는 ${cfg.default_branch} 로 이동해 새로 시작`;
    emit({ code, branch, keys, slug, stage: null, state_path: relPath, gate: null, review: null, dirty, next });
  }

  const { gate, review } = gateReviewInfo(state, cfg, root);
  const nextFn = NEXT_HINTS[state.stage] ?? (() => '(알 수 없는 단계)');
  // lane_runner — 이 세션이 구현 레인을 돌리는 수단(herdr | workflow). 설정(herdr.lanes)만으로는 정해지지 않는다: 설정이 켜져 있어도 Herdr 밖 세션은 workflow 다.
  // plan 의 레인 설계(worktree·kind)와 implement 의 실행 수단이 이 값 하나를 따른다
  emit({ code: 'OK', branch, keys: state.keys, subtasks: state.subtasks ?? [], slug, stage: state.stage, state_path: relPath, gate, review, dirty, lane_runner: laneRunner(cfg, herdrEnv().inside), next: nextFn(state.keys ?? []) });
}

// ---------- 시작 모드 ----------
const USAGE = '사용법: issue-start.mjs --status | <KEY[,KEY…]> [--adopt | --worktree [--base <ref>]] [--cwd <dir>] [--json] | --remove-worktree <KEY[,KEY…]|경로> [--force]';
if (worktreeMode && adopt) fail(2, `--worktree 와 --adopt 는 같이 쓸 수 없다 — ${USAGE}`);
if (!keysArg) fail(2, USAGE);

const proj = locateProject(cwd);
if (!proj || !proj.configPath) fail(2, 'harness.json 이 없다 — /jira-harness:setup 으로 설치할 것');
const cfg = loadConfig(proj.configPath);
const root = proj.toplevel;
const configRoot = proj.configRoot;
const mainRoot = proj.mainRoot; // 작업트리를 파고 지우는 git 명령은 어느 트리에서 불렀든 메인 체크아웃에서 돈다

function parseKeys(arg) {
  const raw = arg.split(',').map(k => k.trim().toUpperCase()).filter(Boolean);
  const keyPattern = new RegExp(`^${cfg.issue_prefix}-\\d+$`);
  const bad = raw.filter(k => !keyPattern.test(k));
  if (!raw.length || bad.length) fail(2, `키 형식이 올바르지 않다: ${bad.join(', ') || '(비어 있음)'} — 기대 형식 ${cfg.issue_prefix}-숫자`);
  return raw;
}

/** "ABC-696","ABC-940" → "ABC-696-940" (같은 접두사 — issue_prefix 검증을 통과했으므로 항상 같다) */
function keysToken(ks) {
  const nums = ks.map(k => k.split('-')[1]);
  return [ks[0], ...nums.slice(1)].join('-');
}
// 새 이슈 브랜치 이름 — 플래그 없는 시작 · --worktree · --remove-worktree 가 같은 이름을 보게 한 곳에서만 정한다
const templateBranch = ks => cfg.branch_template.replace('{keys}', keysToken(ks));

const sameKeys = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && b.every(k => a.includes(k));

/** slug 의 상태 JSON(진행 중이거나 마감해 옮긴 것)에 적힌 키 — 없거나 그 slug 의 것이 아니면 null */
function stateKeysOf(slug) {
  const archived = latestArchivedState(cfg, configRoot, slug);
  for (const file of [statePath(cfg, configRoot, slug), ...(archived ? [join(configRoot, archived)] : [])]) {
    try {
      const st = JSON.parse(readFileSync(file, 'utf8'));
      if (st && typeof st.branch === 'string' && branchSlug(st.branch) === slug && Array.isArray(st.keys)) return st.keys;
    } catch { /* 없거나 깨진 상태 — 이 slug 는 그 키의 것으로 보지 않는다 */ }
  }
  return null;
}
/** 이 이슈의 레인 잔재가 달려 있을 slug 들 — 이슈 브랜치의 slug, 그리고 KEY 로 불렀으면 같은 키로 시작한 다른 이름의 브랜치(--adopt)의 slug */
function laneSlugs(branch, ks) {
  const own = branchSlug(branch);
  if (!ks) return [own];
  const refs = git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${LANE_BRANCH_ROOT}`], { cwd: mainRoot, allowFail: true });
  const found = new Set(refs.status === 0 ? refs.out.split('\n').map(b => b.trim().split('/')[1]).filter(Boolean) : []);
  return [own, ...[...found].filter(s => s !== own && sameKeys(stateKeysOf(s), ks))];
}

// ---------- --remove-worktree ----------
if (removeMode) {
  const asPath = resolve(cwd, keysArg);
  const byPath = existsSync(asPath) && statSync(asPath).isDirectory();
  const ks = byPath ? null : parseKeys(keysArg);
  const target = ks ? templateBranch(ks) : null;
  // KEY 로 불렀는데 그 브랜치가 메인 체크아웃에 걸려 있으면(이슈를 메인 체크아웃에서 했다) 지울 이슈 작업트리는 없다 — 레인 잔재만 본다
  const hit = byPath ? null : listWorktrees(mainRoot).find(w => w.branch === target);
  const wtPath = byPath ? fwd(asPath) : (hit && !hit.main ? hit.path : null);
  const branch = wtPath ? (listWorktrees(mainRoot).find(w => samePath(w.path, wtPath))?.branch ?? null) : target;
  let removed = null;
  if (wtPath) {
    // 자기 폴더 안에서는 지울 수 없다(Windows 는 cwd 폴더가 잠긴다) — 지우다 만 반쪽 상태를 남기기 전에 멈춘다.
    // --cwd 만 보면 안 된다: 셸이 작업트리 안에 선 채 --cwd <메인> 으로 부르면 파일·등록만 지워지고 빈 폴더가 남았다(실측)
    if (samePath(root, wtPath) || samePath(locateProject(process.cwd())?.toplevel, wtPath)) emit({ code: 'IN_WORKTREE', path: wtPath, branch, message: `지우려는 작업트리 안에서 불렀다 — 메인 체크아웃에서(--cwd ${mainRoot}) 다시 부를 것` }, 1);
    removed = removeWorktree(wtPath, { repoDir: mainRoot, force });
    // 이슈 작업트리를 지우지 못했으면 여기서 끝난다 — 그 이슈의 레인에도 손대지 않는다(--force 는 이슈 작업트리의 커밋 안 된 변경에만 듣는다)
    if (!removed.ok) emit({
      code: removed.code, path: wtPath, branch, reason: removed.reason,
      ...(removed.dirty ? { dirty: removed.dirty } : {}), ...(removed.unlinked ? { unlinked: removed.unlinked } : {}),
      ...(removed.code === 'DIRTY' ? { message: '변경을 확인한 뒤 --force 로 다시 부를 것' } : {}),
    }, 1);
  }
  // 그 이슈의 구현 레인이 남긴 작업트리·레인 브랜치. 레인 작업트리를 경로로 직접 준 경우(브랜치가 lane/…)는 그 하나만 지운 것이다
  const lanes = { removed: [], branches: [], kept: [] };
  if (branch && !branch.startsWith(LANE_BRANCH_ROOT)) {
    const rt = join(configRoot, cfg.runtime_dir);
    for (const s of laneSlugs(branch, ks)) {
      const l = removeLaneLeftovers({ repoDir: mainRoot, rt, slug: s, worktreeDir: cfg.herdr?.worktree_dir ?? null });
      lanes.removed.push(...l.removed); lanes.branches.push(...l.branches); lanes.kept.push(...l.kept);
    }
  }
  const cleaned = lanes.removed.length + lanes.branches.length;
  const withLanes = cleaned || lanes.kept.length ? { lanes } : {};
  if (removed) emit({ code: 'REMOVED', path: wtPath, unlinked: removed.unlinked, branch, ...withLanes });
  if (cleaned) emit({ code: 'REMOVED', path: null, branch, keys: ks, lanes });
  if (lanes.kept.length) emit({ code: 'LANES_KEPT', branch, keys: ks, lanes, message: '레인 잔재를 하나도 치우지 못했다 — 사유는 lanes.kept' }, 1);
  emit({ code: 'NO_WORKTREE', branch: target, keys: ks, message: hit?.main ? `${target} 브랜치는 메인 체크아웃에 걸려 있다 — 지울 작업트리도 레인 잔재도 없다` : `${target} 브랜치의 작업트리가 없다` }, 1);
}

const keys = parseKeys(keysArg);
const groups = groupArgs.map((g) => {
  const [parent, rest = ''] = g.split('=');
  const p = (parent ?? '').trim().toUpperCase();
  const children = rest.split(',').map(k => k.trim().toUpperCase()).filter(Boolean);
  if (!keys.includes(p) || !children.length || children.some(c => !keys.includes(c))) fail(2, `--group 형식이 올바르지 않다: "${g}" — 기대 형식 PARENT=CHILD[,CHILD…] (모두 위 키 목록 안의 키)`);
  return { parent: p, children };
});

/**
 * 이슈 브랜치의 작업트리를 연다 — 이미 있으면 그것(created:false), 없으면 <메인>/.claude/worktrees/<이름> 에 파고 준비한다.
 * 실패(자리 점유 · git 실패)는 상태를 쓰기 전에 exit 1 로 끝난다.
 */
function openWorktree(branch) {
  let list = listWorktrees(mainRoot);
  let hit = list.find(w => w.branch === branch);
  if (hit && !existsSync(hit.path)) {
    // 폴더만 손으로 지워진 등록 잔재 — 없는 경로를 돌려주지 않게 등록을 치우고 아래에서 새로 판다(브랜치와 커밋은 그대로다)
    git(['worktree', 'prune'], { cwd: mainRoot, allowFail: true });
    list = listWorktrees(mainRoot);
    hit = list.find(w => w.branch === branch);
  }
  // 그 브랜치가 메인 체크아웃에 걸려 있으면 그곳이 일할 자리다(main: true) — 따로 파지 않는다
  if (hit) return { path: hit.path, created: false, ...(hit.main ? { main: true } : {}), base: null, ignored: null, prepared: null };
  const parent = join(mainRoot, '.claude', 'worktrees');
  const path = fwd(join(parent, branch.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_')));
  if (existsSync(path)) {
    // 등록 안 된 폴더는 누가 무엇을 두었는지 모른다 — 지우지 않고 사람에게 넘긴다
    const other = list.find(w => samePath(w.path, path));
    emit({ code: 'WORKTREE_PATH_TAKEN', branch, keys, path, message: other ? `그 자리는 다른 브랜치(${other.branch ?? 'detached'})의 작업트리다` : '등록되지 않은 폴더가 이미 있다 — 지우지 않았다. 내용을 확인해 치운 뒤 다시 부를 것' }, 1);
  }
  const ignored = ensureLocallyIgnored(mainRoot, parent); // 작업트리 폴더가 메인 체크아웃의 비추적 파일로 잡혀 트리 지문을 흔들지 않게
  const exists = git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: mainRoot, allowFail: true }).status === 0;
  const base = exists ? null : (baseArg ?? cfg.default_branch);
  const add = git(['worktree', 'add', '-q', ...(exists ? [path, branch] : ['-b', branch, path, base])], { cwd: mainRoot, allowFail: true });
  if (add.status !== 0) emit({ code: 'WORKTREE_ADD_FAILED', branch, keys, path, base, reason: (add.err || add.out || 'git worktree add 실패').split('\n')[0] }, 1);
  const prepared = prepareWorktree(path, { repoDir: mainRoot, copy: cfg.herdr.worktree_copy ?? [], init: cfg.herdr.worktree_init ?? [], cfg, env: process.env });
  return { path, created: true, base, ignored, prepared };
}

let targetBranch, scenario, worktree = null;
const currentB = currentBranch(root);
// issue_worktree: always — 플래그 없는 시작도 작업트리에서 한다(지금 트리의 브랜치를 바꾸지 않는다). 예외 둘:
//   · 지금 트리가 이미 그 키의 이슈 브랜치다(이름이 템플릿과 달라도) → 제자리에서 잇는다. 「브랜치는 두고 상태만 만드는」 경로(NO_STATE)가 새 작업트리를 파면 안 된다
//   · --adopt 로 지금 브랜치(기본 브랜치가 아닌)를 채택한다
const always = cfg.issue_worktree === 'always' && !sameKeys(parseBranch(currentB, cfg)?.keys, keys) && !(adopt && currentB && currentB !== cfg.default_branch);
if (worktreeMode || always) {
  // 지금 트리가 어느 브랜치든(분리 HEAD 포함) 같게 동작한다 — 지금 트리는 건드리지 않는다
  targetBranch = templateBranch(keys);
  worktree = openWorktree(targetBranch);
  scenario = 'worktree';
} else if (!currentB) {
  fail(2, '현재 브랜치를 확인할 수 없다(detached HEAD)');
} else if (currentB === cfg.default_branch) {
  targetBranch = templateBranch(keys);
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
  if (groups.length) state.subtasks = groups;
  writeState(sPath, state);
  created = true;
  code = scenario === 'adopt' ? 'ADOPTED' : 'STARTED';
}
herdrPing(cwd, `${code.toLowerCase()} ${keys.join(',')}`);

// Workflow 툴은 작업 디렉토리 밖의 scriptPath 를 거부한다 — 플러그인 워크플로를 프로젝트 runtime 안으로 복사해 두어야
// `jira-harness:<이름>` 이름 해석이 안 되는 세션(플러그인이 세션 시작 뒤에 생긴 경우 등)에서도 scriptPath 폴백이 된다.
const wfDir = join(configRoot, cfg.runtime_dir, 'wf');
const wfSrc = join(PLUGIN_ROOT, 'workflows');
let workflowsCopied = [];
if (existsSync(wfSrc)) {
  mkdirSync(wfDir, { recursive: true });
  for (const f of readdirSync(wfSrc).filter(n => n.endsWith('.js'))) { copyFileSync(join(wfSrc, f), join(wfDir, f)); workflowsCopied.push(f); }
}

const relPath = relative(configRoot, sPath).replace(/\\/g, '/');
const comment = `[jira-harness v3] 이슈 ${keys.join(', ')} 작업을 브랜치 \`${targetBranch}\` 에서 착수합니다.`;
emit({ code, branch: targetBranch, keys: state.keys, subtasks: state.subtasks ?? [], slug, state_path: relPath, created, ...(worktree ? { worktree } : {}), workflows_dir: relative(configRoot, wfDir).replace(/\\/g, '/'), workflows: workflowsCopied, jira: { transition: cfg.jira.start_transition, comment } });
