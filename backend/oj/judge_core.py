"""判题核心：编译、运行、资源限制、输出比对、错误诊断。

相对参考实现的改进：
1. 内存限制（RLIMIT_AS）——防止一次 malloc 打爆容器
2. 进程数限制（RLIMIT_NPROC）——防 fork 炸弹
3. CPU 时间限制（RLIMIT_CPU）+ 墙钟兜底——计时更接近真实复杂度
4. 输出文件大小限制（RLIMIT_FSIZE）——防写爆磁盘
5. 比对改为逐行 rstrip + 去末尾空行——和主流 OJ 一致
6. 编译诊断结构化 + 中文 + 去临时路径
7. 多测试点支持，遇到第一个失败点即停
"""

from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import tempfile
from dataclasses import dataclass, field, asdict
from typing import Optional

from messages import match as match_message

try:
    import resource
except ImportError:  # 非 Linux 平台（比如在 Windows 上做单元测试）
    resource = None


# ------------------------------------------------------------------ 语言配置

LANGUAGES: dict[str, dict] = {
    "C": {
        "file": "main.c",
        "compile": ["gcc", "-std=c11", "-O2", "-Wall", "-o", "prog", "main.c"],
        "run": ["./prog"],
        "check": None,
        "needs_compile": True,
    },
    "C++": {
        "file": "main.cpp",
        "compile": ["g++", "-std=c++17", "-O2", "-Wall", "-o", "prog", "main.cpp"],
        "run": ["./prog"],
        "check": None,
        "needs_compile": True,
    },
    "Python3": {
        "file": "main.py",
        "compile": None,
        "run": ["python3", "main.py"],
        "check": ["python3", "-m", "py_compile", "main.py"],
        "needs_compile": False,
    },
}

COMPILE_TIMEOUT = 20          # 编译最多 20 秒
OUTPUT_FILE_LIMIT = 16 << 20  # 单次运行最多写 16MB 文件
MAX_OUTPUT_CAPTURE = 64 << 10 # 只保留 64KB 输出用于比对和展示


# ------------------------------------------------------------------ 数据结构

@dataclass
class CaseResult:
    index: int
    status: str                  # AC / WA / TLE / RE / MLE
    time_ms: int = 0
    memory_kb: int = 0
    message: str = ""
    actual: str = ""
    expected: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class JudgeResult:
    status: str                  # AC / WA / CE / TLE / RE / MLE / SE
    message: str
    passed: int = 0
    total: int = 0
    time_ms: int = 0
    memory_kb: int = 0
    diagnostics: list[dict] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)
    cases: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ------------------------------------------------------------------ 诊断解析

# 文件:行:列: 级别: 消息
_DIAG_RE = re.compile(
    r"^(?P<file>[^:\n]+):(?P<line>\d+):(?P<col>\d+):\s*"
    r"(?P<sev>fatal error|error|warning|note):\s*(?P<msg>.+)$"
)
# 只保留真正的错误，warning 不阻断编译
_BLOCKING = {"error", "fatal error"}

# 这类报错最容易误伤：本行明明有分号，GCC 却说缺
_SEMI_BEFORE_BRACE = re.compile(r"expected ';' before '\}'")

# 链接阶段的错误格式和编译错误完全不同：没有「文件:行:列」结构，要单独抓
_LINK_UNDEF = re.compile(r"undefined reference to [`'\"]([^'\"`]+)[\"'`]")
_LINK_MULTI = re.compile(r"multiple definition of [`'\"]([^'\"`]+)[\"'`]")


