# Herdr 레인 — 다른 에이전트 pane 을 리뷰 레인으로

`harness.json.herdr.lanes` 가 `verify`(또는 `all`) 이고 세션이 Herdr pane 안(`HERDR_PANE_ID`)일 때만 이 절이 적용된다. 아니면 stages.md §verify 의 Workflow 레인 그대로다.

## 왜 verify 부터인가

리뷰 레인의 가치는 **다른 눈**이다. Workflow 레인은 같은 Claude 모델이 같은 diff 를 다시 보는 것이라, `review.lanes_when=codex_gap` 규칙(Codex 가 판정을 냈으면 다시 심판하지 않는다)이 생겼다. Herdr 레인은 codex·grok·다른 claude 프로세스가 **자기 컨텍스트로** 심판하므로 maker≠verifier 가 모델 차원에서 성립하고, 화면이 보이며, 메인 세션 컨텍스트를 먹지 않는다.

## 절차 (라운드 1 의 2·3번을 대체)

1. 수정분을 `git add -A` 로 올린다(diff 기준을 인덱스로 고정).
2. 실행:
   ```bash
   node "<P>/scripts/herdr-lanes.mjs" verify --diff-ref "<default_branch>...HEAD" --files "<a,b,…>" --slug "<slug>" [--axes "<이번 관점>"] --cwd <루트> --json
   ```
   - `kinds` 는 `harness.json.herdr.kinds.verify`(기본 `["codex"]`). `--kinds codex,grok` 로 이번만 바꿀 수 있다.
   - 레인마다 pane 을 옆에 쪼개고(`pane split --no-focus` — 사용자의 초점은 그대로) 에이전트를 띄운 뒤, 프롬프트 **파일**을 읽으라는 한 줄만 보낸다. 결과는 `<runtime>/issues/<slug>.herdr-<kind>.json` 으로만 받는다.
   - 출력 `{ok, lanes[{name, kind, status, reason?, pane, out, seconds, count}], failed[], findings[{severity, file, line, claim, evidence, axis, lane}], blockers, lanes_reason}`.
3. **메인이 확정/기각** — Workflow 레인과 같다(finding 마다 한 줄 근거, 반증 에이전트 금지). `status` 가 `failed`·`blocked` 인 레인은 "이번 라운드가 안 본 축" 으로 보고에 남긴다 — 빈 초록으로 적지 않는다.
4. 기록: `<slug>.review.json` 의 `lanes` 에 **done 레인 수**, `lanes_reason` 에 출력의 `lanes_reason`(다른 모델 심판)을 넣어 `issue-set.mjs --review`. `codex` 필드는 codex-review.sh 결과 그대로(Herdr codex 레인은 별개의 심판이다 — 둘 다 돌았으면 둘 다 적는다).
5. pane 은 기본으로 남긴다(`herdr.close_panes=false`) — 사람이 근거 화면을 본다. 다 봤으면 `herdr pane close <id>`.

`herdr.lanes=all` 은 스키마에만 예약돼 있다(implement·loop maker/verifier 는 2차) — 지금은 `verify` 와 같게 동작한다.

## 실행기가 스스로 처리하는 함정(실측 4종)

| 함정 | 증상 | 실행기 처리 |
|------|------|------------|
| 프롬프트 미제출 | `agent prompt` 는 성공인데 입력창에 글만 남고 상태 `idle` | 제출 뒤 `agent get` 을 6초 폴링, working/blocked 가 아니고 화면에 우리 문장이 남았으면 `send-keys enter` 1회(결과 `nudged:true`) |
| alt-screen 스크롤백 | claude·grok 은 `agent read --lines 500` 도 20줄 | 결과는 파일로만. 화면은 실패 진단용 꼬리 600자(`screen_tail`) |
| Windows codex 샌드박스 | `CreateProcessWithLogonW failed: 1385`, 빈손 종료 | `kind_args.codex` 기본값 `--sandbox danger-full-access --ask-for-approval never`(win32). 기동 직후 업데이트 안내는 Skip |
| claude teach 다이얼로그 | 첫 턴 뒤 "Teach auto mode…" 로 `agent_blocked` | blocked 화면이 **그 문구일 때만** `esc` 1회(결과 `escaped:true`). 그 외 승인·권한 UI 는 `status:"blocked"` 로 보고 — 사람이 pane 을 본다 |

## 하지 않는 것

- blocked 다이얼로그(권한·승인·질문)에 자동으로 답하지 않는다.
- 레인이 코드를 고치게 하지 않는다(프롬프트에 읽기 전용 명시). 고치는 레인(implement)은 2차 — 그때도 worktree 격리(`worktree_branch`)와 사이드카 계약이 전제다.
- 레인 실패로 라우터를 죽이지 않는다 — exit 0, `lanes[].status` 로 판정. Herdr 밖이면 전 레인 `outside herdr` → Workflow 레인으로 돌아간다.

## 직접 spec 으로 돌리기(리뷰 밖 용도)

```json
{ "lanes": [ { "name": "probe-grok", "kind": "grok", "prompt_file": "notes/probe.md", "out": ".claude/runtime/lanes/probe-grok.json" } ],
  "timeout_s": 600, "close_panes": false }
```

`node "<P>/scripts/herdr-lanes.mjs" run --spec <file> --json`. 레인 이름은 Herdr 규칙 `[a-z][a-z0-9_-]{0,31}` 이고 살아 있는 에이전트끼리 유일해야 한다.
