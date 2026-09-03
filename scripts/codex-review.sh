#!/usr/bin/env bash
# =============================================================================
# codex-review.sh — Codex adversarial review 범용 래퍼 (jira-harness v3, 작업 항목 B5)
# =============================================================================
# 배경: codex exec 는 non-TTY 파이프 stdin 에서 무한 블록되는 문서화된 결함이 있다
#   (openai/codex #20919, #27019 — "Reading additional input from stdin" deadlock).
#   보장 5가지:
#   a. stdin 봉인   — 모든 호출에 < /dev/null (deadlock 원천 차단)
#   b. 출력 파일화  — stdout pipe 캡처 금지 (큰 출력의 pipe 버퍼 데드락 차단)
#   c. 이중 타임박스 — hard timeout(기본 900s) + 무진행 watchdog(기본 180s 출력 불변 시 kill)
#   d. 호출 계측    — <runtime_dir>/codex-invocations.log 에 1줄/호출
#   e. diff 파일화  — diff 본문은 argv 에 넣지 않는다. <out>.diff 로 쓰고 프롬프트에는 경로만 준다.
#                    (Windows CreateProcess 인자 한계 32K — 65파일 diff 를 인자로 넘기면 codex 가 exit 126 으로 죽는다)
#   Windows 일부 환경(사내 GPO 등으로 secondary logon 이 막힌 경우)에서는 codex 기본 샌드박스가
#   자식 프로세스 기동에 실패해(에러 1385) exit 0 인데 실제로는 아무 것도 못 읽은 채 끝나는 사례가
#   있다 — review/critique 는 read-only 작업이라 danger-full-access 샌드박스가 더 안전하다.
#
# 사용법:
#   scripts/codex-review.sh [--since <tree-id>] [--out <file>] [--cwd <dir>]
#                            [--timeout <sec>] [--model <codex model>] [--prompt-file <file>]
#
#   대상 diff:
#     기본        git diff <default_branch>...HEAD (커밋 구간) + git diff HEAD (작업트리)
#     --since T   git diff-tree -r --name-only T $(git write-tree) 로 바뀐 파일만 골라
#                 그 파일들의 diff(T 기준)만 넘긴다 — 델타 패스.
#   default_branch · runtime_dir 은 <root>/.claude/harness.json 에서 읽는다(jq 미사용 —
#   grep/sed). 없으면 main / .claude/runtime.
#
#   출력 파일 기본: <runtime_dir>/review/<branch-slug>-codex-<UTC ts>.md
#   판정은 exit code 가 아니라 **출력 본문**이다 — 영문 앵커 `Verdict:` 줄(PASS|BLOCK|UNKNOWN)과
#   `BLOCKER` 로 시작하는 항목 수를 센다. 사용량 한도 문구면 status=limit. codex 가 PATH 에
#   없으면 status=missing(조용히 통과시키지 않는다). 타임아웃/캡 절단은 status=fail.
#
#   마지막 stdout 줄은 정확히 다음 형식(그 외 로그는 전부 stderr):
#     CODEX_RESULT={"status":"ok|limit|fail|missing","blockers":N,"verdict":"PASS|BLOCK|UNKNOWN","out":"<path>","diff":"<path>","files":N,"reason":"..."}
#   종료 코드: ok=0(blockers 가 있어도 0 — 판정은 호출측이 한다) / limit|fail|missing=1
#
#   env: CODEX_TIMEOUT(=--timeout 기본값, 기본 900) · CODEX_STALL(기본 180) ·
#        CODEX_POLL_INTERVAL(폴링 주기 초, 기본 10 — 테스트에서만 줄여 쓴다) ·
#        CODEX_ARGS(기본 "exec --sandbox danger-full-access --skip-git-repo-check")
# =============================================================================
set -u

