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

## 무엇이 들어 있나

| 구성 요소 | 역할 |
|-----------|------|
| `skills/issue` | 라우터 — 지금 어느 단계인지 정하고 아래 스크립트·워크플로를 부른다 |
| `skills/setup` | 프로젝트 설정·전제 점검·v2 잔재 이관·위반 주입 |
| `skills/grilling` `grill-me` `jira-create` `kb-ingest` | 결정 인터뷰 · 이슈 생성 · 지식 wiki ingest |
| `workflows/plan.js` `implement.js` `verify.js` `recon.js` | Workflow 툴로 도는 다중 에이전트 단계(모든 레인에 model 명시) |
| `hooks/hooks.json` → `scripts/commit-gate.mjs` | PreToolUse(Bash) 훅 — 게이트·리뷰 기록이 커밋될 트리와 같을 때만 commit/push 허용 |
| `scripts/gate.mjs` | 경량(컴파일·린트·DoD) / 전량(빌드·테스트·extra) 게이트 러너 — 트리 id 와 로그 sha256 을 기록 |
| `scripts/issue-start.mjs` `issue-set.mjs` `issue-complete.mjs` | 브랜치·상태 JSON 생명주기 |
| `scripts/safe-commit.mjs` | 훅이 발화하지 않는 경로(헤드리스·무인)에서 같은 판정 후 커밋 |
| `scripts/codex-review.sh` | Codex CLI 리뷰 래퍼(본문 끝으로 판정, 한도 소진을 감추지 않음) |
| `scripts/wiki-row.mjs` `wiki-lint.mjs` `memory-index.mjs` | 마크다운 wiki 표 upsert · 정합 점검 · 자동 메모리 인덱스 |
| `agents/` | 스택별 제네릭 리뷰어·탐색기(Spring / Vue / cross-repo) — verify 워크플로의 dispatch 대상 |
| `schemas/` | `harness.json`(프로젝트 설정) · 상태 JSON 스키마 |

## 프로젝트에 남는 것

- `.claude/harness.json` — 프로젝트만 아는 값(스택·게이트 명령·브랜치 규칙·모델 티어). **절대 경로·자격증명 금지**(머신별 값은 `stacks.<name>.env_file` 이 가리키는 gitignore 파일로).
- `.claude/runtime/issues/<branch>.json` — 브랜치 단위 상태(단계·결정·레인·DoD·게이트·리뷰 기록). `.claude/runtime/` 은 gitignore 대상.
- `.claude/settings.json` — `extraKnownMarketplaces` / `enabledPlugins` (팀원 자동 안내).

## 게이트가 막는 이유(사유 코드)

`[jira-harness] git commit: <CODE> — …` 한 줄이 stderr 로 나옵니다. `NO_STATE`(이슈 시작 안 됨) · `DIRTY_TREE`(게이트가 본 트리 ≠ 커밋될 트리) · `NO_GATE` / `GATE_STALE` / `GATE_FAIL`(게이트 미실행·낡음·실패) · `NO_REVIEW` / `REVIEW_STALE` / `REVIEW_BLOCKERS`(리뷰 없음·낡음·blocker) · push 는 추가로 `GATE_LEVEL`(전량 게이트 필요). 문서만 바뀐 커밋은 어느 브랜치든 통과합니다(`git add … && git commit` 처럼 한 명령이 스테이징까지 하면 스테이징 예정 파일로 판정). complete 로 아카이브된 브랜치에 코드를 더 커밋하면 `COMPLETED`(재시작은 `--adopt`). `mode: suggest` 는 경고만, `off` 는 비활성.

브랜치가 `branch_pattern` 밖이면 `BRANCH_PATTERN` 으로 막습니다. 혼자 쓰는 저장소라 이슈 브랜치를 로컬에서 머지한 뒤 `main` 을 직접 올리는 흐름이라면 `"default_branch_policy": "allow"` 로 **그 브랜치에서만** 판정을 끕니다(기본 `deny` — 켜지 않은 프로젝트의 동작은 그대로). `allow` 를 켜도 이슈 브랜치의 사다리(상태·게이트·리뷰)는 전혀 바뀌지 않습니다.

## 요구 사항

Node.js 20+, git. Windows 는 Git Bash(게이트 명령 실행용). Codex CLI 는 선택(없으면 리뷰 1단계를 건너뛰고 그렇게 기록). Jira 연동은 Atlassian MCP 가 있을 때만(없어도 코드 진행은 막지 않음).

## 개발

```bash
node --test scripts/__tests__/*.test.mjs   # 실제 임시 git 저장소에서 훅·러너·스크립트를 실행하는 통합 테스트
node scripts/dev/wf-sim.mjs workflows/plan.js --args '{...}' --strict   # Workflow 툴 없이 워크플로 제어 흐름 검사
node scripts/hygiene.mjs                    # 공개 저장소 위생(내부 문자열 검출) — push 전 필수
claude plugin validate . --strict
```

이 저장소는 공개입니다. 특정 회사·프로젝트·사람·호스트를 가리키는 문자열은 넣지 않습니다(`.hygiene.local` 에 검출 패턴, gitignore).

## 이전 버전

v2 는 user-scope 스킬 17종 묶음([`claude_jira_harness`](https://github.com/bigbulgogiburger/claude_jira_harness))이었습니다. v3 는 그것을 플러그인 하나로 재구축한 것입니다 — 스킬 체인 대신 라우터 1개 + 저장 워크플로, 모델이 쓰던 markdown 판정 대신 스크립트가 쓰는 상태 JSON, 훅은 `PASS` 문자열 grep 대신 git 트리 id 대조. 기존 프로젝트는 `/jira-harness:setup --upgrade` 로 v2 잔재(훅 3종·runtime 파일·`HARNESS_MODE`)를 이관합니다.

## 라이선스

MIT
