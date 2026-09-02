export const meta = {
  name: 'jira-harness-plan',
  description: '이슈 계획 — 코드·wiki·요구를 병렬로 이해 → dev-guide 초안·레인·DoD 설계 → 제약·범위 검증',
  phases: [
    { title: 'Understand', detail: '코드 경로·wiki 결정·이슈 요구를 병렬로 읽어 구조화한다' },
    { title: 'Design', detail: 'dev-guide 초안(.draft)과 사이드카 JSON 을 에이전트가 직접 쓴다', model: 'opus' },
    { title: 'Verify', detail: '확정 결정과의 모순 · 범위 이탈/DoD 누락을 각각 본다' },
  ],
};

// 이 스크립트는 파일 시스템·git 에 접근하지 않는다. 입력은 전부 args 값이고,
// 파일 쓰기(초안·사이드카)는 Design 레인 에이전트가 프롬프트 지시로 수행한다.

const A = args ?? {};

function need(ok, msg) {
  if (!ok) throw new Error(`plan.js: ${msg}`);
}
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

need(Array.isArray(A.keys) && A.keys.length > 0, 'args.keys 가 없다 — 이슈 키 배열(예: ["ABC-123"])이 필요하다');
need(isPlainObject(A.issueBodies), 'args.issueBodies 가 없다 — {KEY: 이슈 본문} 객체여야 한다');
need(isPlainObject(A.guidePaths) && Object.keys(A.guidePaths).length > 0, 'args.guidePaths 가 비어 있다 — {KEY: dev-guide 경로} 객체여야 한다');
need(typeof A.sidecarPath === 'string' && A.sidecarPath.length > 0, 'args.sidecarPath 가 없다 — 사이드카 JSON 을 쓸 경로');
need(typeof A.repoRoot === 'string' && A.repoRoot.length > 0, 'args.repoRoot 가 없다 — 프로젝트 루트 경로');

const M = Object.assign({ understand: 'sonnet', light: 'haiku', design: 'opus', verify: 'sonnet' }, isPlainObject(A.models) ? A.models : {});
const hasWiki = A.hasWiki === true;
const hasMemory = A.hasMemory === true;
const wikiHits = Array.isArray(A.wikiHits) ? A.wikiHits : [];
const decisions = Array.isArray(A.decisions) ? A.decisions : [];
const stamp = typeof A.ts === 'string' && A.ts ? A.ts : '(호출자가 ts 를 주지 않음 — 시각 필드는 비운다)';

const keyList = A.keys.join(', ');
const guideEntries = A.keys.map((k) => `- ${k} → ${A.guidePaths[k] ?? A.guidePaths[A.keys[0]] ?? '(경로 없음)'}`).join('\n');
const guideValues = Array.from(new Set(Object.keys(A.guidePaths).map((k) => A.guidePaths[k]))).filter(Boolean);
const draftPaths = guideValues.map((p) => `${p}.draft`);
const bodyText = A.keys.map((k) => `### ${k}\n${A.issueBodies[k] ?? '(본문 없음 — 추측하지 말고 unknowns 로 올린다)'}`).join('\n\n');
const decisionText = decisions.length
  ? decisions.map((d, i) => `${i + 1}. 질문: ${d.q}\n   확정: ${d.a}`).join('\n')
  : '(확정된 결정 없음 — 결정이 필요한 지점은 unknowns 로 올린다)';
const wikiText = wikiHits.length ? wikiHits.map((h) => `- ${h}`).join('\n') : '(wiki 히트 없음)';

const RULES = [
  '규율:',
  '- 읽지 않은 것을 아는 척하지 않는다. 확인 못 한 것은 값을 지어내지 말고 unknowns 배열에 문장으로 남긴다.',
  '- 결론마다 근거가 되는 파일 경로(또는 이슈 본문 인용)를 함께 남긴다.',
  '- 코드를 수정하지 않는다. 이 단계는 읽기 전용이다(Design 레인만 파일을 쓴다).',
].join('\n');

