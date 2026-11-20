Codex 질문 도구: `request_user_input`은 제공되는 모드에서만 사용한다. 사용할 수 없으면 `request_user_input_async` 또는 간결한 평문 질문을 사용한다. 승인 요청은 현재 세션의 상위 지침을 따르고, 응답이 없다는 이유로 승인 처리하지 않는다.
# issue 단계별 절차 — 뒤 절반 (verify · gate · commit·push · complete · main 배치)

`<P>` = 설치된 플러그인 루트. 스크립트는 `node "<P>/scripts/<이름>.mjs"` 이고 `--json` 이면 마지막 줄이 JSON 한 덩어리다 — 그것만 읽으면 된다.
`<runtime>` = `harness.json.runtime_dir`(기본 `.codex/runtime` — 작업트리에서 실행해도 메인 저장소 것을 쓴다), `<slug>` = 브랜치 이름의 `/` 를 `-` 로 바꾼 것, 상태 JSON = `<runtime>/issues/<slug>.json`.
Codex 에는 Workflow 툴이 없고 이 배포본에는 `workflows/` 가 들어 있지 않다 — 리뷰 레인은 `scripts/lanes-codex.mjs` 가 돈다.
앞 절반(start · grill · plan · implement)은 [stages-front.md](stages-front.md).
## verify — 리뷰 사다리

