"""SQLite 数据层：题目与提交记录。

只用标准库 sqlite3，不引入 ORM。表结构刻意保持扁平，
判题结果整体以 JSON 存在 detail 字段里，方便前端直接渲染。
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

DB_PATH = os.getenv("SYNCOJ_DB", os.path.join(os.path.dirname(__file__), "data", "syncoj.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS problems (
    id                INTEGER PRIMARY KEY,
    title             TEXT NOT NULL,
    description       TEXT DEFAULT '',
    input_description TEXT DEFAULT '',
    output_description TEXT DEFAULT '',
    samples           TEXT DEFAULT '[]',
    tests             TEXT DEFAULT '[]',
    difficulty        TEXT DEFAULT 'Easy',
    time_limit        INTEGER DEFAULT 1000,
    memory_limit      INTEGER DEFAULT 256,
    source            TEXT DEFAULT '',
    sort_order        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS submissions (
    id          TEXT PRIMARY KEY,
    problem_id  INTEGER NOT NULL,
    language    TEXT NOT NULL,
    code        TEXT NOT NULL,
    status      TEXT NOT NULL,
    message     TEXT DEFAULT '',
    detail      TEXT DEFAULT '{}',
    time_ms     INTEGER DEFAULT 0,
    memory_kb   INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL,
    participant_id TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sub_problem ON submissions(problem_id, created_at DESC);
"""


def _ensure_dir() -> None:
    d = os.path.dirname(DB_PATH)
    if d:
        os.makedirs(d, exist_ok=True)


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    _ensure_dir()
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)

        # 兼容老版本数据库：submissions 早期没有 participant_id
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(submissions)")}
        if "participant_id" not in cols:
            conn.execute("ALTER TABLE submissions ADD COLUMN participant_id TEXT DEFAULT ''")

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sub_participant "
            "ON submissions(participant_id, problem_id, created_at DESC)"
        )


# ------------------------------------------------------------------ 题目

def list_problems() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, title, difficulty, time_limit, memory_limit, source, sort_order "
            "FROM problems ORDER BY sort_order, id"
        ).fetchall()
    return [dict(r) for r in rows]


def get_problem(pid: int) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM problems WHERE id = ?", (pid,)).fetchone()
    if not row:
        return None
    p = dict(row)
    p["samples"] = json.loads(p["samples"] or "[]")
    tests = json.loads(p["tests"] or "[]")
    # 测试数据不给前端看，只返回数量
    p["test_count"] = len(tests)
    p.pop("tests", None)
    return p


def get_problem_tests(pid: int) -> list[dict]:
    with connect() as conn:
        row = conn.execute("SELECT tests FROM problems WHERE id = ?", (pid,)).fetchone()
    if not row:
        return []
    return json.loads(row["tests"] or "[]")


def upsert_problem(p: dict) -> None:
    with connect() as conn:
        conn.execute(
            """INSERT INTO problems
               (id, title, description, input_description, output_description,
                samples, tests, difficulty, time_limit, memory_limit, source, sort_order)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title,
                 description=excluded.description,
                 input_description=excluded.input_description,
                 output_description=excluded.output_description,
                 samples=excluded.samples,
                 tests=excluded.tests,
                 difficulty=excluded.difficulty,
                 time_limit=excluded.time_limit,
                 memory_limit=excluded.memory_limit,
                 source=excluded.source,
                 sort_order=excluded.sort_order""",
            (
                p["id"], p["title"], p.get("description", ""),
                p.get("input_description", ""), p.get("output_description", ""),
                json.dumps(p.get("samples", []), ensure_ascii=False),
                json.dumps(p.get("tests", []), ensure_ascii=False),
                p.get("difficulty", "Easy"), p.get("time_limit", 1000),
                p.get("memory_limit", 256), p.get("source", ""),
                p.get("sort_order", 0),
            ),
        )


def count_problems() -> int:
    with connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM problems").fetchone()[0]


# ------------------------------------------------------------------ 提交

def create_submission(problem_id: int, language: str, code: str, participant_id: str = "") -> str:
    sid = uuid.uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        conn.execute(
            "INSERT INTO submissions "
            "(id, problem_id, language, code, status, message, created_at, participant_id) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (sid, problem_id, language, code, "Pending", "排队中", now, participant_id or ""),
        )
    return sid


def finish_submission(sid: str, result: dict) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE submissions SET status=?, message=?, detail=?, time_ms=?, memory_kb=? WHERE id=?",
            (
                result.get("status", "SE"),
                result.get("message", ""),
                json.dumps(result, ensure_ascii=False),
                result.get("time_ms", 0),
                result.get("memory_kb", 0),
                sid,
            ),
        )


def get_submission(sid: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM submissions WHERE id = ?", (sid,)).fetchone()
    if not row:
        return None
    s = dict(row)
    s["detail"] = json.loads(s["detail"] or "{}")
    s.pop("code", None)
    return s


def get_submission_code(sid: str) -> str | None:
    """单独取提交的代码（get_submission 为了安全不返回代码）。"""
    if not sid:
        return None
    with connect() as conn:
        row = conn.execute("SELECT code FROM submissions WHERE id = ?", (sid,)).fetchone()
    return row["code"] if row else None


def submission_summary(participant_id: str) -> list[dict]:
    """按题目汇总某个学生的提交：尝试次数、是否 AC 过、最后一次时间。"""
    if not participant_id:
        return []
    with connect() as conn:
        rows = conn.execute(
            """SELECT problem_id,
                      COUNT(*) AS attempts,
                      MAX(CASE WHEN status = 'AC' THEN 1 ELSE 0 END) AS solved,
                      MAX(created_at) AS last_at
               FROM submissions
               WHERE participant_id = ?
               GROUP BY problem_id""",
            (participant_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def recent_submissions(limit: int = 20) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, problem_id, language, status, message, time_ms, memory_kb, created_at "
            "FROM submissions ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]
