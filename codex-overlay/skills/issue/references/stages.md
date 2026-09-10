Codex 질문 도구: `request_user_input`은 제공되는 모드에서만 사용한다. 사용할 수 없으면 `request_user_input_async` 또는 간결한 평문 질문을 사용한다. 승인 요청은 현재 세션의 상위 지침을 따르고, 응답이 없다는 이유로 승인 처리하지 않는다.
# issue 단계별 절차

`<P>` = 설치된 플러그인 루트. 스크립트는 `node "<P>/scripts/<이름>.mjs"`로 실행한다. Codex에는 Workflow 툴과 이 플러그인의 `workflows/` 파일이 없다. 아래 recon/plan/implement의 워크플로 계약은 아직 이식되지 않은 참고 사양이며 실행 명령이 아니다. 이 단계의 자동 실행은 미지원으로 보고한다. 역할을 개별 위임할 때는 `subagents/<name>.toml`의 `developer_instructions`를 읽고 `spawn_agent` 프롬프트에 전달한다.
`<runtime>` = `harness.json.runtime_dir`(기본 `.codex/runtime`), `<slug>` = 브랜치 이름의 `/` 를 `-` 로 바꾼 것. 상태 JSON = `<runtime>/issues/<slug>.json`.
스크립트 출력은 `--json` 이면 마지막 줄이 JSON 한 덩어리다 — 그것만 읽으면 된다.

## start

1. `issue-start.mjs <KEY[,KEY…]> [--adopt] --json`
   - 기본 브랜치 위: `branch_template`(기본 `feat/{keys}`) 로 새 브랜치를 만들고 상태 JSON 을 쓴다.
   - 이미 이슈 브랜치 위(상태만 없음): 브랜치는 두고 상태만 만든다.
   - 그 밖의 브랜치: `--adopt` 가 있어야 그 브랜치를 채택한다(없으면 `ON_OTHER_BRANCH` 로 멈춘다 — 엉뚱한 브랜치에 이슈를 붙이는 사고 방지).
   - 이미 상태가 있으면 `RESUMED` — 아무것도 바꾸지 않는다.
2. Atlassian MCP(도구 이름은 ToolSearch 로 찾는다 — `getJiraIssue` / `transitionJiraIssue` / `addCommentToJiraIssue`, 필요하면 `getAccessibleAtlassianResources` 로 cloudId 먼저):
   - `getJiraIssue` 로 본문·댓글을 읽는다(사용자가 전달한 요약보다 원문이 우선 — 번복·누락이 섞인다). 파일에 저장하지 않는다.
   - `transitionJiraIssue` 를 `jira.start_transition` 으로, `addCommentToJiraIssue` 에 출력의 `jira.comment` 를 그대로.
   - MCP 가 없거나 실패하면 코드 진행은 막지 않되 보고에 "Jira 미반영(사유)" 를 남긴다.
3. 키 3개 이상, 또는 본문만으로 범위가 안 잡히면 recon. 아니면 grill.

## recon (선택)

`workflows/recon.js` args `{keys, issueBodies, hints[], repoRoot, model?}`(`repoRoot` = 프로젝트 루트 절대 경로 — 레인이 어디를 읽을지는 값 주입이 유일한 경로다 · `model` 기본 `models.recon`) → `{scope, branchPoints[{question, options[], recommended, why}], unknowns[]}`. sonnet 1레인, 25턴 상한, "미확인" 은 `unknowns[]` 에 남긴다(추측으로 채우지 않는다 — 레인이 죽어도 빈 초록이 아니라 unknowns 1건). 반환은 grill 의 재료일 뿐 결정이 아니다.

## grill

`jira-harness 플러그인의 grilling 스킬` 을 그 자리에서 따른다 — 한 번에 한 질문, 선택지 2~4개, 화면·데이터가 갈리는 질문은 preview. 코드·문서로 답할 수 있는 것은 묻지 않고 한 줄 공유로 대신한다.
확정마다 `issue-set.mjs --decision "<질문>" "<답>"`. 끝나면 `issue-set.mjs --stage plan`.
무인: 묻지 않고 권장안을 택하고 답 끝에 `(unattended)` 를 붙인다.

