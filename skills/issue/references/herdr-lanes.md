# Herdr 레인 — 다른 에이전트 pane 을 리뷰·구현 레인으로

세션이 Herdr pane 안(`HERDR_PANE_ID`)이고 `harness.json.herdr.lanes` 가 `verify`(리뷰 레인) · `implement`(구현 레인) · `all`(둘 다) 일 때만 이 문서가 적용된다(구현 레인은 `issue-start.mjs --status` 출력의 `lane_runner` 가 `herdr` 일 때 — 설정이 켜져 있어도 Herdr 밖 세션은 `workflow` 다). 아니면 stages-back.md §verify 의 Workflow 레인 그대로다.

**끝의 신호는 결과 파일 하나다**(리뷰·구현 레인 공통). 에이전트가 유휴가 됐다는 것은 끝났다는 뜻이 아니다 — 긴 명령을 돌려 두고 쉬는 중일 수 있다. 결과 파일 없이 유휴가 되면 실행기는 `herdr.settle_grace_s`(기본 30초) 지켜본 뒤 "결과 파일이 아직 없다 — 끝났으면 쓰고, 돌려 둔 명령을 기다리는 중이면 계속 기다리라" 고 **한 번** 알리고, `herdr.lane_timeout_s`(기본 900초)까지 결과 파일을 기다린다. 그 전에 닫는 경우는 에이전트가 사라졌을 때(pane 이 셸로 돌아왔다) · 사람이 봐야 하는 승인 화면에 섰을 때(`blocked`) · 알린 뒤에도 사용량 한도 화면일 때(`limit`)뿐이고, 리뷰 레인만은 알린 뒤 유휴가 `settle_grace_s` 의 4배 이어지면 닫는다(리뷰어는 돌려 둔 명령을 기다릴 일이 없다). 구현 레인의 상한은 `lane_timeout_s` 와 3600초 중 큰 값이다 — 기본 900초는 리뷰 레인 기준이라, 구현하고 자기 테스트를 도는 레인은 그 안에 못 끝난다. 레인의 테스트가 그보다 길면 `lane_timeout_s` 를 올린다.

## 왜 verify 부터인가

리뷰 레인의 가치는 **다른 눈**이다. Workflow 레인은 같은 Claude 모델이 같은 diff 를 다시 보는 것이라, `review.lanes_when=codex_gap` 규칙(Codex 가 판정을 냈으면 다시 심판하지 않는다)이 생겼다. Herdr 레인은 codex·grok·다른 claude 프로세스가 **자기 컨텍스트로** 심판하므로 maker≠verifier 가 모델 차원에서 성립하고, 화면이 보이며, 메인 세션 컨텍스트를 먹지 않는다.

## 절차 (라운드 1 의 2·3번을 대체)

1. 수정분을 `git add -A` 로 올린다(diff 기준을 인덱스로 고정).
2. 실행:
   ```bash
   node "<P>/scripts/herdr-lanes.mjs" verify --diff-ref "<default_branch>...HEAD" --files "<a,b,…>" --slug "<slug>" [--axes "<이번 관점>"] --cwd <루트> --json
   ```
   - `kinds` 는 `harness.json.herdr.kinds.verify`(기본 `["codex"]`). `--kinds codex,grok` 로 이번만 바꿀 수 있다.
   - 레인마다 pane 을 옆에 쪼개고(`pane split --no-focus` — 사용자의 초점은 그대로) 에이전트를 띄운 뒤, 프롬프트 **파일**을 읽으라는 한 줄만 보낸다. 결과는 `<runtime>/issues/<slug>.herdr-<kind>.json` 으로만 받는다.
   - 그 경로는 라운드마다 같다 — 실행기는 제출 전에 지난 결과를 `<slug>.herdr-<kind>.prev.json` 으로 치운다. 레인이 `failed` 로 끝난 뒤 pane 이 나중에 결과를 써서 **파일을 직접 읽을 때는** mtime 이 이번 제출 뒤인지와 findings 가 이번 diff 를 인용하는지부터 확인한다(2026-09-23 실측: 지난 라운드 결과를 23초 만에 반환 · 18.4초에 결과 없음으로 끝난 레인이 8분 뒤 결과를 씀).
   - 출력 `{ok, lanes[{name, kind, status, reason?, pane, out, seconds, count}], failed[], findings[{severity, file, line, claim, evidence, axis, lane}], blockers, lanes_reason}`.
