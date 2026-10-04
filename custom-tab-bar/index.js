const store = require('../utils/store.js');
const date = require('../utils/date.js');

// 快捷记（「＋」球面板）：不切换模块，而是把用户在「设置」里勾选的类别（待办类别 + 随记类别，
// 上限见 store.QUICKCATS_MAX）平铺成 chips（多了自动换行），点哪个就在哪个类别下记。
// 类别实时取选项池（改名 / 增删后自动跟上）；没勾过时给默认（全部待办类别 + 全部随记类别）。
function catInfo(qc) {
  if (qc.m === 'jot') {
    const cat = qc.cat || (store.jotKindDefault() || [])[0] || '念头';
    return { k: 'jot', src: 'jotKind', cat, n: cat, ph: '想记点什么', c: store.jotColor(cat) };
  }
  const cat = qc.cat || (store.todoKindDefault() || [])[0] || '备忘';
  return { k: 'todo', src: 'todoKind', cat, n: cat, ph: '要记住什么', c: store.catColor(cat) };
}
// 把存储里的快捷类别（{m,cat}）转成面板要的展示结构（带名字 / 颜色 / 占位符 / key），
// 并过滤掉已从选项池里消失的类别（待办类别看 todoKind、随记类别看 jotKind）。
// 空了则兜底一个默认待办类别。
function buildQaCats() {
  const pool = store.getOPT('todoKind') || [];
  const jpool = store.getOPT('jotKind') || [];
  let cats = (store.getQuickCats() || []).map(qc => {
    const info = catInfo(qc);
    return { key: (qc.m === 'jot' ? 'jot:' : 'todo:') + info.cat, m: info.k, src: info.src, cat: info.cat, n: info.n, c: info.c, ph: info.ph };
  }).filter(qc => qc.m !== 'todo' || pool.indexOf(qc.cat) >= 0)
    .filter(qc => qc.m !== 'jot' || jpool.indexOf(qc.cat) >= 0);
  // 顺序以排列为准：待办类别按 todoKind 池顺序，随记类别接在后面按 jotKind 池顺序（不随勾选先后）
  cats.sort((a, b) => {
    const ai = a.m === 'jot' ? (pool.length + jpool.indexOf(a.cat)) : pool.indexOf(a.cat);
    const bi = b.m === 'jot' ? (pool.length + jpool.indexOf(b.cat)) : pool.indexOf(b.cat);
    return (ai < 0 ? 1e9 : ai) - (bi < 0 ? 1e9 : bi);
  });
  if (!cats.length) {
    const d = catInfo({ m: 'todo', cat: (store.todoKindDefault() || [])[0] || '备忘' });
    cats = [{ key: 'todo:' + d.cat, m: 'todo', src: d.src, cat: d.cat, n: d.n, c: d.c, ph: d.ph }];
  }
  return cats;
}

