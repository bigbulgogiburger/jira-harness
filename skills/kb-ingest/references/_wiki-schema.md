# `_wiki-schema.md` — wiki bookkeeping 공통 SSoT

> **단일 출처 (single source of truth)** — issue 스킬의 wiki 단계(`scripts/wiki-row.mjs`)와 `wiki-lint`(`scripts/wiki-lint.mjs`)가 본 문서를 참조한다.
> 본 문서를 수정하면 즉시 양쪽의 동작이 바뀐다.

## 1. Karpathy LLM Wiki 패턴 — 우리 적용 요약

핵심 통찰: **RAG 처럼 매번 재발견하지 말고, LLM 이 점진적으로 영구 wiki 를 만들고 유지한다.** synthesis 는 query-time 이 아니라 build-time 에 누적.

3-layer 아키텍처:

| Layer | 소유 | 내용 |
|-------|------|------|
| Raw Sources | 사용자 (immutable) | 원문 — Jira 이슈, git 히스토리, 회의록, 외부 문서 (로컬 복제 안 함 — 원본 시스템이 SSoT) |
| Wiki | LLM (관리 + write) | **synthesis**: `docs/wiki/<domain>.md` (§ 16 — 업무 도메인별 현재-상태 종합) / **catalog**: `docs/INDEX.md`, `docs/LOG.md` / **단면**: `docs/<KEY>-dev-guide.md` |
| Schema | 사용자 (git tracked) | `docs/INDEX-SCHEMA.md` — 카테고리·정책·synthesis 도메인 |

### 우리의 의도적 분기 (Karpathy vs 우리)
- "single source touches 10~15 pages" → 우리는 **catalog 1~5 + synthesis 1~3 pages bounded** (PR review + git blame 보존 필요)
- ingest 워크플로 자유형 → 우리는 **forecast + closure 2-phase** 강제 (abandon 검출)
- frontmatter 강제 → 신규 dev-guide 만, 기존은 best-effort 파싱
- raw sources 로컬 보관 → **안 함** — 원문은 Jira·git·Mattermost 가 이미 영구 보존, 로컬 복제는 SSoT 이중화

> ⚠ **catalog 는 synthesis 의 대체재가 아니다** (실측 교훈): synthesis 층 없이 INDEX/LOG 만 운영하면 세션의 배움이 INDEX 요약 셀·LOG note 로 흘러들어 카탈로그가 세션 서사로 비대해지고 (실제 운영에서는 요약 셀 300자 상한 규율까지 필요했다), "이 업무의 현재 규칙 전부"는 여전히 여러 문서를 시간순 재구성해야만 답할 수 있다 — Karpathy 가 비판한 query-time 재발견 그대로. 지식의 정식 자리는 § 16 synthesis 층이다.

## 2. INDEX-SCHEMA.md — 프로젝트별 schema

프로젝트의 `docs/INDEX-SCHEMA.md` 가 카테고리·정책 정의. **처음 실행 시 부재 가능** — 그 때는 issue 스킬의 wiki 단계(scripts/wiki-row.mjs)가 default schema 를 제안.

### Default schema (신규 프로젝트 부트스트랩용)

