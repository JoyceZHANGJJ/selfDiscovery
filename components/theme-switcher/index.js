// 主题快捷切换：胶囊左侧小圆点，点一下切到下一个主题，并同步页面与 tabBar
const store = require('../../utils/store.js');

Component({
  properties: {
    // 编辑态锁定时不切主题，改为通知页面（页面会把「保存修改」滚到中间）
    lock: { type: Boolean, value: false }
  },
  data: {
    ac: '#2F8F7B',
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
    show() { this.applyTheme(); }
  },
  methods: {
    // 取胶囊位置，把控件定位在它左侧
    position() {
      try {
        const mb = wx.getMenuButtonBoundingClientRect();
        const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
        const right = info.windowWidth - mb.left + 8;
        const style = 'position:fixed;top:' + mb.top + 'px;right:' + right + 'px;height:' + mb.height + 'px;z-index:60;';
        this.setData({ style });
      } catch (e) {
        this.setData({ style: 'position:fixed;top:24px;right:92px;z-index:60;' });
      }
    },
    applyTheme() {
      const k = wx.getStorageSync('theme') || 'mint';
      const t = store.THEMES.find(x => x.k === k) || store.THEMES[0];
      this.setData({ ac: t.ac, name: t.n });
    },
    onTap() {
      if (this.data.lock) { this.triggerEvent('locked'); return; }
      const k = wx.getStorageSync('theme') || 'mint';
      const idx = store.THEMES.findIndex(x => x.k === k);
      const next = store.THEMES[(idx + 1) % store.THEMES.length];
      wx.setStorageSync('theme', next.k);
      this.setData({ ac: next.ac, name: next.n });
      // 同步当前页面（根节点 theme- 类）与底部 tabBar
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && page.setData) page.setData({ theme: next.k });
      if (page && typeof page.getTabBar === 'function' && page.getTabBar()) {
        page.getTabBar().setData({ theme: next.k });
      }
      wx.showToast({ title: next.n, icon: 'none', duration: 600 });
    }
  }
});
