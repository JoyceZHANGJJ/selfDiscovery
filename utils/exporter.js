// utils/exporter.js —— 记录导出（两种格式）
//
// 为什么分成两种：原先只有一个「导出」，产出的是给**导入**用的管道文本
// （日期 时间 | 维度 | 内容 | 细节）。它的问题有两个：
//   1) 人读不了——没有标题、没有分组、状态全丢（已完成 / 已放弃 / 在做 这些都没了）；
//   2) 表达力不够——待办的完成时间、计划完成、优先级、可做的流程节点都塞不进去。
// 现在给两种，各干各的事：
//
//   mode:'read' —— **给人读 / 喂给 AI**：按日期分小节，每条一行，字段带中文标签，
//        状态、计划完成、优先级、放弃原因、分类、具体描述全部写出来；
//        末尾附一段**汇总**（天数 / 维度分布 / 可做状态 / 逾期待办 / 能量平均），
//        这些正是看页每天在算的数字 —— 不用读者自己从几百行里统计。
//        人能直接读，AI 也能解析成结构。
//   mode:'backup' —— **给导入用**：仍是原来的管道格式（导入端零改动），
//        状态作为尾部标签追加在细节后面（✓已完成 / ✗已放弃 / 进行中 …），
//        导入时能还原回去，老备份文件照旧能导。
//
// 两个格式都吃同一个 filter：{ days:['2026-10-05'], dims:['todo','want'] } ——
// 按天 / 按维度筛选导出走这里，入口层只要把选择结果传进来。
//
// **read 与 backup 是两种用途，字段策略必须不同**：backup 的格式被导入端依赖，
// 改一个字段就可能让老备份导不回来（所以那边一个字都不能动，验证要靠逐字节 diff）；
// read 只是一份给人看的文本，可以随需求增补 —— 这也是为什么 read 里那套
// 「补充展示态字段」的逻辑只加在 read 这一侧。
const store = require('./store.js');

const DAY = 24 * 3600 * 1000;
const CN = 8 * 3600 * 1000;

// 周一到周日。**下标 0 必须是周一**——之前用'日一二三四五六' 再把 getUTCDay()===0
// 映成 7，索引就越界了（7 号位不存在，周日的标题会打成「周undefined」）。
// 这里直接用数组按下标取，越界不可能发生。
const WK = ['一', '二', '三', '四', '五', '六', '日'];
// getUTCDay()：0=周日…6=周六→ 转成 1..7 的周一优先下标
function wkIdx(ts) {
  const w = new Date((ts || 0) + CN).getUTCDay();
  return w === 0 ? 7 : w;
}
function weekOf(ts) { return WK[wkIdx(ts) - 1]; }

