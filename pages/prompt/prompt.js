// pages/prompt/prompt.js —— 提示词管理 + 试跑
// 两个 tab：
//   · 「提示词」：管理各功能的提示词正文。改完保存**立即生效**，不用再上传部署云函数。
//     这是「随时更换提示词」真正落地的地方——以前改一句话要走「改代码 → 上传部署 → 等一两分钟」。
//   · 「试跑」：用真实记录跑一次看效果，不动正式内容；满意后可「设为线上生效」。
//
// 为什么试跑和线上终于连上了：以前试跑用的文本和线上生效的文本是**两份独立的东西**，
// 跑得再好也只能看着，改不了线上。现在试跑跑完可以一键采纳（云函数 action:'promptAdopt'），
// 于是循环变成「改 → 试 → 看 → 定 → 不满意回滚」，全程不碰代码。
//
// 关于「输出字段」为什么不给改：那是与云函数解析、页面渲染一一对应的机器契约。
// 改了字段名，模型会照着返回，但云函数接不住 → 页面白屏，且极难自查是自己改的。
// 所以管理页里它只读展示（让人看懂模型被要求返回什么结构），不给编辑入口。
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');

const TYPES = [
  { k: 'profile', n: '画像' },
  { k: 'day', n: '日' },
  { k: 'week', n: '周' },
  { k: 'month', n: '月' },
  { k: 'year', n: '年' }
];

// 试跑类型 → 对应哪个提示词槽位。「设为线上生效」时要知道往哪写。
// 必须与云函数 PROMPT_BUILTIN 的槽位名一致。
const TYPE_SLOT = {
  profile: 'report.core',
  day: 'review.dayWeek',
  week: 'review.dayWeek',
  month: 'review.monthYear',
  year: 'review.monthYear'
};
// 槽位 id → 中文名。用途：试跑页显示「当前线上是哪一版」时好看一点。
// 必须覆盖 PROMPT_BUILTIN 的全部槽位（云函数会返回全部，不是只返回用得上的），
// 漏一个就会在页面上露出 'preset.xxx' 这种内部名。
const SLOT_NAME = {
  'common.review': '回看人设与共同原则',
  'review.dayWeek': '周期复盘 · 简版（日 / 周）',
  'review.monthYear': '周期复盘 · 完整版（月 / 年）',
  'report.core': '人物深度报告 · 核心规则',
  'persona.full': '个人画像 · 完整版',
  'persona.lite': '个人画像 · 轻量版',
  'preset.focusBody': '附加 · 聚焦身心',
  'preset.riskFirst': '附加 · 强化风险',
  'preset.sleepEnergy': '附加 · 睡眠-能量关联',
  'preset.keepShort': '附加 · 压缩篇幅'
};

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
    tab: 'manage',         // manage=提示词管理 / test=试跑
    types: TYPES,
    type: 'profile',
    curLive: { rev: 0, name: '', has: false },   // 当前类型对应的槽位线上版本（供 wxml 显示）
    rules: '',            // 要追加/替换的提示词片段
    label: '',            // 备注（跟结果一起存下来）
    override: false,      // true = 规则段整个换掉，从头试一版
    running: false,       // 请求在途中（拦重复点击）
    lastResult: null,     // 本次跑出来的 { nodes, meta }
    errText: '',
    list: [],             // 历史试跑（摘要）
    listErr: '',          // 历史列表读不到时的真实原因（别把失败显示成「没有记录」）
    detail: null,         // 展开看的那一条（含完整结果）
    detailIdx: -1,

    // ---- 提示词管理 ----
    groups: [],           // 分组槽位（不含正文，只含 rev / 字数 / 是否改过）
    plErr: '',            // 列表读不到的真实原因
    cur: null,            // 正在编辑的槽位 { slot,name,desc,body,builtin,rev,edited,contract,state }
    curErr: '',
    saveNote: '',         // 保存时的备注（进历史版本）
    saving: false,
    showContract: false,  // 契约层默认折叠：多数人不需要看，但要看的人一定要看得到
    vers: [],             // 该槽位的历史版本（摘要）
    verErr: '',
    verBody: '',          // 展开看的历史版本正文
    verIdx: -1,
    liveRev: {}           // 各槽位当前线上 rev，试跑时用来显示「我拿的是哪版做的基线」
  },

  onShow() {
    this.ensureTheme();
    this.loadPrompts();
    this.loadList();
  },

  onTabTap(e) {
    const v = e.currentTarget.dataset.v;
    if (v === this.data.tab) return;
    this.setData({ tab: v, errText: '', plErr: '' });
  },

  // ===== 提示词管理 =====

  // 拉槽位列表。失败时显示真实原因，不要静默显示成「还没有提示词」——
  // 那样会让人以为是自己没配过。
  loadPrompts() {
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'promptList' } })
      .then(res => {
        const r = res.result || {};
        this.setData({ groups: r.groups || [], plErr: r.error || '' });
      })
      .catch(() => { this.setData({ plErr: '调用失败（网络或云函数报错）' }); });
  },

  // 打开一个槽位。正文几百上千字，所以**只在打开单个槽位时才拉**（promptList 不带正文）。
  openSlot(e) {
    const slot = e.currentTarget.dataset.slot;
    if (!slot) return;
    this.setData({ curErr: '', cur: null, vers: [], verErr: '', verIdx: -1, verBody: '', showContract: false });
    wx.showLoading({ title: '读取', mask: true });
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'promptGet', slot } })
      .then(res => {
        wx.hideLoading();
        const r = res.result || {};
        if (r.error) { this.setData({ curErr: r.error }); return; }
        this.setData({ cur: r, saveNote: '' });
        this.loadVersions(slot);
      })
      .catch(() => { wx.hideLoading(); this.setData({ curErr: '调用失败（网络或云函数报错）' }); });
  },

  // 版本列表摘要里补上格式化的时间。**为什么要在这里算**：wxml 的表达式不支持函数
