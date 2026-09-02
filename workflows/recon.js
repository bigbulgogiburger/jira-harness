export const meta = {
  name: 'jira-harness-recon',
  description: '정찰 — 이슈 범위와 사람이 정해야 할 분기점만 찾는다(결정하지 않는다)',
  phases: [
    { title: 'Recon', detail: '코드와 이슈 본문을 훑어 범위·분기점·미확인을 정리한다' },
  ],
};

// 반환은 grill 의 재료일 뿐 결정이 아니다. 확인 못 한 것은 추측으로 채우지 않고 unknowns 로 올린다.
// 이 스크립트는 파일 시스템·git 에 접근하지 않는다 — 입력은 전부 args 값이다.

const A = args ?? {};

function need(ok, msg) {
  if (!ok) throw new Error(`recon.js: ${msg}`);
}
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

need(Array.isArray(A.keys) && A.keys.length > 0, 'args.keys 가 없다 — 이슈 키 배열(예: ["ABC-123"])이 필요하다');
need(isPlainObject(A.issueBodies), 'args.issueBodies 가 없다 — {KEY: 이슈 본문} 객체여야 한다');
need(typeof A.repoRoot === 'string' && A.repoRoot.length > 0, 'args.repoRoot 가 없다 — 프로젝트 루트 경로');

const model = typeof A.model === 'string' && A.model ? A.model : 'sonnet';
const hints = Array.isArray(A.hints) ? A.hints.filter(Boolean) : [];
const keyList = A.keys.join(', ');
const bodyText = A.keys.map((k) => `### ${k}\n${A.issueBodies[k] ?? '(본문 없음)'}`).join('\n\n');
const hintText = hints.length ? hints.map((h) => `- ${h}`).join('\n') : '(호출자가 준 힌트 없음)';

const RECON_SCHEMA = {
  type: 'object',
  required: ['scope', 'branchPoints', 'unknowns'],
  properties: {
    scope: { type: 'string' },
    branchPoints: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question', 'options', 'recommended', 'why'],
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommended: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
    unknowns: { type: 'array', items: { type: 'string' } },
  },
};

phase('Recon');
log(`정찰 착수 — 키 ${keyList} · 힌트 ${hints.length}건`);

const prompt = [
  `프로젝트 루트: ${A.repoRoot}`,
  `이슈 ${keyList} 의 **범위**와 **사람이 정해야 할 분기점**만 찾는다. 구현하지 않고, 설계하지도 않는다. 최대 25턴.`,
  '',
  '## 이슈 본문',
  bodyText,
  '',
  '## 호출자가 준 힌트',
  hintText,
  '',
  '## 할 일',
  '1. 루트에서 이슈의 명사(도메인·화면·API 이름)로 검색해 이 이슈가 닿는 영역을 파악한다.',
  '2. `scope`: 이번 이슈가 건드리는 범위를 5~10줄로 쓴다. 어느 스택·어느 계층까지인지 명시한다.',
  '3. `branchPoints`: **코드나 문서를 읽어도 답이 안 나오는 것**만 넣는다. 각 항목은',
  '   - question: 사람에게 그대로 물을 수 있는 한 문장',
  '   - options: 실제로 고를 수 있는 선택지 2~4개(각 선택지의 결과가 서로 달라야 한다)',
  '   - recommended: options 중 하나(문자열이 정확히 일치해야 한다)',
  '   - why: 그것을 권하는 근거 — 읽은 파일 경로나 이슈 본문 인용을 포함한다',
  '   코드로 답이 나오는 것은 분기점이 아니다. 그런 것은 넣지 말고 scope 본문에 사실로 적는다.',
  '4. `unknowns`: 확인하려 했지만 못 한 것을 문장으로 남긴다. **"미확인" 은 정상 결과다** — 모르는 것을 그럴듯한 값으로 채우지 않는다.',
  '',
  '규율: 파일을 수정하지 않는다(읽기 전용). 결론마다 근거 경로를 남긴다. 분기점이 하나도 없으면 빈 배열로 반환한다(억지로 만들지 않는다).',
].join('\n');

const res = await agent(prompt, { label: 'recon', phase: 'Recon', schema: RECON_SCHEMA, model, effort: 'medium' });

if (!res) {
  log('정찰 레인이 결과를 반환하지 않았다 — 빈 결과로 되돌린다(라우터가 grill 로 진행).');
  return { scope: '', branchPoints: [], unknowns: ['정찰 레인이 결과를 반환하지 않았다 — 범위 미확인'] };
}

const branchPoints = Array.isArray(res.branchPoints) ? res.branchPoints : [];
const unknowns = Array.isArray(res.unknowns) ? res.unknowns : [];
log(`정찰 완료 — 분기점 ${branchPoints.length}건 · 미확인 ${unknowns.length}건`);

return {
  scope: typeof res.scope === 'string' ? res.scope : '',
  branchPoints,
  unknowns,
};
