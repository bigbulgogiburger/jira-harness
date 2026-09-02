#!/usr/bin/env python3
"""measure.py — Claude Code 세션 JSONL 집계.

<sessions-dir>/*.jsonl 을 읽어 다음을 집계한다:
  - 세션 수
  - 세션당 턴 수(중앙값·평균) — 세션 하나의 assistant 턴 개수 기준
  - 턴당 컨텍스트(p50/p90) — assistant 턴마다 input_tokens + cache_read_input_tokens
  - 스킬 호출 횟수(스킬명별) — Skill 툴 호출의 input.skill 값 기준
  - 고정 적재 추정(컨텍스트 출처별) — 툴 결과로 컨텍스트에 실린 내용을 파일 경로/명령/패턴으로
    분류해 총량(1x)과, 그 뒤로 세션이 몇 턴 더 도는지로 가중한 총량(ctx-weighted)을 함께 낸다.
    분류 규칙은 harness/Claude Code 일반 관례만 담는다(프로젝트 고유 문서명 금지 — 이 스크립트는
    공개 플러그인에 실려 어떤 프로젝트에서든 --sessions-dir 인자만으로 동작해야 한다).

사용:
  python scripts/measure.py --sessions-dir <dir> [--since YYYY-MM-DD] [--json]

종료 코드: 0=정상 출력 · 2=실행 오류(인자·디렉터리 등). 이 스크립트는 게이트가 아니라 집계
도구라 "위반"이라는 개념이 없다 — limit/PASS-FAIL 판정은 memory-index.mjs 쪽 책임이다.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path


def _force_utf8_console() -> None:
    """Windows 콘솔 기본 codepage(cp949)에서는 한글/이모지 출력이 깨진다 — UTF-8 로 강제한다."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


# 툴 결과 컨텍스트를 "어디서 온 내용인가"로 분류하는 규칙(원본 스크립트의 방식 유지 — 정규식
# 카테고리 + 1회 합계/턴-가중 합계 이중 집계). 회사·프로젝트 고유 문서명은 넣지 않는다.
CONTEXT_CATEGORIES: list[tuple[str, "re.Pattern[str]"]] = [
    ("wiki-catalog", re.compile(r"(INDEX\.md|LOG\.md|INDEX-SCHEMA\.md|_wiki-schema\.md)")),
    ("wiki-synthesis", re.compile(r"docs/wiki/")),
    ("dev-guide", re.compile(r"-dev-guide\.md")),
    ("adr-ledger", re.compile(r"(decision-log|adr[-_]|CHANGELOG\.md|ARCHITECTURE\.md)", re.IGNORECASE)),
    ("claude-md", re.compile(r"CLAUDE\.md")),
    ("memory", re.compile(r"/memory/")),
    ("skills", re.compile(r"\.claude/skills/")),
    ("runtime", re.compile(r"\.claude/runtime/")),
    ("ref-docs", re.compile(r"(\.claude/docs/reference/|docs/[^ ]+\.md)")),
    ("code", re.compile(
        r"\.(java|kt|vue|js|mjs|cjs|ts|tsx|jsx|py|go|rb|rs|swift|dart|sql|ya?ml|json|xml|css|scss|sh)"
        r"([^a-z]|$)"
    )),
]

# 컨텍스트에 텍스트를 실어 나르는 것으로 취급할 툴 이름(원본 스크립트와 동일 — 파일/셸/검색류).
TOOL_RESULT_SOURCE_TOOLS = frozenset({"Read", "Bash", "PowerShell", "Grep", "Glob"})

CHARS_PER_TOKEN_APPROX = 3  # 거친 근사치(원본 스크립트의 방식) — CJK/영문 혼용 텍스트 경험칙


def _categorize(key: str) -> str:
    key = key.replace("\\", "/")
    for name, pattern in CONTEXT_CATEGORIES:
        if pattern.search(key):
            return name
    return "other"


@dataclass
class SessionData:
    session_id: str
    n_turns: int
    first_ts: str | None
    last_ts: str | None
    ctx_values: list[int] = field(default_factory=list)
    skill_counts: Counter[str] = field(default_factory=Counter)
    # (turn_index, category, size) — turn_index 는 이 컨텍스트가 실린 assistant 턴 번호(1-based)
    items: list[tuple[int, str, int]] = field(default_factory=list)


