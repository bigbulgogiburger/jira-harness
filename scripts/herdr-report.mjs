#!/usr/bin/env node
// herdr-report.mjs — 현재 이슈·게이트·리뷰·루프 상태를 Herdr 사이드바(pane/workspace 메타데이터 토큰)에 올리고, 필요하면 토스트를 띄운다.
// Herdr 밖(HERDR_PANE_ID 없음)·하네스 밖에서는 아무것도 하지 않고 exit 0 — 어디서 불러도 무해.
//
// 사용:
//   node herdr-report.mjs [--cwd <dir>] [--event "<한 줄>"] [--notify "<제목>" [--body "<본문>"] [--sound done|request]] [--dry-run] [--json]
//   node herdr-report.mjs --status [--cwd <dir>] [--json]      토큰만 계산해 보여준다(Herdr 호출 없음)
//
// 라우터가 사람 게이트 직전에 부른다(계획 승인 대기·human DoD·리뷰 blocker): `--notify "<KEY> 계획 승인 대기" --sound request`.
// 스크립트(gate·issue-set·loop record·issue-complete·commit-gate)는 lib/herdr.mjs 의 herdrPing 을 직접 부른다.
import { resolve } from 'node:path';
import { herdrReport, herdrEnv, buildStatus, toMetadata } from './lib/herdr.mjs';

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const cwd = resolve(opt('--cwd') ?? process.cwd());
const json = flag('--json');

if (flag('--status')) {
  const s = buildStatus(cwd);
  if (!s) { if (json) console.log(JSON.stringify({ ok: false, reason: 'no harness' })); else console.log('[herdr-report] 하네스 밖'); process.exit(0); }
  const meta = toMetadata(s, opt('--event'));
  const h = herdrEnv();
  if (json) console.log(JSON.stringify({ ok: true, inside: h.inside, pane: h.pane, workspace: h.workspace, ...meta }, null, 2));
  else { console.log(`[herdr-report] ${h.inside ? `pane ${h.pane}` : 'Herdr 밖'} · ${meta.title}`); for (const [k, v] of Object.entries(meta.tokens)) console.log(`  ${k.padEnd(7)} ${v}`); }
  process.exit(0);
}

const notifyTitle = opt('--notify');
const r = herdrReport(cwd, {
  event: opt('--event'),
  notify: notifyTitle ? { title: notifyTitle, body: opt('--body'), sound: opt('--sound') ?? 'none' } : null,
  dryRun: flag('--dry-run'),
});
if (json) console.log(JSON.stringify(r, null, 2));
else if (!r.ok) console.log(`[herdr-report] 건너뜀 — ${r.reason}`);
else console.log(`[herdr-report] ${r.pane ?? '-'} ← ${r.meta.title}${notifyTitle ? ` · 알림 "${notifyTitle}"` : ''}${r.calls ? ' (dry-run)' : ''}`);
process.exit(0);