## plan

1. 재료: `issueBodies{KEY: 본문}`(start 에서 읽은 것) · `guidePaths{KEY: 경로}` = `wiki.dev_guide` 템플릿의 `{KEY}` 치환(다중 키는 첫 키로 **한 장** — BE/FE 공통 변경을 별도 가이드로 쪼개지 않는다) · `hasWiki` = `wiki.index` 존재 · `hasMemory` = 자동 메모리 폴더 존재 · `wikiHits[]` = INDEX 에서 키·핵심어를 grep 한 줄(최대 10) · `decisions[]` = 상태 JSON 의 결정 · `sidecarPath` = `<runtime>/issues/<slug>.plan.json` · `repoRoot` = 프로젝트 루트 절대 경로(**필수** — 없으면 에이전트를 띄우기 전에 거부) · 선택 `ts`(ISO 시각 — 스크립트는 시계를 못 쓴다) · `models`(`harness.json.models`).
2. `workflows/plan.js` 실행 — args `{keys, issueBodies, guidePaths, sidecarPath, repoRoot, hasWiki, hasMemory, wikiHits, decisions, ts?, models?}`. Understand(코드·wiki sonnet / 이슈·메모리 haiku) → Design(opus 1레인 — dev-guide `.draft` 와 사이드카를 **에이전트가 직접** 쓴다) → Verify(sonnet 2레인: 제약·범위). 반환 `{verdict, blockers[], touched[], lanes[], dod[], guides}`. 빈 계획(lanes·dod 가 비었거나 Design 레인이 죽음)은 verify 가 전부 PASS 여도 `BLOCK` 이다.
3. `verdict` 가 `BLOCK` 이면 blockers 를 그대로 보여주고 grill 로 돌아간다(설계를 억지로 통과시키지 않는다).
4. `issue-set.mjs --merge <sidecarPath> --from plan` — touched·lanes·dod·guides 반영. 그 뒤 `--stage plan`.
5. 승인: 범위·레인·DoD·되돌리기 비싼 결정을 5~10줄로 보인 뒤 request_user_input(진행(권장) / 수정할 것 있음 / 다시 계획). go/no-go 를 묻지 말고 수정 요청만 받는다.
   묻기 직전에 `node "<P>/scripts/herdr-report.mjs" --notify "<KEY> 계획 승인 대기" --sound request` — Herdr 안이면 사람을 부르는 토스트, 밖이면 무동작(사람 확인 DoD 가 남아 멈출 때도 같은 한 줄 — 제목만 `<KEY> 사람 확인 DoD <id>`).
   승인되면 ① `.draft` 를 확정 파일명으로 `git mv` ② `wiki-row.mjs --index <wiki.index> --key <KEY> --set "<상태열>=planned" --set "<가이드열>=<경로>" … --log <wiki.log> --event "<한 줄>" --phase forecast`(열 이름은 `wiki.schema` 문서의 표 정의를 따른다 — 하드코딩하지 않는다) ③ `issue-set.mjs --stage implement --note approved`.
   무인: 진행(권장) 으로 간주, note `approved(unattended)`.

## implement

- 레인 1개(기본): 메인이 직접 구현한다. dev-guide 의 DoD 를 작업 목록으로 쓴다.
- 레인 2개 이상: **Phase 0 공통 계약**(DTO·API 경로·DDL·이벤트 이름)은 메인이 먼저 만들어 커밋한 뒤 `workflows/implement.js` args `{lanes[{name, model, worktree, files[], dod[]}], guidePaths, contracts, sidecarDir, sidecarPrefix, repoRoot, ts, maxTurns?}`(`sidecarDir` = `<runtime>/issues` · `sidecarPrefix` = `<slug>` · `maxTurns` 기본 60 — 턴 상한은 agent() 옵션이 아니라 프롬프트 지시로만 전달된다). 레인은 선언된 `model`(opus/sonnet) 과 `worktree` 플래그대로 돈다. 반환 `{lanes[{name, status, …}], failed[], sidecars[]}` — 죽은 레인은 빠지지 않고 `failed` 에 이름이 남는다. 레인별 사이드카 `<sidecarDir>/<sidecarPrefix>.lane-<name>.json` 을 `issue-set.mjs --merge` 로 반영하고, 레인 경계(seam — 한쪽이 부르고 다른 쪽이 받는 곳)는 메인이 직접 대조한다.
- 워크플로 레인의 "완주" 는 반환값으로 판정한다 — 산출물 파일이 있다고 완주가 아니다(중간에 죽은 레인도 파일은 남긴다).
- 구현 중간 커밋은 gate → commit 순서 그대로.

