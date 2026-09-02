#!/usr/bin/env python3
"""measure.py 의 unittest 스위트 — 글자수·턴수를 직접 손으로 계산해 둔 합성 JSONL 2세션으로
집계 결과를 검증한다. 픽스처는 이 파일 안에서 임시 디렉터리에 생성한다(체크인 파일 불필요 —
회사·프로젝트 이름 없는 순수 합성 데이터라 굳이 디스크에 남길 필요가 없다).

실행: python scripts/__tests__/test_measure.py
   또는: python -m unittest scripts.__tests__.test_measure -v  (scripts/ 가 패키지가 아니므로 전자 권장)
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import measure  # noqa: E402  (경로 삽입 뒤에 import)

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "measure.py"


def _line(**kwargs) -> str:
    return json.dumps(kwargs, ensure_ascii=False)


def _assistant(ts: str, input_tokens: int, cache_read: int, content: list[dict] | None = None) -> str:
    return _line(
        type="assistant",
        timestamp=ts,
        message={
            "usage": {
                "input_tokens": input_tokens,
                "cache_read_input_tokens": cache_read,
                "output_tokens": 1,
            },
            "content": content or [],
        },
    )


def _tool_use(tool_id: str, name: str, **input_fields) -> dict:
    return {"type": "tool_use", "id": tool_id, "name": name, "input": input_fields}


def _user_tool_result(ts: str, tool_use_id: str, content) -> str:
    return _line(
        type="user",
        timestamp=ts,
        message={"content": [{"type": "tool_result", "tool_use_id": tool_use_id, "content": content}]},
    )


def build_fixture_dir(tmpdir: str) -> Path:
    """세션 A(2026-08-01, 3턴) + 세션 B(2026-08-10, 2턴)를 생성한다. 기대값은 이 함수의 docstring 대신
    각 테스트 메서드 위 주석에 손계산으로 적어 둔다 — 숫자를 바꿀 땐 그 계산도 같이 바꿔야 한다.
    """
    d = Path(tmpdir)

    # ---- 세션 A: 11111111-....jsonl, 2026-08-01, 3턴 ----
    # turn1: ctx=100+900=1000, tool_use Read(CLAUDE.md)+Skill(jira-plan) 동시 발동,
    #        결과는 문자열 30자 -> items (1, "claude-md", 30)
    # turn2: ctx=50+200=250, tool_use Bash(command="python scripts/foo.py"),
    #        결과는 텍스트블록 리스트(20+20=40자) -> items (2, "code", 40)
    # turn3: ctx=200+100=300, tool_use 없음(순수 텍스트 응답)
    a_lines = [
        _assistant(
            "2026-08-01T10:00:00Z", 100, 900,
            content=[
                _tool_use("u1", "Read", file_path="CLAUDE.md"),
                _tool_use("u1b", "Skill", skill="jira-plan"),
            ],
        ),
        _user_tool_result("2026-08-01T10:00:01Z", "u1", "x" * 30),
        _assistant(
            "2026-08-01T10:01:00Z", 50, 200,
            content=[_tool_use("u2", "Bash", command="python scripts/foo.py")],
        ),
        _user_tool_result("2026-08-01T10:01:01Z", "u2", [{"type": "text", "text": "y" * 20}, {"type": "text", "text": "y" * 20}]),
        _assistant("2026-08-01T10:02:00Z", 200, 100),
    ]
    (d / "11111111-aaaa-bbbb-cccc-000000000001.jsonl").write_text("\n".join(a_lines) + "\n", encoding="utf-8")

    # ---- 세션 B: 22222222-....jsonl, 2026-08-10, 2턴 ----
    # turn1: ctx=10+10=20, tool_use Grep(pattern="TODO")+Skill(harness-review),
    #        결과 문자열 15자 -> items (1, "other", 15)  ("TODO" 는 어떤 카테고리에도 안 걸림)
    # turn2: ctx=5+5=10, tool_use Read(docs/wiki/domain-repair.md)+Skill(jira-plan),
    #        결과 텍스트블록 리스트(10+10=20자) -> items (2, "wiki-synthesis", 20)
    b_lines = [
        _assistant(
            "2026-08-10T09:00:00Z", 10, 10,
            content=[
                _tool_use("v1", "Grep", pattern="TODO"),
                _tool_use("v1b", "Skill", skill="harness-review"),
            ],
        ),
        _user_tool_result("2026-08-10T09:00:01Z", "v1", "z" * 15),
        _assistant(
            "2026-08-10T09:01:00Z", 5, 5,
            content=[
                _tool_use("v2", "Read", file_path="docs/wiki/domain-repair.md"),
                _tool_use("v2b", "Skill", skill="jira-plan"),
            ],
        ),
        _user_tool_result("2026-08-10T09:01:01Z", "v2", [{"type": "text", "text": "w" * 10}, {"type": "text", "text": "w" * 10}]),
    ]
    (d / "22222222-dddd-eeee-ffff-000000000002.jsonl").write_text("\n".join(b_lines) + "\n", encoding="utf-8")

    return d


class ParseSessionTests(unittest.TestCase):
    """세션 단위 파싱(병합 이전)을 검증 — 집계 버그와 파싱 버그를 구분해서 잡기 위함."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = build_fixture_dir(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_session_a_turns_and_context(self):
        s = measure.parse_session(self.dir / "11111111-aaaa-bbbb-cccc-000000000001.jsonl")
        self.assertIsNotNone(s)
        self.assertEqual(s.n_turns, 3)
        self.assertEqual(s.ctx_values, [1000, 250, 300])
        self.assertEqual(s.first_ts, "2026-08-01T10:00:00Z")

    def test_session_a_skill_counts_and_items(self):
        s = measure.parse_session(self.dir / "11111111-aaaa-bbbb-cccc-000000000001.jsonl")
        self.assertEqual(s.skill_counts, {"jira-plan": 1})
        self.assertEqual(s.items, [(1, "claude-md", 30), (2, "code", 40)])

    def test_session_b_turns_and_context(self):
        s = measure.parse_session(self.dir / "22222222-dddd-eeee-ffff-000000000002.jsonl")
        self.assertIsNotNone(s)
        self.assertEqual(s.n_turns, 2)
        self.assertEqual(s.ctx_values, [20, 10])

    def test_session_b_skill_counts_and_items(self):
        s = measure.parse_session(self.dir / "22222222-dddd-eeee-ffff-000000000002.jsonl")
        self.assertEqual(s.skill_counts, {"harness-review": 1, "jira-plan": 1})
        self.assertEqual(s.items, [(1, "other", 15), (2, "wiki-synthesis", 20)])

    def test_categorize_examples(self):
        self.assertEqual(measure._categorize("CLAUDE.md"), "claude-md")
        self.assertEqual(measure._categorize("docs/wiki/foo.md"), "wiki-synthesis")
        self.assertEqual(measure._categorize("src/Foo-dev-guide.md"), "dev-guide")
        self.assertEqual(measure._categorize("python scripts/foo.py"), "code")
        self.assertEqual(measure._categorize("TODO"), "other")
        self.assertEqual(measure._categorize("docs\\INDEX.md"), "wiki-catalog")  # 역슬래시 경로도 인식

    def test_empty_file_returns_none(self):
        empty = self.dir / "empty.jsonl"
        empty.write_text("", encoding="utf-8")
        self.assertIsNone(measure.parse_session(empty))

    def test_malformed_lines_are_skipped_not_fatal(self):
        p = self.dir / "malformed.jsonl"
        p.write_text("not json at all\n" + _assistant("2026-08-01T00:00:00Z", 1, 1) + "\n", encoding="utf-8")
        s = measure.parse_session(p)
        self.assertIsNotNone(s)
        self.assertEqual(s.n_turns, 1)


