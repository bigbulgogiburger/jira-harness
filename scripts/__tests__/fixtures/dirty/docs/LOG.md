# 픽스처 — Wiki Event Log (합성 데이터 · 위반 주입본)

> Append-only. Format: `[YYYY-MM-DD HH:MM KST  <MODE>     <KEY>          <phase>] key=value ...`

[2026-01-04 10:00 KST INGEST ABC-123 forecast] guide=docs/ABC-123-dev-guide.md parent=- adrs=ADR-001 siblings=ABC-124
[2026-01-06 11:00 KST INGEST ABC-123 closure] index_row=updated wiki=alpha touched=docs/INDEX.md
[2026-01-12 12:00 KST INGEST ABC-906 closure] index_row=updated touched=docs/INDEX.md
LOG 형식을 벗어난 줄 — 대괄호로 시작하지 않는다