## verify — 리뷰 사다리

라운드 1
1. `review.codex=true` 면 Codex 판정을 받는다. **경로는 `review.codex_via`** — `herdr`(Herdr 안): `node "<P>/scripts/herdr-lanes.mjs" codex-review [--since <tree>] --files <a,b> --slug <slug> --cwd <루트>` 가 워크스페이스에 상주하는 codex pane 을 재사용(없으면 띄움)해 심판하고, 이슈가 바뀌면 `/new` 로 컨텍스트를 비운다(`herdr.reviewer_context`). Herdr 밖이거나 `exec`(기본) 면 `bash "<P>/scripts/codex-review.sh" [--since <tree>]`. 두 경로 모두 마지막 `CODEX_RESULT={…}` 줄이 같은 계약이다 — herdr 경로가 `status:"missing"` 을 내면 exec 로 한 번 더 부른다. 마지막 `CODEX_RESULT={…}` 줄로 판정한다 — exit code 가 아니라 **본문 끝**이다. `status`: `ok`(blockers N) / `limit`(사용량 한도 — 2 로 가되 `codex:"limit"` 으로 기록해 폴백을 감추지 않는다) / `fail`. diff 본문은 argv 가 아니라 `out` 옆의 `.diff` 파일(`diff` 필드)로 넘어간다 — 큰 배치(50파일+)도 인자 한계에 걸리지 않는다. `--since` 델타는 **인덱스 트리** 기준이라 수정분을 `git add -A` 로 올린 뒤 부른다.
2. **레인은 Codex 가 못 채운 자리에만 돈다** — `review.lanes_when`(기본 `codex_gap`). Codex 가 `ok` 로 판정을 냈으면 **같은 diff 를 Claude 레인으로 다시 심판하지 않는다**: 두 판정이 갈리면 결국 메인이 또 판정하고, 같으면 그 토큰은 통째로 낭비다. 레인을 도는 경우는 둘뿐 — ① Codex 판정이 없다(`missing`·`limit`·`fail`) → 레인이 리뷰를 **대체**한다 ② Codex 가 볼 수 없는 축이 이번 변경의 핵심이다(브라우저 좌표·런타임 화면·외부 호출 재현) → **그 축만**. 어느 쪽이든 기록에 `lanes_reason` 한 줄이 필요하고, 없으면 `issue-set.mjs --review` 가 거부한다. 매번 돌리려면 `always`, 아예 끄려면 `never`.
2b. **Herdr 안이고 `harness.json.herdr.lanes` 가 `verify` 면** 레인은 Workflow 가 아니라 Herdr pane 의 다른 에이전트(codex·grok…)다 — 절차는 [herdr-lanes.md](herdr-lanes.md). 다른 모델의 심판이므로 2번의 "같은 diff 를 다시 심판하지 않는다" 예외에 해당하고 `lanes_reason` 은 실행기 출력이 준다. 전 레인 `outside herdr`/failed 면 3번으로 돌아간다.
3. 레인을 돌 때 — `node "<P>/scripts/lanes-codex.mjs" verify --diff-ref <default_branch> --files <a,b,c> --axes "<축1,축2>" --lanes-max 4 --cwd <루트> --json`. `--files`에는 기준 브랜치 이후 변경과 staged·unstaged·untracked 변경을 모두 합쳐 전달한다. 델타는 `--delta-since <tree>`를 사용한다. 반환 계약은 `{findings, lanes, dropped, delta}`다. `lanes[].status=failed`는 검사 실패이고 findings 0은 성공 증거가 아니다. `dropped`와 0개 레인도 미검사 범위로 보고한다. 상한은 `review.lanes_max`를 따른다.
4. **메인이 확정/기각** — finding 마다 한 줄 근거. Codex finding 도 같은 자리에서 확정/기각한다(레인을 띄워 재심하지 않는다). finding 별 반증 에이전트를 띄우지 않는다(29→56 폭주 이력). 기각 사유 없이 버리지 않는다.
5. 기록: 확정 finding 을 `<runtime>/issues/<slug>.review.json` 으로 쓰고 `issue-set.mjs --review <파일> [--delta]`. 스크립트가 `tree`(현재 인덱스 지문)·`files`·`at`·`blockers_open`(확정 BLOCKER 수) 을 계산한다. **파일 모양은 상태 스키마를 따른다** — `{round?, codex: string(요약 한 줄 + 산출물 경로), lanes: integer(레인 수), lanes_reason?: string(레인>0 이면 필수 — 왜 Codex 로 안 끝났나), findings: [{severity, file, line, claim, evidence, axis, decision, reason?}] | integer, blockers_open?}`. 레인 목록·기각 사유 같은 상세는 같은 파일에 다른 키로 두지 말고(스키마 위반으로 저장 거부) `<slug>.review.detail.json` 처럼 별도 파일에 둔다.

