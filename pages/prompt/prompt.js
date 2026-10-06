// pages/prompt/prompt.js —— 提示词试跑
// 调提示词的工具页：改一段提示词 → 点「跑一次」→ 直接在本页看结果。
//
// 为什么需要它：原来的循环是「改云函数代码 → 上传部署 → 生成 → 翻回看页看」，
// 一轮几分钟，一天试不了两次。现在云函数 action:'promptTest' 接受一段提示词片段，
// 用**真实记录**跑一次模型（和线上生成同一套拼装）并返回结果，所以看到的就是真实效果。
//
// 三条硬约定：
// 1) **不影响线上**：试跑结果只写promptlog 集合，正式的 analysis / profile 一个字都不动。
// 2) **结果留档**：每次试跑连同当时的提示词原文一起存下来，所以能对比「哪一版更好」，
//    不需要另外记笔记。历史列表就是干这个的。
// 3) **模型返回原样渲染**：这里不做「摊平 / 兜底」那类美化——调提示词时你需要看到
//    模型**到底吐了什么形状**（比如它擅自把字符串字段返回成对象），美化掉就看不出问题。
//    正因为不美化，渲染用的是递归通用展开而不是画像那套固定结构。
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');

const TYPES = [
  { k: 'profile', n: '画像' },
  { k: 'day', n: '日' },
  { k: 'week', n: '周' },
  { k: 'month', n: '月' },
  { k: 'year', n: '年' }
];

function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/* 把模型返回的 JSON 递归展开成「路径 + 值」的扁平列表 —— 试跑页专用。
   为什么不用画像页那套固定字段映射：这里的结构由提示词决定，可能是任何形状，
   而且调提示词时恰恰要看清「它把哪个字段返回成了什么形状」。所以：
     · 数组 → 逐条展开，前面加 [i]；
     · 对象 → 递归进去，前面加 字段名；
     · 空值/空数组 → 明确显示成「（空）」，不然会误以为没返回这个字段。
   深度上限 5 层：再深基本是模型抽风了，截断显示，免得刷屏。 */
function flatNodes(v, path, depth, out) {
  const o = out || [];
  const d = depth || 0;
  if (d > 5) { o.push({ path: path, text: '…（层级过深，已截断）' }); return o; }
  if (v === null || v === undefined) { o.push({ path: path, text: '（空）' }); return o; }
  if (Array.isArray(v)) {
    if (!v.length) { o.push({ path: path, text: '（空数组）' }); return o; }
    v.forEach((x, i) => flatNodes(x, path + ' [' + (i + 1) + ']', d + 1, o));
    return o;
  }
  if (typeof v === 'object') {
    const ks = Object.keys(v);
    if (!ks.length) { o.push({ path: path, text: '（空对象）' }); return o; }
    ks.forEach(k => flatNodes(v[k], path ? path + '.' + k : k, d + 1, o));
    return o;
  }
  let s = String(v);
  if (s === '[object Object]') s = '⚠️ 模型返回了对象而不是字符串';
  o.push({ path: path || '（根）', text: s });
  return o;
}

