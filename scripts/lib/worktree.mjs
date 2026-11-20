// worktree.mjs — git 작업트리의 준비(무시 파일 복사·초기화 명령) · 변경 회수(패치) · 안전한 제거. issue-start(--worktree)와 herdr-lanes(구현 레인)가 같이 쓴다.
import { existsSync, mkdirSync, copyFileSync, lstatSync, readdirSync, unlinkSync, rmdirSync, rmSync, readFileSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from './git.mjs';
import { resolveShell } from './shell.mjs';
import { LANE_BRANCH_ROOT, laneName, laneBranchPrefix, laneLedgerFile, lanePatchFile, laneWorktreeRoot } from './lanes.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
// 같은 폴더를 가리키는 다른 표기(Windows 짧은 이름 · 대소문자 · 링크를 거친 경로)를 한 모양으로 — git 이 찍는 경로와 호출자가 준 경로를 비교할 때 쓴다
const real = p => { try { return realpathSync.native(resolve(p)); } catch { return resolve(p); } };
const norm = p => { const s = fwd(real(p)).replace(/\/+$/, ''); return process.platform === 'win32' ? s.toLowerCase() : s; };
export const samePath = (a, b) => !!a && !!b && norm(a) === norm(b);

/** `git worktree list --porcelain` → [{path, branch|null, head|null, main}] — 첫 항목이 메인 체크아웃이다. git 이 실패하면 [] */
export function listWorktrees(repoDir) {
  const r = git(['worktree', 'list', '--porcelain'], { cwd: repoDir, allowFail: true });
  if (r.status !== 0) return [];
  return r.out.split(/\n\s*\n/).map((block, i) => {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) return null;
    return { path: fwd(path.trim()).replace(/\/+$/, ''), branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() ?? null, head: /^HEAD ([0-9a-f]+)/m.exec(block)?.[1] ?? null, main: i === 0 };
  }).filter(Boolean);
}

/** 새 작업트리에 메인 체크아웃의 git 무시 파일을 복사하고(copy) 초기화 명령을 돈다(init — 작업트리 안에서). 실패해도 throw 하지 않고 결과에 남긴다 */
export function prepareWorktree(path, { repoDir, copy = [], init = [], cfg, env, timeoutS = 600 }) {
  const done = { copied: [], skipped: [], init: [] };
  for (const rel of copy) {
    const src = join(repoDir, rel); const dst = join(path, rel);
    if (!existsSync(src)) { done.skipped.push(rel); continue; }
    mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); done.copied.push(rel);
  }
  if (init.length) {
    const shell = resolveShell(cfg ?? {});
    for (const c of init) {
      const r = spawnSync(shell.file, shell.args(c), { cwd: path, env, encoding: 'utf8', timeout: timeoutS * 1000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      done.init.push({ cmd: c, exit: r.status ?? -1, tail: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(-400) });
      if (r.status !== 0) break; // 초기화가 깨졌으면 그 다음은 의미가 없다 — 호출자는 진행하되 결과에 남긴다
    }
  }
  return done;
}

/**
 * 폴더 안의 링크(심볼릭 링크 · Windows junction)를 끊는다. 링크가 가리키는 쪽은 건드리지 않고, 링크 안으로 들어가지도 않는다.
 * 왜: 초기화 명령이 메인 체크아웃의 큰 폴더(의존성 설치본 등)를 링크로 물려 두는데, 지우는 도구와 버전에 따라 그 링크를 따라 들어가
 *     작업트리가 아니라 메인 쪽 내용이 지워진 사고가 있었다. 링크를 남긴 채 `git worktree remove` 를 하면 폴더가 남은 채 성공으로 끝나기도 한다.
 * 반환 { cut[], failed[] } — 경로는 root 기준 상대.
 */
export function unlinkLinks(root) {
  const base = resolve(root);
  const cut = []; const failed = [];
  let top; try { top = lstatSync(base); } catch { return { cut, failed }; }
  if (top.isSymbolicLink()) return { cut, failed: [`${fwd(base)}: 폴더 자체가 링크다`] };
  const walk = (dir) => {
    let names; try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) {
        try { unlinkSync(p); } catch { try { rmdirSync(p); } catch (e) { failed.push(`${fwd(relative(base, p))}: ${e.message}`); continue; } }
        cut.push(fwd(relative(base, p)));
      } else if (st.isDirectory()) walk(p);
    }
  };
  walk(base);
  return { cut, failed };
}

