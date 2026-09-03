// verify.js — 리뷰 레인. **Codex 판정을 대체하거나 보완할 때만** 돈다(harness.json 의 review.lanes_when, 기본 codex_gap):
// Codex 가 ok 로 판정을 냈으면 같은 diff 를 여기서 다시 심판하지 않는다 — 기록에 lanes_reason 이 없으면 issue-set 이 거부한다.
// 레인 수는 **finding 수와 무관하게 고정**이다 — finding 별 반증 fan-out 을 띄우지 않는다(29→56 폭주 이력).
// 이 스크립트는 fs·git 을 만지지 않는다: 바뀐 파일 목록·diff 기준은 args 값으로 받는다.
export const meta = {
  name: 'verify',
  description: '변경 파일을 dispatch 로 나눠 상한 이하 레인으로 리뷰 — 델타 패스는 1레인, finding 은 file+line+claim 으로 병합',
  phases: [{ title: '리뷰 레인' }]
};

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['BLOCKER', 'MAJOR', 'MINOR', 'INFO'] },
          file: { type: 'string' },
          line: { type: 'integer', minimum: 0 },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          axis: { type: 'string' }
        },
        required: ['severity', 'file', 'claim', 'evidence']
      }
    }
  },
  required: ['findings']
};

const RANK = { BLOCKER: 0, MAJOR: 1, MINOR: 2, INFO: 3 };

function slash(p) {
  return String(p == null ? '' : p).split('\\').join('/');
}
// glob → RegExp. 지원: ** (구분자를 넘는다) · * (한 구간) · ? (한 글자). 그 밖의 문자는 리터럴이다.
function globToRe(glob) {
  const g = slash(glob);
  if (g === '*' || g === '**') return /^.*$/;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; }
        else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$(){}|[]'.indexOf(c) >= 0 || c === '\\') {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}
function normClaim(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
}
function bullets(list, empty, cap) {
  const arr = (Array.isArray(list) ? list : []).filter(x => x != null && String(x).length);
  if (!arr.length) return empty;
  const head = cap && arr.length > cap ? arr.slice(0, cap) : arr;
  const rest = arr.length - head.length;
  return head.map(x => '- ' + slash(x)).join('\n') + (rest > 0 ? '\n- … 외 ' + rest + '건' : '');
}

if (!args || typeof args !== 'object') throw new Error('verify: args 가 없다');
if (!args.diffRef) throw new Error('verify: args.diffRef 가 없다');
if (!args.repoRoot) throw new Error('verify: args.repoRoot 가 없다');

const delta = args.delta && Array.isArray(args.delta.files) && args.delta.files.length ? args.delta : null;
const changedFiles = (Array.isArray(args.changedFiles) ? args.changedFiles : []).map(slash);
if (!delta && !changedFiles.length) throw new Error('verify: changedFiles 도 delta 도 없다 — 리뷰할 대상이 없다');

const lanesMax = args.lanesMax > 0 ? args.lanesMax : 4;
const laneModel = args.laneModel || 'sonnet';
const axes = (Array.isArray(args.axes) ? args.axes : []).filter(a => a && String(a).length);
const dispatch = args.dispatch && typeof args.dispatch === 'object' ? args.dispatch : {};
const repoRoot = slash(args.repoRoot);
const ts = args.ts || '(미지정)';

// ── 레인 선정
const candidates = [];
if (delta) {
  candidates.push({
    label: 'verify:delta',
    axis: '델타(직전 리뷰 이후 바뀐 파일만)',
    agentType: undefined,
    files: delta.files.map(slash),
    since: delta.sinceTree || null
  });
} else {
  const buckets = [];
  const byAgent = {};
  const taken = {};
  for (const glob of Object.keys(dispatch)) {
    const re = globToRe(glob);
    const agents = Array.isArray(dispatch[glob]) ? dispatch[glob] : [dispatch[glob]];
    for (const f of changedFiles) {
      if (taken[f] || !re.test(f)) continue;
      taken[f] = true;   // 먼저 걸린 glob 이 임자다 — 뒤에 둔 "*" 가 자연스러운 폴백이 된다
      for (const a of agents) {
        if (!a) continue;
        if (!byAgent[a]) { byAgent[a] = { agentType: a, files: [] }; buckets.push(byAgent[a]); }
        byAgent[a].files.push(f);
      }
    }
  }
  for (const b of buckets) {
    candidates.push({ label: 'verify:' + b.agentType, axis: b.agentType, agentType: b.agentType, files: b.files, since: null });
  }
  for (const ax of axes) {
    candidates.push({ label: 'verify:' + ax, axis: ax, agentType: undefined, files: changedFiles, since: null });
  }
}