def _parse_link_errors(stderr: str) -> list[dict]:
    """链接器报错（找不到实现 / 重复定义），没有行列号，单独生成诊断。"""
    out: list[dict] = []
    seen: set[str] = set()

    for m in _LINK_UNDEF.finditer(stderr):
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        if name == "main":
            type_zh = "找不到 main 函数"
            explain = ("链接器找不到 main 函数。检查是不是把 main 拼错了（比如写成 mian），"
                       "或者函数名的大小写、参数列表写得不对。")
        else:
            type_zh = "链接错误：找不到实现"
            explain = (f"链接器找不到 `{name}` 的实现。常见原因：函数只写了声明没写函数体、"
                       f"名字拼错、或者编译时漏了包含它的源文件。")
        out.append({
            "line": 0, "col": 0, "severity": "error",
            "raw": f"undefined reference to `{name}'",
            "file": "", "snippet": [],
            "type_zh": type_zh, "category": "link_error",
            "explain": explain, "knowledge": "链接与多文件", "related": [],
        })

    for m in _LINK_MULTI.finditer(stderr):
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        out.append({
            "line": 0, "col": 0, "severity": "error",
            "raw": f"multiple definition of `{name}'",
            "file": "", "snippet": [],
            "type_zh": "符号重复定义", "category": "duplicate_symbol",
            "explain": (f"链接器发现 `{name}` 被定义了多次。常见原因："
                        f"把函数或变量的定义写在了头文件里，被多个源文件包含。"),
            "knowledge": "链接与多文件", "related": [],
        })

    return out


def _code_of(snippet: list[str]) -> str:
    """从 `    6 |     return 0;` 这样的片段里取出代码本身。"""
    if not snippet:
        return ""
    first = snippet[0]
    if "|" in first:
        return first.split("|", 1)[1]
    return first


def _find_unclosed_braces(source: str) -> tuple[list[int], int, int]:
    """用括号栈找出没有闭合的 `{` 所在行（1 基），并返回左右括号总数。

    会先剔除行注释，避免把 `// }` 里的括号算进去。
    """
    if not source:
        return [], 0, 0

    cleaned: list[str] = []
    for line in source.split("\n"):
        idx = line.find("//")
        cleaned.append(line[:idx] if idx >= 0 else line)

    stack: list[int] = []
    opens = closes = 0
    for lineno, line in enumerate(cleaned, 1):
        for ch in line:
            if ch == "{":
                opens += 1
                stack.append(lineno)
            elif ch == "}":
                closes += 1
                if stack:
                    stack.pop()
    return stack, opens, closes


_CJK_PUNCT_TAIL = ("；", "，", "。", "）", "】", "、")


def _ends_with_cjk_punct(line: str) -> bool:
    """这一行去掉 // 注释后，是否以中文全角标点结尾。

    只看行尾，避免把字符串或注释里的全角字符误判成语法错误。
    """
    code = line.split("//")[0].rstrip()
    return code.endswith(_CJK_PUNCT_TAIL)


def _find_fix_line(source: str, err_line: int) -> int:
    """编译器把缺分号报在 err_line，真正要改的一般是上面最近的一条有效语句。

    返回建议修改的行号（1 基），找不到就返回 0。
    """
    if not source:
        return 0
    lines = source.split("\n")
    for i in range(min(err_line - 1, len(lines)) - 1, -1, -1):
        s = lines[i].strip()
        if not s:                       # 空行
            continue
        if s in ("{", "}"):             # 括号单独一行，不是语句
            continue
        if s.startswith("//") or s.startswith("/*") or s.startswith("*"):
            continue
        if s.endswith((";", "{", "}", ":", ",")):
            return 0                    # 这一行看起来是完整的，不要瞎猜
        return i + 1
    return 0


