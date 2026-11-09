"""SyncOJ 后端：题目、提交判题、AI 助教。

设计取舍：
- 不引入 Redis / Celery。判题放在 FastAPI 的后台任务里跑（线程池执行），
  状态写进 SQLite，前端轮询。这样 `docker compose up` 一个容器就能跑起来，
  别人 clone 下来不需要额外装中间件。
- 如果以后要横向扩展，把 run_judge 换成 Celery 任务即可，接口不用改。
"""

from __future__ import annotations

import json
import os
import re
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import db
from judge_core import STATUS_TEXT, judge
from prompts import build_diagnose_messages

app = FastAPI(title="SyncOJ", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SUPPORTED_LANGUAGES = [
    {"id": "C", "label": "C (gcc 11)"},
    {"id": "C++", "label": "C++ (g++ 17)"},
    {"id": "Python3", "label": "Python 3"},
]


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


# ------------------------------------------------------------------ 模型

class SubmitRequest(BaseModel):
    problem_id: int
    language: str = "C"
    code: str = Field(..., min_length=1)
    participant_id: Optional[str] = None


class ChatRequest(BaseModel):
    message: str
    problem_id: Optional[int] = None
    code: Optional[str] = None


class DiagnoseRequest(BaseModel):
    problem_id: int
    submission_id: Optional[str] = None
    code: Optional[str] = None


# ------------------------------------------------------------------ 判题任务

def run_judge(sid: str, problem_id: int, language: str, code: str) -> None:
    """在后台线程里执行判题，结果写库。"""
    try:
        problem = db.get_problem(problem_id)
        if not problem:
            db.finish_submission(sid, {"status": "SE", "message": "题目不存在"})
            return

        tests = db.get_problem_tests(problem_id)
        result = judge(
            source=code,
            language=language,
            tests=tests,
            time_limit_ms=problem.get("time_limit", 1000),
            memory_limit_mb=problem.get("memory_limit", 256),
        )
        db.finish_submission(sid, result.to_dict())
    except Exception as exc:  # 兜底，避免提交永远停在 Pending
        db.finish_submission(sid, {"status": "SE", "message": f"判题服务异常：{exc}"})


# ------------------------------------------------------------------ 题目接口

@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "problems": db.count_problems()}


@app.get("/api/languages")
def languages() -> list[dict]:
    return SUPPORTED_LANGUAGES


@app.get("/api/problems")
def problems() -> list[dict]:
    return db.list_problems()


@app.get("/api/problems/{pid}")
def problem_detail(pid: int) -> dict:
    p = db.get_problem(pid)
    if not p:
        raise HTTPException(404, "题目不存在")
    return p


# ------------------------------------------------------------------ 章节学习内容
_LESSONS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lessons.json")
_lessons_cache: list[dict] | None = None


def _load_lessons() -> list[dict]:
    global _lessons_cache
    if _lessons_cache is None:
        with open(_LESSONS_PATH, encoding="utf-8") as f:
            _lessons_cache = json.load(f)
    return _lessons_cache


@app.get("/api/lessons")
def list_lessons() -> list[dict]:
    """章节列表（不带正文，减小响应体积）"""
    return [
        {
            "chapter": item["chapter"],
            "key": item["key"],
            "title": item["title"],
            "intro": item["intro"],
            "problem_count": len(item.get("problems", [])),
        }
        for item in _load_lessons()
    ]


@app.get("/api/lessons/{chapter}")
def get_lesson(chapter: int) -> dict:
    for item in _load_lessons():
        if item["chapter"] == chapter:
            return item
    raise HTTPException(404, f"没有第 {chapter} 章")


# ------------------------------------------------------------------ 提交接口

@app.post("/api/submit")
def submit(req: SubmitRequest, bg: BackgroundTasks) -> dict:
    if req.language not in {x["id"] for x in SUPPORTED_LANGUAGES}:
        raise HTTPException(400, f"暂不支持的语言：{req.language}")

    if not db.get_problem(req.problem_id):
        raise HTTPException(404, "题目不存在")

    sid = db.create_submission(req.problem_id, req.language, req.code, req.participant_id or "")
    bg.add_task(run_judge, sid, req.problem_id, req.language, req.code)
    return {"submission_id": sid, "status": "Pending"}


@app.get("/api/submissions/summary")
def submissions_summary(participant_id: str) -> list[dict]:
    """某个学生每道题的最新情况：尝试次数、是否 AC 过。"""
    return db.submission_summary(participant_id)


@app.get("/api/submissions/{sid}")
def submission_detail(sid: str) -> dict:
    s = db.get_submission(sid)
    if not s:
        raise HTTPException(404, "提交不存在")
    return s


@app.get("/api/submissions")
def submissions(limit: int = 20) -> list[dict]:
    return db.recent_submissions(limit)


# ------------------------------------------------------------------ LLM 错误定位

def _effective_lines(code: str) -> int:
    """统计"有实际内容"的行数，用来判断学生是不是还没写东西。"""
    n = 0
    for ln in code.split("\n"):
        s = ln.strip()
        if not s:
            continue
        if s.startswith(("//", "/*", "*", "#")):
            continue
        if s in ("{", "}"):
            continue
        if re.match(r"^(int|void)\s+main\s*\(", s):
            continue
        if s.replace(" ", "") == "return0;":
            continue
        n += 1
    return n


