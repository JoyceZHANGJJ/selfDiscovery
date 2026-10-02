// pages/look/look.js —— 看
const store = require('../../utils/store.js');
const app = getApp();

function dmClass(m) {
  return ['obs', 'now', 'want', 'nope', 'done'].indexOf(m) >= 0 ? 'dm-' + m : 'dm-custom';
}

Page({
  data: {
    theme: 'sand',
    statusH: 20,
    modules: [],
    filter: 'all',
    filterName: '全部',
    q: '',
    days: [],
    stats: {},
    sel: null,
    selRec: null,
    delUndo: null,
    refreshing: false
  },

  onShow() {
    this.ensureTheme();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 1, theme: wx.getStorageSync('theme') || 'sand' });
    this.setData({ sel: null, selRec: null, delUndo: null });
    store.ensureAll().then(() => { this.rebuild(); });
  },

  ensureTheme() {
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    this.setData({ theme: wx.getStorageSync('theme') || 'sand', statusH: info.statusBarHeight || 20 });
  },

  modulesVM() {
    return store.MODULES;
  },

  recVM(r) {
    const dt = store.buildExt(r.m, r.ext, r.extSrc);
    const ago = store.agoOf(r.ts);
    const d = ago <= 0 ? '' : (ago === 1 ? '昨天' : (ago === 2 ? '前天' : store.dayLabel(ago))) + ' ';
    return { id: r.id, m: store.mname(r.m), c: store.mcolor(r.m), dm: dmClass(r.m), txt: r.txt, t: r.t, d, dt };
  },

  buildStats(filter, list) {
    const allMods = store.MODULES;
    if (filter === 'all') {
      const counts = allMods.map(m => ({ n: m.n, c: m.c, n2: list.filter(r => r.m === m.k).length }));
      const mx = Math.max(1, ...counts.map(c => c.n2));
      return { all: true, total: list.length, bars: counts.map(c => ({ n: c.n, c: c.c, n2: c.n2, w: Math.round(c.n2 / mx * 100) + '%' })) };
    }
    const acc = {};
    list.forEach(r => { acc[r.txt] = (acc[r.txt] || 0) + 1; });
    const keys = Object.keys(acc).sort((a, b) => acc[b] - acc[a]).slice(0, 4);
    const mxv = keys.length ? acc[keys[0]] : 1;
    const bars = keys.map(k => ({ n: k, c: store.mcolor(filter), n2: acc[k], w: Math.round(acc[k] / mxv * 100) + '%' }));
    const labelMap = { obs: '观察最多的事', now: '最常在做的事', want: '最常想做的事', nope: '最常不想的事', done: '做得最多的事' };
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
    const all = app.globalData.records || [];
    const q = this.data.q.trim().toLowerCase();
    const list = all.filter(r => {
      const f1 = this.data.filter === 'all' || r.m === this.data.filter;
      const f2 = !q || (r.txt + ' ' + (r.ext || []).join(' ')).toLowerCase().indexOf(q) >= 0;
      return f1 && f2;
    });
    const map = {}, days = [];
    list.forEach(r => { if (!map[r.day]) { map[r.day] = []; days.push(r.day); } map[r.day].push(this.recVM(r)); });
    const groups = days.map(d => ({ day: d, recs: map[d] }));
    const stats = this.buildStats(this.data.filter, list);
    this.setData({
      modules: this.modulesVM(),
      filterName: this.data.filter === 'all' ? '全部' : store.mname(this.data.filter),
      days: groups,
      stats
    });
  },

  onSearch(e) { this.data.q = e.detail.value; this.rebuild(); },
  onFilter(e) {
    this.data.filter = e.currentTarget.dataset.f;
    this.setData({ filter: this.data.filter, sel: null, selRec: null });
    this.rebuild();
  },

  onRecTap(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.sel === id) { this.setData({ sel: null, selRec: null }); return; }
    const r = (app.globalData.records || []).find(x => x.id === id);
    this.setData({ sel: id, selRec: r ? { m: store.mname(r.m), txt: r.txt } : null });
  },

  onActEdit() {
    const id = this.data.sel; if (id == null) return;
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r) return;
    app.globalData.editRec = r;
    this.setData({ sel: null, selRec: null });
    wx.switchTab({ url: '/pages/index/index' });
  },

  onActDel() {
    const id = this.data.sel; if (id == null) return;
    const i = (app.globalData.records || []).findIndex(x => x.id === id);
    if (i < 0) return;
    const r = app.globalData.records[i];
    store.deleteRecord(r).then(() => {
      app.globalData.records.splice(i, 1);
      this.setData({ sel: null, selRec: null, delUndo: { m: store.mname(r.m), txt: r.txt, dump: r } });
      this.rebuild();
    });
  },

  onUndoDel() {
    const u = this.data.delUndo; if (!u) return;
    const dump = u.dump;
    const rec = { m: dump.m, t: dump.t, txt: dump.txt, ext: dump.ext || [], extSrc: dump.extSrc || [], ts: dump.ts };
    store.addRecord(rec).then(rid => {
      rec._rid = rid; rec.id = rid;
      app.globalData.records.unshift(store.decorate(rec));
      this.setData({ delUndo: null });
      this.rebuild();
    });
  },

  onRefresh() {
    this.setData({ refreshing: true });
    store.loadRecords().then(list => { app.globalData.records = list; this.setData({ refreshing: false }); this.rebuild(); });
  }
});
