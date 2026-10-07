# tools/test-book-show.py —— 注入测试：「书·剧」维度
#
# 为什么单独写一份：书·剧是这个项目里**第一个带两条 5 格量**的维度。
# 5 格量（值域 '1'..'5'、纯图示、不进选项池）原先只有今日的能量/心情两组，
# 它们的写法散在 BATTERIES / MOODS + 各自的 level / name 函数里，加一组要改六处，
# 漏一处不会报错——只会在那一处的页面上显示成英文代号或空白。
# 现在收敛成 SCALES 登记表 + scaleOf / scaleKind / scaleScore，这组测试守的就是那条新路径：
#   静态  —— 登记表配齐、类别默认三处联动、x/5 回读口径、类别不进细节区
#   运行时 —— 抢真实代码跑一遍，导出行与喂 AI 的行逐字相同（比静态比对靠得住）
import os, re, subprocess, sys

root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
def rd(p): return open(os.path.join(root, p), encoding='utf-8').read()

store = rd('utils/store.js')
index = rd('pages/index/index.js')
wxml = rd('pages/index/index.wxml')
look = rd('pages/look/look.js')
lookw = rd('pages/look/look.wxml')
wxss = rd('app.wxss')
themes = rd('utils/themes.js')
ex = rd('utils/exporter.js')
rt = rd('cloudfunctions/analysis/recText.js')

fails = []
def chk(cond, msg):
    if not cond: fails.append(msg)

def line_active(src, needle):
    """这一行确实在跑（没被注释掉）。查子串是不够的——前面加个 // 子串照样在。"""
    return any(needle in ln and not ln.strip().startswith('//') for ln in src.split('\n'))

# ---------------------------------------------------------------- 1) 登记表
chk("k: 'book', n: '书·剧'" in store, "MODULES 里没有「书·剧」维度（或写法变了）")
chk("book: { main: 'bookItem', items: [" in store, 'FIELDS 缺 book 骨架——没有它这条记录能看不能编辑')
chk("bookItem: []" in store, '书·剧主项（书名/剧名）应是纯手填，池子留空')

# 选项池：类别（可管理、有默认值）与进度（可管理、无默认）
for g, names in (('bookKind', ['小说', '漫剧']), ('bookProg', ['待看', '在看', '看完'])):
    m = re.search(r"%s: \[(.*?)\]" % g, store, re.S)
    chk(m is not None, 'OPT 缺 %s 的选项池' % g)
    if m:
        for n in names:
            chk("'%s'" % n in m.group(1), '%s 的选项里少了「%s」' % (g, n))
# 两条 5 格量的池子必须留空（它们不是选项池，是写死在代码里的 5 个档位）
for g in ('bookWow', 'bookLove'):
    chk(re.search(r"%s: \[\]" % g, store) is not None,
        '%s 的选项池不是空的——5 格量的档位写死在 SCALES 里，池子非空会给它开一个无效的「✎ 管理」页' % g)

# 中文标签（GLABEL 决定那一行的标题，COLMAP 决定导出 / AI 看到的名字）
for k in ("bookItem: '名称'", "bookKind: '类别'", "bookProg: '进度'",
          "bookWow: '精彩程度'", "bookLove: '喜爱程度'"):
    chk(k in store, 'GLABEL 缺 %s——少了这个那一行就没有标题' % k)
for k in ("bookKind: '类别'", "bookProg: '进度'", "bookWow: '精彩程度'",
          "bookLove: '喜爱程度'", "'free:bookWhy': '记入原因'"):
    chk(k in store, 'COLMAP 缺 %s——会变成一串没有名字的裸值' % k)

# ------------------------------------------------------- 2) 字段顺序 = 存储顺序
m = re.search(r"book: \{ main: 'bookItem', items: \[(.*?)\n  \] \}", store, re.S)
if not m:
    fails.append('找不到 FIELDS.book 的字段列表')
