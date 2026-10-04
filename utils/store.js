// 自我觉察 · 共享数据层（常量 + 云开发 CRUD + 纯计算）
// 云开发环境 ID：在 app.js 顶部填写 wx.cloud.init 的 env。
// 集合：records（记录）、options（用户新增选项）、usercfg（问候语/自定义维度）
const log = require('./log.js');
const date = require('./date.js');
// 日期工具统一在 utils/date.js；这里起个别名，内部沿用同名调用，导出也照旧
const dayLabel = date.dayLabel;
const agoOf = date.agoOf;
const datePrefix = date.datePrefix;

/* ---------------- 常量（与线上版同构） ---------------- */
// 可选维度。无感 / 悦己已并入觉察（见 migrateNopeLikeIntoObs），不再是可选维度，
// 只会在迁移完成前短暂地存在于历史数据里
const MODULES = [
  { k: 'obs', n: '觉察', c: '#7C9A86' },
  { k: 'now', n: '此刻', c: '#5E9A94' },
  { k: 'want', n: '可做', c: '#C0A05A' },
  // 待办：备忘 / 购物 合并而来。一条待办的 m 都是 todo，
  // 「是备忘还是购物」看 ext 里的「类别」（todoKind），颜色也按类别给（见 catColor / taskColor）
  { k: 'todo', n: '待办', c: '#9A8C7A' },
  { k: 'jot', n: '随记', c: '#948AA8' }
];

const OPT = {
  // 觉察：归类 / 喜恶 / 程度 / 感受 里带「无感 · 悦己」味道的词，是 2026-10 合并维度时
  // 并进来的（原本属于已删除的无感 / 悦己）。直接写在觉察自己这里，池子就不再依赖
  // 那两个已经消失的组——否则同一批词会被「死组」和「活组」各算一份。
  // 默认池每个只留 4 个、尽量覆盖不同方向：够启动就行，更贴合自己的等用起来再加。
  // 「归类」只放"身上发生过的事"：原先掺着的「掌控自己的时间 / 没有任务压力 /
  // 做想做的事 / 无人打扰」是悦己留下来的愿望 / 状态词，会把统计搅浑，已移除
  obsWhat: ['写方案', '陪家人', '加班', '刷手机'],
  obsStart: ['工作必须', '自己想做', '别人提议'],
  obsKind: ['喜欢', '感兴趣', '无感', '讨厌', '不想'],
  obsDeg: ['微微', '有点', '很', '非常', '极度'],   // 一条刻度，不是「方向」，所以留 5 个
  obsMood: ['开心', '平静', '焦虑', '低落'],
  genDoing: ['写代码', '做饭', '散步', '看剧'],
  genFeel: ['专注', '走神', '疲惫', '无聊'],
  genWant: ['喝咖啡', '走一走', '看会儿书', '找人聊聊'],
  wantItem: ['学吉他', '早睡', '去旅行', '跑步'],
  wantKind: ['想做', '可试', '喜欢'],
  // 待办：类别（备忘 / 购物，可在「✎ 管理」里加新类别）；主项就是记事本身，不进选项池
  todoKind: ['备忘', '购物'],
  // 随记：类别（念头 / 灵感，可在「✎ 管理」里加新类别）。默认「念头」，
  // 与待办类别同一套：只从选项池点选、摆在主输入框上方
  jotKind: ['念头', '灵感'],
  todoItem: [], jotItem: []
  // 注：原先还有 doneFeel / doneGain 两组默认词，但可做里「做了的感受 / 收获」是自由文本框、
  // 没有 chips 入口，那两组池子永远不会被用到（选项池界面里也看不到），已删掉
};

// 「归类」：觉察 / 无感已把「什么事」解耦成「归类（名词性、可归类）+ 具体的描述（自由、不可归类）」。
// 叫「归类」而不是「什么事 / 触动的点」，是因为池子里装的不一定是事——也可能是一个概念（自由）
// 或一个物件（猫），所以标签只描述它的作用：从池里点选的那个用来归类的词。
// 可做 / 此刻 也已解耦，那边主项叫「什么事 / 想记的是」（只填描述时它本身就是「事」）；悦己等还没迁
const GLABEL = {
  obsWhat: '归类', obsKind: '喜恶', obsDeg: '程度', obsStart: '怎么开始的', genDoing: '想记的是', genFeel: '情绪',
  genWant: '此刻想做的事', wantItem: '什么事', wantKind: '分类', nopeThing: '归类', nopeDeg: '程度', nopeMood: '无感的情绪', nopeKind: '喜恶',
  doneFeel: '做了的感受', doneGain: '收获', obsMood: '感受', todoItem: '要记住什么', todoKind: '类别', jotKind: '类别', likeItem: '什么事', jotItem: '想记点什么'
};

// 已废弃的选项组：无感 / 悦己 并入觉察后不再使用。加载时忽略云端的旧文档与本地残留，
// 否则这些「死组」会一直被合并回来、在选项池里重复计数
const DEAD_OPT_GROUPS = ['nopeThing', 'nopeDeg', 'nopeMood', 'nopeKind', 'likeItem', 'memoItem', 'buyItem'];

const OPTGROUPS = [
  { m: 'obs', gs: ['obsWhat', 'obsKind', 'obsDeg', 'obsStart', 'obsMood'] },
  { m: 'now', gs: ['genDoing', 'genFeel', 'genWant'] },
  { m: 'want', gs: ['wantItem', 'wantKind'] },
  { m: 'todo', gs: ['todoKind'] },
  { m: 'jot', gs: ['jotKind'] }
];

// 固定选项组（写死，不给“管理”入口）
const FIXED = {
  forgot: { label: '忘了时间吗（可不选）', opts: ['忘了时间', '没有', '不确定'] },
  nrg: { label: '做完精力如何（可不选）', opts: ['耗电', '充电', '没变化'] }
};

// 注：早先有个「~ 前缀 = 把这条手填值固化进选项池」的写法，已整体移除。
// 现在手填就是只记这一次，选项池只从「✎ 管理」里维护

// 「具体的描述」的自由字段 key：与主项（归类）配对——归类是名词性的、可复用；描述自由、不可归类。
// 它固定放在 items 的最后一位，于是 ext/extSrc 的顺序、srcList（导出/导入按顺序对齐）都保持兼容：
// 旧导出文件没有这一位，按顺序仍能正确回填到前几个字段
const DESC_KEY = 'desc';
const DESC_SRC = 'free:' + DESC_KEY;

// 模块字段：g=选项组（noInput=不给手填输入框）/ fx=固定选项组 / free=自由文本
// 注：g 组若没标 noInput，就带一个手填输入框——手填值只记这一条，不进选项池
const FIELDS = {
  // 觉察（无感 / 悦己 已并入这里）。编辑器里的展示顺序由 index 的 buildComposer 排成
  // 「喜恶 → 程度 → 感受（情绪 chips + 紧随的自由输入框）→ 怎么开始的 → 沉浸 → 精力」；
  // 这里的书写顺序是「存储顺序」——新分组追加在末尾，导出/导入的按顺序对齐因此不受影响
  obs: { main: 'obsWhat', items: [
    { g: 'obsStart', single: true, noInput: true },
    { fx: 'forgot' }, { fx: 'nrg' },
    { g: 'obsMood', single: true, noInput: true },
    { free: 'obsfeel', label: '', ph: '有什么想抒发的？', ta: true },
    // 具体的描述：不可归类，编辑时不带标题，就在「归类」下方
    { free: 'desc', label: '', ph: '发生了什么？', ta: true },
    // 喜恶 / 程度：原本属于「无感」，并入后所有觉察记录都能用。
    // 程度是「感受」的修饰（微微 / 有点 / 很…），sub 表示它在编辑器里作为情绪的副行展示：
    // 不单独起标题、chip 小一号、没选情绪时不出现（见 index 的 buildComposer 与 index.wxml）
    { g: 'obsKind', single: true, noInput: true },
    { g: 'obsDeg', single: true, noInput: true, sub: true }
  ] },
  now: { main: 'genDoing', items: [
    { g: 'genFeel', single: false, noInput: true },
    { free: 'nownote', label: '感受', ph: '这一刻心里的感觉，随便写', ta: true },
    { g: 'genWant', single: true },
    // 「具体的描述」：与「想记的是」解耦，逻辑与可做那套一致（只填它时它本身就是「事」）。
    // 固定放最后一位，导出/导入的按顺序对齐不受影响
    { free: 'desc', label: '', ph: '也可以直接写「事」；选了上面就是补充', ta: true, asMain: true }
  ] },
  want: { main: 'wantItem', items: [
    { g: 'wantKind', single: true, noInput: true, hideDetail: true, required: true },
    // 「怎么做」：紧跟在分类下方，写打算怎么做（可跳过）。
    // 注意 srcList 是「按标签匹配」导入的，插在中间不会打乱旧文本的详情对齐
    { free: 'howto', label: '怎么做', ph: '要怎么做？', ta: true },
    { free: 'trigger', label: '是什么让你想做', ph: '刚看到别人晒成果，有点不甘心' },
    { free: 'hope', label: '希望最终变成什么样', ph: '变成每天稳定的习惯' },
    // 「进行中感受」仅在做中/点「开始」后显示（由 index 编辑态按状态过滤）
    { free: 'doingNote', label: '进行中感受', ph: '做的过程中冒出来的感受，随便写', ta: true },
    // 「做了的感受 / 收获」仅点「完成」后显示（由 index 编辑态按状态过滤）
    { free: 'doneFeel', label: '做了的感受', ph: '做完那一刻心里冒出来的话', ta: true },
    { free: 'doneGain', label: '收获', ph: '这次有什么收获，随便写', ta: true },
    // 「为什么不做了」仅点「放弃」或编辑「不做」记录时显示（由 index 编辑态按状态过滤）
    { free: 'abandonWhy', label: '为什么不做了', ph: '为什么不想做了？随便写', ta: true },
    // 「具体的描述」：与「什么事」解耦（事可归类、描述不可归类）。固定放最后一位，导出/导入顺序不变。
    // asMain：可做允许「只填这一个框」——那时这段文字本身就是「事」（见 index 的 doSave）；
    // 觉察 / 无感没有这个标记，因为那边的「归类」只从选项池点选
    { free: 'desc', label: '', ph: '也可以直接写「事」；选了上面就是补充', ta: true, asMain: true }
  ] },
  /* 待办（备忘 / 购物 合并后）：类别 + 一句话。
     类别（todoKind）默认 备忘 / 购物，可在「✎ 管理」里加新类别；
     「原因」合并了原先 备忘的「原因」与 购物的「干什么用」（迁移时统一成 free:tasknote） */
  todo: { main: 'todoItem', items: [
    { g: 'todoKind', single: true, noInput: true, required: true },
    { free: 'tasknote', label: '原因', ph: '为什么记这条？可不填', ta: true },
    // 「放弃原因」仅点「放弃」或编辑「已放弃」记录时显示（由 index 编辑态按状态过滤，
    // 与可做那边同一个键名 free:abandonWhy，保存/恢复/导出的处理都复用同一套）
    { free: 'abandonWhy', label: '放弃原因', ph: '为什么放弃？随便写', ta: true }
  ] },
  /* 随记：随手记一句想法 / 灵感。不是待办（没有勾选、不进清单页），也不需要归类。
     类别（jotKind，默认 念头 / 灵感，可在「✎ 管理」里加）只从选项池点选，
     与待办的类别一样摆在主输入框上方；内容本身就是主项，直接写 */
  jot:  { main: 'jotItem',  items: [
    { g: 'jotKind', single: true, noInput: true, required: true }
  ] }
};

