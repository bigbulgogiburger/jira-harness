---
name: setup
description: >-
  프로젝트에 jira-harness v3 를 설치·점검·업그레이드하는 스킬 — 스택 자동 감지 →
  harness.json 작성(멱등) → 마켓플레이스/플러그인 등록 → 전제 체크리스트 →
  위반 주입 4종으로 게이트가 실제로 작동하는지 실측 확인까지 한 번에 진행한다.
  사용자가 "하네스 설치", "하네스 설정", "하네스 셋업", "이 프로젝트에 jira-harness
  붙여줘", "게이트 설정해줘", "harness.json 만들어줘", "v2 에서 올려줘", "업그레이드
  해줘", "harness 점검", "harness check" 라고 하면 **반드시** 이 스킬을 쓴다.
  `.claude/harness.json` 이 없어 `/jira-harness:issue` 가 `NO_HARNESS` 를 보고할
  때도 이 스킬로 보낸다.
---

# /jira-harness:setup — 설치·점검·업그레이드

`<P>` = 플러그인 루트 절대 경로. 이 스킬이 로드될 때 표시되는 `Base directory for this skill` 의 **두 단계 위**다(`skills/setup` 의 부모의 부모). 아래 모든 명령의 `<P>` 를 그 경로로 치환하고, 프로젝트 루트에서 실행한다.

## 0. 원칙

- **이 스킬은 판단(인터뷰·승인 확인·보고)만 한다.** harness.json·settings.json·.gitignore 쓰기는 전부 `scripts/setup.mjs` 가 한다 — issue 스킬과 같은 원칙이다.
- 코드·설정 파일로 알 수 있는 값은 절대 묻지 않는다. 인터뷰는 `detect` 가 못 정한 값만.
- 위반 주입에서 하나라도 실패하면 "게이트가 심겨 있다"와 "게이트가 작동한다"는 다른 말이라고 보고한다 — 존재 ≠ 실효.

## Usage

`/jira-harness:setup [--upgrade] [--mode auto|suggest|off]`

- 인자 없음: 신규 설치 또는 기존 설정의 멱등 점검
- `--upgrade`: v2 잔재 감지·이관(§6)으로 바로 진입
- `--mode`: `harness.json.mode` 초기값을 미리 지정(생략 시 인터뷰에서 묻고, 권장안은 `auto`)

## 1. detect — 스택 자동 감지

```bash
node "<P>/scripts/setup.mjs" detect --cwd <프로젝트 루트> --json
```

- `stacks`: build.gradle(kts)·package.json·pyproject.toml 등으로 판별한 스택별 {dir, 명령 후보}
- `suggested`: 그대로 쓸 초안 — `issue_prefix` 는 브랜치·커밋 로그에서 추정, 나머지는 스키마 기본값
- `unknown[]`: 코드로 못 정한 값 이름 배열 — **이 목록만** 인터뷰한다
- `existing`: 기존 harness.json 이 있으면 그 내용(diff 비교용)

`unknown[]` 에 있는 값만 AskUserQuestion 으로 **한 번에 하나씩** 확정한다:

| 값 | 언제 묻나 |
|----|----------|
| `issue_prefix` | Jira 프로젝트 키를 코드에서 못 찾았을 때(예시는 ABC 꼴로만 제시) |
| `branch_pattern` / `branch_template` | 브랜치 이름 관례가 감지 안 될 때 |
| `default_branch` | `origin/HEAD` 로 못 정했을 때 |
| 스택별 게이트 명령 보정 | [references/stack-defaults.md](references/stack-defaults.md) 의 흔한 함정을 후보로 제시 |
| `dispatch` | 프로젝트 `agents/` 가 있으면 그 이름을, 없으면 `jira-harness:*` 제네릭 기본값을 제안하고 그대로 쓸지 확인 |

## 2. write — 멱등 쓰기

인터뷰 답 + `suggested` 를 합쳐:

```bash
node "<P>/scripts/setup.mjs" write --config <json 파일|-> [--marketplace <name>] [--plugin <name>] [--repo owner/repo] --json
```

