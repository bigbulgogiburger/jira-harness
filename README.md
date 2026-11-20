# jira-harness

Jira 이슈 한 건을 **브랜치 → 결정 인터뷰 → 계획 → 구현 → 리뷰 → 게이트 → 커밋/푸시 → 마감**까지 끌고 가는 Claude Code 플러그인입니다.
모델은 판단만 하고, 기록(상태 JSON·게이트·리뷰)은 스크립트가 쓰며, `git commit` / `git push` 는 훅이 판정합니다 — "테스트 돌렸다" 는 말이 아니라 **git 트리 id** 가 증거입니다.

> Jira-driven development harness for Claude Code: an issue router skill, saved workflows (plan / implement / verify), a commit/push gate hook, and deterministic bookkeeping scripts.

## 설치

```bash
claude plugin marketplace add bigbulgogiburger/jira-harness
claude plugin install jira-harness@bigbulgogiburger
```

프로젝트에 붙이기:

```
/jira-harness:setup            # 스택 감지 → harness.json → 전제 점검 → 위반 주입으로 훅 실효 확인
/jira-harness:issue ABC-123    # 이슈 한 건(또는 ABC-123,ABC-124) 진행
```

업데이트는 `claude plugin update jira-harness` 후 Claude Code 재시작.

## Codex CLI 에서 쓰기