Component({
  options: { addGlobalClass: true },
  // ballOnly：只挂「＋」球与快捷记面板、不渲染底部 tab 栏——给清单页这类「非 tab 页」用
  // （它们没有自定义 tabBar，整页本来就没有任何快捷记录入口）
  properties: { ballOnly: { type: Boolean, value: false } },
  data: {
    selected: 0,
    theme: 'mint',
    themeStyle: store.themeStyle('mint'),   // 主题变量（由 theme 观察器刷新）
    hidden: false,
    pulse: false,   // 回顶时图标轻弹一次
    hint: false,    // 滑到底部时图标跳动提示可回顶
    list: [
      { pagePath: '/pages/index/index', text: '记', icon: '✎' },
      { pagePath: '/pages/look/look', text: '看', icon: '☰' },
      { pagePath: '/pages/review/review', text: '回看', icon: '◎' },
      { pagePath: '/pages/set/set', text: '设置', icon: '⚙' }
    ],
    // 快捷记（「＋」球）：点球就在原地弹条，不跳页；长按球才进清单页
    qa: false,           // 面板是否展开
    qaCats: [],          // 平铺的快捷类别（来自 getQuickCats，带名字 / 颜色 / 占位符 / key）
    qaIdx: 0,            // 当前选中的类别下标
    qaName: '',          // 当前类别名字（撤销条展示用）
    qaPh: '',            // 当前类别占位符
    qaC: '',             // 当前类别色点
    qaTxt: '',
    qaFocus: false,      // 输入框是否聚焦：打开面板不自动聚焦（不弹键盘），点输入框才弹；失焦即收起面板
    qaUndo: null,        // 刚记下的那条（给一次撤销）
    // 面板底边距：默认落在球的正上方；键盘弹出时改成键盘高度（见 attached）
    qaBottom: 'calc(178px + env(safe-area-inset-bottom, 0px))'
  },

  // theme 一变就重算注入变量（各页与切换器只需 setData({ theme })）
  observers: {
    theme(k) { this.setData({ themeStyle: store.themeStyle(k) }); }
  },

  lifetimes: {
    attached() {
      // 主题：tab 页会在 onShow 里 setData({theme}) 推过来；挂在清单页（ballOnly）时没人推，
      // 所以这里按当前主题先初始化一次，免得球与面板用默认主题的配色。
      // 平铺类别也每次重算一遍：选项池可能在别处被改名 / 增删
      const t = store.curTheme();
      const cats = buildQaCats();
      const a = cats[0] || {};
      this.setData({ theme: t, themeStyle: store.themeStyle(t), qaCats: cats, qaIdx: 0, qaName: a.n, qaPh: a.ph, qaC: a.c });
      // 吸底面板要跟着键盘走：页面级滚动下微信不会缩小视口（而是滚动页面让输入框可见），
      // 所以直接把键盘高度当 bottom，面板始终落在键盘上方（与记页吸底操作行同一套做法）
      this._bindKb();
    },
    detached() {
      if (wx.offKeyboardHeightChange && this._kbHandler) wx.offKeyboardHeightChange(this._kbHandler);
      this._kbHandler = null;
      if (this._qaUndoTimer) clearTimeout(this._qaUndoTimer);
      if (this._qaChipFocusTimer) clearTimeout(this._qaChipFocusTimer);
    }
  },
  // 每次切回本页都重新绑一次：有些基础库只保留最后注册的那一个监听，
  // 别处（记页 onLoad）注册过之后，我们这条可能就收不到键盘高度了
  pageLifetimes: {
    show() { this._bindKb(); }
  },
  methods: {
    /* 键盘高度 → 面板底边距：面板自己抬到键盘上方 10px，键盘收起就回到球的上方 */
    _applyKb(h) {
      h = Math.max(0, Math.round(h || 0));
      this._kbH = h;
      this.setData({ qaBottom: h > 0 ? (h + 10) + 'px' : 'calc(178px + env(safe-area-inset-bottom, 0px))' });
    },
    /* 绑 / 重绑全局键盘监听（先 off 再 on，避免切页回来重复注册） */
    _bindKb() {
      if (!wx.onKeyboardHeightChange) return;
      if (!this._kbHandler) this._kbHandler = (res) => this._applyKb((res && res.height) || 0);
      if (wx.offKeyboardHeightChange) wx.offKeyboardHeightChange(this._kbHandler);
      wx.onKeyboardHeightChange(this._kbHandler);
    },
    /* 输入框自带的键盘高度事件——**真正可靠的那一路**：
       全局那条在部分机型上不派发（记页也是这么兜的），而这里一定跟着这个输入框的键盘走。
       回看整页是 scroll-view（页面本身不滚），微信的 adjust-position 顶不动页面，
       只靠全局那条就会出现「面板留在原位、被键盘盖住」（其它页是被微信顺手顶上去才看着没事） */
    onQaKb(e) { this._applyKb((e && e.detail && e.detail.height) || 0); },
    // 当前页是否处于编辑态（以页面自身的 editing 为准，避免两份状态不同步导致锁死）
    isEditing() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      return !!(page && page.data && page.data.editing);
    },
    // 编辑态被拦：不跳转，只提示先处理当前编辑
    blocked() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      // 优先复用页面的提示（内部会先 hideToast，保证连续点击每次都弹）
      if (page && typeof page.tipSaveFirst === 'function') { page.tipSaveFirst(); return; }
      if (wx.hideToast) wx.hideToast();
      wx.showToast({ title: '请先保存修改或取消', icon: 'none', duration: 800 });
    },
    switchTab(e) {
      if (this.isEditing()) { this.blocked(); return; }
      // 快捷记面板开着时点 tab：先把面板收起（输入组件失焦后，点哪里都应该收起），再正常切页
      if (this.data.qa) this.closeQa();
      if (this.data.qaUndo) this.dismissUndo();
      const idx = e.currentTarget.dataset.index;
      // 再点一次「当前所在」的 tab：不跳转，让当前页回到顶部（页面实现 onTabReselect）
      if (idx === this.data.selected) {
        const pages = getCurrentPages();
        const page = pages[pages.length - 1];
        if (page && typeof page.onTabReselect === 'function') {
          page.onTabReselect();
          this.pulse();   // 回顶成功才给反馈
        }
        return;
      }
      const path = this.data.list[idx].pagePath;
      wx.switchTab({
        url: path,
        success: () => {
          // 切到别的 tab：目标页恢复初始状态（维度 / 筛选 / 视图回到默认）并回顶。
          // 页面实现了 resetToInitial 就走它，否则退回只回顶（如设置页）。
          setTimeout(() => {
            const pages = getCurrentPages();
            const route = path.replace(/^\//, '');
            const page = pages.find(p => p.route === route) || pages[pages.length - 1];
            if (page && typeof page.resetToInitial === 'function') page.resetToInitial();
            else if (page && typeof page.scrollToTop === 'function') page.scrollToTop();
          }, 30);
        }
      });
      },
    // 图标轻弹一次（回顶后的反馈）：动画结束就移除类，保证下次点击能重播
    pulse() {
      if (this._pulseTimer) clearTimeout(this._pulseTimer);
      this.setData({ pulse: false });
      this._pulseTimer = setTimeout(() => {
        this.setData({ pulse: true });
        this._pulseTimer = setTimeout(() => this.setData({ pulse: false }), 460);
      }, 16);
    },
    // 滑到底部时的提示：图标跳几下 + 指示条闪，暗示「点这里回顶」。
    // 带冷却，避免反复滑到底一直跳
    hint() {
      if (this._hintTimer || this._hintCool) return;
      this.setData({ hint: true });
      this._hintTimer = setTimeout(() => {
        this.setData({ hint: false });
        this._hintTimer = null;
        this._hintCool = setTimeout(() => { this._hintCool = null; }, 8000);
      }, 1750);
    },
    onFab() {
      if (this.isEditing()) { this.blocked(); return; }
      // 点球 = 原地记一条待办（再点一次收起）；清单页入口：长按球，或面板右上角「清单 ›」
      if (this.data.qa) this.closeQa();
      else this.openQa();
    },
    // 长按球 = 进清单页（原来的行为挪到这里，球本身改成「随手记」）
    onFabLong() {
      if (this.isEditing()) { this.blocked(); return; }
      if (this.data.ballOnly) return;   // 球就挂在清单页上：长按不再叠开一层同样的页面
      this.closeQa();
      wx.navigateTo({ url: '/pages/list/list' });
    },

    openQa() {
      this._qaStopUndoTimer();
      // 不重置 qaTxt：上一次没写完的草稿要继续能写（只有主动收起才清，见 closeQa）
      // 也**不自动聚焦**：弹键盘会顶动页面、打断正在看的内容；要输的时候点一下输入框就够了
      // 类别每次重新取选项池：改名 / 增删后自动跟上，并过滤掉已删的类别
      const cats = buildQaCats();
      const a = cats[0] || {};
      this.setData({ qa: true, qaFocus: false, qaUndo: null, qaCats: cats, qaIdx: 0, qaName: a.n, qaPh: a.ph, qaC: a.c });
      // 位置按**当前**键盘状态给：不能沿用上一次记下的键盘高度——键盘已经收了、面板还按旧高度
      // 悬在页面中间（这就是「再打开位置变了」）。键盘真在的话，点输入框那一下会再来一次高度事件
      this._applyKb(0);
    },
    closeQa(keepDraft) {
      if (!this.data.qa && !this.data.qaFocus) return;
      this.setData(keepDraft ? { qa: false, qaFocus: false } : { qa: false, qaFocus: false, qaTxt: '' });
      this._applyKb(0);   // 收起后面板不再需要跟着键盘，位置状态归位
    },
    // 点面板自身空白区（标题 / chips 行空白）：没在输入时收起；**输入中不动它**——
    // 写到一半顺手点一下面板空白（很常见）不该把整个面板收掉。收起走「点面板以外」或「点 × 球」
    onQaBgTap() { if (this.data.qa && !this.data.qaFocus) this.closeQa(); },
    onQaNoop() {},
    /* 输入框失焦：**不再顺手收起面板**。
       以前一失焦（键盘被系统收起 / 下滑收起 / 误触）整个面板就消失，写到一半的内容被打断；
       现在只把「焦点」与「位置」归位，面板留着、草稿留着——想接着写，点一下输入框就行。
       收起只剩这几处主动操作：点面板以外（onMaskTap）、点 × 球、切 tab、记下。 */
    onQaBlur() {
      // 刚点过类别 chip：这次失焦是「换类别」带来的，键盘还在，焦点与位置都别动（见 onQaChip）
      if (this._qaChipAt && Date.now() - this._qaChipAt < 600) return;
      this.setData({ qaFocus: false });
      this._applyKb(0);   // 失焦＝键盘要走了：位置回到球的上方，别按旧高度悬在半空
    },
    onQaInput(e) { this.setData({ qaTxt: e.detail.value }); },
    /* 点到面板 / 撤销条以外的任何地方（含页面空白、记录行、记录操作条、球）：都收起。
       与「记录操作条」同一套心智（见记页 clearFloats）；键盘是系统层，不会走到这里，所以打字不受影响。 */
    onMaskTap() {
      if (this.data.qa) { this.closeQa(); return; }
      this.dismissUndo();
    },
    /* 面板开着时，在面板以外做任何操作（点按 / 上下滚动页面）都收起。
       保留草稿（keepDraft）：滚动多半只是想看看别处，不该把手打的字清掉。 */
    onMaskTouch() { if (this.data.qa) this.closeQa(true); },
    // 收起「已记入 …」撤销条（点它处、或 3.2 秒后自动走这里）
    dismissUndo() {
      if (!this.data.qaUndo) return;
      this._qaStopUndoTimer();
      this.setData({ qaUndo: null });
    },
    /* 点类别 chip：切换「当前要记的类别」。**不动输入框里已经写的内容**——
       先写完、再决定归到哪一类是最自然的顺序（草稿只在主动收起面板时才清，见 closeQa）。
       输入框正开着（键盘弹着）时这一下也不能把面板关掉：点 chip 会让输入框失焦，
        所以①记下这次点击，让随之而来的失焦不动这一下（见 onQaBlur 的守卫）；
       ②把焦点收回来（键盘不闪断）。 */
    onQaChip(e) {
      const i = +e.currentTarget.dataset.i;
      if (i === this.data.qaIdx) return;
      const a = this.data.qaCats[i] || {};
      const keepFocus = !!this.data.qaFocus;
      this._qaChipAt = Date.now();
      this.setData({ qaIdx: i, qaName: a.n, qaPh: a.ph, qaC: a.c });
      if (!keepFocus) return;
      if (this._qaChipFocusTimer) clearTimeout(this._qaChipFocusTimer);
      this._qaChipFocusTimer = setTimeout(() => {
        this._qaChipFocusTimer = null;
        if (this.data.qa) this.setData({ qaFocus: true });   // 失焦是刚才那下点击的副作用，收回来
      }, 30);
    },
    /* 回车（或点「记下」）即落库：不跳页、不清键盘，方便连着记几条 */
    onQaSave() {
      const txt = (this.data.qaTxt || '').trim();
      if (!txt) { wx.showToast({ title: '先写点什么', icon: 'none' }); return; }
      const a = this.data.qaCats[this.data.qaIdx] || {};
      const ts = Date.now();
      // 待办 / 随记：把类别写进 ext（src=todoKind / jotKind）
      const rec = { m: a.m, txt, ts, t: date.hhmm(ts), ext: a.cat ? [a.cat] : [], extSrc: a.cat ? [a.src || 'todoKind'] : [], done: false, doneAt: 0, status: '' };
      store.addRecord(rec).then(rid => {
        rec._rid = rid; rec.id = rid;
        const G = getApp().globalData;
        if (!G.records) G.records = [];
        G.records.unshift(store.decorate(rec));
        this.setData({ qa: false, qaFocus: false, qaTxt: '', qaUndo: { id: rid, txt, name: store.recMname(rec) } });
        this.notifyPage();
        this._qaStartUndoTimer();
      }).catch(() => wx.showToast({ title: '没记上，再试一次', icon: 'none' }));
    },
    /* 撤销：把刚记下的那条删掉（与其它页的删除撤销是同一套心智） */
    onQaUndo() {
      const u = this.data.qaUndo; if (!u) return;
      this._qaStopUndoTimer();
      this.setData({ qaUndo: null });
      const G = getApp().globalData;
      const arr = G.records || [];
      const i = arr.findIndex(r => r.id === u.id);
      const rec = i >= 0 ? arr[i] : null;
      if (rec) {
        store.deleteRecord(rec).catch(() => {});
        arr.splice(i, 1);
      }
      this.notifyPage();
      wx.showToast({ title: '已撤销', icon: 'none' });
    },
    _qaStartUndoTimer() {
      this._qaStopUndoTimer();
      this._qaUndoTimer = setTimeout(() => { this._qaUndoTimer = null; this.setData({ qaUndo: null }); }, 3200);
    },
    _qaStopUndoTimer() { if (this._qaUndoTimer) { clearTimeout(this._qaUndoTimer); this._qaUndoTimer = null; } },

    /* 记完让当前页自己刷新（各 tab 页按需实现 onQuickTodo；没实现就等下次 onShow） */
    notifyPage() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && typeof page.onQuickTodo === 'function') page.onQuickTodo();
    }
  }
});