else:
    body = m.group(1)
    order = ["g: 'bookKind'", "g: 'bookWow'", "g: 'bookLove'", "g: 'bookProg'", "free: 'bookWhy'"]
    pos = [body.find(x) for x in order]
    chk(all(p >= 0 for p in pos), 'book 的字段不全：应有 类别/精彩程度/喜爱程度/进度/记入原因')
    chk(pos == sorted(pos), 'book 的字段顺序错了——新字段只能往后加，插在中间会打乱导入的按位对齐')
    # 评分与进度必须标 below：它们评的是「这一本」，名字没写就评不了，
    # 跟着类别一起提到主输入框上方会变成「先打分再补名字」，顺序反了
    for g in ('bookWow', 'bookLove', 'bookProg'):
        d = re.search(r"\{ g: '%s'[^}]*\}" % g, body, re.S)
        chk(d is not None and 'below: true' in d.group(0),
            '%s 没标 below: true——它会被提到名称上方，变成「先打分再补名字」' % g)
    d = re.search(r"\{ g: 'bookKind'[^}]*\}", body, re.S)
    chk(d is not None and 'below' not in d.group(0),
        'bookKind 标了 below——类别要留在名称**上方**（先定是什么，再写是哪一本）')
    chk(re.search(r"free: 'bookWhy'[^\n]*label: '记入原因'", body) is not None,
        '「记入原因」没有 label——它在界面上会是个没有标题的框')
    chk(re.search(r"free: 'bookWhy'[^\n]*ta: true", body) is not None,
        '「记入原因」该用整行 textarea——一句话写长了要能折行')

# --------------------------------------------- 3) 类别默认「小说」的三处联动
# 少任何一处的后果都不同，所以三处都要查：
#   缺 REQUIRED_PICK  → 能被点空，然后被必填提示拦住，界面上看不出该点哪里
#   缺 ensureModuleDefaults → 记下后选中态丢失，下一条还会因「请选择类别」记不进去
#   缺 _defaultPicks → 自动补的默认值被当成「用户填的内容」，一进书·剧就划不动
chk('bookKind: 1' in index.split('REQUIRED_PICK')[1][:220],
    'REQUIRED_PICK 缺 bookKind（类别是必选的，能被点空后就被必填提示拦住）')
chk(line_active(index, "pick['bookKind'] = store.bookKindDefault()"),
    'ensureModuleDefaults 没给 bookKind 补默认「小说」（或这行被注释了）')
chk(line_active(index, "d.bookKind = (store.bookKindDefault() || [])[0]"),
    '_defaultPicks 没登记 bookKind——自动补的默认值会被当成用户填的，一进书·剧就划不动')
chk('function bookKindDefault' in store and 'bookKindDefault,' in store,
    'store 缺 bookKindDefault（或没导出）')
# 默认值必须锁「小说」，不随选项顺序变化：用户在管理页把顺序调了，进维度仍应默认小说
bd = re.search(r"function bookKindDefault\(\)\s*\{(.*?)\n\}", store, re.S)
chk(bd is not None and "'小说'" in bd.group(1) and 'indexOf' in bd.group(1),
    'bookKindDefault 没锁定「小说」——它应当按值找，不是拿 k[0]（顺序变了默认值就变）')

# 进度「无默认」：不能出现在 REQUIRED_PICK，也不能被自动补值
req_block = index.split('REQUIRED_PICK')[1][:220]
for g in ('bookProg', 'bookWow', 'bookLove', 'bookItem'):
    chk(g not in req_block,
        '%s 被登记进 REQUIRED_PICK 了——它是非必填的，不该被拦' % g)
ens = re.search(r"ensureModuleDefaults\([^)]*\)\s*\{(.*?)\n  \}", index, re.S)
ens_body = ens.group(1) if ens else ''
for g in ('bookProg', 'bookWow', 'bookLove'):
    chk(g not in ens_body,
        '%s 被自动补了默认值——进度与评分必须从空开始（没评过就是没评过）' % g)

# 名称必填 + 类别必填的校验
chk("this.st.tag === 'book' ? '先写下书名或剧名'" in index,
    '名称必填的提示语不是「先写下书名或剧名」')
chk(line_active(index, "this.st.tag === 'book' && (!this.st.pick['bookKind']"),
    'doSave 没有校验 bookKind 必选（能被点空后存下一条没有类别的记录）')
chk("book: '书名或剧名 · 回车就记下'" in index, '主输入框的提示语不是「书名或剧名 · 回车就记下」')
chk("tag === 'book' ||" in index or "|| tag === 'book'" in index,
    '书·剧没进 plain 布局——类别不会摆到名称上方，会跟细节挤在一起')

