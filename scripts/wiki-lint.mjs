#!/usr/bin/env node
// wiki-lint.mjs — LLM 위키(INDEX/LOG/가이드/ADR/synthesis/memory) 정합 점검 16종의 코드화.
//
// 규칙 목록·심각도는 프로젝트의 INDEX-SCHEMA.md 와 wiki 스키마 문서를 SSoT 로 따른다.
// 네트워크·이슈 트래커·git 이력이 필요한 점검은 **구현하지 않고 SKIPPED(사유)** 로 출력한다 —
// 조용히 빼면 "검사 0" 이 "위반 0" 으로 읽힌다.
//
// 사용:
//   node scripts/wiki-lint.mjs --docs <docs 디렉토리> [--memory <memory 디렉토리>] [--root <프로젝트 루트>]
//        [--json] [--severity high|all] [--today YYYY-MM-DD] [--synthesis-since YYYY-MM-DD] [--no-code-index]
//
// 종료 코드: 0 · high 위반 1건 이상이면 1 · 입력 오류 2.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitKeepEol, parseTables, unescapeCell, sortHint } from './wiki-row.mjs';

// ── 규칙 목록 (SSoT: 프로젝트 wiki 스키마 § Lint Rules) ───────────────────────
const RULES = [
  { id: 'L01', name: 'Orphan — 가이드 파일이 INDEX 에 없음', severity: 'high' },
  { id: 'L02', name: 'Orphan reverse — INDEX 행의 문서 부재', severity: 'high' },
  { id: 'L03', name: 'Stale — planned 상태 방치', severity: 'medium' },
  { id: 'L04', name: '(폐지 — L03 에 통합)', severity: 'none' },
  { id: 'L05', name: 'Xref — 없는 ADR 인용', severity: 'high' },
  { id: 'L06', name: 'Xref — 가이드 본문의 미등재 이슈 키', severity: 'medium' },
  { id: 'L07', name: 'Xref — parent/siblings 비대칭', severity: 'medium' },
  { id: 'L08', name: 'Frontmatter — 신규 가이드에 frontmatter 없음', severity: 'low' },
  { id: 'L09', name: 'Conflict — 같은 ADR 을 상반되게 인용', severity: 'high' },
  { id: 'L10', name: 'Memory drift — memory 인용 파일/클래스 부재', severity: 'high' },
  { id: 'L11', name: 'INDEX integrity — 중복·셀 수·빈칸·마커·정렬', severity: 'low' },
  { id: 'L12', name: 'LOG integrity — 라인 형식 일탈', severity: 'low' },
  { id: 'L13', name: 'Policy — forbidden 파일 수정(git 이력)', severity: 'high' },
  { id: 'L14', name: 'Closure — 트래커 상태 ↔ INDEX status 불일치', severity: 'medium' },
  { id: 'L15', name: 'Coverage — sprint 주차 파일이 종결 이슈 미인용', severity: 'low' },
  { id: 'L16', name: 'Synthesis coverage — wiki= 필드·등재·도메인', severity: 'medium' },
  { id: 'L17', name: 'Synthesis xref — wiki 페이지 출처 결박', severity: 'high' },
];

// ── 최소 YAML 발췌 (외부 의존성 0) ───────────────────────────────────────────
function yamlOf(text) {
  const m = text.match(/```ya?ml\r?\n([\s\S]*?)```/);
  return m ? m[1] : text;
}

function stripComment(v) {
  let q = null, out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) { out += c; if (c === '\\') { out += v[++i] ?? ''; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(v[i - 1]))) break;
    out += c;
  }
  return out.trim();
}

function unquote(v) {
  const s = stripComment(String(v));
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function indentOf(line) { return (line.match(/^[ \t]*/) || [''])[0].length; }

/** startIdx 줄보다 더 깊게 들여쓴 연속 블록. */
function blockUnder(lines, startIdx) {
  const base = indentOf(lines[startIdx]);
  const out = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { out.push(l); continue; }
    if (indentOf(l) <= base) break;
    out.push(l);
  }
  return out;
}

