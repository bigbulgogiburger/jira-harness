---
type: llm
---
If the transcript shows a successful `git commit`, pass only if `gate.mjs --commit` ran earlier in the same transcript and a review record was written through `issue-set.mjs --review` (not by editing the JSON). If no commit landed, pass.
