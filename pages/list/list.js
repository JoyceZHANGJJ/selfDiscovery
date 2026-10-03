// pages/list/list.js —— 清单：备忘 / 购物 快捷查看
const store = require('../../utils/store.js');
const app = getApp();

Page({
  data: {
    theme: 'sand',
    statusH: 20,
    seg: 'all',            // all | memo | buy
    cmemo: store.mcolor('memo'),
    cbuy: store.mcolor('buy'),
    show: false,
    tit: '待办 · 备忘与购物',
    sum: '',
    undone: [],
    done: [],
    empty: false,
    // 长按就地编辑：这一条直接变成输入框
    edId: '',
    edTxt: ''
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

  /* 页面级下拉刷新入口（原生下拉回弹，与记页一致） */
  onPullDownRefresh() { this.onRefresh(); },

  onRefresh() {
    store.loadRecords().then(list => {
      app.globalData.records = list;
      wx.stopPullDownRefresh();
      this.rebuild();
    }).catch(() => wx.stopPullDownRefresh());
  },

  /* ---------------- 长按就地编辑 ---------------- */
  findRec(id) {
    return (app.globalData.records || []).find(x => x.id === id) || null;
  },

  /* 长按某条待办：这一行直接变成输入框 */
  onLongPress(e) {
    const id = e.currentTarget.dataset.id;
    const r = this.findRec(id);
    if (!r || !store.isTask(r.m)) return;
    this.setData({ edId: id, edTxt: r.txt || '' });
  },

  onEdTxt(e) { this.setData({ edTxt: e.detail.value }); },

  /* 保存：失焦 / 键盘「完成」/ 点「保存」都走这里；改空或没改动则不落云 */
  onEditSave() {
    const id = this.data.edId;
    if (!id) return;
    const txt = (this.data.edTxt || '').trim();
    const r = this.findRec(id);
    const close = () => this.setData({ edId: '', edTxt: '' });
    if (!r || !store.isTask(r.m) || !txt || txt === r.txt) { close(); return; }
    r.txt = txt;
    store.updateRecord(r).catch(() => {});
    close();
    this.rebuild();
    wx.showToast({ title: '已更新', icon: 'none' });
  },

  /* 还要改分类、时间等更多字段：跳记页做完整编辑 */
  onEditHome(e) {
    const r = this.findRec(e.currentTarget.dataset.id);
    if (!r || !store.isTask(r.m)) return;
    app.globalData.editRec = store.decorate(r);
    this.setData({ edId: '', edTxt: '' });
    wx.switchTab({ url: '/pages/index/index' });
  }
});
