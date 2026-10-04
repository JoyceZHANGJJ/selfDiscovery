// utils/swipe.js —— 极简「左右滑动」识别（记卡 / 清单 / 看 / 回看 共用）
// 用法：容器上 bindtouchstart="onSwipeStart" bindtouchend="onSwipeEnd"，页面里：
//   onSwipeStart(e) { swipe.start(this, e); }
//   onSwipeEnd(e) { const d = swipe.end(this, e); if (d) this.stepDim(d); }
// 只在「横向位移够大、且明显大于纵向」时判为滑动，避免与页面纵向滚动打架。
// 返回：'left'（向左滑 → 下一个）/ 'right'（向右滑 → 上一个）/ ''（不算滑动）。
const MIN_DX = 45;   // 横向至少滑动这么多像素才算
const RATIO = 1.3;   // 横向位移至少要达到纵向位移的这个倍数
// 行内左滑的「起手区」宽度（px）：只有从行尾这一小段起手的横滑才判给行内（改这一条），
// 其余横滑留给上层（切 最近/待办/已完成、切维度）——行铺满屏幕，不这样分层上层就没法触发
const EDGE_W = 88;

function start(ctx, e) {
  const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
  if (!t) { ctx._swX = null; return; }
  ctx._swX = t.clientX;
  ctx._swY = t.clientY;
}

// 只算方向、不动起点：行内滑动要「先看一眼是不是自己的，不是就原样留给上层」时用
function dir(ctx, e) {
  if (ctx._swX == null) return '';
  // e 允许缺省（如代码里「兜底再试一次」的调用）：没有坐标就当没滑
  const t = e && ((e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]));
  if (!t) return '';
  const dx = t.clientX - ctx._swX, dy = t.clientY - ctx._swY;
  if (Math.abs(dx) < MIN_DX || Math.abs(dx) < Math.abs(dy) * RATIO) return '';
  return dx < 0 ? 'left' : 'right';
}

function end(ctx, e) {
  if (ctx._swX == null) return '';
  const d = dir(ctx, e);
  ctx._swX = ctx._swY = null;
  return d;
}

// 这次触摸的起点 x（视口坐标：页面级滚动下横向不滚，clientX 就是行内位置）
function touchX(e) {
  const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
  return t ? t.clientX : null;
}
let _w = 0;
function winW() {
  if (!_w) { const i = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()); _w = i.windowWidth || 375; }
  return _w;
}
// 起点是否落在「行尾」那一小段（行尾起手才把横滑判给行内）
function atEdge(e) { const x = touchX(e); return x != null && x >= winW() - EDGE_W; }

module.exports = { start, end, dir, atEdge, EDGE_W };