라운드 1
1. `review.codex=true` 면 Codex 판정을 받는다. **경로는 `review.codex_via`** — `herdr`(Herdr 안): `node "<P>/scripts/herdr-lanes.mjs" codex-review [--since <tree>] --files <a,b> --slug <slug> --cwd <루트>` 가 워크스페이스에 상주하는 codex pane 을 재사용(없으면 띄움)해 심판하고, 이슈가 바뀌면 `/new` 로 컨텍스트를 비운다(`herdr.reviewer_context`). Herdr 밖이거나 `exec`(기본) 면 `bash "<P>/scripts/codex-review.sh" [--since <tree>]`. 두 경로 모두 마지막 `CODEX_RESULT={…}` 줄이 같은 계약이다 — herdr 경로가 `status:"missing"` 을 내면 exec 로 한 번 더 부른다. 마지막 `CODEX_RESULT={…}` 줄로 판정한다 — exit code 가 아니라 **본문 끝**이다. `status`: `ok`(blockers N) / `limit`(사용량 한도 — 2 로 가되 `codex:"limit"` 으로 기록해 폴백을 감추지 않는다) / `fail`. diff 본문은 argv 가 아니라 `out` 옆의 `.diff` 파일(`diff` 필드)로 넘어간다 — 큰 배치(50파일+)도 인자 한계에 걸리지 않는다. `--since` 델타는 **인덱스 트리** 기준이라 수정분을 `git add -A` 로 올린 뒤 부른다. 심판 모델·effort 는 `review.codex_model`·`review.codex_effort` 를 두 경로가 스스로 읽는다(인자로 넘기지 않는다 — 생략하면 codex 기본값). herdr 상주 reviewer 는 기동 시점 값을 유지하므로, 값을 바꿨으면 그 pane 을 닫고 다시 부른다.
2. **레인은 Codex 가 못 채운 자리에만 돈다** — `review.lanes_when`(기본 `codex_gap`). Codex 가 `ok` 로 판정을 냈으면 **같은 diff 를 Claude 레인으로 다시 심판하지 않는다**: 두 판정이 갈리면 결국 메인이 또 판정하고, 같으면 그 토큰은 통째로 낭비다. 레인을 도는 경우는 둘뿐 — ① Codex 판정이 없다(`missing`·`limit`·`fail`) → 레인이 리뷰를 **대체**한다 ② Codex 가 볼 수 없는 축이 이번 변경의 핵심이다(브라우저 좌표·런타임 화면·외부 호출 재현) → **그 축만**. 어느 쪽이든 기록에 `lanes_reason` 한 줄이 필요하고, 없으면 `issue-set.mjs --review` 가 거부한다. 매번 돌리려면 `always`, 아예 끄려면 `never`.
2b. **Herdr 안이고 `harness.json.herdr.lanes` 가 `verify` 면** 레인은 Workflow 가 아니라 Herdr pane 의 다른 에이전트(codex·grok…)다 — 절차는 [herdr-lanes.md](herdr-lanes.md). 다른 모델의 심판이므로 2번의 "같은 diff 를 다시 심판하지 않는다" 예외에 해당하고 `lanes_reason` 은 실행기 출력이 준다. 전 레인 `outside herdr`/failed 면 3번으로 돌아간다.
3. 레인을 돌 때 — `node "<P>/scripts/lanes-codex.mjs" verify --diff-ref <default_branch> --files <a,b,c> --axes "<축1,축2>" --lanes-max 4 --cwd <루트> --json`. `--files`에는 기준 브랜치 이후 변경과 staged·unstaged·untracked 변경을 모두 합쳐 전달한다. 델타는 `--delta-since <tree>`를 사용한다. 반환 계약은 `{findings, lanes, dropped, delta}`다. `lanes[].status=failed`는 검사 실패이고 findings 0은 성공 증거가 아니다. `dropped`와 0개 레인도 미검사 범위로 보고한다. 상한은 `review.lanes_max`를 따른다.
4. **메인이 확정/기각** — finding 마다 한 줄 근거. Codex finding 도 같은 자리에서 확정/기각한다(레인을 띄워 재심하지 않는다). finding 별 반증 에이전트를 띄우지 않는다(29→56 폭주 이력). 기각 사유 없이 버리지 않는다.
5. 기록: 확정 finding 을 `<runtime>/issues/<slug>.review.json` 으로 쓰고 `issue-set.mjs --review <파일> [--delta]`. 스크립트가 `tree`(현재 인덱스 지문)·`files`·`at`·`blockers_open`(확정 BLOCKER 수) 을 계산한다. **파일 모양은 상태 스키마를 따른다** — `{round?, codex: string(요약 한 줄 + 산출물 경로), lanes: integer(레인 수), lanes_reason?: string(레인>0 이면 필수 — 왜 Codex 로 안 끝났나), findings: [{severity, file, line, claim, evidence, axis, decision, reason?}] | integer, blockers_open?}`. 레인 목록·기각 사유 같은 상세는 같은 파일에 다른 키로 두지 말고(스키마 위반으로 저장 거부) `<slug>.review.detail.json` 처럼 별도 파일에 둔다.

라운드 2(라운드 1 에 blocker 가 있었을 때만): 수정 → 같은 순서로 **1차 blocker 축만** 재검(`axes` 를 그 축으로 좁힌다). `review.rounds_max`(기본 2) 를 넘지 않는다.

델타 패스(횟수 제한 없음): 라운드 뒤 수정으로 바뀐 파일만 — `codex-review.sh --since <review.tree>` 또는 `verify.js` 의 `delta:{sinceTree, files}` 1레인 → `issue-set.mjs --review <파일> --delta`. 한 번에 2~4분이라 "모든 수정을 한 커밋에 몰기" 를 강요하지 않는다.

`review.code_review=true` 면 내장 `/code-review` 도 돌린다(메인 세션 토큰을 쓰므로 기본 off).

## gate

