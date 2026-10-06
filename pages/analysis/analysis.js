// pages/analysis/analysis.js —— AI 回看（日 / 周 / 月 / 年，按起始日期倒序列出）
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');

const WEEK = '日一二三四五六';
function weekday(ds) {
  const p = (ds || '').split('-');
  if (p.length < 3) return '';
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return '周' + WEEK[d.getDay()];
}
// 卡片标题按类型显示：日「10月05日」周「09月28日–10月04日」月「2026年09月」年「2025年」
function dateLabel(a) {
  const s = a.start || a.date || '';
  const type = a.type || 'day';
  if (type === 'year') return s.slice(0, 4) + '年';
  if (type === 'month') return s.slice(0, 4) + '年' + Number(s.slice(5, 7)) + '月';
  const md = Number(s.slice(5, 7)) + '月' + Number(s.slice(8, 10)) + '日';
  if (type === 'week') {
    const e = a.end || '';
    const emd = e ? Number(e.slice(5, 7)) + '月' + Number(e.slice(8, 10)) + '日' : '';
    return emd ? md + ' – ' + emd : md;
  }
  return md;
}
const TYPES = ['day', 'week', 'month', 'year'];

// 把任意值压成一行可读文字（与云函数 flatText 同思路）。
// 模型偶尔不听话，把数组元素返回成对象，直接 String 渲染就是 [object Object]，
// 这里递归摊平（对象 → "键：值；键：值"，数组 → "；"连接），前端兜一层。
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

Page(pageBase({
  data: {
    list: [],          // 当前 tab 下的回看
    all: [],           // 云端全量（四个类型混在一起，前端按 tab 过滤）
    tab: 'day',
    ready: false,
    loading: false,
    loadFail: false,
    openIdx: -1
  },

  onShow() {
    this.ensureTheme();
    this.layoutBrand();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3, theme: store.curTheme() });
    }
    this.load();
  },

  onPullDownRefresh() {
    this.load(() => { if (wx.stopPullDownRefresh) wx.stopPullDownRefresh(); });
  },

  onTab(e) {
    const t = e.currentTarget.dataset.t;
    if (t === this.data.tab) return;
    this.setData({ tab: t, openIdx: -1 });
    this.applyTab();
  },

  applyTab() {
    const t = this.data.tab;
    const list = this.data.all.filter(a => (a.type || 'day') === t).map(a => Object.assign({}, a, {
      dateLabel: dateLabel(a),
      weekday: (a.type || 'day') === 'day' ? weekday(a.start || a.date) : ''
    }));
    this.setData({ list });
  },

  load(done) {
    if (this._loading) { done && done(); return; }
    this._loading = true;
    this.setData({ loading: true, loadFail: false });
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'list' } })
      .then(res => {
        const raw = (res.result && res.result.list) || [];
        const all = raw.map(a => {
          // 新版六板结构；旧文档（只有 themes/insight/detail）也照样能显示
          const p = (a.patterns && typeof a.patterns === 'object') ? a.patterns : {};
          // 摊平：模型偶尔把数组元素返回成对象，直接渲染会出现 [object Object]
          const arr = v => {
            const list = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
            return list.map(x => flatText(x))
              .filter(t => t && t !== '[object Object]')
              .slice(0, 8);
          };
          const txt = v => flatText(v);
          return {
            _id: a._id,
            type: a.type || 'day',       // 旧文档没有 type，视为日回看
            start: a.start || a.date || '',
            end: a.end || '',
            summary: txt(a.summary),
            // 新字段
            facts: arr(a.facts),
            drain: arr(p.drain),
            charge: arr(p.charge),
            moodRule: txt(p.moodRule),
            stuck: arr(p.stuck),
            values: arr(p.values),
            compare: txt(a.compare),
            risks: arr(a.risks),
            // 旧字段（历史文档）
            mood: txt(a.mood),
            themes: arr(a.themes),
            suggestion: txt(a.suggestion),
            highlight: txt(a.highlight),
            insight: txt(a.insight),
            actions: arr(a.actions),
            detail: txt(a.detail)
          };
        });
        this.setData({ all, ready: true, loading: false });
        this._loading = false;
        this.applyTab();
        done && done();
      })
      .catch(err => {
        console.error('[AI回看] 加载失败', err);
        this.setData({ loadFail: true, loading: false, ready: true });
        this._loading = false;
        done && done();
      });
  },

  onTap(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ openIdx: this.data.openIdx === i ? -1 : i });
  },

  // 从回看页 navigateTo 进来，点返回回到回看（子页没有底部 tab，靠这个回退）
  onClose() { wx.navigateBack(); }
}));
