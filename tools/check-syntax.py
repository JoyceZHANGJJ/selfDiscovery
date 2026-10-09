#!/usr/bin/env python3
# tools/check-syntax.py —— 改完自查：括号 / 引号 / 标签配对 / 云函数文档同步 / 输出契约一致性
#
# 用法（项目根目录）：
#   python3 tools/check-syntax.py              # 查全项目
#   python3 tools/check-syntax.py utils/store.js pages/list/list.wxml   # 只查指定文件
#
# 为什么要它：项目里没有 node / eslint 的运行环境，而小程序是「一个语法错误就整包加载失败」——
# 少一个收尾括号（utils/store.js 就出过一次：改 ensureAll 时漏了 `})`，require 直接抛错、
# 整个小程序白屏）。这里用最土但最稳的办法先兜住最常见的两类事故：
#   1) js：括号 / 引号没配对（会连带产生「module 未定义」这类看不懂的报错）
#   2) wxml：标签没配对（会连带产生「渲染层错误」或整页空白）
#   3) wxml：内层 wx:for 没写 wx:for-item，把外层的 item 顶掉（同时还在用 item.*）
#      —— 这类不会报错，只是表达式悄悄算成 undefined：出过一次「5 格电量条一格都不亮」，
#      模板里 `{{index<item.bat.lv?'on':''}}` 取到的是内层循环的数字 0..4，不是那条记录
#   4) 云函数文档同步：cloudfunctions/*/index.js 里新增或改名了 action，
#      但没在同目录 README.md 里写出对应的测试模板 / 说明（约定见该文档「更新约定」一节）
#   5) 输出契约一致性：云函数落库的字段有没有超出 fieldsSpec() 声明的范围。
#      这类bug 在页面上表现为「同一段话显示两遍」，不报错、不白屏，
#      靠人 review 极难发现（新增字段的人看到「旧字段也要兼容」，顺手多写一个很自然）
#      ——出过analysis.detail 复述六板的事故，所以改成机械可查
#       6) 提示词槽位一致性：按条件选出来的槽位变量，loadPrompts 必须真的读它。
    #      读错槽位时不会报错，只是静默退回出厂默认值——页面上写着「已改过 vN」，
    #      实际生成用的是出厂默认，连promptRev 记的都是那个 vN，对账时反倒更难看出问题。
    #      ——出过「轻量版画像固定读 persona.full，取正文时却按 lite 找 persona.lite」的事故
#   7) 记录文本的两份实现不许漂移：喂给 AI 的 recText.js 与人读的可读导出
#      （utils/exporter.js）本该是同一个口径，但云函数拿不到 wx，只能复刻。
#      改了一边忘了另一边，同一条记录在导出里叫「剩余能量」、在 AI 眼里叫
#      「todayBat」——不报错、不白屏，对账时看不出是哪边错了。机械比对
#      COLMAP / 维度名 / BATTERIES 三份常量，并禁止云函数里再出现内联副本。
#   8) 记录格式说明不许漏：RECORD_GUIDE（怎么读状态 / 优先级 / 能量档位 / 末尾汇总）
#      必须三个生成路径都拼进 system。漏掉不报错，只是某条路径的模型默默把状态
#      当噪声忽略——上一条 6 的同类形态（漏一处、只退化、不报错）。
# 它不是完整的解析器（不做语法树、不查语义），真正的语法错误仍然以微信开发者工具为准；
# 能做的只是「提交 / 编译前先花一秒扫一遍」，把这类低级错误挡在前面。
#
# ★ 这份脚本里的每一条检查都必须**注入一个已知 bug 验过它真能报出来**。
#   写这类「靠正则匹配真实代码」的检查，最常见的失败是**静默跳过**：
#   提取器与当前写法对不上时匹配数为 0，脚本照样打印「问题 0 个」，
#   看起来一切正常，实际上这条检查根本没跑。（出过一次：BATTERIES 是数组，
#   我用了对象提取器，整条比对永远返回空。）
#   所以提取失败一律显式报出来，不允许「匹配不到就当没问题」。
#
# 只依赖 python3（macOS 自带），不装任何东西。

import io
import os
import re
import sys

SKIP_DIRS = ('node_modules', 'miniprogram_npm', '.git', '.cloudbase')
JS_EXT = ('.js',)
WXML_EXT = ('.wxml',)

# wxml 里允许「不自闭合」的标签（写 <input ...> 而不写 / 或 </input> 是合法的）
# 注意 slot 不算：它是成对的（<slot></slot>）
WXML_VOID = ('input', 'image', 'icon', 'import', 'include', 'wxs', 'br', 'hr')


def read(path):
    return io.open(path, encoding='utf-8').read()


def line_of(src, idx):
    return src.count('\n', 0, idx) + 1


# ---------------------------------------------------------------- js：配对检查
PAIR = {')': '(', ']': '[', '}': '{'}


def check_js(path):
    """返回问题列表：括号 / 引号是否配对。会跳过注释、字符串、模板串与正则字面量。"""
    src = read(path)
    stack, i, n = [], 0, len(src)
    state = None          # None | "'" | '"' | '`' | '//' | '/*'
    out = []
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''
        if state is None:
            if c == '/' and nxt == '/':
                state = '//'
                i += 2
                continue
            if c == '/' and nxt == '*':
                state = '/*'
                i += 2
                continue
            if c == '/' and nxt not in ('/', '*') and _regex_here(src, i):
                i = _skip_regex(src, i)     # 正则字面量：/^\// 这种最容易把后面的引号骗掉
                continue
            if c in '\'"`':
                state = c
                i += 1
                continue
            if c in '([{':
                stack.append((c, line_of(src, i)))
            elif c in ')]}':
                if not stack or stack[-1][0] != PAIR[c]:
                    out.append('%s:%d  多余的 %s' % (path, line_of(src, i), c))
                else:
                    stack.pop()
            i += 1
            continue
        if state == '//':
            if c == '\n':
                state = None
            i += 1
            continue
        if state == '/*':
            if c == '*' and nxt == '/':
                state = None
                i += 2
                continue
            i += 1
            continue
        # 字符串 / 模板串里：先处理转义，再找结束引号
        if c == '\\':
            i += 2
            continue
        if c == state:
            state = None
        i += 1

    for ch, ln in stack:
        out.append('%s:%d  未闭合的 %s' % (path, ln, ch))
    if state in ('"', "'", '`'):
        out.append('%s  字符串没结束（漏了结束引号？）' % path)
    return out


def _regex_here(src, i):
    """这个 / 是不是正则的开头：看它前面那个非空白字符能不能接一个表达式。"""
    k = i - 1
    while k >= 0 and src[k] in ' \t':
        k -= 1
    if k < 0:
        return True
    return src[k] in '(,=:[!&|?{};+-*%~^<>' or src[k] == '\n'


def _skip_regex(src, i):
    j, incls, n = i + 1, False, len(src)
    while j < n:
        if src[j] == '\\':
            j += 2
            continue
        if src[j] == '[':
            incls = True
        elif src[j] == ']':
            incls = False
        elif src[j] == '/' and not incls:
            break
        elif src[j] == '\n':
            break
        j += 1
    return j + 1


# -------------------------------------------------------------- wxml：标签配对
def _attr(text, name):
    """从标签属性串里取某个属性的值；没有返回 None。够用即可：只认 name="..." / name='...'"""
    m = re.search(r'(?:^|\s)' + re.escape(name) + r'\s*=\s*(["\'])(.*?)\1', text, re.S)
    return m.group(2) if m else None


# 模板表达式里用到 item.xxx / item[0]（前面不是单词字符，避免 data-item. 这类误判）
ITEM_REF = re.compile(r'(?<![\w.\-])item\s*[.\[]')


def check_wxml(path):
    """返回问题列表：标签是否配对（自闭合的、允许空标签的都不算问题），
    以及内层 wx:for 顶掉外层 item 的写法。"""
    src = read(path)
    stack, i, n = [], 0, len(src)
    out = []
    while i < n:
        if src.startswith('<!--', i):
            end = src.find('-->', i)
            i = n if end < 0 else end + 3
            continue
        if src[i] != '<':
            i += 1
            continue
        # 只认 <字母 或 </字母，其它（<!、<?）跳过
        j = i + 1
        closing = False
        if j < n and src[j] == '/':
            closing = True
            j += 1
        if j >= n or not (src[j].isalpha() or src[j] == '_'):
            i = j
            continue
        name_start = j
        while j < n and (src[j].isalnum() or src[j] in '_-:'):
            j += 1
        name = src[name_start:j]
        name_end = j
        # 扫到这个标签的 '>'：属性里的引号要跳过（wx:if="{{a > b}}" 里的 > 不能当结束）
        q = None
        while j < n:
            ch = src[j]
            if q:
                if ch == q:
                    q = None
            elif ch in '"\'':
                q = ch
            elif ch == '>':
                break
            j += 1
        attrs = src[name_end:j]        # 属性串（wx:for / class / style …），不含标签名与结尾的 >
        self_closed = (j > i + 1 and src[j - 1] == '/')
        if closing:
            if not stack:
                out.append('%s:%d  多余的 </%s>' % (path, line_of(src, i), name))
            elif stack[-1][1] != name:
                out.append('%s:%d  </%s> 与 <%s>（第 %d 行）对不上'
                           % (path, line_of(src, i), name, stack[-1][1], stack[-1][2]))
                stack.pop()
            else:
                stack.pop()
        elif not self_closed and name not in WXML_VOID:
            # 这一层自己开了 wx:for，但没写 wx:for-item（内层默认也叫 item）
            own_default_for = (('wx:for' in attrs) and _attr(attrs, 'wx:for-item') is None)
            if own_default_for:
                # 祖先里也有没改名的 wx:for → 外层的 item 被顶掉；这一层又真的在用 item.*
                if any(e[4] for e in stack) and ITEM_REF.search(attrs):
                    out.append('%s:%d  wx:for 没写 wx:for-item，会顶掉外层循环的 item；'
                               '同一标签里用的 item.* 取到的是内层那个（表达式不会报错，只会算成 undefined）'
                               % (path, line_of(src, i)))
            stack.append((i, name, line_of(src, i), attrs, own_default_for))
        i = j + 1

    for _, name, ln, _a, _f in stack:
        out.append('%s:%d  未闭合的 <%s>' % (path, ln, name))
    return out


