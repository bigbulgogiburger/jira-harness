#!/usr/bin/env node
// herdr-plugin.mjs — Herdr 플러그인(herdr-plugin.toml) 의 진입점. 팝업 pane·액션·이벤트가 전부 이 파일의 서브커맨드다.
//   status              현재 이슈·게이트·리뷰 요약(issue-start --status + 토큰) 을 팝업에 보이고 키 입력을 기다린다
//   gate commit|full    게이트를 팝업에서 돌린다(출력 그대로) — 끝나면 키 입력 대기
//   report              사이드바 토큰 갱신(herdr-report) — 화면 없음
//   adopt               현재 브랜치를 이슈로 채택(issue-start --adopt) — 브랜치 이름에서 키를 읽는다
//   on-worktree-created 이벤트 — 새 worktree 의 브랜치가 branch_pattern 에 맞으면 상태 JSON 을 만든다
//
// 프로젝트 위치는 HERDR_PLUGIN_CONTEXT_JSON(worktree.path · pane.cwd · workspace.cwd) → HERDR_ACTIVE_PANE_CWD → --cwd → process.cwd() 순.
// 하네스가 없는 디렉터리면 안내 한 줄만 내고 끝난다. 절대 throw 로 죽지 않는다(플러그인 로그에 스택이 남는 것보다 한 줄 안내가 낫다).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { locateProject, loadConfig, parseBranch } from './lib/config.mjs';
import { currentBranch } from './lib/git.mjs';
import { herdrReport, notify } from './lib/herdr.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(PLUGIN_ROOT, 'scripts');
const argv = process.argv.slice(2);
const [cmd, sub] = argv.filter(a => !a.startsWith('--'));
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const json = argv.includes('--json');

/** Herdr 가 넘긴 호출 문맥에서 프로젝트 디렉터리를 고른다 */
export function resolveContextCwd(env = process.env, explicit = null) {
  const cands = [];
  if (explicit) cands.push(explicit);
  let ctx = null;
  try { ctx = env.HERDR_PLUGIN_CONTEXT_JSON ? JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON) : null; } catch { ctx = null; }
  if (ctx && typeof ctx === 'object') {
    // 실측(Herdr 0.9.0 action invoke): 평평한 키 — focused_pane_cwd · workspace_cwd · focused_pane_id · workspace_id · tab_id. 중첩 꼴은 이벤트/향후 버전 대비.
    for (const p of [ctx.worktree_path, ctx.worktree?.path, ctx.worktree?.cwd, ctx.focused_pane_cwd, ctx.pane?.cwd, ctx.focused_pane?.cwd, ctx.workspace_cwd, ctx.workspace?.cwd, ctx.workspace?.identity_cwd, ctx.cwd]) if (p) cands.push(p);
  }
  if (env.HERDR_ACTIVE_PANE_CWD) cands.push(env.HERDR_ACTIVE_PANE_CWD);
  cands.push(process.cwd());
  for (const c of cands) { const p = resolve(String(c)); if (existsSync(p)) return { cwd: p, ctx }; }
  return { cwd: process.cwd(), ctx };
}

function contextBranch(ctx) {
  return ctx?.worktree_branch ?? ctx?.worktree?.branch ?? ctx?.branch ?? null;
}
/** 액션/이벤트 프로세스에는 HERDR_PANE_ID 가 없을 수 있다 — 문맥의 pane/workspace 로 보고한다 */
function contextTarget(ctx) {
  return { pane: ctx?.focused_pane_id ?? ctx?.pane?.pane_id ?? null, workspace: ctx?.workspace_id ?? ctx?.workspace?.workspace_id ?? ctx?.workspace?.id ?? null };
}

