---
name: issue
description: >-
  Jira 이슈(ABC-123 꼴 키) 한 건 또는 여러 건의 개발 전 주기를 진행하는 라우터 — 브랜치·상태 JSON(start),
  결정 인터뷰(grill), 계획 워크플로와 승인(plan), 구현(implement), Codex+워크플로 리뷰(verify),
  컴파일·테스트 게이트(gate), 훅이 판정하는 commit/push, 마감(complete: push·wiki·Jira 전이).
  사용자가 "/jira-harness:issue KEY", "KEY 시작/착수/잡아줘", "이어서 해줘", "계획 세워줘", "리뷰 돌려줘",
  "게이트/테스트 돌려줘", "커밋해줘", "push 해줘", "마무리/QA 넘겨줘/완료 처리" 라고 하거나, 현재 브랜치가
  이슈 브랜치(feat/KEY…)이면 반드시 이 스킬을 쓴다. 명시 호출이 없어도 이슈 키가 언급된 개발 요청이면
  이 스킬로 지금 어느 단계인지부터 정한다.
---

# /jira-harness:issue — 이슈 라우터

`/jira-harness:issue <KEY[,KEY…]> [--adopt] [--stage <단계>] [--unattended]`

## 0. 원칙 (왜 이렇게 나뉘어 있나)

- **이 스킬은 판단만 한다.** 브랜치·상태 JSON·게이트·리뷰 기록은 전부 `scripts/` 가 쓰고, `git commit`/`git push` 는 훅이 판정한다.
  모델이 상태 JSON 의 `gate`/`review` 를 손으로 쓰면 훅과 어긋나 막히거나, 더 나쁘게는 게이트 없이 통과한다.
- 기록의 신선도는 **git 트리 id** 로 잰다. "테스트 돌렸다" 는 말은 증거가 아니고, 게이트가 본 트리와 커밋될 트리가 같아야 통과다.
- 사람 결정(승인·human DoD)은 건너뛰지 않는다. 무인 모드에서는 권장안을 택하되 **그렇게 했다고 기록**한다.

## 1. 매 호출 첫 동작 — 지금 어디인가

`<P>` = 플러그인 루트 절대 경로. 이 스킬이 로드될 때 표시되는 `Base directory for this skill` 의 **두 단계 위**다(`skills/issue` 의 부모의 부모). 아래 모든 명령의 `<P>` 를 그 경로로 치환하고, 프로젝트 루트(또는 그 worktree)에서 실행한다.

```bash
node "<P>/scripts/issue-start.mjs" --status --json
```

| `code` | 뜻 | 다음 |
|--------|----|------|
| `NO_HARNESS` | 이 저장소는 설정 전 | `/jira-harness:setup` 을 안내하고 멈춘다 |
| `OUTSIDE_PATTERN` | 이슈 브랜치가 아니다 | 키가 있으면 **start**(기본 브랜치에서 새 브랜치). 현재 브랜치를 그대로 쓰려면 `--adopt` |
| `NO_STATE` | 이슈 브랜치인데 상태 없음 | **start** (`issue-start.mjs <KEY>` — 브랜치는 그대로 두고 상태만 만든다) |
| `OK` | 진행 중 | 출력의 `stage`·`next` 대로 §2 의 그 단계부터. `--stage` 가 있으면 그 단계로 점프(뒤로 가는 재계획도 허용) |

사용자의 말이 `next` 보다 우선이다 — "커밋해줘" 는 stage 와 무관하게 **gate → commit** 이다.

## 2. 단계 표 — 각 행의 절차는 [references/stages.md](references/stages.md) 의 같은 이름 절을 읽고 따른다

| stage | 한 줄 | 주체 · 수단 | 끝나면 |
|-------|------|------------|--------|
| start | 브랜치 채택/생성 · 상태 JSON · Jira 착수(assignee·전이·댓글) | `issue-start.mjs` + Atlassian MCP 3콜 | grill (키 3개+ 또는 범위 불명이면 먼저 recon) |
| recon | 결정 분기점만 찾는 정찰(선택) | Workflow `workflows/recon.js` (sonnet) | grill |
| grill | 분기점을 **한 번에 하나씩** 묻고 확정 | `/jira-harness:grilling` 을 그 자리에서 따른다 | `issue-set.mjs --decision` · `--stage plan` |
| plan | dev-guide 초안 + 레인·DoD 설계 → **사용자 승인** | Workflow `workflows/plan.js` → `issue-set.mjs --merge --from plan` → AskUserQuestion | 승인 시 `.draft` 확정 · `wiki-row.mjs` forecast · `--stage implement` |
| implement | 코드 작성 — 레인 1개면 메인 직접, 2개+면 워크플로 | 직접 / Workflow `workflows/implement.js` | verify |
| verify | Codex → 워크플로 ≤4레인 → **메인이 확정/기각** → 기록 | `codex-review.sh` → `workflows/verify.js` → `issue-set.mjs --review` | gate |
| gate | 커밋 전 경량(컴파일·린트·DoD) / push 전 전량(빌드·테스트·extra) | `gate.mjs --commit` / `gate.mjs --full` | commit / push |
| commit·push | 평소처럼 `git commit` / `git push` — 훅이 판정 | 훅 (`hooks/hooks.json`) · 무인은 `safe-commit.mjs` | 다음 구현 또는 complete |
| complete | 전량 게이트·리뷰 신선 확인 → push → 상태 아카이브 → wiki closure → Jira 전이·댓글 | `issue-complete.mjs` → `wiki-row.mjs` → `wiki-lint.mjs` → MCP | 사람 머지 대기 (자동 머지 금지) |