# ------------------------------------------- 云函数：action 必须有对应的文档模板
# cloudfunctions/<fn>/index.js 里以 action === 'xxx' 分发的每个 action，
# 都必须在同目录 README.md 的「action 总表」里出现过（出现两次以上才算真有条目：
# 一次是总表行、一次至少还有模板或说明，避免只在一句话里被顺带提过）。
ACTION_RE = re.compile(r"action\s*===\s*['\"]([A-Za-z0-9_]+)['\"]")


def check_cloudfn_docs(path):
    """返回问题列表：云函数里的 action 有没有写进同目录的说明文档。"""
    src = read(path)
    actions = sorted(set(ACTION_RE.findall(src)))
    if not actions:
        return []
    doc = os.path.join(os.path.dirname(os.path.abspath(path)), 'README.md')
    if not os.path.exists(doc):
        return ['%s  有 %d 个 action（%s），但同目录没有 README.md 说明文档'
                % (path, len(actions), '、'.join(actions))]
    text = read(doc)
    out = []
    for a in actions:
        if text.count('`%s`' % a) < 2 and ('"%s"' % a) not in text and ("'%s'" % a) not in text:
            out.append('%s  action `%s` 在 %s 里只出现%s次——补一条测试模板 / 总表行'
                       % (path, a, os.path.relpath(doc), text.count('`%s`' % a)))
    return out


# ---------------------------------------------------------------- 契约 / 落库字段一致性
#
# 为什么要有这条：前端把每一块内容都单独渲染了一遍，所以**只要云函数多落一个
# 前端也会渲染的字段，同一段内容就会在页面上出现两遍**，而且两遍措辞几乎一样，
# 人只会觉得 App 坏了，不会怀疑是数据问题。
#
# 出过的事故：analysis 集合的 detail（前端「复盘随想」）曾用 buildFallbackDetail()
# 从 facts / patterns / compare / risks / actions 拼出来落库，而那六块上面已渲染过一遍
# → 同一天的内容显示两遍。而且注释与条件正好相反（新生成必然命中，不是偶发）。
#
# 这类 bug 靠人 review 很难拦住：新增字段的人看到「旧字段也要兼容」，
# 顺手多写一个很自然，页面上也看不出「哪两块是同一段话」。
# 所以把它变成一条机械可查的规则：落库的字段必须能在 fieldsSpec() 里找到出处。
#
# 白名单：**元信息**字段——谁、什么时候、哪个周期、第几版、用了几条记录、用的哪版提示词。
# 这些不是模型返回的内容，不参与「同一段话显示两遍」的问题，所以不要求出现在契约里。
# 判据是「这个字段的值来自代码的变量 / 函数调用，而不是 parsed.xxx」——
# 只要是前者就属于元信息（像 patterns.drain 是列表推导自 pat.drain，那才是内容）。
DOC_META_FIELDS = {
    # 归属与时间
    'openid', 'type', 'date', 'start', 'end', 'createdAt', '_id', '_openid',
    # 用了哪个模型 / 哪版提示词（写代码时定的，不是模型说的）
    'model', 'promptRev', 'lite',
    # 版本与来源标记
    'rev', 'basedOn', 'n', 'updatedAt', 'fromRev', 'records', 'reviews',
}

