// pages/set/set.js —— 设置
const store = require('../../utils/store.js');
const app = getApp();

function fmtDay(ts) {
  const d = new Date(ts || Date.now());
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

Page({
  data: {
    theme: 'sand',
    statusH: 20,
    themes: [],
    greets: { day: [], night: [] },
    greetOpen: false,
    geEdit: null,
    geNew: null,
    geNewVal: '',
    geEditVal: '',
    dims: [],
    dimOverlay: false,
    dimName: '',
    dimColor: '#7C9A86',
    importOverlay: false,
    importText: '',
    recCount: 0,
    optCount: 0
  },

  g: null,

  onShow() {
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    this.setData({ theme: wx.getStorageSync('theme') || 'sand', statusH: info.statusBarHeight || 20 });
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 3, hidden: false, theme: wx.getStorageSync('theme') || 'sand' });
    store.ensureAll().then(() => {
      this.g = app.globalData.greets ? JSON.parse(JSON.stringify(app.globalData.greets)) : JSON.parse(JSON.stringify(store.GREETS));
      const O = app.globalData.OPT || {};
      const optCount = Object.keys(O).reduce((s, k) => s + (O[k] ? O[k].length : 0), 0);
      this.setData({
        themes: store.THEMES,
        colors: store.DCOLORS,
        greets: this.g,
        dims: (app.globalData.dims || []).map(d => ({ k: d.k, n: d.n, c: d.c, opt: (d.opt || []).length })),
        recCount: (app.globalData.records || []).length,
        optCount
      });
    });
  },

  /* 外观 */
  onTheme(e) {
    const k = e.currentTarget.dataset.k;
    wx.setStorageSync('theme', k);
    this.setData({ theme: k });
  },

  /* 问候语 */
  toggleGreet() { this.setData({ greetOpen: !this.data.greetOpen }); },
  addGreetTap(e) { this.setData({ geNew: e.currentTarget.dataset.pool, geNewVal: '' }); },
  onGeNewInput(e) { this.setData({ geNewVal: e.detail.value }); },
  confirmGeNew(e) {
    const pool = e.currentTarget.dataset.pool;
    const v = (this.data.geNewVal || '').trim();
    if (!v) { this.setData({ geNew: null }); return; }
    this.g[pool].push(v);
    this.persistGreets();
    this.setData({ geNew: null, geNewVal: '', greets: this.g });
  },
  editGreet(e) {
    const pool = e.currentTarget.dataset.pool, idx = e.currentTarget.dataset.idx;
    this.setData({ geEdit: { pool, idx }, geEditVal: this.g[pool][idx] });
  },
  onGeEditInput(e) { this.setData({ geEditVal: e.detail.value }); },
  confirmGeEdit() {
    const { pool, idx } = this.data.geEdit;
    const v = (this.data.geEditVal || '').trim();
    if (v) this.g[pool][idx] = v;
    this.persistGreets();
    this.setData({ geEdit: null, geEditVal: '', greets: this.g });
  },
  cancelGeEdit() { this.setData({ geEdit: null, geEditVal: '' }); },
  delGreet(e) {
    const pool = e.currentTarget.dataset.pool, idx = e.currentTarget.dataset.idx;
    this.g[pool].splice(idx, 1);
    this.persistGreets();
    this.setData({ greets: this.g });
  },
  resetGreet() {
    this.g = JSON.parse(JSON.stringify(store.GREETS));
    app.globalData.greets = null;
    store.saveGreets(null);
    this.setData({ greets: this.g });
    wx.showToast({ title: '已恢复默认', icon: 'none' });
  },
  persistGreets() { app.globalData.greets = this.g; store.saveGreets(this.g); },

  /* 数据：导出 / 导入 / 清空 */
  exportText() {
    const recs = app.globalData.records || [];
    const head = '# 自我觉察 · 导出\n# 时间：' + fmtDay(Date.now()) + ' · 共 ' + recs.length + ' 条\n# 格式：日期 时间 | 维度 | 内容 | 细节（细节用顿号分隔）\n';
    const body = recs.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)).map(r =>
      fmtDay(r.ts) + ' ' + (r.t || '') + ' | ' + store.mname(r.m) + ' | ' + String(r.txt || '') + ((r.ext && r.ext.length) ? ' | ' + r.ext.join('、') : '')
    );
    return head + body.join('\n') + '\n';
  },
  onExport() {
    wx.setClipboardData({ data: this.exportText(), success: () => wx.showToast({ title: '已复制到剪贴板', icon: 'none' }) });
  },
  onImportTap() { this.setData({ importOverlay: true, importText: '' }); this.setTabBarHidden(true); },
  onImportInput(e) { this.setData({ importText: e.detail.value }); },
  closeImport() { this.setData({ importOverlay: false }); this.setTabBarHidden(false); },
  // 系统返回（Android 返回键 / iOS 左滑）：浮层打开时只关浮层，不退出小程序
  onBackPress() {
    if (this.data.importOverlay || this.data.dimOverlay) {
      this.setData({ importOverlay: false, dimOverlay: false });
      this.setTabBarHidden(false);
      return true;
    }
    return false;
  },
  setTabBarHidden(h) {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: !!h });
  },
  doImport() {
    const txt = this.data.importText || '';
    if (!txt.trim()) { wx.showToast({ title: '先粘贴内容', icon: 'none' }); return; }
    const parsed = this.parseImport(txt);
    if (!parsed.recs.length) { wx.showToast({ title: '没有可导入的记录', icon: 'none' }); return; }
    Promise.all(parsed.recs.map(r =>
      store.addRecord(r).then(rid => { r._rid = rid; r.id = rid; app.globalData.records.push(store.decorate(r)); })
    )).then(() => {
      app.globalData.records.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      this.setData({ importOverlay: false, recCount: app.globalData.records.length });
      this.setTabBarHidden(false);
      wx.showToast({ title: '已导入 ' + parsed.recs.length + ' 条', icon: 'none' });
    });
  },
  // 解析表头：抽出日期与时间，返回 { ts, t }
  // 支持：2026-09-29 12:10 / 26/09/29 21:28 / 9/29 / 12:10 / 其他任意文本
  parseHeadLine(head) {
    head = String(head || '').trim();
    let y = 0, mo = 0, d = 0, hh = -1, mi = 0;
    // 日期：YYYY-MM-DD / YYYY/MM/DD / YY-MM-DD / YY/MM/DD / M-D / M/D
    const md = head.match(/(\d{2,4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (md) {
      y = +md[1]; if (y < 100) y += 2000;
      mo = +md[2]; d = +md[3];
    } else {
      const md2 = head.match(/(?:^|[^\d])(\d{1,2})[-\/.](\d{1,2})(?:[^\d]|$)/);
      if (md2) { y = new Date().getFullYear(); mo = +md2[1]; d = +md2[2]; }
    }
    // 时间：HH:MM
    const mt = head.match(/(\d{1,2}):(\d{2})/);
    if (mt) { hh = +mt[1]; mi = +mt[2]; }
    const t = hh >= 0 ? ('0' + hh).slice(-2) + ':' + ('0' + mi).slice(-2) : '';
    // 组装时间戳
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return { ts: new Date(y, mo - 1, d, hh >= 0 ? hh : 12, hh >= 0 ? mi : 0, 0).getTime(), t };
    }
    // 仅有时间：按今天该时刻；完全没有日期时间：用当天正午（避免全堆在同一毫秒）
    if (hh >= 0) { const n = new Date(); n.setHours(hh, mi, 0, 0); return { ts: n.getTime(), t }; }
    const n = new Date(); n.setHours(12, 0, 0, 0); return { ts: n.getTime(), t: '' };
  },
  parseImport(txt) {
    const lines = String(txt || '').split(/\r?\n/);
    const out = []; let bad = 0;
    const N2K = {}; store.MODULES.forEach(m => N2K[m.n] = m.k);
    lines.forEach(ln => {
      ln = ln.trim();
      if (!ln || ln.charAt(0) === '#') return;
      const p = (ln.indexOf('|') >= 0 ? ln.split(/\s*\|\s*/) : ln.split(/\s*·\s*/));
      if (p.length < 3 || !p[2].trim()) { bad++; return; }
      const head = p[0].trim(), mk = p[1].trim(), main = p[2].trim();
      const ext = p.length > 3 ? p.slice(3).join(' | ').split(/[、,，]/).map(x => x.trim()).filter(x => x) : [];
      const k = N2K[mk] || mk;
      const known = store.FIELDS[k] || (app.globalData.dims || []).some(d => d.k === k);
      if (!known) { bad++; return; }
      const { ts, t } = this.parseHeadLine(head);
      // 细节按标签匹配回真实来源（怎么开始/沉浸/精力/心情…），匹配不到才用 fallback
      const extSrc = store.mapExtSrc(k, ext);
      out.push({ m: k, t, txt: main, ext, extSrc, ts });
    });
    return { recs: out, bad };
  },
  onClear() {
    wx.showModal({ title: '清空全部记录', content: '云端与本地都会删除，不可恢复。', confirmColor: '#C0574F', success: (r1) => {
      if (!r1.confirm) return;
      wx.showModal({ title: '再确认一次', content: '真的要清空吗？建议先导出备份。', confirmColor: '#C0574F', success: (r2) => {
        if (!r2.confirm) return;
        store.clearAllRecords().then(() => {
          app.globalData.records = [];
          this.setData({ recCount: 0 });
          wx.showToast({ title: '已清空', icon: 'none' });
        });
      } });
    } });
  },

  /* 自定义标签 */
  onAddDimTap() { this.setData({ dimOverlay: true, dimName: '', dimColor: store.DCOLORS[0] }); this.setTabBarHidden(true); },
  onDimName(e) { this.setData({ dimName: e.detail.value }); },
  onDimColor(e) { this.setData({ dimColor: e.currentTarget.dataset.c }); },
  confirmDim() {
    const name = (this.data.dimName || '').trim();
    if (!name) { wx.showToast({ title: '先写个名字', icon: 'none' }); return; }
    const k = 'd' + Date.now().toString(36);
    const d = { k, n: name, c: this.data.dimColor, opt: [] };
    store.regDim(d);
    app.globalData.dims.push(d);
    store.saveDims(app.globalData.dims);
    this.setData({ dimOverlay: false, dims: (app.globalData.dims || []).map(x => ({ k: x.k, n: x.n, c: x.c, opt: (x.opt || []).length })) });
    this.setTabBarHidden(false);
  },
  delDim(e) {
    const k = e.currentTarget.dataset.k;
    app.globalData.dims = (app.globalData.dims || []).filter(d => d.k !== k);
    store.unregDim(k);
    store.saveDims(app.globalData.dims);
    this.setData({ dims: (app.globalData.dims || []).map(x => ({ k: x.k, n: x.n, c: x.c, opt: (x.opt || []).length })) });
  }
});