# ---------- 인자 ----------
SINCE_TREE=""
OUT_ARG=""
CWD_ARG=""
TIMEOUT_ARG=""
MODEL=""
PROMPT_FILE_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE_TREE="${2:?--since 는 tree-id 필요}"; shift 2 ;;
    --out) OUT_ARG="${2:?--out 은 파일 경로 필요}"; shift 2 ;;
    --cwd) CWD_ARG="${2:?--cwd 는 디렉터리 필요}"; shift 2 ;;
    --timeout) TIMEOUT_ARG="${2:?--timeout 은 초 필요}"; shift 2 ;;
    --model) MODEL="${2:?--model 은 모델명 필요}"; shift 2 ;;
    --prompt-file) PROMPT_FILE_ARG="${2:?--prompt-file 은 파일 경로 필요}"; shift 2 ;;
    *) echo "[codex-review] 알 수 없는 인자: $1" >&2; exit 1 ;;
  esac
done

if [[ -n "$CWD_ARG" ]]; then
  cd "$CWD_ARG" || { echo "[codex-review] --cwd 디렉터리 없음: $CWD_ARG" >&2; exit 1; }
fi

HARD_TIMEOUT="${TIMEOUT_ARG:-${CODEX_TIMEOUT:-900}}"
STALL_LIMIT="${CODEX_STALL:-180}"
POLL_INTERVAL="${CODEX_POLL_INTERVAL:-10}"
CODEX_ARGS="${CODEX_ARGS:-exec --sandbox danger-full-access --skip-git-repo-check}"

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="$(printf '%s' "$s" | tr '\n' ' ')"
  printf '%s' "$s"
}

fwd_slash() { printf '%s' "$1" | sed 's#\\#/#g'; }

branch_slug() {
  local b="$1"
  b="${b//\//-}"; b="${b//\\/-}"
  printf '%s' "$b" | sed -E 's/[^A-Za-z0-9._-]/_/g'
}

DIFF_OUT=""
emit_result() { # status blockers verdict out files reason   (diff 경로는 전역 DIFF_OUT — 산출 전이면 빈 문자열)
  printf 'CODEX_RESULT={"status":"%s","blockers":%s,"verdict":"%s","out":"%s","diff":"%s","files":%s,"reason":"%s"}\n' \
    "$1" "$2" "$3" "$(json_escape "$4")" "$(json_escape "$DIFF_OUT")" "$5" "$(json_escape "$6")"
}

# ---------- 저장소 루트 · harness.json ----------
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "$TOPLEVEL" ]]; then
  echo "[codex-review] git 저장소가 아닙니다" >&2
  emit_result "fail" 0 "UNKNOWN" "" 0 "not-a-git-repo"
  exit 1
fi

CONFIG_ROOT="$TOPLEVEL"
HARNESS_JSON="$TOPLEVEL/.claude/harness.json"
if [[ ! -f "$HARNESS_JSON" ]]; then
  COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  if [[ -n "$COMMON_DIR" ]]; then
    MAIN_ROOT="${COMMON_DIR%/.git}"
    if [[ -f "$MAIN_ROOT/.claude/harness.json" ]]; then
      CONFIG_ROOT="$MAIN_ROOT"
      HARNESS_JSON="$MAIN_ROOT/.claude/harness.json"
    fi
  fi
fi

harness_field() { # field default
  local field="$1" def="$2" val=""
  if [[ -f "$HARNESS_JSON" ]]; then
    val="$(grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$HARNESS_JSON" 2>/dev/null | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')"
  fi
  printf '%s' "${val:-$def}"
}

DEFAULT_BRANCH="$(harness_field default_branch main)"
RUNTIME_DIR="$(harness_field runtime_dir .claude/runtime)"

BRANCH="$(git symbolic-ref --short -q HEAD 2>/dev/null)"
[[ -z "$BRANCH" ]] && BRANCH="(detached)"
CUR_TREE_HEAD="$(git rev-parse -q --verify HEAD^{tree} 2>/dev/null || echo "")"

# ---------- 대상 diff 산출 ----------
TMP_DIR="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/codex-review-$$")"
mkdir -p "$TMP_DIR"
DIFF_FILE="$TMP_DIR/diff.txt"
: > "$DIFF_FILE"

if [[ -n "$SINCE_TREE" ]]; then
  CUR_TREE="$(git write-tree 2>/dev/null)"
  if [[ -z "$CUR_TREE" ]]; then
    echo "[codex-review] git write-tree 실패 — 인덱스 확인" >&2
    emit_result "fail" 0 "UNKNOWN" "" 0 "write-tree-failed"
    exit 1
  fi
  FILES="$(git diff-tree -r --name-only --no-commit-id "$SINCE_TREE" "$CUR_TREE" 2>/dev/null)"
  if [[ -n "$FILES" ]]; then
    git diff "$SINCE_TREE" -- $FILES > "$DIFF_FILE" 2>/dev/null
  fi
  TREE_FOR_META="$CUR_TREE"
