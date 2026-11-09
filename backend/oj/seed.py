"""把 data/problems.json 灌进 SQLite。可重复执行（按 id upsert）。"""

from __future__ import annotations

import json
import os
import sys

from db import count_problems, init_db, upsert_problem

SEED_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "problems.json")


def main() -> int:
    if not os.path.exists(SEED_PATH):
        print(f"找不到种子文件：{SEED_PATH}", file=sys.stderr)
        return 1

    init_db()
    with open(SEED_PATH, encoding="utf-8") as f:
        problems = json.load(f)

    for p in problems:
        upsert_problem(p)

    total_tests = sum(len(p.get("tests", [])) for p in problems)
    print(f"已导入 {count_problems()} 道题，测试点 {total_tests} 个")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