```yaml
version: 1
project: <auto-detected-from-CLAUDE.md-or-package-name>

categories:
  - id: foundational
    label: 기반 (PRD/DB/Domain)
    match:
      pattern: "^[0-9]{2}-.*\\.md$"
    columns: [num, file, summary, owner, updated]

  - id: decisions
    label: 의사결정 (ADR)
    match:
      explicit: ["08-decision-log.md"]
    columns: [file, adr_count, updated]

  - id: issue_guides
    label: 이슈 가이드
    match:
      pattern: "^<ISSUE_PREFIX>-\\d+(?:[+:](?:<ISSUE_PREFIX>-)?\\d+)*-dev-guide\\.md$"
    columns: [issue, status, title, week, parent, siblings, adrs, persona, updated]

  - id: sprint
    label: 스프린트
    match:
      pattern: "^sprint/.*\\.md$"

  - id: setup
    label: 셋업/운영
    match:
      pattern: "^(setup|ops|qa|external|data)/.*\\.md$"

  - id: wiki
    label: 위키 (도메인 현재-상태 종합)
    match:
      pattern: "^wiki/.*\\.md$"
    columns: [file, domain, summary, updated]

synthesis:                       # § 16 — 부재 시 synthesis 단계 전체 skip (catalog-only 운영)
  dir: "wiki/"
  domains: []                    # § 17 Wiki Bootstrap 에서 사용자와 확정 — 빈 배열 = bootstrap 미실행
  max_pages_per_closure: 3

cross_refs:
  adr_pattern: "\\bADR-\\d+\\b"
  issue_pattern: "\\b<ISSUE_PREFIX>-\\d+\\b"   # 예: ABC- / PROJ- / WEB-

closure_signals:
  jira_qa_transition: true
  archive_dir_exists: ".claude/runtime/archive/<ISSUE>"

bounded_writes:
  always:
    - "docs/INDEX.md"
    - "docs/LOG.md"
  conditional:
    - path: "docs/08-decision-log.md"
      write_when:
        - mode: "closure"
        - dev_guide.related_adrs: not_empty
      action: "upsert ingest-managed block per ADR section"
    - path: "docs/sprint/weeks/w*.md"
      write_when:
        - mode: "closure"
        - dev_guide.week: present
        - issue_not_in_file: true
      action: "append closure line to ingest-managed block"
    - path: "docs/sprint/tracks/*.md"
      write_when:
        - mode: "closure"
        - dev_guide.track: present
        - issue_not_in_file: true
      action: "append closure line"
    - path: "docs/wiki/*.md"
      write_when:
        - mode: "closure | kb | bootstrap-wiki"
        - schema.synthesis: present
      action: "merge current-state knowledge per § 16 rules (max_pages_per_closure bound)"
  forbidden:
    - "docs/01-prd*.md"
    - "docs/02-db-schema.md"
    - "CLAUDE.md"
    - "CHANGELOG.md"
    - "**/*.java"
    - "**/*.vue"
    - "**/*.ts"
    - "**/*.js"
    - "**/*.py"

stale_thresholds:
  planned_days: 7
  last_activity_days: 14

claude_md_integration:
  mode: auto-patch          # announce | auto-patch | skip
  target_section: "Planning Docs"
  block_template: |
    | Wiki Index  | 작업 착수 시 관련 이슈·ADR cross-ref 조회 | docs/INDEX.md         |
    | Wiki Log    | ingest 이벤트 로그 (append-only)          | docs/LOG.md           |
    | Wiki Schema | wiki 카테고리·정책 (사용자 편집)          | docs/INDEX-SCHEMA.md  |
```

ISSUE_PREFIX 는 첫 호출 시 프로젝트의 Jira 이슈 키 prefix 로부터 추론 (예: `ABC`, `PROJ`, `WEB`) — `.claude/harness.json` 에 `issue_prefix` 가 있으면 그 값을 우선한다.

## 3. dev-guide YAML frontmatter 표준

신규 dev-guide 는 다음 frontmatter 권장 (plan 단계 — `/jira-harness:issue` 가 자동 삽입):

```yaml
---
issue: ABC-247
title: W5 QA 라우트 가드 권한 침투 spec
type: single                # single | composite | slice
status: planned             # planned | closed | abandoned
week: W5
track: QA
parent: ABC-206             # null if single
siblings: [ABC-245, ABC-246]
related_adrs: [ADR-021, ADR-058, ADR-060]
persona: Vue.js Specialist
created: 2026-05-14
closed: null
---
```

기존 dev-guide 는 비공식 quoted header (`> 부모:`, `> 자매:`, ...) 도 best-effort 파싱.

## 4. dev-guide 파싱 — 6단계 fallback chain

각 단계 순차 시도, 누락 항목은 null:

```
1. YAML frontmatter      ^---\n...\n---\n         → 전체 메타 (있으면 끝)
2. Quoted header lines   ^> 키: 값                → created/stack/persona/parent/siblings/mode
   - r"^> 생성일: (\d{4}-\d{2}-\d{2})"
   - r"^> 스택: (.+)"
   - r"^> 페르소나: \*\*(.+?)\*\*"
   - r"^> 부모: (<ISSUE>-\d+)"
   - r"^> 자매: ((?:<ISSUE>-\d+(?:, )?)+)"
3. Title line            ^# \[(<ISSUE>-\d+(?:-<ISSUE>-\d+)?)\] \[(W\d+)\]\[(\w+)\] (.+?) —
                         → issue, week, track, title
4. Body scan             \bADR-\d+\b → related_adrs (uniq)
                         \b<ISSUE>-\d+\b → mentioned_issues (uniq, parent/siblings 제외)
5. File name             <ISSUE>-(\d+)(?:-<ISSUE>-(\d+))?-dev-guide\.md
                         → issue_key (1~4 모두 실패 시)
6. Git log 보완          git log --diff-filter=A --reverse --format=%cI -- <file> → created
                         git log -1 --format=%cI -- <file> → last_activity
```

