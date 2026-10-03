// utils/ui.js —— 与「原生 UI（胶囊 / 屏幕）」相关的一次性常量
//
// 胶囊矩形在整个会话里是固定的（竖屏 + 自定义导航），但 wx.getMenuButtonBoundingClientRect()
// 在页面切换的瞬间可能返回 0 或「看起来合理但错位」的值——各页 / 各组件各自去查，
// 谁赶上切换谁就被带偏（表现为：程序名不在胶囊下、跑到了主题圆点的位置）。
// 所以这里取到一份「看起来合理」的就缓存起来，之后所有页面 / 组件都用这一份。

let _rect = null;

// 矩形是否「看起来合理」：宽高为正、没有贴到屏幕左缘 / 顶端（胶囊永远留有边距与状态栏高度）
function plausible(mb, winW) {
  return !!(mb && mb.width > 0 && mb.height > 0
    && mb.top > 0 && mb.left > 0
    && mb.left + mb.width <= winW + 1);
}

// 返回 { top, left, width, height, windowWidth }；取不到合理值时返回 null（调用方保留旧值）
function capsuleRect() {
  if (_rect) return _rect;
  try {
    const mb = wx.getMenuButtonBoundingClientRect && wx.getMenuButtonBoundingClientRect();
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    if (plausible(mb, info.windowWidth)) {
      _rect = { top: mb.top, left: mb.left, width: mb.width, height: mb.height, windowWidth: info.windowWidth };
    }
  } catch (e) { /* 取不到就不缓存，下次再试 */ }
  return _rect;
}

module.exports = { capsuleRect };
