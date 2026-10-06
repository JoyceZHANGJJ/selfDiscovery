// utils/vm.js —— 记录展示 VM 的「公共部分」
// 背景（可优化点 #3）：记 / 看 / 清单 三页各写一份 recVM，字段略有差异，改一处容易漏。
// 这里给出公共字段；各页在此基础上补自己的字段（如看页的 dm/from、清单页的完成/放弃时间文案）。
const store = require('./store.js');

// 公共字段：id / 模块名 / 颜色 / 文本 / 描述 / 时间 / 日期前缀 / 待办态
// 注：dt（细节行）、doingDays、dur 等各页按需再加，避免清单页为用不到的字段白算一遍
function baseVM(r) {
  const task = store.isTask(r.m);
  // 待办的优先级：只有「真正挑过的档」才有值（默认档「不紧急不重要」与老记录都不显示，
  // 见 store.prioShow）——否则每一行都挂一个标签，等于没筛出信息。pc 是该档的色
  const prio = task ? store.taskPrio(r) : '';
  const showPrio = store.prioShow(prio);
  return {
    id: r.id,
    m: store.recMname(r),
    // 颜色：待办按类别（备忘 / 购物 / 自己的类别）、随记按类别（念头 / 灵感 …）各取一色；
    // 其余维度用模块色
    c: task ? store.taskColor(r) : (r.m === 'jot' ? store.jotColor(store.jotCat(r)) : store.mcolor(r.m)),
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
    status: r.status || '',
    pn: showPrio ? prio : '',
    pc: showPrio ? store.prioColor(prio) : '',
    // 计划完成（待办）：**没计划就没有这一项**（dueHas=false，行尾什么都不渲染）——
    // 跟优先级默认档同一个取舍，只是这里更彻底：一条待办本来就不一定有计划时间。
    // dueOv＝逾期，行尾那片胶囊转红褐；文案本身已经写了「昨天 / 10月2日」，
    // 颜色只是补一层「一眼扫到」，色弱用户只看字也读得出过期
    due: task ? store.dueLabel(r.dueTs) : '',
    dueHas: !!(task && r.dueTs),
    dueOv: !!(task && store.dueOver(r.dueTs))
  };
}

module.exports = { baseVM };