# 契约声明的字段名（形如"summary（40~70 字…" / "  drain（数组…"，取括号前那段）
SPEC_FIELD_RE = re.compile(r"^\s*'?([A-Za-z_][A-Za-z0-9_]*)'?(?:（|\s*\()")
# 对象字面量的键名（只匹配标识符形式的键，引号形式的键在下面单独处理）
KEY_RE = re.compile(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*:")

# 生成函数 → 输出契约函数。一个生成函数对应一份契约，一一配对。
# 加了新形态（比如以后加个「每日问答」）就往这里补一条；配对不上时下面会静默跳过，
# 所以宁可少配也不要配错——配错会报出一堆假问题，不如不查。
CONTRACT_PAIRS = [
    ('generateFor', 'fieldsSpec'),
    ('generateProfile', 'profileFieldsSpec'),
    ('generateProfilePro', 'profileProFieldsSpec'),
    ('generatePersona', 'personaFieldsSpec'),
]


def _function_body(src, name):
    """按函数名取出函数体的花括号区间，找不到返回 None。"""
    m = re.search(r'(?:async\s+)?function\s+%s\s*\(' % re.escape(name), src)
    if not m:
        return None
    start = src.find('{', m.end())
    if start < 0:
        return None
    depth = 0
    for j in range(start, len(src)):
        if src[j] == '{':
            depth += 1
        elif src[j] == '}':
            depth -= 1
            if depth == 0:
                return src[start:j], start
    return None


def _method_body(src, name):
    """取对象方法（Page({ ensureModuleDefaults(tag) { … } }) 这种简写）的函数体。

    页面上几乎全是方法简写，`function x()` 那个取法（`_function_body`）在这里匹配不到——
    匹配不到时它会返回 None，而「None 就跳过」的写法会让整条检查变成没跑，
    脚本却照样报「问题 0 个」。所以这里单写一个，并对「没找到」显式报错。
    """
    m = re.search(r'(?:^|\n)\s*%s\s*\([^)]*\)\s*\{' % re.escape(name), src)
    if not m:
        return None
    start = src.find('{', m.start())
    if start < 0:
        return None
    depth = 0
    for j in range(start, len(src)):
        if src[j] == '{':
            depth += 1
        elif src[j] == '}':
            depth -= 1
            if depth == 0:
                return src[start:j]
    return None


def _spec_fields(src, fn_name):
    """返回契约函数里声明的字段名集合（含嵌套对象的子字段）。"""
    got = _function_body(src, fn_name)
    if not got:
        return None
    body = got[0]
    fields = set()
    for line in body.split('\n'):
        m = SPEC_FIELD_RE.match(line)
        if m:
            fields.add(m.group(1))
    return fields or None


def _doc_fields(src, fn_name):
    """返回生成函数里落库 doc 对象的**顶层**键名集合，以及该对象的起始行。

    靠括号配对 + 层级计数定位，不用正则扫全文：
    嵌套对象（patterns 里的子字段）与顶层键在同一段文本里，
    纯正则分不出层级，只会把子字段误当成顶层字段。
    """
    got = _function_body(src, fn_name)
    if not got:
        return None, 0
    body_all, fn_start = got
    m = re.search(r'const\s+doc\w*\s*=\s*\{', body_all)
    if not m:
        return None, 0
    start = body_all.index('{', m.start())
    depth = 0
    end = start
    for j in range(start, len(body_all)):
        if body_all[j] == '{':
            depth += 1
        elif body_all[j] == '}':
            depth -= 1
            if depth == 0:
                end = j
                break
    body = body_all[start:end]
    fields = set()
    depth = 0
    k = 0
    n = len(body)
    while k < n:
        ch = body[k]
        if ch == '{':
            depth += 1
            k += 1
            continue
        if ch == '}':
            depth -= 1
            k += 1
            continue
        if depth == 1 and ch in '"\'':
            # 字符串字面量：只有「后面紧跟冒号」的那个才是键名（值里的字符串不算）
            q = ch
            e = body.find(q, k + 1)
            if e < 0:
                break
            if body[e + 1:e + 2] == ':':
                fields.add(body[k + 1:e])
            k = e + 1
            continue
        if depth == 1:
            mm = KEY_RE.match(body, k)
            if mm:
                fields.add(mm.group(1))
                k = mm.end()
                continue
        k += 1
    return fields, line_of(src, fn_start + start)


def check_contract_fields(path):
    """落库字段必须与对应fieldsSpec() 的契约一致，否则前端会把同一内容渲染两遍。"""
    src = read(path)
    out = []
    for gen_fn, spec_fn in CONTRACT_PAIRS:
        spec = _spec_fields(src, spec_fn)
        doc_fields, ln = _doc_fields(src, gen_fn)
        if not spec or doc_fields is None:
            continue                      # 这一对没同时出现（如尚未接入）→ 不查
        extra = sorted(f for f in doc_fields
                       if f not in spec and f not in DOC_META_FIELDS)
        if not extra:
            continue
        out.append('%s:%d  %s() 落库的字段 %s 不在 %s() 声明的契约里。'
                   '前端把每块内容都单独渲染一次，多写一个字段就会在同一页面上显示两遍'
                   '（历史上 analysis.detail 就是这么重复的）。'
                   '要么去掉，要么先加进 %s() 并确认前端怎么展示。'
                   % (path, ln, gen_fn, '、'.join(extra), spec_fn, spec_fn))
    return out


def check_prompt_slots(path):
    """按条件选提示词槽位时，loadPrompts 必须读那个变量本身。

    为什么要有这条：轻量版画像曾经固定 load('persona.full')，取正文时却按lite
    选 `prompts['persona.lite']` —— 取不到就静默退回出厂值。用户改了 persona.lite、
    页面上写着「已改过 v3」，实际生成用的还是出厂默认，而且 promptRev 记的还是 v3，
    对账时反倒更难看出问题。这类错不报错、不白屏，只能靠静态约束拦住。

    做法：盯住每个 loadPrompts([...])，回看它前面 900 字里有没有「按条件选槽位」的
    变量（形如 `const slot = lite ? 'a' : 'b'`）；有的话参数里就必须含这个变量。
    回看范围有限是有意的：超了就大概率是别的函数了，宁可漏报也不要误报。
    """
    src = read(path)
    out = []
    cond = re.compile(r'const\s+(\w+)\s*=\s*(\w+)\s*\?\s*\'([^\']+)\'\s*:\s*\'([^\']+)\'\s*;')
    load = re.compile(r'loadPrompts\(\[(.*?)\]\)', re.S)
    for m in load.finditer(src):
        arg = m.group(1)
        head = src[max(0, m.start() - 900):m.start()]
        for var, flag, when_true, when_false in cond.findall(head):
            if var not in arg:
                picked = when_true if flag == 'lite' else when_false
                out.append('%s:%d  提示词槽位对不上：前面按 %s 选了 %s=%r，'
                           '但 loadPrompts 读的是 [%s]。取不到时会静默退回出厂默认值——'
                           '页面显示「已改过」，实际用的是出厂内容。让 loadPrompts 读同一个变量。'
                           % (path, line_of(src, m.start()), flag, var, picked, arg.strip()))
    return out


#喂给模型的记录文本由 recText.js 生成，格式说明（RECORD_GUIDE）必须**每个生成路径都拼上**。
# 与 check_prompt_slots 是同一类病：漏掉不报错、不白屏，只是某条路径的模型默默退化。
RECORD_GUIDE_USERS = ('buildMessages', 'buildProfileMessages', 'buildProfileProMessages', 'buildPersonaMessages')


def check_record_guide(path):
    """三个生成路径拼 system 时都要带 RECORD_GUIDE（记录格式说明）。

    为什么要有这条：记录文本换成了与「可读导出」一致的自然语言，里面带状态后缀
    （做了 / 未做 / 已逾期 N 天）、优先级、能量档位、末尾汇总。讲不讲这些怎么读，
    模型的理解差别很大——不讲多半会忽略（白喂）或当成正文复述（页面变流水账），
    而且这两种都不会报错。
    这段是**数据契约的一部分**（读法），所以必须由代码强制拼进 system，
    不能放进提示词注册表让人改掉——用户改提示词是改人设与任务规则。
    """
    src = read(path)
    if 'RECORD_GUIDE' not in src:
        return []                      # 不用这个段的云函数，跳过
    out = []
    for fn in RECORD_GUIDE_USERS:
        body, start = _function_body(src, fn)
        if not body:
            continue
        if 'RECORD_GUIDE' not in body:
            out.append('%s:%d  %s() 拼 system 时没有 RECORD_GUIDE。'
                       '记录里带的状态 / 优先级 / 能量档位 / 末尾汇总，模型不知道该怎么读——'
                       '多半会当噪声忽略，或当成正文复述进 facts。'
                       % (path, line_of(src, start or 0), fn))
    return out


# ------------------------------------------------------------------- 主流程
def walk(root):
    """默认目标：项目里的全部 js / wxml（跳过依赖目录）。"""
    js, wxml = [], []
    for base in ('utils', 'pages', 'components', 'custom-tab-bar'):
        d = os.path.join(root, base)
        if not os.path.isdir(d):
            continue
        for cur, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            for f in sorted(files):
                p = os.path.join(cur, f)
                if f.endswith(JS_EXT):
                    js.append(p)
                elif f.endswith(WXML_EXT):
                    wxml.append(p)
    top = os.path.join(root, 'app.js')
    if os.path.exists(top):
        js.append(top)
    return js, wxml


def walk_cloudfn(root):
    """云函数目录：跳过 node_modules，收index.js 以及它require 的同目录模块。"""
    out = []
    base = os.path.join(root, 'cloudfunctions')
    if not os.path.isdir(base):
        return out
    for cur, dirs, files in os.walk(base):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        if 'index.js' in files:
            out.append(os.path.join(cur, 'index.js'))
    return out


def walk_cloudfn_all(root):
    """云函数目录里的全部 js（index.js 与它 require 的同目录模块，如 recText.js）。"""
    out = []
    base = os.path.join(root, 'cloudfunctions')
    if not os.path.isdir(base):
        return out
    for cur, dirs, files in os.walk(base):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        for f in sorted(files):
            if f.endswith('.js'):
                out.append(os.path.join(cur, f))
    return out


# ------------------------------------------------------------------- 第 7 条：记录文本的两份实现不许漂移
def _js_object_literal(src, name):
    """取出 `const NAME = { ... };` 的对象字面量源码（按括号配对，含嵌套）。找不到返回 None。"""
    m = re.search(r'(?:const|var|let)\s+' + re.escape(name) + r'\s*=\s*\{', src)
    if not m:
        return None
    start = src.index('{', m.start())
    depth, j = 0, start
    for j in range(start, len(src)):
        if src[j] == '{':
            depth += 1
        elif src[j] == '}':
            depth -= 1
            if depth == 0:
                break
    return src[start:j + 1]


def _js_array_literal(src, name):
    """取出 `const NAME = [ ... ];` 的数组字面量源码（按括号配对）。找不到返回 None。"""
    m = re.search(r'(?:const|var|let)\s+' + re.escape(name) + r'\s*=\s*\[', src)
    if not m:
        return None
    start = src.index('[', m.start())
    depth, j = 0, start
    for j in range(start, len(src)):
        if src[j] == '[':
            depth += 1
        elif src[j] == ']':
            depth -= 1
            if depth == 0:
                break
    return src[start:j + 1]


def _flat_kv(body):
    """把对象字面量里 `k: 'v'` / `k: 123` / `k: ['a','b']` 拍平成 {k: 原始值文本}。

    只取**顶层**键：嵌套对象（BATTERIES 里那五项）会带着自己的键进来，
    那是另一个维度的东西，不参与比对。
    """
    out = {}
    depth = 0
    i, n = 0, len(body)
    while i < n:
        ch = body[i]
        if ch == '{':
            depth += 1
            i += 1
            continue
        if ch == '}':
            depth -= 1
            i += 1
            continue
        if depth != 1:
            i += 1
            continue
        if ch in '"\'':
            q = ch
            e = body.find(q, i + 1)
            if e < 0:
                break
            key = body[i + 1:e]
            if body[e + 1:e + 2] == ':':
                # 值：标量读到逗号 / 括号；数组/对象读到配对结束
                j = e + 2
                while j < n and body[j] in ' \t\r\n':
                    j += 1
                if j < n and body[j] in '[{':
                    open_c, close_c = body[j], (']' if body[j] == '[' else '}')
                    d2, k2 = 0, j
                    for k2 in range(j, n):
                        if body[k2] == open_c:
                            d2 += 1
                        elif body[k2] == close_c:
                            d2 -= 1
                            if d2 == 0:
                                break
                    out[key] = body[j:k2 + 1].strip()
                    i = k2 + 1
                else:
                    k2 = j
                    while k2 < n and body[k2] != ',':
                        k2 += 1
                    out[key] = body[j:k2].split('\n')[0].strip()
                    i = k2
            else:
                i = e + 1
            continue
        m = KEY_RE.match(body, i)
        if m:
            key = m.group(1)
            j = m.end()
            while j < n and body[j] in ' \t\r\n':
                j += 1
            if j < n and body[j] in '[{':
                open_c = body[j]
                close_c = ']' if open_c == '[' else '}'
                d2, k2 = 0, j
                for k2 in range(j, n):
                    if body[k2] == open_c:
                        d2 += 1
                    elif body[k2] == close_c:
                        d2 -= 1
                        if d2 == 0:
                            break
                out[key] = body[j:k2 + 1].strip()
                i = k2 + 1
            else:
                # 标量：读到逗号 / 右花括号为止。
                # **最后一个键值必须切到换行为止**——它是「值\n}」的形态，
                # 那个 } 已经越界到对象本身去了，连着换行收进来就变成 `'明天的计划'\n}`；
                # 两份 COLMAP 最后一项不同时会因此误报漂移（给 COLMAP 补「回顾」时撞上过）
                k2 = j
                while k2 < n and body[k2] not in ',}':
                    k2 += 1
                out[key] = body[j:k2].split('\n')[0].strip()
                i = k2
            continue
        i += 1
    return out


def _unquote(v):
    """去掉两侧的引号，让 '`今日`' 和 `今日` 判为相等（写法的差异不是差异）。"""
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
        return v[1:-1]
    return v


def _js_unit_map(src):
    """取 js 文件里的 `UNIT_SUFFIX = { '键': '值', … }`，取不到返回 None。

    用朴素的「'键': '值'」正则，**不用 _flat_kv**：那个提取器按「读到逗号 / 右花括号」
    切标量，而 UNIT_SUFFIX 是**单行**对象，最后一个值会把闭合的 } 一起收进来
    （比出 store 是 "'%' }"、recText 是 "'%'"），于是一条本来没问题的对比报成漂移。
    假报警多了，人会习惯性忽略整个脚本，比不查更糟。
    """
    body = _js_object_literal(src, 'UNIT_SUFFIX') or ''
    if not body:
        return None
    found = dict(re.findall(r"'([\w:]+)'\s*:\s*'([^']*)'", body))
    return found or None


def _how_many(d):
    """提取结果转成能安全写进报错的说法：None 也要能说，不能在 len() 上崩掉。"""
    if d is None:
        return '取不到'
    return '%d 项' % len(d)


def check_rec_labels(root):
    """喂给 AI 的记录文本与可读导出必须一致：COLMAP / 维度名 / 能量档位三份常量不许漂移。

    为什么要有这条：这两份是**同一个口径的两处实现**——
      小程序端 utils/exporter.js（人读 / 备份）
      云函数 cloudfunctions/analysis/recText.js（喂大模型）
    云函数拿不到 wx，不能直接 require store.js，只能复刻。复刻就会漂移：
    改了一边忘了另一边，同一条记录在人读的导出里叫「剩余能量」、
    在 AI 眼里叫「todayBat」，对账时完全看不出是哪边错了（不报错、不白屏）。

    这里机械比对三份常量，任何一边多一项 / 少一项 / 值不同都报出来。
    """
    store_p = os.path.join(root, 'utils', 'store.js')
    cloud_p = os.path.join(root, 'cloudfunctions', 'analysis', 'recText.js')
    if not (os.path.exists(store_p) and os.path.exists(cloud_p)):
        return []
    store_src, cloud_src = read(store_p), read(cloud_p)
    out = []

    # COLMAP：store.js 的原名 vs recText.js 的复刻。
    # 提取失败要报出来——静默跳过时脚本会显示「问题 0 个」，看起来一切正常，
    # 实际上这条检查根本没跑（提取器与当前写法对不上就会这样）。
    s_col = _flat_kv(_js_object_literal(store_src, 'COLMAP') or '')
    c_col = _flat_kv(_js_object_literal(cloud_src, 'COLMAP') or '')
    if not s_col or not c_col:
        out.append('  COLMAP 提取失败（store=%d 项 / recText=%d 项），标签比对这条没跑。'
                   % (len(s_col), len(c_col)))
    if s_col and c_col:
        for k in sorted(set(s_col) | set(c_col)):
            a, b = s_col.get(k), c_col.get(k)
            if a == b:
                continue
            if k not in c_col:
                out.append('%s  COLMAP 少了 %s: %r。store.js 里有、recText.js 里没有——'
                           '同一条记录在导出里显示这个标签，在喂给 AI 的文本里就没有。'
                           % (os.path.relpath(cloud_p, root), k, a))
            elif k not in s_col:
                out.append('%s  COLMAP 多了 %s: %r。store.js 里没有——'
                           '喂给 AI 时会把这个来源键翻成这个标签，但页面上并不是这么叫的。'
                           % (os.path.relpath(cloud_p, root), k, b))
            else:
                out.append('%s  COLMAP[%s] 两边不一致：store.js 是 %r，recText.js 是 %r。'
                           '同一条记录在导出和 AI 眼里长得不一样，对账时看不出是哪边错了。'
                           % (os.path.relpath(cloud_p, root), k, a, b))

    # 维度名：store 的 MODULES 是 [{k,n}] 数组，recText 是 MODULE_N 对象。
    # 只认 MODULES 那一段（FIXED 时刻表里也有 {k,n} 形式的 am/noon/pm，别混进来）。
    s_mod = {}
    mods = _js_array_literal(store_src, 'MODULES')
    if mods:
        s_mod = dict(re.findall(r"\{\s*k:\s*'([\w]+)'\s*,\s*n:\s*'([^']*)'", mods))
    # store.mname 里对历史维度 m='done' 有兼容分支（「新流程已并入可做·做了」）
    if re.search(r"if\s*\(\s*k\s*===\s*'done'\s*\)", store_src):
        s_mod['done'] = '做了'
    c_mod = dict((k, _unquote(v)) for k, v in
                 _flat_kv(_js_object_literal(cloud_src, 'MODULE_N') or '').items())
    if not s_mod or not c_mod:
        out.append('  MODULE_N 提取失败（store=%d 项 / recText=%d 项），维度名比对这条没跑。'
                   % (len(s_mod), len(c_mod)))
    if s_mod and c_mod:
        for k in sorted(set(s_mod) | set(c_mod)):
            a, b = s_mod.get(k), c_mod.get(k)
            if a == b:
                continue
            if k not in c_mod:
                out.append('%s  MODULE_N 少了 %s（store 里叫 %r）——这个维度的记录'
                           '在 AI 眼里会直接露出英文键名。'
                           % (os.path.relpath(cloud_p, root), k, a))
            elif k not in s_mod:
                out.append('%s  MODULE_N 多了 %s（%r）——store 里没有这个维度。'
                           % (os.path.relpath(cloud_p, root), k, b))
            else:
                out.append('%s  MODULE_N[%s] 两边不一致：store 是 %r，recText 是 %r。'
                           % (os.path.relpath(cloud_p, root), k, a, b))

    # 能量档位：BATTERIES 两边都是**数组** [{v,name}]（不是对象——用错提取器会静默返回空，
    # 整条检查被跳过，脚本还报「问题0 个」，看起来一切正常）
    def bats(s):
        b = _js_array_literal(s, 'BATTERIES')
        if not b:
            return None
        found = re.findall(r"v:\s*'([^']*)'\s*,\s*name:\s*'([^']*)'", b)
        return found or None
    s_bat, c_bat = bats(store_src), bats(cloud_src)
    if s_bat is None or c_bat is None:
        out.append('  BATTERIES 提取失败（store=%s / recText=%s），能量档位这条比对没跑。'
                   '提取器与当前写法对不上时最容易出现这种「静默跳过」。'
                   % ('有' if s_bat is not None else '无',
                      '有' if c_bat is not None else '无'))
    elif s_bat != c_bat:
        out.append('%s  BATTERIES 与 store.js 不一致：\n      store  : %s\n      recText: %s\n'
                   '能量档位是喂给 AI 的关键信息（「一般（3/5 格）」比孤零零一个「3」有用得多），'
                   '两边不一样时同一份能量会读出两种说法。'
                   % (os.path.relpath(cloud_p, root), s_bat, c_bat))

    # 心情档位：MOODS 与 BATTERIES 同一套机制、同一套漂移风险——
    # 两边名字对不上时，AI 看到的「平静」在导出里会变成「不错」，
    # 两个情绪词被当成两个意思，回看结论直接跑偏。所以一并机械比对。
    def moods(s):
        b = _js_array_literal(s, 'MOODS')
        if not b:
            return None
        found = re.findall(r"v:\s*'([^']*)'\s*,\s*name:\s*'([^']*)'", b)
        return found or None
    s_mood, c_mood = moods(store_src), moods(cloud_src)
    if s_mood is None or c_mood is None:
        out.append('  MOODS 提取失败（store=%s / recText=%s），心情档位这条比对没跑。'
                   % ('有' if s_mood is not None else '无',
                      '有' if c_mood is not None else '无'))
    elif s_mood != c_mood:
        out.append('%s  MOODS 与 store.js 不一致：\n      store  : %s\n      recText: %s\n'
                   '心情档位与能量档位是一对，名字对不上时「平静」和「一般」会被读成两种状态。'
                   % (os.path.relpath(cloud_p, root), s_mood, c_mood))

    # 带单位字段：UNIT_SUFFIX 两边都是**单行对象**（{ 'free:divAcc': '%' }）。
    # 漏一边 → 人读的导出写「准确率：80」、喂给 AI 的写「准确率：80%」，
    # 同一份数据两种说法，对账时看不出是哪边错了（与 COLMAP 漂移同一类事故）。
    s_unit, c_unit = _js_unit_map(store_src), _js_unit_map(cloud_src)
    # 提取失败要报出来而不是跳过：UNIT_SUFFIX 只有一项，被改名 / 删掉时
    # 「两边都是空 dict」会判成一致，检查就成了摆设。
    # 注意别在 len() 上直接用 None（提取失败时返回 None）——那会让整个脚本崩掉，
    # 崩掉比误报更糟：一行都跑不完，等于所有检查都没做（这里真崩过一次）
    if s_unit is None or c_unit is None:
        out.append('  UNIT_SUFFIX 提取失败（store=%s / recText=%s），单位一致性这条没跑。'
                   '一边被改名 / 删空时最容易这样；两边都空也会被误判成「一致」，检查形同虚设。'
                   % (_how_many(s_unit), _how_many(c_unit)))
    su, cu = s_unit or {}, c_unit or {}
    for k in sorted(set(su) | set(cu)):
        a, b = su.get(k), cu.get(k)
        if a == b:
            continue
        out.append('%s  UNIT_SUFFIX[%s]：store 是 %r，recText 是 %r。单位只在回读时补，'
                   '漏一边就出现「导出写 80、AI 写 80%%」这种对不上的文本。'
                   % (os.path.relpath(cloud_p, root), k, a, b))
    # 登记进 UNIT_SUFFIX 的来源必须有中文标签，否则补了单位也没人知道那是什么
    for k in sorted(su):
        if 'free:' + k.split(':', 1)[-1] not in s_col and k not in s_col:
            out.append('  UNIT_SUFFIX 里的 %s 没有对应的 COLMAP 标签。' % k)
    return out


def check_dimension_registration(root):
    """新增维度最常见的一类事故：**登记表漏一行**。

    一个维度在这个项目里不是一处注册，而是散落在 store.js 的几张表
    （MODULES / FIELDS / COLMAP / GLABEL / OPT）+ 页面上的几处硬编码。
    漏任何一张都不报错——表现为：
      · 漏 FIELDS  → 维度能看见但**不能编辑**（checkEdit 里一行 return 就放弃了，连提示都没有）
      · 漏 COLMAP  → 细节 / 导出 / 复制里出现**没有标签的裸值**（「 LSTM」这一栏到底是什么）
      · 漏 look.js 的 labelMap → 单维度统计标题显示成 literal「undefined：xxx · 3 次」
    「悄悄错、且不报错」正是这三条的危险之处，所以机械查，不靠人记。

    另外查「三驾马车」：有默认值的必选组必须在 REQUIRED_PICK / ensureModuleDefaults /
    _defaultPicks 三处都登记，少一处要么被拦住不给保存，要么一进维度就划不动（判脏）。
    """
    out = []
    store_p = os.path.join(root, 'utils', 'store.js')
    index_p = os.path.join(root, 'pages', 'index', 'index.js')
    look_p = os.path.join(root, 'pages', 'look', 'look.js')
    topt_p = os.path.join(root, 'cloudfunctions', 'analysis', 'recText.js')
    for p in (store_p, index_p, look_p, topt_p):
        if not os.path.exists(p):
            return []
    store_src = read(store_p)
    index_src = read(index_p)
    look_src = read(look_p)

    # MODULES 必须用 MODULES 那一段：store.js 里还有一份「时刻」表也是 { k, n } 的写法
    # （FIXED.am / noon / pm 之类），直接 findall 会把那批时刻当成维度报一遍——错的不是代码，
    # 是提取器。假报警一多，人就会习惯性忽略整个脚本，那比不查更糟。
    mods_arr = _js_array_literal(store_src, 'MODULES') or ''
    mods = dict(re.findall(r"\{\s*k:\s*'([\w]+)'\s*,\s*n:\s*'([^']*)'", mods_arr))
    quiet = set(re.findall(r"k:\s*'([\w]+)'[^}]*quiet:\s*true", mods_arr))
    fields = _js_object_literal(store_src, 'FIELDS') or ''
    live = [k for k in mods if k not in quiet]
    if not live or not fields:
        out.append('  MODULES / FIELDS 提取失败（%d 个维度 / FIELDS %d 字符），维度登记这条没跑。'
                   % (len(live), len(fields)))
    else:
        for k in sorted(live):
            # 别按固定缩进 / 空格数去找（`jot:  {` 这种双空格就漏了），按「 key: { 」找
            if not re.search(r"\b%s\s*:\s*\{" % re.escape(k), fields):
                out.append('%s  MODULES 里的维度 %s（%s）没有 FIELDS 骨架。'
                           '没有它这条记录**能看见但不能编辑**——checkEdit 第一行就 '
                           'return 掉了，连提示都没有。'
                           % (os.path.relpath(store_p, root), k, mods[k]))

    col = _flat_kv(_js_object_literal(store_src, 'COLMAP') or '')
    # COLMAP：每个会出现在 extSrc 里的来源都要有中文标签，否则是没标签的裸值。
    # 但有一批 src 是**刻意不进细节区**的——它们已经在别处出现过了，再写一遍就是同一个词
    # 在一行里出现两次（历史上专门为这事修过）。这一类按证据排除，不靠手抄名单：
    #   ① buildExt 里被直接排掉的（描述 / 随记类别）
    #   ② FIELDS 里标了 hideDetail 的组
    #   ③ 导出 / AI 文本里 SKIP_IN_DETAIL 跳过的那些
    def buildext_filter():
        got = _function_body(store_src, 'buildExt')
        body = got[0] if got else ''
        return set(re.findall(r"d\.src !== '([\w:]+)'", body))
    hidden = set(re.findall(r"g:\s*'([\w]+)'[^}]*hideDetail:\s*true", fields))   # ② 跨行写法要单独找
    hidden |= set(re.findall(r"hideDetail[^\n]*?g:\s*'([\w]+)'", fields))
    ex_p2 = os.path.join(root, 'utils', 'exporter.js')
    skip3 = set()
    if os.path.exists(ex_p2):
        m3 = re.search(r'SKIP_IN_DETAIL\s*=\s*\{(.*?)\}', read(ex_p2), re.S)
        if m3:
            # 老老实实写下 [\w:]+ 就好。写成 `[\w:']*([\w:]+)[\w:']*` 那种「前面先吞一段」的
            # 写法，前面的部分会把整个词吃掉，只给捕获组留下最后一个字母
            # （干活的是 SKIP_IN_DETAIL = { todoPrio: 1 … } → 抓出来是 ['o','t','d']），
            # 于是「跳过清单」看起来有东西、实际是空的，每一个该放行的都被报了一遍
            skip3 = set(re.findall(r"([\w:]+)\s*:\s*1", m3.group(1)))
    excused = buildext_filter() | hidden | skip3 | {'free:desc'}
    srcs = set(re.findall(r"g:\s*'([\w]+)'", fields)) | set('free:' + x for x in re.findall(r"free:\s*'([\w]+)'", fields))
    for s in sorted(srcs - excused):
        if s not in col:
            out.append('%s  COLMAP 缺 %s 的中文标签。这个字段会出现在 extSrc 里，'
                       '没标签时细节行 / 导出 / 复制里是一串没有名字的值，'
                       '读者看不出那是哪一栏。' % (os.path.relpath(store_p, root), s))

    # 看页的单维度统计标题：两份 labelMap 都要覆盖全部非静默维度
    rel_l = os.path.relpath(look_p, root)
    maps = re.findall(r'const labelMap = \{(.*?)\}', look_src, re.S)
    if len(maps) != 2:
        out.append('%s  单维度统计的 labelMap 应该是两份（非搜索态 / 搜索态），现在 %d 份。'
                   % (rel_l, len(maps)))
    for idx, body in enumerate(maps):
        got = set(re.findall(r"(\w+):\s*'", body))
        miss = [k for k in live if k not in got and k != 'today']
        if miss:
            out.append('%s  第 %d 份 labelMap 少了 %s。筛到这些维度时会显示成'
                       '「undefined：xxx · 3 次」——不报错，只有肉眼能发现。'
                       % (rel_l, idx + 1, '、'.join(miss)))

    # 三驾马车：REQUIRED_PICK / ensureModuleDefaults / _defaultPicks 必须一起登记
    req = set(re.findall(r"(\w+):\s*1", read(index_p).split('const REQUIRED_PICK')[1].split('}')[0]
                         ) if 'const REQUIRED_PICK' in index_src else [])
    ensure = _method_body(index_src, 'ensureModuleDefaults')
    defpicks = _method_body(index_src, '_defaultPicks')
    if ensure is None or defpicks is None:
        out.append('  取不到 ensureModuleDefaults / _defaultPicks 的函数体'
                   '（ensure=%s / _defaultPicks=%s），三驾马车这条没跑。'
                   '页面里是方法简写，别用只认 `function x()` 的取法。'
                   % ('有' if ensure is not None else '无', '有' if defpicks is not None else '无'))
    rel_i = os.path.relpath(index_p, root)
    # 方向一（严格）：**补了默认值的组**必须同时登记成「不许点空」，
    # 否则用户能把它点空 → 保存被必填提示拦住，界面却看不出该点哪里
    with_default = set(re.findall(r"(\w+)':\s*store\.\w+Default\(\)", ensure or '')) \
        | set(re.findall(r"d\.(\w+) =", defpicks or ''))
    for g in sorted(with_default):
        if g not in req:
            out.append('%s  %s 会自动补默认值，却没登记进 REQUIRED_PICK：'
                       '用户能把它点空，然后被必填提示拦住——界面上看不出该点哪里。'
                       % (rel_i, g))
    # 方向二：反过来。**唯一的例外**是今日的能量（todayBat）——它不许被点空，
    # 但绝不能自动补默认：一进「今日」就亮着一格，看着像已经记过了，
    # 用户就少点那一下、存下错误的档位。其余少登记的都必须补齐。
    for g in sorted(req - {'todayBat'}):
        if ensure is not None and g not in ensure:
            out.append('%s  REQUIRED_PICK 里的 %s 没在 ensureModuleDefaults 里补默认值。'
                       % (rel_i, g))
        if defpicks is not None and g not in defpicks:
            out.append('%s  REQUIRED_PICK 里的 %s 没登记进 _defaultPicks：'
                       '自动补的默认值会被当成「用户填的内容」，一进这个维度就划不动（判脏）。'
                       % (os.path.relpath(index_p, root), g))

    # 一行式字段（inline + unit，如准确率）：声明了 inline 就得有三处配套，
    # 少任何一处都**不报错**，只会表现成「那个输入框不见了」或「单位只在界面上有」：
    #   ① index.js 把它透给 wxml（inline/unit/num）
    #   ② index.wxml 有 it.inline 的渲染分支（没有就退回 textarea，占卜是 plain 布局时会挤成一整行）
    #   ③ store 的 UNIT_SUFFIX 登记了单位（否则导出和 AI 看到的是裸数字，读不出是百分比）
    wxml_p = os.path.join(root, 'pages', 'index', 'index.wxml')
    inl = sorted(set(re.findall(r"free:\s*'(\w+)'[^}\n]*inline:\s*true", store_src)))
    if inl and os.path.exists(wxml_p):
        wxml = read(wxml_p)
        # 注释行剔掉：wxml 里这几处的上方都写着解释为什么这么写的注释，
        # 注释里出现同样的字样不算「渲染分支存在」
        live = '\n'.join(ln for ln in wxml.split('\n') if '<!--' not in ln)
        idx_src = read(index_p)
        # 判据要**精确到那一行的条件表达式**。查「文件里有没有 it.inline」会漏：
        # 记页有两种布局（plain / 常规），各有一处 inline 分支，把其中一处改成
        # false && 之后子串仍在，检查照样通过——这已经是本脚本第五次栽在子串断言上。
        for cond, where in (("wx:if=\"{{it.type==='free' && it.inline}}\"", 'plain 布局'),
                            ("wx:if=\"{{item.type==='free' && item.inline}}\"", '常规布局')):
            if cond not in live:
                out.append('%s  FIELDS 里有 inline 字段（%s），但 wxml 的%s没在渲染它。'
                           '输入框会退回整行 textarea，或整个不出现——页面照常编译，只是少一个框。'
                           % (os.path.relpath(wxml_p, root), '、'.join(inl), where))
        if 'unit: it.unit' not in idx_src:
            out.append('%s  FIELDS 里有 inline 字段，但 buildComposer 没把 unit 透出来。'
                       '单位不会显示在输入框后面。' % rel_i)
        if '{{it.unit}}' not in live or '{{item.unit}}' not in live:
            out.append('%s  有 inline 字段但 wxml 没渲染单位（it.unit / item.unit）——'
                       '输入框后面不会显示 %%。' % os.path.relpath(wxml_p, root))
        units = _js_unit_map(store_src)
        for k in inl:
            if units is not None and ('free:' + k) not in units:
                out.append('%s  FIELDS 里的 %s 声明了 inline/unit，却没在 UNIT_SUFFIX 里登记单位。'
                           '界面上输入框后面有「%%」，导出和喂给 AI 的文本里却是裸数字——'
                           '同一个数在一处看得出是百分比、另一处看不出。'
                           % (os.path.relpath(store_p, root), k))
    return out


def check_rec_action_handlers(root):
    """操作条组件发出的每一种按钮，**每个挂载它的页面都得接住**。

    为什么要有这条：组件的 compute() 决定显示哪些按钮，点下去只是 triggerEvent 发一个 type。
    页面如果没对应的分支，它会被 if-else 链的末尾静默吞掉——**点了没反应，而且没有任何报错**
    （历史上「改 / 删除」在记页和看页点不动就是这么回事：'edit'/'del' 被前面一条 return 截了）。
    「看看都有着这种行为」正是这类 bug 难查的原因：代码看着很正常。

    清单页（pages/list/list.js）不参与这条：它只放行待办 / 随记（见 canList），
    那些维度的按钮和记录operations 是它自己的另一套，硬套全集会误报。
    """
    out = []
    comp_p = os.path.join(root, 'components', 'rec-actions', 'rec-actions.js')
    if not os.path.exists(comp_p):
        return []
    comp_src = read(comp_p)
    types = set(re.findall(r"type:\s*'([\w]+)'", comp_src))
    if not types:
        out.append('%s  提取不到按钮类型（%d 个），这条比对没跑。'
                   % (os.path.relpath(comp_p, root), len(types)))
        return out
    for rel in ('pages/index/index.js', 'pages/look/look.js'):
        p = os.path.join(root, rel)
        if not os.path.exists(p):
            continue
        src = read(p)
        body = _method_body(src, 'onRecAction')
        if body is None:
            out.append('%s  取不到 onRecAction（页面里是方法简写），这条比对没跑。' % rel)
            continue
        miss = sorted(t for t in types if ("=== '%s'" % t) not in body)
        if miss:
            out.append('%s  操作条上的 %s 在这个页面没有对应分支。'
                       '按钮照样显示、点了照样触发事件，然后被 if-else 链末尾静默吞掉——'
                       '什么都不发生，也不报错。（「回顾」只在占卜记录上出现，'
                       '在另一个页面忘了加分支，用户只会觉得这个按钮时灵时不灵）'
                       % (rel, '、'.join(miss)))
    return out


def check_graph_no_manage(root):
    """纯图示档位组（剩余能量 / 心情指数）不许露出「✎ 管理」入口。

    为什么要有这条：它们不是选项池——5 个档位写死在代码里（BATTERIES / MOODS）。
    给个管理入口，用户点进去是一张空白的可增删列表，在里面加的词既不会出现在格子上、
    也永远不会被 AI 看到，但用户以为自己「加过了」。是一次必输的操作，还不报错。

    判据一：这类组在 store.js 的 GRAPH_GROUPS 里集中登记，而不是在页面上枚举组名——
      枚举的写法（`it.group!=='todayBat'`）每加一个新档位组就要改一遍 wxml，
      漏改就重新露出一个无效入口。现在是 index.js 统一算 canManage，wxml 只认这个标记。
    判据二：登记过的组必须在 FIELDS 里真的用得上，别留死条目。
    """
    out = []
    store_p = os.path.join(root, 'utils', 'store.js')
    index_p = os.path.join(root, 'pages', 'index', 'index.js')
    wxml_p = os.path.join(root, 'pages', 'index', 'index.wxml')
    for p in (store_p, index_p, wxml_p):
        if not os.path.exists(p):
            return []
    store_src, index_src, wxml_src = read(store_p), read(index_p), read(wxml_p)

    graph = _js_object_literal(store_src, 'GRAPH_GROUPS')
    if graph is None:
        out.append('%s  找不到 GRAPH_GROUPS。没有它，「哪些组不该给管理入口」就只能在页面上'
                   '枚举组名——每加一个 5 格档位组都要记得改一遍 wxml。'
                   % os.path.relpath(store_p, root))
        return out
    keys = sorted(re.findall(r"(\w+):\s*1", graph))
    if not keys:
        out.append('%s  GRAPH_GROUPS 是空的（提取器与写法可能对不上，别当成「没有这类组」）。'
                   % os.path.relpath(store_p, root))
        return out
    if 'isGraphGroup' not in store_src:
        out.append('%s  缺 isGraphGroup 判断函数（判据要集中在这里，别散到页面上去）。'
                   % os.path.relpath(store_p, root))

    # 登记过的组必须真的在 FIELDS 里被引用（否则是死条目，白占一次判断）
    fields = _js_object_literal(store_src, 'FIELDS') or ''
    for k in keys:
        if "g: '%s'" % k not in fields:
            out.append('%s  GRAPH_GROUPS 里的 %s 在 FIELDS 里没有引用（死条目）。'
                       % (os.path.relpath(store_p, root), k))

    # index.js：给 canManage 赋值的那一行必须用 store.isGraphGroup。
    # 不能查「整个文件里有没有 isGraphGroup」——index.js 里 onManage 的兜底也用了一次，
    # 光那一处就足以让子串检查通过，而真正决定「露不露入口」的算式已经退化成写死组名。
    # 写死组名＝新加一个纯图示档位组就重新露出一个无效入口。这个坑真踩过一次。
    cmg = [ln.strip() for ln in index_src.split('\n') if 'canManage =' in ln]
    if not cmg:
        out.append('%s  buildComposer 没算 canManage，wxml 就分不出哪一组不该给入口。'
                   % os.path.relpath(index_p, root))
    for ln in cmg:
        if 'isGraphGroup' not in ln:
            out.append('%s  canManage 的算式退回了写死组名：%s\n'
                       '    ——应该是 store.isGraphGroup(it.g)。'
                       % (os.path.relpath(index_p, root), ln[:100]))

    # wxml：管理入口一律认 canManage 标记，不许再按组名排除
    relw = os.path.relpath(wxml_p, root)
    for ln in wxml_src.split('\n'):
        if 'bindtap="onManage"' not in ln:
            continue
        # 主项那个入口（data-g="{{composer.main}}"）不进 catItems，另行判断；
        # 其余每一处都必须用 canManage，出现具体组名就是又绕回了「枚举」
        if 'canManage' in ln:
            continue
        if 'composer.main' in ln:
            continue
        out.append('%s  管理入口不是按 canManage 判断：%s\n'
                   '    ——按组名枚举的话，新加一个纯图示档位组就会重新露出无效入口。'
                   % (relw, ln.strip()[:120]))
    return out


def check_exporter_rectext_alignment(root):
    """可读导出（utils/exporter.js）与喂给 AI 的文本（recText.js）必须同步改。

    为什么要有这条：这两份是**同一口径的两处实现**（用户选定「喂 AI 的格式与可读导出
    完全对齐」）。recText 拿不到 wx，只能复刻 exporter 的输出，复刻就会漂移——
    心情指数就是这样只在一边落了地：AI 那边写的是「心情指数：有点低（2/5 格）」，
    导出给人的还是孤零零一个「心情指数：2」。同一个数两种说法，用户对账时只觉得
    「导出好像不对」，但说不出哪里不对。

    判据一：两边的 SKIP_IN_DETAIL 键集必须一致。漏一个＝那一项在一边被原样再写一遍。
    判据二：两边对「今日」的 5 格量（todayBat / todayMood）都要做「名字（N/5 格）」的补写。
    判据三：末尾汇总里也要有这两个量（平均几格 / 几天偏低），同样不许只在一边加。
    """
    out = []
    ex_p = os.path.join(root, 'utils', 'exporter.js')
    rt_p = os.path.join(root, 'cloudfunctions', 'analysis', 'recText.js')
    if not (os.path.exists(ex_p) and os.path.exists(rt_p)):
        return []
    ex_src, rt_src = read(ex_p), read(rt_p)
    rx, rt_rel = os.path.relpath(ex_p, root), os.path.relpath(rt_p, root)

    def skip_keys(s):
        m = re.search(r'SKIP_IN_DETAIL\s*=\s*\{(.*?)\}', s, re.S)
        if not m:
            return None
        return sorted(re.findall(r'[\'"]?([\w:]+)[\'"]?\s*:\s*1', m.group(1)))

    ex_k, rt_k = skip_keys(ex_src), skip_keys(rt_src)
    if not ex_k or not rt_k:
        out.append('  SKIP_IN_DETAIL 提取失败（exporter=%s / recText=%s），这条比对没跑。'
                   % ('有' if ex_k else '无', '有' if rt_k else '无'))
    elif ex_k != rt_k:
        miss_rt = [k for k in ex_k if k not in rt_k]
        miss_ex = [k for k in rt_k if k not in ex_k]
        out.append('%s / %s  SKIP_IN_DETAIL 不一致：\n      exporter: %s\n      recText : %s\n'
                   '%s——漏的那一边会把同一项再写一遍，写成数字（如「心情指数：2」）。'
                   % (rx, rt_rel, ex_k, rt_k,
                      ('recText 少了 %s' % miss_rt) if miss_rt else ('exporter 少了 %s' % miss_ex)))

    def today_block(s):
        i = s.find("r.m === 'today'")
        if i < 0:
            return None
        j = s.find('\n  }', i)          # 到本 if 块的闭合为止
        return s[i:j] if j > 0 else s[i:i + 600]

    ex_b, rt_b = today_block(ex_src), today_block(rt_src)
    if ex_b is None or rt_b is None:
        out.append('  「今日」补写段提取失败（exporter=%s / recText=%s），这条比对没跑。'
                   % ('有' if ex_b else '无', '有' if rt_b else '无'))
    else:
        for k in ('todayBat', 'todayMood'):
            if k not in ex_b:
                out.append('%s  「今日」补写段里没有 %s：导出给人的会是原始档位值'
                           '（「心情指数：2」这种），和 AI 看到的对不上。' % (rx, k))
            if k not in rt_b:
                out.append('%s  「今日」补写段里没有 %s：AI 看不到这一项。' % (rt_rel, k))

    # 汇总段：两边都要算出这两个量的「平均几格 / 几天偏低」。
    # 只在一边加的后果是两份文本的结论不一样——人读的那份看不出心情趋势，
    # AI 却已经在按它写回看报告，用户无从发现。
    def summary_block(s):
        i = s.find('每日剩余能量')
        if i < 0:
            return None
        return s[max(0, i - 900):i + 900]

    ex_s, rt_s = summary_block(ex_src), summary_block(rt_src)
    if ex_s is None or rt_s is None:
        out.append('  汇总段提取失败（exporter=%s / recText=%s），这条比对没跑。'
                   % ('有' if ex_s else '无', '有' if rt_s else '无'))
    else:
        for k, name in (('todayBat', '每日剩余能量'), ('todayMood', '每日心情指数')):
            if k not in ex_s:
                out.append('%s  汇总里没有 %s：人读的那份导出少了这个量，'
                           '和 AI 看到的结论对不上。' % (rx, name))
            if k not in rt_s:
                out.append('%s  汇总里没有 %s：AI 看不到这个量的平均与低谷。' % (rt_rel, name))
    return out


def check_no_inline_rectext(root):
    """云函数里不许再出现「自己拼记录文本」的内联副本。

    为什么要有这条：buildMessages / buildProfileMessages / buildPersonaMessages
    曾经各写一遍同样的 map（`[模块] 内容 （extSrc：值） 时间`），三份副本改一处
    忘另两处，就会出现「回看里是中文标签、深度报告里还是 free:desc」这种对不上的账，
    而且不报错、不白屏。现在统一走 recText.recText()。
    判据：这些函数体里不该再出现 `r.extSrc` 与 `r.ext` 成对遍历拼字符串的写法。
    """
    out = []
    for p in walk_cloudfn(root):
        src = read(p)
        rel = os.path.relpath(p, os.path.dirname(os.path.dirname(p)))
        for fn in ('buildMessages', 'buildProfileMessages', 'buildPersonaMessages'):
            got = _function_body(src, fn)
            if not got:
                continue
            # `r.extSrc || []).map(` 这类：直接从 extSrc 生成带标签的片段
            if re.search(r'\(\s*\w+\.extSrc\s*\|\|\s*\[\s*\]\s*\)\s*\.\s*map', got[0]):
                out.append('%s  %s() 里又在内联拼记录文本（直接遍历 extSrc 生成标签片段）。'
                           '三处各拼一份，改一处忘另两处就对不上了。改成调 recText.recText()。'
                           % (rel, fn))
    return out


def check_scale_groups(root):
    """5 格量（纯图示档位组）的四张表必须互相对得上：SCALES / SCALE_KIND / GRAPH_GROUPS / 主题色。

    为什么要有这条：5 格量原先只有今日的能量 / 心情两组，档位表与取值函数各写一份
    （BATTERIES + batLevel / MOODS + moodLevel）。书·剧加了第三、四组之后，
    「加一组要改六处」这件事第一次真的咬人——而漏掉任何一处都不报错，只在那一处的
    页面上显示成英文代号、空白格子，或者两个量画成同一个颜色分不开。
    所以先把它收敛成一张登记表（store 的 SCALES + SCALE_KIND），再机械地查这张表自身完整。

    具体查四件事：
      ① GRAPH_GROUPS 里的每个组都在 SCALES 里登记了档位表（否则取档位名返回空）
      ② SCALES 里的每个组都在 GRAPH_GROUPS 里（否则会露出无效的「✎ 管理」入口）
      ③ SCALES 里的每个组都在 SCALE_KIND 里映射了颜色键（否则渲染层拿不到该画什么颜色）
      ④ SCALE_KIND 的每个色键在 app.wxss 有样式、且每个启用主题都给了色
         ——第 ④ 条最容易漏：颜色漏了不报错，那条量只是悄悄回落成 accent，
         和旁边那条并排时看着像同一个量画了两遍。
    """
    out = []
    store_p = os.path.join(root, 'utils', 'store.js')
    themes_p = os.path.join(root, 'utils', 'themes.js')
    wxss_p = os.path.join(root, 'app.wxss')
    index_p = os.path.join(root, 'pages', 'index', 'index.js')
    wxml_p = os.path.join(root, 'pages', 'index', 'index.wxml')
    for p in (store_p, themes_p, wxss_p, index_p, wxml_p):
        if not os.path.exists(p):
            return []
    store_src, themes_src = read(store_p), read(themes_p)
    wxss, index_src, wxml = read(wxss_p), read(index_p), read(wxml_p)
    rs, rw = os.path.relpath(store_p, root), os.path.relpath(wxss_p, root)

    # SCALES 的值是一串变量名（BATTERIES / MOODS / WOWS / LOVES…），逐个取出它定义的组
    scales = _js_object_literal(store_src, 'SCALES') or ''
    names = re.findall(r"(\w+):\s*(\w+)", scales)
    if not names:
        out.append('%s  提取不到 SCALES 的登记项（%d 字符）。5 格量的档位表现在应当集中在这里——'
                   '散成 BATTERIES / MOODS 各一份函数的话，加一组要改六处，漏一处不报错。'
                   % (rs, len(scales)))
        return out
    # 组名 -> 定义它的那份数组常量
    var2group = {}
    for g, var in names:
        var2group.setdefault(var, g)
    sgroups = set()
    for var in var2group:
        arr = _js_array_literal(store_src, var)
        if arr is None:
            out.append('%s  SCALES 里的 %s 找不到定义（它应当是一个 5 项的档位数组常量）。'
                       '取档位名 / 取格数会返回空，那条量在页面上显示成空白。'
                       % (rs, var))
            continue
        sgroups.add(var2group[var])

    graph = _js_object_literal(store_src, 'GRAPH_GROUPS') or ''
    ggroups = set(re.findall(r"(\w+):\s*1", graph))
    kinds = _js_object_literal(store_src, 'SCALE_KIND') or ''
    kmap = dict(re.findall(r"(\w+):\s*'([\w]+)'", kinds))

    # SCALE_NO_CSS 登记的色键是有意的例外（今日的能量条就吃 --accent，本就没有独立色类）——
    # 靠「wxss 里恰好没有这几行」来推断例外，早晚会有人好心补上 .ebar-bat，
    # 然后多出一套同色样式，白带一个没人维护的分叉。
    nocss = _js_object_literal(store_src, 'SCALE_NO_CSS') or ''
    nokeys = set(re.findall(r"(\w+):\s*1", nocss))

    for g in sorted(sgroups - ggroups):
        out.append('%s  SCALES 里的 %s 没登记进 GRAPH_GROUPS：它不是选项池（档位写死在代码里），'
                   '不给「✎ 管理」入口是对的——漏登记就会露出一个点进去是空白页的入口，'
                   '而用户在里加的词永远不会出现在格子上。' % (rs, g))
    for g in sorted(ggroups - sgroups):
        out.append('%s  GRAPH_GROUPS 里的 %s 没在 SCALES 登记档位表：取档位名返回空，'
                   '那条量的格子里就没有小字（看着像一排空方块）。' % (rs, g))
    for g in sorted(sgroups - set(kmap)):
        out.append('%s  SCALES 里的 %s 没在 SCALE_KIND 映射颜色键：渲染层拿不到该画什么色，'
                   '会回落成默认的 accent，和旁边那条量并排时看着像同一个东西。' % (rs, g))
    for k in sorted(nokeys - set(kmap.values())):
        out.append('%s  SCALE_NO_CSS 里的色键 %s 已经不是任何一组的色键了——'
                   '它是改色键名之后留下的死条目，会让人以为还有一组要走这个例外。' % (rs, k))

    # 渲染层不许再退回「写死组名」判 5 格量：加一组时那种写法要改三处，漏一处不报错
    if not any(re.search(r'store\.scaleOf\(', ln) and not ln.strip().startswith('//')
               for ln in index_src.split('\n')):
        out.append('%s  buildComposer 不再查 store.scaleOf——5 格量的分支退回了写死组名，'
                   '新加的一组不会被渲染成格子（只当普通 chips，页面照常编译）。'
                   % os.path.relpath(index_p, root))
    live_wxml = '\n'.join(ln for ln in wxml.split('\n') if '<!--' not in ln)
    if 'todayBat' in live_wxml:
        out.append('%s  wxml 里还在按 todayBat 写死判断 5 格量——新加的一组不会画成格子。'
                   '应该统一按 it.graph 分岔（判据由 store.scaleOf 给）。'
                   % os.path.relpath(wxml_p, root))
    if 'ebar-{{it.kind}}' not in live_wxml:
        out.append('%s  wxml 没按 item.kind 生成 5 格条的颜色类名（ebar-{{it.kind}}）——'
                   '几条量会画成同一个颜色，在密集布局里分不出谁是谁。'
                   % os.path.relpath(wxml_p, root))

    # 色键 -> 样式 / 主题色。少一处都只表现为「那条量跟旁边那条同色」，不报错
    # 色键 -> 样式 / 主题色。少一处都只表现为「那条量跟旁边那条同色」，不报错
    for g in sorted(sgroups):
        k = kmap.get(g)
        if not k:
            continue
        if k in nokeys:
            continue
        for sel in ('.tl-bar-%s' % k, '.tl-cell.%s.on' % k, '.ebar-%s .ebar-cell.on' % k,
                    '.ebar-%s .ebar-cell.cur' % k):
            if sel not in wxss:
                out.append('%s  5 格量 %s（色键 %s）缺样式 %s——只读态或编辑态会画成默认色。'
                           % (rw, g, k, sel))
        nthemes = len(re.findall(r"\{\s*k:\s*'[a-z]+',\s*n:\s*'", themes_src))
        ncol = len(re.findall(r"(?:^|[\s,{])%s:\s*'#" % re.escape(k), themes_src, re.M))
        if nthemes and ncol < nthemes:
            out.append('%s  色键 %s 只在 %d/%d 个主题里给了值——缺的主题下这条量会回落成 accent，'
                       '和旁边那条并排时看着像同一个量。'
                       % (os.path.relpath(themes_p, root), k, ncol, nthemes))
    return out


def check_optpool_filtering(root):
    """凡是**拿选项池当「用户真实的池」去过滤东西**的地方，池子没就绪时必须先让开。

    背景（真实 bug）：快捷记面板（custom-tab-bar）把用户在「设置」里勾选的类别，
    按 todoKind / jotKind 两个池过滤一遍，好剔掉已经被删掉的类别。
    但 store.getOPT() 在 G.OPT 还没载入（冷启动，app.js 的 ensureAll 还在路上）时
    **回退到代码里的内置默认池**——于是用户自己加的类别被当成「已删除」而静默筛掉。
    表现是「重新打开小程序后第一次点球，类别少了几项」，第二次点又全了（那时池子到了）。
    难复现的原因：它只在冷启动那一瞬出现，且第二次点自己就好了。

    为什么这条检查守得住：这类过滤的**后果是不对称的**——池子没到时「多摆几个」只是
    难看，「少摆几个」是丢用户数据。所以判据是「有没有 optsReady 守卫」，
    而不是「过滤逻辑对不对」（后者要跑起来才知道池子状态）。
    顺带要求 store 真的导出 optsReady，否则守卫写了个空调用、恒为真。
    """
    out = []
    store_p = os.path.join(root, 'utils', 'store.js')
    if not os.path.exists(store_p):
        return out
    store_src = read(store_p)
    if 'function optsReady' not in store_src:
        out.append('%s  没有 optsReady()：选项池未就绪时无法判断，'
                   '任何「按池过滤」的逻辑都会在冷启动那一瞬用内置默认池误删用户数据。'
                   % os.path.relpath(store_p, root))
    elif re.search(r"module\.exports[\s\S]*?\boptsReady\b", store_src) is None:
        out.append('%s  定义了 optsReady() 但没导出：调用方拿到 undefined，'
                   '守卫会静默失效（写成 optsReady && optsReady() 时恒为 false）。'
                   % os.path.relpath(store_p, root))

    # 已审议过的豁免：**刻意不加守卫**，连同理由一起登记。
    # 靠「读代码猜它危不危险」会两头出错：漏判就放过真 bug，误判就报假警。
    # 假警比漏报更糟——会让人习惯性忽略整个脚本，所以豁免必须写清楚为什么安全，
    # 而不是把判据放宽到「都放过」。
    #   utils/pageBase.js: copyRec 用 isPick 只决定【】里 txt 与 desc 的先后顺序，
    #     不过滤掉任何条目；且只在用户主动点「复制」时才跑，那时机上池子早已就绪。
    exempt = {'utils/pageBase.js'}

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ('.git', 'node_modules', 'miniprogram_npm')]
        for fn_ in filenames:
            if not fn_.endswith(JS_EXT):
                continue
            p = os.path.join(dirpath, fn_)
            rel = os.path.relpath(p, root)
            if p == store_p or rel in exempt:
                continue
            src = read(p)
            if 'getOPT(' not in src:
                continue
            # 出现「池.indexOf(...) >= 0」这种过滤，且该文件里没有 optsReady 守卫
            filt = re.findall(r"\b(?:pool|jpool|opts|kinds|list)\w*\s*\.indexOf\([^)]*\)\s*>=\s*0", src)
            if not filt:
                continue
            # 判「有没有守卫」要看**它真的被调用了**，而不是文件里出现过这个词。
            # 写成 store.optsReady && store.optsReady() 时，函数缺失会让左边短路成
            # undefined——守卫看着在，实际恒假，恰好在最需要它的冷启动那一瞬失效。
            # 光「文件里调用过 optsReady()」不够：过滤那几行本身必须落在守卫里。
            # 否则别处一句无关的 optsReady 调用就能冒充守卫（把守卫改成 if (true) 就骗过了）。
            # 判法：过滤语句所在的那一行，往上找最近的一行 if，看它有没有判 optsReady。
            lines = src.split('\n')
            filt_lines = [i for i, l in enumerate(lines)
                          if re.search(r"\b(?:pool|jpool|opts|kinds|list)\w*\s*\.indexOf\([^)]*\)\s*>=\s*0", l)]
            guarded = False
            for i in filt_lines:
                for j in range(i, max(-1, i - 6), -1):
                    if re.search(r"\bif\s*\(", lines[j]):
                        guarded = bool(re.search(r"optsReady", lines[j]))
                        break
            if not guarded:
                out.append('%s  按选项池过滤（%s 处）但过滤语句不在 optsReady 守卫里：'
                           '冷启动时池子还没载入，getOPT 回退到内置默认池，'
                           '用户自己加的选项会被当成「已删除」而静默筛掉。'
                           % (rel, len(filt_lines)))
                continue
            guard = len(re.findall(r"optsReady\s*\(\s*\)", src))
            if not guard:
                out.append('%s  按选项池过滤（%s 处）却没有真正调用 optsReady()：'
                           '冷启动时池子还没载入，getOPT 回退到内置默认池，'
                           '用户自己加的选项会被当成「已删除」而静默筛掉。'
                           % (rel, len(filt)))
            elif guard and len(re.findall(r"optsReady\s*&&", src)):
                out.append('%s  optsReady 写成了 `optsReady && optsReady()`：'
                           '函数缺失时左边短路成 undefined，守卫恒假——'
                           '恰好在最需要它的冷启动那一瞬失效。用 `!store.optsReady()` 直接判。' % rel)
    # 豁免名单里已经没人了（文件改名 / 删掉了）——留着会让检查名存实亡
    for rel in sorted(exempt):
        if not os.path.exists(os.path.join(root, rel)):
            out.append('%s  check_optpool_filtering 的豁免名单里还有它，但文件已经不在了——'
                       '请确认那处过滤的去向，别让检查名存实亡。' % rel)
    return out


