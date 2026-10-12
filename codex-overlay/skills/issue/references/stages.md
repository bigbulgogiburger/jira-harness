Codex 질문 도구: `request_user_input`은 제공되는 모드에서만 사용한다. 사용할 수 없으면 `request_user_input_async` 또는 간결한 평문 질문을 사용한다. 승인 요청은 현재 세션의 상위 지침을 따르고, 응답이 없다는 이유로 승인 처리하지 않는다.
# issue 단계별 절차

`<P>` = 설치된 플러그인 루트. 스크립트는 `node "<P>/scripts/<이름>.mjs"`로 실행한다. Codex에는 Workflow 툴과 이 플러그인의 `workflows/` 파일이 없다. 아래 recon/plan/implement의 워크플로 계약은 아직 이식되지 않은 참고 사양이며 실행 명령이 아니다. 이 단계의 자동 실행은 미지원으로 보고한다. 역할을 개별 위임할 때는 `subagents/<name>.toml`의 `developer_instructions`를 읽고 `spawn_agent` 프롬프트에 전달한다.
`<runtime>` = `harness.json.runtime_dir`(기본 `.codex/runtime`), `<slug>` = 브랜치 이름의 `/` 를 `-` 로 바꾼 것. 상태 JSON = `<runtime>/issues/<slug>.json`.
스크립트 출력은 `--json` 이면 마지막 줄이 JSON 한 덩어리다 — 그것만 읽으면 된다.

## start

0. **하위이슈 확장 — 사용자가 준 키가 몇 개든 항상**(플래그 없음. 사용자가 "이 이슈만"·"하위 빼고" 라고 한 경우만 건너뛴다): 키마다 `getJiraIssue`(Atlassian MCP — `fields` 에 `subtasks` 를 포함. 본문·댓글도 이 호출이 겸한다)를 불러 응답 배열을 `node "<P>/scripts/issue-subtasks.mjs" --in - --json` 의 stdin 으로 준다. 이미 이슈 브랜치 위인데 상태만 없는 `NO_STATE` 는 확장하지 않고 `--status` 의 `keys` 를 그대로 쓴다.
   - `code`: `RESUME` — 이 키로 시작해 진행 중인 브랜치가 있다. Jira 의 현재 하위 구성이 바뀌었어도 출력 `keys` 를 그대로 이어 간다 · `EXPANDED` — `keys` = 준 키 + 하위(번호 순) · `NO_SUBTASKS` — 하위가 없다(종전과 같다).
   - 끝난 하위(완료 카테고리 · `jira.done_transition` 상태)·다른 프로젝트 키·`subtasks.match`(harness.json — 하위 summary 정규식. 멀티 레포 이슈에서 이 저장소 몫만 고를 때)에 안 걸린 하위는 빠지고, `children[]` 에 `reason` 과 함께 남는다.
   - `confirm: true`(= `subtasks.match` 가 없다)이면 유인 모드에서 `children[]` 를 표로 한 번 보이고 "이 저장소 몫이 아닌 하위(예: 다른 레포의 `[mobile]`)는 빼라" 고 확인한다 — 뺄 것이 있으면 `keys_arg`·`group_args` 에서 그 키를 지워 쓴다. 무인이면 묻지 않고 전부 포함한다. 같은 확인이 되풀이되면 `subtasks.match` 설정을 안내한다.
   - MCP 가 없거나 실패하면 준 키 그대로 가고 보고에 "하위이슈 미확인(사유)" 를 남긴다.
1. `issue-start.mjs <keys_arg> [--adopt] [--group <group_args 마다>]… --json` — 하위가 붙었으면 `--group ABC-10=ABC-11,ABC-12` 가 부모↔하위를 상태 JSON `subtasks` 에 남긴다(새 상태를 만들 때만 — `RESUMED` 는 무시).
   - 기본 브랜치 위: `branch_template`(기본 `feat/{keys}`) 로 새 브랜치를 만들고 상태 JSON 을 쓴다.
   - 이미 이슈 브랜치 위(상태만 없음): 브랜치는 두고 상태만 만든다.
   - 그 밖의 브랜치: `--adopt` 가 있어야 그 브랜치를 채택한다(없으면 `ON_OTHER_BRANCH` 로 멈춘다 — 엉뚱한 브랜치에 이슈를 붙이는 사고 방지).
   - 이미 상태가 있으면 `RESUMED` — 아무것도 바꾸지 않는다.
