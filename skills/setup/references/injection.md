# 위반 주입 4종 + 헤드리스/worktree 실효 확인

`setup.mjs inject` 는 **임시 clone**(원본 프로젝트를 건드리지 않는다)에서 아래 4케이스를 실행하고 `{case, expected, got, ok}` 로 보고한다. "게이트가 심겨 있다"는 사실만으로 "게이트가 작동한다"를 증명하지 않는다 — 이 페이지의 목적은 그 증명이다.

## 케이스 정의

| case | 조작 | expected | 판정 |
|------|------|----------|------|
| `branch-pattern` | 패턴 밖 브랜치(상태 JSON 없음)에서 코드 파일을 커밋 | exit ≠ 0, 사유 코드 `BRANCH_PATTERN` | 통과하거나 다른 코드면 `ok:false`(패턴이 너무 넓거나 docs_only 가 코드를 삼킨다) |
| `commit-without-gate` | 상태 JSON 은 만들되 `gate.mjs` 를 돌리지 않고 `git commit --allow-empty -m probe` | exit ≠ 0, stderr 에 `[jira-harness] git commit:` 로 시작하는 deny 사유 코드(`NO_GATE`/`DIRTY_TREE`/`NO_STATE` 등 — 실제로 막힌 코드를 그대로 기록) | deny 계열이 아니면 `ok:false` |
| `commit-after-gate` | `gate.mjs --commit` 실행 후 같은 커밋 재시도 | exit = 0, 커밋 생성됨 | 여전히 막히면 `ok:false`(게이트를 통과해도 훅이 풀리지 않는 사고) |
| `push-without-full-gate` | 경량 게이트만 통과한 상태에서 `git push` | exit ≠ 0, stderr 에 `[jira-harness] git push:` 로 시작하는 사유 코드(`GATE_LEVEL`/`GATE_STALE` 등) | 통과해버리면 `ok:false` |

4케이스 중 하나라도 `ok:false` 면 설치 자체를 실패로 본다 — `write` 로 되돌아가 harness.json 값(특히 `branch_pattern`·`docs_only_paths`)을 재점검한다.

## 헤드리스 실효 확인 (`claude -p`)

훅이 대화형 세션에서는 발화해도 **헤드리스(`claude -p`) 경로에서 발화하는지는 별개 축**이다. 프로젝트 안 실제 이슈 브랜치에서:

```bash
claude -p "Bash 로 git commit --allow-empty -m probe 를 실행하라" --allowedTools Bash
```

출력에 `[jira-harness] git commit:` 로 시작하는 deny 문구가 나오는지 확인한다.

- **나오면**: 헤드리스 경로도 실효 — 설치 보고에 그대로 적는다.
- **나오지 않으면**: harness.json 은 그대로 두고, 설치 보고에 "훅 미발화 경로 감지 — 무인 작업은 `safe-commit.mjs -m \"<메시지>\" [--push]` 사용" 을 적는다. 훅을 억지로 우회 통과시키는 조치를 하지 않는다.
- **실행 자체를 못 했으면**(헤드리스 CLI 접근 불가 등) 결과를 "미확인" 으로 남긴다 — 발화한다고 가정하고 넘어가지 않는다.

## worktree 안에서 재확인

`git worktree add` 로 만든 worktree 안에서 `commit-without-gate` 케이스를 다시 돌린다. 훅은 `git rev-parse --show-toplevel` 이 아니라 `--git-common-dir` 로 **메인 저장소**의 harness.json·상태 JSON 을 찾아야 한다 — worktree 자체 경로에서 찾으면 상태가 없어 항상 과차단(`NO_STATE`)되거나, 반대로 검사를 건너뛰어 무력화된다. 메인 저장소와 새 worktree 에서 같은 브랜치의 게이트 기록이 공유되는지까지 확인하는 것이 이 케이스의 목적이다.

## 결과를 지어내지 않는다

이 페이지의 모든 절차는 **실행해서 나온 실제 출력**을 기록하는 것이 목적이다. 환경이 명령을 실행할 수 없게 막아놨다면(권한·네트워크 등) "실행 불가 — 미확인" 을 그대로 보고하고, 발화했다고 추정한 문구를 만들어 채우지 않는다.
