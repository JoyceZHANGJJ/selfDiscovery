// components/due-sheet —— 「计划完成」的日历浮层（月历 + 时刻快捷档）
//
// 一个组件，两处用：快捷记面板的「自定义」与记卡待办那一行的「自定义」。
// 以前这段只长在 custom-tab-bar 里，记卡要给待办设具体某天时就没有入口——
// 于是把它提出来共用，两边同一套交互、同一份档位（档位见 store.dueChips / DUE_TIMES）。
//
// 交互口径（与原来一致，一条都没改）：
//   · **翻月只改「在看哪个月」，选中的日期不动**——否则翻一下月份就把选好的那天弄丢了；
//     点到前后补的空格会自动跳到那个月。
//   · 日期与时刻各管各的：先点哪边都行，换日期不动时刻、换时刻不动日期。
//   · 今天＝一圈描边（不填色）、选中＝实心，两个状态不打架。
//   · 过去的格子画淡但**仍可点**（改一条已逾期的待办时它的计划时间就在过去，要能原样看到）。
//   · 月历是纯点按；只有最下面那个 time picker 是兜底，真要 14:37 这种才用，
//     选了它会把档位高亮撤掉（不硬套进任何一档）。
//
// 对外的两个口：
//   properties.value —— 当前值（时间戳，0＝没计划）
//   bind:change      —— 点「好」，detail.ts 是拼好的时间戳（认不出来给 0）
//   bind:close       —— 点「取消」/「✕」
// 打开时由 open 的 observer 归位一次（起点取当前值；当前是「无」就从「今天」起，
// 别让浮层停在 1970 年）。
const store = require('../../utils/store.js');
const date = require('../../utils/date.js');

const p2 = (n) => (n < 10 ? '0' + n : '' + n);
const ymdOf = (ts) => {
  const d = new Date(ts);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
};
const hmOf = (ts) => {
  const d = new Date(ts);
  return p2(d.getHours()) + ':' + p2(d.getMinutes());
};

Component({
  // 用全局的 .sheet / .sh-* / .btn（见 app.wxss），本组件只写 .du-* 那部分
  options: { addGlobalClass: true },
  properties: {
    open: { type: Boolean, value: false, observer(v) { if (v) this._reset(); } },
    value: { type: Number, value: 0 }
  },
  data: {
    ym: '',            // 正在看哪个月 'YYYY-MM'（翻月只改这个）
    monT: '',          // 月份头的文字（当年只写「10月」，跨年才带年份）
    grid: [],          // 42 格日历（date.monthGrid；固定 6 行，翻月时格子不整体跳）
    day: '',           // 当前选中的那天 'YYYY-MM-DD'
    time: '',          // 当前选中的时刻 'HH:MM'
    timeKey: 'none',   // 时刻落在哪一档（高亮；''＝picker 里的任意时刻）
    times: store.DUE_TIMES,
    week: ['一', '二', '三', '四', '五', '六', '日']   // 周一起始，与「回看」的自然周一致
  },
  methods: {
    // 打开时归位。一次 setData 全给齐：_setYM 要读 this.data.day 当天的高亮，
    // 分两步写会依赖 setData 的同步时机，不如自己算清楚
    _reset() {
      const ts = this.data.value || store.duePresetTs('今天');
      const d = ymdOf(ts);
      const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1;
      this.setData({
        day: d, time: hmOf(ts), timeKey: store.dueTimeKey(ts),
        ym: y + '-' + p2(m + 1),
        monT: this._monT(y, m),
        grid: date.monthGrid(y, m, d)
      });
    },
    _monT(y, m) { return (y === new Date().getFullYear() ? '' : y + '年') + (m + 1) + '月'; },
    // 翻月只换「在看哪个月」，选中日期不动
    _setYM(ym) {
      const p = String(ym || '').split('-');
      const y = +p[0], m = +p[1] - 1;
      if (!y || m < 0 || m > 11) return;
      this.setData({
        ym: y + '-' + p2(m + 1),
        monT: this._monT(y, m),
        grid: date.monthGrid(y, m, this.data.day)
      });
    },
    onPrev() {
      const p = this.data.ym.split('-');
      this._setYM(+p[1] === 1 ? (+p[0] - 1) + '-12' : p[0] + '-' + p2(+p[1] - 1));
    },
    onNext() {
      const p = this.data.ym.split('-');
      this._setYM(+p[1] === 12 ? (+p[0] + 1) + '-01' : p[0] + '-' + p2(+p[1] + 1));
    },
    // 点日历上的一天：只换日期，时刻不变（点到前后补的空格会顺手把月切过去）
    onDay(e) {
      const d = e.currentTarget.dataset.d;
      if (!d) return;
      this.setData({ day: d, grid: date.monthGrid(+d.slice(0, 4), +d.slice(5, 7) - 1, d) });
    },
    // 点时刻快捷档：换时刻，日期不变
    onTimePick(e) {
      const t = this.data.times.find(x => x.k === e.currentTarget.dataset.k);
      if (!t) return;
      this.setData({ timeKey: t.k, time: p2(t.h) + ':' + p2(t.m) });
    },
    // 兜底的 picker：任意时刻。选完把档位高亮撤掉（它不属于任何一档）
    onTime(e) { this.setData({ time: e.detail.value, timeKey: '' }); },
    // 保存：日期串 + 时刻串拼回时间戳（store.dueFrom 里兜底 23:59——
    // 与四个档位同一个口径：「那天结束前」）。提示放在组件里，两处用的话术才一致
    onOk() {
      const ts = store.dueFrom(this.data.day, this.data.time);
      if (ts) wx.showToast({ title: '计划 · ' + store.dueLabel(ts), icon: 'none' });
      this.triggerEvent('change', { ts });
    },
    onClose() { this.triggerEvent('close'); }
  }
});
