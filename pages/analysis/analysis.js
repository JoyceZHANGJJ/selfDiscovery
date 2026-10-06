// pages/analysis/analysis.js —— AI 回看（每天一份的温柔回顾，按日期倒序列出）
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');

const WEEK = '日一二三四五六';
function weekday(ds) {
  const p = (ds || '').split('-');
  if (p.length < 3) return '';
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return '周' + WEEK[d.getDay()];
}

Page(pageBase({
  data: {
    list: [],
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

  load(done) {
    if (this._loading) { done && done(); return; }
    this._loading = true;
    this.setData({ loading: true, loadFail: false });
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'list' } })
      .then(res => {
        const raw = (res.result && res.result.list) || [];
        const list = raw.map(a => ({
          _id: a._id,
          date: a.date,
          dateLabel: (a.date || '').slice(5).replace('-', '月') + '日',
          weekday: weekday(a.date),
          summary: a.summary || '',
          mood: a.mood || '',
          themes: a.themes || [],
          suggestion: a.suggestion || '',
          highlight: a.highlight || '',
          detail: a.detail || ''
        }));
        this.setData({ list, ready: true, loading: false });
        this._loading = false;
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