# ------------------------------------------- 4) 5 格量：泛化到 SCALES 而不是写死
chk(re.search(r"SCALES = \{[^}]*bookWow", store, re.S) is not None,
    'SCALES 里没有 bookWow——5 格量的档位表没登记，取档位名会返回空')
chk(re.search(r"SCALES = \{[^}]*bookLove", store, re.S) is not None,
    'SCALES 里没有 bookLove')
chk(re.search(r"SCALE_KIND = \{[^}]*bookWow:\s*'wow'", store, re.S) is not None
    and re.search(r"SCALE_KIND = \{[^}]*bookLove:\s*'love'", store, re.S) is not None,
    'SCALE_KIND 没把两条量映射到 wow / love 颜色键——渲染层画出来会是默认色，两条量分不开')
for fn in ('function scaleOf(', 'function scaleKind(', 'function scaleName(', 'function scaleScore('):
    chk(fn in store, 'store 缺 %s…）' % fn)
for fn in ('SCALES, WOWS, LOVES, scaleOf, scaleKind, scaleName, scaleScore,'):
    chk(fn in store, 'module.exports 里没导出 SCALES 那一组函数——页面 require 不到')

# 渲染层不许再写死组名：加一条 5 格量时，写死的写法要改三处（js / wxml / wxss），漏一处不报错
chk(line_active(index, 'const scale = store.scaleOf(it.g);'),
    "buildComposer 的 5 格分支不再查 store.scaleOf——退回写死组名的话，"
    '新加一组 5 格量不会被渲染成格子（只当普通 chips，且不报错）')
chk("graph: true" in index, '5 格量那条没带 graph 标记——wxml 靠它分岔画格子还是画 chip')
chk('it.group===\'todayBat\'' not in wxml and 'todayBat' not in wxml,
    'index.wxml 里还在按 todayBat 写死判断——新加的 5 格量不会被渲染成格子')
chk('bar-' in wxml and 'ebar-{{it.kind}}' in wxml,
    'index.wxml 没按 item.kind 生成颜色类名（ebar-{{it.kind}}）——四条量会画成同一个颜色')

# 颜色：app.wxss 必须给四个键都有样式，themes.js 必须每个主题都给了色
for k in ('wow', 'love'):
    chk('.tl-bar-%s' % k in wxss and '.tl-cell.%s.on' % k in wxss,
        'app.wxss 缺只读态 %s 的 5 格条配色（.tl-bar-%s / .tl-cell.%s.on）' % (k, k, k))
    chk('.ebar-%s .ebar-cell.on' % k in wxss and '.ebar-%s .ebar-cell.cur' % k in wxss,
        'app.wxss 缺编辑态 %s 的 5 格条配色（点亮色与「当前选中」描边）' % k)
n_themes = len(re.findall(r"\{\s*k:\s*'[a-z]+',\s*n:\s*'", themes))
for i, blk in enumerate(re.findall(r"\{\s*k:\s*'[a-z]+',\s*n:\s*'[^']*',\s*on:\s*(?:true|false)[^}]*vars:\s*\{(.*?)\n  \} \}", themes, re.S)):
    for k in ('wow', 'love'):
        chk(re.search(r"\b%s:\s*'#" % k, blk) is not None,
            'themes.js 第 %d 个主题没给 %s 配色——那条量在这个主题下会回落成 accent，'
            '和旁边那条分不开' % (i + 1, k))
chk(len(re.findall(r"\bwow:\s*'#", themes)) == n_themes,
    'themes.js 里有主题没给 wow 配色（共 %d 个主题，%d 个给了）'
    % (n_themes, len(re.findall(r"\bwow:\s*'#", themes))))

# 书·剧的评分 / 进度落在名称**下方**，所以 plain 分支的下方循环必须能渲染 g 组。
# 那个循环原先只管 free 字段，不补一段 g 的话这三行在页面上根本不出现
# （用户看到的是「评不了、也选不了进度」，而页面照常编译、不报错）
plain_loop = re.search(r'wx:for="\{\{composer\.items\}\}".*?</view>\s*</block>\s*</block>', wxml, re.S)
chk(plain_loop is not None, 'index.wxml 里找不到 plain 布局下方的 composer.items 循环')
if plain_loop:
    seg = plain_loop.group(0)
    chk("it.type==='g'" in seg,
        'plain 布局下方的循环不会渲染 g 组——书·剧的评分与进度会整行消失（看着像「评不了」）')
    chk('it.graph' in seg, 'plain 布局下方的循环没按 it.graph 分岔——5 格量在名称下方画成普通 chip')