// 调用（`{{fmtTs(x)}}` 直接报错），所以凡是页面上要显示的格式化结果都得预先算好放进去。
loadVersions(slot) {
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'promptVersions', slot } })
      .then(res => {
        const r = res.result || {};
        const list = (r.list || []).map(v => Object.assign({}, v, { time: fmtTs(v.createdAt) }));
        this.setData({ vers: list, verErr: r.error || '' });
      })
      .catch(() => { this.setData({ verErr: '版本列表读不到（网络或云函数报错）' }); });
  },

  onBodyInput(e) { this.setData({ cur: Object.assign({}, this.data.cur, { body: e.detail.value }) }); },
  onNoteInput(e) { this.setData({ saveNote: e.detail.value }); },
  onContractTap() { this.setData({ showContract: !this.data.showContract }); },

  // 保存 → 立即生效。不需要上传部署云函数。
  save() {
    const cur = this.data.cur;
    if (!cur || this.data.saving) return;
    const body = (cur.body || '').trim();
    if (!body) { wx.showToast({ title: '正文不能为空', icon: 'none' }); return; }
    if (body === (cur.builtin || '').trim()) {
      // 不是错误，但用户大概率是手滑点错了——提示一句，别让他以为已经存上了
      wx.showToast({ title: '和出厂默认一样', icon: 'none' });
    }
    this.setData({ saving: true });
    wx.showLoading({ title: '保存', mask: true });
    wx.cloud.callFunction({
      name: 'analysis',
      data: { action: 'promptSave', slot: cur.slot, body: body, note: (this.data.saveNote || '').trim() }
    })
      .then(res => {
        wx.hideLoading();
        const r = res.result || {};
        if (r.error) { this.setData({ saving: false }); wx.showToast({ title: r.error, icon: 'none', duration: 2500 }); return; }
        wx.showToast({ title: '已生效 · v' + r.rev, icon: 'none' });
        // 本地同步 rev，免得管理列表还显示旧版本号
        this.setData({ saving: false });
        this.refreshCurMeta();
        this.loadPrompts();
        this.loadVersions(cur.slot);
      })
      .catch(() => {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: '保存失败（网络或云函数报错）', icon: 'none' });
      });
  },

  // 保存后重新拉一次这个槽位，让 rev / edited 与库里一致（而不是前端自己猜）
  refreshCurMeta() {
    const slot = this.data.cur && this.data.cur.slot;
    if (!slot) return;
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'promptGet', slot } })
      .then(res => {
        const r = res.result || {};
        if (!r.error) this.setData({ cur: r });
      })
      .catch(() => { /* 元信息刷新失败不影响已保存的事实，不打扰用户 */ });
  },

  resetDefault() {
    const cur = this.data.cur;
    if (!cur) return;
    wx.showModal({
      title: '恢复出厂默认',
      content: '会把正文换回内置的那一版（rev ' + (cur.rev || 1) + ' 的内容会留成历史，随时能切回来）。',
      confirmText: '恢复', confirmColor: '#B4544E',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '恢复', mask: true });
        wx.cloud.callFunction({ name: 'analysis', data: { action: 'promptReset', slot: cur.slot } })
          .then(r2 => {
            wx.hideLoading();
            const rr = r2.result || {};
            if (rr.error) { wx.showToast({ title: rr.error, icon: 'none' }); return; }
            wx.showToast({ title: '已恢复 · v' + rr.rev, icon: 'none' });
            this.refreshCurMeta();
            this.loadPrompts();
            this.loadVersions(cur.slot);
          })
          .catch(() => { wx.hideLoading(); wx.showToast({ title: '操作失败', icon: 'none' }); });
      }
    });
  },

  // 展开某个历史版本看正文。摘要列表里没有正文（几十个版本全量回传会撑爆响应）。
  openVer(e) {
    const i = e.currentTarget.dataset.i;
    const v = this.data.vers[i];
    if (!v) return;
    if (this.data.verIdx === i) { this.setData({ verIdx: -1, verBody: '' }); return; }
    wx.showLoading({ title: '读取', mask: true });
    wx.cloud.callFunction({
      name: 'analysis', data: { action: 'promptVersionGet', slot: this.data.cur.slot, rev: v.rev }
    })
      .then(res => {
        wx.hideLoading();
        const r = res.result || {};
        if (r.error) { wx.showToast({ title: r.error, icon: 'none' }); return; }
        this.setData({ verIdx: i, verBody: r.body || '' });
      })
      .catch(() => { wx.hideLoading(); wx.showToast({ title: '读取失败', icon: 'none' }); });
  },

  // 切回某个历史版本。走云端的一次正常保存，所以会留新快照、rev 继续往上走。
  revertVer(e) {
    const i = e.currentTarget.dataset.i;
    const v = this.data.vers[i];
    if (!v || !this.data.cur) return;
    wx.showModal({
      title: '切回 v' + v.rev,
      content: '当前正在用的 v' + this.data.cur.rev + ' 会留成历史，随时能再切回来。',
      confirmText: '切回', confirmColor: '#B4544E',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '切回', mask: true });
        wx.cloud.callFunction({
          name: 'analysis', data: { action: 'promptRevert', slot: this.data.cur.slot, rev: v.rev }
        })
          .then(r2 => {
            wx.hideLoading();
            const rr = r2.result || {};
            if (rr.error) { wx.showToast({ title: rr.error, icon: 'none' }); return; }
            wx.showToast({ title: '已切回 · 新版本 v' + rr.rev, icon: 'none', duration: 2200 });
            this.setData({ verIdx: -1, verBody: '' });
            this.refreshCurMeta();
            this.loadPrompts();
            this.loadVersions(this.data.cur.slot);
          })
          .catch(() => { wx.hideLoading(); wx.showToast({ title: '操作失败', icon: 'none' }); });
      }
    });
  },

  closeSlot() { this.setData({ cur: null, curErr: '', vers: [], verErr: '', verIdx: -1, verBody: '' }); },

  // 当前选中的类型对应哪个槽位、那个槽位线上是第几版。
  // **必须预先算好再给 wxml 用**：wxml 的表达式既不支持函数调用，也不支持用变量做
  // 下标 key（`obj[varName]` 不生效），所以这类映射只能在 JS 里算好塞进 data。
  curLiveFor(type) {
    const slot = TYPE_SLOT[type] || '';
    const rev = (this.data.liveRev || {})[slot] || 0;
    return { rev: rev, name: SLOT_NAME[slot] || slot, has: !!rev };
  },

  onTypeTap(e) {
    this.setData({
      type: e.currentTarget.dataset.k,
      lastResult: null, errText: '',
      curLive: this.curLiveFor(e.currentTarget.dataset.k)
    });
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

  // ===== 试跑 =====

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
            _id: r._id,
            type: r.type || '',
            nodes: flatNodes(r.result, '', 0, []),
            meta: this._metaOf(r),
            ver: this._whichVer(r),
            live: this._liveVer(r),
            canAdopt: !!(r.rules || '').trim()
          },
          errText: r.saved ? '' : ('这条没存进历史（原因：' + (r.saveError || '未知') + '）——下面的结果照样能看，只是关掉就没了')
        });
        this.loadList();
        wx.showToast({ title: r.saved ? '跑完了，已存进历史' : '跑完了（没存进历史）', icon: 'none' });
      })
      .catch(() => {
        wx.hideLoading();
        this.setData({ running: false, errText: '调用失败（网络或云函数报错），过一会儿再试' });
      });
  },

  // 「用了哪版」不放在普通元信息里——那一格会把整段提示词铺开，
  // 视觉上分不清是「系统自带的规则」还是「你追加的那句」，越看越糊。
  // 拆成两个字段：ver（短标签，一眼看清用的哪版）+ rulesUsed（原文，可复制）。
  _whichVer(r) {
    const used = (r.rulesUsed !== undefined && r.rulesUsed !== null) ? r.rulesUsed : (r.rules || '');
    if (r.overrideRules) return { ver: '整段替换版', note: '线上那套规则已全部丢弃，只用下面这段', used: used };
    return used ? { ver: '线上版 + 追加', note: '保留了线上那套规则，把下面这段接在最后', used: used }
               : { ver: '线上原版（基线）', note: '没加任何提示词，跑的就是线上正在用的那一版', used: '' };
  },

  _metaOf(r) {
    const out = [
      { k: '类型', v: (TYPES.filter(t => t.k === r.type)[0] || {}).n || r.type || '' },
      { k: '记录', v: (r.records || 0) + ' 条' + (r.range ? '（' + r.range + '）' : '') },
      { k: '耗时', v: (r.ms || 0) + ' ms' },
      { k: '模型', v: r.model || '' },
      { k: '温度', v: String(r.temperature === undefined ? '' : r.temperature) },
      { k: '喂给模型', v: (r.userChars || 0) + ' 字资料 + ' + (r.systemChars || 0) + ' 字提示词' }
    ];
    // ver 单独挂到外层，wxml 里用它做醒目的标签；不放进 meta 表格
    return out;
  },

  // 该类型对应的槽位 + 它当前线上是第几版（试跑时显示，好确认基线是哪一版）
  _liveVer(r) {
    const slot = TYPE_SLOT[r.type] || '';
    const rev = (this.data.liveRev || {})[slot] || 0;
    return { slot: slot, rev: rev, name: SLOT_NAME[slot] || slot };
  },

  // **把这次试跑的正文设为线上生效** —— 「试跑 → 线上」闭环的最后一环。
  // 采纳的是 promptlog 里那次试跑存的正文，所以不用重新输入一遍；
  // 采纳后之后所有回看/画像的生成都会用它，旧版自动留成历史可回滚。
  adoptTest(promptId, type) {
    if (!promptId) return;
    const slot = TYPE_SLOT[type] || '';
    const slotName = SLOT_NAME[slot] || slot;
    wx.showModal({
      title: '设为线上生效',
      content: '之后生成' + ((TYPES.filter(t => t.k === type)[0] || {}).n || '') + '会用这一版，旧版留成历史可随时切回。',
      confirmText: '设为生效', confirmColor: '#B4544E',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '生效中', mask: true });
        wx.cloud.callFunction({ name: 'analysis', data: { action: 'promptAdopt', id: promptId } })
          .then(r2 => {
            wx.hideLoading();
            const rr = r2.result || {};
            if (rr.error) { wx.showToast({ title: rr.error, icon: 'none', duration: 2500 }); return; }
            wx.showModal({
              title: '已生效',
              content: '「' + (rr.slotName || slotName) + '」已更新到 v' + rr.rev + '。下次生成就会用新的一版。',
              showCancel: false, confirmText: '知道了'
            });
            this.refreshCurMeta();
            this.loadPrompts();
            // 让「当前线上 v?」立刻跟上，否则用户会以为没生效
            const lv = Object.assign({}, this.data.liveRev);
            lv[rr.slot || slot] = rr.rev;
            this.setData({ liveRev: lv, curLive: this.curLiveFor(this.data.type) });
          })
          .catch(() => { wx.hideLoading(); wx.showToast({ title: '操作失败（网络或云函数报错）', icon: 'none' }); });
      }
    });
  },

  // 历史列表（摘要，不含结果正文）
  loadList() {
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'ptestList' } })
      .then(res => {
        const r = res.result || {};
        this.setData({ list: (r.list || []), listErr: r.error || '' });
        // 顺手把各槽位当前线上 rev 拉下来：试跑时要知道「基线是哪一版」
        this.loadLiveRevs();
      })
      .catch(() => { this.setData({ listErr: '调用失败（网络或云函数报错）' }); });
  },

  // 各槽位当前生效的 rev。用来在试跑页显示「当前线上 vN」——
  // 没有它就没法确认「我这次拿的是线上那版做的基线，还是已经改过的」。
  loadLiveRevs() {
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'promptList' } })
      .then(res => {
        const groups = (res.result && res.result.groups) || [];
        const live = {};
        groups.forEach(g => (g.slots || []).forEach(s => { live[s.slot] = s.rev; }));
        // curLive 依赖 liveRev，所以拿到之后要重算一次，否则切类型时显示的还是旧值
        this.setData({ liveRev: live, curLive: this.curLiveFor(this.data.type) });
      })
      .catch(() => { /* 拿不到不影响试跑，只是少了「线上 vN」这行提示 */ });
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
            _id: d._id,
            type: d.type || '',
            nodes: flatNodes(d.result, '', 0, []),
            meta: this._metaOf(d),
            ver: this._whichVer(d),
            live: this._liveVer(d),
            canAdopt: !!(d.rules || '').trim(),
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