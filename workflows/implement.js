// implement.js — 레인 2개 이상일 때의 구현 워크플로.
// 레인마다 선언된 모델·격리(worktree)로 에이전트 하나를 띄우고, 레인 사이드카 JSON 을 쓰게 한다.
// 이 스크립트는 fs·git 을 만지지 않는다 — 입력은 전부 args 값이고, 파일을 쓰는 것은 레인 에이전트다.
// 완주 판정은 반환값으로 한다: 죽은 레인(반환 null)도 사이드카 파일은 남기므로 파일 존재는 근거가 아니다.
export const meta = {
  name: 'implement',
  description: '레인별 구현 — 레인 선언대로 모델·worktree 격리, 레인마다 사이드카 JSON 을 남긴다',
  phases: [{ title: '레인 구현' }]
};

const LANE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    status: { type: 'string', enum: ['done', 'partial', 'failed'] },
    files: { type: 'array', items: { type: 'string' } },
    tests: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        passed: { type: 'integer', minimum: 0 },
        failed: { type: 'integer', minimum: 0 }
      }
    },
    notes: { type: 'string' },
    sidecar: { type: 'string' }
  },
  required: ['name', 'status', 'files', 'notes']
};

function slash(p) {
  return String(p == null ? '' : p).split('\\').join('/');
}
function joinPath(dir, name) {
  const d = slash(dir).replace(/\/+$/, '');
  return d ? d + '/' + name : name;
}
function asText(v) {
  if (v == null) return '(없음)';
  if (typeof v === 'string') return v.trim() || '(없음)';
  return JSON.stringify(v, null, 2);
}
function bullets(list, empty) {
  const arr = (Array.isArray(list) ? list : []).filter(x => x != null && String(x).length);
  if (!arr.length) return empty;
  return arr.map(x => '- ' + slash(x)).join('\n');
}
function num(v) {
  return typeof v === 'number' && v >= 0 ? v : 0;
}

if (!args || typeof args !== 'object') throw new Error('implement: args 가 없다');
const lanes = (Array.isArray(args.lanes) ? args.lanes : []).filter(l => l && l.name);
if (!lanes.length) throw new Error('implement: args.lanes 가 비었다 — 레인 1개면 메인이 직접 구현한다');
if (!args.sidecarDir) throw new Error('implement: args.sidecarDir 가 없다');
if (!args.sidecarPrefix) throw new Error('implement: args.sidecarPrefix 가 없다');
if (!args.repoRoot) throw new Error('implement: args.repoRoot 가 없다');

const maxTurns = args.maxTurns > 0 ? args.maxTurns : 60;
const repoRoot = slash(args.repoRoot);
const contractsText = asText(args.contracts);
const guidePaths = args.guidePaths && typeof args.guidePaths === 'object' ? args.guidePaths : {};
const guideList = Object.keys(guidePaths).map(k => '- ' + k + ': ' + slash(guidePaths[k]));
const guideText = guideList.length ? guideList.join('\n') : '- (가이드 경로가 전달되지 않았다 — 계약과 레인 지시만으로 진행한다)';
const ts = args.ts || '(미지정)';

const sidecarOf = (lane) => joinPath(args.sidecarDir, args.sidecarPrefix + '.lane-' + lane.name + '.json');

phase('레인 구현');
log('레인 ' + lanes.length + '개 — ' + lanes.map(l => l.name + '(' + (l.model || '?') + (l.worktree ? ',worktree' : '') + ')').join(', '));

const raw = await pipeline(lanes, async (lane) => {
  const sidecar = sidecarOf(lane);
  const prompt = [
    '너는 이슈 구현 레인 "' + lane.name + '" 이다. 아래 담당 파일만 고치고, 완료 전 해당 스택의 테스트를 직접 실행한다.',
    '',
    '## 개발 가이드 (먼저 정독한다)',
    guideText,
    '',
    '## Phase 0 공통 계약 — 이미 확정·커밋된 것이다. 바꾸지 말고 그대로 따른다',
    contractsText,
    '',
    '## 담당 파일 (저장소 루트 ' + repoRoot + ' 기준 상대 경로)',
    bullets(lane.files, '- (파일 목록이 비었다 — 레인 지시의 범위 안에서만 만든다)'),
    '',
    '## 레인 지시',
    asText(lane.brief),
    '',
    '## 규율',
    '- 담당 파일 밖은 수정하지 않는다. 다른 레인이 같은 저장소에서 동시에 일한다.',
    '- 경계(seam — 한쪽이 부르고 다른 쪽이 받는 곳)에서 상대 레인의 파일을 고쳐야 하면 고치지 말고 notes 에 적는다.',
    '- 완료 전 해당 스택의 테스트를 실제로 실행하고 명령·통과/실패 건수를 기록한다. 실행하지 않았으면 tests.command 를 빈 문자열로 두고 status 는 partial 이다.',
    '- 실패를 숨기지 않는다 — 못 끝냈으면 status 는 partial 또는 failed 다. 초록으로 보이게 테스트를 지우거나 게이트 명령을 바꾸지 않는다.',
    '- 턴 상한 ' + maxTurns + ' — 넘기기 전에 사이드카를 쓰고 반환한다.',
    '',
    '## 산출물',
    '1) 코드 변경',
    '2) 사이드카 파일 ' + sidecar + ' 을 Write 로 아래 모양으로 쓴다:',
    '   {"name": "' + lane.name + '", "files": ["…"], "tests": {"command": "…", "passed": 0, "failed": 0}, "notes": "…"}',
    '3) 같은 내용을 schema 대로 반환한다. (실행 표식 ' + ts + ')'
  ].join('\n');

  const out = await agent(prompt, {
    label: 'lane:' + lane.name,
    phase: '레인 구현',
    schema: LANE_SCHEMA,
    model: lane.model,
    effort: 'high',
    isolation: lane.worktree ? 'worktree' : undefined
  });
  return out;
});

const results = lanes.map((lane, i) => {
  const sidecar = sidecarOf(lane);
  const out = raw[i];
  if (!out || typeof out !== 'object') {
    return {
      name: lane.name,
      status: 'failed',
      files: [],
      tests: { command: '', passed: 0, failed: 0 },
      notes: '레인이 결과를 반환하지 않았다(중단·예외·스키마 불일치). 사이드카 파일이 남아 있어도 완주가 아니다.',
      sidecar
    };
  }
  const tests = out.tests && typeof out.tests === 'object' ? out.tests : {};
  const status = out.status === 'done' || out.status === 'partial' || out.status === 'failed' ? out.status : 'partial';
  return {
    name: lane.name,
    status,
    files: Array.isArray(out.files) ? out.files.map(slash) : [],
    tests: { command: String(tests.command || ''), passed: num(tests.passed), failed: num(tests.failed) },
    notes: String(out.notes == null ? '' : out.notes),
    sidecar
  };
});

const failed = results.filter(r => r.status === 'failed').map(r => r.name);
const partial = results.filter(r => r.status === 'partial').map(r => r.name);
if (failed.length) log('실패 레인 ' + failed.length + '건: ' + failed.join(', ') + ' — 산출물 파일이 아니라 반환값으로 판정했다');
if (partial.length) log('미완 레인 ' + partial.length + '건: ' + partial.join(', '));

return { lanes: results, failed, sidecars: results.map(r => r.sidecar) };
