// pages/index/index.js —— 记
const store = require('../../utils/store.js');
const pageBase = require('../../utils/pageBase.js');
const swipe = require('../../utils/swipe.js');
const date = require('../../utils/date.js');
const vm = require('../../utils/vm.js');
const app = getApp();

// 「有默认值」的选项组：见 ensureModuleDefaults——这几个组进入对应维度时会自动补一个默认值，
// 既然有默认值就不该被点空（再点已选中的那一个＝什么也没发生，保持必选）
// 待办的「优先级」也在内：它与类别一样有默认值，不该被点空（参见 PRIO_DEFAULT）
const REQUIRED_PICK = { wantKind: 1, todoKind: 1, todoPrio: 1, jotKind: 1, obsStart: 1, todayBat: 1 };

function nowStr() {
  const d = new Date();
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
// 时间戳 -> { date:'YYYY-MM-DD', time:'HH:MM' }
function dtStr(ts) {
  if (!ts) return { date: '', time: '' };
  const d = new Date(ts);
  return {
    date: d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2),
    time: ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
  };
}
// 'YYYY-MM-DD' + 'HH:MM' -> { ts, t }
function tsFromDate(dStr, tStr) {
  const p = (dStr || '').split('-').map(Number);
  const q = (tStr || '').split(':').map(Number);
  if (p.length !== 3 || q.length !== 2 || isNaN(p[0])) return { ts: Date.now(), t: nowStr() };
  const ts = new Date(p[0], p[1] - 1, p[2], q[0], q[1], 0, 0).getTime();
  return { ts, t: ('0' + q[0]).slice(-2) + ':' + ('0' + q[1]).slice(-2) };
}
Page(pageBase({
  data: {
    ready: false,
    loadFail: false,     // 首次取数失败（云环境没开 / 网络问题）：撤掉骨架屏，给一个能点的重试
    modules: [],
    tag: 'obs',
    greet: { t: '', s: '' },
    composer: {},
    recent: [],
    recentTab: 'recent',   // 「最近」这一段的切换：'recent'（最近）/ 'done'（已完成的最新十条）
    editing: false,
    focusIdx: -1,
    // 写云在途（点「记下」到云端返回）：期间再点直接忽略，避免同一条被连点落两遍。
    // 同时给按钮一个置灰反馈，见 app.wxss 的 .btn.off
    saving: false,
    // 待办的「计划完成」日历浮层（components/due-sheet，与快捷记面板共用同一个）：
    // dueOpen＝开没开；dueTs＝打开时喂给它的当前值（只在点「自定义」那一刻写一次）
    dueOpen: false,
    dueTs: 0,
    // 维度标签行的「可滚动」渐变提示：只有标签真的超出、右侧还有内容时才显示
    tagFade: false,
    recSel: null,
    recSelRec: null,
    delUndo: null,
    saveUndo: null,       // 刚记下那条的确认条（写清记进了哪里）
    // 吸底操作行（记下 / 保存修改 / 取消）的 bottom：默认抬到底部 tab 栏之上，键盘弹出时再抬到键盘之上
    barBottom: 'calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px))',
    // 输入框的 cursor-spacing：键盘弹出时给吸底操作行让位的高度（≈ 操作行高度 + 余量，
    // 进页后实测一次，见 _measureBar）。微信据此把聚焦的输入框滚到键盘上方，
    // 于是「操作行贴键盘、输入框在操作行上方」
    kbGap: 76,
    barH: 61,             // 吸底操作行的实测高度（见 _measureBar）：_keepFieldAboveBar 算目标位置用
    kbOn: false,          // 键盘是否弹着：弹着时操作行改真 fixed（见 app.wxss 的 .savebar.kb）
    barFollow: false,     // 拿不到键盘高度时的退路：操作行改为「跟着聚焦的输入框」（见 _keepFieldAboveBar）
    // 待办 / 随记长按就地编辑（与清单 / 看页共用的 inline-editor 组件）
    qeOn: false,
    qeFocus: false,       // 显示与聚焦分开：手指抬起后才聚焦（见 onRowTouchend）
    qeId: '',
    qeTxt: '',
    qe: { top: 0, left: 0, width: 0, height: 0 },
    editDate: '',
    editTime: '',
    editCreateLabel: '创建时间',
    todayMaxDate: '',     // 「今日」编辑时 date picker 的日期上限（今天），见 _todayMaxDate
    editHasStart: false,
    editStartDate: '',
    editStartTime: '',
    editHasEnd: false,
    editEndDate: '',
    editEndTime: '',
    editHasAbandon: false,
    editAbandonDate: '',
    editAbandonTime: ''
  },

  st: {
    tag: 'obs', main: '', mainPick: null, pick: {}, typed: {}, free: {},
    // 待办的「计划完成」（记录顶层字段 dueTs，不在 ext 里）：0＝没计划，是常态。
    // 不点就一直是 0，绝不自动补日期；点「无」也能回到 0
    due: 0,
    edit: null, ren: null, optUndo: null,
    startMode: false, completing: false, doing: false, showDoing: false, showDone: false,
    abandoning: false, showAbandon: false, ending: false, focusFree: '',
    todayLocked: null   // 「今日」一日一记：当天已记过时存当天那条（只读锁定态），点「修改」才进编辑
  },

  onLoad() {
    // 吸底操作行要跟着键盘走：页面级滚动下微信不会缩小视口（而是滚动页面让输入框可见），
    // 所以直接把键盘高度当 bottom，操作行始终落在键盘上方
    this._kbHandler = (res) => this._applyKb((res && res.height) || 0);
    if (wx.onKeyboardHeightChange) wx.onKeyboardHeightChange(this._kbHandler);
    this.setData({ todayMaxDate: this._todayMaxDate() });
  },

  // 「今日」编辑时 date picker 的上限＝今天（不能把一日一记记到未来）。
  // 每次进入页面重算：小程序可能长时间挂在后台，跨天了上限要跟着变。
  _todayMaxDate() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  },
  // 只在值真的变了才 setData（避免每次 onShow 都触发一次渲染）
  _refreshTodayMax() {
    const v = this._todayMaxDate();
    if (v !== this.data.todayMaxDate) this.setData({ todayMaxDate: v });
  },

  onUnload() {
    if (wx.offKeyboardHeightChange && this._kbHandler) wx.offKeyboardHeightChange(this._kbHandler);
    if (this._kbTimer) { clearTimeout(this._kbTimer); this._kbTimer = null; }
    if (this._barTimer) { clearTimeout(this._barTimer); this._barTimer = null; }
    if (this._tabHideTimer) { clearTimeout(this._tabHideTimer); this._tabHideTimer = null; }
    if (this._saveUnlockTimer) { clearTimeout(this._saveUnlockTimer); this._saveUnlockTimer = null; }
    this._kbHandler = null;
  },

  onShow() {
    this.ensureTheme();
    this.layoutBrand();
    this._kbH = 0;
    this._clearBarFollow();   // 键盘状态从零开始（上一次离开时的跟随位置不能留）
    this._refreshTodayMax();  // 跨天回来时，「今日」的日期上限要跟着今天走
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 0, theme: store.curTheme() });
    // 「自定义」月历浮层开着时 tab 栏要保持收起（从后台切回来 / 切 tab 回来的那一瞬
    // tabBar 有自己的复位时序，只设一次会被盖回来——所以过一拍再收一次，见 pageBase.setTabHidden）
    if (this.data.dueOpen) this.setTabHidden(true, 300);
    store.ensureAll().then(ok => {
      // 没拉到：撤掉骨架屏、显示可点的重试（以前这里什么都不做，页面会永远停在骨架屏）
      if (!ok) { this.setData({ loadFail: true, ready: true }); return; }
      const mods = this.modulesVM();
      const def = mods.some(m => m.k === 'obs') ? 'obs' : (mods[0] && mods[0].k);
      // 当前选中无效（如删掉了「观察」维度）时，回落到默认：有观察则观察，否则第一个维度
      let cur = this.data.tag;
      if (!mods.some(m => m.k === cur)) { cur = def; this.setData({ tag: def }); }
      this.st.tag = cur;
      // 进入 可做 / 待办 / 随记 时若还没选必选项，补上默认（分类 / 类别；以往靠 onTag 触发，这里兜底）
      this.ensureModuleDefaults(cur);
      // 回到记页且没有待编辑记录时，清掉可能残留的编辑态，避免所有操作一直被拦
      // （从「管理选项」页返回、以及**从后台回来**时除外：编辑中的内容与状态要原样保留——
      //   推到后台再回来把 editing 清成 false，吸底操作行就会从「保存修改」变回「记下」）
      const fromBg = !!app._fromBg; app._fromBg = false;
      if (!app.globalData.editRec && !this.st.fromManage && !fromBg) this.setData({ editing: false });
      // 从「管理选项」返回：把刚改名过的选项同步到已选中的 chip / 手填值上，避免旧名残留；
      // 刚新增的那一项，若对应位置还空着就替他选上（见 applyRenames / applyAdded）
      if (this.st.fromManage) { this.applyRenames(); this.applyAdded(); }
      this.st.fromManage = false;
      this.checkEdit();
      this.rotateGreet();
      // 数据就绪后再渲染真实内容，避免首屏出现空卡片「闪一下」；
      // 必须在 recompute() 之前置 ready:true，否则流转聚焦时真实输入框尚未渲染，scroll/聚焦都失效
      this.setData({ ready: true });
      this.recompute();
      this._measureBar();   // 量一下吸底操作行的实际高度（键盘弹出时输入框要给它让位）
    });
  },

  /* 首次取数失败后点「重试」：再走一遍加载（store 失败时会把状态放回去，可以再来一次） */
  onRetry() {
    if (this._retrying) return;
    this._retrying = true;
    this.setData({ loadFail: false });
    store.ensureAll().then(ok => {
      this._retrying = false;
      if (!ok) { this.setData({ loadFail: true }); return; }
      this.onShow();   // 成功了就按正常进页再走一遍（数据已经就绪，会直接渲染）
    });
  },

  onHide() {
    // 离开页面（切 tab / 去清单 / 进后台）不保留操作条与撤销条，回来是一页干净的
    this.clearFloats();
    this._clearBarFollow();   // 跟着输入框的操作行也收回来（进后台后键盘就没了）
    // 月历浮层同样不留：它是整屏的，留着会盖住别的页；tab 栏顺手放回来
    //（它是本页的实例，hidden 不带走的话下次进本页 tab 栏就没了）
    this.closeDueSheet();
  },

  /* 量吸底操作行（#savebar）的实际高度，加上余量作为输入框的 cursor-spacing（见 data.kbGap）：
     键盘弹出时微信会把聚焦的输入框滚到「距键盘 kbGap」的位置——那一截正好留给操作行，
     于是操作行贴在键盘上方、输入框在操作行上方，两者不会叠在一起。
     取不到节点就沿用默认值（76，约等于默认样式下的行高 + 余量）。 */
  _measureBar() {
    wx.nextTick(() => {
      const q = wx.createSelectorQuery().in(this);
      q.select('#savebar').boundingClientRect();
      q.exec(res => {
        const r = res && res[0];
        if (!r || !r.height) return;
        const h = Math.round(r.height);
        this.setData({ barH: h, kbGap: h + 14 });
      });
    });
  },
  /* 键盘高度变化（两个来源都通到这里）：全局 wx.onKeyboardHeightChange，以及输入框自带的
     bindkeyboardheightchange（见 index.wxml）——部分机型上全局那条不派发，靠输入框这条兜住。
     h > 0：操作行改真 fixed，bottom 给到键盘上方（sticky 受父容器与滚动状态限制，不保证能上移），
            等动画与原生避让落定后再补一次输入框位置（见 _keepFieldAboveBar）；
     h = 0（键盘收起）：把「跟着输入框」的操作行放回记卡底部。 */
  _applyKb(h) {
    h = Math.max(0, Math.round(h || 0));
    // 刚聚焦的这一下，个别机型会先报一次 0（键盘还在起）——别当成「键盘收起」把操作行收回去，
    // 否则表现就是「操作行闪一下又没了」
    if (h === 0 && this._focusId && Date.now() - (this._focusAt || 0) < 800) return;
    this._kbH = h;
    if (h > 0) {
      // 先不动操作行：它到底会不会被键盘盖住，等 _keepFieldAboveBar 量完再决定
      //（量不到、或它本来就露在键盘上方时，保持卡片里的吸底形态不动）
      if (this._kbTimer) clearTimeout(this._kbTimer);
      this._kbTimer = setTimeout(() => { this._kbTimer = null; this._keepFieldAboveBar(); }, 320);
    } else {
      if (this._kbTimer) { clearTimeout(this._kbTimer); this._kbTimer = null; }
      this._clearBarFollow();
    }
  },
  /* 输入框自带的键盘高度事件（index.wxml 的 bindkeyboardheightchange）：与全局那条同源兜底 */
  onFieldKb(e) { this._applyKb((e && e.detail && e.detail.height) || 0); },

  /* 让「聚焦的输入框」与「吸底操作行」不打架——**但只在操作行真的会被键盘盖住时才动它**：
     ・先判断盖不盖得住：操作行「不在浮层里时」的下沿，与「一定在键盘上方的下界」比。
       知道键盘高度时下界就是键盘上沿；不知道时用微信给聚焦框留出的净空（cursor-spacing = kbGap）——
       这段之内不会被键盘盖住，操作行本来就在其中就说明没被盖住，保持卡片里的吸底形态不动。
     ・确实会被盖住时分两条路：知道键盘高度 → 操作行贴到键盘上方，再把这一框挪到它上方
       （只往下滚、只滚超出量，并受「顶部安全带」限制，不会把输入框推到页面顶端）；
       不知道键盘高度 → 操作行跟着这一框，钉在它正下方 8px
       （微信已保证聚焦的框在键盘上方，于是「输入框 → 操作行 → 键盘」自然成立）。
     ・滚动时浮层位置会过期，由 onPageScroll 兜住（见那里）。 */
  _keepFieldAboveBar() {
    const id = this._focusId;
    if (!id) return;
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    const winH = info.windowHeight || 0;
    const kbH = this._kbH || 0;
    const kbTop = kbH > 0 ? winH - kbH : null;
    const barH = this.data.barH || 61;
    const q = wx.createSelectorQuery().in(this);
    q.select('#' + id).boundingClientRect();
    q.select('.composer').boundingClientRect();
    q.selectViewport().scrollOffset();
    q.exec(res => {
      const f = res && res[0], c = res && res[1], off = res && res[2];
      if (!f || !f.height || !off) return;

      // 操作行「自然位置」的下沿（视口坐标）：它正常就在记卡最后一行，所以按**记卡**的下沿推算
      //（记卡 padding-bottom 16px，见 app.wxss 的 .composer）。
      // 不能直接量操作行自己：它是 sticky，可能已被顶到键盘线；转成 fixed 后又脱离文档流——
      // 两种形态量到的都不是「它本来在哪」，之前就是因此把 1px 之差判成「没被盖住」而误收。
      // 已经在浮层里时，用浮起来那一刻记下的值 + 滚动差换算回来（记卡的文档位置没变）
      const naturalNow = c && c.bottom != null ? (c.bottom - 16) : null;
      const floating = this._barFollow || this.data.kbOn;
      const rowNatural = floating && this._barRowBottom != null
        ? (this._barRowBottom - (off.scrollTop - (this._barOff0 || 0)))
        : naturalNow;
      if (!floating && naturalNow != null) { this._barRowBottom = naturalNow; this._barOff0 = off.scrollTop; }
      // 「一定在键盘上方」的下界
      const clearBottom = kbTop != null ? kbTop : (f.bottom + (this.data.kbGap || 75));
      if (rowNatural != null && rowNatural <= clearBottom) {
        // 本来就露在键盘上方：不动它（含「之前在浮着、现在不该浮了」的收回）
        this._clearBarFollow('判定没被盖住 rowNatural=' + Math.round(rowNatural) + ' 下界=' + Math.round(clearBottom));
        return;
      }

      if (kbTop != null) {
        // 知道键盘高度：操作行贴到键盘上方，再把这一框挪到它上方 12px
        if (!this.data.kbOn) this.setData({ barFollow: false, kbOn: true, barBottom: kbH + 'px' });
        const over = Math.round(f.bottom - ((kbTop - barH) - 12));
        if (over <= 0) return;
        const limit = Math.max(0, Math.round(f.top - ((info.statusBarHeight || 20) + 56)));
        const dy = Math.min(over, limit);
        if (dy > 0) wx.pageScrollTo({ scrollTop: Math.round(off.scrollTop + dy), duration: 0 });
        return;
      }

      // 不知道键盘高度：操作行跟着这一框，钉在它正下方 8px。
      // 它是按 bottom 定位的，所以要再让开自己的高度，否则上沿会顶进输入框
      if (!this._barFollow) {
        this._barFollow = true;
        this._barRowBottom = rowNatural;
        this._barOff0 = off.scrollTop;
        this.setData({ barFollow: true, kbOn: false });
      }
      const bottom = Math.max(0, Math.round(winH - f.bottom - 8 - barH));
      if (Math.abs(bottom - (this._barPx || 0)) > 1) { this._barPx = bottom; this.setData({ barBottom: bottom + 'px' }); }
    });
  },
  /* 操作行回到「卡片里的吸底行」形态（sticky、bottom 回到 tab 栏之上）：
     键盘没盖住它、或键盘收起、或失焦 / 点空白 / 离开页面时都调它。
     跟随态的位置是按旧坐标算的绝对值，不收回来就会悬在卡片中间 */
  _clearBarFollow() {
    this._barFollow = false;
    this._barPx = 0;
    this._barRowBottom = null;
    this._barOff0 = null;
    const tabCalc = 'calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px))';
    if (this.data.barFollow || this.data.kbOn || this.data.barBottom !== tabCalc) {
      this.setData({ barFollow: false, kbOn: false, barBottom: tabCalc });
    }
  },
  /* 失焦：收回操作行。刚聚焦那一两百毫秒里的失焦多为机型噪音（换框、输入法切换），
     忽略掉——不然操作行会在键盘刚起来时被收回去，看着就是「闪一下又没了」 */
  onFieldBlur() {
    if (Date.now() - (this._focusAt || 0) < 220) return;
    this._focusId = '';
    this._clearBarFollow();
  },

  /* 主题 / 程序名（ensureTheme / layoutBrand / playBrand）已收敛到 utils/pageBase.js */

  rotateGreet() {
    const g = app.globalData;
    const greets = g.greets || store.GREETS;
    const hh = new Date().getHours();
    const t = hh < 6 ? '还没睡？' : (hh < 11 ? '早上好' : (hh < 14 ? '中午好' : (hh < 18 ? '下午好' : '晚上好')));
    const pool = (hh >= 18 || hh < 5) ? greets.night : greets.day;
    let pick = pool[Math.floor(Math.random() * pool.length)];
    const last = wx.getStorageSync('greet_last') || '';
    if (pool.length > 1 && pick === last) {
      const i = pool.indexOf(pick);
      pick = pool[(i + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length];
    }
    wx.setStorageSync('greet_last', pick);
    this.setData({ greet: { t, s: pick } });
  },

  modulesVM() {
    // 静默维度（睡）不出现在记页的维度标签里：它不在这一页记，只有顶部那个「睡」按钮和「睡」tab
    return store.MODULES.filter(m => !m.quiet);
  },

  checkEdit() {
    const g = app.globalData;
    if (!g.editRec) return;
    const r = g.editRec; g.editRec = null;
    // 历史遗留 m='done' 记录（新流程已并入「可做」）：无对应字段定义，安全跳过编辑，避免崩溃
    if (!store.FIELDS[r.m]) { this.st.edit = null; this.setData({}); return; }
    const main = store.FIELDS[r.m].main;
    const O = store.getOPT(main);
    this.st.edit = r;
    this.st.tag = r.m;
    if (O.indexOf(r.txt) >= 0) { this.st.mainPick = r.txt; this.st.main = ''; }
    else { this.st.main = r.txt; this.st.mainPick = null; }
    this.st.pick = {}; this.st.typed = {}; this.st.free = {};
    // 待办的计划完成：回显这条自己的（非待办 / 老记录都是 0）。它是顶层字段，不在 ext 里
    this.st.due = r.dueTs || 0;
    (r.ext || []).forEach((v, i) => {
      let src = (r.extSrc || [])[i] || '', val = v;
      // 「今日」电池：纯图示档位，把任意值（档位 '0'..'4' 或旧 emoji）归一化成档位 v
      if (src === 'todayBat') { (this.st.pick['todayBat'] = this.st.pick['todayBat'] || []).push(store.batValOf(v)); return; }
      if (src.indexOf('free:') === 0) { this.st.free[src.slice(5)] = val; return; }
      // 老数据的「程度+情绪」合并值（如「微微抵触」）已由 migrateNopeLikeIntoObs 一次性拆开，这里不再处理
      const O = store.getOPT(src);
      // 「沉浸 / 精力」是写死在代码里的固定选项组（fx:）：它们天然不在选项池里（ensureRecOpts 也特意跳过），
      // 所以不能按「池里有这个值 → 选中」来判断，否则这两行编辑时永远空着（值会被塞进 typed，而 fx 行不渲染 typed）
      const isFixed = src.indexOf('fx:') === 0;
      // 不在选项池里的历史值：还能手填的组放进输入框；已经不给手填的组（noInput）
      // 也放进选中态 —— 由 buildComposer 作为临时 chip 展示，否则会在保存时被悄悄丢掉
      if (isFixed || O.indexOf(val) >= 0 || store.isNoInput(src)) (this.st.pick[src] = this.st.pick[src] || []).push(val);
      else this.st.typed[src] = val;
    });
    // 旧此刻记录的「情绪（genFeel）/ 感受（free:nownote）」映射到觉察同款（obsMood / free:obsfeel）：
    // FIELDS.now 已不再定义这两组，不映射的话编辑保存会把旧值悄悄丢掉——编辑一次就完成这一条迁移
    if (r.m === 'now') {
      if ((this.st.pick['genFeel'] || []).length) {
        this.st.pick['obsMood'] = (this.st.pick['obsMood'] || []).concat(this.st.pick['genFeel']);
        delete this.st.pick['genFeel'];
      }
      if (this.st.free['nownote'] && !this.st.free['obsfeel']) this.st.free['obsfeel'] = this.st.free['nownote'];
    }
    // 记录本身没有分类（历史数据）时才补默认分类；有则只回显记录自己的值，避免默认+记录值同时选中
    this.ensureModuleDefaults(r.m);
    // 「开始」流转进入：稍后在「保存修改」时才记录开始时间（这里只标记 startMode）
    this.st.startMode = !!g.editStart; g.editStart = null;
    // 「完成」流转进入：稍后在「保存修改」时才置「做了」并记录完成时间（这里只标记 completing）
    this.st.completing = !!g.editComplete; g.editComplete = null;
    // 「放弃」流转进入：稍后在「保存修改」时才置「不做」并记录放弃时间（这里只标记 abandoning）
    this.st.abandoning = !!g.editAbandon; g.editAbandon = null;
    // 「结束」流转进入（觉察）：自动定位到「感受」输入框并弹出键盘，便于立刻记感受
    // 结束时间不在这里落，稍后在「保存修改」时才记录并写云（这里只标记 ending）
    this.st.ending = !!g.editEnding; g.editEnding = null;
    this.st.focusFree = g.editEndFocus ? 'obsfeel' : '';
    g.editEndFocus = null;
    // 展示哪些字段：点「完成」(action)→仅做了的感受/收获并聚焦；点「开始」(action)→仅进行中感受并聚焦；
    // 点「放弃」(action)→仅“为什么不做了”并聚焦；普通点开编辑：做中→进行中感受；已做（做了）→进行中感受 与 做了的感受/收获 都可改；
    // 已「不做」→“为什么不做了”可改
    if (r.m === 'want') {
      const st0 = r.status || '';
      const isDone = st0 === 'done';
      const isAbandon = st0 === 'abandon';
      if (this.st.completing) { this.st.showDoing = false; this.st.showDone = true; this.st.showAbandon = false; }
      else if (this.st.startMode) { this.st.showDoing = true; this.st.showDone = false; this.st.showAbandon = false; }
      else if (this.st.abandoning) { this.st.showDoing = false; this.st.showDone = false; this.st.showAbandon = true; }
      else { this.st.showDoing = (st0 === 'doing') || isDone; this.st.showDone = isDone; this.st.showAbandon = isAbandon; }
      this.st.abandoning = this.st.abandoning || isAbandon; // 编辑「不做」记录时保持放弃态，保存不改状态/时间
      this.st.doing = this.st.showDoing;
    } else {
      // 待办 / 随记 等没有 可做 那套流转分支，只认「放弃」一种：
      // 点「放弃」进来时保持 abandoning —— 保存修改时才落「已放弃」+ 时间（见 doSave）。
      // 「放弃原因」这一格只在放弃流程里出现，编辑一条已放弃的待办不再多出它；
      // 可做那边沿用原口径（编辑一条已「不做」的记录会显示，方便回看 / 改）。
      this.st.doing = false; this.st.completing = false; this.st.showDoing = false; this.st.showDone = false;
      this.st.showAbandon = false;
    }
    // 编辑时回填时间字段，供「改时间」使用
    // 做了的记录：legacy(m='done') 完成时间=ts、惦记=refTs；新流程(want+status done) 完成时间=doneAt、创建=ts
    // 觉察(obs)：结束时间=endTs（无则默认当前，编辑时可改）
    const isLegacyDone = r.m === 'done';
    const isWantDone = (r.m === 'want') && (r.status === 'done');   // 仅「已做（做了）」记录回显结束时间；点「完成」流转时结束时间在保存时才记，不展示结束时间输入框
    const isDoneView = isLegacyDone || isWantDone;
    // 「放弃时间」这一行：可做的「不做」记录、以及**已放弃的待办**都要给出来（能回看、也能改）。
    // 待办原来只在列表里看到「放弃 · HH:MM」，进记卡反而没有这一行——这里补上
    const isWantAbandon = ((r.m === 'want') && (r.status === 'abandon' || this.st.abandoning)) ||
                          (store.isTask(r.m) && r.status === 'abandon');
    const createTs = isLegacyDone ? (r.refTs || r.ts) : r.ts;   // 做了(legacy)：惦记=refTs；want-done/obs：创建=ts
    const startTs = r.startedAt || 0;
    let endTs = 0;
    if (isLegacyDone) endTs = r.ts;                              // legacy：完成=ts
    else if (isWantDone) endTs = r.doneAt || 0;                  // want-done：完成=doneAt
    else if (r.m === 'obs') endTs = r.endTs || 0;                // 觉察：结束=endTs；未结束(首次)不填，由「结束」按钮记录
    const abandonTs = isWantAbandon ? (r.abandonedAt || Date.now()) : 0;  // 放弃时间=abandonedAt，无则默认现在
    const c = dtStr(createTs), s = dtStr(startTs), e = dtStr(endTs), ab = dtStr(abandonTs);
    this.setData({
      editing: true,
      editCreateLabel: isLegacyDone ? '惦记于' : '创建时间',
      editDate: c.date, editTime: c.time,
      editHasStart: !!startTs,
      editStartDate: s.date, editStartTime: s.time,
      // 觉察：点「改」且已有结束时间才回显结束时间供修改；点「结束」进入时不回显（结束时间在保存时才记）
      editHasEnd: isDoneView || (r.m === 'obs' && !!r.endTs && !this.st.ending),
      editEndDate: e.date, editEndTime: e.time,
      editHasAbandon: isWantAbandon,
      editAbandonDate: ab.date, editAbandonTime: ab.time
    });
    // 进入编辑态后立刻把整页滚回顶部露出记卡：这里 cover 了所有入口
    //（操作条「改」/ 长按记录 / 从看页点「改」或长按后切回本页 / 从管理页返回后继续编辑），
    // 否则从下方「最近」或从看页回来时，页面还停在下方，记卡整个在屏幕外
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  /* 从「管理选项」返回：把这次会话里改过名的选项，同步到已经选中的 chip / 手填值上。
     不这么做的话，旧名会以「池里没有的值＝临时 chip」的方式和新名并排显示，
     看着就是同一个选项出现了两个（保存时还会把旧名写回记录）。 */
  applyRenames() {
    const rm = store.takeRenameMap();
    const keys = Object.keys(rm);
    if (!keys.length) return;
    keys.forEach(g => {
      const m = rm[g];
      if (this.st.pick[g]) {
        const seen = {};
        this.st.pick[g] = this.st.pick[g].map(v => m[v] || v).filter(v => !seen[v] && (seen[v] = 1));
      }
      if (this.st.typed[g] && m[this.st.typed[g]]) this.st.typed[g] = m[this.st.typed[g]];
    });
  },

  /* 从「管理选项」返回：刚新增的那一项，若它在记卡里对应的位置**一个都没选**，就替他选上。
     ・为什么只在「没选」时选：已经选过别的，说明是有意选的，不能替他改掉；
       而「一个都没选」的多半是这组本来没有默认值（归类 / 情绪 / 分类 / 感受这些），
       刚加的那项通常正是他这趟去管理页想加的东西，选上省掉再点一次
     ・编辑态不做：那时记卡回显的是**一条已存在的记录**，替他选等于不声不响地改那条记录
     ・只处理当前维度：这一项属于别的维度就等切过去再说（那时它多半会被默认值顶上，
       真需要保留就再点一次——跨维度先选上反而会跟着切维度被清掉，白选） */
  applyAdded() {
    const am = store.takeAddedMap();
    const keys = Object.keys(am);
    if (!keys.length) return;
    if (this.st.edit) return;                 // 编辑态：见上，不动已存在的那条记录
    this._autoPick = {};                      // 只记本次选上的（换批次前清掉，见 _composerDirty）
    const tag = this.st.tag;
    keys.forEach(g => {
      const v = am[g];
      const ow = store.groupOwner(g);
      if (!ow || ow.m !== tag) return;       // 不是当前维度的组 / 不属于任何维度（如 fx: 固定组）
      if (ow.it && ow.it.sub) return;        // 档位副行（程度）：它跟着情绪出现，没选情绪时选它没意义
      if (store.getOPT(g).indexOf(v) < 0) return;   // 加完又被删了：不在池里就别选
      if (ow.main) {
        // 主项（归类 / 什么事）：没选也没手填时才选。手填过就不能覆盖——那是他自己写的
        if (!this.st.mainPick && !(this.st.main || '').trim()) {
          this.st.mainPick = v; this.st.main = '';
          this._autoPick.main = v;      // 记一笔：这是替他选的，不算「记卡里有内容」（见 _composerDirty）
        }
        return;
      }
      if ((this.st.pick[g] || []).length) return;     // 这组已选过
      if ((this.st.typed[g] || '').trim()) return;    // 手填过：也算他选过
      this.st.pick[g] = [v];
      this._autoPick[g] = v;
    });
  },

  /* 编辑态：修改时间（创建 / 开始 / 结束） */
  onEditDate(e) { this.setData({ editDate: e.detail.value }); },
  onEditTime(e) { this.setData({ editTime: e.detail.value }); },
  onEditStartDate(e) { this.setData({ editStartDate: e.detail.value }); },
  onEditStartTime(e) { this.setData({ editStartTime: e.detail.value }); },
  onEditEndDate(e) { this.setData({ editEndDate: e.detail.value }); },
  onEditEndTime(e) { this.setData({ editEndTime: e.detail.value }); },
  onEditAbandonDate(e) { this.setData({ editAbandonDate: e.detail.value }); },
  onEditAbandonTime(e) { this.setData({ editAbandonTime: e.detail.value }); },

  recVM(r) {
    const dt = store.buildExt(r.m, r.ext, r.extSrc);
    const task = store.isTask(r.m);
    const doingDays = (r.m === 'want' && r.status === 'doing' && r.startedAt) ? Math.max(1, Math.floor((Date.now() - r.startedAt) / 86400000)) : 0;
    // 用时/历时（与看页一致）：做了=用了/惦记了；觉察=历时
    let dur = '';
    const isDoneView = (r.m === 'done') || (r.m === 'want' && r.status === 'done');
    if (isDoneView) {
      const endTs = r.doneAt || r.ts;
      const baseTs = r.m === 'done' ? (r.refTs || r.ts) : r.ts;
      let durLabel = '', durMs = 0;
      if (r.startedAt && endTs && r.startedAt <= endTs) { durMs = endTs - r.startedAt; durLabel = '用了'; }
      else if (baseTs && endTs && baseTs <= endTs) { durMs = endTs - baseTs; durLabel = '惦记了'; }
      const ds = date.fmtDur(durMs);
      if (ds) dur = ds === '片刻' ? durLabel + ds : durLabel + ' ' + ds;
    }
    if (r.m === 'obs' && r.endTs && r.ts && r.endTs > r.ts) {
      const ds = date.fmtDur(r.endTs - r.ts);
      if (ds) dur = ds === '片刻' ? '历时片刻' : '历时 ' + ds;
    }
    // 不做 的历时：从创建到放弃（惦记了多久）
    if (r.m === 'want' && r.status === 'abandon' && r.abandonedAt && r.ts && r.abandonedAt >= r.ts) {
      const ds = date.fmtDur(r.abandonedAt - r.ts);
      if (ds) dur = ds === '片刻' ? '惦记了片刻' : '惦记了 ' + ds;
    }
    const v = vm.baseVM(r);
    v.dt = dt;
    // 「今日」一日一记：**能量格是主项、那句话是附属**（用户 2026-10-05 定的口径）——
    // 能量单独提出来给行内画 5 格条（与记页只读摘要 / 看页卡片同一套 .tl-bar / .tl-cell），
    // 并从细节行里摘掉（否则「剩余能量 1」会在下面再冒一次，而且露的是档位码不是名字）；
    // 那句话不再占主项位，改由 wxml 放在下面的「能量说明」那一行（见 index.wxml）
    if (r.m === 'today') {
      const bi = (r.extSrc || []).indexOf('todayBat');
      const bv = bi >= 0 ? (r.ext || [])[bi] : '';
      v.bat = { lv: bv ? store.batLevel(bv) : 0, name: store.batName(bv) };
      v.dt = dt.filter(d => d.src !== 'todayBat');
    }
    v.doingDays = doingDays;
    v.dur = dur;
    // 清单标题超长：隐藏原因/用途，标题独占整行自动折行（右侧只留时间）
    v.longTxt = task && String(r.txt || '').length > 12;
    return v;
  },

  buildComposer() {
    const tag = this.st.tag;
    const f = store.fieldsOf(tag);
    if (!f) return { main: '', mainOpts: [], catItems: [], items: [], plain: false, focusIdx: -1, mainVal: '', mainPh: '' };
    const main = f.main;
    const mainOpts = store.getOPT(main).map(v => ({ v, on: this.st.mainPick === v }));
    // 历史数据里手填的「点」可能不在选项池里：把它作为临时选项排在最前，
    // 保证看得见、点一下能取消（带描述的模块没有主输入框，点只能从池里选）
    const legacyMain = (!this.st.mainPick && (this.st.main || '').trim()) || '';
    if (legacyMain && store.getOPT(main).indexOf(legacyMain) < 0) mainOpts.unshift({ v: legacyMain, on: true });
    // 「具体的描述」= 与「归类」(主项) 配对的自由字段。它不是普通细节项：单独摆在主输入框下方
    // （见 index.wxml），所以这里先从细节列表里摘出来；保存仍按 f.items 的原顺序写 ext/extSrc，
    // 于是 export/import 的按顺序对齐完全不受影响
    const descItem = (f.items || []).find(it => it.free === store.DESC_KEY);
    // 「可做」按流转状态过滤字段：进行中感受 仅做中/点开始/已做编辑时显示；做了的感受/收获 仅点完成/已做编辑时显示
    let fitems = f.items.filter(it => it.free !== store.DESC_KEY);
    // 「放弃原因」只在两种时候出现：① 正在走「放弃」这个动作（从操作条点「放弃」进来）；
    // ② 编辑一条**已经放弃**的记录（回看 / 改原因）。其余时候不出现——
    // 这条规则待办与可做同一套（待办以前漏了，导致每写一条待办都摆着「为什么不做了」）
    fitems = fitems.filter(it => it.free !== 'abandonWhy' ||
      this.st.abandoning || !!(this.st.edit && this.st.edit.status === 'abandon'));
    if (tag === 'want') {
      fitems = fitems.filter(it => {
        if (it.free === 'doingNote') return !!this.st.showDoing;
        if (it.free === 'doneFeel' || it.free === 'doneGain') return !!this.st.showDone;
        return true;
      });
    }
    // 档位（obsDeg）是情绪的修饰：没选情绪、也没有历史档位时整行不展示。
    // 觉察与此刻的情绪都是 obsMood（此刻整块复用觉察的「感受」），程度副行同一套
    const moodG = (tag === 'obs' || tag === 'now') ? 'obsMood' : '';
    const showDeg = !!moodG &&
      ((this.st.pick[moodG] || []).length > 0 || (this.st.pick['obsDeg'] || []).length > 0);
    // 展示顺序与存储顺序解耦：觉察的细节在编辑器里排成
    // 「喜恶 → 感受（情绪 chips + 档位副行 + 自由输入框）→ 怎么开始的 → 沉浸 → 精力」，
    // 但保存仍按 f.items 的原顺序写 ext/extSrc，导出/导入的按顺序对齐因此不受影响
    if (tag === 'obs') {
      const key = (it) => it.g || (it.fx ? 'fx:' + it.fx : 'free:' + it.free);
      // 档位紧跟情绪（点完情绪就在原处展开），自由感受再跟在后面
      const want = ['obsKind', 'obsMood', 'obsDeg', 'free:obsfeel', 'obsStart', 'fx:forgot', 'fx:nrg'];
      const rest = fitems.filter(it => want.indexOf(key(it)) < 0);   // 未列出的照旧附在后面，不会被吞掉
      fitems = want.map(k => fitems.find(it => key(it) === k)).filter(Boolean).concat(rest);
    }
    const items = fitems.map((it, idx) => {
      if (it.g) {
        // 「今日」能量：5 段能量条（不再用电池图形）。n=档位名（段内小字），
        // lv=格数（wxml 画 5 格、点亮前 lv 格）。lv 跟着选中档走，
        // 所以从低档改到高档时是「一格一格亮起来」，和只读态那条一致。
        // 未选时 lv=0：新建今日记录一进来 5 格全灭（不能借 store.batLevel('') 的兜底值 1
        // 把第 1 格点亮——那会看起来像已经选了「很低」，用户就少点了一下、存下错档）。
        if (it.g === 'todayBat') {
          const cur = (this.st.pick['todayBat'] || [])[0] || '';
          const lv = cur ? store.batLevel(cur) : 0;
          const opts = store.BATTERIES.map((b, i) => ({
            v: b.v, n: b.name, lv: i,
            on: (this.st.pick['todayBat'] || []).indexOf(b.v) >= 0
          }));
          return { type: 'g', first: idx === 0, group: it.g, label: store.GLABEL[it.g], single: true, noInput: true, opts, lv, cur, sub: false, hide: false };
        }
        const opts = store.getOPT(it.g).map(v => ({ v, on: (this.st.pick[it.g] || []).indexOf(v) >= 0 }));
        // 历史手填值不在选项池里（这个组后来取消了手填）：作为临时 chip 排在最前，
        // 保证看得见、点一下能取消，不会在保存时被悄悄丢掉
        (this.st.pick[it.g] || []).forEach(v => {
          if (store.getOPT(it.g).indexOf(v) < 0) opts.unshift({ v, on: true });
        });
        // 手填只记这一条，不进选项池（要复用同一句话，去「✎ 管理」里加）
        const ph = '也可以手填，和选项一起记下（不加入选项池）';
        // sub：情绪下面的档位副行——不显示标题、不给管理入口，chip 小一号，未选情绪时隐藏
        return { type: 'g', first: idx === 0, group: it.g, label: it.sub ? '' : store.GLABEL[it.g], single: !!it.single, noInput: !!it.noInput, ph, opts, typedVal: this.st.typed[it.g] || '',
          sub: !!it.sub, hide: !!it.sub && !showDeg };
      }
      if (it.fx) {
        const fx = store.FIXED[it.fx];
        const opts = fx.opts.map(v => ({ v, on: (this.st.pick['fx:' + it.fx] || []).indexOf(v) >= 0 }));
        return { type: 'fx', first: idx === 0, group: 'fx:' + it.fx, label: fx.label, opts };
      }
      return { type: 'free', first: idx === 0, key: it.free, label: it.label, ph: it.ph, ta: !!it.ta, val: this.st.free[it.free] || '' };
    });
    const MAINPH = { todo: '要记住什么 · 回车就记下', jot: '想记点什么 · 回车就记下', today: '说说今天的能量使用情况吧～' };
    // 待办 / 随记 / 今日：主项不给标题、不走「细节 · 都可跳过」那套，只留必要的行。
    // 今日：电池（类别）摆在主输入框上方、印象（主输入框）在下方，无细节分割线（见 index.wxml 的 plain 分支）
    const plain = store.isTask(tag) || tag === 'jot' || tag === 'today';
    // 待办 / 随记的「类别」（todoKind / jotKind）摆在主输入框**上方**：先定类别，再写内容。
    // 其余细节行（如待办的「原因」「放弃原因」）仍在输入框下方
    const catItems = plain ? items.filter(it => it.type === 'g') : [];
    const bodyItems = plain ? items.filter(it => it.type !== 'g') : items;
    // 待办的「计划完成」：档位表与文案都用 store.dueChips 那一份（与快捷记面板同源），
    // 记卡里只是换个位置渲染。只有待办有这一行——随记 / 今日没有「打算哪天做完」这回事
    const due = tag === 'todo' ? store.dueChips(this.st.due) : null;
    // 自动聚焦：开始 → 进行中感受；完成 → 做了的感受；放弃 → 放弃原因；结束(觉察) → 感受。
    // 索引按**真正渲染的那份**列表算：plain 时类别行不进 composer.items，用 items 会偏一位，
    // 聚焦与 #fld{idx} 都会落空（「放弃待办」要聚焦的正是这类被挤掉一位的框）
    const focusKey = this.st.startMode ? 'doingNote' : (this.st.completing ? 'doneFeel' : (this.st.abandoning ? 'abandonWhy' : (this.st.focusFree || '')));
    const focusIdx = focusKey ? bodyItems.findIndex(it => it.type === 'free' && it.key === focusKey) : -1;
    // focusIdx 必须返回：recompute 依赖它做「滚动到目标输入框 + 程序化聚焦弹键盘」
    return { main: main, mainLabel: store.GLABEL[main], mainOpts, mainVal: this.st.main || '', catItems, items: bodyItems, plain, due: due && { ts: due.ts, pick: due.pick, opts: due.chips }, focusIdx, mainPh: MAINPH[tag] || '手填或直接写一句 · 只记这一次',
      // 「归类」不需要输入框：从选项池点选即可（要靠「✎ 管理」增删），
      // 所以带描述的模块把主输入框整个去掉，输入框只留给「具体的描述」
      mainInput: !descItem,
      // 「具体的描述」：紧跟在「归类」下方单独一个输入框（不带标题），可选
      hasDesc: !!descItem, descPh: descItem ? descItem.ph : '', descVal: (this.st.free && this.st.free[store.DESC_KEY]) || '' };
  },

  /* 「最近 / 待办 / 已完成」三块列表共用这一段（标题旁的几个词就是开关），都只取 10 条：
     ・最近：日常记录。待办一律不在这里出现——它有自己的「待办 / 已完成」两块，
       而且随手记的备忘会挤掉真正想回看的觉察 / 此刻 / 可做 / 随记
     ・待办：还没做完的待办（已放弃的不算——那类去清单页看），**按创建时间倒序**（下面单说）
     ・已完成：最近 10 条「完成」的（待办勾掉的 + 可做「做了」的 + 历史 m='done'），按完成时间倒序 */
  recentVM() {
    const all = app.globalData.records || [];
    const tab = this.data.recentTab;
    if (tab === 'todo') {
      /* 记页这一段的排序**故意与清单页 / 看页不同**：那边按优先级 → 计划时间 → 记录时间
         （store.sortUndone），这边只按创建时间倒序。

         为什么不一样：记页是「随手看一眼」的落地页，这一段摆的是**最近写下的东西**，
         顺序本身就是信息——先看到自己刚记的那几条，符合「我刚说了什么」的预期。
         清单页与看页是「manage 一堆事」的地方，那里顺序要替你做判断：哪件最要紧先出。
         两边目的不同，硬凑成一种反而两边都不顺手。

         注意**只有排序不同**：行的显示字段与交互仍与那两页一致（同一份 recVM / vm.baseVM，
         优先级小旗、行尾「计划完成」胶囊、勾完成、左滑改，点胶囊不换档）。
         记页与那两页的差别是「按什么顺序看」，不是「看起来像不像」。

         filter 出来的是新数组，sort 不会动到 app.globalData.records 的顺序 */
      return all
        .filter(r => store.isTask(r.m) && !r.done && r.status !== 'abandon')
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, 10)
        .map(r => this.recVM(r));
    }
    if (tab === 'done') {
      // filter 出来的是新数组，sort 不会动到 app.globalData.records 的顺序
      return all
        .filter(r => r.done || r.status === 'done' || r.m === 'done')
        .sort((a, b) => (b.doneAt || b.ts || 0) - (a.doneAt || a.ts || 0))
        .slice(0, 10)
        .map(r => this.recVM(r));
    }
    // 待办一律不进「最近」：没做完的去「待办」，做完 / 放弃的去「已完成」或清单页。
    // 「睡」也不进（isQuiet）：它没有内容可展示，只记一个时刻，去「睡」tab 看
    return all
      .filter(r => !store.isTask(r.m) && !store.isQuiet(r.m))
      .slice(0, 10)
      .map(r => this.recVM(r));
  },

  /* 「最近 / 待办 / 已完成」切换（点标题旁的字，或在这块列表上左右滑）：只换这一段的列表，
     输入区与正在输入的内容都不动。
     这一段**不主动滚到顶部**：留在原处更贴合「原地换一份列表」的手感，
     三段的长短差交给列表区自己的 min-height 收住（见 pages/index/index.wxss） */
  onRecentTab(e) { this._goRecent(e.currentTarget.dataset.k); },
  _goRecent(k) {
    if (this.guardEdit()) return;   // 编辑态：不允许切换这一段（与切维度同一套口径）
    if (!k || k === this.data.recentTab) return;
    this.setData({ recentTab: k, recSel: null, recSelRec: null });
    this.recompute();
  },
  /* 最近段（列表区）上左右滑动切这三块：向左滑下一个，向右滑上一个。
     起点在这块区域时打个标记，根节点的手势识别就跳过这次触摸——
     在列表上滑动只切这三块，不去切上面的维度（也不用 catch，页面滚动不受影响） */
  onListSwipeStart(e) { this._inList = true; swipe.start(this, e); },
  onListSwipeEnd(e) {
    this._inList = false;
    const d = swipe.end(this, e);   // 顺手把起点清掉：根节点随后那次 end 就什么也拿不到
    if (d) this.stepRecent(d);
  },
  stepRecent(dir) {
    const keys = ['recent', 'todo', 'done'];
    const i = keys.indexOf(this.data.recentTab);
    if (i < 0) return;
    const ni = dir === 'left' ? i + 1 : i - 1;
    if (ni < 0 || ni >= keys.length) return;
    this._goRecent(keys[ni]);
  },

  recompute() {
    const recs = this.recentVM();
    const composer = this.buildComposer();
    const fi = composer.focusIdx;
    const willFocus = fi >= 0;
    // 进入流转（开始/完成/放弃）时：
    // 1) 先把 scroll-view 滚回顶部（composer 在顶部），确保目标输入框落在可视区——
    //    否则从看页返回时页面可能停在下方，输入框在屏外，scroll-view 内聚焦不弹键盘；
    // 2) 先以 focusIdx=-1 渲染出未聚焦的 textarea（避免「新建即聚焦」不弹键盘）；
    // 3) 延时一帧再翻转 focus 属性并程序化 ctx.focus()，稳定弹出键盘与光标。
    // textarea 用 adjust-position=false，避免键盘弹出时二次滚动再次失焦。
    const patch = {
      modules: this.modulesVM(),
      tag: this.st.tag,
      composer,
      focusIdx: willFocus ? -1 : fi,
      recent: recs,
      recentEmpty: this.data.recentTab === 'done' ? '还没有完成的记录'
        : (this.data.recentTab === 'todo' ? '还没有待办' : '还没有记录')
    };
    this.setData(patch, () => {
      this.checkTagFade();   // 维度标签行是否需要「可滚动」的渐变提示（随维度数量变化）
      // 流转聚焦时先把页面滚回顶部（输入区在页面顶部；页面级滚动会同步原生输入层）
      if (willFocus) wx.pageScrollTo({ scrollTop: 0, duration: 0 });
      if (!willFocus) return;
      setTimeout(() => {
        this.setData({ focusIdx: fi });
        // 程序化聚焦（开始 / 完成 / 放弃 / 结束）不一定派发 bindfocus：这里直接把目标框记上，
        // 并按同一条规则补位置——键盘弹起后它同样会被挪到吸底操作行上方
        this._focusId = 'fld' + fi;
        wx.createSelectorQuery().select('#fld' + fi).context(res => {
          const ctx = res && res.context;
          if (ctx && typeof ctx.focus === 'function') ctx.focus();
        }).exec();
        this.onFieldFocus();
      }, 300);
    });
  },

  /* -------- 交互 -------- */
  onTag(e) {
    if (this.guardEdit()) return;   // 编辑态：不允许切换维度
    const k = e.currentTarget.dataset.k;
    // 「今日」一日一记：当天已记过 → 进「只读锁定」态（顶部显示摘要 + 修改入口），不进编辑态。
    // 内容禁填，点「修改」才回填进编辑态；保存＝更新当天那条，取消＝回到锁定态（见 onTodayEdit / onEditCancel）
    if (k === 'today' && !this.st.edit) {
      const start = date.dayStart(Date.now());
      const dup = (app.globalData.records || []).find(r => r.m === 'today' && r.ts >= start && r.ts < start + date.DAY);
      if (dup) {
        this.st.todayLocked = this._todayLockedOf(dup);
        this.st.tag = 'today';
        this.setData({ tag: 'today', editing: false, todayLocked: this.st.todayLocked });
        this.recompute();
        return;
      }
    }
    this.st.tag = k;
    this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
    this.st.due = 0;
    this.st.startMode = false; this.st.doing = false; this.st.completing = false; this.st.showDoing = false; this.st.showDone = false; this.st.abandoning = false; this.st.showAbandon = false; this.st.ending = false;
    this.st.todayLocked = null;
    this.ensureModuleDefaults();
    this.setData({ tag: this.st.tag, todayLocked: null });
    this.recompute();
    // 这里**不主动置顶**：切维度只是换记卡里的内容，页面停在你滑到的位置。
    // 点标签也一样——标签就在记卡里，能点到它说明记卡本来就在视野里；
    // 主动对齐会把页面往下推一节，看着像整页在跳（与清单页切段同一个取舍，见 list.js 的 onSeg）
  },
  /* 记卡上左右滑动切维度（未编辑态）：向左滑到下一个维度，向右滑回上一个 */
  onSwipeStart(e) {
    if (this._noSwipe) { this._noSwipe = false; this._swX = null; return; }   // 起点在标签行：只滚标签，不切维度
    if (this._inList) return;   // 起点在「最近」列表区：那次滑动由列表自己处理（切 最近/待办/已完成）
    // 「自定义」月历浮层开着时，整屏的手势都归它：浮层在页面里，touch 会冒泡到根节点，
    // 不拦住的话在日历格子上左右一划就切了维度（浮层还开着，内容已经换页了）
    if (this.data.dueOpen) return;
    swipe.start(this, e);
  },
  onSwipeEnd(e) { const d = swipe.end(this, e); if (d) this.stepDim(d); },
  stepDim(dir) {
    if (this.data.editing) return;   // 编辑态不切维度（与 onTag 的守卫一致）
    // 记卡已经填了 / 选了内容：切维度会把整块内容清掉（onTag 会重置 st），
    // 而滑动是「不小心就划一下」的手势，所以这里拦下并提示——点维度标签是明确意图，不受影响
    if (this._composerDirty()) { this.tipDirty(); return; }
    const mods = this.data.modules || this.modulesVM();
    const i = mods.findIndex(m => m.k === this.st.tag);
    if (i < 0) return;
    const ni = dir === 'left' ? i + 1 : i - 1;
    if (ni < 0 || ni >= mods.length) return;
    this.onTag({ currentTarget: { dataset: { k: mods[ni].k } } });
  },
  // 标签行是横向 scroll-view：在它上面按下时打个标记，避免横滑标签误切维度
  onTagTouch() { this._noSwipe = true; },
  onMainInput(e) { this.st.main = e.detail.value; this.setData({ 'composer.mainVal': e.detail.value }); if (e.detail.value.trim()) this.st.mainPick = null; },
  onMainChip(e) {
    const v = e.currentTarget.dataset.v;
    if (this.st.mainPick === v) this.st.mainPick = null;
    else { this.st.mainPick = v; this.st.main = ''; }
    this.recompute();
  },
  onChip(e) {
    // 「今日」已填且只读锁定态：内容禁填（点「修改」才解锁），这里直接拦下
    if (this.data.todayLocked && !this.data.editing) return;
    const g = e.currentTarget.dataset.g, v = e.currentTarget.dataset.v;
    let arr = this.st.pick[g] || [];
    if (arr.indexOf(v) >= 0) {
      // 有默认值的组（类别 / 分类 / 开始方式…）必须留一个：再点已选中的不反选（见 REQUIRED_PICK）
      if (REQUIRED_PICK[g]) return;
      arr = arr.filter(x => x !== v);
    }
    else { if (store.isSingle(g)) arr = []; arr.push(v); }
    this.st.pick[g] = arr;
    // 档位是情绪的修饰，情绪被取消时把档位一并清掉（否则会存下没头没尾的程度）。
    // 觉察与此刻的情绪都是 obsMood，联动同一套；取值行见 buildComposer 的 showDeg
    if (g === 'obsMood' && !arr.length) this.st.pick['obsDeg'] = [];
    this.recompute();
  },

  /* 待办那一行「计划完成」：点一格就设好（今天 / 明天 / 本周末 / 下周一 / 无），
     只有「自定义」会开日历浮层——和快捷记面板同一条口径，这里只是换了个位置。
     判「是不是自定义」用 store.DUE_CUSTOM，不写字面量：档位键与文案是同一个词（见 store 的说明），
     写成 '自定' 的话改了文案这里就静默失配——点自定义会走到预设分支，duePresetTs 拿个不认识的键。
     dueTs 不进 ext（那两条数组是按位置对齐的，见 store 里的说明），所以不走 onChip 那套 */
  onDueChip(e) {
    if (this.data.todayLocked && !this.data.editing) return;
    const k = e.currentTarget.dataset.k;
    if (k === store.DUE_CUSTOM) { this.openDueSheet(); return; }
    this.st.due = k === '无' ? 0 : store.duePresetTs(k);
    this._refreshDue();
  },
  /* 开「自定义」的月历浮层。**同时把底部 tab 栏与「＋」球收起来**——
     浮层是整屏的，而 tab 栏在 custom-tab-bar 组件里、跨组件的层叠在小程序里不可靠，
     不收的话浮层开着照样点得到 tab（人一下就跳到别的页去了，浮层还留着），
     「＋」球也会露在浮层上——那是另一条记事的入口，露着等于让人以为能直接记。
     收放那一步在 pageBase.setTabHidden（三页同一份） */
  openDueSheet() {
    this.setData({ dueOpen: true, dueTs: this.st.due || 0 });
    this.setTabHidden(true);
  },
  closeDueSheet() {
    if (!this.data.dueOpen) return;
    this.setData({ dueOpen: false });
    this.setTabHidden(false);
  },
  // 浮层点「好」：时间戳（认不出来是 0＝没计划）
  onDuePicked(e) {
    this.st.due = (e.detail && e.detail.ts) || 0;
    this.closeDueSheet();
    this._refreshDue();
  },
  onDueClose() { this.closeDueSheet(); },
  /* 只把那一行刷新掉（不整页 recompute）：点一格 chip 只影响这一行的选中态与
     「自定义」的文字，没必要顺带把最近列表也重铺一遍 */
  _refreshDue() {
    const d = store.dueChips(this.st.due);
    this.setData({ 'composer.due.ts': d.ts, 'composer.due.pick': d.pick, 'composer.due.opts': d.chips });
  },
  onGroupInput(e) {
    const g = e.currentTarget.dataset.g, idx = e.currentTarget.dataset.idx;
    this.st.typed[g] = e.detail.value;
    if (idx != null) this.setData({ ['composer.items[' + idx + '].typedVal']: e.detail.value });
  },
  onGroupConfirm(e) { this.st.typed[e.currentTarget.dataset.g] = e.detail.value; },
  onFreeInput(e) {
    const k = e.currentTarget.dataset.k, idx = e.currentTarget.dataset.idx;
    this.st.free[k] = e.detail.value;
    if (idx != null) this.setData({ ['composer.items[' + idx + '].val']: e.detail.value });
  },
  /* 「具体的描述」：只存进 st.free，不渲染在细节列表里，所以不用回写 composer.items */
  onDescInput(e) { this.st.free[store.DESC_KEY] = e.detail.value; },

  /* 输入框获得焦点：记下是哪一个框（供 _keepFieldAboveBar 定位），并补两次位置
     （180ms / 460ms：分别赶在键盘刚弹起、以及动画与原生避让结束之后）。
     键盘避让本身仍交给 adjust-position 原生处理，这里只做「按需、只往下、只滚超出量、
     还有顶部安全带」的修正，重复调用无副作用——不会像早先那版（无条件写 scrollTop）把输入框推到顶端。 */
  onFieldFocus(e) {
    const id = (e && e.currentTarget && e.currentTarget.id) || '';
    if (id) this._focusId = id;
    this._focusAt = Date.now();
    // 补两次：第一次赶在键盘刚开始弹（键盘高度可能还没派发、操作行还没就位），
    // 第二次等动画与原生避让都结束——两次都只做「往下、有上限」的修正，重复调用无副作用
    if (this._kbTimer) clearTimeout(this._kbTimer);
    setTimeout(() => this._keepFieldAboveBar(), 180);
    this._kbTimer = setTimeout(() => { this._kbTimer = null; this._keepFieldAboveBar(); }, 460);
  },

  /* 维度标签行的「可滚动」渐变提示：只有内容真的超出、且右侧还有内容时才显示。
     量一次缓存起来（滚动时不再重复查询），之后滚动只做比较。 */
  checkTagFade() {
    const q = wx.createSelectorQuery().in(this);
    q.select('.tagrow-scroll').boundingClientRect();
    q.select('.tagrow-scroll').scrollOffset();
    q.selectAll('.tg').boundingClientRect();
    q.exec(res => {
      const box = res[0], off = res[1], items = res[2] || [];
      if (!box) return;
      let content = (off && off.scrollWidth) || 0;
      // 兜底：个别基础库上 scrollWidth 拿不到，就用最后一个标签的右边界推算内容宽度
      if (!content && items.length) {
        const right = items.reduce((m, it) => Math.max(m, it.right), 0);
        content = right - box.left;
      }
      this._tagW = { box: box.width, content };
      this._applyTagFade((off && off.scrollLeft) || 0);
    });
  },

  _applyTagFade(left) {
    const w = this._tagW;
    if (!w) return;
    // 超出 + 右侧还有没露出来的内容 → 才提示；滚到底就收起来
    const fade = w.content > w.box + 1 && left + w.box < w.content - 1;
    if (fade !== this.data.tagFade) this.setData({ tagFade: fade });
  },

  onTagScroll(e) { this._applyTagFade((e.detail && e.detail.scrollLeft) || 0); },

  /* 页面滚动：记录滚动位置，顺手收起记录操作条。
     页面级滚动下微信会同步原生输入层位置，无需再销毁重建输入框。 */
  onPageScroll(e) {
    this._pageTop = e.scrollTop || 0;
    this.closeRecSel();
    // 有框聚焦时滚动：操作行跟着输入框的位置要刷新；「会不会被键盘盖住」的判断也随滚动重算
    //（滑到操作行又露出来时，它会自己收回卡片里）。120ms 节流，没聚焦时不做事
    if (this._focusId && !this._barTimer) {
      this._barTimer = setTimeout(() => { this._barTimer = null; this._keepFieldAboveBar(); }, 120);
    }
  },

  /* 页面级下拉刷新入口（原生下拉回弹动画） */
  onPullDownRefresh() { this.layoutBrand(); this.onRefresh(); },

  /* 再点一次底部「记」：整页回到顶部 */
  onTabReselect() {
    wx.pageScrollTo({ scrollTop: 0, duration: 300 });
  },

  /* 切到其它 tab 再切回来（或首次进入）：整页回到顶部 */
  scrollToTop() {
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  /* 切换 tab 进入本页：恢复初始状态（回到默认维度、清空记卡草稿与浮层），并回顶 */
  resetToInitial() {
    this.clearFloats();
    const mods = this.modulesVM();
    const def = mods.some(m => m.k === 'obs') ? 'obs' : (mods[0] && mods[0].k);
    this.st.edit = null;
    this.st.tag = def;
    this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
    this.st.due = 0;
    this.st.startMode = false; this.st.doing = false; this.st.completing = false;
    this.st.showDoing = false; this.st.showDone = false;
    this.st.abandoning = false; this.st.showAbandon = false; this.st.ending = false; this.st.focusFree = '';
    this.st.todayLocked = null;   // 回初始态：清掉「今日」只读锁定（若停在今日维度再回来会重新判定）
    this.ensureModuleDefaults(def);
    this.setData({ editing: false, tag: def, focusIdx: -1, saveUndo: null, recentTab: 'recent', todayLocked: null });
    this.recompute();
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  /* 滚到底部：让底部「记」图标跳一下，提示可以点它回顶 */
  onReachBottom() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().hint();
  },

  /* -------- 编辑态（回显）锁定 -------- */
  // composer 内的点击在这里截止，不冒泡到 body（编辑当前记卡内容是允许的）；
  // 但它同样「不是操作条 / 撤销条」，所以顺手把浮层收起来
  noop() { this.clearFloats(); },

  // 编辑态下，除「编辑当前记卡内容」与「保存修改 / 取消」以外的操作都拦下，
  // 提示先把这一条处理完（保存按钮已常驻卡片底部，无需滚动定位）
  guardEdit() {
    if (!this.data.editing) return false;
    this.tipSaveFirst();
    return true;
  },

  // 每次被拦下的点击都提示一次。连续点击时先 hideToast，
  // 否则上一条 toast 还在显示，新的可能不弹出（表现为「只有第一次有提示」）
  tipSaveFirst() {
    if (wx.hideToast) wx.hideToast();
    wx.showToast({ title: '请先保存修改或取消', icon: 'none', duration: 800 });
  },

  /* 记卡里是否已经有「用户填的 / 选的」内容。
     自动补的默认值不算：进 可做 / 待办 / 随记 / 觉察 时会替你把 分类 / 类别 / 怎么开始的
     选上第一个（见 ensureModuleDefaults），那是系统选的不是你选的——算进去的话，
     一进这些维度就永远切不动了。
     同理放过 applyAdded 替他选上的那一项（从选项管理页加了新选项回来、那一组正好空着）：
     那也是替他选的，他没打算在这张卡上写东西，不该因此被拦着切不了维度。 */
  _composerDirty() {
    const s = this.st;
    if ((s.main || '').trim()) return true;
    if (s.mainPick && s.mainPick !== (this._autoPick || {}).main) return true;
    if (s.due) return true;   // 挑过「计划完成」也算内容：切维度会把 st 整块重置，那是白挑
    const def = this._defaultPicks();
    const ap = this._autoPick || {};
    const pk = s.pick || {};
    for (const g in pk) {
      const arr = pk[g] || [];
      if (!arr.length) continue;
      if (def[g] != null && arr.length === 1 && String(arr[0]) === String(def[g])) continue;  // 只是默认值
      if (ap[g] != null && arr.length === 1 && String(arr[0]) === String(ap[g])) continue;    // 刚从管理页带回来的那一项
      return true;
    }
    const td = s.typed || {};
    for (const g in td) if ((td[g] || '').trim()) return true;
    const fr = s.free || {};
    for (const k in fr) if ((fr[k] || '').trim()) return true;
    return false;
  },
  // 各维度自动补上的那一个选项（「不算用户选的」的白名单）
  _defaultPicks() {
    const t = this.st.tag, d = {};
    if (t === 'want' && store.wantKindDefault) d.wantKind = (store.wantKindDefault() || [])[0];
    if (t === 'todo' && store.todoKindDefault) d.todoKind = (store.todoKindDefault() || [])[0];
    if (t === 'todo' && store.todoPrioDefault) d.todoPrio = (store.todoPrioDefault() || [])[0];
    if (t === 'jot' && store.jotKindDefault) d.jotKind = (store.jotKindDefault() || [])[0];
    if (t === 'obs' && store.obsStartDefault) d.obsStart = (store.obsStartDefault() || [])[0];
    return d;
  },
  // 记卡里有内容时不切维度（切了整块内容就没了，且没有撤销），提示先处理掉
  tipDirty() {
    if (wx.hideToast) wx.hideToast();
    wx.showToast({ title: '记卡里有内容，先记下再切', icon: 'none', duration: 1000 });
  },

  // 主题切换在编辑态被锁：提示先处理当前编辑（与页面内其它无效操作一致）
  onLocked() { this.guardEdit(); },

  // 编辑区之外（最近列表、空白处等）的点击：操作条与撤销条都收起
  onBodyTap() {
    this._clearBarFollow();   // 点空白处键盘会收起：跟着输入框的操作行先回位（编辑态被拦下也一样）
    if (this.guardEdit()) return;
    this.clearFloats();
  },

  /* -------- 保存 -------- */
  doSave() {
    // 防重入：写云是异步的，从点下到云端返回这几百毫秒里按钮还点得到，
    // 而表单要到回调里才清空——手抖连点两下，第二下读到的还是同一份内容，
    // 于是同一条被落了两遍（列表里出现两条一样的）。
    // 这里在**发起写入前**上锁，回调（成功或失败）里解锁；校验失败的分支本来就没写云，不用管。
    if (this._saving) return;
    const f = store.fieldsOf(this.st.tag);
    if (!f) { wx.showToast({ title: '这个维度已不存在', icon: 'none' }); return; }
    // 编辑时：按记录类型拼装时间
    //  · 非 done：创建时间=ts；做了(legacy m='done')：结束时间=ts(完成)，创建(惦记)=refTs
    //  · 新流程 want+done：创建时间=ts，完成时间=doneAt（可被「结束时间」输入框改写）
    //  · 开始时间=startedAt（want 在做 / done 时存在）
    const editing = !!this.st.edit;
    const er = this.st.edit || {};
    const erDoneLegacy = er.m === 'done';
    const erWantDone = (er.m === 'want') && (er.status === 'done' || this.st.completing);
    // 与 checkEdit 的 isWantAbandon 对齐：可做的「不做」记录 + 已放弃的待办，都用「放弃时间」输入框的值
    const erWantAbandon = ((er.m === 'want') && (er.status === 'abandon' || this.st.abandoning)) ||
                          (store.isTask(er.m) && er.status === 'abandon');
    const c = tsFromDate(this.data.editDate, this.data.editTime);
    let startedAt = er.startedAt || 0;
    if (this.data.editHasStart) startedAt = tsFromDate(this.data.editStartDate, this.data.editStartTime).ts;
    let recTs, recT, refTs = er.refTs || 0;
    if (erDoneLegacy) {
      const e = tsFromDate(this.data.editEndDate, this.data.editEndTime);
      recTs = e.ts; recT = e.t;   // 结束时间 = 完成时间
      refTs = c.ts;               // 惦记(创建)时间
    } else {
      recTs = c.ts; recT = c.t;   // 创建时间
    }
    const rec = { m: this.st.tag, t: recT, ts: recTs };
    // 备忘/购物：勾选完成态（编辑时沿用原完成态）
    rec.done = editing ? (!!er.done) : false;
    rec.doneAt = editing ? (er.doneAt || 0) : 0;
    // 保留流转相关字段（状态 / 开始时间 / 来源），避免编辑时被丢
    rec.status = er.status || '';
    rec.startedAt = startedAt;
    // 计划完成：待办在记卡里就能设（那一行 chips）。其余维度沿用原值——
    // 它们是顶层字段，不在 ext 里，漏搬就会在保存后内存那条被 decorate 归 0。
    // 先把 dueTs 摆成**原值**再让 setDue 换：它靠「新旧不同」判断要不要连带清 calTs，
    // 要是先把新值填进去，它看到的就永远是「没变」，标记也就永远清不掉了
    rec.dueTs = er.dueTs || 0;
    // 已推日历：记卡里仍然没有这一格（要重新推走操作条上的按钮），只把原值搬过来
    rec.calTs = er.calTs || 0;
    store.setDue(rec, this.st.tag === 'todo' ? (this.st.due || 0) : (er.dueTs || 0));
    // 「开始」流转进入：保存时才落「进行中感受」这一刻——状态置在做、开始时间记当前
    if (this.st.startMode) { rec.status = 'doing'; rec.startedAt = Date.now(); }
    // 「完成」流转进入：保存时才置「做了」并记录完成时间（默认现在）
    if (this.st.completing) { rec.status = 'done'; rec.doneAt = Date.now(); }
    // 「放弃」流转进入：保存时才置「不做」并记录放弃时间（默认现在）
    if (this.st.abandoning) { rec.status = 'abandon'; rec.abandonedAt = Date.now(); }
    if (er.ref) rec.ref = er.ref;
    if (er.refTxt) rec.refTxt = er.refTxt;
    if (erDoneLegacy) rec.refTs = refTs;
    // 新流程「做了」记录(want+done)：完成时间改用「结束时间」输入框，用户改过才覆盖
    if (erWantDone && this.data.editHasEnd) {
      const e = tsFromDate(this.data.editEndDate, this.data.editEndTime);
      if (e.ts) rec.doneAt = e.ts;
    }
    // 不做 记录(want+abandon)：放弃时间改用「放弃时间」输入框，用户改过才覆盖
    if (erWantAbandon && this.data.editHasAbandon) {
      const e = tsFromDate(this.data.editAbandonDate, this.data.editAbandonTime);
      if (e.ts) rec.abandonedAt = e.ts;
    }
    // 觉察(obs)：结束时间
    // - 点「结束」进入（ending）：保存修改这一刻才落结束时间（默认现在），此前不写云；
    // - 点「改」进来且显示结束时间输入框：用户改过才覆盖；
    // - 未结束且非结束流转：保持原样，编辑内容不碰结束时间
    if (er.m === 'obs') {
      if (this.st.ending) {
        rec.endTs = Date.now();
      } else if (this.data.editHasEnd) {
        const e = tsFromDate(this.data.editEndDate, this.data.editEndTime);
        if (e.ts) rec.endTs = e.ts;
      } else {
        rec.endTs = er.endTs || 0;
      }
    }
    // 主项：从选项池点选（对着没有「描述」的模块，也允许手填——手填只记这一条，不进选项池）
    const mainRaw = this.st.mainPick || this.st.main || '';
    rec.txt = (mainRaw || '').trim();
    // 主项（选项）是必填的那一半，下面那个「具体的描述」是可省的——**描述不顶替主项**：
    // 觉察 / 此刻（想记的是）/ 可做（什么事）一个口径，主项只能从选项池点选（旧记录里手填过的主项
    // 会以临时 chip 排在选项最前，编辑时照旧能改能留）。今日是唯一例外：只选能量不写字也行。
    if (!rec.txt && this.st.tag !== 'today') {
      const descItem = f && (f.items || []).find(it => it.free === store.DESC_KEY);
      // 带「描述」的模块没有主输入框（主项只能点）→ 提示去点选项；其余模块提示写一句
      const ml = (descItem && f && f.main && store.GLABEL[f.main]) || '';
      wx.showToast({ title: ml ? '先选一个「' + ml + '」' : '先写点什么', icon: 'none' });
      return;
    }
    // 今日：能量为必选
    if (this.st.tag === 'today' && (!this.st.pick['todayBat'] || !this.st.pick['todayBat'].length)) {
      wx.showToast({ title: '先选一下今天的能量', icon: 'none' });
      return;
    }
    // 今日一日一记：同一天只允许一条。
    // ① 新建：要查当天有没有（正常流切到「今日」时当天已有记录会直接载入编辑，见 onTag；
    //    这里防的是「本会话中途才从云端同步进来」的记录）；
    // ② 编辑：把创建时间改到别的日子时，那天若已有今日记录就不许存——否则会出现两条。
    //    判断按**改后的创建时间**（rec.ts）走，并排除自己这条，否则改个时刻也会误报。
    if (this.st.tag === 'today') {
      const selfId = editing ? ((this.st.edit || {}).id || (this.st.edit || {})._rid) : null;
      const target = editing ? rec.ts : Date.now();
      const start = date.dayStart(target);
      const dup = (app.globalData.records || []).find(r =>
        r.m === 'today' && r.id !== selfId && r.ts >= start && r.ts < start + date.DAY);
      if (dup) {
        // datePrefix 对「今天」返回空串，所以先自己判一次，提示里才带得清是哪天
        const dl = store.datePrefix(dup.ts).trim();
        const dayName = dl || '今天';
        wx.showToast({ title: dayName + '已经记过了', icon: 'none', duration: 1600 });
        if (!editing) { app.globalData.editRec = store.decorate(dup); this.checkEdit(); }
        return;
      }
    }
    // 想做模块：分类为必选（默认已选「想做」）
    if (this.st.tag === 'want' && (!this.st.pick['wantKind'] || !this.st.pick['wantKind'].length)) {
      wx.showToast({ title: '请选择分类（想要/可做/喜欢）', icon: 'none' });
      return;
    }
    // 待办：类别为必选（默认已选「备忘」）
    if (this.st.tag === 'todo' && (!this.st.pick['todoKind'] || !this.st.pick['todoKind'].length)) {
      wx.showToast({ title: '请选择类别', icon: 'none' });
      return;
    }
    // 随记：类别为必选（默认已选「念头」）
    if (this.st.tag === 'jot' && (!this.st.pick['jotKind'] || !this.st.pick['jotKind'].length)) {
      wx.showToast({ title: '请选择类别', icon: 'none' });
      return;
    }
    const ext = [], extSrc = [];
    f.items.forEach(it => {
      if (it.g) {
        (this.st.pick[it.g] || []).forEach(v => { ext.push(v); extSrc.push(it.g); });
        const tv = (this.st.typed[it.g] || '').trim();
        if (tv && ext.indexOf(tv) < 0) { ext.push(tv); extSrc.push(it.g); }
      } else if (it.fx) {
        (this.st.pick['fx:' + it.fx] || []).forEach(v => { ext.push(v); extSrc.push('fx:' + it.fx); });
      } else if (it.free) {
        const fv = (this.st.free[it.free] || '').trim();
        if (fv) { ext.push(fv); extSrc.push('free:' + it.free); }
      }
    });
    rec.ext = ext; rec.extSrc = extSrc;

    // 上锁：从这里起直到回调解锁，中间再点「记下」直接忽略。
    // 同时把按钮置灰——被忽略的那一下要看得见「正在写」，否则像点了没反应
    this._saving = true;
    this.setData({ saving: true });
    // 兜底解锁：云端要是卡住不回调（弱网 / 环境抽风），锁不能永远留着把按钮变成死按钮。
    // 12s 还没回来就放开门槛——真写成功了的话记录本来也已经进列表
    if (this._saveUnlockTimer) clearTimeout(this._saveUnlockTimer);
    this._saveUnlockTimer = setTimeout(() => {
      this._saveUnlockTimer = null;
      this._unlockSave();
    }, 12000);
    if (this.st.edit) {
      rec._rid = this.st.edit._rid; rec.id = this.st.edit.id;
      store.updateRecord(rec).then(() => {
        this._unlockSave();
        const G = app.globalData;
        const i = G.records.findIndex(r => r._rid === rec._rid);
        if (i >= 0) G.records[i] = store.decorate(rec);
        this.afterSave(rec);
      }).catch(() => { this._unlockSave(); });
    } else {
      store.addRecord(rec).then(rid => {
        this._unlockSave();
        rec._rid = rid; rec.id = rid;
        app.globalData.records.unshift(store.decorate(rec));
        this.afterSave(rec);
      }).catch(() => { this._unlockSave(); });
    }
  },
  // 解锁并把按钮恢复原样（成功走 afterSave，失败单独调一次）
  _unlockSave() {
    if (this._saveUnlockTimer) { clearTimeout(this._saveUnlockTimer); this._saveUnlockTimer = null; }
    this._saving = false;
    this.setData({ saving: false });
  },
  // 「可做」的分类、「待办」的类别、「随记」的类别都是必选项：清空表单后要把默认值补回来，
  // 否则选中态丢失，下一条还会因「请选择…」而记不进去；
  // 觉察的「怎么开始的」不是必选，但也有个默认（自己想做），填的时候少点一下
  ensureModuleDefaults(tag) {
    const t = tag || this.st.tag;
    if (t === 'want' && !this.st.pick['wantKind']) this.st.pick['wantKind'] = store.wantKindDefault();
    if (t === 'todo' && !this.st.pick['todoKind']) this.st.pick['todoKind'] = store.todoKindDefault();
    // 优先级默认「不紧急不重要」：新建待办不点也有值，但列表里不显示标记（见 store.prioShow）
    if (t === 'todo' && !this.st.pick['todoPrio']) this.st.pick['todoPrio'] = store.todoPrioDefault();
    if (t === 'jot' && !this.st.pick['jotKind']) this.st.pick['jotKind'] = store.jotKindDefault();
    if (t === 'obs' && !this.st.pick['obsStart']) this.st.pick['obsStart'] = store.obsStartDefault();
  },

  afterSave(rec) {
    const isEdit = !!this.st.edit;   // 先记下：编辑保存与新记下的提示不同（编辑没有「撤销这条」这回事）
    this.st.edit = null; this.st.startMode = false; this.st.doing = false; this.st.completing = false; this.st.showDoing = false; this.st.showDone = false;
    this.st.abandoning = false; this.st.showAbandon = false; this.st.ending = false; this.st.focusFree = '';
    this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
    this.st.due = 0;   // 计划完成也一并归零：下一条待办默认又没有计划（「没计划」是常态）
    this.ensureModuleDefaults();   // 记下后仍在 可做 / 待办 / 随记 时，把默认分类 / 类别选回来
    // 锁定态只对**今天**成立：把这条改到昨天 / 前几天后，今天并没有记录，
    // 不能进锁定态（否则用户以为今天记过了、结果再也记不了今天）。
    // 那种情况直接回到可编辑的新建态，今天想记还能记。
    if (rec && rec.m === 'today') {
      const st0 = date.dayStart(Date.now());
      const isToday = rec.ts >= st0 && rec.ts < st0 + date.DAY;
      this.st.todayLocked = isToday ? this._todayLockedOf(rec) : null;
    }
    this.setData({ editing: false, focusIdx: -1, editDate: '', editTime: '', editHasStart: false, editStartDate: '', editStartTime: '', editHasEnd: false, editEndDate: '', editEndTime: '', editHasAbandon: false, editAbandonDate: '', editAbandonTime: '', todayLocked: this.st.todayLocked });
    this.recompute();
    if (isEdit) { wx.showToast({ title: '已更新', icon: 'none', duration: 800 }); return; }
    this._showSavedBar(rec);
  },
  // 把一条「今日」记录包成只读锁定态视图对象（算好能量条格数，供记卡顶部摘要块用）
  _todayLockedOf(rec) {
    const r = store.decorate(rec);
    const bi = (r.extSrc || []).indexOf('todayBat');
    const bv = bi >= 0 ? (r.ext || [])[bi] : '';
    r.lv = store.batLevel(bv);      // 能量条点亮几格（1..5）
    r.d = store.datePrefix(r.ts);  // 右起显示创建时间用的日期前缀（与时间线行同一口径）
    r.batName = store.batName(bv);
    return r;
  },
  /* 今日已填：点「修改」→ 把当天那条载入编辑态（回填电池 + 印象），可改可保存 */
  onTodayEdit() {
    if (!this.st.todayLocked) return;
    app.globalData.editRec = this.st.todayLocked;
    this.checkEdit();
    this.recompute();
  },
  onEditCancel() {
    const rec = this.st.edit;
    // 取消的是「今日」记录：按「今天到底记没记过」重新判定锁定态。
    // 不只取 st.todayLocked——编辑也可能从别的页直接进来（最近列表的操作条「改」、看页的今日卡片），
    // 那条路没走过 onTag（只有 onTag 会写 todayLocked），取消就会掉回新建态：
    // 又能选一次剩余能量、再写一句，而今天其实已经记过了（保存时才不会重复，取消却露出空表单）。
    // 这里与 afterSave 同一口径：今天有「今日」记录 → 回只读锁定态，显示已记的那条
    const locked = (rec && rec.m === 'today') ? this._todayLockedNow(rec) : this.st.todayLocked;
    this.st.edit = null; this.st.startMode = false; this.st.doing = false; this.st.completing = false; this.st.showDoing = false; this.st.showDone = false; this.st.abandoning = false; this.st.showAbandon = false; this.st.ending = false; this.st.focusFree = ''; this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {}; this.st.due = 0;
    this.ensureModuleDefaults();   // 取消编辑后仍在 可做 / 待办 / 随记 时，把默认分类 / 类别选回来
    this.st.todayLocked = locked;   // 与展示同步：接下来的判定（点 chip、切维度）都按这一份
    this.setData({ editing: false, focusIdx: -1, editDate: '', editTime: '', editHasStart: false, editStartDate: '', editStartTime: '', editHasEnd: false, editEndDate: '', editEndTime: '', editHasAbandon: false, editAbandonDate: '', editAbandonTime: '', todayLocked: locked });
    this.recompute();
  },
  /* 退出编辑（或保存）后「今日」该不该是只读锁定态：今天库里已有「今日」记录就包成只读视图，否则 null。
     按**库里**那条取，不按编辑中那条——编辑时可能已经把日期改到别的天，而取消不该把未保存的改动当真 */
  _todayLockedNow(rec) {
    const start = date.dayStart(Date.now());
    const end = start + date.DAY;
    const dup = (app.globalData.records || []).find(r => r.m === 'today' && r.ts >= start && r.ts < end);
    const r = dup || (rec && rec.m === 'today' && rec.ts >= start && rec.ts < end ? rec : null);
    return r ? this._todayLockedOf(r) : null;
  },

  /* ---------------- 长按记录：复制这句话 ----------------
     最近里的三个手势分工：点一下出操作条（改 / 删，见 onRecentTap → onRecAction）、
     左滑就地改这一条（见 onRowTouchend → swipeEdit）、长按把内容抄走。
     长按复制是常用动作——最近里记的多是一句话，贴到别处（微信、备忘录）比就地改动更常见。
     复制后由微信自己弹「内容已复制」（setClipboardData 自带），这里再补一下触感，
     免得「不知道到底复制上没有」。 */
  onRecentLongPress(e) {
    if (this.guardEdit()) return;   // 正在编辑其它记录：先处理编辑态
    const id = e.currentTarget.dataset.id;
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r) return;
    this._lpAt = Date.now();   // 长按后紧跟的那次点击要忽略掉，否则会顺手弹出操作条
    this.copyRec(r);
  },
  /* 把一条记录放进剪贴板：只复制那一句话本身（最近列表里最显眼的就是它） */
  /* copyRec 已收敛到 utils/pageBase.js */

  /* 量取该行「整张卡片」的位置（文档坐标）→ 赋值并打开编辑器（量好再显示，避免闪到上一次的位置）。
     gesture=true（左滑触发）时手指正好在抬起，聚焦要隔一拍再做——抬手瞬间聚焦会被微信
     当成「点到外面」把输入框 blur 掉（与长按那套同一个坑，见 focusQe） */
  _openQ(id, txt, gesture) {
    const q = wx.createSelectorQuery().in(this);
    q.selectViewport().scrollOffset();
    q.select('#erow-' + id).boundingClientRect();
    q.exec(res => {
      const scrollTop = (res[0] && res[0].scrollTop) || 0;
      const rect = res[1];
      if (!rect) return;
      this.setData({
        qe: {
          top: Math.round(rect.top + scrollTop),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        recSel: null, recSelRec: null,
        qeId: id, qeTxt: txt, qeOn: true, qeFocus: false
      });
      // 兜底：万一聚焦没成功（手势被系统吞掉），过一会儿自己再试一次
      if (this._focusTimer) clearTimeout(this._focusTimer);
      this._focusTimer = setTimeout(() => this.focusQe(), gesture ? 60 : 500);
    });
  },

  /* 手指抬起后再聚焦：弹出编辑器时就聚焦的话，抬手瞬间微信的「点到外面」会把输入框 blur 掉，
     表现为「一松手输入框就关了」 */
  focusQe() {
    if (!this.data.qeOn || this.data.qeFocus) return;
    this._focusAt = Date.now();
    this.setData({ qeFocus: true });
  },

  /* 左滑某一行＝改这一条：**打开快捷记面板并回显**（文本 + 类别 + 优先级一起改，保存＝更新原记录）。
     以前这里只弹一个行内输入框（改得了话、改不了类别与优先级），待办有了优先级之后就不够用了。
     拿不到面板才退回行内编辑器（上面还开着一条时先收起——_closeQ 会把紧随的那次 save 事件挡掉，
     隔一拍再弹新的，否则旧输入框的失焦会把内容存到刚滑开的那条上） */
  swipeEdit(id, txt) {
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (r && this.quickEdit(r)) { if (this.data.qeOn) this._closeQ(); return; }
    if (this.data.qeOn) {
      this._closeQ();
      if (this._openTimer) clearTimeout(this._openTimer);
      this._openTimer = setTimeout(() => { this._openTimer = null; this._openQ(id, txt, true); }, 170);
      return;
    }
    this._openQ(id, txt, true);
  },

  /* 最近里的行级手势。**只有「行尾起手 + 向左滑（且划得比切 tab 更远更平）」才算行内动作**（改这一条）：
     两道门槛都在 utils/swipe.js（EDGE_W 收窄到 56、rowLeft 要 72px 且更平）——
     改这一条与切 tab 都是往左滑，同门槛必然打架，所以让改更「刻意」一点。
     行铺满整个列表区，若把行上所有横滑都收走，「切 最近/待办/已完成」就没法触发了。
     判成行内时才调 swipe.end 吃掉起点（列表区那次 end 就什么也拿不到）；其余情况原样不动，
     交给列表区切三段 / 根节点切维度。纵向滑动照旧交给页面滚动（swipe 只认横向明显更大的那下） */
  onRowTouchStart(e) { this._rowEdge = swipe.atEdge(e); swipe.start(this, e); },
  onRowTouchCancel() { this._swX = null; this._swY = null; },
  onRowTouchend(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const edge = this._rowEdge; this._rowEdge = false;
    if (edge && ds.id != null && swipe.rowLeft(this, e)) {
      swipe.end(this, e);   // 这一下归行内：吃掉起点，上层那两次 end 就什么也拿不到
      const r = (app.globalData.records || []).find(x => x.id === ds.id);
      if (r && !this.guardEdit()) {
        this._lpAt = Date.now();   // 刚滑过：紧跟其后的 tap（若有）不当成点选
        // 一句话的记录（待办 / 随记）就地改；字段多的维度（觉察 / 此刻 / 可做）就地改不下，进记卡
        if (store.isTask(r.m) || r.m === 'jot') this.swipeEdit(ds.id, r.txt || '');
        else this.editInCard(r);
      }
      return;
    }
    this.focusQe();
  },

  /* 左滑「字段多的记录」＝进记卡完整编辑（与从操作条点「改」同一条路） */
  editInCard(r) {
    app.globalData.editRec = store.decorate(r);
    this.checkEdit();   // 进入编辑态后由 checkEdit 统一滚回顶部
    this.recompute();
  },

  /* 组件派发 save：失焦 / 键盘「完成」/ 点「保存」都走这里；改空或没改动则不落云 */
  onQSave(e) {
    if (this._qeClosing) return;
    // 刚聚焦就被系统「点到外面」blur 掉（长按抬手那一下）：忽略，不要当成用户改完了
    if (this._focusAt && Date.now() - this._focusAt < 400) return;
    const id = this.data.qeId;
    if (!id || !this.data.qeOn) return;
    const txt = ((e.detail && e.detail.value) || '').trim();
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r || (!store.isTask(r.m) && r.m !== 'jot') || !txt || txt === r.txt) { this._closeQ(); return; }
    r.txt = txt;
    store.updateRecord(r).catch(() => {});
    this._closeQ();
    this.recompute();
    wx.showToast({ title: '已更新', icon: 'none' });
  },

  /* 收起：位置原地不动，只把宽高收成 0。
     一挪位置，微信会把「带焦点的输入框」滚进可视区（键盘重弹 + 页面跳回顶部）；
     挪走之前保留 qeId，让那一行继续隐身，避免与原生层残留互相重影 */
  _closeQ() {
    this._qeClosing = true;
    setTimeout(() => { this._qeClosing = false; }, 150);
    this._focusAt = 0;
    const qe = this.data.qe || {};
    this.setData({
      qeOn: false,
      qeFocus: false,
      qeId: '',
      qeTxt: '',
      qe: { top: qe.top || 0, left: qe.left || 0, width: 0, height: 0 }
    });
  },

  /* 就地编辑里的「删除」：删掉这条待办 / 随记，并给出撤销机会（复用底部撤销条） */
  onQDel() {
    const r = (app.globalData.records || []).find(x => x.id === this.data.qeId);
    this._closeQ();
    if (!r || (!store.isTask(r.m) && r.m !== 'jot')) return;
    this._delRec(r);
  },
  /* 快捷记面板（回显编辑态）里的「删除」：走本页自己的删除，与操作条上的「删除」同一套撤销条 */
  delRecById(id) {
    if (!id) return;
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r || (!store.isTask(r.m) && r.m !== 'jot')) return;
    this._delRec(r);
  },

  /* 点「最近」记录：选中并弹出「改 / 删除」操作条 */
  onRecentTap(e) {
    if (this._lpAt && Date.now() - this._lpAt < 400) return;   // 长按刚触发过，忽略随之而来的点击
    if (this.guardEdit()) return;   // 编辑态：不允许选中其它记录
    const id = e.currentTarget.dataset.id;
    if (this.data.recSel === id) { this.setData({ recSel: null, recSelRec: null }); return; }
    const r = (app.globalData.records || []).find(x => x.id === id);
    this.setData({ recSel: id, recSelRec: r ? { m: store.recMname(r), txt: r.txt, rawm: r.m, status: r.status || '', ended: !!r.endTs, done: !!r.done, dueTs: r.dueTs || 0, calTs: r.calTs || 0 } : null });
  },

  /* 记录操作条统一入口（记页「最近」与看页共用 rec-actions 组件；行为各自实现，按钮集合只维护一处）
     type: start | complete | abandon | restore | end | edit | del */
  onRecAction(e) {
    if (this.guardEdit()) return;   // 编辑态：不允许对其它记录做流转/改/删
    const type = e.detail.type;
    const id = this.data.recSel; if (id == null) return;
    if (type === 'cal') { this.pushCal(id); return; }   // 推到手机日历（三页共用 pageBase 的实现）
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r) return;
    // 待办（备忘 / 购物）：恢复只动状态与时间；**放弃要填原因**，所以与「改」一样进记卡回显这一条
    //   （保存修改时才真的落「已放弃」与时间，取消则什么都不变）；完成仍走条目上的勾选框。
    //   改 / 删除照常走下面的统一分支——之前这里把 edit / del 也一并 return 掉了，
    //   于是操作条上的「改」「删除」点了没反应（清单页是好的，只有记页 / 看页这样）
    if (store.isTask(r.m) && (type === 'abandon' || type === 'restore')) {
      if (type === 'restore') {
        r.status = ''; r.abandonedAt = 0;
        store.updateRecord(r).catch(() => {});
        this.setData({ recSel: null, recSelRec: null });
        this.recompute();
        return;
      }
      app.globalData.editRec = r;
      app.globalData.editAbandon = true;
      this.setData({ recSel: null, recSelRec: null });
      this.checkEdit(); this.recompute();
      return;
    }
    if (type === 'start' || type === 'complete' || type === 'abandon') {
      if (r.m !== 'want') return;
      app.globalData.editRec = r;
      if (type === 'start') app.globalData.editStart = true;
      if (type === 'complete') app.globalData.editComplete = true;
      if (type === 'abandon') app.globalData.editAbandon = true;
      this.setData({ recSel: null, recSelRec: null });
      this.checkEdit(); this.recompute();
      return;
    }
    if (type === 'restore') {
      if (r.m !== 'want' || r.status !== 'abandon') return;
      const now = Date.now();
      r.status = ''; r.ts = now; r.t = nowStr();
      r.abandonedAt = 0; r.startedAt = 0;
      const es = r.extSrc || [], ex = r.ext || [];
      const keep = [];
      for (let i = 0; i < es.length; i++) { if (es[i] === 'free:abandonWhy') continue; keep.push(i); }
      r.extSrc = keep.map(i => es[i]); r.ext = keep.map(i => ex[i]);
      store.updateRecord(r).catch(() => {});
      this.setData({ recSel: null, recSelRec: null });
      this.recompute();
      return;
    }
    if (type === 'end') {
      if (r.m !== 'obs') return;
      // 不在这里落结束时间：只标记待结束，等点「保存修改」时才记录结束时间并写云
      // 同时打开编辑态聚焦「感受」输入框、弹键盘，便于立刻记感受
      app.globalData.editRec = r;
      app.globalData.editEnding = true;
      app.globalData.editEndFocus = true;
      this.setData({ recSel: null, recSelRec: null });
      this.checkEdit();
      this.recompute();
      return;
    }
    if (type === 'edit') {
      app.globalData.editRec = store.decorate(r);
      this.checkEdit(); this.recompute();   // 进入编辑态后由 checkEdit 统一滚回顶部
      this.setData({ recSel: null, recSelRec: null });
      return;
    }
    if (type === 'del') { this.onRecDel(); return; }
  },

  /* 点页面其它地方：收起记录操作条（失焦即关） */
  closeRecSel() {
    if (this.data.recSel != null) this.setData({ recSel: null, recSelRec: null });
  },

  /* 点到「任何一个不是浮层本身」的地方（含记卡内部、空白、切页）：操作条与撤销条都收起。
     离开页面（onHide）也走这里——否则切 tab / 去清单再回来，操作条还挂在那儿 */
  clearFloats() {
    const patch = {};
    if (this.data.recSel != null) { patch.recSel = null; patch.recSelRec = null; }
    if (this.data.delUndo) { patch.delUndo = null; this._stopDelTimer(); }
    if (this.data.saveUndo) { patch.saveUndo = null; this._stopSaveTimer(); }
    if (Object.keys(patch).length) this.setData(patch);
  },
  /* _stopDelTimer / _startDelTimer 已收敛到 utils/pageBase.js */

  /* 记下后的确认条：写清记进了哪个模块（觉察还会带上喜恶），并按模块给一个动作——
     待办（备忘 / 购物）给「撤销」：它常常是随手一句、更容易打错，与悬浮球快捷记同一套心智；
     其它维度（觉察 / 此刻 / 可做）给「改一下」：那些是逐项填过的，要改就回编辑态，不是整条重来。
     3.2 秒后自动收起，点别处也收起 */
  _showSavedBar(rec) {
    this.setData({ saveUndo: { id: rec.id, name: store.recMname(rec), txt: rec.txt, task: store.isTask(rec.m) } });
    this._stopSaveTimer();
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this.data.saveUndo) this.setData({ saveUndo: null });
    }, 3200);
  },
  _stopSaveTimer() { if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; } },
  /* 确认条上的「改一下」：直接进入刚记下那条的编辑态
     （省掉「去最近列表里找到它 → 点一下 → 点改」三步；走同一套 checkEdit，会滚回顶部露出记卡） */
  onEditSaved() {
    if (this.guardEdit()) return;
    const u = this.data.saveUndo; if (!u) return;
    this._stopSaveTimer();
    this.setData({ saveUndo: null });
    const r = (app.globalData.records || []).find(x => x.id === u.id);
    if (!r) return;
    app.globalData.editRec = r;
    this.checkEdit();
    this.recompute();
  },
  /* 确认条上的「撤销」（待办）：删掉刚记下的那条并给个说法（与悬浮球快捷记一致） */
  onUndoSaved() {
    if (this.guardEdit()) return;
    const u = this.data.saveUndo; if (!u) return;
    this._stopSaveTimer();
    this.setData({ saveUndo: null });
    const arr = app.globalData.records || [];
    const i = arr.findIndex(r => r.id === u.id);
    if (i < 0) return;
    const r = arr[i];
    store.deleteRecord(r).catch(() => {});
    arr.splice(i, 1);
    this.recompute();
    wx.showToast({ title: '已撤销', icon: 'none' });
  },

  /* 备忘/购物：勾选切换完成态（划线 + 记录完成时间） */
  onRecCheck(e) {
    if (this.guardEdit()) return;
    const id = e.currentTarget.dataset.id;
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r || !store.isTask(r.m)) return;
    r.done = !r.done;
    r.doneAt = r.done ? Date.now() : 0;
    store.updateRecord(r).catch(() => {});
    this.recompute();
  },

  /* 记页「最近」里待办行尾的「计划完成」胶囊：点一下＝取消计划。
     确认框、清标记、提示全走 pageBase.clearDue（清单页 / 看页同一份），
     这里只负责把 dataset 里的 id 取出来——记页的待办行是自己写的，取值路径与组件那条不同 */
  onRecentDue(e) {
    if (this.guardEdit()) return;
    this.clearDue(this._id(e));
  },

  /* 删除一条记录并给出撤销机会（操作条「删除」与就地编辑的「删除」共用） */
  _delRec(r) {
    const i = (app.globalData.records || []).indexOf(r);
    if (i < 0) return;
    store.deleteRecord(r).then(() => {
      app.globalData.records.splice(i, 1);
      this.setData({ recSel: null, recSelRec: null, delUndo: { m: store.recMname(r), txt: r.txt, dump: r } });
      this.recompute();
      this._startDelTimer();
    });
  },

  /* 点操作条「删除」：删除并给出撤销机会 */
  onRecDel() {
    if (this.guardEdit()) return;
    const id = this.data.recSel; if (id == null) return;
    const r = (app.globalData.records || []).find(x => x.id === id);
    if (!r) return;
    this._delRec(r);
  },

  onUndoDel() {
    if (this.guardEdit()) return;
    const u = this.data.delUndo; if (!u) return;
    // 防重入：撤销条要等 addRecord 的回调才清掉，这中间再点一下「撤销」会把同一条加两遍。
    // 先同步把 delUndo 清掉再发请求——这一下本来就是「撤销条已经用掉了」
    this._stopDelTimer();
    this.setData({ delUndo: null });
    const dump = u.dump;
    // 删除后撤销：忠实还原原记录，保留状态（未做/在做/做了/不做）、开始时间与放弃时间
    // （计划完成 / 已推日历也在 dumps 里，一起还原，否则撤销后那道胶囊就没了）
    const rec = { m: dump.m, t: dump.t, txt: dump.txt, ext: dump.ext || [], extSrc: dump.extSrc || [], ts: dump.ts, done: dump.done || false, doneAt: dump.doneAt || 0, status: dump.status || '', startedAt: dump.startedAt || 0, abandonedAt: dump.abandonedAt || 0, dueTs: dump.dueTs || 0, calTs: dump.calTs || 0 };
    store.addRecord(rec).then(rid => {
      rec._rid = rid; rec.id = rid;
      app.globalData.records.unshift(store.decorate(rec));
      this.recompute();
    }).catch(() => { this.setData({ delUndo: u }); this._startDelTimer(); });
  },

  /* 悬浮球「＋」快捷记下一条待办后：只刷新「最近」，不碰正在输入的内容；
     同时收掉记卡里那条「已记入」——两条说的是同一件事，留刚弹出的那条 */
  onQuickTodo() { this._stopSaveTimer(); this.setData({ saveUndo: null }); this.recompute(); },

  /* 下拉刷新：统一走页面级下拉（列表 refresher 已关闭）
     记录是串行分页拉的（每页 20 条，N 条要 N/20 次往返），全量等完要好几秒。
     所以第一页（最新 20 条）一到就先渲染并收起下拉，剩余页在后台补齐——和「看」页
     首屏就 stopPullDownRefresh 一个路子。补齐后 G.records 仍是全量，编辑/删除的
     findIndex、splice 都不受影响。 */
  onRefresh() {
    // 编辑态：下拉刷新会丢掉未保存的编辑，拦下
    if (this.data.editing) { wx.stopPullDownRefresh(); this.guardEdit(); return; }
    if (this._refreshing) { wx.stopPullDownRefresh(); return; }   // 已在刷新中，避免重复触发
    this._refreshing = true;
    // 名字这会儿正好从胶囊后露出来，播一次逐字浮现
    this.playBrand();

    const afterData = () => {
      wx.stopPullDownRefresh();
      this._refreshing = false;
      this.st.edit = null; this.st.main = ''; this.st.mainPick = null; this.st.pick = {}; this.st.typed = {}; this.st.free = {};
      this.st.due = 0;
      this.st.startMode = false; this.st.completing = false; this.st.abandoning = false; this.st.showDoing = false; this.st.showDone = false; this.st.showAbandon = false; this.st.ending = false;
      // 刷新后仍在「可做」/「待办」/「随记」时，补回默认分类 / 类别（避免被清空）
      this.ensureModuleDefaults();
      this.rotateGreet();
      this.recompute();
    };

    store.reload({
      // 第一页（最新 20 条）先到：先用它渲染，界面立刻可用，下拉也收起来
      onFirstPage: (firstPage) => {
        if (this._refreshing !== true) return;      // 全量已先完成（页数少时可能同一轮就回来了）
        const G = app.globalData;                  // store.globalData 就是 app.globalData
        const all = G.records || [];
        // 拼上内存里已有的更早记录，避免第一页覆盖掉正在看的老数据
        const seen = {}; firstPage.forEach(r => { seen[r._rid] = 1; });
        const older = all.filter(r => !seen[r._rid]);
        G.records = firstPage.concat(older);
        this.recompute();
        wx.stopPullDownRefresh();
      }
    }).then(afterData).catch(() => { wx.stopPullDownRefresh(); this._refreshing = false; });
  },

  /* 点「最近」标题右侧「清单」：进入待办清单（备忘 / 购物） */
  goList() {
    if (this.guardEdit()) return;
    wx.navigateTo({ url: '/pages/list/list' });
  },

  /* -------- 选项管理：跳转到独立子页面（返回即回「记」页，不退出小程序） -------- */
  onManage(e) {
    // 编辑态也允许去管理选项池：标记来源，返回时保留编辑中的内容与状态
    this.st.fromManage = true;
    const g = e.currentTarget.dataset.g;
    const url = '/pages/options/options?group=' + encodeURIComponent(g);
    wx.navigateTo({
      url,
      fail: (err) => {
        console.error('[manage] navigateTo 失败：', err, 'url=', url, '当前页面栈=', getCurrentPages().length);
        // 页面栈已满或跳转异常时，退一层再重试，避免用户彻底打不开
        const pages = getCurrentPages();
        if (pages.length >= 10) {
          wx.navigateBack({ delta: 1, success: () => wx.navigateTo({ url, fail: () => wx.showToast({ title: '打开管理页失败', icon: 'none' }) }) });
        } else {
          wx.showToast({ title: '打开管理页失败', icon: 'none' });
        }
      }
    });
  }
}));