- 커밋 전 `gate.mjs --commit [--stage-all]` — 컴파일·린트, **건드린 스택만**. DoD 는 돌리지 않는다(커밋마다 DoD 를 다시 돌린 것이 경량 게이트 시간의 86%였다). 목표 `gate.commit_budget_s`(기본 3분). 구현 중 새 테스트가 도는지는 `gate.mjs --try` 로 본다 — DoD tests 를 스택마다 한 번에 묶어 돌리는 **확인**이고 게이트가 아니다(상태·판정을 기록하지 않고 로그 파일만 남긴다. 훅도 이 결과를 보지 않는다 — stages-front.md §implement).
- **lint 범위** — 스택에 `lint_changed` 설정이 있으면 이슈 게이트(`--commit`·`--dod`·`--related`)의 lint 는 **그 게이트가 보는 변경 파일만** 넘겨 돈다(커밋 게이트 = 작업트리 변경 · `--dod`·`--related` = 이 브랜치가 바꾼 것 전부). 요약의 `lint 범위 <스택>: 바뀐 파일 N개만` 줄이 그 표시다. 바뀐 파일 중 lint 대상이 없으면 전체로 넘어가지 않고 파일과 무관한 검사(`always`)만 돌거나 lint 단계가 SKIPPED 로 남으며(`… lint 를 돌리지 않았다(검사 0)`), `전체 lint` 로 적혀 있으면 넘어간 까닭(lint 설정·의존성 변경 · 상한 초과 · cmd 셸)이 같이 적힌다 — 어느 쪽이든 보고에 그대로 적는다. 좁힌 lint 는 안 바뀐 파일을 보지 않으므로, 거기서 새로 생긴 위반은 `--main`·`--full` 의 전체 lint 에서 드러난다. 설정 방법과 켜기 전 확인은 setup 의 stack-defaults.md.
- push·complete 전 게이트는 `harness.json.gate.push_level` 이 정한다(훅·`issue-complete` 의 거부 사유에 필요한 명령이 그대로 적힌다).
  - **`related`** → `gate.mjs --related`: **DoD 프로브 먼저** → 이 브랜치가 바꾼 스택(기본 브랜치와의 merge-base 이후 + 작업트리)의 컴파일·린트 → **관련 테스트** → DoD tests 항목. 관련 테스트는 `stacks.<name>.dod_tests.adapter` 로 고른다 — gradle 은 바뀐 클래스 이름을 단어 단위로 쓰는 테스트 클래스 + 바뀐 테스트 자신(`--tests <FQCN>`), vitest 는 `vitest related --run <바뀐 파일>`(import 그래프). 빌드 설정·의존성·공용 리소스(`related.fallback_full`)가 바뀌었거나 선택이 상한을 넘으면 **그 스택만** 전체 테스트로 돈다. 고를 것이 없으면 테스트 단계는 SKIPPED 이고 요약 `related.<스택>: none · 테스트 0건` 이 보인다 — 보고에 그대로 적는다("위반 0" 이 아니라 "검사 0"). build·extra·전체 스위트는 이슈에서 돌지 않고 아래 **main 배치**로 간다.
  - **`dod`** → `gate.mjs --dod`: **DoD 프로브 먼저** → 이 브랜치가 바꾼 스택의 컴파일·린트 → DoD tests 항목. **관련 테스트 선택 단계도 돌지 않는다** — 공용 파일(locales·공용 클래스·마이그레이션)을 건드리면 관련 테스트가 스택 전체로 불어나 이슈마다 수십 분~1시간이 걸렸다. 이슈에서 도는 테스트는 DoD `tests` 항목뿐이고, 테스트(관련·전체)·build·extra 는 **여러 이슈를 머지한 뒤 기본 브랜치에서 `--main` 1회가 필수**다(배포·릴리즈 전). **Herdr 멀티 pane 으로 여러 이슈를 병렬 개발할 때 권한다.** DoD 에 `tests` 항목이 0개면 이 게이트는 테스트를 하나도 돌리지 않은 초록(「검사 0」)이라 요약에 `⚠ DoD tests 항목 0개` 경고가 붙는다(실패는 아님) — 보고에 그대로 적고, plan 에서 이슈의 핵심 행위를 덮는 `tests` 항목을 1개 이상 두는 것을 권한다. 위험은 결함이 `--main` 까지 늦게 드러나는 것이다 — 아래 **main 배치**의 용의 커밋 추적을 쓴다.
  - **`full`**(기본) → `gate.mjs --full`: DoD 프로브 먼저 → 빌드·전체 테스트·extra → DoD tests 항목.
  - 셋 다 DoD 프로브가 하나라도 FAIL 이면 스택 단계를 건너뛰고 끝난다(프로브를 고친 뒤 다시). 오래 걸리면 `exec_command`로 시작하고 반환된 session_id를 `write_stdin`으로 기다린다.
  - 이슈 게이트가 실패했을 때 **실패 테스트가 이 브랜치와 무관해 보이면**(공유 자원·부하·시간 초과) 그 테스트만 단독 재실행해 판정 근거를 남긴다. 전체 게이트를 같은 조건에서 몇 번이고 다시 돌리지 않는다 — 2회 연속 환경 요인이면 멈추고 보고한다.
