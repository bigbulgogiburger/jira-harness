// implement.js — 레인 2개 이상일 때의 구현 워크플로.
// 레인마다 선언된 모델로 에이전트 하나를 띄우고, 레인 사이드카 JSON 을 쓰게 한다. **레인은 전부 한 작업트리에서 동시에 돈다** —
// 레인마다 작업트리를 파고 끝난 뒤 변경을 패치로 회수하는 것은 Herdr 실행기(herdr-lanes.mjs implement)뿐이다. 여기서 레인을 격리 작업트리로 보내면
// 그 변경을 메인으로 가져올 단계가 없어 구현이 떠 버린다 — 그래서 worktree: true 레인은 받지 않는다(아래).
// 이 스크립트는 fs·git 을 만지지 않는다 — 입력은 전부 args 값이고, 파일을 쓰는 것은 레인 에이전트다.
// 완주 판정은 반환값으로 한다: 죽은 레인(반환 null)도 사이드카 파일은 남기므로 파일 존재는 근거가 아니다.
export const meta = {
  name: 'implement',
  description: '레인별 구현 — 한 작업트리에서 레인마다 선언한 모델로 동시에 고치고, 레인마다 사이드카 JSON 을 남긴다',
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
// worktree: true 는 Herdr 실행기를 전제한 계획이다(Herdr 안에서 세운 계획을 밖에서 잇는 경우 · 설정만 보고 세운 계획). 그대로 한 작업트리에서 돌리면
// 그 계획이 허용한 파일 겹침이 서로의 수정을 덮는다 — 에이전트를 띄우기 전에 멈추고, 겹침을 다시 점검하게 한다
const isolated = lanes.filter(l => l.worktree === true).map(l => l.name);
if (isolated.length) throw new Error('implement: 레인 ' + isolated.join(', ') + ' 가 worktree: true 다 — 워크플로 레인은 전부 한 작업트리에서 돈다(레인마다 작업트리를 파고 변경을 패치로 회수하는 것은 Herdr 실행기뿐이다). 계획 사이드카에서 그 레인들의 worktree 를 false 로 고쳐 issue-set.mjs --merge <사이드카> --from plan 을 다시 한 뒤 부를 것 — 그 점검이 레인끼리 겹치는 파일을 LANE_OVERLAP 오류로 알려 주면 겹치는 레인을 한 레인으로 묶는다');

const maxTurns = args.maxTurns > 0 ? args.maxTurns : 60;
const repoRoot = slash(args.repoRoot);
const contractsText = asText(args.contracts);
const guidePaths = args.guidePaths && typeof args.guidePaths === 'object' ? args.guidePaths : {};
const guideList = Object.keys(guidePaths).map(k => '- ' + k + ': ' + slash(guidePaths[k]));
const guideText = guideList.length ? guideList.join('\n') : '- (가이드 경로가 전달되지 않았다 — 계약과 레인 지시만으로 진행한다)';
const ts = args.ts || '(미지정)';

const sidecarOf = (lane) => joinPath(args.sidecarDir, args.sidecarPrefix + '.lane-' + lane.name + '.json');

phase('레인 구현');
log('레인 ' + lanes.length + '개 — ' + lanes.map(l => l.name + '(' + (l.model || '?') + ')').join(', '));

// 검증 규칙 — 레인은 빌드·테스트를 돌리지 않는다. 다른 레인이 같은 트리에서 동시에 고치는 중이라 남이 반쯤 쓴 파일까지 컴파일되고,
// 같은 빌드 폴더를 두 러너가 같이 쓴다. 검증은 레인이 전부 돌아온 뒤 드라이버가 한 번 한다(gate.mjs --try).
const VERIFY_RULES = [
  '- **빌드·테스트·lint 를 돌리지 않는다.** 다른 레인이 같은 작업트리에서 동시에 고치는 중이다 — 지금 돌리면 남이 반쯤 쓴 파일까지 컴파일돼 네 코드와 무관하게 실패하고, 같은 빌드 폴더를 여러 러너가 같이 써서 서로를 깨뜨린다. 검증은 레인이 전부 끝난 뒤 메인이 한 번에 한다.',
  '- 테스트 코드는 쓴다(가이드의 DoD 가 요구하는 것). tests.command 는 빈 문자열, passed·failed 는 0 으로 두고, notes 에 **메인이 돌려야 할 테스트**(클래스 이름·파일 경로)와 돌리지 못해 확신이 없는 곳을 적는다.',
  '- 테스트를 돌리지 않은 것은 미완이 아니다 — 맡은 구현과 테스트 코드를 다 썼으면 status 는 done 이다.',
];
function dodIds(lane) {
  return (Array.isArray(lane.dod) ? lane.dod : []).map(d => (typeof d === 'string' ? d : d && d.id)).filter(Boolean);
}

const raw = await pipeline(lanes, async (lane) => {
  const sidecar = sidecarOf(lane);
  const ids = dodIds(lane);
  const prompt = [
    '너는 이슈 ' + (lane.key ? lane.key + ' 의 ' : '') + '구현 레인 "' + lane.name + '" 이다. 아래 담당 파일만 고친다.',
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
    ...(ids.length ? ['', '## 이 레인이 닫아야 할 DoD', '가이드 `## DoD` 의 ' + ids.join(', ') + ' — 이 항목들이 요구하는 구현과 테스트 코드가 네 몫이다.'] : []),
    '',
    '## 규율',
    '- 담당 파일 밖은 수정하지 않는다. 다른 레인이 같은 저장소에서 동시에 일한다.',
    '- 경계(seam — 한쪽이 부르고 다른 쪽이 받는 곳)에서 상대 레인의 파일을 고쳐야 하면 고치지 말고 notes 에 적는다.',
    '- 실패를 숨기지 않는다 — 못 끝냈으면 status 는 partial 또는 failed 다. 초록으로 보이게 테스트를 지우거나 게이트 명령을 바꾸지 않는다.',
    '- 턴 상한 ' + maxTurns + ' — 넘기기 전에 사이드카를 쓰고 반환한다.',
    '',
    '## 검증',
    ...VERIFY_RULES,
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
    effort: 'high'
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
