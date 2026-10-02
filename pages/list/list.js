// pages/list/list.js —— 清单：备忘 / 购物 快捷查看
const store = require('../../utils/store.js');
const app = getApp();

Page({
  data: {
    theme: 'sand',
    statusH: 20,
    refreshing: false,
    seg: 'all',            // all | memo | buy
    cmemo: store.mcolor('memo'),
    cbuy: store.mcolor('buy'),
    show: false,
    tit: '待办 · 备忘与购物',
    sum: '',
    undone: [],
    done: [],
    empty: false
  },

  onShow() {
    this.ensureTheme();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 4, theme: wx.getStorageSync('theme') || 'sand' });
    }
    store.ensureAll().then(() => this.rebuild());
  },

  ensureTheme() {
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    this.setData({ theme: wx.getStorageSync('theme') || 'sand', statusH: info.statusBarHeight || 20 });
  },

  recVM(r) {
    return {
      id: r.id, m: store.mname(r.m), c: store.mcolor(r.m),
      txt: r.txt, t: r.t,
      done: !!r.done, doneLabel: store.doneLabel(r.doneAt),
      reason: r.reason || '', usefor: r.usefor || ''
    };
  },

  rebuild() {
    const all = (app.globalData.records || []).filter(r => store.isTask(r.m));
    const seg = this.data.seg;
    const list = seg === 'all' ? all : all.filter(r => r.m === seg);
    const undone = list.filter(r => !r.done).map(r => this.recVM(r));
    const done = list.filter(r => r.done).map(r => this.recVM(r));
    undone.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    const u = undone.length, dn = done.length;
    const sum = u ? (u + ' 项待完成' + (dn ? ' · 已完成 ' + dn : '')) : (dn ? '全部完成 · ' + dn + ' 条' : '');
    const tit = seg === 'memo' ? '备忘' : (seg === 'buy' ? '购物' : '待办 · 备忘与购物');
    this.setData({ show: list.length > 0, tit, sum, undone, done, empty: list.length === 0 });
  },

  onSeg(e) {
    this.data.seg = e.currentTarget.dataset.s;
    this.setData({ seg: this.data.seg });
    this.rebuild();
  },

  onCheck(e) {
    const id = e.currentTarget.dataset.id;
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r || !store.isTask(r.m)) return;
    r.done = !r.done; r.doneAt = r.done ? Date.now() : 0;
    store.updateRecord(r).catch(() => {});
    this.rebuild();
  },

  onRefresh() {
    this.setData({ refreshing: true });
    store.loadRecords().then(list => {
      app.globalData.records = list;
      this.setData({ refreshing: false });
      this.rebuild();
    }).catch(() => this.setData({ refreshing: false }));
  }
});
