// pages/index/index.js —— 记
const store = require('../../utils/store.js');
const app = getApp();

function nowStr() {
  const d = new Date();
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

Page({
  data: {
    theme: 'mint',
    statusH: 20,
    ready: false,
    modules: [],
    tag: 'obs',
    greet: { t: '', s: '' },
    composer: {},
    recent: [],
    saved: null,
    froze: null,
    editing: false,
    refreshing: false,
    scrollTop: 0,
    recSel: null,
    recSelRec: null,
    delUndo: null
  },

  st: {
    tag: 'obs', main: '', mainPick: null, pick: {}, typed: {}, free: {},
    edit: null, lastRec: null, ren: null, optUndo: null
  },

  onShow() {
    this.ensureTheme();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 0, theme: store.curTheme() });
    store.ensureAll().then(() => {
      const mods = this.modulesVM();
      const def = mods.some(m => m.k === 'obs') ? 'obs' : (mods[0] && mods[0].k);
      // 当前选中无效（如删掉了「观察」维度）时，回落到默认：有观察则观察，否则第一个维度
      let cur = this.data.tag;
      if (!mods.some(m => m.k === cur)) { cur = def; this.setData({ tag: def }); }
      this.st.tag = cur;
      // 进入「去做」时若还没选分类，补上默认分类（以往靠 onTag 触发，现在默认就是它，需在此兜底）
      if (cur === 'want' && !this.st.pick['wantKind']) this.st.pick['wantKind'] = store.wantKindDefault();
      this.checkEdit();
      this.rotateGreet();
      this.recompute();
      // 数据就绪后再渲染真实内容，避免首屏出现空卡片「闪一下」
      this.setData({ ready: true });
      // 悬浮球「备忘/购物」快速记：跳转后自动切到对应模块
      if (app.globalData && app.globalData.pendingTag) {
        const t = app.globalData.pendingTag;
        app.globalData.pendingTag = null;
        if (t !== this.st.tag) this.onTag({ currentTarget: { dataset: { k: t } } });
      }
    });
  },

  ensureTheme() {
    const t = store.curTheme();
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    this.setData({ theme: t, statusH: info.statusBarHeight || 20 });
  },

  rotateGreet() {
    const g = app.globalData;
    const greets = g.greets || store.GREETS;
    const hh = new Date().getHours();
    const t = hh < 6 ? '还没睡？' : (hh < 11 ? '早上好' : (hh < 14 ? '中午好' : (hh < 18 ? '下午好' : '晚上好')));
    const pool = (hh >= 18 || hh < 5) ? greets.night : greets.day;
    let pick = pool[Math.floor(Math.random() * pool.length)];
    const last = wx.getStorageSync('greet_last') || '';
    if (pool.length > 1 && pick === last) {
      const i = pool.indexOf(pick);
      pick = pool[(i + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length];
    }
    wx.setStorageSync('greet_last', pick);
    this.setData({ greet: { t, s: pick } });
  },

  modulesVM() {
    return store.MODULES;
  },

  checkEdit() {
    const g = app.globalData;
    if (!g.editRec) return;
    const r = g.editRec; g.editRec = null;
    const main = store.FIELDS[r.m].main;
    const O = store.getOPT(main);
    this.st.edit = r;
    this.st.tag = r.m;
    if (O.indexOf(r.txt) >= 0) { this.st.mainPick = r.txt; this.st.main = ''; }
    else { this.st.main = r.txt; this.st.mainPick = null; }
    this.st.pick = {}; this.st.typed = {}; this.st.free = {};
    (r.ext || []).forEach((v, i) => {
      let src = (r.extSrc || [])[i] || '', val = v;
      if (src.indexOf('free:') === 0) { this.st.free[src.slice(5)] = val; return; }
      // 老数据：不想的情绪可能存成「程度+情绪」合并值（如「微微懒」），拆回 程度 + 情绪
      if (src === 'nopeMood') {
        const degs = store.getOPT('nopeDeg');
        const hitDeg = degs.find(d => val.indexOf(d) === 0);
        const rest = hitDeg ? val.slice(hitDeg.length) : val;
        // 若拆分后剩余正好是预设情绪，则各自还原；否则整条放回情绪
        if (hitDeg && store.getOPT('nopeMood').indexOf(rest) >= 0) {
          (this.st.pick['nopeDeg'] = this.st.pick['nopeDeg'] || []).push(hitDeg);
          (this.st.pick['nopeMood'] = this.st.pick['nopeMood'] || []).push(rest);
          return;
        }
        val = rest;
      }
      const O = store.getOPT(src);
      if (O.indexOf(val) >= 0) (this.st.pick[src] = this.st.pick[src] || []).push(val);
      else if (!store.isNoInput(src)) this.st.typed[src] = val; // 非预设选项的手填值（隐藏输入的组不留残值）
    });
    // 记录本身没有分类（历史数据）时才补默认分类；有则只回显记录自己的值，避免默认+记录值同时选中
    if (r.m === 'want' && !this.st.pick['wantKind']) this.st.pick['wantKind'] = store.wantKindDefault();
    this.setData({ editing: true });
  },

  recVM(r) {
    const dt = store.buildExt(r.m, r.ext, r.extSrc);
    const ago = store.agoOf(r.ts);
    const d = ago <= 0 ? '' : (ago === 1 ? '昨天' : (ago === 2 ? '前天' : store.dayLabel(ago))) + ' ';
    const task = store.isTask(r.m);
    return { id: r.id, m: store.recMname(r), c: store.mcolor(r.m), txt: r.txt, t: r.t, d, dt, task, done: !!r.done, doneLabel: store.doneLabel(r.doneAt), reason: r.reason || '', usefor: r.usefor || '' };
  },

  buildComposer() {
    const tag = this.st.tag;
    let f = store.FIELDS[tag];
    if (!f) {
      const d = (app.globalData.dims || []).find(x => x.k === tag);
      if (d) f = { main: 'm_' + tag, items: [{ g: 'm_' + tag, freeze: true, single: true }, { free: 'note', label: '补充', ph: '随便记点什么，可跳过', ta: true }] };
    }
    const main = f.main;
    const mainOpts = store.getOPT(main).map(v => ({ v, on: this.st.mainPick === v }));
    const items = f.items.map((it, idx) => {
      if (it.g) {
        const opts = store.getOPT(it.g).map(v => ({ v, on: (this.st.pick[it.g] || []).indexOf(v) >= 0 }));
        const ph = it.freeze ? '手填：加 ~ 才存入选项池' : '也可以手填，和选项一起记下（不加入选项）';
        return { type: 'g', first: idx === 0, group: it.g, label: store.GLABEL[it.g], single: !!it.single, freeze: !!it.freeze, noInput: !!it.noInput, ph, opts, typedVal: this.st.typed[it.g] || '' };
      }
      if (it.fx) {
        const fx = store.FIXED[it.fx];
        const opts = fx.opts.map(v => ({ v, on: (this.st.pick['fx:' + it.fx] || []).indexOf(v) >= 0 }));
        return { type: 'fx', first: idx === 0, group: 'fx:' + it.fx, label: fx.label, opts };
      }
      return { type: 'free', first: idx === 0, key: it.free, label: it.label, ph: it.ph, ta: !!it.ta, val: this.st.free[it.free] || '' };
    });
    const MAINPH = { memo: '要记住什么 · 回车就记下', buy: '要买什么 · 可写「牛奶 2」' };
    // 备忘 / 购物：只保留一个输入框，不显示标题、选项池与管理入口
    const plain = store.isTask(tag);
    return { main: main, mainLabel: store.GLABEL[main], mainOpts, mainVal: this.st.main || '', items, plain, mainPh: MAINPH[tag] || '手填或直接写一句 · 默认只记这次，加 ~ 存入选项池' };
  },

  recompute() {
    const recs = (app.globalData.records || []).slice(0, 3).map(r => this.recVM(r));
    this.setData({
      modules: this.modulesVM(),
      tag: this.st.tag,
      composer: this.buildComposer(),
      recent: recs
    });
  },

  /* -------- 交互 -------- */
  onTag(e) {
    this.st.tag = e.currentTarget.dataset.k;
    this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
    if (this.st.tag === 'want' && !this.st.pick['wantKind']) this.st.pick['wantKind'] = store.wantKindDefault();
    this.setData({ tag: this.st.tag });
    this.recompute();
  },
  onMainInput(e) { this.st.main = e.detail.value; this.setData({ 'composer.mainVal': e.detail.value }); if (e.detail.value.trim()) this.st.mainPick = null; },
  onMainChip(e) {
    const v = e.currentTarget.dataset.v;
    if (this.st.mainPick === v) this.st.mainPick = null;
    else { this.st.mainPick = v; this.st.main = ''; }
    this.recompute();
  },
  onChip(e) {
    const g = e.currentTarget.dataset.g, v = e.currentTarget.dataset.v;
    let arr = this.st.pick[g] || [];
    if (arr.indexOf(v) >= 0) arr = arr.filter(x => x !== v);
    else { if (store.isSingle(g)) arr = []; arr.push(v); }
    this.st.pick[g] = arr;
    this.recompute();
  },
  onGroupInput(e) {
    const g = e.currentTarget.dataset.g, idx = e.currentTarget.dataset.idx;
    this.st.typed[g] = e.detail.value;
    if (idx != null) this.setData({ ['composer.items[' + idx + '].typedVal']: e.detail.value });
  },
  onGroupConfirm(e) { this.st.typed[e.currentTarget.dataset.g] = e.detail.value; },
  onFreeInput(e) {
    const k = e.currentTarget.dataset.k, idx = e.currentTarget.dataset.idx;
    this.st.free[k] = e.detail.value;
    if (idx != null) this.setData({ ['composer.items[' + idx + '].val']: e.detail.value });
  },

  /* -------- 保存 -------- */
  doSave() {
    let f = store.FIELDS[this.st.tag];
    if (!f) {
      const d = (app.globalData.dims || []).find(x => x.k === this.st.tag);
      if (d) f = { main: 'm_' + this.st.tag, items: [{ g: 'm_' + this.st.tag, freeze: true, single: true }, { free: 'note', label: '补充', ph: '随便记点什么，可跳过', ta: true }] };
    }
    // 编辑时保留创建时间（时间线用创建时间），新增才用现在
    const editing = !!this.st.edit;
    const rec = { m: this.st.tag, t: editing ? this.st.edit.t : nowStr(), ts: editing ? this.st.edit.ts : Date.now() };
    // 备忘/购物：勾选完成态（编辑时沿用原完成态）
    rec.done = editing ? (!!this.st.edit.done) : false;
    rec.doneAt = editing ? (this.st.edit.doneAt || 0) : 0;
    // 主项：手填时可加 ~ 前缀（默认只记这次，加 ~ 存入选项池）
    let mainRaw = this.st.mainPick || this.st.main || '';
    const mainOnce = store.isOnce(mainRaw);
    rec.txt = store.stripOnce(mainRaw);
    if (!rec.txt) { wx.showToast({ title: '先写点什么', icon: 'none' }); return; }
    // 想做模块：分类为必选（默认已选「想做」）
    if (this.st.tag === 'want' && (!this.st.pick['wantKind'] || !this.st.pick['wantKind'].length)) {
      wx.showToast({ title: '请选择分类（想要/可做/喜欢）', icon: 'none' });
      return;
    }
    if (!this.st.mainPick && mainOnce && store.FIELDS[this.st.tag]) {
      const mg = f.main;
      const O = app.globalData.OPT;
      if (!O[mg]) O[mg] = [];
      if (O[mg].indexOf(rec.txt) < 0) { O[mg].push(rec.txt); store.addOption(mg, rec.txt); }
      this.st.froze = { txt: rec.txt, g: mg };
    }
    const ext = [], extSrc = [];
    f.items.forEach(it => {
      if (it.g) {
        (this.st.pick[it.g] || []).forEach(v => { ext.push(v); extSrc.push(it.g); });
        const rawTv = (this.st.typed[it.g] || '');
        const tv = store.stripOnce(rawTv);
        if (tv && ext.indexOf(tv) < 0) {
          ext.push(tv); extSrc.push(it.g);
          // 仅当带 ~ 前缀（且该组允许固化）才存入选项池
          if (it.freeze && store.isOnce(rawTv)) this.freezeOpt(it.g, tv);
        }
      } else if (it.fx) {
        (this.st.pick['fx:' + it.fx] || []).forEach(v => { ext.push(v); extSrc.push('fx:' + it.fx); });
      } else if (it.free) {
        const fv = (this.st.free[it.free] || '').trim();
        if (fv) { ext.push(fv); extSrc.push('free:' + it.free); }
      }
    });
    rec.ext = ext; rec.extSrc = extSrc;

    if (this.st.edit) {
      rec._rid = this.st.edit._rid; rec.id = this.st.edit.id;
      store.updateRecord(rec).then(() => {
        const G = app.globalData;
        const i = G.records.findIndex(r => r._rid === rec._rid);
        if (i >= 0) G.records[i] = store.decorate(rec);
        this.afterSave(rec);
      });
    } else {
      store.addRecord(rec).then(rid => {
        rec._rid = rid; rec.id = rid;
        app.globalData.records.unshift(store.decorate(rec));
        this.afterSave(rec);
      });
    }
  },
  afterSave(rec) {
    this.st.lastRec = rec;
    this.st.saved = { t: rec.t, txt: rec.txt };
    this.st.edit = null;
    this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
    this.setData({ saved: this.st.saved, editing: false, froze: this.st.froze });
    this.recompute();
    wx.showToast({ title: '已记下', icon: 'success', duration: 700 });
  },
  freezeOpt(g, v) {
    const O = app.globalData.OPT;
    if (O[g] && O[g].indexOf(v) >= 0) return;
    if (!O[g]) O[g] = [];
    O[g].push(v);
    store.addOption(g, v);
    this.st.froze = { txt: v, g };
  },
  onFrozeUndo() {
    const f = this.st.froze; if (!f) return;
    const O = app.globalData.OPT;
    if (O[f.g]) O[f.g] = O[f.g].filter(x => x !== f.txt);
    store.removeOption(f.g, f.txt);
    this.st.froze = null;
    this.setData({ froze: null });
    this.recompute();
  },
  onUndoSave() {
    const r = this.st.lastRec; if (!r) return;
    store.deleteRecord(r).then(() => {
      app.globalData.records = app.globalData.records.filter(x => x._rid !== r._rid);
      this.st.saved = null; this.st.lastRec = null;
      this.setData({ saved: null });
      this.recompute();
    });
  },
  onEditCancel() {
    this.st.edit = null; this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
    this.setData({ editing: false });
    this.recompute();
  },

  /* 点「最近」记录：选中并弹出「改 / 删除」操作条 */
  onRecentTap(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.recSel === id) { this.setData({ recSel: null, recSelRec: null }); return; }
    const r = (app.globalData.records || []).find(x => x.id === id);
    this.setData({ recSel: id, recSelRec: r ? { m: store.recMname(r), txt: r.txt } : null });
  },

  /* 点页面其它地方：收起记录操作条（失焦即关） */
  closeRecSel() {
    if (this.data.recSel != null) this.setData({ recSel: null, recSelRec: null });
  },

  /* 备忘/购物：勾选切换完成态（划线 + 记录完成时间） */
  onRecCheck(e) {
    const id = e.currentTarget.dataset.id;
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r || !store.isTask(r.m)) return;
    r.done = !r.done;
    r.doneAt = r.done ? Date.now() : 0;
    store.updateRecord(r).catch(() => {});
    this.recompute();
  },

  /* 点操作条「改」：回填到编辑区并滚到顶部 */
  onRecEdit() {
    const id = this.data.recSel; if (id == null) return;
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r) return;
    app.globalData.editRec = store.decorate(r);
    this.checkEdit();
    this.recompute();
    this.setData({ recSel: null, recSelRec: null, scrollTop: 0 });
  },

  /* 点操作条「删除」：删除并给出撤销机会 */
  onRecDel() {
    const id = this.data.recSel; if (id == null) return;
    const i = (app.globalData.records || []).findIndex(x => x.id === id);
    if (i < 0) return;
    const r = app.globalData.records[i];
    store.deleteRecord(r).then(() => {
      app.globalData.records.splice(i, 1);
      this.setData({ recSel: null, recSelRec: null, delUndo: { m: store.recMname(r), txt: r.txt, dump: r } });
      this.recompute();
    });
  },

  onUndoDel() {
    const u = this.data.delUndo; if (!u) return;
    const dump = u.dump;
    const rec = { m: dump.m, t: dump.t, txt: dump.txt, ext: dump.ext || [], extSrc: dump.extSrc || [], ts: dump.ts, done: dump.done || false, doneAt: dump.doneAt || 0 };
    store.addRecord(rec).then(rid => {
      rec._rid = rid; rec.id = rid;
      app.globalData.records.unshift(store.decorate(rec));
      this.setData({ delUndo: null });
      this.recompute();
    });
  },

  /* 下拉刷新：从云端重新拉取全部数据 */
  onRefresh() {
    this.setData({ refreshing: true });
    store.reload().then(() => {
      this.st.edit = null; this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
      // 刷新后仍在「来做」时，补回默认分类（避免默认「想做」被清空）
      if (this.st.tag === 'want' && !this.st.pick['wantKind']) this.st.pick['wantKind'] = store.wantKindDefault();
      this.rotateGreet();
      this.recompute();
      this.setData({ refreshing: false });
    }).catch(() => this.setData({ refreshing: false }));
  },

  /* 点「最近」标题右侧「清单」：进入待办清单（备忘 / 购物） */
  goList() {
    wx.navigateTo({ url: '/pages/list/list' });
  },

  /* -------- 选项管理：跳转到独立子页面（返回即回「记」页，不退出小程序） -------- */
  onManage(e) {
    const g = e.currentTarget.dataset.g;
    const url = '/pages/options/options?group=' + encodeURIComponent(g);
    wx.navigateTo({
      url,
      fail: (err) => {
        console.error('[manage] navigateTo 失败：', err, 'url=', url, '当前页面栈=', getCurrentPages().length);
        // 页面栈已满或跳转异常时，退一层再重试，避免用户彻底打不开
        const pages = getCurrentPages();
        if (pages.length >= 10) {
          wx.navigateBack({ delta: 1, success: () => wx.navigateTo({ url, fail: () => wx.showToast({ title: '打开管理页失败', icon: 'none' }) }) });
        } else {
          wx.showToast({ title: '打开管理页失败', icon: 'none' });
        }
      }
    });
  }
});