const CODE_SCHEMA = {
  type: 'object',
  required: ['paths', 'patterns', 'tests', 'unknowns'],
  properties: {
    paths: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'why'],
        properties: { path: { type: 'string' }, why: { type: 'string' }, stack: { type: 'string' } },
      },
    },
    patterns: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

const WIKI_SCHEMA = {
  type: 'object',
  required: ['decisions', 'unknowns'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ref', 'summary'],
        properties: { ref: { type: 'string' }, summary: { type: 'string' }, impact: { type: 'string' } },
      },
    },
    guides: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

const REQ_SCHEMA = {
  type: 'object',
  required: ['requirements', 'constraints', 'outOfScope'],
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' }, source: { type: 'string' } },
      },
    },
    constraints: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } },
  },
};

const DESIGN_SCHEMA = {
  type: 'object',
  required: ['guides', 'touched', 'lanes', 'dod', 'wrote'],
  properties: {
    guides: { type: 'object', additionalProperties: { type: 'string' } },
    touched: { type: 'array', items: { type: 'string' } },
    lanes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'model', 'files', 'worktree', 'brief'],
        properties: {
          name: { type: 'string' },
          model: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          worktree: { type: 'boolean' },
          brief: { type: 'string' },
        },
      },
    },
    dod: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text', 'human'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          probe: { type: ['string', 'null'] },
          cwd: { type: ['string', 'null'] },
          expect: {
            type: 'object',
            properties: { pattern: { type: 'string' }, min_tests: { type: 'integer' } },
          },
          human: { type: 'boolean' },
        },
      },
    },
    wrote: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'blockers'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'BLOCK'] },
    blockers: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

phase('Understand');
log(`계획 착수 — 키 ${keyList} · wiki ${hasWiki ? '있음' : '없음'} · 확정 결정 ${decisions.length}건`);

const codePrompt = [
  `프로젝트 루트: ${A.repoRoot}`,
  `아래 이슈를 구현할 때 **실제로 손대게 될 코드**를 찾아 정리한다. 최대 25턴 안에 끝낸다.`,
  '',
  '## 이슈 본문',
  bodyText,
  '',
  '## 이미 확정된 결정',
  decisionText,
  '',
  '## 할 일',
  '1. 루트에서 이슈의 명사(도메인·화면·API 이름)로 검색해 관련 파일을 찾는다. 스택이 둘 이상이면(서버·클라이언트) 양쪽 다 본다.',
  '2. 각 파일이 왜 관련되는지 한 줄로 적는다. 추정이면 그렇게 적는다.',
  '3. 같은 종류의 기능이 이미 어떻게 구현돼 있는지(기존 패턴)를 2~5개 문장으로 적는다 — 새 방식을 발명하지 않기 위한 재료다.',
  '4. 이 영역을 덮는 기존 테스트 파일 경로를 모은다. 없으면 빈 배열로 두고 unknowns 에 "테스트 없음" 을 적는다.',
  '5. 되돌리기 비싼 지점(스키마 변경·외부 계약·상태 머신)을 risks 에 적는다.',
  '',
  RULES,
].join('\n');

const wikiPrompt = [
  `프로젝트 루트: ${A.repoRoot}`,
  '이 이슈와 충돌하거나 이미 결론이 난 **기존 결정**이 있는지만 확인한다. 최대 25턴.',
  '',
  '## 이슈 본문',
  bodyText,
  '',
  '## 문서 인덱스에서 뽑은 후보 줄(이미 grep 된 결과)',
  wikiText,
  '',
  '## 할 일',
  '1. 위 후보 줄이 가리키는 문서를 열어 이 이슈에 걸리는 결정만 고른다. 관련 없는 줄은 버린다.',
  '2. 결정마다 ref(문서 경로 또는 결정 번호)·한 줄 요약·이 이슈에 미치는 영향을 적는다.',
  '3. 같은 주제의 기존 가이드 문서가 있으면 guides 에 경로를 넣는다(중복 작성을 막기 위해서다).',
  '4. 인덱스에 없지만 확인이 필요한 것은 unknowns 로 올린다.',
  '',
  RULES,
].join('\n');

