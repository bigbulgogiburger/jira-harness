// queue.mjs — 이 PC 에서 「무거운 검사는 한 번에 하나」를 지키는 대기열.
//
// 왜: 여러 작업공간이 전체 테스트를 동시에 돌리면 서로 느려지고, 부하 때문에 이슈와 무관한 테스트가 시간 초과·공유 자원 충돌로 깨진다.
//     사람이 순번 파일을 손으로 넘기던 일을 러너가 스스로 한다 — 먼저 온 순서대로 하나씩.
// 무엇이 아닌가: 판정 장치가 아니라 처리량 장치다. 대기열 자체가 고장 나면(디렉토리·파이프를 못 만든다) 막지 않고 크게 알린 뒤 그냥 돈다(fail-open).
//     훅의 「못 읽으면 거부」와 반대다 — 대기열 때문에 대기열이 없던 때보다 나빠지면 안 된다.
// 어떻게:
//   자리   OS 가 프로세스에 쥐여 주는 이름 하나를 「듣고 있는」 프로세스가 임자다(Windows named pipe · 그 밖은 unix 소켓 파일).
//          러너는 명령을 동기 실행해 그동안 타이머가 멈춘다 — 하트비트로 살아 있음을 알릴 수 없다. 그래서 「프로세스가 살아 있는 동안 OS 가 잡아 주고,
//          죽으면(강제 종료 포함) OS 가 놓아 주는」 수단을 쓴다. 잠금 파일 + 하트비트는 임자가 죽으면 남의 손이 풀어 줘야 해서 쓰지 않는다.
//   순서   번호표 파일 <dir>/tickets/<class>-<도착 ms>-<pid>-<난수>.json. 기다리는 쪽은 타이머가 살아 있어 매 바퀴 표를 갱신하고,
//          맨 앞 표만 자리를 잡으러 간다. 죽은 프로세스의 표와 오래 갱신되지 않은 표는 지우고 건너뛴다.
//   안내   <dir>/holder-<class>.json (누가 · 무엇을 · 언제부터). 기다리는 쪽에 보여 줄 뿐 판정에 쓰지 않는다 — 자리의 진실은 OS 다.
// 한 저장소가 아니라 PC 전체가 공유한다: 디렉토리는 홈의 ~/.gate-queue (GATE_QUEUE_DIR 로 바꾼다 — 테스트는 반드시 따로 둔다).
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, rmdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** 이 시간 넘게 갱신되지 않은 번호표는 버려진 것으로 본다(임자 pid 가 다른 프로세스로 재사용된 경우까지 덮는다) */
const TICKET_STALE_MS = 120_000;
/** unix 소켓 파일을 물려받는 중이라는 표식 — 이보다 오래됐으면 물려받다 죽은 것이다 */
const TAKEOVER_STALE_MS = 10_000;

export function queueDir() { return resolve(process.env.GATE_QUEUE_DIR || join(homedir(), '.gate-queue')); }
/**
 * 이 실행은 줄을 서지 않는다 — GATE_QUEUE=off|0|false|no.
 * Windows 밖에서는 기본이 꺼짐이다: unix 소켓 쪽 자리(버려진 소켓 파일을 물려받는 길)는 실행으로 검증하지 못했다. 검증하지 못한 잠금을 기본으로 켜면
 * 대기열이 없던 때보다 나빠질 수 있다(멈춤·동시 실행) — 써 보려면 GATE_QUEUE=on.
 */
export function queueOff(env = process.env, platform = process.platform) {
  const v = (env.GATE_QUEUE ?? '').trim();
  if (/^(?:off|0|false|no)$/i.test(v)) return true;
  return platform !== 'win32' && !/^(?:on|1|true|yes)$/i.test(v);
}
/** 바깥 프로세스가 이미 자리를 쥐고 이 프로세스를 띄웠다 — 다시 줄을 서면 자기 자신을 기다린다 */
export function queueHeld(env = process.env) { return env.GATE_QUEUE_HELD === '1'; }