function pad(n) { return (n < 10 ? '0' : '') + n; }
function ymd(ts) {
  const d = new Date((ts || 0) + CN);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function hhmm(ts) {
  const d = new Date(ts || 0);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function md(ts) {const s = ymd(ts); return s.slice(5, 7) + '月' + s.slice(8, 10) + '日'; }

// ---------------- 状态（待办的完成态 / 可做的流程节点）----------------
// 可做：未做 / 在做 / 做了 / 不做（与 store.recMname / 列表口径一致）
const WANT_STATE = { doing: '在做', done: '做了', abandon: '不做', '': '未做' };
function wantState(r) {
  if (r.m !== 'want') return '';
  return WANT_STATE[r.status || ''] || '未做';
}
// 待办：完成 / 放弃（与列表的两个分段一致）；abandonWhy 在 decorate 里已把「原因」换成它
function taskState(r) {
  if (!store.isTask(r.m)) return '';
  if (r.status === 'abandon') return '已放弃';
  if (r.done || r.doneAt) return '已完成';
  return '';
}

// 「完成于 / 放弃于 / 什么时候开始的」的时间戳 → 人读的日期
function stateAt(r) {
  if (store.isTask(r.m)) return r.status === 'abandon' ? r.abandonedAt : r.doneAt;
  return r.status === 'doing' ? r.startedAt : r.doneAt;      // 可做的「在做」记在 startedAt
}

// ---------------- 可读导出专用：把「页面上显示、但 buildExt 故意排掉」的字段补回来 ----------------
//
// 为什么单独写一段：buildExt是**给列表用的**，它排除某些字段是刻意的，各有各的道理：
//   ・DESC_SRC（具体的描述）—— 页面上它跟主项同排展示，再进「细节」区就是同一句话出现两次
//   ・jotKind / wantKind / todoKind —— 行首已经显示了（"念头"、"想做"、类别），进细节区重复
//   ・todoPrio —— 列表上只有旗子没有字
// 但导出是**给人读 / 喂给 AI 的另一份文本**，没有「行首 vs 细节区」之分，
// 那些字段恰恰是最该带的（分类是这条记录属于哪一类，描述是这件事到底怎么了）。
// 所以这里按 export 自己的口径重新取一遍，不去改 buildExt ——
// 它服务三处（列表 / 复制 / 详情），为导出改它会连带影响前两处的显示。
//
// 「计算出来的信息」也在这里补：今日的能量档位在存储里只是个 '1'~'5'，
// 页面上显示的是能量条+ 档位名（"还行"），导出只写「1」等于什么都没说。
//
// 凡是这里补写过的来源，都要在 readLine 的 SKIP_IN_DETAIL 里同时跳过 ——
// 否则会出「剩余能量：一般（3/5 格） | 剩余能量：3」这种一行写两遍的情况。
// 从 ext / extSrc 里按来源键取值（比 buildExt 原始但更好定位单项值）
function extOf(r, src) {
  const i = (r.extSrc || []).indexOf(src);
  return i >= 0 ? (r.ext || [])[i] || '' : '';
}

// 展示态补充项：返回 [{ lbl, v }]，没值就不给，绝不产出空标签。
//
// 注意这里**不写分类**（wantKind / todoKind / jotKind / obsKind）：它们已经拼进
// 维度名了（"可做·想做"、"随记·灵感"）。两处都写就是同一个词在一行里出现两次 ——
// 读起来像有两件事，而 AI 解析时也会把它当成两个不同的值。
function displayExtras(r) {
  const out = [];
  const push = (lbl, v) => { if (v !== '' && v != null) out.push({ lbl: lbl, v: String(v) }); };

  // 「今日」的能量与心情：存储里是档位值 1~5，页面显示的是 5 格条 + 档位名，两个都给。
  // 这一项**必须在这里写、同时从细节里跳过**（见 readLine 的 SKIP_IN_DETAIL）：
  // buildExt 会把 todayBat 原样吐出来（值 '3'），不跳过就成了
  // 「剩余能量：一般（3/5 格） | 剩余能量：3」——同一件事写两遍，还写法不同。
  // 心情（todayMood）同理：跳过它之前导出行里是孤零零一个「心情指数：2」，
  // 既不和页面上的 5 格对得上，也和喂给 AI 的那份文本不一致（那边是「有点低（2/5 格）」）。
  // 两个量都走 G / level / 5 格 的同一句式，能量与心情因此在同一行里长得一样好读。
  if (r.m === 'today') {
    [['todayBat', '剩余能量', store.batName, store.batLevel],
     ['todayMood', '心情指数', store.moodName, store.moodLevel]].forEach(cfg => {
      const v = extOf(r, cfg[0]);
      if (v === '') return;
      const nm = cfg[2](v), lv = cfg[3](v);
      push(cfg[1], nm ? nm + '（' + lv + '/5 格）' : (lv + '/5 格'));
    });
  }

  // 「具体的描述」：页面上跟主项并排的那一句，最容易在导出时被漏掉
  const desc = extOf(r, store.DESC_SRC);
  if (desc) push('描述', desc);

  // 「此刻」的喜恶：维度名里故意没带（见 moduleLabel），所以在这里补。
  // 觉察的喜恶已经进了维度名，这里只管此刻。
  if (r.m === 'now') push('喜恶', extOf(r, 'obsKind'));

  // 待办的优先级：默认档在列表里不显示（每行都挂标签等于没筛出信息），
  // 但导出是给人读的，该写就写——「不紧急不重要」也是信息
  if (store.isTask(r.m)) {
    const p = store.taskPrio(r);
    push('优先级', p);
  }
  return out;
}

// ---------------- 筛选 ----------------
// filter: { days:[...], dims:[...] }，都是可选；空 / 缺省 = 全部
function applyFilter(recs, filter) {
  const f = filter || {};
  const days = (f.days || []).filter(Boolean);
  const dims = (f.dims || []).filter(Boolean);
  return recs.filter(r => {
    if (days.length && days.indexOf(ymd(r.ts)) < 0) return false;
    if (dims.length && dims.indexOf(r.m) < 0) return false;
    return true;
  }).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));   // 一律按时间正序
}

