#!/usr/bin/env node
// wiki-row.mjs — 마크다운 표 행 upsert + 이벤트 로그 append (결정론·멱등).
//
// 열 이름은 대상 표의 헤더 행에서 학습한다(하드코딩 없음). 같은 키가 있으면 갱신, 없으면 추가.
// 쓰기는 tmp + rename 원자 쓰기이고, 다른 행·주변 텍스트·줄끝은 그대로 보존한다.
//
// 사용:
//   node scripts/wiki-row.mjs --index <표 파일> --key <KEY> [--key-col <열이름>] \
//        --set "<열>=<값>" [--set ...] [--section "<헤딩 부분문자열>"] [--insert top|end|auto] \
//        [--empty <빈칸 표기>] [--log <로그파일> --event "<한 줄>" [--mode INGEST] [--phase forecast] \
//         [--date YYYY-MM-DD] [--time HH:MM]] [--dry-run] [--json]
//
// 종료 코드: 0 정상 · 1 사용자 오류(표 모호·모르는 열·키 없음+--set 없음) · 2 파일 없음.

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 표 파싱 (wiki-lint.mjs 도 이 함수들을 재사용한다) ────────────────────────

/** 줄 끝(\n·\r\n)을 붙인 채로 자른다 — 혼합 줄끝 파일도 원형 보존된다. */
export function splitKeepEol(text) {
  return text.length ? text.split(/(?<=\n)/) : [];
}

/** 줄 끝을 뗀 본문. */
export function lineBody(raw) {
  return raw.replace(/\r?\n$/, '');
}

/** 줄 끝 문자열('' | '\n' | '\r\n'). */
export function lineEol(raw) {
  const m = raw.match(/\r?\n$/);
  return m ? m[0] : '';
}

/** `| a | b\|c |` → ['a', 'b\\|c'] (이스케이프된 파이프는 셀 경계가 아니다). */
export function splitCells(body) {
  const s = body.trim();
  if (!s.startsWith('|')) return null;
  const cells = [];
  let cur = '';
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') cells.push(cur); // 끝 파이프가 없는 행도 받는다
  return cells.map(c => c.trim());
}

export function unescapeCell(s) {
  return String(s).replace(/\\\|/g, '|');
}

export function escapeCell(s) {
  return String(s).replace(/\r?\n/g, '<br>').replace(/(?<!\\)\|/g, '\\|');
}

function isSeparatorRow(body) {
  const t = body.trim();
  return /^\|[\s:|-]+\|?$/.test(t) && t.includes('-');
}

/**
 * 파일 안의 모든 마크다운 표를 찾는다.
 *
 * ⚠ 본문 한가운데의 빈 줄은 표를 끊지 않는다 — 실물 INDEX 에 그런 줄이 있고(마크다운 렌더러는
 * 거기서 표를 끊는다 = 그 자체가 별도 결함), 끊어 읽으면 그 아래 수백 행이 통째로 분모 밖이 되어
 * "그 키의 행이 없다" 며 중복 행을 새로 만든다. 대신 그 위치를 gaps 로 돌려 lint 가 잡게 한다.
 * 빈 줄 다음이 "헤더 + 구분선" 이면 진짜 새 표이므로 거기서 끊는다.
 *
 * @returns [{ section, headingIdx, headerIdx, sepIdx, bodyStart, bodyEnd, columns, rows, gaps }]
 */
export function parseTables(rawLines) {
  const tables = [];
  let section = null;
  let headingIdx = -1;
  for (let i = 0; i < rawLines.length; i++) {
    const body = lineBody(rawLines[i]);
    const h = body.match(/^(#{1,6})\s+(.*)$/);
    if (h) { section = h[2].trim(); headingIdx = i; continue; }
    if (!body.trim().startsWith('|')) continue;
    if (i + 1 >= rawLines.length || !isSeparatorRow(lineBody(rawLines[i + 1]))) continue;
    const columns = (splitCells(body) || []).map(c => unescapeCell(c));
    const rows = [];
    const gaps = [];
    let j = i + 2;
    for (; j < rawLines.length; j++) {
      const b = lineBody(rawLines[j]);
      const t = b.trim();
      if (t.startsWith('|')) { rows.push({ idx: j, cells: splitCells(b) || [] }); continue; }
      if (t !== '') break;
      let k = j + 1;
      while (k < rawLines.length && lineBody(rawLines[k]).trim() === '') k++;
      if (k >= rawLines.length) break;
      if (!lineBody(rawLines[k]).trim().startsWith('|')) break;
      if (isSeparatorRow(k + 1 < rawLines.length ? lineBody(rawLines[k + 1]) : '')) break; // 새 표의 헤더
      for (let g = j; g < k; g++) gaps.push(g);
      j = k - 1;
    }
    const bodyEnd = rows.length ? rows[rows.length - 1].idx : i + 1;
    tables.push({
      section, headingIdx, headerIdx: i, sepIdx: i + 1,
      bodyStart: i + 2, bodyEnd, columns, rows, gaps,
    });
    i = Math.max(j - 1, bodyEnd);
  }
  return tables;
}

/** 섹션 헤딩 직전~표 사이의 안내문에서 정렬 규약을 읽는다(없으면 null). */
export function sortHint(rawLines, table) {
  if (table.headingIdx < 0) return null;
  let text = '';
  for (let i = table.headingIdx; i < table.headerIdx; i++) text += lineBody(rawLines[i]) + '\n';
  if (!/정렬|sort/i.test(text)) return null;
  if (/내림차순|역순|desc/i.test(text)) return 'desc';
  if (/오름차순|asc/i.test(text)) return 'asc';
  return null;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { set: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out.flags._ = (out.flags._ || []).concat(a); continue; }
    const name = a.slice(2);
    if (name === 'dry-run' || name === 'json') { out.flags[name] = true; continue; }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) { out.flags[name] = true; continue; }
    i++;
    if (name === 'set') out.set.push(val); else out.flags[name] = val;
  }
  return out;
}