const reqPrompt = [
  '아래 이슈 본문과 확정 결정에서 **요구·제약·범위 밖** 목록을 뽑는다. 코드는 읽지 않는다. 최대 10턴.',
  '',
  '## 이슈 본문',
  bodyText,
  '',
  '## 확정 결정',
  decisionText,
  '',
  hasMemory
    ? '## 참고: 이 저장소에는 세션 간 메모리가 있다 — 이미 로드된 맥락과 어긋나는 요구가 보이면 unknowns 에 적는다.'
    : '## 참고: 세션 간 메모리 없음.',
  '',
  '## 할 일',
  '1. requirements: 검증 가능한 단위로 쪼갠다. id 는 R1, R2 … 로 붙이고 source 에 근거(이슈 키 또는 결정 번호)를 적는다.',
  '2. constraints: 지켜야 하는 제약(호환·성능·권한·마감 등)만.',
  '3. outOfScope: 본문이 명시적으로 뺐거나, 결정에서 하지 않기로 한 것.',
  '4. 본문에 없는 요구를 만들어 넣지 않는다. 모호하면 unknowns.',
  '',
  RULES,
].join('\n');

const understandTasks = [
  () => agent(codePrompt, { label: 'understand:code', phase: 'Understand', schema: CODE_SCHEMA, model: M.understand, effort: 'medium' }),
];
if (hasWiki) {
  understandTasks.push(() => agent(wikiPrompt, { label: 'understand:wiki', phase: 'Understand', schema: WIKI_SCHEMA, model: M.understand, effort: 'medium' }));
}
understandTasks.push(() => agent(reqPrompt, { label: 'understand:issue', phase: 'Understand', schema: REQ_SCHEMA, model: M.light }));

const understandResults = await parallel(understandTasks);
const codeRes = understandResults[0] ?? null;
const wikiRes = hasWiki ? (understandResults[1] ?? null) : null;
const reqRes = (hasWiki ? understandResults[2] : understandResults[1]) ?? null;
log(`Understand 완료 — 코드 ${codeRes ? 'OK' : '실패'} · wiki ${hasWiki ? (wikiRes ? 'OK' : '실패') : '생략'} · 요구 ${reqRes ? 'OK' : '실패'}`);

phase('Design');

