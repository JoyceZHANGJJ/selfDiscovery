// pages/list/list.js —— 清单：备忘 / 购物（待办）+ 随记（平铺列表）快捷查看
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');
const swipe = require('../../utils/swipe.js');
const date = require('../../utils/date.js');
const vm = require('../../utils/vm.js');
const app = getApp();

// 筛选行 / 快捷新增的目标 id：待办类别用 'k:<类别>'，随记类别用 'j:<类别>'
// （裸 'jot' = 随记的默认类别，筛「随记」整段或兜底时用），全部用 'all'。
// 类别一律实时取选项池（todoKind / jotKind）—— 「✎ 管理」里加了新类别，清单页会自动多一项
function todoSeg(v) { return 'k:' + v; }

// 能在清单页就地改 / 删的记录：待办 + 随记（都是「一句话」，区别只是前者有完成与状态）
function canList(m) { return store.isTask(m) || m === 'jot'; }

Page(pageBase({
  data: {
    // seg：'all'（全部：下分待办 / 随记，见 allKind）| 'k:<待办类别>' | 'jot'（随记）——都来自选项池，可增删
    seg: 'all',            // 默认停在「全部」
    allKind: 'todo',       // 「全部」下的二级筛选：'todo'（默认）| 'jot'——同一时刻只显示一种，不上下叠着
    subs: [],              // 上面那行二级筛选的 chips（待办 / 随记）
    segs: [],              // 一级筛选行（单行横向滚动）：全部 + 各待办类别 + 各随记类别（没有「随记」那一格，见 rebuild）
    segFade: false,        // 筛选行右侧是否还有内容（超出时给一点渐隐提示，与记卡维度行同一套）
    segFadeL: false,       // 左侧是否有内容没露出来（往回滚过就提示，见 _applySegFade）
    segInto: '',           // 当前选中的 chip：切段后把它滚进视野（滚出屏外的 tab 也看得见、够得着）
    jf: 'all',             // 随记的类别筛选（'all' | <随记类别>）：点「j:<类别>」那个 chip 会选中它
    jotOn: false,          // 这一段是否渲染随记（「随记」段、以及「全部」下的随记二级）
    showTodo: true,         // 这一段是否渲染待办清单（「全部」下选了待办、或各待办类别段）
    // 本页只做「看与管理」：新增走右下角的「＋」球（快捷记面板）或记页，页面上不再放输入框
    show: false,
    ready: false,        // 首屏数据未就绪时先渲染骨架屏（与记 / 看 同一套 .sk 样式）
    loadFail: false,     // 取数失败：撤掉骨架屏，给一句说明 + 可点的重试
    tit: '全部',
    sum: '',
    undone: [],
    jotGroups: [],         // 随记：按「随记类别」分段（段头＝类别，组内按时间倒序）
    doneGroups: [],
    doneN: 0,
    abandGroups: [],
    abandN: 0,
    // 各段的「显示更多」：默认只渲染最近一段，避免已完成 / 随记攒长了又长又卡。
    // 待完成 / 随记的窗口按「条」算，已完成 / 已放弃按「天」算（它们本来就按天分段）
    limU: 20, limD: 7, limA: 7, limJ: 20,
    undoneN: 0,
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
    this.layoutBrand();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 4, theme: wx.getStorageSync('theme') || 'sand' });
    }
    store.ensureAll().then(ok => {
      if (!ok) { this.setData({ loadFail: true, ready: true }); return; }
      this.setData({ ready: true });
      this.rebuild();
    });
  },

  /* 取数失败后点「重试」：再走一遍加载（store 失败时会把状态放回去，可以再来一次） */
  onRetry() {
    if (this._retrying) return;
    this._retrying = true;
    this.setData({ loadFail: false, ready: false });
    store.ensureAll().then(ok => {
      this._retrying = false;
      if (!ok) { this.setData({ loadFail: true, ready: true }); return; }
      this.onShow();   // 成功了按正常进页再走一遍
    });
  },

  /* 主题 / 程序名（ensureTheme / layoutBrand / playBrand）已收敛到 utils/pageBase.js */

  recVM(r) {
    const v = vm.baseVM(r);
    // 待办的行内时间组件那边直接读 tt（与看页同一份口径，不必两页各覆盖一次 t）。
    // 这里覆盖 t 是留给随记段那个 .tw 的：它不摆日期前缀，只写 item.t，
    // 所以非今天的随记得靠 tt 才看得出是哪天（今天＝时刻，非今天＝简洁日期）
    v.t = r.tt || r.t;
    // 完成时间带「完成 ·」前缀：行右侧那个裸时间是「记录时间」，两个时间要能分得清
    v.doneAtText = r.doneAt ? ('完成 · ' + date.hhmm(r.doneAt)) : '已完成';
    v.abandAtText = r.abandonedAt ? ('放弃 · ' + date.hhmm(r.abandonedAt)) : '已放弃';
    return v;
  },

  rebuild() {
    const recs = app.globalData.records || [];
    const seg = this.data.seg;
    const isJot = seg === 'jot';
    const isAll = seg === 'all';
    // 「全部」下再分待办 / 随记（默认待办，见 allKind）：同一时刻只渲染一种，不再把两者上下叠成一页；
    // 「随记」段与各随记类别段同样只渲染随记
    const showJot = isJot || (isAll && this.data.allKind === 'jot');
    const showTodo = !showJot;
    // 随记的类别筛选：'all' 时不筛（按类别分段展示＝全部随记），选了某一类就只看这一类
    const jcat = (isJot && this.data.jf !== 'all') ? this.data.jf : '';
    // 备忘 / 购物 合并成「待办」后，它们是同一个模块（todo）下的「类别」：按类别筛
    const cat = seg.indexOf('k:') === 0 ? seg.slice(2) : '';
    const tasks = recs.filter(r => store.isTask(r.m));
    // 这一屏不渲染待办时（随记相关段）不白算待办的那几段窗口
    const list = showTodo ? (cat ? tasks.filter(r => store.taskCat(r) === cat) : tasks) : [];
    // 注意：recVM 的产物里没有 ts / doneAt，必须在 map 之前对原始记录排序，
    // 否则 sort 比较的全是 undefined，等于没排（已完成要按完成时间倒序，就是这个坑）。
    // 另外：先排序 → 按「显示更多」的窗口切片 → 最后才 map 成 VM；
    // 记录多的时候（几百上千条）不要把没渲染的那些也白算一遍（不然「显示更多」会卡）
    // 待完成不按时间排，先按**优先级**轻重（紧急重要 → 不紧急不重要，见 store.prioRank），
    // 同一档内再按**计划完成时间**：有计划的排在前面、早的在前（「今天要交」压着「下周一交」），
    // 没计划的沉到这一档的最后、内部仍按时间倒序——「没计划」是常态，
    // 让它们去打扰计划好的那些没有道理。口径收在 store.sortUndone（看页 / 记页同一份，
    // 三处各写一遍迟早会走偏）；「显示更多」也是在排好的序列上往后切，
    // 所以翻出来的仍是这一档里的下几条
    const undoneRaw = store.sortUndone(list.filter(r => !r.done && r.status !== 'abandon'));
    const doneRecs = list.filter(r => r.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    const abandRecs = list.filter(r => !r.done && r.status === 'abandon').sort((a, b) => (b.abandonedAt || 0) - (a.abandonedAt || 0));
    // 已完成 / 已放弃各按「那天」分段（与看页同一套）：段头给日期，行内只写「完成 / 放弃 · HH:MM」
    const doneDays = this.groupByDay(doneRecs, r => r.doneAt || r.ts);
    const abandDays = this.groupByDay(abandRecs, r => r.abandonedAt || r.ts);
    // 随记不是待办：没有 待完成 / 已完成 / 已放弃 那套。展示按「随记类别」分段——
    // 段头是类别、组内按记录时间倒序，不会漏掉任何一条；组序取选项池顺序（被删掉的老类别排最后）。
    // 「全部」下级选了随记、或进「随记」段 / 随记类别段才渲染随记。
    // 待办与随记**不混排**（不上下叠两层），改成「全部」下的二级筛选二选一；
    // 筛到某个随记类别时就只有那一个类别，不再显示段头（标题已写明）
    const jotOn = showJot;
    const jotRecs = jotOn ? recs.filter(r => r.m === 'jot' && (!jcat || store.jotCat(r) === jcat)).sort((a, b) => (b.ts || 0) - (a.ts || 0)) : [];
    const jotTotal = jotRecs.length;
    // 每段只渲染「最近一段」，其余收在「显示更多」后面（已长了的段不会一上来全铺开）
    const undone = undoneRaw.slice(0, this.data.limU).map(r => this.recVM(r));
    const jotGroups = jotOn ? this.groupJots(jotRecs, this.data.limJ, !jcat) : [];
    const jotHide = jotGroups.reduce((s, g) => s + g.hide, 0);
    const doneGroups = this.winGroups(doneDays, this.data.limD, this.data.doneDayAll);
    const abandGroups = this.winGroups(abandDays, this.data.limA, this.data.abandDayAll);

    const u = undoneRaw.length, dn = doneRecs.length, an = abandRecs.length;
    // 一条都没有时也给一行数量（「0 项待完成」）：这一行是小节标题下的口径说明，
    // 空类别突然少一行会让下面几行位置跟着跳（随记那边同理，见下面的 sum）
    const sum = u
      ? (u + ' 项待完成' + (dn ? ' · 已完成 ' + dn : '') + (an ? ' · 已放弃 ' + an : ''))
      : ((dn || an) ? ('全部处理完' + (dn ? ' · 已完成 ' + dn : '') + (an ? ' · 已放弃 ' + an : '')) : '0 项待完成');
    // 标题：「全部」段用页名「待办 · 随记」（这一屏只看其中一种，靠下面的二级筛选换）；
    // 待办按类别筛时显示类别名，随记段叫「随记」，筛到某一类时只显示类别名（与待办同一套）
    const tit = isAll ? '待办 · 随记' : (isJot ? (jcat || '随记') : (cat || '待办'));
    // 「全部」下的二级筛选：待办（默认）/ 随记——只有一级段是「全部」时才出现，
    // 点一下只换这一屏渲染哪一种，一级段不动
    const subs = [
      { k: 'todo', n: '待办', c: store.mcolor('todo'), on: this.data.allKind !== 'jot' },
      { k: 'jot', n: '随记', c: store.mcolor('jot'), on: this.data.allKind === 'jot' }
    ];
    // 一级筛选行（单行横向滚动，超出时给渐隐提示，与记卡维度行同一套）：
    // 全部 + 各待办类别 + 各随记类别——随记的类别直接排在待办类别后面。
    // 这里**不再放「随记」这一格**：看全部随记统一走「全部 → 二级筛选 随记」，
    // 免得两个入口（一级的「随记」与二级的「随记」）看着重复、切换后又不同步。
    // 点一个随记类别＝切到「随记」段并只看这一类。实时取选项池，加新类别后自动多一项
    const segs = [{ k: 'all', n: '全部', c: '', on: isAll }]
      .concat(store.getOPT('todoKind').map(v => {
        const k = todoSeg(v);
        return { k, n: v, c: store.catColor(v), on: seg === k };
      }))
      .concat((store.getOPT('jotKind') || []).map(v => ({
        k: 'j:' + v, n: v, c: store.jotColor(v), on: isJot && this.data.jf === v
      })));
    // 切段后把选中的 chip 滚进视野：这一行是横向滚动的，滑到后面的段时
    // 对应的 chip 可能还在屏外——不滚过去就会「看不见、够不着」，像滑不过去
    const cur = segs.findIndex(s => s.on);
    this.setData({
      // seg / jf / allKind 与数量同一次下发：见 onSeg 的说明
      seg: this.data.seg, jf: this.data.jf, allKind: this.data.allKind,
      show: showJot ? jotTotal > 0 : list.length > 0,
      showTodo, jotOn, subs,
      tit, sum: showJot ? (jotTotal + ' 条') : sum,   // 空类别也给「0 条」（同上）
      undone, doneGroups, abandGroups, jotGroups, segs,
      segInto: cur >= 0 ? 'seg' + cur : '',
      undoneN: u, doneN: dn, abandN: an,
      undoneHide: Math.max(0, u - undone.length),
      doneHide: Math.max(0, doneDays.length - doneGroups.length),
      abandHide: Math.max(0, abandDays.length - abandGroups.length),
      jotHide,
      empty: showJot ? jotTotal === 0 : list.length === 0,
      emptyText: showJot ? (jcat ? '这个类别还没有随记' : '还没有随记')
        : (cat ? '这个类别还没有记录' : '还没有待办记录')
    }, () => this.checkSegFade());
  },

  /* 各段的「显示更多」：u 待完成 / d 已完成（天）/ a 已放弃（天）/ j 随记 */
  onMore(e) {
    if (this.guardEdit()) return;
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
    if (this.guardEdit()) return;
    const k = String(this._detailOr(e, 'k'));   // 天的 key（0 点时间戳，字符串）
    const w = this._detailOr(e, 'w');   // d 已完成 | a 已放弃
    const which = w === 'a' ? 'abandDayAll' : 'doneDayAll';
    const map = Object.assign({}, this.data[which]);
    if (map[k]) delete map[k]; else map[k] = 1;
    const patch = {}; patch[which] = map;
    this.setData(patch, () => this.rebuild());
  },

  /* groupByDay / winGroups 已收敛到 utils/pageBase.js（与看页同一份） */

  /* 随记按「随记类别」分段：段头用日标签那套（.daylab，时间线轴线因此照常对齐），
     组序取随记类别池顺序——被删掉的老类别、以及没类别（合并前）的记录排在最后。
     组内保持传进来的时间倒序；每组各自最多渲染 lim 条，其余交给「显示更多」收口
     （所以「随记」这一段永远是全部随记，只是分了几组）。
     withHead=false（已筛到某一类）时不显示段头，标题里已经写明是哪个类别 */
  groupJots(recs, lim, withHead) {
    const pool = store.getOPT('jotKind') || [];
    const map = {}, order = [];
    recs.forEach(r => {
      const cat = store.jotCat(r);
      if (!map[cat]) {
        map[cat] = { key: cat || 'jot-none', day: cat || '未分类', c: store.jotColor(cat), recs: [] };
        order.push(cat);
      }
      map[cat].recs.push(r);
    });
    const rank = (cat) => { const i = pool.indexOf(cat); return cat ? (i < 0 ? 1e5 : i) : 1e6; };
    order.sort((a, b) => rank(a) - rank(b));
    return order.map(cat => {
      const g = map[cat];
      const shown = g.recs.slice(0, lim).map(r => this.recVM(r));
      return { key: g.key, day: g.day, c: g.c, head: !!withHead, n: g.recs.length, recs: shown, hide: Math.max(0, g.recs.length - shown.length) };
    });
  },

  /* 筛选行：'all'（全部：下分待办 / 随记）/ 'k:<待办类别>' / 'j:<随记类别>'（切到随记段并筛这一类）。
     一级不再排「随记全部」那一格——看全部随记走「全部」下的二级筛选（见 onAllKind） */
  onSeg(e) {
    if (this.guardEdit()) return;   // 就地编辑中：点 chip 切段也拦下（滑动那条见 stepDim）
    const k = e.currentTarget.dataset.s || 'all';
    const isJotCat = k.indexOf('j:') === 0;
    this.data.seg = isJotCat ? 'jot' : k;
    this.data.jf = isJotCat ? k.slice(2) : 'all';   // 换段时随记的类别筛选归零（它只属于随记段）
    // 「全部」每次进来都回到默认的「待办」二级（不记住上次选的）；切段还把待办清单的
    // 折叠态归位——由 todo-list 的 foldKey 变化触发：第一个「待完成」展开、其余收起
    this.data.allKind = 'todo';
    // 这里只清选中态；seg / jf / allKind **不单独下发**——它们要和数量在同一次 setData 里到组件，
    // 折叠归位才能拿到与这个段一致的数量（分两次下发会先按上一个段的数量归位：比如切到
    // 「只有已完成」的类别，会先按旧段的「有待完成」展开待完成，而这一段待完成是 0，
    // 结果三段全收起、什么都不展开，见 todo-list 的 observers）
    this.setData({ sel: null, selRec: null });
    this.rebuild();
    // 这里**不主动滚动**：滑动切段只是换这一段的列表，页面停在你滑到的位置。
    // 之前会对齐到标题，从页顶切段时整块顶部会被往下推约一节（看着像页面自己跳了一下）；
    // 短段的内容变少时浏览器仍会把滚动位置夹回来，那是内容变短的必然反应（已被 .body 的最小高度收窄）
  },
  /* 「全部」下的二级筛选：待办 / 随记（默认待办）。只换这一屏渲染哪一种，
     一级段仍是「全部」（筛选行里那个 chip 继续亮着） */
  onAllKind(e) {
    if (this.guardEdit()) return;
    const k = e.currentTarget.dataset.k === 'jot' ? 'jot' : 'todo';
    if (k === this.data.allKind) return;
    this.data.allKind = k;   // 与 rebuild 的数据一起下发（理由同 onSeg）
    this.setData({ sel: null, selRec: null });
    this.rebuild();   // 同样不主动滚动（理由见 onSeg）
  },
  /* 筛选行「可滚动」渐隐提示：只有 chips 真的超出、且右侧还有内容时才显示（与记卡维度行同一套） */
  checkSegFade() {
    const q = wx.createSelectorQuery().in(this);
    q.select('.tagrow-scroll').boundingClientRect();
    q.select('.tagrow-scroll').scrollOffset();
    q.selectAll('.ft').boundingClientRect();
    q.exec(res => {
      const box = res[0], off = res[1], items = res[2] || [];
      if (!box) return;
      let content = (off && off.scrollWidth) || 0;
      // 兜底：个别基础库上 scrollWidth 拿不到，就用最后一个 chip 的右边界推算内容宽度
      if (!content && items.length) {
        const right = items.reduce((m, it) => Math.max(m, it.right), 0);
        content = right - box.left;
      }
      this._segW = { box: box.width, content };
      this._applySegFade((off && off.scrollLeft) || 0);
    });
  },
  _applySegFade(left) {
    // 左侧：只要往回滚过（左边还有没露出来的 chip）就提示。这一条不依赖内容宽度，
    // 所以放在前面先算，免得首屏还没量完宽度时左侧少了提示
    const l = left > 1;
    if (l !== this.data.segFadeL) this.setData({ segFadeL: l });
    const w = this._segW;
    if (!w) return;
    // 右侧：超出 + 右侧还有没露出来的内容 → 才提示；滚到底就收起来
    const fade = w.content > w.box + 1 && left + w.box < w.content - 1;
    if (fade !== this.data.segFade) this.setData({ segFade: fade });
  },
  onSegScroll(e) { this._applySegFade((e.detail && e.detail.scrollLeft) || 0); },
  /* 左右滑动切筛选段（全部 / 各待办类别 / 随记）：向右滑上一个、向左滑下一个。
     例外：**行尾起手的左滑归行内**（＝就地改这一条，见 onRowSwipe / onRowTouchend）——
     那一下不能再切段，否则「改」和「切段」会一起触发。所以这里延后一拍再切，
     行内动作一到就把它撤掉（不依赖事件先后：组件派发的事件与根节点原生事件的顺序没法保证） */
  onSwipeStart(e) { swipe.start(this, e); },
  onSwipeEnd(e) {
    const d = swipe.end(this, e);
    if (!d) return;
    // 在筛选行上起手的横滑＝滚 chips（scroll-view 自己处理）：这一下不当切段，
    // 否则会一边滚 chip 一边换段。按**起点所在节点**判断（id 都以 seg 开头），
    // 不依赖事件先后：同一手势的 touchstart/touchend 一定落在同一个节点上
    const tid = (e && e.target && e.target.id) || '';
    if (tid.indexOf('seg') === 0) { this._rowActAt = 0; return; }
    // 切段延后一拍再做：行内左滑（组件派发的事件）与这次原生事件的先后没法保证，
    // 它一到就把这次切段取消掉——这样「改」和「切段」不会同时发生
    if (this._segTimer) clearTimeout(this._segTimer);
    this._segTimer = setTimeout(() => {
      this._segTimer = null;
      if (this._rowActAt && Date.now() - this._rowActAt < 400) { this._rowActAt = 0; return; }
      this.stepDim(d);
    }, 60);
  },
  /* 行内动作（左滑就地改）一到就把可能还在排队的「切段」撤掉 */
  _cancelSeg() { if (this._segTimer) { clearTimeout(this._segTimer); this._segTimer = null; } },
  stepDim(dir) {
    if (this.data.editing) return;   // 就地编辑中不切
    const segs = this.data.segs || [];
    // 以「当前选中的 chip」为起点（而不是段名）：随记类别选中的是 'j:<类别>'，段名却是 'jot'，
    // 按段名找会退回到「随记」那一格，滑动时前后就错位了
    const i = segs.findIndex(s => s.on);
    if (i < 0) return;
    const ni = dir === 'left' ? i + 1 : i - 1;
    if (ni < 0 || ni >= segs.length) return;
    this.onSeg({ currentTarget: { dataset: { s: segs[ni].k } } });
  },
  /* ---------------- 点条目：记录操作条（放弃 / 恢复 / 改 / 删除） ----------------
     勾选框是「完成」（catchtap 单独处理），点条目的其它地方才是次级操作，两者互不干扰 */
  onRecTap(e) {
    if (this._lpAt && Date.now() - this._lpAt < 400) return;   // 长按刚触发过，忽略随之而来的点击
    if (this.guardEdit()) return;   // 就地编辑中：不选中其它条（不然操作条会跟编辑器叠在一起）
    const id = this._id(e);
    if (this.data.sel === id) { this.setData({ sel: null, selRec: null }); return; }
    const r = this.findRec(id);
    this.setData({ sel: id, selRec: r ? { m: store.recMname(r), txt: r.txt, rawm: r.m, status: r.status || '', ended: !!r.endTs, done: !!r.done, dueTs: r.dueTs || 0, calTs: r.calTs || 0 } : null });
  },

  /* 操作条统一入口（与记 / 看页共用 rec-actions 组件）：待办用 放弃 / 恢复 / 改 / 删；
     随记没有状态与完成，所以只有 改 / 删（那套流转按钮本来也不会渲染） */
  onRecAction(e) {
    if (this.guardEdit()) return;   // 就地编辑中：不允许对其它条做流转 / 改 / 删
    const type = e.detail.type;
    const id = this.data.sel; if (id == null) return;
    if (type === 'cal') { this.pushCal(id); return; }   // 推到手机日历（三页共用 pageBase 的实现）
    const r = this.findRec(id);
    if (!r) return;
    if (r.m === 'jot') {
      if (type === 'edit') { this.editInCard(r); return; }
      if (type === 'del') { this.setData({ sel: null, selRec: null }); this._del(r); }
      return;
    }
    if (!store.isTask(r.m)) return;
    if (type === 'abandon') {
      // 放弃要填原因：走「改」那条路进记卡回显这一条，并聚焦「放弃原因」输入框
      //（保存修改时才落状态与时间，取消则什么都不变）
      app.globalData.editAbandon = true;
      this.editInCard(r);
      return;
    }
    if (type === 'restore') {
      r.status = ''; r.abandonedAt = 0;
      // 恢复后「放弃原因」不再成立：顺手清掉（与记页同一处理），免得留在记录里
      const es = r.extSrc || [], ex = r.ext || [], keep = [];
      for (let i = 0; i < es.length; i++) { if (es[i] === 'free:abandonWhy') continue; keep.push(i); }
      r.extSrc = keep.map(i => es[i]); r.ext = keep.map(i => ex[i]);
      store.updateRecord(r).catch(() => {});
      this.setData({ sel: null, selRec: null });
      this.rebuild();
      return;
    }
    if (type === 'edit') { this.editInCard(r); return; }
    if (type === 'del') { this.setData({ sel: null, selRec: null }); this._del(r); }
  },
  /* 操作条上的「改」＝进记卡完整编辑（会回显这一条的类别 / 原因 / 类别等，改的是同一条记录）。
     一句话的快速改写走「行尾左滑」（就地编辑器），两者分工。
     注意：记页是 tab 页，只能 switchTab 过去——清单页会被关掉，回来时长按「＋」球即可 */
  editInCard(r) {
    app.globalData.editRec = store.decorate(r);
    this.setData({ sel: null, selRec: null });
    wx.switchTab({ url: '/pages/index/index' });
  },

  onCheck(e) {
    if (this.guardEdit()) return;   // 就地编辑中：不让勾选改写数据（可能与正在编辑的那条重叠）
    const id = this._id(e);
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r || !store.isTask(r.m)) return;
    r.done = !r.done; r.doneAt = r.done ? Date.now() : 0;
    store.updateRecord(r).catch(() => {});
    this.rebuild();
  },

  /* 页面级下拉刷新入口（原生下拉回弹，与记页一致）；
     下拉时程序名正好从胶囊后露出来，顺手播一次逐字浮现 */
  onPullDownRefresh() {
    this.layoutBrand();   // 露出来之前再确认一次位置（万一首次没取到胶囊矩形）
    this.playBrand();
    this.onRefresh();
  },

  /* 悬浮球「＋」快捷记下一条（待办 / 随记）后：立刻重排列表 */
  onQuickTodo() { this.rebuild(); },

  /* ---------------- 编辑态锁定 ----------------
     就地编辑（inline-editor）开着时，只允许：改这一条 / 保存 / 删除。其余入口一律拦下并提示，
     因为切段、二级筛选、显示更多、展开某天、勾选完成、选中其它条出操作条、撤销删除、下拉刷新、
     切主题……都会 rebuild 或改写数据：正在编辑的那一行从 DOM 里消失，绝对定位的编辑器变成孤儿；
     左滑另一条更会直接丢掉未保存的文本。
     与记页的 guardEdit 同一套口径（见 pages/index/index.js）。 */
  guardEdit() {
    if (!this.data.editing) return false;
    if (wx.hideToast) wx.hideToast();   // 连续点击时先收掉上一条，否则新提示不弹
    wx.showToast({ title: '请先保存修改或取消', icon: 'none', duration: 800 });
    return true;
  },

  onRefresh() {
    if (this.guardEdit()) return;   // 就地编辑中：下拉刷新会整表重建，未保存的文本会丢
    store.loadRecords().then(list => {
      app.globalData.records = list;
      wx.stopPullDownRefresh();
      this.rebuild();
    }).catch(() => wx.stopPullDownRefresh());
  },

  /* ---------------- 长按就地编辑（全局唯一编辑器） ---------------- */
  /* findRec / _id / _detailOr 已收敛到 utils/pageBase.js */

  /* 长按某条待办 / 随记＝复制这句话（改 / 删走「点一下出操作条」或「左滑直接改」） */
  onLongPress(e) {
    if (this.guardEdit()) return;   // 与记页口径一致：编辑态下连复制也先让位
    const id = this._id(e);
    const r = this.findRec(id);
    if (!r || !canList(r.m)) return;
    this._lpAt = Date.now();     // 长按之后紧跟的那次点击要忽略，否则会立刻弹出操作条
    this.copyRec(r);
  },
  /* copyRec 已收敛到 utils/pageBase.js */

  /* 量取该行「整张卡片」的位置（文档坐标）→ 赋值并打开编辑器：
     编辑器做成和卡片同尺寸盖上去（同内边距/圆角/边框），页面滚动时跟着原行走。
     gesture=true（行尾左滑触发）时手指正好在抬起，聚焦隔一拍再做，免得被微信当成「点到外面」 */
  _openEdit(id, txt, gesture) {
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
      // 兜底：万一聚焦没成功（手势被系统吞掉），过一会儿自己再试一次
      if (this._focusTimer) clearTimeout(this._focusTimer);
      this._focusTimer = setTimeout(() => {
        if (this.data.editing && !this.data.edFocus) this.focusEd();
      }, gesture ? 60 : 500);
    });
  },

  /* 手指抬起后再聚焦：弹出编辑器时就聚焦的话，抬手瞬间微信的「点到外面」会把输入框 blur 掉，
     表现为「一松手输入框就关了」 */
  focusEd() {
    if (!this.data.editing || this.data.edFocus) return;
    this._focusAt = Date.now();
    this.setData({ edFocus: true });
  },

  /* 行级手势：随记行在本页，待办行在 todo-list 组件里（组件判完横滑派发 swipeleft）。
     **只有「行尾起手的左滑」＝就地改这一条**；其它方向、其它位置（含行中间往左）都放过，
     交给根节点切段——行铺满整屏，不划这条界线上层手势就没法触发。
     随记行在本页判、判成行内时才吃掉起点；待办行的行尾左滑由组件报回来（见 onRowSwipe） */
  onRowTouchStart(e) { this._rowEdge = swipe.atEdge(e); swipe.start(this, e); },
  onRowTouchCancel() { this._swX = null; this._swY = null; },
  onRowTouchend(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const edge = this._rowEdge; this._rowEdge = false;
    if (edge && ds.id != null && swipe.rowLeft(this, e)) {
      swipe.end(this, e);   // 这一下归行内：吃掉起点，根节点那一次 end 就什么也拿不到
      this.onRowSwipe({ detail: { id: ds.id } });
      return;
    }
    this.focusEd();
  },
  /* 左滑某一行＝改这一条：**打开快捷记面板并回显**（文本 + 类别 + 优先级一起改，保存＝更新原记录）。
     以前这里只弹一个行内输入框（改得了话、改不了类别与优先级），待办的优先级出来之后就明显不够用了。
     上面还开着一条时先收起（_closeEdit 会把紧随的那次 save 事件挡掉），隔一拍再弹新的 */
  onRowSwipe(e) {
    if (this.guardEdit()) return;   // 正在编辑另一条：先处理它（原来这里直接收起，未保存的文本就丢了）
    const id = this._id(e);
    const r = this.findRec(id);
    if (!r || !canList(r.m)) return;
    this._lpAt = Date.now();     // 刚滑过：紧跟其后的 tap（若有）不当成点选
    this._rowActAt = Date.now(); // 这一次滑动归行内：根节点那次不要再切段（见 onSwipeEnd）
    this._cancelSeg();           // 已经排队的那次切段也撤掉（事件先后不定，两边都兜住）
    this.setData({ sel: null, selRec: null });
    if (this.quickEdit(r)) return;             // 面板改这一条（新口径）
    this._openEdit(id, r.txt || '', true);     // 拿不到面板才退回行内编辑器（理论上不会发生）
  },
  /* 面板里的「删除」：走本页自己的删除（删完有撤销条），与操作条上的「删除」同一套 */
  delRecById(id) {
    if (!id) return;
    const r = this.findRec(id);
    if (!r || !canList(r.m)) return;
    this._del(r);
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
  /* 主题切换在编辑态被锁（与记页 onLocked 一致） */
  onLocked() { this.guardEdit(); },

  onBodyTap() {
    const patch = {};
    if (this.data.sel != null) { patch.sel = null; patch.selRec = null; }
    if (this.data.delUndo) { patch.delUndo = null; this._stopDelTimer(); }
    if (Object.keys(patch).length) this.setData(patch);
  },
  /* _stopDelTimer / _startDelTimer 已收敛到 utils/pageBase.js */

  /* 撤销删除：把记录原样加回来。
     原来这里只还原了「那句话」，状态与几个时间字段全丢了——撤销一条「已放弃」的待办
     会把它退回「未做」，定了计划时间的胶囊也一并消失。既然叫「撤销」，就照 dump 原样回来 */
  onUndoDel() {
    if (this.guardEdit()) return;
    const u = this.data.delUndo; if (!u) return;
    this._stopDelTimer();
    const d = u.dump;
    const rec = {
      m: d.m, t: d.t, txt: d.txt, ext: d.ext || [], extSrc: d.extSrc || [],
      ts: d.ts, done: !!d.done, doneAt: d.doneAt || 0,
      status: d.status || '', startedAt: d.startedAt || 0, abandonedAt: d.abandonedAt || 0,
      dueTs: d.dueTs || 0, calTs: d.calTs || 0
    };
    store.addRecord(rec).then(rid => {
      rec._rid = rid; rec.id = rid;
      app.globalData.records.unshift(store.decorate(rec));
      this.setData({ delUndo: null });
      this.rebuild();
    });
  }
}));
