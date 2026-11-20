---
name: issue
description: >-
  Jira 이슈(ABC-123 꼴 키) 한 건 또는 여러 건의 개발 전 주기를 진행하는 라우터 — 브랜치·작업트리·상태 JSON(start),
  결정 인터뷰(grill), 계획·기계 점검·반증과 승인(plan), 구현(implement), Codex+워크플로 리뷰(verify),
  컴파일·테스트 게이트(gate), 훅이 판정하는 commit/push, 마감(complete: push·wiki·Jira 전이).
  사용자가 "jira-harness 플러그인의 issue 스킬 KEY", "KEY 시작/착수/잡아줘", "이어서 해줘", "계획 세워줘", "리뷰 돌려줘",
  "게이트/테스트 돌려줘", "커밋해줘", "push 해줘", "마무리/QA 넘겨줘/완료 처리" 라고 하거나, 현재 브랜치가
  이슈 브랜치(feat/KEY…)이면 반드시 이 스킬을 쓴다. 명시 호출이 없어도 이슈 키가 언급된 개발 요청이면
  이 스킬로 지금 어느 단계인지부터 정한다.
---

Codex 질문 도구: `request_user_input`은 제공되는 모드에서만 사용한다. 사용할 수 없으면 `request_user_input_async` 또는 간결한 평문 질문을 사용한다. 승인 요청은 현재 세션의 상위 지침을 따르고, 응답이 없다는 이유로 승인 처리하지 않는다.

# jira-harness 플러그인의 issue 스킬 — 이슈 라우터

`jira-harness 플러그인의 issue 스킬 <KEY[,KEY…]> [--adopt | --worktree] [--stage <단계>] [--unattended]`

## 0. 원칙 (왜 이렇게 나뉘어 있나)

- **이 스킬은 판단만 한다.** 브랜치·상태 JSON·게이트·리뷰 기록은 전부 `scripts/` 가 쓰고, `git commit`/`git push` 는 훅이 판정한다.
  모델이 상태 JSON 의 `gate`/`review` 를 손으로 쓰면 훅과 어긋나 막히거나, 더 나쁘게는 게이트 없이 통과한다.
- 기록의 신선도는 **git 트리 id** 로 잰다. "테스트 돌렸다" 는 말은 증거가 아니고, 게이트가 본 트리와 커밋될 트리가 같아야 통과다.
- 사람 결정(승인·human DoD)은 건너뛰지 않는다. 묻지 않고 고른 해석은 숨기지 않고 **가정으로 기록**한다(`issue-set.mjs --assume`) — 승인 요약과 마감 댓글의 맨 위에 올라가 사람이 한 번에 바로잡는다.

## 1. 매 호출 첫 동작 — 지금 어디인가

`<P>` = 플러그인 루트 절대 경로. 이 스킬이 로드될 때 표시되는 `Base directory for this skill` 의 **두 단계 위**다(`skills/issue` 의 부모의 부모). 아래 모든 명령의 `<P>` 를 그 경로로 치환하고, 프로젝트 루트(또는 그 worktree)에서 실행한다.

```bash
node "<P>/scripts/issue-start.mjs" --status --json
```

| `code` | 뜻 | 다음 |
|--------|----|------|
| `NO_HARNESS` | 이 저장소는 설정 전 | `jira-harness 플러그인의 setup 스킬` 을 안내하고 멈춘다 |
| `OUTSIDE_PATTERN` | 이슈 브랜치가 아니다 | 키가 있으면 **start**(기본 브랜치에서 새 브랜치). 현재 브랜치를 그대로 쓰려면 `--adopt`, 지금 트리를 건드리지 않고 따로 하려면 `--worktree`(프로젝트가 `issue_worktree: "always"` 면 플래그 없이도 작업트리에서 시작한다 — 출력 `next` 가 알려 준다) |
| `NO_STATE` | 이슈 브랜치인데 상태 없음 | **start** (`issue-start.mjs <KEY>` — 브랜치는 그대로 두고 상태만 만든다) |
| `OK` | 진행 중 | 출력의 `stage`·`next` 대로 §2 의 그 단계부터. `--stage` 가 있으면 그 단계로 점프(뒤로 가는 재계획도 허용) |

사용자의 말이 `next` 보다 우선이다 — "커밋해줘" 는 stage 와 무관하게 **gate → commit** 이다.