라운드 2(라운드 1 에 blocker 가 있었을 때만): 수정 → 같은 순서로 **1차 blocker 축만** 재검(`axes` 를 그 축으로 좁힌다). `review.rounds_max`(기본 2) 를 넘지 않는다.

델타 패스(횟수 제한 없음): 라운드 뒤 수정으로 바뀐 파일만 — `codex-review.sh --since <review.tree>` 또는 `verify.js` 의 `delta:{sinceTree, files}` 1레인 → `issue-set.mjs --review <파일> --delta`. 한 번에 2~4분이라 "모든 수정을 한 커밋에 몰기" 를 강요하지 않는다.

`review.code_review=true` 면 내장 `/code-review` 도 돌린다(메인 세션 토큰을 쓰므로 기본 off).

## gate

- 커밋 전 `gate.mjs --commit [--stage-all]` — 컴파일·린트·DoD 프로브, **건드린 스택만**. 목표 `gate.commit_budget_s`(기본 3분).
- push·complete 전 `gate.mjs --full` — 빌드·전체 테스트·extra(프로젝트 정적 게이트 등). 9~15분이면 `exec_command`로 시작하고 반환된 session_id를 `write_stdin`으로 기다린다.
- **Herdr 안이면** 게이트를 runner pane 에서 돌린다 — `node "<P>/scripts/herdr-lanes.mjs" gate --full|--commit [--stage-all] [--no-wait] --cwd <루트> --json`. 로그가 driver 컨텍스트 밖(pane)에 남고, 기록·토스트는 gate.mjs 가 그대로 한다. `--no-wait` 면 바로 돌아오고 완료 토스트(전량 PASS=done · FAIL=request)를 기다린다. 결과 JSON 은 출력의 `out`.
- 같은 트리에 전량 통과 기록이 이미 있으면 `--commit` 은 재실행을 생략한다.
- DoD `human:true` 는 게이트가 SKIPPED 로 남긴다 — 보고에 "사람 확인 필요 N건" 을 적는다. `expect.min_tests` 는 실행 건수 0 을 FAIL 로 본다(초록이 "검사 0" 인지 "위반 0" 인지 구분하기 위해). 건수는 러너 요약 줄(`Tests N passed`·`N tests completed`·`Tests run: N`)이나 숫자 한 줄에서 읽고 색상 코드는 벗긴다. 건수를 출력하지 않는 sentinel 프로브(위반 주입·존재 검사·lint 문구)에는 `min_tests` 를 두지 않는다 — 두면 "분모 미확인" 으로 상시 FAIL 이다.
- FAIL 이면 `<runtime>/gate/<slug>-<level>-<시각>.log` 를 읽고 코드를 고친 뒤 재실행. 게이트 명령을 바꾸거나 테스트를 지워서 통과시키지 않는다.