Page(pageBase({
  data: {
    types: TYPES,
    type: 'profile',
    rules: '',            // 要追加/替换的提示词片段
    label: '',            // 备注（跟结果一起存下来）
    override: false,      // true = 规则段整个换掉，从头试一版
    running: false,       // 请求在途中（拦重复点击）
    lastResult: null,     // 本次跑出来的 { nodes, meta }
    errText: '',
    list: [],             // 历史试跑（摘要）
    detail: null,         // 展开看的那一条（含完整结果）
    detailIdx: -1
  },

  onShow() {
    this.ensureTheme();
    this.loadList();
  },

  onTypeTap(e) {
    this.setData({ type: e.currentTarget.dataset.k, lastResult: null, errText: '' });
  },
  onRulesInput(e) { this.setData({ rules: e.detail.value }); },
  onLabelInput(e) { this.setData({ label: e.detail.value }); },
  // 整段替换 vs 追加：这两个的差别很大，切换时把提示语换掉，别让人以为只是开关
  onOverrideTap() {
    const v = !this.data.override;
    this.setData({ override: v });
    wx.showToast({
      title: v ? '规则段将被整个替换' : '追加到线上规则后面',
      icon: 'none', duration: 1400
    });
  },

  // 跑一次
  run() {
    if (this.data.running) return;
    const rules = (this.data.rules || '').trim();
    if (!rules && !this.data.override) {
      // 空着就跑 = 基线对照（用线上那版），是合法用法，但要让人知道自己在干什么
      wx.showToast({ title: '没填提示词就是跑线上那版', icon: 'none' });
    }
    this.setData({ running: true, errText: '', lastResult: null, detail: null, detailIdx: -1 });
    wx.showLoading({ title: '跑一次', mask: true });

    const data = { action: 'promptTest', type: this.data.type, rules: rules };
    if (this.data.label.trim()) data.label = this.data.label.trim();
    if (this.data.override) data.overrideRules = true;

    wx.cloud.callFunction({ name: 'analysis', data })
      .then(res => {
        wx.hideLoading();
        this.setData({ running: false });
        const r = res.result || {};
        if (r.error) { this.setData({ errText: r.error }); return; }
        this.setData({
          lastResult: {
            nodes: flatNodes(r.result, '', 0, []),
            meta: this._metaOf(r)
          }
        });
        this.loadList();
        wx.showToast({ title: r.saved ? '跑完了，已存进历史' : '跑完了（没存下来）', icon: 'none' });
      })
      .catch(() => {
        wx.hideLoading();
        this.setData({ running: false, errText: '调用失败（网络或云函数报错），过一会儿再试' });
      });
  },

  _metaOf(r) {
    return [
      { k: '类型', v: (TYPES.filter(t => t.k === r.type)[0] || {}).n || r.type || '' },
      { k: '记录', v: (r.records || 0) + ' 条' + (r.range ? '（' + r.range + '）' : '') },
      { k: '耗时', v: (r.ms || 0) + ' ms' },
      { k: '模型', v: r.model || '' },
      { k: '温度', v: String(r.temperature === undefined ? '' : r.temperature) },
      { k: '喂给模型', v: (r.userChars || 0) + ' 字资料 + ' + (r.systemChars || 0) + ' 字提示词' },
      { k: '用了哪版', v: r.overrideRules ? ('替换版：' + (r.rulesUsed || '')) : (r.rulesUsed ? ('线上版 + 追加：' + r.rulesUsed) : '线上原版（基线）') }
    ];
  },

  // 历史列表（摘要，不含结果正文）
  loadList() {
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'ptestList' } })
      .then(res => {
        this.setData({ list: (res.result && res.result.list) || [] });
      })
      .catch(() => { /* 集合还没建 / 网络问题：历史留空，不阻断试跑 */ });
  },

  onItemTap(e) {
    const i = e.currentTarget.dataset.i;
    if (this.data.detailIdx === i) { this.setData({ detail: null, detailIdx: -1 }); return; }
    const id = this.data.list[i]._id;
    wx.showLoading({ title: '读取', mask: true });
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'ptestGet', id } })
      .then(res => {
        wx.hideLoading();
        const d = (res.result && res.result.doc) || null;
        if (!d) { wx.showToast({ title: '这条读不到了', icon: 'none' }); return; }
        this.setData({
          detailIdx: i,
          detail: {
            nodes: flatNodes(d.result, '', 0, []),
            meta: this._metaOf(d),
            label: d.label || ''
          }
        });
        wx.pageScrollTo({ scrollTop: 0, duration: 0 });
      })
      .catch(() => { wx.hideLoading(); wx.showToast({ title: '读取失败', icon: 'none' }); });
  },

  // 删一条试跑记录（只影响 promptlog，不影响任何正式内容）
  onDel(e) {
    const i = e.currentTarget.dataset.i;
    const it = this.data.list[i];
    if (!it) return;
    wx.showModal({
      title: '删掉这次试跑',
      content: (it.label ? '「' + it.label + '」' : fmtTs(it.createdAt)) + '——只删试跑记录，正式的回看与画像不受影响。',
      confirmText: '删掉', confirmColor: '#B4544E',
      success: (res) => {
        if (!res.confirm) return;
        wx.cloud.callFunction({ name: 'analysis', data: { action: 'ptestDel', id: it._id } })
          .then(() => { this.loadList(); wx.showToast({ title: '已删', icon: 'none' }); })
          .catch(() => wx.showToast({ title: '删除失败', icon: 'none' }));
      }
    });
  },

  // 复制结果：调提示词时经常要贴去别处对比
  copyResult() {
    const src = this.data.detailIdx >= 0 ? this.data.detail : this.data.lastResult;
    if (!src || !src.nodes.length) return;
    const txt = src.nodes.map(n => (n.path ? n.path + '：' : '') + n.text).join('\n');
    wx.setClipboardData({ data: txt, success: () => wx.showToast({ title: '已复制', icon: 'none' }) });
  },

  onClearInput() { this.setData({ rules: '', label: '' }); },

  onClose() { wx.navigateBack(); }
}));