def parse_diagnostics(stderr: str, source: str = "", keep_warning: bool = False) -> list[dict]:
    """把编译器 stderr 拆成结构化诊断，并按中文表翻译。

    source 传进来后，可以修正"编译器的报错行 ≠ 该改的行"这个问题。
    """
    lines = stderr.splitlines()
    out: list[dict] = []
    notes: list[dict] = []

    i = 0
    while i < len(lines):
        m = _DIAG_RE.match(lines[i])
        if not m:
            i += 1
            continue

        severity = m["sev"]
        snippet: list[str] = []
        j = i + 1
        while j < len(lines) and not _DIAG_RE.match(lines[j]) and lines[j].strip():
            snippet.append(lines[j].rstrip())
            j += 1

        item = {
            "line": int(m["line"]),
            "col": int(m["col"]),
            "severity": severity,
            "raw": m["msg"].strip(),
            "file": os.path.basename(m["file"]),   # 去掉临时目录路径
            "snippet": snippet,
            "type_zh": "",
            "category": "",
            "explain": "",
            "knowledge": "",
            "related": [],
        }

        if severity == "note":
            notes.append(item)
        else:
            category, type_zh, explain, knowledge = match_message(item["raw"])

            # 缺分号的定位修正：
            # 编译器通常要读到下一条语句才发现"上一行没结束"，报错行往往不是该改的行。
            # 判据：本行代码末尾已经有分号（半角或全角）→ 问题在上一行。
            # 全角也要算：学生把「；」打上去时以为自己写完了，实际编译器不认。
            if category == "missing_semicolon" and _code_of(snippet).rstrip().endswith((";", "；")):
                fix = _find_fix_line(source, item["line"])
                if fix and fix != item["line"]:
                    item["fix_line"] = fix
                    lines = source.splitlines()
                    prev = lines[fix - 1] if 0 < fix <= len(lines) else ""
                    if _ends_with_cjk_punct(prev):
                        type_zh = "用了中文标点"
                        explain = (
                            f"第 {fix} 行末尾标点是中文全角字符（比如「；」），"
                            f"C 语言只认英文半角「;」。把输入法切到英文，"
                            f"删掉那个符号重新打一次即可。"
                        )
                    else:
                        type_zh = "缺少分号（在上一行）"
                        explain = (
                            f"编译器把错误报在第 {item['line']} 行，但那一行本身是有分号的。"
                            f"真正要改的是第 {fix} 行——那条语句没有用分号结束，"
                            f"编译器一直读到第 {item['line']} 行才发现不对。"
                        )
                else:
                    type_zh = "语句没有正确结束"
                    explain = ("这一行本身已经有分号了，问题多半在上一行的括号没有闭合、"
                               "或者上一条语句没有正确结束。")

            # 花括号未闭合：GCC 只报"文件末尾还有代码块没结束"，不告诉你是哪个 {
            # 这里用括号栈自己算出来，直接指到具体行
            if "expected declaration or statement at end of input" in item["raw"]:
                unclosed, opens, closes = _find_unclosed_braces(source)
                if unclosed:
                    where = "、".join(f"第 {n} 行" for n in unclosed)
                    item["fix_line"] = unclosed[-1]
                    type_zh = "花括号没有闭合"
                    explain = (
                        f"代码里 {{ 有 {opens} 个，}} 只有 {closes} 个，少了 {opens - closes} 个。"
                        f"还没有闭合的是 {where} 的 {{ 。"
                        f"注意：被 // 注释掉的括号不算数。"
                    )

            if category == "unknown":
                # 兜底文案里把编译器原文嵌进去，不要让学生去找不存在的"下面的信息"
                explain = explain.replace("{raw}", item["raw"])
            else:
                # 命中规则的：中文解释 + 编译器原文，方便对照
                explain = f"{explain}\n\n编译器原文：{item['raw']}"

            item.update(category=category, type_zh=type_zh,
                        explain=explain, knowledge=knowledge)
            out.append(item)

        i = j

    # 把 note 挂到最近一条 error 上（例如"重复定义"指向原始定义行）
    for note in notes:
        if not out:
            continue
        out[-1]["related"].append({
            "line": note["line"],
            "col": note["col"],
            "message": note["raw"],
        })

    if not keep_warning:
        errors = [d for d in out if d["severity"] in _BLOCKING]
        out = errors or out

    # 链接阶段的错误格式和编译错误不同，单独抓一遍补进来
    out.extend(_parse_link_errors(stderr))

    # 去重：同一个位置同一条消息，GCC 有时会重复报（比如多个 { 都没闭合）
    seen: set[tuple] = set()
    uniq: list[dict] = []
    for d in out:
        key = (d["line"], d["col"], d["raw"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(d)

    return uniq


# ------------------------------------------------------------------ 资源限制

def _make_preexec(cpu_seconds: int, mem_bytes: int, is_python: bool):
    """在子进程 exec 之前套上内核级资源限制。"""
    def _fn():
        if resource is None:
            return
        try:
            # CPU 时间：到点先发 SIGXCPU，再超 1 秒发 SIGKILL
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
            # 地址空间（Python 解释器本身就要几十 MB，给宽一点）
            if not is_python:
                resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
            # 进程数：防 fork 炸弹
            resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
            # 单文件写入大小
            resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_FILE_LIMIT, OUTPUT_FILE_LIMIT))
            # 不产生 core dump
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        except Exception:
            pass
    return _fn


