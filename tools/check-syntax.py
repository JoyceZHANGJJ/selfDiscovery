#!/usr/bin/env python3
# tools/check-syntax.py —— 改完自查：括号 / 引号 / 标签配对
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
# 它不是完整的解析器（不做语法树、不查语义），真正的语法错误仍然以微信开发者工具为准；
# 能做的只是「提交 / 编译前先花一秒扫一遍」，把这类低级错误挡在前面。
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


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    args = sys.argv[1:]
    if args:
        js = [a for a in args if a.endswith(JS_EXT)]
        wxml = [a for a in args if a.endswith(WXML_EXT)]
    else:
        js, wxml = walk(root)

    problems = []
    for p in js + wxml:
        if not os.path.exists(p):
            problems.append('%s  文件不存在' % p)
            continue
        problems += check_js(p) if p.endswith(JS_EXT) else check_wxml(p)

    for line in problems:
        sys.stdout.write(line + '\n')
    sys.stdout.write('检查 js %d 个 / wxml %d 个，问题 %d 个\n' % (len(js), len(wxml), len(problems)))
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
