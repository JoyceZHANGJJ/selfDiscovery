Component({
  options: { addGlobalClass: true },
  data: {
    selected: 0,
    theme: 'sand',
    hidden: false,
    list: [
      { pagePath: '/pages/index/index', text: '记', icon: '✎' },
      { pagePath: '/pages/look/look', text: '看', icon: '☰' },
      { pagePath: '/pages/review/review', text: '回看', icon: '◎' },
      { pagePath: '/pages/set/set', text: '设置', icon: '⚙' }
    ]
  },
  methods: {
    switchTab(e) {
      const idx = e.currentTarget.dataset.index;
      const path = this.data.list[idx].pagePath;
      wx.switchTab({ url: path });
    },
    onFab() {
      wx.navigateTo({ url: '/pages/list/list' });
    }
  }
});
