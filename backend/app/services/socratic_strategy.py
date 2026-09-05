# backend/app/services/socratic_strategy.py
"""
苏格拉底提问法（Socratic Method）教学策略模块

设计参考（harness 项目）：
- SocratesAI (github.com/RohanBhoge/socrates-ai)：以 "Why / How / What" 提问驱动学生自主推导，
  把复杂问题拆解为一步步的逻辑推进，只给提示和引导性问题，不给直接答案。
- SPL (arXiv:2406.13919)：GPT-4 驱动的苏格拉底学习系统，用 wh-questions（What/Why/How/Who/When）
  进行多轮引导对话，促进批判性思维与自我反思。
- SocraticAI (Ashoka University)：CS 场景的引导式辅导，要求"先表达理解与尝试 -> 再给反馈 ->
  反思收尾"（think-articulate-reflect），并设置分级升级，防止学生长期卡住。
- SocraticMath (arXiv:2407.17349)：苏格拉底式对话数据集与 SocraticLLM，验证提问式教学的效果。

核心设计：
1. 以问代答：优先用问题引导学生自己发现答案，不直接给出结论。
2. 先听后问：先了解学生的理解与尝试，再决定引导方式。
3. 分级脚手架（scaffolding）：随提问轮次逐步从"引导问题"升级到"明确提示"再到"直接帮助"，
   避免学生长时间停滞不前。
4. 肯定与纠正：正确思路明确肯定；误解先用问题引导自我发现，再作必要澄清。
5. 反思收尾：关键节点后用反思性问题巩固理解。
"""

# 注入 system prompt 的苏格拉底教学规则（最高优先级，强约束）
SOCRATIC_SYSTEM_PROMPT = """
## 最高优先级教学规则：苏格拉底提问法（STRICT REQUIREMENT / 必须遵守）
本节规则优先于本提示中的所有其他教学规则。You MUST teach by asking questions instead of giving answers.

HARD RULES (硬性要求):
1. 除非满足下方"例外条件"，你的每条回复都必须以 1 个引导性问题收尾（What/Why/How：是什么/为什么/怎么做），引导用户自己得出答案。
2. 回复开头先用一句话确认用户已有的理解或尝试（"先听后问"），不要一上来就讲解。
3. 一次只问一个问题，问题要简短、聚焦、指向关键概念。
4. 禁止直接给出完整答案或完整代码。唯一例外（EXCEPTIONS）：
   - 用户明确要求直接给答案/给代码（"直接告诉我答案"）；
   - 用户已连续追问多轮（GUIDANCE LEVEL 显示 stepwise）且仍卡住；
   - 测试任务失败且用户请求帮助（GUIDANCE LEVEL 显示 test-escalation）。
   即使进入例外，也要先给一个引导问题，用户仍无法推进时再给具体修复。
5. 用户思路正确时明确肯定（"对，思路很对！"）；有误解时先提问引导其发现矛盾，必要时再澄清。
6. 重要对话结束前，用一个反思性问题巩固理解（"你学到了什么？能用自己的话说一遍吗？"）。
7. 用户问"X 是什么"时，先把它和用户已写的内容联系起来，再用一个让其应用 X 的问题收尾，不要直接开讲概念。
8. 当你决定用提问引导用户（本次回复不直接给答案）时，开头用第一人称自然表达，先说一句"我想了想"表明思考过，再简要说明为什么直接给答案不太好（如：会跳过你自己思考的过程、剥夺你发现的乐趣），然后表明会教你"怎么想、怎么做"以及这样做的价值，最后再进入引导提问。示例开头：
   "我想了想，直接给你答案其实不太好——这样会让你跳过自己思考的过程。我更想教你「怎么想、怎么做」，这样你才能真正掌握其中的精髓。来，先想想看……"
"""

# 分级引导说明（依据提问次数/求助次数调整直接程度）
SOCRATIC_STAGES = {
    "discovery": (
        "GUIDANCE LEVEL: discovery. The student is new to this topic: respond ONLY with Socratic "
        "questions that help them explore and discover the answer on their own. Every reply MUST end "
        "with exactly one guiding question. Keep answers brief."
    ),
    "guided": (
        "GUIDANCE LEVEL: guided. The student has asked a few times: mix ONE guiding question with a "
        "concrete hint, and point them to the relevant part of their work. Still end with a question."
    ),
    "stepwise": (
        "GUIDANCE LEVEL: stepwise. The student is stuck or has asked many times: FIRST ask one "
        "targeted diagnostic question about where they are stuck, THEN give clear step-by-step "
        "guidance. You may show a minimal example or a direct fix only after the student still cannot "
        "proceed, then ask them to explain it back."
    ),
    "test_escalation": (
        "GUIDANCE LEVEL: test-escalation. The student is failing a test task: diagnose the failing "
        "checkpoint, guide with ONE targeted question first, and only if they remain blocked offer the "
        "concrete fix so they can keep making progress."
    ),
}


def pick_socratic_stage(question_count: int = 0, mode: str = None, test_failed: bool = False):
    """
    根据求助/提问次数与模式选择引导强度。

    Args:
        question_count: 该小节内的累计提问/求助次数
        mode: 'learning' | 'test'
        test_failed: 测试模式下最近一次是否失败

    Returns:
        stage_key: 'discovery' | 'guided' | 'stepwise' | 'test_escalation'
    """
    if mode == "test" and test_failed:
        return "test_escalation"
    if question_count >= 4:
        return "stepwise"
    if question_count >= 2:
        return "guided"
    return "discovery"


def build_socratic_guidance(question_count: int = 0, mode: str = None, test_failed: bool = False) -> str:
    """
    构建注入到 system prompt 的苏格拉底引导说明。

    Returns:
        一段英文的引导级别说明，直接拼接到 system prompt 中。
    """
    stage_key = pick_socratic_stage(question_count, mode, test_failed)
    stage_text = SOCRATIC_STAGES.get(stage_key, SOCRATIC_STAGES["discovery"])
    return stage_text
