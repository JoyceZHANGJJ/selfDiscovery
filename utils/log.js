// utils/log.js —— 统一错误日志 + 失败提示
// 背景（可优化点 #4）：store 里大量 `.catch(() => resolve([]))` 把错误吞掉，线上问题看不到、定位难。
// 这里提供两个口子：
//   log.err(tag, e, extra) / log.warn(...)：控制台 + 小程序「实时日志」（可在后台按用户查）。
//   log.fail(msg)：关键写入失败时给用户一个可感知的提示（不静默）。
// 约定：store 只负责「记日志 + 把错误抛出去」，要不要给用户弹提示由页面决定（避免底层弹 UI）。

function detail(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  return e.errMsg || e.message || String(e);
}

function realtime(level, tag, e, extra) {
  try {
    const lm = wx.getRealtimeLogManager && wx.getRealtimeLogManager();
    if (!lm) return;
    const args = [tag, detail(e)];
    if (extra !== undefined) args.push(typeof extra === 'string' ? extra : JSON.stringify(extra));
    if (level === 'error') lm.error.apply(lm, args);
    else lm.warn.apply(lm, args);
  } catch (x) { /* 实时日志不可用时忽略 */ }
}

// 错误：控制台 error + 实时日志 error
function err(tag, e, extra) {
  console.error('[' + tag + ']', detail(e), extra === undefined ? '' : extra);
  realtime('error', tag, e, extra);
}

// 警告：控制台 warn + 实时日志 warn（用于「本地兜底已生效」这类非致命问题）
function warn(tag, e, extra) {
  console.warn('[' + tag + ']', detail(e), extra === undefined ? '' : extra);
  realtime('warn', tag, e, extra);
}

// 关键写入失败的统一提示（页面 catch 里调用）
function fail(msg) {
  try { wx.showToast({ title: msg || '没保存上，请重试', icon: 'none' }); } catch (e) {}
}

module.exports = { err, warn, fail };
