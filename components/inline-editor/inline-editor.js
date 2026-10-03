// 待办「长按就地编辑」的编辑器（清单 / 看 / 记 三页共用）
//
// 设计要点（踩过的坑都在这里）：
// 1) 全页只有这一个输入框节点，且常驻不销毁 —— 删节点会让原生输入层变成孤儿（残留文字/光标）；
// 2) 收起时【只把宽高收成 0，位置原地不动】—— 挪位置会把「带焦点的输入框」滚进可视区，
//    表现为键盘重弹 + 页面跳回顶部；而原生层不认 visibility/opacity，只有没面积才不画；
// 3) 位置不由组件自己算：宿主页面量好「整张卡片」的矩形（文档坐标）通过 rect 传进来；
// 4) 只编辑「事项」这一件事（txt），分类 / 时间 / 原因等更多字段走「改更多」进完整编辑器。
Component({
  properties: {
    visible: { type: Boolean, value: false },
    // 聚焦与显示分开：长按过程中不聚焦，等手指抬起后再聚焦
    // （长按时就聚焦的话，抬手瞬间微信的「点到外面」会把输入框 blur 掉 → 表现为一松手就关掉）
    focus: { type: Boolean, value: false },
    value: { type: String, value: '' },
    rect: { type: Object, value: {} },        // { top, left, width, height }，文档坐标
    showHome: { type: Boolean, value: true }, // 是否显示「改更多」
    moreLabel: { type: String, value: '改更多' }, // 「改更多」文案（改名只改这一处）
    maxlength: { type: Number, value: 200 }
  },
  data: {
    txt: ''
  },
  observers: {
    // 仅在「打开」时把待办文本灌进输入框；收起过程中不动它，避免文字闪一下
    'visible, value': function (visible, value) {
      if (visible) this.setData({ txt: value || '' });
    }
  },
  methods: {
    onInput(e) { this.setData({ txt: e.detail.value }); },
    // 失焦 / 键盘「完成」/ 点「保存」都派发 save，由页面决定是否落库与收起
    onSave() { this.triggerEvent('save', { value: (this.data.txt || '').trim() }); },
    onHome() { this.triggerEvent('home'); }
  }
});