function fail(msg, code = 1) {
  console.error(`wiki-row: ${msg}`);
  process.exit(code);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function today(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function nowHm(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** tmp + rename 원자 쓰기. */
export function atomicWrite(file, text) {
  const tmp = join(dirname(resolve(file)), `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    if (existsSync(tmp)) { try { unlinkSync(tmp); } catch { /* 정리 실패는 무시 */ } }
    throw e;
  }
}

/** 표 1개를 고른다. 애매하면 사용법을 알려주고 exit 1. */
function pickTable(tables, sectionArg, key, keyColArg) {
  const holdsKey = t => {
    const ki = keyColArg
      ? t.columns.findIndex(c => c.toLowerCase() === String(keyColArg).toLowerCase())
      : 0;
    return ki >= 0 && t.rows.some(r => unescapeCell(r.cells[ki] ?? '') === key);
  };
  if (tables.length === 0) fail('마크다운 표를 찾지 못했습니다.');
  if (!sectionArg) {
    if (tables.length === 1) return tables[0];
    console.error('wiki-row: 파일에 표가 여러 개입니다 — --section 으로 지정하세요.');
    for (const t of tables) {
      console.error(`  --section "${t.section ?? '(헤딩 없음)'}"   열: ${t.columns.join(', ')}`);
    }
    process.exit(1);
  }
  const needle = sectionArg.toLowerCase();
  const hit = tables.filter(t => (t.section ?? '').toLowerCase().includes(needle));
  if (hit.length === 0) {
    console.error(`wiki-row: "${sectionArg}" 에 해당하는 섹션이 없습니다. 후보:`);
    for (const t of tables) console.error(`  ${t.section ?? '(헤딩 없음)'}`);
    process.exit(1);
  }
  const sections = [...new Set(hit.map(t => t.section))];
  if (sections.length > 1) {
    console.error(`wiki-row: "${sectionArg}" 가 섹션 ${sections.length}개에 걸립니다 — 더 구체적으로 주세요.`);
    for (const s of sections) console.error(`  ${s}`);
    process.exit(1);
  }
  // 한 섹션에 표가 여럿이면, 그 키를 이미 가진 표를 우선한다 (첫 표만 보면 중복 행을 만든다)
  return hit.find(holdsKey) ?? hit[0];
}

function buildRowLine(cells) {
  return `| ${cells.join(' | ')} |`;
}

function appendLog(logPath, line, dryRun) {
  if (!existsSync(logPath)) fail(`로그 파일이 없습니다: ${logPath}`, 2);
  const text = readFileSync(logPath, 'utf8');
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const already = splitKeepEol(text).some(r => lineBody(r) === line);
  if (already) return { action: 'duplicate-skipped', line };
  if (dryRun) return { action: 'would-append', line };
  const needsNl = text.length > 0 && !/\n$/.test(text);
  atomicWrite(logPath, text + (needsNl ? eol : '') + line + eol);
  return { action: 'appended', line };
}

function main(argv) {
  const { set, flags } = parseArgs(argv);
  const indexPath = flags.index;
  const key = flags.key;
  if (!indexPath || typeof indexPath !== 'string') fail('--index <파일> 이 필요합니다.');
  if (!key || typeof key !== 'string') fail('--key <KEY> 가 필요합니다.');
  if (!existsSync(indexPath)) fail(`파일이 없습니다: ${indexPath}`, 2);

  const text = readFileSync(indexPath, 'utf8');
  const rawLines = splitKeepEol(text);
  const tables = parseTables(rawLines);
  const table = pickTable(
    tables,
    typeof flags.section === 'string' ? flags.section : null,
    key,
    typeof flags['key-col'] === 'string' ? flags['key-col'] : null,
  );

  // 열 학습 — 헤더 행이 SSoT
  const columns = table.columns;
  const keyCol = typeof flags['key-col'] === 'string' ? flags['key-col'] : columns[0];
  const keyIdx = columns.findIndex(c => c === keyCol || c.toLowerCase() === String(keyCol).toLowerCase());
  if (keyIdx < 0) fail(`키 열 "${keyCol}" 이 표에 없습니다. 열: ${columns.join(', ')}`);

  // --set 파싱 + 모르는 열 거부
  const updates = [];
  for (const s of set) {
    const eq = s.indexOf('=');
    if (eq <= 0) fail(`--set 형식은 "열=값" 입니다: ${s}`);
    const col = s.slice(0, eq).trim();
    const val = s.slice(eq + 1);
    const ci = columns.findIndex(c => c === col || c.toLowerCase() === col.toLowerCase());
    if (ci < 0) fail(`모르는 열 "${col}". 이 표의 열: ${columns.join(', ')}`);
    updates.push({ col: columns[ci], idx: ci, value: val });
  }

  const empty = typeof flags.empty === 'string' ? flags.empty : '-';
  const found = table.rows.find(r => unescapeCell(r.cells[keyIdx] ?? '') === key);

  let action, lineNo, before = null, after;
  const out = rawLines.slice();

  if (found) {
    const cells = columns.map((_, i) => found.cells[i] ?? empty);
    for (const u of updates) cells[u.idx] = escapeCell(u.value);
    cells[keyIdx] = escapeCell(key);
    before = lineBody(rawLines[found.idx]);
    after = buildRowLine(cells);
    action = before === after ? 'unchanged' : 'updated';
    lineNo = found.idx + 1;
    if (action === 'updated') out[found.idx] = after + lineEol(rawLines[found.idx]);
  } else {
    if (updates.length === 0) fail(`키 "${key}" 행이 없고 --set 도 없어 새 행을 만들 수 없습니다.`);
    const cells = columns.map(() => empty);
    for (const u of updates) cells[u.idx] = escapeCell(u.value);
    cells[keyIdx] = escapeCell(key);
    after = buildRowLine(cells);
    action = 'inserted';

    let mode = typeof flags.insert === 'string' ? flags.insert : 'auto';
    if (mode === 'auto') mode = sortHint(rawLines, table) === 'desc' ? 'top' : 'end';
    const anchor = mode === 'top' ? table.sepIdx : (table.bodyEnd >= table.bodyStart ? table.bodyEnd : table.sepIdx);
    const eol = lineEol(rawLines[anchor]) || '\n';
    if (!lineEol(rawLines[anchor])) out[anchor] = rawLines[anchor] + eol; // 파일 끝 줄바꿈 보정
    out.splice(anchor + 1, 0, after + eol);
    lineNo = anchor + 2;
  }

  const newText = out.join('');
  const changed = newText !== text;
  if (changed && !flags['dry-run']) atomicWrite(indexPath, newText);

  // 이벤트 로그 append
  let log = null;
  if (flags.log) {
    if (typeof flags.event !== 'string' || !flags.event.trim()) fail('--log 와 함께 --event "<한 줄>" 이 필요합니다.');
    const ev = flags.event.trim();
    let line;
    if (ev.startsWith('[')) {
      line = ev; // 이미 완성된 라인
    } else {
      const d = typeof flags.date === 'string' ? flags.date : today();
      const t = typeof flags.time === 'string' ? flags.time : nowHm();
      const mode = typeof flags.mode === 'string' ? flags.mode : 'INGEST';
      const phase = typeof flags.phase === 'string' ? ` ${flags.phase}` : '';
      line = `[${d} ${t} KST ${mode} ${key}${phase}] ${ev}`;
    }
    log = appendLog(flags.log, line, !!flags['dry-run']);
  }

  const result = {
    index: indexPath,
    section: table.section,
    columns,
    key_col: columns[keyIdx],
    key,
    action,
    line: lineNo,
    dry_run: !!flags['dry-run'],
    before,
    after,
    log,
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const verb = { inserted: '추가', updated: '갱신', unchanged: '변경 없음' }[action];
    console.log(`wiki-row: ${indexPath} [${table.section ?? '-'}] ${key} — ${verb}${flags['dry-run'] ? ' (dry-run)' : ''} (line ${lineNo})`);
    if (action !== 'unchanged') console.log(`  ${after}`);
    if (log) console.log(`  log: ${log.action} — ${log.line}`);
  }
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
