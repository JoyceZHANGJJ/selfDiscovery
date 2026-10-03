// pages/review/review.js —— 回看
// · 全部：主题档案 —— 以「内容」为轴，把全历史里同名的主项（觉察的「归类」、此刻「想记的是」、
//   可做的「什么事」）聚成一条条档案：出现多少次、跨多久、按时间怎么分布，
//   展开还能看到它自身的变化（喜恶 / 感受 / 可做状态的迁移）与最近的要点。
//   （只看 觉察 / 此刻 / 可做；待办 / 随记不算可回看的"内容主题"）
// · 周 / 月：按自然周 / 自然月出的复盘报告（本期 vs 上期），回答"这段时间怎么样"。
const store = require('../../utils/store.js');
const app = getApp();

const DAY = 86400000;

// 某天 0 点的毫秒时间戳（用于按天去重 / 出每日分布）
function dayStart(ts) {
  const d = new Date(ts || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 取一条记录里某个来源的值（细节按 extSrc / ext 对齐）
function extVal(r, src) {
  const es = r.extSrc || [], ex = r.ext || [];
  const i = es.indexOf(src);
  return i >= 0 ? (ex[i] || '') : '';
}
// 去掉相邻重复项，得到一个「变化序列」（如 喜欢 → 没兴趣）
function seqOf(vals) {
  const out = [];
  vals.forEach(v => { if (v && out[out.length - 1] !== v) out.push(v); });
  return out;
}
// 一条记录的「要点」：优先取自由描述类字段
const NOTE_SRCS = ['free:desc', 'free:obsfeel', 'free:tasknote', 'free:nownote', 'free:trigger', 'free:doneFeel', 'free:doneGain', 'free:hope'];
function pickNote(r) {
  for (let i = 0; i < NOTE_SRCS.length; i++) { const v = extVal(r, NOTE_SRCS[i]); if (v) return v; }
  return '';
}
// 月序号（年 * 12 + 月，0 基）与显示名，用于按月的分布
function mIndex(ts) { const d = new Date(ts || 0); return d.getFullYear() * 12 + d.getMonth(); }
function mLabel(idx) { return Math.floor(idx / 12) + '年' + ((idx % 12) + 1) + '月'; }

const WANT_ST = { '': '未做', doing: '在做', done: '做了', abandon: '不做' };

// 自然周（周一 0 点起）/ 自然月；offset：0 本期、-1 上一期（只往前翻）
function periodOf(unit, offset) {
  const now = new Date();
  let start, end, label;
  if (unit === 'month') {
    const s = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    start = s.getTime();
    end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1).getTime();
    label = s.getFullYear() + '年' + (s.getMonth() + 1) + '月';
  } else {
    const back = (now.getDay() + 6) % 7;   // 周日=0 → 距周一的天数
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    mon.setHours(0, 0, 0, 0);
    start = mon.getTime() + offset * 7 * DAY;
    end = start + 7 * DAY;
    const a = new Date(start), b = new Date(end - DAY);
    label = (a.getMonth() + 1) + '月' + a.getDate() + '日 – ' + (b.getMonth() + 1) + '月' + b.getDate() + '日';
  }
  const isM = unit === 'month';
  const rel = offset === 0 ? (isM ? '本月' : '本周')
    : (offset === -1 ? (isM ? '上月' : '上周')
    : (offset < 0 ? Math.abs(offset) + (isM ? ' 个月前' : ' 周前') : offset + (isM ? ' 个月后' : ' 周后')));
  return { start, end, label, rel, unit, offset };
}

Page({
  data: {
    theme: 'mint',
    statusH: 20,
    view: 'week',        // week | month | all（主题档案）
    // —— 周 / 月复盘 ——
    offset: 0,
    curLabel: '', curRel: '', preText: '',
    kpis: [], dims: [], flow: [], tops: [], trend: [], trendSum: '',
    // —— 全部：主题档案 ——
    docSort: 'n',        // n（最常出现）| recent（最近出现）
    docLimit: 20,
    docs: [],            // 当前展示的档案
    docTotal: 0,
    docHead: '',
    refreshing: false
  },
  _docs: [],             // 全量档案（不塞进 data，避免 setData 过大）

  onShow() {
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    this.setData({ theme: store.curTheme(), statusH: info.statusBarHeight || 20 });
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 2, theme: wx.getStorageSync('theme') || 'mint' });
    store.ensureAll().then(() => this.build());
  },

  /* ---------------- 视图切换 ---------------- */
  onView(e) {
    const v = e.currentTarget.dataset.v;
    if (v === this.data.view) return;
    this.setData({ view: v, offset: 0 }, () => this.build());
  },
  onPrev() { if (this.data.view === 'all') return; this.setData({ offset: this.data.offset - 1 }, () => this.buildPeriod()); },
  onNext() {
    if (this.data.view === 'all' || this.data.offset >= 0) return;   // 已经是本期，不再往后
    this.setData({ offset: this.data.offset + 1 }, () => this.buildPeriod());
  },
  build() { if (this.data.view === 'all') this.buildDocs(); else this.buildPeriod(); },

  /* ---------------- 全部：主题档案 ---------------- */
  onDocSort(e) {
    const s = e.currentTarget.dataset.s;
    if (s === this.data.docSort) return;
    this.setData({ docSort: s, docLimit: 20 }, () => this.buildDocs());
  },
  onDocMore() { this.setData({ docLimit: this.data.docLimit + 20 }, () => this.buildDocs()); },
  onDocTap(e) {
    const i = e.currentTarget.dataset.i;
    const patch = {};
    patch['docs[' + i + '].open'] = !this.data.docs[i].open;
    this.setData(patch);
  },

  buildDocs() {
    // 主题档案只回看「觉察 / 此刻 / 可做」：待办是"要做的事"（流转在周 / 月复盘里看），
    // 随记是流水式的一句话——都算不上可回看的"内容主题"
    const all = (app.globalData.records || []).filter(r => !store.isTask(r.m) && r.m !== 'jot');
    // 记住已展开的，重建（换排序 / 显示更多）时不收起来
    const openMap = {};
    (this.data.docs || []).forEach(d => { if (d.open) openMap[d.txt] = 1; });

    const byTxt = {}, keys = [];
    all.forEach(r => {
      const t = r.txt || '（未填）';
      if (!byTxt[t]) { byTxt[t] = []; keys.push(t); }
      byTxt[t].push(r);
    });

    const docs = keys.map(t => {
      const rs = byTxt[t].slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const n = rs.length;
      const firstTs = rs[0].ts || 0, lastTs = rs[rs.length - 1].ts || 0;

      // 涉及哪些维度（次数 + 色点；待办按类别取色）
      const modAcc = {};
      rs.forEach(r => { modAcc[r.m] = (modAcc[r.m] || 0) + 1; });
      const mods = Object.keys(modAcc).map(k => ({
        k, n: modAcc[k], nm: store.mname(k),
        c: store.isTask(k) ? store.taskColor(rs.find(r => r.m === k)) : store.mcolor(k)
      })).sort((a, b) => b.n - a.n);

      // 按月的分布（最多回看最近 12 个月，避免跨度太长把柱子挤没了）
      const mc = {};
      rs.forEach(r => { const m = mIndex(r.ts || 0); mc[m] = (mc[m] || 0) + 1; });
      const m0 = mIndex(firstTs), m1 = mIndex(lastTs);
      const startM = Math.max(m0, m1 - 11);
      const arr = [];
      for (let m = startM; m <= m1; m++) arr.push(mc[m] || 0);
      const mmx = Math.max(1, ...arr);
      const months = arr.map(v => ({ lv: v ? (v === mmx ? 3 : (v * 2 >= mmx ? 2 : 1)) : 0 }));

      // 变化：喜恶 / 感受 / 可做状态的迁移
      const changes = [];
      const obsRs = rs.filter(r => r.m === 'obs');
      const kindSeq = seqOf(obsRs.map(r => extVal(r, 'obsKind')));
      if (kindSeq.length >= 2) changes.push({ l: '喜恶', v: kindSeq.join(' → ') });
      const feelSeq = seqOf(obsRs.map(r => (extVal(r, 'obsDeg') + extVal(r, 'obsMood'))));
      if (feelSeq.length >= 2) changes.push({ l: '感受', v: feelSeq.join(' → ') });
      const wantSeq = seqOf(rs.filter(r => r.m === 'want').map(r => WANT_ST[r.status || ''] || '未做'));
      if (wantSeq.length >= 2) changes.push({ l: '可做', v: wantSeq.join(' → ') });

      // 要点：最近几次里写过的自由描述
      const notes = [];
      for (let i = rs.length - 1; i >= 0 && notes.length < 3; i--) {
        const v = pickNote(rs[i]);
        if (v) notes.push({ d: (store.datePrefix(rs[i].ts) || '今天').trim() + ' ' + (rs[i].t || ''), v });
      }

      const lastTxt = (store.datePrefix(lastTs) || '今天').trim();
      const rangeTxt = mLabel(startM) + (startM === m1 ? '' : ' – ' + mLabel(m1));
      return {
        txt: t, n, lastTs, mods, months, changes, notes,
        metaTxt: '最近 ' + lastTxt + ' · ' + rangeTxt,
        hasChange: changes.length > 0,
        open: !!openMap[t]
      };
    });

    docs.sort((a, b) => this.data.docSort === 'recent'
      ? (b.lastTs - a.lastTs)
      : (b.n - a.n || (b.lastTs - a.lastTs)));
    this._docs = docs;

    let head = '还没有可回看的内容';
    if (all.length) head = '共 ' + all.length + ' 条记录（不含待办、随记）· ' + docs.length + ' 个内容';
    this.setData({
      docs: docs.slice(0, this.data.docLimit),
      docTotal: docs.length,
      docHead: head
    });
  },

  /* ---------------- 周 / 月复盘 ---------------- */
  buildPeriod() {
    const all = app.globalData.records || [];
    const unit = this.data.view;                          // week | month
    const cur = periodOf(unit, this.data.offset);
    const pre = periodOf(unit, this.data.offset - 1);
    const inR = (ts, p) => ts >= p.start && ts < p.end;

    const c = all.filter(r => inR(r.ts || 0, cur));      // 本期记下的（按创建时间归属）
    const pv = all.filter(r => inR(r.ts || 0, pre));     // 上期，用来算增减

    const days = new Set(c.map(r => dayStart(r.ts))).size;
    const delta = c.length - pv.length;
    const kpis = [
      { n: c.length, l: '本期记录', s: delta === 0 ? '与上期持平' : ('较上期 ' + (delta > 0 ? '+' + delta : delta)), cls: delta > 0 ? 'up' : (delta < 0 ? 'dn' : '') },
      { n: days, l: '活跃天数', s: '', cls: '' }
    ];

    // 各维度条数 + 与上期的增减（条宽按本期最大值归一）
    const raw = store.MODULES.map(m => {
      const v = c.filter(r => r.m === m.k).length;
      const p = pv.filter(r => r.m === m.k).length;
      const d = v - p;
      return { k: m.k, n: m.n, c: m.c, v, dt: d === 0 ? '' : (d > 0 ? '+' + d : String(d)), up: d > 0 };
    });
    const mx = Math.max(1, ...raw.map(x => x.v));
    const dims = raw.map(x => ({ k: x.k, n: x.n, c: x.c, v: x.v, dt: x.dt, up: x.up, w: Math.round(x.v / mx * 100) + '%' }));

    // 流转：可做（新增 / 做了 / 放弃）、待办（记了 / 完成）
    // 「做了 / 完成 / 放弃」按发生时间归属本期（不是创建时间），这样「这周做了什么」才是真的
    const wantN = c.filter(r => r.m === 'want').length;
    const doneWant = all.filter(r => r.m === 'want' && r.status === 'done' && inR(r.doneAt || 0, cur)).length;
    const abandWant = all.filter(r => r.m === 'want' && r.status === 'abandon' && inR(r.abandonedAt || 0, cur)).length;
    const todoN = c.filter(r => store.isTask(r.m)).length;
    const doneTodo = all.filter(r => store.isTask(r.m) && r.done && inR(r.doneAt || 0, cur)).length;
    const flow = [
      { l: '可做', items: [{ n: '新增', v: wantN }, { n: '做了', v: doneWant }, { n: '放弃', v: abandWant }] },
      { l: '待办', items: [{ n: '记了', v: todoN }, { n: '完成', v: doneTodo }] }
    ];

    // 记得最多的：各维度内容 Top 3
    const topN = (list) => {
      const acc = {};
      list.forEach(r => { const t = r.txt || '（未填）'; acc[t] = (acc[t] || 0) + 1; });
      return Object.keys(acc).sort((a, b) => acc[b] - acc[a]).slice(0, 3).map(t => ({ t, n: acc[t] }));
    };
    const tops = store.MODULES
      .map(m => ({ n: m.n, c: m.c, items: topN(c.filter(r => r.m === m.k)) }))
      .filter(g => g.items.length);

    // 本期每天：按天出条小柱（周=7、月=28~31），顺带一句概述
    const dayMap = {};
    c.forEach(r => { const k = dayStart(r.ts); dayMap[k] = (dayMap[k] || 0) + 1; });
    const arr = [];
    for (let t = dayStart(cur.start); t < cur.end; t += DAY) arr.push(dayMap[t] || 0);
    const dmx = Math.max(1, ...arr);
    const trend = arr.map(n => ({ lv: n ? (n === dmx ? 3 : (n * 2 >= dmx ? 2 : 1)) : 0 }));
    const act = arr.filter(n => n).length;
    const trendSum = act ? ('有记录 ' + act + ' 天 · 最多一天 ' + dmx + ' 条') : '本期还没有记录';

    this.setData({
      curLabel: cur.label,
      curRel: cur.rel,
      preText: '上期 ' + pre.label,
      kpis, dims, flow, tops, trend, trendSum
    });
  },

  /* 下拉刷新：从云端重新拉取全部数据 */
  onRefresh() {
    this.setData({ refreshing: true });
    store.reload().then(() => { this.build(); this.setData({ refreshing: false }); })
      .catch(() => this.setData({ refreshing: false }));
  }
});
