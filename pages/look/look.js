// pages/look/look.js —— 看
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');
const ui = require('../../utils/ui.js');
const swipe = require('../../utils/swipe.js');
const date = require('../../utils/date.js');
const vm = require('../../utils/vm.js');
const app = getApp();

Page(pageBase({
  data: {
    modules: [],
    filter: 'all',
    filterName: '全部',
    stateFilter: 'all',
    q: '',
    // 觉察专用：喜恶筛选（喜欢 / 感兴趣 / 无感 / 讨厌，取选项池），与「可做」的流转状态筛选同一个位置
    kindFilter: 'all',
    kinds: [],
    recs: [],          // 已加载（装饰后）的记录，按 ts 倒序
    days: [],
    stats: {},
    sel: null,
    selRec: null,
    delUndo: null,
    tasks: { show: false, tit: '', sum: '', undone: [], doneGroups: [], doneN: 0, abandGroups: [], abandN: 0 },
    // 待办视图的「显示更多」窗口：待完成 20 条、已完成 / 已放弃 各 7 天（与清单页同一套）
    limU: 20, limD: 7, limA: 7,
    doneDayAll: {}, abandDayAll: {},
    empty: false,

    // 游标分页 + 快捷时间
    range: 'all',
    rangeLabel: '全部',
    rangeStart: null,
    hasMore: true,
    loading: false,
    ready: false,     // 首屏数据未就绪时先渲染骨架屏（与记页同一套 .sk 样式）
    loadFail: false,  // 取数失败：撤掉骨架屏，给一句说明 + 可点的重试（以前是整屏空白）
    stat: {}          // 后端统计结果：{ byMod } / { bySt } / { total, tops, ext } / { total, byCat }（随记）
  },

  onLoad() {
    this._cursor = null;
    this._loading = false;
    this._gen = 0;              // 取数代次：切维度 / 换筛选 / 搜索都会 +1，用来丢掉过期响应（见 resetLoad）
    this._searchTimer = null;
    this._everLoaded = false;   // 骨架屏只在「还没成功加载过一次」时出场（见 resetLoad）
  },

  onShow() {
    this.ensureTheme();
    this.layoutBrand();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 1, theme: store.curTheme() });
    this.setData({ sel: null, selRec: null, delUndo: null });
    // 兜底：若此前停留在已下架的「做了」维度，回到「全部」
    if (this.data.filter === 'done') this.setData({ filter: 'all', stateFilter: 'all' });
    store.ensureAll().then(ok => {
      // 基础数据（记录 / 选项池）没拉到：不用再等分页了，直接给失败态
      if (!ok) { this.setData({ loadFail: true, ready: true, loading: false }); return; }
      // 首屏交给骨架屏挡着：ready 由 resetLoad → loadMore 的首屏回调置 true
      // （之前在这里就置 true，骨架屏在真正取到第一页数据前就撤了，等于看不见）
      this.resetLoad();
    });
  },

  /* 取数失败后点「重试」：再走一遍加载（store 失败时会把状态放回去，可以再来一次） */
  onRetry() {
    if (this._retrying) return;
    this._retrying = true;
    this.setData({ loadFail: false, ready: false });
    store.ensureAll().then(ok => {
      this._retrying = false;
      if (!ok) { this.setData({ loadFail: true, ready: true }); return; }
      this.onShow();   // 成功了按正常进页再走一遍
    });
  },

  /* 主题 / 程序名（ensureTheme / layoutBrand / playBrand）已收敛到 utils/pageBase.js */

  modulesVM() {
    // 维度筛选里不列「做了」——它与「可做 → 做了」状态筛选重复，列出来入口歧义。
    // 「今日」要列：一日一记，筛它就能只翻自己那些天（统计只报总数、时间线与「全部」同样式）。
    // 「睡」不列（isQuiet）：它不进记录流，只在「睡」tab 里看（见 store.MODULES 的注释）
    return store.MODULES.filter(m => m.k !== 'done' && !m.quiet);
  },

  recVM(r) {
    const dt = store.buildExt(r.m, r.ext, r.extSrc);
    const doingDays = (r.m === 'want' && r.status === 'doing' && r.startedAt) ? Math.max(1, Math.floor((Date.now() - r.startedAt) / 86400000)) : 0;
    // 做了 的历时：可做→做了（status=done）或历史遗留 m='done' 记录
    let fromLine = '', durLine = '';
    const isDoneView = (r.m === 'done') || (r.m === 'want' && r.status === 'done');
    if (isDoneView) {
      const refTxt = r.refTxt || '';
      const endTs = r.doneAt || r.ts;                        // 完成时间：want-done 用 doneAt；遗留 done 用 ts
      const baseTs = r.m === 'done' ? (r.refTs || r.ts) : r.ts;  // 惦记起点：want 用创建 ts；遗留 done 用 refTs
      let durLabel = '', dur = 0;
      if (r.startedAt && endTs && r.startedAt <= endTs) {
        // 有开始时间：实际用了多久（完成 − 开始）
        dur = endTs - r.startedAt; durLabel = '用了';
      } else if (baseTs && endTs && baseTs <= endTs) {
        // 没开始时间（一次性直接完成）：从创建/惦记起惦记了多久（完成 − 起点）
        dur = endTs - baseTs; durLabel = '惦记了';
      }
      if (refTxt && refTxt !== r.txt) fromLine = '↳ 来自：' + refTxt;
      const ds = date.fmtDur(dur);
      // 「片刻」本身成词，与标签连写（用了片刻）；数值时长保留空格（用了 1 天）
      if (ds) durLine = ds === '片刻' ? durLabel + ds : durLabel + ' ' + ds;
    }
    // 觉察：有结束时间则显示「历时」（从创建到结束）
    if (r.m === 'obs' && r.endTs && r.ts && r.endTs > r.ts) {
      const ds = date.fmtDur(r.endTs - r.ts);
      if (ds) durLine = ds === '片刻' ? '历时片刻' : '历时 ' + ds;
    }
    // 不做 的历时：从创建到放弃（惦记了多久）
    if (r.m === 'want' && r.status === 'abandon' && r.abandonedAt && r.ts && r.abandonedAt >= r.ts) {
      const ds = date.fmtDur(r.abandonedAt - r.ts);
      if (ds) durLine = ds === '片刻' ? '惦记了片刻' : '惦记了 ' + ds;
    }
    const v = vm.baseVM(r);
    v.dt = dt;
    v.doingDays = doingDays;
    v.dur = durLine;
    v.from = fromLine;
    v.doneAtText = r.doneAt ? ('完成 · ' + date.hhmm(r.doneAt)) : '已完成';
    v.abandAtText = r.abandonedAt ? ('放弃 · ' + date.hhmm(r.abandonedAt)) : '已放弃';
    return v;
  },

  // 统计面板：默认用后端统计结果（count / 聚合，不受列表分页影响）；
  // useClient=true（搜索态）时改用当前已加载的全量搜索结果在客户端算
  /* 统计块的高度只跟「维度」有关，不跟二级筛选走：把条形行数补到该维度可能的最大值，
     缺的行用占位行撑住（占位行不可见，只占高度）。这样换喜恶 / 类别时统计块不再伸缩，
     下面的时间线也就不会跟着上下跳——跳得最明显的就是觉察的喜恶筛选（Top 归类 0~4 行）。 */
  _padStats(stats, filter) {
    if (!stats || stats.hide || !stats.bars) return stats;
    let max;
    if (filter === 'all') max = stats.bars.length;                                // 全部：条数＝维度数，本来就固定
    else if (filter === 'jot') max = (store.getOPT('jotKind') || []).length + 1;  // 随记：类别池 + 「未分类」
    else max = 4;                                                                // 觉察 / 此刻 / 可做：Top 最多 4 条
    const pads = [];
    for (let i = stats.bars.length; i < max; i++) pads.push(i);
    return Object.assign({}, stats, { pads });
  },

  buildStats(filter, list, useClient) {
    // 待办（备忘 / 购物）不展示统计，只在下面清单里看
    if (filter === 'todo') return { hide: true };
    // 「今日」一日一记：只报总数，不画条形/占比——一条维度线、分不出「构成」，
    // 硬凑一张图反而是噪音。onlySum 让 wxml 藏掉「统计 · 今日」标题，只留「共 N 条」
    if (filter === 'today') return { all: true, onlySum: true, total: list.length, bars: [], pads: [] };
    if (useClient) return this.buildStatsFromList(filter, list);
    const stat = this.data.stat || {};
    // 「可做」维度：统计各流转状态（未做 / 在做 / 做了 / 不做）
    if (filter === 'want') {
      const cnt = stat.bySt || { todo: 0, doing: 0, done: 0, abandon: 0 };
      const defs = [
        { n: '未做', k: 'todo', c: '#C0A05A' },
        { n: '在做', k: 'doing', c: '#5E9A94' },
        { n: '做了', k: 'done', c: '#7C9A86' },
        { n: '不做', k: 'abandon', c: '#948AA8' }
      ];
      const mx = Math.max(1, cnt.todo, cnt.doing, cnt.done, cnt.abandon);
      const total = cnt.todo + cnt.doing + cnt.done + cnt.abandon;
      const bars = defs.map(d => ({ n: d.n, c: d.c, n2: cnt[d.k], w: Math.round(cnt[d.k] / mx * 100) + '%' }));
      return { all: false, title: '可做 · 流转', lead: `共 ${total} 条`, bars, extra: '' };
    }
    // 「随记」：与待办一个口径——只数数量，不做「最常记的」文本 Top（随记多是
    // 一次性的一句话，比拼哪句话记得多没什么参考价值）；数量按类别分（可增删，取选项池）
    if (filter === 'jot') {
      return this.jotStatsVM(stat.byCat || {}, stat.total || 0);
    }
    // 「全部」：各觉察维度条数（不含备忘/购物，与下面清单口径区分开）
    const allMods = store.MODULES.filter(m => !store.isTask(m.k) && !m.quiet);
    if (filter === 'all') {
      const byMod = stat.byMod || {};
      const counts = allMods.map(m => ({ n: m.n, c: m.c, n2: byMod[m.k] || 0 }));
      const mx = Math.max(1, ...counts.map(c => c.n2));
      const total = counts.reduce((s, c) => s + c.n2, 0);
      return { all: true, total, bars: counts.map(c => ({ n: c.n, c: c.c, n2: c.n2, w: Math.round(c.n2 / mx * 100) + '%' })) };
    }
    // 单维度：总数 + 事项 Top（后端聚合）
    const tops = stat.tops || [];
    const total = stat.total || 0;
    const mxv = tops.length ? tops[0].n : 1;
    const bars = tops.slice(0, 4).map(t => ({ n: t.txt, c: store.mcolor(filter), n2: t.n, w: Math.round(t.n / mxv * 100) + '%' }));
    const labelMap = { obs: '觉察最多的归类', now: '最常记的', want: '最常想做的事', done: '做得最多的事', todo: '记得最多的事', jot: '最常记的' };
    let extra = '';
    if (filter === 'obs' && total) {
      const e = stat.ext || {};
      const fg = e['忘了时间'] || 0, chg = e['充电'] || 0, tire = e['耗电'] || 0;
      extra = `忘了时间 ${fg}/${total}（${Math.round(fg / total * 100)}%）· 充电 ${chg} · 耗电 ${tire}`;
    }
    return { all: false, title: store.mname(filter), lead: tops.length ? `${labelMap[filter]}：${tops[0].txt} · ${tops[0].n} 次` : '这个模块还没有记录', bars, extra };
  },

  // 客户端统计（搜索态专用：list 是搜索后的全量结果）
  buildStatsFromList(filter, list) {
    if (filter === 'want') {
      const cnt = { todo: 0, doing: 0, done: 0, abandon: 0 };
      list.forEach(r => {
        const st = r.status || '';
        if (st === 'doing') cnt.doing++;
        else if (st === 'done') cnt.done++;
        else if (st === 'abandon') cnt.abandon++;
        else cnt.todo++;
      });
      const defs = [
        { n: '未做', k: 'todo', c: '#C0A05A' },
        { n: '在做', k: 'doing', c: '#5E9A94' },
        { n: '做了', k: 'done', c: '#7C9A86' },
        { n: '不做', k: 'abandon', c: '#948AA8' }
      ];
      const mx = Math.max(1, cnt.todo, cnt.doing, cnt.done, cnt.abandon);
      const bars = defs.map(d => ({ n: d.n, c: d.c, n2: cnt[d.k], w: Math.round(cnt[d.k] / mx * 100) + '%' }));
      return { all: false, title: '可做 · 流转', lead: `共 ${list.length} 条`, bars, extra: '' };
    }
    // 「随记」：与 buildStats 同一套（搜索态就在客户端数各类别的条数）
    if (filter === 'jot') {
      const cats = store.getOPT('jotKind') || [];
      const byCat = {};
      list.forEach(r => { const c = store.jotCat(r); if (c && cats.indexOf(c) >= 0) byCat[c] = (byCat[c] || 0) + 1; });
      return this.jotStatsVM(byCat, list.length);
    }
    // 「全部」统计不计备忘/购物、也不计「睡」（静默维度，只有它的 tab 里统计）
    const awareList = filter === 'all' ? list.filter(r => !store.isTask(r.m) && !store.isQuiet(r.m)) : list;
    const allMods = store.MODULES.filter(m => !store.isTask(m.k) && !m.quiet);
    if (filter === 'all') {
      const counts = allMods.map(m => ({ n: m.n, c: m.c, n2: awareList.filter(r => r.m === m.k).length }));
      const mx = Math.max(1, ...counts.map(c => c.n2));
      return { all: true, total: awareList.length, bars: counts.map(c => ({ n: c.n, c: c.c, n2: c.n2, w: Math.round(c.n2 / mx * 100) + '%' })) };
    }
    const acc = {};
    list.forEach(r => { acc[r.txt] = (acc[r.txt] || 0) + 1; });
    const keys = Object.keys(acc).sort((a, b) => acc[b] - acc[a]).slice(0, 4);
    const mxv = keys.length ? acc[keys[0]] : 1;
    const bars = keys.map(k => ({ n: k, c: store.mcolor(filter), n2: acc[k], w: Math.round(acc[k] / mxv * 100) + '%' }));
    const labelMap = { obs: '觉察最多的归类', now: '最常记的', want: '最常想做的事', done: '做得最多的事', todo: '记得最多的事', jot: '最常记的' };
    let extra = '';
    if (filter === 'obs' && list.length) {
      const fg = list.filter(r => (r.ext || []).indexOf('忘了时间') >= 0).length;
      const chg = list.filter(r => (r.ext || []).indexOf('充电') >= 0).length;
      const tire = list.filter(r => (r.ext || []).indexOf('耗电') >= 0).length;
      extra = `忘了时间 ${fg}/${list.length}（${Math.round(fg / list.length * 100)}%）· 充电 ${chg} · 耗电 ${tire}`;
    }
    return { all: false, title: store.mname(filter), lead: keys.length ? `${labelMap[filter]}：${keys[0]} · ${acc[keys[0]]} 次` : '这个模块还没有记录', bars, extra };
  },

  /* 随记统计的呈现：各类别的条数（类别取自选项池，可增删）——与待办同一口径，只数数量。
     池子里没有的（老记录还没类别 / 类别后来被删掉）归到「未分类」（与清单页同一叫法），
     这样每条记录都有归属，各行加起来就等于「共 N 条」。
     数量为 0 的类别不占行（同待办的汇总行：没有的那项就不写） */
  jotStatsVM(byCat, total) {
    const cats = store.getOPT('jotKind') || [];
    const bars = cats.map(c => ({ n: c, c: store.jotColor(c), n2: byCat[c] || 0 }));
    const other = Math.max(0, (total || 0) - bars.reduce((s, b) => s + b.n2, 0));
    if (other) bars.push({ n: '未分类', c: store.jotColor(''), n2: other });
    const shown = bars.filter(b => b.n2 > 0);
    const mx = shown.length ? Math.max(...shown.map(b => b.n2)) : 1;
    return {
      all: false,
      title: '随记 · 类别',
      lead: total ? `共 ${total} 条` : '还没有随记',
      bars: shown.map(b => ({ n: b.n, c: b.c, n2: b.n2, w: Math.round(b.n2 / mx * 100) + '%' })),
      extra: ''
    };
  },

  /* 换筛选 / 换时间范围 / 换维度：数据都是异步回来的。
     立刻 alignTop 等于按**旧**布局算位置，新内容一到（条数变了）就会被浏览器夹回来，
     看着就是跳一下。所以这里只记下要对齐的目标，等这一批数据渲染完（rebuild 末尾）再对。 */
  _alignLater(sel) { this._alignSel = sel; },
  _flushAlign() {
    const sel = this._alignSel;
    if (!sel) return;
    this._alignSel = '';
    ui.alignTop(this, sel);
  },

  rebuild() {
    const all = this.data.recs;
    const q = this.data.q.trim().toLowerCase();
    const isWant = this.data.filter === 'want';
    // 「可以」下「做了」即 want 记录 status=done；统计/标题用模块名
    const effM = this.data.filter;
    const list = all.filter(r => {
      const f1 = this.data.filter === 'all' || r.m === this.data.filter;
      let f1b = true;
      if (isWant) {
        const st = r.status || '';
        if (this.data.stateFilter === 'todo') f1b = (st !== 'doing' && st !== 'done' && st !== 'abandon');
        else if (this.data.stateFilter === 'doing') f1b = (st === 'doing');
        else if (this.data.stateFilter === 'done') f1b = (st === 'done');
        else if (this.data.stateFilter === 'abandon') f1b = (st === 'abandon');
        else f1b = true; // all：未做 + 在做 + 做了 + 不做
      } else if (this.data.filter === 'obs' && this.data.kindFilter !== 'all') {
        // 觉察：喜恶（存在 ext 里的细节值）——搜索态是客户端过滤，非搜索态云端已按它筛过，这里不重复
        f1b = (r.ext || []).indexOf(this.data.kindFilter) >= 0;
      } else if (this.data.filter === 'todo' && this.data.kindFilter !== 'all') {
        // 待办：类别筛（同上：搜索态客户端过滤，非搜索态云端已按它筛过）
        f1b = store.taskCat(r) === this.data.kindFilter;
      } else if (this.data.filter === 'jot' && this.data.kindFilter !== 'all') {
        // 随记：类别筛（同上）
        f1b = store.jotCat(r) === this.data.kindFilter;
      }
      const f2 = !q || (r.txt + ' ' + (r.ext || []).join(' ')).toLowerCase().indexOf(q) >= 0;
      return f1 && f1b && f2;
    });
    // 备忘 / 购物是待办，不进时间流：抽出来平铺成清单；觉察记录才按天分组。
    // 「今日」一日一记：不单独占行、内容拼在所在日期旁边（grp.today → wxml 的 todaycard），
    // 无论看的是「全部」还是单独筛「今日」，都用同一套展示（筛「今日」时 aware 里没有别的记录，
    // 日期行就只剩这一天，但今日块照样在）
    const tasks = list.filter(r => store.isTask(r.m));
    const todays = list.filter(r => r.m === 'today');
    // 「睡」不进时间线（isQuiet）：取数时已经排掉了，这里再挡一道——
    // 内存全量 / 搜索态等别的入口也可能把记录送进来，漏一道就会冒出一行没有内容的记录
    const aware = list.filter(r => !store.isTask(r.m) && r.m !== 'today' && !store.isQuiet(r.m));
    const map = {};
    // 日期行的来源：aware 里的记录 + 「今日」记录。后者即使当天没有任何 aware 记录，
    // 也要单独占一行——否则「今天只记了今日」这天整行不出现，电池和印象都看不见。
    // 顺序沿用 list（云端按 ts 倒序），所以日期自然是新的在前。
    const dayKeys = aware.concat(todays).map(r => r.day).filter((d, i, a) => d && a.indexOf(d) === i);
    dayKeys.forEach(d => { if (!map[d]) map[d] = []; });
    aware.forEach(r => { if (!map[r.day]) { map[r.day] = []; } map[r.day].push(this.recVM(r)); });
    const groups = dayKeys.map(d => {
      const g = { day: d, recs: map[d] || [] };
      const tr = todays.find(x => x.day === d);
      if (tr) {
        const bi = (tr.extSrc || []).indexOf('todayBat');
        const bv = bi >= 0 ? (tr.ext || [])[bi] || '' : '';
        // 「今日」电量：与记页同一套能量条（wxml 的 .tl-bar/.tl-cell），lv=点亮几格（1..5）
        // id/m 一并带上：今日块也要能左滑进记页改、能点出操作条（靠 id 查回记录）
        g.today = {
          id: tr.id != null ? tr.id : tr._rid, m: tr.m,
          d: store.datePrefix(tr.ts), t: tr.t,     // 右起显示创建时间，与时间线行同一口径
          lv: store.batLevel(bv), batName: store.batName(bv), txt: tr.txt || ''
        };
      }
      return g;
    });
    const stats = this._padStats(this.buildStats(effM, list, !!q), effM);
    // 正在看某个「喜恶」/ 某个待办类别 / 某个随记类别时，标题也带上它——
    // 避免列表筛过了、标题却说整个模块
    const kn = (['obs', 'todo', 'jot'].indexOf(effM) >= 0 && this.data.kindFilter !== 'all') ? ' · ' + this.data.kindFilter : '';
    this.setData({
      modules: this.modulesVM(),
      // 子筛选取项池：觉察是「喜恶」，待办是「类别」，随记是「类别」——
      // 用户在选项管理里增删后这里自动跟上
      kinds: effM === 'todo' ? store.getOPT('todoKind')
        : (effM === 'jot' ? store.getOPT('jotKind') : store.getOPT('obsKind')),
      filterName: effM === 'all' ? '全部' : (store.mname(effM) + kn),
      days: groups,
      tasks: this.buildTasks(tasks),
      empty: groups.length === 0 && tasks.length === 0,
      stats
    });
    this._flushAlign();   // 数据渲染完了，按最终布局对齐（见 _alignLater）
  },

  /* 待办清单：待完成在上（按时间倒序）；已完成、已放弃各成一段（按各自时间倒序 + 按天分段）；
     三段都可收起。「全部」里不再平铺待办——待办只在自己那个维度（备忘 / 购物）下看 */
  buildTasks(ts) {
    if (!store.isTask(this.data.filter)) {
      return { show: false, tit: '', sum: '', undone: [], undoneN: 0, doneGroups: [], doneN: 0, abandGroups: [], abandN: 0 };
    }
    // 注意：recVM 的产物里没有 ts / doneAt / abandonedAt，必须在 map 之前对原始记录排序，
    // 否则 sort 比较的全是 undefined，等于没排
    const undoneRaw = ts.filter(r => !r.done && r.status !== 'abandon').sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const doneRecs = ts.filter(r => r.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    const abandRecs = ts.filter(r => !r.done && r.status === 'abandon').sort((a, b) => (b.abandonedAt || 0) - (a.abandonedAt || 0));
    const doneDays = this.groupByDay(doneRecs, r => r.doneAt || r.ts);
    const abandDays = this.groupByDay(abandRecs, r => r.abandonedAt || r.ts);
    // 数量与列出的行是同一份数据（待办视图不分页）；渲染量由「显示更多」窗口收口，
    // 并且只有窗口里真正要渲染的那几条才 map 成 VM（待办攒多了也不会卡）
    const undone = undoneRaw.slice(0, this.data.limU).map(r => this.recVM(r));
    const doneGroups = this.winGroups(doneDays, this.data.limD, this.data.doneDayAll);
    const abandGroups = this.winGroups(abandDays, this.data.limA, this.data.abandDayAll);
    const u = undoneRaw.length, dn = doneRecs.length, an = abandRecs.length;
    const sum = u
      ? (u + ' 项待完成' + (dn ? ' · 已完成 ' + dn : '') + (an ? ' · 已放弃 ' + an : ''))
      : ((dn || an) ? ('全部处理完' + (dn ? ' · 已完成 ' + dn : '') + (an ? ' · 已放弃 ' + an : '')) : '');
    const tit = this.data.kindFilter === 'all' ? '待办' : '待办 · ' + this.data.kindFilter;
    return {
      show: (u + dn + an) > 0, tit, sum, undone, undoneN: u,
      undoneHide: Math.max(0, u - undone.length),
      doneGroups, doneN: dn, abandGroups, abandN: an,
      doneHide: Math.max(0, doneDays.length - doneGroups.length),
      abandHide: Math.max(0, abandDays.length - abandGroups.length)
    };
  },

  /* groupByDay / winGroups 已收敛到 utils/pageBase.js（与清单页同一份） */

  /* ---------------- 游标分页 ---------------- */
  // 「可以」维度下「做了」已是 want 记录的一种状态（status=done），不再单独查 done 模块
  effQuery() {
    let m = this.data.filter === 'all' ? null : this.data.filter;
    let state = null;
    if (this.data.filter === 'want') {
      state = this.data.stateFilter === 'doing' ? 'doing'
            : (this.data.stateFilter === 'todo' ? 'todo'
            : (this.data.stateFilter === 'done' ? 'done'
            : (this.data.stateFilter === 'abandon' ? 'abandon' : 'all')));
    }
    // 觉察的喜恶 / 待办的类别 / 随记的类别筛选交给云端（否则分页会混进不匹配的记录，
    // 页数与「已经到底了」都会不准）
    const subF = this.data.filter === 'obs' || this.data.filter === 'todo' || this.data.filter === 'jot';
    const extTags = (subF && this.data.kindFilter !== 'all') ? [this.data.kindFilter] : null;
    // 「全部」的时间线不看待办、也不看「睡」，所以查询里就把它们排掉：
    // 否则一页 20 条被待办占满，时间线只显示几条、页面短到滚不动，上拉加载更多点了没反应
    // （memo / buy 是合并前的老数据，一并排掉，避免迁移没跑完时混进时间线）
    const mNot = (this.data.filter === 'all') ? ['todo', 'memo', 'buy', 'sleep'] : null;
    return { m, state, extTags, mNot };
  },
  // 重置并加载第一页 + 统计总数
  resetLoad() {
    // 切维度 / 换筛选 / 搜索都从这里走：代次 +1 把在途的旧请求作废（不然旧响应回来会盖掉新内容）；
    // 顺手清 _loading —— 上一次取数还在飞时若不清，这一页的首屏会被 loadMore 直接跳过，
    // 页面就一直空着，直到用户滚到底触发 onReachBottom 才补上第一页
    this._gen = (this._gen || 0) + 1;
    this._loading = false;
    this._cursor = null;
    // 只有「还没成功加载过一次」时才让骨架屏接管：切筛选 / 换时间也会走这里，
    // 每次都闪一下骨架比短暂的空列表还晃眼
    const skeleton = !this._everLoaded;
    this.setData({ recs: [], hasMore: true, loading: false, empty: false, ready: !skeleton });
    this.loadMore(true);
    this.loadStats();
  },
  // 加载一页（first=true 为首屏/刷新）；有搜索词时走全量搜索
  loadMore(first) {
    // 待办视图不分页：直接取本地全量（见 loadAllTasks）
    if (this.data.filter === 'todo') { if (first) this.loadAllTasks(); return; }
    // 「今日」同理：一天一条，分页毫无意义；而总数要的是全历史条数，分页会只数到已加载那几页。
    // 走 loadAllTodays——按时间倒序取全部「今日」记录（每页 20，串行翻完），一次性给准总数
    if (this.data.filter === 'today') { if (first) this.loadAllTodays(); return; }
    if (this._loading) return;
    if (!first && !this.data.hasMore) return;
    if (this.data.q.trim()) { this.fullSearch(); return; }
    const gen = this._gen;   // 这一页属于哪一代：回来时对不上就不要了
    this._loading = true;
    this.setData({ loading: true });
    const q = this.effQuery();
    const params = {
      before: first ? null : this._cursor,
      limit: 20,
      m: q.m,
      startTs: this.data.rangeStart,
      state: q.state,
      extTags: q.extTags,
      mNot: q.mNot,
      // 已加载的文档 id：配合 lte 游标去重，避免同毫秒记录被跳过或重复
      excludeIds: first ? null : (this.data.recs || []).map(r => r._rid)
    };
    store.loadRecordsPage(params).then(({ list, hasMore, nextCursor }) => {
      if (gen !== this._gen) return;   // 期间又切过维度 / 筛选：这一页已经过期，不能往 setData 里塞
      this._cursor = nextCursor;
      const recs = first ? list : this.data.recs.concat(list);
      this._loading = false;
      this._everLoaded = true;
      this.setData({ recs, hasMore, loading: false, ready: true }, () => {
        this.rebuild();
        if (first) wx.stopPullDownRefresh();   // 首屏/刷新加载完，收起原生下拉
        // 没有更多了 + 内容够长 → 这时才提示可以点底部当前 tab 回顶
        if (!hasMore && recs.length > 10) this.hintTabTop();
      });
    }).catch(() => {
      if (gen !== this._gen) return;
      this._loading = false;
      // 失败也要撤掉骨架屏，否则会一直卡在占位上；并给出「点击重试」（以前是整屏空白）
      this.setData({ loading: false, hasMore: false, ready: true, loadFail: true });
      wx.stopPullDownRefresh();
    });
  },
  /* 待办视图不分页：ensureAll 已经把记录全量拉进内存，直接用本地那份——
     分页时「待完成 · N」是全部、列出的行只有已加载的几页，两者对不上。
     待办也不看时间范围（页面上没有那行筛选，见 look.wxml），这里只应用类别筛选，
     渲染量交给「显示更多」窗口收口。 */
  loadAllTasks() {
    const all = app.globalData.records || [];
    const cat = this.data.kindFilter !== 'all' ? this.data.kindFilter : '';
    const list = all.filter(r => store.isTask(r.m) && (!cat || store.taskCat(r) === cat));
    this._loading = false;
    this._everLoaded = true;
    this.setData({ recs: list, hasMore: false, loading: false, ready: true }, () => {
      this.rebuild();
      wx.stopPullDownRefresh();
    });
  },

  /* 「今日」视图不分页：一天一条，分页没意义，且总数必须是全历史条数（分页只数得到已加载那几页）。
     与待办同源——直接用内存全量（app.globalData.records，各页取数后都在里面），
     按创建时间倒序；「显示更多」窗口在 rebuild 的分组里收口，攒多了也不会卡。 */
  loadAllTodays() {
    const all = app.globalData.records || [];
    const list = all.filter(r => r.m === 'today').slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    this._loading = false;
    this._everLoaded = true;
    this.setData({ recs: list, hasMore: false, loading: false, ready: true }, () => {
      this.rebuild();
      wx.stopPullDownRefresh();
    });
  },

  // 页面级上拉触底：加载更多（提示回顶只在「真的到底」时触发，见 loadMore 回调）
  onReachBottom() { this.loadMore(false); },

  // 滚到底部了：让底部「看」图标跳一下，提示可以点它回顶
  hintTabTop() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().hint();
  },
  // 统计当前 模块 + 时间范围（后端统计，不受列表分页影响；搜索态由 rebuild 在客户端算）
  loadStats() {
    const f = this.data.filter;
    const startTs = this.data.rangeStart;
    const gen = this._gen;
    // 统计也是异步回来的：期间又切了维度 / 筛选，这批数字就属于上一屏了，直接丢掉
    const set = (stat) => { if (gen === this._gen) this.setData({ stat }, () => this.rebuild()); };
    if (this.data.q.trim()) return;
    // 待办视图不展示统计面板（三个数量的口径在 buildTasks 里，取自本地全量）
    if (f === 'todo') { set({}); return; }
    if (f === 'all') {
      store.countByModule({ startTs }).then(byMod => set({ byMod }));
      return;
    }
    if (f === 'want') {
      store.countByStatus({ startTs }).then(bySt => set({ bySt }));
      return;
    }
    // 随记：按类别数数量（类别取自选项池，可增删）——和待办一样只看数量，不做文本 Top。
    // 已经筛了某个类别时，数量也落在同一个筛选里（与觉察的喜恶同一套口径）
    if (f === 'jot') {
      const cats = store.getOPT('jotKind') || [];
      const base = this.data.kindFilter !== 'all' ? [this.data.kindFilter] : null;
      const jobs = cats.map(c => store.countRecords({ m: 'jot', startTs, extTags: base ? base.concat([c]) : [c] }));
      jobs.push(store.countRecords({ m: 'jot', startTs, extTags: base }));   // 最后一个＝总数（各类别之和可能漏掉未分类的）
      Promise.all(jobs).then(arr => {
        const total = arr[arr.length - 1] || 0;
        const byCat = {};
        cats.forEach((c, i) => { byCat[c] = arr[i] || 0; });
        set({ total, byCat });
      });
      return;
    }
    // 觉察筛了喜恶时，统计也跟着落在同一个筛选里
    //（不然列表是筛过的、数字却是全模块的）
    const tags = (f === 'obs' && this.data.kindFilter !== 'all') ? [this.data.kindFilter] : null;
    const jobs = [store.countRecords({ m: f, startTs, extTags: tags }), store.countByTxt({ m: f, startTs, extTags: tags })];
    if (f === 'obs') {
      const withTag = (t) => (tags ? tags.concat([t]) : [t]);
      jobs.push(store.countRecords({ m: 'obs', startTs, extTags: withTag('忘了时间') }));
      jobs.push(store.countRecords({ m: 'obs', startTs, extTags: withTag('充电') }));
      jobs.push(store.countRecords({ m: 'obs', startTs, extTags: withTag('耗电') }));
    }
    Promise.all(jobs).then(([total, tops, fg, chg, tire]) => {
      const stat = { total: total || 0, tops: tops || [] };
      if (f === 'obs') stat.ext = { '忘了时间': fg || 0, '充电': chg || 0, '耗电': tire || 0 };
      set(stat);
    });
  },
  // 搜索：全量拉取后客户端过滤（搜索需覆盖全部记录，不走游标分页）
  fullSearch() {
    const gen = this._gen;
    this._loading = true;
    this.setData({ loading: true, hasMore: false });
    const q = this.effQuery();
    // 待办不看时间范围（页面上没有那行筛选），其它维度照旧
    const params = { m: q.m, mNot: q.mNot, startTs: this.data.filter === 'todo' ? null : this.data.rangeStart };
    store.loadAllRecords(params).then(all => {
      if (gen !== this._gen) return;   // 期间改过搜索词 / 切过维度：这份结果已经过期
      const q2 = this.data.q.trim().toLowerCase();
      const list = all.filter(r => (r.txt + ' ' + (r.ext || []).join(' ')).toLowerCase().indexOf(q2) >= 0);
      this._loading = false;
      this.setData({ recs: list, loading: false }, () => this.rebuild());
    }).catch(() => {
      if (gen !== this._gen) return;
      this._loading = false;
      this.setData({ loading: false });
    });
  },

  /* ---------------- 筛选 / 搜索 ---------------- */
  onSearch(e) {
    this.data.q = e.detail.value;
    clearTimeout(this._searchTimer);
    if (!this.data.q.trim()) { this.resetLoad(); return; }
    this._searchTimer = setTimeout(() => this.fullSearch(), 300);
  },
  // 聚焦搜索框：不做处理。
  // 手动滚动会与 adjust-position 的原生键盘避让叠加（先被滚到顶部、又被原生推起一次），
  // 导致键盘弹出时搜索框“飞”到页面顶端。统一交给 adjust-position 原生处理。
  onSearchFocus() {},
  /* 待办各段的「显示更多」：u 待完成（条）/ d 已完成（天）/ a 已放弃（天） */
  onTaskMore(e) {
    const k = this._detailOr(e, 'k');
    const patch = {};
    if (k === 'u') patch.limU = this.data.limU + 20;
    else if (k === 'd') patch.limD = this.data.limD + 7;
    else if (k === 'a') patch.limA = this.data.limA + 7;
    else return;
    this.setData(patch, () => this.rebuild());
  },
  /* 某一天「展开全部 / 收起」（这天超过 20 条时才有入口） */
  onDayMore(e) {
    const k = String(this._detailOr(e, 'k'));
    const w = this._detailOr(e, 'w');   // d 已完成 | a 已放弃
    const which = w === 'a' ? 'abandDayAll' : 'doneDayAll';
    const map = Object.assign({}, this.data[which]);
    if (map[k]) delete map[k]; else map[k] = 1;
    const patch = {}; patch[which] = map;
    this.setData(patch, () => this.rebuild());
  },
  onFilter(e) {
    this.data.filter = e.currentTarget.dataset.f;
    this.data.stateFilter = 'all';
    // 子筛选（可做的流转状态 / 觉察的喜恶）只属于各自的模块，切模块时归零
    this.data.kindFilter = 'all';
    this.setData({ filter: this.data.filter, stateFilter: 'all', kindFilter: 'all', sel: null, selRec: null });
    this.resetLoad();
    // 换维度后把这一页的标题对齐到屏幕顶部（像切 tab 那样主动滚一下）：
    // 各维度时间线长短差很多，不主动对齐就会被浏览器被动拉回，看着像整页在跳
    this._alignLater('#blk-title');
  },
  /* 左右滑动切维度（全部 / 各维度）：向左滑下一个，向右滑上一个。
     例外：行尾左滑归行内（时间线行、待办行都是「进记卡改」，见 onRowSwipe / onRowTouchend）——
     那一下不能再切维度。所以这里延后一拍再切，行内动作一到就把它撤掉
     （组件派发的事件与根节点原生事件的先后没法保证，两边都兜住） */
  onSwipeStart(e) { swipe.start(this, e); },
  onSwipeEnd(e) {
    const d = swipe.end(this, e);
    if (!d) return;
    if (this._segTimer) clearTimeout(this._segTimer);
    this._segTimer = setTimeout(() => {
      this._segTimer = null;
      if (this._rowActAt && Date.now() - this._rowActAt < 400) { this._rowActAt = 0; return; }
      this.stepDim(d);
    }, 60);
  },
  /* 行内动作（左滑改这一条）一到，就把可能还在排队的「切维度」撤掉 */
  _cancelSeg() { if (this._segTimer) { clearTimeout(this._segTimer); this._segTimer = null; } },
  stepDim(dir) {
    const mods = this.data.modules || this.modulesVM();
    const keys = ['all'].concat(mods.map(m => m.k));
    const i = keys.indexOf(this.data.filter);
    if (i < 0) return;
    const ni = dir === 'left' ? i + 1 : i - 1;
    if (ni < 0 || ni >= keys.length) return;
    this.onFilter({ currentTarget: { dataset: { f: keys[ni] } } });
  },
  // 觉察 · 喜恶筛选（与「可做」的流转状态筛选同一套：切了就重拉第一页）
  onKindFilter(e) {
    this.data.kindFilter = e.currentTarget.dataset.k || 'all';
    this.setData({ kindFilter: this.data.kindFilter, sel: null, selRec: null });
    this.resetLoad();
    // 这里**不主动滚动**：换二级筛只是换这一屏的记录，页面停在你点的地方。
    // 之前会把筛选行顶到屏幕上，看着就是「跳到顶部」（与记页换维度、清单页切段同一个取舍）
  },
  // 可以 维度下的状态切换：未做 / 在做 / 做了
  onStateFilter(e) {
    this.data.stateFilter = e.currentTarget.dataset.s;
    this.setData({ stateFilter: this.data.stateFilter });
    this.resetLoad();
    // 同上：不主动滚动（可做 未做 / 在做 / 做了 / 不做 只是换一批记录）
  },
  // 快捷时间选择：全部 / 今天 / 近7天 / 近30天
  onRange(e) {
    const r = e.currentTarget.dataset.r;
    const map = { all: '全部', today: '今天', '7d': '近7天', '30d': '近30天' };
    this.setData({ range: r, rangeLabel: map[r] || '全部', rangeStart: this.rangeStartOf(r), stateFilter: 'all' });
    this.resetLoad();
    this._alignLater('.ranges');
  },
  rangeStartOf(range) {
    if (range === 'all') return null;
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    if (range === 'today') return d.getTime();
    if (range === '7d') { d.setDate(d.getDate() - 6); return d.getTime(); }
    if (range === '30d') { d.setDate(d.getDate() - 29); return d.getTime(); }
    return null;
  },

  /* 再点一次底部「看」：整页回到顶部 */
  onHide() {
    // 离开页面（切 tab / 进后台）不保留操作条与撤销条，回来是一页干净的
    this.clearFloats();
  },

  /* onTabReselect 覆盖 pageBase 的默认：本页回顶前先收起操作条（再点当前 tab = 干净的一页） */
  onTabReselect() {
    this.closeSel();
    wx.pageScrollTo({ scrollTop: 0, duration: 300 });
  },

  /* 切换 tab 进入本页：恢复初始状态（回到「全部」维度、清空搜索与子筛选），并回顶 */
  resetToInitial() {
    this.clearFloats();
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    this.data.filter = 'all'; this.data.stateFilter = 'all'; this.data.kindFilter = 'all'; this.data.q = '';
    this.setData({ filter: 'all', stateFilter: 'all', kindFilter: 'all', q: '', sel: null, selRec: null });
    this.resetLoad();
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  /* 看页对待办只做概览：改 / 删 / 放弃 / 恢复都去清单页管理 */
  goList() { wx.navigateTo({ url: '/pages/list/list' }); },

  /* 页面滚动：顺手收起记录操作条（页面级滚动下微信会同步原生输入层位置） */
  onPageScroll(e) {
    this._pageTop = e.scrollTop || 0;
    this.closeSel();
  },

  /* 页面级下拉刷新入口（原生下拉回弹，与记页一致）；
     下拉时程序名正好从胶囊后露出来，顺手播一次逐字浮现 */
  onPullDownRefresh() {
    this.layoutBrand();   // 露出来之前再确认一次位置（万一首次没取到胶囊矩形）
    this.playBrand();
    this.onRefresh();
  },

  /* 悬浮球「＋」快捷记下一条待办后：重拉第一页，让它出现在时间流里 */
  onQuickTodo() { this.resetLoad(); },

  /* 下拉刷新：重置首屏（首屏加载完会收起原生下拉） */
  onRefresh() {
    this.resetLoad();
  },

  /* ---------------- 记录操作 ---------------- */
  /* findRec / _id / _detailOr 已收敛到 utils/pageBase.js（与清单页同一份） */
  syncGlobal(id, fn) {
    const g = app.globalData.records || [];
    const r = g.find(x => x.id === id); if (r) fn(r);
  },
  syncGlobalDel(id) {
    const g = app.globalData.records || [];
    const i = g.findIndex(x => x.id === id); if (i >= 0) g.splice(i, 1);
  },
  syncGlobalAdd(rec) {
    const g = app.globalData.records || [];
    const i = g.findIndex(x => x.id === rec.id);
    if (i >= 0) g[i] = rec; else { g.unshift(rec); g.sort((a, b) => (b.ts || 0) - (a.ts || 0)); }
  },

  /* 备忘/购物：勾选切换完成态 */
  onRecCheck(e) {
    const id = this._id(e);
    const r = (this.data.recs || []).find(x => x.id === id);
    if (!r || !store.isTask(r.m)) return;
    r.done = !r.done; r.doneAt = r.done ? Date.now() : 0;
    store.updateRecord(r).catch(() => {});
    this.syncGlobal(id, gr => { gr.done = r.done; gr.doneAt = r.doneAt; });
    this.setData({ recs: this.data.recs.slice() }, () => this.rebuild());
  },

  /* ---------------- 长按记录：复制这句话 ----------------
     待办行与时间线上的行一样：点一下出操作条、行尾左滑进记卡改（改 / 删都在记卡 / 本页处理），
     长按一律复制原文；「放弃 / 恢复」待办在本页直接落库（不必跳页） */
  onRowLongPress(e) {
    const id = this._id(e);
    const r = this.findRec(id);
    if (!r) return;
    this._lpAt = Date.now();   // 长按后紧跟着的那次点击要忽略掉
    this.copyRec(r);
  },
  /* copyRec 已收敛到 utils/pageBase.js */
  /* 行级手势：时间线上的行「行尾左滑」＝进记卡改这一条（看页是「概览 + 管理去别处」的口径，
     与操作条里的「改」同一条路）。**只有行尾起手的横滑才算行内**，其余横滑原样不动，
     交给根节点切维度；纵向滑动照旧交给页面滚动 */
  onRowTouchStart(e) { this._rowEdge = swipe.atEdge(e); swipe.start(this, e); },
  onRowTouchCancel() { this._swX = null; this._swY = null; },
  onRowTouchend(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const edge = this._rowEdge; this._rowEdge = false;
    if (edge && ds.id != null && swipe.dir(this, e) === 'left') {
      swipe.end(this, e);   // 这一下归行内：吃掉起点，根节点那次 end 就什么也拿不到
      const r = this.findRec(ds.id);
      if (r && !store.isTask(r.m)) this.rowAct(r);
    }
  },
  /* 「今日」块：点一下出操作条（改 / 删与时间线行同一套）。
     它不在 this.data.recs 里（被 rebuild 排除在时间线外），但 findRec 先查
     app.globalData.records（内存全量），所以照样查得到。 */
  onTodayTap(e) {
    if (this._lpAt && Date.now() - this._lpAt < 400) return;   // 刚左滑过，忽略随之而来的点击
    const id = this._id(e);
    if (this.data.sel === id) { this.setData({ sel: null, selRec: null }); return; }
    const r = this.findRec(id);
    if (!r) return;
    this.setData({ sel: id, selRec: { m: store.recMname(r), txt: r.txt, rawm: r.m, status: r.status || '', ended: !!r.endTs, done: !!r.done } });
  },
  /* 行内动作（左滑「改这一条」）：跳记页完整编辑（与操作条里的「改」同一条路）。
     顺手记时间戳并撤掉排队中的「切维度」——这次滑动不该再被当成切维度 */
  rowAct(r) {
    this._lpAt = Date.now();     // 刚滑过：紧跟其后的 tap（若有）不当成点选
    this._rowActAt = Date.now();
    this._cancelSeg();
    this.editInCard(r);
  },
  /* 跳记页完整编辑（看页是「概览 + 管理去记卡」的口径，待办 / 时间线行都走这条） */
  editInCard(r) {
    app.globalData.editRec = store.decorate(r);
    this.setData({ sel: null, selRec: null });
    wx.switchTab({ url: '/pages/index/index' });
  },

  onRecTap(e) {
    if (this._lpAt && Date.now() - this._lpAt < 400) return;   // 长按刚触发过，忽略随之而来的点击
    const id = this._id(e);
    if (this.data.sel === id) { this.setData({ sel: null, selRec: null }); return; }
    const r = this.findRec(id);
    // 待办也出操作条（放弃 / 恢复 本地处理，改 / 删 走下面统一分支）
    this.setData({ sel: id, selRec: r ? { m: store.recMname(r), txt: r.txt, rawm: r.m, status: r.status || '', ended: !!r.endTs, done: !!r.done } : null });
  },
  /* 待办行（todo-list 组件里）的「行尾左滑」：与时间线行同一口径——进记卡改这一条 */
  onRowSwipe(e) {
    const d = e.detail || {};
    if (d.id == null) return;
    const r = this.findRec(d.id);
    if (r) this.rowAct(r);
  },

  /* 记录操作条统一入口（与记页共用 rec-actions 组件；看页行为：流转/改/结束 跳到记页（结束时间待「保存修改」时才记），恢复/删 本地直接处理）
     type: start | complete | abandon | restore | end | edit | del */
  onRecAction(e) {
    const type = e.detail.type;
    const id = this.data.sel; if (id == null) return;
    const r = this.findRec(id);
    if (!r) return;
    // 待办（备忘 / 购物）：放弃 / 恢复只动状态与时间，不跳页（完成仍由条目上的勾选框负责）；
    //   改 / 删除照常走下面的统一分支——之前这里把 edit / del 也一并 return 掉了，点了没反应
    if (store.isTask(r.m) && (type === 'abandon' || type === 'restore')) {
      const apply = (o) => {
        if (type === 'abandon') { o.status = 'abandon'; o.abandonedAt = Date.now(); }
        else { o.status = ''; o.abandonedAt = 0; }
      };
      apply(r);
      this.syncGlobal(id, apply);
      store.updateRecord(r).catch(() => {});
      this.setData({ recs: this.data.recs.slice(), sel: null, selRec: null }, () => this.rebuild());
      return;
    }
    if (type === 'start' || type === 'complete' || type === 'abandon') {
      if (r.m !== 'want') return;
      app.globalData.editRec = r;
      if (type === 'start') app.globalData.editStart = true;
      if (type === 'complete') app.globalData.editComplete = true;
      if (type === 'abandon') app.globalData.editAbandon = true;
      this.setData({ sel: null, selRec: null });
      wx.switchTab({ url: '/pages/index/index' });
      return;
    }
    if (type === 'restore') {
      if (r.m !== 'want' || r.status !== 'abandon') return;
      const now = Date.now();
      const apply = (rec) => {
        rec.status = '';
        rec.ts = now;
        rec.t = store.normTime('', now);
        rec.abandonedAt = 0;
        rec.startedAt = 0;
        const es = rec.extSrc || [], ex = rec.ext || [];
        const keep = [];
        for (let i = 0; i < es.length; i++) { if (es[i] === 'free:abandonWhy') continue; keep.push(i); }
        rec.extSrc = keep.map(i => es[i]); rec.ext = keep.map(i => ex[i]);
      };
      apply(r);
      this.syncGlobal(id, apply);
      store.updateRecord(r).catch(() => {});
      this.setData({ recs: this.data.recs.slice(), sel: null, selRec: null }, () => this.rebuild());
      return;
    }
    if (type === 'end') {
      if (r.m !== 'obs') return;
      // 不在这里落结束时间：只标记待结束，跳到记页编辑态并聚焦「感受」输入框、弹键盘，
      // 等点「保存修改」时才记录结束时间并写云
      app.globalData.editRec = r;
      app.globalData.editEnding = true;
      app.globalData.editEndFocus = true;
      this.setData({ sel: null, selRec: null });
      wx.switchTab({ url: '/pages/index/index' });
      return;
    }
    if (type === 'edit') {
      app.globalData.editRec = r;
      this.setData({ sel: null, selRec: null });
      wx.switchTab({ url: '/pages/index/index' });
      return;
    }
    if (type === 'del') { this.onActDel(); return; }
  },

  /* 点页面其它地方：收起记录操作条（失焦即关） */
  closeSel() {
    if (this.data.sel != null) this.setData({ sel: null, selRec: null });
  },

  /* 点到「任何一个不是浮层本身」的地方（含页面内部、空白、切页）：操作条与撤销条都收起。
     离开页面（onHide）也走这里——否则切 tab 再回来，操作条还挂在那儿 */
  clearFloats() {
    const patch = {};
    if (this.data.sel != null) { patch.sel = null; patch.selRec = null; }
    if (this.data.delUndo) { patch.delUndo = null; this._stopDelTimer(); }
    if (Object.keys(patch).length) this.setData(patch);
  },
  /* _stopDelTimer / _startDelTimer 已收敛到 utils/pageBase.js */

  /* 删除一条记录并给出撤销机会（操作条「删除」与就地编辑的「删除」共用） */
  _delRec(r) {
    const id = r.id;
    const i = (this.data.recs || []).findIndex(x => x.id === id);
    store.deleteRecord(r).then(() => {
      const recs = this.data.recs.slice();
      if (i >= 0) recs.splice(i, 1);
      this.syncGlobalDel(id);
      this.setData({ recs, sel: null, selRec: null, delUndo: { m: store.recMname(r), txt: r.txt, dump: r } }, () => this.rebuild());
      this._startDelTimer();   // 之前这里缺自动收起，撤销条会一直挂在页面上
    });
  },

  onActDel() {
    const id = this.data.sel; if (id == null) return;
    const r = this.findRec(id);
    if (!r) return;
    this._delRec(r);
  },

  onUndoDel() {
    const u = this.data.delUndo; if (!u) return;
    const dump = u.dump;
    // 删除后撤销：忠实还原原记录，保留状态（未做/在做/做了/不做）、开始时间与放弃时间，
    // 以及「为什么不做了」——「不做」记录撤销后仍是「不做」，而不是退回未做
    const rec = {
      m: dump.m, t: dump.t, txt: dump.txt,
      ext: dump.ext || [], extSrc: dump.extSrc || [],
      ts: dump.ts, done: dump.done || false, doneAt: dump.doneAt || 0,
      status: dump.status || '',
      startedAt: dump.startedAt || 0,
      abandonedAt: dump.abandonedAt || 0
    };
    store.addRecord(rec).then(rid => {
      rec._rid = rid; rec.id = rid;
      const decorated = store.decorate(rec);
      const recs = this.data.recs.slice();
      recs.unshift(decorated);
      recs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      this.syncGlobalAdd(decorated);
      this.setData({ recs, delUndo: null }, () => this.rebuild());
    });
  }
}));
