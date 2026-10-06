// pages/persona/persona.js —— 个人画像（③ 增量沉淀）
//
// **和「人物深度报告」（pages/profile）是两个不同的功能**，不是同一个东西的两个版本：
//
//   persona（本页）：只沉淀**跨周期稳定**的特质——精力模式、价值取向、思维卡点、
//                    取舍模式、身心反应。每次把**上一版画像当素材喂进去**，
//                    做「新增 / 修正 / 淘汰」而不是全盘重写。所以它越跑越准、可以随时跑，
//                    并且**按版本留档**，你能看到画像怎么一点点长出来。
//
//   profile（另一页）：定期**全量重算**的综合诊断，含未来推演与行动方案。贵，所以每周限一次。
//
// 为什么要分开：两者的运行节奏、对结果的期待都不同。画像是「长期沉淀」，每个月看它
// 变没变、变了什么；深度报告是「定期体检」，季度看一次全貌。把两者揉在一起的话，
// 低频的深度诊断会不断冲掉高频积累的稳定特质——这正是原「个人画像」页的实际问题：
// 它名字叫画像，实际跑的是深度报告。
//
// 交互约定：
// 1) 下拉刷新 = 只**读取**已有画像（personaGet，秒回、不花模型额度），不会重新生成。
// 2) 「更新画像」= 拿**真实记录**调模型做一次增量，每点一次长一版（v1 → v2 → …）。
//    **不设每周冷却**：它是增量的、成本低，合集明确建议周跑轻量版 / 月年跑完整版，
//    硬锁只会挡住正常节奏。但会给「这是第几版、上次改了什么」的提示。
// 3) 生成是后台任务：点击后立即提交，页面进入 pending 态，可随时离开，回来自动看到结果。
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');

const POLL_MS = 5000;
const POLL_MAX = 24;       // 最多轮询 24 次（约 2 分钟）

function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 把任意值压成一行可读文字。与云函数 flatText 同思路：模型偶尔会把本该是字符串的字段
// 返回成对象，直接 String(obj) 会变成 "[object Object]" 显示在页面上。这里兜一层。
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

// 规整成字符串数组：摊平对象、剔除空项和 "[object Object]" 这类垃圾值
function listOf(v, cap) {
  const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
  return arr.map(x => flatText(x)).filter(s => s && s !== '[object Object]')
    .slice(0, cap || 8);
}

// 云函数返回的嵌套对象 → 页面用的扁平结构（补齐空数组/空串，wxml 可直接 .length）
function mapPersona(p) {
  const o = (v, keys) => {
    const src = (v && typeof v === 'object') ? v : {};
    const out = {};
    keys.forEach(k => { out[k] = listOf(src[k]); });
    return out;
  };
  const s = (v) => {
    const t = flatText(v);
    return (t === '[object Object]' || t === '[object object]') ? '' : t;
  };
  const e = p.energy || {}, val = p.value || {}, t = p.thinking || {};
  const tr = p.tradeoff || {}, h = p.health || {}, cl = p.changelog || {};
  const b = p.basedOn || {};
  const changed = listOf(cl.changed).length;
  const added = listOf(cl.added).length;
  const dropped = listOf(cl.dropped).length;
  return {
    _id: p._id,
    rev: p.rev || 1,
    revLabel: 'v' + (p.rev || 1),
    energy: {
      drain: listOf(e.drain), charge: listOf(e.charge), rhythm: s(e.rhythm)
    },
    value: {
      like: listOf(val.like), dislike: listOf(val.dislike), core: listOf(val.core)
    },
    thinking: { patterns: listOf(t.patterns), stuck: listOf(t.stuck) },
    tradeoff: { choose: listOf(tr.choose), giveup: listOf(tr.giveup) },
    health: { moodRule: s(h.moodRule), bodyLink: listOf(h.bodyLink) },
    changelog: {
      added: listOf(cl.added), changed: listOf(cl.changed), dropped: listOf(cl.dropped),
      any: added + changed + dropped > 0
    },
    // 「本次没变化」是一条**有效信息**——说明这段时间的记录没有推翻任何既有结论。
    // 所以别把空变更当成失败，它其实是在告诉你画像很稳。
    noChange: added + changed + dropped === 0,
    basedOn: { records: b.records || 0, reviews: b.reviews || 0, fromRev: b.fromRev || 0 },
    createdLabel: fmtTs(p.createdAt),
    lite: !!p.lite
  };
}