## 3. 훅이 막았을 때 — 사유 코드는 stderr 의 `[jira-harness] git <op>: <CODE> — …` 한 줄

| 코드 | 뜻 | 조치 |
|------|----|------|
| `BRANCH_PATTERN` | 이슈 브랜치가 아니고 상태도 없다 | `issue-start.mjs <KEY> --adopt`(이 브랜치를 채택) 또는 기본 브랜치로 가서 start |
| `NO_STATE` | 이슈가 시작되지 않았다 | `issue-start.mjs <KEY>` |
| `COMPLETED` | complete 가 상태를 아카이브한 브랜치에 **코드** 커밋 | closure 문서(CHANGELOG·wiki)는 docs-only 로 통과한다. 코드를 더 바꾸려면 `issue-start.mjs <KEY> --adopt` 로 다시 시작 |
| `DIRTY_TREE` | 게이트가 본 트리 ≠ 커밋될 트리(unstaged·untracked) | 전부 `git add -A` 하거나 `gate.mjs --commit --stage-all` |
| `NO_GATE` `GATE_STALE` `GATE_FAIL` `GATE_LOG_*` | 게이트 미실행·낡음·실패·로그 불일치 | `gate.mjs --commit` (push 면 `--full`) 재실행 |
| `GATE_LEVEL` | push 인데 경량 게이트뿐 | `gate.mjs --full` |
| `NO_REVIEW` `REVIEW_STALE` | 리뷰 없음 · 리뷰 이후 코드 변경 | verify — 이미 한 번 했으면 **델타 패스**만 |
| `REVIEW_BLOCKERS` | 확정 blocker 미해결 | 수정 → 델타 패스 |
| `BAD_STATE` | 상태 JSON 이 스키마에 안 맞는다(손으로 고친 흔적) | `issue-set.mjs` 로 값을 고치거나 `issue-start.mjs <KEY>` 로 다시 만든다 |
| `BAD_CONFIG` `HOOK_ERROR` | harness.json 이 스키마에 안 맞거나 판정 중 예외(fail-closed) | 코드 문제가 아니다 — `/jira-harness:setup` 으로 설정을 고친다(우회 금지) |

`issue-complete.mjs` 는 같은 사다리에 `CLAUDE_MD_TOO_LONG`·`PUSH_FAILED` 를 더한다(stages.md §complete). `DOCS_ONLY`·`MODE_OFF`·suggest 경고는 통과다. docs-only 는 `git add … && git commit` · `commit -a` 처럼 한 명령이 스테이징까지 하면 스테이징 *예정* 파일(staged+unstaged+untracked)로 판정한다 — 훅은 명령 실행 *전*에 보므로 그때 인덱스는 비어 있다. 훅을 우회하려고 `--no-verify` 나 상태 JSON 편집을 쓰지 않는다 — 막힌 이유를 고치는 것이 항상 더 짧다.

## 4. 변형

- **`--unattended`(무인)**: AskUserQuestion 을 부르지 않고 권장안을 택한다(결정·승인에 `(unattended)` 표기). 사람 게이트(human DoD·머지)에 닿으면 멈추고 보고. 커밋은 `node "<P>/scripts/safe-commit.mjs" -m "<메시지>" [--push]` — 훅과 같은 판정을 스크립트가 하고 통과할 때만 커밋한다(훅이 발화하지 않는 헤드리스 경로에서도 같은 규율).
- **Workflow 툴이 없는 세션**: `workflows/*.js` 의 레인을 `Agent` 로 순차 실행한다(같은 프롬프트, 결과는 JSON 텍스트로 받아 직접 파싱). 모델 티어는 파일 안 `model` 값 그대로.
- **다중 키** `ABC-696,ABC-940`: 브랜치 `feat/ABC-696-940` 하나, dev-guide 한 장, 상태 JSON 하나. Jira 콜은 키마다.
- **worktree**: 어느 worktree 에서 실행해도 상태·로그는 메인 저장소의 runtime 에 쓰인다 — 같은 브랜치의 게이트 기록을 worktree 와 메인이 공유한다.
- `harness.json` 의 게이트 명령이 틀렸으면 이 스킬에서 고치지 않는다 — `/jira-harness:setup` 의 일이다.

## 5. 멈출 때마다 보고 (5줄 이내)

`stage` · 방금 한 것 · 훅/게이트/리뷰 결과 코드와 분모(테스트 N건, blocker N건) · 다음 한 수 · 사용자 결정이 필요한지.