같은 하네스의 **Codex 판**이 [`bigbulgogiburger/jira-harness_codex`](https://github.com/bigbulgogiburger/jira-harness_codex) 에 있습니다.

```bash
codex plugin marketplace add bigbulgogiburger/jira-harness_codex --ref main
codex plugin add jira-harness@jira-harness-codex
```

그 저장소는 **생성물**입니다 — 이 저장소에서 [`caseworker`](https://github.com/bigbulgogiburger/caseworker) 의
`scripts/build-codex.mjs` 가 통째로 찍어냅니다. 그러니 **고칠 곳은 언제나 여기**이고,
Codex 에서만 달라야 하는 파일은 이 저장소의 `codex-overlay/` 에 둡니다(생성 시 위에 덮입니다).

```bash
node <caseworker>/scripts/build-codex.mjs --src . --out <jira-harness_codex>
```

⚠ **Codex 는 플러그인을 설치해도 그 훅을 신뢰하지 않습니다** — `/hooks` 에서 검토·신뢰하기 전까지
커밋 게이트는 "있지만 아무것도 막지 않는" 상태입니다. 서브에이전트도 이름으로 부르는 구조가
아니라 `spawn_agent` 로 띄우고 역할을 프롬프트로 주는 구조라, `agents/` 는 `subagents/*.toml`
역할 원고로 옮겨집니다. 차이와 미검증 항목은 [Codex 판 README](https://github.com/bigbulgogiburger/jira-harness_codex#readme) 에 정리돼 있습니다.

## 무엇이 들어 있나

| 구성 요소 | 역할 |
|-----------|------|
| `skills/issue` | 라우터 — 지금 어느 단계인지 정하고 아래 스크립트·워크플로를 부른다 |
| `skills/setup` | 프로젝트 설정·전제 점검·v2 잔재 이관·위반 주입 |
| `skills/grilling` `grill-me` `jira-create` `kb-ingest` | 결정 인터뷰 · 이슈 생성 · 지식 wiki ingest |
| `workflows/plan.js` `plan-check.js` `implement.js` `verify.js` | Workflow 툴로 도는 에이전트 단계(모든 레인에 model 명시) — `plan` 은 조사할 곳이 넓은 이슈의 조사·초안을 병렬로 돌리고, `plan-check` 는 계획을 세운 컨텍스트와 무관한 에이전트 하나가 "이대로 구현하면 틀리게 되는 곳" 을 찾는 반증이다 |
| `scripts/plan-check.mjs` · `scripts/lib/plan-check.mjs` | 계획 기계 점검 — 요구↔DoD 대응 · 0건 매치 `select` · 건수 하한 없는 러너 프로브 · 원복이 위험한 주입 프로브 · 레인 이름·파일 겹침 · 이 세션이 돌릴 수 없는 작업트리 레인 · 하위이슈 DoD. `issue-set.mjs --merge --from plan` 이 반영 전에 돌리고 오류가 있으면 반영하지 않는다 |
| `hooks/hooks.json` → `scripts/commit-gate.mjs` | PreToolUse(Bash\|PowerShell) 훅 — 게이트·리뷰 기록이 커밋될 트리와 같을 때만 commit/push 허용. `git commit … && git push` 처럼 한 명령에 둘이 있으면 둘 다 판정한다 |
| `scripts/gate.mjs` | 경량(컴파일·린트) / **경량+DoD**(`--dod` — 바뀐 스택의 컴파일·린트·DoD 만, 테스트 선택 없음 · `gate.push_level=dod` 의 push 전제 · 이 모드는 머지 뒤 `--main` 필수 · Herdr 멀티 이슈 병렬에 권장) / **관련 테스트**(`--related` — 바뀐 스택의 컴파일·린트·관련 테스트·DoD · `gate.push_level=related` 의 push 전제) / 전량(DoD 프로브 → 빌드·테스트·extra → DoD tests) / **main 배치**(`--main` — 기본 브랜치에서 여러 이슈 머지 뒤 전체 스위트 1회 · `main-gate.json`) 게이트 러너 — DoD 는 전량에서만 돌고, 프로브가 하나라도 FAIL 이면 스택 단계를 건너뛴다 · DoD `tests` 항목은 스택별 1회 배치(`stacks.<name>.dod_tests`, test 리포트에 걸리면 재사용) · `--full --stacks` 는 브랜치가 바꾼 스택을 뺄 수 없다 · 트리 id 와 로그 sha256 을 기록 · **구현 중 확인**(`--try` — DoD tests 를 스택마다 한 번에 돌려 항목별 판정만 낸다. 게이트가 아니다: 상태·판정을 기록하지 않고 로그 파일만 남긴다) · `stacks.<name>.lint_changed` 를 두면 이슈 게이트(`--commit`·`--dod`·`--related`)의 lint 가 바뀐 파일만 본다(선택 · `--full`·`--main` 은 언제나 전체 lint) |
| `scripts/lib/queue.mjs` · `scripts/queue-run.mjs` | 무거운 게이트 대기열 — `--full`·`--related`·`--main` 은 이 PC 에서 한 번에 하나만 돈다(여러 작업공간이 `~/.gate-queue` 한 줄을 같이 쓴다 · 먼저 온 순서 · 임자가 죽으면 OS 가 자리를 놓는다). 기다린 시간은 기록의 `queue_wait_s`. `queue-run.mjs [--no-queue] -- <명령>` 으로 게이트가 아닌 무거운 명령도 같은 줄에 세운다. **Windows 에서만 기본으로 켜져 있다**(그 밖의 OS 는 검증 전이라 `GATE_QUEUE=on` 일 때만). 끄기: `--no-queue` · `GATE_QUEUE=off` · `gate.queue: false`. 경량(`--commit`)·`--dod` 게이트와 줄을 서지 않고 직접 돌린 테스트는 대기열 밖이다 |
| `scripts/issue-start.mjs` `issue-set.mjs` `issue-complete.mjs` | 브랜치·상태 JSON 생명주기. `issue-start.mjs --status` 의 `lane_runner`(`herdr`\|`workflow`)가 이 세션이 구현 레인을 돌리는 수단이다(설정이 켜져 있어도 Herdr 밖이면 `workflow`). `issue-start.mjs --worktree` 는 지금 트리를 건드리지 않고 이슈 작업트리를 파고(준비·무시 설정 포함 — harness.json 에 `"issue_worktree": "always"` 를 두면 플래그 없는 시작도 그렇게 한다), `--remove-worktree` 는 안의 링크를 먼저 끊고 지운다(`<KEY>` 로 부르면 그 이슈의 구현 레인이 남긴 작업트리·레인 브랜치도 함께 — 회수되지 않은 변경과 레인이 커밋한 작업은 남긴다). 사람 확인 없이 고른 해석(`issue-set.mjs --assume`)과 사람 확인 DoD 의 근거(`--dod-result … --evidence`)는 마감 댓글에 실린다 |
| `scripts/safe-commit.mjs` | 훅이 발화하지 않는 경로(헤드리스·무인)에서 같은 판정 후 커밋 |
| `scripts/codex-review.sh` | Codex CLI 리뷰 래퍼(본문 끝으로 판정, 한도 소진을 감추지 않음) |
| `scripts/wiki-row.mjs` `wiki-lint.mjs` `memory-index.mjs` | 마크다운 wiki 표 upsert · 정합 점검 · 자동 메모리 인덱스 |
| `scripts/lib/herdr.mjs` · `scripts/herdr-report.mjs` · `herdr-plugin.toml` · `scripts/herdr-plugin.mjs` | [Herdr](https://herdr.dev) 연동 — 이슈·stage·게이트·리뷰를 사이드바 토큰(`$case $stage $gate $review`)으로, 사람 게이트(게이트 FAIL·리뷰 blocker·훅 거부·승인 대기)는 토스트로. 같은 저장소가 Herdr 플러그인이기도 하다(팝업 status/gate · `worktree.created` 이벤트로 자동 착수). Herdr 밖에서는 전부 무동작 |
| `scripts/herdr-lanes.mjs` | Herdr pane 을 역할로 쓰는 실행기 — **reviewer**(`review.codex_via: "herdr"`: 상주 codex 를 재사용해 Codex 판정, 이슈가 바뀌면 `/new`) · **runner**(`gate --full`: 게이트를 runner pane 에서, 로그는 driver 밖) · **lane**(`herdr.lanes: "verify"`: grok 등 추가 심판) · **implement**(`herdr.lanes: "implement"`/`"all"`: 상태 JSON 의 레인마다 `lane/<slug>/<name>` worktree 를 파고 plan 이 고른 kind(claude·codex·grok)로 pane 을 띄운 뒤, 끝나면 diff 를 패치로 회수해 메인에 적용 — 레인은 커밋하지 않고 커밋 권한은 메인 훅뿐). 결과는 사이드카 JSON 파일로 회수(alt-screen 스크롤백을 믿지 않는다) — **끝의 신호는 결과 파일 하나**라, 긴 명령을 돌려 두고 쉬는 레인을 끝난 것으로 읽지 않는다(유휴면 한 번 알리고 `herdr.lane_timeout_s` 까지 기다린다). 실행기가 먼저 끝났으면 `implement --harvest` 로 결과만 회수한다 |
| `agents/` | 스택별 제네릭 리뷰어·탐색기(Spring / Vue / cross-repo) — verify 워크플로의 dispatch 대상 |
| `schemas/` | `harness.json`(프로젝트 설정) · 상태 JSON 스키마 |

## 프로젝트에 남는 것

- `.claude/harness.json` — 프로젝트만 아는 값(스택·게이트 명령·브랜치 규칙·모델 티어). **절대 경로·자격증명 금지**(머신별 값은 `stacks.<name>.env_file` 이 가리키는 gitignore 파일로).
- `.claude/runtime/issues/<branch>.json` — 브랜치 단위 상태(단계·결정·레인·DoD·게이트·리뷰 기록). `.claude/runtime/` 은 gitignore 대상.
- `.claude/settings.json` — `extraKnownMarketplaces` / `enabledPlugins` (팀원 자동 안내).

## 게이트가 막는 이유(사유 코드)

`[jira-harness] git commit: <CODE> — …` 한 줄이 stderr 로 나옵니다. `NO_STATE`(이슈 시작 안 됨) · `DIRTY_TREE`(게이트가 본 트리 ≠ 커밋될 트리) · `NO_GATE` / `GATE_STALE` / `GATE_FAIL`(게이트 미실행·낡음·실패) · `NO_REVIEW` / `REVIEW_STALE` / `REVIEW_BLOCKERS`(리뷰 없음·낡음·blocker) · push 는 추가로 `GATE_LEVEL`(전량 게이트 필요). 문서만 바뀐 커밋은 어느 브랜치든 통과합니다(`git add … && git commit` 처럼 한 명령이 스테이징까지 하면 스테이징 예정 파일로 판정). complete 로 아카이브된 브랜치에 코드를 더 커밋하면 `COMPLETED`(재시작은 `--adopt`). `mode: suggest` 는 경고만, `off` 는 비활성.

브랜치가 `branch_pattern` 밖이면 `BRANCH_PATTERN` 으로 막습니다. 혼자 쓰는 저장소라 이슈 브랜치를 로컬에서 머지한 뒤 `main` 을 직접 올리는 흐름이라면 `"default_branch_policy": "allow"` 로 **그 브랜치에서만** 판정을 끕니다(기본 `deny` — 켜지 않은 프로젝트의 동작은 그대로). `allow` 를 켜도 이슈 브랜치의 사다리(상태·게이트·리뷰)는 전혀 바뀌지 않습니다.

## Herdr 와 같이 쓰기(선택)

[Herdr](https://herdr.dev) 안에서 Claude Code 를 돌리면 jira-harness 가 자동으로 사이드바에 상태를 올리고 사람이 봐야 할 순간에 토스트를 띄웁니다. 설정은 `config.toml` 의 사이드바 행 선언 한 번뿐입니다:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "$case", "$stage"], ["$gate", "$review"]]
```

Herdr 플러그인으로도 설치됩니다 — `herdr plugin install bigbulgogiburger/jira-harness` (팝업 `status` · `gate-commit` · `gate-full`, 액션 `report` · `adopt-branch`, 이벤트 `worktree.created` → 자동 착수). 리뷰 레인을 codex·grok pane 으로 돌리려면 `harness.json.herdr.lanes = "verify"`, 구현 레인까지 worktree + kind pane 으로 돌리려면 `"all"`(메인 Claude 는 오케스트레이션·회수·게이트·커밋만). 자세한 것은 [`skills/setup/references/herdr.md`](skills/setup/references/herdr.md) 와 [`skills/issue/references/herdr-lanes.md`](skills/issue/references/herdr-lanes.md).

## 요구 사항

Node.js 20+, git. Windows 는 Git Bash(게이트 명령 실행용). Codex CLI 는 선택(없으면 리뷰 1단계를 건너뛰고 그렇게 기록). Jira 연동은 Atlassian MCP 가 있을 때만(없어도 코드 진행은 막지 않음). Herdr 는 선택(없으면 연동 지점이 전부 무동작).

## 개발

```bash
node --test scripts/__tests__/*.test.mjs   # 실제 임시 git 저장소에서 훅·러너·스크립트를 실행하는 통합 테스트
node scripts/dev/wf-sim.mjs workflows/plan-check.js --args '{...}' --strict   # Workflow 툴 없이 워크플로 제어 흐름 검사
node scripts/hygiene.mjs                    # 공개 저장소 위생(내부 문자열 검출) — push 전 필수
claude plugin validate . --strict
```

이 저장소는 공개입니다. 특정 회사·프로젝트·사람·호스트를 가리키는 문자열은 넣지 않습니다(`.hygiene.local` 에 검출 패턴, gitignore).

## 이전 버전

v2 는 user-scope 스킬 17종 묶음([`claude_jira_harness`](https://github.com/bigbulgogiburger/claude_jira_harness))이었습니다. v3 는 그것을 플러그인 하나로 재구축한 것입니다 — 스킬 체인 대신 라우터 1개 + 저장 워크플로, 모델이 쓰던 markdown 판정 대신 스크립트가 쓰는 상태 JSON, 훅은 `PASS` 문자열 grep 대신 git 트리 id 대조. 기존 프로젝트는 `/jira-harness:setup --upgrade` 로 v2 잔재(훅 3종·runtime 파일·`HARNESS_MODE`)를 이관합니다.

## 라이선스

MIT
