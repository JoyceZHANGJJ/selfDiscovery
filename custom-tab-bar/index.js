Component({
  options: { addGlobalClass: true },
  data: {
    selected: 0,
    theme: 'mint',
    hidden: false,
    list: [
      { pagePath: '/pages/index/index', text: '记', icon: '✎' },
      { pagePath: '/pages/look/look', text: '看', icon: '☰' },
      { pagePath: '/pages/review/review', text: '回看', icon: '◎' },
      { pagePath: '/pages/set/set', text: '设置', icon: '⚙' }
    ]
  },
  methods: {
    // 当前页是否处于编辑态（以页面自身的 editing 为准，避免两份状态不同步导致锁死）
    isEditing() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      return !!(page && page.data && page.data.editing);
    },
    // 编辑态被拦：不跳转，让当前页把「保存修改」滚到屏幕中间
    blocked() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && typeof page.scrollSaveToCenter === 'function') page.scrollSaveToCenter();
      // 优先复用页面的提示（内部会先 hideToast，保证连续点击每次都弹）
      if (page && typeof page.tipSaveFirst === 'function') { page.tipSaveFirst(); return; }
      if (wx.hideToast) wx.hideToast();
      wx.showToast({ title: '请先保存修改或取消', icon: 'none', duration: 800 });
    },
    switchTab(e) {
      if (this.isEditing()) { this.blocked(); return; }
      const idx = e.currentTarget.dataset.index;
      const path = this.data.list[idx].pagePath;
      wx.switchTab({ url: path });
    },
    onFab() {
      if (this.isEditing()) { this.blocked(); return; }
      wx.navigateTo({ url: '/pages/list/list' });
    }
  }
});