`OK` 출력의 `lane_runner`(`herdr` | `workflow`)는 **이 세션이 구현 레인을 돌리는 수단**이다 — plan 의 레인 설계와 implement 의 실행이 이 값 하나를 따른다. `harness.json` 의 `herdr.lanes` 만 보고 정하지 않는다: 설정이 켜져 있어도 Herdr 밖 세션은 `workflow` 다.

## 2. 단계 표 — 절차는 같은 이름 절을 읽고 따른다: start~implement 는 [references/stages-front.md](references/stages-front.md), verify 부터는 [references/stages-back.md](references/stages-back.md)

| stage | 한 줄 | 주체 · 수단 | 끝나면 |
|-------|------|------------|--------|
| start | **하위이슈 확장** · 브랜치 채택/생성(또는 이슈 작업트리 — `--worktree` · 프로젝트 설정 `issue_worktree: "always"`) · 상태 JSON · Jira 착수(assignee·전이·댓글). 출력에 `worktree.path` 가 있으면 **그 경로가 일하는 자리**다 | `issue-start.mjs` + Atlassian MCP 3콜 | grill |
| grill | 분기점을 **한 번에 하나씩** 묻고 확정 · 묻지 않고 고른 해석은 가정으로 기록 · 결함은 보고된 상태부터 재현 | `jira-harness 플러그인의 grilling 스킬` 을 그 자리에서 따른다 | `issue-set.mjs --decision`·`--assume` · `--stage plan` |
| plan | **드라이버가 직접**(조사할 곳이 넓으면 조사는 `spawn_agent` 여러 개에 나눠 맡긴다): 영향 범위 훑기 → 가이드 초안 + DoD 사이드카 → 기계 점검 → 새 컨텍스트 반증 한 번 → **사용자 승인** | 직접 → `issue-set.mjs --merge --from plan`(오류가 있으면 반영하지 않는다) → `spawn_agent` 반증 에이전트 1개 → request_user_input | 승인 시 `.draft` 확정 · `wiki-row.mjs` forecast · `--stage implement` |
| implement | 코드 작성 — **이슈 1건은 드라이버가 직접**, **이슈 여러 건(다중 키·하위이슈)은 이슈마다 레인 하나로 동시에**(병렬의 단위는 이슈다). 레인을 돌리는 수단은 §1 출력의 `lane_runner` 가 정한다 — **`herdr`**(Herdr 안 + `herdr.lanes` 가 `implement`/`all`)면 레인마다 worktree + kind(claude·codex·grok) pane 이 고치고 메인이 패치를 회수·적용, **`workflow`** 면 `spawn_agent` 레인들이 한 작업트리에서 파일을 나눠 동시에 고친다. 구현 중 테스트는 `gate.mjs --try` 로 **자기 것만 한 번에 묶어** 돌린다(상태·판정을 남기지 않는 확인 — 전체 테스트·전체 lint·build 는 게이트와 main 배치의 몫이다). 화면을 바꿨으면 실제 화면에서 확인하고 근거를 남긴다 | 직접 / `herdr-lanes.mjs implement`([herdr-lanes.md](references/herdr-lanes.md) §implement) / `spawn_agent` | verify |
| verify | **Codex 판정** → (Codex 가 못 채운 자리에만) 워크플로 ≤4레인 → **메인이 확정/기각** → 기록 | `codex-review.sh` → `scripts/lanes-codex.mjs verify --json` → `issue-set.mjs --review` | gate |
| gate | 커밋 전 경량(컴파일·린트) / push 전 — `gate.push_level` 이 `dod` 면 **경량+DoD**(DoD 프로브 → 바뀐 스택의 컴파일·린트 → DoD tests · 테스트 선택 단계 없음 — Herdr 멀티 이슈 병렬에 권장), `related` 면 **관련 테스트**(DoD 프로브 → 바뀐 스택의 컴파일·린트·관련 테스트 → DoD tests), `full`(기본)이면 전량(빌드·전체 테스트·extra까지) | `gate.mjs --commit` / `gate.mjs --dod`·`--related`·`--full` | commit / push |
| commit·push | 평소처럼 `git commit` / `git push` — 훅이 판정 | 훅 (`hooks/hooks.json`) · 무인은 `safe-commit.mjs` | 다음 구현 또는 complete |
| complete | push 전 게이트·리뷰 신선 확인 → push → 상태 아카이브 → wiki closure → Jira 전이·댓글 | `issue-complete.mjs` → `wiki-row.mjs` → `wiki-lint.mjs` → MCP | 사람 머지 대기 (자동 머지 금지) |
| main 배치 | (`push_level=dod`·`related` — **dod 면 테스트 검증은 여기뿐이라 필수**) 여러 이슈를 기본 브랜치에 머지한 **뒤 한 번**(dod 는 머지 ~5건마다 권장) — 전 스택 빌드·전체 테스트·extra. 이슈마다 돌리지 않는다 | `gate.mjs --main` (`--main --status` = 마지막 PASS 이후 커밋 수) | 배포·릴리즈 전 PASS 확인. FAIL 이면 용의 커밋부터 |

