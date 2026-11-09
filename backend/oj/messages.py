"""GCC / Clang 编译诊断的中文映射表。

每条规则：(匹配正则, 类别, 中文类型名, 解释模板, 知识点)

解释模板里的 {line} / {col} / {name} 会在解析时替换。
匹配顺序从上到下，越具体的写在越前面，避免被宽泛规则抢先命中。
"""

from __future__ import annotations

# (pattern, category, type_zh, explain, knowledge)
RULES: list[tuple[str, str, str, str, str]] = [
    # ---------------- 语法：符号缺失 / 不配对 ----------------
    # GCC 遇到"上一条语句没结束"时，会把错误报在下一行第一个标识符处，
    # 文案形如：expected '=', ',', ';', 'asm' or '__attribute__' before 'scanf'
    # 这种情况真正要改的是上一行末尾，归到 missing_semicolon 交给 fix_line 修正
    (r"expected '=', ',', ';', 'asm' or '__attribute__' before", "missing_semicolon",
     "缺少分号",
     "编译器读到这里才发现上一条语句没有结束。真正要改的是上一行末尾——那一行少了分号 ;",
     "语句结束符"),

    (r"expected ';'|expected ',' or ';'", "missing_semicolon",
     "缺少分号",
     "这一行的语句写完后少了分号 ;，编译器会把它和下一行当成同一条语句。",
     "语句结束符"),

    (r"expected '\)'", "missing_bracket",
     "缺少右括号 )",
     "这一行的圆括号没有闭合，少了一个右括号 )。检查这一行的函数调用——每个左括号 ( 都要有对应的右括号 )。",
     "括号配对"),

    (r"expected '\]'", "missing_bracket",
     "缺少右方括号 ]",
     "这一行的数组下标没有闭合，少了一个右方括号 ]。每个 [ 都要有对应的 ]。",
     "括号配对"),

    (r"expected '\}'", "unclosed_brace",
     "花括号没有闭合",
     "这个代码块少了一个 }，函数、if、for、while 的左右大括号必须成对出现。",
     "代码块与作用域"),

    (r"expected declaration or statement at end of input", "unclosed_brace",
     "花括号没有闭合",
     "代码走到文件末尾还有代码块没结束，多半是少写了一个右花括号 }。"
     "注意：被 // 注释掉的 } 不算数。",
     "代码块与作用域"),

    (r"missing terminating .* character", "unterminated_literal",
     "字符串或字符常量没有闭合",
     "字符串要用一对双引号包住，字符要用一对单引号包住，这里只写了一边。",
     "字符串常量"),

    (r"stray '\\\d+' in program", "stray_char",
     "出现了多余的转义字符",
     "代码里有一个不该出现的反斜杠转义，检查字符串里的 \\n、\\t 这些写法。",
     "转义字符"),

    (r"expected expression before", "missing_expression",
     "这里缺少一个表达式",
     "运算符或函数调用前面缺了内容，常见于多写了一个逗号或运算符。",
     "表达式"),

    (r"expected .* before .* token", "syntax_error",
     "语法错误",
     "这里的写法不符合 C 语言语法，编译器在这个位置之前就已经无法继续解析了。",
     "语法结构"),

    # ---------------- 声明与作用域 ----------------
    (r"undeclared \(first use in this function\)", "undeclared_var",
     "使用了未声明的变量",
     "这个变量在使用之前没有定义。C 语言要求先声明类型再使用，比如先写 int x; 再用 x。",
     "变量声明"),

    (r"implicit declaration of function", "missing_include",
     "函数没有声明",
     "调用这个函数前没有包含它所在的头文件。比如用 printf 要 #include <stdio.h>，用 strlen 要 #include <string.h>。",
     "头文件引用"),

    (r"redefinition of", "redefinition",
     "重复定义",
     "同一个名字被定义了两次。常见于同一个作用域里写了两个同名变量，或者把定义写在了头文件里被多次包含。",
     "作用域与重名"),

    (r"conflicting types for", "conflicting_types",
     "类型声明冲突",
     "同一个函数或变量前后声明的类型不一致，检查函数原型和定义是否对得上。",
     "函数声明"),

    (r"previous declaration of .* was here|previous definition of .* here", "redefinition",
     "重复定义",
     "这里之前已经声明或定义过同名对象，和上面那条错误是同一处问题。",
     "作用域与重名"),

    # ---------------- 类型 ----------------
    (r"incompatible types when (assigning|initializing)", "type_mismatch",
     "类型不匹配",
     "等号两边的类型不一致，不能直接赋值。检查是不是把指针赋给了整数、或者把字符串赋给了 char。",
     "数据类型"),

    (r"makes (integer|pointer) from (pointer|integer) without a cast", "type_mismatch",
     "指针和整数之间隐式转换",
     "一边是指针一边是整数，C 语言允许但通常不是你想要的。检查有没有漏写 * 或 &。",
     "指针与类型"),

    (r"assignment to expression with array type|array type .* is not assignable", "assign_to_array",
     "不能对整个数组赋值",
     "数组名代表首地址，不能被整体赋值。要给数组传值只能逐个元素赋值，或者用 memcpy。",
     "数组"),

    (r"invalid operands to binary", "invalid_operand",
     "运算符两边的类型不支持这个运算",
     "比如对结构体做加法、对指针做乘法。检查操作数的类型是否符合该运算符的要求。",
     "运算符与类型"),

    (r"subscripted value is (neither array nor pointer)", "index_non_array",
     "对非数组用了下标",
     "这里用了 a[i] 的写法，但 a 既不是数组也不是指针，检查变量名是不是写错了。",
     "数组"),

    (r"dereferencing pointer to incomplete type", "incomplete_type",
     "使用了不完整的类型",
     "这个结构体只声明了名字，没有定义成员，不能访问它的字段。需要先写完整的 struct 定义。",
     "结构体"),

    # ---------------- 函数 ----------------
    (r"too few arguments to function", "arg_count",
     "函数参数太少",
     "调用这个函数时传的参数个数比声明的少，检查函数原型要几个参数。",
     "函数调用"),

    (r"too many arguments to function", "arg_count",
     "函数参数太多",
     "调用这个函数时传的参数个数比声明的多，检查是不是多写了一个。",
     "函数调用"),

    (r"control reaches end of non-void function", "missing_return",
     "函数缺少返回值",
     "函数声明了有返回值（比如 int），但走到末尾没有 return。每个分支都要保证有返回值。",
     "函数返回值"),

    (r"return type is not allowed|return with a value, in function returning void", "wrong_return",
     "返回值类型不对",
     "void 函数不能 return 一个值，非 void 函数必须 return 一个值。",
     "函数返回值"),

    (r"number of arguments doesn't match prototype", "arg_count",
     "参数个数和声明不一致",
     "函数定义时的参数个数和前面声明的原型不一样。",
     "函数声明"),

    # ---------------- 数组与内存 ----------------
    (r"variable-sized object may not be initialized", "vla_init",
     "变长数组不能初始化",
     "数组长度是变量时不能同时写初始值，先声明再逐个赋值。",
     "数组"),

    (r"size of array .* is too large|array is too large", "array_too_large",
     "数组太大",
     "数组长度超过了编译器的限制，考虑改小，或者用动态分配。",
     "数组"),

    (r"initializer element is not constant", "non_const_init",
     "初始化值不是常量",
     "全局变量的初始值必须是编译期就能确定的常量，不能用变量或函数返回值。",
     "变量初始化"),

    # ---------------- 格式化字符串 ----------------
    (r"format ['\"].*['\"] expects argument of type", "format_mismatch",
     "格式化字符串和参数类型不符",
     "printf / scanf 里的 %d 要求 int，%f 要求 double，%s 要求字符串。检查占位符和后面的参数是否一一对应。",
     "printf 格式符"),

    (r"format .* expects a matching", "format_missing_arg",
     "格式化字符串缺少对应参数",
     "格式串里的占位符比后面传的参数多，检查每个 % 后面是否都有对应的变量。",
     "printf 格式符"),

    # ---------------- 头文件 / 链接 ----------------
    (r"No such file or directory", "header_not_found",
     "找不到头文件",
     "这个头文件不存在或名字拼错了。标准库用尖括号 <>，自己写的头文件用双引号 \"\"。",
     "头文件引用"),

    (r"undefined reference to", "link_error",
     "链接错误：找不到函数实现",
     "函数声明了但没有对应的实现。常见于只写了函数原型没写函数体，或者编译时漏了源文件。",
     "链接与多文件"),

    (r"multiple definition of", "duplicate_symbol",
     "符号重复定义",
     "同一个全局函数或变量在多个文件里都定义了。检查是不是把定义写在了头文件里。",
     "链接与多文件"),

    # ---------------- 其他常见 ----------------
    (r"empty character constant", "empty_char",
     "空的字符常量",
     "两个单引号之间什么都没有。字符常量里必须有一个字符。",
     "字符常量"),

    (r"comparison between pointer and integer|comparison of integer expressions of different signedness", "compare_mismatch",
     "比较的两个值类型不一致",
     "一边是指针一边是整数，或者有符号和无符号混着比，结果可能不是你预期的。",
     "比较运算"),

    (r"left operand of assignment|expression is not assignable|lvalue required", "not_lvalue",
     "等号左边不能赋值",
     "赋值号左边必须是变量，不能是常量、表达式或者数组名。检查是不是写成了 a + 1 = 5 这种。",
     "赋值语句"),

    (r"unused variable", "unused_var",
     "变量定义了但没用到",
     "这是警告不是错误，代码能编译通过。删掉这个变量，或者检查是不是忘了使用它。",
     "变量声明"),

    (r"is used uninitialized", "uninitialized", "变量没初始化",
     "这个变量在赋值之前就被使用了，里面的值是随机的（不可预测）。用之前先给它赋一个初值。",
     "变量初始化"),

    (r"unused parameter", "unused_param",
     "函数参数没有用到",
     "这是警告，参数声明了但函数体里没用。如果确实不需要，可以删掉或者写 (void)参数名;",
     "函数参数"),

    (r"invalid character.*\(U\+FF", "fullwidth_char",
     "用了中文全角符号",
     "代码里混进了中文输入法打出来的全角符号（例如 ， （ ） ； ： \" \"）。"
     "它们看起来和英文标点几乎一样，但计算机会当成无效字符。",
     "字符与编码"),

    (r"unknown type name", "typo_type",
     "类型名写错了",
     "编译器不认识这个类型名，多半是拼错了。GCC 后面会给出它猜的正确写法（did you mean ...），照着改就行。",
     "变量声明"),

    # ---------------- Python ----------------
    (r"invalid syntax", "py_syntax", "语法错误",
     "Python 无法解析这一行。常见原因：少了冒号、括号不配对、中英文标点混用（比如中文逗号、中文括号）。",
     "Python 语法"),

    (r"was never closed", "py_unclosed", "括号没有闭合",
     "这一行有个左括号一直没有对应的右括号。检查 () [] {} 是否成对——每个 ( 都要有 )。",
     "括号配对"),

    (r"unexpected EOF|unexpected end of file", "py_unclosed", "代码没有写完",
     "文件在这里意外结束了。通常是括号或引号没有闭合，或者 if/for/def 后面忘了写内容。",
     "括号配对"),

    (r"expected ':'", "py_colon", "缺少冒号",
     "这一行末尾少了一个冒号。Python 的 if / for / while / def / class 都要以冒号结尾。",
     "Python 语法"),

    (r"expected an indented block", "py_indent", "缺少缩进",
     "上一行的 if / for / def 下面必须有一个缩进的代码块，这一行应该往右缩进。",
     "缩进与代码块"),

    (r"unexpected indent", "py_indent", "缩进多了",
     "这一行多缩进了，但上面没有 if / for / def 之类的语句开头。",
     "缩进与代码块"),

    (r"TabError|inconsistent use of tabs", "py_indent", "Tab 和空格混用",
     "同一个文件里混用了 Tab 和空格。Python 3 不允许这样，建议统一改成 4 个空格。",
     "缩进与代码块"),

    (r"NameError: name '\w+' is not defined", "py_name", "变量没有定义",
     "用了一个还没赋值的变量。检查拼写，或者是不是忘了先定义、忘了 import。",
     "变量作用域"),

    (r"ZeroDivisionError", "py_divzero", "除数为零",
     "除号右边的值是 0。做除法之前先判断除数是不是 0。",
     "算术运算"),

    (r"IndexError", "py_index", "下标越界",
     "访问的位置超过了列表或字符串的长度。下标从 0 开始，最大是长度减 1。",
     "列表与下标"),

    (r"KeyError", "py_key", "字典里没有这个键",
     "用了一个字典里不存在的键。可以先用 in 判断，或者用 get() 给个默认值。",
     "字典操作"),

    (r"TypeError: unsupported operand", "py_type", "类型不匹配",
     "两种不能一起运算的类型放在一起了，比如字符串加数字。用 int() 或 str() 转换一下。",
     "数据类型"),

    (r"ValueError: invalid literal for int", "py_value", "转换失败",
     "想把一个不是数字的东西转成整数。检查输入格式，或者先用 .strip() 去掉空白。",
     "数据类型"),
]


# 兜底：没命中任何规则时用这个
FALLBACK = ("unknown", "其他编译错误",
            "这条报错没有归入常见错误类型。编译器原文：{raw}", "语法结构")


def match(message: str) -> tuple[str, str, str, str]:
    """按顺序匹配，返回 (类别, 中文类型, 解释, 知识点)。"""
    import re
    for pattern, category, type_zh, explain, knowledge in RULES:
        if re.search(pattern, message):
            return category, type_zh, explain, knowledge
    return FALLBACK
