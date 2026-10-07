const store = require('../utils/store.js');
const date = require('../utils/date.js');
const tabicons = require('../utils/tabicons.js');

// 底部 tab：ic = 图标名（画法全在 utils/tabicons.js，同一视框 / 同一描边 / 同一视觉尺寸）。
// 顺序与 app.json 的 tabBar.list 必须一致（switchTab 按下标查 pagePath），selected 索引不能错位。
// 记 / 看 / 作息 是每天都要看的（作息一天两回：起床、入睡），回看是周 / 月的复盘，往后放。
const TABS = [
  { pagePath: '/pages/index/index', text: '记', ic: 'write' },
  { pagePath: '/pages/look/look', text: '看', ic: 'look' },
  // 「作息」：半明半暗的圆——一页里装着「起 / 睡」两半，昼夜各半正好是这个 tab 的意思
  { pagePath: '/pages/sleep/sleep', text: '作息', ic: 'rest' },
  { pagePath: '/pages/review/review', text: '回看', ic: 'review' },
  { pagePath: '/pages/set/set', text: '设置', ic: 'set' }
];

// 按主题算一份完整的 list：图标不能靠 CSS 变量上色（<image> 里的 SVG 拿不到 currentColor），
// 所以颜色在这里就写进图里——未选中取该主题的 ink3、选中取 accent。
// 主题一变（各页 onShow 会 setData({theme})）就重算一对，切换时不会有旧色残留。
function tabList(themeKey) {
  const vars = (store.themeOf(themeKey) || {}).vars || {};
  const ic = tabicons.iconsFor(vars.accent, vars.ink3);
  return TABS.map(it => Object.assign({}, it, ic[it.ic] || {}));
}

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
  });
  // 池子没就绪时**先不过滤**：此刻 pool / jpool 是内置默认池（getOPT 的回退），
  // 用户自己加的类别会被它当成「已删除」而静默筛掉——冷启动后第一次点球就少几项，
  // 第二次点又全了（那时 ensureAll 回来了）。宁可先多摆几个，等 _syncQaCats 补完再收。
  if (store.optsReady()) {
    cats = cats.filter(qc => qc.m !== 'todo' || pool.indexOf(qc.cat) >= 0)
      .filter(qc => qc.m !== 'jot' || jpool.indexOf(qc.cat) >= 0);
  }
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

// 快捷记的「优先级」chips（只有待办才有这一格，随记没有）：取选项池 todoPrio，
// 改名 / 增删后自动跟上；颜色与列表里那面小旗同源（store.prioColor）
function buildQaPrios() {
  return (store.getOPT('todoPrio') || []).map(n => ({ n, c: store.prioColor(n) }));
}

/* 「计划完成」那一行的档位不是这里算的——档位表（今天 / 明天 / 本周末 / 下周一 / 无 / 自定义）
   与文字都是 store.dueChips 一份，记卡待办那一行用的是同一个（两处各写一份必然走偏）。
   这里只把键名换成本组件 data 上的名字 */
