// utils/pageBase.js —— 页面公共骨架（第三批 N1'）
//
// 背景：Page 不支持 behaviors，所以用工厂合并——`Page(pageBase({ ...页面自己的配置 }))`。
// 原则：**只收「多页逐字相同」的零差异逻辑**（主题 / 程序名 / 回顶 / 复制 / 取事件值 /
// 按天分组窗口 / 删除撤销定时器）；页面间行为有差别的（onRecAction 流转、stepDim 切换、
// 行级手势、chip 渐隐测量）仍留在页面里——别为了省行数把不同口径搅在一起。
// 合并顺序：base 在前、页面配置在后 → 页面同名方法 / 同名 data 字段覆盖 base。

const store = require('./store.js');
const ui = require('./ui.js');
const date = require('./date.js');
// 本模块只被页面 require（页面在 App 注册之后才加载），getApp() 此时一定可用
const app = (typeof getApp === 'function' && getApp()) || {};

const BASE_DATA = {
  theme: 'mint',
  statusH: 20,
  themeStyle: store.themeStyle('mint'),
  // 程序名彩蛋（记 / 看 / 清单 / 回看 用；设置 / 选项页不渲染但字段无害）
  appName: (app && app.APP_NAME) || '',
  brandTop: 0, brandLeft: 0, brandW: 0, brandH: 0, brandChars: [], brandPlay: false
};

function pageBase(extra) {
  extra = extra || {};
  return Object.assign({
    data: Object.assign({}, BASE_DATA, extra.data || {}),

    /* 主题 + 状态栏：整站只有这一份实现（原来 6 页各写一份，其中 3 份逐字相同）。
       顺带把窗口底色同步成主题的 bg——下拉露出的那层，不跟主题就会分层（见 store.syncWindowBg） */
    ensureTheme() {
      const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
      const t = store.curTheme();
      this.setData({ theme: t, statusH: info.statusBarHeight || 20, themeStyle: store.themeStyle(t) });
      store.syncWindowBg(t);
    },

    /* 程序名藏在胶囊「背后」：按胶囊的矩形定位，平时被原生胶囊盖住，
       只有下拉刷新把页面（含这个 fixed 元素）推下去时才露出来。
       矩形走 ui.capsuleRect()（一份会话内固定值的缓存）——各页现查的话，赶上页面切换
       会拿到「看起来合理但错位」的值，程序名就会跑到主题圆点的位置。
       名字**在这里运行时取**（getApp().APP_NAME），不能用模块顶层缓存的那份：
       本模块被页面 require 的时机早于 App() 注册完成，顶层 getApp() 拿到的是空，
       appName 变成空串 → 标题就「不展示了」 */
    layoutBrand() {
      const inst = (typeof getApp === 'function' && getApp()) || {};
      const mb = ui.capsuleRect();
      if (!mb) return;   // 取不到就先不显示（它平时本来就是被盖住的），下次 onShow 再取
      this.setData({
        brandTop: mb.top, brandLeft: mb.left, brandW: mb.width, brandH: mb.height,
        brandChars: String(inst.APP_NAME || this.data.appName || '').split('')
      });
    },

    /* 名字露出来的这会儿，播一次逐字浮现（下拉刷新时调用） */
    playBrand() {
      this.setData({ brandPlay: true });
      if (this._brandTimer) clearTimeout(this._brandTimer);
      this._brandTimer = setTimeout(() => this.setData({ brandPlay: false }), 900);
    },

    /* 切到其它 tab 再切回来（或再点当前 tab）：整页回到顶部。
       页面可覆盖 scrollToTop（如回看改用别的滚动容器时） */
    scrollToTop() {
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    },
    onTabReselect() { this.scrollToTop(); },

    /* 长按复制：把一条记录放进剪贴板，只复制那一句话本身（记 / 看 / 清单 三页逐字相同） */
    copyRec(r) {
      const txt = r.txt || '';
      if (!txt) return;
      wx.setClipboardData({
        data: txt,
        success: () => { if (wx.vibrateShort) wx.vibrateShort(); },
        fail: () => wx.showToast({ title: '没复制上，再试一次', icon: 'none' })
      });
    },

    /* 记录查找 / 事件取值：交互事件要么来自页面节点（dataset），要么来自组件（detail），统一取。
       findRec 先查内存全量（各页取数后都在里面），再兜底页面自己加载的那份 */
    findRec(id) {
      return (app.globalData.records || []).find(x => x.id === id)
        || (this.data.recs || []).find(x => x.id === id);
    },
    _id(e) { return (e.detail && e.detail.id != null) ? e.detail.id : e.currentTarget.dataset.id; },
    _detailOr(e, key) { return (e.detail && e.detail[key] != null) ? e.detail[key] : e.currentTarget.dataset[key]; },

    /* 按「某一天」把记录分段（看页 / 清单页逐字相同）：段头用时间线同款日标签，段内保持传入顺序。
       只分组、不 map 成 VM——窗口外那些天不用白算（见 winGroups） */
    groupByDay(recs, tsOf) {
      const map = {}, order = [];
      recs.forEach(r => {
        const k = date.dayStart(tsOf(r));
        if (!map[k]) { map[k] = { key: k, day: store.dayLabel(store.agoOf(k)), recs: [] }; order.push(k); }
        map[k].recs.push(r);
      });
      return order.map(k => map[k]);
    },
    /* 「按天分段 + 显示更多窗口」：只把窗口里真正要渲染的那几条 map 成 VM（窗口规则见 store.winDays） */
    winGroups(days, lim, dayAll) {
      return store.winDays(days, lim, dayAll).map(g => Object.assign({}, g, { recs: g.recs.map(r => this.recVM(r)) }));
    },

    /* 删除撤销条的自动收起定时器（记 / 看 / 清单 三页相同）；
       _delRec / onUndoDel 的收尾各页不同（重算的列表不一样），留在页面里 */
    _stopDelTimer() { if (this._delTimer) { clearTimeout(this._delTimer); this._delTimer = null; } },
    _startDelTimer() {
      this._stopDelTimer();
      this._delTimer = setTimeout(() => {
        if (this.data.delUndo) this.setData({ delUndo: null });
      }, 3000);
    }
  }, extra);
}

module.exports = pageBase;
