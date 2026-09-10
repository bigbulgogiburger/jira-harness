#!/usr/bin/env node
// lanes-codex.mjs — 리뷰 레인 실행기 (Codex 판).
//
// 왜 이 파일만 손으로 쓰는가: 나머지는 원본 트리를 그대로 옮기면 되지만, Claude 판의
// 레인은 Workflow 툴(`workflows/verify.js`)이 돌린다. Codex 에는 그 런타임이 없다.
// Codex 쪽 대응물은 `spawn_agent` 지만 그건 **모델이 판단해** 띄우는 구조라 레인 구성이
// 매번 달라진다 — 게이트가 "레인 N개 기록이 있나"로 판정할 수 없다. 그래서 레인 배정은
// 이 스크립트가 기계적으로 하고(원본 verify.js 와 **같은 glob 규칙**), 각 레인은
// `codex exec` 로 띄운다.
//
// 계약은 workflows/verify.js 와 동일하다 — 상위 절차가 둘을 구분하지 않게 하기 위해서다:
//   출력 { findings: [{severity,file,line,claim,evidence,axis}], lanes, dropped, delta }
//
// 사용:
//   node lanes-codex.mjs verify --diff-ref <ref> [--files a,b,c] [--lanes-max 4]
//                               [--delta-since <tree>] [--axes "a,b"] [--sandbox read-only]
//                               [--cwd <dir>] [--json]
// 종료 코드: 0 (레인 실패는 lanes[].status 로 본다 — 레인이 죽었다고 라우터를 죽이지 않는다)
//            2 사용법·설정 오류
//
// 규율: 레인이 결과 파일을 남기지 않으면 findings 0 이 아니라 **status:"failed"** 다.
//       빈 초록과 "안 돌았다"는 다른 말이고, 그 둘을 섞으면 게이트가 무장 해제된다.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { locateProject, loadConfig, branchSlug } from './lib/config.mjs';
import { currentBranch } from './lib/git.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('--'));
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const JSON_OUT = flag('--json');

if (cmd !== 'verify') {
  console.error('usage: lanes-codex.mjs verify --diff-ref <ref> [--files a,b] [--lanes-max N] [--delta-since <tree>] [--axes "x,y"] [--sandbox <mode>] [--cwd <dir>] [--json]');
  process.exit(2);
}

// ── verify.js 에서 그대로 옮긴 판정 로직 ────────────────────────────────
const RANK = { BLOCKER: 0, MAJOR: 1, MINOR: 2, INFO: 3 };
const slash = (p) => String(p == null ? '' : p).split('\\').join('/');

/** glob → RegExp. ** 는 구분자를 넘고, * 는 한 구간, ? 는 한 글자. */
function globToRe(glob) {
  const g = slash(glob);
  if (g === '*' || g === '**') return /^.*$/;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^$(){}|[]'.indexOf(c) >= 0 || c === '\\') re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
const normClaim = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
function bullets(list, empty, cap) {
  const arr = (Array.isArray(list) ? list : []).filter((x) => x != null && String(x).length);
  if (!arr.length) return empty;
  const head = cap && arr.length > cap ? arr.slice(0, cap) : arr;
  const rest = arr.length - head.length;
  return head.map((x) => `- ${slash(x)}`).join('\n') + (rest > 0 ? `\n- … 외 ${rest}건` : '');
}

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['BLOCKER', 'MAJOR', 'MINOR', 'INFO'] },
          file: { type: 'string' },
          line: { type: 'integer', minimum: 0 },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          axis: { type: 'string' },
        },
        required: ['severity', 'file', 'line', 'claim', 'evidence', 'axis'],
      },
    },
  },
  required: ['findings'],
};

// ── 설정·범위 ───────────────────────────────────────────────────────────
const cwd = arg('--cwd') ? resolve(arg('--cwd')) : process.cwd();
const proj = locateProject(cwd);
if (!proj || !proj.configPath) {
  console.error('[lanes-codex] .codex/harness.json 이 없다 — setup 을 먼저 돌릴 것');
  process.exit(2);
}
const cfg = loadConfig(proj.configPath);
const root = proj.toplevel;

const diffRef = arg('--diff-ref') || cfg.default_branch || 'main';
const deltaSince = arg('--delta-since');
const lanesMax = Number(arg('--lanes-max') || cfg?.review?.lanes_max || 4) || 4;
const sandbox = arg('--sandbox') || cfg?.review?.codex_sandbox || 'read-only';
const model = arg('--model') || cfg?.review?.codex_model || null;
const axes = String(arg('--axes') || '').split(',').map((s) => s.trim()).filter(Boolean);
const dispatch = cfg.dispatch && typeof cfg.dispatch === 'object' ? cfg.dispatch : {};

