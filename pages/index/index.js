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
    appName: (app && app.APP_NAME) || '',
    brandTop: 0,
    brandLeft: 0,
    brandW: 0,
    brandH: 0,
    brandChars: [],
    brandPlay: false,
    ready: false,
    modules: [],
    tag: 'obs',
    greet: { t: '', s: '' },
    composer: {},
    recent: [],
    froze: null,
    editing: false,
    focusIdx: -1,
    scrollTop: 0,
    composerTop: 0,
    scrollTo: '',
    // 维度标签行的「可滚动」渐变提示：只有标签真的超出、右侧还有内容时才显示
    tagFade: false,
    recSel: null,
    recSelRec: null,
    delUndo: null,
    // 吸底操作行（记下 / 保存修改 / 取消）的 bottom：默认抬到底部 tab 栏之上，键盘弹出时再抬到键盘之上
    barBottom: 'calc(58px + env(safe-area-inset-bottom, 0px))',
    // 待办长按就地编辑（与清单 / 看页共用的 inline-editor 组件）
    qeOn: false,
    qeFocus: false,       // 显示与聚焦分开：手指抬起后才聚焦（见 onRowTouchend）
    qeId: '',
    qeTxt: '',
    qe: { top: 0, left: 0, width: 0, height: 0 },
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

  onLoad() {
    // 吸底操作行要跟着键盘走：页面级滚动下微信不会缩小视口（而是滚动页面让输入框可见），
    // 所以直接把键盘高度当 bottom，操作行始终落在键盘上方
    this._kbHandler = (res) => {
      const h = (res && res.height) || 0;
      this.setData({ barBottom: h > 0 ? h + 'px' : 'calc(58px + env(safe-area-inset-bottom, 0px))' });
    };
    if (wx.onKeyboardHeightChange) wx.onKeyboardHeightChange(this._kbHandler);
  },

  onUnload() {
    if (wx.offKeyboardHeightChange && this._kbHandler) wx.offKeyboardHeightChange(this._kbHandler);
    this._kbHandler = null;
  },

  onShow() {
    this.ensureTheme();
    this.layoutBrand();
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
      // 回到记页且没有待编辑记录时，清掉可能残留的编辑态，避免所有操作一直被拦
      // （从「管理选项」页返回时除外：编辑中的内容与状态要原样保留）
      if (!app.globalData.editRec && !this.st.fromManage) this.setData({ editing: false });
      this.st.fromManage = false;
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

  onHide() {
    // 离开页面（切 tab / 去清单 / 进后台）不保留操作条与撤销条，回来是一页干净的
    this.clearFloats();
  },

  ensureTheme() {
    const t = store.curTheme();
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    this.setData({ theme: t, statusH: info.statusBarHeight || 20 });
  },

  /* 程序名藏在胶囊「背后」：按胶囊的矩形定位，平时被原生胶囊盖住，
     只有下拉刷新把页面（含这个 fixed 元素）推下去时才露出来。 */
  layoutBrand() {
    try {
      const mb = wx.getMenuButtonBoundingClientRect && wx.getMenuButtonBoundingClientRect();
      if (!mb || !mb.height) return;
      this.setData({
        brandTop: mb.top, brandLeft: mb.left, brandW: mb.width, brandH: mb.height,
        brandChars: String(this.data.appName || '').split('')
      });
    } catch (e) { /* 取不到就不显示 */ }
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
      // 老数据的「程度+情绪」合并值（如「微微抵触」）已由 migrateNopeLikeIntoObs 一次性拆开，这里不再处理
      const O = store.getOPT(src);
      // 「沉浸 / 精力」是写死在代码里的固定选项组（fx:）：它们天然不在选项池里（ensureRecOpts 也特意跳过），
      // 所以不能按「池里有这个值 → 选中」来判断，否则这两行编辑时永远空着（值会被塞进 typed，而 fx 行不渲染 typed）
      const isFixed = src.indexOf('fx:') === 0;
      // 不在选项池里的历史值：还能手填的组放进输入框；已经不给手填的组（noInput）
      // 也放进选中态 —— 由 buildComposer 作为临时 chip 展示，否则会在保存时被悄悄丢掉
      if (isFixed || O.indexOf(val) >= 0 || store.isNoInput(src)) (this.st.pick[src] = this.st.pick[src] || []).push(val);
      else this.st.typed[src] = val;
    });
    // 记录本身没有分类（历史数据）时才补默认分类；有则只回显记录自己的值，避免默认+记录值同时选中
    if (r.m === 'want' && !this.st.pick['wantKind']) this.st.pick['wantKind'] = store.wantKindDefault();
    // 「开始」流转进入：稍后在「保存修改」时才记录开始时间（这里只标记 startMode）
    this.st.startMode = !!g.editStart; g.editStart = null;
    // 「完成」流转进入：稍后在「保存修改」时才置「做了」并记录完成时间（这里只标记 completing）
    this.st.completing = !!g.editComplete; g.editComplete = null;
    // 「放弃」流转进入：稍后在「保存修改」时才置「不做」并记录放弃时间（这里只标记 abandoning）
    this.st.abandoning = !!g.editAbandon; g.editAbandon = null;
    // 「结束」流转进入（觉察）：自动定位到「感受」输入框并弹出键盘，便于立刻记感受
    // 结束时间不在这里落，稍后在「保存修改」时才记录并写云（这里只标记 ending）
    this.st.ending = !!g.editEnding; g.editEnding = null;
    this.st.focusFree = g.editEndFocus ? 'obsfeel' : '';
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
    else if (r.m === 'obs') endTs = r.endTs || 0;                // 觉察：结束=endTs；未结束(首次)不填，由「结束」按钮记录
    const abandonTs = isWantAbandon ? (r.abandonedAt || Date.now()) : 0;  // 不做：放弃时间=abandonedAt，无则默认现在
    const c = dtStr(createTs), s = dtStr(startTs), e = dtStr(endTs), ab = dtStr(abandonTs);
    this.setData({
      editing: true,
      editCreateLabel: isLegacyDone ? '惦记于' : '创建时间',
      editDate: c.date, editTime: c.time,
      editHasStart: !!startTs,
      editStartDate: s.date, editStartTime: s.time,
      // 觉察：点「改」且已有结束时间才回显结束时间供修改；点「结束」进入时不回显（结束时间在保存时才记）
      editHasEnd: isDoneView || (r.m === 'obs' && !!r.endTs && !this.st.ending),
      editEndDate: e.date, editEndTime: e.time,
      editHasAbandon: isWantAbandon,
      editAbandonDate: ab.date, editAbandonTime: ab.time
    });
    // 进入编辑态后立刻把整页滚回顶部露出记卡：这里 cover 了所有入口
    //（操作条「改」/ 长按记录 / 从看页点「改」或长按后切回本页 / 从管理页返回后继续编辑），
    // 否则从下方「最近」或从看页回来时，页面还停在下方，记卡整个在屏幕外
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
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
    // 日期前缀：今天空串，昨天 / 前天相对说法，更早给日期（跨年才带年份）
    const d = store.datePrefix(r.ts);
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
    if (r.m === 'obs' && r.endTs && r.ts && r.endTs > r.ts) {
      const ds = fmtDur(r.endTs - r.ts);
      if (ds) dur = ds === '片刻' ? '历时片刻' : '历时 ' + ds;
    }
    // 不做 的历时：从创建到放弃（惦记了多久）
    if (r.m === 'want' && r.status === 'abandon' && r.abandonedAt && r.ts && r.abandonedAt >= r.ts) {
      const ds = fmtDur(r.abandonedAt - r.ts);
      if (ds) dur = ds === '片刻' ? '惦记了片刻' : '惦记了 ' + ds;
    }
    return { id: r.id, m: store.recMname(r), c: store.mcolor(r.m), txt: r.txt, desc: r.desc || '', t: r.t, tt: r.tt || r.t, d, dt, task, done: !!r.done, doneLabel: store.doneLabel(r.doneAt), reason: r.reason || '', usefor: r.usefor || '', status: r.status || '', doingDays, dur,
      // 清单标题超长：隐藏原因/用途，标题独占整行自动折行（右侧只留时间）
      longTxt: task && String(r.txt || '').length > 12 };
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
    // 历史数据里手填的「点」可能不在选项池里：把它作为临时选项排在最前，
    // 保证看得见、点一下能取消（带描述的模块没有主输入框，点只能从池里选）
    const legacyMain = (!this.st.mainPick && (this.st.main || '').trim()) || '';
    if (legacyMain && store.getOPT(main).indexOf(legacyMain) < 0) mainOpts.unshift({ v: legacyMain, on: true });
    // 「具体的描述」= 与「归类」(主项) 配对的自由字段。它不是普通细节项：单独摆在主输入框下方
    // （见 index.wxml），所以这里先从细节列表里摘出来；保存仍按 f.items 的原顺序写 ext/extSrc，
    // 于是 export/import 的按顺序对齐完全不受影响
    const descItem = (f.items || []).find(it => it.free === store.DESC_KEY);
    // 「可做」按流转状态过滤字段：进行中感受 仅做中/点开始/已做编辑时显示；做了的感受/收获 仅点完成/已做编辑时显示；
    // 为什么不做了 仅点放弃/编辑「不做」时显示
    let fitems = f.items.filter(it => it.free !== store.DESC_KEY);
    if (tag === 'want') {
      fitems = fitems.filter(it => {
        if (it.free === 'doingNote') return !!this.st.showDoing;
        if (it.free === 'doneFeel' || it.free === 'doneGain') return !!this.st.showDone;
        if (it.free === 'abandonWhy') return !!this.st.showAbandon;
        return true;
      });
    }
    // 档位（obsDeg）是情绪的修饰：没选情绪、也没有历史档位时整行不展示
    const showDeg = tag === 'obs' &&
      ((this.st.pick['obsMood'] || []).length > 0 || (this.st.pick['obsDeg'] || []).length > 0);
    // 展示顺序与存储顺序解耦：觉察的细节在编辑器里排成
    // 「分类 → 感受（情绪 chips + 档位副行 + 自由输入框）→ 怎么开始的 → 沉浸 → 精力」，
    // 但保存仍按 f.items 的原顺序写 ext/extSrc，导出/导入的按顺序对齐因此不受影响
    if (tag === 'obs') {
      const key = (it) => it.g || (it.fx ? 'fx:' + it.fx : 'free:' + it.free);
      // 档位紧跟情绪（点完情绪就在原处展开），自由感受再跟在后面
      const want = ['obsKind', 'obsMood', 'obsDeg', 'free:obsfeel', 'obsStart', 'fx:forgot', 'fx:nrg'];
      const rest = fitems.filter(it => want.indexOf(key(it)) < 0);   // 未列出的照旧附在后面，不会被吞掉
      fitems = want.map(k => fitems.find(it => key(it) === k)).filter(Boolean).concat(rest);
    }
    const items = fitems.map((it, idx) => {
      if (it.g) {
        const opts = store.getOPT(it.g).map(v => ({ v, on: (this.st.pick[it.g] || []).indexOf(v) >= 0 }));
        // 历史手填值不在选项池里（这个组后来取消了手填）：作为临时 chip 排在最前，
        // 保证看得见、点一下能取消，不会在保存时被悄悄丢掉
        (this.st.pick[it.g] || []).forEach(v => {
          if (store.getOPT(it.g).indexOf(v) < 0) opts.unshift({ v, on: true });
        });
        const ph = it.freeze ? '手填：加 ~ 才存入选项池' : '也可以手填，和选项一起记下（不加入选项）';
        // sub：情绪下面的档位副行——不显示标题、不给管理入口，chip 小一号，未选情绪时隐藏
        return { type: 'g', first: idx === 0, group: it.g, label: it.sub ? '' : store.GLABEL[it.g], single: !!it.single, freeze: !!it.freeze, noInput: !!it.noInput, ph, opts, typedVal: this.st.typed[it.g] || '',
          sub: !!it.sub, hide: !!it.sub && !showDeg };
      }
      if (it.fx) {
        const fx = store.FIXED[it.fx];
        const opts = fx.opts.map(v => ({ v, on: (this.st.pick['fx:' + it.fx] || []).indexOf(v) >= 0 }));
        return { type: 'fx', first: idx === 0, group: 'fx:' + it.fx, label: fx.label, opts };
      }
      return { type: 'free', first: idx === 0, key: it.free, label: it.label, ph: it.ph, ta: !!it.ta, val: this.st.free[it.free] || '' };
    });
    // 自动聚焦：开始 → 进行中感受；完成 → 做了的感受；放弃 → 为什么不做了；结束(觉察) → 感受
    const focusKey = this.st.startMode ? 'doingNote' : (this.st.completing ? 'doneFeel' : (this.st.abandoning ? 'abandonWhy' : (this.st.focusFree || '')));
    const focusIdx = focusKey ? items.findIndex(it => it.type === 'free' && it.key === focusKey) : -1;
    const MAINPH = { memo: '要记住什么 · 回车就记下', buy: '要买什么 · 可写「牛奶 2」' };
    // 备忘 / 购物：只保留一个输入框，不显示标题、选项池与管理入口
    const plain = store.isTask(tag);
    // focusIdx 必须返回：recompute 依赖它做「滚动到目标输入框 + 程序化聚焦弹键盘」
    return { main: main, mainLabel: store.GLABEL[main], mainOpts, mainVal: this.st.main || '', items, plain, focusIdx, mainPh: MAINPH[tag] || '手填或直接写一句 · 默认只记这次，加 ~ 存入选项池',
      // 「归类」不需要输入框：从选项池点选即可（要靠「✎ 管理」增删），
      // 所以带描述的模块把主输入框整个去掉，输入框只留给「具体的描述」
      mainInput: !descItem,
      // 「具体的描述」：紧跟在「归类」下方单独一个输入框（不带标题），可选
      hasDesc: !!descItem, descPh: descItem ? descItem.ph : '', descVal: (this.st.free && this.st.free[store.DESC_KEY]) || '' };
  },

  /* 最近记录条数：固定 10 条 */
  recentVM() {
    return (app.globalData.records || []).slice(0, 10).map(r => this.recVM(r));
  },

  recompute() {
    const recs = this.recentVM();
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
      recent: recs
    };
    this.setData(patch, () => {
      this.checkTagFade();   // 维度标签行是否需要「可滚动」的渐变提示（随维度数量变化）
      // 流转聚焦时先把页面滚回顶部（输入区在页面顶部；页面级滚动会同步原生输入层）
      if (willFocus) wx.pageScrollTo({ scrollTop: 0, duration: 0 });
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
    // 觉察：档位是情绪的修饰，情绪被取消时把档位一并清掉（否则会存下没头没尾的程度）
    if (g === 'obsMood' && !arr.length) this.st.pick['obsDeg'] = [];
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
  /* 「具体的描述」：只存进 st.free，不渲染在细节列表里，所以不用回写 composer.items */
  onDescInput(e) { this.st.free[store.DESC_KEY] = e.detail.value; },

  /* 输入框获得焦点：这里刻意什么都不做。
     1) 手动滚动会与 adjust-position 的原生键盘避让叠加（先被滚到顶部、又被原生推起一次）；
     2) 写 scrollTop 会覆盖掉「开始/完成/放弃/结束」流转的自动定位（scroll-into-view）；
     输入层错位改由 always-embed 强制同层解决（iOS），键盘避让交给 adjust-position 原生处理。 */
  /* 输入框聚焦：不做任何处理（提示语保持显示）。
     键盘避让交给 adjust-position 原生处理；手动滚动会与之叠加，导致输入框「飞」到页面顶端。 */
  onFieldFocus() {},

  /* 维度标签行的「可滚动」渐变提示：只有内容真的超出、且右侧还有内容时才显示。
     量一次缓存起来（滚动时不再重复查询），之后滚动只做比较。 */
  checkTagFade() {
    const q = wx.createSelectorQuery().in(this);
    q.select('.tagrow-scroll').boundingClientRect();
    q.select('.tagrow-scroll').scrollOffset();
    q.selectAll('.tg').boundingClientRect();
    q.exec(res => {
      const box = res[0], off = res[1], items = res[2] || [];
      if (!box) return;
      let content = (off && off.scrollWidth) || 0;
      // 兜底：个别基础库上 scrollWidth 拿不到，就用最后一个标签的右边界推算内容宽度
      if (!content && items.length) {
        const right = items.reduce((m, it) => Math.max(m, it.right), 0);
        content = right - box.left;
      }
      this._tagW = { box: box.width, content };
      this._applyTagFade((off && off.scrollLeft) || 0);
    });
  },

  _applyTagFade(left) {
    const w = this._tagW;
    if (!w) return;
    // 超出 + 右侧还有没露出来的内容 → 才提示；滚到底就收起来
    const fade = w.content > w.box + 1 && left + w.box < w.content - 1;
    if (fade !== this.data.tagFade) this.setData({ tagFade: fade });
  },

  onTagScroll(e) { this._applyTagFade((e.detail && e.detail.scrollLeft) || 0); },

  /* 页面滚动：记录滚动位置，顺手收起记录操作条。
     页面级滚动下微信会同步原生输入层位置，无需再销毁重建输入框。 */
  onPageScroll(e) {
    this._pageTop = e.scrollTop || 0;
    this.closeRecSel();
  },

  /* 页面级下拉刷新入口（原生下拉回弹动画） */
  onPullDownRefresh() { this.onRefresh(); },

  /* 再点一次底部「记」：整页回到顶部 */
  onTabReselect() {
    wx.pageScrollTo({ scrollTop: 0, duration: 300 });
  },

  /* 滚到底部：让底部「记」图标跳一下，提示可以点它回顶 */
  onReachBottom() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().hint();
  },

  /* -------- 编辑态（回显）锁定 -------- */
  // composer 内的点击在这里截止，不冒泡到 body（编辑当前记卡内容是允许的）；
  // 但它同样「不是操作条 / 撤销条」，所以顺手把浮层收起来
  noop() { this.clearFloats(); },

  // 编辑态下，除「编辑当前记卡内容」与「保存修改 / 取消」以外的操作都拦下，
  // 提示先把这一条处理完（保存按钮已常驻卡片底部，无需滚动定位）
  guardEdit() {
    if (!this.data.editing) return false;
    this.tipSaveFirst();
    return true;
  },

  // 每次被拦下的点击都提示一次。连续点击时先 hideToast，
  // 否则上一条 toast 还在显示，新的可能不弹出（表现为「只有第一次有提示」）
  tipSaveFirst() {
    if (wx.hideToast) wx.hideToast();
    wx.showToast({ title: '请先保存修改或取消', icon: 'none', duration: 800 });
  },

  // 主题切换在编辑态被锁：提示先处理当前编辑（与页面内其它无效操作一致）
  onLocked() { this.guardEdit(); },

  // 编辑区之外（最近列表、空白处等）的点击：操作条与撤销条都收起
  onBodyTap() {
    if (this.guardEdit()) return;
    this.clearFloats();
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
    // 觉察(obs)：结束时间
    // - 点「结束」进入（ending）：保存修改这一刻才落结束时间（默认现在），此前不写云；
    // - 点「改」进来且显示结束时间输入框：用户改过才覆盖；
    // - 未结束且非结束流转：保持原样，编辑内容不碰结束时间
    if (er.m === 'obs') {
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
    // 带「具体的描述」的模块（觉察）：主项只能从选项池点选，提示语换个说法
    const descModule = !!(f && (f.items || []).some(it => it.free === store.DESC_KEY));
    if (!rec.txt) { wx.showToast({ title: descModule ? '先选一个「归类」' : '先写点什么', icon: 'none' }); return; }
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
  // 「可做」的分类是必选项：清空表单后要把默认分类补回来，
  // 否则分类选中态丢失，下一条还会因「请选择分类」而记不进去
  ensureDefaultKind() {
    if (this.st.tag === 'want' && !this.st.pick['wantKind']) this.st.pick['wantKind'] = store.wantKindDefault();
  },

  afterSave(rec) {
    this.st.edit = null; this.st.startMode = false; this.st.doing = false; this.st.completing = false; this.st.showDoing = false; this.st.showDone = false;
    this.st.abandoning = false; this.st.showAbandon = false; this.st.ending = false; this.st.focusFree = '';
    this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
    this.ensureDefaultKind();   // 记下后仍在 可做 时，把默认分类选回来
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
    this.ensureDefaultKind();   // 取消编辑后仍在 可做 时，把默认分类选回来
    this.setData({ editing: false, focusIdx: -1, editDate: '', editTime: '', editHasStart: false, editStartDate: '', editStartTime: '', editHasEnd: false, editEndDate: '', editEndTime: '', editHasAbandon: false, editAbandonDate: '', editAbandonTime: '' });
    this.recompute();
  },

  /* ---------------- 长按记录（与清单 / 看页共用 inline-editor） ----------------
     待办：就地快捷改（只改事项）；其它维度：与点「改」等价，直接进记卡完整编辑 */
  onRecentLongPress(e) {
    if (this.guardEdit()) return;   // 正在编辑其它记录：先处理编辑态
    const id = e.currentTarget.dataset.id;
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r) return;
    this._lpAt = Date.now();   // 长按后紧跟着的那次点击要忽略掉
    if (store.isTask(r.m)) { this._openQ(id, r.txt || ''); return; }
    app.globalData.editRec = store.decorate(r);
    this.checkEdit();   // 进入编辑态后由 checkEdit 统一滚回顶部
    this.recompute();
  },

  /* 量取该行「整张卡片」的位置（文档坐标）→ 赋值并打开编辑器（量好再显示，避免闪到上一次的位置） */
  _openQ(id, txt) {
    const q = wx.createSelectorQuery().in(this);
    q.selectViewport().scrollOffset();
    q.select('#erow-' + id).boundingClientRect();
    q.exec(res => {
      const scrollTop = (res[0] && res[0].scrollTop) || 0;
      const rect = res[1];
      if (!rect) return;
      this.setData({
        qe: {
          top: Math.round(rect.top + scrollTop),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        recSel: null, recSelRec: null,
        qeId: id, qeTxt: txt, qeOn: true, qeFocus: false
      });
      // 兜底：万一 touchend 没触发（手势被系统吞掉），500ms 后自己聚焦
      if (this._focusTimer) clearTimeout(this._focusTimer);
      this._focusTimer = setTimeout(() => {
        if (this.data.qeOn && !this.data.qeFocus) this.onRowTouchend();
      }, 500);
    });
  },

  /* 手指抬起后再聚焦：长按过程中就聚焦的话，抬手瞬间微信的「点到外面」会把输入框 blur 掉，
     表现为「一松手输入框就关了」 */
  onRowTouchend() {
    if (!this.data.qeOn || this.data.qeFocus) return;
    this._focusAt = Date.now();
    this.setData({ qeFocus: true });
  },

  /* 组件派发 save：失焦 / 键盘「完成」/ 点「保存」都走这里；改空或没改动则不落云 */
  onQSave(e) {
    if (this._qeClosing) return;
    // 刚聚焦就被系统「点到外面」blur 掉（长按抬手那一下）：忽略，不要当成用户改完了
    if (this._focusAt && Date.now() - this._focusAt < 400) return;
    const id = this.data.qeId;
    if (!id || !this.data.qeOn) return;
    const txt = ((e.detail && e.detail.value) || '').trim();
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r || !store.isTask(r.m) || !txt || txt === r.txt) { this._closeQ(); return; }
    r.txt = txt;
    store.updateRecord(r).catch(() => {});
    this._closeQ();
    this.recompute();
    wx.showToast({ title: '已更新', icon: 'none' });
  },

  /* 收起：位置原地不动，只把宽高收成 0。
     一挪位置，微信会把「带焦点的输入框」滚进可视区（键盘重弹 + 页面跳回顶部）；
     挪走之前保留 qeId，让那一行继续隐身，避免与原生层残留互相重影 */
  _closeQ() {
    this._qeClosing = true;
    setTimeout(() => { this._qeClosing = false; }, 150);
    this._focusAt = 0;
    const qe = this.data.qe || {};
    this.setData({
      qeOn: false,
      qeFocus: false,
      qeId: '',
      qeTxt: '',
      qe: { top: qe.top || 0, left: qe.left || 0, width: 0, height: 0 }
    });
  },

  /* 就地编辑里的「删除」：删掉这条待办，并给出撤销机会（复用底部撤销条） */
  onQDel() {
    const r = (app.globalData.records || []).find(x => x.id === this.data.qeId);
    this._closeQ();
    if (!r || !store.isTask(r.m)) return;
    this._delRec(r);
  },

  /* 点「最近」记录：选中并弹出「改 / 删除」操作条 */
  onRecentTap(e) {
    if (this._lpAt && Date.now() - this._lpAt < 400) return;   // 长按刚触发过，忽略随之而来的点击
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
      if (r.m !== 'obs') return;
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
      this.checkEdit(); this.recompute();   // 进入编辑态后由 checkEdit 统一滚回顶部
      this.setData({ recSel: null, recSelRec: null });
      return;
    }
    if (type === 'del') { this.onRecDel(); return; }
  },

  /* 点页面其它地方：收起记录操作条（失焦即关） */
  closeRecSel() {
    if (this.data.recSel != null) this.setData({ recSel: null, recSelRec: null });
  },

  /* 点到「任何一个不是浮层本身」的地方（含记卡内部、空白、切页）：操作条与撤销条都收起。
     离开页面（onHide）也走这里——否则切 tab / 去清单再回来，操作条还挂在那儿 */
  clearFloats() {
    const patch = {};
    if (this.data.recSel != null) { patch.recSel = null; patch.recSelRec = null; }
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

  /* 删除一条记录并给出撤销机会（操作条「删除」与就地编辑的「删除」共用） */
  _delRec(r) {
    const i = (app.globalData.records || []).indexOf(r);
    if (i < 0) return;
    store.deleteRecord(r).then(() => {
      app.globalData.records.splice(i, 1);
      this.setData({ recSel: null, recSelRec: null, delUndo: { m: store.recMname(r), txt: r.txt, dump: r } });
      this.recompute();
      this._startDelTimer();
    });
  },

  /* 点操作条「删除」：删除并给出撤销机会 */
  onRecDel() {
    if (this.guardEdit()) return;
    const id = this.data.recSel; if (id == null) return;
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r) return;
    this._delRec(r);
  },

  onUndoDel() {
    if (this.guardEdit()) return;
    const u = this.data.delUndo; if (!u) return;
    this._stopDelTimer();
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

  /* 下拉刷新：统一走页面级下拉（列表 refresher 已关闭） */
  onRefresh() {
    // 编辑态：下拉刷新会丢掉未保存的编辑，拦下
    if (this.data.editing) { wx.stopPullDownRefresh(); this.guardEdit(); return; }
    if (this._refreshing) { wx.stopPullDownRefresh(); return; }   // 已在刷新中，避免重复触发
    this._refreshing = true;
    // 名字这会儿正好从胶囊后露出来，播一次逐字浮现
    this.setData({ brandPlay: true });
    if (this._brandTimer) clearTimeout(this._brandTimer);
    this._brandTimer = setTimeout(() => this.setData({ brandPlay: false }), 900);
    store.reload().then(() => {
      wx.stopPullDownRefresh();
      this._refreshing = false;
      this.st.edit = null; this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
      this.st.startMode = false; this.st.completing = false; this.st.abandoning = false; this.st.showDoing = false; this.st.showDone = false; this.st.showAbandon = false; this.st.ending = false;
      // 刷新后仍在「可做」时，补回默认分类（避免默认「想做」被清空）
      if (this.st.tag === 'want' && !this.st.pick['wantKind']) this.st.pick['wantKind'] = store.wantKindDefault();
      this.rotateGreet();
      this.recompute();
    }).catch(() => { wx.stopPullDownRefresh(); this._refreshing = false; });
  },

  /* 点「最近」标题右侧「清单」：进入待办清单（备忘 / 购物） */
  goList() {
    if (this.guardEdit()) return;
    wx.navigateTo({ url: '/pages/list/list' });
  },

  /* -------- 选项管理：跳转到独立子页面（返回即回「记」页，不退出小程序） -------- */
  onManage(e) {
    // 编辑态也允许去管理选项池：标记来源，返回时保留编辑中的内容与状态
    this.st.fromManage = true;
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