else
  git diff "${DEFAULT_BRANCH}...HEAD" > "$DIFF_FILE" 2>/dev/null
  echo >> "$DIFF_FILE"
  git diff HEAD >> "$DIFF_FILE" 2>/dev/null
  FILES="$( { git diff --name-only "${DEFAULT_BRANCH}...HEAD" 2>/dev/null; git diff --name-only HEAD 2>/dev/null; } | sort -u )"
  TREE_FOR_META="${CUR_TREE_HEAD:-unknown}"
fi

FILES_COUNT=0
[[ -n "$FILES" ]] && FILES_COUNT="$(printf '%s\n' "$FILES" | sed '/^$/d' | wc -l | tr -d ' ')"

TS_UTC="$(date -u +%Y%m%dT%H%M%SZ)"

# ---------- 출력 파일 경로 ----------
if [[ -n "$OUT_ARG" ]]; then
  OUT_PATH="$OUT_ARG"
else
  SLUG="$(branch_slug "$BRANCH")"
  OUT_PATH="$CONFIG_ROOT/$RUNTIME_DIR/review/${SLUG}-codex-${TS_UTC}.md"
fi
OUT_PATH="$(fwd_slash "$OUT_PATH")"
mkdir -p "$(dirname "$OUT_PATH")" 2>/dev/null

# diff 는 보고서 옆에 파일로 남긴다 — codex 에는 이 경로만 준다(보장 e). 리뷰 뒤에도 "무엇을 봤나" 의 증거로 남는다.
DIFF_OUT="${OUT_PATH%.md}.diff"
cp "$DIFF_FILE" "$DIFF_OUT" 2>/dev/null || : > "$DIFF_OUT"
DIFF_BYTES="$(wc -c < "$DIFF_OUT" 2>/dev/null | tr -d ' ')"

write_report() { # body-file-or-empty note
  {
    echo "# Codex Review"
    echo
    echo "- branch: $BRANCH"
    echo "- tree: $TREE_FOR_META"
    echo "- files: $FILES_COUNT"
    echo "- diff: $DIFF_OUT (${DIFF_BYTES:-0} bytes)"
    echo "- model: ${MODEL:-(default)}"
    echo "- timestamp: $TS_UTC"
    echo
    echo "---"
    echo
    if [[ -n "${2:-}" ]]; then echo "$2"; echo; fi
    if [[ -n "${1:-}" && -f "$1" ]]; then cat "$1"; fi
  } > "$OUT_PATH"
}

LOGF="$CONFIG_ROOT/$RUNTIME_DIR/codex-invocations.log"
mkdir -p "$(dirname "$LOGF")" 2>/dev/null
log_line() { # status elapsed bytes note
  printf '[%s] status=%s elapsed=%ss out_bytes=%s files=%s note=%s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$2" "$3" "$FILES_COUNT" "${4:-}" >> "$LOGF" 2>/dev/null
}

# ---------- codex 미존재 ----------
if ! command -v codex >/dev/null 2>&1; then
  write_report "" "codex CLI 를 PATH 에서 찾을 수 없어 리뷰를 수행하지 못했습니다."
  log_line MISSING 0 0 "codex not on PATH"
  echo "[codex-review] codex CLI 가 PATH 에 없습니다" >&2
  emit_result "missing" 0 "UNKNOWN" "$OUT_PATH" "$FILES_COUNT" "codex-not-on-PATH"
  exit 1
fi

# ---------- 대상 파일 없음 ----------
if [[ "$FILES_COUNT" -eq 0 ]]; then
  write_report "" "대상 파일이 없어 리뷰를 생략했습니다."
  log_line OK 0 0 "no target files"
  emit_result "ok" 0 "PASS" "$OUT_PATH" 0 ""
  exit 0
fi