Page(pageBase({
  data: {
    ready: false,
    loading: false,
    genning: false,
    pending: false,
    genFail: false,
    p: null,               // 当前画像
    versions: [],          // 历史版本摘要（不含正文）
    empty: false,
    showVerList: false,    // 历史版本列表展开
    showChangelog: true    // 变更日志默认展开——它是这一页最有价值的部分
  },

  onShow() {
    this.ensureTheme();
    this.load();
    if (this.data.pending) this.startPolling();
  },

  onHide() { this.stopPolling(); },
  onUnload() { this.stopPolling(); this._gone = true; },

  // 读取（秒回、不花额度）。把「没有画像」和「读失败」严格区分开——
  // 后者要显示真实原因，不能长得跟「还没生成过」一模一样。
  load() {
    this.setData({ loading: true });
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'personaGet' } })
      .then(res => {
        const r = res.result || {};
        if (this._gone) return;
        if (r.error) {
          this.setData({ ready: true, loading: false, genFail: true, empty: false, p: null });
          return;
        }
        const cur = r.persona || null;
        this.setData({
          ready: true, loading: false, genFail: false,
          empty: !cur,
          p: cur ? mapPersona(cur) : null,
          versions: (r.versions || []).map(v => Object.assign({}, v, { time: fmtTs(v.createdAt) }))
        });
      })
      .catch(() => {
        if (this._gone) return;
        this.setData({ ready: true, loading: false, genFail: true, empty: false, p: null });
      });
  },

  // 更新画像（增量一版）。lite=true 走轻量版——合集建议：周用轻量、月年用完整版。
  generate(lite) {
    if (this.data.genning) return;
    const has = !!this.data.p;
    wx.showModal({
      title: has ? '更新画像' : '建立画像',
      content: has
        ? '会在现有画像（' + this.data.p.revLabel + '）基础上做一次增量：保留仍然成立的、补上新的、修正被推翻的、淘汰不再适用的。'
        : '第一次建立画像，用你已有的记录跑一版。',
      confirmText: has ? '更新' : '建立', confirmColor: '#B4544E',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ genning: true, pending: true, genFail: false });
        wx.cloud.callFunction({ name: 'analysis', data: { action: 'persona', lite: !!lite } })
          .then(r2 => {
            const rr = r2.result || {};
            if (this._gone) return;
            if (rr.error) {
              this.setData({ genning: false, pending: false, genFail: true });
              wx.showToast({ title: rr.error, icon: 'none', duration: 2500 });
              return;
            }
            this.setData({ genning: false });
            if (rr.empty) {
              this.setData({ pending: false });
              wx.showToast({ title: rr.summary || '还没有记录', icon: 'none' });
              return;
            }
            this.startPolling();
          })
          .catch(() => {
            if (this._gone) return;
            this.setData({ genning: false, pending: false, genFail: true });
            wx.showToast({ title: '提交失败（网络或云函数报错）', icon: 'none' });
          });
      }
    });
  },

  // 后台轮询：画像是增量的、通常十几秒内就好，但不想让人对着转圈干等。
  startPolling() {
    this.stopPolling();
    let n = 0;
    const tick = () => {
      if (this._gone) { clearTimeout(this._timer); return; }
      n++;
      wx.cloud.callFunction({ name: 'analysis', data: { action: 'personaGet' } })
        .then(res => {
          if (this._gone) return;
          const r = res.result || {};
          const cur = r.persona || null;
          const before = this.data.p ? this.data.p.rev : 0;
          if (cur && cur.rev > before) {
            this.stopPolling();
            this.setData({
              pending: false,
              p: mapPersona(cur),
              empty: false,
              versions: (r.versions || []).map(v => Object.assign({}, v, { time: fmtTs(v.createdAt) }))
            });
            wx.showToast({ title: '画像已更新到 ' + cur.rev, icon: 'none' });
            return;
          }
          if (n >= POLL_MAX) { this.stopPolling(); this.setData({ pending: false }); return; }
          this._timer = setTimeout(tick, POLL_MS);
        })
        .catch(() => {
          if (this._gone) return;
          if (n >= POLL_MAX) { this.stopPolling(); this.setData({ pending: false }); return; }
          this._timer = setTimeout(tick, POLL_MS);
        });
    };
    this._timer = setTimeout(tick, POLL_MS);
  },
  stopPolling() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } },

  // 看某个历史版本的完整画像（用来对比「上一版长什么样」）。
  // 历史摘要列表里没有正文——正文要单条取，否则十几版会撑爆响应。
  openVer(e) {
    const i = e.currentTarget.dataset.i;
    const v = this.data.versions[i];
    if (!v) return;
    wx.showLoading({ title: '读取', mask: true });
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'personaVer', rev: v.rev } })
      .then(res => {
        wx.hideLoading();
        const r = res.result || {};
        if (r.error || !r.persona) { wx.showToast({ title: r.error || '读不到这一版', icon: 'none' }); return; }
        const m = mapPersona(r.persona);
        wx.showModal({
          title: 'v' + m.rev + ' · ' + v.time,
          content: '精力·耗电：' + (m.energy.drain.join('；') || '（无）')
            + '\n精力·充电：' + (m.energy.charge.join('；') || '（无）')
            + '\n惯性卡点：' + (m.thinking.stuck.join('；') || '（无）')
            + '\n放弃模式：' + (m.tradeoff.giveup.join('；') || '（无）')
            + '\n\n（只列了关键几项，完整内容建议直接看当前版本）',
          showCancel: false, confirmText: '知道了'
        });
      })
      .catch(() => { wx.hideLoading(); wx.showToast({ title: '读取失败', icon: 'none' }); });
  },

  onVerListTap() { this.setData({ showVerList: !this.data.showVerList }); },
  onChangelogTap() { this.setData({ showChangelog: !this.data.showChangelog }); },

  onClose() { wx.navigateBack(); }
}));