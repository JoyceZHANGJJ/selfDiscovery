// pages/sleep/sleep.js —— 作息（起 / 睡）
// 这一页只有统计和时间线，**没有记录按钮**：点的是顶部圆点旁边那两个胶囊「起 / 睡」
// （每个页面都在，见 components/theme-switcher），比切到这一页再点一下更近。
// 上面是「起」——平均几点起、多少个早上在基准点前 / 后起；往下滑（或点「睡」）看入睡的那一半。
//
// 口径（与 utils/store.js 的 sleep* / wake* 完全同一份，这里只是取用）：
// · 一夜 = 睡一次 + 起一次，**以中午 12:00 分界**（12:00–23:59 点算今夜，00:00–11:59 算昨夜），
//   重复点＝覆盖（不新增）；
// · **基准点**（设置 · 作息里可改，睡默认 0 点 / 起默认 6 点，时分可调）是拿来比较的那条线：
//   睡 → 「多少夜在它之后才睡、多少夜在它之前」，起 → 「多少个早上在它之前起、多少个在它之后」；
//   改基准点后回到这一页（onShow）整页重算——统计本来就是「按现在的口径看历史」；
// · 平均入睡时间在「从中午 12:00 起算」的时间轴上求（跨 0 点接在后面），
//   否则 23:30 与 0:30 的平均会算出荒谬的 12:00；起床都落在清晨一个连续段里，直接按钟表算。
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');
const date = require('../../utils/date.js');
const swipe = require('../../utils/swipe.js');
const app = getApp();

const WIN = 14;   // 时间线一次显示多少夜（更早的走底部「显示更早的 N 夜」，起 / 睡各一份窗口）

const EMPTY_TREND = { has: false, pts: [], seg: [], first: '', sum: '', anchorPct: null };

// 'YYYY-MM-DD'（原生日期选择器的值格式；也是「改时刻」面板里显示的那串）
function dayStr(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
// 'YYYY-MM-DD' + 'HH:MM' → 时间戳（本地时区）；任一段认不出来返回 null
function tsFrom(dateS, timeS) {
  const md = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateS || '');
  const mt = /^(\d{1,2}):(\d{2})$/.exec(timeS || '');
  if (!md || !mt) return null;
  return new Date(+md[1], +md[2] - 1, +md[3], +mt[1], +mt[2], 0).getTime();
}