## 5. Unique Key — 3 종 dev-guide 구분

| Type | 패턴 | Key 형식 | 예 |
|------|------|---------|-----|
| single | `ABC-247-dev-guide.md` | `ABC-247` | 단일 이슈 |
| composite | `ABC-10-ABC-81-dev-guide.md` | `ABC-10+ABC-81` | 통합 (cross-track) |
| slice | `ABC-194-68-dev-guide.md` | `ABC-194::ABC-68` | 부모 + 슬라이스 (--subtasks) |

**Bootstrap 휴리스틱** (frontmatter 부재 시):
1. `ABC-<N>-dev-guide.md` 가 같은 디렉토리에 존재 → 두 번째 숫자는 slice
2. 둘 다 단독 dev-guide 존재 → composite
3. 그 외 → composite 가정 + bootstrap 결과 표에 ⚠️ 표시 → 사용자 confirm

신규 dev-guide 는 frontmatter `type:` 필드 강제 — bootstrap 한 번만 휴리스틱 의존.

## 6. LOG.md 형식 — grep-first

```
[YYYY-MM-DD HH:MM KST  <MODE>     <KEY>          <phase>] key=value key=value...
[2026-05-14 14:32 KST  INGEST     ABC-247        forecast] guide=docs/ABC-247-dev-guide.md parent=ABC-206 adrs=ADR-021,058,060
[2026-05-14 18:45 KST  CLOSURE    ABC-247        ] verdict=PASS commit=6c0072b touched=3 qa=2026-05-14
[2026-05-14 18:45 KST  INGEST     ABC-247        closure] index_row=updated touched=[INDEX.md,LOG.md,sprint/weeks/w5-w8.md]
[2026-05-13 17:20 KST  INGEST     ABC-246        forecast] guide=docs/ABC-246-dev-guide.md parent=ABC-200 adrs=ADR-029
[2026-05-12 09:00 KST  BOOTSTRAP  -              ] parsed=94 categories=5 warnings=2
[2026-05-15 10:00 KST  LINT       -              ] mode=summary score=92 errors=2 warnings=7
```

MODE 종류: `INGEST` / `CLOSURE` / `BOOTSTRAP` / `BOOTSTRAP-WIKI` / `LINT` / `REFRESH` / `REBUILD-XREFS`.

synthesis 활성 프로젝트의 closure/kb 라인은 `wiki=` 필드로 통합 페이지를 기록 (L16 lint 의 검사 축):

```
[2026-08-31 15:02 KST  INGEST     ABC-127        closure] index_row=updated wiki=billing,notifications touched=[...]
[2026-08-31 16:10 KST  INGEST     meeting/2026-01-15-kickoff  kb] wiki=billing,onboarding index_row=created
```

KEY 없는 kb 소스는 KEY 자리에 소스 경로 slug (phase 자리에 `kb`).

`grep ABC-247 docs/LOG.md` → 단일 이슈의 전체 타임라인. append-only, 절대 read 하지 않음 (lint 만 스캔).

## 7. INDEX.md 형식

전체 표가 ingest-managed 블록 안에 위치. 사람이 손대지 않음.