chk(line_active(index, "const catItems = plain ? items.filter(it => it.type === 'g' && !it.below) : [];"),
    'catItems 没排除 below 的组——评分与进度会被提到名称上方（顺序反了：先打分再补名字）')
chk(line_active(index, "const bodyItems = plain ? items.filter(it => it.type !== 'g' || it.below) : items;"),
    'bodyItems 没把 below 的组收进来——名称下方那三行不会渲染')

# ---------------------------------------------------------------- 5) 记录展示 x/5
# 用户明确要求「精彩程度和喜爱程度按 x/5 的格式展示」。
# 这条在 fmtVal 里统一做（列表 / 复制 / 导出 / AI 四处共用 buildExt，改一处四处生效）
chk('const SCALE_RICH = { todayBat: 1, todayMood: 1 };' in store,
    'store 缺 SCALE_RICH——今日那两条量若也补 x/5，会与导出 / AI 侧'
    '「一般（3/5 格）」的写法对不上')
chk(re.search(r"SCALES\[src\] && !SCALE_RICH\[src\]", store) is not None,
    'fmtVal 没排除 SCALE_RICH 里的组——今日的能量/心情会变成 3/5，与导出侧的写法冲突')
chk('function fmtVal(' in store and 'fmtVal(src, v)' in store,
    'buildExt 还在用 withUnit 而不是 fmtVal——x/5 的回读口径没生效')
# 书·剧的两条量必须在 SCALES 里、且**不在** SCALE_RICH 里（它们只有 x/5 一种写法）
rich = re.search(r"SCALE_RICH = \{(.*?)\}", store, re.S)
chk(rich is not None and 'bookWow' not in rich.group(1) and 'bookLove' not in rich.group(1),
    'SCALE_RICH 里不该有书·剧那两条量——它们只走 x/5（补档位名对 AI 是噪音）')

# ------------------------------------------- 6) 类别不进细节区（两侧口径一致）
# 类别已经拼进维度名（「书·剧·小说」），细节区再写一遍就成了同一个词一行出现两次。
# 这一处漏改不报错，只是读起来像有两件事——所以两侧都要查
chk(re.search(r"d\.src !== 'bookKind'", store) is not None,
    "store.buildExt 没排除 bookKind——类别会在细节区重复出现（维度名里已经有一个了）")
for rel, src in (('utils/exporter.js', ex), ('cloudfunctions/analysis/recText.js', rt)):
    sk = re.search(r'SKIP_IN_DETAIL\s*=\s*\{(.*?)\}', src, re.S)
    chk(sk is not None and 'bookKind' in sk.group(1),
        '%s 的 SKIP_IN_DETAIL 没有 bookKind——类别会在同一行里出现两次' % rel)
    chk(re.search(r"r\.m === 'book'\) \{ const k = extOf\(r, 'bookKind'\)", src) is not None,
        '%s 的 moduleLabel 没有书·剧分支——导出里看不到类别（看不出是小说还是漫剧）' % rel)
# 云函数那侧还要有自己的 x/5 复刻（它拿不到 wx，require 不了 store）
chk(re.search(r"const SCALES = \{[^}]*bookWow", rt, re.S) is not None,
    'recText.js 的 SCALES 里没有 bookWow——喂给 AI 的文本里评分会是个裸数字 3')
chk("bookKind: '类别'" in rt and "'free:bookWhy': '记入原因'" in rt,
    "recText.js 的 COLMAP 缺书·剧的标签——AI 看到的是「free:bookWhy：...」这种机器键")
chk("book: '书·剧'" in rt, "recText.js 的 MODULE_N 里没有 book——AI 看到的是英文 book")

