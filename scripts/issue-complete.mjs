#!/usr/bin/env node
// issue-complete.mjs — 이슈 마감. 훅과 **같은 판정**(lib/gate-core)으로 전량 게이트·리뷰 신선도·작업트리 clean 을 다시 보고,
// 통과할 때만 push → 상태 JSON 아카이브 → Jira 전이·마감 댓글 본문을 돌려준다.
//   ⚠ 이 스크립트는 Jira 를 부르지 않는다. MCP 콜은 라우터(skills/issue)가 출력의 jira.{transition,comment} 로 한다.
//   ⚠ main 머지는 하지 않는다 — 자동 머지 금지(사람이 한다).
//
// 사용: node scripts/issue-complete.mjs [--dry-run] [--no-push] [--cwd <dir>] [--json]
// 종료 코드: 0 통과(또는 dry-run) · 1 거부·push 실패 · 2 하네스 미설치/설정 오류
// 거부는 stderr 한 줄로 사유 코드를 준다: `[jira-harness] complete: <CODE> — <사유>`
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { locateProject, loadConfig, parseBranch, branchSlug, statePath, readState, writeState, matchesAny } from './lib/config.mjs';
import { currentBranch, git, stagedFiles, unstagedFiles, untrackedFiles } from './lib/git.mjs';
import { fingerprintTree } from './lib/tree.mjs';
import { treeAccepted, sha256File } from './lib/gate-core.mjs';

// ---------- 인자 ----------
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const asJson = flag('--json');
const dryRun = flag('--dry-run');
const noPush = flag('--no-push');
const cwd = resolve(opt('--cwd') ?? process.cwd());

const OK_RESULT = new Set(['PASS', 'SKIPPED']);
const GATE_KEYS = ['compile', 'lint', 'build', 'test', 'extra', 'dod'];

function nowIso() { return new Date().toISOString(); }
function fwd(p) { return p.replace(/\\/g, '/'); }
function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function countLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** 거부·오류 종료 — 라우터가 stderr 한 줄로 SKILL.md §3 표에 대응한다 */
function reject(code, reason, extra = {}, exitCode = 1) {
  console.error(`[jira-harness] complete: ${code} — ${reason}`);
  if (asJson) console.log(JSON.stringify({ code, reason, ...extra }));
  process.exit(exitCode);
}

// ---------- 프로젝트·설정 ----------
const proj = locateProject(cwd);
if (!proj || !proj.configPath) reject('NO_HARNESS', '하네스 미설치 프로젝트 — /jira-harness:setup 으로 설치할 것', {}, 2);
let cfg;
try { cfg = loadConfig(proj.configPath); } catch (e) { reject('BAD_CONFIG', `harness.json 이 유효하지 않다: ${e.message}`, {}, 2); }
const root = proj.toplevel;
const configRoot = proj.configRoot;

// ---------- 브랜치·상태 ----------
const branch = currentBranch(root);
let parsed = parseBranch(branch, cfg);
if (!parsed && branch && existsSync(statePath(cfg, configRoot, branchSlug(branch)))) {
  // --adopt 로 채택한 브랜치: 패턴 밖이어도 상태 JSON 이 있으면 그 기록을 따른다(키는 상태 JSON 이 안다)
  parsed = { branch, keys: [], slug: branchSlug(branch) };
}
if (!parsed) {
  reject('NO_STATE', `브랜치 "${branch ?? '(detached)'}" 는 branch_pattern 밖이고 상태 JSON 도 없다 — /jira-harness:issue <KEY> --adopt 로 채택할 것`, { branch });
}
const sPath = statePath(cfg, configRoot, parsed.slug);
let state;
try { state = readState(sPath); } catch (e) { reject('BAD_STATE', `상태 JSON 이 유효하지 않다(${fwd(relative(configRoot, sPath))}): ${e.message}`, { branch }); }
if (!state) reject('NO_STATE', `이슈가 시작되지 않았다 — /jira-harness:issue <KEY> 로 시작할 것`, { branch });
const keys = state.keys?.length ? state.keys : parsed.keys;
const base = { branch, keys };

// ---------- 작업트리 clean ----------
const ex = cfg.fingerprint_exclude;
const notExcluded = list => list.filter(p => !matchesAny(p, ex));
const staged = notExcluded(stagedFiles(root));
const unstaged = notExcluded(unstagedFiles(root));
const untracked = notExcluded(untrackedFiles(root));
if (staged.length || unstaged.length || untracked.length) {
  const sample = [...staged, ...unstaged, ...untracked].slice(0, 5).join(', ');
  reject('DIRTY_TREE', `커밋되지 않은 변경이 있다 — staged ${staged.length}개 · unstaged ${unstaged.length}개 · untracked ${untracked.length}개 (${sample}). 먼저 커밋하거나 stash 할 것`, base);
}

