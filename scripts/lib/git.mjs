// git.mjs — git 호출 래퍼(UTF-8 고정, 실패 시 예외 대신 결과 객체).
import { spawnSync } from 'node:child_process';

export function git(args, { cwd, allowFail = false, env, input } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env, input });
  const out = (r.stdout ?? '').replace(/\r\n/g, '\n').trimEnd();
  if (r.status !== 0 && !allowFail) {
    const err = new Error(`git ${args.join(' ')} 실패(exit ${r.status}): ${(r.stderr ?? '').trim()}`);
    err.status = r.status;
    throw err;
  }
  return { status: r.status ?? -1, out, err: (r.stderr ?? '').trim() };
}

export function gitLines(args, opts) {
  const { out } = git(args, opts);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** 프로젝트 루트(작업트리 최상위)와 메인 저장소 루트(worktree 면 다르다) */
export function repoRoots(cwd) {
  const top = git(['rev-parse', '--show-toplevel'], { cwd, allowFail: true });
  if (top.status !== 0) return null;
  const toplevel = top.out.replace(/\\/g, '/');
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, allowFail: true });
  let mainRoot = toplevel;
  if (common.status === 0 && common.out) {
    const commonDir = common.out.replace(/\\/g, '/').replace(/\/$/, '');
    if (commonDir.endsWith('/.git')) mainRoot = commonDir.slice(0, -'/.git'.length);
  }
  return { toplevel, mainRoot, isWorktree: mainRoot !== toplevel };
}

export function currentBranch(cwd) {
  const r = git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd, allowFail: true });
  return r.status === 0 ? r.out : null; // detached → null
}

export function headTree(cwd) {
  const r = git(['rev-parse', '--verify', '-q', 'HEAD^{tree}'], { cwd, allowFail: true });
  return r.status === 0 ? r.out : null;
}

/** 두 트리 사이에서 바뀐 경로 목록 */
export function changedBetweenTrees(a, b, cwd) {
  if (a === b) return [];
  return gitLines(['diff-tree', '-r', '--name-only', '--no-commit-id', a, b], { cwd });
}

export function stagedFiles(cwd) { return gitLines(['diff', '--cached', '--name-only'], { cwd }); }
export function unstagedFiles(cwd) { return gitLines(['diff', '--name-only'], { cwd }); }
export function untrackedFiles(cwd) { return gitLines(['ls-files', '--others', '--exclude-standard'], { cwd }); }
export function changedVsHead(cwd) { return gitLines(['diff', '--name-only', 'HEAD'], { cwd, allowFail: true }); }

/** push 대상 커밋들이 바꾼 경로(upstream 없으면 default_branch 와의 merge-base 기준). 판정 불가면 null */
export function pushChangedFiles(cwd, defaultBranch) {
  const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd, allowFail: true });
  let base = up.status === 0 ? up.out : null;
  if (!base) {
    const mb = git(['merge-base', 'HEAD', defaultBranch], { cwd, allowFail: true });
    if (mb.status !== 0) return null;
    base = mb.out;
  }
  return gitLines(['diff', '--name-only', `${base}..HEAD`], { cwd, allowFail: true });
}

export function pinRef(name, objectId, cwd) {
  git(['update-ref', name, objectId], { cwd });
}