```markdown
# <Project> — 문서 인덱스 (LLM-maintained)

> 자동 갱신: `/jira-harness:issue` 의 wiki 단계 호출 시. 마지막 갱신: 2026-05-14 14:32 KST.
> 카테고리/정책: `INDEX-SCHEMA.md`. lint 보고서: `wiki-lint` 호출.

<!-- ingest-managed:begin file=INDEX.md -->

## 기반 (PRD/DB/Domain)

| # | 파일 | 한줄 요약 | 갱신 |
|---|------|----------|------|
| 00 | `00-baseline.md` | 최종 기준선 | 2026-04-29 |
| 01 | `01-prd.md` | PRD v1.2 단일 본문 | 2026-05-04 |

## 의사결정 (ADR)
| 파일 | ADR 수 | 갱신 |
|------|--------|------|
| `08-decision-log.md` | 70 | 2026-05-13 |

## 이슈 가이드
| Issue | Status | Title | Week | Parent | ADRs | Siblings | Updated |
|-------|--------|-------|------|--------|------|----------|---------|
| ABC-247 | closed | W5 QA 라우트 가드 권한 침투 spec | W5 | ABC-206 | ADR-021,058,060 | ABC-245,246 | 2026-05-14 |
| ABC-246 | closed | W5.1+ 사이드바 collapse persistence | W5 | ABC-200 | ADR-029 | ABC-247 | 2026-05-13 |

<!-- ingest-managed:end file=INDEX.md -->
```

정렬: 카테고리별 — 이슈 가이드는 week 역순 + issue key 내림차순. 빈 cell = `-`.

## 8. ingest-managed Block Sentinel

자동 갱신과 사용자 수정의 충돌을 마커로 격리. ADR 본문 / sprint week / INDEX 모두 동일 패턴.

```markdown
## ADR-070 — 캐시 무효화 정책
... 본문 (절대 wiki 단계가 손대지 않음) ...

<!-- ingest-managed:begin adr=ADR-070 -->
### Referenced by (issue 스킬의 wiki 단계가 자동 관리 — scripts/wiki-row.mjs)
- [ABC-247](../ABC-247-dev-guide.md) — W5 QA 라우트 가드 (2026-05-14 closed)
- [ABC-246](../ABC-246-dev-guide.md) — W5.1+ 사이드바 (2026-05-13 closed)
<!-- ingest-managed:end adr=ADR-070 -->
```

**규칙**:
- wiki 단계(scripts/wiki-row.mjs)는 `<!-- ingest-managed:begin ... -->` ~ `:end` **사이만** rewrite
- 마커 부재 시 섹션 끝에 자동 추가
- 사용자가 마커 안 수정해도 다음 ingest 가 덮어씀 (의도)
- **본문 100% safe** — git blame 보존

## 9. 상태 머신 — 3-state (단순화)

```
INDEX.status ∈ {planned, closed, abandoned}
```

| 전이 | 트리거 |
|------|--------|
| `(none) → planned` | wiki 단계 forecast (plan 단계 직후) |
| `planned → closed` | wiki 단계 closure (complete 단계 직전) |
| `* → abandoned` | 사용자 수동 / wiki-lint --fix L03 권고 수락 시 |

> **implementing 상태는 의도적으로 없음**. 구현 중 활동은 LOG 의 `last_activity` 로 추적. wiki-lint stale 검사가 `last_activity > 7d AND status=planned` 기반 → 자연스럽게 stale 회피.

## 10. Bounded Writes 정책

bounded_writes 는 INDEX-SCHEMA.md 의 `bounded_writes` 섹션 (§ 2 default 참조). 3 카테고리:

- **always**: INDEX.md, LOG.md — ingest 호출 시 항상 갱신
- **conditional**: ADR / sprint week·track — 조건 만족 시만 (mode + dev_guide 필드 + 중복 검사)
- **forbidden**: PRD / DB schema / 코드 파일 — **자동 갱신 절대 금지**. wiki-lint L13 (v2) 이 위반 검출 예정

PR diff 가 항상 5 파일 이내 보장.

## 11. Wiki Lint Rules — 14 종 (L13 은 v2 로 미룸)

