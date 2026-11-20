// plan-check.mjs — 계획(사이드카 {guides, touched, lanes, dod} + 가이드 본문)에서 **기계로 볼 수 있는 것**만 본다.
// 왜: 모델 검증 레인이 보던 것 가운데 글자 대조·집합 비교로 끝나는 것(0건 매치 select · min_tests 누락 · 레인 소유 겹침 ·
//     요구↔DoD 대응)은 스크립트가 보면 몇 초이고 매번 같다. 모델은 기계로 못 보는 것(결정과의 모순·범위 판단)에만 쓴다.
// 반환 { errors, warnings, summary } — errors 가 하나라도 있으면 issue-set 이 계획을 반영하지 않는다. msg 한 줄이 곧 사용자 안내다.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { matchesAny, underStack } from './config.mjs';
import { git } from './git.mjs';
import { gradleMatches, vitestMatches } from './dod-tests.mjs';
import { RELATED_DEFAULTS, fqcnOf } from './related-tests.mjs';
import { laneName, LANE_NAME_BAD, herdrImplementOn, laneRunner, laneRunnerWhy } from './lanes.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
const isGlob = p => /[*?[{]/.test(p);

/** 사람 결정 없이 드라이버가 고른 해석인가 — issue-set --assume 기록이거나 무인 진행의 `(unattended)` 답 */
export function isAssumption(d) {
  return !!d && (d.assumed === true || /\(unattended\)\s*$/.test(String(d.a ?? '')));
}
/** 사람이 확인하는 DoD 항목인가 — 게이트(gate.mjs)와 같은 기준: human 이거나, 자동으로 잴 것(probe·tests)이 하나도 없다 */
export function isHumanDod(d) {
  return !!d && (d.human === true || (!d.probe && !d.tests));
}

// 알려진 테스트 러너 — 건수를 찍으므로 min_tests 가 의미 있고, 없으면 0건 실행이 초록이 된다
const RUNNERS = [
  /\bgradlew?(?:\.bat)?\b[^|;&]*(?:^|[\s:])test\b/,
  /\bmvnw?(?:\.cmd)?\b[^|;&]*\btest\b/,
  /\bvitest\b(?![.\w-])/, /\bjest\b(?![.\w-])/, /\bpytest\b(?![.\w-])/, // vitest.config.ts 같은 파일 이름은 러너 호출이 아니다
  /\bgo\s+test\b/,
  /\bnpm\s+(?:run\s+)?test\b/,
  /\bnode\b[^|;&]*\s--test\b/,
];
/** probe 가 테스트 러너를 부르는가(PROBE_MIN·MIN_ON_SENTINEL 이 같은 판정을 쓴다) */
export function callsTestRunner(probe) { return RUNNERS.some(rx => rx.test(String(probe ?? ''))); }

// 커밋 전 트리에서 원복하면 수정 자체가 지워지는 명령들
const RESTORE_RX = /\bgit\s+(?:checkout\b[^|;&]*\s--(?:\s|$)|restore\b|stash\b|reset\s+--hard\b)/;

/** 가이드 본문에서 제목이 headRx 로 시작하는 `## ` 절들의 본문(다음 `#`/`##` 제목 전까지)을 이어 붙인다 — 가이드가 여러 장이면 같은 절이 여러 번 나온다 */
function sections(text, headRx) {
  const out = [];
  let cur = null, fence = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence; // 코드 펜스 안의 `# 주석` 줄은 제목이 아니다
    else if (!fence && /^#{1,2}\s/.test(line)) { cur = headRx.test(line) ? [] : null; if (cur) out.push(cur); continue; }
    if (cur) cur.push(line);
  }
  return out.map(l => l.join('\n')).join('\n');
}
const idsIn = (text, rx) => [...new Set(String(text).match(rx) ?? [])];

/** plan.guides 의 경로마다 `<경로>.draft` 를 먼저, 없으면 확정본을 읽어 이어 붙인다. 하나도 없으면 null */
export function loadGuideText({ root, plan }) {
  const parts = [];
  for (const rel of Object.values(plan?.guides ?? {})) {
    if (typeof rel !== 'string' || !rel) continue;
    for (const p of [join(root, `${rel}.draft`), join(root, rel)]) {
      if (existsSync(p)) { parts.push(readFileSync(p, 'utf8')); break; }
    }
  }
  return parts.length ? parts.join('\n') : null;
}

/** 러너가 실제로 수집하는 테스트 후보(스택 dir 기준) — gradle 은 test_roots 안 .java/.kt 의 FQCN, vitest 는 *.test.* / *.spec.* 파일 */
function testCandidates(adapter, stack, files) {
  const rel = underStack(files, stack.dir);
  if (adapter === 'gradle-junit') {
    const roots = (stack.related?.test_roots ?? RELATED_DEFAULTS['gradle-junit'].test_roots).map(r => fwd(r).replace(/\/$/, ''));
    const out = [];
    for (const p of rel) {
      if (!/\.(java|kt)$/.test(p)) continue;
      // 다중 모듈이면 test_roots 가 모듈 폴더 아래에 있다(module-a/src/test/java/…) — 경로 어디서든 폴더 경계로 찾는다
      for (const r of roots) {
        const at = p.startsWith(r + '/') ? 0 : p.indexOf(`/${r}/`) + 1;
        if (at > 0 || p.startsWith(r + '/')) { out.push(fqcnOf(p.slice(at + r.length + 1))); break; }
      }
    }
    return out;
  }
  if (adapter === 'vitest') return rel.filter(p => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p));
  return null;
}

/**
 * @param {{cfg:object, root:string, state?:object|null, plan:{guides?,touched?,lanes?,dod?}, guideText?:string|null, herdrInside?:boolean|null}} a
 *   herdrInside — 이 세션이 Herdr 안인가(lib/herdr.mjs herdrEnv().inside). 모르면 null — 그때는 Herdr 여부에 기대는 점검(LANE_WORKTREE)을 하지 않는다
 * @returns {{errors:{code,id?,msg}[], warnings:{code,id?,msg}[], summary:object}}
 */
export function checkPlan({ cfg, root, state = null, plan, guideText = null, herdrInside = null }) {
  const errors = [], warnings = [];
  const err = (code, msg, id) => errors.push(id != null ? { code, id, msg } : { code, msg });
  const warn = (code, msg, id) => warnings.push(id != null ? { code, id, msg } : { code, msg });

  const dod = Array.isArray(plan?.dod) ? plan.dod.filter(d => d && typeof d === 'object') : [];
  const touched = Array.isArray(plan?.touched) ? plan.touched.filter(t => typeof t === 'string' && t).map(fwd) : [];
  const lanes = Array.isArray(plan?.lanes) ? plan.lanes.filter(l => l && typeof l === 'object') : [];

  // ---- 비어 있음 · id ----
  if (!dod.length) err('PLAN_EMPTY', 'dod 가 비었다 — 검증할 완료 조건을 1건 이상 넣을 것');
  if (!touched.length) err('PLAN_EMPTY', 'touched 가 비었다 — 이번에 수정·추가할 파일 경로를 넣을 것');
  const seen = new Set();
  dod.forEach((d, i) => {
    if (typeof d.id !== 'string' || !d.id) { err('DOD_ID', `dod[${i}] 에 id 가 없다 — D1, D2 … 꼴로 붙일 것`); return; }
    if (seen.has(d.id)) err('DOD_ID', `dod id "${d.id}" 가 중복이다 — 항목마다 다른 id 를 쓸 것`, d.id);
    seen.add(d.id);
  });

  // ---- tests 항목 ----
  let tracked = null; // 필요할 때 한 번만 부른다
  const repoFiles = () => {
    if (!tracked) {
      // -z: 한글 경로가 인용부호로 바뀌지 않게
      const r = git(['ls-files', '-z'], { cwd: root, allowFail: true });
      const ls = r.status === 0 ? r.out.split('\0').filter(Boolean) : [];
      tracked = [...new Set([...ls.map(fwd), ...touched.filter(t => !isGlob(t))])];
    }
    return tracked;
  };
  const noMin = [];
  for (const d of dod) {
    const id = d.id;
    if (d.tests) {
      const stackName = d.tests.stack;
      const stack = cfg.stacks?.[stackName];
      if (!stack) err('TESTS_STACK', `tests.stack "${stackName}" 가 harness.json stacks 에 없다(있는 것: ${Object.keys(cfg.stacks ?? {}).join(', ')}) — 스택 이름을 고칠 것`, id);
      else if (!stack.dod_tests) err('TESTS_STACK', `스택 "${stackName}" 에 dod_tests 설정이 없다 — tests 대신 probe 로 쓰거나 harness.json stacks.${stackName}.dod_tests 를 둘 것`, id);
      const min = d.expect?.min_tests;
      // 없으면 게이트가 1 로 본다(하나라도 돌고 통과하면 된다) — 오류가 아니라 아래에서 한 줄로 모아 알린다. 있는데 1 이상 정수가 아니면 오류
      if (min == null) noMin.push(id);
      else if (!(Number.isInteger(min) && min >= 1)) err('TESTS_MIN', `expect.min_tests 가 1 이상 정수가 아니다(${JSON.stringify(min)}) — 실제 기대 건수를 정수로 넣을 것`, id);
      const sel = Array.isArray(d.tests.select) ? d.tests.select.map(s => String(s).trim()).filter(Boolean) : [];
      if (!sel.length) err('SELECT_EMPTY', 'tests.select 가 비었다 — gradle 은 클래스 패턴, vitest 는 스택 dir 기준 파일 경로를 넣을 것', id);
      else if (stack?.dod_tests) {
        const adapter = stack.dod_tests.adapter;
        const cands = testCandidates(adapter, stack, repoFiles());
        if (!cands) warn('SELECT_UNCHECKED', `러너 "${adapter}" 의 선택 규칙을 몰라 tests.select 가 0건 매치인지 보지 못했다`, id);
        // 후보가 하나도 없으면 select 가 틀렸다기보다 이 프로젝트의 테스트 배치를 못 알아본 것이다 — 전부 오류로 내지 않는다
        else if (!cands.length) warn('SELECT_UNCHECKED', `스택 "${stackName}" 에서 테스트 파일을 하나도 찾지 못해 tests.select 가 0건 매치인지 보지 못했다(테스트 배치가 기본 규칙과 다르거나 아직 테스트가 없다) — 새로 쓸 테스트면 touched 에 넣을 것`, id);
        else {
          // gradle 은 파일에서 최상위 클래스만 알 수 있다 — 중첩 클래스 패턴(Outer$Inner)은 바깥 클래스로 맞춘다
          const hit = s => adapter === 'gradle-junit'
            ? cands.some(c => gradleMatches(s.replace(/\$.*$/, ''), c))
            : cands.some(c => vitestMatches(s, c));
          const dead = sel.filter(x => !hit(x));
          const how = adapter === 'gradle-junit'
            ? `스택 "${stackName}" 의 테스트 클래스(파일 이름)에 걸리지 않는다 — 클래스 패턴(예 *FooTest*)으로, 설계의 클래스명과 글자까지 같게 쓸 것`
            : `스택 "${stackName}"(dir ${stack.dir}) 기준 *.test.*·*.spec.* 경로에 걸리지 않는다 — 스택 dir 을 뺀 경로로, 설계의 파일 경로와 글자까지 같게 쓸 것`;
          const list = dead.map(s => `"${s}"`).join(', ');
          // 게이트는 항목 단위로 센다 — 전부 0건이면 그 항목은 돌 테스트가 없다(오류). 일부만 0건이면 죽은 필터다(경고)
          if (dead.length === sel.length) err('SELECT_NO_MATCH', `select ${list} 가 0건 매치다 — ${how}(새로 쓸 테스트면 touched 에 넣을 것)`, id);
          else if (dead.length) warn('SELECT_NO_MATCH', `select ${list} 는 0건 매치다(같은 항목의 다른 select 는 걸린다) — 오타가 아니면 빼고, 새로 쓸 테스트면 touched 에 넣을 것`, id);
        }
      }
    }
    if (d.probe) {
      const runner = callsTestRunner(d.probe);
      if (runner && d.expect?.min_tests == null && !d.expect?.pattern) {
        err('PROBE_MIN', 'probe 가 테스트 러너를 부르는데 expect.min_tests 도 pattern 도 없다 — 0건 실행이 초록이 된다. min_tests 를 1 이상으로 넣을 것', id);
      }
      if (!runner && d.expect?.min_tests != null) {
        warn('MIN_ON_SENTINEL', 'probe 가 테스트 러너를 부르지 않는데 min_tests 가 있다 — 건수를 찍지 않으면 항상 FAIL 한다. 건수를 직접 찍지 않는다면 min_tests 를 빼고 pattern 을 둘 것', id);
      }
      if (RESTORE_RX.test(d.probe)) {
        err('INJECT_RESTORE', 'probe 가 git checkout -- · restore · stash · reset --hard 로 원복한다 — 커밋 전 트리에서는 수정 자체를 지운다. 사본 복구(cp → 주입 → 테스트 → mv)로 쓸 것', id);
      }
    }
    if (d.human === true && (d.probe || d.tests)) {
      warn('HUMAN_HAS_PROBE', 'human 항목인데 probe/tests 가 있다 — 자동으로 잴 수 있으면 human 을 빼고, 아니면 probe/tests 를 비울 것', id);
    }
    // 확인 방법이 없는 항목은 게이트가 사람 확인으로 치고 건너뛴다 — 그럴 뜻이면 human 을 적어 드러낸다
    if (!d.probe && !d.tests && d.human !== true) {
      err('DOD_NO_CHECK', 'probe · tests · human 이 모두 없다 — 자동으로 잴 수 있으면 probe 나 tests 를, 사람이 볼 항목이면 human: true 를 넣을 것', id);
    }
  }

  // ---- 레인 이름 ----
  // 이름은 결과 파일(<slug>.lane-<이름>.json) · Herdr 작업트리 브랜치(lane/<slug>/<이름>) · pane 이름의 재료다 — 겹치면 두 레인이 같은 파일·브랜치에 쓴다
  // 이름 겹침은 설정만 본다(세션이 Herdr 밖이어도) — Herdr 밖에서 세운 계획을 Herdr 안에서 이어 돌릴 수 있다
  const herdrLanesOn = herdrImplementOn(cfg);
  if (lanes.length) {
    const groups = new Map(); // 겹침 축 → 그 축에서 같은 값이 되는 레인 이름들
    lanes.forEach((l, i) => {
      // 이름은 적힌 그대로 본다(앞뒤 공백을 잘라 내고 보지 않는다) — 상태에는 적힌 그대로 들어가고 실행기도 그 값으로 브랜치·파일 이름을 만든다
      const name = typeof l.name === 'string' ? l.name : '';
      if (!name.trim()) { err('LANE_NAME', `lanes[${i}] 에 name 이 없다 — 이름 없는 레인은 실행기가 건너뛴다. 이슈 키를 소문자로 줄인 abc-12 꼴로 붙일 것`); return; }
      if (LANE_NAME_BAD.test(name)) err('LANE_NAME', `레인 이름 "${name}" 에 파일 이름으로 쓸 수 없는 글자(공백 · / \\ : * ? " < > | · 앞뒤의 점)가 있다 — 이름이 결과 파일 이름에 들어간다. abc-12 꼴로 쓸 것`);
      // 결과 파일은 대소문자를 가리지 않는 파일 시스템에서 겹친다. Herdr 는 이름을 [a-z][a-z0-9_-]{0,31} 로 깎아 브랜치·pane 이름을 만든다(한글·숫자뿐인 이름은 전부 "lane" 이 된다)
      const axes = [['결과 파일', name.toLowerCase()], ...(herdrLanesOn ? [['Herdr 작업트리 브랜치', laneName(name)], ['Herdr pane 이름', laneName(`impl-${name}`)]] : [])];
      for (const [axis, v] of axes) { const k = `${axis}\u0000${v}`; groups.set(k, [...(groups.get(k) ?? []), name]); }
    });
    const told = new Set();
    for (const [k, names] of groups) {
      if (names.length < 2) continue;
      const [axis, v] = k.split('\u0000');
      const sig = [...names].sort().join('\u0000');
      if (told.has(sig)) continue; // 같은 레인 묶음이 여러 축에서 겹쳐도 한 줄만
      told.add(sig);
      err('LANE_NAME', `레인 이름 겹침 — ${names.map(n => `"${n}"`).join(' · ')} 의 ${axis}: "${v}". 두 레인이 같은 파일·브랜치에 쓰게 된다 — 영문 소문자로 시작하고 서로 다른 이름(abc-12 꼴)을 쓸 것`);
    }
  }

  // ---- 레인의 작업트리 ↔ 이 세션이 쓸 실행기 ----
  // worktree: true 는 Herdr 구현 레인(레인마다 작업트리를 파고 끝나면 패치로 회수한다)을 전제한다. Herdr 밖이거나 설정이 꺼져 있으면 워크플로 레인으로 도는데,
  // 거기서는 격리 작업트리의 변경을 메인으로 가져오는 단계가 없다. 설정(herdr.lanes)만 보고 정한 계획이 Herdr 밖 세션에서 그대로 실행되는 것을 반영 전에 드러낸다
  if (herdrInside != null && laneRunner(cfg, herdrInside) !== 'herdr') {
    const wt = lanes.filter(l => l.worktree === true).map(l => l.name);
    if (wt.length) warn('LANE_WORKTREE', `레인 ${wt.join(', ')} 가 worktree: true 인데 이 세션은 Herdr 구현 레인을 쓰지 못한다(${laneRunnerWhy(cfg, herdrInside)}) — 워크플로 레인은 한 작업트리에서 돌고, 격리 작업트리의 변경을 메인으로 가져오는 단계가 없다. Herdr 안에서 구현할 계획이 아니면 worktree 를 전부 false 로 두고 레인의 파일 소유가 겹치지 않게 나눌 것`);
  }

  // ---- 레인 소유 겹침 ----
  if (lanes.length > 1) {
    const filesOf = l => (Array.isArray(l.files) ? l.files.map(fwd) : []);
    for (let i = 0; i < lanes.length; i++) for (let j = i + 1; j < lanes.length; j++) {
      const a = lanes[i], b = lanes[j];
      const fa = filesOf(a), fb = filesOf(b);
      const shared = [...new Set([...fa.filter(x => fb.includes(x)), ...touched.filter(t => matchesAny(t, fa) && matchesAny(t, fb))])];
      if (!shared.length) continue;
      const what = `레인 ${a.name}·${b.name} 가 같은 파일을 가진다(${shared.slice(0, 3).join(', ')}${shared.length > 3 ? ` 외 ${shared.length - 3}` : ''})`;
      // 둘 다 작업트리 없이 같은 트리에서 돌면 서로의 수정을 덮는다(오류). 한쪽이라도 자기 작업트리가 있으면 패치를 합칠 때의 충돌 위험이다(경고)
      if (a.worktree !== true && b.worktree !== true) err('LANE_OVERLAP', `${what} — 둘 다 작업트리 없이 같은 트리에서 돈다. 한 레인만 소유하게 나누거나 한 레인으로 묶을 것`);
      else warn('LANE_OVERLAP', `${what} — 패치를 합칠 때 충돌할 수 있다. 한 레인만 소유하게 나누거나, 겹치는 파일의 계약을 먼저 커밋해 둘 것`);
    }
  }

  // ---- 레인이 가리키는 DoD ----
  // 레인의 dod(id 배열)는 구현 레인이 「자기 테스트」를 고르는 유일한 근거다(gate.mjs --try --lane). 없는 id 를 가리키면 그 레인은 돌릴 것을 못 찾는다
  for (const l of lanes) {
    if (l.dod == null) continue;
    const ids = (Array.isArray(l.dod) ? l.dod : []).map(x => (typeof x === 'string' ? x : x?.id));
    const unknown = [...new Set(ids.filter(x => !x || !seen.has(x)).map(x => String(x ?? '(id 없음)')))];
    if (!Array.isArray(l.dod)) err('LANE_DOD', `레인 ${l.name} 의 dod 가 배열이 아니다 — 그 레인이 맡은 DoD 의 id 배열(예 ["D1","D3"])로 쓸 것`);
    else if (unknown.length) err('LANE_DOD', `레인 ${l.name} 의 dod 가 사이드카 dod 에 없는 id 를 가리킨다(${unknown.join(', ')}) — dod[].id 와 글자까지 같게 쓸 것(있는 것: ${[...seen].join(', ') || '없음'})`);
  }
  // 레인이 여럿인데 어느 레인도 맡지 않은 자동 tests 항목 — 오류는 아니다(합친 뒤에야 잴 수 있는 확인일 수 있다).
  // 어느 레인도 dod 를 적지 않았으면 레인마다 「자기 테스트」가 없는 것이다(gate.mjs --try --lane 이 돌릴 것을 못 찾는다) — 그 경우는 따로 말한다
  if (lanes.length > 1) {
    const owned = new Set(lanes.flatMap(l => (Array.isArray(l.dod) ? l.dod : []).map(x => (typeof x === 'string' ? x : x?.id))));
    const orphan = dod.filter(d => d.tests && d.human !== true && typeof d.id === 'string' && !owned.has(d.id)).map(d => d.id);
    const noneOwns = !lanes.some(l => Array.isArray(l.dod) && l.dod.length);
    if (orphan.length && noneOwns) warn('LANE_DOD_UNOWNED', `레인이 ${lanes.length}개인데 어느 레인에도 dod 가 없다(tests 항목: ${orphan.join(', ')}) — 레인은 구현 중 돌릴 자기 테스트를 고를 근거가 없다. 레인마다 그 레인이 맡은 DoD 의 id 배열을 dod 에 적을 것`);
    else if (orphan.length) warn('LANE_DOD_UNOWNED', `어느 레인의 dod 에도 없는 tests 항목: ${orphan.join(', ')} — 레인은 구현 중 이 테스트를 돌리지 않는다(합친 뒤 드라이버가 본다). 한 레인의 몫이면 그 레인의 dod 에 넣을 것`);
  }

  // ---- 이슈 여러 건인데 레인이 없다 ----
  // 오류가 아니다(한 레인에 묶거나 차례로 할 이유가 있을 수 있다) — 다만 말없이 차례로 구현되지 않게 승인 전에 드러낸다
  const issueKeys = Array.isArray(state?.keys) ? state.keys : [];
  const hasSubtasks = (Array.isArray(state?.subtasks) ? state.subtasks : []).some(g => Array.isArray(g?.children) && g.children.length);
  if ((issueKeys.length > 1 || hasSubtasks) && lanes.length < 2) {
    warn('LANES_SERIAL', `이슈 ${issueKeys.length}건을 한 번에 처리하는데 레인이 ${lanes.length}개다 — 이대로면 이슈들이 차례로 구현된다. 이슈마다 레인을 두어 동시에 돌리거나(같은 파일을 고치는 이슈끼리는 한 레인으로), 차례로 할 이유를 승인 요약에 적을 것`);
  }

  // ---- 하위이슈마다 DoD ----
  for (const grp of (Array.isArray(state?.subtasks) ? state.subtasks : [])) {
    for (const c of (Array.isArray(grp?.children) ? grp.children : [])) {
      const key = typeof c === 'string' ? c : c?.key;
      if (!key) continue;
      // 실제 표기는 한 괄호에 여러 하위를 묶기도 한다([ABC-12·13·14] …) — 맨 앞 괄호 안에 그 키나 번호가 있으면 덮인 것이다
      const num = String(key).split('-').pop();
      const covers = d => { const m = /^\s*\[([^\]]+)\]/.exec(String(d.text ?? '')); return !!m && m[1].split(/[^A-Za-z0-9-]+/).some(t => t === key || t === num); };
      if (!dod.some(covers)) {
        err('SUBTASK_DOD', `하위이슈 ${key} 의 DoD 가 없다 — text 가 "[${key}]" 로 시작하는 DoD 를 1건 이상 넣을 것(한 항목이 여러 하위를 덮으면 "[${key}·…]" 처럼 한 괄호에 적고, 이번에 계획하지 않는 하위도 human 항목으로 남겨 마감 때 미확인으로 보이게 한다)`, key);
      }
    }
  }

  // ---- 가이드 ↔ DoD ----
  let reqIds = [];
  if (guideText == null) warn('GUIDE_MISSING', '가이드 초안(.draft)도 확정본도 없다 — guides 경로를 확인하거나 가이드를 먼저 쓸 것(요구↔DoD 대응을 못 봤다)');
  else {
    const dodSec = sections(guideText, /^##\s+DoD\b/i);
    reqIds = idsIn(sections(guideText, /^##\s+요구/), /\bR\d+\b/g);
    if (!reqIds.length) warn('REQ_NO_IDS', '가이드 ## 요구 절에 R 번호(R1, R2 …)가 없어 요구↔DoD 대응을 못 봤다 — 요구마다 번호를 붙이고 DoD 줄에 (R1) 꼴로 적을 것');
    else {
      const covered = new Set(idsIn(dodSec, /\bR\d+\b/g));
      const missing = reqIds.filter(x => !covered.has(x));
      // DoD 절에 요구 번호가 하나도 없으면(표기 자체를 안 썼다) 요구마다 한 줄씩 내지 않고 한 줄로 알린다
      if (missing.length && !covered.size) err('REQ_UNCOVERED', `가이드 ## DoD 절에 요구 번호가 하나도 없다(요구 ${reqIds.length}건) — DoD 줄마다 그 항목이 확인하는 요구를 "D1 (R1, R2) …" 꼴로 적을 것`);
      else for (const r of missing) err('REQ_UNCOVERED', `요구 ${r} 가 가이드 ## DoD 절에 한 번도 나오지 않는다 — 그 요구를 확인하는 DoD 줄에 (${r}) 를 적거나 DoD 를 더할 것`, r);
    }
    // 가이드에만 있는 항목은 사람이 승인했는데 게이트가 돌지 않는 검사다(오류). 사이드카에만 있는 항목은 승인 문서에 안 보이는 검사다(경고)
    const guideD = idsIn(dodSec, /\bD\d+[A-Za-z]?\b/g);
    if (guideD.length) {
      const side = dod.map(d => d.id).filter(x => typeof x === 'string' && x);
      const onlyGuide = guideD.filter(x => !side.includes(x));
      const token = id => new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`);
      const onlySide = side.filter(x => !token(x).test(dodSec));
      if (onlyGuide.length) err('DOD_GUIDE_MISMATCH', `가이드 ## DoD 에만 있고 사이드카 dod 에 없는 항목: ${onlyGuide.join(', ')} — 승인한 검사가 게이트에서 돌지 않는다. 사이드카에 넣거나 가이드에서 뺄 것`);
      if (onlySide.length) warn('DOD_GUIDE_MISMATCH', `사이드카 dod 에만 있고 가이드 ## DoD 에 없는 항목: ${onlySide.join(', ')} — 가이드에도 적어 승인 때 보이게 할 것`);
    }
  }

  // ---- 경고: 기대 건수 없는 tests 항목 · human 비중 · touched 오타 ----
  if (noMin.length) warn('TESTS_MIN_DEFAULT', `tests 항목 ${noMin.length}건(${noMin.slice(0, 6).join(', ')}${noMin.length > 6 ? ' …' : ''})에 expect.min_tests 가 없다 — 게이트는 1건만 돌아도 통과시킨다. 그 요구를 재는 테스트의 실제 기대 건수를 넣을 것`);
  const human = dod.filter(isHumanDod).length;
  if (dod.length && human * 2 > dod.length) warn('HUMAN_HEAVY', `사람 확인 항목이 ${human}/${dod.length} 로 절반을 넘는다 — 쪼개서 probe/tests 를 붙일 것`);
  for (const t of touched) {
    if (isGlob(t)) continue;
    if (!existsSync(join(root, t)) && !existsSync(join(root, dirname(t)))) warn('TOUCHED_PATH', `touched "${t}" 도 그 부모 폴더도 없다 — 경로 오타가 아닌지 볼 것`);
  }

  const summary = {
    requirements: reqIds.length,
    dod: dod.length,
    tests_items: dod.filter(d => d.tests && d.human !== true).length,
    probes: dod.filter(d => d.probe && !d.tests && d.human !== true).length,
    human,
    lanes: lanes.length,
    touched: touched.length,
    assumptions: (Array.isArray(state?.decisions) ? state.decisions : []).filter(isAssumption).map(d => ({ q: d.q, a: d.a })),
  };
  return { errors, warnings, summary };
}
