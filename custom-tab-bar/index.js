const store = require('../utils/store.js');

Component({
  data: {
    selected: 0,
    theme: 'sand',
    hidden: false,
    fabOpen: false,
    fabList: [],
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
    toggleFab() {
      this.buildFab();
      this.setData({ fabOpen: !this.data.fabOpen });
    },
    // 悬浮球菜单：列出全部维度（含自定义维度）
    buildFab() {
      const dims = (store.globalData.dims || []).map(d => ({ k: d.k, n: d.n, c: d.c }));
      const list = store.MODULES.map(m => ({ k: m.k, n: m.n, c: m.c })).concat(dims);
      // 去重（自定义维度已并入 MODULES 的情况）
      const seen = {};
      const out = [];
      list.forEach(it => { if (!seen[it.k]) { seen[it.k] = 1; out.push(it); } });
      this.setData({ fabList: out });
    },
    goTag(e) {
      const tag = e.currentTarget.dataset.tag;
      const app = getApp();
      const pages = getCurrentPages();
      const cur = pages[pages.length - 1];
      const onIndex = cur && cur.route === 'pages/index/index';
      this.setData({ fabOpen: false });
      // 已在「记」页：直接切维度（switchTab 到当前页不会触发 onShow，故手动调用）
      if (onIndex && typeof cur.onTag === 'function') {
        if (app && app.globalData) app.globalData.pendingTag = null;
        cur.onTag({ currentTarget: { dataset: { k: tag } } });
      } else {
        if (app && app.globalData) app.globalData.pendingTag = tag;
        wx.switchTab({ url: '/pages/index/index' });
      }
    }
  }
});