const picked = candidates.slice(0, lanesMax);
const dropped = candidates.slice(lanesMax).map(c => c.label);

phase('리뷰 레인');
log('레인 ' + picked.length + '/' + candidates.length + '개 (상한 ' + lanesMax + ', 모델 ' + laneModel + ', 델타 ' + (delta ? 'Y' : 'N') + ')');
if (dropped.length) log('상한 초과로 뺀 레인 ' + dropped.length + '건: ' + dropped.join(', ') + ' — 다음 라운드나 델타 패스에서 다시 잡는다');

const raw = await pipeline(picked, async (lane) => {
  const prompt = [
    '너는 코드 리뷰 레인 "' + lane.axis + '" 이다. 아래 변경만 읽고 결함을 찾는다. 코드를 고치지 않는다.',
    '',
    '## 변경 범위',
    '- diff 기준: ' + args.diffRef,
    lane.since ? '- 직전 리뷰 트리: ' + lane.since + ' (그 뒤 바뀐 파일만 본다)' : '- 라운드 리뷰(변경 전체가 대상)',
    '- 저장소 루트: ' + repoRoot,
    '',
    '## 담당 파일',
    bullets(lane.files, '- (파일 목록 없음 — diff 기준 전체를 본다)', 60),
    '',
    '## 관점',
    lane.agentType ? '이 레인의 전문 관점(' + lane.agentType + ')으로 본다.' : '"' + lane.axis + '" 축에 집중한다.',
    '',
    '## 규율',
    '- finding 마다 파일·줄과 **증거**(그 자리에서 읽은 코드·명령 출력)를 단다. 증거 없는 추측은 내지 않는다.',
    '- 게이트가 초록이라는 사실은 근거가 아니다 — 초록은 "위반 0" 과 "검사 0" 을 구분해주지 않는다.',
    '- severity: BLOCKER(머지 불가) / MAJOR(고쳐야 함) / MINOR(사소) / INFO(참고).',
    '- 같은 결함을 여러 줄로 쪼개 부풀리지 않는다. 담당 파일 밖 결함은 내지 않는다.',
    '- 20턴 안에 끝낸다. 못 본 영역이 있으면 그 사실을 INFO 로 남긴다.',
    '',
    '## 반환',
    'schema 대로 findings 배열만 반환한다. axis 에는 "' + lane.axis + '" 를 넣는다. 결함이 없으면 빈 배열이다. (실행 표식 ' + ts + ')'
  ].join('\n');

  const out = await agent(prompt, {
    label: lane.label,
    phase: '리뷰 레인',
    schema: FINDING_SCHEMA,
    model: laneModel,
    effort: 'medium',
    agentType: lane.agentType
  });
  return out;
});

// ── 병합: file + line + claim 정규화로 중복 제거.
// 먼저 온 것을 남기되 **severity 는 더 센 쪽으로 올린다** — 먼저 온 MINOR 가 뒤의 BLOCKER 를 삼키면 병합이 결함을 지운다.
const merged = [];
const seen = {};
const laneReport = picked.map((lane, i) => {
  const out = raw[i];
  const list = out && Array.isArray(out.findings) ? out.findings : [];
  if (!out) log('레인 ' + lane.label + ' 이 결과를 반환하지 않았다 — findings 0 으로 센다');
  for (const f of list) {
    if (!f || !f.file || !f.claim) continue;
    const file = slash(f.file);
    const line = typeof f.line === 'number' ? f.line : 0;
    const key = file + '|' + line + '|' + normClaim(f.claim);
    const sev = RANK[f.severity] === undefined ? 'INFO' : f.severity;
    if (seen[key]) {
      const prev = seen[key];
      if (RANK[sev] < RANK[prev.severity]) prev.severity = sev;
      continue;
    }
    const rec = {
      severity: sev,
      file,
      line,
      claim: String(f.claim),
      evidence: String(f.evidence == null ? '' : f.evidence),
      axis: f.axis || lane.axis
    };
    seen[key] = rec;
    merged.push(rec);
  }
  return { label: lane.label, agentType: lane.agentType === undefined ? null : lane.agentType, count: list.length };
});

merged.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
log('finding ' + merged.length + '건(레인 합계 ' + laneReport.reduce((s, l) => s + l.count, 0) + '건에서 중복 제거) — 확정/기각은 메인이 한다');

return { findings: merged, lanes: laneReport, dropped, delta: !!delta };