3. **메인이 확정/기각** — Workflow 레인과 같다(finding 마다 한 줄 근거, 반증 에이전트 금지). `status` 가 `failed`·`blocked` 인 레인은 "이번 라운드가 안 본 축" 으로 보고에 남긴다 — 빈 초록으로 적지 않는다.
4. 기록: `<slug>.review.json` 의 `lanes` 에 **done 레인 수**, `lanes_reason` 에 출력의 `lanes_reason`(다른 모델 심판)을 넣어 `issue-set.mjs --review`. `codex` 필드는 codex-review.sh 결과 그대로(Herdr codex 레인은 별개의 심판이다 — 둘 다 돌았으면 둘 다 적는다).
5. pane 은 기본으로 남긴다(`herdr.close_panes=false`) — 사람이 근거 화면을 본다. 다 봤으면 `herdr pane close <id>`.

## implement — 레인마다 worktree + kind (`herdr.lanes: "implement"` 또는 `"all"`)

**쓰는 때는 이슈 여러 건을 한 번에 처리할 때다**(다중 키 · 하위이슈 — plan 이 이슈마다 레인 하나를 낸다. stages-front.md §implement). 이슈 1건은 드라이버가 직접 구현한다 — 한 이슈를 레인으로 쪼개면 띄우기·경계 맞추기·회수 비용이 병렬 이득보다 컸다(사용자가 명시했을 때만 예외). 레인이 1개면 띄우지 않는다 — 병렬 이득 없이 worktree 띄우기와 패치 회수만 남는다(드라이버가 조율만 맡고 구현을 다른 모델에 넘기는 운영일 때만 예외).

메인 Claude 는 오케스트레이션(계약·배정·회수·게이트·커밋)만 하고, 구현은 레인마다 **자기 worktree** 에서 그 일에 맞는 kind(claude·codex·grok)의 에이전트가 한다. 결과는 화면이 아니라 diff(패치)와 사이드카 JSON 으로 돌아온다.

```bash
node "<P>/scripts/herdr-lanes.mjs" implement --slug "<slug>" [--lanes be,fe] [--contracts-file <Phase 0 계약 md>] [--fresh] [--no-apply] [--dry-run] [--harvest] [--max-turns 60] --cwd <일하는 트리> --json
```

`--cwd` 는 드라이버가 일하는 트리다(메인 체크아웃이든 `issue-start.mjs --worktree` 로 판 이슈 작업트리든) — 레인은 그 트리의 HEAD 에서 갈리고 패치도 그 트리에 적용된다. 상태 JSON·장부·패치·레인 작업트리는 어느 트리에서 부르든 **메인 저장소의 runtime** 에 모인다.

절차(레인마다 — 전부 띄운 뒤 기다린다. 벽시계는 레인 최대값):