// ---------- 게이트 기록 ----------
const tree = fingerprintTree({ cwd: root, base: 'HEAD', excludes: ex });
const g = state.gate;
if (!g) reject('NO_GATE', '게이트 기록 없음 — gate.mjs --full 을 먼저 실행할 것', base);
if (g.level !== 'full') reject('GATE_LEVEL', `마감은 전량 게이트가 필요하다(기록은 ${g.level}) — gate.mjs --full`, base);
const gt = treeAccepted(g.tree, tree, cfg, root);
if (!gt.ok) {
  reject('GATE_STALE', `게이트 기록 이후 코드가 바뀌었다(${gt.changed ? gt.changed.slice(0, 5).join(', ') : '트리 비교 불가'}) — gate.mjs --full 재실행`, base);
}
const results = g.results ?? {};
const badGate = GATE_KEYS.filter(k => !OK_RESULT.has(results[k] ?? 'NOT_RUN'));
if (badGate.length) {
  reject('GATE_FAIL', `게이트 결과 미통과: ${badGate.map(k => `${k}=${results[k] ?? 'NOT_RUN'}`).join(' · ')} — gate.mjs --full`, base);
}
if (g.log) {
  const logFile = join(configRoot, g.log);
  if (!existsSync(logFile)) reject('GATE_LOG_MISSING', `게이트 로그가 없다(${g.log}) — gate.mjs --full 재실행`, base);
  if (g.log_sha256 && sha256File(logFile) !== g.log_sha256) {
    reject('GATE_LOG_MISMATCH', `게이트 로그 해시가 기록과 다르다(${g.log}) — gate.mjs --full 재실행`, base);
  }
}

// ---------- 리뷰 기록 ----------
const rv = state.review;
if (!rv) reject('NO_REVIEW', '리뷰 기록 없음 — 리뷰 사다리(codex-review.sh → verify) 를 실행할 것', base);
const rt = treeAccepted(rv.tree, tree, cfg, root);
if (!rt.ok) {
  reject('REVIEW_STALE', `리뷰 이후 바뀐 파일이 있다(${rt.changed ? rt.changed.slice(0, 5).join(', ') : '트리 비교 불가'}) — 델타 패스(verify --delta) 필요`, base);
}
if ((rv.blockers_open ?? 0) > 0) reject('REVIEW_BLOCKERS', `리뷰 blocker ${rv.blockers_open}건 미해소 — 수정 후 델타 패스`, base);

// ---------- CLAUDE.md 길이 (마감으로 루트 문서를 키우지 않는다) ----------
const claudeMd = join(root, 'CLAUDE.md');
const maxLines = cfg.wiki.claude_md_max_lines;
if (existsSync(claudeMd) && maxLines != null) {
  const lines = countLines(readFileSync(claudeMd, 'utf8'));
  if (lines > maxLines) {
    reject('CLAUDE_MD_TOO_LONG', `CLAUDE.md 가 ${lines}줄로 상한 ${maxLines}줄을 넘는다 — closure 기록은 CHANGELOG·wiki 로 보내고 루트 문서를 줄일 것`, { ...base, claude_md_lines: lines, claude_md_max_lines: maxLines });
  }
}

// ---------- 요약·마감 댓글 ----------
const dod = state.dod ?? [];
const probes = dod.filter(d => d.probe && !d.human);
const humans = dod.filter(d => d.human || !d.probe);
const probePass = probes.filter(d => d.last === 'PASS').length;
const humanPending = humans.filter(d => d.last !== 'PASS').map(d => d.id);

const stackLine = Object.entries(g.stacks ?? {})
  .map(([name, steps]) => `${name}(${Object.entries(steps).map(([k, v]) => `${k} ${v}`).join(' · ')})`)
  .join(' / ');
const resultLine = GATE_KEYS.map(k => `${k} ${results[k] ?? 'NOT_RUN'}`).join(' · ');

const gateSummary = {
  level: g.level, tree: g.tree, at: g.at, results, stacks: g.stacks ?? null,
  dod: g.dod ?? null, dod_probe_pass: probePass, dod_probe_total: probes.length, dod_human: humans.length,
  log: g.log ?? null, duration_s: g.duration_s ?? null,
};
const reviewSummary = {
  tree: rv.tree, at: rv.at, round: rv.round ?? null, delta_passes: rv.delta_passes ?? 0,
  codex: rv.codex ?? 'skipped', lanes: rv.lanes ?? null, findings: rv.findings ?? null, blockers_open: rv.blockers_open ?? 0,
};

const comment = [
  `${keys.length ? keys.join(', ') + ' ' : ''}구현을 마치고 브랜치 \`${branch}\` 를 원격에 올렸습니다.`,
  '',
  `- 게이트: 전량(full) · ${resultLine}`,
  stackLine ? `  - 스택별: ${stackLine}` : null,
  `- DoD: 프로브 ${probePass}/${probes.length} PASS · 사람 확인 ${humans.length}건 SKIPPED${humanPending.length ? ` (미확인 ${humanPending.join(', ')})` : ''}`,
  `- 리뷰: 라운드 ${reviewSummary.round ?? '?'} · 델타 패스 ${reviewSummary.delta_passes} · codex ${reviewSummary.codex} · 확정 blocker ${reviewSummary.blockers_open}건`,
  `- main 머지는 사람이 합니다 — 자동 머지하지 않습니다.`,
].filter(Boolean).join('\n');