const designPrompt = [
  `프로젝트 루트: ${A.repoRoot}`,
  `이슈 ${keyList} 의 개발 가이드 초안과 사이드카 JSON 을 **직접 파일로 쓴다**. 최대 40턴.`,
  '',
  '## 재료 1 — 이슈 본문',
  bodyText,
  '',
  '## 재료 2 — 확정 결정(뒤집지 않는다)',
  decisionText,
  '',
  '## 재료 3 — 코드 이해 결과(JSON)',
  JSON.stringify(codeRes),
  '',
  '## 재료 4 — 기존 결정/문서 조사 결과(JSON)',
  JSON.stringify(wikiRes),
  '',
  '## 재료 5 — 요구·제약·범위 밖(JSON)',
  JSON.stringify(reqRes),
  '',
  '## 써야 할 파일 1 — dev-guide 초안',
  '아래 경로에 **.draft 접미사를 붙인 파일**을 Write 한다(확정 파일은 승인 뒤 라우터가 만든다 — 확정 경로에 쓰지 않는다):',
  draftPaths.map((p) => `- ${p}`).join('\n'),
  '이슈가 여러 건이어도 가이드는 **한 장**이다. 서버·클라이언트 공통 변경을 두 장으로 쪼개지 않는다.',
  '가이드 문서의 절 구성(이 순서, 이 제목):',
  '1. `## 요구` — 검증 가능한 문장 목록. 근거(이슈 키·결정)를 함께.',
  '2. `## 범위 밖` — 이번에 하지 않는 것. 비면 "없음" 이라고 쓴다.',
  '3. `## 설계` — 무엇을 어디에 어떻게. 손댈 파일 경로를 본문에 적고, 기존 패턴을 따르는지/벗어나는지 밝힌다.',
  '4. `## 작업 항목` — 레인별 구성 요소 목록. 레인 경계(한쪽이 부르고 다른 쪽이 받는 지점)를 명시한다.',
  '5. `## DoD` — 표. 열: id · 확인할 것 · 프로브 명령 · 기대 · 사람 확인 여부.',
  '6. `## 리스크` — 되돌리기 비싼 결정과 그 완화책.',
  '',
  '## 써야 할 파일 2 — 사이드카 JSON',
  `경로: ${A.sidecarPath}`,
  '내용은 아래 키만 가진 JSON 객체다(다른 키를 넣지 않는다):',
  '- `guides`: {이슈 키: 확정 dev-guide 경로}. `.draft` 가 **아닌** 아래 확정 경로를 그대로 쓴다:',
  guideEntries,
  '- `touched`: 이번에 수정/추가할 파일 경로 배열(프로젝트 루트 기준 상대 경로).',
  '- `lanes`: [{name, model, files, worktree, brief}]. name 은 짧은 식별자, model 은 opus/sonnet/haiku 중 난이도에 맞게, files 는 그 레인이 소유하는 경로 glob, worktree 는 두 레인이 같은 파일을 동시에 고칠 때만 true, brief 는 그 레인이 할 일 2~3문장.',
  '  레인은 파일 소유가 겹치지 않게 나눈다. 나눌 근거가 없으면 레인 1개로 둔다(억지로 병렬화하지 않는다).',
  '- `dod`: [{id, text, probe, cwd, expect, human}]. id 는 D1, D2 …',
  '  probe 는 **실제로 실행 가능한 셸 명령 한 줄**(테스트·린트·빌드 필터). cwd 는 프로젝트 루트 기준 상대 경로(루트면 null).',
  '  expect 는 {pattern, min_tests}. pattern 은 성공 출력에 반드시 나오는 정규식, min_tests 는 실행 건수 하한이다 —',
  '  **필터가 0건을 실행해도 초록이 되는 사고를 막는 유일한 장치이므로, 테스트 프로브에는 min_tests 를 1 이상으로 반드시 넣는다.**',
  '  자동으로 못 재는 항목만 human: true 로 두고 probe 는 null 로 한다. human 항목이 절반을 넘으면 설계가 검증 불가능한 것이다 — 쪼개서 프로브를 붙인다.',
  '  거부 케이스를 최소 1건 넣는다("잘못된 입력이 거부되는가" — 통과 케이스만 있는 DoD 는 검사 0건과 구분되지 않는다).',
  `- 시각 값이 필요하면 ${stamp} 를 쓴다.`,
  '',
  '## 반환',
  '두 파일을 다 쓴 뒤, 사이드카에 쓴 것과 **같은 값**을 guides/touched/lanes/dod 로 반환하고, wrote 에 실제로 Write 한 파일 경로 전부를 넣는다.',
  '',
  '규율: 확정 결정을 뒤집지 않는다. 재료에 없는 요구를 새로 만들지 않는다. 코드는 이 단계에서 고치지 않는다(문서 2종만 쓴다).',
].join('\n');

const design = await agent(designPrompt, { label: 'design', phase: 'Design', schema: DESIGN_SCHEMA, model: M.design, effort: 'high' });

const touched = Array.isArray(design?.touched) ? design.touched : [];
const lanes = Array.isArray(design?.lanes) ? design.lanes : [];
const dod = Array.isArray(design?.dod) ? design.dod : [];
const guides = isPlainObject(design?.guides) && Object.keys(design.guides).length ? design.guides : A.guidePaths;
log(`Design 완료 — 레인 ${lanes.length} · DoD ${dod.length} · 손댈 파일 ${touched.length}`);

phase('Verify');

const planJson = JSON.stringify({ touched, lanes, dod, guides, draftPaths });

