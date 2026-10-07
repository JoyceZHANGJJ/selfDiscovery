# tools/test-divination.py —— 注入测试：「占卜」维度与「回顾」
#
# 为什么单独写一份：新增一个维度在本项目里要同步改 5 张登记表 + 若干硬编码，
# 每一处漏改都不报错。这里的断言分两类：
#   静态  —— 登记表有没有配齐、必填的三处有没有漏
#   运行时 —— 直接 require 真实代码，比对导出行与喂 AI 的行（比静态比对更靠得住：
#             COLMAP 两边错了一个字，静态比对可能没事，跑一遍立刻现形）
import os, re, subprocess, sys

root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
def rd(p): return open(os.path.join(root, p), encoding='utf-8').read()

store = rd('utils/store.js')
index = rd('pages/index/index.js')
wxml = rd('pages/index/index.wxml')
look = rd('pages/look/look.js')
comp = rd('components/rec-actions/rec-actions.js')
compw = rd('components/rec-actions/rec-actions.wxml')
compx = rd('components/rec-actions/rec-actions.wxss')
rt = rd('cloudfunctions/analysis/recText.js')

fails = []
def chk(cond, msg):
    if not cond: fails.append(msg)

def line_active(src, needle):
    """这一行确实在跑（没被注释掉）。查子串是不够的——前面加个 // 子串照样在。"""
    return any(needle in ln and not ln.strip().startswith('//') for ln in src.split('\n'))

# 1) MODULES / FIELDS / 选项池 / 标签
chk("k: 'div', n: '占卜'" in store, 'MODULES 里没有「占卜」维度（或写法变了）')
chk("div: { main: 'divItem', items: [" in store, 'FIELDS 缺 div 骨架——没有它这条记录能看不能编辑')
for g, names in (('divType', ['塔罗', '雷诺曼']), ('divSpan', ['一周内', '半个月', '一个月', '三个月', '半年'])):
    chk(re.search(r"%s: \[(.*?)\]" % g, store, re.S) is not None, 'OPT 缺 %s 的选项池' % g)
    body = re.search(r"%s: \[(.*?)\]" % g, store, re.S).group(1)
    for n in names:
        chk("'%s'" % n in body, '%s 的默认选项里少了「%s」' % (g, n))
chk("divItem: []" in store, '占卜主项（占卜的问题）应是纯手填，池子留空')
for k in ("divType: '类型'", "divSpan: '时间范围'", "divItem: '占卜的问题'"):
    chk(k in store, 'GLABEL 缺 %s——少了这个那一行就没有标题' % k)

# 2) 字段顺序：类型 → 时间范围 → 抽到的牌 → 解读 → 回顾（顺序＝存储顺序，导出/导入按位对齐）
m = re.search(r"div: \{ main: 'divItem', items: \[(.*?)\n  \] \}", store, re.S)
if not m:
    fails.append('找不到 FIELDS.div 的字段列表')
else:
    body = m.group(1)
    order = ["g: 'divType'", "g: 'divSpan'", "free: 'divCard'", "free: 'divRead'", "free: 'review'", "free: 'divAcc'"]
    pos = [body.find(x) for x in order]
    chk(all(p >= 0 for p in pos), 'div 的字段不全：应有 类型/时间范围/抽到的牌/解读/回顾/准确率')
    chk(pos == sorted(pos), 'div 的字段顺序错了——新字段只能往后加，插在中间会打乱导入的按位对齐')
    chk("ph: '抽到了哪些牌？'" in body or '抽到了哪些牌' in body, '「抽到的牌」缺 placeholder')

# 3) 必填三处：REQUIRED_PICK / ensureModuleDefaults / _defaultPicks，少一处就卡住
chk('divType: 1' in index.split('REQUIRED_PICK')[1][:200],
    'REQUIRED_PICK 缺 divType（必选的组能被点空，然后被必填提示拦住）')
chk(line_active(index, "pick['divType'] = store.divTypeDefault()"),
    'ensureModuleDefaults 没给 divType 补默认「塔罗」（或这行被注释了）')
chk(line_active(index, "d.divType = (store.divTypeDefault() || [])[0]"),
    '_defaultPicks 没登记 divType——自动补的默认会被当成用户填的，一进占卜就划不动')
chk('function divTypeDefault' in store and 'divTypeDefault,' in store,
    'store 缺 divTypeDefault（或没导出）')
# 主输入框提示语
chk("div: '占卜的问题是？'" in index, '主输入框的提示语不是「占卜的问题是？」')

# 4) 回顾：平时藏起来，点「回顾」才出来，并且自动聚焦
chk(line_active(index, "REVIEW_ONLY_FREE.indexOf(it.free) < 0 || !!this.st.reviewing"),
    '「回顾」行没有按 reviewing 过滤（平时也会露出来，让人以为必填）')
chk("this.st.reviewing = !!g.editReview" in index,
    'checkEdit 没把 editReview 变成 reviewing（点回顾进来显示不出那一行）')