1. **kind 배정** — 상태 JSON `lanes[].kind`(plan 이 `kind_reason` 과 함께 고른 것)가 있으면 그대로(`kind_source: plan`), 없으면 `herdr.kinds.implement` 풀에서 순서대로(`pool` · 기계적·재현 가능 · 기본 `["claude"]`). "어느 kind 가 어느 일을 잘하나" 표(`herdr.kinds.profiles`, 없으면 실행기 기본값 `DEFAULT_KIND_PROFILES`)는 **가설**이다 — 레인 기록(`lanes[].result` 의 kind·status·tests·seconds)이 쌓여야 말할 수 있으므로 설정으로 바꿀 수 있는 자리에 둔다.
2. **worktree + pane** — 배치는 `herdr.lane_placement`. **`split`(기본)**: 브랜치 `lane/<slug>/<name>` 을 git 이 `<runtime>/herdr/worktrees/<slug>/<name>`(`herdr.worktree_dir` 로 변경 · gitignore 안)에 직접 파고, pane 은 **driver 옆에 split**(`--cwd` 그 경로 · 새 워크스페이스를 열지 않는다 — 사람이 같은 화면에서 레인을 본다). 체크아웃이 이미 있으면 그 경로를 쓴다(`mode: existing`). **`workspace`**: `herdr worktree create` 로 레인마다 워크스페이스를 연다(이미 열려 있으면 `open` 재사용 · `mode: already-open`). 어느 쪽이든 장부(`<runtime>/herdr/implement-<slug>.json`)에 지난 패치가 `applied` 로 남아 있으면 `--fresh` 없이도 지우고 새로 판다 — 낡은 diff 를 두 번 적용하지 않기 위해. 체크아웃은 없는데 브랜치만 남아 있고 HEAD 에 없는 커밋이 없으면 지우고 판다 — 그대로 두면 **옛 베이스**를 체크아웃한다(실측). `herdr.worktree_copy`(gitignore 파일 복사 — `.claude/harness.env.local` 등) · `herdr.worktree_init`(셸 명령 — `npm ci` 등)이 새 worktree 를 준비한다.
3. **프롬프트** — worktree 경로·브랜치·가이드·Phase 0 계약(`--contracts-file`)·담당 파일·`brief`·레인 DoD·규율(커밋·push·stash·브랜치 전환 금지 · 담당 파일 밖 금지 · seam 은 notes 에)·검증 규칙을 파일로 쓰고 "그 파일을 읽으라" 한 줄만 보낸다.
   **검증 규칙 — 레인은 자기 테스트만, 한 번에 묶어서 돌린다.** 레인의 `dod`(plan 이 적은 DoD id)에 tests 항목이 있으면 지시문에 `node "<P>/scripts/gate.mjs" --try --slug <slug> --lane <name> --cwd <레인 작업트리>` 가 들어간다 — 그 레인의 DoD 테스트를 스택마다 한 번에, push 전 게이트가 DoD 를 재는 것과 같은 명령·환경 파일·판정으로 돌리되 **상태·판정을 기록하지 않는다**(로그 파일만 남는다 — 상태 JSON 은 메인 것 하나이고 게이트 기록은 드라이버만 쓴다). 실패하면 출력의 「다시」 줄(`--try --stack <스택> --select '<실패한 것>'`)로 실패한 것만 다시 돌고, 통과 건수 하한까지 다시 재려면 「항목판정」 줄(`--try --slug <slug> --ids <실패한 항목>`)을 쓴다. `dod` 가 없는 레인은 `--stack/--select` 로 자기가 쓴 테스트를 고른다. 묶어 돌리는 설정(`dod_tests`)이 없는 스택이 섞여 있으면 지시문이 그 스택은 러너를 직접 부르라고 따로 알린다. 레인이 돌리지 않는 것: 전체 테스트 · 전체 lint · build · 위반 주입 프로브 — 드라이버가 레인을 합친 트리의 게이트에서 한 번 돈다(레인마다 돌리면 같은 검사가 레인 수만큼 반복되고, 동시에 도는 러너끼리 서로를 느리게 한다). 테스트 실행이 3번 안팎을 넘기면 레인은 `partial` 로 보고하고 드라이버가 합친 트리에서 이어 한다. 결과 JSON 은 `<runtime>/issues/<slug>.lane-<name>.json`(implement.js 사이드카와 같은 모양 `{name, status: done|partial|failed, files, tests{command, passed, failed}, notes}`).
4. **회수·적용** — 레인이 끝나면(결과 파일 없이 닫혔어도) worktree 의 변경 전부를 `git add -A → diff --cached --binary → reset` 으로 패치(`<runtime>/herdr/patches/<slug>.lane-<name>.patch`)로 뽑는다. 레인 status 가 `done` 이고 사이드카가 `failed` 가 아닐 때만 메인에 `git apply`(안 들어가면 `--3way`) 한다. `applied`: `yes` · `conflict`(메인이 푼다 — 표식 `<<<<<<<` 또는 `apply_error`. 메인 작업트리가 같은 파일을 고쳐 둔 상태도 여기다) · `skipped`(레인 실패·사이드카 failed·패치 실패) · `empty`(변경 0) · `no-apply`.
5. **기록** — `issue-set.mjs --lane` 으로 `lanes[]` 의 그 레인에 `kind`·`kind_source`·`result{status, lane_status, tests, files, patch, applied, seconds}` 를 남긴다(plan 이 쓴 `model`·`files`·`brief` 는 보존). 그 다음은 stages-front.md §implement 그대로 — seam(레인 경계) 대조 → `gate --commit` → commit(훅). **레인은 커밋하지 않는다. 커밋 권한은 언제나 메인의 훅·safe-commit 이다.**