- `existing` 이 있었으면 먼저 diff 를 보여주고 승인 받은 뒤 `--force` 로 재호출한다(승인 없이 덮어쓰지 않는다)
- 이 한 호출이 `.claude/settings.json` 의 `extraKnownMarketplaces`/`enabledPlugins` 병합과 `.gitignore` 항목(런타임·env_file)까지 함께 처리한다 — 다른 파일을 손으로 건드리지 않는다

## 3. check — 전제 체크리스트

```bash
node "<P>/scripts/setup.mjs" check --json
```

항목별 `{id, ok, detail, failClosedStage}` — node·git·Git Bash(win32)·codex CLI·harness.json 스키마 유효성·`gate.mjs --commit --dry-run`·`gate.mjs --full --dry-run`. **`ok:false` 여도 설치를 막지 않는다** — 그 항목이 물고 있는 단계를 "fail-closed" 로 그대로 보고한다(예: codex CLI 없음 → verify 단계는 codex 를 건너뛰고 sonnet 폴백만 뜬다는 사실을 미리 알린다).

## 4. inject — 위반 주입 4종

```bash
node "<P>/scripts/setup.mjs" inject --json
```

`{cases[{case, expected, got, ok}]}`. **한 케이스라도 `ok:false` 면 설치 실패로 보고한다.** 4종의 정의·기대 출력은 [references/injection.md](references/injection.md).

## 5. 헤드리스 실효 확인

[references/injection.md](references/injection.md) 의 헤드리스 절차 그대로 실행한다: 프로젝트 안 이슈 브랜치에서 `claude -p` 로 커밋을 시도시켜 훅이 실제로 발화하는지 실측한다. **발화하지 않으면 harness.json 은 그대로 두고**, 설치 보고에 "훅 미발화 경로 — 무인 작업은 `safe-commit.mjs` 사용" 을 적는다. 실행하지 못했으면 결과를 "미확인" 으로 남긴다 — 지어내지 않는다.

## 6. --upgrade — v2 이관

1. `node "<P>/scripts/setup.mjs" upgrade --json`(dry-run) → `{found, moved, removedHooks, warnings}` 를 그대로 보여준다
2. 승인 후 `--apply` 로 재호출 — v2 훅 3종·`HARNESS_MODE`·`runtime/{sprint-contract,workflow-state*.json,aggregate-verdict*.md,changed-files.txt}`·`phases/`·`scripts/*-execute.py` 가 `runtime/archive/v2/` 로 옮겨진다(삭제 아님)
3. 사용자 스코프 v2 스킬(`harness-*`, `jira-plan`/`complete`/`execute`/`compile`/`ingest`, `wiki-lint`, `llm-wiki` 등 v3 가 대체하는 것)은 **목록만 보이고 이동은 사용자가 결정**한다 — 스킬은 사용자 파일을 지우지 않는다
4. 프로젝트 CLAUDE.md 의 Harness 절과 연동 문서를 v3 표기로 갱신하도록 **안내**한다(편집은 사용자 승인 후 직접). 매핑표는 [references/upgrade.md](references/upgrade.md)

## 7. 설치 보고 (1화면)

스택 · 모드 · 게이트 명령 · 체크리스트(§3) · 주입 결과(§4) · 헤드리스 확인 결과(§5) · 다음 명령(`/jira-harness:issue <KEY>`) 을 한 화면에 정리한다.

## References

- [references/stack-defaults.md](references/stack-defaults.md) — 스택별 기본 게이트 명령 + 흔한 보정
- [references/injection.md](references/injection.md) — 위반 주입 4종 + 헤드리스/worktree 확인 절차
- [references/upgrade.md](references/upgrade.md) — v2 → v3 매핑표

## Notes

- harness.json 에 절대 경로·자격증명을 쓰지 않는다 — 머신별 값은 `stacks.<name>.env_file` 이 가리키는 gitignore 파일로.
- 마켓플레이스·플러그인 이름·저장소는 사용자가 명시하지 않으면 묻는다 — 추측해 등록하지 않는다.
- `harness.json` 의 게이트 명령이 실제로 실패하면(스택 오탐 등) 이 스킬로 돌아와 `detect`→`write` 를 다시 돈다 — `/jira-harness:issue` 는 그 값을 고치지 않는다.