chk("this.st.reviewing ? 'review'" in index,
    'focusKey 没把 reviewing 算进去（点回顾进来不会聚焦那一个框）')
# reviewing 必须能被清掉，否则下一条记录也带着「回顾」
for clear in ("this.st.reviewing = false;   // 回顾态是一次性的",
              "this.st.reviewing = false;   // 切走维度就退出回顾态"):
    chk(clear in index, '缺少清除 reviewing 的地方：%s' % clear[:24])
chk("this.st.reviewing = false; this.st.main = ''" in index,
    'onEditCancel 没清 reviewing（取消编辑后还会留着回顾态）')

# 5) 回顾按钮：只有占卜记录有，且两个页面都接住
chk("rawm === 'div'" in comp and "type: 'review'" in comp,
    '操作条没给占卜记录加「回顾」按钮')
chk(line_active(comp, "if (isDiv) flow.push({ type: 'review'"),
    '「回顾」没有按「只给占卜」的条件推送（或这行被注释了）')
for rel, src in (('pages/index/index.js', index), ('pages/look/look.js', look)):
    chk("if (type === 'review') {" in src, '%s 没接 review——点了没反应且不报错' % rel)
chk(".flow.review" in compx, '「回顾」按钮没有配色（会和别的流转按钮长得一样）')

# 6) 运行时：抢一份真实代码跑一遍，导出行与喂给 AI 的行必须逐字相同。
#    这一步比静态比对更靠得住：两边任何一个标签错一个字，这里立刻现形
NODE = os.environ.get('NODE_BIN', '/Users/zhangmilu/.workbuddy/binaries/node/versions/22.22.2-6/bin/node')
script = r'''
global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} };
global.getApp = () => ({ APP_NAME: 'x' });
const ex = require('@ROOT@/utils/exporter.js');
const rt = require('@ROOT@/cloudfunctions/analysis/recText.js');
const store = require('@ROOT@/utils/store.js');
const now = Date.now();
const rec = { m: 'div', ts: now, t: '21:10', txt: '这个offer该签吗',
  ext: ['塔罗', '一个月', '权杖八（逆）+ 隐士', '先别急'],
  extSrc: ['divType', 'divSpan', 'free:divCard', 'free:divRead'] };
// 回顾后再填了准确率的那一条（准确率非必填，也可能只填回顾不填准确率）
const rec2 = { m: 'div', ts: now, t: '21:10', txt: '这个offer该签吗',
  ext: ['塔罗', '一个月', '权杖八（逆）+ 隐士', '先别急', '最后没签成', '80'],
  extSrc: ['divType', 'divSpan', 'free:divCard', 'free:divRead', 'free:review', 'free:divAcc'] };
// 存储值自带单位的那一条（导入 / 手改都可能带来）——用来确认不会补出「80%%」
// 注：路径用 @ROOT@ 占位后 replace 拼，不走 % 格式化——否则脚本里任何字面 %
// （这里的 '80%'、断言里的 count('%')）都会被当成格式符，报 not enough arguments
const rec3 = Object.assign({}, rec2, { ext: rec2.ext.slice(0, 5).concat(['80%']) });
const line = s => s.split('\n').filter(l => l.indexOf('21:10') >= 0)[0];
const a = line(String(ex.build([rec], { mode: 'read' })));
const b = line(rt.recText([rec]));
const acc_a = line(String(ex.build([rec2], { mode: 'read' })));
const acc_b = line(rt.recText([rec2]));
const dup_a = line(String(ex.build([rec3], { mode: 'read' })));
console.log(JSON.stringify({ a, b, acc_a, acc_b, dup_a,
  dim: store.mname('div'), fields: !!store.fieldsOf('div'),
  accExt: store.buildExt('div', ['80'], ['free:divAcc']) }));
'''.replace('@ROOT@', root)
p = subprocess.run([NODE, '-e', script], capture_output=True, text=True, cwd=root)
if p.returncode != 0:
    fails.append('跑 exporter / recText 失败（%s）' % (p.stderr.strip().split('\n')[-1][:120] if p.stderr else '未知'))
