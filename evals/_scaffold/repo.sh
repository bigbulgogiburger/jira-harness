#!/usr/bin/env bash
# 임시 프로젝트 저장소를 만든다. 인자: <mode> = bare | issue-no-gate | issue-implement
set -euo pipefail
MODE="${1:-issue-no-gate}"
git init -q -b main .
git config user.email eval@example.com; git config user.name eval; git config core.autocrlf false
mkdir -p backend frontend docs .claude
printf 'class App {}\n' > backend/App.java
printf 'export default 1\n' > frontend/app.js
printf '# docs\n' > docs/README.md
printf '.claude/runtime/\n.claude/harness.env.local\n' > .gitignore
if [ "$MODE" != "bare" ]; then
cat > .claude/harness.json <<'JSON'
{ "version": 3, "mode": "auto", "issue_prefix": "ABC",
  "branch_pattern": "^(feat|fix)/(?<keys>ABC-\d+(?:-\d+)*)(?:-[a-z0-9]+)*$",
  "stacks": { "be": { "dir": "backend", "compile": "echo compile-ok", "lint": null, "build": "echo build-ok", "test": "echo '3 tests completed'" },
              "fe": { "dir": "frontend", "compile": "echo compile-ok", "lint": "echo lint-ok", "build": "echo build-ok", "test": "echo 'Tests 2 passed'" } } }
JSON
fi
git add -A && git commit -q -m init
if [ "$MODE" != "bare" ]; then
  git checkout -q -b feat/ABC-1
  mkdir -p .claude/runtime/issues
  STAGE=start; [ "$MODE" = "issue-implement" ] && STAGE=implement
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cat > .claude/runtime/issues/feat-ABC-1.json <<JSON
{ "version": 3, "branch": "feat/ABC-1", "keys": ["ABC-1"], "stage": "$STAGE", "started_at": "$NOW", "updated_at": "$NOW",
  "guides": {}, "decisions": [], "touched": [], "lanes": [], "dod": [], "gate": null, "review": null, "history": [{ "stage": "start", "at": "$NOW" }] }
JSON
  printf 'class App { int x; }\n' > backend/App.java
  git add -A
fi
