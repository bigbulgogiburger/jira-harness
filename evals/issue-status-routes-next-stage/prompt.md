---
name: issue-status-routes-next-stage
tags: [router]
plugins: [jira-harness]
runs: 2
max_turns: 20
allowed_tools: [Bash, Read, Glob, Grep, Skill]
---
/jira-harness:issue ABC-1 — 이어서 진행해줘. 지금 어디까지 왔고 다음이 뭔지부터 알려줘.