// ---------------- 可读导出 ----------------
// 一条记录 = 一行，「时间 维度 内容｜标签：值 …」。
// 分隔符用全角「｜」和「·」，人读清楚；也方便以后按分隔符解析喂给 AI。
//
// 为什么用「标签：值」而不是把所有值堆在一起：值本身不带含义——「3」是能量档位还是
// 睡眠分钟数？「焦虑」是情绪还是分类？标签一给，文本既能直接读，也能被 AI 解析成结构
// （不定分隔符的话，「3、焦虑、方案没定下来」这样一行，模型只能猜哪个是什么）。
function readLine(r) {
  const parts = [];

  // 时间 + 维度。可做 / 觉察的维度名带上分类或喜恶（与列表的 recMname 同口径）：
  // 「未做·想做」比「未做」信息多，而这一行的其余部分不会再写一遍分类。
  parts.push((r.t || hhmm(r.ts)) + ' ' + moduleLabel(r));

  // 主项（记的那句话）。没有主项的记录（今日能量条、睡眠时刻）单独处理，见下
  const main = String(r.txt || '').trim();
  if (main) parts.push(main);

  // 状态：可做的流程节点 / 待办的完成态，后面跟那一刻的日期。
  // 「起」只跟在**进行中**后面——「在做（10月6日起）」说的是「从哪天开始做」，
  // 而「做了（10月6日起）」读起来像那天才起头，做完的日子才是终点，语义反了。
  const ws = wantState(r), ts2 = taskState(r);
  const at = stateAt(r);
  const st = [];
  if (ws) st.push(ws + (at ? '（' + md(at) + (r.status === 'doing' ? '起' : '') + '）' : ''));
  if (ts2) st.push(ts2 + (at ? '（' + md(at) + '）' : ''));
  if (st.length) parts.push(st.join('·'));

  // 展示态补充（能量档位 / 分类 / 描述 / 优先级）—— 见 displayExtras 的说明：
  // 这些字段页面上有、但 buildExt 刻意排掉，得在这里按导出口径补回来。
  // 「描述」和「优先级」在这里写；分类那些已经拼进维度名了（见 moduleLabel），
  // 这里绝不能再写一遍 —— 一行里同一个词出现两次，读起来像有两件事，实际是同一件。
  displayExtras(r).forEach(d => { parts.push(d.lbl + '：' + d.v); });

  // 细节：buildExt 出来的其余项（感受 → 怎么开始的 → 沉浸 → 精力 等，
  // 它已经在内部把 obs 的「程度+情绪」连写成一句了）。一个都没有就整段省掉。
  // 下面几个来源已经在上面写过（或被补成了人话），要跳过，别同一件事写两遍：
  //   todoPrio —— 优先级已单独成栏
  //   todayBat —— 能量档位已补成「一般（3/5 格）」，这里再写个「3」既重复又看不懂
  //   todoKind —— 类别已经进了维度名（「待办·购物」），这里再写「购物」读起来像两件事
  //   wantKind / jotKind —— buildExt 本来就排除了
  //   todayMood —— 心情也已在上面补成「平静（3/5 格）」，这里同理不能再写
  //   bookKind —— 同理：类别已进维度名（「书·剧·小说」），store.buildExt 里已排掉
  //     书·剧的两条评分**不在**跳过名单里：它们就该以「精彩程度：4/5」出现在细节区
  const SKIP_IN_DETAIL = { todoPrio: 1, todayBat: 1, todayMood: 1, todoKind: 1, obsKind: 1, bookKind: 1 };
  const dl = (store.buildExt(r.m, r.ext, r.extSrc) || []).filter(d => {
    if (d.v === '' || d.v == null) return false;
    if (SKIP_IN_DETAIL[d.src]) return false;
    // buildExt 给觉察 / 此刻合成的「喜恶」那一项**不带 src**（见它内部 push），
    // 所以只能按标签认。它已经进了维度名（觉察）或 displayExtras（此刻），
    // 细节区再写一遍就成了同一句话在同一行出现两次。
    if (!d.src && d.lbl === store.COLMAP.obsKind) return false;
    return true;
  });
  if (dl.length) parts.push(dl.map(d => (d.lbl ? d.lbl + '：' : '') + d.v).join('、'));

  // 待办特有：计划完成（优先级在上面已写过）。逾期时把「迟了几天」也写出来——
  // 「已逾期」只说了性质，读者还得自己翻记录才知道迟了多久。
  if (store.isTask(r.m) && r.dueTs) {
    const over = store.dueOver(r.dueTs);
    const late = over ? daysSince(r.dueTs) : 0;
    parts.push('计划完成：' + store.dueLabel(r.dueTs)
      + (over ? (late > 0 ? '（已逾期 ' + late + ' 天）' : '（已逾期）') : ''));
  }

// 主项为空的记录（今日只有能量条没写说明）会拼出「22:00 今日 | 剩余能量：很低（1/5 格）」，
// 读起来像丢了内容 —— 补一句说明它本来是什么
if (!main && r.m === 'today') parts.push('（当天没写说明）');

  // 睡眠记录：txt 存的就是'HH:MM'（见 store 的写入规则——留着是为了导入时主项不为空），
// 直接当主项输出就成了「23:30 睡 | 23:30」，同一件事写两遍。
// 改成把主项换成一句说明：「23:30 睡 | 记的是入睡时刻23:30」。
// 注意用**过滤**而不是切片——切片会漏掉后面追加的状态 / 细节（parts 是逐步 push 的，
// 睡眠那条也有状态与细节，切片极易漏）。
if ((r.m === 'sleep' || r.m === 'wake') && main) {
  const verb = r.m === 'sleep' ? '入睡' : '起床';
  parts[1] = '记的是' + verb + '时刻' + main;
}

return parts.join(' | ');
}

