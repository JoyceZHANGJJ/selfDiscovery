// pages/list/list.js —— 清单：备忘 / 购物（待办）+ 随记（平铺列表）快捷查看
const store = require('../../utils/store.js');
const swipe = require('../../utils/swipe.js');
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

// 筛选行 / 快捷新增的目标 id：待办类别用 'k:<类别>'，随记用 'jot'，全部用 'all'。
// 类别一律实时取选项池 todoKind —— 「✎ 管理」里加了新类别，清单页会自动多一项
function todoSeg(v) { return 'k:' + v; }

// 能在清单页就地改 / 删的记录：待办 + 随记（都是「一句话」，区别只是前者有完成与状态）
function canList(m) { return store.isTask(m) || m === 'jot'; }

Page({
  data: {
    theme: 'sand',
    statusH: 20,
    seg: 'all',            // 'all' | 'jot' | 'k:<类别>'（类别来自选项池，可增删）
    segs: [],              // 筛选行：全部 + 各待办类别 + 随记（rebuild 里按选项池生成）
    // 顶部快捷新增：输入 → 回车 → 立刻出现在列表顶部，可连着加（目标跟筛选走）
    qaTxt: '',
    qaM: 'k:备忘',         // seg='all' 时的目标：'k:<类别>' | 'jot'
    qaCats: [],            // 全部模式下平铺的可勾选类别（来自「设置」里的快捷创建勾选，最多 5 个）
    qaKey: 'k:备忘',       // 当前快捷新增目标（用于高亮 chips）
    qaC: store.catColor('备忘'),
    qaName: '备忘',
    qaPh: '要记住什么',
    show: false,
    tit: '待办',
    sum: '',
    undone: [],
    jots: [],
    doneGroups: [],
    doneN: 0,
    abandGroups: [],
    abandN: 0,
    // 各段的「显示更多」：默认只渲染最近一段，避免已完成 / 随记攒长了又长又卡。
    // 待完成 / 随记的窗口按「条」算，已完成 / 已放弃按「天」算（它们本来就按天分段）
    limU: 20, limD: 7, limA: 7, limJ: 20,
    undoneN: 0, jotN: 0,
    undoneHide: 0, doneHide: 0, abandHide: 0, jotHide: 0,
    doneDayAll: {}, abandDayAll: {},   // 某天被「展开全部」了（<天 key>: 1）
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
      id: r.id, m: store.recMname(r), c: store.isTask(r.m) ? store.taskColor(r) : store.mcolor(r.m),
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
    const recs = app.globalData.records || [];
    const seg = this.data.seg;
    const isJot = seg === 'jot';
    // 备忘 / 购物 合并成「待办」后，它们是同一个模块（todo）下的「类别」：按类别筛
    const cat = seg.indexOf('k:') === 0 ? seg.slice(2) : '';
    const tasks = recs.filter(r => store.isTask(r.m));
    const list = isJot ? [] : (cat ? tasks.filter(r => store.taskCat(r) === cat) : tasks);
    // 注意：recVM 的产物里没有 ts / doneAt，必须在 map 之前对原始记录排序，
    // 否则 sort 比较的全是 undefined，等于没排（已完成要按完成时间倒序，就是这个坑）
    const undoneAll = list.filter(r => !r.done && r.status !== 'abandon').sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(r => this.recVM(r));
    const doneRecs = list.filter(r => r.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    const abandRecs = list.filter(r => !r.done && r.status === 'abandon').sort((a, b) => (b.abandonedAt || 0) - (a.abandonedAt || 0));
    // 已完成 / 已放弃各按「那天」分段（与看页同一套）：段头给日期，行内只写「完成 / 放弃 · HH:MM」
    const doneDays = this.groupByDay(doneRecs, r => r.doneAt || r.ts);
    const abandDays = this.groupByDay(abandRecs, r => r.abandonedAt || r.ts);
    // 随记不是待办：没有 待完成 / 已完成 / 已放弃 那套，就是一个平铺列表（按记录时间倒序）
    const jotsAll = isJot ? recs.filter(r => r.m === 'jot').sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(r => this.recVM(r)) : [];
    // 每段只渲染「最近一段」，其余收在「显示更多」后面（已长了的段不会一上来全铺开）
    const undone = undoneAll.slice(0, this.data.limU);
    const jots = jotsAll.slice(0, this.data.limJ);
    const doneGroups = store.winDays(doneDays, this.data.limD, this.data.doneDayAll);
    const abandGroups = store.winDays(abandDays, this.data.limA, this.data.abandDayAll);

    const u = undoneAll.length, dn = doneRecs.length, an = abandRecs.length;
    const sum = u
      ? (u + ' 项待完成' + (dn ? ' · 已完成 ' + dn : '') + (an ? ' · 已放弃 ' + an : ''))
      : ((dn || an) ? ('全部处理完' + (dn ? ' · 已完成 ' + dn : '') + (an ? ' · 已放弃 ' + an : '')) : '');
    // 标题：就叫「待办」（不再罗列 备忘与购物——类别是可增删的）；按类别筛时显示类别名
    const tit = isJot ? '随记' : (cat || '待办');
    // 筛选行：全部 + 各待办类别 + 随记（类别实时取选项池，加新类别后自动出现）
    const segs = [{ k: 'all', n: '全部', c: '' }]
      .concat(store.getOPT('todoKind').map(v => ({ k: todoSeg(v), n: v, c: store.catColor(v) })))
      .concat([{ k: 'jot', n: '随记', c: store.mcolor('jot') }]);
    // 全部模式下平铺的可勾选类别（来自「设置」里的快捷创建勾选，最多 5 个）；筛了具体项时目标跟筛走
    const pool = store.getOPT('todoKind') || [];
    const qaCats = (store.getQuickCats() || []).map(qc => {
      const key = qc.m === 'jot' ? 'jot' : ('k:' + (qc.cat || ''));
      const T = this.qaDesc(key);
      return { key, m: T.m, cat: T.cat, n: T.n, c: T.c };
    }).filter(o => o.m !== 'todo' || pool.indexOf(o.cat) >= 0);
    const qaKeys = qaCats.map(o => o.key);
    let qaM = this.data.qaM;
    if (qaKeys.indexOf(qaM) < 0) qaM = qaKeys[0] || 'jot';
    const qm = (isJot || cat) ? seg : qaM;
    const T = this.qaDesc(qm);
    this.setData({
      show: isJot ? jotsAll.length > 0 : list.length > 0,
      tit, sum: isJot ? (jotsAll.length ? jotsAll.length + ' 条' : '') : sum,
      undone, doneGroups, abandGroups, jots, segs,
      undoneN: u, doneN: dn, abandN: an, jotN: jotsAll.length,
      undoneHide: Math.max(0, u - undone.length),
      doneHide: Math.max(0, doneDays.length - doneGroups.length),
      abandHide: Math.max(0, abandDays.length - abandGroups.length),
      jotHide: Math.max(0, jotsAll.length - jots.length),
      empty: isJot ? jotsAll.length === 0 : list.length === 0,
      qaCats, qaM: qaM, qaKey: qm, qaName: T.n, qaPh: T.ph, qaC: T.c
    });
  },

  /* 各段的「显示更多」：u 待完成 / d 已完成（天）/ a 已放弃（天）/ j 随记 */
  onMore(e) {
    const k = this._detailOr(e, 'k');
    const patch = {};
    if (k === 'u') patch.limU = this.data.limU + 20;
    else if (k === 'j') patch.limJ = this.data.limJ + 20;
    else if (k === 'd') patch.limD = this.data.limD + 7;
    else if (k === 'a') patch.limA = this.data.limA + 7;
    else return;
    this.setData(patch, () => this.rebuild());
  },
  /* 某一天「展开全部 / 收起」（这天超过 20 条时才有入口） */
  onDayMore(e) {
    const k = String(this._detailOr(e, 'k'));   // 天的 key（0 点时间戳，字符串）
    const w = this._detailOr(e, 'w');   // d 已完成 | a 已放弃
    const which = w === 'a' ? 'abandDayAll' : 'doneDayAll';
    const map = Object.assign({}, this.data[which]);
    if (map[k]) delete map[k]; else map[k] = 1;
    const patch = {}; patch[which] = map;
    this.setData(patch, () => this.rebuild());
  },

  // 按「某一天」把记录分段（已完成按完成时间、已放弃按放弃时间）：段头用时间线同款日标签
  groupByDay(recs, tsOf) {
    const map = {}, order = [];
    recs.forEach(r => {
      const k = dayStartTs(tsOf(r));
      if (!map[k]) { map[k] = { key: k, day: store.dayLabel(store.agoOf(k)), recs: [] }; order.push(k); }
      map[k].recs.push(this.recVM(r));
    });
    return order.map(k => map[k]);
  },

  onSeg(e) {
    this.data.seg = e.currentTarget.dataset.s;
    this.setData({ seg: this.data.seg });
    this.rebuild();
  },
  /* 左右滑动切筛选段（全部 / 各待办类别 / 随记）：向左滑下一个，向右滑上一个 */
  onSwipeStart(e) {
    if (this._noSwipe) { this._noSwipe = false; this._swX = null; return; }   // 起点在类别 chips：只滚 chips，不切段
    swipe.start(this, e);
  },
  onSwipeEnd(e) { const d = swipe.end(this, e); if (d) this.stepDim(d); },
  stepDim(dir) {
    if (this.data.editing) return;   // 就地编辑中不切
    const segs = this.data.segs || [];
    const i = segs.findIndex(s => s.k === this.data.seg);
    if (i < 0) return;
    const ni = dir === 'left' ? i + 1 : i - 1;
    if (ni < 0 || ni >= segs.length) return;
    this.onSeg({ currentTarget: { dataset: { s: segs[ni].k } } });
  },
  // 快捷新增的类别 chips 是横向 scroll-view：在它上面按下时打个标记，横滑它只滚 chips，不切筛选段
  onChipsTouch() { this._noSwipe = true; },

  /* ---------------- 点条目：记录操作条（放弃 / 恢复 / 改 / 删除） ----------------
     勾选框是「完成」（catchtap 单独处理），点条目的其它地方才是次级操作，两者互不干扰 */
  onRecTap(e) {
    if (this._lpAt && Date.now() - this._lpAt < 400) return;   // 长按刚触发过，忽略随之而来的点击
    const id = this._id(e);
    if (this.data.sel === id) { this.setData({ sel: null, selRec: null }); return; }
    const r = this.findRec(id);
    this.setData({ sel: id, selRec: r ? { m: store.recMname(r), txt: r.txt, rawm: r.m, status: r.status || '', ended: !!r.endTs, done: !!r.done } : null });
  },

  /* 操作条统一入口（与记 / 看页共用 rec-actions 组件）：待办用 放弃 / 恢复 / 改 / 删；
     随记没有状态与完成，所以只有 改 / 删（那套流转按钮本来也不会渲染） */
  onRecAction(e) {
    const type = e.detail.type;
    const id = this.data.sel; if (id == null) return;
    const r = this.findRec(id);
    if (!r) return;
    if (r.m === 'jot') {
      if (type === 'edit') { this.setData({ sel: null, selRec: null }); this._openEdit(id, r.txt || ''); return; }
      if (type === 'del') { this.setData({ sel: null, selRec: null }); this._del(r); }
      return;
    }
    if (!store.isTask(r.m)) return;
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

  /* ---------------- 快捷新增待办 / 随记 ---------------- */
  // 目标 id → 描述（名字 / 占位符 / 模块 / 类别 / 色点）
  qaDesc(k) {
    if (k === 'jot') return { n: '随记', ph: '想记点什么', m: 'jot', cat: '', c: store.mcolor('jot') };
    const cat = k.indexOf('k:') === 0 ? k.slice(2) : (store.getOPT('todoKind')[0] || '备忘');
    return { n: cat, ph: '要记住什么', m: 'todo', cat, c: store.catColor(cat) };
  },
  // 快捷新增的目标：筛到具体项就是它，否则用「切换」选的那个
  qaTarget() {
    const s = this.data.seg;
    return (s === 'jot' || s.indexOf('k:') === 0) ? s : this.data.qaM;
  },
  // 只有「全部」时目标才可切（筛了某类别 / 随记时，目标就是筛选本身）；点 chips 即在类别间平铺切换
  onQaChip(e) {
    if (this.data.seg !== 'all') return;
    const k = e.currentTarget.dataset.k;
    if (k === this.data.qaM) return;
    const T = this.qaDesc(k);
    this.setData({ qaM: k, qaKey: k, qaName: T.n, qaPh: T.ph, qaC: T.c });
  },
  onQaInput(e) { this.setData({ qaTxt: e.detail.value }); },
  /* 回车（或点「记下」）即落库：输入框清空、列表顶部立刻多一条，可继续输下一条 */
  onQaSave() {
    const txt = (this.data.qaTxt || '').trim();
    if (!txt) { wx.showToast({ title: '先写点什么', icon: 'none' }); return; }
    const T = this.qaDesc(this.qaTarget());
    const ts = Date.now();
    // 待办：把类别写进 ext（src=todoKind）；随记没有类别
    const rec = { m: T.m, txt, ts, t: hhmm(ts), ext: T.cat ? [T.cat] : [], extSrc: T.cat ? ['todoKind'] : [], done: false, doneAt: 0, status: '' };
    store.addRecord(rec).then(rid => {
      rec._rid = rid; rec.id = rid;
      if (!app.globalData.records) app.globalData.records = [];
      app.globalData.records.unshift(store.decorate(rec));
      this.setData({ qaTxt: '' });
      this.rebuild();
      wx.showToast({ title: '已记入' + T.n, icon: 'none', duration: 900 });
    }).catch(() => wx.showToast({ title: '没记上，再试一次', icon: 'none' }));
  },

  onCheck(e) {
    const id = this._id(e);
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r || !store.isTask(r.m)) return;
    r.done = !r.done; r.doneAt = r.done ? Date.now() : 0;
    store.updateRecord(r).catch(() => {});
    this.rebuild();
  },

  /* 页面级下拉刷新入口（原生下拉回弹，与记页一致） */
  onPullDownRefresh() { this.onRefresh(); },

  /* 悬浮球「＋」快捷记下一条（待办 / 随记）后：立刻重排列表 */
  onQuickTodo() { this.rebuild(); },

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

  // 待办行现在可能在 todo-list 组件里：交互事件要么来自本页（dataset），要么来自组件（detail），统一取 id / 字段
  _id(e) { return (e.detail && e.detail.id != null) ? e.detail.id : e.currentTarget.dataset.id; },
  _detailOr(e, key) { return (e.detail && e.detail[key] != null) ? e.detail[key] : e.currentTarget.dataset[key]; },

  /* 长按某条待办 / 随记：先量好位置再显示，避免编辑器先闪一下上一次的位置 */
  onLongPress(e) {
    const id = this._id(e);
    const r = this.findRec(id);
    if (!r || !canList(r.m)) return;
    this._lpAt = Date.now();     // 长按之后紧跟的那次点击要忽略，否则会立刻弹出操作条
    this.setData({ sel: null, selRec: null });
    this._openEdit(id, r.txt || '');
  },

  /* 量取该行「整张卡片」的位置（文档坐标）→ 赋值并打开编辑器：
     编辑器做成和卡片同尺寸盖上去（同内边距/圆角/边框），页面滚动时跟着原行走 */
  _openEdit(id, txt) {
    const comp = this.selectComponent('#todoList');
    const q = wx.createSelectorQuery();
    q.selectViewport().scrollOffset();
    (comp ? q.in(comp) : q).select('#erow-' + id).boundingClientRect();
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
    if (!r || !canList(r.m) || !txt || txt === r.txt) { this._closeEdit(); return; }
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

  /* 就地编辑里的「删除」（待办 / 随记都有） */
  onEditDel() {
    const r = this.findRec(this.data.edId);
    this._closeEdit();
    if (!r || !canList(r.m)) return;
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