def _iter_session_files(sessions_dir: Path) -> list[Path]:
    return sorted(sessions_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)


def _tool_result_size(raw: object) -> int:
    if isinstance(raw, str):
        return len(raw)
    if isinstance(raw, list):
        return sum(len(b.get("text", "")) for b in raw if isinstance(b, dict))
    return 0


def parse_session(path: Path) -> SessionData | None:
    """세션 JSONL 파일 하나를 읽어 SessionData 로 만든다. 내용이 전혀 없으면 None."""
    session_id = path.stem[:8]
    n_turns = 0
    first_ts: str | None = None
    last_ts: str | None = None
    # tool_use.id -> (tool_name, key, turn_index) — 같은 파일 안에서만 유효한 임시 매핑
    pending: dict[str, tuple[str, str, int]] = {}
    ctx_values: list[int] = []
    skill_counts: Counter[str] = Counter()
    items: list[tuple[int, str, int]] = []

    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if not isinstance(rec, dict):
                continue

            ts = rec.get("timestamp")
            if ts:
                first_ts = first_ts or ts
                last_ts = ts

            rtype = rec.get("type")
            msg = rec.get("message") or {}
            if not isinstance(msg, dict):
                continue

            if rtype == "assistant":
                n_turns += 1
                usage = msg.get("usage") or {}
                input_tok = usage.get("input_tokens", 0) or 0
                cache_read = usage.get("cache_read_input_tokens", 0) or 0
                ctx_values.append(int(input_tok) + int(cache_read))

                for block in msg.get("content") or []:
                    if not (isinstance(block, dict) and block.get("type") == "tool_use"):
                        continue
                    name = block.get("name") or "?"
                    tool_input = block.get("input") or {}
                    if not isinstance(tool_input, dict):
                        tool_input = {}
                    if name == "Skill":
                        skill_counts[tool_input.get("skill") or "?"] += 1
                    key = (
                        tool_input.get("file_path")
                        or tool_input.get("command")
                        or tool_input.get("pattern")
                        or tool_input.get("skill")
                        or ""
                    )
                    block_id = block.get("id")
                    if block_id:
                        pending[block_id] = (name, str(key), n_turns)

            elif rtype == "user":
                content = msg.get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if not (isinstance(block, dict) and block.get("type") == "tool_result"):
                        continue
                    origin = pending.get(block.get("tool_use_id"))
                    if not origin:
                        continue
                    name, key, turn_idx = origin
                    if name not in TOOL_RESULT_SOURCE_TOOLS:
                        continue
                    size = _tool_result_size(block.get("content"))
                    items.append((turn_idx, _categorize(key), size))

    if n_turns == 0 and first_ts is None:
        return None  # 빈 파일/파싱 불가 — 세션으로 안 센다

    return SessionData(
        session_id=session_id, n_turns=n_turns, first_ts=first_ts, last_ts=last_ts,
        ctx_values=ctx_values, skill_counts=skill_counts, items=items,
    )


def _percentile(sorted_values: list[int], q: float) -> int:
    if not sorted_values:
        return 0
    idx = min(len(sorted_values) - 1, int(q * len(sorted_values)))
    return sorted_values[idx]


def _fixed_load_report(cat_totals: Counter[str], cat_weighted: Counter[str]) -> list[dict]:
    total = sum(cat_totals.values()) or 1
    weighted_total = sum(cat_weighted.values()) or 1
    rows = []
    for name, chars in cat_totals.most_common():
        rows.append({
            "category": name,
            "chars": chars,
            "approx_tokens": chars // CHARS_PER_TOKEN_APPROX,
            "pct_of_total": round(100 * chars / total, 1),
            "pct_context_weighted": round(100 * cat_weighted[name] / weighted_total, 1),
        })
    return rows


