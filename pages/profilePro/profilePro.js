// pages/profilePro/profilePro.js —— 深度分析·高级版
// 基于全部历史记录，由云函数 analysis 的 action:'profilePro' 生成一份「高级版深度分析」
// （结构：summary / top_conclusions / energy_system / meta_patterns / blind_spots /
//  strengths / weaknesses / relationship / next_observations / limitations / risk_alert）。
// 与「人物深度报告」(profile) 完全平行：独立提示词（report.corePro）+ 独立模型（glm-4-plus）+
// 独立集合（profilePro）+ 独立页面。每周冷却同深度报告。
//
// 交互约定与 profile 页一致：
// 1) 下拉刷新 = 只重新读取已有报告（profileProGet，秒回、不花额度）；
// 2) 重新生成 = 真调 glm-4-plus 重算，每个自然周只能点一次（双道拦截）；
// 3) 生成是后台任务：点击即提交，页面进 pending，后台轮询 profileProGet；
// 4) pending 标记落 Storage（utils/genstate.js），避免页面被销毁后重进丢失提交状态。
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');
const genstate = require('../../utils/genstate.js');

const POLL_MS = 5000;
const POLL_MAX = 24;
const GEN_KIND = 'profilePro';
const ACTION_GET = 'profileProGet';
const ACTION_GEN = 'profilePro';

function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/* 「每周从星期一开始」：按中国时区算某个时刻落在哪个自然周（周一 00:00 起）。
   必须和云函数 cnWeekStart 完全一致，否则按钮显示的天数和云端判定会错位。 */
const CN = 8 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
function cnWeekStart(ts) {
  const d = new Date(ts + CN);
  const dow = d.getUTCDay();
  const backToMon = (dow + 6) % 7;
  const mid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0) - CN;
  return mid - backToMon * DAY;
}

// 把任意值压成一行可读文字。与云函数 flatText 同思路：兜掉老文档可能的 [object Object]。
function flatText(v, depth) {
  const d = depth || 0;
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (d > 3) return '';
  if (Array.isArray(v)) return v.map(x => flatText(x, d + 1)).filter(Boolean).join('；');
  if (typeof v === 'object') {
    const parts = [];
    Object.keys(v).forEach(k => {
      const val = v[k];
      const t = flatText(val, d + 1);
      if (t) parts.push((val && typeof val === 'object') ? (k + '：' + t) : (k + ' ' + t));
    });
    return parts.join('；');
  }
  return '';
}
function listOf(v, cap) {
  const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
  return arr.map(x => flatText(x)).filter(s => s && s !== '[object Object]').slice(0, cap || 8);
}

// 把高级版里一条带证据的对象（meta_patterns / blind_spots / strengths / weaknesses）规整成展示结构。
// 云端已用 safeItems 清洗成 {title, note, type, check, evidence:[{date,quote}]}；这里再兜一层
// （模型偶尔把 evidence 写成字符串、或漏字段），保证页面永远能渲染。
function proItemView(it) {
  if (!it) return null;
  if (typeof it === 'string') return { title: flatText(it), note: '', type: '', check: '', evidence: [] };
  const o = (typeof it === 'object') ? it : {};
  const ev = (o.evidence != null) ? o.evidence : (o.evidences != null ? o.evidences : null);
  const evidence = Array.isArray(ev) ? ev.map(e => {
    if (typeof e === 'string') return { date: '', quote: flatText(e) };
    const eo = (e && typeof e === 'object') ? e : {};
    return { date: flatText(eo.date), quote: flatText(eo.quote || eo.text || eo.content) };
  }).filter(x => x.quote || x.date) : [];
  return {
    title: flatText(o.title || o.pattern || o.point || o.name || o.topic),
    note: flatText(o.note || o.interpretation || o.desc || o.description),
    type: flatText(o.type),
    check: flatText(o.check || o.self_check || o.selfCheck),
    evidence
  };
}
function itemsOf(v, cap) {
  if (!Array.isArray(v)) return [];
  return v.map(proItemView).filter(x => x && (x.title || x.note || x.evidence.length)).slice(0, cap || 8);
}

// 云函数返回的嵌套对象 → 页面用的扁平结构（补齐空数组/空串，wxml 可直接 .length）
function mapProfilePro(p) {
  const s = v => {
    const t = flatText(v);
    return (t === '[object Object]' || t === '[object object]') ? '' : t;
  };
  const arr = v => Array.isArray(v) ? v.map(flatText).filter(Boolean) : (v ? [s(v)] : []);
  const es = (p.energy_system && typeof p.energy_system === 'object') ? p.energy_system : {};
  const meta = itemsOf(p.meta_patterns, 8);
  const blind = itemsOf(p.blind_spots, 8);
  const strengths = itemsOf(p.strengths, 8);
  const weaknesses = itemsOf(p.weaknesses, 8);
  // 「内容损坏」= 整份报告一个可用字段都没剩下（同 profile 页逻辑，避免误报）
  const hasAny = !!s(p.summary) || arr(p.top_conclusions).length
    || arr(es.charging).length || arr(es.draining).length
    || meta.length || blind.length || strengths.length || weaknesses.length
    || !!s(p.relationship) || arr(p.next_observations).length
    || !!s(p.limitations) || !!s(p.risk_alert);
  return {
    _id: p._id,
    summary: s(p.summary).slice(0, 300),
    top: arr(p.top_conclusions).slice(0, 5),
    energy: { charging: arr(es.charging), draining: arr(es.draining) },
    meta, blind, strengths, weaknesses,
    relationship: s(p.relationship),
    next: arr(p.next_observations).slice(0, 5),
    limitations: s(p.limitations),
    risk: s(p.risk_alert),
    n: p.n || 0,
    model: p.model || '',
    updatedAt: p.updatedAt || 0,
    updatedAtLabel: fmtTs(p.updatedAt),
    broken: !hasAny
  };
}

