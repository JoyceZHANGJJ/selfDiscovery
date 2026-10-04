// pages/sleep/sleep.js —— 睡
// 这一页只有统计和时间线，**没有记录按钮**：睡前点的是顶部圆点左边那个「睡」（每个页面都在，
// 见 components/theme-switcher），比切到这一页再点一下更近。这里回答两件事：
// ① 这段时间平均几点睡、多少天在 0 点前 / 后；② 每个夜里各自是几点。
//
// 口径（与 utils/store.js 的 sleep* 完全同一份，这里只是取用）：
// · 一夜以**中午 12:00** 分界：12:00–23:59 点算今夜，00:00–11:59 点算昨夜
//   ——所以 23:47 点过、次日 00:20 又点，是同一夜，覆盖成 00:20（不新增）；
// · 「0 点前 / 0 点后」按点下的那一刻算，正好 0:00 归「0 点后」；
// · 平均入睡时间在「从中午 12:00 起算」的时间轴上求（跨 0 点接在后面），
//   否则 23:30 与 0:30 的平均会算出一个荒谬的 12:00。
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');
const date = require('../../utils/date.js');
const app = getApp();

const WIN = 14;   // 时间线一次显示多少夜（更早的走底部「显示更早的 N 夜」）

Page(pageBase({
  data: {
    ready: false,        // 首屏数据未就绪时先渲染骨架屏（与记 / 看 / 回看 同一套 .sk 样式）
    loadFail: false,     // 取数失败：撤掉骨架屏，给一句说明 + 可点的重试
    range: '30',         // 30＝近 30 天 | all＝全部
    hasAny: false,       // 全历史有没有记过（决定整页是「空态指引」还是统计 + 时间线）
    stats: { days: 0, before: 0, after: 0, beforePct: 0, avgTxt: '', gapTxt: '', earlyTxt: '', lateTxt: '' },
    trend: { has: false, pts: [], seg: [], first: '', sum: '' },   // 入睡趋势（只看近 30 天，见 buildTrend）
    list: [],            // 时间线（夜倒序）
    moreN: 0,            // 还有多少夜没展开
    show: WIN
  },

  onShow() {
    this.ensureTheme();
    this.layoutBrand();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3, theme: store.curTheme() });
    }
    this._startClock();
    store.ensureAll().then(ok => {
      if (!ok) { this.setData({ loadFail: true, ready: true }); return; }
      this.setData({ ready: true });
      this.refresh();
    });
  },
  onHide() { this._stopClock(); },
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
  /* 这一页没有实时数字要显示，走时钟只为了一件事：跨过中午 12:00 就是新的一夜了，
     「今夜 / 昨夜」这些标签和「近 30 天」的窗口都得跟着挪一格。
     所以一分钟看一次足够，没换夜就什么都不做（不 setData） */
  _tick() {
    if (!this._key) return;   // 还没 refresh 过（数据没到），别抢在它前面算
    if (store.sleepNightKey(Date.now()) !== this._key) this.refresh();
  },

  /* 从内存全量重算：统计 + 趋势 + 时间线（记下 / 撤销 / 删除 / 切范围 / 下拉刷新都走它） */
  refresh() {
    this._key = store.sleepNightKey(Date.now());
    const all = app.globalData.records || [];
    const isAll = this.data.range === 'all';
    const startTs = isAll ? null : (this._key - 29 * date.DAY);
    const st = store.sleepStats(all, { startTs });
    const list = st.nights.slice(0, this.data.show);
    this.setData({
      // 全历史一条都没有时整页换成一句指引（否则「统计」与「时间线」各喊一句"还没有记录"，
      // 而这一页本身没有记录按钮，得告诉人去点右上角那个「睡」）
      hasAny: all.some(r => r && r.m === 'sleep'),
      stats: {
        days: st.days, before: st.before, after: st.after, beforePct: st.beforePct,
        avgTxt: st.avgTxt, avgAfter: st.avgAfter, gapTxt: st.gapTxt, earlyTxt: st.earlyTxt, lateTxt: st.lateTxt
      },
      trend: isAll ? { has: false, pts: [], seg: [], first: '', sum: '' } : this.buildTrend(st),
      list,
      moreN: Math.max(0, st.nights.length - list.length)
    });
  },

  /* 入睡趋势：近 30 天每晚一个点连成折线。
     · x 轴 = 30 个夜槽（没记的夜是空槽，点与点断开不连线——补值会画出「睡得极早/极晚」的假象，
       与回看电量趋势同一口径）；y 轴固定 21:00 → 03:00，0 点线正好落在 50%，
       中线以下 = 0 点前（主题色点）、以上 = 0 点后（深灰点），与时间线胶囊同一套颜色；
     · 线段用 rotate 画（小程序没有 svg polyline，与电量趋势同一套最省的办法）；
     · 只在「近 30 天」给：「全部」的夜数太长，30 个点挤成一团也读不出走势。
       st.nights 是夜倒序（新→旧），这里按时间正序（旧→新）铺 x 轴 */
  buildTrend(st) {
    const LO = 21 * 60, HI = 27 * 60;   // 纵轴范围（入睡轴上：21:00=1260 → 次日 03:00=1620），0 点=1440 在正中
    const H = 84, W = 590;              // 图区高（px，与 .str-plot 一致）/ 宽（rpx，用于算线段长度）
    const byKey = {};
    st.nights.forEach(n => { byKey[n.key] = n; });
    const slots = [];
    for (let k = this._key - 29 * date.DAY; k <= this._key; k += date.DAY) {
      const n = byKey[k];
      slots.push(n ? n.off : null);
    }
    const pts = [];
    slots.forEach((off, i) => {
      if (off == null) return;
      pts.push({
        i,
        pct: slots.length > 1 ? (i / (slots.length - 1)) * 100 : 0,
        pct2: Math.max(0, Math.min(100, (off - LO) / (HI - LO) * 100)),   // 超出 21:00–03:00 的贴边
        after: off >= store.SLEEP_EDGE
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
    const firstKey = this._key - 29 * date.DAY;
    return {
      has: pts.length >= 2,               // 只有一个点画不出「趋势」，不如不给
      pts, seg,
      first: (store.datePrefix(firstKey) || '').trim(),
      sum: '近 30 夜记了 ' + pts.length + ' 夜'
    };
  },

  onRange(e) {
    const r = e.currentTarget.dataset.r;
    if (r === this.data.range) return;
    this.setData({ range: r }, () => this.refresh());
  },
  onMore() { this.setData({ show: this.data.show + WIN }, () => this.refresh()); },

  /* 顶部圆点的「睡」记下后回来（component 的 _notifySleep）：这一页显示着就立刻跟上。
     这一页自己没有记录入口——睡前点的是右上角那个「睡」，记完当场上屏 */
  onSleepChange() { this.refresh(); },

  /* 时间线里长按某一夜 → 确认后删掉。
     误点的补记不该一直留在统计里；「今夜」那条也在这条时间线的第一行，所以删今夜同样走这里 */
  onNightLongPress(e) {
    const id = e.currentTarget.dataset.id;
    const rec = (app.globalData.records || []).find(x => x.id === id);
    if (!rec) return;
    const d = store.sleepNightLabel(store.sleepNightKey(rec.ts));
    wx.showModal({
      title: '删掉' + d + '的入睡记录？',
      content: '这一条是 ' + (rec.txt || '') + ' 记下的。',
      confirmText: '删掉', confirmColor: '#C0574F',
      success: r => {
        if (!r.confirm) return;
        store.sleepRemove(rec).then(() => {
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