| ID | 카테고리 | 검사 | Severity | Auto-fix |
|----|---------|------|----------|----------|
| L01 | Orphan | dev-guide 파일 있는데 INDEX 에 없음 | high | ✅ |
| L02 | Orphan | INDEX 에 있는데 dev-guide 파일 부재 | high | ⚠️ (수동) |
| L03 | Stale | `status=planned` + `last_activity > 7d` | medium | × |
| L04 | Stale | (안 씀 — L03 으로 통합, implementing 상태 제거 영향) | — | — |
| L05 | Xref | dev-guide 의 ADR-N 이 08-decision-log.md 에 없음 | high | × (Levenshtein 후보 제안) |
| L06 | Xref | dev-guide 의 ABC-M 가 INDEX 에 없음 | medium | × |
| L07 | Xref | parent/siblings 양방향 비대칭 | medium | ✅ |
| L08 | Frontmatter | 신규 dev-guide (생성일 ≥ schema.frontmatter_required_since) 에 YAML frontmatter 없음 | low | ✅ (best-effort 변환) |
| L09 | Conflict | 같은 ADR-N 을 두 dev-guide 가 모순되게 인용 (heuristic) | high | × |
| L10 | Memory drift | MEMORY.md 인용 파일/클래스 부재 | high | × |
| L11 | INDEX integrity | 표 정렬 깨짐 / 중복 row / 빈 cell / 마커 손상 | low | ✅ |
| L12 | LOG integrity | LOG 라인 형식 일탈 | low | × |
| L13 | Policy | forbidden 파일이 ingest 호출 PR 에서 수정 (git log) | high | × | (**v2 — 첫 릴리스 제외**) |
| L14 | Closure | Jira 상태 = QA/Done 인데 INDEX status = planned | medium | ✅ (Jira 진실로) |
| L15 | Coverage | sprint week 가 그 week 의 closed issue 인용 안 함 | low | ✅ |
| L16 | Synthesis | (synthesis 활성 시만) closure/kb LOG 라인에 `wiki=` 부재, `wiki=` 명시 페이지가 그 시점 이후 미갱신, wiki/ 파일이 INDEX wiki 카테고리에 없음, schema.synthesis.domains 에 없는 페이지 존재 | medium | × |
| L17 | Synthesis xref | (synthesis 활성 시만) wiki 페이지의 출처 (ADR-N / ISSUE-N / meeting 경로) 가 실재하지 않음, 규칙 문장에 출처 표기 자체가 없음 (§ 16-3 원칙 2 위반) | high | × |

`--fix` 는 ✅ 표시된 것만. 나머지는 보고 + 권고. L16/L17 은 `schema.synthesis` 부재 프로젝트에서 자동 skip (위반 0 이 아니라 검사 제외 — 보고서에 "synthesis 미설정" 명시).

## 12. 첫 실행 (First-run) 시나리오

스킬이 호출됐는데 wiki 자산이 없는 경우 — 단계적 onboarding:

| 상태 | 행동 |
|------|------|
| `docs/` 디렉토리 부재 | 사용자에게 "docs/ 디렉토리 만들까요?" 확인. 거부 시 종료 (다른 경로 안내) |
| `docs/INDEX-SCHEMA.md` 부재 | § 2 default schema 를 보여주고 "이걸로 `docs/INDEX-SCHEMA.md` 생성할까요?" 확인. 프로젝트 ISSUE_PREFIX 추론 (`.claude/harness.json` / CLAUDE.md / Jira API 시도) |
| `docs/INDEX.md` 부재 | bootstrap 권고 — "기존 dev-guide N개 발견. 카탈로그화할까요?" 확인 후 5+1 Pass |
| `docs/LOG.md` 부재 | bootstrap 시 자동 생성 (git log 백필) |
| `CLAUDE.md` 에 wiki 자산 row 부재 | § 15 의 `claude_md_integration` 정책 적용 (default `auto-patch`, 첫 1회 승인) — bootstrap / onboarding 종료 직후 1회만 |
| 정상 (모두 존재) | 호출자 의도 추론 후 진행 |

## 13. 호출자 의도 추론 — 자연어 우선, `--subtasks` 만 명시

플래그 explosion 회피. 사용자가 자연어로 의도 전달하면 LLM 이 추론:

| 사용자 입력 | 추론 모드 |
|------------|----------|
| "ABC-247 등록해줘" + dev-guide 존재 + Jira Open | forecast |
| "ABC-247 closure 처리" / "마감처리" | closure |
| "wiki 처음 설정" / "INDEX 만들어줘" + INDEX 부재 | bootstrap |
| "ABC-247 다시 갱신" / "refresh" | refresh (특정 issue 재계산) |
| "INDEX 누락분 채워줘" | backfill |
| "cross-ref 다시 만들어줘" | rebuild-cross-refs |
| "이 회의록/클라 회신/세션 기록 ingest" (KEY 없는 소스) | → **kb-ingest 스킬** 영역 (issue 스킬의 wiki 단계가 받았으면 kb-ingest 로 안내) |
| "전체 문서를 wiki 로 ingest" / "wiki 구조 만들어줘" / synthesis 설정 있는데 `wiki/` 부재 | bootstrap-wiki (§ 17) |

