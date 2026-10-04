// pages/theme/theme.js —— 外观 · 主题（独立子页面）
// 为什么是子页面而不是设置页上的全屏浮层：tab 页**无法拦截系统返回键**（微信没有
// onBackPress 这类 API），按返回 = 退出小程序；走 navigateTo 子页面，返回键 = 回到设置页。
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');

Page(pageBase({
  data: {
    themeOpts: [],   // 主题表：每项 k / n / c（主色）/ on（当前）/ fav（常用）
    favMax: store.FAVTHEMES_MAX   // 常用主题上限（store 里单一来源）
  },

  onShow() {
    this.ensureTheme();
    this.buildThemeOpts();
  },

  /* 列出主题表，标出当前主题与「常用」（右上圆点只循环常用的那几个） */
  buildThemeOpts() {
    const fav = store.getFavThemes();
    const cur = store.curTheme();
    const themeOpts = store.themeList().map(t => {
      const v = (store.themeOf(t.k).vars || {});
      return { k: t.k, n: t.n, c: v.accent || '', on: t.k === cur, fav: fav.indexOf(t.k) >= 0 };
    });
    this.setData({ themeOpts });
  },

  /* 点色点＝切到这个主题：写存储 + 本页变量 + 窗口底色。
     设置页与各 tab 页的主题变量在它们下次 onShow 时自动跟上；
     右上圆点的名称也会在自己页面的 show 生命周期里重取（见 theme-switcher.applyTheme） */
  onThemePick(e) {
    const k = e.currentTarget.dataset.k;
    if (!k || k === store.curTheme()) return;
    wx.setStorageSync('theme', k);
    this.setData({
      theme: k, themeStyle: store.themeStyle(k),
      themeOpts: this.data.themeOpts.map(o => Object.assign({}, o, { on: o.k === k }))
    });
    store.syncWindowBg(k);
    wx.showToast({ title: store.themeOf(k).n, icon: 'none', duration: 600 });
  },

  /* 勾「常用」＝加入 / 移出右上圆点的循环，最多 FAVTHEMES_MAX 个。
     取消勾选不会改当前主题：就算当前这个不再常用，圆点下次也是从第一个常用主题接着走 */
  onFavToggle(e) {
    const k = e.currentTarget.dataset.k;
    const fav = store.getFavThemes();
    const i = fav.indexOf(k);
    if (i >= 0) fav.splice(i, 1);
    else {
      if (fav.length >= store.FAVTHEMES_MAX) { wx.showToast({ title: '最多 ' + store.FAVTHEMES_MAX + ' 个', icon: 'none' }); return; }
      fav.push(k);
    }
    const saved = store.setFavThemes(fav);
    this.setData({
      themeOpts: this.data.themeOpts.map(o => Object.assign({}, o, { fav: saved.indexOf(o.k) >= 0 }))
    });
    wx.showToast({ title: saved.length ? ('常用 ' + saved.length + ' 个') : '循环全部主题', icon: 'none', duration: 800 });
  }
}));