function run(script, args, cwd, { inherit = true } = {}) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: inherit ? 'inherit' : 'pipe' });
  return { status: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

async function waitKey(msg = '\n[아무 키나 누르면 닫힙니다]') {
  if (!process.stdin.isTTY) return;
  process.stdout.write(msg);
  await new Promise(res => { try { process.stdin.setRawMode(true); } catch { /* */ } process.stdin.resume(); process.stdin.once('data', () => res()); });
  try { process.stdin.setRawMode(false); } catch { /* */ }
}

function harnessOrExplain(cwd) {
  const proj = locateProject(cwd);
  if (!proj) { console.log(`[jira-harness] git 저장소가 아닙니다 — ${cwd}`); return null; }
  if (!proj.configPath) { console.log(`[jira-harness] 이 저장소에는 .claude/harness.json 이 없습니다 — Claude Code 에서 /jira-harness:setup 을 먼저 실행하세요 (${proj.toplevel})`); return null; }
  return proj;
}

const { cwd, ctx } = resolveContextCwd(process.env, opt('--cwd'));

async function main() {
  switch (cmd) {
    case 'status': {
      if (!harnessOrExplain(cwd)) return waitKey();
      run('issue-start.mjs', ['--status', '--cwd', cwd], cwd);
      console.log('');
      run('herdr-report.mjs', ['--status', '--cwd', cwd], cwd);
      run('herdr-report.mjs', ['--cwd', cwd, '--event', 'status 열람'], cwd, { inherit: false });
      return waitKey();
    }
    case 'gate': {
      const level = sub === 'full' ? '--full' : '--commit';
      if (!harnessOrExplain(cwd)) return waitKey();
      console.log(`[jira-harness] gate ${level} · ${cwd}\n`);
      const r = run('gate.mjs', [level, '--cwd', cwd], cwd);
      console.log(`\n[jira-harness] gate exit ${r.status} — 사이드바 토큰은 gate.mjs 가 갱신했습니다`);
      return waitKey();
    }
    case 'report': {
      const r = herdrReport(cwd, { ...contextTarget(ctx), event: opt('--event') ?? 'report' });
      if (json) console.log(JSON.stringify(r)); else console.log(r.ok ? `[jira-harness] ${r.meta.title} → ${r.pane ?? r.workspace}` : `[jira-harness] 건너뜀 — ${r.reason}`);
      return;
    }
    case 'adopt':
    case 'on-worktree-created': {
      const proj = locateProject(cwd);
      if (!proj || !proj.configPath) { if (json) console.log(JSON.stringify({ ok: false, reason: 'no harness', cwd })); else console.log(`[jira-harness] 하네스 없음 — ${cwd}`); return; }
      const cfg = loadConfig(proj.configPath);
      const branch = contextBranch(ctx) ?? currentBranch(cwd);
      const parsed = branch ? parseBranch(branch, cfg) : null;
      if (!parsed) { if (json) console.log(JSON.stringify({ ok: false, reason: 'branch outside pattern', branch })); else console.log(`[jira-harness] 브랜치 ${branch ?? '(없음)'} 는 이슈 브랜치 패턴 밖 — 채택하지 않음`); return; }
      const r = run('issue-start.mjs', [parsed.keys.join(','), '--adopt', '--cwd', cwd, '--json'], cwd, { inherit: false });
      // issue-start --json 은 여러 줄 JSON 이다 — 첫 `{` 부터 끝까지가 한 덩어리
      let out = null; try { out = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { out = null; }
      const code = out?.code ?? `exit ${r.status}`;
      if (cmd === 'on-worktree-created' && out?.code && out.code !== 'RESUMED') notify(`${parsed.keys.join(',')} ${code}`, { body: `worktree ${branch}`, sound: 'none' }, { cwd });
      herdrReport(cwd, { ...contextTarget(ctx), event: `${cmd} ${code}` });
      if (json) console.log(JSON.stringify({ ok: r.status === 0, code, branch, keys: parsed.keys, cwd, detail: out }));
      else console.log(`[jira-harness] ${code} — ${branch} (${parsed.keys.join(', ')})${r.err ? `\n${r.err.trim()}` : ''}`);
      return;
    }
    default:
      console.log('사용: herdr-plugin.mjs status | gate commit|full | report | adopt | on-worktree-created [--cwd <dir>] [--json]');
  }
}

main().then(() => process.exit(0)).catch(e => { console.log(`[jira-harness] ${e.message}`); process.exit(0); });
