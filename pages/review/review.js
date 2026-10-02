// pages/review/review.js —— 回看
const store = require('../../utils/store.js');
const app = getApp();

Page({
  data: {
    theme: 'sand',
    statusH: 20,
    sum: [],
    kpis: [],
    heat: { cells: [], sum: '' },
    ev: { total: 0, groups: [], open: true },
    refreshing: false
  },

  onShow() {
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    this.setData({ theme: wx.getStorageSync('theme') || 'sand', statusH: info.statusBarHeight || 20 });
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 2, theme: wx.getStorageSync('theme') || 'sand' });
    store.ensureAll().then(() => { this.rebuild(); });
  },

  rebuild() {
    const recs = app.globalData.records || [];
    this.setData({
      sum: this.buildSummary(recs),
      kpis: this.buildKpis(recs),
      heat: this.buildHeat(recs),
      ev: this.buildEvents(recs)
    });
  },

  buildSummary(recs) {
    const extAcc = (ext) => { const a = {}; recs.forEach(r => { if (r.m === 'obs' && (r.ext || []).indexOf(ext) >= 0) a[r.txt] = (a[r.txt] || 0) + 1; }); return a; };
    const modAcc = (m) => { const a = {}; recs.forEach(r => { if (r.m === m) a[r.txt] = (a[r.txt] || 0) + 1; }); return a; };
    const leader = (a) => { const ks = Object.keys(a); if (!ks.length) return null; let mx = 0; ks.forEach(k => { if (a[k] > mx) mx = a[k]; }); return ks.filter(k => a[k] === mx).join('、'); };
    const cObs = store.mcolor('obs'), cWant = store.mcolor('want'), cNope = store.mcolor('nope'), cDone = store.mcolor('done');
    return [
      { k: '沉浸最深', c: cObs, v: leader(extAcc('忘了时间')) },
      { k: '耗能最多', c: cObs, v: leader(extAcc('耗电')) },
      { k: '充电最多', c: cObs, v: leader(extAcc('充电')) },
      { k: '最想做', c: cWant, v: leader(modAcc('want')) },
      { k: '最不想做', c: cNope, v: leader(modAcc('nope')) },
      { k: '做得最多', c: cDone, v: leader(modAcc('done')) }
    ];
  },

  buildKpis(recs) {
    const days = new Set(recs.map(r => { const d = new Date(r.ts); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); })).size;
    return [{ n: recs.length, l: '总记录' }, { n: days, l: '活跃天数' }];
  },

  buildHeat(recs) {
    const cnt = new Array(30).fill(0);
    recs.forEach(r => { const a = (r.ago == null ? 0 : r.ago); if (a >= 0 && a < 30) cnt[29 - a]++; });
    let mx = 1; cnt.forEach(n => { if (n > mx) mx = n; });
    const cells = cnt.map(n => ({ lv: n ? (mx <= 1 ? 2 : (n === mx ? 3 : (n * 2 >= mx ? 2 : 1))) : 0 }));
    const act = cnt.filter(n => n).length;
    const sum = act ? `近 30 天有记录 ${act} 天 · 最多一天 ${mx} 条` : '近 30 天还没有记录';
    return { cells, sum };
  },

  buildEvents(recs) {
    const groups = {}, keys = [];
    recs.forEach(r => {
      if (!groups[r.txt]) { groups[r.txt] = { minAgo: r.ago, count: 0, mods: {} }; keys.push(r.txt); }
      const g = groups[r.txt];
      if (r.ago < g.minAgo) g.minAgo = r.ago;
      g.count++;
      (g.mods[r.m] = g.mods[r.m] || []).push(r);
    });
    keys.sort((a, b) => groups[a].minAgo - groups[b].minAgo);
    const order = store.MODULES;
    const evGroups = keys.map(txt => {
      const g = groups[txt];
      const dims = [];
      order.forEach(m => {
        const rs = g.mods[m.k]; if (!rs || !rs.length) return;
        const rows = rs.map(r => {
          const det = store.buildExt(r.m, r.ext, r.extSrc).map(it => it.lbl ? it.lbl + '：' + it.v : it.v).join(' · ');
          const ago = store.agoOf(r.ts);
          const d = ago <= 0 ? '' : (ago === 1 ? '昨天' : (ago === 2 ? '前天' : store.dayLabel(ago))) + ' ';
          return { d: d + r.t, x: det };
        });
        dims.push({ n: m.n, c: m.c, rows });
      });
      return { txt, count: g.count, dims };
    });
    return { total: recs.length, groups: evGroups, open: this.data.ev.open };
  },

  onToggleEv() { this.setData({ 'ev.open': !this.data.ev.open }); },

  /* 下拉刷新：从云端重新拉取全部数据 */
  onRefresh() {
    this.setData({ refreshing: true });
    store.reload().then(() => { this.rebuild(); this.setData({ refreshing: false }); })
      .catch(() => this.setData({ refreshing: false }));
  }
});
