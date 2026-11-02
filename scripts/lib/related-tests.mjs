// related-tests.mjs — 관련 테스트 게이트(`gate.mjs --related`)가 스택마다 돌릴 테스트를 고른다.
//
// 왜: 이슈마다 전체 테스트를 돌리면 1만 건짜리 스위트가 한 시간씩 걸리고, 부하·공유 자원 때문에 이슈와 무관하게 깨진다
//     (2026-11 stanley-cs STD-1900: 권한 3줄 변경이 전량 게이트 6회 · 15시간 동안 머지되지 못했다 — 실패는 전부 환경 요인).
//     업계 관행(Google TAP presubmit · Gradle Predictive Test Selection · CI "커밋 단계 10분")도 커밋 전에는 영향받는 테스트만,
//     전체는 머지 뒤 한 번이다. 전체 스위트는 `gate.mjs --main`(기본 브랜치에서 여러 이슈를 머지한 뒤 1회)이 돈다.
//
// 선택 규칙(어댑터 = stacks.<name>.dod_tests.adapter):
//   gradle-junit  ① 바뀐 테스트 파일(이름이 Test/Tests/IT 로 끝남) 그 자체 ② 바뀐 소스 파일(.java/.kt)의 단순 클래스명이
//                 단어 단위로 등장하는 테스트 파일. FQCN 은 테스트 루트 기준 경로에서 만든다. `--tests '<FQCN>'` 로 돈다.
//   vitest        `vitest related --run <바뀐 파일…>` — vitest 가 import 그래프로 고른다(바뀐 spec 파일 자신도 포함).
// 전체로 넘기는 경우(mode=full): 바뀐 파일이 fallback_full glob 에 걸림(빌드 설정·의존성·공용 리소스) · 선택이 max_selected 초과.
// 고를 것이 없으면 mode=none — 테스트 단계는 SKIPPED 로 남고 요약에 "관련 테스트 0" 이 보인다("위반 0" 과 "검사 0" 을 섞지 않는다).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename, extname } from 'node:path';

const fwd = p => String(p).replace(/\\/g, '/');
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const RELATED_DEFAULTS = Object.freeze({
  'gradle-junit': {
    test_roots: ['src/test/java', 'src/test/kotlin'],
    fallback_full: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'gradle/**', 'src/main/resources/**', 'src/test/resources/**'],
    max_selected: 250, // Windows 명령줄 32K 안 — FQCN 평균 70자 × 250 ≈ 18K
  },
  vitest: {
    fallback_full: ['package.json', 'package-lock.json', 'vite.config.*', 'vitest.config.*', 'vitest.setup.*', 'tests/setup*', 'src/test/setup*'],
    max_selected: 2000,
  },
});

const TEST_NAME = /(Test|Tests|IT|TestCase)\.(java|kt)$/;
const SRC_EXT = new Set(['.java', '.kt']);

