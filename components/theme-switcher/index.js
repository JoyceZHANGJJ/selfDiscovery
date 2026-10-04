// 主题快捷切换：胶囊左侧小圆点，点一下切到下一个主题，并同步页面与 tabBar
const store = require('../../utils/store.js');
const ui = require('../../utils/ui.js');

Component({
  properties: {
    // 编辑态锁定时不切主题，改为通知页面（页面会把「保存修改」滚到中间）
    lock: { type: Boolean, value: false },
    // 圆点左侧显示的名称（如小程序名），不传则不显示
    title: { type: String, value: '' }
  },
  data: {
    name: '',
    style: ''
  },
  lifetimes: {
    attached() {
      this.applyTheme();
      this.position();
    }
  },
  pageLifetimes: {
    show() {
      this.applyTheme();
      this.position();   // 重新对一次位置：胶囊矩形走缓存，页面切换不会把它带偏
    }
  },
  methods: {
    // 取胶囊位置，把控件定位在它左侧（矩形走 ui.capsuleRect()，与会话内其它取胶囊处同一份）
    position() {
      const mb = ui.capsuleRect();
      if (!mb) { this.setData({ style: 'position:fixed;top:24px;right:92px;z-index:60;' }); return; }
      const right = mb.windowWidth - mb.left + 8;
      this.setData({ style: 'position:fixed;top:' + mb.top + 'px;right:' + right + 'px;height:' + mb.height + 'px;z-index:60;' });
    },
    applyTheme() {
      this.setData({ name: store.themeOf(store.curTheme()).n });
    },
    onTap() {
      if (this.data.lock) { this.triggerEvent('locked'); return; }
      const list = store.themeList();
      const idx = list.findIndex(x => x.k === store.curTheme());
      const next = list[(idx + 1) % list.length];
      wx.setStorageSync('theme', next.k);
      this.setData({ name: next.n });
      // 同步当前页面（根节点注入的主题变量）与底部 tabBar
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && page.setData) page.setData({ theme: next.k, themeStyle: store.themeStyle(next.k) });
      if (page && typeof page.getTabBar === 'function' && page.getTabBar()) {
        page.getTabBar().setData({ theme: next.k });
      }
      wx.showToast({ title: next.n, icon: 'none', duration: 600 });
    }
  }
});