- `--dod`·`--related`·`--full` 의 `--stacks a,b` 로 스택을 줄일 수 있지만 **이 브랜치가 바꾼 스택은 뺄 수 없다**(exit 2) — 기록은 결과만 남고 어느 스택이 돌았는지는 push·complete 가 다시 보지 않기 때문이다. 다른 스택의 파일을 읽는 테스트가 있으면 그 경로를 그 스택의 `stacks.<name>.paths` 에 넣어 둔다.
- **Herdr 안이면** 게이트를 runner pane 에서 돌린다 — `node "<P>/scripts/herdr-lanes.mjs" gate --dod|--related|--full|--main|--commit [--stacks a,b] [--stage-all] [--no-wait] --cwd <루트> --json`. 로그가 driver 컨텍스트 밖(pane)에 남고, 기록·토스트는 gate.mjs 가 그대로 한다. `--no-wait` 면 바로 돌아오고 완료 토스트(전량 PASS=done · FAIL=request)를 기다린다. 결과 JSON 은 출력의 `out`. 기다리는 쪽이 먼저 끝나 출력에 `pending: true` 가 오면 게이트는 pane 에서 아직 돌거나 대기열에서 차례를 기다리는 중이다 — 다시 띄우지 말고(같은 게이트가 줄에 하나 더 선다) `out` 파일이 생기기를 기다린다.
- 같은 트리에 전량·관련 테스트·dod 통과 기록(compile·lint PASS)이 이미 있으면 `--commit` 은 재실행을 생략한다.
- **대기열 — 무거운 게이트(`--full`·`--related`·`--main`)는 이 PC 에서 한 번에 하나만 돈다.** 다른 작업공간·worktree 의 무거운 게이트가 돌고 있으면 먼저 온 순서대로 기다리고, 그동안 `[gate] 대기열: … 지금 <프로젝트> 의 gate --main (pid · N분째) · 내 앞에 K개` 가 주기적으로 찍힌다. 전체 테스트가 겹쳐 돌면 서로 느려지고 부하 때문에 이슈와 무관한 테스트가 시간 초과·공유 자원 충돌로 깨지기 때문이다 — CPU 가 한가해지길 지켜보거나 순번을 손으로 맞추지 않는다. 기다림이 길 수 있으니 무거운 게이트는 백그라운드로 돌리고 알림을 기다린다. 기다린 시간은 결과의 `queue_wait_s` 에 남는다(실제로 걸린 시간 = `queue_wait_s` + `duration_s`) — 보고에 둘을 따로 적는다.
  - **Windows 에서만 기본으로 켜져 있다.** 그 밖의 OS 는 자리를 잡는 방식(unix 소켓)을 실행으로 검증하지 못해 기본이 꺼짐이다 — 써 보려면 환경변수 `GATE_QUEUE=on`.
  - 줄을 서지 않는 길: `--no-queue`(이번 한 번) · 환경변수 `GATE_QUEUE=off` · `harness.json` 의 `gate.queue: false`(이 프로젝트 전체). 남의 게이트와 겹쳐 돌게 되므로 까닭이 있을 때만 쓴다. `gate.queue_max_wait_s` 는 「그 시간을 넘기면 더 기다리지 않는다」는 뜻이다 — 넘긴 뒤에도 자리를 못 잡았으면 exit 75 로 끝나고(게이트는 돌지 않았고 기록도 없다 — 다시 실행한다), 그 순간 자리가 나 있으면 그대로 돈다.
  - 경량(`--commit`)·`--dod`·`--dry-run`·`--main --status` 는 줄을 서지 않는다 — 그래서 `push_level=dod` 프로젝트에서 줄을 서는 것은 `--main` 하나다.
  - 게이트가 아닌 무거운 명령(스택 전체 테스트를 직접 돌리는 스크립트·수동 실행)은 `node "<P>/scripts/queue-run.mjs" [--what <라벨>] [--max-wait <초>] [--no-queue] -- <명령>` 으로 같은 줄에 세운다. 줄을 서지 않은 명령(에이전트가 직접 친 `gradlew test`·`vitest run` 포함)은 대기열이 보지 못해, 차례를 받은 게이트와 겹쳐 돈다.
  - 대기열은 처리량 장치지 판정 장치가 아니다 — 대기열 자체가 고장 나면(디렉토리·파이프를 못 만든다) 막지 않고 크게 알린 뒤 그냥 돈다.