function globRx(g) {
  let s = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { s += '.*'; i++; if (g[i + 1] === '/') i++; } else s += '[^/]*'; }
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${s}$`);
}
const matchesAnyGlob = (p, globs) => globs.some(g => globRx(g).test(p));

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/** 테스트 루트 기준 경로 → FQCN (com/x/FooTest.java → com.x.FooTest) */
export function fqcnOf(relToRoot) {
  return fwd(relToRoot).replace(/\.(java|kt)$/, '').split('/').join('.');
}

/**
 * @param {object} a
 * @param {'gradle-junit'|'vitest'} a.adapter
 * @param {string} a.stackDir  스택 디렉터리 절대 경로
 * @param {string[]} a.files   스택 디렉터리 기준 경로 — 이 브랜치가 바꾼 파일(삭제 포함)
 * @param {object} [a.related] harness.json stacks.<name>.related (덮어쓰기)
 * @returns {{mode:'selected'|'full'|'none', select:string[], reason:string}}
 */
export function selectRelated({ adapter, stackDir, files, related = {} }) {
  const d = RELATED_DEFAULTS[adapter];
  if (!d) throw new Error(`관련 테스트 선택을 모르는 어댑터: ${adapter} (지원: ${Object.keys(RELATED_DEFAULTS).join(', ')})`);
  const conf = { ...d, ...related };
  const rel = files.map(fwd);
  const global = rel.filter(p => matchesAnyGlob(p, conf.fallback_full));
  if (global.length) return { mode: 'full', select: [], reason: `전역 파일 변경 → 전체 테스트: ${global.slice(0, 5).join(', ')}` };

  if (adapter === 'vitest') {
    const live = rel.filter(p => existsSync(join(stackDir, p)));
    if (!live.length) return { mode: 'none', select: [], reason: '바뀐 파일이 없다(삭제만)' };
    if (live.length > conf.max_selected) return { mode: 'full', select: [], reason: `바뀐 파일 ${live.length}개 > ${conf.max_selected} → 전체 테스트` };
    return { mode: 'selected', select: live, reason: `vitest related — 바뀐 파일 ${live.length}개의 import 그래프` };
  }

  // gradle-junit
  const roots = conf.test_roots;
  const inRoot = p => roots.find(r => p.startsWith(r.replace(/\/$/, '') + '/'));
  const picked = new Set();
  const names = new Set();
  for (const p of rel) {
    if (!SRC_EXT.has(extname(p))) continue;
    const root = inRoot(p);
    if (root && TEST_NAME.test(p)) {
      if (existsSync(join(stackDir, p))) picked.add(fqcnOf(p.slice(root.replace(/\/$/, '').length + 1)));
      continue;
    }
    names.add(basename(p, extname(p))); // 소스 또는 테스트 헬퍼 — 이 이름을 쓰는 테스트를 찾는다
  }
  if (names.size) {
    const rxs = [...names].map(n => [n, new RegExp(`\\b${n.replace(/[$]/g, '\\$')}\\b`)]);
    for (const r of roots) {
      const abs = join(stackDir, r);
      for (const f of walk(abs)) {
        const relF = fwd(relative(abs, f));
        if (!TEST_NAME.test(relF)) continue;
        let txt; try { txt = readFileSync(f, 'utf8'); } catch { continue; }
        if (rxs.some(([, x]) => x.test(txt))) picked.add(fqcnOf(relF));
      }
    }
  }
  const select = [...picked].sort();
  if (!select.length) return { mode: 'none', select, reason: names.size ? `바뀐 클래스 ${[...names].slice(0, 5).join(', ')} 를 쓰는 테스트가 없다` : '바뀐 소스·테스트 파일이 없다' };
  if (select.length > conf.max_selected) return { mode: 'full', select: [], reason: `관련 테스트 ${select.length}개 > ${conf.max_selected} → 전체 테스트` };
  return { mode: 'selected', select, reason: `관련 테스트 클래스 ${select.length}개(바뀐 클래스 ${names.size}개 참조 + 바뀐 테스트)` };
}

/** 선택을 명령 한 줄로. vitest 는 `vitest run` 을 `vitest related --run` 으로 바꾼다(그 꼴이 아니면 related.command 가 필요). */
export function relatedCommand({ adapter, run, select, related = {} }) {
  if (related.command) return related.command.replace('{files}', select.map(shq).join(' '));
  if (adapter === 'gradle-junit') return `${run} ${select.map(p => `--tests ${shq(p)}`).join(' ')}`;
  if (adapter === 'vitest') {
    if (!/\bvitest\s+run\b/.test(run)) throw new Error(`dod_tests.run(${run}) 에 "vitest run" 이 없어 related 명령을 만들 수 없다 — stacks.<name>.related.command 에 "{files}" 자리를 넣어 줄 것`);
    return `${run.replace(/\bvitest\s+run\b/, 'vitest related --run --passWithNoTests')} ${select.map(shq).join(' ')}`;
  }
  throw new Error(`알 수 없는 어댑터: ${adapter}`);
}
