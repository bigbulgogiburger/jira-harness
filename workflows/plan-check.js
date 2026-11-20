// plan-check.js — 계획 반증. 계획을 세운 컨텍스트와 무관한 에이전트 하나가 "이 계획대로 구현하면 틀리게 되는 곳" 을 찾는다.
// 기계로 볼 수 있는 것(요구↔DoD 대응 · min_tests · select 매치 · 레인 겹침)은 scripts/plan-check.mjs 가 이미 봤다 — 여기는 판단이 필요한 것만 본다.
// 이 스크립트는 fs·git 을 만지지 않는다: 입력은 전부 args 값이고, 가이드·사이드카·코드는 에이전트가 직접 읽는다.
export const meta = {
  name: 'plan-check',
  description: '계획 반증 — 새 컨텍스트 에이전트 하나가 요구 누락·영향 범위 누락·판별력 없는 DoD·결정과의 모순을 찾는다',
  phases: [{ title: '반증' }],
};

const A = args ?? {};
function need(ok, msg) { if (!ok) throw new Error(`plan-check.js: ${msg}`); }
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

need(typeof A.repoRoot === 'string' && A.repoRoot.length > 0, 'args.repoRoot 가 없다 — 지금 일하는 트리의 절대 경로');
need(Array.isArray(A.keys) && A.keys.length > 0, 'args.keys 가 없다 — 이슈 키 배열');
need(isPlainObject(A.issueBodies) && Object.keys(A.issueBodies).length > 0, 'args.issueBodies 가 없다 — {KEY: 이슈 원문} 객체여야 한다(원문 없이는 요구 누락을 볼 수 없다)');
need(Array.isArray(A.draftPaths) && A.draftPaths.length > 0, 'args.draftPaths 가 없다 — 가이드 초안 경로 배열');
need(typeof A.sidecarPath === 'string' && A.sidecarPath.length > 0, 'args.sidecarPath 가 없다 — 계획 사이드카 JSON 경로');

const decisions = Array.isArray(A.decisions) ? A.decisions.filter(isPlainObject) : [];
const wikiHits = Array.isArray(A.wikiHits) ? A.wikiHits : [];
const isAssumed = (d) => d.assumed === true || /\(unattended\)\s*$/.test(String(d.a ?? ''));
const decisionText = decisions.length
  ? decisions.map((d) => `- ${isAssumed(d) ? '[가정] ' : ''}${d.q} → ${d.a}`).join('\n')
  : '- (기록된 결정 없음)';
const bodyText = A.keys.map((k) => `### ${k}\n${A.issueBodies[k] ?? '(원문 없음 — 이 키의 요구 누락은 볼 수 없다고 notes 에 적는다)'}`).join('\n\n');

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'blockers', 'notes', 'looked'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'BLOCK'] },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['what', 'why', 'where'],
        properties: { what: { type: 'string' }, why: { type: 'string' }, where: { type: 'string' } },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    looked: { type: 'array', items: { type: 'string' } },
  },
};