**`--harvest` — 실행기 없이 결과만 회수한다.** 실행기가 레인보다 먼저 끝났을 때(셸이 죽었다 · 시간 상한에 걸려 닫은 뒤 결과가 왔다) 쓴다. 레인을 다시 띄우지 않고(pane 의 에이전트는 그대로 돌고 있다) 이미 있는 결과 파일과 레인 작업트리만 읽어 위 4·5번을 그대로 한다 — Herdr 밖에서도 된다. 장부에 이미 들어간 것으로 남은 레인(`yes` · `conflict`)은 건너뛰고(같은 diff 를 두 번 넣지 않는다), 결과 파일이 아직 없는 레인은 `pending: true` 로 보고만 하고 그 작업트리·장부·상태에 손대지 않는다 — 끝난 뒤 다시 부른다.

전제: Phase 0 계약은 **먼저 커밋**한다 — worktree 는 일하는 트리의 HEAD 에서 갈리므로 커밋 안 된 수정은 레인이 못 본다(출력 `dirty_base` 가 그 목록이다). `--dry-run` 은 배정·브랜치·프롬프트만 보여주고 Herdr 를 부르지 않는다. worktree 는 끝나도 남는다(`herdr.close_panes` 와 무관 — 사람이 화면을 본다). `split` 배치의 레인 작업트리와 레인 브랜치는 **이슈를 마감할 때 `issue-start.mjs --remove-worktree <KEY>` 가 한꺼번에 치운다**(stages-back.md §complete 7 — pane 은 먼저 `herdr pane close <id>`. 회수되지 않은 변경이 있는 작업트리와 레인이 커밋한 브랜치는 남기고 사유를 낸다). 그 전에 하나만 치우려면 `--remove-worktree <경로>`(안의 링크를 먼저 끊고 지운다 — `git worktree remove`·폴더 삭제를 손으로 하면 링크를 따라 메인 쪽 폴더가 지워진다 · 브랜치는 남고 마감 때의 정리가 치운다). `workspace` 배치면 `herdr worktree remove --workspace <id>`.

하위이슈 브랜치(상태 JSON `subtasks`)에서는 **레인 = 하위이슈 한 건**이다 — `lanes[].key` 에 그 이슈 키, `name` 은 키를 소문자로 줄인 것(`abc-538`, 위 이름 규칙). 다른 하위가 의존하는 선행 하위(DDL·공통 계약)는 레인이 아니라 Phase 0 로 메인이 먼저 커밋한다. 상세는 stages-front.md §implement.

## 상주 reviewer — Codex 판정 자체를 pane 으로 (`review.codex_via: "herdr"`)

라운드 1 의 1번(Codex 판정)도 pane 으로 옮길 수 있다. `codex-review.sh` 는 호출마다 `codex exec` 를 새로 띄워 저장소를 처음부터 보고, 출력 상한에 잘리며, 화면이 없다. 상주 codex 는 셋 다 없다.

```bash
node "<P>/scripts/herdr-lanes.mjs" codex-review [--since <tree>] --files "<a,b>" --slug "<slug>" [--axes "…"] --cwd <루트> --json
```

- **있으면 쓰고 없으면 띄운다.** `agent list` 에서 이름 `review-codex` 이거나(같은 kind · 같은 cwd · `idle`/`done`) 인 에이전트를 재사용한다. `working` 이면 `busy` 로 보고한다(기다리거나 다른 이름으로 하나 더).
- **컨텍스트 수명** `herdr.reviewer_context` — `issue`(기본): 이슈 slug 가 바뀌면 `/new` · `always`: 매 호출 · `never`. 장부는 `<runtime>/herdr/reviewer-codex.json`.
- **계약은 exec 와 같다.** 마지막 줄 `CODEX_RESULT={"status":"ok|limit|fail|missing",…}`. `limit` 은 pane 결과 파일의 `{"status":"limit"}` 또는 화면의 한도 문구로 판정하고, 감추지 않는다. `missing`(Herdr 밖·설정 exec) 이면 라우터가 `codex-review.sh` 로 간다.
- 결과 파일 `<runtime>/issues/<slug>.herdr-codex.json`(델타는 `-delta`). 재사용한 pane 은 절대 닫지 않는다.

## runner — 게이트를 driver 밖에서

```bash
node "<P>/scripts/herdr-lanes.mjs" gate --full|--commit [--stage-all] [--no-wait] --cwd <루트> --json
```

