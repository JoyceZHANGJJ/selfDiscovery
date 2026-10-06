// pages/profile/profile.js —— 个人画像
// 基于全部历史记录，由云函数 analysis 的 action:'profile' 生成一份「专属人物深度分析报告」
// （七章：基础画像 / 核心盘点 / 适配方向 / 未来推演 / 行动方案 / 决策辅助 / 总结）。
// 每 openid 一份最新：进页面先 profileGet（只读、秒回、不花大模型额度）。
//
// 交互约定：
// 1) 下拉刷新 = 只重新**读取**已有画像（profileGet，秒回、不花大模型额度），不会重新生成。
// 2) 重新生成 = 真调大模型重算，**每个自然周只能点一次**（周一 00:00 按中国时区重置；
//    云函数冷却 + 前端按钮置灰提示「还剩 N 天」双道拦截，避免反复刷额度）。
// 3) 生成是「后台任务」：点击后立即提交，页面进入 pending 态提示「稍后回来查看」，
//    同时后台轮询 profileGet；出结果自动渲染 + toast。不用对着转圈干等。
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');

const POLL_MS = 5000;      // 轮询间隔
const POLL_MAX = 24;       // 最多轮询 24 次（约 2 分钟）

function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/* 「每周从星期一开始」：按**中国时区**算某个时刻落在哪个自然周（周一 00:00 起）。
   必须和云函数 cnWeekStart 完全一致，否则按钮显示的天数和云端判定会错位。 */
const CN =8 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
function cnWeekStart(ts) {
  const d = new Date(ts + CN);
  const dow = d.getUTCDay();                     // 0=周日
  const backToMon = (dow + 6) % 7;               // 周一=0 … 周日=6
  const mid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0) - CN;
  return mid - backToMon * DAY;
}

// 云函数返回的嵌套对象 → 页面用的扁平结构（补齐空数组/空串，wxml 可直接 .length）
function mapProfile(p) {
  const o = (v, keys) => {
    const src = (v && typeof v === 'object') ? v : {};
    const out = {};
    keys.forEach(k => { out[k] = Array.isArray(src[k]) ? src[k] : []; });
    return out;
  };
  const s = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
  const f = (p.future && typeof p.future === 'object') ? p.future : {};
  const d = (p.decision && typeof p.decision === 'object') ? p.decision : {};
  return {
    _id: p._id,
    summary: s(p.summary).slice(0, 300),
    basic: o(p.basic, ['info', 'energy', 'decision', 'body', 'finance', 'env']),
    core: o(p.core, ['strengths', 'downsides', 'conflicts']),
    fit: o(p.fit, ['workFirst', 'workCareful', 'workAvoid', 'life', 'risks']),
    future: { neutral: s(f.neutral), optimistic: s(f.optimistic), cautious: s(f.cautious) },
    action: o(p.action, ['quick', 'rules', 'metrics']),
    decision: {
      rhythm: s(d.rhythm),
      framework: Array.isArray(d.framework) ? d.framework : [],
      trial: Array.isArray(d.trial) ? d.trial : []
    },
    conclusion: s(p.conclusion).slice(0, 500),
    n: p.n || 0,
    updatedAt: p.updatedAt || 0,
    updatedAtLabel: fmtTs(p.updatedAt)
  };
}