def check_scroll_hints(root):
    """横向可滚动区域的两端提示要**成对**：能往一边滚，就要在另一边也给出提示。

    背景（真实 bug）：记卡的维度标签行只有右侧有渐变遮盖（tagFade），
    往回滚时左边那一排 chip 被硬切掉一半，看着像渲染坏了，而不是「还能往回滚」。

    为什么要机械地查：「只有右侧」这件事在页面上表现为「少了个渐变」，
    不报错、不少功能、也没有任何一条测试会失败——它只是不太好看。
    靠人记得「这个滚动区该有两份提示」必然漏，所以查「有没有单向的提示」。

    同类第二条：快捷记面板（custom-tab-bar）要能滚（max-height + overflow-y）。
    它从球上方往上长，类别最多 10 个，键盘弹着时可用高度只剩一点点，
    顶出屏幕的部分会被裁掉——被裁的那些在下面，看着就像「类别没显示全」。
    """
    out = []
    index_p = os.path.join(root, 'pages', 'index', 'index.js')
    wxml_p = os.path.join(root, 'pages', 'index', 'index.wxml')
    if os.path.exists(index_p) and os.path.exists(wxml_p):
        js, wxml = read(index_p), read(wxml_p)
        rel = os.path.relpath(wxml_p, root)
        # 右侧提示在 wxml 里是 tagFade，左侧那条必须同时存在（数据字段 + 节点）
        if 'tagFade' in js or 'tagrow-fade' in wxml:
            for field, why in (('tagFade', '右侧（内容超出时提示右边还有）'),
                               ('tagFadeL', '左侧（往回滚过时提示左边还有）')):
                if field not in wxml:
                    out.append('%s  维度标签行有横向滚动，但只渲染了单向提示：缺 %s。'
                               '%s缺了，滚到那一头时边缘的 chip 被硬切掉一半，'
                               '看着像渲染坏了，而不是「还能往那边滚」。'
                               % (rel, field, why))
            if 'tagFadeL' in wxml and 'tagFadeL' not in js:
                out.append('%s  声明了 tagFadeL 但 index.js 里从不置它：'
                           '左侧遮盖永远不显示。' % os.path.relpath(index_p, root))
            if 'tagFadeL' in js and 'tagFadeL' not in wxml:
                out.append('%s  index.js 算了 tagFadeL，但 wxml 里没有对应的节点：'
                           '遮盖不会显示（数据层与视图层脱节，不报错）。'
                           % os.path.relpath(index_p, root))

    # 快捷记面板：吸底往上长，必须有高度上限 + 自己能滚
    qa_wxss = os.path.join(root, 'custom-tab-bar', 'index.wxss')
    qa_wxml = os.path.join(root, 'custom-tab-bar', 'index.wxml')
    if os.path.exists(qa_wxss) and os.path.exists(qa_wxml):
        wxss, wxml = read(qa_wxss), read(qa_wxml)
        rel = os.path.relpath(qa_wxss, root)
        if '.qa {' in wxss and 'position: fixed' in wxss.split('.qa {')[1].split('}')[0]:
            blk = wxss.split('.qa {')[1].split('}')[0]
            blk_raw = blk
            if 'max-height' not in re.sub(r'/\*[\s\S]*?\*/', '', blk):
                out.append('%s  快捷记面板是 fixed 吸底、往上长，却没有 max-height：'
                           '类别最多 10 个，键盘弹着时顶出屏幕的部分被裁掉，'
                           '看着像「类别没显示全」。' % rel)
            # 判 overflow 要同时躲两个坑：① 注释里常写「overflow」作说明；
            # ② -webkit-overflow-scrolling 里也含「overflow」这个子串——
            # 拿子串匹配判的话，删掉真正的 overflow-y 反而判不出（那一行还在）。
            # 所以只认独立的 overflow 属性名。
            blk_code = re.sub(r'/\*[\s\S]*?\*/', '', blk)
            has_of = re.search(r'(?<![-\w])overflow(-[xy])?\s*:', blk_code) is not None
            if 'max-height' in blk_code and not has_of:
                out.append('%s  快捷记面板有 max-height 却没 overflow：'
                           '超出的部分仍然直接被裁掉，加了上限也没用。' % rel)
            # 自己要滚，就得拦住滚动冒泡，否则会带着背后的页面一起滚；
            # 而 catchtouchmove 绑的方法必须真的存在，绑了个没有的会「找不到 handler」，
            # 面板整个点不动（这类错只在真机上点一下才暴露）。
            qa_js = os.path.join(root, 'custom-tab-bar', 'index.js')
            if 'catchtouchmove' in wxml and os.path.exists(qa_js):
                m = re.search(r'catchtouchmove="(\w+)"', wxml)
                if m and ('%s(' % m.group(1)) not in read(qa_js):
                    out.append('%s  面板上绑了 catchtouchmove="%s"，但 index.js 里没有这个方法：'
                               '点面板时会报「找不到 handler」，面板整个点不动。'
                               % (os.path.relpath(qa_wxml, root), m.group(1)))
    return out


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    args = sys.argv[1:]
    if args:
        js = [a for a in args if a.endswith(JS_EXT)]
        wxml = [a for a in args if a.endswith(WXML_EXT)]
        cloudfn = []
    else:
        js, wxml = walk(root)
        cloudfn = walk_cloudfn(root)
        cloudfn_all = walk_cloudfn_all(root)

    problems = []
    for p in js + wxml:
        if not os.path.exists(p):
            problems.append('%s  文件不存在' % p)
            continue
        problems += check_js(p) if p.endswith(JS_EXT) else check_wxml(p)
    for p in cloudfn:
        problems += check_js(p)
        problems += check_cloudfn_docs(p)
        problems += check_contract_fields(p)
        problems += check_prompt_slots(p)
        problems += check_record_guide(p)
    # index.js 之外的同目录模块（如 recText.js）也要过语法检查
    for p in cloudfn_all:
        if p not in cloudfn:
            problems += check_js(p)
    # 跨文件的约束只在全量扫描时查（依赖 utils/store.js 与云函数同时在场）
    if not args:
        problems += check_rec_labels(root)
        problems += check_rec_action_handlers(root)
        problems += check_dimension_registration(root)
        problems += check_exporter_rectext_alignment(root)
        problems += check_graph_no_manage(root)
        problems += check_scale_groups(root)
        problems += check_optpool_filtering(root)
        problems += check_scroll_hints(root)
        problems += check_no_inline_rectext(root)

    for line in problems:
        sys.stdout.write(line + '\n')
    n_all = len(set(cloudfn) | set(cloudfn_all))
    sys.stdout.write('检查 js %d 个 / wxml %d 个 / 云函数 %d 个，问题 %d 个\n'
                     % (len(js), len(wxml), n_all, len(problems)))
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
