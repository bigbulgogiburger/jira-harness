// gate-core.mjs — 커밋·push 판정 로직(훅과 테스트가 공유). 설계 문서 §3.5 판정 순서.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { locateProject, loadConfig, parseBranch, branchSlug, statePath, readState, latestArchivedState, allDocsOnly, matchesAny } from './config.mjs';
import { currentBranch, stagedFiles, unstagedFiles, untrackedFiles, changedBetweenTrees, pushChangedFiles } from './git.mjs';
import { fingerprintTree } from './tree.mjs';

const OK = new Set(['PASS', 'SKIPPED']);

/** 훅이 판정하는 셸 툴. hooks/hooks.json 의 matcher 와 항상 같은 집합이어야 한다(gate.test 가 대조) — 한쪽만 보면 다른 쪽 셸로 커밋할 때 게이트가 아예 안 돈다. */
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** 기록 트리가 현재 트리를 대변하는가 — 같거나, 그 사이 바뀐 것이 docs_only 뿐이면 */
export function treeAccepted(recordTree, tree, cfg, cwd) {
  if (!recordTree) return { ok: false, changed: null };
  if (recordTree === tree) return { ok: true, changed: [] };
  let changed;
  try { changed = changedBetweenTrees(recordTree, tree, cwd); } catch { return { ok: false, changed: null }; }
  if (changed.length === 0) return { ok: true, changed };
  return { ok: allDocsOnly(changed, cfg), changed };
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 커밋 명령이 같은 명령 안에서 스테이징까지 하는가 — `git add …` 가 commit 앞에 있거나, commit 에 -a/--all(-am 등) 이 붙었을 때.
 * 훅은 명령이 실행되기 *전*에 판정하므로 이런 명령에서는 인덱스가 아직 비어 있다.
 */
export function stagesInCommand(command) {
  if (!command) return false;
  const idx = command.search(/git(?:\.exe)?\s+(?:(?:-C\s+\S+|-c\s+\S+|--git-dir=\S+|--work-tree=\S+|--no-pager)\s+)*commit\b/);
  if (idx < 0) return false;
  if (/git(?:\.exe)?\s+add\b/.test(command.slice(0, idx))) return true;
  const seg = command.slice(idx).split(/\n|&&|\|\||;|\|/)[0];
  return /\s--all\b/.test(seg) || /\s-[a-z]*a[a-z]*\b/.test(seg);
}

/** 커밋에 들어갈 파일 — 보통은 인덱스, 명령이 스테이징까지 하면 스테이징 *예정* 파일(staged ∪ unstaged ∪ untracked) */
function commitCandidates(root, command) {
  const staged = stagedFiles(root);
  if (!stagesInCommand(command)) return staged;
  return [...new Set([...staged, ...unstagedFiles(root), ...untrackedFiles(root)])];
}

/**
 * @param op 'commit' | 'push'
 * @param opts.command 훅이 받은 셸 명령 전문(스테이징 여부 판단용) — 없으면 인덱스만 본다
 * @param opts.afterCommit push 전용 — 같은 명령의 commit 이 아직 HEAD 에 없다(`git commit … && git push`).
 *        push 될 파일·트리를 HEAD 가 아니라 (이미 쌓인 커밋 + 이 명령이 만들 커밋 = 인덱스) 로 본다. 이걸 안 하면 커밋 전엔 HEAD==upstream 이라 NOTHING_TO_PUSH 로 통과한다.
 *        전제는 "커밋 뒤 HEAD 트리 == 지금 인덱스 트리"다. 훅은 실행 전에 판정하므로 이 전제가 깨지는 흐름은 미리 알 수 없다 —
 *        pathspec 커밋(`git commit -m x path`)·pre-commit 훅이 인덱스를 고침·commit 과 push 사이의 pull/rebase·`;`/`||` 로 이어 commit 이 실패해도 도는 push.
 *        그런 저장소·흐름에서는 commit 과 push 를 따로 실행할 것(수정 전에는 이런 복합 명령의 push 를 아예 판정하지 않았다).
 * @returns {{decision:'pass'|'deny'|'warn', reason:string, code:string}}
 */
export function decide(op, cwd, opts = {}) {
  const proj = locateProject(cwd);
  if (!proj || !proj.configPath) return { decision: 'pass', code: 'NO_HARNESS', reason: '하네스 미설치 프로젝트' };
  let cfg;
  try { cfg = loadConfig(proj.configPath); } catch (e) { return { decision: 'deny', code: 'BAD_CONFIG', reason: `harness.json 이 유효하지 않다: ${e.message}` }; }
  if (cfg.mode === 'off') return { decision: 'pass', code: 'MODE_OFF', reason: 'mode=off' };
  const soft = cfg.mode === 'suggest';
  const deny = (code, reason) => ({ decision: soft ? 'warn' : 'deny', code, reason });
  const root = proj.toplevel;
  const afterCommit = op === 'push' && !!opts.afterCommit;

  // docs-only 는 어느 브랜치든 통과 (main 위 docs 커밋 포함). `git add … && git commit` 처럼 한 명령이 스테이징까지 하면
  // 인덱스 대신 스테이징 예정 파일로 본다 — 종전엔 빈 인덱스로 판정해 closure docs 커밋이 NO_STATE 로 막혔다.
  let files;
  if (op === 'commit') files = commitCandidates(root, opts.command);
  else {
    files = pushChangedFiles(root, cfg.default_branch);
    // `git commit … && git push` — 이 명령의 커밋은 아직 HEAD 에 없다. push 될 파일 = 이미 쌓인 커밋 + 이 명령이 만들 커밋
    if (afterCommit && files) files = [...new Set([...files, ...commitCandidates(root, opts.command)])];
  }
  if (files && allDocsOnly(files, cfg)) return { decision: 'pass', code: 'DOCS_ONLY', reason: `docs-only ${files.length}개` };
  if (op === 'push' && files && files.length === 0) return { decision: 'pass', code: 'NOTHING_TO_PUSH', reason: 'push 할 커밋 없음' };

  const branch = currentBranch(root);
  // default_branch 는 정책이 allow 면 판정하지 않는다 — 이슈 브랜치를 머지하고 main 을 올리는 1인 저장소 흐름.
  // 기본은 deny 라 켜지 않은 프로젝트의 동작은 그대로다(이슈 브랜치 강제).
  if (cfg.default_branch_policy === 'allow' && branch && branch === cfg.default_branch) {
    return { decision: 'pass', code: 'DEFAULT_BRANCH_ALLOWED', reason: `${branch} 는 default_branch_policy=allow` };
  }
  let parsed = parseBranch(branch, cfg);
  if (!parsed && branch && existsSync(statePath(cfg, proj.configRoot, branchSlug(branch)))) {
    // issue-start --adopt 로 채택한 브랜치: 패턴 밖이어도 상태 JSON 이 있으면 그 기록을 따른다(키는 상태 JSON 이 안다)
    parsed = { branch, keys: [], slug: branchSlug(branch) };
  }
  if (!parsed) return deny('BRANCH_PATTERN', `브랜치 "${branch ?? '(detached)'}" 가 branch_pattern 밖이다 — 이슈 브랜치에서 작업하거나 /jira-harness:issue <KEY> --adopt 로 채택할 것`);

  const sPath = statePath(cfg, proj.configRoot, parsed.slug);
  let state;
  try { state = readState(sPath); } catch (e) { return deny('BAD_STATE', `상태 JSON 이 유효하지 않다(${sPath}): ${e.message}`); }
  if (!state) {
    // complete 가 상태를 아카이브한 브랜치 — 사다리(게이트·리뷰)가 닫혔다. closure 문서는 위 docs-only 로 이미 통과했으니 여기 오면 코드 변경이다.
    const archived = latestArchivedState(cfg, proj.configRoot, parsed.slug);
    if (archived) return deny('COMPLETED', `이슈가 complete 로 아카이브됐다(${archived}) — 코드를 더 바꾸려면 issue-start.mjs ${parsed.keys.join(',') || '<KEY>'} --adopt 로 다시 시작할 것(closure 문서만이면 docs-only 로 통과한다)`);
    return deny('NO_STATE', `이슈가 시작되지 않았다(${parsed.keys.join(',')}) — /jira-harness:issue ${parsed.keys[0]} 로 시작할 것`);
  }

  if (op === 'commit') {
    const ex = cfg.fingerprint_exclude;
    const dirty = unstagedFiles(root).filter(p => !matchesAny(p, ex));
    const untracked = untrackedFiles(root).filter(p => !matchesAny(p, ex));
    if (dirty.length || untracked.length) {
      const sample = [...dirty, ...untracked].slice(0, 5).join(', ');
      return deny('DIRTY_TREE', `게이트가 본 트리와 커밋될 트리가 다르다 — unstaged ${dirty.length}개 · untracked ${untracked.length}개 (${sample}). 전부 add 하거나(gate --stage-all) stash 할 것`);
    }
  }

  const tree = fingerprintTree({ cwd: root, base: op === 'commit' || afterCommit ? 'index' : 'HEAD', excludes: cfg.fingerprint_exclude });

  // 게이트 기록
  const g = state.gate;
  const need = op === 'commit' ? 'gate.mjs --commit' : 'gate.mjs --full';
  if (!g) return deny('NO_GATE', `게이트 기록 없음 — ${need} 를 먼저 실행할 것`);
  if (op === 'push' && g.level !== 'full') return deny('GATE_LEVEL', `push 는 전량 게이트가 필요하다(기록은 ${g.level}) — gate.mjs --full`);
  const gt = treeAccepted(g.tree, tree, cfg, root);
  if (!gt.ok) return deny('GATE_STALE', `게이트 기록 이후 코드가 바뀌었다(${gt.changed ? gt.changed.slice(0, 5).join(', ') : '트리 비교 불가'}) — ${need} 재실행`);
  const r = g.results ?? {};
  const mustCommit = ['compile', 'lint', 'dod'];
  const mustPush = ['build', 'test', 'extra'];
  const bad = (op === 'commit' ? mustCommit : [...mustCommit, ...mustPush]).filter(k => !OK.has(r[k] ?? 'NOT_RUN'));
  if (bad.length) return deny('GATE_FAIL', `게이트 결과 미통과: ${bad.map(k => `${k}=${r[k] ?? 'NOT_RUN'}`).join(' · ')} — ${need}`);
  if (g.log) {
    const logFile = join(proj.configRoot, g.log);
    if (!existsSync(logFile)) return deny('GATE_LOG_MISSING', `게이트 로그가 없다(${g.log}) — ${need} 재실행`);
    if (g.log_sha256 && sha256File(logFile) !== g.log_sha256) return deny('GATE_LOG_MISMATCH', `게이트 로그 해시가 기록과 다르다(${g.log}) — ${need} 재실행`);
  }

  // 리뷰 기록
  const rv = state.review;
  if (!rv) return deny('NO_REVIEW', '리뷰 기록 없음 — 리뷰 사다리(codex-review.sh → verify) 를 실행할 것');
  const rt = treeAccepted(rv.tree, tree, cfg, root);
  if (!rt.ok) return deny('REVIEW_STALE', `리뷰 이후 바뀐 파일이 있다(${rt.changed ? rt.changed.slice(0, 5).join(', ') : '트리 비교 불가'}) — 델타 리뷰(verify --delta) 필요`);
  if ((rv.blockers_open ?? 0) > 0) return deny('REVIEW_BLOCKERS', `리뷰 blocker ${rv.blockers_open}건 미해소`);

  return { decision: 'pass', code: 'OK', reason: `gate ${g.level}@${g.at} · review r${rv.round ?? '?'}@${rv.at}` };
}

// Bash 와 PowerShell 둘 다 본다 — PowerShell 의 `& git …`(호출 연산자)·`git.exe`·`if ($?) { git push }` 스크립트블록도 같은 op 다.
// ⚠ 따옴표·heredoc 안은 가리지 않는다 — 커밋 메시지·echo 문자열 안에서 줄 첫머리나 `;`·`&`·`|`·`(`·`{` 바로 뒤에 `git push` 가 오면 push 로 오탐한다(판정이 늘어 더 엄격해지는 쪽).
// ⚠ 문장 첫머리가 아닌 자리(`then git push`·`env X=1 git push`·`xargs git push` 같은 래퍼·키워드 뒤)는 못 잡는다 — 이 변경 전부터의 한계.
const GIT_OP_RE = /(?:^|[;&|({]\s*|\n\s*)git(?:\.exe)?\s+(?:(?:-C\s+\S+|-c\s+\S+|--git-dir=\S+|--work-tree=\S+|--no-pager)\s+)*(commit|push)\b/gm;

/** command[0, idx) 끝에서 따옴표(' 또는 ")가 열려 있는가 — 여닫이 개수만 센다(이스케이프·here-string 은 안 본다). */
function insideQuotes(command, idx) {
  let single = false, double = false;
  for (let i = 0; i < idx; i++) {
    const c = command[i];
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
  }
  return single || double;
}

/**
 * 셸 명령 안의 모든 git commit/push 를 등장 순서로 돌려준다. `git commit … && git push` 는 둘 다 판정해야 한다 —
 * 첫 op 만 보면 push 의 전량 게이트가 통째로 빠진다(이 PC 실사용에서 commit 명령의 22%가 이 복합 꼴).
 * push 앞에 (따옴표 밖의) commit 이 있으면 그 push 는 afterCommit: 커밋이 아직 HEAD 에 없으니 push 판정은 커밋 뒤 인덱스 트리 기준이어야 한다.
 * 같은 (op, afterCommit) 는 한 번만 담는다.
 * @returns {{op:'commit'|'push', afterCommit:boolean}[]}
 */
export function detectGitOps(command) {
  const jobs = [];
  if (!command) return jobs;
  let sawCommit = false;
  for (const m of command.matchAll(GIT_OP_RE)) {
    const op = m[1];
    const afterCommit = op === 'push' && sawCommit;
    // 따옴표 안의 `git commit`(`echo '{git commit}'`·메시지 본문)도 판정 대상에는 넣지만 sawCommit 은 켜지 않는다 —
    // 켜면 뒤의 진짜 push 가 HEAD 가 아니라 인덱스 기준으로 느슨하게 통과한다. 여닫이 개수 휴리스틱이 틀려도 결과는 커밋 전 HEAD 기준(= 수정 전 동작)일 뿐이다.
    if (op === 'commit' && !insideQuotes(command, m.index)) sawCommit = true;
    if (!jobs.some(j => j.op === op && j.afterCommit === afterCommit)) jobs.push({ op, afterCommit });
  }
  return jobs;
}

/** 셸 명령 문자열에서 첫 git commit/push 를 찾는다. 없으면 null. */
export function detectGitOp(command) {
  return detectGitOps(command)[0]?.op ?? null;
}

/** 명령 안의 `cd <dir> &&` 또는 `git -C <dir>` 로 실행 디렉토리를 추정한다 */
export function effectiveCwd(command, cwd) {
  // -C 는 git 자신의 것만 — "grep -C 2 … ; git commit" 의 -C 를 디렉토리로 읽으면 없는 경로가 되어 NO_HARNESS 로 통과해 버린다
  const c = /\bgit(?:\.exe)?\s+(?:(?:-c\s+\S+|--no-pager|--git-dir=\S+|--work-tree=\S+)\s+)*-C\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  if (c) return resolveDir(cwd, (c[2] ?? c[3] ?? c[4]));
  // cd 는 줄바꿈 뒤(heredoc 다음 줄)와 "cd X<줄바꿈>" 꼴도 첫머리로 친다 — 놓치면 세션 cwd 의 *다른 저장소* 를 판정한다
  const d = /(?:^|[;&|\n]\s*)cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;|\n|$)/.exec(command);
  if (d) return resolveDir(cwd, (d[2] ?? d[3] ?? d[4]));
  return cwd;
}

/** cd/-C 대상 — 절대 경로는 그대로, ~ 는 홈, Git Bash 의 /d/… 는 Windows 에서 D:/… 로. (join 은 절대 경로를 cwd 뒤에 이어 붙여 없는 경로를 만들었다) */
function resolveDir(cwd, dir) {
  if (dir === '~' || dir.startsWith('~/')) dir = homedir() + dir.slice(1);
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(dir);
  if (process.platform === 'win32' && m) dir = m[1].toUpperCase() + ':/' + m[2];
  return pathResolve(cwd, dir);
}
