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

/* 把某个元素对齐到屏幕顶部（切换内容后主动滚一下，像切 tab）。
   看页的换维度 / 换筛选用它（回看翻期是自己 pageScrollTo 回顶，不走这里）。
   记页（换维度）与清单页（换段）刻意**不用**：换的是同一块内容里的一份，
   对齐会把页面往下推一节，看着像整页在跳——停在你滑到的位置更贴合「原地换一份」的手感
   （见 pages/index/index.js 的 onTag、pages/list/list.js 的 onSeg）。
   sel 传区块的标题 / 切换行选择器；拿不到节点就什么都不做（保持原样）。 */
function alignTop(ctx, sel) {
  wx.nextTick(() => {
    // 顶部留出状态栏遮罩（.statusbar-mask）的高度：对齐到它下面，标题 / 卡片才不会被盖住
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    const gap = (info.statusBarHeight || 20) + 8;
    const q = wx.createSelectorQuery().in(ctx);
    q.select(sel).boundingClientRect();
    q.selectViewport().scrollOffset();
    q.exec(res => {
      const rect = res && res[0], off = res && res[1];
      if (!rect || !off) return;
      const top = Math.max(0, Math.round(rect.top + off.scrollTop - gap));
      if (Math.abs(top - off.scrollTop) < 2) return;   // 已经贴顶，不用滚
      wx.pageScrollTo({ scrollTop: top, duration: 0 });
    });
  });
}

module.exports = { capsuleRect, alignTop };
