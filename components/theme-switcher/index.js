// 胶囊左侧的小控件：一个圆点（点一下切到下一个主题）+ 它左边那个「睡」
// （点一下把现在的时刻记成入睡时间）。
//
// 为什么「睡」挂在这里：这个控件本来就在每个页面里，而且已经按胶囊矩形算好了位置，
// 天然满足「睡前在任何一页都能顺手点到、不占页面空间」。它现在承担两件事：
// 切主题（圆点）与记入睡（左胶囊）。
//
// 入睡的规则（与「睡」tab、store.sleep* 同一套口径）：
// · 记的就是**点下去的那一刻**，只存 ts，不填任何东西；
// · 一夜一条，夜间以 **中午 12:00** 分界（00:00–11:59 点算昨夜）——所以 23:47 点过、
//   次日 00:20 又点，是同一夜，**覆盖**成 00:20（不新增第二条）；
// · 撤销分两种：刚新建的那条＝删掉；覆盖掉的那次＝把时间改回去。
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
    style: '',
    // 「睡」的状态：今夜是否已记（**只用来决定按钮实底/空心**，按钮上的字一直是「睡」）
    sleepOn: false,
    slUndo: null,
    slBusy: false   // 写入中：连点两次不重复写
  },
  lifetimes: {
    attached() {
      this.applyTheme();
      this.position();
      this.syncSleep();
    }
  },
  pageLifetimes: {
    show() {
      this.applyTheme();
      this.position();   // 重新对一次位置：胶囊矩形走缓存，页面切换不会把它带偏
      this.syncSleep();  // 别的页面记过 / 撤销过，回到这页要跟上
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
    // 今夜那条「睡」：有 → 按钮点亮（实底），没有 → 空心「睡」。字不变，只有底色变
    syncSleep() {
      const r = store.sleepRecOf(store.globalData.records || [], Date.now());
      this.setData({ sleepOn: !!r });
    },
    onTap() {
      if (this.data.lock) { this.triggerEvent('locked'); return; }
      // 只在「常用主题」之间循环（设置页勾的那几个，最多 5 个）；一个都没勾时退回全部主题
      let list = store.getFavThemes().map(k => store.themeOf(k));
      if (!list.length) list = store.themeList();
      const idx = list.findIndex(x => x.k === store.curTheme());
      // 当前主题不在常用里时（刚取消勾选）从第一个常用主题开始
      const next = list[(idx + 1) % list.length];
      wx.setStorageSync('theme', next.k);
      this.setData({ name: next.n });
      // 同步当前页面（根节点注入的主题变量）与底部 tabBar
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && page.setData) page.setData({ theme: next.k, themeStyle: store.themeStyle(next.k) });
      store.syncWindowBg(next.k);   // 从圆点切主题同样要立刻换窗口底色
      if (page && typeof page.getTabBar === 'function' && page.getTabBar()) {
        page.getTabBar().setData({ theme: next.k });
      }
      wx.showToast({ title: next.n, icon: 'none', duration: 600 });
    },
    /* 记入睡：点一下 = 记现在（写入规则统一在 store.sleepNow，这里是唯一入口）。
       返回 Promise：写入完成（撤销条已上屏）才算完 */
    onSleep() {
      if (this.data.slBusy) return Promise.resolve();
      this.setData({ slBusy: true });
      return store.sleepNow().then(res => {
        this._res = res;
        this.setData({ slBusy: false, slUndo: { msg: (res.kind === 'new' ? '已记 ' : '已改成 ') + res.rec.txt + ' 入睡' } });
        this.syncSleep();
        this._startSlUndo();
        this._notifySleep();
      }).catch(() => {
        this.setData({ slBusy: false });
        wx.showToast({ title: '没记上，再试一次', icon: 'none' });
      });
    },
    /* 撤销：新建的那条删掉；覆盖过的那次把时间改回去——两种都用一次「撤销」交代清楚 */
    onSlUndo() {
      const res = this._res;
      this._stopSlUndo();
      this.setData({ slUndo: null });
      if (!res) return;
      this._res = null;
      const back = (res.back || {}).t || '';
      store.sleepUndo(res);
      this.syncSleep();
      this._notifySleep();
      wx.showToast({ title: res.kind === 'new' ? '已撤销' : '已改回 ' + back, icon: 'none' });
    },
    onSlNoop() {},
    _startSlUndo() {
      this._stopSlUndo();
      this._slTimer = setTimeout(() => { this._slTimer = null; this.setData({ slUndo: null }); }, 3200);
    },
    _stopSlUndo() { if (this._slTimer) { clearTimeout(this._slTimer); this._slTimer = null; } },
    // 记完让当前页跟上（「睡」页实现 onSleepChange；其它页没实现就等下次 onShow）
    _notifySleep() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && typeof page.onSleepChange === 'function') page.onSleepChange();
    }
  }
});