class AggregateTests(unittest.TestCase):
    """두 세션을 합친 aggregate() 결과 — 손으로 미리 계산한 값과 대조."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = build_fixture_dir(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_session_count_and_turns(self):
        report = measure.aggregate(self.dir, since=None)
        self.assertEqual(report["session_count"], 2)
        self.assertEqual(report["files_scanned"], 2)
        # turn_counts = [3, 2] -> median 2.5, mean 2.5
        self.assertEqual(report["turns_per_session"]["median"], 2.5)
        self.assertEqual(report["turns_per_session"]["mean"], 2.5)

    def test_context_percentiles(self):
        report = measure.aggregate(self.dir, since=None)
        # 합친 ctx_values 정렬: [10, 20, 250, 300, 1000] (5개)
        # p50: idx=min(4, int(0.5*5))=2 -> 250 / p90: idx=min(4, int(0.9*5))=4 -> 1000
        cpt = report["context_per_turn"]
        self.assertEqual(cpt["n_turns"], 5)
        self.assertEqual(cpt["p50"], 250)
        self.assertEqual(cpt["p90"], 1000)

    def test_skill_calls_summed_across_sessions(self):
        report = measure.aggregate(self.dir, since=None)
        # jira-plan: 세션A 1회 + 세션B 1회 = 2 / harness-review: 세션B 1회
        self.assertEqual(report["skill_calls"], {"jira-plan": 2, "harness-review": 1})

    def test_fixed_load_by_source_chars_and_percentages(self):
        report = measure.aggregate(self.dir, since=None)
        rows = {r["category"]: r for r in report["fixed_load_by_source"]}
        self.assertEqual(set(rows.keys()), {"claude-md", "code", "other", "wiki-synthesis"})

        # 1회 합계(원본 chars) — 손계산
        self.assertEqual(rows["claude-md"]["chars"], 30)
        self.assertEqual(rows["code"]["chars"], 40)
        self.assertEqual(rows["other"]["chars"], 15)
        self.assertEqual(rows["wiki-synthesis"]["chars"], 20)

        # approx_tokens = chars // 3
        for name, row in rows.items():
            self.assertEqual(row["approx_tokens"], row["chars"] // 3, name)

        # 퍼센트는 같은 공식을 이 테스트에서 독립적으로 재계산해서 비교(스크립트 결과를 맹신하지 않음)
        total_chars = 30 + 40 + 15 + 20
        for name, row in rows.items():
            expected_pct = round(100 * row["chars"] / total_chars, 1)
            self.assertAlmostEqual(row["pct_of_total"], expected_pct, places=6, msg=name)

        # 턴-가중 합계 — 손계산
        # claude-md: turn1 size30 * (n_turns3 - turn_idx1) = 60
        # code:      turn2 size40 * (3-2) = 40
        # other:     turn1 size15 * (2-1) = 15
        # wiki-synthesis: turn2 size20 * (2-2) = 0
        weighted = {"claude-md": 60, "code": 40, "other": 15, "wiki-synthesis": 0}
        weighted_total = sum(weighted.values())
        for name, row in rows.items():
            expected_pct_w = round(100 * weighted[name] / weighted_total, 1)
            self.assertAlmostEqual(row["pct_context_weighted"], expected_pct_w, places=6, msg=name)

    def test_since_filter_keeps_only_later_session(self):
        report = measure.aggregate(self.dir, since="2026-08-05")
        self.assertEqual(report["session_count"], 1)
        self.assertEqual(report["turns_per_session"]["median"], 2)  # 세션 B 만 (2턴)
        self.assertEqual(report["skill_calls"], {"harness-review": 1, "jira-plan": 1})
        rows = {r["category"]: r["chars"] for r in report["fixed_load_by_source"]}
        self.assertEqual(rows, {"other": 15, "wiki-synthesis": 20})  # 세션 A 분(claude-md/code) 제외됨

    def test_since_filter_excludes_all_when_after_both_sessions(self):
        report = measure.aggregate(self.dir, since="2099-01-01")
        self.assertEqual(report["session_count"], 0)
        self.assertEqual(report["turns_per_session"], {"median": 0, "mean": 0})
        self.assertEqual(report["skill_calls"], {})

    def test_date_range(self):
        report = measure.aggregate(self.dir, since=None)
        self.assertEqual(report["date_range"], {"first": "2026-08-01", "last": "2026-08-10"})


class CliTests(unittest.TestCase):
    """실제 CLI(subprocess)로 --json 출력이 유효한 JSON 이고 UTF-8 로 나오는지, 오류 종료 코드가
    맞는지 확인 — parse_session/aggregate 직접 호출과는 별도로 argparse/main() 배선을 검증한다."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = build_fixture_dir(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT_PATH), *args],
            capture_output=True, text=True, encoding="utf-8",
        )

    def test_json_output_is_valid_and_matches_direct_call(self):
        res = self._run("--sessions-dir", str(self.dir), "--json")
        self.assertEqual(res.returncode, 0, res.stderr)
        payload = json.loads(res.stdout)
        self.assertEqual(payload["session_count"], 2)
        self.assertEqual(payload["skill_calls"], {"jira-plan": 2, "harness-review": 1})

    def test_human_output_contains_korean_labels_without_crashing(self):
        res = self._run("--sessions-dir", str(self.dir))
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("세션당 턴 수", res.stdout)
        self.assertIn("스킬 호출 횟수", res.stdout)

    def test_missing_dir_exits_2(self):
        res = self._run("--sessions-dir", str(self.dir / "does-not-exist"))
        self.assertEqual(res.returncode, 2)

    def test_bad_since_format_exits_2(self):
        res = self._run("--sessions-dir", str(self.dir), "--since", "08/05/2026")
        self.assertEqual(res.returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