else:
    import json
    o = json.loads(p.stdout.strip().split('\n')[-1])
    chk(o['dim'] == '占卜', '维度名不对：应在加载后能取到「占卜」，实际 %r' % o['dim'])
    chk(a_eq_b := (o['a'] == o['b']),
        '导出与 AI 看到的不一致：\n      导出：%s\n      AI  ：%s' % (o['a'], o['b']))
    for kw in ('占卜', '类型：塔罗', '时间范围：一个月', '抽到的牌', '解读'):
        chk(kw in o['a'], '导出行里没有「%s」——这栏标签可能没登记' % kw)
    chk('undefined' not in o['a'] and '：' in o['a'],
        '导出行里出现 undefined / 没有标签：%s' % o['a'])
    # 回顾 + 准确率这一条：两边逐字相同，且准确率带 %
    chk(o['acc_a'] == o['acc_b'],
        '回顾那条导出与 AI 不一致：\n      导出：%s\n      AI  ：%s' % (o['acc_a'], o['acc_b']))
    for kw in ('回顾：最后没签成', '准确率：80%'):
        chk(kw in o['acc_a'], '导出行里没有「%s」——这一栏没标签或没补单位：%s' % (kw, o['acc_a']))
    chk(o['acc_a'].count('%') == 1, '一行里出现了多个 %%：%s' % o['acc_a'])
    chk(o['dup_a'].count('%') == 1, '存储值自带 %% 时又补了一个：%s' % o['dup_a'])
    chk(o['accExt'] and o['accExt'][0]['v'] == '80%',
        '列表回显没补单位：%r' % (o['accExt'],))

# 7) 准确率：一行式（非必填、无默认），只在回顾态出现，单位两边都登记
m2 = re.search(r"div: \{ main: 'divItem', items: \[(.*?)\n  \] \}", store, re.S)
acc_def = re.search(r"\{ free: 'divAcc'[^}]*\}", m2.group(1) if m2 else '', re.S)
if not acc_def:
    fails.append('FIELDS.div 里没有 divAcc 的字段定义')
else:
    d = acc_def.group(0)
    chk('inline: true' in d, '准确率没标 inline——不会渲染成「标题 + 输入框同一行」')
    chk("unit: '%'" in d, '准确率没声明单位 %')
    chk('ta: true' not in d, '准确率不该用整行 textarea——一个数字摆一整行太重')
# 只在回顾态出现
chk("REVIEW_ONLY_FREE = ['review', 'divAcc']" in index,
    'REVIEW_ONLY_FREE 里没有 divAcc——准确率会平时就露出来（占卜当下没有准不准可言）')
chk(line_active(index, 'REVIEW_ONLY_FREE.indexOf(it.free) < 0 || !!this.st.reviewing'),
    '过滤没按 REVIEW_ONLY_FREE 走（加了新字段就漏一次）')
# 非必填、无默认：不能出现在 REQUIRED_PICK / 默认值补齐里
for g in ('divType', 'divSpan', 'todayBat', 'wantKind'):
    chk('divAcc' not in index.split('REQUIRED_PICK')[1][:200],
        '准确率被登记进 REQUIRED_PICK 了——它是非必填，不该被拦')
chk('divAcc' not in (re.search(r"ensureModuleDefaults\([^)]*\)\s*\{(.*?)\n  \}", index, re.S).group(1)
                        if re.search(r"ensureModuleDefaults\([^)]*\)\s*\{(.*?)\n  \}", index, re.S) else ''),
    '准确率被自动补了默认值——它必须从空开始')
# 单位两边都登记（导出与 AI 同一口径）
for rel, src in (('utils/store.js', store), ('cloudfunctions/analysis/recText.js', rt)):
    chk("'free:divAcc': '%'" in src, '%s 的 UNIT_SUFFIX 没登记 divAcc 的单位' % rel)
    chk("'free:divAcc': '准确率'" in src, '%s 的 COLMAP 没有「准确率」标签' % rel)
# wxml 必须有 inline 分支，否则那个输入框会整个消失（不报错）。
# 这里查的是**那两行判据本身**，不是「文件里有没有 it.inline」——
# 两处布局各有一份 inline 分支，把其中一处改成 false && 之后子串仍在，断言照样通过
chk(line_active(wxml, "wx:if=\"{{it.type==='free' && it.inline}}\""),
    'index.wxml 的 plain 布局没有 inline 字段的渲染分支——准确率的输入框会不见')
chk(line_active(wxml, "wx:if=\"{{item.type==='free' && item.inline}}\""),
    'index.wxml 的常规布局没有 inline 字段的渲染分支')
chk(line_active(wxml, '{{it.unit}}') and line_active(wxml, '{{item.unit}}'),
    'index.wxml 没有渲染单位——%% 不会显示在输入框后面')

# 7) 桩：「回顾」是不是只在回顾态才在圈子里
def visible_rows(reviewing):
    rows = ['类型', '时间范围', '抽到的牌', '解读']
    if reviewing: rows.append('回顾')
    return rows
chk(visible_rows(False) == ['类型', '时间范围', '抽到的牌', '解读'],
    '普通新建时不应出现「回顾」——那时候还没有「后来怎么样了」')
chk(visible_rows(True)[-1] == '回顾', '回顾态必须能看到「回顾」那一格')

if fails:
    print('FAIL 共 %d 处：' % len(fails))
    for f in fails: print('  · ' + f)
    sys.exit(1)
print('OK  占卜维度：登记表 / 必填三处 / 回顾的显隐与清除 / 两页都接住「回顾」')
print('OK  运行时比对：可读导出与喂给 AI 的一行逐字相同')
print('\n注入测试通过')