2. Atlassian MCP(도구 이름은 ToolSearch 로 찾는다 — `getJiraIssue` / `transitionJiraIssue` / `addCommentToJiraIssue`, 필요하면 `getAccessibleAtlassianResources` 로 cloudId 먼저):
   - 본문·댓글은 0번에서 읽은 것을 쓴다(사용자가 전달한 요약보다 원문이 우선 — 번복·누락이 섞인다). 하위로 새로 들어온 키만 `getJiraIssue` 를 더 부른다. 파일에 저장하지 않는다.
   - `transitionJiraIssue` 를 `jira.start_transition` 으로, `addCommentToJiraIssue` 에 출력의 `jira.comment` 를 그대로 — **키마다**(부모·하위 전부).
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
   `subtasks` = 하위가 붙은 브랜치면 상태 JSON `subtasks` 에 각 하위의 요약을 붙인 `[{parent, children:[{key, summary}]}]`(없으면 생략 — `issueBodies` 에는 하위 본문까지 키별로 넣는다) · Herdr 안이고 `herdr.lanes` 가 `implement`/`all` 이면 `herdrKinds` = `herdr.kinds.implement`(없으면 `["claude"]`) · `herdrProfiles` = `herdr.kinds.profiles` 를 더해 Design 이 레인마다 `kind`·`kind_reason` 을 고르게 한다.
2. `workflows/plan.js` 실행 — args `{keys, issueBodies, guidePaths, sidecarPath, repoRoot, hasWiki, hasMemory, wikiHits, decisions, ts?, models?, subtasks?, herdrKinds?, herdrProfiles?}`. Understand(코드·wiki sonnet / 이슈·메모리 haiku) → Design(opus 1레인 — dev-guide `.draft` 와 사이드카를 **에이전트가 직접** 쓴다) → Verify(sonnet 2레인: 제약·범위). 반환 `{verdict, blockers[], touched[], lanes[], dod[], guides}`. 빈 계획(lanes·dod 가 비었거나 Design 레인이 죽음)은 verify 가 전부 PASS 여도 `BLOCK` 이다.
3. `verdict` 가 `BLOCK` 이면 blockers 를 그대로 보여주고 grill 로 돌아간다(설계를 억지로 통과시키지 않는다).
4. `issue-set.mjs --merge <sidecarPath> --from plan` — touched·lanes·dod·guides 반영. 그 뒤 `--stage plan`.
5. 승인: 범위·레인·DoD·되돌리기 비싼 결정을 5~10줄로 보인 뒤 request_user_input(진행(권장) / 수정할 것 있음 / 다시 계획). go/no-go 를 묻지 말고 수정 요청만 받는다.
   묻기 직전에 `node "<P>/scripts/herdr-report.mjs" --notify "<KEY> 계획 승인 대기" --sound request` — Herdr 안이면 사람을 부르는 토스트, 밖이면 무동작(사람 확인 DoD 가 남아 멈출 때도 같은 한 줄 — 제목만 `<KEY> 사람 확인 DoD <id>`).
   승인되면 ① `.draft` 를 확정 파일명으로 `git mv` ② `wiki-row.mjs --index <wiki.index> --key <KEY> --set "<상태열>=planned" --set "<가이드열>=<경로>" … --log <wiki.log> --event "<한 줄>" --phase forecast`(열 이름은 `wiki.schema` 문서의 표 정의를 따른다 — 하드코딩하지 않는다) ③ `issue-set.mjs --stage implement --note approved`.
   무인: 진행(권장) 으로 간주, note `approved(unattended)`.

## implement

