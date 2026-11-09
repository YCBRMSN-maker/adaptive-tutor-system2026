"""LLM 错误定位用的 prompt。

设计要点：
1. 强制 JSON 输出，方便前端把行号标到编辑器上
2. 明确禁止给出完整正确代码，只讲逻辑
3. 先判断"有没有写实际逻辑"，避免对空代码强行编造错误
4. 最多 3 处，防止刷屏
"""

from __future__ import annotations

MAX_CODE_CHARS = 3000   # 代码太长就截断，避免超出上下文
MAX_DESC_CHARS = 1200

SYSTEM_PROMPT = """你是一位 C 语言编程课的助教，负责帮学生定位"答案错误"的原因。

工作准则：
1. 只讲逻辑，**绝对不要输出完整可运行的正确代码**，也不要输出可以直接复制粘贴的多行代码块。
   可以描述"这一行应该改成让 i 从 0 开始"这种思路，但不能写成完整的程序。
2. 定位必须具体到行号。行号以学生代码的实际行数为准（从 1 开始，空行也算）。
3. 最多指出 3 处问题，按重要性排序。不要面面俱到。
4. 说明"为什么错"时，要讲清逻辑和因果关系，不要只写"这里错了"。
5. 如果学生的代码几乎没有实际计算逻辑（只有框架、只有输入没有处理），
   不要编造错误，直接把 no_logic 设为 true。
6. 只输出 JSON，不要加 markdown 代码围栏，不要加任何解释性文字。"""

OUTPUT_SPEC = """请严格按下面的 JSON 结构输出：

{
  "no_logic": false,
  "summary": "一句话概括主要问题（不超过 40 字）",
  "errors": [
    {
      "line": 5,
      "type": "错误类型（简短，如：循环边界 / 变量未初始化 / 条件写反 / 类型不匹配）",
      "why": "为什么这一行有问题（1-2 句，讲清逻辑）"
    }
  ]
}

如果代码没有实际逻辑，只输出：
{"no_logic": true, "summary": "说明学生还没写出实际计算逻辑", "errors": []}"""


def build_diagnose_messages(problem: dict, code: str, case: dict | None) -> list[dict]:
    """构造发给 LLM 的消息列表。

    problem: 题目信息（title / description / input_description / output_description）
    code: 学生代码
    case: 失败的那个测试点 {"index", "input", "expected", "actual"}
    """
    desc = (problem.get("description") or "").strip()
    if len(desc) > MAX_DESC_CHARS:
        desc = desc[:MAX_DESC_CHARS] + "..."
    # 题目描述是 HTML，粗略去掉标签，减少无关 token
    import re
    desc = re.sub(r"<[^>]+>", "", desc)
    desc = re.sub(r"\n{3,}", "\n\n", desc).strip()

    code_text = code if len(code) <= MAX_CODE_CHARS else code[:MAX_CODE_CHARS] + "\n...（已截断）"

    parts = [
        f"【题目】{problem.get('title', '')}",
        desc,
    ]

    if problem.get("input_description"):
        parts.append("【输入格式】" + re.sub(r"<[^>]+>", "", problem["input_description"]).strip())
    if problem.get("output_description"):
        parts.append("【输出格式】" + re.sub(r"<[^>]+>", "", problem["output_description"]).strip())

    samples = problem.get("samples") or []
    if samples:
        block = []
        for i, s in enumerate(samples[:2], 1):
            block.append(f"样例{i} 输入：{s.get('input', '')}\n样例{i} 输出：{s.get('output', '')}")
        parts.append("【样例】\n" + "\n".join(block))

    # 给出行号，方便模型对齐（否则它数行容易错）
    numbered = "\n".join(f"{i:>3}| {ln}" for i, ln in enumerate(code_text.split("\n"), 1))
    parts.append("【学生代码（左侧是行号）】\n" + numbered)

    if case:
        parts.append(
            "【失败的测试点】\n"
            f"输入：\n{case.get('input', '').strip()}\n"
            f"学生的输出：\n{case.get('actual', '').strip() or '（空）'}\n"
            f"期望输出：\n{case.get('expected', '').strip()}"
        )
        if case.get("message"):
            parts.append("【比对结果】" + str(case["message"]))

    parts.append(OUTPUT_SPEC)

    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(parts)},
    ]
