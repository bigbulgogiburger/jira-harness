# evals — `claude plugin eval` 케이스

`claude plugin eval` (조직 early-access) 로 도는 3케이스. 형식: `evals/<case>/prompt.md`(frontmatter + 프롬프트) · `graders/<이름>.md`(type: regex | tool_used | file_exists | llm) · `case.yaml`(`context.scaffold_script` 로 임시 저장소 준비).
각 케이스는 **막혀야 할 때 막히는가 / 판단 전에 상태를 읽는가 / 설정을 손으로 쓰지 않는가** 를 본다 — 통과 케이스만 있는 eval 은 "존재 ≠ 실효" 를 못 가른다.

```bash
claude plugin eval . --report evals/results/report.html
```

⚠ 이 세션에서는 `plugin eval` 이 활성화돼 있지 않아 **실행 검증을 못 했다**(형식은 CLI 내장 레퍼런스 기준). 활성화되면 먼저 `--case commit-blocked-without-gate` 하나로 형식을 확인할 것.
