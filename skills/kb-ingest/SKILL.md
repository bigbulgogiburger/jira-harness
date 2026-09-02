---
name: kb-ingest
description: "kb-ingest — Jira 이슈 KEY 가 없는 소스 (회의록, 클라이언트 회신, Mattermost 스레드, 세션 진단·결정 기록, 외부 문서, 구두 전달 정보) 를 코드 프로젝트의 docs/ 지식 wiki 에 ingest 합니다. 소스를 읽고 핵심을 추출해 docs/wiki/<도메인>.md 현재-상태 종합 페이지에 통합하고, INDEX.md 등재 + LOG.md 기록까지 수행합니다 (issue 스킬의 wiki 단계(scripts/wiki-row.mjs)와 references/_wiki-schema.md SSoT 공유 — 경계는 '소스에 이슈 KEY 가 있느냐' 하나). 사용자가 '이 회의록 ingest 해줘', '클라 회신 wiki 에 반영해줘', '이 문서 wiki 로', '오늘 회의 내용 기록해줘', '이 결정 wiki 에 넣어줘', 'kb ingest', '지식 등록', '세션 기록 wiki 반영' 등을 요청하거나, 회의록·회신·기록 파일을 가리키며 wiki 반영 의도를 보이면 반드시 이 스킬을 사용하세요. 파일 없이 말로만 전달된 결정 사항도 이 스킬로 wiki 에 기록합니다. ⚠ 개인 폴더 (결혼 준비 위키, 회사 업무 폴더 등) 의 파일 배치·정리는 이 스킬이 아니라 anthropic-skills 의 wiki-ingest 담당 — 이 스킬은 docs/INDEX-SCHEMA.md 를 가진 코드 프로젝트 wiki 전용입니다. Jira 이슈의 forecast/closure ingest 는 issue 스킬의 wiki 단계(scripts/wiki-row.mjs) 담당."
---

# kb-ingest — KEY 없는 소스의 Wiki Ingest

> **Karpathy LLM Wiki 패턴의 범용 ingest 진입점** — issue 스킬의 wiki 단계(scripts/wiki-row.mjs)가 Jira 이슈 KEY 축 (forecast/closure) 을 담당한다면, 본 스킬은 **KEY 가 없는 모든 지식 소스**를 담당한다: 회의록, 클라이언트 회신, Mattermost 스레드, 세션 진단·결정 기록, 외부 문서, 구두 전달.
> SSoT: `references/_wiki-schema.md` — 특히 § 16 (synthesis 규약) · § 6 (LOG 형식). issue 스킬의 wiki 단계와 통합 규약 완전 공유.

## Usage

```
/kb-ingest <파일경로>              # 파일 소스
/kb-ingest                        # 인자 없이 — 대화 컨텍스트의 정보 또는 사용자가 이어서 지정
```

소스 유형은 자연어로 추론 — 플래그 없음. 파일·URL·붙여넣은 텍스트·구두 전달 모두 수용.

## ⛔ Guard

| 점검 | 부재 시 행동 |
|------|-------------|
| `docs/INDEX-SCHEMA.md` | "wiki 미설정 프로젝트입니다 — `/jira-harness:issue`(wiki 단계, scripts/wiki-row.mjs)로 onboarding 먼저 진행해주세요" 안내 후 종료 |
| schema 에 `synthesis:` 키 | "synthesis 층이 설정되지 않았습니다" — catalog 등재 (INDEX/LOG) 만 할지, `references/_wiki-schema.md` § 17 Wiki Bootstrap 을 먼저 할지 사용자 확인 |
| `docs/wiki/` 부재 또는 `synthesis.domains` 빈 배열 | `references/_wiki-schema.md` § 17 **Wiki Bootstrap** 제안 — bootstrap 없이 개별 kb-ingest 만 반복하면 wiki 가 "최근 것만 아는" 반쪽이 된다. 단 사용자가 "이것만 먼저" 라면 진행 (신규 도메인 신설 확인 포함) |

## § 1. Ingest 절차

### 1-1. 소스 확보·배치

- **파일 소스**: read 후, 파일이 schema 카테고리 위치 밖에 있으면 (예: 회의록이 `docs/` 루트나 다운로드 폴더) 올바른 폴더 (`docs/meeting/` 등 schema 카테고리 매칭 위치) 로 이동/복사를 제안. 이미 제자리면 그대로.
- **파일명 규약**: 대상 카테고리의 기존 파일명 관례를 따른다 (예: meeting = `YYYY-MM-DD-<slug>.md`). 관례가 안 보이면 기존 파일 2~3개를 열어 실측 — 추측으로 새 관례를 만들지 않는다.
- **비파일 소스** (구두 전달·붙여넣은 텍스트·Mattermost 스레드): 먼저 원문 기록 파일을 적절한 카테고리에 생성 (예: `docs/meeting/2026-01-15-<slug>.md`) — **wiki 페이지가 원문 보관소가 되면 안 된다** (wiki 는 종합, 원문은 소스). 스레드 permalink·발화자·날짜를 헤더에 보존.
- 소스 파일은 이후 immutable — 본 스킬이 기존 소스 문서의 본문을 수정하는 일은 없다.