- DoD `tests: {stack, select[]}` 항목은 스택별로 **한 번에** 돈다(`stacks.<stack>.dod_tests` — gradle `--tests` 합집합 · vitest 경로 합집합 + JSON 리포터) — 러너 리포트로 항목마다 판정한다(걸린 것 1건 이상 · 실패 0 · 통과 ≥ `min_tests`). test 명령이 `dod_tests.run` 과 같으면 그 리포트를 읽기만 하고 다시 돌리지 않는다. `probe` 문자열 항목은 항목마다 돈다 — 테스트를 도는 DoD 를 probe 로 쓰면 항목 수만큼 러너를 새로 띄운다(2026-09-23 실측: 41건 31.5분).
- 사람 확인 DoD(`human: true` 이거나 probe·tests 가 모두 없는 항목)는 게이트가 판정하지 않는다(요약의 `human N 제외`) — 구현 단계에서 `issue-set.mjs --dod-result <id> PASS --evidence "…"` 로 남긴 기록이 그대로 마감 보고에 실리고, 남은 것은 보고에 "사람 확인 필요 N건" 으로 적는다. `expect.min_tests` 는 실행 건수 0 을 FAIL 로 본다(초록이 "검사 0" 인지 "위반 0" 인지 구분하기 위해). 건수는 러너 요약 줄(`Tests N passed`·`N tests completed`·`Tests run: N`)이나 숫자 한 줄에서 읽고 색상 코드는 벗긴다. 건수를 출력하지 않는 sentinel 프로브(위반 주입·존재 검사·lint 문구)에는 `min_tests` 를 두지 않는다 — 두면 "분모 미확인" 으로 상시 FAIL 이다.
- FAIL 이면 **요약부터** 본다 — `failed_tests`(스택별 실패한 스위트·파일 이름. 그 이름으로 단독 재실행한다)와 `timed_out`(`gate.timeout_s` 에 걸려 중단된 단계 — 테스트가 깨진 것이 아니라 시간이 모자란 것이다). 둘 다 없으면 `<runtime>/gate/<slug>-<level>-<시각>.log` 를 읽는다(긴 출력은 표준 출력·표준 오류 각각 앞·뒤만 남는다 — 실패 요약은 뒤쪽에 있다). 원인을 보려고 게이트를 통째로 다시 돌리지 않는다. 코드를 고친 뒤 재실행 — 게이트 명령을 바꾸거나 테스트를 지워서 통과시키지 않는다.
  - `failed_tests` 는 **스택의 test 단계**가 실패했을 때, 명령을 바꾸지 않고 읽을 수 있는 리포트에서만 채운다. gradle(`dod_tests.adapter: gradle-junit`)은 이번 실행이 쓴 XML 에서 언제나 읽는다. vitest 는 게이트가 DoD·관련 테스트 판정 때문에 JSON 리포터를 이미 붙인 실행에서만 읽는다(`--related` 의 관련 테스트 · `--full` 에서 그 스택에 DoD `tests` 항목이 있을 때 — 스택 전체로 도는 경우는 test 명령이 `dod_tests.run` 과 같아야 한다) — `--main` 과 그 밖의 vitest 실패는 이름이 비어 있으니 로그 꼬리를 본다. 리포트가 쓰이기 전에 죽은 실행(컴파일 실패·시간 초과)도 비어 있다.
  - DoD `tests` 항목의 실패는 `failed_tests` 가 아니라 **그 항목의 판정**(`dod` 요약과 상태 JSON `dod[].last`)에 남는다 — `--dod` 게이트의 실패는 여기서 본다.
  - 시간 초과로 끊은 단계는 Windows 에서 그 아래 프로세스(테스트 러너)를 부모 pid 를 따라가며 끝낸다 — 남은 러너가 다음 차례의 게이트와 겹쳐 돌지 않게. **닿지 않는 것이 있다**: Git Bash 에서 `#!/usr/bin/env …` 로 시작하는 실행 스크립트(`npm` · `npx` 등)를 거쳐 뜬 프로세스는 부모 pid 사슬이 중간에서 끊겨 이 정리가 찾지 못한다(`./gradlew` 같은 `#!/bin/sh` 스크립트와 직접 실행한 명령은 닿는다 — 2026-11-19 실측). 그런 프로세스도 출력을 계속 쓰는 것은 게이트가 출력 파이프를 닫은 뒤 다음 쓰기에서 스스로 끝나지만, **아무것도 출력하지 않고 도는 것(멈춘 테스트 등)은 남는다**. 부모에 매이지 않고 따로 떠 있는 것(gradle 데몬 등)도 이 정리에 들지 않고, Windows 밖에서는 자손을 정리하지 않는다.

