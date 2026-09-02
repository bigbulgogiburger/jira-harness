# 픽스처 — Wiki INDEX Schema (합성 데이터)

> 테스트 전용. 실제 프로젝트 값이 아니다.

```yaml
version: 1
project: fixture-project

issue_prefix: ABC            # 가상 이슈 키 prefix

categories:
  - id: issue_guides
    label: 이슈 가이드
    match:
      pattern: "^ABC-\\d+(?:-(?:ABC-)?\\d+)*-dev-guide\\.md$"
    columns: [issue, status, title, week, parent, siblings, adrs, updated]

  - id: wiki
    label: 위키 (도메인 현재-상태 종합)
    match:
      pattern: "^wiki/.*\\.md$"
    columns: [file, domain, summary, updated]

synthesis:
  dir: "wiki/"
  domains:
    - id: alpha
    - id: beta
  max_pages_per_closure: 3

cross_refs:
  adr_pattern: "\\bADR-\\d+\\b"
  issue_pattern: "\\bABC-\\d+\\b"

stale_thresholds:
  planned_days: 7

frontmatter_required_since: "2026-01-01"

lint_exemptions:
  guide_file_optional:
    - id: row_description_only
      keys: ["ABC-900"]
      reason: "행 본문이 유일한 기록 — 전용 가이드를 만들지 않기로 한 행"
```