`/jira-harness:issue` 라우터가 wiki 단계를 호출할 때는 forecast/closure 모드를 넘긴다 (예: wiki 단계(`scripts/wiki-row.mjs`)를 "ABC-247 forecast 모드"로 실행).

**유일한 명시 플래그**: `--subtasks` — `_subtasks-convention.md` 와 일관성. 자연어로는 부모/슬라이스 mechanical 처리 모호.

## 14. 책임 분리

| 책임 | 담당 |
|------|------|
| Catalog write (INDEX/LOG/cross-ref) — KEY 있는 소스 | issue 스킬의 wiki 단계(scripts/wiki-row.mjs) |
| Synthesis write (`wiki/`) — KEY 있는 소스 (closure) + bootstrap-wiki | issue 스킬의 wiki 단계(scripts/wiki-row.mjs) (§ 16·17) |
| Synthesis + catalog write — KEY 없는 소스 (회의록·클라 회신·세션 기록) | **kb-ingest** |
| Wiki verify (orphan/stale/drift/synthesis 정합) | wiki-lint |
| Closure 단언 신뢰 | complete 단계 호출 = 신뢰. 검증은 wiki-lint L14 가 사후 |
| Schema 관리 | 사용자 (git tracked) |
| Skill SSoT | 본 문서 (`_wiki-schema.md`) |

issue 스킬의 wiki 단계(scripts/wiki-row.mjs) / kb-ingest / wiki-lint 는 본 문서의 정책만 따른다 → 한 곳 수정으로 셋의 동작이 동시에 바뀐다. kb-ingest 와 wiki 단계의 경계는 **소스에 이슈 KEY 가 있느냐** 하나 — synthesis 통합 규약(§ 16)은 완전히 공유한다.

## 15. CLAUDE.md Integration — wiki 자산 가시화

bootstrap / onboarding 직후 CLAUDE.md 에 wiki 자산 안내가 없으면 **미래 LLM 세션이 INDEX.md / LOG.md 의 존재를 모름** — dev-guide 작업 중에도 wiki 활용 안 함. INDEX-SCHEMA.md 의 `claude_md_integration.mode` 로 격리:

| mode | 동작 |
|------|------|
| `auto-patch` (default) | 사용자 승인 후 Edit 툴로 CLAUDE.md 의 `target_section` 표 끝에 row 추가. |
| `announce` | 보강 블록 templated text 만 출력. 사용자가 수동 복붙. **CLAUDE.md 무수정**. |
| `skip` | 안내 자체 생략. |

**왜 default 가 `auto-patch` 인가?**
- 핵심 목적: wiki 를 build-time 에 쌓아도 **CLAUDE.md 가 가리키지 않으면 미래 LLM 세션이 안 읽음**. 활성화 직후 자동 가시화가 wiki 의 존재 이유.
- auto-patch 는 무단 수정이 아님 — **첫 패치 1회 사용자 승인** 후 Edit. 승인 게이트가 PR 노이즈 / git blame 오염 우려를 통제.
- announce 의 trade-off (사람 친화 문서, 수동 commit 으로 author 명확) 는 여전히 유효 → 자동 갱신을 원치 않는 프로젝트는 schema 에서 `announce` / `skip` 으로 격리.

**호출 타이밍** (3 회만):
- § 1 First-run Onboarding 종료 직후
- § 2 Bootstrap 종료 직후
- 사용자가 명시적으로 "CLAUDE.md 에 wiki 안내 추가해줘" 요청 시

**일반 ingest (forecast / closure) 에서는 절대 호출 안 함** — 의도된 침묵.

**탐지 휴리스틱** (보강 필요 여부):
```
CLAUDE.md grep "docs/INDEX.md"
  매칭 있음 → 이미 안내됨, 생략
  매칭 없음 → 보강 블록 출력 / auto-patch
```

**block_template** 은 schema 의 `claude_md_integration.block_template` 사용. 프로젝트별로 컬럼 형식 조정 가능 (헤더 추가, 영문/한글 등).