- 레인 1개(기본): 메인이 직접 구현한다. dev-guide 의 DoD 를 작업 목록으로 쓴다.
- 레인 2개 이상: **Phase 0 공통 계약**(DTO·API 경로·DDL·이벤트 이름)은 메인이 먼저 만들어 커밋한 뒤 `workflows/implement.js` args `{lanes[{name, model, worktree, files[], dod[]}], guidePaths, contracts, sidecarDir, sidecarPrefix, repoRoot, ts, maxTurns?}`(`sidecarDir` = `<runtime>/issues` · `sidecarPrefix` = `<slug>` · `maxTurns` 기본 60 — 턴 상한은 agent() 옵션이 아니라 프롬프트 지시로만 전달된다). 레인은 선언된 `model`(opus/sonnet) 과 `worktree` 플래그대로 돈다. 반환 `{lanes[{name, status, …}], failed[], sidecars[]}` — 죽은 레인은 빠지지 않고 `failed` 에 이름이 남는다. 레인별 사이드카 `<sidecarDir>/<sidecarPrefix>.lane-<name>.json` 을 `issue-set.mjs --merge` 로 반영하고, 레인 경계(seam — 한쪽이 부르고 다른 쪽이 받는 곳)는 메인이 직접 대조한다.
- **Codex 에는 `workflows/implement.js` 를 돌릴 Workflow 툴이 없다.** 레인 2개 이상의 자동 병렬 경로는 **Herdr 구현 레인** 하나다 — Herdr 안이고 `harness.json.herdr.lanes` 가 `implement` 또는 `all` 이면 `node "<P>/scripts/herdr-lanes.mjs" implement --slug <slug> [--lanes a,b] [--contracts-file <Phase 0 계약 md>] [--dry-run] --cwd <루트> --json`. 상태 JSON `lanes[]` 마다 `lane/<slug>/<name>` worktree 를 파고 레인의 `kind`(plan 이 골랐으면 그대로, 없으면 `herdr.kinds.implement` 풀 순서 — codex 자신도 kind 가 될 수 있다)로 pane 에이전트를 띄운다. **Phase 0 계약은 먼저 커밋한다**(worktree 는 HEAD 에서 갈린다 — 출력 `dirty_base` 가 못 보는 목록). 레인은 커밋하지 않고, 끝나면 실행기가 worktree 의 diff 를 패치로 회수해 메인에 적용한다(`applied: yes|conflict|skipped|empty|no-apply` — `conflict` 는 메인이 표식을 푼다). 결과는 실행기가 `issue-set.mjs --lane` 으로 `lanes[].kind·result` 에 남긴다. 절차·함정은 [herdr-lanes.md](herdr-lanes.md) §implement. Herdr 밖·설정 off 면 출력 `ok:false` — 그때는 메인이 레인을 **순차로 직접** 구현한다(위 args 계약의 프롬프트를 `spawn_agent` 에 넘겨도 된다 — 다만 그 결과는 사이드카 파일과 반환값 둘 다로 판정한다).
- **하위이슈가 붙은 브랜치**(상태 JSON `subtasks` 가 비어 있지 않다): 하위의 코드는 **한 브랜치·한 상태 JSON** 에 쌓이고, 전략만 Herdr 여부로 갈린다.
  - **전략 A — Herdr 밖(또는 `herdr.lanes` 가 off/verify)**: **한 작업트리**에서 처리한다. 격리 worktree 의 변경을 메인으로 가져오는 단계(패치 회수·적용)는 Herdr 실행기에만 있어서, Workflow 의 `isolation: 'worktree'` 레인은 결과가 메인에 안 돌아온다 — plan 이 레인의 `worktree` 를 전부 false 로 둔다. 메인이 선행(Phase 0) 하위부터 DoD 의 `[KEY]` 순서대로 직접 구현한다(Codex 에는 Workflow 툴이 없다).
  - **전략 B — Herdr 안 + `herdr.lanes` 가 `implement`/`all`**: 하위마다 레인 하나(`name` = 키를 소문자로 줄인 `abc-12`, 레인 `key` = 이슈 키)가 자기 `lane/<slug>/<name>` worktree 에서 pane 에이전트로 돈다. **선행 하위(DDL·공통 계약)는 레인이 아니라 Phase 0** — 메인이 먼저 구현·커밋한 뒤 레인을 띄운다(worktree 는 HEAD 에서 갈린다). 회수·적용은 위 Herdr 구현 레인 그대로다.
  - 실행기가 `ok:false` 면 B 에서 A 로 폴백한다. 어느 쪽이든 게이트·리뷰는 브랜치 전체에 한 번이고, 하위별 진척은 DoD 의 `[KEY]` 표기로 본다.
