// components/todo-list/todo-list.js —— 待办清单公用组件
// 只负责「待完成 / 已完成 / 已放弃」三段渲染与折叠态；
// 勾选、选中、长按、左滑、展开等交互一律通过事件交给页面，清单页与看页各自接同一份渲染。
const swipe = require('../../utils/swipe.js');

Component({
  options: { addGlobalClass: true },
  properties: {
    // 三段数据（页面已算好窗口化后的结果）
    undone: { type: Array, value: [] },
    doneGroups: { type: Array, value: [] },
    abandGroups: { type: Array, value: [] },
    // 各段数量与「显示更多」的剩余量
    undoneN: { type: Number, value: 0 },
    doneN: { type: Number, value: 0 },
    abandN: { type: Number, value: 0 },
    undoneHide: { type: Number, value: 0 },
    doneHide: { type: Number, value: 0 },
    abandHide: { type: Number, value: 0 },
    // 顶部标题与汇总行（清单页「待办 / 类别名」+「N 项待完成 · 已完成 N」；看页同款），可选
    tit: { type: String, value: '' },
    sum: { type: String, value: '' },
    // 是否显示模块名（清单页「全部」时显示；看页待办视图始终显示）
    showMn: { type: Boolean, value: false },
    // 是否可「管理」：点击出操作条 / 左滑就地改。false 时这些行只作概览（勾选与长按复制不受它控制）
    manage: { type: Boolean, value: true },
    // 选中高亮 / 正在就地编辑的那一行（页面级状态，透传下来）
    sel: { type: String, value: '' },
    edId: { type: String, value: '' },
    // 页面切的「段」（清单页传 seg，看页不传）：它一变就把折叠态归位（见下面的 observers）
    foldKey: { type: String, value: '' }
  },
  // 折叠态归组件自己管：默认展开「待完成」，已完成 / 已放弃收起
  data: { openU: true, openD: false, openA: false },
  observers: {
    /* 切段时把折叠态归位：展开第一个**有内容**的段（待完成 → 已完成 → 已放弃 顺次找），其余收起。
       有的类别只剩已完成 / 已放弃（待完成是 0），固定展开「待完成」会整屏都是收起的段头。
       数量也一起监听：段与数量是同一次 setData 下来的，只盯 foldKey 可能先拿到旧数量；
       但只有 foldKey 真的换了才归位——否则「勾掉一条待完成」这种数量变化也会抹掉用户的折叠态。
       再补一种：数量后到时（首帧还是 0，比如看页先挂组件再取数）会被归位成「全收起」，
       明明有内容却一个段都看不到——这种也再归位一次 */
    'foldKey, undoneN, doneN, abandN'(key, u, d, a) {
      const hasU = u > 0, hasD = d > 0, hasA = a > 0;
      const any = hasU || hasD || hasA;
      const collapsed = !this.data.openU && !this.data.openD && !this.data.openA;
      if (key === this._foldKey && !(any && collapsed)) return;
      this._foldKey = key;
      this.setData({ openU: hasU, openD: !hasU && hasD, openA: !hasU && !hasD && hasA });
    }
  },
  methods: {
    onFold(e) {
      const k = e.currentTarget.dataset.k;
      if (k === 'undone') this.setData({ openU: !this.data.openU });
      else if (k === 'aband') this.setData({ openA: !this.data.openA });
      else this.setData({ openD: !this.data.openD });
    },
    onCheck(e) { this.triggerEvent('check', { id: e.currentTarget.dataset.id }); },
    onTapRow(e) { if (!this.data.manage) return; this.triggerEvent('select', { id: e.currentTarget.dataset.id }); },
    // 长按＝复制，不是「管理」动作：概览态（看页）也照样派发
    onLongPress(e) { this.triggerEvent('longpress', { id: e.currentTarget.dataset.id }); },
    /* 行内触摸：只在「行尾起手的左滑」上插手——那是「就地改这一条」（派发 swipeleft 给页面）。
       其它方向、以及不是从行尾起手的横滑（含从行中间往左）都原样放过，交给页面级 / 根节点
       去切段 / 切维度——行铺满整屏，不划这条界线上层手势就没法触发了。
       触摸用 bind（不是 catch）：catch 掉触摸会让微信的 tap / longpress 在行内失效——
       勾选完成、点条目出行操作条、长按复制都会没反应 */
    onTouchStart(e) { this._rowEdge = swipe.atEdge(e); swipe.start(this, e); },
    onTouchCancel() { this._swX = null; this._swY = null; this.triggerEvent('touchend'); },
    onTouchEnd(e) {
      // 左滑＝就地改，属于「管理」动作：只有行尾起手算，概览态（看页）也不派发。
      // 门槛比切 tab 高一档（swipe.rowLeft：划得更远更平），短促一挥归页面切 tab
      const row = this.data.manage && this._rowEdge && swipe.rowLeft(this, e);
      swipe.end(this, e);
      if (row) {
        this.triggerEvent('swipeleft', { id: e.currentTarget.dataset.id });
        return;
      }
      this.triggerEvent('touchend');
    },
    onMore(e) { this.triggerEvent('more', { k: e.currentTarget.dataset.k }); },
    onDayMore(e) { this.triggerEvent('daymore', { k: e.currentTarget.dataset.k, w: e.currentTarget.dataset.w }); }
  }
});
