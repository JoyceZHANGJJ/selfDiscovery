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
    // 删除后的撤销条（与记 / 看页同一套）
    delUndo: null,
    // 长按就地编辑：全局唯一一个编辑器，叠加到被长按的那一行
    editing: false,
    edFocus: false,       // 显示与聚焦分开：手指抬起后才聚焦（见 onRowTouchend）
    edId: '',
    edTxt: '',
    ed: { top: 0, left: 0, width: 0, height: 0 }
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
      txt: r.txt,
      // 待办的时间：今天显示时刻，非今天显示简洁日期（避免只有 HH:MM 看不出是哪天）
      t: r.tt || r.t,
      done: !!r.done, doneLabel: store.doneLabel(r.doneAt),
      reason: r.reason || '', usefor: r.usefor || ''
    };
  },

  rebuild() {
    const all = (app.globalData.records || []).filter(r => store.isTask(r.m));
    const seg = this.data.seg;
    const list = seg === 'all' ? all : all.filter(r => r.m === seg);
    // 注意：recVM 的产物里没有 ts / doneAt，必须在 map 之前对原始记录排序，
    // 否则 sort 比较的全是 undefined，等于没排（已完成要按完成时间倒序，就是这个坑）
    const undone = list.filter(r => !r.done).sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(r => this.recVM(r));
    const done = list.filter(r => r.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).map(r => this.recVM(r));
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

  /* ---------------- 长按就地编辑（全局唯一编辑器） ---------------- */
  findRec(id) {
    return (app.globalData.records || []).find(x => x.id === id) || null;
  },

  /* 长按某条待办：先量好位置再显示，避免编辑器先闪一下上一次的位置 */
  onLongPress(e) {
    const id = e.currentTarget.dataset.id;
    const r = this.findRec(id);
    if (!r || !store.isTask(r.m)) return;
    this._openEdit(id, r.txt || '');
  },

  /* 量取该行「整张卡片」的位置（文档坐标）→ 赋值并打开编辑器：
     编辑器做成和卡片同尺寸盖上去（同内边距/圆角/边框），页面滚动时跟着原行走 */
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

  /* 保存：失焦 / 键盘「完成」/ 点「保存」由组件派发 save；改空或没改动则不落云 */
  onEditSave(e) {
    if (this._closing) return;   // 失焦与「完成」可能连着触发两次，收起中直接忽略
    // 刚聚焦就被系统「点到外面」blur 掉（长按抬手那一下）：忽略，不要当成用户改完了
    if (this._focusAt && Date.now() - this._focusAt < 400) return;
    const id = this.data.edId;
    if (!id || !this.data.editing) return;
    const txt = ((e.detail && e.detail.value) || '').trim();
    const r = this.findRec(id);
    if (!r || !store.isTask(r.m) || !txt || txt === r.txt) { this._closeEdit(); return; }
    r.txt = txt;
    store.updateRecord(r).catch(() => {});
    this._closeEdit();
    this.rebuild();
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

  /* 就地编辑里的「删除」：删掉这条待办，并给出撤销机会（与记 / 看页一致） */
  onEditDel() {
    const r = this.findRec(this.data.edId);
    this._closeEdit();
    if (!r || !store.isTask(r.m)) return;
    const i = (app.globalData.records || []).indexOf(r);
    store.deleteRecord(r).then(() => {
      if (i >= 0) app.globalData.records.splice(i, 1);
      this.setData({ delUndo: { m: store.recMname(r), txt: r.txt, dump: r } });
      this.rebuild();
      this._startDelTimer();
    });
  },

  /* 点到页面其它地方：收起删除撤销条（与记 / 看页一致：不是浮层本身的点击都收起） */
  onBodyTap() {
    if (!this.data.delUndo) return;
    this._stopDelTimer();
    this.setData({ delUndo: null });
  },
  _stopDelTimer() { if (this._delTimer) { clearTimeout(this._delTimer); this._delTimer = null; } },
  _startDelTimer() {
    this._stopDelTimer();
    this._delTimer = setTimeout(() => {
      if (this.data.delUndo) this.setData({ delUndo: null });
    }, 3000);
  },

  /* 撤销删除：把记录原样加回来 */
  onUndoDel() {
    const u = this.data.delUndo; if (!u) return;
    this._stopDelTimer();
    const d = u.dump;
    const rec = {
      m: d.m, t: d.t, txt: d.txt, ext: d.ext || [], extSrc: d.extSrc || [], ts: d.ts,
      done: !!d.done, doneAt: d.doneAt || 0
    };
    store.addRecord(rec).then(rid => {
      rec._rid = rid; rec.id = rid;
      app.globalData.records.unshift(store.decorate(rec));
      this.setData({ delUndo: null });
      this.rebuild();
    });
  }
});
