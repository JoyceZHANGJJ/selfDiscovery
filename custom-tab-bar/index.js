const store = require('../utils/store.js');

// 快捷记待办：记录的时间只存 HH:MM（与 store.normTime 的输出一致；「今天 / 非今天」的显示交给 taskTime）
function hhmm(ts) {
  const d = new Date(ts);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

// 快捷记能记哪几种（按这个顺序轮换）：待办 + 随记（一句话想法）。
// 购物不在这里：球是「随手记一条」的入口，买东西另有清单页的「购物」一栏去记。
// 待办的类别不写死，实时取选项池（跟着 todoKindDefault：锁定的「备忘」，改名 / 增删后自动跟上），
// 所以「✎ 管理」里把默认类别改名后，球上显示的名字与写进 ext 的类别都会跟着变
const QA_KINDS = ['todo', 'jot'];
function qaInfo(k) {
  if (k === 'jot') return { k: 'jot', cat: '', n: '随记', ph: '想记点什么', c: store.mcolor('jot') };
  const cat = (store.todoKindDefault() || [])[0] || '备忘';
  return { k: 'todo', cat, n: cat, ph: '要记住什么', c: store.catColor(cat) };
}
const QA_DEF = qaInfo('todo');   // 初始展示（面板每次展开时会重新算一遍）

Component({
  options: { addGlobalClass: true },
  data: {
    selected: 0,
    theme: 'mint',
    hidden: false,
    pulse: false,   // 回顶时图标轻弹一次
    hint: false,    // 滑到底部时图标跳动提示可回顶
    list: [
      { pagePath: '/pages/index/index', text: '记', icon: '✎' },
      { pagePath: '/pages/look/look', text: '看', icon: '☰' },
      { pagePath: '/pages/review/review', text: '回看', icon: '◎' },
      { pagePath: '/pages/set/set', text: '设置', icon: '⚙' }
    ],
    // 快捷记待办（「＋」球）：点球就在原地弹条，不跳页；长按球才进清单页
    qa: false,           // 面板是否展开
    // 目标：todo | jot（面板上显示 待办类别 / 随记）。每次展开都回到第一个（待办）——
    // 球本身就是「随手记一条」的默认入口，不记住上次切换的（切换只在本次面板打开期间有效）
    qaM: 'todo',
    qaName: QA_DEF.n,    // 目标的名字 / 占位符 / 色点（随切换、以及选项池改名/增删一起更新）
    qaPh: QA_DEF.ph,
    qaC: QA_DEF.c,
    qaTxt: '',
    qaFocus: false,      // 输入框是否聚焦：打开面板不自动聚焦（不弹键盘），点输入框才弹；失焦即收起面板
    qaUndo: null,        // 刚记下的那条（给一次撤销）
    // 面板底边距：默认落在球的正上方；键盘弹出时改成键盘高度（见 attached）
    qaBottom: 'calc(178px + env(safe-area-inset-bottom, 0px))'
  },

  lifetimes: {
    attached() {
      // 选项池可能在别处被改名 / 增删：组件每次加载都把默认目标的展示重算一遍
      const d = qaInfo(QA_KINDS[0]);
      this.setData({ qaM: d.k, qaName: d.n, qaPh: d.ph, qaC: d.c });
      // 吸底面板要跟着键盘走：页面级滚动下微信不会缩小视口（而是滚动页面让输入框可见），
      // 所以直接把键盘高度当 bottom，面板始终落在键盘上方（与记页吸底操作行同一套做法）
      this._kbHandler = (res) => {
        const h = (res && res.height) || 0;
        this.setData({ qaBottom: h > 0 ? (h + 10) + 'px' : 'calc(178px + env(safe-area-inset-bottom, 0px))' });
      };
      if (wx.onKeyboardHeightChange) wx.onKeyboardHeightChange(this._kbHandler);
    },
    detached() {
      if (wx.offKeyboardHeightChange && this._kbHandler) wx.offKeyboardHeightChange(this._kbHandler);
      this._kbHandler = null;
      if (this._qaUndoTimer) clearTimeout(this._qaUndoTimer);
      if (this._qaBlurTimer) clearTimeout(this._qaBlurTimer);
    }
  },
  methods: {
    // 当前页是否处于编辑态（以页面自身的 editing 为准，避免两份状态不同步导致锁死）
    isEditing() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      return !!(page && page.data && page.data.editing);
    },
    // 编辑态被拦：不跳转，让当前页把「保存修改」滚到屏幕中间
    blocked() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && typeof page.scrollSaveToCenter === 'function') page.scrollSaveToCenter();
      // 优先复用页面的提示（内部会先 hideToast，保证连续点击每次都弹）
      if (page && typeof page.tipSaveFirst === 'function') { page.tipSaveFirst(); return; }
      if (wx.hideToast) wx.hideToast();
      wx.showToast({ title: '请先保存修改或取消', icon: 'none', duration: 800 });
    },
    switchTab(e) {
      if (this.isEditing()) { this.blocked(); return; }
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
      wx.switchTab({ url: path });
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
      this.closeQa();
      wx.navigateTo({ url: '/pages/list/list' });
    },

    openQa() {
      this._qaStopUndoTimer();
      this._qaCancelBlurClose();
      // 不重置 qaTxt：上一次是被「收起键盘」收走的草稿要继续能写（主动收起走 closeQa 会清掉）
      // 也**不自动聚焦**：弹键盘会顶动页面、打断正在看的内容；要输的时候点一下输入框就够了
      // 目标每次都回到待办：默认入口就是它，不记住上次切换的（切换只在本次打开期间有效）
      // 类别每次重新取选项池：改名 / 增删后自动跟上
      const d = qaInfo(QA_KINDS[0]);
      this.setData({ qa: true, qaFocus: false, qaUndo: null, qaM: d.k, qaName: d.n, qaPh: d.ph, qaC: d.c });
    },
    closeQa(keepDraft) {
      this._qaCancelBlurClose();
      if (!this.data.qa && !this.data.qaFocus) return;
      this.setData(keepDraft ? { qa: false, qaFocus: false } : { qa: false, qaFocus: false, qaTxt: '' });
    },
    /* 输入框失焦就收起面板：面板是「跟着键盘的输入条」，键盘一收（系统收起键、下滑收起、点别处）
       它不该继续悬在页面角上；顺手把页面滚动还给用户（遮罩没了才能正常滚）。
       已输入的文字留着（keepDraft），再点「＋」还能接着写；主动收起（点别处 / 点 ×）才清空。 */
    onQaBlur() {
      this._qaCancelBlurClose();
      this._qaBlurTimer = setTimeout(() => {
        this._qaBlurTimer = null;
        if (this.data.qa) this.closeQa(true);
      }, 180);
    },
    // 面板内部的点击（切换模块等）会先让输入框失焦：延后一点关闭，并允许被取消
    _qaCancelBlurClose() { if (this._qaBlurTimer) { clearTimeout(this._qaBlurTimer); this._qaBlurTimer = null; } },
    onQaInput(e) { this.setData({ qaTxt: e.detail.value }); },
    /* 点到面板 / 撤销条以外的任何地方（含页面空白、记录行、记录操作条、球）：都收起。
       与「记录操作条」同一套心智（见记页 clearFloats）；键盘是系统层，不会走到这里，所以打字不受影响。 */
    onMaskTap() {
      if (this.data.qa) { this.closeQa(); return; }
      this.dismissUndo();
    },
    // 收起「已记入 …」撤销条（点它处、或 3.2 秒后自动走这里）
    dismissUndo() {
      if (!this.data.qaUndo) return;
      this._qaStopUndoTimer();
      this.setData({ qaUndo: null });
    },
    /* 目标轮换：待办 → 随记 → 待办（待办显示的是选项池里的默认类别名） */
    onQaSwitch() {
      // 点标签本身不算「收键盘」：先取消失焦收起，再切目标（否则面板会被自己关掉）
      this._qaCancelBlurClose();
      const focused = this.data.qaFocus;
      const i = QA_KINDS.indexOf(this.data.qaM);
      const nx = qaInfo(QA_KINDS[(i + 1) % QA_KINDS.length]);
      this.setData({ qaM: nx.k, qaName: nx.n, qaPh: nx.ph, qaC: nx.c, qaFocus: false });
      // 点标签会让输入框失焦、键盘收起：如果刚才正在输入，切完把焦点还回去，好接着打字
      if (focused) setTimeout(() => { if (this.data.qa) this.setData({ qaFocus: true }); }, 40);
    },
    goList() { this.closeQa(); wx.navigateTo({ url: '/pages/list/list' }); },

    /* 回车（或点「记下」）即落库：不跳页、不清键盘，方便连着记几条 */
    onQaSave() {
      const txt = (this.data.qaTxt || '').trim();
      if (!txt) { wx.showToast({ title: '先写点什么', icon: 'none' }); return; }
      const info = qaInfo(this.data.qaM);
      this._qaCancelBlurClose();   // 收起输入框本身会触发失焦：这里已经要关了，别再排一次
      const ts = Date.now();
      // 待办：把类别写进 ext（src=todoKind）；随记没有类别
      const rec = { m: info.k, txt, ts, t: hhmm(ts), ext: info.cat ? [info.cat] : [], extSrc: info.cat ? ['todoKind'] : [], done: false, doneAt: 0, status: '' };
      store.addRecord(rec).then(rid => {
        rec._rid = rid; rec.id = rid;
        const G = getApp().globalData;
        if (!G.records) G.records = [];
        G.records.unshift(store.decorate(rec));
        this.setData({ qa: false, qaFocus: false, qaTxt: '', qaUndo: { id: rid, txt, name: info.n } });
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