# ---------- 프롬프트 구성 ----------
DEFAULT_PROMPT='당신은 이 저장소의 diff 에 대한 적대적(adversarial) 코드 리뷰어입니다.

리뷰 축: 정확성(로직 오류·엣지 케이스·예외 처리) / 보안(인증·인가 누락·인젝션·시크릿 노출) / 계약 일치(API·타입·인터페이스가 호출측과 어긋나지 않는지) / 테스트 실효성(테스트가 실제로 실패 케이스를 검증하는지, 항상 통과하는 껍데기 테스트는 아닌지).

문제를 찾으면 항목마다 다음 형식으로 적으세요:
- severity: BLOCKER | MAJOR | MINOR
- file: <경로>
- line: <줄번호>
- claim: <무엇이 문제인가>
- evidence: <근거 — 코드 인용 또는 논리>

문제가 없으면 그렇게 적으세요. 반드시 마지막 줄에 다음 중 하나만 정확히 적으세요:
Verdict: PASS
Verdict: BLOCK'

if [[ -n "$PROMPT_FILE_ARG" ]]; then
  if [[ ! -f "$PROMPT_FILE_ARG" ]]; then
    write_report "" "--prompt-file 를 찾을 수 없어 리뷰를 수행하지 못했습니다: $PROMPT_FILE_ARG"
    log_line FAIL 0 0 "prompt-file not found: $PROMPT_FILE_ARG"
    echo "[codex-review] --prompt-file 없음: $PROMPT_FILE_ARG" >&2
    emit_result "fail" 0 "UNKNOWN" "$OUT_PATH" "$FILES_COUNT" "prompt-file-not-found"
    exit 1
  fi
  BASE_PROMPT="$(cat "$PROMPT_FILE_ARG")"
else
  BASE_PROMPT="$DEFAULT_PROMPT"
fi

# 프롬프트(=codex 의 argv 하나)에는 diff 본문을 넣지 않는다 — 경로와 파일 목록만. Windows 인자 한계(32K) 안에 머문다.
PROMPT_FILE="$TMP_DIR/prompt.txt"
ARGV_LIMIT=30000
build_prompt() { # file-list-max
  {
    printf '%s\n' "$BASE_PROMPT"
    echo
    echo "---"
    echo
    echo "# 대상 diff (${FILES_COUNT}개 파일, ${DIFF_BYTES:-0} bytes)"
    echo
    echo "diff 본문은 이 프롬프트에 없다. 아래 파일(unified diff, UTF-8)을 먼저 읽고 그 내용을 리뷰하라:"
    echo "  $DIFF_OUT"
    echo
    echo "대상 파일 목록(최대 ${1}개):"
    printf '%s\n' "$FILES" | sed '/^$/d' | head -n "$1" | sed 's/^/- /'
  } > "$PROMPT_FILE"
}
build_prompt 200
if [[ "$(wc -c < "$PROMPT_FILE" | tr -d ' ')" -gt "$ARGV_LIMIT" ]]; then
  build_prompt 20
  if [[ "$(wc -c < "$PROMPT_FILE" | tr -d ' ')" -gt "$ARGV_LIMIT" ]]; then
    echo "[codex-review] 경고: 프롬프트가 ${ARGV_LIMIT}B 를 넘는다(--prompt-file 이 큰가?) — Windows 에서 exit 126 이 날 수 있다" >&2
  fi
fi

# ---------- codex 호출 (stdin 봉인 + 출력 파일화 + 이중 타임박스) ----------
RAW_OUT="$TMP_DIR/codex-out.txt"
: > "$RAW_OUT"

snapshot_codex() { tasklist.exe 2>/dev/null | grep -i 'codex' | awk '{print $2}' | sort | tr '\n' ' '; }
CODEX_PIDS_BEFORE="$(snapshot_codex)"
kill_tree() {
  local pid=$1
  if command -v taskkill.exe >/dev/null 2>&1; then
    local winpid
    winpid=$(ps -p "$pid" -o winpid= 2>/dev/null | tr -d ' ')
    taskkill.exe //PID "${winpid:-$pid}" //T //F >/dev/null 2>&1
    for cpid in $(tasklist.exe 2>/dev/null | grep -i 'codex' | awk '{print $2}'); do
      case " $CODEX_PIDS_BEFORE " in
        *" $cpid "*) ;;
        *) taskkill.exe //PID "$cpid" //T //F >/dev/null 2>&1 ;;
      esac
    done
  fi
  kill "$pid" 2>/dev/null; sleep 1; kill -9 "$pid" 2>/dev/null
}