## 16. Synthesis Layer — `wiki/` 도메인 페이지

> **왜 필요한가**: catalog(INDEX/LOG)만으로는 "이 업무가 지금 어떤 규칙으로 돌아가나"를 어디서도 답할 수 없다. 지식이 dev-guide(이슈 단면)·ADR(결정 원문)·CHANGELOG(세션 서사)에 **시간순으로** 흩어져 있어, 질문마다 여러 문서를 시간순 재구성해야 한다. synthesis 층은 그 재구성을 ingest 시점(build-time)에 1회 수행해 **업무 도메인별 현재-상태 종합**으로 고정한다. reference 문서(`.claude/docs/reference/`)와의 경계: reference 는 "코드를 어떻게 만지나"(코드베이스 관점), wiki 는 "업무가 어떤 규칙로 돌아가나"(도메인 관점) — 같은 사실이 양쪽에 다른 관점으로 실릴 수 있고 그건 중복이 아니다.

**활성 조건**: 프로젝트 `INDEX-SCHEMA.md` 에 `synthesis:` 키 존재. 부재 시 wiki 단계(scripts/wiki-row.mjs)·kb-ingest 는 synthesis 단계를 통째로 건너뛰고 (catalog-only), wiki-lint 는 L16/L17 을 검사 제외한다. 기존 catalog-only 프로젝트 무영향.

### 16-1. 페이지 단위와 위치

- `docs/wiki/<domain>.md` — **업무 도메인당 1페이지**. 축은 업무(결제·알림·온보딩 …)이지 화면·이슈·주차가 아니다.
- 도메인 목록은 schema `synthesis.domains` 가 SSoT — § 17 bootstrap 에서 사용자와 확정. 이후 신설은 ingest 중 "어느 도메인에도 안 맞음" 판정 + 사용자 승인으로만.
- closure/kb 1회가 만지는 페이지는 `synthesis.max_pages_per_closure` (default 3) 이내 — diff 검토 가능성 보존.

### 16-2. 페이지 템플릿

```markdown
---
domain: billing
title: 결제
updated: 2026-01-20
scope: ["결제", "billing", "payment_method", "환불"]   # 도메인 판정 힌트 (키워드·경로 조각)
sources: [ADR-12, ABC-114, ABC-127, meeting/2026-01-15-kickoff]
---

# 결제 (Billing)

> 한 줄 정의 — 이 도메인이 무엇인가.

## 현재 규칙
업무 규칙의 as-is 서술. 모든 문장에 출처. (예: 결제 재시도는 최대 3회로 제한된다 — 4회째부터는 수동 처리로 전환한다 (ABC-114))

## 경계·계약
FE↔BE·외부 시스템과 맞닿는 seam — 엔드포인트, @RequestPart 파트명, enum 폭, 헤더 규약 등 "양쪽이 함께 맞아야 성립하는" 계약.

## ⚠ 함정
실사고·실측에서 나온 함정. 규칙이 반전돼도 함정은 지식으로 보존.

## 미해결
열린 질문·클라 회신 대기·보류. 아는 척 서술하지 않고 질문으로 남긴다.

## 이력 참조
주요 반전만 링크로 (ADR-NNN ← ADR-MMM 반전). 서사는 CHANGELOG/LOG 가 SSoT — 여기 재서술 금지.
```

### 16-3. 서술 규약 — 5원칙

1. **as-is only**: 항상 "현재 유효한 규칙"만. 시간순 append 금지 — 새 결정이 오면 옛 서술을 **교체**한다. 페이지는 읽는 순간의 진실이어야 하고, 이력은 출처 링크(ADR·CHANGELOG)가 담당한다.
2. **출처 결박**: 모든 규칙 문장에 출처 — `(ADR-NNN)` / `(ABC-NNN)` / `(meeting <경로|날짜>)` / `(V<마이그>)`. 출처 없는 규칙 서술은 L17 위반. 출처가 있어야 "이 서술이 낡았나"를 나중에 판정할 수 있다.
3. **반전 처리**: 반전되면 옛 규칙 서술은 삭제, 새 규칙에 `(ADR-신 — ADR-구 반전)` 표기. 옛 규칙을 본문에 남기면 미래 세션이 현재 규칙으로 오독한다 (실사고 축).
4. **⚠ 함정 보존**: 함정 섹션은 교체 대상이 아니라 누적 대상 — "왜 이렇게 하면 안 되는가"는 규칙이 바뀌어도 유효한 지식이다.
5. **모름 표기**: 확인 안 된 것은 "미해결"에 질문으로. 추정을 규칙처럼 서술하는 것이 최악의 오염이다.

