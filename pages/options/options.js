// pages/options/options.js —— 选项管理（独立页，返回即回到「记」）
const store = require('../../utils/store.js');
const app = getApp();

Page({
  data: {
    theme: store.curTheme(),
    statusH: 20,
    themeStyle: store.themeStyle(store.curTheme()),
    group: '',
    label: '',
    opts: [],
    newVal: '',
    undo: null,
    dragging: false,
    dragIdx: -1,
    rowH: 58
  },

  onLoad(q) {
    const group = decodeURIComponent(q.group || '');
    this.group = group;
    this.setData({ group, label: store.GLABEL[group] || '管理选项' });
    this.refresh();
    this.diag();
  },

  // 诊断：打印当前云环境 + options 集合实际可见条数（模拟器/手机对比用）
  diag() {
    try {
      const db = wx.cloud.database();
      db.collection('options').count()
        .then(r => console.log('[诊断] 环境=', (wx.cloud.database().config && wx.cloud.database().config.env) || '-', 'options 云端总条数=', r.total))
        .catch(e => console.error('[诊断] options 读取失败（多为集合不存在或无读权限）：', e));
    } catch (e) { console.error('[诊断] 云未初始化：', e); }
  },

  onShow() {
    const t = store.curTheme();
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    this.setData({ theme: t, statusH: info.statusBarHeight || 20, themeStyle: store.themeStyle(t) });
    this.refresh();
  },

  onHide() {
    // 兜底：离开页面时结束可能残留的拖拽状态
    if (this.data.dragging) this.setData({ dragging: false, dragIdx: -1 });
  },

  // 读取最新选项池（store 为单例，与首页共享 app.globalData.OPT）
  refresh() {
    const opts = store.getOPT(this.group).map(v => ({ v, ren: false }));
    this.setData({ opts, undo: null });
  },

  onRenStart(e) {
    const v = e.currentTarget.dataset.v;
    const opts = this.data.opts.map(o => o.v === v ? { v, ren: true } : o);
    this.setData({ opts, _renVal: v });
  },
  onRenInput(e) { this.setData({ _renVal: e.detail.value }); },
  onRenSave(e) {
    const ov = e.currentTarget.dataset.v;
    const nv = (this.data._renVal || '').trim();
    if (!nv || nv === ov) { this.refresh(); return; }
    const g = this.group;
    const O = app.globalData.OPT;
    // 只在本选项组内替换：不同组里的同名项互不影响
    if (O[g]) { const i = O[g].indexOf(ov); if (i >= 0) O[g][i] = nv; }
    // 记录同步：主项组改所属模块记录的 txt；细节组只改 ext 里 src 正好是该组的位置
    const mainOf = store.mainModuleOf(g);
    app.globalData.records.forEach(r => {
      if (mainOf) { if (r.m === mainOf && r.txt === ov) r.txt = nv; return; }
      const es = r.extSrc || [], ex = r.ext || [];
      for (let i = 0; i < es.length; i++) if (es[i] === g && ex[i] === ov) ex[i] = nv;
    });
    const ps = [store.renameOption(g, ov, nv)];
    if (store.isDefault(g, ov)) {
      // 默认项改名：旧值标记删除，新值落库持久化
      ps.push(store.addDelDef(g, ov));
      if (O[g] && O[g].indexOf(nv) < 0) O[g].push(nv);
      ps.push(store.addOption(g, nv));
    }
    if (store.isDefault(g, nv)) ps.push(store.clearDelDef(g, nv)); // 新值恰好是默认项，清除删除标记
    ps.push(store.markOptCustom(g, O[g]));   // 动过这组了：以后这组以你这份为准，默认词不再插手
    Promise.all(ps).then(() => wx.showToast({ title: '已同步云端', icon: 'none' }));
    this.refresh();
  },
  onOptDel(e) {
    const v = e.currentTarget.dataset.v;
    const O = app.globalData.OPT;
    if (O[this.group]) O[this.group] = O[this.group].filter(x => x !== v);
    if (O[this.group]) store.setOptOrder(this.group, O[this.group]);
    const ps = [store.removeOption(this.group, v)];
    if (store.isDefault(this.group, v)) ps.push(store.addDelDef(this.group, v)); // 删的是默认项，记录删除标记
    ps.push(store.markOptCustom(this.group, O[this.group]));
    Promise.all(ps).then(() => wx.showToast({ title: '已同步云端', icon: 'none' }));
    this.setData({ undo: { v } });
    this.refresh();
  },
  // 长按进入拖拽：锁定列表滚动，记录起点
  onDragStart(e) {
    const idx = +e.currentTarget.dataset.idx;
    if (!this.data.opts[idx] || this.data.opts[idx].ren) return; // 改名中不可拖
    this._startY = e.touches[0].clientY;
    this._baseIdx = idx;
    this.setData({ dragging: true, dragIdx: idx });
    wx.vibrateShort && wx.vibrateShort({ type: 'light' });
  },
  // 拖动中：按手指位移换算目标位置并实时换位
  onDragMove(e) {
    if (!this.data.dragging) return;
    const delta = e.touches[0].clientY - this._startY;
    let target = this._baseIdx + Math.round(delta / this.data.rowH);
    const len = this.data.opts.length;
    if (target < 0) target = 0;
    if (target > len - 1) target = len - 1;
    if (target === this.data.dragIdx) return;
    const arr = this.data.opts.slice();
    const item = arr.splice(this.data.dragIdx, 1)[0];
    arr.splice(target, 0, item);
    this.setData({ opts: arr, dragIdx: target });
    store.setOptOrder(this.group, arr.map(o => o.v));
  },
  // 松手：结束拖拽，恢复滚动
  onDragEnd() {
    if (!this.data.dragging) return;
    this.setData({ dragging: false, dragIdx: -1 });
  },
  onOptUndo() {
    const u = this.data.undo; if (!u) return;
    const O = app.globalData.OPT;
    if (!O[this.group]) O[this.group] = [];
    if (O[this.group].indexOf(u.v) < 0) O[this.group].push(u.v);
    const ps = [store.addOption(this.group, u.v)];
    if (store.isDefault(this.group, u.v)) ps.push(store.clearDelDef(this.group, u.v)); // 还原被删的默认项
    ps.push(store.markOptCustom(this.group, O[this.group]));
    Promise.all(ps).then(() => wx.showToast({ title: '已同步云端', icon: 'none' }));
    this.setData({ undo: null });
    this.refresh();
  },
  onNewInput(e) { this.setData({ newVal: e.detail.value }); },
  onNewAdd() {
    const v = (this.data.newVal || '').trim();
    if (!v) return;
    const O = app.globalData.OPT, g = this.group;
    if (!O[g]) O[g] = [];
    if (O[g].indexOf(v) < 0) {
      O[g].push(v);
      store.setOptOrder(g, O[g]);
      const ps = [store.addOption(g, v)];
      if (store.isDefault(g, v)) ps.push(store.clearDelDef(g, v)); // 加回的是曾被删的默认项
      ps.push(store.markOptCustom(g, O[g]));
      Promise.all(ps).then(() => wx.showToast({ title: '已同步云端', icon: 'none' }));
    }
    this.setData({ newVal: '' });
    this.refresh();
  },
  onClose() { wx.navigateBack(); }
});