function endpoint(dir, cls) {
  if (process.platform !== 'win32') return join(dir, `${cls}.sock`);
  // 파이프 이름은 PC 전역이다 — 대기열 디렉토리마다 다른 이름이 되게 해 테스트용 대기열이 진짜 대기열과 섞이지 않게 한다
  return `\\\\.\\pipe\\gate-queue-${createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0, 16)}-${cls}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } // EPERM = 있지만 내 것이 아니다
}
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

function listen(path) {
  return new Promise(done => {
    const server = net.createServer(sock => sock.destroy()); // 들어오는 연결은 「듣는 프로세스가 있나」 확인일 뿐이다
    server.once('error', err => done({ ok: false, code: err.code ?? 'ERR', err }));
    server.listen({ path, exclusive: true }, () => { server.unref(); done({ ok: true, server }); });
  });
}

/** unix 소켓 파일에 듣는 프로세스가 있는가 — 거부(ECONNREFUSED)·소켓이 아님·없음이면 버려진 파일이다 */
function socketAlive(path) {
  return new Promise(done => {
    const c = net.connect({ path });
    const end = alive => { c.destroy(); done(alive); };
    c.once('connect', () => end(true));
    c.once('error', e => end(!['ECONNREFUSED', 'ENOTSOCK', 'ENOENT'].includes(e.code)));
    setTimeout(() => end(true), 500).unref(); // 답이 없다 = 임자가 동기 실행 중이라 받지 못할 뿐이다
  });
}

/**
 * 자리를 잡아 본다. {ok:true, server} · {ok:false}(임자가 있다) · {ok:false, fatal}(대기열을 쓸 수 없다)
 * unix 는 임자가 죽어도 소켓 파일이 남는다 — 듣는 프로세스가 없으면 지우고 다시 잡되, 둘이 동시에 지우고 둘 다 잡는 일이 없게
 * mkdir(원자적)로 「물려받는 중」 표식을 세운 쪽만 지운다.
 */
async function take(ep, dir, cls) {
  const r = await listen(ep);
  if (r.ok) return r;
  if (r.code !== 'EADDRINUSE') return { ok: false, fatal: r.err };
  if (process.platform === 'win32') return { ok: false };
  if (await socketAlive(ep)) return { ok: false };
  const guard = join(dir, `${cls}.takeover`);
  try { mkdirSync(guard); }
  catch {
    try { if (Date.now() - statSync(guard).mtimeMs > TAKEOVER_STALE_MS) rmdirSync(guard); } catch { /* 다음 바퀴에 다시 본다 */ }
    return { ok: false };
  }
  try {
    if (await socketAlive(ep)) return { ok: false }; // 표식을 세우는 사이 다른 쪽이 먼저 잡았다
    rmSync(ep, { force: true });
    const again = await listen(ep);
    return again.ok ? again : again.code === 'EADDRINUSE' ? { ok: false } : { ok: false, fatal: again.err };
  } finally { try { rmdirSync(guard); } catch { /* 남아도 TAKEOVER_STALE_MS 뒤에 치워진다 */ } }
}

/** 살아 있는 번호표를 도착 순으로 — 죽은 것·버려진 것은 지운다 */
function liveTickets(tdir, cls) {
  const out = [];
  const re = new RegExp(`^${cls}-\\d{13}-(\\d+)-[0-9a-f]+\\.json$`);
  for (const name of readdirSync(tdir).sort()) {
    const m = re.exec(name);
    if (!m) continue;
    const file = join(tdir, name);
    let dead = !pidAlive(Number(m[1]));
    if (!dead) { try { dead = Date.now() - statSync(file).mtimeMs > TICKET_STALE_MS; } catch { dead = true; } }
    if (dead) { try { rmSync(file, { force: true }); } catch { /* 다른 쪽이 먼저 지웠다 */ } continue; }
    out.push(file);
  }
  return out;
}

function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}초` : s < 5400 ? `${Math.round(s / 60)}분` : `${(s / 3600).toFixed(1)}시간`;
}

/** 지금 자리를 쥔 쪽 — 안내용. 기록의 pid 가 죽었으면(강제 종료 뒤 남은 파일) 모른다고 답한다 */
export function currentHolder(dir = queueDir(), cls = 'heavy') {
  const h = readJson(join(dir, `holder-${cls}.json`));
  return h && pidAlive(h.pid) ? h : null;
}

/**
 * 자리가 날 때까지 기다렸다가 잡는다.
 * @param opts.cls 대기열 이름(같은 이름끼리만 서로 기다린다). 기본 'heavy'
 * @param opts.info 기다리는 쪽에 보여 줄 것 — {project, what, cwd}
 * @param opts.maxWaitS 이 시간을 넘기면 포기한다(0 = 상한 없음)
 * @param opts.log 한 줄 알림(바로 잡았으면 부르지 않는다 — 기다릴 때만 처음 한 번과 noticeMs 마다)
 * @returns {Promise<{ok:true, waited_s:number, ahead:number, release:()=>void, broken?:string} | {ok:false, timedOut:true, waited_s:number, holder:object|null}>}
 *          broken 이 있으면 대기열을 쓰지 못해 기다리지 않고 통과시킨 것이다(fail-open)
 */