### 16-4. 도메인 판정 (closure / kb 공통)

1. 소스(dev-guide·회의록·세션 기록)의 제목·본문·터치 파일 경로에서 후보 도메인 추출
2. 각 wiki 페이지 frontmatter `scope:` 힌트와 대조
3. LLM 최종 판정 — 1~max_pages 장. 판정 결과를 LOG 라인 `wiki=` 필드에 기록 (L16 의 검사 축)
4. 어느 도메인에도 안 맞으면 **기존 페이지에 억지로 넣지 않는다** — 사용자에게 "새 도메인 <제안명> 신설?" 확인 (승인 시 schema.domains 에도 추가)

### 16-5. 통합(merge) 절차 — 멱등

1. 대상 페이지 read → 소스 key(ABC-N / meeting 경로)가 이미 frontmatter `sources` 에 있으면 **skip** (재-ingest 안전)
2. 소스에서 4종 추출: 규칙 변화 / 신규·변경 계약 / 함정 / 미해결
3. § 16-3 규약으로 해당 섹션 갱신 — 교체 우선, append 는 함정·미해결만
4. frontmatter `updated`·`sources` 갱신
5. **모순 검출**: 새 소스가 페이지 기존 서술과 충돌하면 자동 교체하지 않는다 — 양쪽 출처를 나란히 제시하고 사용자에게 어느 쪽이 최신 결정인지 확인 (Karpathy "noting where new data contradicts old claims" 의 우리 구현)

## 17. Wiki Bootstrap — 기존 코퍼스 1회 소급 synthesis

**트리거** (wiki 단계 Guard 에서 자동 감지 + 사용자 의도):
- schema 에 `synthesis:` 있는데 `docs/wiki/` 부재 또는 `synthesis.domains` 빈 배열 → "올바른 위키 구조가 아직 없습니다 — 기존 문서 전체를 wiki 로 1회 ingest 할까요?" 제안
- 사용자가 "전체 문서 wiki 로 ingest" / "wiki 구조 만들어줘" 의도 표명

**절차 (5 Pass)**:

| Pass | 내용 |
|------|------|
| W1 도메인 축 도출 | 도메인 모델 문서(05-domain-model 류)·BE 도메인 디렉토리·INDEX 카테고리에서 후보 도출 → **사용자 confirm** → `schema.synthesis.domains` 확정 기입 |
| W2 코퍼스 열거·배정 | INDEX 전 카테고리(dev-guide·ADR·meeting·foundational) + CHANGELOG 를 도메인별 소스 목록으로 배정 (1 소스 N 도메인 가능) |
| W3 페이지 synthesis | 도메인별로 소스를 **최신→과거 순**으로 읽으며 § 16-3 규약으로 종합. 최신 우선 순서가 핵심 — 과거 문서의 반전 전 서술을 현재 규칙으로 오인하는 것을 순서 자체로 방지 (먼저 자리잡은 최신 서술을 과거 소스가 덮지 못함) |
| W4 INDEX/LOG 반영 | INDEX 에 wiki 카테고리 표 생성 + `BOOTSTRAP-WIKI` 라인 append (`domains=<csv> sources=<n> pages=<n>`) |
| W5 lint 체인 | wiki-lint L16/L17 baseline 측정 |

**규모 규율**:
- 코퍼스 100+ 문서면 인라인 강행 금지 — 도메인별 병렬 fan-out(dynamic Workflow 등 병렬 수단) 을 **사용자 승인 후** 사용. 컨텍스트 규율상 별도 세션 권장 — 본 § 는 그 세션이 따를 절차 SSoT.
- 소스는 immutable — bootstrap 이 dev-guide·ADR·CHANGELOG 본문을 수정하는 일은 없다 (쓰기는 `wiki/`·INDEX·LOG·schema.domains 만).
- 중단 재개: W3 는 도메인 단위로 독립 — 완료된 페이지의 frontmatter `sources` 가 진행 상태 그 자체 (별도 checkpoint 불요).
