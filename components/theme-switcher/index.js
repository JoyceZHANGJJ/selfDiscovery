// 胶囊左侧的小控件：一个圆点（点一下切到下一个主题）+ 它左边那两个胶囊「起 / 睡」
// （点一下把现在的时刻记成起床 / 入睡时间）。
//
// 为什么挂在这里：这个控件本来就在每个页面里，而且已经按胶囊矩形算好了位置，
// 天然满足「睡前 / 起床后在任何一页都能顺手点到、不占页面空间」。它现在承担两件事：
// 切主题（圆点）与记起 / 睡（左边的两个胶囊）。
//
// 记录的规则（与「作息」tab、store 的 sleep* / wake* 同一套口径）：
// · 记的就是**点下去的那一刻**，只存 ts，不填任何东西；
// · 一夜一条，分界用**一天的分割点**（设置 · 作息里可改，默认中午 12:00）——所以 23:47 点过、
//   次日 00:20 又点，是同一夜，**覆盖**成 00:20（不新增第二条）；「起」同 night 键，正好配对；
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
    // 「起 / 睡」的状态：这一夜是否已记（**只用来决定按钮实底/空心**，按钮上的字不变）
    sleepOn: false,
    wakeOn: false,
    slUndo: null,
    slBusy: false,  // 写入中：连点两次不重复写
    // 「睡原因」弹层：只在「睡晚于基准点」时弹出，可不填；已填过则回显
    reasonOpen: false,
    reasonVal: '',
    reasonAnchor: ''
  },
  lifetimes: {
    attached() {
      this.applyTheme();
      this.position();
      this.syncRec();
      // 冷启动时上面那次 syncRec 读到的是**空记录列表**（首次取数还在路上，见 app.js 的 ensureAll）——
      // 结果是这一夜明明已经记过，「起 / 睡」却都是空心，切一次 tab 才补上。
      // 这里订阅「取数就绪」：已经就绪就立刻回调，还在路上就等它完成，回调后订阅作废。
      // 组件先于页面被销毁时（_dead）不再 setData
      store.onLoaded(() => { if (!this._dead) this.syncRec(); });
      // 作息页删掉 / 改掉一条「起 / 睡」时，别处改的数据这边也要跟上（不然标记要到下一
      // 次 onShow 才灭——表现就是「删了还亮着，重进才消除」）。见 store.emitRecChange
      this._offRec = store.onRecChange(() => { if (!this._dead) this.syncRec(); });
    },
    detached() {
      this._dead = true;
      // 退订：每进一页都会挂一份新实例，不退订会把已销毁的实例越攒越多
      if (this._offRec) { this._offRec(); this._offRec = null; }
    }
  },
  pageLifetimes: {
    show() {
      this.applyTheme();
      this.position();   // 重新对一次位置：胶囊矩形走缓存，页面切换不会把它带偏
      this.syncRec();    // 别的页面记过 / 撤销过，回到这页要跟上
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
    // 这一夜的两条「起 / 睡」：有 → 对应按钮点亮（实底），没有 → 空心。字不变，只有底色变
    syncRec() {
      const list = store.globalData.records || [];
      const now = Date.now();
      this.setData({
        sleepOn: !!store.sleepRecOf(list, now),
        wakeOn: !!store.wakeRecOf(list, now)
      });
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
    /* 记起 / 记睡：点一下 = 记现在（写入规则统一在 store 的 wakeNow / sleepNow，
       这里是唯一入口）。kind 区分这次记的是哪一边（撤销条文案与撤销分派都要用）。
       返回 Promise：写入完成（撤销条已上屏）才算完 */
    _recNow(kind) {
      if (this.data.slBusy) return Promise.resolve();
      this.setData({ slBusy: true });
      const isW = kind === 'wake';
      const write = isW ? store.wakeNow() : store.sleepNow();
      return write.then(res => {
        this._res = res;
        this._resKind = kind;
        const label = isW ? ' 起床' : ' 入睡';
        this.setData({ slBusy: false, slUndo: { msg: (res.kind === 'new' ? '已记 ' : '已改成 ') + res.rec.txt + label } });
        this.syncRec();
        this._startSlUndo();
        this._notifyRec();
        // 记的是「睡」且晚于基准点（超出睡的基准点）→ 弹「睡原因」，可不填；已填过则回显
        if (!isW && store.sleepMin(res.rec.ts) > store.sleepAnchor()) {
          this._reasonRec = res.rec;
          this.setData({
            reasonOpen: true,
            reasonVal: res.rec.sleepNote || '',
            reasonAnchor: store.anchorTxt(store.getAnchor('sleep'))
          });
        }
      }).catch(() => {
        this.setData({ slBusy: false });
        wx.showToast({ title: '没记上，再试一次', icon: 'none' });
      });
    },
    onWake() { return this._recNow('wake'); },
    onSleep() { return this._recNow('sleep'); },
    /* 撤销：新建的那条删掉；覆盖过的那次把时间改回去——两种都用一次「撤销」交代清楚。
       撤销条起睡共用（后一次操作盖前一次），按刚才记的是哪一边分派到 wakeUndo / sleepUndo */
    onSlUndo() {
      const res = this._res;
      const kind = this._resKind;
      this._stopSlUndo();
      this.setData({ slUndo: null });
      if (!res) return;
      this._res = null;
      this._resKind = null;
      const back = (res.back || {}).t || '';
      if (kind === 'wake') store.wakeUndo(res); else store.sleepUndo(res);
      this.syncRec();
      this._notifyRec();
      wx.showToast({ title: res.kind === 'new' ? '已撤销' : '已改回 ' + back, icon: 'none' });
    },
    onSlNoop() {},
    // 「睡原因」弹层：输入、保存（写回记录并持久化）、跳过（关闭，不动已有值）
    onReasonInput(e) { this.setData({ reasonVal: e.detail.value }); },
    onReasonSave() {
      const rec = this._reasonRec;
      const val = (this.data.reasonVal || '').slice(0, 200);
      if (rec) {
        rec.sleepNote = val;          // 内存里同一份对象，sleep 页回来即见
        store.updateRecord(rec);      // 落到云端（sleepNote 已在 TEXT_FIELDS 里）
      }
      this.closeReason();
    },
    onReasonSkip() { this.closeReason(); },
    closeReason() { this._reasonRec = null; this.setData({ reasonOpen: false, reasonVal: '', reasonAnchor: '' }); },
    _startSlUndo() {
      this._stopSlUndo();
      this._slTimer = setTimeout(() => { this._slTimer = null; this.setData({ slUndo: null }); }, 3200);
    },
    _stopSlUndo() { if (this._slTimer) { clearTimeout(this._slTimer); this._slTimer = null; } },
    // 记完让当前页跟上（「作息」页实现 onSleepChange / onWakeChange；其它页没实现就等下次 onShow）
    _notifyRec() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      ['onSleepChange', 'onWakeChange'].forEach(fn => {
        if (page && typeof page[fn] === 'function') page[fn]();
      });
    }
  }
});
