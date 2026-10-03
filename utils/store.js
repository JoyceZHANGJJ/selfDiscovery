// 自我觉察 · 共享数据层（常量 + 云开发 CRUD + 纯计算）
// 云开发环境 ID：在 app.js 顶部填写 wx.cloud.init 的 env。
// 集合：records（记录）、options（用户新增选项）、usercfg（问候语/自定义维度）

/* ---------------- 常量（与线上版同构） ---------------- */
// 可选维度。无感 / 悦己已并入觉察（见 migrateNopeLikeIntoObs），不再是可选维度，
// 只会在迁移完成前短暂地存在于历史数据里
const MODULES = [
  { k: 'obs', n: '觉察', c: '#7C9A86' },
  { k: 'now', n: '此刻', c: '#5E9A94' },
  { k: 'want', n: '可做', c: '#C0A05A' },
  { k: 'memo', n: '备忘', c: '#9A8C7A' },
  { k: 'buy', n: '购物', c: '#C08552' }
];

const OPT = {
  // 觉察：归类 / 分类 / 程度 / 感受 里带「无感 · 悦己」味道的词，是 2026-10 合并维度时
  // 并进来的（原本属于已删除的无感 / 悦己）。直接写在觉察自己这里，池子就不再依赖
  // 那两个已经消失的组——否则同一批词会被「死组」和「活组」各算一份
  obsWhat: ['写方案', '写周报', '整理资料', '陪家人',
    '应酬', '刷手机', '加班', '回消息',
    '掌控自己的时间', '没有任务压力', '做想做的事', '无人打扰'],
  obsStart: ['工作必须', '自己想做', '别人提议'],
  obsKind: ['喜欢', '有趣', '没兴趣', '不喜欢', '不想'],
  obsDeg: ['微微', '有点', '很', '非常', '极度'],
  obsMood: ['开心', '平静', '满足', '焦虑', '低落', '烦躁', '麻木', '抵触', '心累', '反感'],
  genDoing: ['写代码', '开会', '散步', '带娃', '做饭'],
  genFeel: ['专注', '走神', '平静', '焦虑'],
  genWant: ['喝咖啡', '走一走', '看会儿书'],
  wantItem: ['学吉他', '早睡', '去旅行', '练字'],
  wantKind: ['想做', '可试', '喜欢'],
  memoItem: [], buyItem: [],
  doneFeel: ['踏实', '轻松', '平静'],
  doneGain: ['完成感', '心情变好', '学到了']
};

// 「归类」：觉察 / 无感已把「什么事」解耦成「归类（名词性、可归类）+ 具体的描述（自由、不可归类）」。
// 叫「归类」而不是「什么事 / 触动的点」，是因为池子里装的不一定是事——也可能是一个概念（自由）
// 或一个物件（猫），所以标签只描述它的作用：从池里点选的那个用来归类的词。
// 可做 / 此刻 也已解耦，那边主项仍叫「什么事 / 此刻想记」（只填描述时它本身就是「事」）；悦己等还没迁
const GLABEL = {
  obsWhat: '归类', obsKind: '分类', obsDeg: '程度', obsStart: '怎么开始的', genDoing: '此刻想记', genFeel: '情绪',
  genWant: '此刻想做的事', wantItem: '什么事', wantKind: '分类', nopeThing: '归类', nopeDeg: '程度', nopeMood: '无感的情绪', nopeKind: '分类',
  doneFeel: '做了的感受', doneGain: '收获', obsMood: '感受', memoItem: '要记住什么', buyItem: '要买什么', likeItem: '什么事'
};

// 已废弃的选项组：无感 / 悦己 并入觉察后不再使用。加载时忽略云端的旧文档与本地残留，
// 否则这些「死组」会一直被合并回来、在选项池里重复计数
const DEAD_OPT_GROUPS = ['nopeThing', 'nopeDeg', 'nopeMood', 'nopeKind', 'likeItem'];