function changedFrom(ref) {
  const r = spawnSync('git', ['diff', '--name-only', `${ref}...HEAD`], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).map(slash).filter(Boolean);
}
const filesArg = arg('--files');
const changedFiles = filesArg
  ? filesArg.split(',').map((s) => slash(s.trim())).filter(Boolean)
  : changedFrom(deltaSince || diffRef);

if (!changedFiles.length) {
  const out = { findings: [], lanes: [], dropped: [], delta: !!deltaSince, reason: '리뷰할 변경 파일이 없다' };
  console.log(JSON_OUT ? JSON.stringify(out) : '[lanes-codex] 변경 파일이 없다 — 레인 0');
  process.exit(0);
}

// ── 레인 선정 (verify.js 와 동일: 먼저 걸린 glob 이 임자) ───────────────
const candidates = [];
if (deltaSince) {
  candidates.push({ label: 'verify:delta', axis: '델타(직전 리뷰 이후 바뀐 파일만)', agentType: null, files: changedFiles, since: deltaSince });
} else {
  const buckets = [];
  const byAgent = {};
  const taken = {};
  for (const glob of Object.keys(dispatch)) {
    const re = globToRe(glob);
    const list = Array.isArray(dispatch[glob]) ? dispatch[glob] : [dispatch[glob]];
    for (const f of changedFiles) {
      if (taken[f] || !re.test(f)) continue;
      taken[f] = true;
      for (const a of list) {
        if (!a) continue;
        if (!byAgent[a]) { byAgent[a] = { agentType: a, files: [] }; buckets.push(byAgent[a]); }
        byAgent[a].files.push(f);
      }
    }
  }
  for (const b of buckets) candidates.push({ label: `verify:${b.agentType}`, axis: b.agentType, agentType: b.agentType, files: b.files, since: null });
  for (const ax of axes) candidates.push({ label: `verify:${ax}`, axis: ax, agentType: null, files: changedFiles, since: null });
}
const picked = candidates.slice(0, lanesMax);
const dropped = candidates.slice(lanesMax).map((c) => c.label);

if (!picked.length) {
  const out = { findings: [], lanes: [], dropped, delta: !!deltaSince, reason: 'dispatch 가 어떤 레인도 배정하지 않았다' };
  console.log(JSON_OUT ? JSON.stringify(out) : '[lanes-codex] dispatch 가 레인을 배정하지 않았다 — harness.json.dispatch 를 볼 것');
  process.exit(0);
}

// ── 레인 프롬프트 — 전문 관점은 subagents/<name>.toml 의 원고에서 온다 ──
function roleBrief(agentType) {
  if (!agentType) return null;
  const f = join(PLUGIN_ROOT, 'subagents', `${agentType}.toml`);
  if (!existsSync(f)) return null;
  const text = readFileSync(f, 'utf8');
  const m = /developer_instructions\s*=\s*'''\r?\n([\s\S]*?)\r?\n'''/.exec(text);
  return m ? m[1] : null;
}

