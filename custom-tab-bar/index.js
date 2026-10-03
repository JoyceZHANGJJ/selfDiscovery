Component({
  options: { addGlobalClass: true },
  data: {
    selected: 0,
    theme: 'mint',
    hidden: false,
    pulse: false,   // 回顶时图标轻弹一次
    hint: false,    // 滑到底部时图标跳动提示可回顶
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
      // 再点一次「当前所在」的 tab：不跳转，让当前页回到顶部（页面实现 onTabReselect）
      if (idx === this.data.selected) {
        const pages = getCurrentPages();
        const page = pages[pages.length - 1];
        if (page && typeof page.onTabReselect === 'function') {
          page.onTabReselect();
          this.pulse();   // 回顶成功才给反馈
        }
        return;
      }
      const path = this.data.list[idx].pagePath;
      wx.switchTab({ url: path });
    },
    // 图标轻弹一次（回顶后的反馈）：动画结束就移除类，保证下次点击能重播
    pulse() {
      if (this._pulseTimer) clearTimeout(this._pulseTimer);
      this.setData({ pulse: false });
      this._pulseTimer = setTimeout(() => {
        this.setData({ pulse: true });
        this._pulseTimer = setTimeout(() => this.setData({ pulse: false }), 460);
      }, 16);
    },
    // 滑到底部时的提示：图标跳几下 + 指示条闪，暗示「点这里回顶」。
    // 带冷却，避免反复滑到底一直跳
    hint() {
      if (this._hintTimer || this._hintCool) return;
      this.setData({ hint: true });
      this._hintTimer = setTimeout(() => {
        this.setData({ hint: false });
        this._hintTimer = null;
        this._hintCool = setTimeout(() => { this._hintCool = null; }, 8000);
      }, 1750);
    },
    onFab() {
      if (this.isEditing()) { this.blocked(); return; }
      wx.navigateTo({ url: '/pages/list/list' });
    }
  }
});
