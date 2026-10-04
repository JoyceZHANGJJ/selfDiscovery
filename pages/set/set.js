// pages/set/set.js —— 设置
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');
const CHANGELOG = require('../../utils/changelog.js');
const app = getApp();

function fmtDay(ts) {
  const d = new Date(ts || Date.now());
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

Page(pageBase({
  data: {
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
    optCount: 0,
    optGroups: 0,
    logOverlay: false,
    logs: CHANGELOG,
    logLatest: (CHANGELOG[0] || {}).d || '',
    quickOpts: [],     // 快捷创建可勾选的类别（待办类别 + 随记类别），每项带 on 标记
    quickCount: 0,     // 已勾选数量（显示成 N/上限）
    quickMax: store.QUICKCATS_MAX,   // 上限（store 里单一来源，不写死）
    _selKeys: [],      // 已勾选的 key 有序列表（todo:<类别> / jot:<类别>）
    themeOpts: [],     // 主题表：每项 k / n / c（主色）/ on（当前）/ fav（常用）
    themeName: '',     // 当前主题的中文名（设置页那一行显示）
    favCount: 0,       // 常用主题已勾数量
    favMax: store.FAVTHEMES_MAX   // 常用主题上限（store 里单一来源）
  },

  g: null,

  onShow() {
    this.ensureTheme();
    // tabBar 的 hidden 跟着「有没有浮层」走，不能写死 false：
    // 从后台切回来也会走一次 onShow，写死就会把 tab 栏放出来、压住浮层底部的按钮（主题面板的「完成」）
    const tb = (typeof this.getTabBar === 'function') ? this.getTabBar() : null;
    // selected 按 app.json 的 tabBar.list 下标：记0 / 看1 / 回看2 / 睡3 / 设置4
    if (tb) tb.setData({ selected: 4, hidden: this._anyOverlay(), theme: wx.getStorageSync('theme') || 'mint' });
    this._rehideTabBar();   // 后台回来那一瞬间 tabBar 有自己的复位时序，过一拍再收一次
    this.buildThemeOpts();   // 主题表 / 当前 / 常用：右上圆点那边改过主题时，切回设置页要能看到最新的
    store.ensureAll().then(() => {
      this.g = app.globalData.greets ? JSON.parse(JSON.stringify(app.globalData.greets)) : JSON.parse(JSON.stringify(store.GREETS));
      const O = app.globalData.OPT || {};
      // optCount 是所有组里的「选项总数」，不是组数；optGroups 才是有内容的组数
      const optGroups = Object.keys(O).filter(k => (O[k] || []).length).length;
      const optCount = Object.keys(O).reduce((s, k) => s + (O[k] ? O[k].length : 0), 0);
      this.setData({
        colors: store.DCOLORS,
        greets: this.g,
        dims: (app.globalData.dims || []).map(d => ({ k: d.k, n: d.n, c: d.c, opt: (d.opt || []).length })),
        recCount: (app.globalData.records || []).length,
        optGroups,
        optCount
      });
      this.buildQuickOpts();
    });
  },

  /* 切到其它 tab 再切回来（或首次进入）：整页回到顶部 */
  scrollToTop() {
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  /* 悬浮球「＋」快捷记下一条待办后：只有「记录条数」会变 */
  onQuickTodo() { this.setData({ recCount: (app.globalData.records || []).length }); },

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

  /* 快捷创建：把「待办类别 + 随记类别」（都来自选项池）列出来，标出已勾选的（来自 getQuickCats） */
  buildQuickOpts() {
    const sel = store.getQuickCats();
    const selSet = new Set(sel.map(c => c.m === 'jot' ? ('jot:' + (c.cat || '')) : ('todo:' + c.cat)));
    const quickOpts = (store.getOPT('todoKind') || []).map(c => ({ key: 'todo:' + c, n: c, c: store.catColor(c), on: selSet.has('todo:' + c) }))
      .concat((store.getOPT('jotKind') || []).map(c => ({ key: 'jot:' + c, n: c, c: store.jotColor(c), on: selSet.has('jot:' + c) })));
    // 只认「仍然存在」的类别：选项池里被删掉的类别不再计数、也不再占 5 个名额。
    // 顺手把清理后的结果写回存储（只在与当前存储不同时写，避免每次进页面都写存储）。
    const selKeys = quickOpts.filter(o => o.on).map(o => o.key);
    const cleaned = selKeys.map(k => this._keyToCat(k));
    const same = cleaned.length === sel.length && cleaned.every((c, i) => c.m === sel[i].m && (c.cat || '') === (sel[i].cat || ''));
    if (!same) store.setQuickCats(cleaned);
    this.setData({ quickOpts, _selKeys: selKeys, quickCount: selKeys.length });
  },
  // 勾选 / 取消：最多 QUICKCATS_MAX 个；改动即持久化。顺序始终以选项排列为准（待办类别池 + 随记类别池），不随点击先后
  onQuickToggle(e) {
    const key = e.currentTarget.dataset.k;
    const onSet = new Set(this.data._selKeys);
    if (onSet.has(key)) { onSet.delete(key); }
    else {
      if (onSet.size >= store.QUICKCATS_MAX) { wx.showToast({ title: '最多选 ' + store.QUICKCATS_MAX + ' 个', icon: 'none' }); return; }
      onSet.add(key);
    }
    // 按 quickOpts 的展示顺序重排（待办类别 + 随记类别），保证「顺序 = 排列」
    const sel = this.data.quickOpts.map(o => o.key).filter(k => onSet.has(k));
    const quickOpts = this.data.quickOpts.map(o => Object.assign({}, o, { on: onSet.has(o.key) }));
    store.setQuickCats(sel.map(k => this._keyToCat(k)));
    this.setData({ _selKeys: sel, quickOpts, quickCount: sel.length });
  },
  _keyToCat(k) { return k.indexOf('jot:') === 0 ? { m: 'jot', cat: k.slice(4) } : { m: 'todo', cat: k.slice(5) }; },

  /* 外观 · 主题：像「快捷创建」一样直接铺在设置页里（不用浮层 / 子页面——
     tab 页无法拦截系统返回键，浮层按返回会退出小程序、子页面又多一次跳转）。
     点色点＝切到这个主题：写存储 + 本页变量 + 窗口底色 + tabBar，其它页下次 onShow 自动跟上 */
  buildThemeOpts() {
    const fav = store.getFavThemes();
    const cur = store.curTheme();
    const themeOpts = store.themeList().map(t => {
      const v = (store.themeOf(t.k).vars || {});
      return { k: t.k, n: t.n, c: v.accent || '', on: t.k === cur, fav: fav.indexOf(t.k) >= 0 };
    });
    this.setData({ themeOpts, favCount: fav.length, themeName: store.themeOf(cur).n });
  },
  onThemePick(e) {
    const k = e.currentTarget.dataset.k;
    if (!k || k === store.curTheme()) return;
    wx.setStorageSync('theme', k);
    this.setData({
      theme: k, themeStyle: store.themeStyle(k), themeName: store.themeOf(k).n,
      themeOpts: this.data.themeOpts.map(o => Object.assign({}, o, { on: o.k === k }))
    });
    store.syncWindowBg(k);   // 切主题的当下就换窗口底色，别等下次 onShow
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ theme: k });
    const sw = this.selectComponent('#themeSw');   // 右上圆点的名称也跟着换
    if (sw && sw.applyTheme) sw.applyTheme();
    wx.showToast({ title: store.themeOf(k).n, icon: 'none', duration: 600 });
  },
  /* 勾「常用」＝加入 / 移出右上圆点的循环，最多 FAVTHEMES_MAX 个。
     取消勾选不会改当前主题：就算当前这个不再常用，圆点下次也是从第一个常用主题接着走 */
  onFavToggle(e) {
    const k = e.currentTarget.dataset.k;
    const fav = store.getFavThemes();
    const i = fav.indexOf(k);
    if (i >= 0) fav.splice(i, 1);
    else {
      if (fav.length >= store.FAVTHEMES_MAX) { wx.showToast({ title: '最多 ' + store.FAVTHEMES_MAX + ' 个', icon: 'none' }); return; }
      fav.push(k);
    }
    const saved = store.setFavThemes(fav);
    this.setData({
      favCount: saved.length,
      themeOpts: this.data.themeOpts.map(o => Object.assign({}, o, { fav: saved.indexOf(o.k) >= 0 }))
    });
    wx.showToast({ title: saved.length ? ('常用 ' + saved.length + ' 个') : '循环全部主题', icon: 'none', duration: 800 });
  },

  /* 数据：导出 / 导入 / 清空 */
  exportText(recs) {
    const head = '# ' + (app.APP_NAME || '识己手札') + ' · 导出\n# 时间：' + fmtDay(Date.now()) + ' · 共 ' + recs.length + ' 条\n# 格式：日期 时间 | 维度 | 内容 | 细节（细节用顿号分隔）\n';
    const body = recs.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)).map(r =>
      fmtDay(r.ts) + ' ' + (r.t || '') + ' | ' + store.mname(r.m) + ' | ' + String(r.txt || '') + ((r.ext && r.ext.length) ? ' | ' + r.ext.join('、') : '')
    );
    return head + body.join('\n') + '\n';
  },
  // 导出：单独全量拉取（不依赖被截断的本地内存，覆盖全部历史记录）
  onExport() {
    wx.showLoading({ title: '导出中', mask: true });
    store.loadAllRecords({}).then(recs => {
      wx.hideLoading();
      wx.setClipboardData({ data: this.exportText(recs), success: () => wx.showToast({ title: '已复制到剪贴板', icon: 'none' }) });
    }).catch(() => {
      wx.hideLoading();
      wx.setClipboardData({ data: this.exportText(app.globalData.records || []), success: () => wx.showToast({ title: '已复制到剪贴板', icon: 'none' }) });
    });
  },
  onImportTap() { this.setData({ importOverlay: true, importText: '' }); this.setTabBarHidden(true); },
  onImportInput(e) { this.setData({ importText: e.detail.value }); },
  closeImport() { this.setData({ importOverlay: false }); this.setTabBarHidden(false); },
  /* 有没有浮层开着：开着时底部 tab 栏要收起来（否则压住浮层底部的按钮） */
  _anyOverlay() {
    return !!(this.data.importOverlay || this.data.dimOverlay || this.data.logOverlay);
  },
  /* 浮层开着时，过一拍再把 tabBar 收一次：从后台切回来（或切 tab 回来）的那一瞬间，
     tabBar 有自己的重建 / 复位时序，只在 onShow 里设一次可能被它盖回来——
     表现就是主题面板底部的「完成」被 tab 栏压住 */
  _rehideTabBar() {
    if (!this._anyOverlay()) return;
    if (this._rehideTimer) clearTimeout(this._rehideTimer);
    this._rehideTimer = setTimeout(() => {
      this._rehideTimer = null;
      if (this._anyOverlay()) this.setTabBarHidden(true);
    }, 300);
  },
  // 注：原来这里有个 onBackPress（「Android 返回键先关浮层」）——微信小程序没有这个回调，
  // 它从未生效过（那是 uni-app 的 API）。tab 页按系统返回 = 退出小程序，无法拦截；
  // 需要返回键友好的交互不能放在 tab 页的浮层里——主题选择最后做成了设置页内的内联列表

  /* 更新日志 */
  openLog() { this.setData({ logOverlay: true }); this.setTabBarHidden(true); },
  closeLog() { this.setData({ logOverlay: false }); this.setTabBarHidden(false); },
  setTabBarHidden(h) {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: !!h });
  },
  doImport() {
    const txt = this.data.importText || '';
    if (!txt.trim()) { wx.showToast({ title: '先粘贴内容', icon: 'none' }); return; }
    const parsed = this.parseImport(txt);
    if (!parsed.recs.length) { wx.showToast({ title: '没有可导入的记录', icon: 'none' }); return; }
    // 判重：同一模块 + 内容 + 时间戳 视为同一条，避免重复导入（如同一份文本导入两次）
    const existing = app.globalData.records || [];
    const seen = new Set(existing.map(r => (r.m || '') + '\u0001' + (r.txt || '') + '\u0001' + (r.ts || '')));
    const toAdd = [], dup = [];
    parsed.recs.forEach(r => {
      const key = (r.m || '') + '\u0001' + (r.txt || '') + '\u0001' + (r.ts || '');
      if (seen.has(key)) { dup.push(r); return; }
      seen.add(key); toAdd.push(r);
    });
    if (!toAdd.length) {
      this.setData({ importOverlay: false });
      this.setTabBarHidden(false);
      wx.showToast({ title: '都是重复记录，未导入', icon: 'none' });
      return;
    }
    Promise.all(toAdd.map(r =>
      store.addRecord(r).then(rid => { r._rid = rid; r.id = rid; app.globalData.records.push(store.decorate(r)); })
    )).then(() => {
      app.globalData.records.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      this.setData({ importOverlay: false, recCount: app.globalData.records.length });
      this.setTabBarHidden(false);
      const msg = '已导入 ' + toAdd.length + ' 条' + (dup.length ? ' · 跳过重复 ' + dup.length : '');
      wx.showToast({ title: msg, icon: 'none' });
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
    // 「睡」也在 MODULES 里（只是标了 quiet），所以这里天然认识它；
    // 下面 known 的白名单要额外放行 isQuiet —— 它没有 FIELDS（不在记页手记），
    // 不放行的话导出的「睡」会被当成坏行丢掉，导入一条都回不来
    const N2K = {}; store.MODULES.forEach(m => N2K[m.n] = m.k);
    // 备忘 / 购物 已并入「待办」：老导出文件里的维度名映射成 todo，并把类别补进细节最前
    // （合并后的新导出维度写「待办」，类别本就在细节里，不需要这一步）
    const LEGACY_TASK = { '备忘': '备忘', '购物': '购物' };
    lines.forEach(ln => {
      ln = ln.trim();
      if (!ln || ln.charAt(0) === '#') return;
      const p = (ln.indexOf('|') >= 0 ? ln.split(/\s*\|\s*/) : ln.split(/\s*·\s*/));
      if (p.length < 3 || !p[2].trim()) { bad++; return; }
      const head = p[0].trim(), mk = p[1].trim(), main = p[2].trim();
      let ext = p.length > 3 ? p.slice(3).join(' | ').split(/[、,，]/).map(x => x.trim()).filter(x => x) : [];
      const aliasCat = LEGACY_TASK[mk];
      const k = aliasCat ? 'todo' : (N2K[mk] || mk);
      const known = store.FIELDS[k] || (app.globalData.dims || []).some(d => d.k === k) || store.isQuiet(k);
      if (!known) { bad++; return; }
      if (aliasCat) ext = [aliasCat].concat(ext);   // 类别与 srcList('todo') 的首位对齐
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
}));