function scalarIn(lines, key) {
  const re = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`);
  for (const l of lines) { const m = l.match(re); if (m) return unquote(m[1]); }
  return null;
}

function findIdx(lines, re) { return lines.findIndex(l => re.test(l)); }

function parseSchema(schemaText, fallbackPrefix) {
  const lines = yamlOf(schemaText).split(/\r?\n/);
  const prefix = scalarIn(lines, 'issue_prefix') || fallbackPrefix || 'ISSUE';

  let guidePattern = null;
  const gi = findIdx(lines, /^\s*-\s*id:\s*issue_guides\s*$/);
  if (gi >= 0) guidePattern = scalarIn(blockUnder(lines, gi), 'pattern');
  if (!guidePattern) guidePattern = `^${prefix}-\\d+(?:-(?:${prefix}-)?\\d+)*-dev-guide\\.md$`;

  // ⚠ 최상위 키에 꼬리 주석이 붙어 있는 실물이 있다 (`synthesis:   # …`).
  //    앵커를 `$` 로 닫으면 블록을 못 찾고 L16/L17 이 조용히 "미설정" 으로 빠진다.
  const topKey = k => new RegExp(`^${k}:[ \\t]*(?:#.*)?$`);
  let domains = null;
  const si = findIdx(lines, topKey('synthesis'));
  if (si >= 0) {
    domains = blockUnder(lines, si)
      .map(l => (l.match(/^\s*-\s*id:\s*([A-Za-z0-9_\-]+)/) || [])[1])
      .filter(Boolean);
  }

  let plannedDays = 7;
  const ti = findIdx(lines, topKey('stale_thresholds'));
  if (ti >= 0) {
    const v = scalarIn(blockUnder(lines, ti), 'planned_days');
    if (v && /^\d+$/.test(v)) plannedDays = Number(v);
  }

  const frontmatterSince = scalarIn(lines, 'frontmatter_required_since');

  let exemptKeys = [];
  const ei = findIdx(lines, /^\s*-\s*id:\s*row_description_only\s*$/);
  if (ei >= 0) {
    const raw = scalarIn(blockUnder(lines, ei), 'keys');
    if (raw) exemptKeys = [...raw.matchAll(/"([^"]+)"|'([^']+)'/g)].map(m => m[1] || m[2]);
  }

  let adrPattern = null, issuePattern = null;
  const ci = findIdx(lines, topKey('cross_refs'));
  if (ci >= 0) {
    const b = blockUnder(lines, ci);
    adrPattern = scalarIn(b, 'adr_pattern');
    issuePattern = scalarIn(b, 'issue_pattern');
  }
  return {
    prefix,
    guidePattern,
    domains,                       // null 이면 synthesis 미설정
    plannedDays,
    frontmatterSince,
    exemptKeys,
    adrRe: new RegExp(adrPattern || '\\bADR-\\d+\\b', 'g'),
    issueRe: new RegExp(issuePattern || `\\b${prefix}-\\d+\\b`, 'g'),
  };
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function daysBetween(a, b) { return Math.round((Date.parse(a) - Date.parse(b)) / 86400000); }

// 점 디렉토리를 통째로 건너뛰면 `.loop/driver.js` 같은 실재 파일이 "부재" 로 잡힌다 —
// 무거운 것만 이름으로 뺀다.
const DEFAULT_SKIP = ['.git', '.gradle', '.idea', '.vscode', '.venv', '.next', '.nuxt', '.cache', '.m2', 'node_modules'];

function walkFiles(dir, { skipDirs = new Set(), exts = null, limit = 200000 } = {}) {
  for (const d of DEFAULT_SKIP) skipDirs.add(d);
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d); } catch { continue; }
    for (const name of entries) {
      const p = join(d, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!skipDirs.has(name)) stack.push(p); continue; }
      if (exts && !exts.some(e => name.endsWith(e))) continue;
      out.push(p);
    }
  }
  return out;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      fm[mm[1]] = v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else fm[mm[1]] = unquote(v);
  }
  return fm;
}

function cellsToObj(columns, cells) {
  const o = {};
  columns.forEach((c, i) => { o[c.toLowerCase()] = unescapeCell(cells[i] ?? ''); });
  return o;
}

function pick(obj, ...names) {
  for (const n of names) if (obj[n] !== undefined) return obj[n];
  return '';
}

function splitList(v) {
  return String(v || '').split(/[,/]/).map(s => s.trim()).filter(s => s && s !== '-');
}

