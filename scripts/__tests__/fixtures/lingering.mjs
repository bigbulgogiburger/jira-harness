// 시간 상한 테스트용 — 「셸 → 이 프로세스 → 손자」 트리를 만든다.
// 손자는 시작 표식(<marker>.started)을 곧바로, 끝 표식(<marker>)을 delayMs 뒤에 쓴다. 이 프로세스는 sleepMs 동안 떠 있는다.
// 셸만 끝내면 둘 다 남아 손자가 끝 표식을 쓴다 — 트리째 정리됐는지를 끝 표식의 유무로 본다.
// 사용: node lingering.mjs <marker> <delayMs> <sleepMs>
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [marker, delayMs, sleepMs, role] = process.argv.slice(2);
if (role === 'child') {
  writeFileSync(`${marker}.started`, String(process.pid));
  setTimeout(() => writeFileSync(marker, String(Date.now())), Number(delayMs));
} else {
  spawn(process.execPath, [process.argv[1], marker, delayMs, '0', 'child'], { stdio: 'ignore', windowsHide: true });
  setTimeout(() => {}, Number(sleepMs));
}