Page(pageBase({
  data: {
    ready: false,        // 首屏数据未就绪时先渲染骨架屏（与记 / 看 / 回看 同一套 .sk 样式）
    loadFail: false,     // 取数失败：撤掉骨架屏，给一句说明 + 可点的重试
    seg: 'wake',         // 当前视图：wake＝起（默认）| sleep＝睡。点顶部胶囊或左右滑动切换
    range: '30',         // 30＝近 30 天 | all＝全部（两段共用同一份范围）
    hasSleep: false,     // 全历史有没有记过（各段自己的空态指引）
    hasWake: false,
    st: { days: 0, before: 0, after: 0, beforePct: 0, anchorTxt: '', avgTxt: '', gapTxt: '', earlyTxt: '', lateTxt: '' },
    wk: { days: 0, before: 0, after: 0, beforePct: 0, anchorTxt: '', avgTxt: '', earlyTxt: '', lateTxt: '' },
    trend: EMPTY_TREND,  // 入睡趋势（只看近 30 天，见 buildTrend）
    wtrend: EMPTY_TREND, // 起床趋势（同上，纵轴不同）
    list: [],            // 入睡时间线（夜倒序）
    wlist: [],           // 起床时间线（日倒序）
    moreN: 0, wmoreN: 0,
    show: WIN, wshow: WIN,
    // 行尾左滑「改」弹出的编辑面板：null＝没开。{ id, m, title, date, time, oldT, max, hint }
    ed: null
  },

  onShow() {
    this.ensureTheme();
    this.layoutBrand();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3, theme: store.curTheme() });
    }
    this._setTabBar(!!this.data.ed);   // 编辑面板开着时（从后台回来）tab 栏要保持收起
    this._startClock();
    store.ensureAll().then(ok => {
      if (!ok) { this.setData({ loadFail: true, ready: true }); return; }
      this.setData({ ready: true });
      this.refresh();
    });
  },
  // 切走时把编辑面板收掉、并把 tab 栏放回来（它是本页自己的实例，别把 hidden 带回来）
  onHide() { this._stopClock(); if (this.data.ed) this.setData({ ed: null }); this._setTabBar(false); },
  onUnload() { this._stopClock(); },

  /* 取数失败后点「重试」：再走一遍加载（store 失败时会把状态放回去，可以再来一次） */
  onRetry() {
    if (this._retrying) return;
    this._retrying = true;
    this.setData({ loadFail: false, ready: false });
    store.ensureAll().then(ok => {
      this._retrying = false;
      if (!ok) { this.setData({ loadFail: true, ready: true }); return; }
      this.onShow();
    });
  },

  _startClock() { this._stopClock(); this._clock = setInterval(() => this._tick(), 60000); },
  _stopClock() { if (this._clock) { clearInterval(this._clock); this._clock = null; } },
  /* 这一页没有实时数字要显示，走时钟只为了一件事：跨过分割点就是新的一夜了，
     「今夜 / 昨夜 / 今早」这些标签和「近 30 天」的窗口都得跟着挪一格。
     所以一分钟看一次足够，没换夜就什么都不做（不 setData） */
  _tick() {
    if (!this._key) return;   // 还没 refresh 过（数据没到），别抢在它前面算
    if (store.sleepNightKey(Date.now()) !== this._key) this.refresh();
  },

  /* 从内存全量重算：起 / 睡两段的统计 + 趋势 + 时间线都算好
     （记下 / 撤销 / 删除 / 切范围 / 改基准点回来 / 下拉刷新都走它；两段一起算，滑过去就是现成的） */
  refresh() {
    this._key = store.sleepNightKey(Date.now());
    const all = app.globalData.records || [];
    const isAll = this.data.range === 'all';
    const startTs = isAll ? null : (this._key - 29 * date.DAY);
    const st = store.sleepStats(all, { startTs });
    const wk = store.wakeStats(all, { startTs });
    const list = st.nights.slice(0, this.data.show);
    const wlist = wk.nights.slice(0, this.data.wshow);
    this.setData({
      hasSleep: all.some(r => r && r.m === 'sleep'),
      hasWake: all.some(r => r && r.m === 'wake'),
      st: {
        days: st.days, before: st.before, after: st.after, beforePct: st.beforePct,
        anchorTxt: st.anchorTxt, avgTxt: st.avgTxt, avgAfter: st.avgAfter,
        gapTxt: st.gapTxt, earlyTxt: st.earlyTxt, lateTxt: st.lateTxt
      },
      wk: {
        days: wk.days, before: wk.before, after: wk.after, beforePct: wk.beforePct,
        anchorTxt: wk.anchorTxt, avgTxt: wk.avgTxt, earlyTxt: wk.earlyTxt, lateTxt: wk.lateTxt
      },
      trend: isAll ? EMPTY_TREND : this.buildTrend(st.nights, true),
      wtrend: isAll ? EMPTY_TREND : this.buildTrend(wk.nights, false),
      list,
      wlist,
      moreN: Math.max(0, st.nights.length - list.length),
      wmoreN: Math.max(0, wk.nights.length - list.length)
    });
  },

  /* 趋势图：近 30 天每天一个点连成折线（睡按夜、起按天）。
     · x 轴 = 30 个槽（没记的断开不连线——补值会画出「极早 / 极晚」的假象，与电量趋势同一口径）；
     · 纵轴固定**钟表时刻**：睡 21:00 → 03:00（纵轴值按「从中午 12:00 起算」，跨 0 点接在后面）、
       起 05:00 → 13:00（直接是钟表分钟）；
     · 基准点（睡默认 0 点 / 起默认 6 点）在图上画成一条**加重的中线**：
       它的位置随设置挪，落在纵轴范围外时那条线不画（anchorPct = null）；
     · 线段用 rotate 画（小程序没有 svg polyline，与电量趋势同一套最省的办法）；
     · 只在「近 30 天」给：「全部」的点太长，挤成一团读不出走势。
       nights 是倒序（新→旧），这里按时间正序（旧→新）铺 x 轴 */
  buildTrend(nights, isSleep) {
    const LO = isSleep ? 21 * 60 : 5 * 60, HI = isSleep ? 27 * 60 : 13 * 60;
    const H = 84, W = 590;              // 图区高（px，与 .str-plot 一致）/ 宽（rpx，用于算线段长度）
    const byKey = {};
    (nights || []).forEach(n => { byKey[n.key] = n; });
    const slots = [];
    for (let k = this._key - 29 * date.DAY; k <= this._key; k += date.DAY) {
      slots.push(byKey[k] || null);
    }
    const pts = [];
    slots.forEach((n, i) => {
      if (!n) return;
      pts.push({
        i,
        pct: slots.length > 1 ? (i / (slots.length - 1)) * 100 : 0,
        pct2: Math.max(0, Math.min(100, (n.off - LO) / (HI - LO) * 100)),   // 超出纵轴的贴边
        after: !!n.after
      });
    });
    const seg = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = (b.pct - a.pct) / 100 * W;
      const dy = (b.pct2 - a.pct2) / 100 * H;
      seg.push({
        k: 's' + i, x0: a.pct, y0: a.pct2,
        w: Math.sqrt(dx * dx + dy * dy),
        rot: -Math.atan2(dy, dx) * 180 / Math.PI   // CSS 的 y 轴向下，取负
      });
    }
    // 基准点线：纵轴上的位置（睡 0 点 = 1440 在 21:00–03:00 的正中；改成 23 点就往左挪）。
    // 落在纵轴范围外（比如把睡基准点设成 6 点）就不画这条线，也不在文案里提它
    const edge = isSleep ? store.sleepAnchor() : store.getAnchor('wake');
    const ep = (edge - LO) / (HI - LO) * 100;
    const hasEdge = ep >= 0 && ep <= 100;
    const anchorTxt = store.anchorTxt(edge);
    const firstKey = this._key - 29 * date.DAY;
    const unit = isSleep ? '夜' : '天';
    return {
      has: pts.length >= 2,               // 只有一个点画不出「趋势」，不如不给
      pts, seg,
      hasEdge,
      anchorPct: Math.round(ep),
      anchorTxt,
      first: (store.datePrefix(firstKey) || '').trim(),
      sum: '近 30 ' + unit + '记了 ' + pts.length + ' ' + unit,
      sub: (isSleep ? '越靠上睡得越晚' : '越靠上起得越晚') + (hasEdge ? '（' + anchorTxt + ' 线为基准）' : '')
    };
  },

  /* 顶部分段切换：点胶囊。左右滑动的手势见下面 onSwipe* */
  onSeg(e) {
    const s = e.currentTarget.dataset.s;
    if (!s || s === this.data.seg) return;
    this.setData({ seg: s });
  },
  /* 左右滑动切段：向左滑 → 睡，向右滑 → 起（识别用 utils/swipe.js，
     与看 / 回看切维度同一套——横向位移够大且明显大于纵向才算，不与页面纵向滚动打架）。
     手势挂在 .screen（height:100% 那一层，永远铺满整屏）而不是 .body：
     **空白处也生效**——.body 内容不满一屏时只有内容那么高，下面那片留白不在它里面。
     行尾左滑改时刻的那一下会在行里先把起点吃掉，这里是收不到的空动作 */
  onSwipeStart(e) { swipe.start(this, e); },
  onSwipeEnd(e) {
    const d = swipe.end(this, e);
    if (d === 'left' && this.data.seg === 'wake') this.setData({ seg: 'sleep' });
    if (d === 'right' && this.data.seg === 'sleep') this.setData({ seg: 'wake' });
  },

  /* 行级手势：时间线里**行尾起手的左滑**＝改这一条的时刻（防误触：只有行尾那一小段起手才算，
     行中间往左滑仍归页面切起 / 睡，与看页 / 清单页同一条界线）。长按删除照旧 */
  onRowTouchStart(e) { this._rowEdge = swipe.atEdge(e); this._rowLong = false; swipe.start(this, e); },
  onRowTouchCancel() { this._rowEdge = false; this._rowLong = false; this._swX = null; this._swY = null; },
  onRowTouchend(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const edge = this._rowEdge; this._rowEdge = false;
    // 这一下已经按成长按删除（确认框弹出来了）→ 手指抬起时的移动不再算「改时刻」，
    // 但起点要吃掉：否则整页那次 end 会拿它去切段（框还在上面就切了页）
    if (this._rowLong) { this._rowLong = false; swipe.end(this, e); return; }
    if (edge && ds.id != null && swipe.dir(this, e) === 'left') {
      swipe.end(this, e);   // 这一下归行内：吃掉起点，整页那次 end 就什么也拿不到
      const r = (app.globalData.records || []).find(x => x.id === ds.id);
      if (r) this.openEd(r);
    }
  },

  /* 打开「改时刻」面板：日期 + 时间两个原生选择器（年月日时分都能改）。
     进来时把当前值填好，日期上限给到今天（未来时段不该出现在作息里） */
  openEd(r) {
    const d = new Date(r.ts || Date.now());
    this.setData({
      ed: {
        id: r.id, m: r.m,
        title: (r.m === 'wake' ? '改起床时间' : '改入睡时间'),
        date: dayStr(d), time: store.minTxt(d.getHours() * 60 + d.getMinutes()),
        oldT: r.txt || store.minTxt(d.getHours() * 60 + d.getMinutes()),
        max: dayStr(new Date()),
        hint: '可以改到过去的任何一天；那一天 / 那一夜已经有记录时不会被覆盖。'
      }
    });
    this._setTabBar(true);
  },
  closeEd() { this.setData({ ed: null }); this._setTabBar(false); },
  onEdDate(e) { this.setData({ 'ed.date': e.detail.value }); },
  onEdTime(e) { this.setData({ 'ed.time': e.detail.value }); },
  /* 保存：只有两条规则——不能改到将来；目标时段不能已经有同类记录（校验在 store.slotTaken，
     只有一份）。通过就改时刻（主项跟着改成新的 HH:MM），然后整页重算 */
  onEdSave() {
    const ed = this.data.ed;
    if (!ed) return;
    const rec = (app.globalData.records || []).find(x => x.id === ed.id);
    if (!rec) { this.closeEd(); return; }
    const ts = tsFrom(ed.date, ed.time);
    if (ts == null) { wx.showToast({ title: '这个时间认不出来', icon: 'none' }); return; }
    if (ts > Date.now()) { wx.showToast({ title: '不能改到将来', icon: 'none' }); return; }
    if (ts === rec.ts) { this.closeEd(); return; }
    const hit = store.slotTaken(rec, ts);
    if (hit) {
      const d = rec.m === 'wake' ? store.wakeDayLabel(hit.ts) : store.sleepNightLabel(store.sleepNightKey(hit.ts));
      wx.showToast({ title: d + '已经记过 ' + (hit.txt || '') + '，先改或删掉它', icon: 'none', duration: 2200 });
      return;
    }
    store.moveRec(rec, ts);
    this.closeEd();
    this.refresh();
    wx.showToast({ title: '已改成 ' + rec.txt, icon: 'none' });
  },
  _setTabBar(h) {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: !!h });
  },

  onRange(e) {
    const r = e.currentTarget.dataset.r;
    if (r === this.data.range) return;
    this.setData({ range: r }, () => this.refresh());
  },
  onMore() { this.setData({ show: this.data.show + WIN }, () => this.refresh()); },
  onWMore() { this.setData({ wshow: this.data.wshow + WIN }, () => this.refresh()); },

  /* 顶部胶囊的「起 / 睡」记下后回来（component 的 _notifyRec）：这一页显示着就立刻跟上。
     这一页自己没有记录入口——点的是右上角那两个胶囊，记完当场上屏 */
  onSleepChange() { this.refresh(); },
  onWakeChange() { this.refresh(); },

  /* 时间线里长按某一行 → 确认后删掉（起 / 睡共用一个处理器，按记录自己的模块分派）。
     误点的补记不该一直留在统计里；最新那一条也在这条时间线的第一行，所以同样走这里 */
  onNightLongPress(e) {
    this._rowLong = true;   // 让同一触摸的 touchend 别再打开「改时刻」（见 onRowTouchend）
    const id = e.currentTarget.dataset.id;
    const rec = (app.globalData.records || []).find(x => x.id === id);
    if (!rec) return;
    const isW = rec.m === 'wake';
    const d = isW ? store.wakeDayLabel(rec.ts) : store.sleepNightLabel(store.sleepNightKey(rec.ts));
    wx.showModal({
      title: '删掉' + d + '的' + (isW ? '起床' : '入睡') + '记录？',
      content: '这一条是 ' + (rec.txt || '') + ' 记下的。',
      confirmText: '删掉', confirmColor: '#C0574F',
      success: r => {
        if (!r.confirm) return;
        (isW ? store.wakeRemove(rec) : store.sleepRemove(rec)).then(() => {
          this.refresh();
          wx.showToast({ title: '已删掉', icon: 'none' });
        });
      }
    });
  },

  /* 页面级下拉刷新（原生下拉回弹，与记 / 看 / 回看 一致）；
     下拉时程序名正好从胶囊后露出来，顺手播一次逐字浮现 */
  onPullDownRefresh() {
    this.layoutBrand();
    this.playBrand();
    this.onRefresh();
  },
  onRefresh() {
    store.reload().then(() => { this.refresh(); wx.stopPullDownRefresh(); })
      .catch(() => wx.stopPullDownRefresh());
  }
}));
