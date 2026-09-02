#!/usr/bin/env node
// memory-index.mjs — Claude Code 자동 메모리 폴더 점검 + 인덱스(MEMORY.md) 한 줄 추가.
//
// 폴더 구조 전제 (Claude Code 자동 메모리 규약):
//   <dir>/MEMORY.md      인덱스 — 매 세션 자동 로드. 줄마다 "- ... [텍스트](파일명.md) ..." 형태의 항목.
//   <dir>/<name>.md       메모리 1건. frontmatter(--- name/description/metadata ---) + 본문.
//                          본문 안에 관련 항목을 [[다른-name]] 형태로 교차 참조할 수 있다.
//   MEMORY.md 가 다른 인덱스형 파일(예: ARCHIVE.md)을 링크하면 그 파일의 링크도 같은 방식으로
//   따라가며 인덱스에 "닿는" 파일 집합을 구한다(BFS) — 즉 "인덱스에 링크가 있다" 는
//   MEMORY.md 에서 [text](*.md) 링크를 몇 단계 거쳐서든 도달 가능함을 뜻한다.
//
// 점검 항목:
//   1) MEMORY.md 글자 수 vs --limit(하드 상한) / --target(목표치)
//   2) 고아 — 폴더의 .md 파일 중 인덱스에서 도달 불가능한 것(MEMORY.md 자신은 제외)
//   3) 깨진 인덱스 링크 — 인덱스(및 인덱스에서 도달한 파일)의 [text](*.md) 링크 중 실제 파일이 없는 것
//   4) 깨진 [[name]] 링크 — 모든 .md 파일 본문의 [[name]] 중 <name>.md 파일이 없는 것
// 종료 코드: limit 초과 또는 깨진 링크(3·4) 가 하나라도 있으면 1. 고아만 있으면 0(정보성).
// 인자 오류·잠금 실패 등 실행 자체의 문제는 2.
//
// --add "<줄>": MEMORY.md 맨 위에 한 줄을 원자적으로 추가한다.
//   - 잠금 파일(.memory-index.lock, 배타적 생성)로 동시 쓰기를 막고, 잠금을 쥔 채로
//     "쓰기 직전에 다시 읽기 → 이미 있으면 스킵(멱등) → tmp 파일에 쓰고 rename" 순서로 처리한다.
//   - 잠금이 오래(기본 2s) 방치돼 있으면 죽은 프로세스의 잔여 잠금으로 보고 회수한다.
//   - Windows 에서는 파일이 막 쓰인 직후 백신·인덱서가 짧게 핸들을 잡아 rename/unlink 가
//     간헐적으로 EPERM/EBUSY 로 실패할 수 있다(실측) — 그 두 오류는 재시도 대상으로 취급한다.
//
// 사용:
//   node scripts/memory-index.mjs --dir <memory dir> [--limit N] [--target N] [--json]
//   node scripts/memory-index.mjs --dir <memory dir> --add "<인덱스 한 줄>" [--json]

import {
  readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync,
  openSync, closeSync, writeSync, unlinkSync,
} from 'node:fs';
import { join, resolve, relative, basename, isAbsolute } from 'node:path';

const DEFAULT_LIMIT = 24000;
const DEFAULT_TARGET = 17000;
const INDEX_NAME = 'MEMORY.md';
const LOCK_STALE_MS = 2000; // 이보다 오래된 잠금은 죽은 프로세스의 잔여물로 보고 회수한다
const LOCK_TIMEOUT_MS = 5000; // LOCK_STALE_MS 보다 커야 회수 분기를 실제로 거친다
const FS_RETRY_ATTEMPTS = 5;
const FS_RETRY_BASE_MS = 25;

function isTransientFsError(err) {
  return err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
}

// Windows 에서 rename/unlink 가 백신·인덱서의 짧은 파일 점유로 간헐적 EPERM/EBUSY 를 낼 수 있어
// 재시도한다. 그 외 오류(예: 대상 없음)는 그대로 던진다.
function withFsRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isTransientFsError(err) || attempt >= FS_RETRY_ATTEMPTS) throw err;
      syncSleep(FS_RETRY_BASE_MS * (attempt + 1));
    }
  }
}

class UsageError extends Error {}

// ---------- CLI 인자 ----------

function parseArgs(argv) {
  const out = { dir: null, limit: DEFAULT_LIMIT, target: DEFAULT_TARGET, add: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dir': out.dir = argv[++i]; break;
      case '--limit': out.limit = Number(argv[++i]); break;
      case '--target': out.target = Number(argv[++i]); break;
      case '--add': out.add = argv[++i]; break;
      case '--json': out.json = true; break;
      case '--help': case '-h': out.help = true; break;
      default: throw new UsageError(`알 수 없는 인자: ${a}`);
    }
  }
  if (out.help) return out;
  if (!out.dir) throw new UsageError('--dir <memory dir> 가 필요합니다.');
  if (!Number.isFinite(out.limit) || out.limit <= 0) throw new UsageError('--limit 은 양수여야 합니다.');
  if (!Number.isFinite(out.target) || out.target <= 0) throw new UsageError('--target 은 양수여야 합니다.');
  if (out.add != null && out.add.includes('\n')) throw new UsageError('--add 값은 한 줄이어야 합니다(개행 불가).');
  return out;
}

