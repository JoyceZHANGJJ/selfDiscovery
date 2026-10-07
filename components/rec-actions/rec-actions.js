// 记录操作条（记页「最近」与看页共用）：集中维护「哪些模块/状态显示哪些操作按钮」
// 页面只负责各自的行为（记页内联改、看页跳记页），按钮集合与可见性逻辑只此一处。
Component({
  properties: {
    rec: {
      type: Object,
      value: null,
      observer() { this.compute(); }
    },
    visible: { type: Boolean, value: false },
    // 距底部的距离（可选）：不传就用 wxss 里的默认值（抬到 tab 栏之上）；
    // 没有 tab 栏的页面（清单页）传一个小值，让条子真正贴底
    bottom: { type: String, value: '' }
  },
  data: {
    title: '',
    flow: [],        // [{ type, label, cls }] 流转按钮（开始/完成/放弃/恢复/结束）
    showEditDel: false,
    showEndSep: false,   // 觉察/无感 分组后分隔线
    showWantSep: false,  // 可做 流转后分隔线
    calLabel: ''         // 「推到日历」按钮的文字；空串＝不渲染（见 compute）
  },
  lifetimes: {
    attached() { this.compute(); }
  },
  methods: {
    compute() {
      const rec = this.data.rec || {};
      const rawm = rec.rawm;
      const status = rec.status || '';
      const isWant = rawm === 'want';
      const isObsNope = rawm === 'obs' || rawm === 'nope';
      // 待办：备忘 / 购物 合并后都是 todo（memo / buy 兼容迁移前的老数据）
      const isTask = rawm === 'todo' || rawm === 'memo' || rawm === 'buy';
      const flow = [];
      // 可做：未做/在做 显示 开始(仅未在做)/完成/放弃；不做 显示 恢复
      if (isWant && status !== 'done' && status !== 'abandon') {
        if (status !== 'doing') flow.push({ type: 'start', label: '开始', cls: 'start' });
        // type 必须是 complete（页面 handler 按 complete 处理）；cls 仍是 done（对应 .flow.done 样式）
        flow.push({ type: 'complete', label: '完成', cls: 'done' });
        flow.push({ type: 'abandon', label: '放弃', cls: 'abandon' });
      }
      if (isWant && status === 'abandon') {
        flow.push({ type: 'restore', label: '恢复', cls: 'restore' });
      }
      // 觉察 / 无感：结束（仅未结束显示；已结束后改时间走「改」，不再显示「结束」）
      if (isObsNope && !rec.ended) {
        flow.push({ type: 'end', label: '结束', cls: 'end' });
      }
      // 待办（备忘 / 购物）：完成永远走条目上的勾选框，操作条只给次级操作 —— 放弃 / 恢复。
      // 放弃只是小概率事件，放这儿不会影响「点一下勾掉」这条主路径
      if (isTask && !rec.done && status !== 'abandon') flow.push({ type: 'abandon', label: '放弃', cls: 'abandon' });
      if (isTask && status === 'abandon') flow.push({ type: 'restore', label: '恢复', cls: 'restore' });
      /* 占卜：事后补一句「后来实际怎么样了」。
         只给占卜——它是唯一一个「记的时候还没结果」的维度：牌抽完、解读写完，
         准不准要等事情走完才知道（记录上那个时间范围就是提醒何时该回头看）。
         其余维度记下的本身就是已经发生的事，不需要再「回顾」一次。 */
      const isDiv = rawm === 'div';
      if (isDiv) flow.push({ type: 'review', label: '回顾', cls: 'review' });
      /* 「推到日历」：只有**待办且定了计划完成时间**才有这个入口。
         没计划就不出现——不给一条本来不需要截止的待办偷偷补日期（与 dueTs「0 是常态」一致）。
         已推过的写成「再推一次?」之外的中性说法：推过了就说「已推日历」，
         点一下会先问一句（手机日历里会多一条，不该悄悄推）。 */
      const canCal = isTask && !!rec.dueTs && !rec.done && status !== 'abandon';
      this.setData({
        flow,
        calLabel: canCal ? (rec.calTs ? '已推日历' : '推到日历') : '',
        showEditDel: !!rawm,
        showEndSep: isObsNope && !rec.ended,
        // 有流转按钮时，与右边的「改 / 删除」之间加一道分隔线（占卜的「回顾」同理）
        showWantSep: (isWant && status !== 'done') || (isTask && flow.length > 0) || isDiv,
        title: rec.m ? (rec.m + ' · ' + rec.txt) : ''
      });
    },
    onTap(e) {
      const type = e.currentTarget.dataset.type;
      this.triggerEvent('action', { type, rec: this.data.rec });
    }
  }
});