const runtimeDir = join(root, cfg.runtime_dir || '.codex/runtime', 'lanes');
mkdirSync(runtimeDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const slug = arg('--slug') || branchSlug(currentBranch(root) || 'detached');

function buildPrompt(lane) {
  const brief = roleBrief(lane.agentType);
  return [
    `너는 코드 리뷰 레인 "${lane.axis}" 이다. 아래 변경만 읽고 결함을 찾는다. 코드를 고치지 않는다.`,
    '',
    '## 변경 범위',
    `- diff 기준: ${diffRef}`,
    lane.since ? `- 직전 리뷰 트리: ${lane.since} (그 뒤 바뀐 파일만 본다)` : '- 라운드 리뷰(변경 전체가 대상)',
    `- 저장소 루트: ${slash(root)}`,
    '',
    '## 담당 파일',
    bullets(lane.files, '- (파일 목록 없음 — diff 기준 전체를 본다)', 60),
    '',
    '## 관점',
    brief
      ? `이 레인의 전문 관점(${lane.agentType})은 아래 원고를 따른다.\n\n<<<역할 원고\n${brief}\n역할 원고>>>`
      : `"${lane.axis}" 축에 집중한다.`,
    '',
    '## 규율',
    '- finding 마다 파일·줄과 **증거**(그 자리에서 읽은 코드·명령 출력)를 단다. 증거 없는 추측은 내지 않는다.',
    '- 게이트가 초록이라는 사실은 근거가 아니다 — 초록은 "위반 0" 과 "검사 0" 을 구분해주지 않는다.',
    '- severity: BLOCKER(머지 불가) / MAJOR(고쳐야 함) / MINOR(사소) / INFO(참고).',
    '- 같은 결함을 여러 줄로 쪼개 부풀리지 않는다. 담당 파일 밖 결함은 내지 않는다.',
    '- 파일을 고치거나 커밋하지 않는다. 읽기만 한다.',
    '',
    '## 반환',
    `schema 대로 findings 배열만 반환한다. axis 에는 "${lane.axis}" 를 넣는다. 결함이 없으면 빈 배열이다. (실행 표식 ${ts})`,
  ].join('\n');
}

// ── 레인 실행 (병렬) ────────────────────────────────────────────────────
const schemaPath = join(runtimeDir, `${slug}-schema-${ts}.json`);
writeFileSync(schemaPath, JSON.stringify(FINDING_SCHEMA, null, 2));

function runLane(lane, i) {
  return new Promise((done) => {
    const base = join(runtimeDir, `${slug}-${String(i).padStart(2, '0')}-${ts}`);
    const promptPath = `${base}.prompt.md`;
    const outPath = `${base}.json`;
    writeFileSync(promptPath, buildPrompt(lane));

    const args = [
      'exec',
      '--cd', root,
      '--sandbox', sandbox,
      '--skip-git-repo-check',
      '--output-schema', schemaPath,
      '--output-last-message', outPath,
    ];
    if (model) args.push('--model', model);
    args.push(readFileSync(promptPath, 'utf8'));

    const started = Date.now();
    const child = spawn('codex', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => done({ lane, status: 'failed', reason: `codex 실행 실패: ${e.message}`, findings: [], ms: Date.now() - started, outPath }));
    child.on('close', (code) => {
      const ms = Date.now() - started;
      if (!existsSync(outPath)) {
        return done({ lane, status: 'failed', reason: `결과 파일이 없다 (exit ${code})${stderr ? ` — ${stderr.trim().slice(-400)}` : ''}`, findings: [], ms, outPath });
      }
      let parsed = null;
      try { parsed = JSON.parse(readFileSync(outPath, 'utf8')); } catch (e) {
        return done({ lane, status: 'failed', reason: `결과 JSON 파싱 실패: ${e.message}`, findings: [], ms, outPath });
      }
      const list = parsed && Array.isArray(parsed.findings) ? parsed.findings : null;
      if (!list) return done({ lane, status: 'failed', reason: 'findings 배열이 없다', findings: [], ms, outPath });
      done({ lane, status: 'ok', reason: null, findings: list, ms, outPath });
    });
  });
}

const results = await Promise.all(picked.map((l, i) => runLane(l, i)));
try { rmSync(schemaPath, { force: true }); } catch { /* 남아도 무해하다 */ }

// ── 병합 — verify.js 와 동일: 먼저 온 것을 남기되 severity 는 센 쪽으로 ──
const merged = [];
const seen = {};
const laneReport = results.map((r) => {
  for (const f of r.findings) {
    if (!f || !f.file || !f.claim) continue;
    const file = slash(f.file);
    const line = typeof f.line === 'number' ? f.line : 0;
    const key = `${file}|${line}|${normClaim(f.claim)}`;
    const sev = RANK[f.severity] === undefined ? 'INFO' : f.severity;
    if (seen[key]) {
      if (RANK[sev] < RANK[seen[key].severity]) seen[key].severity = sev;
      continue;
    }
    const rec = { severity: sev, file, line, claim: String(f.claim), evidence: String(f.evidence == null ? '' : f.evidence), axis: f.axis || r.lane.axis };
    seen[key] = rec;
    merged.push(rec);
  }
  return {
    label: r.lane.label,
    agentType: r.lane.agentType || null,
    status: r.status,
    reason: r.reason,
    count: r.findings.length,
    ms: r.ms,
    out: slash(r.outPath),
  };
});
merged.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

const failedLanes = laneReport.filter((l) => l.status !== 'ok');
const out = { findings: merged, lanes: laneReport, dropped, delta: !!deltaSince };

if (JSON_OUT) {
  console.log(JSON.stringify(out));
} else {
  console.log(`[lanes-codex] 레인 ${picked.length}/${candidates.length}개 (상한 ${lanesMax}, sandbox ${sandbox})`);
  for (const l of laneReport) {
    console.log(`  ${l.status === 'ok' ? 'OK ' : 'X  '} ${l.label}  finding ${l.count}건  ${(l.ms / 1000).toFixed(1)}s${l.reason ? `  — ${l.reason}` : ''}`);
  }
  if (dropped.length) console.log(`  상한 초과로 뺀 레인: ${dropped.join(', ')} — 다음 라운드나 델타 패스에서 다시 잡는다`);
  console.log(`[lanes-codex] finding ${merged.length}건 (중복 제거 후) — 확정/기각은 메인이 한다`);
  if (failedLanes.length) console.log(`[lanes-codex] ⚠ 레인 ${failedLanes.length}건이 안 돌았다 — 그 축은 "결함 0" 이 아니라 "안 봤다" 이다`);
}
process.exit(0);