## 3. 훅이 막았을 때 — 사유 코드는 Codex 차단 메시지의 `[jira-harness] git <op>: <CODE> — …` 한 줄

| 코드 | 뜻 | 조치 |
|------|----|------|
| `BRANCH_PATTERN` | 이슈 브랜치가 아니고 상태도 없다 | `issue-start.mjs <KEY> --adopt`(이 브랜치를 채택) 또는 기본 브랜치로 가서 start |
| `NO_STATE` | 이슈가 시작되지 않았다 | `issue-start.mjs <KEY>` |
| `COMPLETED` | complete 가 상태를 아카이브한 브랜치에 **코드** 커밋 | closure 문서(CHANGELOG·wiki)는 docs-only 로 통과한다. 코드를 더 바꾸려면 `issue-start.mjs <KEY> --adopt` 로 다시 시작 |
| `DIRTY_TREE` | 게이트가 본 트리 ≠ 커밋될 트리(unstaged·untracked) | 전부 `git add -A` 하거나 `gate.mjs --commit --stage-all` |
| `NO_GATE` `GATE_STALE` `GATE_FAIL` `GATE_LOG_*` | 게이트 미실행·낡음·실패·로그 불일치 | `gate.mjs --commit` (push 면 사유에 적힌 `--dod`/`--related`/`--full`) 재실행 |
| `GATE_LEVEL` | push 인데 그 단계 게이트 기록이 없다(경량뿐 · 또는 `push_level` 보다 약한 기록 — `full` 인데 관련 테스트 기록, `related` 인데 dod 기록. 더 강한 기록은 받는다) | 사유에 적힌 명령 — `push_level=dod` 면 `gate.mjs --dod`, `related` 면 `gate.mjs --related`, 아니면 `gate.mjs --full` |
| `NO_REVIEW` `REVIEW_STALE` | 리뷰 없음 · 리뷰 이후 코드 변경 | verify — 이미 한 번 했으면 **델타 패스**만 |
| `REVIEW_BLOCKERS` | 확정 blocker 미해결 | 수정 → 델타 패스 |
| `BAD_STATE` | 상태 JSON 이 스키마에 안 맞는다(손으로 고친 흔적) | `issue-set.mjs` 로 값을 고치거나 `issue-start.mjs <KEY>` 로 다시 만든다 |
| `BAD_CONFIG` `HOOK_ERROR` | harness.json 이 스키마에 안 맞거나 판정 중 예외(fail-closed). 명령의 `cd`/`-C` 가 없는 경로를 가리켜도 여기다 | 코드 문제가 아니다 — `jira-harness 플러그인의 setup 스킬` 으로 설정을 고친다(우회 금지). "판정할 디렉토리가 없다" 면 `cd` 를 변수·`~` 가 아닌 실제 경로로 |

`issue-complete.mjs` 는 같은 사다리에 `CLAUDE_MD_TOO_LONG`·`PUSH_FAILED` 를 더한다(stages-back.md §complete). `DOCS_ONLY`·`MODE_OFF`·suggest 경고는 통과다. docs-only 는 `git add … && git commit` · `commit -a` 처럼 한 명령이 스테이징까지 하면 스테이징 *예정* 파일(staged+unstaged+untracked)로 판정한다 — 훅은 명령 실행 *전*에 보므로 그때 인덱스는 비어 있다. 훅을 우회하려고 `--no-verify` 나 상태 JSON 편집을 쓰지 않는다 — 막힌 이유를 고치는 것이 항상 더 짧다.

## 4. 변형

