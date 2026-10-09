// cloudfunctions/analysis/recText.js —— 把记录拼成「可读文本」，喂给大模型
//
// 为什么有这个文件（历史上一度是三份内联副本）：
//   原来 buildMessages / buildProfileMessages / buildPersonaMessages 里各写了一遍
//   同样的 map 逻辑。三份副本改一处忘另两处，就会重演 persona.lite 那种
//   「账实不符」——不报错、不白屏，只能靠人眼发现。现在收成这一份。
//
// 为什么不能直接 require 小程序端的 utils/exporter.js：
//   exporter 依赖 utils/store.js，而 store.js 到处用 wx.*（getStorageSync、
//   showToast…），云函数里没有 wx。硬搬过来只会把整个 wx 依赖树拖进来。
//   所以这里是**纯逻辑复刻**，不依赖任何 wx API。
//
// ★ 与 utils/exporter.js 的 COLMAP / BATTERIES / 维度名必须保持一致。
//   两边不一致时，同一条记录在人读的导出里和在 AI 眼里会长得不一样，
//   对账时极难看出是哪边错了。tools/check-syntax.py 的 check_rec_labels()
//   会机械比对这三份常量，不一致直接报错——**改了一边必须改另一边**。
//
// 口径（与 utils/exporter.js 的 readable() 完全一致）：
//   「时间 维度·分类 | 主项 | 状态（日期） | 标签：值 | 细节」+末尾汇总。
//   关键点：
//   ・extSrc 是机器键（free:desc / fx:nrg / todayBat…），**必须映射成中文标签**。
//     不映射的话模型看到的是「free:desc：方案没定下来」，得自己猜那是什么意思。
//   ・状态必须带上。少了它，AI 分析「行动力 / 拖延」时只能从原话里猜那条
//     「可做」后来做了没有——而这恰恰是这类报告最该依据的东西。
//   ・能量档位要给名字。只给 '3' 等于什么都没说（是能量档还是睡眠分钟数？）。

// ---------------- 标签映射（与 utils/store.js 的 COLMAP 同源）----------------
const COLMAP = {
  obsKind: '喜恶', obsDeg: '程度',
  obsStart: '怎么开始', 'fx:forgot': '沉浸', 'fx:nrg': '精力', 'fx:mood': '心情', obsMood: '心情',
  'free:obsfeel': '感受', genFeel: '情绪', genWant: '此刻想做', 'free:nownote': '感受',
  'free:tasknote': '原因', 'free:memonote': '原因', 'free:buynote': '干什么用',
  'free:desc': '描述',
  'free:trigger': '原因', 'free:hope': '希望实现成', 'free:doingNote': '进行中感受',
  nopeMood: '情绪', nopeDeg: '程度', 'free:nopefeel': '感受', 'free:after': '之后',
  'free:doneFeel': '做了感受', 'free:doneGain': '做了收获', 'free:abandonWhy': '不做了',
  'free:likeFeel': '当时感受',
  'free:howto': '怎么做',
  todayBat: '剩余能量', todayMood: '心情指数', todoPrio: '优先级',
  'free:tomorrow': '明天的计划',
  divType: '类型', divSpan: '时间范围',
  'free:divCard': '抽到的牌', 'free:divRead': '解读', 'free:review': '回顾',
  'free:divAcc': '准确率',
  bookKind: '类别', bookStatus: '状态', bookProg: '进度', bookWow: '精彩程度', bookLove: '喜爱程度',
  'free:bookWhy': '记入原因'
};
// 带单位的字段（与 utils/store.js 的 UNIT_SUFFIX 同源，check_rec_labels 守着两边一致）。
// 存储里只存数字，回读时在这里补单位：不补的话 AI 看到「准确率：80」，
// 分不清是 80 分还是 80%
const UNIT_SUFFIX = { 'free:divAcc': '%' };
function withUnit(src, v) {
  const u = UNIT_SUFFIX[src];
  if (!u || v === '' || v == null) return v;
  const s = String(v);
  return s.indexOf(u) >= 0 ? s : s + u;
}
// 维度名（与 utils/store.js 的 MODULES 的 n 同源）。
// 注意「今日」在 store 里叫「今日」，云函数原先的 MODULE_LABELS 写的是
// 「今日能量」——这里跟 store 对齐，让两边看起来是同一份数据。
//
// 'done' 是**历史遗留维度**：老流程里「做了」曾是独立的一个维度（m='done'），
// 新流程已并入「可做·做了」（m='want' + status='done'）。store.mname 里保留了这个
// 兼容分支，老记录才仍能正常读出来 —— 这里也必须跟着有，否则同一条老记录
// 在人读的导出里叫「做了」、在 AI 眼里叫「done」（check_rec_labels() 会守住这条）。
const MODULE_N = {
  today: '今日', obs: '觉察', now: '此刻', want: '可做',
  todo: '待办', jot: '随记', sleep: '睡', wake: '起', done: '做了', div: '占卜', book: '书·剧'
};
const FALLBACK = { obs: '感受', want: '原因', nope: '感受', now: '感受', like: '当时感受' };

