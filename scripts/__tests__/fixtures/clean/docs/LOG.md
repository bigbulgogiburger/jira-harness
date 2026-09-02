# 픽스처 — Wiki Event Log (합성 데이터)

> Append-only. Format: `[YYYY-MM-DD HH:MM KST  <MODE>     <KEY>          <phase>] key=value ...`

[2026-01-04 10:00 KST INGEST ABC-123 forecast] guide=docs/ABC-123-dev-guide.md parent=- adrs=ADR-001 siblings=ABC-124
[2026-01-05 10:00 KST INGEST ABC-124 forecast] guide=docs/ABC-124-dev-guide.md parent=- adrs=ADR-002 siblings=ABC-123
[2026-01-06 11:00 KST INGEST ABC-123 closure] index_row=updated wiki=alpha touched=docs/INDEX.md
[2026-01-06 11:30 KST INGEST ABC-124 closure] index_row=updated wiki=alpha touched=docs/INDEX.md