const HELP = `memory-index.mjs — 메모리 인덱스(MEMORY.md) 점검 + 한 줄 추가

  node scripts/memory-index.mjs --dir <memory dir> [--limit N] [--target N] [--json]
  node scripts/memory-index.mjs --dir <memory dir> --add "<인덱스 한 줄>" [--json]

종료 코드: 0=이상 없음 · 1=limit 초과 또는 깨진 링크 · 2=실행 오류(인자·잠금 등)`;

// ---------- 경로 유틸 ----------

function toRel(dir, absPath) {
  return relative(dir, absPath).replace(/\\/g, '/');
}

function isLocalMdTarget(target) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return false; // http:, mailto:, file: 등 스킴
  if (target.startsWith('/')) return false; // 절대경로(POSIX)
  if (/^[A-Za-z]:[\\/]/.test(target)) return false; // 절대경로(Windows 드라이브)
  return true;
}

function withinDir(absPath, dir) {
  const rel = relative(dir, absPath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function listMdFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.md$/i.test(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function readTextOrNull(absPath) {
  try { return readFileSync(absPath, 'utf8'); } catch { return null; }
}

// ---------- 링크 추출 ----------

// "[텍스트](대상)" 링크 중 대상이 로컬 .md 파일인 것만 {text, target} 로 반환한다.
// 앵커(#...)는 대상에서 잘라낸다. [[...]] 위키링크는 괄호가 없어 이 정규식과 겹치지 않는다.
function extractMdLinks(content) {
  const out = [];
  const re = /\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(content))) {
    let target = m[2];
    const hash = target.indexOf('#');
    if (hash !== -1) target = target.slice(0, hash);
    if (!isLocalMdTarget(target)) continue;
    if (!/\.md$/i.test(target)) continue;
    out.push({ text: m[1], target });
  }
  return out;
}

// "[[name]]" 위키링크의 name 목록을 반환한다(확장자 없이, name.md 로 해석).
function extractWikiLinks(content) {
  const out = [];
  const re = /\[\[([^\]|#]+)\]\]/g;
  let m;
  while ((m = re.exec(content))) out.push(m[1].trim());
  return out;
}

// ---------- 점검 ----------

// MEMORY.md 를 뿌리로 [text](*.md) 링크를 BFS 로 따라가며 도달 가능한 파일명 집합과
// (인덱스 체인 안에서) 존재하지 않는 파일을 가리키는 링크 목록을 구한다.
function buildReachability(dir, indexAbsPath) {
  const reachableNames = new Set();
  const brokenIndexLinks = [];
  const queue = [indexAbsPath];
  const queued = new Set([indexAbsPath]);
  while (queue.length) {
    const file = queue.shift();
    const content = readTextOrNull(file);
    if (content == null) continue;
    for (const { target } of extractMdLinks(content)) {
      const abs = resolve(dir, target);
      const ok = withinDir(abs, dir) && existsSync(abs) && statSync(abs).isFile();
      if (!ok) {
        brokenIndexLinks.push({ source: toRel(dir, file), target });
        continue;
      }
      reachableNames.add(basename(abs));
      if (!queued.has(abs)) { queued.add(abs); queue.push(abs); }
    }
  }
  return { reachableNames, brokenIndexLinks };
}

function checkWikiLinks(dir, mdFiles) {
  const broken = [];
  for (const name of mdFiles) {
    const content = readTextOrNull(join(dir, name));
    if (content == null) continue;
    for (const wname of extractWikiLinks(content)) {
      const expected = /\.md$/i.test(wname) ? wname : `${wname}.md`;
      if (!existsSync(join(dir, expected))) broken.push({ source: name, name: wname, expected });
    }
  }
  return broken;
}

function runCheck(dir, limit, target) {
  const indexAbsPath = join(dir, INDEX_NAME);
  const indexExists = existsSync(indexAbsPath) && statSync(indexAbsPath).isFile();
  const indexContent = indexExists ? readFileSync(indexAbsPath, 'utf8') : '';
  const chars = Array.from(indexContent).length; // 코드포인트 기준 글자 수(서로게이트 페어 포함 이모지 정확 계산)

  const mdFiles = listMdFiles(dir);
  const { reachableNames, brokenIndexLinks } = indexExists
    ? buildReachability(dir, indexAbsPath)
    : { reachableNames: new Set(), brokenIndexLinks: [] };
  const orphans = mdFiles.filter((name) => name !== INDEX_NAME && !reachableNames.has(name));
  const brokenWikiLinks = checkWikiLinks(dir, mdFiles);

  const overLimit = chars > limit;
  const overTarget = chars > target;
  const ok = !overLimit && brokenIndexLinks.length === 0 && brokenWikiLinks.length === 0;

  return {
    dir,
    index_file: INDEX_NAME,
    index_exists: indexExists,
    size: { chars, limit, target, over_limit: overLimit, over_target: overTarget },
    files: { total_md: mdFiles.length, memory_files: mdFiles.filter((n) => n !== INDEX_NAME).length },
    orphans,
    broken_index_links: brokenIndexLinks,
    broken_wiki_links: brokenWikiLinks,
    ok,
  };
}

// ---------- --add (원자적 쓰기) ----------

function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(dir) {
  const lockPath = join(dir, '.memory-index.lock');
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return lockPath;
    } catch (err) {
      const busy = err.code === 'EEXIST' || isTransientFsError(err);
      if (!busy) throw err;
      // existsSync 로 미리 보지 않고 바로 stat 을 시도한다 — 그사이 잠금 보유자가 release(unlink)
      // 하면 statSync 가 ENOENT 로 던지므로, 그건 "잠금이 막 풀렸다"로 보고 즉시 재시도한다.
      let st = null;
      try { st = statSync(lockPath); } catch { /* 방금 release 됐다 — 다음 루프에서 openSync 재시도 */ }
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        try { unlinkSync(lockPath); } catch { /* 다른 프로세스가 먼저 회수했을 수 있다 */ }
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`memory-index: 잠금 획득 실패(${LOCK_TIMEOUT_MS}ms 초과, 마지막 오류 ${err.code}) — ${lockPath}`);
      }
      syncSleep(15 + Math.floor(Math.random() * 20));
    }
  }
}