Page(pageBase({
  data: {
    ready: false,
    loading: false,
    genning: false,
    pending: false,
    genFail: false,
    p: null,
    empty: false,
    cooling: false,
    retryDays: 0
  },

  onShow() {
    this.ensureTheme();
    this.layoutBrand();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3, theme: store.curTheme() });
    }
    const g = genstate.peek(GEN_KIND);
    if (g) this.setData({ pending: true });
    this.loadProfile();
    if (g) this.startPolling(g.from);
  },

  onHide() { this.stopPolling(); },
  onUnload() { this.stopPolling(); this._gone = true; },

  applyCooldown(updatedAt) {
    if (!updatedAt) { this.setData({ cooling: false, retryDays: 0 }); return; }
    const wk = cnWeekStart(Date.now());
    if (updatedAt >= wk) {
      this.setData({ cooling: true, retryDays: Math.max(1, Math.ceil((wk + 7 * DAY - Date.now()) / DAY)) });
    } else {
      this.setData({ cooling: false, retryDays: 0 });
    }
  },

  onPullDownRefresh() {
    this.layoutBrand();
    this.playBrand();
    this.loadProfile(() => wx.stopPullDownRefresh());
  },

  // 只读已存的高级版报告（不花大模型额度）；没有就留空态让用户点生成
  loadProfile(cb) {
    if (this._reading) { cb && cb(); return; }
    this._reading = true;
    this.setData({ loading: true });
    wx.cloud.callFunction({ name: 'analysis', data: { action: ACTION_GET } })
      .then(res => {
        this._reading = false;
        const p = res.result && res.result.profilePro;
        const g = genstate.peek(GEN_KIND);
        let done = false;
        if (g && p && (p.updatedAt || 0) > (g.from || 0)) { genstate.clear(GEN_KIND); done = true; }
        this.setData({
          loading: false, ready: true, genFail: false,
          p: p ? mapProfilePro(p) : null,
          empty: !p,
          pending: done ? false : this.data.pending
        });
        this.applyCooldown(p ? p.updatedAt : 0);
        cb && cb();
      })
      .catch(() => {
        this._reading = false;
        this.setData({ loading: false, ready: true, empty: true, genFail: false });
        cb && cb();
      });
  },

  generate() {
    if (this._gone) return;
    if (this.data.gening || this.data.pending) { this.loadProfile(); return; }
    if (this.data.cooling) {
      wx.showToast({ title: '本周已生成过，下周一可再来', icon: 'none' });
      return;
    }
    const base = (this.data.p && this.data.p.updatedAt) || 0;
    genstate.markStart(GEN_KIND, base);
    this.setData({ genning: true, pending: true, genFail: false });
    this.startPolling(base);

    wx.cloud.callFunction({ name: 'analysis', data: { action: ACTION_GEN } })
      .then(res => {
        this.setData({ genning: false });
        const r = res.result || {};
        if (r.empty) {
          this.stopPolling();
          genstate.clear(GEN_KIND);
          this.setData({ pending: false, ready: true, empty: true, p: null });
          wx.showToast({ title: '先去记几条再来生成', icon: 'none' });
          return;
        }
        if (r.cooling) {
          this.stopPolling();
          genstate.clear(GEN_KIND);
          this.setData({ pending: false });
          this.applyCooldown(r.updatedAt);
          wx.showToast({ title: '本周已生成过，下周一可再来', icon: 'none' });
          return;
        }
        if (r.error) {
          this.stopPolling();
          genstate.clear(GEN_KIND);
          this.setData({ pending: false, genFail: true });
          return;
        }
        this.stopPolling();
        genstate.clear(GEN_KIND);
        this.setData({ pending: false, ready: true, empty: false, p: mapProfilePro(r) });
        this.applyCooldown(r.updatedAt);
        wx.showToast({ title: '高级版已生成', icon: 'success' });
      })
      .catch(() => {
        this.setData({ genning: false });
      });
  },

  startPolling(base) {
    this.stopPolling();
    const from = (base === undefined) ? ((this.data.p && this.data.p.updatedAt) || 0) : base;
    let n = 0;
    const tick = () => {
      if (this._gone) return;
      n++;
      if (n > POLL_MAX) {
        this.stopPolling();
        genstate.clear(GEN_KIND);
        this.setData({ genning: false, pending: false });
        wx.showToast({ title: '还在生成，稍后再来看看', icon: 'none' });
        return;
      }
      this._pollTimer = setTimeout(tick, POLL_MS);
      wx.cloud.callFunction({ name: 'analysis', data: { action: ACTION_GET } })
        .then(res => {
          if (this._gone) return;
          const p = res.result && res.result.profilePro;
          if (p && (!from || (p.updatedAt || 0) > from)) {
            this.stopPolling();
            genstate.clear(GEN_KIND);
            this.setData({
              genning: false, pending: false, ready: true, empty: false, genFail: false,
              p: mapProfilePro(p)
            });
            this.applyCooldown(p.updatedAt);
            wx.showToast({ title: '高级版已生成', icon: 'success' });
          }
        })
        .catch(() => { /* 单次查询失败忽略，下一轮再试 */ });
    };
    this._pollTimer = setTimeout(tick, POLL_MS);
  },

  stopPolling() {
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
  },

  onGenerate() { this.generate(); },
  onClose() { wx.navigateBack(); }
}));
