// pages/profile/profile.js —— 个人画像
// 基于全部历史记录，由云函数 analysis 的 action:'profile' 生成一份稳定的「你是谁」画像：
// 擅长、感兴趣、不太感兴趣、适合的方向、可以尝试、更深的模式。每 openid 一份最新，
// 进页面先 profileGet（快、不花额度），点刷新 / 下拉重新生成。
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');

function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

Page(pageBase({
  data: {
    ready: false,          // 首屏是否已拉到（含「没有画像」的明确结论）
    loading: false,        // 生成 / 重新生成中
    genFail: false,        // 生成（网络 / 服务端）失败
    p: null,               // 画像对象
    empty: false           // 还没生成过（图谱为空）
  },

  onShow() {
    this.ensureTheme();
    this.layoutBrand();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3, theme: store.curTheme() });
    }
    this.loadProfile();
  },

  // 进页面先读已存的画像（不花大模型额度）；没有就留空态让用户点生成
  loadProfile() {
    if (this._loading) return;
    this.setData({ ready: false, genFail: false });
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'profileGet' } })
      .then(res => {
        const p = res.result && res.result.profile;
        this.setData({
          ready: true,
          p: p ? Object.assign({}, p, { updatedAtLabel: fmtTs(p.updatedAt) }) : null,
          empty: !p
        });
      })
      .catch(() => {
        // 读失败（集合还没建 / 网络问题）：先给空态，不阻断页面
        this.setData({ ready: true, empty: true, genFail: false });
      });
  },

  // 下拉刷新＝重新生成；也复用同一条生成逻辑
  onPullDownRefresh() {
    this.layoutBrand();
    this.playBrand();
    this.generate();
  },

  // 生成 / 重新生成画像（调大模型，几秒 ~ 十几秒）
  generate() {
    if (this._loading) { wx.stopPullDownRefresh && wx.stopPullDownRefresh(); return; }
    this._loading = true;
    this.setData({ loading: true, genFail: false });
    wx.cloud.callFunction({ name: 'analysis', data: { action: 'profile' } })
      .then(res => {
        this._loading = false;
        const r = res.result || {};
        if (r.empty) {
          this.setData({ loading: false, empty: true, p: null, ready: true });
          wx.stopPullDownRefresh && wx.stopPullDownRefresh();
          return;
        }
        if (r.error) {
          this.setData({ loading: false, genFail: true });
          wx.stopPullDownRefresh && wx.stopPullDownRefresh();
          return;
        }
        this.setData({
          loading: false, ready: true, empty: false,
          p: {
            _id: r._id, summary: r.summary, strengths: r.strengths || [],
            interests: r.interests || [], disinterests: r.disinterests || [],
            directions: r.directions || [], tryThis: r.tryThis || [],
            patterns: r.patterns || '', updatedAtLabel: fmtTs(r.updatedAt)
          }
        });
        wx.stopPullDownRefresh && wx.stopPullDownRefresh();
      })
      .catch(() => {
        this._loading = false;
        this.setData({ loading: false, genFail: true });
        wx.stopPullDownRefresh && wx.stopPullDownRefresh();
      });
  },

  onGenerate() { this.generate(); },

  // 子页：从回看页 navigateTo 进来，点返回回退
  onClose() { wx.navigateBack(); }
}));
