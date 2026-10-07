# tools/test-today-mood.py —— 注入测试：验「今日」的心情指数与明天的计划
#
# 为什么用注入测试：小程序的 Page() 与 buildComposer 依赖 wx 运行时，跑不起来。
# 这里直接对源码做静态断言 + 用一个照抄逻辑的桩验证「没填就不画」这类分支，
# 跟 tools/test-resetall.py 同一套路。
import os, re, sys

root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
def rd(p): return open(os.path.join(root, p), encoding='utf-8').read()

store = rd('utils/store.js')
index = rd('pages/index/index.js')
wxml = rd('pages/index/index.wxml')
wxss = rd('app.wxss')
themes = rd('utils/themes.js')
rt = rd('cloudfunctions/analysis/recText.js')
exporter = rd('utils/exporter.js')

fails = []
def chk(cond, msg):
    if not cond: fails.append(msg)

# 1) store：心情档位与函数齐备
chk('const MOODS = [' in store, 'store.js 缺 MOODS 档位表')
chk('function moodName' in store, 'store.js 缺 moodName')
chk('function moodLevel' in store, 'store.js 缺 moodLevel')
chk("MOODS, moodName, moodLevel" in store, 'store.js 没导出 MOODS / moodName / moodLevel')
chk("todayMood: []" in store, 'store.js 的 OPT 缺 todayMood 占位')
chk("todayMood: '心情指数'" in store, 'store.js 的 GLABEL / COLMAP 缺 todayMood 标签')

# 2) today 的字段：能量 → 心情 → 明天的计划，顺序不能反（心情要紧跟能量）
m = re.search(r"today: \{ main: 'todayItem', items: \[(.*?)\] \}", store, re.S)
chk(m is not None, 'store.js 找不到 FIELDS.today')
if m:
    body = m.group(1)
    i_bat = body.find("'todayBat'")
    i_mood = body.find("'todayMood'")
    i_tmr = body.find("'tomorrow'")
    chk(i_bat >= 0 and i_mood >= 0 and i_tmr >= 0, 'today 的 items 缺 todayBat / todayMood / tomorrow')
    chk(i_bat < i_mood < i_tmr, 'today 的字段顺序错了，应是 能量 → 心情 → 明天的计划')
    chk("ph: '明天准备做什么呢'" in body, '「明天的计划」的 placeholder 不是「明天准备做什么呢」')

# 3) 主题：每个主题都要有 mood 色，且不能和 accent 一样（否则两排条看着是同一个量）
def rgb(h): return [int(h[i:i+2], 16) for i in (1, 3, 5)]
acc = re.findall(r"accent: '(#[0-9A-Fa-f]{6})'", themes)
moo = re.findall(r"mood: '(#[0-9A-Fa-f]{6})'", themes)
chk(len(acc) == len(moo) and len(acc) > 0,
    '主题里 accent 有 %d 个、mood 只有 %d 个——有主题没配心情色' % (len(acc), len(moo)))
for a, b in zip(acc, moo):
    d = sum(abs(x - y) for x, y in zip(rgb(a), rgb(b)))
    chk(a != b and d >= 100, '主题心情色与 accent 太接近：%s vs %s（差 %d）' % (a, b, d))

# 4) index.js：主输入框文案 + 构建心情的 5 格
chk("today: '今天发生了哪些影响能量和心情的事呢？'" in index,
    '主输入框文案没改成「今天发生了哪些影响能量和心情的事呢？」')
# 5 格量原先是按组名写死判的（it.g === 'todayMood' / kind: isMood ? 'mood' : 'bat'），
# 书·剧加了第三、四组之后收敛成 SCALES 登记表 + store.scaleOf / scaleKind。
# 这里跟着改成查新路径 —— 断言要守住的是「心情那排仍然是 5 格量、仍然有自己的颜色」，
# 不是「代码里出现 todayMood 这个字符串」：写死组名的写法新加一组就要改一遍，
# 漏改的那一组会安静地退化成普通 chips（页面照常编译，只有肉眼看得出不对）。
chk('const scale = store.scaleOf(it.g);' in index,
    "buildComposer 的 5 格分支不再查 store.scaleOf —— todayMood 会掉出 5 格量那条路，"
    '心情那排画成普通 chips')