def _extract_json(text: str) -> dict:
    """从模型回复里抠出 JSON，容忍 ```json 围栏和前后多余的话。"""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    i, j = text.find("{"), text.rfind("}")
    if i >= 0 and j > i:
        text = text[i:j + 1]
    return json.loads(text)


def _call_llm(messages: list[dict], max_tokens: int = 900,
              temperature: float = 0.3) -> str:
    """调用 DeepSeek，返回纯文本回复。"""
    import httpx

    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    base = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    model = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

    resp = httpx.post(
        f"{base}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        },
        timeout=60,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:200]}")

    try:
        msg = resp.json()["choices"][0]["message"]
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise RuntimeError(f"模型响应格式异常：{resp.text[:200]}") from exc

    content = (msg.get("content") or "").strip()
    if not content:
        raise RuntimeError("模型返回空内容（可能用了推理模型或 max_tokens 不足）")
    return content


@app.post("/api/diagnose")
def diagnose(req: DiagnoseRequest) -> dict:
    """答案错误之后，用大模型定位是哪几行、错在哪。"""
    if not os.getenv("DEEPSEEK_API_KEY", "").strip():
        return {"ok": False, "error": "未配置大模型接口（DEEPSEEK_API_KEY）"}

    problem = db.get_problem(req.problem_id)
    if not problem:
        raise HTTPException(404, "题目不存在")

    sub = db.get_submission(req.submission_id) if req.submission_id else None
    code = req.code or (db.get_submission_code(req.submission_id)
                        if req.submission_id else None)
    if not code:
        return {"ok": False, "error": "找不到这次提交的代码"}

    # 本地粗筛：只有框架、没有实际逻辑，就不浪费一次模型调用
    if _effective_lines(code) < 2:
        return {
            "ok": True, "no_logic": True, "errors": [],
            "summary": "这段代码还没有实际的计算逻辑，先把题目要求的处理写出来再试。",
        }

    detail = (sub or {}).get("detail") or {}
    cases = detail.get("cases") or []
    failed = next((c for c in cases if c.get("status") != "AC"), None)

    try:
        raw = _call_llm(build_diagnose_messages(problem, code, failed))
        data = _extract_json(raw)
    except Exception as exc:
        return {"ok": False, "error": f"模型调用失败：{exc}"}

    errors: list[dict] = []
    total_lines = len(code.split("\n"))
    for e in (data.get("errors") or [])[:3]:
        try:
            ln = int(e.get("line"))
        except (TypeError, ValueError):
            continue
        if not (1 <= ln <= total_lines):
            continue          # 模型瞎编的行号直接丢掉
        errors.append({
            "line": ln,
            "type": str(e.get("type", "逻辑错误"))[:30],
            "why": str(e.get("why", ""))[:300],
        })

    return {
        "ok": True,
        "no_logic": bool(data.get("no_logic")) or not errors,
        "summary": str(data.get("summary", ""))[:200],
        "errors": errors,
    }


# ------------------------------------------------------------------ AI 助教

def _fallback_reply(req: ChatRequest) -> str:
    """没配大模型时的本地回复：按关键词给固定建议，不编造分析。"""
    msg = (req.message or "").strip()
    lower = msg.lower()

    parts = ["当前未配置大模型接口（DEEPSEEK_API_KEY），以下是根据你的问题给出的固定提示：", ""]

    if any(k in msg for k in ["怎么", "如何", "思路", "不会"]):
        parts.append("**做题思路**：先读输入输出说明，确认数据范围；再用一张纸写出第一个样例的手算过程；")
        parts.append("手算通了，把步骤翻译成代码；先保证能跑，再考虑优化。")
    elif any(k in msg for k in ["错", "报错", "为什么", "调试"]):
        parts.append("**排查顺序**：① 看编译错误给的行号，那里通常是第一个出错点；")
        parts.append("② 如果编译通过但答案错，用一个最小样例手工跑一遍，对比中间变量；")
        parts.append("③ 检查循环边界和初始值，这两处占初学者错误的一半。")
    elif any(k in lower for k in ["复杂度", "超时", "tle"]):
        parts.append("**复杂度判断**：n 在 10^3 以内，O(n²) 可以接受；10^5 必须 O(n log n) 或更好；")
        parts.append("10^7 只能用 O(n)。超时先数循环层数。")
    else:
        parts.append("你可以问我：这道题的思路、某段代码为什么报错、或者某个语法点的用法。")

    return "\n".join(parts)


@app.post("/api/chat")
def chat(req: ChatRequest) -> dict:
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        return {"reply": _fallback_reply(req), "configured": False, "source": "local"}

    try:
        problem = db.get_problem(req.problem_id) if req.problem_id else None
        context = ""
        if problem:
            desc = re.sub(r"<[^>]+>", "", problem.get("description") or "")[:800]
            context = f"\n\n【当前题目】{problem['title']}\n{desc}"
        if req.code:
            context += f"\n\n【学生当前代码】\n```c\n{req.code[:1500]}\n```"

        reply = _call_llm([
            {"role": "system", "content":
             "你是编程教学助手。回答要用初学者能懂的语言，先给结论，再给理由；"
             "不要直接给完整答案，用提问和提示引导学生自己写出来。"},
            {"role": "user", "content": req.message + context},
        ], max_tokens=800, temperature=0.5)

        return {"reply": reply, "configured": True, "source": "deepseek"}
    except Exception as exc:
        return {"reply": f"调用大模型失败：{exc}\n\n{_fallback_reply(req)}",
                "configured": True, "source": "error"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