const prompt = [
  '당신은 이 저장소에서 곧 구현될 계획의 반증자다. 계획을 세운 쪽과 컨텍스트를 공유하지 않는다 — 아래 재료와 저장소만 본다.',
  `프로젝트 루트: ${A.repoRoot} (아래 경로가 상대 경로면 이 루트 기준이다)`,
  '',
  '## 할 일',
  '이 계획대로 구현하면 **틀리게 되는 곳**을 찾는다. 더 나은 설계를 제안하는 자리가 아니다. 찾을 것은 네 가지다.',
  '1. 요구 누락·오독 — 이슈 원문과 결정에 있는데 가이드의 `## 요구` 에 없거나 다르게 읽힌 것. 원문의 문장을 하나씩 대조한다. 원문의 요구가 근거(사람의 결정) 없이 `## 범위 밖` 으로 빠진 것도 여기다.',
  '2. 영향 범위 누락 — 사이드카 `touched` 밖인데 이 변경으로 같이 바뀌어야 하는 곳. 추측하지 말고 코드를 열어 확인한다: 같은 동작의 다른 진입점과 공용 함수의 다른 호출처 · 반대편 표면(서버↔클라이언트) · 권한의 다른 층과 그 층을 거치지 않는 쓰기 경로 · 같은 값을 계산·표시하는 다른 곳 · 다른 언어의 문구 · 외부 호출·비동기·트랜잭션 뒤의 실패 경로 · 이 변경으로 틀려지는 문서.',
  '3. 판별력 없는 DoD — 틀린 구현에서도 초록이 되는 항목. 통과 사례만 재는가, 기대값이 구현에서 나오는가, mock 이 재려는 실제 경로를 건너뛰는가, `tests.select` 가 그 요구를 재는 테스트를 가리키는가(이미 있는 테스트만으로 `min_tests` 가 채워지는가), 요구(R) 가운데 어느 DoD 로도 실제로는 확인되지 않는 것이 있는가.',
  '4. 모순 — 사람이 정한 결정이나 저장소 문서의 기존 결정을 뒤집는 설계. `[가정]` 은 사람 확인 없이 고른 해석이다 — 원문이나 코드와 어긋나면 blocker 다.',
  '',
  '## 재료',
  '### 이슈 원문',
  bodyText,
  '',
  '### 결정과 가정',
  decisionText,
  '',
  `### 가이드 초안(직접 읽는다): ${A.draftPaths.join(' , ')}`,
  `### 사이드카(직접 읽는다): ${A.sidecarPath}`,
  ...(wikiHits.length ? ['### 관련 문서 줄', ...wikiHits.map((h) => `- ${h}`)] : []),
  ...(A.mechanical ? ['### 기계 점검 결과(이미 본 것 — 다시 하지 않는다)', typeof A.mechanical === 'string' ? A.mechanical : JSON.stringify(A.mechanical)] : []),
  '',
  '## 판정',
  '- blocker 는 그대로 구현하면 요구를 어기거나, 결함이 남거나, 틀린 구현이 검증을 통과하게 되는 것이다. `what`(무엇이) · `why`(왜 틀리게 되는가) · `where`(파일:심볼 또는 원문 문장)를 적는다. 코드나 원문에서 확인한 것만 올리고, 확인하지 못한 의심은 notes 에 둔다.',
  '- 취향 · 더 나은 대안 · 문서 형식은 blocker 가 아니다.',
  '- 못 찾았으면 PASS 이고 blockers 는 빈 배열이다. `looked` 에는 실제로 열어 본 파일과 대조한 원문 문장을 적는다 — 보지 않은 곳을 "없다" 로 단정하지 않는다.',
  '- 코드와 문서를 고치지 않는다(읽기 전용). 최대 25턴.',
].join('\n');

phase('반증');
const out = await agent(prompt, { label: 'plan-check', phase: '반증', schema: VERDICT_SCHEMA, model: typeof A.model === 'string' && A.model ? A.model : 'opus', effort: 'high' });

if (!out || typeof out !== 'object') {
  log('반증 에이전트가 결과를 내지 못했다 — 확인 0건을 통과로 읽지 않는다');
  return { verdict: 'BLOCK', blockers: [{ what: '반증 에이전트가 결과를 내지 못했다', why: '확인 0건은 통과가 아니다 — 다시 돌리거나, 건너뛴 사실을 승인 요약에 적는다', where: '' }], notes: [], looked: [], dead: true };
}
const blockers = (Array.isArray(out.blockers) ? out.blockers : []).filter((b) => isPlainObject(b) && String(b.what ?? '').trim());
const looked = (Array.isArray(out.looked) ? out.looked : []).map(String).filter(Boolean);
const notes = (Array.isArray(out.notes) ? out.notes : []).map(String).filter(Boolean);
if (!blockers.length && !looked.length) {
  log('PASS 인데 열어 본 것이 없다 — 검사 0건으로 본다');
  return { verdict: 'BLOCK', blockers: [{ what: '반증이 아무것도 열어 보지 않고 PASS 를 냈다', why: '검사 0건은 통과가 아니다 — 다시 돌리거나, 건너뛴 사실을 승인 요약에 적는다', where: '' }], notes, looked, dead: true };
}
const verdict = blockers.length ? 'BLOCK' : 'PASS';
log(`반증 ${verdict} — blocker ${blockers.length} · 열어 본 곳 ${looked.length}`);
return { verdict, blockers, notes, looked };
