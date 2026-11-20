// git.mjs — git 호출 래퍼(UTF-8 고정, 실패 시 예외 대신 결과 객체).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';

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

/**
 * 경로 목록을 내는 git 명령(diff · diff-tree · ls-files)을 `-z`(NUL 구분)로 돌려 경로 배열로 받는다. args[0] 이 하위 명령이다.
 * 줄 단위로 받으면 git 이 ASCII 밖 글자가 든 경로(한글 파일 이름 등)를 따옴표로 감싸고 8진수로 바꿔 낸다(core.quotepath 기본값). 그 꼴은
 * 스택 paths · docs_only_paths · lint 대상 glob 어디에도 걸리지 않는다 — 그 파일만 고친 변경이 「어느 스택도 아닌 코드 변경」이 되어
 * 컴파일·lint 없이 게이트를 지나고, 문서인데도 docs-only 로 읽히지 않는다.
 */
export function gitPaths(args, opts) {
  const { out } = git([args[0], '-z', ...args.slice(1)], opts);
  return out ? out.split('\0').filter(Boolean) : [];
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

/**
 * repoRoots 와 같은 답을 git 을 띄우지 않고 낸다 — 훅처럼 명령마다 도는 자리에서 git 을 두 번 띄우는 비용(Windows 에서 0.2~0.5초)을 피하려는 것이다.
 * 확실할 때만 답한다. 가장 가까운 `.git` 이
 *   - 디렉토리(HEAD 가 있다)이고 그 위에 `.git` 이 더 없을 때 — git 은 저장소가 아닌 `.git` 디렉토리(HEAD 만 있는 가짜 포함)를 건너뛰고 위의
 *     저장소를 쓴다(실측). 진짜인지는 git 만 가리므로, 건너뛰면 닿을 `.git` 이 위에 있으면 답하지 않는다. 위에 없으면 git 은 저장소를 찾지 못해
 *     그 git 명령이 실패하니 어느 답이든 판정할 일이 없다
 *   - 작업트리 파일(`gitdir: …/.git/worktrees/<이름>`)이고 그 git 디렉토리의 `commondir` 가 `git worktree add` 가 쓰는 값(`../..`)일 때 —
 *     작업트리가 쓰는 저장소는 `.git` 파일의 경로가 아니라 `commondir` 가 정한다. 깨진 `.git` 파일에서는 git 이 위로 올라가지 않고 실패한다(실측)
 * 경로는 주어진 철자 그대로다(git 처럼 정규화하지 않는다) — 파일을 읽고 쓰는 데만 쓰고 경로 문자열끼리 견주는 데는 쓰지 않는다.
 * 보지 않는 것: 저장소 설정의 core.worktree · GIT_COMMON_DIR 환경변수.
 * @returns {{toplevel:string, mainRoot:string, isWorktree:boolean, gitDir:string}|null|undefined}
 *   null = 저장소 밖 · undefined = 모른다(위 두 경우가 아닌 모든 것 — 서브모듈 · 따로 둔 git 디렉토리 · 빈 `.git` · 겹친 저장소 ·
 *   표준이 아닌 commondir · GIT_DIR 환경변수 · 읽기 오류) — 호출자가 repoRoots 로 묻는다
 */
export function quickRoots(cwd) {
  try {
    if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || !existsSync(cwd)) return undefined;
    const norm = p => p.replace(/\\/g, '/');
    for (let d = resolve(cwd); ; ) {
      const dot = join(d, '.git');
      if (existsSync(dot)) {
        if (statSync(dot).isDirectory()) {
          if (!existsSync(join(dot, 'HEAD'))) return undefined; // 저장소가 아닌 `.git` — git 은 건너뛰고 위로 올라간다
          if (dotGitAbove(d)) return undefined;                 // HEAD 만 있는 가짜일 수 있다 — 그러면 git 은 위의 저장소를 쓴다
          return { toplevel: norm(d), mainRoot: norm(d), isWorktree: false, gitDir: norm(dot) };
        }
        const m = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]([^\\/]+)$/.exec(readFileSync(dot, 'utf8').trim());
        if (!m) return undefined;
        const main = isAbsolute(m[1]) ? m[1] : resolve(d, m[1]);
        const gitDir = join(main, '.git', 'worktrees', m[2]);
        if (readFileSync(join(gitDir, 'commondir'), 'utf8').trim() !== '../..') return undefined; // 공용 디렉토리가 <본 저장소>/.git 이 아닐 수 있다
        return { toplevel: norm(d), mainRoot: norm(main), isWorktree: true, gitDir: norm(gitDir) };
      }
      const up = dirname(d);
      if (up === d) return null;
      d = up;
    }
  } catch { return undefined; }
}

/** d 보다 위 폴더에 `.git`(디렉토리든 파일이든)이 있는가 */
function dotGitAbove(d) {
  for (let cur = d; ; ) {
    const up = dirname(cur);
    if (up === cur) return false;
    if (existsSync(join(up, '.git'))) return true;
    cur = up;
  }
}

/** quickRoots 가 찾은 git 디렉토리의 HEAD 로 지금 브랜치를 읽는다 — 브랜치 이름 · 분리면 null · 못 읽으면 undefined */
export function quickBranch(gitDir) {
  try {
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(readFileSync(join(gitDir, 'HEAD'), 'utf8').trim());
    return m ? m[1] : null;
  } catch { return undefined; }
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
  return gitPaths(['diff-tree', '-r', '--name-only', '--no-commit-id', a, b], { cwd });
}

// 경로 목록은 이름 바꾸기를 옛 경로·새 경로 둘 다로 센다(--no-renames) — `git diff` 는 diff.renames 기본값으로 새 경로만 보여 줘서
// `git mv src/A.java docs/A.md` 가 docs-only 로 읽혀 게이트 없이 통과했다(2026-10-12 재현). diff-tree(changedBetweenTrees)는 원래 둘 다 본다.
export function stagedFiles(cwd) { return gitPaths(['diff', '--cached', '--name-only', '--no-renames'], { cwd }); }
export function unstagedFiles(cwd) { return gitPaths(['diff', '--name-only', '--no-renames'], { cwd }); }
export function untrackedFiles(cwd) { return gitPaths(['ls-files', '--others', '--exclude-standard'], { cwd }); }
export function changedVsHead(cwd) { return gitPaths(['diff', '--name-only', '--no-renames', 'HEAD'], { cwd, allowFail: true }); }

/** 이 브랜치가 default_branch 에서 갈라진 뒤 커밋으로 바꾼 경로. merge-base 를 못 구하면 null */
export function branchChangedFiles(cwd, defaultBranch) {
  const mb = git(['merge-base', 'HEAD', defaultBranch], { cwd, allowFail: true });
  if (mb.status !== 0) return null;
  return gitPaths(['diff', '--name-only', '--no-renames', `${mb.out}..HEAD`], { cwd, allowFail: true });
}

/** push 대상 커밋들이 바꾼 경로(upstream 없으면 default_branch 와의 merge-base 기준). 판정 불가면 null */
export function pushChangedFiles(cwd, defaultBranch) {
  const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd, allowFail: true });
  let base = up.status === 0 ? up.out : null;
  if (!base) {
    const mb = git(['merge-base', 'HEAD', defaultBranch], { cwd, allowFail: true });
    if (mb.status !== 0) return null;
    base = mb.out;
  }
  return gitPaths(['diff', '--name-only', '--no-renames', `${base}..HEAD`], { cwd, allowFail: true });
}

export function pinRef(name, objectId, cwd) {
  git(['update-ref', name, objectId], { cwd });
}