runner pane(라벨 `runner`, `<runtime>/herdr/runner-<slug>.json` 에 기억 — 일하는 트리마다 하나다 · `pane get` 으로 생사 확인 후 재사용)에서 `gate-run` 을 돌린다. 한 프로세스가 gate.mjs 실행·결과 파일·완료 표식(`GATE_DONE_<nonce>`)까지 맡아 pane 셸이 bash 든 PowerShell 이든 같다. driver 는 `pane wait-output` 으로 표식만 기다리거나 `--no-wait` 로 바로 돌아와 gate.mjs 의 토스트를 받는다. 게이트 기록(상태 JSON·트리 지문)은 gate.mjs 가 그대로 쓴다 — 훅 판정은 달라지지 않는다.

## 실행기가 스스로 처리하는 함정(실측 4종)

| 함정 | 증상 | 실행기 처리 |
|------|------|------------|
| 프롬프트 미제출 | `agent prompt` 는 성공인데 입력창에 글만 남고 상태 `idle` | 제출 뒤 `agent get` 을 6초 폴링, working/blocked 가 아니고 화면에 우리 문장이 남았으면 `send-keys enter` 1회(결과 `nudged:true`) |
| alt-screen 스크롤백 | claude·grok 은 `agent read --lines 500` 도 20줄 | 결과는 파일로만. 화면은 실패 진단용 꼬리 600자(`screen_tail`) |
| Windows codex 샌드박스 | `CreateProcessWithLogonW failed: 1385`, 빈손 종료 | `kind_args.codex` 기본값 `--sandbox danger-full-access --ask-for-approval never`(win32). 기동 직후 업데이트 안내는 Skip |
| claude teach 다이얼로그 | 첫 턴 뒤 "Teach auto mode…" 로 `agent_blocked` | blocked 화면이 **그 문구일 때만** `esc` 1회(결과 `escaped:true`). 그 외 승인·권한 UI 는 `status:"blocked"` 로 보고 — 사람이 pane 을 본다 |
| codex 디렉터리 신뢰 다이얼로그 | 새 worktree(또는 미신뢰 저장소)에서 기동 직후 "Do you trust the contents of this directory?" 에 `idle` 로 선다. **그 상태로 프롬프트를 보내면 글자가 선택키로 먹혀 codex 가 quit 하고, 남은 텍스트가 셸에서 실행된다**(2026-09-14 실측) | 기동 직후 사다리: 화면이 그 문구면 `enter`(1. Yes — 레인 cwd 는 언제나 이 프로젝트 자신의 worktree) · 업데이트 안내면 Skip · teach 면 esc. `herdr.auto_trust=false` 면 `blocked` 로 보고(결과 `dialogs:[…]`) |
| 에이전트 소실 | 다이얼로그에서 quit 하거나 기동에 실패해 pane 이 셸 프롬프트로 돌아온 상태 | 프롬프트 **전·후** `agent get` 으로 생존 확인 — 없으면 아무 입력도 보내지 않고 `failed`(사유 "종료됐다") + `screen_tail` 은 pane 화면 |

## 하지 않는 것

- blocked 다이얼로그(권한·승인·질문)에 자동으로 답하지 않는다.
- 리뷰 레인이 코드를 고치게 하지 않는다(프롬프트에 읽기 전용 명시). 고치는 레인은 implement 뿐이고, 그것도 **자기 worktree** 안에서만 — 메인 체크아웃을 레인이 직접 만지지 않는다.
- 레인에게 커밋을 시키지 않는다 — 커밋해 버린 레인(규율 위반)의 변경도 잃지 않도록 회수는 "worktree HEAD 대비" 가 아니라 "지금 트리 vs 그 worktree 의 HEAD" 로 잰다.
- 레인 실패로 라우터를 죽이지 않는다 — exit 0, `lanes[].status` 로 판정. Herdr 밖이면 전 레인 `outside herdr` → Workflow 레인으로 돌아간다.

## 직접 spec 으로 돌리기(리뷰 밖 용도)

```json
{ "lanes": [ { "name": "probe-grok", "kind": "grok", "prompt_file": "notes/probe.md", "out": ".claude/runtime/lanes/probe-grok.json" } ],
  "timeout_s": 600, "close_panes": false }
```

`node "<P>/scripts/herdr-lanes.mjs" run --spec <file> --json`. 레인 이름은 Herdr 규칙 `[a-z][a-z0-9_-]{0,31}` 이고 살아 있는 에이전트끼리 유일해야 한다.