const OPTGROUPS = [
  { m: 'obs', gs: ['obsWhat', 'obsKind', 'obsDeg', 'obsStart', 'obsMood'] },
  { m: 'now', gs: ['genDoing', 'genFeel', 'genWant'] },
  { m: 'want', gs: ['wantItem', 'wantKind'] }
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
  // 「分类 → 程度 → 感受（情绪 chips + 紧随的自由输入框）→ 怎么开始的 → 沉浸 → 精力」；
  // 这里的书写顺序是「存储顺序」——新分组追加在末尾，导出/导入的按顺序对齐因此不受影响
  obs: { main: 'obsWhat', items: [
    { g: 'obsStart', single: true, noInput: true },
    { fx: 'forgot' }, { fx: 'nrg' },
    { g: 'obsMood', single: true, noInput: true },
    { free: 'obsfeel', label: '', ph: '有什么想抒发的？', ta: true },
    // 具体的描述：不可归类，编辑时不带标题，就在「归类」下方
    { free: 'desc', label: '', ph: '发生了什么？', ta: true },
    // 分类 / 程度：原本属于「无感」，并入后所有觉察记录都能用。
    // 程度是「感受」的修饰（微微 / 有点 / 很…），sub 表示它在编辑器里作为情绪的副行展示：
    // 不单独起标题、chip 小一号、没选情绪时不出现（见 index 的 buildComposer 与 index.wxml）
    { g: 'obsKind', single: true, noInput: true },
    { g: 'obsDeg', single: true, noInput: true, sub: true }
  ] },
  now: { main: 'genDoing', items: [
    { g: 'genFeel', single: false, noInput: true },
    { free: 'nownote', label: '感受', ph: '这一刻心里的感觉，随便写', ta: true },
    { g: 'genWant', single: true },
    // 「具体的描述」：与「此刻想记」解耦，逻辑与可做那套一致（只填它时它本身就是「事」）。
    // 固定放最后一位，导出/导入的按顺序对齐不受影响
    { free: 'desc', label: '', ph: '也可以直接写「事」；选了上面就是补充', ta: true, asMain: true }
  ] },
  want: { main: 'wantItem', items: [
    { g: 'wantKind', single: true, noInput: true, hideDetail: true, required: true },
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
  /* 备忘 / 购物：只记一句话，没有细节；要复用同一句话，去「选项池」里加 */
  memo: { main: 'memoItem', items: [ { free: 'memonote', label: '原因', ph: '为什么记这条？可不填', ta: true } ] },
  buy:  { main: 'buyItem',  items: [ { free: 'buynote', label: '干什么用', ph: '买来做什么？可不填', ta: true } ] }
};

const THEMES = [
  { k: 'mint', n: '薄荷', bg: '#FFFFFF', ac: '#2F8F7B' },
  { k: 'sand', n: '暖沙', bg: '#FAF8F4', ac: '#7C9A86' },
  // { k: 'bamboo', n: '竹青', bg: '#FFFFFF', ac: '#3E9E7C' },
  { k: 'olive', n: '橄榄', bg: '#F8FAF2', ac: '#6E7B3D' },
  { k: 'teal', n: '湖青', bg: '#FFFFFF', ac: '#2E8B9A' },
  { k: 'graph', n: '石墨', bg: '#FFFFFF', ac: '#4F5459' },
  // { k: 'fog', n: '雾灰', bg: '#F7F8F9', ac: '#6E757B' },
  { k: 'amber', n: '琥珀', bg: '#FFFCF5', ac: '#C98A2B' },
  // { k: 'lilac', n: '浅紫', bg: '#F7F5FC', ac: '#9A8BC0' },
  { k: 'butter', n: '鹅黄', bg: '#FBF8EE', ac: '#C9B25E' },
  // 温柔 / 温暖色系
  { k: 'apricot', n: '暖阳', bg: '#FFF8F2', ac: '#D68A5A' },
  { k: 'peach', n: '蜜桃', bg: '#FFF7F6', ac: '#C9807A' },
  { k: 'latte', n: '奶茶', bg: '#FAF5EF', ac: '#A98163' }
];

// 读取当前主题；若 storage 里是已被删除的废弃主题（如早期的雾蓝/赤陶等），回落默认 mint，
// 避免冷启动套上不存在的 theme 类，导致 CSS 变量全空、输入框/按钮背景透明
function curTheme() {
  const k = wx.getStorageSync('theme') || 'mint';
  return THEMES.some(t => t.k === k) ? k : 'mint';
}

// 问候语：白天 30 条 / 夜里 30 条（设置页可自定义，改完存云端；恢复默认即用这里）
const GREETS = {
  day: [
    '今天天气很好，去晒晒太阳怎么样？', '窗外有风的话，要不要闭上眼感受下？',
    '阳光落在桌上，好像挺暖的', '今天的云走得慢，看一会儿吧',
    '空气里有花香吗？要不要闻一闻？', '阳光照在手背上，暖洋洋的',
    '风把窗帘吹得轻轻动，好温柔', '晨雾散开时，远山像被谁轻轻描了一笔',
    '阳光落在叶尖，把叶子照得透亮', '风掠过整片芦苇，荡起一层温柔的银浪',
    '晾着的衣服被风鼓起来，像在伸懒腰', '远处有鸟叫传过来，你听见了吗？',
    '树影落在桌上，轻轻晃着，像水波', '天很蓝，云一朵一朵地慢慢走',
    '泡一杯茶放在手边，看热气慢慢散开', '光斜斜地照进来，细尘在里面浮着',
    '路边的草刚修剪过，有股青涩的味道', '窗玻璃被晒得温温的，把手心贴上去试试',
    '风替你翻了一页书，要不要读两行', '楼下的声音忽然停了，安静了一小会儿',
    '影子缩到脚边了，是正午了吧', '下雨的话，就听一会儿雨声吧',
    '雨刚停，空气里有泥土的味道', '水冲在手上是凉的，舒服吧',
    '风铃响了一下，是风来了', '阳台上的花又开了一朵',
    '有点困的话，就眯一小会儿', '光从窗帘缝里漏进来，在地板上画了一道',
    '杯壁上凝了一层水珠，凉丝丝的', '今天不冷不热，刚刚好'
  ],
  night: [
    '晚风很温柔，是不是？', '夜色很美，赏赏月如何？', '今天有什么小小的开心事？',
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
    '把手机扣过去，今晚先到这儿吧', '窗户留一条缝，风会自己进来',
    '窗外的树叶不动了，夜也跟着停下来', '天黑透了，屋里反而显得更暖',
    '把被子裹紧一点，脚也跟着暖了', '枕头上有一点洗衣液的味道',
    '明天的事，留给明天再想吧', '放一首慢一点的歌，音量调小一点'
  ]
};

const DCOLORS = ['#7C9A86', '#5E9A94', '#C0A05A', '#948AA8', '#6E8CB0', '#B4544E', '#8A7B5C', '#5C7A8A'];

// 细节回读标签：来源 -> 字段名
const COLMAP = {
  obsKind: '分类', obsDeg: '程度',
  obsStart: '怎么开始', 'fx:forgot': '沉浸', 'fx:nrg': '精力', 'fx:mood': '心情', obsMood: '心情',
  'free:obsfeel': '感受', genFeel: '情绪', genWant: '此刻想做', 'free:nownote': '感受', 'free:memonote': '原因', 'free:buynote': '干什么用',
  'free:desc': '描述',
  'free:trigger': '诱因', 'free:hope': '希望实现成', 'free:doingNote': '进行中感受',
  nopeMood: '情绪', nopeDeg: '程度', 'free:nopefeel': '感受', 'free:after': '之后',
  'free:doneFeel': '做了感受', 'free:doneGain': '做了收获', 'free:abandonWhy': '不做了', 'free:likeFeel': '当时感受'
};
const FALLBACK = { obs: '感受', want: '诱因', nope: '感受', now: '感受', like: '当时感受' };

/* ---------------- 纯计算 ---------------- */
function dayLabel(ago) {
  if (ago <= 0) return '今天';
  if (ago === 1) return '昨天';
  const d = new Date(); d.setDate(d.getDate() - ago);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
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
// 去做模块默认分类：优先锁定值「想做」（不随选项顺序变化），找不到再退第一个，最后兜底「想做」
function wantKindDefault() {
  const k = getOPT('wantKind');
  const def = k.indexOf('想做') >= 0 ? '想做' : (k[0] || '想做');
  return [def];
}

// 时间线（非待办）记录的日期前缀：今天＝空串；昨天 / 前天用相对说法；更早给日期（跨年才带年份）。
// 与 taskTime 共用同一套「跨年才带年份」的判断，避免去年的记录只显示「10月3日」产生歧义
function datePrefix(ts) {
  const ago = agoOf(ts);
  if (ago <= 0) return '';
  if (ago === 1) return '昨天 ';
  if (ago === 2) return '前天 ';
  const d = new Date(ts), now = new Date();
  const md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return (d.getFullYear() === now.getFullYear() ? md : (d.getFullYear() + '年' + md)) + ' ';
}
function agoOf(ts) {
  if (!ts) return 0;
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const n = new Date(); n.setHours(0, 0, 0, 0);
  const a = Math.round((n - d) / 86400000);
  return a < 0 ? 0 : a;
}
function extLabel(src, m) {
  if (src && src.indexOf('fallback:') === 0) return FALLBACK[m] || '';
  return COLMAP[src] || FALLBACK[m] || '';
}
// 生成记录的细节展示列表 [{lbl, v}]
// obs：按「分类 → 程度 → 感受 → 怎么开始 / 沉浸 / 精力」排序，情绪与自由感受合成「感受」一行
// nope：仅作兜底——无感已并入觉察，这里保留是为了万一某次迁移没跑完，老记录仍能正常回读
function buildExt(m, ext, extSrc) {
  const f = FIELDS[m];
  const hideSrc = f ? (f.items.filter(it => it.hideDetail && it.g).map(it => it.g)) : [];
  const list = (ext || []).map((v, i) => {
    const src = (extSrc || [])[i] || '';
    return { src, lbl: extLabel(src, m), v };
  // 「具体的描述」不并进细节区：它要和「归类」同排展示（见页面 recVM 的 desc），
  // 这里排掉，避免同一句话在标题行和细节行各出现一次
  }).filter(d => hideSrc.indexOf(d.src) < 0 && d.src !== DESC_SRC);
  // 觉察：详情按「分类 → 感受 → 怎么开始的 → 沉浸 → 精力」展示，与编辑器里的顺序一致。
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
// 记录的模块显示名：want 按状态显示为 未做/在做（已完成归入 done 模块显示“做了”），再拼接分类
function recMname(r) {
  if (r.m === 'want') {
    const st = r.status || '';
    const stateName = st === 'doing' ? '在做' : (st === 'done' ? '做了' : (st === 'abandon' ? '不做' : '未做'));
    const es = r.extSrc || [], ex = r.ext || [];
    const i = es.indexOf('wantKind');
    const k = i >= 0 ? ex[i] : '';
    return k ? stateName + '·' + k : stateName;
  }
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
  // 备忘「原因」/ 购物「什么用」：从细节里提取对应 free 字段
  o.reason = '';
  o.usefor = '';
  // 「具体的描述」：与「归类」(txt) 配对，取出后供列表同排展示
  o.desc = '';
  const _es = o.extSrc || [], _ex = o.ext || [];
  for (let i = 0; i < _es.length; i++) {
    if (!_ex[i]) continue;
    if (_es[i] === 'free:memonote') o.reason = _ex[i];
    else if (_es[i] === 'free:buynote') o.usefor = _ex[i];
    else if (_es[i] === DESC_SRC) o.desc = _ex[i];
  }
  return o;
}
// 备忘 / 购物 = 待办型记录
function isTask(m) { return m === 'memo' || m === 'buy'; }
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
// extTags: 细节值（如觉察的「分类」= 喜欢 / 有趣 / 没兴趣 / 不喜欢）——ext 是数组，
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
    }).catch(() => resolve({ list: [], hasMore: false, nextCursor: null }));
  });
}
// 全量拉取（导出 / 搜索 / 记页数据源）：按小程序端上限 20 自动翻页直到取完
function loadAllRecords({ m = null, mNot = null, startTs = null } = {}) {
  const PAGE = 20;
  let cursor = null;
  const out = [];
  const seen = {};
  function step() {
    return loadRecordsPage({ before: cursor, limit: PAGE, m, mNot, startTs, excludeIds: Object.keys(seen) }).then(({ list, hasMore, nextCursor }) => {
      list.forEach(r => { if (!seen[r._rid]) { seen[r._rid] = 1; out.push(r); } });
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
    // extTag 是早期的单标签写法，extTags 支持「分类 + 沉浸」这类组合（都要命中）
    const tags = (extTags && extTags.length) ? extTags : (extTag ? [extTag] : []);
    const w = recWhere({ m, startTs, state, extTags: tags });
    recCol().where(w).count()
      .then(r => resolve((r && r.total) || 0)).catch(() => resolve(0));
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
    .catch(() => []);
}
// 兼容旧调用：全量加载（去掉 300 上限，避免早期记录被静默丢弃）
function loadRecords() { return loadAllRecords({}).then(list => list); }
function addRecord(rec) {
  const data = { m: rec.m, t: rec.t, txt: rec.txt, ext: rec.ext || [], extSrc: rec.extSrc || [], ts: rec.ts || Date.now(), done: !!rec.done, doneAt: rec.doneAt || 0, createTime: db().serverDate() };
  if (rec.status) data.status = rec.status;
  if (rec.startedAt) data.startedAt = rec.startedAt;
  if (rec.ref) data.ref = rec.ref;
  if (rec.refTxt) data.refTxt = rec.refTxt;
  if (rec.refTs) data.refTs = rec.refTs;
  if (rec.endTs) data.endTs = rec.endTs;
  if (rec.abandonedAt) data.abandonedAt = rec.abandonedAt;
  return recCol().add({ data }).then(res => res._id);
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
  return recCol().doc(rec._rid).update({ data });
}
function deleteRecord(rec) {
  return recCol().doc(rec._rid).remove();
}
// 清空全部记录（递归分批删除，仅删当前用户自己的）
function clearAllRecords() {
  return recCol().limit(100).get().then(res => {
    const docs = res.data || [];
    if (!docs.length) return 0;
    return Promise.all(docs.map(d => recCol().doc(d._id).remove()))
      .then(() => clearAllRecords()).then(rest => docs.length + rest);
  }).catch(() => 0);
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
    }).catch(() => { _delDef = local; resolve(local); });
  });
}
function saveDelDef(arr) {
  _delDef = arr.slice();
  persistDelDefLocal(arr);
  return cfgCol().where({ type: 'delDef' }).get().then(res => {
    const docs = res.data || [];
    if (docs.length) return cfgCol().doc(docs[0]._id).update({ data: { data: arr } }).then(() => true).catch(() => false);
    return cfgCol().add({ data: { type: 'delDef', data: arr } }).then(() => true).catch(() => false);
  }).catch(e => { console.warn('[云] 删除默认选项未同步云端（usercfg 集合已创建？）：', e); return false; });
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
    }).catch(() => resolve(local));
  });
}
function saveOptOrderToCloud(map) {
  return cfgCol().where({ type: 'optOrder' }).get().then(res => {
    const docs = res.data || [];
    if (docs.length) return cfgCol().doc(docs[0]._id).update({ data: { data: map } }).then(() => true).catch(() => false);
    return cfgCol().add({ data: { type: 'optOrder', data: map } }).then(() => true).catch(() => false);
  }).catch(e => { console.warn('[云] 选项顺序未同步云端（usercfg 集合已创建？）：', e); return false; });
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
      loadOptOrder()
    ]).then(([res, delDef, orderMap]) => {
      const O = JSON.parse(JSON.stringify(OPT));
      const docs = res.data || [];
      docs.forEach(d => {
        const g = d.group, v = d.value;
        if (DEAD_OPT_GROUPS.indexOf(g) >= 0) return;   // 无感 / 悦己 的旧文档：忽略（词已并入觉察）
        if (!O[g]) O[g] = [];
        if (O[g].indexOf(v) < 0) O[g].push(v);
      });
      mergeOpts(O, local);
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
      console.error('[options] 云端读取失败，回退默认+本地：', e);
      const O = JSON.parse(JSON.stringify(OPT)); mergeOpts(O, local); applyDelDef(O, _delDef);
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
    .catch(e => { console.error('[options] 云写入失败（已存本地）：', e); return false; });
}
function removeOption(g, v) {
  persistLocalOpts();
  return new Promise((resolve) => {
    optCol().where({ group: g, value: v }).limit(1000).get().then(res => {
      const docs = res.data || [];
      let p = Promise.resolve();
      docs.forEach(d => { p = p.then(() => optCol().doc(d._id).remove()); });
      p.then(() => resolve(true)).catch(() => resolve(false));
    }).catch(() => resolve(false));
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
function renameOption(g, ov, nv) {
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
      .catch(e => { console.warn('[rename] 选项改名未完全同步云端：', e); resolve(false); });
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

// 自定义维度
function loadDims() {
  return new Promise((resolve) => {
    cfgCol().where({ type: 'dims' }).get().then(res => {
      const d = (res.data && res.data[0] && res.data[0].data) || [];
      resolve(d);
    }).catch(() => resolve([]));
  });
}
function saveDims(arr) {
  return new Promise((resolve) => {
    cfgCol().where({ type: 'dims' }).get().then(res => {
      const docs = res.data || [];
      if (docs.length) return cfgCol().doc(docs[0]._id).update({ data: { data: arr } }).then(resolve).catch(resolve);
      cfgCol().add({ data: { type: 'dims', data: arr } }).then(resolve).catch(resolve);
    }).catch(e => { console.warn('[云] 自定义维度未同步云端（usercfg 集合已创建？）：', e); resolve(); });
  });
}

// 问候语
function loadGreets() {
  return new Promise((resolve) => {
    cfgCol().where({ type: 'greets' }).get().then(res => {
      const d = (res.data && res.data[0] && res.data[0].data) || null;
      resolve(d);
    }).catch(() => resolve(null));
  });
}
function saveGreets(obj) {
  return new Promise((resolve) => {
    cfgCol().where({ type: 'greets' }).get().then(res => {
      const docs = res.data || [];
      if (docs.length) return cfgCol().doc(docs[0]._id).update({ data: { data: obj } }).then(resolve).catch(resolve);
      cfgCol().add({ data: { type: 'greets', data: obj } }).then(resolve).catch(resolve);
    }).catch(e => { console.warn('[云] 问候语未同步云端（usercfg 集合已创建？）：', e); resolve(); });
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
function ensureAll() {
  if (G.loaded) return Promise.resolve();
  if (_loading) return new Promise(res => { const t = setInterval(() => { if (G.loaded) { clearInterval(t); res(); } }, 120); });
  _loading = true;
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
      .then(() => cleanDeadOptGroups());
  }).catch(() => { _loading = false; });
}

// 下拉刷新用：忽略 loaded 缓存，重新从云端全量拉取（同步多端数据）
function reload() {
  return Promise.all([loadRecords(), loadOptions(), loadDims(), loadGreets()]).then(([recs, O, dims, greets]) => {
    (G.dims || []).forEach(d => unregDim(d.k)); // 先注销自定义维度，避免重复注册
    G.records = recs;
    G.OPT = O;
    G.dims = dims || [];
    G.greets = greets;
    (dims || []).forEach(d => regDim(d));
    G.loaded = true;
  });
}

module.exports = {
  MODULES, OPT, GLABEL, OPTGROUPS, FIXED, FIELDS, DESC_KEY, DESC_SRC, THEMES, GREETS, DCOLORS, COLMAP, FALLBACK, curTheme,
  dayLabel, mname, mcolor, isSingle, isNoInput, getOPT, wantKindDefault, agoOf, datePrefix, taskTime, extLabel, srcList, mapExtSrc, buildExt, decorate, isTask, doneLabel, recMname,
  loadRecords, loadRecordsPage, loadAllRecords, countRecords, countByModule, countByStatus, countByTxt, addRecord, updateRecord, deleteRecord, clearAllRecords,
  loadOptions, addOption, removeOption, renameOption, setOptOrder, mainModuleOf, migrateWantKind, migrateNopeLikeIntoObs, cleanDeadOptGroups,
  isDefault, addDelDef, clearDelDef,
  loadDims, saveDims, loadGreets, saveGreets, ensureAll, reload, regDim, unregDim,
  globalData: G
};