### 1-2. 핵심 추출 + 확인

소스에서 4종 추출 (`references/_wiki-schema.md` § 16-5):

1. **규칙 변화** — 새 결정, 기존 규칙의 반전·수정
2. **경계·계약** — FE↔BE·외부 시스템 seam 의 신규/변경
3. **⚠ 함정** — 실사고·실측에서 나온 "이렇게 하면 안 되는 이유"
4. **미해결** — 열린 질문, 회신 대기, 보류

attended 세션이면 추출 결과를 사용자에게 한 번 보여주고 강조점 확인 (Karpathy "discusses key takeaways with you"). 자동 chain·배치 호출이면 생략하고 출력에 요약.

> ⚠ 회의록·회신은 dev-guide 보다 원시적이다 — 발화가 결정인지 아이디어인지 모호할 수 있다. **모호한 것은 규칙으로 서술하지 말고 "미해결" 로 분류**한다. 회의록의 난이도 표기·단정도 불신 (실측 교훈: "즉시 가능" 이 기구현이었고 한 줄짜리가 전역 결함이었다).

### 1-3. Wiki synthesis

`references/_wiki-schema.md` § 16-4 (도메인 판정) → § 16-5 (멱등 merge) 그대로:

1. 도메인 판정 — 페이지 frontmatter `scope` 힌트 + LLM 판단, `synthesis.max_pages_per_closure` 장 이내
2. 각 페이지에 merge — 규칙은 **교체** (as-is only), 함정·미해결은 append, 모든 문장에 출처 결박: `(meeting <경로|날짜>)` / `(클라 회신 <날짜>)` / `(Mattermost <날짜>)`
3. 페이지 `sources` 에 이 소스가 이미 있으면 skip (재-ingest 안전)
4. **모순 검출 시 자동 교체 금지** — 기존 서술(출처 포함)과 새 소스를 나란히 제시하고 사용자에게 어느 쪽이 최신 결정인지 확인. 특히 회의록·클라 회신은 기존 ADR 을 뒤집는 일이 잦다 — 반전이 확정되면 wiki 반영 + "정식 반전은 ADR 등재 필요" 를 사용자에게 상기 (wiki 가 ADR 의 대체재가 되면 안 된다)
5. 어느 도메인에도 안 맞으면 새 도메인 신설 제안 (승인 시 `synthesis.domains` 에도 추가)

### 1-4. Catalog 반영

1. `INDEX.md` — 소스 파일을 해당 카테고리 표에 upsert (신규 원문 파일 생성 시 필수)
2. `LOG.md` append (`references/_wiki-schema.md` § 6 — KEY 자리에 소스 경로 slug, phase 자리에 `kb`):
   ```
   [<timestamp> KST INGEST <source-slug> kb] wiki=<csv|-> index_row=<created|updated|-> note="<핵심 1문장>"
   ```
3. `forbidden` 파일 (PRD·DB schema·CLAUDE.md·CHANGELOG·코드) 은 절대 touch X

## § 2. 출력 포맷

```
📋 KB Ingest 완료 — <source>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ 소스 배치       : <docs/meeting/2026-01-15-xxx.md (신규 생성 | 기존 위치 유지 | 이동)>
✓ Wiki synthesis  : <billing, onboarding 2 페이지 merge | 신규 도메인 notifications 신설 (승인됨)>
✓ INDEX.md        : <meeting 카테고리 row 추가 | 기존>
✓ LOG.md          : append 1 line
⚠ 모순 발견       : <0 | N건 — 사용자 판정 대기 목록>
📌 미해결 등재     : <N건 (wiki 페이지 "미해결" 섹션)>

권장: 모순 N건 판정 / ADR 등재 필요 반전 <목록>
```

## § 3. Error Handling

- 각 단계 독립 try-catch — wiki merge 실패해도 catalog 반영은 진행 (역도 동일), 실패는 출력에 명시
- 도메인 판정 실패 (스코프 전멸) → 억지 배정 금지, 사용자에게 신설/보류 확인
- 소스가 이미 ingest 됨 (`sources` 에 존재 + INDEX 등재) → "이미 반영됨" 보고 후 종료 (강제 재통합은 사용자가 "다시" 명시할 때만 — 그 경우 sources 기반 skip 을 무시하고 § 16-5 재실행)

## § 4. Notes

- **issue 스킬의 wiki 단계와의 경계는 KEY 유무 하나**: dev-guide 가 있는 Jira 이슈는 그쪽(forecast/closure), 그 외 모든 지식 소스는 본 스킬. 같은 § 16 규약을 따르므로 wiki 페이지 입장에서 둘은 구분되지 않는다.
- **개인 폴더 위키와 혼동 금지**: 결혼 준비·회사 업무 폴더 등 파일 배치 중심 위키는 anthropic-skills `wiki-ingest` 담당. 본 스킬은 `docs/INDEX-SCHEMA.md` 를 가진 코드 프로젝트 전용 — Guard 가 이를 강제한다.
- Skill 호출당 context cost: 소스 크기 + wiki 페이지 1~3장 read/merge ≈ ~20K token
- `harness.json` 의 `mode` 값과 무관 (직교)