## commit · push

- 평소처럼 `git add -A && git commit -m "…"` / `git push`. 훅이 판정하고 거부 사유를 hookSpecificOutput.permissionDecisionReason으로 전달한다(SKILL.md §3).
- `docs_only_paths` 안의 변경만 있는 커밋은 게이트 없이 통과한다 — 문서 커밋에 게이트를 돌리지 않는다.
- 훅은 판정마다 `<runtime_dir>/hook-log.jsonl` 에 한 줄을 남긴다(무엇을 몇 번 통과·거부했나 — 명령 전문은 남기지 않는다). runtime 폴더를 통째로 `.gitignore` 하지 않고 하위 폴더만 무시하는 프로젝트는 이 파일도 `.gitignore` 와 `fingerprint_exclude` 에 넣는다 — 빠지면 추적되지 않는 파일로 잡혀 커밋 판정이 `DIRTY_TREE` 가 된다.
- 무인 모드, 또는 setup 이 "훅 미발화" 로 판정한 경로: `safe-commit.mjs -m "<메시지>" [--push]` — 같은 판정을 스크립트가 하고 통과할 때만 커밋/푸시한다.
- 커밋 메시지는 프로젝트 규약(예: `feat: …`)을 따르고 이슈 키를 넣는다.

## complete

1. push 전 게이트(`push_level` 에 따라 `--dod`·`--related`·`--full` — 더 강한 단계 기록도 받는다)가 현재 트리에 대해 신선한지 먼저 본다(낡았으면 여기서 돌린다).
2. `issue-complete.mjs [--dry-run] [--no-push] --json` — push 전 게이트·리뷰 신선도·작업트리 clean 을 다시 검사 → `git push -u origin <branch>` → 상태 JSON 을 `<runtime>/issues/archive/` 로 이동(stage `archived`) → `{jira:{transition, comment}, summary}` 출력. CLAUDE.md 줄 수가 `wiki.claude_md_max_lines`(기본 150) 를 넘으면 거부한다 — closure 는 CHANGELOG·wiki 로 간다. `summary.timing`(start 기준 단계별 첫 도달 초 · 커밋 게이트 횟수 · 전량 게이트 시간)과 댓글의 `- 소요:` 줄이 **이슈마다 자동으로** 남는다 — 하네스가 실제로 시간을 줄이는지는 이 값을 이슈별로 모아 v2 기준선과 비교한다(`measure.py` 는 세션 단위라 이슈 단위 시간은 여기서만 나온다). 아카이브 뒤 같은 브랜치의 closure 문서 커밋(3번 wiki-row 결과·CHANGELOG)은 docs-only 로 통과한다 — `git add … && git commit` 한 명령이어도 스테이징 예정 파일로 판정한다. 코드 커밋은 `COMPLETED` 로 막힌다(다시 시작은 `issue-start.mjs <KEY> --adopt`).
   댓글 초안에는 「확인이 필요한 가정」(사람 결정 없이 고른 해석 — 있으면 맨 위)과 사람 확인 DoD 의 확인·미확인과 근거 줄이 실린다. 지우거나 풀어 쓰지 않고 그대로 올린다 — 사람이 한 번에 바로잡는 자리다.
   거부 코드는 훅과 같은 사다리(SKILL.md §3) 에 세 개가 더 있다: `CLAUDE_MD_TOO_LONG`(줄여서 재실행) · `BAD_STATE`(상태 JSON 이 스키마에 안 맞음 — `issue-set.mjs` 로 고치거나 `issue-start.mjs` 로 다시 만든다) · `PUSH_FAILED`(원격 거부 — 사유를 그대로 보고, 상태는 archive 로 옮기지 않는다).
