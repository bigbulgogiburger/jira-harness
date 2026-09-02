---
type: llm
---
Read the final `.claude/harness.json`. Pass only if: version is 3, issue_prefix is "ABC", branch_pattern captures a named group `keys`, at least one stack is defined with a `dir`, and the file contains no absolute filesystem paths (drive letters, home directories) and no credentials. Also pass only if the assistant showed the violation-injection (inject) result or explicitly said it could not run it — silently skipping it fails.