def aggregate(sessions_dir: Path, since: str | None) -> dict:
    files = _iter_session_files(sessions_dir)
    parsed = [parse_session(p) for p in files]
    sessions = [s for s in parsed if s is not None]
    if since:
        sessions = [s for s in sessions if s.first_ts and s.first_ts[:10] >= since]

    ctx_values: list[int] = []
    skill_counts: Counter[str] = Counter()
    cat_totals: Counter[str] = Counter()
    cat_weighted: Counter[str] = Counter()

    for s in sessions:
        ctx_values.extend(s.ctx_values)
        skill_counts.update(s.skill_counts)
        for turn_idx, category, size in s.items:
            cat_totals[category] += size
            cat_weighted[category] += size * max(0, s.n_turns - turn_idx)

    ctx_values.sort()
    turn_counts = [s.n_turns for s in sessions]
    first_dates = sorted(s.first_ts for s in sessions if s.first_ts)
    last_dates = sorted(s.last_ts for s in sessions if s.last_ts)

    return {
        "sessions_dir": str(sessions_dir),
        "since": since,
        "files_scanned": len(files),
        "session_count": len(sessions),
        "date_range": {
            "first": first_dates[0][:10] if first_dates else None,
            "last": last_dates[-1][:10] if last_dates else None,
        },
        "turns_per_session": {
            "median": statistics.median(turn_counts) if turn_counts else 0,
            "mean": round(statistics.fmean(turn_counts), 1) if turn_counts else 0,
        },
        "context_per_turn": {
            "unit": "tokens",
            "basis": "input_tokens + cache_read_input_tokens",
            "p50": _percentile(ctx_values, 0.5),
            "p90": _percentile(ctx_values, 0.9),
            "n_turns": len(ctx_values),
        },
        "skill_calls": dict(skill_counts.most_common()),
        "fixed_load_by_source": _fixed_load_report(cat_totals, cat_weighted),
    }


def _print_human(report: dict) -> None:
    print(f"measure: {report['sessions_dir']}")
    if report["since"]:
        print(f"  --since {report['since']} 이후만")
    dr = report["date_range"]
    print(
        f"  세션 {report['session_count']}개(스캔한 파일 {report['files_scanned']}개)"
        f"  기간 {dr['first']} ~ {dr['last']}"
    )
    tps = report["turns_per_session"]
    print(f"  세션당 턴 수: 중앙값 {tps['median']}  평균 {tps['mean']}")
    cpt = report["context_per_turn"]
    print(
        f"  턴당 컨텍스트({cpt['basis']}, {cpt['n_turns']}턴 기준): "
        f"p50={cpt['p50']:,}  p90={cpt['p90']:,} {cpt['unit']}"
    )
    print("  스킬 호출 횟수:")
    if not report["skill_calls"]:
        print("    (없음)")
    for name, count in report["skill_calls"].items():
        print(f"    {count:5d}  {name}")
    print("  고정 적재 추정(출처별, chars / ~tokens / 1회비중 / 턴가중비중):")
    for row in report["fixed_load_by_source"]:
        print(
            f"    {row['category']:<15s} {row['chars']:>10,d}  ~{row['approx_tokens']:>8,d}tok"
            f"  {row['pct_of_total']:5.1f}%  {row['pct_context_weighted']:5.1f}%"
        )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="measure.py",
        description="Claude Code 세션 JSONL 집계 — 세션당 턴 수·턴당 컨텍스트·스킬 호출·컨텍스트 출처별 고정 적재",
    )
    parser.add_argument("--sessions-dir", required=True, help="세션 JSONL 이 있는 디렉터리(예: ~/.claude/projects/<slug>)")
    parser.add_argument("--since", default=None, help="이 날짜(YYYY-MM-DD) 이후 시작한 세션만 집계")
    parser.add_argument("--json", action="store_true", help="JSON 으로 출력")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    _force_utf8_console()
    args = parse_args(sys.argv[1:] if argv is None else argv)

    if args.since is not None and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.since):
        print(f"measure: --since 는 YYYY-MM-DD 형식이어야 합니다 — 받은 값: {args.since}", file=sys.stderr)
        return 2

    sessions_dir = Path(args.sessions_dir).expanduser().resolve()
    if not sessions_dir.is_dir():
        print(f"measure: 디렉터리가 없습니다 — {sessions_dir}", file=sys.stderr)
        return 2

    report = aggregate(sessions_dir, args.since)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_human(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