// 维度名：带上分类 / 喜恶，跟列表的 recMname 同口径。
// 不用 store.recMname 是因为它对「随记」等维度有自己的省略规则：
// 随记在App 里本来就独占一栏，列表上只显示类别（「灵感」）不带「随记·」前缀，
// 但导出是独立文本，一行只写「灵感」会让人以为这是另一个维度 —— 所以这里一律带维度名。
function moduleLabel(r) {
  const n = store.mname(r.m);
  if (r.m === 'want') { const k = extOf(r, 'wantKind'); return k ? n + '·' + k : n; }
  if (store.isTask(r.m)) { const k = extOf(r, 'todoKind'); return k ? n + '·' + k : n; }
  if (r.m === 'jot') { const k = extOf(r, 'jotKind'); return k ? n + '·' + k : n; }
  // 书·剧：类别（小说 / 漫剧）拼进维度名，与 store.recMname / 云函数 moduleLabel 同一口径
  if (r.m === 'book') { const k = extOf(r, 'bookKind'); return k ? n + '·' + k : n; }
  if (r.m === 'obs') { const k = extOf(r, 'obsKind'); return k ? n + '·' + k : n; }
  // 「此刻」的喜恶不给维度名 —— 它在 App 里复用觉察那套情绪 chips（见 store 的 FIELDS.now），
  // 但此刻不是「对某件事的感受」，写出来「此刻·喜欢」读着别扭。放到下面的补充项里带。
  return n;
}