// 主题配色统一在 utils/themes.js 维护（单一来源），这里只做读取与转发
const themes = require('./themes.js');
const THEMES = themes.THEMES;
const themeList = themes.themeList;
const themeStyle = themes.themeStyle;
const themeOf = themes.themeOf;

// 把窗口底色（下拉时露出的那层）同步成当前主题的 bg。
// app.json 里的 window.backgroundColor 只能写死一个值，切到别的主题时下拉会露出
// 写死的那色，与页面的 var(--bg) 对不上，出现分层（首页/看页/回看都露）。
// 各主题 bg 都不相同（#FFFFFF / #F8FAF2 / #FFF8F2 / #F7F5FC …），所以必须跟着主题走。
// tabBar 是 custom，底色由 .tabbar 用 var(--bg) 画，不受这里影响，无需处理。
function syncWindowBg(k) {
  const key = k || curTheme();
  const bg = (themeOf(key).vars || {}).bg;
  if (!bg || bg === _lastWindowBg) return;
  _lastWindowBg = bg;
  wx.setBackgroundColor({ backgroundColor: bg, backgroundColorTop: bg, backgroundColorBottom: bg });
}
let _lastWindowBg = '';

// 读取当前主题；若 storage 里是已被删除的废弃主题，回落切换列表第一个，
// 避免冷启动套上不存在的主题、CSS 变量全空（输入框/按钮背景透明）
function curTheme() {
  const list = themes.themeList();
  const k = wx.getStorageSync('theme') || list[0].k;
  return list.some(t => t.k === k) ? k : list[0].k;
}

// 问候语：白天 30 条 / 夜里 30 条（设置页可自定义，改完存云端；恢复默认即用这里）
// 写新句子有两条讲究（白天跨 5:00–18:00、夜里跨 18:00–5:00，都是 13 小时）：
//   ① **别点名具体时刻**（「早晨」「正午」「天黑透」「今晚」）：这一组是按时段轮换的，
//      写死某个时刻，落到这个时段的其它时间就对不上（清晨看到「是正午了吧」很出戏）；
//      ② **别断言天气 / 环境**（「今天天气很好」「雨刚停」），改成「…的话 / 的话」。
//      已经发生的、或纯想象的画面（「风掠过整片芦苇」「月亮浸在湖里」）不受这条限制
const GREETS = {
  day: [
    '天气好的话，去晒晒太阳怎么样？', '窗外有风的话，要不要闭上眼感受下？',
    '光落在桌上，好像挺暖的', '云走得慢的话，看一会儿吧',
    '空气里有花香吗？要不要闻一闻？', '光照在手背上，暖洋洋的',
    '风把窗帘吹得轻轻动，好温柔', '雾散开时，远山像被谁轻轻描了一笔',
    '光落在叶尖，把叶子照得透亮', '风掠过整片芦苇，荡起一层温柔的银浪',
    '晾着的衣服被风鼓起来，像在伸懒腰', '远处有鸟叫传过来，你听见了吗？',
    '树影落在桌上，轻轻晃着，像水波', '天很蓝的时候，云一朵一朵地慢慢走',
    '泡一杯茶放在手边，看热气慢慢散开', '光斜斜地照进来，细尘在里面浮着',
    '路边的草刚修剪过，有股青涩的味道', '窗玻璃温温的，把手心贴上去试试',
    '风替你翻了一页书，要不要读两行', '楼下的声音忽然停了，安静了一小会儿',
    '影子落在脚边，跟着你一起走', '下雨的话，就听一会儿雨声吧',
    '雨后，空气里有泥土的味道', '水冲在手上是凉的，舒服吧',
    '风铃响了一下，是风来了', '阳台上的花又开了一朵',
    '有点困的话，就眯一小会儿', '光从窗帘缝里漏进来，在地板上画了一道',
    '杯壁上凝了一层水珠，凉丝丝的', '不冷不热的时候，刚刚好'
  ],
  night: [
    '晚风很温柔，是不是？', '夜色很美的话，赏赏月如何？', '今天有什么小小的开心事？',
    '灯亮起来了，屋里很安静吧', '窗外有星星的话，要不抬头看一眼？',
    '被窝外的世界安安静静的，是不是？', '月亮浸在湖里，碎成满池晃动的银',
    '路灯把树影投在墙上，像一幅会呼吸的画', '薄霜悄悄爬上窗，开出一树树细小的冰花',
    '星子落进杯里，茶也跟着亮了一下',
    '窗外的路灯亮着，像有人在守着', '晒过的被子，还留着一点太阳的味道',
    '杯里的热水冒着白气，手心也跟着暖了', '最后一辆车开过去了，之后就安静了',
    '风从窗缝里进来，凉了一下又走开', '远处的楼只剩几盏灯还亮着',
    '虫鸣一阵一阵的，像在慢慢数着什么', '影子被路灯拉得很长，陪你慢慢走回去',
    '夜里有飞机经过，天上留下一道细细的光', '把灯关了吧，让眼睛先歇一会儿',
    '热水冲过后背，一天的累松了一点', '床头那本书还开着，看两页再睡？',
    '把手机扣过去，今天就到这儿吧', '窗户留一条缝，风会自己进来',
    '窗外的树叶不动了，夜也跟着停下来', '天色暗下来，屋里反而显得更暖',
    '把被子裹紧一点，脚也跟着暖了', '枕头上有一点洗衣液的味道',
    '明天的事，留给明天再想吧', '放一首慢一点的歌，音量调小一点'
  ]
};

const DCOLORS = ['#7C9A86', '#5E9A94', '#C0A05A', '#948AA8', '#6E8CB0', '#B4544E', '#8A7B5C', '#5C7A8A'];

// 细节回读标签：来源 -> 字段名
const COLMAP = {
  obsKind: '喜恶', obsDeg: '程度',
  obsStart: '怎么开始', 'fx:forgot': '沉浸', 'fx:nrg': '精力', 'fx:mood': '心情', obsMood: '心情',
  'free:obsfeel': '感受', genFeel: '情绪', genWant: '此刻想做', 'free:nownote': '感受', 'free:tasknote': '原因', 'free:memonote': '原因', 'free:buynote': '干什么用',
  'free:desc': '描述',
  'free:trigger': '诱因', 'free:hope': '希望实现成', 'free:doingNote': '进行中感受',
  nopeMood: '情绪', nopeDeg: '程度', 'free:nopefeel': '感受', 'free:after': '之后',
  'free:doneFeel': '做了感受', 'free:doneGain': '做了收获', 'free:abandonWhy': '不做了', 'free:likeFeel': '当时感受',
  'free:howto': '怎么做'
};
const FALLBACK = { obs: '感受', want: '诱因', nope: '感受', now: '感受', like: '当时感受' };

/* ---------------- 纯计算 ---------------- */
function mname(k) {
  if (k === 'done') return '做了';   // 兼容历史 m='done' 记录（新流程已并入「可做·做了」）
  const m = MODULES.concat((G.dims || []).map(d => ({ k: d.k, n: d.n }))).find(x => x.k === k); return m ? m.n : k;
}
function mcolor(k) {
  if (k === 'done') return '#6E8CB0';
  const m = MODULES.concat((G.dims || []).map(d => ({ k: d.k, n: d.n, c: d.c }))).find(x => x.k === k); return m ? m.c : '#7C9A86';
}
function isSingle(g) { for (const m of OPTGROUPS) { if (m.gs.indexOf(g) >= 0) { const f = FIELDS[m.m]; return !!(f.items.find(it => it.g === g && it.single)); } } return false; }
// 该选项组是否隐藏手填输入框（这类组不能手填，编辑时不留残值）
function isNoInput(g) { for (const m of OPTGROUPS) { if (m.gs.indexOf(g) >= 0) { const f = FIELDS[m.m]; return !!(f.items.find(it => it.g === g && it.noInput)); } } return false; }
function getOPT(g) { const O = G.OPT || OPT; return O[g] || []; }
// 快捷创建（「＋」球面板）里平铺哪些类别：待办类别（todoKind 池）+ 随记类别（jotKind 池）。
// 由用户在「设置」里勾选，最多 QUICKCATS_MAX 个；没勾过时给默认（全部待办类别 + 随记类别，截断到上限）。
const QUICKCATS_LS = 'self_quickcats_v1';
const QUICKCATS_MAX = 10;
function defaultQuickCats() {
  const cats = (getOPT('todoKind') || []).map(c => ({ m: 'todo', cat: c }));
  (getOPT('jotKind') || []).forEach(c => cats.push({ m: 'jot', cat: c }));
  return cats.slice(0, QUICKCATS_MAX);
}
// 老配置里的「随记」没有类别（{m:'jot'}）：补成默认随记类别（念头），
// 否则它在新版里对不上任何类别 chip，等于被默默丢掉
function normQuickCats(arr) {
  const jd = (getOPT('jotKind') || [])[0] || '念头';
  return (arr || []).map(c => (c && c.m === 'jot' && !c.cat) ? { m: 'jot', cat: jd } : c);
}
function getQuickCats() {
  try { const v = wx.getStorageSync(QUICKCATS_LS); if (v && Array.isArray(v) && v.length) return normQuickCats(v); } catch (e) {}
  return defaultQuickCats();
}
function setQuickCats(arr) { const a = normQuickCats(arr).slice(0, QUICKCATS_MAX); try { wx.setStorageSync(QUICKCATS_LS, a); } catch (e) {} return a; }
// 常用主题：右上角圆点（theme-switcher）只在这几个之间循环，最多 FAVTHEMES_MAX 个。
// 由用户在「设置 · 外观」里勾选；没勾过（或勾的都失效）时按主题表顺序取前 FAVTHEMES_MAX 个。
const FAVTHEMES_LS = 'self_favthemes_v1';
const FAVTHEMES_MAX = 5;
function defaultFavThemes() { return themeList().slice(0, FAVTHEMES_MAX).map(t => t.k); }
// 只认「仍然存在」的主题：主题表里被下掉的不计数、也不占名额；
// 顺序也按主题表排（不管勾选先后），这样圆点的循环方向始终是可预期的
function normFavThemes(arr) {
  return themeList().map(t => t.k).filter(k => (arr || []).indexOf(k) >= 0);
}
function getFavThemes() {
  try {
    const v = wx.getStorageSync(FAVTHEMES_LS);
    if (v && Array.isArray(v) && v.length) {
      const a = normFavThemes(v);
      if (a.length) return a;
    }
  } catch (e) {}
  return defaultFavThemes();
}
function setFavThemes(arr) { const a = normFavThemes(arr).slice(0, FAVTHEMES_MAX); try { wx.setStorageSync(FAVTHEMES_LS, a); } catch (e) {} return a; }
// 去做模块默认分类：优先锁定值「想做」（不随选项顺序变化），找不到再退第一个，最后兜底「想做」
function wantKindDefault() {
  const k = getOPT('wantKind');
  const def = k.indexOf('想做') >= 0 ? '想做' : (k[0] || '想做');
  return [def];
}
// 待办默认类别：优先锁定值「备忘」（不随选项顺序变化），找不到再退第一个，最后兜底「备忘」
function todoKindDefault() {
  const k = getOPT('todoKind');
  const def = k.indexOf('备忘') >= 0 ? '备忘' : (k[0] || '备忘');
  return [def];
}
// 随记默认类别：优先锁定值「念头」（不随选项顺序变化），找不到再退第一个，最后兜底「念头」
function jotKindDefault() {
  const k = getOPT('jotKind');
  const def = k.indexOf('念头') >= 0 ? '念头' : (k[0] || '念头');
  return [def];
}
// 觉察「怎么开始的」默认：优先锁定值「自己想做」（不随选项顺序变化），找不到再退第一个
function obsStartDefault() {
  const k = getOPT('obsStart');
  const def = k.indexOf('自己想做') >= 0 ? '自己想做' : (k[0] || '自己想做');
  return [def];
}

