// pages/look/look.js —— 看
const store = require('../../utils/store.js');
const app = getApp();

function dmClass(m) {
  return ['obs', 'now', 'want', 'nope', 'done', 'memo', 'buy', 'like'].indexOf(m) >= 0 ? 'dm-' + m : 'dm-custom';
}

// 用时格式化：不足 1 天用小时（不足 1 小时用分钟，再短“片刻”）；
// 满 1 天及以上用「天」并保留一位小数，如 1.5 天
function fmtDur(ms) {
  if (ms <= 0) return '';
  const DAY = 86400000, HOUR = 3600000, MIN = 60000;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    if (h > 0) return h + ' 小时';
    const m = Math.floor(ms / MIN);
    if (m > 0) return m + ' 分钟';
    return '片刻';
  }
  const d = ms / DAY;
  return (Math.round(d * 10) / 10) + ' 天';
}

Page({
  data: {
    theme: 'mint',
    statusH: 20,
    // 程序名彩蛋：与记页同一套（按胶囊矩形定位 + 下拉逐字浮现）
    appName: (app && app.APP_NAME) || '',
    brandTop: 0,
    brandLeft: 0,
    brandW: 0,
    brandH: 0,
    brandChars: [],
    brandPlay: false,
    modules: [],
    filter: 'all',
    filterName: '全部',
    stateFilter: 'all',
    q: '',
    recs: [],          // 已加载（装饰后）的记录，按 ts 倒序
    days: [],
    stats: {},
    sel: null,
    selRec: null,
    delUndo: null,
    tasks: { show: false, tit: '', sum: '', undone: [], done: [], doneN: 0 },
    taskOpen: { undone: true, done: false }, // 待完成 / 已完成 折叠态（true=展开）
    empty: false,
    // 待办长按就地编辑（与清单 / 记页共用的 inline-editor 组件）
    editing: false,
    edFocus: false,       // 显示与聚焦分开：手指抬起后才聚焦（见 onRowTouchend）
    edId: '',
    edTxt: '',
    ed: { top: 0, left: 0, width: 0, height: 0 },

    // 游标分页 + 快捷时间
    range: 'all',
    rangeLabel: '全部',
    rangeStart: null,
    hasMore: true,
    loading: false,
    stat: {}          // 后端统计结果：{ byMod } / { bySt } / { total, tops, ext }
  },

  onLoad() {
    this._cursor = null;
    this._loading = false;
    this._searchTimer = null;
  },

  onShow() {
    this.ensureTheme();
    this.layoutBrand();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 1, theme: store.curTheme() });
    this.setData({ sel: null, selRec: null, delUndo: null });
    // 兜底：若此前停留在已下架的「做了」维度，回到「全部」
    if (this.data.filter === 'done') this.setData({ filter: 'all', stateFilter: 'all' });
    store.ensureAll().then(() => { this.resetLoad(); });
  },

  ensureTheme() {
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    this.setData({ theme: store.curTheme(), statusH: info.statusBarHeight || 20 });
  },

  /* 程序名藏在胶囊「背后」：按胶囊的矩形定位，平时被原生胶囊盖住，
     只有下拉刷新把页面（含这个 fixed 元素）推下去时才露出来（与记页同一套） */
  layoutBrand() {
    try {
      const mb = wx.getMenuButtonBoundingClientRect && wx.getMenuButtonBoundingClientRect();
      if (!mb || !mb.height) return;
      this.setData({
        brandTop: mb.top, brandLeft: mb.left, brandW: mb.width, brandH: mb.height,
        brandChars: String(this.data.appName || '').split('')
      });
    } catch (e) { /* 取不到就不显示 */ }
  },

  /* 名字露出来的这会儿，播一次逐字浮现 */
  playBrand() {
    this.setData({ brandPlay: true });
    if (this._brandTimer) clearTimeout(this._brandTimer);
    this._brandTimer = setTimeout(() => this.setData({ brandPlay: false }), 900);
  },

  modulesVM() {
    // 维度筛选不单列「做了」：它与「可做 → 做了」状态筛选重复，避免入口歧义
    return store.MODULES.filter(m => m.k !== 'done');
  },

  recVM(r) {
    const dt = store.buildExt(r.m, r.ext, r.extSrc);
    // 日期前缀：今天空串，昨天 / 前天相对说法，更早给日期（跨年才带年份）
    const d = store.datePrefix(r.ts);
    const task = store.isTask(r.m);
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
      const ds = fmtDur(dur);
      // 「片刻」本身成词，与标签连写（用了片刻）；数值时长保留空格（用了 1 天）
      if (ds) durLine = ds === '片刻' ? durLabel + ds : durLabel + ' ' + ds;
    }
    // 觉察：有结束时间则显示「历时」（从创建到结束）
    if (r.m === 'obs' && r.endTs && r.ts && r.endTs > r.ts) {
      const ds = fmtDur(r.endTs - r.ts);
      if (ds) durLine = ds === '片刻' ? '历时片刻' : '历时 ' + ds;
    }
    // 不做 的历时：从创建到放弃（惦记了多久）
    if (r.m === 'want' && r.status === 'abandon' && r.abandonedAt && r.ts && r.abandonedAt >= r.ts) {
      const ds = fmtDur(r.abandonedAt - r.ts);
      if (ds) durLine = ds === '片刻' ? '惦记了片刻' : '惦记了 ' + ds;
    }
    return { id: r.id, m: store.recMname(r), c: store.mcolor(r.m), dm: dmClass(r.m), txt: r.txt, desc: r.desc || '', t: r.t, tt: r.tt || r.t, d, dt, task, done: !!r.done, doneLabel: store.doneLabel(r.doneAt), reason: r.reason || '', usefor: r.usefor || '', status: r.status || '', doingDays, dur: durLine, from: fromLine };
  },

  // 统计面板：默认用后端统计结果（count / 聚合，不受列表分页影响）；
  // useClient=true（搜索态）时改用当前已加载的全量搜索结果在客户端算
  buildStats(filter, list, useClient) {
    // 备忘 / 购物是待办，不展示统计，只在下面清单里看
    if (filter === 'memo' || filter === 'buy') return { hide: true };
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
    // 「全部」：各觉察维度条数（不含备忘/购物，与下面清单口径区分开）
    const allMods = store.MODULES.filter(m => !store.isTask(m.k));
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
    const labelMap = { obs: '觉察最多的归类', now: '最常在做的事', want: '最常想做的事', done: '做得最多的事', memo: '记得最多的事', buy: '最常买的东西' };
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
    // 「全部」统计不计备忘/购物
    const awareList = filter === 'all' ? list.filter(r => !store.isTask(r.m)) : list;
    const allMods = store.MODULES.filter(m => !store.isTask(m.k));
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
    const labelMap = { obs: '觉察最多的归类', now: '最常在做的事', want: '最常想做的事', done: '做得最多的事', memo: '记得最多的事', buy: '最常买的东西' };
    let extra = '';
    if (filter === 'obs' && list.length) {
      const fg = list.filter(r => (r.ext || []).indexOf('忘了时间') >= 0).length;
      const chg = list.filter(r => (r.ext || []).indexOf('充电') >= 0).length;
      const tire = list.filter(r => (r.ext || []).indexOf('耗电') >= 0).length;
      extra = `忘了时间 ${fg}/${list.length}（${Math.round(fg / list.length * 100)}%）· 充电 ${chg} · 耗电 ${tire}`;
    }
    return { all: false, title: store.mname(filter), lead: keys.length ? `${labelMap[filter]}：${keys[0]} · ${acc[keys[0]]} 次` : '这个模块还没有记录', bars, extra };
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
      }
      const f2 = !q || (r.txt + ' ' + (r.ext || []).join(' ')).toLowerCase().indexOf(q) >= 0;
      return f1 && f1b && f2;
    });
    // 备忘 / 购物是待办，不进时间流：抽出来平铺成清单；觉察记录才按天分组
    const tasks = list.filter(r => store.isTask(r.m));
    const aware = list.filter(r => !store.isTask(r.m));
    const map = {}, days = [];
    aware.forEach(r => { if (!map[r.day]) { map[r.day] = []; days.push(r.day); } map[r.day].push(this.recVM(r)); });
    const groups = days.map(d => ({ day: d, recs: map[d] }));
    const stats = this.buildStats(effM, list, !!q);
    this.setData({
      modules: this.modulesVM(),
      filterName: effM === 'all' ? '全部' : store.mname(effM),
      days: groups,
      tasks: this.buildTasks(tasks),
      empty: groups.length === 0 && tasks.length === 0,
      stats
    });
  },

  /* 待办清单：未完成在上（按时间倒序），已完成沉底（按完成时间倒序）；待完成/已完成各自可折叠。
     「全部」里不再平铺待办——待办只在自己那个维度（备忘 / 购物）下看 */
  buildTasks(ts) {
    if (!store.isTask(this.data.filter)) {
      return { show: false, tit: '', sum: '', undone: [], done: [], doneN: 0, openU: true, openD: false };
    }
    // 注意：recVM 的产物里没有 ts / doneAt，必须在 map 之前对原始记录排序，
    // 否则 sort 比较的全是 undefined，等于没排
    const undone = ts.filter(r => !r.done).sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(r => this.recVM(r));
    const done = ts.filter(r => r.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).map(r => this.recVM(r));
    const u = undone.length, dn = done.length;
    const sum = u ? (u + ' 项待完成' + (dn ? ' · 已完成 ' + dn : '')) : (dn ? '全部完成 · ' + dn + ' 条' : '');
    const tit = this.data.filter === 'memo' ? '备忘' : (this.data.filter === 'buy' ? '购物' : '待办 · 备忘与购物');
    const open = this.data.taskOpen || { undone: true, done: false };
    return { show: ts.length > 0, tit, sum, undone, done, doneN: dn, openU: open.undone !== false, openD: open.done === true };
  },

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
    return { m, state };
  },
  // 重置并加载第一页 + 统计总数
  resetLoad() {
    this._cursor = null;
    this.setData({ recs: [], hasMore: true, loading: false, empty: false });
    this.loadMore(true);
    this.loadStats();
  },
  // 加载一页（first=true 为首屏/刷新）；有搜索词时走全量搜索
  loadMore(first) {
    if (this._loading) return;
    if (!first && !this.data.hasMore) return;
    if (this.data.q.trim()) { this.fullSearch(); return; }
    this._loading = true;
    this.setData({ loading: true });
    const q = this.effQuery();
    const params = {
      before: first ? null : this._cursor,
      limit: 20,
      m: q.m,
      startTs: this.data.rangeStart,
      state: q.state,
      // 已加载的文档 id：配合 lte 游标去重，避免同毫秒记录被跳过或重复
      excludeIds: first ? null : (this.data.recs || []).map(r => r._rid)
    };
    store.loadRecordsPage(params).then(({ list, hasMore, nextCursor }) => {
      this._cursor = nextCursor;
      const recs = first ? list : this.data.recs.concat(list);
      this._loading = false;
      this.setData({ recs, hasMore, loading: false }, () => {
        this.rebuild();
        if (first) wx.stopPullDownRefresh();   // 首屏/刷新加载完，收起原生下拉
        // 没有更多了 + 内容够长 → 这时才提示可以点底部当前 tab 回顶
        if (!hasMore && recs.length > 10) this.hintTabTop();
      });
    }).catch(() => {
      this._loading = false;
      this.setData({ loading: false, hasMore: false });
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
    if (this.data.q.trim()) return;
    if (f === 'memo' || f === 'buy') { this.setData({ stat: {} }, () => this.rebuild()); return; }
    if (f === 'all') {
      store.countByModule({ startTs }).then(byMod => this.setData({ stat: { byMod } }, () => this.rebuild()));
      return;
    }
    if (f === 'want') {
      store.countByStatus({ startTs }).then(bySt => this.setData({ stat: { bySt } }, () => this.rebuild()));
      return;
    }
    const jobs = [store.countRecords({ m: f, startTs }), store.countByTxt({ m: f, startTs })];
    if (f === 'obs') {
      jobs.push(store.countRecords({ m: 'obs', startTs, extTag: '忘了时间' }));
      jobs.push(store.countRecords({ m: 'obs', startTs, extTag: '充电' }));
      jobs.push(store.countRecords({ m: 'obs', startTs, extTag: '耗电' }));
    }
    Promise.all(jobs).then(([total, tops, fg, chg, tire]) => {
      const stat = { total: total || 0, tops: tops || [] };
      if (f === 'obs') stat.ext = { '忘了时间': fg || 0, '充电': chg || 0, '耗电': tire || 0 };
      this.setData({ stat }, () => this.rebuild());
    });
  },
  // 搜索：全量拉取后客户端过滤（搜索需覆盖全部记录，不走游标分页）
  fullSearch() {
    this._loading = true;
    this.setData({ loading: true, hasMore: false });
    const q = this.effQuery();
    const params = { m: q.m, startTs: this.data.rangeStart };
    store.loadAllRecords(params).then(all => {
      const q2 = this.data.q.trim().toLowerCase();
      const list = all.filter(r => (r.txt + ' ' + (r.ext || []).join(' ')).toLowerCase().indexOf(q2) >= 0);
      this._loading = false;
      this.setData({ recs: list, loading: false }, () => this.rebuild());
    }).catch(() => {
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
  // 待完成 / 已完成 折叠切换
  onTaskFold(e) {
    const k = e.currentTarget.dataset.k;
    const open = Object.assign({}, this.data.taskOpen || { undone: true, done: false });
    open[k] = !open[k];
    this.setData({ taskOpen: open });
    this.rebuild();
  },
  onFilter(e) {
    this.data.filter = e.currentTarget.dataset.f;
    this.data.stateFilter = 'all';
    this.setData({ filter: this.data.filter, stateFilter: 'all', sel: null, selRec: null });
    this.resetLoad();
  },
  // 可以 维度下的状态切换：未做 / 在做 / 做了
  onStateFilter(e) {
    this.data.stateFilter = e.currentTarget.dataset.s;
    this.setData({ stateFilter: this.data.stateFilter });
    this.resetLoad();
  },
  // 快捷时间选择：全部 / 今天 / 近7天 / 近30天
  onRange(e) {
    const r = e.currentTarget.dataset.r;
    const map = { all: '全部', today: '今天', '7d': '近7天', '30d': '近30天' };
    this.setData({ range: r, rangeLabel: map[r] || '全部', rangeStart: this.rangeStartOf(r), stateFilter: 'all' });
    this.resetLoad();
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

  onTabReselect() {
    this.closeSel();
    wx.pageScrollTo({ scrollTop: 0, duration: 300 });
  },

  /* 页面滚动：顺手收起记录操作条（页面级滚动下微信会同步原生输入层位置） */
  onPageScroll(e) {
    this._pageTop = e.scrollTop || 0;
    this.closeSel();
  },

  /* 页面级下拉刷新入口（原生下拉回弹，与记页一致）；
     下拉时程序名正好从胶囊后露出来，顺手播一次逐字浮现 */
  onPullDownRefresh() {
    this.playBrand();
    this.onRefresh();
  },

  /* 下拉刷新：重置首屏（首屏加载完会收起原生下拉） */
  onRefresh() {
    this.resetLoad();
  },

  /* ---------------- 记录操作 ---------------- */
  findRec(id) {
    return (app.globalData.records || []).find(x => x.id === id) || (this.data.recs || []).find(x => x.id === id);
  },
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
    const id = e.currentTarget.dataset.id;
    const r = (this.data.recs || []).find(x => x.id === id);
    if (!r || !store.isTask(r.m)) return;
    r.done = !r.done; r.doneAt = r.done ? Date.now() : 0;
    store.updateRecord(r).catch(() => {});
    this.syncGlobal(id, gr => { gr.done = r.done; gr.doneAt = r.doneAt; });
    this.setData({ recs: this.data.recs.slice() }, () => this.rebuild());
  },

  /* ---------------- 长按记录（与清单 / 记页共用 inline-editor） ----------------
     待办：就地快捷改；其它维度：与点「改」等价，跳记页完整编辑 */
  onRowLongPress(e) {
    const id = e.currentTarget.dataset.id;
    const r = this.findRec(id);
    if (!r) return;
    this._lpAt = Date.now();   // 长按后紧跟着的那次点击要忽略掉
    if (store.isTask(r.m)) { this._openEdit(id, r.txt || ''); return; }
    app.globalData.editRec = store.decorate(r);
    this.setData({ sel: null, selRec: null });
    wx.switchTab({ url: '/pages/index/index' });
  },

  /* 量取该行「整张卡片」的位置（文档坐标）→ 赋值并打开编辑器（量好再显示，避免闪到上一次的位置） */
  _openEdit(id, txt) {
    const q = wx.createSelectorQuery().in(this);
    q.selectViewport().scrollOffset();
    q.select('#erow-' + id).boundingClientRect();
    q.exec(res => {
      const scrollTop = (res[0] && res[0].scrollTop) || 0;
      const rect = res[1];
      if (!rect) return;
      this.setData({
        ed: {
          top: Math.round(rect.top + scrollTop),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        sel: null, selRec: null,
        edId: id, edTxt: txt, editing: true, edFocus: false
      });
      // 兜底：万一 touchend 没触发（手势被系统吞掉），500ms 后自己聚焦
      if (this._focusTimer) clearTimeout(this._focusTimer);
      this._focusTimer = setTimeout(() => {
        if (this.data.editing && !this.data.edFocus) this.onRowTouchend();
      }, 500);
    });
  },

  /* 手指抬起后再聚焦：长按过程中就聚焦的话，抬手瞬间微信的「点到外面」会把输入框 blur 掉，
     表现为「一松手输入框就关了」 */
  onRowTouchend() {
    if (!this.data.editing || this.data.edFocus) return;
    this._focusAt = Date.now();
    this.setData({ edFocus: true });
  },

  /* 组件派发 save：失焦 / 键盘「完成」/ 点「保存」都走这里；改空或没改动则不落云 */
  onEditSave(e) {
    if (this._closing) return;
    // 刚聚焦就被系统「点到外面」blur 掉（长按抬手那一下）：忽略，不要当成用户改完了
    if (this._focusAt && Date.now() - this._focusAt < 400) return;
    const id = this.data.edId;
    if (!id || !this.data.editing) return;
    const txt = ((e.detail && e.detail.value) || '').trim();
    const i = (this.data.recs || []).findIndex(x => x.id === id);
    const r = i >= 0 ? this.data.recs[i] : this.findRec(id);
    if (!r || !store.isTask(r.m) || !txt || txt === r.txt) { this._closeEdit(); return; }
    r.txt = txt;
    store.updateRecord(r).catch(() => {});
    this.syncGlobal(id, gr => { gr.txt = txt; });
    this._closeEdit();
    this.setData({ recs: this.data.recs.slice() }, () => this.rebuild());
    wx.showToast({ title: '已更新', icon: 'none' });
  },

  /* 收起：位置原地不动，只把宽高收成 0。
     一挪位置，微信会把「带焦点的输入框」滚进可视区（键盘重弹 + 页面跳回顶部）；
     挪走之前保留 edId，让那一行继续隐身，避免与原生层残留互相重影 */
  _closeEdit() {
    this._closing = true;
    setTimeout(() => { this._closing = false; }, 150);
    this._focusAt = 0;
    const ed = this.data.ed || {};
    this.setData({
      editing: false,
      edFocus: false,
      edId: '',
      edTxt: '',
      ed: { top: ed.top || 0, left: ed.left || 0, width: 0, height: 0 }
    });
  },

  /* 还要改分类等更多字段：点条目走操作条里的「改」；这里只做删除 */
  onEditDel() {
    const r = this.findRec(this.data.edId);
    this._closeEdit();
    if (!r || !store.isTask(r.m)) return;
    this._delRec(r);
  },

  onRecTap(e) {
    if (this._lpAt && Date.now() - this._lpAt < 400) return;   // 长按刚触发过，忽略随之而来的点击
    const id = e.currentTarget.dataset.id;
    if (this.data.sel === id) { this.setData({ sel: null, selRec: null }); return; }
    const r = this.findRec(id);
    this.setData({ sel: id, selRec: r ? { m: store.recMname(r), txt: r.txt, rawm: r.m, status: r.status || '', ended: !!r.endTs } : null });
  },

  /* 记录操作条统一入口（与记页共用 rec-actions 组件；看页行为：流转/改/结束 跳到记页（结束时间待「保存修改」时才记），恢复/删 本地直接处理）
     type: start | complete | abandon | restore | end | edit | del */
  onRecAction(e) {
    const type = e.detail.type;
    const id = this.data.sel; if (id == null) return;
    const r = this.findRec(id);
    if (!r) return;
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
  _stopDelTimer() { if (this._delTimer) { clearTimeout(this._delTimer); this._delTimer = null; } },
  _startDelTimer() {
    this._stopDelTimer();
    this._delTimer = setTimeout(() => {
      if (this.data.delUndo) this.setData({ delUndo: null });
    }, 3000);
  },

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
});