// 按日期分小节；每节前加一行「## 2026-10-05 周三」类的标题（## 便于 AI 分段）
//
// 末尾追加一段「## 汇总」：这几天在做的事分布成什么样。
// 为什么加：一份几百上千条的导出，人从头翻到尾才敢下结论；而「哪几天最耗人、
// 哪些想做一直没做」这类判断，本来就是看页每天都在算的那些数字。
// 把它们算好写在末尾，读者不用自己统计——这也是「喂给 AI」时最省事的一步。
function readable(recs, filter) {
  const list = applyFilter(recs, filter);
  const WK = '日一二三四五六';
  const L = [];
  L.push('# ' + (getApp().APP_NAME || '识己手札') + ' · 记录');
  L.push('# 导出时间：' + ymd(Date.now()) + ' · 共 ' + list.length + ' 条');
  L.push('# 格式：每天一节，每条写成「时间 维度 内容 | 状态 | 标签：值」；末尾附一段汇总');
  L.push('');
  if (!list.length) return L.join('\n') + '\n';

  let cur = '';
  list.forEach(r => {
    const d = ymd(r.ts);
    if (d !== cur) {
      cur = d;
      L.push('## ' + d + ' 周' + weekOf(r.ts));
    }
    L.push('- ' + readLine(r));
  });

  const sum = summary(list);
  if (sum.length) {
    L.push('');
    L.push('## 汇总');
    sum.forEach(s => { L.push('- ' + s); });
  }
  return L.join('\n') + '\n';
}