const jira = { transition: cfg.jira.done_transition, comment };
const summary = { gate: gateSummary, review: reviewSummary, dod_human_pending: humanPending };

// ---------- 아카이브 경로 ----------
const issuesDir = join(configRoot, cfg.runtime_dir, 'issues');
const archiveDir = join(issuesDir, 'archive');
function archiveNames() {
  let name = `${parsed.slug}-${stamp()}`;
  let n = 1;
  while (existsSync(join(archiveDir, `${name}.json`))) name = `${parsed.slug}-${stamp()}-${++n}`;
  // `<slug>.json` 은 상태 본체다 — 사이드카(`<slug>.plan.json` 꼴)만 고른다
  const sidecars = existsSync(issuesDir)
    ? readdirSync(issuesDir).filter(f => f.startsWith(`${parsed.slug}.`) && f.endsWith('.json') && f !== `${parsed.slug}.json`)
    : [];
  return { name, sidecars };
}
const { name: archiveName, sidecars } = archiveNames();
const archiveRel = fwd(relative(configRoot, join(archiveDir, `${archiveName}.json`)));

// ---------- dry-run: 계획만 ----------
if (dryRun) {
  const plan = {
    code: 'OK', dry_run: true, branch, keys,
    pushed: false, archived_to: null,
    plan: { push: !noPush ? `git push -u origin ${branch}` : null, archive_to: archiveRel, sidecars: sidecars.map(f => fwd(relative(configRoot, join(issuesDir, f)))) },
    jira, summary,
  };
  console.error(`[jira-harness] complete: OK — dry-run(변경 없음) · ${branch}`);
  if (asJson) console.log(JSON.stringify(plan));
  else {
    console.log(`[complete] dry-run · ${branch} (${keys.join(', ')})`);
    console.log(`  push     ${plan.plan.push ?? '(생략 — --no-push)'}`);
    console.log(`  archive  ${archiveRel}`);
    console.log(`  gate     ${resultLine}`);
    console.log(`  review   r${reviewSummary.round ?? '?'} · blocker ${reviewSummary.blockers_open}`);
  }
  process.exit(0);
}

// ---------- push ----------
let pushed = false;
if (!noPush) {
  const remote = git(['remote', 'get-url', 'origin'], { cwd: root, allowFail: true });
  if (remote.status !== 0) {
    reject('PUSH_FAILED', 'origin 원격이 없다 — 원격을 등록하거나 --no-push 로 마감할 것(아카이브하지 않음)', { ...base, pushed: false, archived_to: null });
  }
  const r = git(['push', '-u', 'origin', branch], { cwd: root, allowFail: true });
  if (r.status !== 0) {
    reject('PUSH_FAILED', `git push 실패: ${(r.err || r.out).split('\n').slice(-3).join(' ').slice(0, 300)}`, { ...base, pushed: false, archived_to: null });
  }
  pushed = true;
}

// ---------- 상태 아카이브 ----------
const at = nowIso();
state.stage = 'archived';
state.history = [...(state.history ?? []), { stage: 'archived', at, note: pushed ? `pushed ${branch}` : 'archived (no-push)' }];
mkdirSync(archiveDir, { recursive: true });
const archivePath = join(archiveDir, `${archiveName}.json`);
writeState(archivePath, state);
unlinkSync(sPath);
const movedSidecars = [];
for (const f of sidecars) {
  const suffix = f.slice(parsed.slug.length + 1); // "plan.json" · "lane-be.json" · "review.json"
  const dest = join(archiveDir, `${archiveName}.${suffix}`);
  renameSync(join(issuesDir, f), dest);
  movedSidecars.push(fwd(relative(configRoot, dest)));
}

// ---------- 출력 ----------
const payload = { code: 'OK', branch, keys, pushed, archived_to: archiveRel, sidecars: movedSidecars, jira, summary };
console.error(`[jira-harness] complete: OK — ${branch} · push ${pushed ? '완료' : '생략'} · ${archiveRel}`);
if (asJson) console.log(JSON.stringify(payload));
else {
  console.log(`[complete] OK · ${branch} (${keys.join(', ')})`);
  console.log(`  push     ${pushed ? `origin/${branch}` : '(생략 — --no-push)'}`);
  console.log(`  archive  ${archiveRel}${movedSidecars.length ? ` (+사이드카 ${movedSidecars.length})` : ''}`);
  console.log(`  gate     ${resultLine}`);
  console.log(`  dod      프로브 ${probePass}/${probes.length} · 사람 확인 ${humans.length}건${humanPending.length ? ` (미확인 ${humanPending.join(', ')})` : ''}`);
  console.log(`  review   r${reviewSummary.round ?? '?'} · 델타 ${reviewSummary.delta_passes} · codex ${reviewSummary.codex} · blocker ${reviewSummary.blockers_open}`);
  console.log(`  jira     ${jira.transition} 전이 + 댓글 (라우터가 MCP 로 수행)`);
  console.log(`  다음     main 머지는 사람이 — 자동 머지 금지`);
}
process.exit(0);
