# Herdr 연동 — 사이드바 토큰·알림·플러그인·레인 실행기

Herdr(https://herdr.dev) 는 코딩 에이전트를 인식하는 터미널 워크스페이스 매니저다. jira-harness 는 Herdr 가 있으면 **표시·알림**을 더하고, 없으면 아무것도 하지 않는다 — 모든 연동 지점은 `HERDR_PANE_ID` 가 없으면 무동작이다(`scripts/lib/herdr.mjs`).

## 0. 판정 기준 — 무엇을 건드리고 무엇을 안 건드리나

| 축 | 쓴다 | 이유 |
|----|------|------|
| `pane report-metadata`(토큰·상태 라벨·제목) | ✅ | 표시 전용. lifecycle 권위와 무관 |
| `workspace report-metadata`(`$case`·`$stage`) | ✅ | 사이드바 space 행 |
| `notification show`(토스트, `--sound done|request`) | ✅ | 사람 게이트에서 사람을 부른다 |
| `pane report-agent`(idle/working/blocked) | ❌ | 통합 훅·화면 매니페스트가 그 축의 주인 — 덮으면 `agent wait`·알림이 어긋난다 |
| blocked 다이얼로그 자동 응답 | ❌ | 승인·권한 UI 는 사람 몫 |

## 1. 사이드바에 무엇이 뜨나

토큰 5개 + 사건 1개. `herdr-report.mjs --status` 로 언제든 값을 확인한다.

| 토큰 | 값 | 갱신 시점 |
|------|----|----------|
| `$case` | 이슈 키(다중이면 `ABC-1+2`) | start · 모든 보고 |
| `$stage` | 상태 JSON 의 stage | `issue-set --stage` |
| `$gate` | `commit PASS` · `full FAIL` · `… (stale)` · `-` | `gate.mjs` 끝 |
| `$review` | `r1 b0` · `r2 b3 (stale)` · `-` | `issue-set --review` |
| `$event` | 마지막 사건 한 줄(`gate commit FAIL`, `git push 거부 GATE_LEVEL`) | 매 보고 |

상태 라벨(Herdr 가 상태 자리에 대신 보여주는 글): working `ABC-7 · implement` · idle/done `ABC-7 · implement · gate commit PASS` · blocked `ABC-7 · 사람 확인 DoD H1`(사람 DoD 가 남았을 때).

`~/.config/herdr/config.toml`(Windows `%APPDATA%\herdr\config.toml`) 에 행을 선언해야 보인다:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "workspace", "$case", "$stage"],
  ["$gate", "$review"],
]
[ui.sidebar.spaces]
rows = [["state_icon", "workspace", "branch", "$case"]]
```

적용은 `herdr server reload-config`.

## 2. 알림이 오는 순간(사람 게이트)

| 순간 | 누가 부르나 | 소리 |
|------|------------|------|
| 게이트 FAIL | `gate.mjs` | request |
| 전량 게이트 PASS(push 가능) | `gate.mjs --full` | done |
| 리뷰 blocker 확정 | `issue-set --review` | request |
| 훅이 commit/push 거부 | `commit-gate.mjs`(deny 경로) | request |
| complete 성공 / 거부 | `issue-complete.mjs` | done / request |
| **계획 승인 대기** · **사람 확인 DoD** | 라우터가 `herdr-report.mjs --notify "<KEY> 계획 승인 대기" --sound request`(stages.md) | request |

무인 pane(`--unattended`) 에서 이 알림이 곧 "사람이 봐야 할 순간" 목록이다. 끄려면 `harness.json.herdr.notify=false`(토큰은 유지) 또는 `herdr.enabled=false`(전부).

## 3. Herdr 플러그인으로 설치(선택)

같은 저장소가 Herdr 플러그인이기도 하다(루트 `herdr-plugin.toml`). Claude Code 플러그인과 **스크립트를 공유**하므로 두 벌이 아니다.

```bash
herdr plugin install bigbulgogiburger/jira-harness      # 마켓(GitHub 토픽 herdr-plugin)
herdr plugin link D:/path/to/jira-harness               # 로컬 개발
herdr plugin enable bigbulgogiburger.jira-harness
```

| 종류 | id | 하는 일 |
|------|----|--------|
| 팝업 pane | `status` | `session-brief --print` + 토큰 표. 키 입력으로 닫힘 |
| 팝업 pane | `gate-commit` · `gate-full` | 게이트를 팝업에서 돌린다(출력 그대로) |
| 액션 | `report` · `adopt-branch` | 사이드바 갱신 · 현재 브랜치를 이슈로 채택 |
| 이벤트 | `worktree.created` | 새 worktree 브랜치가 `branch_pattern` 안이면 `issue-start --adopt` 로 상태 JSON 을 만들고 토스트 |

키에 묶기(`config.toml`):

```toml
[[keys.command]]
key = "prefix+alt+c"
type = "plugin_action"
command = "bigbulgogiburger.jira-harness.report"
```

팝업 pane 은 `herdr plugin pane open status --plugin bigbulgogiburger.jira-harness`.

프로젝트 위치는 Herdr 가 넘기는 문맥(`HERDR_PLUGIN_CONTEXT_JSON` 의 `focused_pane_cwd` · `workspace_cwd` · worktree 경로)에서 고른다 — 0.9.0 실측 키다. 하네스가 없는 디렉터리면 안내 한 줄만 낸다.

## 4. 레인 실행기(`herdr.lanes`)

Workflow 서브에이전트 대신 **Herdr pane 의 다른 에이전트**(codex·grok·claude …)를 레인으로 쓴다. 기본 `off`. `verify` 면 리뷰 레인(`all` 은 예약). 절차·함정·설정은 [`skills/issue/references/herdr-lanes.md`](../../issue/references/herdr-lanes.md).

역할 세 개가 워크스페이스에 상주한다(A 단계):

| 역할 | 켜는 값 | 무엇 |
|------|--------|------|
| reviewer | `review.codex_via: "herdr"` | Codex 판정을 `codex exec` 대신 상주 codex pane 으로. 있으면 재사용, 없으면 띄움. 컨텍스트는 `herdr.reviewer_context`(issue/always/never) |
| runner | 항상(Herdr 안이면) | 게이트를 runner pane 에서 — `herdr-lanes.mjs gate --full [--no-wait]`. 로그가 driver 컨텍스트 밖에 남는다 |
| lane | `herdr.lanes: "verify"` | 추가 심판(grok 등) 레인 |

driver(Claude) 는 판단·결정·훅만 갖고, 긴 출력은 전부 pane 과 파일로 나간다. codex 는 조언자다 — 커밋은 driver 의 훅·safe-commit 만 통과한다.

```jsonc
"review": { "codex_via": "herdr" },
"herdr": {
  "lanes": "verify",
  "reviewer_context": "issue",
  "kinds": { "verify": ["codex", "grok"] },
  "kind_args": { "codex": ["--sandbox", "danger-full-access", "--ask-for-approval", "never"] },
  "lane_timeout_s": 900,
  "close_panes": false
}
```

## 5. 전제 점검(check 에 더할 것)

- `herdr status` 가 server running 이고 client/server 버전이 같다.
- `herdr integration status` 에서 쓰는 에이전트(claude·codex)가 installed — 세션 복원(`claude --resume`)과 상태 인식 정확도가 여기서 갈린다. 설치는 사용자가 한다(`herdr integration install claude` 는 `~/.claude/settings.json` 을 고친다 — 묻지 않고 실행하지 않는다).
- Windows codex 는 기본 샌드박스로 파일을 못 읽는다(`CreateProcessWithLogonW failed: 1385`) — `kind_args.codex` 에 `--sandbox danger-full-access` 가 없으면 verify 레인이 빈손으로 끝난다.
