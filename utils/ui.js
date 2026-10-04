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

/* ============================================================================
   输入层已知坑 —— 改输入相关的东西之前先看一遍，避免回归（可优化点 N9①）
   ----------------------------------------------------------------------------
   1) 整页必须是**页面级滚动**（内容不能套在 scroll-view 里）：
      页面滚动时微信会同步原生输入层的位置；套 scroll-view 时不同步，安卓上光标 / 文字
      会飘出输入框。另一个副作用：页面本身不滚时，wx.pageScrollTo 与 adjust-position
      都顶不动它（回看以前是 scroll-view：回顶全是空操作、快捷记面板被键盘盖住）。

   2) input / textarea 三件套（见各页 wxml）：
      · always-embed="{{true}}"     强制原生输入，滚动时才跟得住
      · adjust-position="{{true}}"  让微信把聚焦的框滚到键盘上方，留出的高度 = cursor-spacing
        ——快捷记面板刻意关掉它：面板位置由我们自己按键盘高度给（custom-tab-bar 的 _applyKb），
          两边都调会抬过头；而且页面顶不动时它也帮不上忙（见第 1 条）
      · cursor-spacing              记页实测操作行高度 + 14（_measureBar），给吸底操作行让位

   3) 键盘高度要听**两路**：
      · 全局 wx.onKeyboardHeightChange（部分机型不派发）
      · 输入框 bindkeyboardheightchange（一定跟着这个输入框走，是兜底的那一路）
      并且**每次切回页面重新绑一次**——有些基础库只保留最后注册的那一个监听。

   4) 聚焦要「两步走」+ 延后：手指抬起的瞬间微信会把刚聚焦的框 blur 掉，
      所以先渲染未聚焦的框、滚到位，再延后 60ms（手势）/ 500ms（长按）聚焦。

   5) 失焦要「延后 / 忽略」：刚聚焦的这一下，个别机型会先报一次键盘高度 0，
      直接当成「键盘收起」会把操作行收回去（表现为闪一下就没了）——800ms 内忽略。

   6) 吸底操作行有两套形态（记页）：卡内 sticky ↔ 真 fixed（贴键盘上方）。
      **只在真的会被盖住时才切**：先按记卡下沿推算它的自然位置，再与
      「键盘上沿 / cursor-spacing 净空」比，没被盖住就保持卡内形态不动。

   7) 滚动时要补位：onPageScroll 里 120ms 节流，重算聚焦框与操作行的关系。

   延时一览（都是当时调出来的，改一处容易回归另一处；N9② 建议收成常量）：
      键盘 320（高度变化后重算）/ 800（忽略这段时间内的「高度 0」）/ 220（失焦忽略）
      聚焦 60（手势）/ 500（长按）/ 180 + 460（补位两次）
      切段 / 切维度 60（延后）+ 400（行内动作到达就撤销）
      误存保护 400、滚动节流 120、撤销条 3000 / 3200
      快捷记 chip 30（失焦后收回焦点）/ 180（收起）/ 600（换类别窗口）
      store.ensureAll 并发等待轮询 120
   ========================================================================== */

module.exports = { capsuleRect, alignTop };
