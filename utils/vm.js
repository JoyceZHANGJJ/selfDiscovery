// utils/vm.js —— 记录展示 VM 的「公共部分」
// 背景（可优化点 #3）：记 / 看 / 清单 三页各写一份 recVM，字段略有差异，改一处容易漏。
// 这里给出公共字段；各页在此基础上补自己的字段（如看页的 dm/from、清单页的完成/放弃时间文案）。
const store = require('./store.js');

// 公共字段：id / 模块名 / 颜色 / 文本 / 描述 / 时间 / 日期前缀 / 待办态
// 注：dt（细节行）、doingDays、dur 等各页按需再加，避免清单页为用不到的字段白算一遍
function baseVM(r) {
  const task = store.isTask(r.m);
  return {
    id: r.id,
    m: store.recMname(r),
    c: task ? store.taskColor(r) : store.mcolor(r.m),
    txt: r.txt,
    desc: r.desc || '',
    t: r.t,
    tt: r.tt || r.t,
    d: store.datePrefix(r.ts),
    task,
    done: !!r.done,
    doneLabel: store.doneLabel(r.doneAt),
    reason: r.reason || '',
    usefor: r.usefor || '',
    status: r.status || ''
  };
}

module.exports = { baseVM };
