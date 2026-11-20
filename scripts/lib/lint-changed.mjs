// lint-changed.mjs — 이슈 게이트(`gate.mjs --commit · --dod · --related`)의 lint 를 「이 변경이 건드린 파일」로 좁힌다.
//
// 왜: 전체 lint 는 캐시가 있어야 빠른데 캐시는 작업트리마다 따로다 — 이슈를 새 작업트리에서 시작하면 첫 lint 가 캐시 없이 전체를 돈다
//     (2026-11 실측: 이슈의 첫 lint 중앙 155초 · 그 뒤 28초 · 캐시 없는 전체 766초 · 파일 12개만 넘기면 40초).
//     전체 lint 는 `--full` 과 `--main`(머지 뒤 1회)이 그대로 돈다 — 안 바뀐 파일에서 새로 생긴 위반은 거기서 잡힌다.
//
// 설정 — harness.json `stacks.<name>.lint_changed = {run, match, always?, fallback_full?, max_files?}` (그 스택에 `lint` 가 있을 때만 쓴다):
//   run            `{files}` 자리에 바뀐 파일(스택 dir 기준 경로 · 따옴표 붙음)이 들어가는 명령
//   match          lint 대상 glob(스택 dir 기준) — **전체 lint 가 보는 범위와 같게** 쓴다. 넓으면 전체 lint 에 없던 실패가 나고, 좁으면 그 파일이 이슈 게이트를 그냥 지난다
//   always         파일 목록과 무관한 검사(다국어 키 검사 등) — 좁혀 돌 때 run 뒤에, 대상이 0개일 때는 이것만 돈다
//   fallback_full  하나라도 바뀌면 전체 lint 로 넘기는 glob(린트 설정·의존성 — 규칙이 바뀌면 안 바뀐 파일의 판정도 달라진다). 기본 LINT_FALLBACK_FULL
//   max_files      대상이 이보다 많으면 전체 lint(기본 200)
// 판정:
//   changed  바뀐 대상만 — run(+always)
//   none     바뀐 파일 중 대상이 없다 — always 만(없으면 lint 단계가 SKIPPED). 관련 테스트 게이트의 「고를 것 없음」과 같은 처리다:
//            전체로 넘기지 않고, 「검사 0」을 PASS 가 아니라 SKIPPED 와 요약 줄로 드러낸다
//   full     전체 lint — fallback_full 에 걸림(스택 dir 의 조상 폴더에 바로 놓인 파일 포함 — 린터는 위 폴더의 설정도 읽는다) · max_files 초과 ·
//            명령줄이 너무 길다 · 셸이 cmd(파일 이름을 안전하게 감싸 넘길 수 없다) · lint_changed 설정 없음
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { matchesAny } from './config.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const LINT_MAX_FILES = 200;
/** 명령줄 길이 상한 — Windows 는 한 명령이 32,767자를 넘지 못한다 */
export const LINT_MAX_CMD_CHARS = 30000;
/** 규칙이나 린터 자체를 바꾸는 파일 — 바뀌면 안 바뀐 파일의 판정도 달라지므로 전체 lint 로 넘긴다(설정의 fallback_full 이 있으면 그것으로 바꾼다) */
export const LINT_FALLBACK_FULL = Object.freeze([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.eslintrc', '.eslintrc.*', 'eslint.config.*', '.eslintignore',
  '.prettierrc', '.prettierrc.*', 'prettier.config.*', '.prettierignore',
  'tsconfig.json', 'tsconfig.*.json', 'jsconfig.json',
  '.stylelintrc', '.stylelintrc.*', 'stylelint.config.*',
]);

/**
 * @param {object} a
 * @param {object} a.stack     harness.json 의 스택({lint, lint_changed})
 * @param {string} a.stackDir  스택 디렉터리 절대 경로
 * @param {string[]} a.files   스택 디렉터리 기준 경로 — 이 게이트가 보는 변경(삭제 포함)
 * @param {string[]} [a.above] 스택 디렉터리의 조상 폴더에 바로 놓인 변경 파일의 이름 — fallback_full 판정에만 쓴다(lint 대상이 되지는 않는다)
 * @param {string} [a.shell]   게이트 명령을 돌리는 셸 이름(bash·sh·cmd). cmd 면 좁혀 돌지 않는다 — 작은따옴표가 인자에 그대로 남고 한 줄 상한(8,191자)도 다르다
 * @param {number} [a.maxCmdChars]
 * @returns {{mode:'changed'|'none'|'full', cmds:string[], files:number, reason:string}} cmds 가 비면 lint 단계는 돌 것이 없다
 */
export function planLint({ stack, stackDir, files, above = [], shell = 'bash', maxCmdChars = LINT_MAX_CMD_CHARS }) {
  const lc = stack.lint_changed;
  const full = reason => ({ mode: 'full', cmds: stack.lint ? [stack.lint] : [], files: 0, reason });
  if (!stack.lint) return full('lint 명령 없음');
  if (!lc) return full('lint_changed 설정 없음');
  if (shell === 'cmd') return full('셸이 cmd 라 파일 목록을 안전하게 넘길 수 없다 → 전체 lint(Git Bash 가 있으면 좁혀 돈다)');
  const rel = [...new Set(files.map(fwd))];
  const fallback = lc.fallback_full ?? LINT_FALLBACK_FULL;
  const global = [...rel.filter(p => matchesAny(p, fallback)), ...[...new Set(above.map(fwd))].filter(p => matchesAny(p, fallback)).map(p => `(상위 폴더) ${p}`)];
  if (global.length) return full(`lint 설정·의존성이 바뀌었다(${global.slice(0, 5).join(', ')}) → 전체 lint`);
  const always = lc.always ? [lc.always] : [];
  const targets = rel.filter(p => matchesAny(p, lc.match) && existsSync(join(stackDir, p))).sort();
  if (!targets.length) return { mode: 'none', cmds: always, files: 0, reason: `바뀐 파일 중 lint 대상이 없다 — ${always.length ? '파일과 무관한 검사(always)만 돌았다' : 'lint 를 돌리지 않았다(검사 0)'}` };
  const max = lc.max_files ?? LINT_MAX_FILES;
  if (targets.length > max) return full(`lint 대상 ${targets.length}개 > ${max} → 전체 lint`);
  const cmd = lc.run.split('{files}').join(targets.map(shq).join(' '));
  if (cmd.length > maxCmdChars) return full(`명령줄 ${cmd.length}자 > ${maxCmdChars} → 전체 lint`);
  return { mode: 'changed', cmds: [cmd, ...always], files: targets.length, reason: `바뀐 파일 ${targets.length}개` };
}