// ---------------- 汇总 ----------------
// 只写「页面上已经显示、且不用翻记录就能得出」的东西。不做趋势分析、不下结论——
// 那是 AI 的活，这里只负责把事实摆齐（并且每条都能在上面的记录里找到出处）。
function summary(list) {
  const out = [];
  const days = {};
  list.forEach(r => {
    const d = ymd(r.ts);
    if (!days[d]) days[d] = 0;
    days[d]++;
  });
  const dayKeys = Object.keys(days).sort();
  out.push('天数：' + dayKeys.length + ' 天（有记录 ' + dayKeys[0] + ' 至 ' + dayKeys[dayKeys.length - 1] + '），日均 '
    + (list.length / dayKeys.length).toFixed(1) + ' 条');

  // 各维度条数（按量排序，一眼看出时间都花在哪）
  const byM = {};
  list.forEach(r => { byM[r.m] = (byM[r.m] || 0) + 1; });
  const dims = Object.keys(byM).sort((a, b) => byM[b] - byM[a]);
  out.push('维度分布：' + dims.map(m => store.mname(m) + ' ' + byM[m] + ' 条').join('，'));

  // 可做的流转状态：这是最值得单独拎出来的一组——「未做」堆积说明想做但一直没做
  const wants = list.filter(r => r.m === 'want');
  if (wants.length) {
    const byS = { '未做': 0, '在做': 0, '做了': 0, '不做': 0 };
    wants.forEach(r => { byS[wantState(r)]++; });
    out.push('可做 ' + wants.length + ' 条：'
      + ['未做', '在做', '做了', '不做'].filter(k => byS[k]).map(k => k + ' ' + byS[k]).join('，'));

    const undone = wants.filter(r => wantState(r) === '未做');
    if (undone.length) {
      // 优先列「躺得最久」的：躺了三个月的比躺三天的更值得你现在决定做不做。
      // 排序后再截前 8 条 —— 只按原顺序取前 8 条的话，列出来的可能全是很久以前随手记的。
      const olds = undone.slice().sort((a, b) => a.ts - b.ts);
      const over7 = olds.filter(r => daysSince(r.ts) >= 7);
      const pick = (over7.length ? over7 : olds).slice(0, 8);
      out.push('一直没做的（' + undone.length + ' 条'
        + (over7.length ? '，其中 ' + over7.length + ' 条躺了超过一周' : '') + '）：'
        + pick.map(r => '「' + String(r.txt || '').slice(0, 20) + '」' + daysAgoTxt(r.ts)).join('、'));
      const shown = pick.length;
      if (undone.length > shown) out.push('（还有 ' + (undone.length - shown) + ' 条同类，没列出来）');
    }
  }

  // 待办：已完成 / 未完成 / 已放弃
  const todos = list.filter(r => store.isTask(r.m));
  if (todos.length) {
    const dn = todos.filter(r => r.done || r.doneAt).length;
    const ab = todos.filter(r => r.status === 'abandon').length;
    const open = todos.length - dn - ab;
    out.push('待办 ' + todos.length + ' 条：已完成 ' + dn + '，进行中/未完成 ' + open + '，已放弃 ' + ab);
    // 逾期的没完成 —— 这一条最容易自己忘，单独拎出来
    const over = todos.filter(r => !r.done && !r.doneAt && r.status !== 'abandon' && r.dueTs && store.dueOver(r.dueTs));
    if (over.length) {
      out.push('计划完成已逾期（' + over.length + ' 条）：'
        + over.slice(0, 8).map(r => '「' + String(r.txt || '').slice(0, 20) + '」（计划 '
          + store.dueLabel(r.dueTs) + '，迟 ' + daysSince(r.dueTs) + ' 天）').join('、'));
      if (over.length > 8) out.push('（还有 ' + (over.length - 8) + ' 条，没列出来）');
    }
  }

  // 今日那两个 5 格量（剩余能量 / 心情指数）：平均值 + 分布。
  // 页面上是两条并排的格子，导出用文字反而更清楚（读者不用去数格子）；
  // 两个量的句式完全一致，横着读一眼就能对上。
  // 分开计数而不统一计：老记录只有能量没有心情，用同一个天数会把「没记心情」
  // 说成「记了 N 天心情」，平均也就跟着虚低了。
  // 情绪的两端都比能量更值得单独拎出来——「平均几格」看不出「其中有几天特别低」，
  // 而回看时最想知道的正是那几天。
  const todays = list.filter(r => r.m === 'today');
  if (todays.length) {
    [['todayBat', '每日剩余能量', store.batLevel],
     ['todayMood', '每日心情指数', store.moodLevel]].forEach(cfg => {
      const rows = todays.filter(r => extOf(r, cfg[0]) !== '');
      if (!rows.length) return;
      const lvs = rows.map(r => cfg[2](extOf(r, cfg[0])));
      const avg = lvs.reduce((a, b) => a + b, 0) / lvs.length;
      const low = lvs.filter(v => v <= 2).length;
      out.push(cfg[1] + '：记录 ' + rows.length + ' 天，平均 ' + (Math.round(avg * 10) / 10) + '/5 格'
        + (low ? '，其中 ' + low + ' 天在 2 格及以下' : ''));
    });
  }
  return out;
}

