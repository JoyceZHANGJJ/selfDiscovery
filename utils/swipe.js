// utils/swipe.js —— 极简「左右滑动」识别（记卡 / 清单 / 看 / 回看 共用）
// 用法：容器上 bindtouchstart="onSwipeStart" bindtouchend="onSwipeEnd"，页面里：
//   onSwipeStart(e) { swipe.start(this, e); }
//   onSwipeEnd(e) { const d = swipe.end(this, e); if (d) this.stepDim(d); }
// 只在「横向位移够大、且明显大于纵向」时判为滑动，避免与页面纵向滚动打架。
// 返回：'left'（向左滑 → 下一个）/ 'right'（向右滑 → 上一个）/ ''（不算滑动）。
const MIN_DX = 45;   // 横向至少滑动这么多像素才算
const RATIO = 1.3;   // 横向位移至少要达到纵向位移的这个倍数

function start(ctx, e) {
  const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
  if (!t) { ctx._swX = null; return; }
  ctx._swX = t.clientX;
  ctx._swY = t.clientY;
}

function end(ctx, e) {
  if (ctx._swX == null) return '';
  const x0 = ctx._swX, y0 = ctx._swY;
  ctx._swX = ctx._swY = null;
  const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
  if (!t) return '';
  const dx = t.clientX - x0, dy = t.clientY - y0;
  if (Math.abs(dx) < MIN_DX || Math.abs(dx) < Math.abs(dy) * RATIO) return '';
  return dx < 0 ? 'left' : 'right';
}

module.exports = { start, end };