/** 등록되지 않은 잔재 폴더를 지운다 — 링크를 먼저 끊는다. 끊지 못한 링크가 있으면 지우지 않는다 */
export function removeDirSafely(path) {
  if (!existsSync(path)) return { ok: true, unlinked: [] };
  const { cut, failed } = unlinkLinks(path);
  if (failed.length) return { ok: false, unlinked: cut, reason: `링크를 끊지 못해 지우지 않았다 — ${failed[0]}` };
  try { rmSync(path, { recursive: true, force: true }); } catch (e) { return { ok: false, unlinked: cut, reason: e.message }; }
  return { ok: true, unlinked: cut };
}

/**
 * 작업트리를 지운다 — 링크를 먼저 끊고 `git worktree remove`. 브랜치는 지우지 않는다(커밋은 브랜치에 남는다).
 * force 가 아니면 커밋 안 된 변경(추적·비추적)이 있을 때 지우지 않고 그 목록을 돌려준다. 메인 체크아웃·등록되지 않은 경로는 거부한다.
 * git 이 등록은 풀고 폴더를 다 지우지 못한 채 끝나면(성공으로든 실패로든) 남은 폴더를 마저 치운다. git 이 거절해 등록이 남아 있으면 손대지 않는다.
 * 반환 { ok, code?, reason?, unlinked?, dirty? } — code: NOT_A_WORKTREE · MAIN_WORKTREE · DIRTY · UNLINK_FAILED · REMOVE_FAILED
 */
export function removeWorktree(path, { repoDir, force = false } = {}) {
  const abs = fwd(resolve(path));
  const hit = listWorktrees(repoDir).find(w => samePath(w.path, abs));
  if (!hit) return { ok: false, code: 'NOT_A_WORKTREE', reason: `등록된 작업트리가 아니다: ${abs}` };
  if (hit.main) return { ok: false, code: 'MAIN_WORKTREE', reason: `메인 체크아웃은 지우지 않는다: ${abs}` };
  if (!existsSync(abs)) { git(['worktree', 'prune'], { cwd: repoDir, allowFail: true }); return { ok: true, unlinked: [], pruned: true }; }
  if (!force) {
    const st = git(['status', '--porcelain'], { cwd: abs, allowFail: true });
    if (st.status !== 0) return { ok: false, code: 'DIRTY', reason: `변경 여부를 확인하지 못했다(git status 실패) — 확인한 뒤 force 로 지울 것: ${st.err}` };
    const dirty = st.out.split('\n').filter(Boolean);
    if (dirty.length) return { ok: false, code: 'DIRTY', reason: `커밋 안 된 변경 ${dirty.length}건이 있다 — 확인한 뒤 force 로 지울 것`, dirty: dirty.slice(0, 20) };
  }
  const { cut, failed } = unlinkLinks(abs);
  if (failed.length) return { ok: false, code: 'UNLINK_FAILED', reason: `링크를 끊지 못해 지우지 않았다 — ${failed[0]}`, unlinked: cut };
  const rm = git(['worktree', 'remove', '--force', abs], { cwd: repoDir, allowFail: true });
  if (rm.status !== 0) {
    // git 이 거절했으면(잠긴 작업트리 등) 등록이 그대로다 — 손대지 않는다. 목록을 읽지 못했을 때도(빈 목록) 모르는 것이므로 손대지 않는다
    const after = listWorktrees(repoDir);
    if (!after.length || after.some(w => samePath(w.path, abs))) return { ok: false, code: 'REMOVE_FAILED', reason: (rm.err || rm.out || 'git worktree remove 실패').split('\n')[0], unlinked: cut };
  }
  // 등록은 풀렸는데 폴더가 남은 경우 — git 이 성공으로 끝내고도 남기거나(잠긴 파일 등), 검사를 통과한 뒤 다 지우지 못해 실패로 끝낸다
  // (Windows 에서 260자를 넘는 경로는 `Filename too long` — 빌드 산출물이 깊은 작업트리에서 흔하다). 링크는 위에서 끊었으니 남은 폴더만 치운다
  if (existsSync(abs)) {
    const left = removeDirSafely(abs);
    if (!left.ok) return { ok: false, code: 'REMOVE_FAILED', reason: `등록은 풀었지만 폴더가 남았다 — ${left.reason}`, unlinked: cut };
  }
  git(['worktree', 'prune'], { cwd: repoDir, allowFail: true });
  return { ok: true, unlinked: cut };
}