// ── 컨텍스트 수집 ────────────────────────────────────────────────────────────
function buildContext(opt) {
  const docsDir = resolve(opt.docs);
  if (!existsSync(docsDir)) { console.error(`wiki-lint: docs 디렉토리가 없습니다: ${docsDir}`); process.exit(2); }
  const root = resolve(opt.root || join(docsDir, '..'));

  const schemaPath = join(docsDir, 'INDEX-SCHEMA.md');
  const indexPath = join(docsDir, 'INDEX.md');
  const logPath = join(docsDir, 'LOG.md');
  const adrPath = join(docsDir, '08-decision-log.md');

  const schemaText = existsSync(schemaPath) ? readFileSync(schemaPath, 'utf8') : '';
  const schema = parseSchema(schemaText, opt.prefix);
  const hasSchema = !!schemaText;

  const indexText = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  const indexLines = splitKeepEol(indexText);
  const tables = parseTables(indexLines);
  const issueTable = tables.find(t => /^issue$/i.test(t.columns[0] || '')) || null;

  const rows = [];
  const keySet = new Set();
  if (issueTable) {
    for (const r of issueTable.rows) {
      const obj = cellsToObj(issueTable.columns, r.cells);
      const rowKey = unescapeCell(r.cells[0] ?? '').trim();
      const keys = [...rowKey.matchAll(new RegExp(schema.issueRe.source, 'g'))].map(m => m[0]);
      rows.push({ rowKey, keys, obj, line: r.idx + 1, cellCount: r.cells.length });
      keySet.add(rowKey);
      for (const k of keys) keySet.add(k);
    }
  }

  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const logEntries = [];
  const logRaw = logText.split(/\r?\n/);
  logRaw.forEach((body, i) => {
    if (!body.startsWith('[')) return;
    const m = body.match(/^\[(\d{4}-\d{2}-\d{2})(?:\s+([\d:]+))?\s+KST\s+(.*?)\]\s*(.*)$/);
    if (!m) return;
    const toks = m[3].trim().split(/\s+/);
    logEntries.push({
      line: i + 1, date: m[1], mode: toks[0] || '-', key: toks[1] || '-',
      phase: toks[2] || '', rest: m[4], body,
    });
  });

  const adrText = existsSync(adrPath) ? readFileSync(adrPath, 'utf8') : '';
  const adrSet = new Set([...adrText.matchAll(/^##\s*(ADR-\d+)/gm)].map(m => m[1]));

  const docFiles = walkFiles(docsDir, { exts: ['.md'] }).map(p => relative(docsDir, p).replace(/\\/g, '/'));
  const guideRe = new RegExp(schema.guidePattern);
  const guideFiles = docFiles
    .filter(f => guideRe.test(basename(f)))
    .map(f => ({
      file: f,
      keys: (basename(f).match(/\d+/g) || []).map(n => `${schema.prefix}-${n}`),
    }));

  const wikiDir = join(docsDir, 'wiki');
  const wikiPages = existsSync(wikiDir)
    ? readdirSync(wikiDir).filter(f => f.endsWith('.md')).map(f => {
        const text = readFileSync(join(wikiDir, f), 'utf8');
        return { file: `wiki/${f}`, name: f, text, fm: parseFrontmatter(text) || {} };
      })
    : [];

  let codeIndex = null;
  if (!opt.noCodeIndex) {
    const skipDirs = new Set(['node_modules', 'build', 'dist', 'out', 'target', 'coverage', '__pycache__', 'vendor', 'tmp']);
    const files = walkFiles(root, { skipDirs, exts: ['.java', '.vue', '.ts', '.js', '.py', '.kt', '.mjs'] });
    if (files.length) {
      codeIndex = { paths: new Set(), names: new Set() };
      for (const p of files) {
        codeIndex.paths.add(relative(root, p).replace(/\\/g, '/'));
        codeIndex.names.add(basename(p));
      }
    }
  }

  const memoryFiles = opt.memory && existsSync(opt.memory)
    ? walkFiles(resolve(opt.memory), { exts: ['.md'] })
    : [];

  return {
    docsDir, root, schema, hasSchema, indexText, indexLines, tables, issueTable, rows, keySet,
    logText, logRaw, logEntries, adrSet, adrPresent: !!adrText, docFiles, guideFiles, wikiPages,
    codeIndex, memoryFiles, today: opt.today, synthesisSince: opt.synthesisSince,
    guideCache: new Map(),
  };
}

/** INDEX/LOG 를 뺀 docs 전 문서가 "서술하는" 이슈 키 집합 (1회 계산 후 캐시). */
function describedKeys(ctx) {
  if (ctx._describedKeys) return ctx._describedKeys;
  const set = new Set();
  const re = new RegExp(ctx.schema.issueRe.source, 'g');
  for (const f of ctx.docFiles) {
    if (f === 'INDEX.md' || f === 'LOG.md' || f === 'INDEX-SCHEMA.md') continue;
    let text;
    try { text = readFileSync(join(ctx.docsDir, f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(re)) set.add(m[0]);
  }
  ctx._describedKeys = set;
  return set;
}

function guideText(ctx, file) {
  if (!ctx.guideCache.has(file)) {
    try { ctx.guideCache.set(file, readFileSync(join(ctx.docsDir, file), 'utf8')); }
    catch { ctx.guideCache.set(file, ''); }
  }
  return ctx.guideCache.get(file);
}

// ── 점검 구현 ────────────────────────────────────────────────────────────────
const V = (file, line, message) => ({ file, line, message });
const skipped = reason => ({ status: 'SKIPPED', reason, violations: [] });
const ok = violations => ({ status: violations.length ? 'VIOLATION' : 'OK', violations });

const CHECKS = {
  L01(ctx) {
    if (!ctx.issueTable) return skipped('INDEX.md 에 이슈 표(첫 열 Issue)가 없다');
    const v = [];
    for (const g of ctx.guideFiles) {
      if (g.keys.length === 0) continue;
      if (!g.keys.some(k => ctx.keySet.has(k))) v.push(V(g.file, 1, `INDEX 미등재 (키 ${g.keys.join(',')})`));
    }
    return ok(v);
  },

  L02(ctx) {
    if (!ctx.issueTable) return skipped('INDEX.md 에 이슈 표가 없다');
    const v = [];
    const docSet = new Set(ctx.docFiles);
    for (const r of ctx.rows) {
      if (r.rowKey.includes('::')) continue;                       // 슬라이스 행 — 전용 파일 없음이 설계
      if (/[()]/.test(r.rowKey)) continue;                          // 키 포맷 변형
      if (ctx.schema.exemptKeys.includes(r.rowKey)) continue;       // 스키마가 명시 면제
      if (ctx.guideFiles.some(g => g.keys.some(k => r.keys.includes(k)))) continue;  // 전용 가이드 존재
      // 행 본문이 실재하는 docs 경로를 인용하면 그 문서가 SSoT (세션 문서 유형)
      const rowText = Object.values(r.obj).join(' ');
      const paths = [...rowText.matchAll(/([A-Za-z0-9_\-./]+\.md)/g)].map(m => m[1].replace(/^docs\//, ''));
      if (paths.some(p => docSet.has(p))) continue;
      // 어떤 문서든 그 키를 서술하면 등재는 정상 (umbrella 가이드 · 세션 문서 유형).
      // ⚠ 파일명만 보면 `<KEY>-520-525` umbrella 가이드가 521~524 를 덮는 것을 못 본다 — 본문을 봐야 한다.
      if (r.keys.some(k => describedKeys(ctx).has(k))) continue;
      v.push(V('INDEX.md', r.line, `${r.rowKey} — 대응 문서를 찾지 못함`));
    }
    return ok(v);
  },

  L03(ctx) {
    if (!ctx.issueTable) return skipped('INDEX.md 에 이슈 표가 없다');
    const v = [];
    for (const r of ctx.rows) {
      if (pick(r.obj, 'status', '상태').toLowerCase() !== 'planned') continue;
      const dates = ctx.logEntries.filter(e => r.keys.some(k => e.key.includes(k)) || e.key === r.rowKey).map(e => e.date);
      const last = dates.sort().pop() || pick(r.obj, 'updated', '갱신');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(last)) continue;
      const age = daysBetween(ctx.today, last);
      if (age > ctx.schema.plannedDays) v.push(V('INDEX.md', r.line, `${r.rowKey} planned ${age}일 (임계 ${ctx.schema.plannedDays}일, 최종활동 ${last})`));
    }
    return ok(v);
  },

  L04() { return skipped('스키마에서 폐지 — L03 (stale) 에 통합됨'); },

  L05(ctx) {
    if (!ctx.adrPresent) return skipped('08-decision-log.md 가 없다');
    const v = [];
    const all = [...ctx.adrSet];
    for (const r of ctx.rows) {
      for (const raw of splitList(pick(r.obj, 'adrs', 'adr'))) {
        const tok = /^\d+$/.test(raw) ? `ADR-${raw}` : raw;
        if (!/^ADR-\d+$/.test(tok)) continue;
        if (ctx.adrSet.has(tok)) continue;
        const near = all.map(a => [levenshtein(tok, a), a]).sort((x, y) => x[0] - y[0]).slice(0, 3).map(x => x[1]);
        v.push(V('INDEX.md', r.line, `${r.rowKey} → ${tok} 미존재 (후보: ${near.join(', ') || '-'})`));
      }
    }
    return ok(v);
  },

  L06(ctx) {
    if (!ctx.issueTable) return skipped('INDEX.md 에 이슈 표가 없다');
    const v = [];
    for (const g of ctx.guideFiles) {
      const text = guideText(ctx, g.file);
      const refs = new Set([...text.matchAll(new RegExp(ctx.schema.issueRe.source, 'g'))].map(m => m[0]));
      for (const k of refs) {
        if (!ctx.keySet.has(k)) v.push(V(g.file, 1, `본문의 ${k} 가 INDEX 에 없다`));
      }
    }
    return ok(v);
  },

  L07(ctx) {
    if (!ctx.issueTable) return skipped('INDEX.md 에 이슈 표가 없다');
    const v = [];
    const byKey = new Map();
    for (const r of ctx.rows) for (const k of [r.rowKey, ...r.keys]) if (!byKey.has(k)) byKey.set(k, r);
    for (const r of ctx.rows) {
      const parent = pick(r.obj, 'parent', '부모').trim();
      if (parent && parent !== '-' && !byKey.has(parent)) {
        v.push(V('INDEX.md', r.line, `${r.rowKey} 의 parent ${parent} 행이 INDEX 에 없다`));
      }
      for (const sib of splitList(pick(r.obj, 'siblings', '형제'))) {
        const other = byKey.get(sib);
        if (!other || other === r) continue;
        const back = splitList(pick(other.obj, 'siblings', '형제'));
        if (!back.some(b => b === r.rowKey || r.keys.includes(b))) {
          v.push(V('INDEX.md', r.line, `${r.rowKey} → ${sib} 는 단방향 (${other.rowKey} 행에 역참조 없음)`));
        }
      }
    }
    return ok(v);
  },

  L08(ctx) {
    const since = ctx.schema.frontmatterSince;
    if (!since) return skipped('스키마에 frontmatter_required_since 가 없다');
    const v = [];
    for (const g of ctx.guideFiles) {
      // 생성일 대용: LOG 의 최초 언급일 → 없으면 INDEX 행의 갱신일 (git 이력 없이 쓰는 근사)
      const first = ctx.logEntries.filter(e => g.keys.some(k => e.key.includes(k))).map(e => e.date).sort()[0];
      const row = ctx.rows.find(r => r.keys.some(k => g.keys.includes(k)));
      const date = first || (row ? pick(row.obj, 'updated', '갱신') : '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < since) continue;
      if (!/^---\r?\n/.test(guideText(ctx, g.file))) v.push(V(g.file, 1, `frontmatter 없음 (기준일 ${since} 이후: ${date})`));
    }
    return ok(v);
  },

  L09(ctx) {
    if (!ctx.issueTable) return skipped('INDEX.md 에 이슈 표가 없다');
    const REVERT = /반전|폐기|철회|취소|supersede/;
    const APPLY = /적용|채택|준수|유지/;
    const stance = new Map(); // ADR -> { revert:[], apply:[] }
    for (const r of ctx.rows) {
      const text = Object.values(r.obj).join(' ');
      for (const m of text.matchAll(/ADR-\d+/g)) {
        const ctxStr = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
        const s = stance.get(m[0]) || { revert: new Set(), apply: new Set() };
        if (REVERT.test(ctxStr)) s.revert.add(r.rowKey);
        else if (APPLY.test(ctxStr)) s.apply.add(r.rowKey);
        stance.set(m[0], s);
      }
    }
    const v = [];
    for (const [adr, s] of stance) {
      const rev = [...s.revert], app = [...s.apply].filter(k => !s.revert.has(k));
      if (rev.length && app.length) {
        v.push(V('INDEX.md', 0, `${adr} — 반전 주장(${rev[0]}) 과 적용 주장(${app[0]}) 공존 (heuristic)`));
      }
    }
    return ok(v);
  },

  L10(ctx) {
    if (!ctx.memoryFiles.length) return skipped('--memory 미지정이거나 memory 파일이 없다');
    if (!ctx.codeIndex) return skipped('코드 인덱스가 비었다 (--root 로 코드 트리를 지정하거나 --no-code-index 해제)');
    const v = [];
    const CLASS = /\b[A-Z][A-Za-z0-9]{5,}(?:Service|Controller|Repository|Component|Entity|Dto|Factory|Aspect)\b/g;
    const stems = [...ctx.codeIndex.names].map(n => n.replace(/\.[^.]+$/, ''));
    for (const f of ctx.memoryFiles) {
      const text = readFileSync(f, 'utf8');
      const rel = relative(ctx.root, f).replace(/\\/g, '/');
      const seen = new Set();
      for (const m of text.matchAll(/[A-Za-z0-9_\-./]+\.(?:java|vue|ts|js|py|kt)\b/g)) {
        const p = m[0].replace(/^\.\//, '');
        // `*.spec.js` 같은 확장자 조각은 경로가 아니다 — 마지막 조각이 이름으로 시작해야 한다
        if (!/^[A-Za-z0-9_][A-Za-z0-9_\-.]*$/.test(p.split('/').pop())) continue;
        if (seen.has(p)) continue; seen.add(p);
        const hit = p.includes('/')
          ? [...ctx.codeIndex.paths].some(q => q === p || q.endsWith('/' + p))
          : ctx.codeIndex.names.has(p);
        if (!hit) v.push(V(rel, 1, `인용 파일 부재: ${p}`));
      }
      for (const m of text.matchAll(CLASS)) {
        const c = m[0];
        if (seen.has(c)) continue; seen.add(c);
        // 접두사가 붙은 실제 클래스(RepairRequestByOperatorWriteService)를 부재로 오판하지 않는다
        if (!stems.some(s => s === c || s.endsWith(c))) v.push(V(rel, 1, `인용 클래스 부재: ${c}`));
      }
    }
    return ok(v);
  },

  L11(ctx) {
    if (!ctx.indexText) return skipped('INDEX.md 가 없다');
    const v = [];
    const begins = (ctx.indexText.match(/ingest-managed:begin/g) || []).length;
    const ends = (ctx.indexText.match(/ingest-managed:end/g) || []).length;
    if (begins !== ends) v.push(V('INDEX.md', 0, `ingest-managed 마커 불균형 (begin ${begins} / end ${ends})`));
    for (const t of ctx.tables) {
      for (const g of t.gaps ?? []) {
        v.push(V('INDEX.md', g + 1, `표 본문 안의 빈 줄 — 렌더러는 여기서 표를 끊는다 (섹션 "${t.section ?? '-'}")`));
      }
      const seen = new Map();
      let prevNum = null, prevWeek = null;
      const desc = sortHint(ctx.indexLines, t) === 'desc';
      // 첫 열이 연번(`#`·No·번호)이면 그건 행 키가 아니다 — 그 열로 중복을 세면 정상 표가 통째로 위반이 된다
      const ki = /^(#|no|번호|num)$/i.test((t.columns[0] ?? '').trim()) && t.columns.length > 1 ? 1 : 0;
      for (const r of t.rows) {
        const key = unescapeCell(r.cells[ki] ?? '').trim();
        if (seen.has(key)) v.push(V('INDEX.md', r.idx + 1, `중복 행 "${key}" (앞 행 line ${seen.get(key)})`));
        else seen.set(key, r.idx + 1);
        if (r.cells.length !== t.columns.length) {
          v.push(V('INDEX.md', r.idx + 1, `셀 수 ${r.cells.length} ≠ 헤더 ${t.columns.length} — "${key}"`));
        }
        r.cells.forEach((c, i) => {
          if (String(c).trim() === '') v.push(V('INDEX.md', r.idx + 1, `빈 셀 (열 "${t.columns[i] ?? i}") — 규약은 "-"`));
        });
        if (desc) {
          const obj = cellsToObj(t.columns, r.cells);
          const week = pick(obj, 'week', '주차');
          const num = Number((key.match(/\d+/) || [])[0]);
          if (Number.isFinite(num)) {
            if (prevNum !== null && week === prevWeek && num > prevNum) {
              v.push(V('INDEX.md', r.idx + 1, `정렬 역전 — ${key} 가 앞 행보다 큼 (같은 ${week || '구간'})`));
            }
            prevNum = num; prevWeek = week;
          }
        }
      }
    }
    return ok(v);
  },

  L12(ctx) {
    if (!ctx.logText) return skipped('LOG.md 가 없다');
    const v = [];
    ctx.logRaw.forEach((body, i) => {
      const t = body.trim();
      if (t === '' || t.startsWith('#') || t.startsWith('>')) return;
      if (!t.startsWith('[')) { v.push(V('LOG.md', i + 1, `엔트리가 "[" 로 시작하지 않음: ${t.slice(0, 60)}`)); return; }
      if (!/^\[(\d{4}-\d{2}-\d{2})(?:\s+[\d:]+)?\s+KST\s+.*?\]/.test(t)) {
        v.push(V('LOG.md', i + 1, `형식 일탈 (기대: [YYYY-MM-DD HH:MM KST MODE KEY phase] …): ${t.slice(0, 60)}`));
      }
    });
    return ok(v);
  },

  L13() { return skipped('git 이력 조회가 필요 — 이 스크립트는 파일 스냅샷만 본다 (스키마상 v2 유보 항목)'); },

  L14() { return skipped('이슈 트래커(원격 MCP) 조회가 필요 — 네트워크 점검은 구현하지 않는다'); },

  L15(ctx) {
    if (!ctx.issueTable) return skipped('INDEX.md 에 이슈 표가 없다');
    const weekFiles = ctx.docFiles.filter(f => /^sprint\/weeks\/.+\.md$/.test(f));
    if (!weekFiles.length) return skipped('sprint/weeks/*.md 가 없다');
    const v = [];
    for (const r of ctx.rows) {
      if (pick(r.obj, 'status', '상태').toLowerCase() !== 'closed') continue;
      const week = pick(r.obj, 'week', '주차').trim().toLowerCase();
      if (!/^w\d+$/.test(week)) continue;
      const f = weekFiles.find(x => basename(x, '.md').toLowerCase() === week);
      if (!f) continue;
      const text = readFileSync(join(ctx.docsDir, f), 'utf8');
      if (!r.keys.some(k => text.includes(k))) v.push(V(f, 1, `${r.rowKey} (closed, ${week}) 미인용`));
    }
    return ok(v);
  },

  L16(ctx) {
    if (!ctx.schema.domains) return skipped('스키마에 synthesis 가 없다 — 검사 제외 (위반 0 과 다름)');
    const v = [];
    const closureLines = ctx.logEntries.filter(e => /closure/i.test(e.phase) || /^KB$/i.test(e.mode) || /kb/i.test(e.phase));
    const since = ctx.synthesisSince
      || ctx.logEntries.filter(e => /(^|\s)wiki=/.test(e.rest)).map(e => e.date).sort()[0]
      || null;
    if (since) {
      for (const e of closureLines) {
        if (e.date < since) continue;                        // synthesis 활성 이전 라인은 분모 밖
        if (!/(^|\s)wiki=/.test(e.rest)) v.push(V('LOG.md', e.line, `${e.key} closure 라인에 wiki= 필드 없음`));
      }
    }
    const byName = new Map(ctx.wikiPages.map(p => [p.name.replace(/\.md$/, ''), p]));
    for (const e of closureLines) {
      const m = e.rest.match(/(^|\s)wiki=([^\s]+)/);
      if (!m || m[2] === '-') continue;
      for (const name of m[2].split(',').map(s => s.trim()).filter(Boolean)) {
        const p = byName.get(name.replace(/\.md$/, ''));
        if (!p) { v.push(V('LOG.md', e.line, `wiki=${name} 페이지가 없다`)); continue; }
        const sources = (p.fm.sources || []).map(String);
        if (e.key !== '-' && !e.key.split(/[+,]/).some(k => sources.includes(k))) {
          v.push(V(p.file, 1, `LOG(line ${e.line}) 는 ${e.key} 통합을 선언하는데 sources 에 없다`));
        }
      }
    }
    for (const p of ctx.wikiPages) {
      if (!ctx.indexText.includes(p.file)) v.push(V(p.file, 1, 'INDEX 위키 카테고리에 미등재 (orphan wiki page)'));
      const d = p.fm.domain;
      if (d && !ctx.schema.domains.includes(d)) v.push(V(p.file, 1, `frontmatter domain "${d}" 가 스키마 domains 에 없다`));
    }
    return ok(v);
  },

  L17(ctx) {
    if (!ctx.schema.domains) return skipped('스키마에 synthesis 가 없다 — 검사 제외 (위반 0 과 다름)');
    if (!ctx.wikiPages.length) return skipped('docs/wiki/*.md 가 없다');
    const v = [];
    const all = [...ctx.adrSet];
    for (const p of ctx.wikiPages) {
      const lines = p.text.split(/\r?\n/);
      const seenAdr = new Set(), seenKey = new Set();
      lines.forEach((l, i) => {
        for (const m of l.matchAll(new RegExp(ctx.schema.adrRe.source, 'g'))) {
          if (seenAdr.has(m[0]) || !ctx.adrPresent) continue;
          seenAdr.add(m[0]);
          if (!ctx.adrSet.has(m[0])) {
            const near = all.map(a => [levenshtein(m[0], a), a]).sort((x, y) => x[0] - y[0]).slice(0, 3).map(x => x[1]);
            v.push(V(p.file, i + 1, `${m[0]} 미존재 (후보: ${near.join(', ') || '-'})`));
          }
        }
        for (const m of l.matchAll(new RegExp(ctx.schema.issueRe.source, 'g'))) {
          if (seenKey.has(m[0]) || !ctx.issueTable) continue;
          seenKey.add(m[0]);
          if (!ctx.keySet.has(m[0])) v.push(V(p.file, i + 1, `${m[0]} 가 INDEX 에 없다`));
        }
      });
      for (const src of (p.fm.sources || [])) {
        const s = String(src).replace(/\s+§.*$/, '').trim();
        if (!s.includes('/')) continue;                       // ADR-N·STD-N·V마이그는 위 토큰 검사 몫
        const cand = [s, `${s}.md`, s.replace(/^docs\//, ''), `${s.replace(/^docs\//, '')}.md`];
        if (!cand.some(c => existsSync(join(ctx.docsDir, c)))) v.push(V(p.file, 1, `sources 경로 부재: ${src}`));
      }
      // 규칙 서술의 출처 결박 (현재 규칙 / 경계·계약 절)
      let inRuleSection = false;
      lines.forEach((l, i) => {
        const h = l.match(/^(#{2,4})\s+(.*)$/);
        if (h) { inRuleSection = /현재 규칙|경계|계약/.test(h[2]); return; }
        if (!inRuleSection) return;
        if (!/^\s*(?:[-*]|\d+\.)\s+/.test(l)) return;
        const body = l.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim();
        if (body.length < 40) return;
        if (/ADR-\d+|V\d+|meeting|NEVER|\b[A-Z]{2,}-\d+\b/.test(body)) return;
        v.push(V(p.file, i + 1, `출처 표기 없는 규칙 서술: ${body.slice(0, 50)}…`));
      });
    }
    return ok(v);
  },
};

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) { f[name] = true; continue; }
    f[name] = val; i++;
  }
  return f;
}

function pad2(n) { return String(n).padStart(2, '0'); }

export function runLint(opt) {
  const ctx = buildContext(opt);
  const wantAll = opt.severity !== 'high';
  const results = [];
  for (const rule of RULES) {
    if (!wantAll && rule.severity !== 'high') continue;
    let r;
    try { r = CHECKS[rule.id](ctx); }
    catch (e) { r = { status: 'SKIPPED', reason: `점검 실행 오류: ${e.message}`, violations: [] }; }
    results.push({ ...rule, ...r, count: r.violations.length });
  }
  const highViolations = results.filter(r => r.severity === 'high' && r.status === 'VIOLATION')
    .reduce((n, r) => n + r.count, 0);
  return { ctx, results, highViolations };
}

function main(argv) {
  const f = parseArgs(argv);
  if (!f.docs || f.docs === true) { console.error('wiki-lint: --docs <docs 디렉토리> 가 필요합니다.'); process.exit(2); }
  const now = new Date();
  const opt = {
    docs: f.docs,
    memory: typeof f.memory === 'string' ? f.memory : null,
    root: typeof f.root === 'string' ? f.root : null,
    severity: f.severity === 'high' ? 'high' : 'all',
    today: typeof f.today === 'string' ? f.today : `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    synthesisSince: typeof f['synthesis-since'] === 'string' ? f['synthesis-since'] : null,
    noCodeIndex: !!f['no-code-index'],
    prefix: typeof f.prefix === 'string' ? f.prefix : null,
  };
  const { ctx, results, highViolations } = runLint(opt);

  if (f.json) {
    console.log(JSON.stringify({
      docs: ctx.docsDir, today: opt.today, severity: opt.severity,
      rules: results.map(r => ({
        id: r.id, name: r.name, severity: r.severity, status: r.status,
        count: r.count, reason: r.reason ?? null,
        example: r.violations[0] ? `${r.violations[0].file}:${r.violations[0].line} ${r.violations[0].message}` : null,
        violations: r.violations.slice(0, 20),
        truncated: r.violations.length > 20,
      })),
      summary: {
        checks: results.length,
        ok: results.filter(r => r.status === 'OK').length,
        violation: results.filter(r => r.status === 'VIOLATION').length,
        skipped: results.filter(r => r.status === 'SKIPPED').length,
        high_violations: highViolations,
      },
      exit: highViolations ? 1 : 0,
    }, null, 2));
  } else {
    console.log(`wiki-lint  docs=${ctx.docsDir}  today=${opt.today}  severity=${opt.severity}`);
    console.log('코드  심각도  상태       건수  예시');
    console.log('----  ------  ---------  ----  --------------------------------------------------');
    for (const r of results) {
      const ex = r.status === 'SKIPPED'
        ? `SKIP 사유: ${r.reason}`
        : (r.violations[0] ? `${r.violations[0].file}:${r.violations[0].line} ${r.violations[0].message}` : '-');
      console.log(
        `${r.id.padEnd(4)}  ${String(r.severity).padEnd(6)}  ${r.status.padEnd(9)}  ` +
        `${String(r.status === 'SKIPPED' ? '-' : r.count).padStart(4)}  ${ex.slice(0, 140)}`
      );
    }
    const s = {
      ok: results.filter(r => r.status === 'OK').length,
      vio: results.filter(r => r.status === 'VIOLATION').length,
      skip: results.filter(r => r.status === 'SKIPPED').length,
    };
    console.log(`\n점검 ${results.length}행 (스키마 규칙 16종 + 폐지된 L04) — OK ${s.ok} · VIOLATION ${s.vio} · SKIPPED ${s.skip} · high 위반 ${highViolations}건`);
    console.log(highViolations ? 'wiki-lint: FAIL (high 위반 존재)' : 'wiki-lint: PASS (high 위반 0)');
  }
  return highViolations ? 1 : 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