# ------------------------------------------------- 7) 看页：类别统计 + 二级筛选
for frag, why in (
    ('bookStatsVM', '看页没有书·剧的类别统计'),
    ("store.bookCat(r) === this.data.kindFilter", '看页的类别二级筛没接上 store.bookCat'),
    # 选项池现在查 CAT_STAT（见下），不再写 effM === 'book' ? getOPT('bookKind')
    ('CAT_STAT[effM] ? store.getOPT(CAT_STAT[effM])', '二级筛的选项池没查 CAT_STAT——筛不出书·剧的类别'),
    # 统计不跟二级筛走（与随记同一口径）：否则换类别时只剩自己那一行、总数缩到那一条。
    # 同样改成查 CAT_STAT
    ('CAT_STAT[effM] ? store.mname(effM)', 'statName 没让书·剧脱离二级筛——标题会变成「统计 · 书·剧 · 小说」，看着像换了另一份统计'),
):
    chk(frag in look, why)
# 类别筛选与统计现在都查 CAT_STAT 这张表（维度 -> 选项池），不再逐维度写 if 链。
# 断言随之改成查那张表：要守的是「书·剧接通了类别筛选与统计」，
# 不是「代码里出现 filter === 'book' 这一串」——写死维度的写法日后加一个维度就要改一遍，
# 漏改的那个会安静地退化成「筛选行有选项、统计却不按它分组」。
m_cat = re.search(r"const CAT_STAT = \{([^}]*)\}", look)
chk(m_cat is not None, '看页没有 CAT_STAT 表（哪个维度按哪个类别池统计的唯一出处）')
if m_cat:
    chk(re.search(r"book:\s*'bookKind'", m_cat.group(1)) is not None,
        'CAT_STAT 里没有书·剧 -> bookKind——统计块是空的 / 筛选行没有类别')
# 占位行：书·剧的类别分布**刻意不跟二级筛走**（换筛选时这张图不变），
# 所以不该给它补占位——补了就是用户看到的那片空白。见 tools/test-look-stats.py
chk(re.search(r"STAT_PADS[^\n]*book", look) is None,
    'STAT_PADS 里登记了书·剧——它的类别分布不跟二级筛走，补占位只会多出空白')
# 二级筛必须交给云端（否则分页会混进不匹配的记录，页数与「已经到底了」都会不准）
chk(re.search(r"const subF = [\s\S]{0,300}?CAT_STAT\[this\.data\.filter\]", look) is not None,
    "effQuery 的 subF 没按 CAT_STAT 判定——二级筛不传云端，分页会混进别的类别的记录")
chk(re.search(r"if \(CAT_STAT\[f\]\) \{[\s\S]{0,500}?countRecords\(\{ m: f", look) is not None,
    'loadStats 没有按 CAT_STAT 的类别计数分支——统计块是空的')
# 二级筛那行 chips
chk(re.search(r"filter==='jot' \|\| filter==='book' \|\| filter==='div'\) && kinds\.length", lookw) is not None,
    'look.wxml 没有书·剧的类别二级筛选行——用户没法只看小说或只看漫剧')