def _child_usage() -> tuple[float, int]:
    """累计的子进程 CPU 时间（秒）和内存峰值（KB）。"""
    if resource is None:
        return 0.0, 0
    u = resource.getrusage(resource.RUSAGE_CHILDREN)
    return u.ru_utime + u.ru_stime, u.ru_maxrss


# ------------------------------------------------------------------ 输出比对

def normalize(text: str) -> str:
    """逐行去掉行尾空白，再去掉末尾空行。和主流 OJ 的比对规则一致。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.rstrip() for ln in text.split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines)


def first_diff(actual: str, expected: str) -> str:
    a, e = actual.split("\n"), expected.split("\n")
    for i, (x, y) in enumerate(zip(a, e), start=1):
        if x != y:
            col = next((k + 1 for k, (p, q) in enumerate(zip(x, y)) if p != q),
                       min(len(x), len(y)) + 1)
            return f"第 {i} 行第 {col} 个字符开始不同：期望 {y!r}，实际 {x!r}"
    if len(a) != len(e):
        return f"输出行数不同：期望 {len(e)} 行，实际 {len(a)} 行"
    return "输出内容不一致"


# ------------------------------------------------------------------ 编译

def compile_source(source: str, language: str, workdir: str) -> tuple[bool, list[dict], str]:
    cfg = LANGUAGES[language]
    src_path = os.path.join(workdir, cfg["file"])
    with open(src_path, "w", encoding="utf-8") as f:
        f.write(source)

    env = os.environ.copy()
    env["LC_ALL"] = "C"      # 强制英文诊断，否则中文 locale 下正则失效
    env["LANG"] = "C"

    if not cfg["needs_compile"]:
        proc = subprocess.run(cfg["check"], capture_output=True, text=True,
                              timeout=COMPILE_TIMEOUT, env=env, cwd=workdir)
        if proc.returncode == 0:
            return True, [], ""
        diag = _parse_python_error(proc.stderr)
        return False, diag, proc.stderr

    proc = subprocess.run(cfg["compile"], capture_output=True, text=True,
                          timeout=COMPILE_TIMEOUT, env=env, cwd=workdir)
    diags = parse_diagnostics(proc.stderr, source=source, keep_warning=True)

    if proc.returncode == 0:
        # 编译通过，但可能有 warning（比如 int a = "Hello"），留给自己展示
        warns = [d for d in diags if d["severity"] == "warning"]
        return True, warns, proc.stderr

    errors = [d for d in diags if d["severity"] != "warning"]
    return False, errors or diags, proc.stderr


def _parse_python_error(stderr: str) -> list[dict]:
    m = re.search(r'File "(.+?)", line (\d+)', stderr)
    line_no = int(m.group(2)) if m else 0
    msg_m = re.search(r"(SyntaxError|IndentationError|TabError): (.+)", stderr)
    raw = msg_m.group(2).strip() if msg_m else stderr.strip().splitlines()[-1][:200]
    category, type_zh, explain, knowledge = match_message(raw)
    explain = explain.replace("{raw}", raw)
    return [{
        "line": line_no, "col": 0, "severity": "error", "raw": raw,
        "file": "main.py", "snippet": [],
        "type_zh": type_zh or "语法错误",
        "category": category or "syntax_error",
        "explain": explain or "Python 在解析这段代码时发现语法不符合规则。",
        "knowledge": knowledge or "语法结构",
        "related": [],
    }]


def _parse_python_runtime(stderr: str) -> str:
    """从 Python 的 traceback 里提炼一句话，用于 RE 的提示。

    形如：
        Traceback (most recent call last):
          File "main.py", line 2, in <module>
            print(a + c)
        NameError: name 'c' is not defined
    """
    lines = [ln for ln in stderr.strip().splitlines() if ln.strip()]
    if not lines:
        return ""

    last = lines[-1]
    if not re.match(r"(\w+Error|\w+Exception):", last):
        return ""

    line_no = 0
    for ln in lines:
        fm = re.search(r'File ".*?", line (\d+)', ln)
        if fm:
            line_no = int(fm.group(1))

    _cat, type_zh, explain, knowledge = match_message(last)
    loc = f"第 {line_no} 行：" if line_no else ""
    return f"{loc}{type_zh} · {knowledge} —— {explain}\n\n编译器原文：{last}"


def _translate_unknown(diags: list[dict]) -> list[dict]:
    """兜底的编译错误（没命中任何规则）调大模型翻译成中文。

    只在真的没规则可用时才触发，一次判题最多调一次。
    翻译失败不影响判题结果，保留原文即可。
    """
    unknown = [d for d in diags if d.get("category") == "unknown"]
    if not unknown:
        return diags

    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        print("[translate] 没有配置 DEEPSEEK_API_KEY，跳过翻译", flush=True)
        return diags

    print(f"[translate] 有 {len(unknown)} 条兜底错误待翻译", flush=True)

    try:
        import httpx

        base = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
        model = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
        raws = [d["raw"] for d in unknown]

        prompt = (
            "下面是 C 语言编译器报错的英文原文，请逐条翻译成中文。\n"
            "要求：\n"
            "1. 直译技术含义，保留原有的标识符、类型名和符号\n"
            "2. 每条翻译占一行，顺序和原文一致\n"
            "3. 不要加编号，不要解释，只给译文\n\n"
            + "\n".join(raws)
        )

        resp = httpx.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
                "max_tokens": 500,
            },
            timeout=20,
        )
        if resp.status_code != 200:
            return diags

        text = resp.json()["choices"][0]["message"]["content"].strip()
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        lines = [re.sub(r"^\d+[.、)]\s*", "", ln) for ln in lines]

        for d, zh in zip(unknown, lines):
            if zh:
                # 只留中文，不再把英文原文堆在下面
                d["explain"] = zh
                print(f"[translate] {d['raw'][:40]} → {zh[:40]}", flush=True)
    except Exception as exc:
        print(f"[translate] 翻译失败: {exc}", flush=True)  # 翻译只是锦上添花，失败了继续用原文

    return diags


# ------------------------------------------------------------------ 运行单个测试点

def run_case(workdir: str, language: str, stdin_data: str,
             time_limit_ms: int, memory_limit_mb: int, index: int) -> CaseResult:
    cfg = LANGUAGES[language]
    is_py = language == "Python3"

    cpu_limit = max(1, int(time_limit_ms / 1000) + 1)
    wall_limit = (time_limit_ms + (2000 if is_py else 300)) / 1000.0
    mem_bytes = memory_limit_mb * 1024 * 1024

    cpu_before, _ = _child_usage()

    try:
        proc = subprocess.run(
            cfg["run"],
            input=stdin_data.encode("utf-8", "replace"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=wall_limit,
            cwd=workdir,
            preexec_fn=_make_preexec(cpu_limit, mem_bytes, is_py),
        )
    except subprocess.TimeoutExpired:
        return CaseResult(index=index, status="TLE", time_ms=time_limit_ms,
                          message=f"运行时间超过 {time_limit_ms} ms，已强制终止")
    except Exception as exc:
        return CaseResult(index=index, status="RE", message=f"启动失败：{exc}")

    cpu_after, mem_kb = _child_usage()
    cpu_ms = int((cpu_after - cpu_before) * 1000)
    time_ms = cpu_ms if cpu_ms > 0 else 0

    stdout = proc.stdout[:MAX_OUTPUT_CAPTURE].decode("utf-8", "replace")
    stderr = proc.stderr[:MAX_OUTPUT_CAPTURE].decode("utf-8", "replace")

    # 被信号终止
    if proc.returncode < 0:
        sig = -proc.returncode
        if sig in (signal.SIGXCPU, signal.SIGKILL):
            if mem_kb and mem_kb > memory_limit_mb * 1024:
                return CaseResult(index=index, status="MLE", time_ms=time_ms,
                                  memory_kb=mem_kb,
                                  message=f"内存使用 {mem_kb} KB，超过限制 {memory_limit_mb} MB")
            return CaseResult(index=index, status="TLE", time_ms=time_ms,
                              memory_kb=mem_kb,
                              message=f"CPU 时间超过 {time_limit_ms} ms，被系统终止")
        name = signal.Signals(sig).name if sig in signal.Signals._value2member_map_ else str(sig)
        hint = {
            "SIGSEGV": "段错误：多半是数组越界、访问空指针或无限递归导致栈溢出。",
            "SIGFPE": "算术错误：常见于除以 0 或整数溢出。",
            "SIGABRT": "程序主动中止：可能是断言失败或内存越界被运行时检查拦下。",
        }.get(name, "程序异常终止。")
        return CaseResult(index=index, status="RE", time_ms=time_ms, memory_kb=mem_kb,
                          message=f"{name}：{hint}", actual=stderr[:500])

    if proc.returncode != 0:
        msg = f"程序以返回码 {proc.returncode} 退出"
        if is_py:
            hint = _parse_python_runtime(stderr)
            if hint:
                msg = hint
        return CaseResult(index=index, status="RE", time_ms=time_ms, memory_kb=mem_kb,
                          message=msg, actual=stderr[:500])

    return CaseResult(index=index, status="AC", time_ms=time_ms, memory_kb=mem_kb,
                      actual=stdout)


# ------------------------------------------------------------------ 统一入口

STATUS_TEXT = {
    "AC": "全部通过",
    "WA": "答案错误",
    "CE": "编译错误",
    "TLE": "运行超时",
    "RE": "运行时错误",
    "MLE": "内存超限",
    "SE": "系统错误",
}


def judge(source: str, language: str, tests: list[dict],
          time_limit_ms: int = 1000, memory_limit_mb: int = 256) -> JudgeResult:
    """判一道题。

    tests 形如 [{"input": "1 1\\n", "output": "2\\n"}, ...]
    """
    if language not in LANGUAGES:
        return JudgeResult(status="SE", message=f"暂不支持的语言：{language}")

    if not tests:
        return JudgeResult(status="SE", message="这道题还没有配置测试数据")

    exe = LANGUAGES[language]["run"][0]
    if exe.startswith("./"):
        if not shutil.which("gcc" if language == "C" else "g++"):
            return JudgeResult(status="SE", message="运行环境缺少编译器")
    elif not shutil.which(exe):
        return JudgeResult(status="SE", message=f"运行环境缺少 {exe}")

    workdir = tempfile.mkdtemp(prefix="syncoj_")
    try:
        ok, diags, _raw = compile_source(source, language, workdir)
        if not ok:
            # 没命中规则的报错，补一句中文翻译（命中规则的不会走这里）
            diags = _translate_unknown(diags)
            first = diags[0] if diags else None
            msg = "编译失败"
            if first:
                if first["line"]:
                    loc = f"第 {first['line']} 行"
                    if first["col"]:
                        loc += f" 第 {first['col']} 列"
                    msg = f"{loc}：{first['type_zh']}"
                else:
                    # 链接错误没有行列号
                    msg = first["type_zh"]
            return JudgeResult(status="CE", message=msg, diagnostics=diags,
                               total=len(tests))

        warnings = diags  # 编译通过时，diags 里装的是 warning

        results: list[CaseResult] = []
        max_time = 0
        max_mem = 0
        for idx, case in enumerate(tests, start=1):
            r = run_case(workdir, language, case.get("input", ""),
                         time_limit_ms, memory_limit_mb, idx)
            max_time = max(max_time, r.time_ms)
            max_mem = max(max_mem, r.memory_kb)

            if r.status == "AC":
                expected = normalize(case.get("output", ""))
                actual = normalize(r.actual)
                if actual != expected:
                    r.status = "WA"
                    r.expected = expected[:2000]
                    r.actual = actual[:2000]
                    r.message = first_diff(actual, expected)

            results.append(r)
            if r.status != "AC":
                break

        passed = sum(1 for r in results if r.status == "AC")
        total = len(tests)
        overall = "AC" if passed == total else results[-1].status

        return JudgeResult(
            status=overall,
            message=f"{STATUS_TEXT.get(overall, overall)}（通过 {passed}/{total}）",
            passed=passed, total=total, time_ms=max_time, memory_kb=max_mem,
            warnings=warnings,
            cases=[r.to_dict() for r in results],
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
