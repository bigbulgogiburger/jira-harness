// lanes.mjs — 레인 이름 규칙과 「이 세션이 레인을 무엇으로 돌리는가」. 실행기(herdr-lanes.mjs) · 계획 점검(lib/plan-check.mjs) ·
// 상태 조회(issue-start.mjs --status)가 같은 규칙을 쓴다 — 실행기가 이름을 깎아 만든 브랜치·pane 이름이 겹치는지를 계획 점검이 반영 전에 봐야 하고,
// 계획이 가정한 실행 수단과 실제로 도는 수단이 어긋나면 레인의 변경을 가져올 길이 없어지기 때문이다.

import { join } from 'node:path';

/** Herdr 에이전트 이름 규칙 [a-z][a-z0-9_-]{0,31} 로 깎는다 — 레인의 작업트리 브랜치(lane/<slug>/<이름>)와 pane 이름의 재료 */
export function laneName(s) {
  const n = String(s).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z]+/, '');
  return (n || 'lane').slice(0, 32);
}

// 구현 레인의 작업트리 브랜치 · 실행기 장부 · 회수한 패치의 자리. 실행기(herdr-lanes.mjs implement)가 쓰고, 이슈를 마감할 때의 정리
// (issue-start.mjs --remove-worktree → lib/worktree.mjs removeLaneLeftovers)가 같은 이름으로 찾는다 — 두 곳이 따로 적으면 정리가 아무것도 못 찾는다.
export const LANE_BRANCH_ROOT = 'lane/';
export const laneBranchPrefix = slug => `${LANE_BRANCH_ROOT}${slug}/`;
export const laneBranch = (slug, name) => `${laneBranchPrefix(slug)}${laneName(name)}`;
/** @param rt 메인 저장소 runtime 폴더의 절대 경로 */
export const laneLedgerFile = (rt, slug) => join(rt, 'herdr', `implement-${slug}.json`);
export const lanePatchFile = (rt, slug, lane) => join(rt, 'herdr', 'patches', `${slug}.lane-${lane}.patch`);
/** 실행기가 그 이슈의 레인 작업트리를 파는 기본 자리(herdr.worktree_dir 을 설정하지 않았을 때) — 레인마다 <이 폴더>/<laneName(레인)> 이다 */
export const laneWorktreeRoot = (rt, slug) => join(rt, 'herdr', 'worktrees', slug);

/** 레인 이름에 들어가면 결과 파일(<slug>.lane-<이름>.json)을 만들 수 없거나 엉뚱한 곳에 쓰게 되는 글자 */
export const LANE_NAME_BAD = /[\\/:*?"<>|\s]|^\.|\.$/;

/** 설정이 Herdr 구현 레인을 켰는가 — herdr.lanes 가 implement·all 이고 herdr.enabled 가 false 가 아니다(세션이 Herdr 안인지는 보지 않는다) */
export function herdrImplementOn(cfg) {
  const h = cfg?.herdr ?? {};
  return ['implement', 'all'].includes(h.lanes ?? 'off') && h.enabled !== false;
}

/**
 * 이 세션이 구현 레인을 돌리는 수단.
 *   'herdr'    — 레인마다 작업트리 + 에이전트 pane, 끝나면 패치로 회수한다(herdr-lanes.mjs implement). 세션이 Herdr 안이고 설정이 켜져 있을 때만
 *   'workflow' — 한 작업트리에서 도는 워크플로 레인(workflows/implement.js). 그 밖의 모든 세션 — 설정이 켜져 있어도 Herdr 밖이면 여기다
 */
export function laneRunner(cfg, herdrInside) {
  return herdrInside && herdrImplementOn(cfg) ? 'herdr' : 'workflow';
}

/** laneRunner 가 'workflow' 인 이유 한 구절(경고 문구용) — 'herdr' 면 null */
export function laneRunnerWhy(cfg, herdrInside) {
  if (laneRunner(cfg, herdrInside) === 'herdr') return null;
  if (!herdrInside) return 'Herdr 밖이다';
  return cfg?.herdr?.enabled === false ? 'herdr.enabled 가 false 다' : 'herdr.lanes 가 implement·all 이 아니다';
}
