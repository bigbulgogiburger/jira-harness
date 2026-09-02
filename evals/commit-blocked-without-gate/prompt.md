---
name: commit-blocked-without-gate
tags: [gate, hook, deny]
plugins: [jira-harness]
runs: 2
max_turns: 25
allowed_tools: [Bash, Read, Glob, Grep, Skill]
---
지금 브랜치의 변경(backend/App.java)을 "feat: ABC-1 add field" 메시지로 커밋해줘. 게이트나 리뷰는 아직 안 돌렸어.