3. `wiki-row.mjs --index <wiki.index> --key <KEY> --set "<상태열>=closed" … --log <wiki.log> --event "<한 줄>" --phase closure` → `wiki-lint.mjs --docs <docs> [--memory <memory dir>] --root <프로젝트 루트>` 가 high 위반 0.
4. 배운 것이 있으면 `jira-harness 플러그인의 kb-ingest 스킬` 로 wiki 종합 페이지 최대 `wiki.max_pages_per_closure` 장. 자동 메모리에 남길 것은 `memory-index.mjs --dir <memory dir> --add "<인덱스 한 줄>"`(본문 파일은 직접 쓴다).
5. Atlassian MCP: `transitionJiraIssue`(`jira.done_transition`) + `addCommentToJiraIssue`(출력 comment). 키마다 — 하위부터. **부모**(상태 JSON `subtasks[].parent`)는 전이 직전에 `getJiraIssue` 로 그 하위를 다시 읽어, 이 브랜치에 안 들어온 하위(다른 레포 몫·`subtasks.match` 밖)가 아직 안 끝났으면(완료 카테고리 · `jira.done_transition` 상태가 아니면) 부모를 전이하지 않고 "부모 <KEY> 보류 — 남은 하위: <KEY…>" 를 보고한다.
6. 보고: 브랜치·push 여부·게이트 분모(관련 테스트면 스택별 mode·건수 · dod 면 DoD tests 항목 수)·리뷰 결과·확인이 필요한 가정과 미확인 사람 확인 DoD·사람이 할 일(main 머지는 사람 — 자동 머지 금지). `push_level=dod`·`related` 면 "전체 스위트는 main 배치 대기" 를 한 줄 남긴다(dod 는 "테스트 검증은 main 배치에서").
7. 이슈 작업트리(시작 출력에 `worktree.path` 가 있었다)와 Herdr 구현 레인이 남긴 작업트리·레인 브랜치(`lane/<slug>/…`)는 closure 커밋까지 push 한 뒤 메인 체크아웃에서 `issue-start.mjs --remove-worktree <KEY>` **한 번**으로 지운다 — 이슈를 메인 체크아웃에서 했어도 레인을 돌렸으면 부른다. 폴더를 손으로 지우지 않는다(안의 링크를 따라 메인 쪽 폴더가 지워진다). 그 작업트리 안에서 부르면 `IN_WORKTREE` 로 거부한다.
   - 레인 pane 이 열려 있으면 **먼저 닫는다**(`herdr pane close <id>` — id 는 `herdr pane list` 로 지금 것을 확인한다). pane 이 그 폴더에 서 있는 채로 부르면 파일과 등록만 지워지고 폴더가 남는다 — 닫고 다시 부르면 남은 폴더까지 치운다.
   - 레인 쪽은 **지금 그 작업트리에 있는 것**으로 판정한다: 변경이 없거나 회수해 둔 패치와 같을 때만 지운다. 회수되지 않은 변경이 있는 작업트리, 레인이 커밋해 버린 브랜치, Herdr 워크스페이스로 연 작업트리(`workspace` 배치)는 지우지 않고 출력 `lanes.kept` 에 사유와 함께 남긴다 — 읽고 처리한다(`--force` 는 이슈 작업트리의 커밋 안 된 변경에만 듣는다). 레인 잔재가 있는데 하나도 못 치웠으면 `LANES_KEPT`(exit 1)다.