// 距今多少天（按天算，不看时分——记录是「某天发生的事」，差几个小时不该影响计数）
function daysSince(ts) {
  return Math.floor((dayStart(Date.now()) - dayStart(ts)) / DAY);
}
// 距今多久（按天算，不看时分——记录是「某天发生的事」，差几个小时不该影响计数）。
// 超过半年改说「X 个月前」：一年多的记录写成「380 天前」没人读得出来，
// 而导出是给人读 / 喂给 AI 的，AI 读「9 个月前」比读一个三位数天更容易理解。
function daysAgoTxt(ts) {
  const d = daysSince(ts);
  if (d <= 0) return '';
  if (d < 180) return '（' + d + ' 天前）';
  const mo = Math.round(d / 30);
  if (mo < 12) return '（' + mo + ' 个月前）';
  const y = Math.round(d / 365);
  return '（' + y + ' 年前）';
}
function dayStart(ts) {
  const d = new Date((ts || 0) + CN);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ---------------- 备份导出（导入用）----------------
// 保持原来的管道格式：日期 时间 | 维度 | 内容 | 细节（顿号分隔）
// 状态作为**尾部追加**的一段标签接在细节后面，导入端能还原；老备份文件没有这一段，照样能导。
const ST_TAGS = {
  done: '✓已完成', abandon: '✗已放弃', doing: '进行中'
};
function backupLine(r) {
  const head = ymd(r.ts) + ' ' + (r.t || hhmm(r.ts)) + ' | ' + store.mname(r.m) + ' | ' + String(r.txt || '')
    + ((r.ext && r.ext.length) ? ' | ' + r.ext.join('、') : '');
  const tags = [];
  // 状态标记看status / done（不看时间戳）：startedAt / abandonedAt 可能为 0，
  // 但状态本身是确定的，漏掉就等于信息丢了。
  if (r.status === 'abandon') tags.push(ST_TAGS.abandon);
  else if (r.status === 'doing') tags.push(ST_TAGS.doing);
  else if (r.done || r.doneAt) tags.push(ST_TAGS.done);
  // 那一刻的日期（有才带）
  const at = stateAt(r);
  if (at) tags.push((r.status === 'abandon' ? '放弃于' : (r.status === 'doing' ? '开始于' : '完成于')) + ' ' + ymd(at));
  if (store.isTask(r.m) && r.dueTs) tags.push('计划完成 ' + ymd(r.dueTs));
  if (store.isTask(r.m)) {
    const p = store.taskPrio(r);
    if (p) tags.push('优先级 ' + p);
  }
  // 状态段必须带「状态：」前缀：否则「没有细节」的行里，最后一段到底是细节还是状态分不清
  // （细节用顿号、状态用逗号，可末段仍可能两者皆像）。有这个前缀，导入端按前缀取末段即可。
  return tags.length ? head + ' | 状态：' + tags.join('，') : head;
}
function backup(recs, filter) {
  const list = applyFilter(recs, filter);
  const head = '# ' + (getApp().APP_NAME || '识己手札') + ' · 备份\n'
    + '# 时间：' + ymd(Date.now()) + ' · 共 ' + list.length + ' 条\n'
    + '# 格式：日期 时间 | 维度 | 内容 | 细节 | 状态标签\n';
  return head + list.map(backupLine).join('\n') + '\n';
}

// 统一入口：mode = 'read' | 'backup'
function build(recs, mode, filter) {
  return mode === 'backup' ? backup(recs, filter) : readable(recs, filter);
}

// 恢复：把备份里的状态标签解析回记录字段（导入用；解析不出就留空，不影响原有流程）
const TAG_F = {
  '✓已完成': { done: 1 },
  '✗已放弃': { status: 'abandon' },
  '进行中': { status: 'doing' }
};
function readStateTags(seg) {
  const out = {};
  String(seg || '').split(/[，,]/).forEach(t => {
    t = t.trim();
    if (!t) return;
    const mt = t.match(/^(完成于|放弃于|开始于|计划完成)\s+(\d{4}-\d{2}-\d{2})/);
    if (mt) {
      const ts = new Date(mt[2] + 'T12:00:00').getTime();
      if (mt[1] === '计划完成') out.dueTs = ts;
      else if (mt[1] === '完成于') { out.doneAt = ts; if (!out.done) out.done = 1; }
      else if (mt[1] === '开始于') { out.startedAt = ts; if (!out.status) out.status = 'doing'; }
      else out.abandonedAt = ts;
      return;
    }
    const mp = t.match(/^优先级\s+(.+)$/);
    if (mp) { out.prio = mp[1].trim(); return; }
    if (TAG_F[t]) Object.assign(out, TAG_F[t]);   // 不 return：可能同一格里既有标记又有日期
  });
  return out;
}

module.exports = { build, readable, backup, applyFilter, ymd, hhmm, wantState, taskState, readStateTags };