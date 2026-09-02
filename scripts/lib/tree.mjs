// tree.mjs — 지문 트리: 인덱스(또는 HEAD)에서 fingerprint_exclude 경로를 뺀 **실제 git 트리 객체** 를 만든다.
// 실제 트리 객체라서 diff-tree 로 "리뷰 이후 바뀐 파일" 을 셀 수 있고 refs/harness/* 로 고정(gc 방지)할 수 있다.
// 상태 JSON·게이트 로그(.claude/runtime/**)는 제외돼야 한다 — 게이트가 기록을 쓰는 순간 지문이 스스로 무효화되는 것을 막기 위해.
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git, gitLines } from './git.mjs';
import { matchesAny } from './config.mjs';

let seq = 0;

/** @param base 'index' | 'HEAD' */
export function fingerprintTree({ cwd, base = 'index', excludes = [] }) {
  const tmpIndex = join(tmpdir(), `jira-harness-index-${process.pid}-${Date.now()}-${seq++}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const source = base === 'index' ? git(['write-tree'], { cwd }).out : 'HEAD';
    git(['read-tree', source], { cwd, env });
    const listed = gitLines(['ls-files'], { cwd, env });
    const drop = listed.filter(p => matchesAny(p, excludes));
    // -f: 임시 인덱스에서만 빼는 것이라 "staged 내용이 파일·HEAD 와 다르다" 는 보호가 필요 없다(상태 JSON 이 add -A 로 올라간 경우가 그렇다)
    if (drop.length) git(['rm', '--cached', '-f', '-q', '-r', '--ignore-unmatch', '--pathspec-from-file=-'], { cwd, env, input: drop.join('\n') + '\n' });
    return git(['write-tree'], { cwd, env }).out;
  } finally {
    if (existsSync(tmpIndex)) { try { unlinkSync(tmpIndex); } catch { /* ignore */ } }
  }
}
