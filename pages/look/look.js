// pages/look/look.js —— 看
const store = require('../../utils/store.js');
const app = getApp();

function dmClass(m) {
  return ['obs', 'now', 'want', 'nope', 'done', 'memo', 'buy', 'like'].indexOf(m) >= 0 ? 'dm-' + m : 'dm-custom';
}
// 取一条「想做」记录的分类值（想要/可做/喜欢…）
function wantKindOf(r) {
  const i = (r.extSrc || []).indexOf('wantKind');
  return i >= 0 ? String((r.ext || [])[i] || '') : '';
}

Page({
  data: {
    theme: 'mint',
    statusH: 20,
    modules: [],
    filter: 'all',
    filterName: '全部',
    kindFilter: 'all',
    kinds: [],
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
    refreshing: false,
    // 游标分页 + 快捷时间
    range: 'all',
    rangeLabel: '全部',
    rangeStart: null,
    hasMore: true,
    loading: false,
    total: 0
  },

  onLoad() {
    this._cursor = null;
    this._loading = false;
    this._searchTimer = null;
  },

  onShow() {
    this.ensureTheme();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 1, theme: store.curTheme() });
    this.setData({ sel: null, selRec: null, delUndo: null });
    store.ensureAll().then(() => { this.resetLoad(); });
  },

  ensureTheme() {
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    this.setData({ theme: store.curTheme(), statusH: info.statusBarHeight || 20 });
  },

  modulesVM() {
    return store.MODULES;
  },

  recVM(r) {
    const dt = store.buildExt(r.m, r.ext, r.extSrc);
    const ago = store.agoOf(r.ts);
    const d = ago <= 0 ? '' : (ago === 1 ? '昨天' : (ago === 2 ? '前天' : store.dayLabel(ago))) + ' ';
    const task = store.isTask(r.m);
    return { id: r.id, m: store.recMname(r), c: store.mcolor(r.m), dm: dmClass(r.m), txt: r.txt, t: r.t, d, dt, task, done: !!r.done, doneLabel: store.doneLabel(r.doneAt), reason: r.reason || '', usefor: r.usefor || '' };
  },

  buildStats(filter, list, totalOverride) {
    // 备忘 / 购物是待办，不展示统计，只在下面清单里看
    if (filter === 'memo' || filter === 'buy') return { hide: true };
    // 「全部」统计不计备忘/购物：它们属于待办，单独在清单里看（展示全部觉察维度，不截断）
    const awareList = filter === 'all' ? list.filter(r => !store.isTask(r.m)) : list;
    const allMods = store.MODULES.filter(m => !store.isTask(m.k));
    if (filter === 'all') {
      const counts = allMods.map(m => ({ n: m.n, c: m.c, n2: awareList.filter(r => r.m === m.k).length }));
      const mx = Math.max(1, ...counts.map(c => c.n2));
      const total = totalOverride != null ? totalOverride : awareList.length;
      return { all: true, total, bars: counts.map(c => ({ n: c.n, c: c.c, n2: c.n2, w: Math.round(c.n2 / mx * 100) + '%' })) };
    }
    const acc = {};
    list.forEach(r => { acc[r.txt] = (acc[r.txt] || 0) + 1; });
    const keys = Object.keys(acc).sort((a, b) => acc[b] - acc[a]).slice(0, 4);
    const mxv = keys.length ? acc[keys[0]] : 1;
    const bars = keys.map(k => ({ n: k, c: store.mcolor(filter), n2: acc[k], w: Math.round(acc[k] / mxv * 100) + '%' }));
    const labelMap = { obs: '观察最多的事', now: '最常在做的事', want: '最常想做的事', nope: '最常不想的事', done: '做得最多的事', memo: '记得最多的事', buy: '最常买的东西', like: '最常喜欢的事' };
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
    const list = all.filter(r => {
      const f1 = this.data.filter === 'all' || r.m === this.data.filter;
      const f1b = this.data.filter !== 'want' || this.data.kindFilter === 'all' || wantKindOf(r) === this.data.kindFilter;
      const f2 = !q || (r.txt + ' ' + (r.ext || []).join(' ')).toLowerCase().indexOf(q) >= 0;
      return f1 && f1b && f2;
    });
    // 备忘 / 购物是待办，不进时间流：抽出来平铺成清单；觉察记录才按天分组
    const tasks = list.filter(r => store.isTask(r.m));
    const aware = list.filter(r => !store.isTask(r.m));
    const map = {}, days = [];
    aware.forEach(r => { if (!map[r.day]) { map[r.day] = []; days.push(r.day); } map[r.day].push(this.recVM(r)); });
    const groups = days.map(d => ({ day: d, recs: map[d] }));
    const stats = this.buildStats(this.data.filter, list, q ? null : this.data.total);
    this.setData({
      modules: this.modulesVM(),
      filterName: this.data.filter === 'all' ? '全部' : store.mname(this.data.filter),
      kinds: this.data.filter === 'want' ? store.getOPT('wantKind') : [],
      days: groups,
      tasks: this.buildTasks(tasks),
      empty: groups.length === 0 && tasks.length === 0,
      stats
    });
  },

  /* 待办清单：未完成在上（按时间倒序），已完成沉底（按完成时间倒序）；待完成/已完成各自可折叠 */
  buildTasks(ts) {
    const undone = ts.filter(r => !r.done).map(r => this.recVM(r));
    const done = ts.filter(r => r.done).map(r => this.recVM(r));
    undone.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    const u = undone.length, dn = done.length;
    const sum = u ? (u + ' 项待完成' + (dn ? ' · 已完成 ' + dn : '')) : (dn ? '全部完成 · ' + dn + ' 条' : '');
    const tit = this.data.filter === 'memo' ? '备忘' : (this.data.filter === 'buy' ? '购物' : '待办 · 备忘与购物');
    const open = this.data.taskOpen || { undone: true, done: false };
    return { show: ts.length > 0, tit, sum, undone, done, doneN: dn, openU: open.undone !== false, openD: open.done === true };
  },

  /* ---------------- 游标分页 ---------------- */
  // 重置并加载第一页 + 统计总数
  resetLoad() {
    this._cursor = null;
    this.setData({ recs: [], hasMore: true, loading: false, empty: false });
    this.loadMore(true);
    this.loadCount();
  },
  // 加载一页（first=true 为首屏/刷新）；有搜索词时走全量搜索
  loadMore(first) {
    if (this._loading) return;
    if (!first && !this.data.hasMore) return;
    if (this.data.q.trim()) { this.fullSearch(); return; }
    this._loading = true;
    this.setData({ loading: true });
    const params = {
      before: first ? null : this._cursor,
      limit: 20,
      m: this.data.filter === 'all' ? null : this.data.filter,
      startTs: this.data.rangeStart
    };
    store.loadRecordsPage(params).then(({ list, hasMore, nextCursor }) => {
      this._cursor = nextCursor;
      const recs = first ? list : this.data.recs.concat(list);
      this._loading = false;
      this.setData({ recs, hasMore, loading: false }, () => {
        this.rebuild();
        if (first && this.data.refreshing) this.setData({ refreshing: false });
      });
    }).catch(() => {
      this._loading = false;
      this.setData({ loading: false, hasMore: false, refreshing: false });
    });
  },
  // 上拉触底：加载更多
  onLoadMore() { this.loadMore(false); },
  // 统计当前 模块 + 时间范围 下的总数
  loadCount() {
    const m = this.data.filter === 'all' ? null : this.data.filter;
    store.countRecords({ m, startTs: this.data.rangeStart }).then(t => this.setData({ total: t }));
  },
  // 搜索：全量拉取后客户端过滤（搜索需覆盖全部记录，不走游标分页）
  fullSearch() {
    this._loading = true;
    this.setData({ loading: true, hasMore: false });
    const params = { m: this.data.filter === 'all' ? null : this.data.filter, startTs: this.data.rangeStart };
    store.loadAllRecords(params).then(all => {
      const q = this.data.q.trim().toLowerCase();
      const list = all.filter(r => (r.txt + ' ' + (r.ext || []).join(' ')).toLowerCase().indexOf(q) >= 0);
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
    this.data.kindFilter = 'all';
    this.setData({ filter: this.data.filter, kindFilter: 'all', sel: null, selRec: null });
    this.resetLoad();
  },
  // 想做模块二级分类筛选（想要/可做/喜欢…）
  onKindFilter(e) {
    this.data.kindFilter = e.currentTarget.dataset.k;
    this.setData({ kindFilter: this.data.kindFilter });
    this.resetLoad();
  },
  // 快捷时间选择：全部 / 今天 / 近7天 / 近30天
  onRange(e) {
    const r = e.currentTarget.dataset.r;
    const map = { all: '全部', today: '今天', '7d': '近7天', '30d': '近30天' };
    this.setData({ range: r, rangeLabel: map[r] || '全部', rangeStart: this.rangeStartOf(r), kindFilter: 'all' });
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

  /* 下拉刷新：重置首屏（首屏加载完会自动收起 refresher） */
  onRefresh() {
    this.setData({ refreshing: true });
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

  onRecTap(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.sel === id) { this.setData({ sel: null, selRec: null }); return; }
    const r = this.findRec(id);
    this.setData({ sel: id, selRec: r ? { m: store.recMname(r), txt: r.txt } : null });
  },

  /* 点页面其它地方：收起记录操作条（失焦即关） */
  closeSel() {
    if (this.data.sel != null) this.setData({ sel: null, selRec: null });
  },

  onActEdit() {
    const id = this.data.sel; if (id == null) return;
    const r = this.findRec(id);
    if (!r) return;
    app.globalData.editRec = r;
    this.setData({ sel: null, selRec: null });
    wx.switchTab({ url: '/pages/index/index' });
  },

  onActDel() {
    const id = this.data.sel; if (id == null) return;
    const i = (this.data.recs || []).findIndex(x => x.id === id);
    if (i < 0) return;
    const r = this.data.recs[i];
    store.deleteRecord(r).then(() => {
      const recs = this.data.recs.slice(); recs.splice(i, 1);
      this.syncGlobalDel(id);
      this.setData({ recs, sel: null, selRec: null, delUndo: { m: store.recMname(r), txt: r.txt, dump: r } }, () => this.rebuild());
    });
  },

  onUndoDel() {
    const u = this.data.delUndo; if (!u) return;
    const dump = u.dump;
    const rec = { m: dump.m, t: dump.t, txt: dump.txt, ext: dump.ext || [], extSrc: dump.extSrc || [], ts: dump.ts, done: dump.done || false, doneAt: dump.doneAt || 0 };
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
