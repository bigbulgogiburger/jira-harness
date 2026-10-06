// subtasks.mjs — 하위이슈 확장(순수 함수). Jira 를 부르지 않는다: 라우터가 MCP getJiraIssue 로 읽은 응답을 값으로 준다.
// 규칙: 이슈를 주면 그 하위이슈를 같이 처리한다(기본). 이미 끝난 하위·다른 프로젝트 키·harness.json subtasks.match 에 안 걸린 하위는 뺀다.

const DONE_NAME = /^(done|closed|resolved|completed?|완료|종료|해결(됨)?)$/i;
const num = (key) => Number(String(key).split('-').pop());

/** getJiraIssue 응답 한 건 → { key, children[{key, summary, status, done}] }. fields.subtasks · subtasks 둘 다 받는다. */
export function readIssue(issue, { doneTransition = null } = {}) {
  const key = String(issue?.key ?? '').trim().toUpperCase();
  const raw = issue?.fields?.subtasks ?? issue?.subtasks ?? [];
  const children = (Array.isArray(raw) ? raw : []).map((s) => {
    const f = s?.fields ?? s ?? {};
    const status = f.status?.name ?? '';
    const category = String(f.status?.statusCategory?.key ?? '').toLowerCase();
    return {
      key: String(s?.key ?? '').trim().toUpperCase(),
      summary: f.summary ?? '',
      status,
      // QA 처럼 이 하네스가 직접 전이시킨 상태도 끝난 것으로 본다 — 마감 뒤 부모를 다시 열어도 그 하위를 또 잡지 않는다.
      done: category === 'done' || DONE_NAME.test(status) || (!!doneTransition && status === doneTransition),
    };
  }).filter((c) => c.key);
  return { key, children };
}

/**
 * 부모 이슈들 → 처리할 키 목록.
 * keys = 준 키(순서 유지) 뒤에 각 부모의 포함 하위(번호 오름차순). 부모가 항상 앞이라 dev-guide 의 대표 키는 바뀌지 않는다.
 * children[] 은 제외된 것까지 전부(reason: other-project | already | done | no-match) — 라우터가 표로 보여준다.
 */
export function resolveSubtasks(issues, { prefix, match = null, doneTransition = null } = {}) {
  const keyRe = new RegExp(`^${prefix}-\\d+$`);
  const matchRe = match ? new RegExp(match) : null;
  const parents = issues.map((i) => readIssue(i, { doneTransition }));
  const keys = parents.map((p) => p.key).filter((k, i, a) => k && a.indexOf(k) === i);
  const groups = [];
  const children = [];
  for (const p of parents) {
    const picked = [];
    for (const c of [...p.children].sort((a, b) => num(a.key) - num(b.key))) {
      let reason = null;
      if (!keyRe.test(c.key)) reason = 'other-project';
      else if (keys.includes(c.key)) reason = 'already';
      else if (c.done) reason = 'done';
      else if (matchRe && !matchRe.test(c.summary)) reason = 'no-match';
      children.push({ parent: p.key, ...c, include: !reason, reason });
      if (!reason) { keys.push(c.key); picked.push(c.key); }
    }
    if (picked.length) groups.push({ parent: p.key, children: picked });
  }
  return { keys, groups, children };
}

/** 진행 중인 상태 중 첫 키가 givenKeys 에 있는 것 — 그 브랜치를 이어 간다(Jira 의 현재 하위 구성이 바뀌었어도 브랜치를 새로 만들지 않는다). */
export function findResumable(states, givenKeys) {
  const given = givenKeys.map((k) => String(k).toUpperCase());
  const hit = states.find((s) => s && s.stage !== 'archived' && Array.isArray(s.keys) && given.includes(s.keys[0]));
  return hit ? { branch: hit.branch, keys: hit.keys, stage: hit.stage, subtasks: hit.subtasks ?? [] } : null;
}
