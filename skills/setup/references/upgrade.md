# v2 → v3 매핑표

`--upgrade` 흐름(SKILL.md §6)이 참조하는 이관 대상 목록이다. **삭제가 아니라 이동** — 사용자가 되돌아볼 수 있게 `runtime/archive/v2/` 에 보존한다.

## 자동 이관(코드가 이동) — `--apply` 시 `setup.mjs` 가 처리

| v2 | v3 |
|----|----|
| `settings.local.json` 의 훅 3종(PreToolUse 개별 등록 등) | 플러그인 훅 1개 — `hooks/hooks.json` → `commit-gate.mjs` |
| 환경변수 `HARNESS_MODE` | `harness.json.mode`(`auto`/`suggest`/`off`) |
| `runtime/sprint-contract*` | `runtime/archive/v2/sprint-contract*` |
| `runtime/workflow-state*.json` | `runtime/archive/v2/workflow-state*.json` |
| `runtime/aggregate-verdict*.md` | `runtime/archive/v2/aggregate-verdict*.md` |
| `runtime/changed-files.txt` | `runtime/archive/v2/changed-files.txt` |
| `phases/`(컴파일된 step 시퀀스) | `runtime/archive/v2/phases/` |
| `scripts/*-execute.py`(러너) | `runtime/archive/v2/scripts-execute-py/` |

## 사용자 판단 대상(목록만 표시, 이동 안 함) — 사용자 스코프 v2 스킬

| v2 스킬 | v3 대응 |
|---------|--------|
| `harness-setup` | 본 스킬(`jira-harness:setup`) |
| `harness-workflow` | `jira-harness:issue` (전 단계를 라우팅) |
| `harness-plan` | `jira-harness:issue` plan 단계(`workflows/plan.js`) |
| `harness-review` | `jira-harness:issue` verify 단계(`workflows/verify.js` + `codex-review.sh`) |
| `harness-gate` | `jira-harness:issue` gate 단계(`scripts/gate.mjs`) |
| `jira-plan` | `jira-harness:issue` plan 단계 |
| `jira-execute` | `jira-harness:issue` implement 단계 |
| `jira-complete` | `jira-harness:issue` complete 단계(`scripts/issue-complete.mjs`) |
| `jira-compile` | v3 미채택 — 대형 이슈의 step 컴파일 개념은 `workflows/*.js` 의 args 로 흡수. 계속 쓰려면 사용자 스코프에 남긴다 |
| `jira-ingest` | `jira-harness:issue` wiki 단계(`scripts/wiki-row.mjs`) 또는 `jira-harness:kb-ingest`(KEY 없는 소스) |
| `wiki-lint` | 스킬이 아니라 `scripts/wiki-lint.mjs` — `issue-complete.mjs` 가 complete 단계에서 직접 호출 |
| `llm-wiki` | `jira-harness:kb-ingest` |

이 표에 없는 v2 스킬(프로젝트 고유로 얹었던 것 등)이 감지되면 `warnings` 에 이름만 나열한다 — 매핑을 추측해 지어내지 않는다.

## 문서 갱신 안내(편집은 사용자 승인 후)

- 프로젝트 `CLAUDE.md` 의 `## Harness Engineering` 절 — v2 훅 개수·모델 티어링 서술을 위 표 기준으로 갱신
- `harness-integration.md` 류 연동 문서 — v2 스크립트 경로가 남아 있으면 위 표의 v3 경로로 교체
- 갱신 문구를 이 스킬이 대신 커밋하지 않는다 — 다음 `/jira-harness:issue` 호출에서 문서 변경이 게이트를 막지 않도록, `docs_only_paths` 커밋으로 별도 처리하는 편이 안전하다