const constraintsPrompt = [
  `프로젝트 루트: ${A.repoRoot}`,
  '아래 설계가 **이미 확정된 것과 모순되는지**만 본다. 더 좋은 설계를 제안하지 않는다. 최대 15턴.',
  '',
  '## 확정 결정',
  decisionText,
  '',
  '## 이슈 본문',
  bodyText,
  '',
  '## 기존 결정/문서 조사 결과(JSON)',
  JSON.stringify(wikiRes),
  '',
  '## 검증 대상 설계(JSON)',
  planJson,
  '',
  `초안 문서를 직접 읽어 대조한다: ${draftPaths.join(' , ')}`,
  '',
  '## 판정 기준',
  '- 확정 결정을 뒤집는 설계가 있으면 BLOCK. 어느 결정을 어떻게 뒤집는지 한 줄로 쓴다.',
  '- 기존 문서 결정과 어긋나는데 근거가 문서에 없으면 BLOCK.',
  '- 취향 차이·더 나은 대안은 blocker 가 아니다 — notes 로만 적는다.',
  '- 모순을 못 찾았으면 PASS 이고 blockers 는 빈 배열이다. 찾지 못한 것을 "없다" 로 단정하지 말고 notes 에 어디까지 봤는지 적는다.',
].join('\n');

const scopePrompt = [
  `프로젝트 루트: ${A.repoRoot}`,
  '아래 설계의 **범위와 검증 가능성**만 본다. 최대 15턴.',
  '',
  '## 요구·제약·범위 밖(JSON)',
  JSON.stringify(reqRes),
  '',
  '## 이슈 본문',
  bodyText,
  '',
  '## 검증 대상 설계(JSON)',
  planJson,
  '',
  `초안 문서를 직접 읽어 대조한다: ${draftPaths.join(' , ')}`,
  '',
  '## 판정 기준(하나라도 걸리면 BLOCK)',
  '- 요구에 없는 작업이 touched/lanes 에 들어 있다(범위 이탈).',
  '- 요구 중 어느 DoD 로도 확인되지 않는 것이 있다(누락).',
  '- 범위 밖으로 선언한 것을 설계가 하고 있다.',
  '- DoD 가 통과 케이스만 있고 거부/실패 케이스가 하나도 없다.',
  '- 테스트를 도는 probe 에 expect.min_tests 가 없다(0건 실행이 초록으로 통과한다).',
  '- 레인들의 files 가 서로 겹치는데 worktree 가 false 다.',
  'blocker 는 "무엇이 · 왜" 한 줄로 쓴다. 모호한 지적은 notes 로.',
].join('\n');

const verdicts = await parallel([
  () => agent(constraintsPrompt, { label: 'verify:constraints', phase: 'Verify', schema: VERDICT_SCHEMA, model: M.verify }),
  () => agent(scopePrompt, { label: 'verify:scope', phase: 'Verify', schema: VERDICT_SCHEMA, model: M.verify }),
]);

const blockers = [];
if (!design) blockers.push('Design 레인이 결과를 반환하지 않았다 — 초안·사이드카가 없을 수 있다.');
if (!lanes.length) blockers.push('lanes 가 비어 있다 — 구현을 맡을 레인이 하나도 없다.');
if (!dod.length) blockers.push('dod 가 비어 있다 — 검증 가능한 완료 조건 없이 승인할 수 없다.');

const verifyLabels = ['verify:constraints', 'verify:scope'];
verdicts.forEach((v, i) => {
  const label = verifyLabels[i];
  if (!v) { blockers.push(`${label} 레인이 결과를 반환하지 않았다 — 검증 분모가 비었다.`); return; }
  if (v.verdict !== 'BLOCK') return;
  const list = Array.isArray(v.blockers) ? v.blockers.filter(Boolean) : [];
  if (list.length) for (const b of list) blockers.push(`${label}: ${b}`);
  else blockers.push(`${label}: BLOCK 인데 사유가 비어 있다.`);
});

const verdict = blockers.length ? 'BLOCK' : 'PASS';
log(`Verify 완료 — ${verdict}${blockers.length ? ` · blocker ${blockers.length}건` : ''}`);
if (verdict === 'BLOCK') log('BLOCK 이므로 Design 을 재시도하지 않는다 — 라우터가 grill 로 되돌린다.');

return {
  verdict,
  blockers,
  touched,
  lanes,
  dod,
  guides,
  draftPaths,
  sidecarPath: A.sidecarPath,
  understand: {
    code: codeRes,
    wiki: wikiRes,
    requirements: reqRes,
  },
  verify: {
    constraints: verdicts[0] ?? null,
    scope: verdicts[1] ?? null,
  },
};
