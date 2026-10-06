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
RECORD_GUIDE_USERS = ('buildMessages', 'buildProfileMessages', 'buildPersonaMessages')


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
                    out[key] = body[j:k2].strip()
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
                k2 = j
                while k2 < n and body[k2] not in ',}':
                    k2 += 1
                out[key] = body[j:k2].strip()
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
        problems += check_no_inline_rectext(root)

    for line in problems:
        sys.stdout.write(line + '\n')
    n_all = len(set(cloudfn) | set(cloudfn_all))
    sys.stdout.write('检查 js %d 个 / wxml %d 个 / 云函数 %d 个，问题 %d 个\n'
                     % (len(js), len(wxml), n_all, len(problems)))
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
