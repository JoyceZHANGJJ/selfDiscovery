// utils/genstate.js —— 「后台生成中」标记的本地持久化
//
// 为什么需要它：AI 生成是**后台任务**（点提交后页面立刻返回，结果靠轮询取回），
// 但 `pending` 这个状态如果只放在 Page 的 data 里，一旦页面被销毁（用户返回、
// 小程序被回收、从分享卡片重新进入），data 会重置成 false——
// 云函数那边还在跑，页面却已经显示「还没有报告」，用户以为没提交成功，于是重复点击、
// 白白消耗额度。这个坑在真机上必现，开发者工具里很难复现。
//
// 所以把标记落到 Storage：进入页面先读回来，再决定要不要显示「正在生成」。
// 这里只存**什么时候开始提交**和**提交时的基准版本**，不存任何报告内容，
// 真正的结果永远以云端为准（轮询到新版本才渲染）。
//
// TTL 的作用：标记只应该活到「这次生成该出结果」为止。超过 TTL 还没结果，
// 说明这次生成已经黄了（云函数报错 / 超时 / 被回收），再显示「正在生成」就是骗人，
// 所以到点自动失效，页面回到正常空态。

const KEY = 'genstate';
const TTL = 10 * 60 * 1000;        // 10 分钟：正常生成十几秒~1 分钟，10 分钟足够宽松

function readAll() {
  try {
    const v = wx.getStorageSync(KEY);
    return (v && typeof v === 'object') ? v : {};
  } catch (e) { return {}; }
}

function writeAll(o) {
  try { wx.setStorageSync(KEY, o); } catch (e) { /* 存储失败不该影响主流程 */ }
}

/**
 * 标记「某类生成正在跑」。
 * @param {string} kind生成类型，'profile'（深度报告）/ 'persona'（个人画像）
 * @param {number} from 提交那一刻的基准版本（profile 用 updatedAt，persona 用 rev）。
 *                     轮询时用它判断「结果是不是新的」，避免把旧数据当新结果显示。
 */
function markStart(kind, from) {
  const all = readAll();
  all[kind] = { at: Date.now(), from: (from || 0) };
  writeAll(all);
}

/** 读回标记；不存在或已过期返回 null。 */
function peek(kind) {
  const it = readAll()[kind];
  if (!it || !it.at) return null;
  if (Date.now() - it.at > TTL) { clear(kind); return null; }
  return it;
}

function clear(kind) {
  const all = readAll();
  if (all[kind]) { delete all[kind]; writeAll(all); }
}

module.exports = { markStart, peek, clear, TTL };