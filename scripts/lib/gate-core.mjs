// gate-core.mjs — 커밋·push 판정 로직(훅과 테스트가 공유). 설계 문서 §3.5 판정 순서.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { locateProject, loadConfig, parseBranch, branchSlug, statePath, readState, latestArchivedState, allDocsOnly, matchesAny } from './config.mjs';
import { currentBranch, stagedFiles, unstagedFiles, untrackedFiles, changedBetweenTrees, pushChangedFiles } from './git.mjs';
import { fingerprintTree } from './tree.mjs';

const OK = new Set(['PASS', 'SKIPPED']);

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
  const idx = command.search(/git\s+(?:(?:-C\s+\S+|-c\s+\S+|--git-dir=\S+|--work-tree=\S+|--no-pager)\s+)*commit\b/);
  if (idx < 0) return false;
  if (/git\s+add\b/.test(command.slice(0, idx))) return true;
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
 * @param opts.command 훅이 받은 Bash 명령 전문(스테이징 여부 판단용) — 없으면 인덱스만 본다
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

  // docs-only 는 어느 브랜치든 통과 (main 위 docs 커밋 포함). `git add … && git commit` 처럼 한 명령이 스테이징까지 하면
  // 인덱스 대신 스테이징 예정 파일로 본다 — 종전엔 빈 인덱스로 판정해 closure docs 커밋이 NO_STATE 로 막혔다.
  const files = op === 'commit' ? commitCandidates(root, opts.command) : pushChangedFiles(root, cfg.default_branch);
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

  const tree = fingerprintTree({ cwd: root, base: op === 'commit' ? 'index' : 'HEAD', excludes: cfg.fingerprint_exclude });

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

/** Bash 명령 문자열에서 git commit/push 를 찾는다. 없으면 null. */
export function detectGitOp(command) {
  if (!command) return null;
  const re = /(?:^|[;&|(]\s*|\n\s*)git\s+(?:(?:-C\s+\S+|-c\s+\S+|--git-dir=\S+|--work-tree=\S+|--no-pager)\s+)*(commit|push)\b/m;
  const m = re.exec(command);
  return m ? m[1] : null;
}

/** 명령 안의 `cd <dir> &&` 또는 `git -C <dir>` 로 실행 디렉토리를 추정한다 */
export function effectiveCwd(command, cwd) {
  const c = /-C\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  if (c) return join(cwd, (c[2] ?? c[3] ?? c[4]));
  const d = /(?:^|[;&|]\s*)cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/.exec(command);
  if (d) return join(cwd, (d[2] ?? d[3] ?? d[4]));
  return cwd;
}