- **`--unattended`(무인)**: request_user_input 을 부르지 않고 권장안을 택한다 — 고른 것은 `issue-set.mjs --assume` 으로 가정에 남기고 승인 note 는 `approved(unattended)`. 사람 게이트(human DoD·머지)에 닿으면 멈추고 보고. 커밋은 `node "<P>/scripts/safe-commit.mjs" -m "<메시지>" [--push]` — 훅과 같은 판정을 스크립트가 하고 통과할 때만 커밋한다(훅이 발화하지 않는 헤드리스 경로에서도 같은 규율).
- **Codex 실행 경로**: Codex 에는 Workflow 툴이 없고 이 배포본에는 `workflows/` 가 들어 있지 않다. plan 의 반증과 구현 레인(이슈 여러 건이면 이슈마다 하나)은 `spawn_agent` 로 띄우고(stages-front.md — 서로의 결과를 기다리지 않는 레인들은 한꺼번에 띄워 동시에 돌린다), verify 레인은 `scripts/lanes-codex.mjs` 를 사용한다. 개별 역할 위임은 `subagents/<name>.toml`의 `developer_instructions`를 읽어 `spawn_agent` 프롬프트에 넣는다. Claude 에이전트 이름이나 모델 티어를 Codex 호출 인자로 넘기지 않는다. `lane_runner` 가 `herdr` 면 `scripts/herdr-lanes.mjs implement` 가 레인마다 worktree + kind pane 을 띄우고 패치를 회수한다(Node 스크립트라 Codex 에서도 그대로 돈다).
- **하위이슈(항상)**: 사용자가 준 이슈는 **몇 개든** 그 하위이슈를 같이 꺼내 처리한다 — 플래그 없음("이 이슈만" 이라고 하면 건너뜀). start 직전에 키마다 `getJiraIssue` 로 읽어 `issue-subtasks.mjs` 로 풀고(끝난 하위·다른 프로젝트·`harness.json` `subtasks.match` 밖은 제외), 부모+하위를 아래 다중 키 한 브랜치로 처리한다. 구현은 하위이슈마다 레인 하나로 동시에 한다 — stages-front.md §start·§implement · stages-back.md §complete.
- **다중 키** `ABC-696,ABC-940`(하위가 붙으면 `ABC-696-697-698` 꼴): 브랜치 `feat/ABC-696-940` 하나, dev-guide 한 장, 상태 JSON 하나. Jira 콜은 키마다. **구현은 이슈마다 레인 하나로 동시에 한다** — `lane_runner` 가 `herdr` 면 레인마다 worktree pane, `workflow` 면 한 작업트리의 `spawn_agent` 레인(stages-front.md §implement). 브랜치·PR 까지 따로 가져갈 이슈들이면 한 번에 주지 말고 이슈마다 `--worktree` 로 시작한 자기 세션에서 한다.
- **worktree**: 이슈 작업트리는 `issue-start.mjs <KEY> --worktree` 로 파고 `--remove-worktree <KEY>` 로 지운다(손으로 파거나 지우지 않는다 — 준비·무시 설정이 빠지고, 지울 때 안의 링크를 따라 메인 쪽 폴더가 지워진다). 프로젝트가 harness.json 에 `"issue_worktree": "always"` 를 두면 플래그 없는 시작도 작업트리를 판다(메인 체크아웃의 브랜치를 바꾸지 않는다) — 어느 쪽이든 **일하는 자리는 플래그가 아니라 시작 출력으로 정한다: `worktree.path` 가 있으면 그 경로다.** `--remove-worktree <KEY>` 는 그 이슈의 Herdr 구현 레인이 남긴 작업트리와 레인 브랜치도 함께 치운다(stages-back.md §complete 7). 어느 worktree 에서 실행해도 상태·로그는 메인 저장소의 runtime 에 쓰인다 — 같은 브랜치의 게이트 기록을 worktree 와 메인이 공유한다.
- `harness.json` 의 게이트 명령이 틀렸으면 이 스킬에서 고치지 않는다 — `jira-harness 플러그인의 setup 스킬` 의 일이다.

## 5. 멈출 때마다 보고 (5줄 이내)

`stage` · 방금 한 것 · 훅/게이트/리뷰 결과 코드와 분모(테스트 N건, blocker N건) · 사람 확인 없이 고른 가정(있으면) · 다음 한 수 · 사용자 결정이 필요한지.
