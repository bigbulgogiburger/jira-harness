// proctree.mjs — 프로세스 트리 정리(Windows).
//
// 왜: 무거운 게이트는 이 PC 에서 한 번에 하나여야 한다(lib/queue.mjs). 그런데 직접 자식만 끝내면 그 아래 테스트 러너가 남아, 자리를 넘겨받은
//     다음 게이트와 겹쳐 돈다 — 시간 초과가 다음 차례의 시간 초과를 부른다.
//   killTree(pid)              살아 있는 프로세스를 트리째 끝낸다 — 신호를 받은 대기열 부모가 자식을 정리할 때
//   killOrphans(pid, startedMs) 이미 죽은 프로세스가 남긴 자손을 끝낸다 — spawnSync 의 timeout 이 셸만 죽인 뒤
// 둘 다 정리일 뿐 판정에 쓰지 않는다: 실패해도 던지지 않는다.
// 한계: Windows 밖에서는 killTree 가 신호 하나만 보내고 killOrphans 는 아무것도 하지 않는다(고아가 init 으로 넘어가 부모 pid 로 찾을 수 없다).
//     부모 프로세스에 매이지 않고 도는 것(gradle 데몬처럼 따로 떠 있는 서버)은 어느 OS 에서도 이 트리에 없다.
//     Git Bash(MSYS)에서 `#!/usr/bin/env …` 로 시작하는 실행 스크립트(npm · npx 등)를 거쳐 뜬 프로세스는 Windows 의 부모 pid 사슬이
//     중간에서 끊긴다(exec 한 중간 프로세스가 죽은 pid 로 남는다) — killTree(taskkill /T)도 killOrphans 도 그 아래에 닿지 못한다.
//     `#!/bin/sh` 스크립트(./gradlew)와 직접 실행한 명령은 이어진다(2026-11-19 실측 — 여덟 꼴). MSYS 프로세스 표로도 잇지 못했다
//     (단독 `npm run` 꼴에서 끊긴 쪽의 부모가 1 로 나온다). 닿게 하려면 단계를 띄울 때 묶어 두는 장치(Windows 작업 개체 등)가 있어야 한다.
//     닿지 않은 프로세스가 모두 계속 도는 것은 아니다: 게이트는 시간 초과 뒤 출력 파이프를 닫으므로, 표준출력·표준오류에 계속 쓰는
//     프로세스는 다음 쓰기에서 스스로 끝난다(0.2초마다 쓰는 것은 3초 안에 없어졌다). 아무것도 쓰지 않는 프로세스는 남는다(30초 뒤에도 일하고 있었다).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const WIN = process.platform === 'win32';
const SYS = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

/** 살아 있는 프로세스를 트리째 끝낸다(Windows: taskkill /T /F · 그 밖: 그 프로세스에 신호 하나) */
export function killTree(pid, sig = 'SIGTERM') {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (WIN) spawnSync(join(SYS, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000, stdio: 'ignore' });
    else process.kill(pid, sig);
  } catch { /* 이미 끝났다 */ }
}

/**
 * 프로세스 목록에서 root 의 자손 pid 를 고른다.
 * 부모 pid 는 재사용된다. 남의 프로세스를 고르지 않으려고 태어난 시각으로 두 번 거른다:
 *   - 「부모보다 먼저 태어난 자식」은 그 pid 의 예전 임자가 낳은 것이다 — 고르지 않고 그 아래도 따라가지 않는다.
 *   - 「root 가 죽은 뒤에 태어난 직계 자식」은 그 pid 를 새로 받은 임자가 낳은 것이다(rootDiedMs). 목록을 읽는 데 수 초가 걸려 그 사이
 *     죽은 root 의 pid 가 재사용될 수 있다. 이 상한은 root 단계에만 건다 — 그 아래는 목록에 살아 있는 부모를 따라가므로 pid 가 재사용됐을 수
 *     없고, 살아남은 러너는 root 가 죽은 뒤에도 워커를 낳는다. 여유는 두지 않는다: 놓치면 러너가 남을 뿐이지만 잘못 고르면 남의 작업을 끝낸다.
 * @param rows {pid, ppid, born(ms)}[]
 * @param rootStartedMs root 가 태어난 시각 — root 는 이미 죽어 목록에 없을 수 있다
 * @param opts.rootDiedMs root 가 죽은 시각(죽은 것을 안 직후의 시각) — 주지 않으면 상한 없음
 */
export function descendants(rows, rootPid, rootStartedMs, { slackMs = 1000, rootDiedMs = Infinity } = {}) {
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const out = [], seen = new Set([rootPid]);
  const walk = (pid, bornMs, diedMs) => {
    for (const c of kids.get(pid) ?? []) {
      if (seen.has(c.pid) || c.born < bornMs - slackMs || c.born > diedMs) continue;
      seen.add(c.pid);
      out.push(c.pid);
      walk(c.pid, c.born, Infinity);
    }
  };
  walk(rootPid, rootStartedMs, rootDiedMs);
  return out;
}

/**
 * (Windows) 이미 죽은 프로세스가 남긴 자손을 끝낸다.
 * @param rootDiedMs root 가 죽은 것을 안 시각 — 프로세스 목록을 읽기 전에 잡은 값이어야 한다(기본값은 이 함수에 들어온 시각)
 * @returns {number} 끝내려 한 프로세스 수 · -1 = 프로세스 목록을 읽지 못했다(아무것도 하지 않았다)
 */
export function killOrphans(rootPid, rootStartedMs, rootDiedMs = Date.now()) {
  if (!WIN || !Number.isInteger(rootPid) || rootPid <= 0) return 0;
  try {
    const ps = "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }";
    const r = spawnSync(join(SYS, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (r.status !== 0 || !r.stdout) return -1;
    const rows = r.stdout.split(/\r?\n/).map(l => l.trim().split(/\s+/).map(Number))
      .filter(a => a.length === 3 && a.every(Number.isFinite)).map(([pid, ppid, born]) => ({ pid, ppid, born }));
    const pids = descendants(rows, rootPid, rootStartedMs, { rootDiedMs }).filter(p => p !== process.pid);
    if (!pids.length) return 0;
    spawnSync(join(SYS, 'taskkill.exe'), ['/F', '/T', ...pids.flatMap(p => ['/PID', String(p)])], { windowsHide: true, timeout: 15_000, stdio: 'ignore' });
    return pids.length;
  } catch { return -1; }
}