chk("todayMood: 'mood'" in store,
    "SCALE_KIND 里没有 todayMood -> mood 的映射（构建器拿不到心情的颜色键，"
    '会和能量条画成同一个颜色）')
chk("MOODS," in store, 'SCALES 里没有登记 MOODS（心情的档位表取不到，那排格子没有小字）')
chk("v.mood = {" in index, 'recVM 没给最近列表算 mood（列表里看不到心情）')
chk("r.mlv = mv ? store.moodLevel(mv) : 0" in index, '_todayLockedOf 没算心情格数（只读摘要不回显）')
# 注意别写成 "'tomorrow'" in index：源码里它出现在 'free:tomorrow' 中间，
# 前面是冒号不是引号，那样匹配不到，断言会假失败
chk("indexOf('free:tomorrow')" in index, '_todayLockedOf 没按 free:tomorrow 回读')
chk('r.tomorrow =' in index, '_todayLockedOf 没把「明天的计划」放进只读视图')

# 关键分支：没记过心情的老记录必须画 0 格，而不是画成最低档
chk("mv ? store.moodLevel(mv) : 0" in index,
    '心情没填时应是 0 格；写成 moodLevel(mv) 会把「没填」画成 1 格、读成「很低落」')

# 5) wxml：两排条 + 只读回显 + 列表回显
# 同样跟着泛化：编辑态现在按 it.graph 分岔（由 store.scaleOf 给），不再按组名枚举。
# 反过来也要查 —— 若哪天又退回写 todayBat/todayMood，这里会重新变成两组专属的分支
chk('it.graph' in wxml, '编辑态没按 it.graph 分岔（it.graph 由 store.scaleOf 给，'
    '退回按组名枚举的话，新加的 5 格量不会被渲染成格子）')
chk("todayLocked.mlv > 0" in wxml, '只读摘要没按「记过心情才显示」判断')
chk("item.mood.lv > 0" in wxml, '最近列表没按「记过心情才显示」判断')
chk("class=\"tl-lab tl-lab-2\"" in wxml or "tl-lab-2" in wxml, '最近列表两个标签没做间距类名')

# 6) wxss：心情要点亮成 --mood（不是 accent），两排才分得开。
# 必须**逐条规则**查「这条规则里确实用了 --mood」，不能只查 '--mood' 这个子串在不在文件里：
# 文件里有三处 var(--mood, var(--accent))，只改掉一处的话子串还在、断言照样通过，
# 而剩下的那两排条已经退化成 accent 色了（注入测试就这么骗过过一次）。
def rule_has(src, sel, var):
    """找选择器 sel 所在的那条规则，看它的声明里有没有 var。"""
    i = src.find(sel)
    if i < 0: return False
    j = src.find('}', i)
    return j > 0 and var in src[i:j]
chk(rule_has(wxss, '.tl-cell.mood.on', '--mood'), '只读心情格没用 --mood（会和能量同色）')
chk(rule_has(wxss, '.ebar-mood .ebar-cell.on', '--mood'), '编辑态心情格没用 --mood')
chk(rule_has(wxss, '.ebar-mood .ebar-cell.cur', '--mood'), '编辑态心情格选中描边没用 --mood')

# 7) recText：AI 也要看到心情，且不能重复展示
chk("todayMood: '心情指数'" in rt, 'recText 的 COLMAP 缺 todayMood（AI 看不到心情标签）')
# 同样要确认这行**没被注释掉**：只查 "push('心情指数'" 这个子串的话，
# 前面加个 // 之后子串依然在，断言照样通过，而 AI 其实已经看不到心情了
def line_active(src, needle):
    return any(needle in ln and not ln.strip().startswith('//') for ln in src.split('\n'))
chk(line_active(rt, "push('心情指数'"), 'recText 没把心情补成「平静（3/5 格）」（或这行被注释了）')
chk('todayMood: 1' in rt and 'SKIP_IN_DETAIL' in rt,
    'recText 没在 SKIP_IN_DETAIL 里跳过 todayMood——会出现「心情指数：平静（3/5 格）| 心情指数：3」')