Page(pageBase({
  data: {
    ready: false,          // 首屏是否已拉到（含「没有画像」的明确结论）
    loading: false,        // 读取中（profileGet，秒级）
    genning: false,        // 生成请求在途中（拦重复点击）
    pending: false,        // 已提交生成、结果还没出来（后台跑着，可随时离开）
    genFail: false,        // 生成失败（明确报错，非轮询超时）
    p: null,               // 画像对象
    empty: false,          // 还没生成过
    cooling: false,        // 距上次生成不足一周（重新生成按钮置灰）
    retryDays: 0// 冷却还剩几天
  },

  onShow() {
    this.ensureTheme();
    this.layoutBrand();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3, theme: store.curTheme() });
    }
    this.loadProfile();
    // 上次提交过生成、还没看到结果：回到页面继续等
    if (this.data.pending) this.startPolling();
  },

  onHide() { this.stopPolling(); },
  onUnload() { this.stopPolling(); this._gone = true; },

  // 冷却判定：上次生成还落在**当前这一自然周**（周一00:00 起）内 → 锁定到下周一 00:00。
  // 与云函数 cnWeekStart 逻辑一致（都按中国时区），前端先拦一道，云函数还会再拦一道。
  applyCooldown(updatedAt) {
    if (!updatedAt) { this.setData({ cooling: false, retryDays: 0 }); return; }
    const wk = cnWeekStart(Date.now());
    if (updatedAt >= wk) {
      // 距下周一00:00 还有几天（周一~周日分别剩 7~1 天）
      this.setData({ cooling: true, retryDays: Math.max(1, Math.ceil((wk + 7 * DAY - Date.now()) / DAY)) });
    } else {
      this.setData({ cooling: false, retryDays: 0 });
    }
  },

  // 下拉刷新 = 只重新读取已有画像（profileGet，秒回、不花大模型额度），不重新生成
  onPullDownRefresh() {
    this.layoutBrand();
    this.playBrand();
    this.loadProfile(() => wx.stopPullDownRefresh());
  },

  // 只读已存的画像（不花大模型额度）；没有就留空态让用户点生成
  loadProfile(cb) {
    if (this._reading) { cb && cb(); return; }
    this._reading = true;
    this.setData({ loading: true });
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'profileGet' } })
      .then(res => {
        this._reading = false;
        const p = res.result && res.result.profile;
        this.setData({
          loading: false, ready: true, genFail: false,
          p: p ? mapProfile(p) : null,
          empty: !p
        });
        this.applyCooldown(p ? p.updatedAt : 0);
        cb && cb();
      })
      .catch(() => {
        // 读失败（集合还没建 / 网络问题）：先给空态，不阻断页面
        this._reading = false;
        this.setData({ loading: false, ready: true, empty: true, genFail: false });
        cb && cb();
      });
  },

  /* 提交生成（或重新生成）。立即返回，不阻塞：
     置 pending → 发请求 → 后台轮询 profileGet 直到 updatedAt 变化。 */
  generate() {
    if (this._gone) return;
    // 已在生成 / 已在等待：再点只是催一下结果，不重复提交
    if (this.data.gening || this.data.pending) { this.loadProfile(); return; }
    // 一周冷却：距上次生成不足一周，不发请求，直接提示还剩几天
    if (this.data.cooling) {
      wx.showToast({ title: '本周已生成过，下周一可再来', icon: 'none' });
      return;
    }

    const base = (this.data.p && this.data.p.updatedAt) || 0;
    this.setData({ genning: true, pending: true, genFail: false });
    this.startPolling(base);

    wx.cloud.callFunction({ name: 'analysis', data: { action: 'profile' } })
      .then(res => {
        this.setData({ genning: false });
        const r = res.result || {};
        if (r.empty) {                       // 还没有任何记录
          this.stopPolling();
          this.setData({ pending: false, ready: true, empty: true, p: null });
          wx.showToast({ title: '先去记几条再来生成', icon: 'none' });
          return;
        }
        if (r.cooling) {                     // 云函数判定仍在冷却期（前端拦漏了 / 别人刚生成过）
          this.stopPolling();
          this.setData({ pending: false });
          this.applyCooldown(r.updatedAt);
          wx.showToast({ title: '本周已生成过，下周一可再来', icon: 'none' });
          return;
        }
        if (r.error) {                       // 明确报错（如额度用完）
          this.stopPolling();
          this.setData({ pending: false, genFail: true });
          return;
        }
        this.stopPolling();
        this.setData({
          pending: false, ready: true, empty: false, p: mapProfile(r)
        });
        this.applyCooldown(r.updatedAt);
        wx.showToast({ title: '画像已生成', icon: 'success' });
      })
      .catch(() => {
        // 请求异常（含控制台偶发的 ret=-3）：不清 pending，让轮询继续兜底
        this.setData({ genning: false });
      });
  },

  // 后台轮询：结果出来就渲染 + 提醒；超时不报错，只提示稍后再来
  startPolling(base) {
    this.stopPolling();
    const from = (base === undefined) ? ((this.data.p && this.data.p.updatedAt) || 0) : base;
    let n = 0;
    const tick = () => {
      if (this._gone) return;
      n++;
      if (n > POLL_MAX) {
        this.stopPolling();
        this.setData({ genning: false });
        wx.showToast({ title: '还在生成，稍后再来看看', icon: 'none' });
        return;
      }
      this._pollTimer = setTimeout(tick, POLL_MS);
      wx.cloud.callFunction({ name: 'analysis', data: { action: 'profileGet' } })
        .then(res => {
          if (this._gone) return;
          const p = res.result && res.result.profile;
          if (p && (!from || (p.updatedAt || 0) > from)) {
            this.stopPolling();
            this.setData({
              genning: false, pending: false, ready: true, empty: false, genFail: false,
              p: mapProfile(p)
            });
            this.applyCooldown(p.updatedAt);
            wx.showToast({ title: '画像已生成', icon: 'success' });
          }
        })
        .catch(() => { /* 单次查询失败忽略，下一轮再试 */ });
    };
    this._pollTimer = setTimeout(tick, POLL_MS);
  },

  stopPolling() {
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
  },

  // 「生成个人画像」/「重新生成」按钮（一周只能点一次；读取画像走下拉刷新）
  onGenerate() { this.generate(); },

  // 子页：从回看页 navigateTo 进来，点返回回退
  onClose() { wx.navigateBack(); }
}));