function releaseLock(lockPath) {
  try { withFsRetry(() => unlinkSync(lockPath)); } catch { /* 이미 없으면 무시 — 다음 획득자가 stale 로 회수 가능 */ }
}

// 잠금을 쥔 채로 "다시 읽기 → 중복 확인 → tmp 에 쓰기 → rename" 을 수행한다.
// 동시에 --add 를 호출한 다른 프로세스가 있어도 이 사이엔 끼어들 수 없다.
function addLine(dir, line) {
  const indexAbsPath = join(dir, INDEX_NAME);
  const lockPath = acquireLock(dir);
  try {
    const before = existsSync(indexAbsPath) ? readFileSync(indexAbsPath, 'utf8') : '';
    const existingLines = before.length ? before.split('\n') : [];
    const already = existingLines.some((l) => l.replace(/\r$/, '') === line);
    if (already) return { added: false, reason: 'duplicate' };

    const after = `${line}\n${before}`;
    const tmpPath = join(dir, `.${INDEX_NAME}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmpPath, after, 'utf8');
    try {
      // 같은 볼륨 내 rename = 원자적 치환. Windows 는 막 쓰인 파일을 백신 등이 짧게 점유해
      // 간헐적 EPERM 을 낼 수 있어 재시도한다(실측 — 잠금은 정상 동작했는데 이 단계에서만 실패했었다).
      withFsRetry(() => renameSync(tmpPath, indexAbsPath));
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* tmp 잔여물 정리 실패는 무시 — 원 오류를 던진다 */ }
      throw err;
    }
    return { added: true };
  } finally {
    releaseLock(lockPath);
  }
}

// ---------- 출력 ----------

function printHuman(report) {
  const s = report.size;
  console.log(`memory-index: ${report.dir}`);
  if (!report.index_exists) console.log(`  ${report.index_file} 없음 — 빈 인덱스로 취급`);
  console.log(
    `  ${report.index_file} 글자수 ${s.chars} (limit ${s.limit}, target ${s.target})`
    + (s.over_limit ? ' — LIMIT 초과' : s.over_target ? ' — target 초과(limit 이내)' : ' — 이내'),
  );
  console.log(`  메모리 파일 ${report.files.memory_files}개 중 고아 ${report.orphans.length}건`);
  for (const f of report.orphans) console.log(`    - ${f}`);
  console.log(`  깨진 인덱스 링크 ${report.broken_index_links.length}건`);
  for (const l of report.broken_index_links) console.log(`    - ${l.source} -> ${l.target}`);
  console.log(`  깨진 [[name]] 링크 ${report.broken_wiki_links.length}건`);
  for (const l of report.broken_wiki_links) console.log(`    - ${l.source} -> [[${l.name}]] (${l.expected} 없음)`);
  console.log(report.ok ? '  RESULT: PASS' : '  RESULT: FAIL');
}

// ---------- main ----------

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`memory-index: ${err.message}\n\n${HELP}`);
      process.exit(2);
    }
    throw err;
  }
  if (args.help) { console.log(HELP); process.exit(0); }

  const dir = resolve(args.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`memory-index: 디렉터리가 없습니다 — ${dir}`);
    process.exit(2);
  }

  let addResult = null;
  if (args.add != null) {
    try {
      addResult = addLine(dir, args.add);
    } catch (err) {
      console.error(`memory-index: --add 실패 — ${err.message}`);
      process.exit(2);
    }
  }

  const report = runCheck(dir, args.limit, args.target);

  if (args.json) {
    console.log(JSON.stringify(addResult ? { add: addResult, ...report } : report, null, 2));
  } else {
    if (addResult) {
      console.log(addResult.added ? 'memory-index: 추가됨' : `memory-index: 추가 안 함(${addResult.reason})`);
    }
    printHuman(report);
  }
  process.exit(report.ok ? 0 : 1);
}

main();
