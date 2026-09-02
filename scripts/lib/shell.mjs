// shell.mjs — 게이트 명령을 돌릴 셸을 고른다. gate.mjs(실행)와 setup.mjs(check 항목)가 **같은 탐색**을 써야 한다 —
// 두 벌로 갈리면 check 는 "bash 있음" 이라 보고한 뒤 게이트가 다른 셸로 도는 사고가 난다.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Windows 에서 Git Bash 를 찾는다. System32\bash.exe(WSL) 는 제외 — 프로젝트 도구(gradlew·npm)가 다른 세계에 산다. */
export function findBash() {
  const cands = [process.env.JIRA_HARNESS_BASH, 'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['bash'], { encoding: 'utf8', windowsHide: true });
  for (const line of (w.stdout ?? '').split(/\r?\n/)) {
    const p = line.trim().replace(/\\/g, '/');
    if (p && !/System32/i.test(p) && existsSync(p)) return p;
  }
  return null;
}

/**
 * harness.json.shell(auto|bash|cmd|sh) → { name, file, args(cmd) => argv }.
 * bash 를 명시했는데 없으면 code='NO_BASH' 인 Error 를 던진다(호출자가 종료 코드를 정한다).
 */
export function resolveShell(cfg) {
  const pref = cfg?.shell ?? 'auto';
  const cmdExe = () => ({ name: 'cmd', file: process.env.ComSpec ?? 'cmd.exe', args: c => ['/d', '/s', '/c', c] });
  const sh = () => ({ name: 'sh', file: '/bin/sh', args: c => ['-c', c] });
  if (pref === 'cmd') return cmdExe();
  if (pref === 'sh') return sh();
  if (pref === 'bash' || (pref === 'auto' && process.platform === 'win32')) {
    const bash = findBash();
    if (bash) return { name: 'bash', file: bash, args: c => ['-c', c] };
    if (pref === 'bash') { const e = new Error('bash 를 찾을 수 없다(JIRA_HARNESS_BASH 로 지정 가능)'); e.code = 'NO_BASH'; throw e; }
    return cmdExe();
  }
  return sh();
}