## main 배치 — `push_level=dod`·`related` 의 전체 스위트

이슈 게이트가 미룬 build·전체 테스트·extra 를 **기본 브랜치에서 한 번에** 돈다. 여러 이슈를 머지한 뒤(같은 세션의 마지막, 또는 배포·릴리즈 직전) 1회면 된다 — 이슈마다 돌리면 이 모드를 쓰는 이유가 사라진다.

**`push_level=dod` 면 필수다** — 이슈 게이트가 관련 테스트조차 돌리지 않았으니 테스트 검증은 여기뿐이다. 배포·릴리즈 전에는 반드시 PASS 를 확인하고, 머지가 쌓일수록 FAIL 의 용의자가 늘어나므로 **머지 ~5건마다** 한 번씩 돌리는 것을 권한다(`--main --status` 의 커밋 수로 판단). FAIL 이면 `suspects`(마지막 PASS 이후 first-parent 커밋 = 머지 커밋 단위)로 범위를 좁힌다.

1. 기본 브랜치를 checkout 한 깨끗한 작업트리(메인 체크아웃)에서 `node "<P>/scripts/gate.mjs" --main [--json]` — 이슈 상태 JSON 이 없어도 돈다. 기록은 `<runtime>/main-gate.json`(마지막 결과 · 마지막 PASS 의 head · 최근 30회). 다른 작업공간의 무거운 게이트가 돌고 있으면 대기열에서 차례를 기다린 뒤 돈다(§gate 대기열) — 기다리는 동안 들어온 커밋까지 포함해 그때의 head 를 잰다.
2. 지금 얼마나 쌓였나: `gate.mjs --main --status` — 마지막 PASS 이후 first-parent 커밋 수·목록.
3. PASS → 배포·릴리즈로 진행. FAIL → 출력의 `failed_tests`(실패한 스위트 이름 — `--main` 은 gradle 스택만 채운다. vitest 스택은 로그 꼬리의 실패 요약을 본다)와 `suspects`(마지막 PASS 이후 커밋)를 맞대어 실패 테스트를 바꾼 이슈를 찾고, 그 테스트를 단독 재실행해 실제 결함인지(그 이슈 브랜치를 `--adopt` 로 다시 열어 고친다) 환경 요인인지 가른다. 환경 요인이면 단독 PASS 근거와 함께 보고하고 재실행은 한가할 때 1회.
4. Herdr 안이면 `herdr-lanes.mjs gate --main --no-wait` 로 runner pane 에서 돌린다.