/**
 * 작업트리의 변경(추적·비추적 전부)을 바이너리 패치 글로 뽑는다 — 인덱스는 잠깐 쓰고 되돌린다.
 * 기준은 `git diff <base>` 가 아니라 "지금 트리 vs 그 작업트리의 HEAD" 다(커밋 안 된 것 전부).
 * 반환 { ok: true, text, files[], insertions, deletions } | { ok: false, reason } — 변경이 없으면 text 가 빈 글이다.
 */
export function worktreeChanges(wtPath) {
  const add = git(['add', '-A'], { cwd: wtPath, allowFail: true });
  if (add.status !== 0) return { ok: false, reason: `git add 실패: ${add.err}` };
  const diff = spawnSync('git', ['diff', '--cached', '--binary', '--no-color'], { cwd: wtPath, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  const stat = git(['diff', '--cached', '--numstat'], { cwd: wtPath, allowFail: true });
  git(['reset', '-q'], { cwd: wtPath, allowFail: true });
  if (diff.status !== 0) return { ok: false, reason: `git diff 실패: ${(diff.stderr ?? '').trim()}` };
  const rows = stat.out ? stat.out.split('\n').filter(Boolean).map(l => l.split('\t')) : [];
  return {
    ok: true, text: diff.stdout ?? '', files: rows.map(r => fwd(r[2] ?? '')),
    insertions: rows.reduce((n, r) => n + (Number(r[0]) || 0), 0), deletions: rows.reduce((n, r) => n + (Number(r[1]) || 0), 0),
  };
}

/** 작업트리의 변경을 패치 파일로 남긴다(구현 레인의 회수). 변경이 없으면 파일을 쓰지 않고 empty:true */
export function harvestWorktree(wtPath, patchFile) {
  const c = worktreeChanges(wtPath);
  if (!c.ok) return c;
  if (!c.text.trim()) return { ok: true, empty: true, files: [], insertions: 0, deletions: 0, file: null };
  mkdirSync(dirname(patchFile), { recursive: true });
  writeFileSync(patchFile, c.text, 'utf8');
  return { ok: true, empty: false, files: c.files, insertions: c.insertions, deletions: c.deletions, file: fwd(patchFile) };
}

/**
 * 한 이슈(slug)의 구현 레인이 남긴 작업트리와 레인 브랜치(lane/<slug>/…)를 치운다 — 이슈를 마감할 때 issue-start --remove-worktree 가 부른다.
 *
 * 작업트리를 지우는 기준은 장부의 기록이 아니라 **지금 그 작업트리에 있는 것**이다: 변경이 없거나, 지금 뽑은 패치가 회수해 둔 패치 파일과 글자까지 같을 때만 지운다.
 *   장부의 「적용됨」과 지난 패치 파일은, 그 뒤에 같은 레인을 다시 파서 새로 한 작업을 모른다(실행기가 죽으면 장부는 갱신되지 않는다) —
 *   그것으로 판정하면 어디에도 회수되지 않은 유일한 사본을 지운다.
 * 레인 브랜치는 그 끝 커밋을 lane/ 밖의 브랜치(로컬·원격)가 갖고 있을 때만 지운다 — 레인은 커밋하지 않으므로 보통 이슈 브랜치의 커밋 위에 그대로 서 있다.
 *   레인이 커밋해 버렸으면(규율 위반) 그 작업은 브랜치에만 있으므로 남긴다. 기준을 HEAD 로 잡으면 안 된다: 정리는 메인 체크아웃(기본 브랜치)에서 부르고,
 *   이슈 브랜치가 아직 머지되지 않았으면 레인의 시작점은 거기에 없다.
 * Herdr 워크스페이스로 연 작업트리(workspace 배치)는 손대지 않는다. pane 도 닫지 않는다 — 장부의 pane id 는 Herdr 가 다시 뜨면 남의 pane 일 수 있다.
 * 장부(디스크의 JSON)에 적힌 경로는 지울 곳으로 쓰지 않는다 — 등록된 작업트리는 git 이 알려 준 경로로, 폴더만 남은 자리는 여기서 만든 경로로 지운다(아래).
 * @param worktreeDir 프로젝트가 설정한 herdr.worktree_dir(없으면 null) — 레인 작업트리를 기본 자리가 아닌 곳에 팠을 때 남은 폴더를 거기서도 찾는다
 * 반환 { removed[{path, branch|null, leftover?}], branches[], kept[{path?, branch?, reason, pane?}] }
 */
export function removeLaneLeftovers({ repoDir, rt, slug, worktreeDir = null }) {
  const prefix = laneBranchPrefix(slug);
  let ledger = {};
  try { ledger = JSON.parse(readFileSync(laneLedgerFile(rt, slug), 'utf8'))?.lanes ?? {}; } catch { ledger = {}; }
  const entries = Object.entries(ledger).map(([lane, e]) => ({ ...(e ?? {}), lane })).filter(e => typeof e.branch === 'string' && e.branch.startsWith(prefix));
  const removed = []; const branches = []; const kept = [];

  for (const w of listWorktrees(repoDir).filter(x => !x.main && x.branch?.startsWith(prefix))) {
    const e = entries.find(x => x.branch === w.branch) ?? null;
    const keep = reason => kept.push({ path: w.path, branch: w.branch, reason, ...(e?.pane ? { pane: e.pane } : {}) });
    if (e?.placement === 'workspace') { keep('Herdr 워크스페이스로 연 작업트리다 — herdr worktree remove --workspace <id> 로 닫을 것'); continue; }
    if (existsSync(w.path)) {
      const c = worktreeChanges(w.path);
      if (!c.ok) { keep(`변경을 읽지 못했다 — ${c.reason}`); continue; }
      if (c.text.trim()) {
        const patch = e ? lanePatchFile(rt, slug, e.lane) : null;
        let saved = null;
        if (patch && existsSync(patch)) { try { saved = readFileSync(patch, 'utf8'); } catch { saved = null; } }
        if (saved !== c.text) {
          keep(saved == null
            ? '회수되지 않은 변경이 있다 — herdr-lanes.mjs implement --harvest 로 회수하거나, 확인한 뒤 --remove-worktree <경로> --force'
            : '회수해 둔 패치와 지금 내용이 다르다(회수 뒤에 더 고쳤다) — herdr-lanes.mjs implement --harvest 로 다시 회수하거나, 확인한 뒤 --remove-worktree <경로> --force');
          continue;
        }
      }
    }
    const r = removeWorktree(w.path, { repoDir, force: true });
    if (!r.ok) { keep(r.reason); continue; }
    removed.push({ path: w.path, branch: w.branch, ...(r.unlinked?.length ? { unlinked: r.unlinked } : {}) });
  }

  // 등록은 풀렸는데 폴더만 남은 자리 — pane 이 그 폴더에 서 있는 채로 지우면 파일과 등록만 지워지고 폴더가 남는다(pane 을 닫고 다시 부르면 여기서 치운다).
  // 지울 경로는 장부에서 받지 않고 여기서 만든다: 실행기가 레인 작업트리를 파는 자리(기본 <rt>/herdr/worktrees/<slug> · 설정한 herdr.worktree_dir) 바로 아래의
  // <laneName(레인)> 폴더이고, 장부가 적어 둔 경로가 그 폴더와 같을 때만 지운다. 장부의 경로를 그대로 지우면 장부가 틀렸을 때(손상 · 옛 설정 · 누가 고쳐 쓴 값)
  // 레인과 무관한 폴더가 통째로 지워진다. 레인 폴더의 부모는 쓸지 않는다(worktree_dir 을 설정하면 여러 이슈가 한 부모를 쓴다).
  // 체크아웃(.git)이 든 폴더는 손대지 않고, 폴더 자체가 링크면 지우지 않고 사유를 남긴다(removeDirSafely).
  const roots = [laneWorktreeRoot(rt, slug), ...(worktreeDir ? [resolve(repoDir, worktreeDir)] : [])];
  const registered = listWorktrees(repoDir);
  for (const e of entries) {
    if (e.placement === 'workspace' || typeof e.path !== 'string' || !e.path) continue;
    const dir = roots.map(r => join(r, laneName(e.lane))).find(d => samePath(d, e.path));
    if (!dir || !existsSync(dir)) continue;
    if (registered.some(w => samePath(w.path, dir)) || existsSync(join(dir, '.git'))) continue;
    const left = removeDirSafely(dir);
    if (left.ok) removed.push({ path: fwd(dir), branch: null, leftover: true });
    else kept.push({ path: fwd(dir), reason: `남은 폴더를 지우지 못했다 — ${left.reason}`, ...(e.pane ? { pane: e.pane } : {}) });
  }

  const checkedOut = new Set(registered.map(w => w.branch).filter(Boolean));
  const refs = git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`], { cwd: repoDir, allowFail: true });
  for (const b of (refs.status === 0 ? refs.out.split('\n').map(s => s.trim()).filter(Boolean) : [])) {
    if (checkedOut.has(b)) continue; // 작업트리가 남아 있다 — 사유는 위에서 남겼다
    const holders = git(['for-each-ref', '--format=%(refname)', '--contains', `refs/heads/${b}`, 'refs/heads', 'refs/remotes'], { cwd: repoDir, allowFail: true });
    const held = holders.status === 0 && holders.out.split('\n').map(s => s.trim()).filter(Boolean).some(r => !r.startsWith(`refs/heads/${LANE_BRANCH_ROOT}`));
    if (!held) { kept.push({ branch: b, reason: '레인 브랜치에만 있는 커밋이 있다(레인이 커밋했다) — 내용을 확인한 뒤 git branch -D 로 지울 것' }); continue; }
    const d = git(['branch', '-D', b], { cwd: repoDir, allowFail: true });
    if (d.status === 0) branches.push(b);
    else kept.push({ branch: b, reason: (d.err || d.out || 'git branch -D 실패').split('\n')[0] });
  }
  return { removed, branches, kept };
}

/**
 * 저장소 안의 경로가 git 에 무시되게 한다 — 이미 무시되면 그대로, 아니면 이 저장소의 로컬 제외 목록(<git-common-dir>/info/exclude)에 한 줄 더한다.
 * 커밋되는 .gitignore 는 건드리지 않는다. 작업트리 폴더가 메인 체크아웃의 비추적 파일로 잡혀 게이트의 트리 지문을 흔드는 것을 막는다.
 * 반환 'ignored'(이미) · 'added' · 'outside'(저장소 밖 경로 — 할 일 없음) · 'failed'
 */
export function ensureLocallyIgnored(repoDir, dir) {
  const rel = fwd(relative(resolve(repoDir), resolve(dir)));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return 'outside';
  const chk = git(['check-ignore', '-q', `${rel}/probe`], { cwd: repoDir, allowFail: true });
  if (chk.status === 0) return 'ignored';
  const common = git(['rev-parse', '--git-common-dir'], { cwd: repoDir, allowFail: true });
  if (common.status !== 0 || !common.out) return 'failed';
  const file = join(resolve(repoDir, common.out.trim()), 'info', 'exclude');
  try {
    const line = `/${rel}/`;
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes(line)) { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`, 'utf8'); }
    return 'added';
  } catch { return 'failed'; }
}