// 能量档位（与 utils/store.js 的 BATTERIES 同源）
const BATTERIES = [
  { v: '1', name: '很低' }, { v: '2', name: '低' }, { v: '3', name: '一般' },
  { v: '4', name: '较高' }, { v: '5', name: '满' }
];
const BAT_EMOJI = ['🪫', '¼🔋', '½🔋', '¾🔋', '🔋'];

const DESC_SRC = 'free:desc';
const GLABEL_OBS_MOOD = '感受';   // store 的 GLABEL.obsMood
const DUE_END_H = 23, DUE_END_M = 59;

// ---------------- 时间helper（东八区）----------------
const DAY = 24 * 3600 * 1000;
const CN = 8 * 3600 * 1000;
function pad(n) { return (n < 10 ? '0' : '') + n; }
function ymd(ts) {
  const d = new Date((ts || 0) + CN);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function md(ts) { const s = ymd(ts); return s.slice(5, 7) + '月' + s.slice(8, 10) + '日'; }
function hhmm(ts) {
  const d = new Date(ts || 0);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
// 周一到周日。**下标 0 必须是周一**——用'日一二三四五六' 再把周日映成 7 会越界，
// 索引 7不存在，标题会打成「周undefined」（这个 bug 出过一次）。
const WK = ['一', '二', '三', '四', '五', '六', '日'];
function weekOf(ts) {
  const w = new Date((ts || 0) + CN).getUTCDay();
  return WK[(w === 0 ? 7 : w) - 1];
}
function dayStart(ts) {
  const d = new Date((ts || 0) + CN);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
// 距今多少天（按天算，不看时分——记录是「某天发生的事」）
function daysSince(ts) { return Math.floor((dayStart(Date.now()) - dayStart(ts)) / DAY); }
function daysAgoTxt(ts) {
  const d = daysSince(ts);
  if (d <= 0) return '';
  if (d < 180) return '（' + d + ' 天前）';
  const mo = Math.round(d / 30);
  if (mo < 12) return '（' + mo + ' 个月前）';
  return '（' + Math.round(d / 365) + ' 年前）';
}

// ---------------- 能量档位 ----------------
function batValOf(v) {
  if (v == null) return '';
  if (BATTERIES.some(b => b.v === v)) return v;
  if (v === '0') return '1';
  const i = BAT_EMOJI.indexOf(v);
  if (i >= 0) return String(i + 1);
  return '';
}
function batName(v) { const b = BATTERIES.find(x => x.v === batValOf(v)); return b ? b.name : ''; }
function batLevel(v) {
  const n = parseInt(batValOf(v), 10);
  return isNaN(n) ? 1 : Math.max(1, Math.min(5, n));
}
/* 「今日」心情指数：与剩余能量同一套值域（'1'..'5'）、另一套档位名。
   与 store.js 的 MOODS / moodName / moodLevel 必须逐项一致——
   AI 看到的就是这两行，名字对不上会让「平静」和「一般」混成一个意思。 */
const MOODS = [
  { v: '1', name: '很低落' },
  { v: '2', name: '有点低' },
  { v: '3', name: '平静' },
  { v: '4', name: '不错' },
  { v: '5', name: '很好' }
];
function moodName(v) { const m = MOODS.find(x => x.v === batValOf(v)); return m ? m.name : ''; }
function moodLevel(v) {
  const n = parseInt(batValOf(v), 10);
  return isNaN(n) ? 1 : Math.max(1, Math.min(5, n));
}

// ---------------- 状态（与 store.recMname / exporter 同口径）----------------
// 可做：未做 / 在做 / 做了 / 不做
const WANT_STATE = { doing: '在做', done: '做了', abandon: '不做', '': '未做' };
function wantState(r) {
  if (r.m !== 'want') return '';
  return WANT_STATE[r.status || ''] || '未做';
}
function isTask(m) { return m === 'todo' || m === 'memo' || m === 'buy'; }
// 待办：完成 / 放弃
function taskState(r) {
  if (!isTask(r.m)) return '';
  if (r.status === 'abandon') return '已放弃';
  if (r.done || r.doneAt) return '已完成';
  return '';
}
function stateAt(r) {
  if (isTask(r.m)) return r.status === 'abandon' ? r.abandonedAt : r.doneAt;
  return r.status === 'doing' ? r.startedAt : r.doneAt;
}
function taskPrio(r) {
  if (!r) return '';
  const i = (r.extSrc || []).indexOf('todoPrio');
  return i >= 0 ? (r.ext[i] || '') : '';
}
function dueOver(ts) { return !!ts && ts < Date.now(); }
function dueLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts), n = new Date();
  const dd = Math.round((dayStart(ts) - dayStart(n.getTime())) / DAY);
  let day;
  if (dd === 0) day = '今天';
  else if (dd === 1) day = '明天';
  else if (dd === 2) day = '后天';
  else if (dd === -1) day = '昨天';
  else {
    const m2 = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    day = d.getFullYear() === n.getFullYear() ? m2 : (d.getFullYear() + '年' + m2);
  }
  // 只有自定义的具体时刻才带时分；档位的 23:59 说了反而吵
  if (d.getHours() !== DUE_END_H || d.getMinutes() !== DUE_END_M) day += ' ' + hhmm(ts);
  return day;
}

// ---------------- ext 取值 ----------------
function extOf(r, src) {
  const i = (r.extSrc || []).indexOf(src);
  return i >= 0 ? (r.ext[i] || '') : '';
}
function extLabel(src, m) {
  if (src && src.indexOf('fallback:') === 0) return FALLBACK[m] || '';
  return COLMAP[src] || FALLBACK[m] || '';
}

// buildExt 的纯逻辑复刻（utils/store.js:790）。
// 只需要 FIELDS 里的 hideDetail，而全项目目前**只有 wantKind 标了 hideDetail**，
// 所以这里直接写死；将来 store.js 里新增 hideDetail 字段时，
// check_rec_labels() 会因为这里对不上而报错（见下）。
const HIDE_DETAIL = { wantKind: 1 };
// 5 格量（与 utils/store.js 的 SCALES 同源）：值域都是 '1'..'5'，回读一律写成「x/5」——
// 光给一个 3 读不出是 3 格还是 3 分，写成 3/5 才自明。没值时返回空串（那一栏就不出现，
// 而不是显示成「0/5」，那看着像打了 0 分）。
// **今天的两条（todayBat / todayMood）不在这里**：它们走 displayExtras 的
// 「档位名（N/5 格）」写法（AI 分析能量/心情需要看得懂档位名，只给 3/5 没有信息量），
// 所以那一侧刻意留在 SCALE_RICH 里不补 x/5（见 store 的 fmtVal），两边口径必须一致。
// 书·剧的两条（bookWow / bookLove）只有 x/5 这一种写法：它们不参与任何状态分析，
// 数值本身就是全部信息（多精彩 / 多喜欢），补个档位名反而啰嗦。
const SCALES = { bookWow: 1, bookLove: 1 };
function scaleScore(src, v) {
  if (!SCALES[src] || v == null || v === '') return '';
  const s = String(v);
  if (s.indexOf('/') >= 0) return s;          // 已经是「3/5」这种写法，不重复加工
  const n = parseInt(s, 10);
  return isNaN(n) ? '' : (Math.max(1, Math.min(5, n)) + '/5');
}
// 回读格式化：先看是不是 5 格量，是就补 x/5；否则按单位补（withUnit）
function fmtVal(src, v) {
  const s = scaleScore(src, v);
  return s || withUnit(src, v);
}
function buildExt(m, ext, extSrc) {
  const list = (ext || []).map((v, i) => {
    const src = (extSrc || [])[i] || '';
    return { src: src, lbl: extLabel(src, m), v: fmtVal(src, v) };
  }).filter(d => !HIDE_DETAIL[d.src] && d.src !== DESC_SRC && d.src !== 'jotKind' && d.src !== 'bookKind');

  if (m === 'obs' || m === 'now') {
    // 感受是一组：程度 + 情绪连写成「有点焦虑」，再与自由感受用 · 连起来。
    // 与编辑器里「档位 + 情绪 chips + 自由输入框」合成一块的口径一致。
    const picks = (src) => list.filter(d => d.src === src).map(d => d.v).filter(Boolean);
    const out = [];
    const kind = picks('obsKind')[0] || '';
    if (kind) out.push({ lbl: COLMAP.obsKind, v: kind });
    const feel = [
      (picks('obsDeg')[0] || '') + picks('obsMood').join(''),
      picks('genFeel').join('、'),
      picks('free:obsfeel').join(' '),
      picks('free:nownote').join(' ')
    ].filter(Boolean).join(' · ');
    if (feel) out.push({ lbl: GLABEL_OBS_MOOD, v: feel });
    const used = ['obsKind', 'obsDeg', 'obsMood', 'genFeel', 'free:obsfeel', 'free:nownote'];
    list.forEach(d => { if (used.indexOf(d.src) < 0) out.push(d); });
    return out;
  }
  if (m === 'nope') {
    // 仅作兜底——无感已并入觉察，这里保留是为了万一某次迁移没跑完，老记录仍能正常读
    const deg = list.find(d => d.src === 'nopeDeg');
    const degV = deg ? deg.v : '';
    return list
      .filter(d => d.src !== 'nopeDeg')
      .map(d => (d.src === 'nopeMood' ? { lbl: '情绪', v: (degV || '') + d.v } : d));
  }
  return list;
}

// ---------------- 一行 ----------------
function moduleLabel(r) {
  const n = MODULE_N[r.m] || r.m || '记录';
  if (r.m === 'want') { const k = extOf(r, 'wantKind'); return k ? n + '·' + k : n; }
  if (isTask(r.m)) { const k = extOf(r, 'todoKind'); return k ? n + '·' + k : n; }
  if (r.m === 'jot') { const k = extOf(r, 'jotKind'); return k ? n + '·' + k : n; }
  // 书·剧：类别（小说 / 漫剧）拼进维度名，与 store.recMname 同一口径
  if (r.m === 'book') { const k = extOf(r, 'bookKind'); return k ? n + '·' + k : n; }
  if (r.m === 'obs') { const k = extOf(r, 'obsKind'); return k ? n + '·' + k : n; }
  // 「此刻」的喜恶不给维度名：此刻不是「对某件事的感受」，写「此刻·喜欢」读着别扭。
  // 它在下面 displayExtras 里补。
  return n;
}
// 「页面上显示、但 buildExt 刻意排掉」的字段，按本文件的口径补回来。
// 分类那几个已经拼进维度名了，这里绝不能再写一遍——同一个词一行里出现两次，
// 读起来像有两件事，AI 解析时也会当成两个不同的值。
function displayExtras(r) {
  const out = [];
  const push = (lbl, v) => { if (v !== '' && v != null) out.push({ lbl: lbl, v: String(v) }); };
  // 能量：存储里是 '1'~'5'，这里补成「一般（3/5 格）」。
  // 必须在下面 SKIP_IN_DETAIL 里同时跳过 todayBat，否则会出
  // 「剩余能量：一般（3/5 格） | 剩余能量：3」——同一件事写两遍还写法不同。
  if (r.m === 'today') {
    const bv = extOf(r, 'todayBat');
    if (bv !== '') {
      const nm = batName(bv), lv = batLevel(bv);
      push('剩余能量', nm ? nm + '（' + lv + '/5 格）' : (lv + '/5 格'));
    }
    // 心情指数：与能量同一口径补成「平静（3/5 格）」。
    // 同样必须在 SKIP_IN_DETAIL 里跳过 todayMood，否则会出现
    // 「心情指数：平静（3/5 格） | 心情指数：3」这种自相矛盾的两行。
    // 没记过心情的老记录（空值）不写——写了反而像「心情是空的」。
    const mv = extOf(r, 'todayMood');
    if (mv !== '') {
      const nm = moodName(mv), lv = moodLevel(mv);
      push('心情指数', nm ? nm + '（' + lv + '/5 格）' : (lv + '/5 格'));
    }
  }
  const desc = extOf(r, DESC_SRC);
  if (desc) push('描述', desc);
  if (r.m === 'now') push('喜恶', extOf(r, 'obsKind'));
  if (isTask(r.m)) push('优先级', taskPrio(r));
  return out;
}

function readLine(r) {
  const parts = [];
  parts.push((r.t || hhmm(r.ts)) + ' ' + moduleLabel(r));

  const main = String(r.txt || '').trim();
  if (main) parts.push(main);

  const ws = wantState(r), tstate = taskState(r);
  const at = stateAt(r);
  const st = [];
  if (ws) st.push(ws + (at ? '（' + md(at) + (r.status === 'doing' ? '起' : '') + '）' : ''));
  if (tstate) st.push(tstate + (at ? '（' + md(at) + '）' : ''));
  if (st.length) parts.push(st.join('·'));

  displayExtras(r).forEach(d => { parts.push(d.lbl + '：' + d.v); });

  // 上面已经写过（或已补成人话）的来源要跳过，别同一件事写两遍：
  //   todoPrio —— 优先级已单独成栏
  //   todayBat —— 能量档位已补成「一般（3/5 格）」，这里再写个「3」既重复又看不懂
  //   todoKind —— 类别已进维度名（「待办·购物」），再写一遍读起来像两件事
  //   wantKind / jotKind —— buildExt 本来就排除了
  //   bookKind —— 同理：类别已进维度名（「书·剧·小说」），buildExt 里已排掉
  const SKIP_IN_DETAIL = { todoPrio: 1, todayBat: 1, todayMood: 1, todoKind: 1, obsKind: 1, bookKind: 1 };
  const dl = buildExt(r.m, r.ext, r.extSrc).filter(d => {
    if (d.v === '' || d.v == null) return false;
    if (SKIP_IN_DETAIL[d.src]) return false;
    // buildExt 给觉察 / 此刻合成的「喜恶」那一项**不带 src**（见它内部 push），
    // 只能按标签认。它已经进了维度名（觉察）或 displayExtras（此刻）。
    if (!d.src && d.lbl === COLMAP.obsKind) return false;
    return true;
  });
  if (dl.length) parts.push(dl.map(d => (d.lbl ? d.lbl + '：' : '') + d.v).join('、'));

  if (isTask(r.m) && r.dueTs) {
    const over = dueOver(r.dueTs);
    const late = over ? daysSince(r.dueTs) : 0;
    parts.push('计划完成：' + dueLabel(r.dueTs)
      + (over ? (late > 0 ? '（已逾期 ' + late + ' 天）' : '（已逾期）') : ''));
  }

  // 主项为空（今日只点了能量条没写说明）时补一句，否则读起来像丢了内容
  if (!main && r.m === 'today') parts.push('（当天没写说明）');

  // 睡眠记录：txt 存的就是 'HH:MM'（留着是为了导入时主项非空），
  // 直接当主项输出就成了「23:30 睡 | 23:30」，同一件事写两遍。
  // 改写parts[1]，**不用切片**——parts 是逐步 push 的，切片会漏掉后面追加的状态与细节。
  if ((r.m === 'sleep' || r.m === 'wake') && main) {
    parts[1] = '记的是' + (r.m === 'sleep' ? '入睡' : '起床') + '时刻' + main;
  }
  return parts.join(' | ');
}

// ---------------- 汇总 ----------------
// 只摆事实、不下结论（那是模型的活），并且每条都能在上面的记录里找到出处。
function summary(list) {
  const out = [];
  const days = {};
  list.forEach(r => {
    const d = ymd(r.ts);
    days[d] = (days[d] || 0) + 1;
  });
  const dayKeys = Object.keys(days).sort();
  if (!dayKeys.length) return out;
  out.push('天数：' + dayKeys.length + ' 天（有记录 ' + dayKeys[0] + ' 至 '
    + dayKeys[dayKeys.length - 1] + '），日均 ' + (list.length / dayKeys.length).toFixed(1) + ' 条');

  const byM = {};
  list.forEach(r => { byM[r.m] = (byM[r.m] || 0) + 1; });
  const dims = Object.keys(byM).sort((a, b) => byM[b] - byM[a]);
  out.push('维度分布：' + dims.map(m => (MODULE_N[m] || m) + ' ' + byM[m] + ' 条').join('，'));

  // 可做的流转状态：「未做」堆积说明想做但一直没做——这是最值得单独拎出来的一组
  const wants = list.filter(r => r.m === 'want');
  if (wants.length) {
    const byS = { '未做': 0, '在做': 0, '做了': 0, '不做': 0 };
    wants.forEach(r => { byS[wantState(r)]++; });
    out.push('可做 ' + wants.length + ' 条：'
      + ['未做', '在做', '做了', '不做'].filter(k => byS[k]).map(k => k + ' ' + byS[k]).join('，'));
    const undone = wants.filter(r => wantState(r) === '未做');
    if (undone.length) {
      // 优先列躺得最久的：躺了三个月的比躺三天的更值得现在决定做不做。
      // 排序后再截前 8——只按原顺序取前 8，列出来的可能全是很久以前随手记的。
      const olds = undone.slice().sort((a, b) => a.ts - b.ts);
      const over7 = olds.filter(r => daysSince(r.ts) >= 7);
      const pick = (over7.length ? over7 : olds).slice(0, 8);
      out.push('一直没做的（' + undone.length + ' 条'
        + (over7.length ? '，其中 ' + over7.length + ' 条躺了超过一周' : '') + '）：'
        + pick.map(r => '「' + String(r.txt || '').slice(0, 20) + '」' + daysAgoTxt(r.ts)).join('、'));
      if (undone.length > pick.length) {
        out.push('（还有 ' + (undone.length - pick.length) + ' 条同类，没列出来）');
      }
    }
  }

  const todos = list.filter(r => isTask(r.m));
  if (todos.length) {
    const dn = todos.filter(r => r.done || r.doneAt).length;
    const ab = todos.filter(r => r.status === 'abandon').length;
    out.push('待办 ' + todos.length + ' 条：已完成 ' + dn + '，进行中/未完成 '
      + (todos.length - dn - ab) + '，已放弃 ' + ab);
    const over = todos.filter(r => !r.done && !r.doneAt && r.status !== 'abandon'
      && r.dueTs && dueOver(r.dueTs));
    if (over.length) {
      out.push('计划完成已逾期（' + over.length + ' 条）：'
        + over.slice(0, 8).map(r => '「' + String(r.txt || '').slice(0, 20) + '」（计划 '
          + dueLabel(r.dueTs) + '，迟 ' + daysSince(r.dueTs) + ' 天）').join('、'));
      if (over.length > 8) out.push('（还有 ' + (over.length - 8) + ' 条，没列出来）');
    }
  }

  // 今日那两个 5 格量（剩余能量 / 心情指数）：平均值 + 分布。与 exporter.js 的汇总段同源，
  // 改一边必须改另一边（见 tools/check-syntax.py 的 check_exporter_rectext_alignment）。
  // 分开计数：老记录只有能量没有心情，用同一个天数会把「没记心情」说成「记了 N 天心情」。
  const todays = list.filter(r => r.m === 'today');
  if (todays.length) {
    [['todayBat', '每日剩余能量', batLevel],
     ['todayMood', '每日心情指数', moodLevel]].forEach(cfg => {
      const rows = todays.filter(r => extOf(r, cfg[0]) !== '');
      if (!rows.length) return;
      const lvs = rows.map(r => cfg[2](extOf(r, cfg[0])));
      const avg = lvs.reduce((a, b) => a + b, 0) / lvs.length;
      const low = lvs.filter(v => v <= 2).length;
      out.push(cfg[1] + '：记录 ' + rows.length + ' 天，平均 ' + (Math.round(avg * 10) / 10)
        + '/5 格' + (low ? '，其中 ' + low + ' 天在 2 格及以下' : ''));
    });
  }
  return out;
}

// ---------------- 入口 ----------------
// opt.cap     —— 最多取多少条记录（按时间正序，超出的丢在末尾并在提示里说明）
// opt.noSum   —— true 时不追加汇总（记录很少时汇总反而是噪声）
// 返回可直接塞进 user 消息的文本。
function recText(rows, opt) {
  const o = opt || {};
  const all = (rows || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const cap = o.cap || all.length;
  const list = all.slice(0, cap);

  const L = [];
  L.push('以下是用户的自我记录，按时间先后。每天一节，每条写成'
    + '「时间 维度·分类 | 内容 | 状态（日期） | 标签：值」——竖线只是分隔符，各段含义固定。');
  if (all.length > list.length) {
    L.push('（共 ' + all.length + ' 条记录，以下是最早的 ' + list.length + ' 条。）');
  }
  L.push('');

  if (!list.length) return L.join('\n');

  let cur = '';
  list.forEach(r => {
    const d = ymd(r.ts);
    if (d !== cur) {
      cur = d;
      L.push('## ' + d + ' 周' + weekOf(r.ts));
    }
    L.push('- ' + readLine(r));
  });

  if (!o.noSum) {
    const sum = summary(list);
    if (sum.length) {
      L.push('');
      L.push('## 汇总');
      sum.forEach(s => { L.push('- ' + s); });
    }
  }
  return L.join('\n') + '\n';
}

module.exports = {
  recText, readLine, summary, buildExt, moduleLabel, displayExtras,
  wantState, taskState, stateAt, isTask, taskPrio, dueLabel, dueOver,
  batName, batLevel, batValOf, ymd, md, hhmm, weekOf, daysSince,
  COLMAP, MODULE_N, BATTERIES, MOODS, SCALES, HIDE_DETAIL, DESC_SRC
};