- 레인의 "완주" 는 반환값·`lanes[].status` 로 판정한다 — 산출물 파일이 있다고 완주가 아니다(중간에 죽은 레인도 파일은 남긴다). Herdr 레인은 `status` 가 `done` 이고 사이드카가 `failed` 가 아닐 때만 패치가 적용된다.
- 구현 중간 커밋은 gate → commit 순서 그대로.

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

- 커밋 전 `gate.mjs --commit [--stage-all]` — 컴파일·린트, **건드린 스택만**. DoD 는 돌리지 않는다(커밋마다 DoD 를 다시 돌린 것이 경량 게이트 시간의 86%였다). 목표 `gate.commit_budget_s`(기본 3분). 구현 중 새 테스트가 도는지는 관련 테스트만 직접 돌려 본다.
- push·complete 전 `gate.mjs --full` — **DoD 프로브를 먼저** 돌리고, 하나라도 FAIL 이면 스택 단계를 건너뛰고 끝난다(프로브를 고친 뒤 다시). 통과하면 빌드·전체 테스트·extra(프로젝트 정적 게이트 등) → DoD tests 항목. 9~15분이면 `exec_command`로 시작하고 반환된 session_id를 `write_stdin`으로 기다린다.
- `--full --stacks a,b` 로 스택을 줄일 수 있지만 **이 브랜치가 바꾼 스택은 뺄 수 없다**(exit 2) — 기록은 결과만 남고 어느 스택이 돌았는지는 push·complete 가 다시 보지 않기 때문이다. 다른 스택의 파일을 읽는 테스트가 있으면 그 경로를 그 스택의 `stacks.<name>.paths` 에 넣어 둔다.
- **Herdr 안이면** 게이트를 runner pane 에서 돌린다 — `node "<P>/scripts/herdr-lanes.mjs" gate --full|--commit [--stage-all] [--no-wait] --cwd <루트> --json`. 로그가 driver 컨텍스트 밖(pane)에 남고, 기록·토스트는 gate.mjs 가 그대로 한다. `--no-wait` 면 바로 돌아오고 완료 토스트(전량 PASS=done · FAIL=request)를 기다린다. 결과 JSON 은 출력의 `out`.
- 같은 트리에 전량 통과 기록이 이미 있으면 `--commit` 은 재실행을 생략한다.
- DoD `tests: {stack, select[]}` 항목은 스택별로 **한 번에** 돈다(`stacks.<stack>.dod_tests` — gradle `--tests` 합집합 · vitest 경로 합집합 + JSON 리포터) — 러너 리포트로 항목마다 판정한다(걸린 것 1건 이상 · 실패 0 · 통과 ≥ `min_tests`). test 명령이 `dod_tests.run` 과 같으면 그 리포트를 읽기만 하고 다시 돌리지 않는다. `probe` 문자열 항목은 항목마다 돈다 — 테스트를 도는 DoD 를 probe 로 쓰면 항목 수만큼 러너를 새로 띄운다(2026-09-23 실측: 41건 31.5분).
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
5. Atlassian MCP: `transitionJiraIssue`(`jira.done_transition`) + `addCommentToJiraIssue`(출력 comment). 키마다 — 하위부터. **부모**(상태 JSON `subtasks[].parent`)는 전이 직전에 `getJiraIssue` 로 그 하위를 다시 읽어, 이 브랜치에 안 들어온 하위(다른 레포 몫·`subtasks.match` 밖)가 아직 안 끝났으면(완료 카테고리 · `jira.done_transition` 상태가 아니면) 부모를 전이하지 않고 "부모 <KEY> 보류 — 남은 하위: <KEY…>" 를 보고한다.
6. 보고: 브랜치·push 여부·게이트 분모·리뷰 결과·사람이 할 일(main 머지는 사람 — 자동 머지 금지).
