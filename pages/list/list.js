// pages/list/list.js —— 清单：备忘 / 购物 快捷查看
const store = require('../../utils/store.js');
const app = getApp();

// 待办的时间只存 HH:MM（与 store.normTime 的输出一致；「今天 / 非今天」的显示交给 taskTime）
function hhmm(ts) {
  const d = new Date(ts);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

// 某天 0 点的毫秒时间戳：已完成按「完成那天」分段用（与看页同一套，跨年不会撞 key）
function dayStartTs(ts) {
  const d = new Date(ts || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

Page({
  data: {
    theme: 'sand',
    statusH: 20,
    seg: 'all',            // all | memo | buy
    cmemo: store.mcolor('memo'),
    cbuy: store.mcolor('buy'),
    // 顶部快捷新增：输入 → 回车 → 立刻出现在列表顶部，可连着加（目标模块跟筛选走）
    qaTxt: '',
    qaM: 'memo',           // seg='all' 时的目标模块：memo | buy
    qaName: '备忘',
    qaPh: '要记住什么',
    show: false,
    tit: '待办 · 备忘与购物',
    sum: '',
    undone: [],
    doneGroups: [],
    doneN: 0,
    abandGroups: [],
    abandN: 0,
    // 收起态：只默认展开「待完成」——清单页一进来先看要干什么；
    // 已完成 / 已放弃都收起，条数在各自的标题上看得见，想看再点开
    openU: true,
    openD: false,
    openA: false,
    empty: false,
    // 点条目出的记录操作条（放弃 / 恢复 / 改 / 删除；完成永远走条目上的勾选框）
    sel: null,
    selRec: null,
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
      // 完成时间带「完成 ·」前缀：行右侧那个裸时间是「记录时间」，两个时间要能分得清
      doneAtText: r.doneAt ? ('完成 · ' + hhmm(r.doneAt)) : '已完成',
      abandAtText: r.abandonedAt ? ('放弃 · ' + hhmm(r.abandonedAt)) : '已放弃',
      reason: r.reason || '', usefor: r.usefor || ''
    };
  },

  rebuild() {
    const all = (app.globalData.records || []).filter(r => store.isTask(r.m));
    const seg = this.data.seg;
    const list = seg === 'all' ? all : all.filter(r => r.m === seg);
    // 注意：recVM 的产物里没有 ts / doneAt，必须在 map 之前对原始记录排序，
    // 否则 sort 比较的全是 undefined，等于没排（已完成要按完成时间倒序，就是这个坑）
    const undone = list.filter(r => !r.done && r.status !== 'abandon').sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(r => this.recVM(r));
    const doneRecs = list.filter(r => r.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    const abandRecs = list.filter(r => !r.done && r.status === 'abandon').sort((a, b) => (b.abandonedAt || 0) - (a.abandonedAt || 0));
    // 已完成 / 已放弃各按「那天」分段（与看页同一套）：段头给日期，行内只写「完成 / 放弃 · HH:MM」
    const doneGroups = this.groupByDay(doneRecs, r => r.doneAt || r.ts);
    const abandGroups = this.groupByDay(abandRecs, r => r.abandonedAt || r.ts);
    const u = undone.length, dn = doneRecs.length, an = abandRecs.length;
    const sum = u
      ? (u + ' 项待完成' + (dn ? ' · 已完成 ' + dn : '') + (an ? ' · 已放弃 ' + an : ''))
      : ((dn || an) ? ('全部处理完' + (dn ? ' · 已完成 ' + dn : '') + (an ? ' · 已放弃 ' + an : '')) : '');
    const tit = seg === 'memo' ? '备忘' : (seg === 'buy' ? '购物' : '待办 · 备忘与购物');
    // 快捷新增的目标模块：筛选定了就跟筛选走（筛「全部」时用 qaM，可在输入框左边点「切换」改）
    const qm = (seg === 'memo' || seg === 'buy') ? seg : this.data.qaM;
    this.setData({
      show: list.length > 0, tit, sum, undone, doneGroups, doneN: dn, abandGroups, abandN: an, empty: list.length === 0,
      qaM: qm, qaName: qm === 'buy' ? '购物' : '备忘', qaPh: qm === 'buy' ? '要买什么' : '要记住什么'
    });
  },

  // 按「某一天」把记录分段（已完成按完成时间、已放弃按放弃时间）：段头用时间线同款日标签
  groupByDay(recs, tsOf) {
    const map = {}, order = [];
    recs.forEach(r => {
      const k = dayStartTs(tsOf(r));
      if (!map[k]) { map[k] = { day: store.dayLabel(store.agoOf(k)), recs: [] }; order.push(k); }
      map[k].recs.push(this.recVM(r));
    });
    return order.map(k => map[k]);
  },

  onSeg(e) {
    this.data.seg = e.currentTarget.dataset.s;
    this.setData({ seg: this.data.seg });
    this.rebuild();
  },

  /* 待完成 / 已完成 / 已放弃 三段的收起（与看页同一套带线标题 + ▸ 箭头） */
  onFold(e) {
    const k = e.currentTarget.dataset.k;
    if (k === 'undone') this.setData({ openU: !this.data.openU });
    else if (k === 'aband') this.setData({ openA: !this.data.openA });
    else this.setData({ openD: !this.data.openD });
  },

  /* ---------------- 点条目：记录操作条（放弃 / 恢复 / 改 / 删除） ----------------
     勾选框是「完成」（catchtap 单独处理），点条目的其它地方才是次级操作，两者互不干扰 */
  onRecTap(e) {
    if (this._lpAt && Date.now() - this._lpAt < 400) return;   // 长按刚触发过，忽略随之而来的点击
    const id = e.currentTarget.dataset.id;
    if (this.data.sel === id) { this.setData({ sel: null, selRec: null }); return; }
    const r = this.findRec(id);
    this.setData({ sel: id, selRec: r ? { m: store.recMname(r), txt: r.txt, rawm: r.m, status: r.status || '', ended: !!r.endTs, done: !!r.done } : null });
  },

  /* 操作条统一入口（与记 / 看页共用 rec-actions 组件）：待办只用到 放弃 / 恢复 / 改 / 删 */
  onRecAction(e) {
    const type = e.detail.type;
    const id = this.data.sel; if (id == null) return;
    const r = this.findRec(id);
    if (!r || !store.isTask(r.m)) return;
    if (type === 'abandon') {
      r.status = 'abandon'; r.abandonedAt = Date.now();
      store.updateRecord(r).catch(() => {});
      this.setData({ sel: null, selRec: null });
      this.rebuild();
      return;
    }
    if (type === 'restore') {
      r.status = ''; r.abandonedAt = 0;
      store.updateRecord(r).catch(() => {});
      this.setData({ sel: null, selRec: null });
      this.rebuild();
      return;
    }
    if (type === 'edit') { this.setData({ sel: null, selRec: null }); this._openEdit(id, r.txt || ''); return; }
    if (type === 'del') { this.setData({ sel: null, selRec: null }); this._del(r); }
  },

  /* ---------------- 快捷新增待办 ---------------- */
  // 目标模块：筛选到具体模块时就是它，否则用「切换」选的那个
  qaTarget() {
    const s = this.data.seg;
    return (s === 'memo' || s === 'buy') ? s : (this.data.qaM === 'buy' ? 'buy' : 'memo');
  },
  // 只有「全部」时目标才可切（筛了备忘 / 购物时目标就是筛选本身）
  onQaSwitch() {
    if (this.data.seg !== 'all') return;
    this.data.qaM = this.data.qaM === 'buy' ? 'memo' : 'buy';
    this.rebuild();
  },
  onQaInput(e) { this.setData({ qaTxt: e.detail.value }); },
  /* 回车（或点「记下」）即落库：输入框清空、列表顶部立刻多一条，可继续输下一条 */
  onQaSave() {
    const txt = (this.data.qaTxt || '').trim();
    if (!txt) { wx.showToast({ title: '先写点什么', icon: 'none' }); return; }
    const m = this.qaTarget();
    const ts = Date.now();
    const rec = { m, txt, ts, t: hhmm(ts), ext: [], extSrc: [], done: false, doneAt: 0, status: '' };
    store.addRecord(rec).then(rid => {
      rec._rid = rid; rec.id = rid;
      if (!app.globalData.records) app.globalData.records = [];
      app.globalData.records.unshift(store.decorate(rec));
      this.setData({ qaTxt: '' });
      this.rebuild();
      wx.showToast({ title: '已记入' + (m === 'buy' ? '购物' : '备忘'), icon: 'none', duration: 900 });
    }).catch(() => wx.showToast({ title: '没记上，再试一次', icon: 'none' }));
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
    this._lpAt = Date.now();     // 长按之后紧跟的那次点击要忽略，否则会立刻弹出操作条
    this.setData({ sel: null, selRec: null });
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

  /* 就地编辑里的「删除」 */
  onEditDel() {
    const r = this.findRec(this.data.edId);
    this._closeEdit();
    if (!r || !store.isTask(r.m)) return;
    this._del(r);
  },
  /* 删除 + 一次撤销机会（就地编辑的「删除」与操作条的「删除」共用） */
  _del(r) {
    const i = (app.globalData.records || []).indexOf(r);
    store.deleteRecord(r).then(() => {
      if (i >= 0) app.globalData.records.splice(i, 1);
      this.setData({ delUndo: { m: store.recMname(r), txt: r.txt, dump: r } });
      this.rebuild();
      this._startDelTimer();
    });
  },

  /* 点到页面其它地方：操作条与删除撤销条都收起（与记 / 看页一致：不是浮层本身的点击都收起） */
  onBodyTap() {
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