# 7) 「✎ 管理」入口：纯图示档位组（剩余能量 / 心情指数）不该有——
#    它们不是选项池，那一页是一张空白的增删列表，加进去的词永远不会被读到。
#    判据必须走 store.isGraphGroup 集中登记，不许在页面上写死组名：
#    写死的话以后再加一条类似的 5 格条（比如专注度）又会露出无效入口。
chk('GRAPH_GROUPS' in store and 'isGraphGroup' in store,
    'store.js 缺 GRAPH_GROUPS / isGraphGroup（「哪些组不给管理入口」没有集中判据）')
chk("todayBat: 1" in store and "todayMood: 1" in store,
    'GRAPH_GROUPS 没同时登记 todayBat 与 todayMood')
# 必须查「给 canManage 赋值的那一行」：index.js 里 onManage 的兜底也用了 isGraphGroup，
# 查整个文件的子串会让退化成写死组名的算式照样通过（这个坑踩过一次）
cmg = [ln.strip() for ln in index.split('\n') if 'canManage =' in ln]
chk(cmg and all('isGraphGroup' in ln for ln in cmg),
    'canManage 的算式没用 store.isGraphGroup（又退回写死组名了）')
chk('canManage: false' in index, '纯图示档位组没有显式 canManage: false')
for ln in wxml.split('\n'):
    if 'bindtap="onManage"' not in ln:
        continue
    chk('canManage' in ln or 'composer.main' in ln,
        '管理入口不是按 canManage 判断：%s' % ln.strip()[:90])

# 8) 可读导出与喂给 AI 的文本必须同步（用户选定的对齐口径）：
#    心情指数曾经只在 AI 那一边补了「有点低（2/5 格）」，导出给人的还是裸数字「2」
chk('todayMood: 1' in exporter,
    'exporter 没在 SKIP_IN_DETAIL 里跳过 todayMood——导出行里会出现裸数字「心情指数：2」')
chk(line_active(exporter, "'todayMood', '心情指数'"),
    'exporter 没把心情补成「心情指数：有点低（2/5 格）」（或这行改没了）')
# 末尾汇总：两个量都要给「平均几格 / 几天偏低」。
# 只在一边加的话，人读的那份和 AI 看到的结论不一样（AI 已经在按心情写回看了，
# 用户却从导出里看不出这个趋势，也无从发现两边不一致）
chk(line_active(exporter, "'todayMood', '每日心情指数'"),
    'exporter 的汇总里没有「每日心情指数」（平均几格 / 几天偏低）')
chk(line_active(rt, "'todayMood', '每日心情指数'"),
    'recText 的汇总里没有「每日心情指数」——AI 看不到心情的平均与低谷')
# 两个量必须**分开计天数**：老记录只有能量没心情，共用天数会把「没记心情」
# 说成「记了 N 天心情」，平均就被那些没记的日子拉虚。
# 必须查「写天数那一行」用的到底是什么：只查 'rows.length' 这个子串会被别处的
# rows.map / if (!rows.length) 顶过去——共用天数的写法照样通过。第三次踩同一个坑。
def summary_count_line(name, src):
    ls = [ln for ln in src.split('\n') if "'：记录 '" in ln or "'：记录 '" in ln]
    return sum(1 for ln in ls if 'rows.length' in ln), sum(1 for ln in ls if 'todays.length' in ln)

for name, src in (('exporter', exporter), ('recText', rt)):
    ok, bad = summary_count_line(name, src)
    chk(ok >= 1 and bad == 0,
        '%s 的汇总天数不是按「各自记了多少天」算（rows.length）——'
        '共用 todays.length 会让没记心情的日子把心情平均拉虚' % name)

# 9) 桩：模拟「记过心情 / 没记过」两种回显
def mock_render(mlv):
    """照 wxml 的判据：mlv>0 才画。返回画了几格。"""
    return mlv if mlv > 0 else 0
chk(mock_render(3) == 3, '记了 3 格心情应画 3 格')
chk(mock_render(0) == 0, '没记心情应整行不画（不能画成 1 格让人误读成「很低落」）')

if fails:
    print('FAIL 共 %d 处：' % len(fails))
    for f in fails: print('  · ' + f)
    sys.exit(1)
print('OK  心情指数与明天的计划：store / 主题 / 页面 / 样式 / AI 文本 全部就位')
print('OK  分支：记过心情才画，没记过不画（不会误读成「很低落」）')
print('\n注入测试通过')