# ------------------------------------------------ 8) 运行时：两份输出必须逐字相同
# 比静态比对靠得住：两边任何一个标签错一个字，这里立刻现形
NODE = os.environ.get('NODE_BIN', '/Users/zhangmilu/.workbuddy/binaries/node/versions/22.22.2-6/bin/node')
script = r'''
global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} };
global.getApp = () => ({ APP_NAME: 'x' });
const ex = require('@ROOT@/utils/exporter.js');
const rt = require('@ROOT@/cloudfunctions/analysis/recText.js');
const store = require('@ROOT@/utils/store.js');
const now = Date.now();
// 满配那一条：类别 + 两条评分 + 进度 + 原因
const rec = { m: 'book', ts: now, t: '22:30', txt: '房思琪的初恋乐园',
  ext: ['小说', '4', '5', '在看', '朋友推荐的'],
  extSrc: ['bookKind', 'bookWow', 'bookLove', 'bookProg', 'free:bookWhy'] };
// 只填了名称与类别（评分、进度、原因全可跳过）
const rec2 = { m: 'book', ts: now, t: '22:30', txt: '异世界',
  ext: ['漫剧'], extSrc: ['bookKind'] };
// 存储值已自带「4/5」的那一条（导入 / 手改都可能带来）——不能补成「4/5/5」
const rec3 = Object.assign({}, rec, { ext: ['小说', '4/5', '5', '在看', '朋友推荐的'] });
// 类别被删掉的：应该归到「未分类」那一行（统计侧），且导出里不带「·」
const rec4 = { m: 'book', ts: now, t: '22:30', txt: '没有类别的',
  ext: [], extSrc: [] };
const line = s => s.split('\n').filter(l => l.indexOf('22:30') >= 0)[0];
console.log(JSON.stringify({
  a: line(String(ex.build([rec], { mode: 'read' }))),
  b: line(rt.recText([rec])),
  min_a: line(String(ex.build([rec2], { mode: 'read' }))),
  min_b: line(rt.recText([rec2])),
  dup_a: line(String(ex.build([rec3], { mode: 'read' }))),
  noKind_a: line(String(ex.build([rec4], { mode: 'read' }))),
  noKind_b: line(rt.recText([rec4])),
  dim: store.mname('book'),
  fields: !!store.fieldsOf('book'),
  label: store.recMname(rec),
  noKindLabel: store.recMname(rec4),
  cat: store.bookCat(rec), color: store.bookColor('小说'),
  // 列表回显：两条评分必须已经是 x/5
  ext: store.buildExt('book', rec.ext, rec.extSrc),
  scoreWow: store.scaleScore('bookWow', '4'),
  scoreEmpty: store.scaleScore('bookWow', ''),
  nameWow: store.scaleName('bookWow', '5'),
  kindWow: store.scaleKind('bookWow'), kindLove: store.scaleKind('bookLove'),
  kindBat: store.scaleKind('todayBat'),
  def: store.bookKindDefault()
}));
'''.replace('@ROOT@', root)
p = subprocess.run([NODE, '-e', script], capture_output=True, text=True, cwd=root)
if p.returncode != 0:
    fails.append('跑 exporter / recText 失败（%s）'
                 % (p.stderr.strip().split('\n')[-1][:160] if p.stderr else '未知'))
else:
    import json
    o = json.loads(p.stdout.strip().split('\n')[-1])
    chk(o['dim'] == '书·剧', '维度名不对：应在加载后能取到「书·剧」，实际 %r' % o['dim'])
    chk(o['fields'], 'store.fieldsOf("book") 拿不到骨架——记录能看见但不能编辑')
    chk(o['def'] == ['小说'], '默认类别不是「小说」：%r' % (o['def'],))
    chk(o['kindWow'] == 'wow' and o['kindLove'] == 'love' and o['kindBat'] == 'bat',
        'scaleKind 取错颜色键：wow=%r love=%r bat=%r' % (o['kindWow'], o['kindLove'], o['kindBat']))
    chk(o['scoreWow'] == '4/5', 'x/5 回读不对：scaleScore("bookWow","4") = %r' % o['scoreWow'])
    chk(o['scoreEmpty'] == '', '没值时 scaleScore 应返回空串（否则那一栏显示成「0/5」）')
    chk(o['nameWow'] == '非常精彩', 'scaleName 取错档位名：%r' % o['nameWow'])
    chk(o['cat'] == '小说' and o['label'] == '书·剧·小说',
        '类别没进维度名：cat=%r label=%r' % (o['cat'], o['label']))
    chk(o['noKindLabel'] == '书·剧', '没有类别的记录维度名不该带「·」：%r' % o['noKindLabel'])

    # 列表回显：x/5（这是用户明确要求的那一条）
    ext = {d['src']: d['v'] for d in (o['ext'] or [])}
    chk(ext.get('bookWow') == '4/5', '列表里精彩程度没按 x/5 展示：%r' % (o['ext'],))
    chk(ext.get('bookLove') == '5/5', '列表里喜爱程度没按 x/5 展示：%r' % (o['ext'],))
    chk('bookKind' not in ext, '列表里类别还在——它已经进了模块名（书·剧·小说），会重复')

    # 导出 vs 喂 AI：逐字相同
    chk(o['a'] == o['b'],
        '导出与 AI 看到的不一致：\n      导出：%s\n      AI  ：%s' % (o['a'], o['b']))
    chk(o['min_a'] == o['min_b'],
        '只填名称与类别那条不一致：\n      导出：%s\n      AI  ：%s' % (o['min_a'], o['min_b']))
    chk(o['noKind_a'] == o['noKind_b'],
        '没有类别那条不一致：\n      导出：%s\n      AI  ：%s' % (o['noKind_a'], o['noKind_b']))
    chk(o['dup_a'] == o['dup_a'], '占位')
    # 类别只出现一次
    chk(o['a'].count('小说') == 1,
        '「小说」在一行里出现了 %d 次（维度名里已有，细节区不该再写）：%s'
        % (o['a'].count('小说'), o['a']))
    # 评分以 x/5 进导出与 AI 文本
    for kw in ('书·剧·小说', '房思琪的初恋乐园', '精彩程度：4/5', '喜爱程度：5/5',
               '进度：在看', '记入原因：朋友推荐的'):
        chk(kw in o['a'], '导出行里没有「%s」——这栏标签没登记或值没补成 x/5：%s' % (kw, o['a']))
    chk('undefined' not in o['a'], '导出行里出现 undefined：%s' % o['a'])
    # 只填名称与类别：评分/进度/原因那一行不该出现（「0/5」或空标签都不行）
    chk(o['min_a'].count('：') == 0 or '精彩程度' not in o['min_a'],
        '没评分却出现了评分栏：%s' % o['min_a'])
    for kw in ('精彩程度', '喜爱程度', '进度', '记入原因', '/5'):
        chk(kw not in o['min_a'],
            '没填的字段却出现在导出里（%s）——看着像打了 0 分：%s' % (kw, o['min_a']))
    # 已自带「4/5」的值不能补成「4/5/5」
    chk('4/5/5' not in o['dup_a'] and o['dup_a'].count('精彩程度：4/5') == 1,
        '存储值已自带 x/5 时又补了一次：%s' % o['dup_a'])
    # 没有类别的记录：维度名是「书·剧」而不是「书·剧·」
    chk('书·剧·|' not in o['noKind_a'] and '书·剧· ' not in o['noKind_a'],
        '没有类别时维度名尾部多了个「·」：%s' % o['noKind_a'])