export async function acquire({ cls = 'heavy', info = {}, maxWaitS = 0, dir = queueDir(), log = () => {}, pollMs = 1000, noticeMs = 60_000 } = {}) {
  const t0 = Date.now();
  // 기다린 시간은 벽시계가 아니라 단조 시계로 잰다 — 기다리는 사이 시계가 고쳐지면(NTP·수동) 음수나 엉뚱한 값이 기록에 실린다
  const m0 = performance.now();
  const elapsedMs = () => performance.now() - m0;
  const waited = () => +(elapsedMs() / 1000).toFixed(1);
  let ticket = null;
  let maxAhead = 0;
  const dropTicket = () => { if (ticket) { try { rmSync(ticket, { force: true }); } catch { /* 남으면 다른 쪽이 치운다 */ } ticket = null; } };
  try {
    const tdir = join(dir, 'tickets');
    mkdirSync(tdir, { recursive: true });
    // 자리 이름은 디렉토리의 실제 경로로 만든다 — 같은 디렉토리를 junction·심볼릭 링크·다른 표기로 열어도 같은 자리를 다투게
    const ep = endpoint(realpathSync.native(dir), cls);
    const body = JSON.stringify({ ...info, cls, pid: process.pid, since: new Date(t0).toISOString() }) + '\n';
    ticket = join(tdir, `${cls}-${String(t0).padStart(13, '0')}-${process.pid}-${randomBytes(4).toString('hex')}.json`);
    writeFileSync(ticket, body, 'utf8');
    let lastNotice = -1; // 아직 알리지 않았다 — 기다리게 되면 첫 바퀴에 한 번 알린다
    let server = null;
    for (;;) {
      // 표를 갱신한다. 부하로 오래 멈춘 사이 남이 버려진 표로 보고 지웠으면 같은 이름(같은 순번)으로 다시 세운다
      try { const now = new Date(); utimesSync(ticket, now, now); } catch { writeFileSync(ticket, body, 'utf8'); }
      const ahead = Math.max(0, liveTickets(tdir, cls).indexOf(ticket));
      maxAhead = Math.max(maxAhead, ahead);
      if (ahead === 0) {
        const r = await take(ep, dir, cls);
        if (r.ok) { server = r.server; break; }
        if (r.fatal) throw r.fatal;
      }
      // 상한은 「더 기다리지 않는다」는 뜻이다 — 위에서 자리를 잡았으면 상한을 넘긴 바퀴라도 돈다(자리가 났는데 돌지 않을 까닭이 없다)
      const el = elapsedMs();
      if (maxWaitS > 0 && el >= maxWaitS * 1000) { dropTicket(); return { ok: false, timedOut: true, waited_s: waited(), holder: currentHolder(dir, cls) }; }
      if (lastNotice < 0 || el - lastNotice >= noticeMs) {
        lastNotice = el;
        const h = currentHolder(dir, cls);
        const who = h ? `${h.project ?? '?'} 의 ${h.what ?? '?'} (pid ${h.pid} · ${span(Date.now() - Date.parse(h.since))}째)` : '다른 프로세스';
        log(`대기열: 무거운 검사는 이 PC 에서 한 번에 하나만 돈다 — 지금 ${who}${ahead ? ` · 내 앞에 ${ahead}개` : ''} · 기다린 지 ${span(el)}${maxWaitS > 0 ? ` (상한 ${span(maxWaitS * 1000)})` : ''}. 줄을 서지 않으려면 --no-queue`);
      }
      await sleep(pollMs);
    }
    dropTicket();
    const holderFile = join(dir, `holder-${cls}.json`);
    try { writeFileSync(holderFile, JSON.stringify({ ...info, cls, pid: process.pid, since: new Date().toISOString() }) + '\n', 'utf8'); } catch { /* 안내 파일일 뿐이다 */ }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try { if (readJson(holderFile)?.pid === process.pid) rmSync(holderFile, { force: true }); } catch { /* 안내 파일일 뿐이다 */ }
      try { server.close(); } catch { /* 프로세스가 끝나면 OS 가 놓는다 */ }
    };
    return { ok: true, waited_s: waited(), ahead: maxAhead, release };
  } catch (e) {
    dropTicket();
    return { ok: true, waited_s: waited(), ahead: maxAhead, release() {}, broken: e?.message ?? String(e) };
  }
}
