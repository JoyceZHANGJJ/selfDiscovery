# tools/test-resetall.py —— 注入测试：验「一键恢复全部」的分支行为
#
# 为什么用注入测试而不是真连数据库：云函数里的 promptResetAll 依赖 wx-server-sdk，
# 单元测试跑不起来。这里把它的循环体原样抄成纯函数版本，喂假数据，验证
# 「改过的恢复、没改的跳过、失败的报出来、全失败报错」四条关键分支。
import re, sys, os

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                   'cloudfunctions', 'analysis', 'index.js')
src = open(SRC, encoding='utf-8').read()

# 1) 云函数里必须有 promptResetAll 分支
if "action === 'promptResetAll'" not in src:
    print('FAIL 云函数没有 promptResetAll 分支'); sys.exit(1)

# 2) 必须先比正文再决定动不动手（否则会凭空刷历史版本）
# 不要用正则去「配对大括号」——这个分支体最后一句 return 后面就跟着闭合的
# 大括号（同一行），正则一遇到缩进变化就匹配不上，而且很容易在改动后
# 「匹配到一半」给出假通过。改成按行号切：从 promptResetAll 那行往后，
# 一直取到**缩进和 if 本身相同**的那行为止。这跟人读代码的方式一致。
lines = src.split('\n')
start = None
for i, ln in enumerate(lines):
    if "action === 'promptResetAll'" in ln and ln.lstrip().startswith('if '):
        start = i
        break
if start is None:
    print('FAIL 找不到 promptResetAll 分支'); sys.exit(1)
indent = len(lines[start]) - len(lines[start].lstrip())
end = start + 1
while end < len(lines):
    ln = lines[end]
    if ln.strip() and (len(ln) - len(ln.lstrip())) <= indent:
        break
    end += 1
body = '\n'.join(lines[start:end])
if len(body) < 10:
    print('FAIL promptResetAll 分支体异常短，可能结构被改坏'); sys.exit(1)
if 'curBody === meta.body' not in body:
    print('FAIL 没有「正文相同就跳过」的判断'); sys.exit(1)
if 'skipped.push' not in body:
    print('FAIL 跳过时没有计入 skipped'); sys.exit(1)
if 'failed.push' not in body:
    print('FAIL 失败时没有计入 failed'); sys.exit(1)
if 'done.length === 0 && failed.length' not in body:
    print('FAIL 全部失败时没有返回 error（会被显示成成功）'); sys.exit(1)

# 3) 模拟几种场景
# 桩的槽位集合**跟着传入的数据走**（而不是写死四个）：写死的话，
# 「全部失败」那组会被硬塞进来的 c、d 变成成功项，于是永远测不到
# 全失败分支——第一版就是这么写的，测试反而成了摆设。
def run(db):
    """db: {slot: 当前正文, slot+'!fail': 1}。返回结果字典。"""
    slots = sorted(k for k in db if not k.endswith('!fail'))
    BUILTIN = {s: '出厂值-' + s for s in slots}
    done, skipped, failed = [], [], []
    for slot in slots:
        cur = db.get(slot, '')
        if cur and cur == BUILTIN[slot]:
            skipped.append(slot); continue
        if db.get(slot + '!fail'):
            failed.append(slot); continue
        done.append(slot)
    if done == [] and failed:
        return {'error': 'fail'}
    return {'ok': True, 'restored': len(done), 'skipped': len(skipped),
            'failed': failed, 'done': done}

# a：全是出厂值 → 一个都不该动
r = run({'a': '出厂值-a', 'b': '出厂值-b', 'c': '出厂值-c', 'd': '出厂值-d'})
assert r['restored'] == 0 and r['skipped'] == 4, r
assert r['failed'] == [], r
print('OK  全出厂值：restored=0 skipped=4，不产生新版本')

# b：改了两个 → 只恢复这两个
r = run({'a': '出厂值-a', 'b': '我改过B', 'c': '出厂值-c', 'd': '我改过D'})
assert r['restored'] == 2 and r['skipped'] == 2, r
assert sorted(r['done']) == ['b', 'd'], r
print('OK  改了 2 个：只恢复这 2 个，另外 2 个不碰')

# c：一个失败 → 必须报出来，不能当成功
# 失败标记必须放在独立的 key 里（桩读的是 db[slot + '!fail']），
# 不能塞进槽位值——那是「当前正文」，会被当成正常改过的内容恢复掉，
# 结果永远测不出失败分支（第一版就是这么写的，差点当成功能没问题）。
r = run({'a': '出厂值-a', 'b': '我改过B', 'c': '出厂值-c', 'd': '我改过D', 'd!fail': 1})
assert r['restored'] == 1 and r['failed'] == ['d'], r
print('OK  部分失败：failed=[\'d\']，前端会弹「大部分恢复了」')

# d：全部失败 → 必须返回 error
r = run({'a': 'A', 'b': 'B', 'a!fail': 1, 'b!fail': 1})
assert 'error' in r, r
print('OK  全部失败：返回 error，不会显示成成功')

# 4) 前端必须真的调这个 action，并处理 failed
P = os.path.join(os.path.dirname(SRC), '..', '..', 'pages', 'prompt', 'prompt.js')
p = open(os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
             'pages', 'prompt', 'prompt.js')), encoding='utf-8').read()
if "action: 'promptResetAll'" not in p:
    print('FAIL 前端没有调 promptResetAll'); sys.exit(1)
if 'rr.failed && rr.failed.length' not in p:
    print('FAIL 前端没有处理 failed（部分失败会被静默当成功）'); sys.exit(1)
if 'resetting' not in p:
    print('FAIL 前端没有 resetting 防重复点击'); sys.exit(1)
print('OK  前端：调了 action、处理了 failed、有防重复点击')

# 5) 按钮只在「确实有被改过的槽位」时出现
W = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
             'pages', 'prompt', 'prompt.wxml'))
w = open(W, encoding='utf-8').read()
if 'editedCount > 0' not in w:
    print('FAIL 按钮没按 editedCount 显隐'); sys.exit(1)
if 'resetAllDefault' not in w:
    print('FAIL 按钮没绑事件'); sys.exit(1)
# 表达式里不能有 `> 0` 这种多余空格（wxml 对此敏感）
if re.search(r'editedCount>\s', w):
    print('FAIL wxml 表达式里有 `editedCount>` 后面跟空格'); sys.exit(1)
print('OK  按钮：按 editedCount 显隐、事件已绑、表达式无多余空格')

print('\n注入测试全部通过（5 组）')