# -------------------------------------------- 9) 类别统计：0 不占行、未分类兜底
# 这一条只能桩测：真跑要看云端 countRecords，静态比对（类别池 + 「未分类」兜底 + 0 过滤）够用
chk(re.search(r"^\s*catStatsVM\(m, byCat, total\)", look, re.M) is not None,
    '看页没有通用的类别统计呈现（catStatsVM）')
# 页面里是方法简写（没有 function 前缀），取函数体别按 `function x()` 那套来
cs = re.search(r"^\s*catStatsVM\(m, byCat, total\)\s*\{(.*?)\n  \},", look, re.M | re.S)
chk(cs is not None, '取不到 catStatsVM 的函数体')
if cs:
    seg = cs.group(1)
    chk("n: '未分类'" in seg, '类别统计没有「未分类」兜底——各类别加起来会少于总数，看着像数字丢了')
    chk('b.n2 > 0' in seg, '类别统计没有过滤 0——没记过的类别也占一行')
    # 类别池查 CAT_STAT（与筛选行同源）、配色按维度查 store——两处都查表才谈得上「口径一致」
    chk('CAT_STAT[m]' in seg, 'catStatsVM 没查 CAT_STAT 拿类别池（会拿错维度的池子去数，数字全错）')
    chk('bookColor' in seg, 'catStatsVM 的配色表里没有书·剧（会拿随记的颜色，显示成另一种含义）')
    chk("mname(m) + ' · '" in seg and "'随记 · 类别'" not in seg,
        "catStatsVM 的标题写死了「随记 · 类别」——泛化之后书·剧会顶着随记的标题")

if fails:
    print('FAIL 共 %d 处：' % len(fails))
    for f in fails: print('  · ' + f)
    sys.exit(1)
print('OK  登记表：MODULES / FIELDS / OPT（两条 5 格量池子留空）/ GLABEL / COLMAP')
print('OK  字段顺序＝存储顺序，评分与进度标 below 留在名称下方')
print('OK  类别默认「小说」三处联动齐全；进度与评分不补默认值')
print('OK  5 格量走 SCALES 登记表（不写死组名），四个颜色键在 wxss 与 themes 里都齐')
print('OK  记录展示按 x/5（fmtVal 统一口径，今日那两条量仍走更完整的写法）')
print('OK  类别只进维度名，不在细节区重复（store / 导出 / 云函数三处一致）')
print('OK  看页：类别统计（0 不占行 + 未分类兜底）与二级筛（客户端 + 云端）都接上了')
print('OK  运行时比对：可读导出与喂给 AI 的一行逐字相同，x/5 两边一致')
print('\n注入测试通过')