START=$(date +%s)
# shellcheck disable=SC2086
codex $CODEX_ARGS ${MODEL:+--model "$MODEL"} "$(cat "$PROMPT_FILE")" < /dev/null > "$RAW_OUT" 2>&1 &
PID=$!

LAST_SIZE=0
STALL=0
STATUS=""
REASON=""
while kill -0 "$PID" 2>/dev/null; do
  sleep "$POLL_INTERVAL"
  kill -0 "$PID" 2>/dev/null || break
  NOW=$(date +%s); ELAPSED=$((NOW - START))
  SIZE=$(wc -c < "$RAW_OUT" 2>/dev/null || echo 0)
  if [[ "$SIZE" -gt "$LAST_SIZE" ]]; then LAST_SIZE=$SIZE; STALL=0; else STALL=$((STALL + POLL_INTERVAL)); fi
  if [[ "$ELAPSED" -ge "$HARD_TIMEOUT" ]]; then
    kill_tree "$PID"
    STATUS="fail"
    REASON="timeout(${HARD_TIMEOUT}s) 도달 — 출력 ${SIZE}B (자라는 중이면 --timeout 상향, 정지 상태면 stdin-deadlock 의심)"
    break
  fi
  if [[ "$STALL" -ge "$STALL_LIMIT" ]]; then
    kill_tree "$PID"
    STATUS="fail"
    REASON="무진행(${STALL_LIMIT}s) 감지 — stdin-deadlock 의심"
    break
  fi
done

if [[ -z "$STATUS" ]]; then
  wait "$PID"; RC=$?
  NOW=$(date +%s); ELAPSED=$((NOW - START))
  SIZE=$(wc -c < "$RAW_OUT" 2>/dev/null || echo 0)
  if grep -qiE 'rate limit|usage limit|quota exceeded' "$RAW_OUT" 2>/dev/null; then
    STATUS="limit"
    REASON="사용량 한도 문구 감지"
  elif [[ "$RC" -ne 0 ]]; then
    STATUS="fail"
    REASON="codex exit ${RC}"
  else
    STATUS="ok"
    REASON=""
  fi
  log_line "$STATUS" "$ELAPSED" "$SIZE" "$REASON"
else
  NOW=$(date +%s); ELAPSED=$((NOW - START))
  SIZE=$(wc -c < "$RAW_OUT" 2>/dev/null || echo 0)
  log_line "$STATUS" "$ELAPSED" "$SIZE" "$REASON"
fi

# limit 은 exit 코드와 무관하게 출력 문구로도 잡는다(타임아웃 경로 제외 — 그쪽은 출력이 불완전)
if [[ "$STATUS" != "fail" ]] && grep -qiE 'rate limit|usage limit|quota exceeded' "$RAW_OUT" 2>/dev/null; then
  STATUS="limit"
  REASON="사용량 한도 문구 감지"
fi

write_report "$RAW_OUT" ""

if [[ "$STATUS" == "ok" ]]; then
  VERDICT="$(grep -Eo 'Verdict:[[:space:]]*(PASS|BLOCK|UNKNOWN)' "$RAW_OUT" 2>/dev/null | tail -1 | sed -E 's/.*(PASS|BLOCK|UNKNOWN).*/\1/')"
  [[ -z "$VERDICT" ]] && VERDICT="UNKNOWN"
  BLOCKERS="$(grep -Ec '^[[:space:]]*([0-9]+\.[[:space:]]*|[-*][[:space:]]*)?BLOCKER' "$RAW_OUT" 2>/dev/null)"
  [[ -z "$BLOCKERS" ]] && BLOCKERS=0
  emit_result "ok" "$BLOCKERS" "$VERDICT" "$OUT_PATH" "$FILES_COUNT" ""
  exit 0
fi

emit_result "$STATUS" 0 "UNKNOWN" "$OUT_PATH" "$FILES_COUNT" "$REASON"
exit 1