function dueState(ts) {
  const d = store.dueChips(ts);
  return { qaDueTs: d.ts, qaDues: d.chips, qaDuePick: d.pick };
}
// 默认选中的那档＝默认档「不紧急不重要」（与记卡一致：不点也有值，但列表不插旗）
function qaPrioDefIdx() {
  const prios = buildQaPrios();
  const def = (store.todoPrioDefault() || [])[0] || '';
  const i = prios.findIndex(p => p.n === def);
  return { prios, idx: i >= 0 ? i : Math.max(0, prios.length - 1) };
}
// 面板「新建态」要的那组字段：类别 / 优先级 / 计划完成三行一起归位。
// attached（首帧）与 openQa（点球弹面板）需要的完全一样，写一份免得两处走偏；
// 计划完成固定回「无」——新建一条待办默认没有计划时间，要设得自己点一下
function qaNewFields(cats, a, p) {
  return Object.assign({
    qaCats: cats, qaIdx: 0, qaName: a.n, qaPh: a.ph, qaC: a.c,
    qaPrios: p.prios, qaPrioIdx: p.idx, qaIsTodo: a.m !== 'jot'
  }, dueState(0));
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
    list: tabList(store.curTheme()),   // 图标按当前主题先算一份，免得首帧是空的（attached 再对齐一次）
    // 快捷记（「＋」球）：点球就在原地弹条，不跳页；长按球才进清单页
    qa: false,           // 面板是否展开
    // 编辑模式：非空＝正在改这条记录（回显它的文本 / 类别 / 优先级，保存＝更新而不是新建）
    qaEditId: '',
    qaCats: [],          // 平铺的快捷类别（来自 getQuickCats，带名字 / 颜色 / 占位符 / key）
    qaIdx: 0,            // 当前选中的类别下标
    qaPrios: [],         // 优先级 chips（待办才有；随记类别下这一行不渲染）
    qaPrioIdx: 0,        // 当前选中的优先级下标（默认落在默认档）
    // 计划完成（待办才有，与优先级同一格）：默认 0＝没计划——**这才是常态**，
    // 一条待办本来就不一定有计划时间，所以面板里也不预选任何一档，只能自己点
    qaDueTs: 0,          // 面板里当前选的计划时间戳（0＝没计划）
    qaDues: [],          // 那一行档位 chips（今天 / 明天 / 本周末 / 下周一 / 无 / 自定义）
    qaDuePick: '无',     // 高亮哪一格
    // 「自定义」浮层开没开。月历 / 时刻那些 state 都在 due-sheet 组件里（那边自己管）
    qaDueOpen: false,
    qaIsTodo: true,      // 当前类别是不是待办（决定优先级那一行出不出）
    qaName: '',          // 当前类别名字（撤销条展示用）
    qaPh: '',            // 当前类别占位符
    qaC: '',             // 当前类别色点
    qaTxt: '',
    qaFocus: false,      // 输入框是否聚焦：打开面板不自动聚焦（不弹键盘），点输入框才弹；失焦即收起面板
    qaUndo: null,        // 刚记下的那条（给一次撤销）
    qaSaving: false,     // 写云在途：期间再点「记下」忽略（同一条不该被连点落两遍），按钮同时置灰
    // 面板底边距：默认落在球的正上方；键盘弹出时改成键盘高度（见 attached）
    qaBottom: 'calc(var(--qa-bottom) + env(safe-area-inset-bottom, 0px))'
  },

  // theme 一变就重算注入变量与图标（各页与切换器只需 setData({ theme })）
  observers: {
    theme(k) { this.setData({ themeStyle: store.themeStyle(k), list: tabList(k) }); }
  },

  lifetimes: {
    attached() {
      // 主题：tab 页会在 onShow 里 setData({theme}) 推过来；挂在清单页（ballOnly）时没人推，
      // 所以这里按当前主题先初始化一次，免得球与面板用默认主题的配色。
      // 平铺类别也每次重算一遍：选项池可能在别处被改名 / 增删
      const t = store.curTheme();
      const cats = buildQaCats();
      const a = cats[0] || {};
      const p = qaPrioDefIdx();
      this.setData(Object.assign({ theme: t, themeStyle: store.themeStyle(t), list: tabList(t) }, qaNewFields(cats, a, p)));
      // 吸底面板要跟着键盘走：页面级滚动下微信不会缩小视口（而是滚动页面让输入框可见），
      // 所以直接把键盘高度当 bottom，面板始终落在键盘上方（与记页吸底操作行同一套做法）
      this._bindKb();
      // 选项池往往还在路上（app.js 的 ensureAll 异步）。冷启动那一刻算出来的类别是拿
      // 内置默认池凑的，等真池子到了要重算一次——否则「重新打开后第一次点球类别不全」。
      // attached 只跑一次，所以这次重算是一次性的；用户勾选的类别增减仍由 openQa 每次现算。
      store.onLoaded(() => { this._syncQaCats(); });
    },
    detached() {
      if (wx.offKeyboardHeightChange && this._kbHandler) wx.offKeyboardHeightChange(this._kbHandler);
      this._kbHandler = null;
      if (this._qaUndoTimer) clearTimeout(this._qaUndoTimer);
      if (this._qaChipFocusTimer) clearTimeout(this._qaChipFocusTimer);
      if (this._qaSaveUnlockTimer) clearTimeout(this._qaSaveUnlockTimer);
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
      this.setData({ qaBottom: h > 0 ? (h + 10) + 'px' : 'calc(var(--qa-bottom) + env(safe-area-inset-bottom, 0px))' });
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

    /* 收掉当前页自己的浮层（记录操作条 / 删除撤销条）：两套浮层互不知情，
       面板弹开时页面收不到这次点击（球在遮罩之上），操作条会留在原地——
       「任何一个失焦都收起」的心智要求它们互斥。各页收浮层的入口：
       记 / 看 / 回看是 clearFloats()，清单页是 onBodyTap()（同一件事，名字没统一） */
    closePageFloats() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (!page) return;
      if (typeof page.clearFloats === 'function') page.clearFloats();
      else if (typeof page.onBodyTap === 'function') page.onBodyTap();
    },

    openQa() {
      this.closePageFloats();   // 先收掉页面的操作条 / 撤销条，别和面板叠在一起
      this._qaStopUndoTimer();
      // 不重置 qaTxt：上一次没写完的草稿要继续能写（只有主动收起才清，见 closeQa）
      // 也**不自动聚焦**：弹键盘会顶动页面、打断正在看的内容；要输的时候点一下输入框就够了
      // 类别每次重新取选项池：改名 / 增删后自动跟上，并过滤掉已删的类别
      const cats = buildQaCats();
      const a = cats[0] || {};
      const p = qaPrioDefIdx();
      // qaEditId 一并归零：新建态（＝不是回显改某一条）——保险，正常路径下 closeQa 已经清过
      this.setData(Object.assign({ qa: true, qaFocus: false, qaUndo: null, qaEditId: '', qaDueOpen: false, qaSaving: false }, qaNewFields(cats, a, p)));
      this._qaDueHadFocus = false;   // 面板整个换新：上一轮记下的焦点归属作废
      // 位置按**当前**键盘状态给：不能沿用上一次记下的键盘高度——键盘已经收了、面板还按旧高度
      // 悬在页面中间（这就是「再打开位置变了」）。键盘真在的话，点输入框那一下会再来一次高度事件
      this._applyKb(0);
      // 池子还没到（冷启动那一瞬）也照样开面板：此时 buildQaCats 跳过了过滤，
      // 摆出来的类别只多不少。等 onLoaded 到了自然会重算（见 attached 的订阅），
      // 这里再补一道是因为 attached 那次订阅可能已经触发过了、而池子仍未到。
      if (!store.optsReady()) store.onLoaded(() => { if (this.data.qa) this._syncQaCats(); });
    },
    /* 真池子到了之后把类别重算一遍。保住在选中的那一个（按 key 比，不按下标——
       下标会因补进新类别而错位，用户会看到自己点的类别跳到别的字上），
       也保住已经写了一半的草稿和它聚焦着没有。重算只在 attached 订阅一次里调用。 */
    _syncQaCats() {
      const cats = buildQaCats();
      const key = (this.data.qaCats || [])[this.data.qaIdx] || {};
      let idx = cats.findIndex(c => c.key === key.key);
      if (idx < 0) idx = 0;
      const a = cats[idx] || {};
      const fields = { qaCats: cats, qaIdx: idx, qaName: a.n, qaPh: a.ph, qaC: a.c, qaIsTodo: a.m !== 'jot' };
      // 草稿在就不动优先级那一行：用户可能已经挑过档，别让补数据把他选的冲掉
      if (!this.data.qaTxt) Object.assign(fields, qaPrioDefIdx());
      this.setData(fields);
      // 面板正开着的话，补完可能要换占位符（当前类别的 ph），输入框仍聚焦着就重新对一次
      if (this.data.qa && this.data.qaFocus) this._qaKeepFocus();
    },

    closeQa(keepDraft) {
      if (!this.data.qa && !this.data.qaFocus) return;
      // 编辑模式下不留草稿：那句话是「这一条的内容」，留着再点球就成了新建一条同样的
      if (this.data.qaEditId) keepDraft = false;
      this._qaRec = null;
      if (this._qaEditFocusTimer) { clearTimeout(this._qaEditFocusTimer); this._qaEditFocusTimer = null; }
      this.setData(keepDraft
        ? { qa: false, qaFocus: false, qaEditId: '', qaDueOpen: false }
        : { qa: false, qaFocus: false, qaTxt: '', qaEditId: '', qaDueOpen: false });
      this._qaDueHadFocus = false;
      this._applyKb(0);   // 收起后面板不再需要跟着键盘，位置状态归位
    },

    /* 左滑「改这一条」：打开同一个面板，但回显这条记录的内容（文本 / 类别 / 优先级），
       保存时更新原记录（时间不动）。以前那个行内编辑器只有一个输入框，改不了类别与优先级 */
    openQuickEdit(rec) {
      if (!rec) return;
      const m = rec.m === 'jot' ? 'jot' : 'todo';
      // 只留同类类别：改类别不该把一条待办变成随记（模块变了，记录会整个挪到另一个维度）
      const cats = buildQaCats().filter(c => c.m === m);
      const cur = m === 'jot' ? store.jotCat(rec) : store.taskCat(rec);
      let idx = cats.findIndex(c => c.cat === cur);
      if (idx < 0) {
        // 这条的类别没勾进快捷类别（或后来删了）：临时插在最前面，否则回显不出来
        const info = catInfo({ m, cat: cur });
        cats.unshift({ key: (m === 'jot' ? 'jot:' : 'todo:') + cur, m, src: info.src, cat: cur, n: info.n, c: info.c, ph: info.ph });
        idx = 0;
      }
      const prios = buildQaPrios();
      const cp = store.taskPrio(rec);
      let pi = prios.findIndex(p => p.n === cp);
      if (pi < 0) {
        if (cp) { prios.unshift({ n: cp, c: store.prioColor(cp) }); pi = 0; }   // 改名后的旧档位
        else pi = qaPrioDefIdx().idx;                                          // 老记录没有这一格
      }
      const a = cats[idx] || {};
      this._qaRec = rec;                 // 记录引用留在这儿（不进 data：整个对象没必要参与渲染）
      this.closePageFloats();            // 先收掉页面的操作条 / 撤销条，别和面板叠在一起
      this._qaStopUndoTimer();
      this.setData(Object.assign({
        qa: true, qaFocus: false, qaUndo: null, qaEditId: rec.id, qaTxt: rec.txt || '',
        qaDueOpen: false,
        qaCats: cats, qaIdx: idx, qaName: a.n, qaPh: a.ph, qaC: a.c,
        qaPrios: prios, qaPrioIdx: pi, qaIsTodo: m !== 'jot'
      // 计划完成也回显：随记没有这一格，一律 0
      }, dueState(m === 'todo' ? (rec.dueTs || 0) : 0)));
      this._qaDueHadFocus = false;   // 换了一条记录：上一轮记下的焦点归属作废
      this._applyKb(0);
      // 意图明确（就是来改这条的），隔一拍自动聚焦——与以前的行内编辑器一致，省一次点击
      if (this._qaEditFocusTimer) clearTimeout(this._qaEditFocusTimer);
      this._qaEditFocusTimer = setTimeout(() => {
        this._qaEditFocusTimer = null;
        if (this.data.qa && this.data.qaEditId) this.setData({ qaFocus: true });
      }, 80);
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
      // 切到随记类别时优先级那一行要收掉（随记没有这一格），切回待办再出来
      this.setData({ qaIdx: i, qaName: a.n, qaPh: a.ph, qaC: a.c, qaIsTodo: a.m !== 'jot' });
      if (!keepFocus) return;
      this._qaKeepFocus();
    },
    /* 面板自己要滚（见 wxss 的 max-height）：滚它的时候别把背后的页面一起带着滚。
       空实现即可——catchtouchmove 只要拦住冒泡，面板自身的滚动照常。 */
    onQaScroll() {},

    /* 点 chips 后把焦点收回来：点 chip 会让输入框失焦，而键盘其实还在——
       不收回来键盘就闪断一下（见 onQaBlur 的守卫） */
    _qaKeepFocus() {
      if (this._qaChipFocusTimer) clearTimeout(this._qaChipFocusTimer);
      this._qaChipFocusTimer = setTimeout(() => {
        this._qaChipFocusTimer = null;
        if (this.data.qa) this.setData({ qaFocus: true });   // 失焦是刚才那下点击的副作用，收回来
      }, 30);
    },
    /* 点优先级 chip：与点类别同一套（不动草稿、键盘不闪断）。
       默认档也照样写进记录（与记卡一致：不点也有值），只是列表里不插旗 */
    onQaPrio(e) {
      const i = +e.currentTarget.dataset.i;
      if (i === this.data.qaPrioIdx) return;
      const keepFocus = !!this.data.qaFocus;
      this._qaChipAt = Date.now();
      this.setData({ qaPrioIdx: i });
      if (!keepFocus) return;
      this._qaKeepFocus();
    },
    /* 计划完成：点一格就设好——这一行的全部意义就是**不弹选择器**。
       点「无」＝把计划取消掉（回到「没计划」这个常态，与不设时是同一种数据）。
       与类别 / 优先级 chip 同一套：不动输入框里已写的内容，键盘也不闪断 */
    onQaDue(e) {
      const k = e.currentTarget.dataset.k;
      // 判「是不是自定义」用 store.DUE_CUSTOM，不写字面量（理由见 pages/index 的 onDueChip）
      if (k === store.DUE_CUSTOM) { this.openQaDue(); return; }
      const keepFocus = !!this.data.qaFocus;
      this._qaChipAt = Date.now();
      this.setData(dueState(k === '无' ? 0 : store.duePresetTs(k)));
      if (keepFocus) this._qaKeepFocus();
    },
/* 「自定义」：面板里唯一会展开一层的地方（要具体到某一天才用得上）。
       月历 + 时刻快捷档都在 due-sheet 组件里（记卡的待办那一行用的是同一个），
       这里只负责开与收；选完由组件的 change 事件把时间戳带回来。
       开这层时面板整块不渲染（见 index.wxml），输入框随之卸载、键盘收掉——
       所以要把「刚才有没有焦点」记下来，收起这层后再还给输入框：
       不还的话 qaFocus 仍是 true，输入框一挂载键盘立刻弹起来，正好挡住月历。 */
openQaDue() {
  this._qaDueHadFocus = !!this.data.qaFocus;
  this.setData({ qaDueOpen: true, qaFocus: false });
},
onQaDueClose() { this._closeQaDue(); },
onQaDueChange(e) {
  const ts = (e.detail && e.detail.ts) || 0;
  this.setData(Object.assign({ qaDueOpen: false }, dueState(ts)));
  this._restoreQaFocus();
},
_closeQaDue() {
  this.setData({ qaDueOpen: false });
  this._restoreQaFocus();
},
_restoreQaFocus() {
  if (!this._qaDueHadFocus) return;
  this._qaDueHadFocus = false;
  this._qaKeepFocus();   // 与点 chip 同一套：失焦是刚才那下点击的副作用，收回来
},

    /* 回车（或点「记下」）即落库：不跳页、不清键盘，方便连着记几条。
       编辑模式（qaEditId 非空）走 _qaUpdate——更新原来那条，不是新建 */
    onQaSave() {
      // 防重入：写云是异步的，回调回来之前面板还开着、文本也还在，
      // 连点两下「记下」会把同一条落两遍（撤销条只能撤掉最后一条，第一条留在这）。
      // 上锁后第二次直接忽略——刻意不给提示：这一下本来就是同一次意图的重复。
      if (this._qaSaving) return;
      if (this.data.qaEditId) { this._qaUpdate(); return; }
      const txt = (this.data.qaTxt || '').trim();
      if (!txt) { wx.showToast({ title: '先写点什么', icon: 'none' }); return; }
      const a = this.data.qaCats[this.data.qaIdx] || {};
      const ts = Date.now();
      // 待办 / 随记：把类别写进 ext（src=todoKind / jotKind）；
      // 待办再多写一份优先级（src=todoPrio）——与记卡同一份结构，清单页排序 / 小旗才认得它。
      // 顺序按 FIELDS.todo（类别 → 优先级），导入与详情都按标签匹配，不受顺序影响
      const ext = [], src = [];
      if (a.cat) { ext.push(a.cat); src.push(a.src || 'todoKind'); }
      if (a.m === 'todo') {
        const prio = (this.data.qaPrios[this.data.qaPrioIdx] || {}).n;
        if (prio) { ext.push(prio); src.push('todoPrio'); }
      }
      // 计划完成：只有待办写（随记没有这一格）；没点过就是 0＝不写这个字段
      const rec = { m: a.m, txt, ts, t: date.hhmm(ts), ext, extSrc: src, done: false, doneAt: 0, status: '', dueTs: a.m === 'todo' ? (this.data.qaDueTs || 0) : 0 };
      this._qaSaving = true;
      this.setData({ qaSaving: true });
      // 兜底解锁：云端卡住不回调时不能让「记下」永远变成死按钮（见 pages/index 的同名兜底）
      if (this._qaSaveUnlockTimer) clearTimeout(this._qaSaveUnlockTimer);
      this._qaSaveUnlockTimer = setTimeout(() => { this._qaSaveUnlockTimer = null; this._qaUnlockSave(); }, 12000);
      store.addRecord(rec).then(rid => {
        this._qaUnlockSave();
        rec._rid = rid; rec.id = rid;
        const G = getApp().globalData;
        if (!G.records) G.records = [];
        G.records.unshift(store.decorate(rec));
        this.setData({ qa: false, qaFocus: false, qaTxt: '', qaUndo: { id: rid, txt, name: store.recMname(rec) } });
        this.notifyPage();
        this._qaStartUndoTimer();
      }).catch(() => { this._qaUnlockSave(); wx.showToast({ title: '没记上，再试一次', icon: 'none' }); });
    },
    _qaUnlockSave() {
      if (this._qaSaveUnlockTimer) { clearTimeout(this._qaSaveUnlockTimer); this._qaSaveUnlockTimer = null; }
      this._qaSaving = false;
      this.setData({ qaSaving: false });
    },
    /* 编辑模式的保存：把面板上的内容写回原记录（文本 + 类别 + 优先级），
       记录时间不动——改的是内容，不是「什么时候记的」。没改动就不落云 */
    _qaUpdate() {
      const txt = (this.data.qaTxt || '').trim();
      if (!txt) { wx.showToast({ title: '先写点什么', icon: 'none' }); return; }
      const rec = this._qaRec;
      if (!rec) { this.closeQa(); return; }
      const a = this.data.qaCats[this.data.qaIdx] || {};
      const src = rec.extSrc || (rec.extSrc = []);
      const ex = rec.ext || (rec.ext = []);
      const before = (rec.txt || '') + '' + ex.join('');
      const dueBefore = rec.dueTs || 0;   // 计划完成也要参与「有没有改动」的判定
      const calBefore = rec.calTs || 0;   // 原「已推日历」标记：改计划时间会被清掉（见 setDue）
      // 按标签定位覆盖写：找得到就改那一格，找不到就补在后面（老记录可能没有优先级那一格）
      const setTag = (s, v) => { const i = src.indexOf(s); if (i >= 0) ex[i] = v; else { src.push(s); ex.push(v); } };
      setTag(a.src || (a.m === 'jot' ? 'jotKind' : 'todoKind'), a.cat);
      if (a.m === 'todo') {
        const prio = (this.data.qaPrios[this.data.qaPrioIdx] || {}).n;
        if (prio) setTag('todoPrio', prio);
        // 走 store.setDue：时间真变了就把「已推日历」清掉——手机日历里那条写的是旧时间，
        // 而小程序读不回也改不了系统日程（见 utils/calendar.js 的能力边界）。
        // 留着标记只会让按钮显示「已推日历」却对不上日程，再点还会被确认框挡住
        store.setDue(rec, this.data.qaDueTs || 0);
      }
      rec.txt = txt;
      // 改动判定连计划完成一起算：只改了计划时间也要落云（文本与 ext 都没动时上面那条比较会是 false）
      const changed = ((rec.txt || '') + '' + (rec.ext || []).join('') !== before)
        || ((rec.dueTs || 0) !== dueBefore);
      // 计划时间变了而且原来推过日历：按钮会回到「推到日历」，
      // 说一句免得以为日历里那条也会跟着改（系统日程读不回来，见 utils/calendar.js）
      const dueChanged = (rec.dueTs || 0) !== dueBefore;
      this.closeQa();
      if (!changed) return;
      store.updateRecord(rec).catch(() => {});
      this.notifyPage();
      wx.showToast({ title: (dueChanged && calBefore) ? '已更新 · 日历需重推' : '已更新', icon: 'none' });
    },
    /* 编辑模式里的「删除」：交给页面自己的删除（它有撤销条，与操作条「删除」同一套）；
       页面没接就直接删——保证删得掉，只是没有撤销条 */
    onQaDel() {
      const id = this.data.qaEditId;
      if (!id) return;
      this.closeQa();
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && typeof page.delRecById === 'function') { page.delRecById(id); return; }
      const G = (typeof getApp === 'function' && getApp()) ? getApp().globalData : {};
      const arr = G.records || [];
      const i = arr.findIndex(r => r.id === id);
      if (i < 0) return;
      store.deleteRecord(arr[i]).catch(() => {});
      arr.splice(i, 1);
      this.notifyPage();
      wx.showToast({ title: '已删除', icon: 'none' });
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
