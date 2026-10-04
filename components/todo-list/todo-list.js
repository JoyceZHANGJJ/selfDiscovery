// components/todo-list/todo-list.js —— 待办清单公用组件
// 只负责「待完成 / 已完成 / 已放弃」三段渲染与折叠态；
// 勾选、选中、长按、展开等交互一律通过事件交给页面，清单页与看页各自接同一份渲染。
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
    // 是否可「管理」：点击出操作条 / 长按就地编辑。false 时这些行只作概览（勾选不受它控制）
    manage: { type: Boolean, value: true },
    // 选中高亮 / 正在就地编辑的那一行（页面级状态，透传下来）
    sel: { type: String, value: '' },
    edId: { type: String, value: '' }
  },
  // 折叠态归组件自己管：默认展开「待完成」，已完成 / 已放弃收起（页面 rebuild 不会重置它）
  data: { openU: true, openD: false, openA: false },
  methods: {
    onFold(e) {
      const k = e.currentTarget.dataset.k;
      if (k === 'undone') this.setData({ openU: !this.data.openU });
      else if (k === 'aband') this.setData({ openA: !this.data.openA });
      else this.setData({ openD: !this.data.openD });
    },
    onCheck(e) { this.triggerEvent('check', { id: e.currentTarget.dataset.id }); },
    onTapRow(e) { if (!this.data.manage) return; this.triggerEvent('select', { id: e.currentTarget.dataset.id }); },
    onLongPress(e) { if (!this.data.manage) return; this.triggerEvent('longpress', { id: e.currentTarget.dataset.id }); },
    onTouchEnd() { this.triggerEvent('touchend'); },
    onMore(e) { this.triggerEvent('more', { k: e.currentTarget.dataset.k }); },
    onDayMore(e) { this.triggerEvent('daymore', { k: e.currentTarget.dataset.k, w: e.currentTarget.dataset.w }); }
  }
});
