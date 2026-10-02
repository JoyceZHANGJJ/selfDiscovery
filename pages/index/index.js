// pages/index/index.js —— 记
const store = require('../../utils/store.js');
const app = getApp();

function nowStr() {
  const d = new Date();
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
// 时间戳 -> { date:'YYYY-MM-DD', time:'HH:MM' }
function dtStr(ts) {
  if (!ts) return { date: '', time: '' };
  const d = new Date(ts);
  return {
    date: d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2),
    time: ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
  };
}
// 'YYYY-MM-DD' + 'HH:MM' -> { ts, t }
function tsFromDate(dStr, tStr) {
  const p = (dStr || '').split('-').map(Number);
  const q = (tStr || '').split(':').map(Number);
  if (p.length !== 3 || q.length !== 2 || isNaN(p[0])) return { ts: Date.now(), t: nowStr() };
  const ts = new Date(p[0], p[1] - 1, p[2], q[0], q[1], 0, 0).getTime();
  return { ts, t: ('0' + q[0]).slice(-2) + ':' + ('0' + q[1]).slice(-2) };
}
// 用时格式化（与看页一致）：不足 1 天用小时；满 1 天用「天」保留一位小数；不足 1 分钟为“片刻”
function fmtDur(ms) {
  if (ms <= 0) return '';
  const DAY = 86400000, HOUR = 3600000, MIN = 60000;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    if (h > 0) return h + ' 小时';
    const m = Math.floor(ms / MIN);
    if (m > 0) return m + ' 分钟';
    return '片刻';
  }
  const d = ms / DAY;
  return (Math.round(d * 10) / 10) + ' 天';
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
    froze: null,
    editing: false,
    refreshing: false,
    focusIdx: -1,
    scrollTop: 0,
    scrollTo: '',
    recSel: null,
    recSelRec: null,
    delUndo: null,
    editDate: '',
    editTime: '',
    editCreateLabel: '创建时间',
    editHasStart: false,
    editStartDate: '',
    editStartTime: '',
    editHasEnd: false,
    editEndDate: '',
    editEndTime: '',
    editHasAbandon: false,
    editAbandonDate: '',
    editAbandonTime: ''
  },

  st: {
    tag: 'obs', main: '', mainPick: null, pick: {}, typed: {}, free: {},
    edit: null, ren: null, optUndo: null,
    startMode: false, completing: false, doing: false, showDoing: false, showDone: false,
    abandoning: false, showAbandon: false, ending: false, focusFree: ''
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
      // 进入「无感」时若还没选分类，补上默认分类「不想」
      if (cur === 'nope' && !this.st.pick['nopeKind']) this.st.pick['nopeKind'] = store.nopeKindDefault();
      // 回到记页且没有待编辑记录时，清掉可能残留的编辑态，避免所有操作一直被拦
      if (!app.globalData.editRec) this.setData({ editing: false });
      this.checkEdit();
      this.rotateGreet();
      // 数据就绪后再渲染真实内容，避免首屏出现空卡片「闪一下」；
      // 必须在 recompute() 之前置 ready:true，否则流转聚焦时真实输入框尚未渲染，scroll/聚焦都失效
      this.setData({ ready: true });
      this.recompute();
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
    // 历史遗留 m='done' 记录（新流程已并入「可做」）：无对应字段定义，安全跳过编辑，避免崩溃
    if (!store.FIELDS[r.m]) { this.st.edit = null; this.setData({}); return; }
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
    if (r.m === 'nope' && !this.st.pick['nopeKind']) this.st.pick['nopeKind'] = store.nopeKindDefault();
    // 「开始」流转进入：稍后在「保存修改」时才记录开始时间（这里只标记 startMode）
    this.st.startMode = !!g.editStart; g.editStart = null;
    // 「完成」流转进入：稍后在「保存修改」时才置「做了」并记录完成时间（这里只标记 completing）
    this.st.completing = !!g.editComplete; g.editComplete = null;
    // 「放弃」流转进入：稍后在「保存修改」时才置「不做」并记录放弃时间（这里只标记 abandoning）
    this.st.abandoning = !!g.editAbandon; g.editAbandon = null;
    // 「结束」流转进入（觉察/无感）：自动定位到「感受」输入框并弹出键盘，便于立刻记感受
    // 结束时间不在这里落，稍后在「保存修改」时才记录并写云（这里只标记 ending）
    this.st.ending = !!g.editEnding; g.editEnding = null;
    this.st.focusFree = g.editEndFocus ? (r.m === 'obs' ? 'obsfeel' : (r.m === 'nope' ? 'nopefeel' : '')) : '';
    g.editEndFocus = null;
    // 展示哪些字段：点「完成」(action)→仅做了的感受/收获并聚焦；点「开始」(action)→仅进行中感受并聚焦；
    // 点「放弃」(action)→仅“为什么不做了”并聚焦；普通点开编辑：做中→进行中感受；已做（做了）→进行中感受 与 做了的感受/收获 都可改；
    // 已「不做」→“为什么不做了”可改
    if (r.m === 'want') {
      const st0 = r.status || '';
      const isDone = st0 === 'done';
      const isAbandon = st0 === 'abandon';
      if (this.st.completing) { this.st.showDoing = false; this.st.showDone = true; this.st.showAbandon = false; }
      else if (this.st.startMode) { this.st.showDoing = true; this.st.showDone = false; this.st.showAbandon = false; }
      else if (this.st.abandoning) { this.st.showDoing = false; this.st.showDone = false; this.st.showAbandon = true; }
      else { this.st.showDoing = (st0 === 'doing') || isDone; this.st.showDone = isDone; this.st.showAbandon = isAbandon; }
      this.st.abandoning = this.st.abandoning || isAbandon; // 编辑「不做」记录时保持放弃态，保存不改状态/时间
      this.st.doing = this.st.showDoing;
    } else {
      this.st.doing = false; this.st.completing = false; this.st.showDoing = false; this.st.showDone = false;
      this.st.abandoning = false; this.st.showAbandon = false;
    }
    // 编辑时回填时间字段，供「改时间」使用
    // 做了的记录：legacy(m='done') 完成时间=ts、惦记=refTs；新流程(want+status done) 完成时间=doneAt、创建=ts
    // 觉察(obs)：结束时间=endTs（无则默认当前，编辑时可改）
    const isLegacyDone = r.m === 'done';
    const isWantDone = (r.m === 'want') && (r.status === 'done');   // 仅「已做（做了）」记录回显结束时间；点「完成」流转时结束时间在保存时才记，不展示结束时间输入框
    const isDoneView = isLegacyDone || isWantDone;
    const isWantAbandon = (r.m === 'want') && (r.status === 'abandon' || this.st.abandoning);
    const createTs = isLegacyDone ? (r.refTs || r.ts) : r.ts;   // 做了(legacy)：惦记=refTs；want-done/obs：创建=ts
    const startTs = r.startedAt || 0;
    let endTs = 0;
    if (isLegacyDone) endTs = r.ts;                              // legacy：完成=ts
    else if (isWantDone) endTs = r.doneAt || 0;                  // want-done：完成=doneAt
    else if (r.m === 'obs' || r.m === 'nope') endTs = r.endTs || 0;   // 觉察/无感：结束=endTs；未结束(首次)不填，由「结束」按钮记录
    const abandonTs = isWantAbandon ? (r.abandonedAt || Date.now()) : 0;  // 不做：放弃时间=abandonedAt，无则默认现在
    const c = dtStr(createTs), s = dtStr(startTs), e = dtStr(endTs), ab = dtStr(abandonTs);
    this.setData({
      editing: true,
      editCreateLabel: isLegacyDone ? '惦记于' : '创建时间',
      editDate: c.date, editTime: c.time,
      editHasStart: !!startTs,
      editStartDate: s.date, editStartTime: s.time,
      // 觉察/无感：点「改」且已有结束时间才回显结束时间供修改；点「结束」进入时不回显（结束时间在保存时才记）
      editHasEnd: isDoneView || ((r.m === 'obs' || r.m === 'nope') && !!r.endTs && !this.st.ending),
      editEndDate: e.date, editEndTime: e.time,
      editHasAbandon: isWantAbandon,
      editAbandonDate: ab.date, editAbandonTime: ab.time
    });
  },

  /* 编辑态：修改时间（创建 / 开始 / 结束） */
  onEditDate(e) { this.setData({ editDate: e.detail.value }); },
  onEditTime(e) { this.setData({ editTime: e.detail.value }); },
  onEditStartDate(e) { this.setData({ editStartDate: e.detail.value }); },
  onEditStartTime(e) { this.setData({ editStartTime: e.detail.value }); },
  onEditEndDate(e) { this.setData({ editEndDate: e.detail.value }); },
  onEditEndTime(e) { this.setData({ editEndTime: e.detail.value }); },
  onEditAbandonDate(e) { this.setData({ editAbandonDate: e.detail.value }); },
  onEditAbandonTime(e) { this.setData({ editAbandonTime: e.detail.value }); },

  recVM(r) {
    const dt = store.buildExt(r.m, r.ext, r.extSrc);
    const ago = store.agoOf(r.ts);
    const d = ago <= 0 ? '' : (ago === 1 ? '昨天' : (ago === 2 ? '前天' : store.dayLabel(ago))) + ' ';
    const task = store.isTask(r.m);
    const doingDays = (r.m === 'want' && r.status === 'doing' && r.startedAt) ? Math.max(1, Math.floor((Date.now() - r.startedAt) / 86400000)) : 0;
    // 用时/历时（与看页一致）：做了=用了/惦记了；觉察=历时
    let dur = '';
    const isDoneView = (r.m === 'done') || (r.m === 'want' && r.status === 'done');
    if (isDoneView) {
      const endTs = r.doneAt || r.ts;
      const baseTs = r.m === 'done' ? (r.refTs || r.ts) : r.ts;
      let durLabel = '', durMs = 0;
      if (r.startedAt && endTs && r.startedAt <= endTs) { durMs = endTs - r.startedAt; durLabel = '用了'; }
      else if (baseTs && endTs && baseTs <= endTs) { durMs = endTs - baseTs; durLabel = '惦记了'; }
      const ds = fmtDur(durMs);
      if (ds) dur = ds === '片刻' ? durLabel + ds : durLabel + ' ' + ds;
    }
    if ((r.m === 'obs' || r.m === 'nope') && r.endTs && r.ts && r.endTs > r.ts) {
      const ds = fmtDur(r.endTs - r.ts);
      if (ds) dur = ds === '片刻' ? '历时片刻' : '历时 ' + ds;
    }
    // 不做 的历时：从创建到放弃（惦记了多久）
    if (r.m === 'want' && r.status === 'abandon' && r.abandonedAt && r.ts && r.abandonedAt >= r.ts) {
      const ds = fmtDur(r.abandonedAt - r.ts);
      if (ds) dur = ds === '片刻' ? '惦记了片刻' : '惦记了 ' + ds;
    }
    return { id: r.id, m: store.recMname(r), c: store.mcolor(r.m), txt: r.txt, t: r.t, d, dt, task, done: !!r.done, doneLabel: store.doneLabel(r.doneAt), reason: r.reason || '', usefor: r.usefor || '', status: r.status || '', doingDays, dur };
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
    // 「可做」按流转状态过滤字段：进行中感受 仅做中/点开始/已做编辑时显示；做了的感受/收获 仅点完成/已做编辑时显示；
    // 为什么不做了 仅点放弃/编辑「不做」时显示
    let fitems = f.items;
    if (tag === 'want') {
      fitems = f.items.filter(it => {
        if (it.free === 'doingNote') return !!this.st.showDoing;
        if (it.free === 'doneFeel' || it.free === 'doneGain') return !!this.st.showDone;
        if (it.free === 'abandonWhy') return !!this.st.showAbandon;
        return true;
      });
    }
    const items = fitems.map((it, idx) => {
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
    // 自动聚焦：开始 → 进行中感受；完成 → 做了的感受；放弃 → 为什么不做了；结束(觉察/无感) → 感受
    const focusKey = this.st.startMode ? 'doingNote' : (this.st.completing ? 'doneFeel' : (this.st.abandoning ? 'abandonWhy' : (this.st.focusFree || '')));
    const focusIdx = focusKey ? items.findIndex(it => it.type === 'free' && it.key === focusKey) : -1;
    const MAINPH = { memo: '要记住什么 · 回车就记下', buy: '要买什么 · 可写「牛奶 2」' };
    // 备忘 / 购物：只保留一个输入框，不显示标题、选项池与管理入口
    const plain = store.isTask(tag);
    // focusIdx 必须返回：recompute 依赖它做「滚动到目标输入框 + 程序化聚焦弹键盘」
    return { main: main, mainLabel: store.GLABEL[main], mainOpts, mainVal: this.st.main || '', items, plain, focusIdx, mainPh: MAINPH[tag] || '手填或直接写一句 · 默认只记这次，加 ~ 存入选项池' };
  },

  recompute() {
    const recs = (app.globalData.records || []).slice(0, 3).map(r => this.recVM(r));
    const composer = this.buildComposer();
    const fi = composer.focusIdx;
    const willFocus = fi >= 0;
    // 进入流转（开始/完成/放弃）时：
    // 1) 先把 scroll-view 滚回顶部（composer 在顶部），确保目标输入框落在可视区——
    //    否则从看页返回时页面可能停在下方，输入框在屏外，scroll-view 内聚焦不弹键盘；
    // 2) 先以 focusIdx=-1 渲染出未聚焦的 textarea（避免「新建即聚焦」不弹键盘）；
    // 3) 延时一帧再翻转 focus 属性并程序化 ctx.focus()，稳定弹出键盘与光标。
    // textarea 用 adjust-position=false，避免键盘弹出时二次滚动再次失焦。
    const patch = {
      modules: this.modulesVM(),
      tag: this.st.tag,
      composer,
      focusIdx: willFocus ? -1 : fi,
      // 进入流转（开始/完成/放弃/结束）：先把目标输入框滚到可视区顶部，配合 adjust-position 让键盘不遮挡
      scrollTo: willFocus ? ('fld' + fi) : '',
      recent: recs
    };
    // 只在流转聚焦时强制回到顶部。平时不要把 scrollTop 原样写回——
    // 「滚动到保存按钮」会把居中位置存进 scrollTop，若每次渲染都套用，
    // 刷新、切 tab 回来等场景都会被反复拉回那个居中位置（即使已退出编辑态）
    if (willFocus) patch.scrollTop = 0;
    this.setData(patch, () => {
      if (!willFocus) return;
      setTimeout(() => {
        this.setData({ focusIdx: fi });
        wx.createSelectorQuery().select('#fld' + fi).context(res => {
          const ctx = res && res.context;
          if (ctx && typeof ctx.focus === 'function') ctx.focus();
        }).exec();
      }, 300);
    });
  },

  /* -------- 交互 -------- */
  onTag(e) {
    if (this.guardEdit()) return;   // 编辑态：不允许切换维度
    this.st.tag = e.currentTarget.dataset.k;
    this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
    this.st.startMode = false; this.st.doing = false; this.st.completing = false; this.st.showDoing = false; this.st.showDone = false; this.st.abandoning = false; this.st.showAbandon = false; this.st.ending = false;
    if (this.st.tag === 'want' && !this.st.pick['wantKind']) this.st.pick['wantKind'] = store.wantKindDefault();
    if (this.st.tag === 'nope' && !this.st.pick['nopeKind']) this.st.pick['nopeKind'] = store.nopeKindDefault();
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

  /* 输入框获得焦点：不再手动 scroll-into-view。
     手动滚动会与 adjust-position 的原生键盘避让叠加（先被滚到顶部、又被原生推起一次），
     导致键盘弹出时输入框“飞”到页面顶端。现在键盘避让统一交给 adjust-position 原生处理；
     流转进入（开始/完成/放弃/结束）的预滚动仍在 recompute 里、发生在键盘弹出前，不受影响。 */
  onFieldFocus() {},

  /* -------- 编辑态（回显）锁定 -------- */
  // composer 内的点击在这里截止，不冒泡到 body（编辑当前记卡内容是允许的）
  noop() {},

  // 编辑态下，除「编辑当前记卡内容」与「保存修改 / 取消」以外的操作都拦下，
  // 并把「保存修改」按钮滚到屏幕中间，提示先把这一条处理完
  guardEdit() {
    if (!this.data.editing) return false;
    this.scrollSaveToCenter();
    this.tipSaveFirst();
    return true;
  },

  // 每次被拦下的点击都提示一次。连续点击时先 hideToast，
  // 否则上一条 toast 还在显示，新的可能不弹出（表现为「只有第一次有提示」）
  tipSaveFirst() {
    if (wx.hideToast) wx.hideToast();
    wx.showToast({ title: '请先保存修改或取消', icon: 'none', duration: 800 });
  },

  // 主题切换在编辑态被锁：滚动到保存按钮并提示（与页面内其它无效操作一致）
  onLocked() { this.guardEdit(); },

  // 把「保存修改」按钮滚到滚动区垂直居中
  scrollSaveToCenter() {
    const q = wx.createSelectorQuery().in(this);
    q.select('#savebar').boundingClientRect();
    q.select('.screen').boundingClientRect();
    q.select('.screen').scrollOffset();
    q.exec(res => {
      const save = res[0], sv = res[1], off = res[2];
      if (!save || !sv) return;
      // 目标：按钮中心落在滚动区中心 → 计算需要再滚动多少
      const delta = save.top - (sv.top + (sv.height - save.height) / 2);
      let top = Math.max(0, ((off && off.scrollTop) || 0) + delta);
      // scroll-top 写入与当前相同的值不会触发滚动，做 1px 微调确保每次点击都生效
      if (Math.abs(top - (this.data.scrollTop || 0)) < 1) top += 1;
      this.setData({ scrollTo: '', scrollTop: top });
    });
  },

  // 编辑区之外（最近列表、空白处等）的点击
  onBodyTap() {
    if (this.guardEdit()) return;
    this.closeRecSel();
  },

  /* -------- 保存 -------- */
  doSave() {
    let f = store.FIELDS[this.st.tag];
    if (!f) {
      const d = (app.globalData.dims || []).find(x => x.k === this.st.tag);
      if (d) f = { main: 'm_' + this.st.tag, items: [{ g: 'm_' + this.st.tag, freeze: true, single: true }, { free: 'note', label: '补充', ph: '随便记点什么，可跳过', ta: true }] };
    }
    // 编辑时：按记录类型拼装时间
    //  · 非 done：创建时间=ts；做了(legacy m='done')：结束时间=ts(完成)，创建(惦记)=refTs
    //  · 新流程 want+done：创建时间=ts，完成时间=doneAt（可被「结束时间」输入框改写）
    //  · 开始时间=startedAt（want 在做 / done 时存在）
    const editing = !!this.st.edit;
    const er = this.st.edit || {};
    const erDoneLegacy = er.m === 'done';
    const erWantDone = (er.m === 'want') && (er.status === 'done' || this.st.completing);
    const erWantAbandon = (er.m === 'want') && (er.status === 'abandon' || this.st.abandoning);
    const c = tsFromDate(this.data.editDate, this.data.editTime);
    let startedAt = er.startedAt || 0;
    if (this.data.editHasStart) startedAt = tsFromDate(this.data.editStartDate, this.data.editStartTime).ts;
    let recTs, recT, refTs = er.refTs || 0;
    if (erDoneLegacy) {
      const e = tsFromDate(this.data.editEndDate, this.data.editEndTime);
      recTs = e.ts; recT = e.t;   // 结束时间 = 完成时间
      refTs = c.ts;               // 惦记(创建)时间
    } else {
      recTs = c.ts; recT = c.t;   // 创建时间
    }
    const rec = { m: this.st.tag, t: recT, ts: recTs };
    // 备忘/购物：勾选完成态（编辑时沿用原完成态）
    rec.done = editing ? (!!er.done) : false;
    rec.doneAt = editing ? (er.doneAt || 0) : 0;
    // 保留流转相关字段（状态 / 开始时间 / 来源），避免编辑时被丢
    rec.status = er.status || '';
    rec.startedAt = startedAt;
    // 「开始」流转进入：保存时才落「进行中感受」这一刻——状态置在做、开始时间记当前
    if (this.st.startMode) { rec.status = 'doing'; rec.startedAt = Date.now(); }
    // 「完成」流转进入：保存时才置「做了」并记录完成时间（默认现在）
    if (this.st.completing) { rec.status = 'done'; rec.doneAt = Date.now(); }
    // 「放弃」流转进入：保存时才置「不做」并记录放弃时间（默认现在）
    if (this.st.abandoning) { rec.status = 'abandon'; rec.abandonedAt = Date.now(); }
    if (er.ref) rec.ref = er.ref;
    if (er.refTxt) rec.refTxt = er.refTxt;
    if (erDoneLegacy) rec.refTs = refTs;
    // 新流程「做了」记录(want+done)：完成时间改用「结束时间」输入框，用户改过才覆盖
    if (erWantDone && this.data.editHasEnd) {
      const e = tsFromDate(this.data.editEndDate, this.data.editEndTime);
      if (e.ts) rec.doneAt = e.ts;
    }
    // 不做 记录(want+abandon)：放弃时间改用「放弃时间」输入框，用户改过才覆盖
    if (erWantAbandon && this.data.editHasAbandon) {
      const e = tsFromDate(this.data.editAbandonDate, this.data.editAbandonTime);
      if (e.ts) rec.abandonedAt = e.ts;
    }
    // 觉察(obs)/无感(nope)：结束时间
    // - 点「结束」进入（ending）：保存修改这一刻才落结束时间（默认现在），此前不写云；
    // - 点「改」进来且显示结束时间输入框：用户改过才覆盖；
    // - 未结束且非结束流转：保持原样，编辑内容不碰结束时间
    if (er.m === 'obs' || er.m === 'nope') {
      if (this.st.ending) {
        rec.endTs = Date.now();
      } else if (this.data.editHasEnd) {
        const e = tsFromDate(this.data.editEndDate, this.data.editEndTime);
        if (e.ts) rec.endTs = e.ts;
      } else {
        rec.endTs = er.endTs || 0;
      }
    }
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
    // 无感模块：分类为必选（默认已选「不想」）
    if (this.st.tag === 'nope' && (!this.st.pick['nopeKind'] || !this.st.pick['nopeKind'].length)) {
      wx.showToast({ title: '请选择分类（不想/没兴趣/不喜欢）', icon: 'none' });
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
  // 「可做 / 无感」的分类是必选项：清空表单后要把默认分类补回来，
  // 否则分类选中态丢失，下一条还会因「请选择分类」而记不进去
  ensureDefaultKind() {
    if (this.st.tag === 'want' && !this.st.pick['wantKind']) this.st.pick['wantKind'] = store.wantKindDefault();
    if (this.st.tag === 'nope' && !this.st.pick['nopeKind']) this.st.pick['nopeKind'] = store.nopeKindDefault();
  },

  afterSave(rec) {
    this.st.edit = null; this.st.startMode = false; this.st.doing = false; this.st.completing = false; this.st.showDoing = false; this.st.showDone = false;
    this.st.abandoning = false; this.st.showAbandon = false; this.st.ending = false; this.st.focusFree = '';
    this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
    this.ensureDefaultKind();   // 记下后仍在 可做/无感 时，把默认分类选回来
    this.setData({ editing: false, focusIdx: -1, editDate: '', editTime: '', editHasStart: false, editStartDate: '', editStartTime: '', editHasEnd: false, editEndDate: '', editEndTime: '', editHasAbandon: false, editAbandonDate: '', editAbandonTime: '', froze: this.st.froze });
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
    if (this.guardEdit()) return;
    const f = this.st.froze; if (!f) return;
    const O = app.globalData.OPT;
    if (O[f.g]) O[f.g] = O[f.g].filter(x => x !== f.txt);
    store.removeOption(f.g, f.txt);
    this.st.froze = null;
    this.setData({ froze: null });
    this.recompute();
  },
  onEditCancel() {
    this.st.edit = null; this.st.startMode = false; this.st.doing = false; this.st.completing = false; this.st.showDoing = false; this.st.showDone = false; this.st.abandoning = false; this.st.showAbandon = false; this.st.ending = false; this.st.focusFree = ''; this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
    this.ensureDefaultKind();   // 取消编辑后仍在 可做/无感 时，把默认分类选回来
    this.setData({ editing: false, focusIdx: -1, editDate: '', editTime: '', editHasStart: false, editStartDate: '', editStartTime: '', editHasEnd: false, editEndDate: '', editEndTime: '', editHasAbandon: false, editAbandonDate: '', editAbandonTime: '' });
    this.recompute();
  },

  /* 点「最近」记录：选中并弹出「改 / 删除」操作条 */
  onRecentTap(e) {
    if (this.guardEdit()) return;   // 编辑态：不允许选中其它记录
    const id = e.currentTarget.dataset.id;
    if (this.data.recSel === id) { this.setData({ recSel: null, recSelRec: null }); return; }
    const r = (app.globalData.records || []).find(x => x.id === id);
    this.setData({ recSel: id, recSelRec: r ? { m: store.recMname(r), txt: r.txt, rawm: r.m, status: r.status || '', ended: !!r.endTs } : null });
  },

  /* 记录操作条统一入口（记页「最近」与看页共用 rec-actions 组件；行为各自实现，按钮集合只维护一处）
     type: start | complete | abandon | restore | end | edit | del */
  onRecAction(e) {
    if (this.guardEdit()) return;   // 编辑态：不允许对其它记录做流转/改/删
    const type = e.detail.type;
    const id = this.data.recSel; if (id == null) return;
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r) return;
    if (type === 'start' || type === 'complete' || type === 'abandon') {
      if (r.m !== 'want') return;
      app.globalData.editRec = r;
      if (type === 'start') app.globalData.editStart = true;
      if (type === 'complete') app.globalData.editComplete = true;
      if (type === 'abandon') app.globalData.editAbandon = true;
      this.setData({ recSel: null, recSelRec: null });
      this.checkEdit(); this.recompute();
      return;
    }
    if (type === 'restore') {
      if (r.m !== 'want' || r.status !== 'abandon') return;
      const now = Date.now();
      r.status = ''; r.ts = now; r.t = nowStr();
      r.abandonedAt = 0; r.startedAt = 0;
      const es = r.extSrc || [], ex = r.ext || [];
      const keep = [];
      for (let i = 0; i < es.length; i++) { if (es[i] === 'free:abandonWhy') continue; keep.push(i); }
      r.extSrc = keep.map(i => es[i]); r.ext = keep.map(i => ex[i]);
      store.updateRecord(r).catch(() => {});
      this.setData({ recSel: null, recSelRec: null });
      this.recompute();
      return;
    }
    if (type === 'end') {
      if (r.m !== 'obs' && r.m !== 'nope') return;
      // 不在这里落结束时间：只标记待结束，等点「保存修改」时才记录结束时间并写云
      // 同时打开编辑态聚焦「感受」输入框、弹键盘，便于立刻记感受
      app.globalData.editRec = r;
      app.globalData.editEnding = true;
      app.globalData.editEndFocus = true;
      this.setData({ recSel: null, recSelRec: null });
      this.checkEdit();
      this.recompute();
      return;
    }
    if (type === 'edit') {
      app.globalData.editRec = store.decorate(r);
      this.checkEdit(); this.recompute();
      this.setData({ recSel: null, recSelRec: null, scrollTop: 0 });
      return;
    }
    if (type === 'del') { this.onRecDel(); return; }
  },

  /* 点页面其它地方：收起记录操作条（失焦即关） */
  closeRecSel() {
    if (this.data.recSel != null) this.setData({ recSel: null, recSelRec: null });
  },

  /* 备忘/购物：勾选切换完成态（划线 + 记录完成时间） */
  onRecCheck(e) {
    if (this.guardEdit()) return;
    const id = e.currentTarget.dataset.id;
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r || !store.isTask(r.m)) return;
    r.done = !r.done;
    r.doneAt = r.done ? Date.now() : 0;
    store.updateRecord(r).catch(() => {});
    this.recompute();
  },

  /* 点操作条「删除」：删除并给出撤销机会 */
  onRecDel() {
    if (this.guardEdit()) return;
    const id = this.data.recSel; if (id == null) return;
    const i = (app.globalData.records || []).findIndex(x => x.id === id);
    if (i < 0) return;
    const r = app.globalData.records[i];
    store.deleteRecord(r).then(() => {
      app.globalData.records.splice(i, 1);
      this.setData({ recSel: null, recSelRec: null, delUndo: { m: store.recMname(r), txt: r.txt, dump: r } });
      this.recompute();
      if (this._delTimer) clearTimeout(this._delTimer);
      this._delTimer = setTimeout(() => {
        if (this.data.delUndo) this.setData({ delUndo: null });
      }, 3000);
    });
  },

  onUndoDel() {
    if (this.guardEdit()) return;
    const u = this.data.delUndo; if (!u) return;
    if (this._delTimer) { clearTimeout(this._delTimer); this._delTimer = null; }
    const dump = u.dump;
    // 删除后撤销：忠实还原原记录，保留状态（未做/在做/做了/不做）、开始时间与放弃时间
    const rec = { m: dump.m, t: dump.t, txt: dump.txt, ext: dump.ext || [], extSrc: dump.extSrc || [], ts: dump.ts, done: dump.done || false, doneAt: dump.doneAt || 0, status: dump.status || '', startedAt: dump.startedAt || 0, abandonedAt: dump.abandonedAt || 0 };
    store.addRecord(rec).then(rid => {
      rec._rid = rid; rec.id = rid;
      app.globalData.records.unshift(store.decorate(rec));
      this.setData({ delUndo: null });
      this.recompute();
    });
  },

  /* 下拉刷新：从云端重新拉取全部数据 */
  onRefresh() {
    // 编辑态：下拉刷新会丢掉未保存的编辑，拦下并滚到「保存修改」
    if (this.data.editing) { this.setData({ refreshing: false }); this.guardEdit(); return; }
    this.setData({ refreshing: true });
    store.reload().then(() => {
      this.st.edit = null; this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
      this.st.startMode = false; this.st.completing = false; this.st.abandoning = false; this.st.showDoing = false; this.st.showDone = false; this.st.showAbandon = false; this.st.ending = false;
      // 刷新后仍在「来做」时，补回默认分类（避免默认「想做」被清空）
      if (this.st.tag === 'want' && !this.st.pick['wantKind']) this.st.pick['wantKind'] = store.wantKindDefault();
      if (this.st.tag === 'nope' && !this.st.pick['nopeKind']) this.st.pick['nopeKind'] = store.nopeKindDefault();
      this.rotateGreet();
      this.recompute();
      this.setData({ refreshing: false });
    }).catch(() => this.setData({ refreshing: false }));
  },

  /* 点「最近」标题右侧「清单」：进入待办清单（备忘 / 购物） */
  goList() {
    if (this.guardEdit()) return;
    wx.navigateTo({ url: '/pages/list/list' });
  },

  /* -------- 选项管理：跳转到独立子页面（返回即回「记」页，不退出小程序） -------- */
  onManage(e) {
    if (this.guardEdit()) return;   // 编辑态：不允许跳去管理选项
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