function extLabel(src, m) {
  if (src && src.indexOf('fallback:') === 0) return FALLBACK[m] || '';
  return COLMAP[src] || FALLBACK[m] || '';
}
// 生成记录的细节展示列表 [{lbl, v}]
// obs：按「喜恶 → 程度 → 感受 → 怎么开始 / 沉浸 / 精力」排序，情绪与自由感受合成「感受」一行
// nope：仅作兜底——无感已并入觉察，这里保留是为了万一某次迁移没跑完，老记录仍能正常回读
function buildExt(m, ext, extSrc) {
  const f = FIELDS[m];
  const hideSrc = f ? (f.items.filter(it => it.hideDetail && it.g).map(it => it.g)) : [];
  const list = (ext || []).map((v, i) => {
    const src = (extSrc || [])[i] || '';
    return { src, lbl: extLabel(src, m), v };
  // 「具体的描述」不并进细节区：它要和「归类」同排展示（见页面 recVM 的 desc），
  // 这里排掉，避免同一句话在标题行和细节行各出现一次；
  // 随记的「类别」同理——行首显示的模块名就是类别本身（念头 / 灵感），不再重复成一行
  }).filter(d => hideSrc.indexOf(d.src) < 0 && d.src !== DESC_SRC && d.src !== 'jotKind');
  // 觉察：详情按「喜恶 → 感受 → 怎么开始的 → 沉浸 → 精力」展示，与编辑器里的顺序一致。
  // 「感受」是一组：程度（obsDeg）与情绪（obsMood）连写成「有点焦虑」，再和自由感受（obsfeel）
  // 用 · 连成一行 —— 与编辑器里「档位 + 情绪 + 自由输入框」合成一块的口径一致；
  // 只影响回读展示，ext/extSrc 里三者仍是各自独立的字段
  if (m === 'obs') {
    const pick = (src) => (list.find(d => d.src === src) || {}).v || '';
    const out = [];
    const kind = pick('obsKind'); if (kind) out.push({ lbl: COLMAP.obsKind, v: kind });
    const feel = [pick('obsDeg') + pick('obsMood'), pick('free:obsfeel')].filter(Boolean).join(' · ');
    if (feel) out.push({ lbl: GLABEL.obsMood, v: feel });   // 组名跟随编辑器里的「感受」
    ['obsStart', 'fx:forgot', 'fx:nrg'].forEach(s => {
      const d = list.find(x => x.src === s); if (d) out.push(d);
    });
    // 兜底：没在上述来源里的（历史遗留脏数据）照原样附在后面，不丢信息
    const shown = ['obsKind', 'obsDeg', 'obsMood', 'free:obsfeel', 'obsStart', 'fx:forgot', 'fx:nrg'];
    list.forEach(d => { if (shown.indexOf(d.src) < 0) out.push(d); });
    return out;
  }
  if (m === 'nope') {
    const deg = list.find(d => d.src === 'nopeDeg');
    const degV = deg ? deg.v : '';
    return list
      .filter(d => d.src !== 'nopeDeg') // 程度不单独成行
      .map(d => (d.src === 'nopeMood' ? { lbl: '情绪', v: (degV ? degV : '') + d.v } : d));
  }
  return list;
}
// 某模块的细节来源列表（有序），用于导入时按标签反查真实来源
// 返回 [{ src, lbl }]，src 为记录里的来源键（如 obsStart / fx:forgot / free:xxx）
function srcList(m) {
  const f = FIELDS[m];
  if (!f) {
    const d = (G.dims || []).find(x => x.k === m);
    if (d) return [{ src: 'm_' + m, lbl: d.n }, { src: 'free:note', lbl: '补充' }];
    return [];
  }
  const out = [];
  f.items.forEach(it => {
    if (it.hideDetail) return; // 分类等隐藏字段是固定的，不参与细节的顺序对齐/导入匹配
    if (it.g) out.push({ src: it.g, lbl: GLABEL[it.g] || it.g });
    else if (it.fx) out.push({ src: 'fx:' + it.fx, lbl: (FIXED[it.fx] || {}).label || it.fx });
    // label 为空（编辑器里不显示标题）时回退到回读标签，保证导入时的标签匹配仍有意义
    else if (it.free) out.push({ src: 'free:' + it.free, lbl: it.label || COLMAP['free:' + it.free] || it.free });
  });
  return out;
}
// 导入用：细节按模块字段顺序对齐到真实来源（导出文本只含值、不含标签，按顺序最稳）
// 若值里恰好等于某个标签名，则优先按标签匹配（兼容带标签的文本）
function mapExtSrc(m, labels) {
  const list = srcList(m);
  const vals = labels || [];
  const used = {};
  const out = new Array(vals.length);
  vals.forEach((v, i) => {
    const hit = list.find(it => it.lbl === v && !used[it.src]);
    if (hit) { used[hit.src] = 1; out[i] = hit.src; }
  });
  // 剩余未命中的，按字段顺序依次填未使用过的来源
  let p = 0;
  vals.forEach((v, i) => {
    if (out[i]) return;
    while (p < list.length && used[list[p].src]) p++;
    if (p < list.length) { used[list[p].src] = 1; out[i] = list[p].src; }
    else out[i] = 'fallback:' + m;
  });
  return out;
}
// 规范化时间显示：只保留 HH:MM；t 里混入的日期会剥掉，缺失时用 ts 补
function normTime(t, ts) {
  const s = String(t || '').trim();
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return ('0' + (+m[1])).slice(-2) + ':' + m[2];
  if (ts) { const d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  return s;
}
// 记录的模块显示名：want 按状态显示为 未做/在做（已完成归入 done 模块显示“做了”），再拼接分类；
// obs 同样把「喜恶」拼在模块名后面（觉察·喜欢），这样列表 / 操作条一眼能看出这条归在哪一类
function recMname(r) {
  // 从 ext / extSrc 里取某个细节值（两条拼接规则共用）
  const extVal = (src) => {
    const es = r.extSrc || [], ex = r.ext || [];
    const i = es.indexOf(src);
    return i >= 0 ? ex[i] : '';
  };
  if (r.m === 'want') {
    const st = r.status || '';
    const stateName = st === 'doing' ? '在做' : (st === 'done' ? '做了' : (st === 'abandon' ? '不做' : '未做'));
    const k = extVal('wantKind');
    return k ? stateName + '·' + k : stateName;
  }
  if (r.m === 'obs') {
    const k = extVal('obsKind'), n = mname('obs');
    return k ? n + '·' + k : n;
  }
  // 随记：只显示类别（念头 / 灵感 …），不带「随记·」前缀——随记本来就都在随记这一栏里，
  // 带前缀反而啰嗦；老记录没有类别时才回落到「随记」
  if (r.m === 'jot') {
    const k = extVal('jotKind');
    return k || mname('jot');
  }
  // 待办：显示类别（备忘 / 购物），而不是模块名「待办」——列表 / 操作条上一眼能分清
  if (isTask(r.m)) return taskCat(r);
  return mname(r.m);
}
// 待办清单行的时间文案：今天只给时刻；非今天给简洁日期（跨年才带年份），
// 否则一个「15:30」看不出是哪天的待办
function taskTime(ts, t) {
  const hm = normTime(t, ts);
  const d = new Date(ts || Date.now()), now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return hm;
  const md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return d.getFullYear() === now.getFullYear() ? md : (d.getFullYear() + '年' + md);
}
// 给一条记录补上 ago / day
function decorate(r) {
  const o = Object.assign({}, r);
  o.ago = agoOf(o.ts);
  o.day = dayLabel(o.ago);
  o.t = normTime(o.t, o.ts);
  o.tt = taskTime(o.ts, o.t);   // 待办行专用：今天＝时刻，非今天＝简洁日期
  o.extSrc = fixExtSrc(o.m, o.ext, o.extSrc);
  o.done = !!o.done;
  o.doneAt = o.doneAt || 0;
  o.status = r.status || '';
  o.ref = r.ref || '';
  o.refTxt = r.refTxt || '';
  o.startedAt = r.startedAt || 0;
  o.abandonedAt = r.abandonedAt || 0;
  o.endTs = r.endTs || 0;
  // 待办：类别（todoKind）+「原因」自由字段。
  // 「原因」合并了原先 备忘的「原因」与 购物的「干什么用」（旧的 two 个来源也一并兼容，供迁移前数据回显）
  o.cat = '';
  o.reason = '';
  o.usefor = '';
  o.abandonWhy = '';
  // 「具体的描述」：与「归类」(txt) 配对，取出后供列表同排展示
  o.desc = '';
  const _es = o.extSrc || [], _ex = o.ext || [];
  for (let i = 0; i < _es.length; i++) {
    if (!_ex[i]) continue;
    if (_es[i] === 'todoKind') o.cat = _ex[i];
    else if (_es[i] === 'free:tasknote' || _es[i] === 'free:memonote' || _es[i] === 'free:buynote') o.reason = _ex[i];
    else if (_es[i] === 'free:abandonWhy') o.abandonWhy = _ex[i];
    else if (_es[i] === DESC_SRC) o.desc = _ex[i];
  }
  // 已放弃的待办：行内「原因」的位置改显示「放弃原因」——只取它，不再显示原来的原因；
  // 显隐规则与原因完全一致（有值才显示那一行，见 components/todo-list 的 .twr）
  if (isTask(o.m) && o.status === 'abandon' && o.abandonWhy) o.reason = o.abandonWhy;
  return o;
}
// 待办型记录（备忘 / 购物 已合并为 todo；memo / buy 只用于兼容迁移前的老数据）
function isTask(m) { return m === 'todo' || m === 'memo' || m === 'buy'; }

// 待办的「类别」：新记录取 ext 里的 todoKind；迁移前的老记录按原模块兜底。
//
// 「类别色」是与「维度色」分开的另一族，两边不重复（维度色见 MODULES：
// 觉察·绿 / 此刻·青 / 可做·金 / 待办·棕 / 随记·紫）：下面的调色板刻意避开了这 5 个颜色。
// ・待办类别按它在 todoKind 池里的位置取色（池子里任意两个类别都不会撞色；删掉一个，后面的顺次前移）
// ・随记类别走 jotColor，从同一块调色板往后错开取
// 于是「维度 / 待办类别 / 随记类别」三者的颜色两两不同
const CAT_PALETTE = ['#C08552', '#B4544E', '#6E8CB0', '#5C7A8A', '#8A9A5B', '#4F8FA8', '#9C6B4F', '#A8809E'];
function catColor(cat) {
  if (!cat) return mcolor('todo');
  const i = getOPT('todoKind').indexOf(cat);
  return i >= 0 ? CAT_PALETTE[i % CAT_PALETTE.length] : mcolor('todo');
}
// 随记类别颜色：与待办类别共用一块调色板，但整体往后错开「待办类别数」——
// 待办类别占调色板靠前的几位，随记类别从第 N 位起取色，所以同一屏里
// 待办类别 + 随记类别 的颜色互不重复；这块调色板本身又不含维度色，
// 于是三族（维度 / 待办类别 / 随记类别）两两不同。
// 取不到（老记录没类别 / 类别已从池里删掉）时回落到随记的模块色。
function jotColor(cat) {
  if (!cat) return mcolor('jot');
  const i = getOPT('jotKind').indexOf(cat);
  if (i < 0) return mcolor('jot');
  const off = (getOPT('todoKind') || []).length;
  return CAT_PALETTE[(i + off) % CAT_PALETTE.length];
}
function taskCat(r) {
  if (!r) return '待办';
  // 以 ext 里的类别为准（decorate 虽然缓存了一份到 r.cat，但改选项名时只改了 ext，缓存会过期）
  const es = r.extSrc || [], ex = r.ext || [];
  const i = es.indexOf('todoKind');
  if (i >= 0 && ex[i]) return ex[i];
  if (r.cat) return r.cat;
  if (r.m === 'memo') return '备忘';
  if (r.m === 'buy') return '购物';
  return '待办';
}
function taskColor(r) { return catColor(taskCat(r)); }
// 随记的「类别」：取 ext 里的 jotKind（老记录还没类别时返回空串，页面自己兜底显示）
function jotCat(r) {
  if (!r) return '';
  const es = r.extSrc || [], ex = r.ext || [];
  const i = es.indexOf('jotKind');
  return i >= 0 ? (ex[i] || '') : '';
}

// 每天默认最多先渲染多少条：超过才有「展开全部」。这个数只在这里写一份——
// todo-list.wxml 以前也写死了一份 20（g.n > 20），改一处忘另一处就会出现
// 「显示了 20 条但入口不出现」（或反之）；现在 wxml 只看 winDays 返回的 more / all
const DAY_WIN = 20;
// 按天分段（[{key, day, recs}]）的「只渲染最近 N 天」窗口：清单页 / 看页共用。
// key 统一转成字符串：它要经 data-* 传回 dataset，避免数字 / 字符串对不上
function winDays(days, lim, dayAll) {
  return (days || []).slice(0, lim).map(g => {
    const key = String(g.key);
    const all = !!(dayAll && dayAll[key]);
    const recs = all ? g.recs : g.recs.slice(0, DAY_WIN);
    const n = g.recs.length;
    return { key, day: g.day, recs, n, all, more: !all && n > recs.length };
  });
}
// 完成时间文案：已完成 · X月X日 HH:MM
function doneLabel(ts) {
  if (!ts) return '已完成';
  const d = new Date(ts);
  const hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
  return '已完成 · ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hh + ':' + mm;
}
// 修正历史数据的来源：整条细节都挂 fallback:<模块> 时，按字段顺序重新对齐回真实来源
function fixExtSrc(m, ext, extSrc) {
  const src = (extSrc || []).slice();
  const extArr = ext || [];
  while (src.length < extArr.length) src.push('');
  const list = srcList(m);
  if (!list.length) return src;
  // 已明确来源的保留；fallback/空 的按「标签匹配 → 顺序补齐」重新分配
  const used = {};
  src.forEach(s => { if (s && s.indexOf('fallback:') !== 0) used[s] = 1; });
  const pending = [];
  src.forEach((s, i) => { if (!s || s.indexOf('fallback:') === 0) pending.push(i); });
  if (!pending.length) return src; // 无需修正
  // 先按值与标签同名匹配
  const out = src.slice();
  pending.forEach(i => {
    const hit = list.find(it => it.lbl === extArr[i] && !used[it.src]);
    if (hit) { used[hit.src] = 1; out[i] = hit.src; }
  });
  // 剩余按字段顺序补齐
  let p = 0;
  pending.forEach(i => {
    if (out[i] && out[i].indexOf('fallback:') !== 0) return;
    while (p < list.length && used[list[p].src]) p++;
    out[i] = p < list.length ? (used[list[p].src] = 1, list[p].src) : 'fallback:' + m;
  });
  return out;
}

/* ---------------- 云开发 ---------------- */
function db() { return wx.cloud.database(); }
function recCol() { return db().collection('records'); }
function optCol() { return db().collection('options'); }
function cfgCol() { return db().collection('usercfg'); }

// 记录按微信用户（_openid）隔离：云数据库默认「仅创建者可读写」，
// 不同用户创建的文档彼此不可见，这里无需手动加 openid 过滤。
// 文档 -> 装饰记录（与旧 loadRecords 的字段映射保持一致）
function decorateDoc(d) {
  return decorate({
    id: d._id, _rid: d._id, m: d.m, t: d.t, txt: d.txt,
    ext: d.ext || [], extSrc: d.extSrc || [], ts: d.ts,
    done: !!d.done, doneAt: d.doneAt || 0,
    status: d.status || '', ref: d.ref || '', refTxt: d.refTxt || '', startedAt: d.startedAt || 0, refTs: d.refTs || 0, endTs: d.endTs || 0, abandonedAt: d.abandonedAt || 0
  });
}
// 组装查询条件：模块过滤 + 时间范围（startTs <= ts < before）+ 状态（仅 want 模块用）+ 细节值筛选
// state: 'all'(未做+在做+做了+不做) / 'todo' / 'doing' / 'done' / 'abandon'
// extTags: 细节值（如觉察的「喜恶」= 喜欢 / 感兴趣 / 无感 / 讨厌）——ext 是数组，
//          单个值直接等值命中（数组包含即算中），多个值要求同时都包含
// mNot: 要排除的模块（看页「全部」不看待办：备忘 / 购物不进时间线，取回来只是白占一页的位置）
function recWhere({ m = null, mNot = null, startTs = null, before = null, state = null, extTags = null } = {}) {
  const _ = db().command;
  const w = {};
  if (m && m !== 'all') w.m = m;
  else if (mNot && mNot.length) w.m = _.nin(mNot);
  if (m === 'want' && state) {
    if (state === 'todo') w.status = _.nin(['doing', 'done', 'abandon']);
    else if (state === 'doing') w.status = 'doing';
    else if (state === 'done') w.status = 'done';
    else if (state === 'abandon') w.status = 'abandon';
    // state === 'all'：不限制 status（未做 + 在做 + 做了 + 不做 都显示）
  }
  const tags = (extTags || []).filter(Boolean);
  if (tags.length === 1) w.ext = tags[0];
  else if (tags.length > 1) w.ext = _.all(tags);
  const ts = [];
  if (startTs != null) ts.push(_.gte(startTs));
  // 用 lte 而不是 lt：同毫秒可能有多条记录（批量导入常见），lt 会把它们整批跳过；
  // 重复的部分由调用方用 excludeIds 去重，保证不漏数据
  if (before != null) ts.push(_.lte(before));
  if (ts.length === 1) w.ts = ts[0];
  else if (ts.length === 2) w.ts = _.and(ts);
  return w;
}
// 单页：before 为上一页最后一条的 ts（取更旧）。
// 重要：小程序端 limit 默认与上限都是 20（官方限制），请求超过 20 会被静默截断，
// 所以这里最多取 20 条，并用「是否满页」判断可能还有更旧的记录（下一页返回空即结束）。
// excludeIds 用于去掉已加载的文档（配合 lte 游标，避免同毫秒记录重复或遗漏）。
function loadRecordsPage({ before = null, limit = 20, m = null, mNot = null, startTs = null, state = null, extTags = null, excludeIds = null } = {}) {
  const take = Math.min(limit || 20, 20);
  return new Promise((resolve) => {
    recCol().where(recWhere({ m, mNot, startTs, before, state, extTags })).orderBy('ts', 'desc').limit(take).get().then(res => {
      const raw = res.data || [];
      let data = raw;
      if (excludeIds && excludeIds.length) {
        const set = {};
        excludeIds.forEach(id => { set[id] = 1; });
        data = raw.filter(d => !set[d._id]);
      }
      const list = data.map(decorateDoc);
      const hasMore = raw.length >= take;   // 满页 → 可能还有更旧的
      const nextCursor = list.length ? list[list.length - 1].ts : null;
      resolve({ list, hasMore, nextCursor });
    }).catch(e => { log.warn('records.page', e); resolve({ list: [], hasMore: false, nextCursor: null }); });
  });
}
// 全量拉取（导出 / 搜索 / 记页数据源）：按小程序端上限 20 自动翻页直到取完
// onFirstPage 是「渐进加载」的钩子：第一页（20 条）拿到就立刻回调一次，
// 剩余页继续在后台串行拉。下拉刷新用它先渲染、先收起下拉，不必等全部页拉完
// （串行分页要 N/20 次网络往返，全量等完才会让人等好几秒）。
function loadAllRecords({ m = null, mNot = null, startTs = null, onFirstPage = null } = {}) {
  const PAGE = 20;
  let cursor = null;
  let first = true;
  const out = [];
  const seen = {};
  function step() {
    return loadRecordsPage({ before: cursor, limit: PAGE, m, mNot, startTs, excludeIds: Object.keys(seen) }).then(({ list, hasMore, nextCursor }) => {
      list.forEach(r => { if (!seen[r._rid]) { seen[r._rid] = 1; out.push(r); } });
      if (first) {
        first = false;
        if (typeof onFirstPage === 'function') { try { onFirstPage(out.slice()); } catch (e) { log.warn('loadAll.first', e); } }
      }
      // 本页没有新增（全是已加载的同毫秒记录或已取完）→ 结束，防止死循环
      if (!list.length) return out;
      if (hasMore && nextCursor != null) { cursor = nextCursor; return step(); }
      return out;
    });
  }
  return step();
}
// 记录总数（按 模块 / 时间范围 / 流转状态 / 细节标签 过滤），用于「共 X 条」准确统计。
// 走 count 接口，不受列表分页影响。
function countRecords({ m = null, startTs = null, state = null, extTag = null, extTags = null } = {}) {
  return new Promise((resolve) => {
    // extTag 是早期的单标签写法，extTags 支持「喜恶 + 沉浸」这类组合（都要命中）
    const tags = (extTags && extTags.length) ? extTags : (extTag ? [extTag] : []);
    const w = recWhere({ m, startTs, state, extTags: tags });
    recCol().where(w).count()
      .then(r => resolve((r && r.total) || 0)).catch(e => { log.warn('records.count', e); resolve(0); });
  });
}
// 统计：各觉察维度（不含备忘/购物）的条数 → { obs: 12, now: 3, want: 5 }
function countByModule({ startTs = null } = {}) {
  const mods = MODULES.filter(m => !isTask(m.k));
  return Promise.all(mods.map(m => countRecords({ m: m.k, startTs }))).then(arr => {
    const out = {};
    mods.forEach((m, i) => { out[m.k] = arr[i] || 0; });
    return out;
  });
}
// 统计：可做维度下各流转状态的条数 → { todo, doing, done, abandon }
function countByStatus({ startTs = null } = {}) {
  const states = ['todo', 'doing', 'done', 'abandon'];
  return Promise.all(states.map(s => countRecords({ m: 'want', startTs, state: s }))).then(arr => {
    const out = { todo: 0, doing: 0, done: 0, abandon: 0 };
    states.forEach((s, i) => { out[s] = arr[i] || 0; });
    return out;
  });
}
// 统计：某模块下「事项」出现次数前几名（聚合分组，不受分页影响）→ [{ txt, n }]
function countByTxt({ m = null, startTs = null, top = 8, extTags = null } = {}) {
  const dbc = db().command;
  const $ = dbc.aggregate;
  const match = {};
  if (m) match.m = m;
  if (startTs != null) match.ts = dbc.gte(startTs);
  const tags = (extTags || []).filter(Boolean);
  if (tags.length === 1) match.ext = tags[0];
  else if (tags.length > 1) match.ext = dbc.all(tags);
  return db().collection('records').aggregate()
    .match(match)
    .group({ _id: '$txt', n: $.sum(1) })
    .sort({ n: -1 })
    .limit(top)
    .end()
    .then(res => (res.list || []).map(x => ({ txt: x._id || '（未填）', n: x.n || 0 })))
    .catch(e => { log.warn('records.topTxt', e); return []; });
}
// 兼容旧调用：全量加载（去掉 300 上限，避免早期记录被静默丢弃）
// opts.onFirstPage：渐进加载钩子，见 loadAllRecords
function loadRecords(opts) { return loadAllRecords(opts || {}).then(list => list); }
function addRecord(rec) {
  const data = { m: rec.m, t: rec.t, txt: rec.txt, ext: rec.ext || [], extSrc: rec.extSrc || [], ts: rec.ts || Date.now(), done: !!rec.done, doneAt: rec.doneAt || 0, createTime: db().serverDate() };
  if (rec.status) data.status = rec.status;
  if (rec.startedAt) data.startedAt = rec.startedAt;
  if (rec.ref) data.ref = rec.ref;
  if (rec.refTxt) data.refTxt = rec.refTxt;
  if (rec.refTs) data.refTs = rec.refTs;
  if (rec.endTs) data.endTs = rec.endTs;
  if (rec.abandonedAt) data.abandonedAt = rec.abandonedAt;
  return recCol().add({ data }).then(res => res._id)
    .catch(e => { log.err('record.add', e, { m: rec.m, txt: rec.txt }); log.fail('没记上，请重试'); throw e; });
}
function updateRecord(rec) {
  const data = { m: rec.m, t: rec.t, txt: rec.txt, ext: rec.ext || [], extSrc: rec.extSrc || [], ts: rec.ts || Date.now(), done: !!rec.done, doneAt: rec.doneAt || 0 };
  if (rec.status !== undefined) data.status = rec.status;
  if (rec.startedAt !== undefined) data.startedAt = rec.startedAt;
  if (rec.ref !== undefined) data.ref = rec.ref;
  if (rec.refTxt !== undefined) data.refTxt = rec.refTxt;
  if (rec.refTs !== undefined) data.refTs = rec.refTs;
  if (rec.endTs !== undefined) data.endTs = rec.endTs;
  if (rec.abandonedAt !== undefined) data.abandonedAt = rec.abandonedAt;
  return recCol().doc(rec._rid).update({ data })
    .catch(e => { log.err('record.update', e, { m: rec.m, txt: rec.txt }); log.fail('没保存上，请重试'); throw e; });
}
function deleteRecord(rec) {
  return recCol().doc(rec._rid).remove()
    .catch(e => { log.err('record.delete', e, { m: rec && rec.m, txt: rec && rec.txt }); log.fail('没删掉，请重试'); throw e; });
}
// 清空全部记录（递归分批删除，仅删当前用户自己的）
function clearAllRecords() {
  return recCol().limit(100).get().then(res => {
    const docs = res.data || [];
    if (!docs.length) return 0;
    return Promise.all(docs.map(d => recCol().doc(d._id).remove()))
      .then(() => clearAllRecords()).then(rest => docs.length + rest);
  }).catch(e => { log.err('records.clearAll', e); return 0; });
}

// 选项池：合并默认值、云端、本地存储（本地兜底，保证改动不丢）
const OPT_LS = 'self_opt_v1';
function loadLocalOpts() {
  try { return wx.getStorageSync(OPT_LS) || {}; } catch (e) { return {}; }
}
function persistLocalOpts() {
  try {
    const O = G.OPT || OPT;
    const copy = {};
    Object.keys(O).forEach(g => { copy[g] = (O[g] || []).slice(); });
    wx.setStorageSync(OPT_LS, copy);
  } catch (e) {}
}
function mergeOpts(O, src) {
  Object.keys(src || {}).forEach(g => {
    if (DEAD_OPT_GROUPS.indexOf(g) >= 0) return;   // 已废弃的组：本地残留不再合并回来
    if (!O[g]) O[g] = [];
    (src[g] || []).forEach(v => { if (O[g].indexOf(v) < 0) O[g].push(v); });
  });
}

// 默认项的「删除/改名」覆盖：记录被删掉的默认项 key（group|value），加载时剔除，避免从 OPT 常量回弹
const DELDEF_LS = 'self_deldef_v1';
let _delDef = [];
function loadDelDefLocal() { try { return wx.getStorageSync(DELDEF_LS) || []; } catch (e) { return []; } }
function persistDelDefLocal(arr) { try { wx.setStorageSync(DELDEF_LS, arr); } catch (e) {} }
function isDefault(g, v) { return (OPT[g] || []).indexOf(v) >= 0; }
function applyDelDef(O, delDef) {
  const set = new Set(delDef || []);
  Object.keys(O).forEach(g => { if (O[g]) O[g] = O[g].filter(v => !set.has(g + '|' + v)); });
}
function loadDelDef() {
  return new Promise(resolve => {
    const local = loadDelDefLocal();
    cfgCol().where({ type: 'delDef' }).get().then(res => {
      const docs = res.data || [];
      const cloud = (docs[0] && docs[0].data) || [];
      const merged = Array.from(new Set([...local, ...cloud]));
      persistDelDefLocal(merged);
      _delDef = merged;
      resolve(merged);
    }).catch(e => { log.warn('delDef.load', e); _delDef = local; resolve(local); });
  });
}
function saveDelDef(arr) {
  _delDef = arr.slice();
  persistDelDefLocal(arr);
  return cfgCol().where({ type: 'delDef' }).get().then(res => {
    const docs = res.data || [];
    if (docs.length) return cfgCol().doc(docs[0]._id).update({ data: { data: arr } }).then(() => true).catch(() => false);
    return cfgCol().add({ data: { type: 'delDef', data: arr } }).then(() => true).catch(() => false);
  }).catch(e => { log.warn('delDef.sync', e, 'usercfg 集合已创建？'); return false; });
}
function addDelDef(g, v) {
  if (!isDefault(g, v)) return Promise.resolve(false);
  const k = g + '|' + v;
  if (_delDef.indexOf(k) < 0) _delDef.push(k);
  return saveDelDef(_delDef);
}
function clearDelDef(g, v) {
  const k = g + '|' + v;
  const i = _delDef.indexOf(k);
  if (i < 0) return Promise.resolve(false);
  _delDef.splice(i, 1);
  return saveDelDef(_delDef);
}

/* 用户自己编辑过的组：只要在「✎ 管理」里动过某组（增 / 删 / 改名），这一组就归他自己了——
   把当时的完整列表存下来（本地 + 云端 usercfg），此后加载就以这份为准，
   代码里的默认词不再往这组里塞（改默认池只影响他从没动过的组）。
   只调过顺序不算数：顺序另有 optOrder 记着，词组该更新还是更新。 */
const OPTCUSTOM_LS = 'self_optcustom_v1';
let _optCustom = {};
function loadOptCustomLocal() { try { return wx.getStorageSync(OPTCUSTOM_LS) || {}; } catch (e) { return {}; } }
function persistOptCustomLocal(map) { try { wx.setStorageSync(OPTCUSTOM_LS, map); } catch (e) {} }
function loadOptCustom() {
  return new Promise(resolve => {
    const local = loadOptCustomLocal();
    cfgCol().where({ type: 'optCustom' }).get().then(res => {
      const cloud = (res.data && res.data[0] && res.data[0].data) || {};
      const merged = Object.assign({}, local, cloud);
      persistOptCustomLocal(merged);
      _optCustom = merged;
      resolve(merged);
    }).catch(e => { log.warn('optCustom.load', e); _optCustom = local; resolve(local); });
  });
}
function saveOptCustom(map) {
  _optCustom = map;
  persistOptCustomLocal(map);
  return cfgCol().where({ type: 'optCustom' }).get().then(res => {
    const docs = res.data || [];
    if (docs.length) return cfgCol().doc(docs[0]._id).update({ data: { data: map } }).then(() => true).catch(() => false);
    return cfgCol().add({ data: { type: 'optCustom', data: map } }).then(() => true).catch(() => false);
  }).catch(e => { log.warn('optCustom.sync', e); return false; });
}
// 用户动过某组后调用：把这一组的完整列表存下来，此后这一组以它为准
function markOptCustom(g, arr) {
  if (!g) return Promise.resolve(false);
  const map = Object.assign({}, _optCustom);
  map[g] = (arr || (G.OPT && G.OPT[g]) || []).slice();
  return saveOptCustom(map);
}

// 选项顺序：每组一个有序数组，持久化到本地 + 云端 usercfg（type=optOrder）
const ORDER_LS = 'self_optorder_v1';
function loadOptOrderLocal() { try { return wx.getStorageSync(ORDER_LS) || {}; } catch (e) { return {}; } }
function persistOptOrderLocal(map) { try { wx.setStorageSync(ORDER_LS, map); } catch (e) {} }
function loadOptOrder() {
  return new Promise(resolve => {
    const local = loadOptOrderLocal();
    cfgCol().where({ type: 'optOrder' }).get().then(res => {
      const cloud = (res.data && res.data[0] && res.data[0].data) || {};
      const merged = Object.assign({}, local, cloud); // 云端覆盖本地
      persistOptOrderLocal(merged);
      resolve(merged);
    }).catch(e => { log.warn('optOrder.load', e); resolve(local); });
  });
}
function saveOptOrderToCloud(map) {
  return cfgCol().where({ type: 'optOrder' }).get().then(res => {
    const docs = res.data || [];
    if (docs.length) return cfgCol().doc(docs[0]._id).update({ data: { data: map } }).then(() => true).catch(() => false);
    return cfgCol().add({ data: { type: 'optOrder', data: map } }).then(() => true).catch(() => false);
  }).catch(e => { log.warn('optOrder.sync', e, 'usercfg 集合已创建？'); return false; });
}
// 更新某组顺序并持久化（同步 G.OPT 内存、本地、云端）
function setOptOrder(g, arr) {
  if (!G.OPT) G.OPT = {};
  G.OPT[g] = arr.slice();
  const map = loadOptOrderLocal();
  map[g] = arr.slice();
  persistOptOrderLocal(map);
  saveOptOrderToCloud(map);
  return Promise.resolve(true);
}
function loadOptions() {
  return new Promise((resolve) => {
    const local = loadLocalOpts();
    Promise.all([
      optCol().limit(1000).get().catch(() => ({ data: [] })),
      loadDelDef(),
      loadOptOrder(),
      loadOptCustom()
    ]).then(([res, delDef, orderMap, custom]) => {
      const O = JSON.parse(JSON.stringify(OPT));
      // 用户自己编辑过的组：以他存下来的那份为底，代码里的默认词不再插手
      Object.keys(custom || {}).forEach(g => {
        if (DEAD_OPT_GROUPS.indexOf(g) >= 0 || !custom[g]) return;
        O[g] = custom[g].slice();
      });
      const docs = res.data || [];
      docs.forEach(d => {
        const g = d.group, v = d.value;
        if (DEAD_OPT_GROUPS.indexOf(g) >= 0) return;   // 无感 / 悦己 的旧文档：忽略（词已并入觉察）
        if (!O[g]) O[g] = [];
        if (O[g].indexOf(v) < 0) O[g].push(v);
      });
      // 本地快照里混着代码默认词：已自定义过的组不吃它，否则默认词又渗回去了
      const localClean = {};
      Object.keys(local || {}).forEach(g => { if (!(custom && custom[g])) localClean[g] = local[g]; });
      mergeOpts(O, localClean);
      applyDelDef(O, delDef); // 剔除被删/改的默认项，避免常量回弹
      // 应用自定义排序：已记录顺序的优先按记录排，未记录的排后面
      Object.keys(orderMap || {}).forEach(g => {
        if (!O[g]) return;
        const order = orderMap[g] || [];
        const present = order.filter(v => O[g].indexOf(v) >= 0);
        const extra = O[g].filter(v => order.indexOf(v) < 0);
        O[g] = present.concat(extra);
      });
      console.log('[options] 云端读取到 ' + docs.length + ' 条用户选项');
      resolve(O);
    }).catch(e => {
      log.err('options.load', e, '回退默认+本地');
      const O = JSON.parse(JSON.stringify(OPT));
      Object.keys(_optCustom || {}).forEach(g => { if (_optCustom[g]) O[g] = _optCustom[g].slice(); });
      const localClean = {};
      Object.keys(local || {}).forEach(g => { if (!(_optCustom && _optCustom[g])) localClean[g] = local[g]; });
      mergeOpts(O, localClean); applyDelDef(O, _delDef);
      resolve(O);
    });
  });
}
function addOption(g, v) {
  persistLocalOpts(); // 先落本地，保证不丢
  return optCol().add({ data: { group: g, value: v, sort: (getOPT(g).length) } })
    .then(res => {
      console.log('[options] 云写入成功 id=', res._id, 'group=', g, 'value=', v);
      return true;
    })
    .catch(e => { log.err('option.add', e, '已存本地'); return false; });
}
function removeOption(g, v) {
  persistLocalOpts();
  return new Promise((resolve) => {
    optCol().where({ group: g, value: v }).limit(1000).get().then(res => {
      const docs = res.data || [];
      let p = Promise.resolve();
      docs.forEach(d => { p = p.then(() => optCol().doc(d._id).remove()); });
      p.then(() => resolve(true)).catch(e => { log.warn('option.remove', e); resolve(false); });
    }).catch(e => { log.warn('option.remove', e); resolve(false); });
  });
}
// 某个选项组是不是某模块的主项组（主项存 txt、不进 ext）；是则返回该模块 key
function mainModuleOf(g) {
  let hit = '';
  Object.keys(FIELDS).forEach(m => { if (!hit && FIELDS[m].main === g) hit = m; });
  return hit;
}

// 选项改名只作用于「当前这一组」——不同组里的同名项互不影响。
//  · 主项组（觉察·归类 / 可做·什么事 …）：只改所属模块记录的 txt
//  · 细节组：只改 ext 里 extSrc 正好等于该组的位置
// 云端没法表达「数组某一项等于某值」，所以按 ext 命中粗筛、再在本地逐条核对；
// 核对过的文档用 nin 排除——同名值若同时属于别的组，记录会持续命中粗筛，
// 不排除的话就会反复取到同一批、原地打转
function renameInRecords(g, ov, nv) {
  const _ = db().command;
  const mainOf = mainModuleOf(g);
  const seen = [];
  let rounds = 0;
  function step() {
    if (++rounds > 200 || seen.length > 1000) return Promise.resolve(false);   // 兜底
    const base = mainOf ? { m: mainOf, txt: ov } : { ext: ov };
    const where = Object.assign({}, base);
    if (seen.length) where._id = _.nin(seen);
    return recCol().where(where).limit(20).get().then(res => {
      const docs = res.data || [];
      if (!docs.length) return true;
      docs.forEach(d => seen.push(d._id));
      const tasks = [];
      docs.forEach(d => {
        if (mainOf) {
          if (d.txt !== ov) return;
          tasks.push(recCol().doc(d._id).update({ data: { txt: nv } }));
          return;
        }
        const es = d.extSrc || [], ex = d.ext || [];
        let hit = false;
        for (let i = 0; i < es.length; i++) { if (es[i] === g && ex[i] === ov) { ex[i] = nv; hit = true; } }
        if (!hit) return;                        // 同名值属于别的组：不动它
        tasks.push(recCol().doc(d._id).update({ data: { ext: ex } }));
      });
      return Promise.all(tasks).then(() => step());
    });
  }
  return step().then(() => true)
    .catch(e => { console.warn('[rename] 历史记录里的旧选项名未同步云端：', e); return false; });
}

// 选项改名：记页已同步改过内存，这里把云端补齐（否则下拉刷新一次，旧名字就回来了）。
// 默认项的删除标记（delDef）仍由选项管理页处理——同样只针对本组
// 顺带记一次「改名映射」：当前会话里还挂着旧值的地方（如记页已选中的 chip）要跟着换新名，
// 否则旧值会以「临时 chip」的身份与改名后的新值一起出现，看起来像同一个选项重复了
// （记页从管理页返回时用 takeRenameMap 取走并同步，见 index 的 applyRenames）
let _renames = {};
function takeRenameMap() { const m = _renames; _renames = {}; return m; }
function renameOption(g, ov, nv) {
  _renames[g] = _renames[g] || {};
  _renames[g][ov] = nv;
  persistLocalOpts();
  return new Promise((resolve) => {
    // ① 云端选项池：本组里等于旧名的项改名
    optCol().where({ group: g, value: ov }).limit(1000).get().then(res => {
      const docs = res.data || [];
      let p = Promise.resolve();
      docs.forEach(d => { p = p.then(() => optCol().doc(d._id).update({ data: { value: nv } })); });
      // ② 历史记录里同一组下的同名值
      return p.then(() => renameInRecords(g, ov, nv));
    }).then(() => resolve(true))
      .catch(e => { log.warn('option.rename', e); resolve(false); });
  });
}

// 一次性迁移：分类「可做」→「可试」（2026-10 模块改名“可做”后避免与分类重名）
// 步骤：① 翻页改所有 m='want' 且 wantKind=可做 的记录；② 选项池（云端+本地）重命名；③ 同步内存 G.records
const MIG_WANTKIND_KEY = 'self_mig_wantkind_202610';
function migrateWantKind() {
  return new Promise((resolve) => {
    if (wx.getStorageSync(MIG_WANTKIND_KEY)) { resolve(true); return; }
    let cursor = 0;
    function step() {
      return recCol().where({ m: 'want' }).limit(100).skip(cursor).get().then(res => {
        const docs = res.data || [];
        const tasks = [];
        docs.forEach(d => {
          const es = d.extSrc || [], ex = d.ext || [];
          const i = es.indexOf('wantKind');
          if (i >= 0 && ex[i] === '可做') {
            ex[i] = '可试';
            tasks.push(recCol().doc(d._id).update({ data: { ext: ex } }));
          }
        });
        return Promise.all(tasks).then(() => {
          cursor += docs.length;
          return docs.length === 100 ? step() : true;
        });
      }).catch(() => true);
    }
    step().then(() => {
      // 选项池重命名（云端）
      return renameOption('wantKind', '可做', '可试').then(() => {
        // 本地 OPT 与内存同步
        const local = loadLocalOpts();
        if (local.wantKind) {
          const li = local.wantKind.indexOf('可做');
          if (li >= 0) { local.wantKind[li] = '可试'; wx.setStorageSync(OPT_LS, local); }
        }
        if (G.OPT && G.OPT.wantKind) {
          const gi = G.OPT.wantKind.indexOf('可做');
          if (gi >= 0) { G.OPT.wantKind[gi] = '可试'; persistLocalOpts(); }
        }
        // 内存已加载记录同步（本会话编辑/回看一致）
        (G.records || []).forEach(r => {
          if (r.m === 'want' && r.extSrc && r.ext) {
            const i = r.extSrc.indexOf('wantKind');
            if (i >= 0 && r.ext[i] === '可做') r.ext[i] = '可试';
          }
        });
        wx.setStorageSync(MIG_WANTKIND_KEY, 1);
        resolve(true);
      });
    });
  });
}

/* 一次性迁移：觉察「喜恶」里几个词改名（2026-10）
   有趣 → 感兴趣 / 没兴趣 → 无感 / 不喜欢 → 讨厌（「厌恶」是中间用过一版的名字，一并归到「讨厌」）。
   改的是「值」，所以三处都要跟：① 历史记录里的该值（renameOption 顺手一起改）；
   ② 选项池（云端 + 本地快照 + 内存）；③ 内存里已加载的记录。与 migrateWantKind 同一套做法，跑完写标记。
   注：标记名带版本 —— 改过目标词就换一个 key，让已经跑过上一版的机器再跑一次。 */
const MIG_OBSKIND_KEY = 'self_mig_obskind_202610c';
const OBSKIND_RENAME = { '有趣': '感兴趣', '没兴趣': '无感', '不喜欢': '讨厌', '厌恶': '讨厌' };
function migrateObsKind() {
  return new Promise((resolve) => {
    if (wx.getStorageSync(MIG_OBSKIND_KEY)) { resolve(true); return; }
    const mapV = (v) => OBSKIND_RENAME[v] || v;
    const uniq = (arr) => arr.map(mapV).filter((v, i, a) => a.indexOf(v) === i);
    // ① 选项池（云端）+ 历史记录：renameOption 两者都管
    let p = Promise.resolve();
    Object.keys(OBSKIND_RENAME).forEach(ov => { p = p.then(() => renameOption('obsKind', ov, OBSKIND_RENAME[ov])); });
    p.then(() => {
      // ② 本地快照 + 内存池（改完可能与新默认词撞上，顺手去重）
      const local = loadLocalOpts();
      if (local.obsKind && local.obsKind.length) { local.obsKind = uniq(local.obsKind); wx.setStorageSync(OPT_LS, local); }
      if (G.OPT && G.OPT.obsKind) { G.OPT.obsKind = uniq(G.OPT.obsKind); persistLocalOpts(); }
      // ③ 内存里已加载的记录（本会话无需刷新即可看到）
      (G.records || []).forEach(r => {
        if (r.m !== 'obs') return;
        const es = r.extSrc || [], ex = r.ext || [];
        for (let i = 0; i < es.length; i++) if (es[i] === 'obsKind' && OBSKIND_RENAME[ex[i]]) ex[i] = OBSKIND_RENAME[ex[i]];
      });
      wx.setStorageSync(MIG_OBSKIND_KEY, 1);
      console.log('[mig] 觉察「喜恶」改名：有趣→感兴趣 / 没兴趣→无感 / 不喜欢、厌恶→讨厌');
      resolve(true);
    }).catch(e => { console.warn('[mig] 觉察喜恶改名失败（下次启动重试）：', e); resolve(false); });
  });
}

/* 一次性迁移：随记「类别」里的 想法 → 念头（2026-10）
   随记类别最初默认叫「想法」，定名后改成「念头」。改的是「值」，所以四处都要跟：
   ① 云端选项池 + 历史记录（renameOption 两者都管）；② 本地快照 + 内存池；
   ③ 「✎ 管理」里动过的组（optCustom 快照——不改的话下次启动旧名会回来）；
   ④ 内存里已加载的记录 + 快捷创建里勾过的随记项（存的是 {m:'jot', cat:'想法'}）。
   与 migrateObsKind 同一套做法，跑完写标记；以后若再改目标词，换个 key 让机器再跑一次。 */
const MIG_JOTKIND_KEY = 'self_mig_jotkind_202610';
const JOTKIND_OV = '想法', JOTKIND_NV = '念头';
function migrateJotKind() {
  return new Promise((resolve) => {
    if (wx.getStorageSync(MIG_JOTKIND_KEY)) { resolve(true); return; }
    const swap = (arr) => {
      const out = (arr || []).map(v => (v === JOTKIND_OV ? JOTKIND_NV : v));
      return out.filter((v, i) => out.indexOf(v) === i);   // 改完可能与新默认词撞上，顺手去重
    };
    // ① 云端选项池 + 历史记录
    renameOption('jotKind', JOTKIND_OV, JOTKIND_NV).then(() => {
      // ② 本地快照 + 内存池
      const local = loadLocalOpts();
      if (local.jotKind && local.jotKind.length) { local.jotKind = swap(local.jotKind); wx.setStorageSync(OPT_LS, local); }
      if (G.OPT && G.OPT.jotKind) { G.OPT.jotKind = swap(G.OPT.jotKind); persistLocalOpts(); }
      // ③ 用户自己编辑过的那份（以它为底，不改就白改了）
      if (_optCustom && _optCustom.jotKind && _optCustom.jotKind.length) {
        const map = Object.assign({}, _optCustom);
        map.jotKind = swap(map.jotKind);
        saveOptCustom(map);
      }
      // ④ 快捷创建里勾过的随记项：不改等于这一项被静默丢掉（对不上任何类别 chip）
      const qc = getQuickCats();
      const qc2 = qc.map(c => (c && c.m === 'jot' && c.cat === JOTKIND_OV) ? { m: 'jot', cat: JOTKIND_NV } : c);
      if (qc2.some((c, i) => c !== qc[i])) setQuickCats(qc2);
      // ⑤ 内存里已加载的记录（本会话不用刷新就能看到新名）
      (G.records || []).forEach(r => {
        if (r.m !== 'jot') return;
        const es = r.extSrc || [], ex = r.ext || [];
        for (let i = 0; i < es.length; i++) if (es[i] === 'jotKind' && ex[i] === JOTKIND_OV) ex[i] = JOTKIND_NV;
      });
      wx.setStorageSync(MIG_JOTKIND_KEY, 1);
      console.log('[mig] 随记「类别」改名：想法 → 念头');
      resolve(true);
    }).catch(e => { console.warn('[mig] 随记类别改名失败（下次启动重试）：', e); resolve(false); });
  });
}

/* 一次性迁移：把历史记录里类别是「备忘」的待办并到「识己」（2026-10）
   **只改记录，两个类别都留着**：「识己」是本地用的主类别，但「备忘」以后还想用，
   所以选项池里的「备忘」不能少（上一版曾误把它一起改掉，这里缺了就补回来）。
   ・记录：走 renameInRecords（不像 renameOption，它不碰选项池），按 extSrc==='todoKind' 精确核对
   ・补回「备忘」：与「✎ 管理」里新增一项同一套写法（顺序 + 云端 + 清删除标记 + 归用户自己管）
   ・内存里已加载的记录同步改一遍，本会话不用刷新就能看到
   ・目标类别「识己」不在池子里时不动记录（免得记录挂在不存在的类别上），只打日志 */
const MIG_TODOREC_KEY = 'self_mig_todorec_202610';
const TODOREC_OV = '备忘', TODOREC_NV = '识己';
function migrateTodoRecords() {
  return new Promise((resolve) => {
    if (wx.getStorageSync(MIG_TODOREC_KEY)) { resolve(true); return; }
    // ① 选项池里补回「备忘」（缺了才补）
    if (G.OPT && G.OPT.todoKind && G.OPT.todoKind.indexOf(TODOREC_OV) < 0) {
      G.OPT.todoKind.unshift(TODOREC_OV);
      setOptOrder('todoKind', G.OPT.todoKind);
      addOption('todoKind', TODOREC_OV);
      if (isDefault('todoKind', TODOREC_OV)) clearDelDef('todoKind', TODOREC_OV);
      markOptCustom('todoKind', G.OPT.todoKind);
      console.log('[mig] 待办类别补回「备忘」（以后还能用它记）');
    }
    // ② 目标类别不在池子里就不动记录：宁可不改，也不要让记录挂到一个不存在的类别上
    if ((getOPT('todoKind') || []).indexOf(TODOREC_NV) < 0) {
      console.warn('[mig] 待办记录未合并：选项池里没有「' + TODOREC_NV + '」，先在「✎ 管理」里加上它');
      resolve(true);
      return;
    }
    // ③ 历史记录：备忘 → 识己（跑不完（量太大）就不写标记，下次启动接着跑）
    renameInRecords('todoKind', TODOREC_OV, TODOREC_NV).then((ok) => {
      (G.records || []).forEach(r => {
        if (!isTask(r.m)) return;
        const src = r.extSrc || [], ex = r.ext || [];
        for (let i = 0; i < src.length; i++) if (src[i] === 'todoKind' && ex[i] === TODOREC_OV) ex[i] = TODOREC_NV;
      });
      if (ok) wx.setStorageSync(MIG_TODOREC_KEY, 1);
      console.log('[mig] 待办记录并到「识己」：备忘 → 识己' + (ok ? '（类别都保留）' : '：未跑完，下次启动继续'));
      resolve(true);
    }).catch(e => { console.warn('[mig] 待办记录合并失败（下次启动重试）：', e); resolve(false); });
  });
}

/* ---------------- 一次性迁移：无感 / 悦己 并入觉察（2026-10） ----------------
   选项池的合并已经固化进 OPT 常量（那两个组本身已删除），这里只做记录迁移：
   ① m 改成 obs，细节来源按映射改写，再按觉察的来源顺序重建 ext/extSrc
      （保证导出/导入的按顺序对齐在迁移后依然成立）；
   ② 记录里出现过、但池子里还没有的手填值补进对应选项组，保证编辑时能看到选中态；
   ③ 「硬着头皮做了之后」(free:after) 在觉察里没有对应项，按约定丢弃。 */
const MIG_NOPELIKE_KEY = 'self_mig_nopelike_202610';
const NOPELIKE_SRC_MAP = {
  nopeKind: 'obsKind',
  nopeDeg: 'obsDeg',
  nopeMood: 'obsMood',
  'free:nopefeel': 'free:obsfeel',
  'free:likeFeel': 'free:obsfeel',
  'free:desc': 'free:desc',
  'free:after': ''            // 丢弃
};

// 把值补进某选项组（内存 + 本地 + 云端）；已存在则跳过
function ensureOpt(g, v) {
  if (!g || !v) return false;
  const O = G.OPT || (G.OPT = {});
  if (!O[g]) O[g] = [];
  if (O[g].indexOf(v) >= 0) return false;
  O[g].push(v);
  addOption(g, v);
  return true;
}

// 老数据里「情绪」可能存成「程度+情绪」的合并值（如「微微抵触」）：迁移时拆回 程度 + 情绪
function splitDegMood(val, degs, moods) {
  const hit = degs.find(d => val.indexOf(d) === 0);
  if (!hit) return null;
  const rest = val.slice(hit.length);
  return (rest && moods.indexOf(rest) >= 0) ? { deg: hit, mood: rest } : null;
}

// 把一条无感 / 悦己记录的细节重排成觉察的字段，返回 { ext, extSrc }
function toObsExt(extSrc, ext) {
  const degs = getOPT('obsDeg'), moods = getOPT('obsMood');
  const bag = {};
  const put = (src, v) => { if (!src || !v) return; (bag[src] = bag[src] || []).push(v); };
  (extSrc || []).forEach((s, i) => {
    const v = (ext || [])[i];
    if (!v) return;
    if (s === 'nopeMood') {                        // 旧的合并值：拆成 程度 + 情绪
      const sp = splitDegMood(v, degs, moods);
      if (sp) { put('obsDeg', sp.deg); put('obsMood', sp.mood); return; }
    }
    const to = (!s || s.indexOf('fallback:') === 0) ? 'free:obsfeel' : NOPELIKE_SRC_MAP[s];
    put(to === undefined ? 'free:desc' : to, v);   // 未登记来源（脏数据）并入描述，不丢内容
  });
  const outSrc = [], outExt = [];
  srcList('obs').forEach(it => {                   // 按觉察的来源顺序重建，保证 export/import 对齐
    const vs = bag[it.src];
    if (vs && vs.length) { outSrc.push(it.src); outExt.push(vs.join('；')); }
  });
  return { ext: outExt, extSrc: outSrc };
}

// 记录里出现过、但还没进池的值补进对应选项组，保证编辑时能看到选中态
function ensureRecOpts(extSrc, ext) {
  (extSrc || []).forEach((s, i) => {
    if (s.indexOf('free:') === 0 || s.indexOf('fx:') === 0) return;
    ensureOpt(s, ext[i]);
  });
}

function migrateNopeLikeIntoObs() {
  return new Promise((resolve) => {
    if (wx.getStorageSync(MIG_NOPELIKE_KEY)) { resolve(true); return; }
    // ① 记录迁移。查询条件里带 m，而迁移会把 m 改掉，所以不能按 skip 翻页
    //    （结果集会随处理而收缩，skip 会漏数据）——每轮取一批未迁移的，处理完再查，直到取空；
    //    小程序端单次取数有 20 条上限，分多轮正好绕开这个限制
    const _ = db().command;
    let rounds = 0;
    function step() {
      if (++rounds > 200) return Promise.resolve(false);   // 兜底：异常时不至于无限循环
      return recCol().where({ m: _.in(['nope', 'like']) }).limit(100).get().then(res => {
        const docs = res.data || [];
        if (!docs.length) return true;
        const tasks = docs.map(d => {
          const r = decorateDoc(d);
          const nf = toObsExt(r.extSrc, r.ext);
          ensureRecOpts(nf.extSrc, nf.ext);
          if (r.txt) ensureOpt('obsWhat', r.txt);
          return recCol().doc(d._id).update({ data: { m: 'obs', ext: nf.ext, extSrc: nf.extSrc } });
        });
        return Promise.all(tasks).then(() => step());
      });
    }
    step().then(ok => {
      if (!ok) { resolve(false); return; }   // 没迁完就不写标记，下次启动接着迁
      // ② 内存里的记录同步改掉：本会话无需刷新即可看到
      (G.records || []).forEach((r, i) => {
        if (r.m !== 'nope' && r.m !== 'like') return;
        const nf = toObsExt(r.extSrc, r.ext);
        G.records[i] = decorate({
          id: r.id, _rid: r._rid, m: 'obs', t: r.t, txt: r.txt, ext: nf.ext, extSrc: nf.extSrc, ts: r.ts,
          done: r.done, doneAt: r.doneAt, status: r.status, ref: r.ref, refTxt: r.refTxt,
          startedAt: r.startedAt, refTs: r.refTs, endTs: r.endTs, abandonedAt: r.abandonedAt
        });
      });
      wx.setStorageSync(MIG_NOPELIKE_KEY, 1);
      console.log('[mig] 无感 / 悦己 已并入觉察');
      resolve(true);
    }).catch(e => { console.warn('[mig] 无感/悦己 迁入觉察失败（下次启动重试）：', e); resolve(false); });
  });
}

/* ---------------- 一次性清理：抹掉无感 / 悦己 遗留的「死组」数据（2026-10） ----------------
   选项池加载时已经不再认这些组（见 DEAD_OPT_GROUPS），这里把云端与本地残留一起清掉：
   ① 云端 options 集合里 group 属于死组的文档；
   ② 本地 + 云端的「默认项删除标记」(delDef) 与「选项顺序」(optOrder) 里这些组的条目；
   ③ 本地选项池快照（persistLocalOpts 按当前内存重建，死组自然消失）。 */
const MIG_DEADOPT_KEY = 'self_mig_deadopt_202610';
function cleanDeadOptGroups() {
  return new Promise((resolve) => {
    if (wx.getStorageSync(MIG_DEADOPT_KEY)) { resolve(true); return; }
    const _ = db().command;
    let rounds = 0;
    // ① 云端死组文档：删掉后就不再命中查询，直接翻页删到空即可，不需要 skip
    function step() {
      if (++rounds > 200) return Promise.resolve(false);   // 兜底：删除异常时不死循环
      return optCol().where({ group: _.in(DEAD_OPT_GROUPS) }).limit(20).get().then(res => {
        const docs = res.data || [];
        if (!docs.length) return true;
        return Promise.all(docs.map(d => optCol().doc(d._id).remove())).then(() => step());
      });
    }
    step().then(ok => {
      if (!ok) { resolve(false); return; }   // 没删完就不写标记，下次启动接着清
      // ② 删除标记 / 选项顺序里的死组条目
      const alive = _delDef.filter(k => DEAD_OPT_GROUPS.indexOf(String(k).split('|')[0]) < 0);
      if (alive.length !== _delDef.length) saveDelDef(alive);
      const order = loadOptOrderLocal();
      let changed = false;
      DEAD_OPT_GROUPS.forEach(g => { if (order[g]) { delete order[g]; changed = true; } });
      if (changed) { persistOptOrderLocal(order); saveOptOrderToCloud(order); }
      // ③ 本地选项池快照
      persistLocalOpts();
      wx.setStorageSync(MIG_DEADOPT_KEY, 1);
      console.log('[mig] 无感 / 悦己 遗留的选项组数据已清理');
      resolve(true);
    }).catch(e => { console.warn('[mig] 死组数据清理失败（下次启动重试）：', e); resolve(false); });
  });
}

/* ---------------- 一次性迁移：备忘 / 购物 合并为「待办」（2026-10） ----------------
   模块层已合并成 todo（见 FIELDS.todo），这里把历史记录搬过来：
   ① m 改成 todo；② 在 ext/extSrc 最前面补上「类别」= 备忘 / 购物；
   ③ 原因字段统一成 free:tasknote（备忘的「原因」与 购物的「干什么用」本就是同一位）。
   与其它迁移一样：改了 m 结果集会收缩，所以每轮取一批未迁移的、取空为止；没迁完不写标记，下次启动接着迁。
   迁移后内存里的记录同步改掉，本会话无需刷新即可看到。 */
const MIG_TODO_KEY = 'self_mig_todo_202610';
function toTodoExt(oldM, extSrc, ext) {
  const cat = oldM === 'buy' ? '购物' : '备忘';
  const outExt = [cat], outSrc = ['todoKind'];
  (extSrc || []).forEach((s, i) => {
    const v = (ext || [])[i];
    if (!v) return;
    outExt.push(v);
    outSrc.push((s === 'free:memonote' || s === 'free:buynote') ? 'free:tasknote' : s);
  });
  return { ext: outExt, extSrc: outSrc };
}
function migrateTasksToTodo() {
  return new Promise((resolve) => {
    if (wx.getStorageSync(MIG_TODO_KEY)) { resolve(true); return; }
    const _ = db().command;
    let rounds = 0;
    function step() {
      if (++rounds > 200) return Promise.resolve(false);   // 兜底：异常时不至于无限循环
      return recCol().where({ m: _.in(['memo', 'buy']) }).limit(20).get().then(res => {
        const docs = res.data || [];
        if (!docs.length) return true;
        const tasks = docs.map(d => {
          const nf = toTodoExt(d.m, d.extSrc, d.ext);
          return recCol().doc(d._id).update({ data: { m: 'todo', ext: nf.ext, extSrc: nf.extSrc } });
        });
        return Promise.all(tasks).then(() => step());
      });
    }
    step().then(ok => {
      if (!ok) { resolve(false); return; }   // 没迁完就不写标记，下次启动接着迁
      (G.records || []).forEach((r, i) => {
        if (r.m !== 'memo' && r.m !== 'buy') return;
        const nf = toTodoExt(r.m, r.extSrc, r.ext);
        G.records[i] = decorate({
          id: r.id, _rid: r._rid, m: 'todo', t: r.t, txt: r.txt, ext: nf.ext, extSrc: nf.extSrc, ts: r.ts,
          done: r.done, doneAt: r.doneAt, status: r.status, ref: r.ref, refTxt: r.refTxt,
          startedAt: r.startedAt, refTs: r.refTs, endTs: r.endTs, abandonedAt: r.abandonedAt
        });
      });
      wx.setStorageSync(MIG_TODO_KEY, 1);
      console.log('[mig] 备忘 / 购物 已合并为待办');
      resolve(true);
    }).catch(e => { console.warn('[mig] 待办合并迁移失败（下次启动重试）：', e); resolve(false); });
  });
}

// 自定义维度
function loadDims() {
  return new Promise((resolve) => {
    cfgCol().where({ type: 'dims' }).get().then(res => {
      const d = (res.data && res.data[0] && res.data[0].data) || [];
      resolve(d);
    }).catch(e => { log.warn('dims.load', e); resolve([]); });
  });
}
function saveDims(arr) {
  return new Promise((resolve) => {
    cfgCol().where({ type: 'dims' }).get().then(res => {
      const docs = res.data || [];
      if (docs.length) return cfgCol().doc(docs[0]._id).update({ data: { data: arr } }).then(resolve).catch(resolve);
      cfgCol().add({ data: { type: 'dims', data: arr } }).then(resolve).catch(resolve);
    }).catch(e => { log.warn('dims.sync', e, 'usercfg 集合已创建？'); resolve(); });
  });
}

// 问候语
function loadGreets() {
  return new Promise((resolve) => {
    cfgCol().where({ type: 'greets' }).get().then(res => {
      const d = (res.data && res.data[0] && res.data[0].data) || null;
      resolve(d);
    }).catch(e => { log.warn('greets.load', e); resolve(null); });
  });
}
function saveGreets(obj) {
  return new Promise((resolve) => {
    cfgCol().where({ type: 'greets' }).get().then(res => {
      const docs = res.data || [];
      if (docs.length) return cfgCol().doc(docs[0]._id).update({ data: { data: obj } }).then(resolve).catch(resolve);
      cfgCol().add({ data: { type: 'greets', data: obj } }).then(resolve).catch(resolve);
    }).catch(e => { log.warn('greets.sync', e, 'usercfg 集合已创建？'); resolve(); });
  });
}

/* ---------------- 自定义维度（注册进全局常量） ---------------- */
function regDim(d) {
  if (!d || !d.k || FIELDS[d.k]) return false;
  const gk = 'm_' + d.k;
  MODULES.push({ k: d.k, n: d.n, c: d.c, custom: true });
  OPT[gk] = (d.opt || []).slice();
  GLABEL[gk] = d.n;
  FIELDS[d.k] = { main: gk, items: [{ g: gk, single: true }, { free: 'note', label: '补充', ph: '随便记点什么，可跳过', ta: true }] };
  return true;
}
function unregDim(k) {
  const i = MODULES.findIndex(m => m.k === k);
  if (i >= 0) MODULES.splice(i, 1);
  delete FIELDS[k];
  delete GLABEL['m_' + k];
  delete OPT['m_' + k];
}

/* ---------------- 全局状态（store 自有，避免依赖 getApp） ---------------- */
const G = {
  theme: 'mint',
  OPT: null,
  dims: [],
  greets: null,
  records: [],
  loaded: false,
  editRec: null
};

/* ---------------- 启动加载 ---------------- */
let _loading = false;
let _loadFail = false;
// 返回 true = 数据就绪，false = 这一轮没拉到（云环境没开 / 网络问题）。
// 以前失败只在 catch 里重置 _loading，页面拿不到任何信号：记页永远停在骨架屏、看页整屏空白；
// 而且「排在后面的那些调用」会一直轮询 G.loaded 也永远等不到（失败不置 loaded）——现在一并给个结果
function ensureAll() {
  if (G.loaded) return Promise.resolve(true);
  if (_loading) {
    return new Promise(res => {
      const t = setInterval(() => {
        if (G.loaded) { clearInterval(t); res(true); }
        else if (_loadFail) { clearInterval(t); res(false); }   // 这一轮已经失败：别让等的人一直挂着
      }, 120);
    });
  }
  _loading = true;
  _loadFail = false;
  return Promise.all([loadRecords(), loadOptions(), loadDims(), loadGreets()]).then(([recs, O, dims, greets]) => {
    G.records = recs;
    G.OPT = O;
    G.dims = dims || [];
    G.greets = greets;
    (dims || []).forEach(d => regDim(d));
    G.loaded = true;
    _loading = false;
    return migrateWantKind()
      .then(() => migrateNopeLikeIntoObs())
      .then(() => cleanDeadOptGroups())
      .then(() => migrateTasksToTodo())
      // 喜恶改名放在「无感 / 悦己 并入觉察」之后：那一步会把旧词带进觉察，这里一并改掉
      .then(() => migrateObsKind())
      .then(() => migrateJotKind())
      .then(() => migrateTodoRecords());
  }).then(() => { _loading = false; _loadFail = false; return true; })
    .catch(() => { _loading = false; _loadFail = true; return false; });
}

// 下拉刷新用：忽略 loaded 缓存，重新从云端全量拉取（同步多端数据）
// opts.onFirstPage：第一页到达时先回调一次（页面可先渲染/先收起下拉），
// 全部页拉完后再 resolve —— 调用方拿到的是最终全量，G.records 不受影响。
function reload(opts) {
  const o = opts || {};
  // 渐进加载期间用户可能又新记了几条；那几条内存里有、这次全量未必包含（写入还在路上），
  // 直接 G.records = recs 会把它们抹掉。记下旧 id，全量回来后把这些「本地新增」补回去。
  const before = o.onFirstPage ? (G.records || []).slice() : null;
  return Promise.all([loadRecords({ onFirstPage: o.onFirstPage }), loadOptions(), loadDims(), loadGreets()]).then(([recs, O, dims, greets]) => {
    (G.dims || []).forEach(d => unregDim(d.k)); // 先注销自定义维度，避免重复注册
    if (before) {
      const got = {}; recs.forEach(r => { got[r._rid] = 1; });
      const localNew = before.filter(r => !got[r._rid]);
      if (localNew.length) recs = recs.concat(localNew).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }
    G.records = recs;
    G.OPT = O;
    G.dims = dims || [];
    G.greets = greets;
    (dims || []).forEach(d => regDim(d));
    G.loaded = true;
  });
}

module.exports = {
  MODULES, OPT, GLABEL, OPTGROUPS, FIXED, FIELDS, DESC_KEY, DESC_SRC, THEMES, GREETS, DCOLORS, COLMAP, FALLBACK, curTheme, themeList, themeStyle, themeOf, syncWindowBg,
  dayLabel, mname, mcolor, isSingle, isNoInput, getOPT, wantKindDefault, todoKindDefault, jotKindDefault, obsStartDefault, agoOf, datePrefix, taskTime, extLabel, srcList, mapExtSrc, buildExt, decorate, isTask, doneLabel, recMname, catColor, jotColor, taskCat, taskColor, jotCat, winDays, QUICKCATS_MAX, getQuickCats, setQuickCats, FAVTHEMES_MAX, getFavThemes, setFavThemes,
  loadRecords, loadRecordsPage, loadAllRecords, countRecords, countByModule, countByStatus, countByTxt, addRecord, updateRecord, deleteRecord, clearAllRecords,
  loadOptions, addOption, removeOption, renameOption, setOptOrder, mainModuleOf, migrateWantKind, migrateNopeLikeIntoObs, cleanDeadOptGroups, migrateTasksToTodo, migrateObsKind, migrateJotKind, migrateTodoRecords, takeRenameMap,
  isDefault, addDelDef, clearDelDef, markOptCustom,
  loadDims, saveDims, loadGreets, saveGreets, ensureAll, reload, regDim, unregDim,
  globalData: G
};
