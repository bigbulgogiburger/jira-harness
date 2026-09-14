# Herdr 레인 — 다른 에이전트 pane 을 리뷰·구현 레인으로

세션이 Herdr pane 안(`HERDR_PANE_ID`)이고 `harness.json.herdr.lanes` 가 `verify`(리뷰 레인) · `implement`(구현 레인) · `all`(둘 다) 일 때만 이 문서가 적용된다. 아니면 stages.md 의 Workflow 레인 그대로다.

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
   - 출력 `{ok, lanes[{name, kind, status, reason?, pane, out, seconds, count}], failed[], findings[{severity, file, line, claim, evidence, axis, lane}], blockers, lanes_reason}`.
3. **메인이 확정/기각** — Workflow 레인과 같다(finding 마다 한 줄 근거, 반증 에이전트 금지). `status` 가 `failed`·`blocked` 인 레인은 "이번 라운드가 안 본 축" 으로 보고에 남긴다 — 빈 초록으로 적지 않는다.
4. 기록: `<slug>.review.json` 의 `lanes` 에 **done 레인 수**, `lanes_reason` 에 출력의 `lanes_reason`(다른 모델 심판)을 넣어 `issue-set.mjs --review`. `codex` 필드는 codex-review.sh 결과 그대로(Herdr codex 레인은 별개의 심판이다 — 둘 다 돌았으면 둘 다 적는다).
5. pane 은 기본으로 남긴다(`herdr.close_panes=false`) — 사람이 근거 화면을 본다. 다 봤으면 `herdr pane close <id>`.

## implement — 레인마다 worktree + kind (`herdr.lanes: "implement"` 또는 `"all"`)

메인 Claude 는 오케스트레이션(계약·배정·회수·게이트·커밋)만 하고, 구현은 레인마다 **자기 worktree** 에서 그 일에 맞는 kind(claude·codex·grok)의 에이전트가 한다. 결과는 화면이 아니라 diff(패치)와 사이드카 JSON 으로 돌아온다.

```bash
node "<P>/scripts/herdr-lanes.mjs" implement --slug "<slug>" [--lanes be,fe] [--contracts-file <Phase 0 계약 md>] [--fresh] [--no-apply] [--dry-run] [--max-turns 60] --cwd <루트> --json
```

절차(레인마다 — 전부 띄운 뒤 기다린다. 벽시계는 레인 최대값):

1. **kind 배정** — 상태 JSON `lanes[].kind`(plan 이 `kind_reason` 과 함께 고른 것)가 있으면 그대로(`kind_source: plan`), 없으면 `herdr.kinds.implement` 풀에서 순서대로(`pool` · 기계적·재현 가능 · 기본 `["claude"]`). "어느 kind 가 어느 일을 잘하나" 표(`herdr.kinds.profiles`, 없으면 실행기 기본값 `DEFAULT_KIND_PROFILES`)는 **가설**이다 — 레인 기록(`lanes[].result` 의 kind·status·tests·seconds)이 쌓여야 말할 수 있으므로 설정으로 바꿀 수 있는 자리에 둔다.
2. **worktree + pane** — 배치는 `herdr.lane_placement`. **`split`(기본)**: 브랜치 `lane/<slug>/<name>` 을 git 이 `<runtime>/herdr/worktrees/<slug>/<name>`(`herdr.worktree_dir` 로 변경 · gitignore 안)에 직접 파고, pane 은 **driver 옆에 split**(`--cwd` 그 경로 · 새 워크스페이스를 열지 않는다 — 사람이 같은 화면에서 레인을 본다). 체크아웃이 이미 있으면 그 경로를 쓴다(`mode: existing`). **`workspace`**: `herdr worktree create` 로 레인마다 워크스페이스를 연다(이미 열려 있으면 `open` 재사용 · `mode: already-open`). 어느 쪽이든 장부(`<runtime>/herdr/implement-<slug>.json`)에 지난 패치가 `applied` 로 남아 있으면 `--fresh` 없이도 지우고 새로 판다 — 낡은 diff 를 두 번 적용하지 않기 위해. 체크아웃은 없는데 브랜치만 남아 있고 HEAD 에 없는 커밋이 없으면 지우고 판다 — 그대로 두면 **옛 베이스**를 체크아웃한다(실측). `herdr.worktree_copy`(gitignore 파일 복사 — `.claude/harness.env.local` 등) · `herdr.worktree_init`(셸 명령 — `npm ci` 등)이 새 worktree 를 준비한다.
3. **프롬프트** — worktree 경로·브랜치·가이드·Phase 0 계약(`--contracts-file`)·담당 파일·`brief`·레인 DoD·규율(커밋·push·stash·브랜치 전환 금지 · 담당 파일 밖 금지 · seam 은 notes 에 · 테스트 실행 건수 기록)을 파일로 쓰고 "그 파일을 읽으라" 한 줄만 보낸다. 결과 JSON 은 `<runtime>/issues/<slug>.lane-<name>.json`(implement.js 사이드카와 같은 모양 `{name, status: done|partial|failed, files, tests{command, passed, failed}, notes}`).
4. **회수·적용** — 레인이 끝나면(결과 파일이 없어도) worktree 의 변경 전부를 `git add -A → diff --cached --binary → reset` 으로 패치(`<runtime>/herdr/patches/<slug>.lane-<name>.patch`)로 뽑는다. 레인 status 가 `done` 이고 사이드카가 `failed` 가 아닐 때만 메인에 `git apply`(안 들어가면 `--3way`) 한다. `applied`: `yes` · `conflict`(메인이 푼다 — 표식 `<<<<<<<` 또는 `apply_error`. 메인 작업트리가 같은 파일을 고쳐 둔 상태도 여기다) · `skipped`(레인 실패·사이드카 failed·패치 실패) · `empty`(변경 0) · `no-apply`.
5. **기록** — `issue-set.mjs --lane` 으로 `lanes[]` 의 그 레인에 `kind`·`kind_source`·`result{status, lane_status, tests, files, patch, applied, seconds}` 를 남긴다(plan 이 쓴 `model`·`files`·`brief` 는 보존). 그 다음은 stages.md §implement 그대로 — seam(레인 경계) 대조 → `gate --commit` → commit(훅). **레인은 커밋하지 않는다. 커밋 권한은 언제나 메인의 훅·safe-commit 이다.**

전제: Phase 0 계약은 **먼저 커밋**한다 — worktree 는 메인 HEAD 에서 갈리므로 커밋 안 된 수정은 레인이 못 본다(출력 `dirty_base` 가 그 목록이다). `--dry-run` 은 배정·브랜치·프롬프트만 보여주고 Herdr 를 부르지 않는다. worktree 는 끝나도 남는다(`herdr.close_panes` 와 무관 — 사람이 화면을 본다) — 닫기는 `herdr worktree remove --workspace <id>`.

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

runner pane(라벨 `runner`, `<runtime>/herdr/runner.json` 에 기억 · `pane get` 으로 생사 확인 후 재사용)에서 `gate-run` 을 돌린다. 한 프로세스가 gate.mjs 실행·결과 파일·완료 표식(`GATE_DONE_<nonce>`)까지 맡아 pane 셸이 bash 든 PowerShell 이든 같다. driver 는 `pane wait-output` 으로 표식만 기다리거나 `--no-wait` 로 바로 돌아와 gate.mjs 의 토스트를 받는다. 게이트 기록(상태 JSON·트리 지문)은 gate.mjs 가 그대로 쓴다 — 훅 판정은 달라지지 않는다.

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