## commit · push

- 평소처럼 `git add -A && git commit -m "…"` / `git push`. 훅이 판정하고 거부 사유를 hookSpecificOutput.permissionDecisionReason으로 전달한다(SKILL.md §3).
- `docs_only_paths` 안의 변경만 있는 커밋은 게이트 없이 통과한다 — 문서 커밋에 게이트를 돌리지 않는다.
- 무인 모드, 또는 setup 이 "훅 미발화" 로 판정한 경로: `safe-commit.mjs -m "<메시지>" [--push]` — 같은 판정을 스크립트가 하고 통과할 때만 커밋/푸시한다.
- 커밋 메시지는 프로젝트 규약(예: `feat: …`)을 따르고 이슈 키를 넣는다.

## complete

1. `gate.mjs --full` 이 현재 트리에 대해 신선한지 먼저 본다(낡았으면 여기서 돌린다).
2. `issue-complete.mjs [--dry-run] [--no-push] --json` — 전량 게이트·리뷰 신선도·작업트리 clean 을 다시 검사 → `git push -u origin <branch>` → 상태 JSON 을 `<runtime>/issues/archive/` 로 이동(stage `archived`) → `{jira:{transition, comment}, summary}` 출력. CLAUDE.md 줄 수가 `wiki.claude_md_max_lines`(기본 150) 를 넘으면 거부한다 — closure 는 CHANGELOG·wiki 로 간다. `summary.timing`(start 기준 단계별 첫 도달 초 · 커밋 게이트 횟수 · 전량 게이트 시간)과 댓글의 `- 소요:` 줄이 **이슈마다 자동으로** 남는다 — 하네스가 실제로 시간을 줄이는지는 이 값을 이슈별로 모아 v2 기준선과 비교한다(`measure.py` 는 세션 단위라 이슈 단위 시간은 여기서만 나온다). 아카이브 뒤 같은 브랜치의 closure 문서 커밋(3번 wiki-row 결과·CHANGELOG)은 docs-only 로 통과한다 — `git add … && git commit` 한 명령이어도 스테이징 예정 파일로 판정한다. 코드 커밋은 `COMPLETED` 로 막힌다(다시 시작은 `issue-start.mjs <KEY> --adopt`).
   거부 코드는 훅과 같은 사다리(SKILL.md §3) 에 세 개가 더 있다: `CLAUDE_MD_TOO_LONG`(줄여서 재실행) · `BAD_STATE`(상태 JSON 이 스키마에 안 맞음 — `issue-set.mjs` 로 고치거나 `issue-start.mjs` 로 다시 만든다) · `PUSH_FAILED`(원격 거부 — 사유를 그대로 보고, 상태는 archive 로 옮기지 않는다).
3. `wiki-row.mjs --index <wiki.index> --key <KEY> --set "<상태열>=closed" … --log <wiki.log> --event "<한 줄>" --phase closure` → `wiki-lint.mjs --docs <docs> [--memory <memory dir>] --root <프로젝트 루트>` 가 high 위반 0.
4. 배운 것이 있으면 `jira-harness 플러그인의 kb-ingest 스킬` 로 wiki 종합 페이지 최대 `wiki.max_pages_per_closure` 장. 자동 메모리에 남길 것은 `memory-index.mjs --dir <memory dir> --add "<인덱스 한 줄>"`(본문 파일은 직접 쓴다).
5. Atlassian MCP: `transitionJiraIssue`(`jira.done_transition`) + `addCommentToJiraIssue`(출력 comment). 키마다.
6. 보고: 브랜치·push 여부·게이트 분모·리뷰 결과·사람이 할 일(main 머지는 사람 — 자동 머지 금지).
