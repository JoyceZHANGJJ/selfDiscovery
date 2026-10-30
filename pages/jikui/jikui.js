const pageBase = require('../../utils/pageBase.js');
const store = require('../../utils/store.js');
const ui = require('../../utils/ui.js');

// 积跬步 —— 目标 / 待办树（移植自 /Users/zhangmilu/WorkBuddy/2026-10-28-16-24-02/积跬步.html）
//
// 数据存到云开发（专属的 jikui 集合，见 store.saveJikui / loadJikui）：
// 整棵树作为一篇文档 upsert 上云，按微信用户 _openid 自动隔离，换设备可同步。
// 本地用 wx.setStorageSync 做「即时渲染缓存」，云端回拉后再以其为准。
// 不再内置默认示例数据——首启是空的，从「新建愿望」开始。
//
// 树形用「扁平渲染」：把可见节点按层级展平成带 depth 的列表，WXML 不支持递归组件，
// 这是小程序里表达任意深度树最稳的办法（连接线用缩进表达，不做横线）。

const KEY = 'jikuibu.v1';
// 旧版内置的示例愿望标题：每次打开都按「整棵是否全是示例」判定并清掉（本地 + 云端），
// 不展示、不保留；用户自建的内容（标题不全是示例）不受影响。
const SEED_TITLES = ['我想床车旅行', '我想学会做咖啡'];
function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }
function mkTodo(title) { return { id: uid(), title: title || '', status: 0, repeat: 0, completions: [], expect: '', actual: '', completedAt: 0, children: [] }; }

// 完成时间格式化：M月D日 HH:mm
function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 历时格式化：fromTs → toTs（toTs = 完成时间 或 此刻）。
// 规则（按用户要求）：<365 天只显示「x天」；正好是 365 的倍数只显示「x年」；>365 显示「x年x天」。
function fmtElapsed(fromTs, toTs) {
  let days = Math.floor((toTs - fromTs) / 86400000);
  if (days < 0) days = 0;
  const years = Math.floor(days / 365);
  const rem = days % 365;
  if (years === 0) return days + '天';
  if (rem === 0) return years + '年';
  return years + '年' + rem + '天';
}

function countProgress(todos) {
  let done = 0, total = 0;
  // 重复待办是「习惯」，永不彻底完成，不计入 x/y 进度（它们一直在做）
  const walk = (ns) => { for (const n of ns) { if (n.repeat) { walk(n.children || []); continue; } total++; if (n.status === 1) done++; walk(n.children || []); } };
  walk(todos || []);
  return { done, total, pct: total ? Math.round(done / total * 100) : 0 };
}

// 待办是否「未完成 / 生效中」：不定次重复的待办永远算未完成——
// 它们不会彻底完成，只累积完成记录，所以无论 status 是否残留为 1，都仍然可以再点一次
function isOpenTodo(t) { return !!t.repeat || t.status === 0; }

Page(pageBase({
  data: {
    goalsView: [],
    active: null,      // { type:'addRoot'|'addChild'|'addSib'|'editGoal'|'editTodo', gid, tid }
    draft: '',         // 内联添加 / 编辑待办的草稿
    goalDraft: '',     // 行内编辑愿望标题的草稿
    goalDetailOpen: null,  // { gid }：愿望说明弹层开着的那条
    goalDesc: '',      // 愿望说明
    goalDescCount: 0,
    detailOpen: null,   // { gid, tid, willComplete }：待办详情弹层（备注 / 实际结果）开着的那条
    expectVal: '',      // 备注（可随时编辑；字段名仍为 expect，避免数据迁移）
    actualVal: '',      // 实际结果（完成后记录，由「感受」改名而来）
    expectCount: 0,
    actualCount: 0,
    navOpen: false,    // 目录浮层（愿望导航抽屉）是否展开
    navList: [],       // 抽屉里展示的「未结束」愿望列表
    doneOpen: false,   // 抽屉里「已结束」分区是否展开
    doneNav: [],       // 抽屉里展示的「已结束」愿望列表
    activeGid: null,   // 当前在页面上展示的那一个愿望（单视图）
    dragGid: '',       // 正在被拖动排序的事项 gid（目录下拉内）
    dragIndex: -1,     // 拖动中该项在 navList 里的当前下标
    dragY: 0,          // 拖动项跟随手指的纵向位移（px）
    navDragging: false, // 目录下拉是否处于拖动排序中（用于禁止面板滚动）
    dirTop: 24, dirH: 32, dirLeft: 14, // 目录悬浮胶囊定位：贴左缘、与微信胶囊同高
    headH: 56                          // 顶部占位高度：= 胶囊下沿，正文由 .jk-body 的 16px 上内边距起始
  },

  onLoad() {
    // 先读本地缓存即时渲染（避免闪白）；云端回拉后再以其为准
    try { const raw = wx.getStorageSync(KEY); this._goals = raw ? JSON.parse(raw) : []; }
    catch (e) { this._goals = []; }
    if (!Array.isArray(this._goals)) this._goals = [];
    // 兼容旧数据：早期版本存的目标没有创建时间，统一补上「现在」
    this._ensureCreatedAt();
    // 兼容旧数据：早期版本的待办用 reflection（感受），统一迁到 actual（实际结果）；并确保有 expect 字段
    this._migrate();
    // 旧版内置示例（床车旅行 / 做咖啡）不应再作为默认数据出现：本地若整棵都是示例，直接清空并落盘，
    // 不展示、不保留；真用户自建的内容（标题不全是示例）不受影响。云端那份在 _syncFromCloud 里同样清掉。
    if (this._isSeed(this._goals)) { this._goals = []; this._saveLocal(); }
    this.rebuild();
    this._syncFromCloud();
  },

  onShow() {
    this.ensureTheme();
    const tb = (typeof this.getTabBar === 'function') && this.getTabBar();
    if (tb) tb.setData({ selected: 0, theme: store.curTheme() });
    this.rebuild();
    this._positionDir();
  },

  onReady() { this._positionDir(); },

  // 目录悬浮胶囊定位：水平固定贴左（dirLeft），纵向与微信胶囊同高对齐；
  // 顶部占位 headH 只到胶囊下沿为止，不再额外加间隙——首卡上方的留白交给
  // .jk-body 的 padding-top（16px），与卡片之间的 margin-bottom（16px）完全一致
  _positionDir() {
    const mb = ui.capsuleRect();
    const statusH = this.data.statusH || 20;
    const top = (mb && typeof mb.top === 'number') ? mb.top : statusH + 4;
    const h = (mb && mb.height) ? mb.height : 32;
    this.setData({ dirTop: top, dirH: h, headH: top + h });
  },

  // 切走时收掉内联输入 / 弹层，避免回来时卡在一个空的输入框
  onHide() { this.setData({ active: null, detailOpen: null, goalDetailOpen: null }); },

  /* ---------- 持久化 ---------- */
  // 本地缓存（即时渲染用）+ 云端（usercfg.type=jikui）：两端都写，云端失败给提示但不阻断
  _save() {
    this._saveLocal();
    if (wx.cloud) {
      store.saveJikui(this._goals)
        .then(ok => { if (!ok) wx.showToast({ title: '云端保存失败，已存本机', icon: 'none' }); })
        .catch(() => wx.showToast({ title: '云端保存失败，已存本机', icon: 'none' }));
    }
  },
  _saveLocal() {
    try { wx.setStorageSync(KEY, JSON.stringify(this._goals)); }
    catch (e) { wx.showToast({ title: '保存失败', icon: 'none' }); }
  },
  // 从云端回拉：有数据就以云端为准（并写回本地缓存）；云端还是旧版示例则清掉（覆盖为空，别让它回灌）；
  // 云端没有而本地有真数据，则把本地推上去（旧版本迁移）
  _syncFromCloud() {
    if (!wx.cloud) return;
    store.loadJikui().then(data => {
      if (Array.isArray(data)) {
        if (this._isSeed(data)) {
          this._goals = [];
          this._saveLocal();
          store.saveJikui([]);   // 覆盖云端的旧示例
        } else {
          this._goals = data;
          this._ensureCreatedAt();
          this._migrate();          // 云端回拉的数据也要跑一遍迁移（含目标开始/结束时间）
          this._saveLocal();
        }
        this.rebuild();
      } else if (this._goals.length && !this._isSeed(this._goals)) {
        store.saveJikui(this._goals);
      }
    }).catch(() => {});
  },
  // 是否「整棵都是旧版内置示例」：是才清，避免误删用户自建的、恰好与示例同名的内容
  _isSeed(goals) {
    return Array.isArray(goals) && goals.length > 0 && goals.every(g => SEED_TITLES.indexOf(g.title) >= 0);
  },
  _ensureCreatedAt() {
    const now = Date.now();
    this._goals.forEach(g => { if (!g.createdAt) g.createdAt = now; });
  },
  // 旧版迁移：目标 —— 没 startedAt 的（旧版 / 本版新建前）用创建时间兜底为开始时间；
  // 旧版目标的 completedAt 当作结束时间。待办 —— reflection（感受）→ actual（实际结果），并补 expect。
  _migrate() {
    this._goals.forEach(g => {
      if (g.startedAt == null) g.startedAt = g.createdAt || Date.now();
      if (g.endedAt == null && g.completedAt) g.endedAt = g.completedAt;
      if ('completedAt' in g) delete g.completedAt;
      if (g.desc == null) g.desc = '';
      const walk = (ns) => {
        for (const n of ns) {
          if (n.reflection != null && n.actual == null) n.actual = n.reflection;
          if ('reflection' in n) delete n.reflection;
          if (n.expect == null) n.expect = '';
          if (n.repeat == null) n.repeat = 0;
          if (!Array.isArray(n.completions)) n.completions = [];
          // 旧数据里可能残留「已完成的重复待办」：重复待办永远未完成，统一复位
          if (n.repeat && n.status === 1) { n.status = 0; n.completedAt = 0; }
          walk(n.children || []);
        }
      };
      walk(g.todos || []);
    });
  },

  /* ---------- 渲染（扁平树） ---------- */
  _activeIs(type, gid, tid) {
    const a = this.data.active;
    return !!a && a.type === type && a.gid === gid && (tid == null || a.tid === tid);
  },
  rebuild() {
    const goals = this._goals.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const now = Date.now();
    const fullView = goals.map(g => {
      const startedAt = g.startedAt || 0;
      const endedAt = g.endedAt || 0;
      const started = startedAt > 0;
      const ended = endedAt > 0;
      const inProgress = started && !ended;
      const notStarted = !started;
      const completed = ended;
      // 「已x天 / 历时x天」统一以「点击开始的时间」为起算点（不再用创建时间）
      const endTs = ended ? endedAt : now;
      const elapsedLabel = notStarted ? '未开始' : ((completed ? '历时 ' : '已 ') + fmtElapsed(startedAt, endTs));
      const statusText = notStarted ? '未开始' : (completed ? '已完成' : '进行中');
      const goalBtn = notStarted ? '开始' : (completed ? '重开' : '结束');
      return {
        gid: g.id,
        title: g.title,
        expanded: !!g.expanded,
        started, ended, inProgress, notStarted, completed,
        statusText, goalBtn,
        elapsedLabel,
        desc: g.desc || '',
        editingTitle: this._activeIs('editGoal', g.id),
        progress: countProgress(g.todos || []),
        todosView: g.expanded ? this._flatTodos(g) : [],
        // 概览态用：该事项下「生效中」的第一个待办（status 0；含嵌套子树，按树序取首个）
        firstTodo: this._firstActiveTodoView(g)
      };
    });

    // 两种视图：
    //  · 概览（activeGid 为空，默认）：列出每个事项，每项只露「生效中的第一个待办」
    //  · 单事项（点目录里的事项后）：只展示那一个事项的全部待办
    const overview = !this.data.activeGid;
    let goalsView;
    if (overview) {
      goalsView = fullView.map(g => Object.assign({}, g, {
        isOverview: true,
        expanded: false,
        todosView: []
      }));
    } else {
      let activeGid = this.data.activeGid;
      if (!fullView.some(g => g.gid === activeGid)) activeGid = fullView.length ? fullView[0].gid : null;
      const activeGoal = activeGid ? fullView.find(g => g.gid === activeGid) : null;
      goalsView = activeGoal ? [Object.assign({}, activeGoal, { isOverview: false })] : [];
    }

    // 目录下拉：未结束 / 已结束 两类分别列出（点哪个切到哪个；顶部「全部事项」回概览）
    const navList = fullView
      .filter(g => !g.completed)
      .map(g => ({ gid: g.gid, title: g.title, statusText: g.statusText, elapsedLabel: g.elapsedLabel, pct: g.progress.pct }));
    const doneNav = fullView
      .filter(g => g.completed)
      .map(g => ({ gid: g.gid, title: g.title, statusText: g.statusText, elapsedLabel: g.elapsedLabel, pct: g.progress.pct }));
    this.setData({ goalsView, activeGid: overview ? null : this.data.activeGid, navList, doneNav });
  },
  _flatTodos(g) {
    const out = [];
    const self = this;
    const flat = (todos, depth) => {
      // 未完成优先：同层内「未完成 / 可重复」（isOpenTodo）排在前（PRD FR-12）
      const sorted = todos.slice().sort((a, b) => (isOpenTodo(a) ? 0 : 1) - (isOpenTodo(b) ? 0 : 1));
      for (const t of sorted) {
        const completions = t.completions || [];
        out.push({
          kind: 'todo', key: t.id, tid: t.id, title: t.title,
          // 重复待办的 status 一律按 0 渲染：它们不会彻底完成，不应显示为「已完成」
          status: t.repeat ? 0 : t.status,
          expect: t.expect, actual: t.actual, depth,
          isRepeat: !!t.repeat,
          repeatCount: completions.length,
          completionsView: completions.slice().reverse().map(c => ({ date: fmtDateTime(c.ts), actual: c.actual || '' })),
          hasChildren: (t.children && t.children.length) > 0,
          collapsed: !!t._collapsed,
          showExpect: !!t.expect,
          showActual: !t.repeat && t.status === 1 && !!t.actual,
          editing: self._activeIs('editTodo', g.id, t.id)
        });
        // 内联添加输入：紧跟在该节点之后（子待办缩进 +1、并列同层）
        if (self._activeIs('addChild', g.id, t.id)) out.push({ kind: 'add', key: 'addC' + t.id, indent: depth + 1 });
        if (self._activeIs('addSib', g.id, t.id)) out.push({ kind: 'add', key: 'addS' + t.id, indent: depth });
        if (t.children && t.children.length && !t._collapsed) flat(t.children, depth + 1);
      }
    };
    flat(g.todos || [], 0);
    return out;
  },
  // 取事项下「生效中」的第一个待办：树序前序遍历，第一个 isOpenTodo（未完成，或可重复完成）即返回。
  // 排序与 _flatTodos 保持一致（未完成 / 可重复优先），保证「概览露出的那条」= 展开后列表的第一条
  _firstActiveTodoView(g) {
    let found = null;
    const walk = (todos) => {
      if (found) return;
      const sorted = (todos || []).slice().sort((a, b) => (isOpenTodo(a) ? 0 : 1) - (isOpenTodo(b) ? 0 : 1));
      for (const t of sorted) {
        if (isOpenTodo(t)) { found = t; return; }
        if (t.children && t.children.length) { walk(t.children); if (found) return; }
      }
    };
    walk(g.todos || []);
    if (!found) return null;
    const completions = found.completions || [];
    return {
      tid: found.id,
      title: found.title,
      status: found.repeat ? 0 : found.status,
      isRepeat: !!found.repeat,
      repeatCount: completions.length,
      expect: found.expect || ''   // 概览里也要能看到首条待办的备注
    };
  },

  /* ---------- 定位 ---------- */
  _findGoal(gid) { return this._goals.find(x => x.id === gid); },
  _findTodo(gid, tid) {
    const g = this._findGoal(gid); if (!g) return null;
    let res = null;
    const walk = (nodes, list) => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.id === tid) { res = { node: n, list, i }; return true; }
        if (n.children && n.children.length && walk(n.children, n.children)) return true;
      }
      return false;
    };
    walk(g.todos || [], g.todos || []);
    return res;
  },

  /* ---------- 目标：新建 / 展开 / 改名 / 删除 ---------- */
  newGoal() {
    const g = { id: uid(), title: '新事项', order: this._goals.length, expanded: true, createdAt: Date.now(), startedAt: 0, endedAt: 0, desc: '', todos: [] };
    this._goals.push(g); this._save();
    // 新建即进入行内改名（名称在记录里点标题改），说明走「≡」弹层；并切到这个新愿望
    this.setData({ active: { type: 'editGoal', gid: g.id }, goalDraft: '新事项', activeGid: g.id });
    this.rebuild();
  },
  toggleGoal(e) {
    const g = this._findGoal(e.currentTarget.dataset.gid); if (!g) return;
    g.expanded = !g.expanded; this._save(); this.rebuild();
  },
  // 愿望生命周期：未开始 →（点开始）→ 进行中 →（点结束）→ 已完成；完成后可「重开」回到进行中
  // 开始时间 = 点「开始」那一刻（不再用创建时间）；结束时间 = 点「结束」那一刻
  onGoalToggle(e) {
    const g = this._findGoal(e.currentTarget.dataset.gid); if (!g) return;
    if (!g.startedAt) g.startedAt = Date.now();     // 未开始 → 开始，记录开始时间
    else if (!g.endedAt) g.endedAt = Date.now();     // 进行中 → 结束，记录结束时间
    else g.endedAt = 0;                              // 已完成 → 重开，回到进行中
    this._save(); this.rebuild();
  },
  // 点标题：行内改名（名称就在卡片上改，不弹层）
  editGoal(e) {
    const g = this._findGoal(e.currentTarget.dataset.gid); if (!g) return;
    this.setData({ active: { type: 'editGoal', gid: g.id }, goalDraft: g.title });
    this.rebuild();   // 让 g.editingTitle 翻成 true，改名输入框才出现
  },
  onGoalDraftInput(e) { this.setData({ goalDraft: e.detail.value }); },
  finishGoalEdit(e) {
    const g = this._findGoal(e.currentTarget.dataset.gid); if (!g) return;
    const v = (this.data.goalDraft || '').trim();
    if (v) g.title = v;                      // 空了就退回原标题（不删愿望）
    this.setData({ active: null, goalDraft: '' }); this._save(); this.rebuild();
  },
  // 点「≡」：只编辑说明（标题在卡片上点着改）
  editGoalDesc(e) {
    const g = this._findGoal(e.currentTarget.dataset.gid); if (!g) return;
    this.setData({ goalDetailOpen: { gid: g.id }, goalDesc: g.desc || '', goalDescCount: (g.desc || '').length });
  },
  onGoalDescInput(e) { this.setData({ goalDesc: e.detail.value, goalDescCount: e.detail.value.length }); },
  cancelGoalDetail() { this.setData({ goalDetailOpen: null, goalDesc: '', goalDescCount: 0 }); },
  confirmGoalDetail() {
    const d = this.data.goalDetailOpen; if (!d) return;
    const g = this._findGoal(d.gid);
    if (g) g.desc = (this.data.goalDesc || '').trim();
    this.setData({ goalDetailOpen: null, goalDesc: '', goalDescCount: 0 }); this._save(); this.rebuild();
  },
  delGoal(e) {
    const g = this._findGoal(e.currentTarget.dataset.gid); if (!g) return;
    const n = (g.todos || []).length;
    wx.showModal({
      title: '删除事项',
      content: '删除「' + g.title + '」？其下 ' + n + ' 个待办将一并删除，不可恢复。',
      confirmText: '删除', confirmColor: '#B4544E',
      success: (r) => {
        if (!r.confirm) return;
        this._goals = this._goals.filter(x => x.id !== g.id);
        this.setData({ active: null }); this._save(); this.rebuild();
      }
    });
  },

  /* ---------- 目录浮层（愿望导航下拉） ---------- */
  // 点顶栏「目录」按钮：展开下拉，列出所有愿望
  // 打开目录
  openNav() { this.setData({ navOpen: true }); },
  closeNav() { this.setData({ navOpen: false }); },
  // 点下拉里的某个愿望：切到它（单视图）、展开并收起下拉
  selectGoal(e) {
    const gid = e.currentTarget.dataset.gid;
    const g = this._findGoal(gid); if (!g) return;
    g.expanded = true;   // 切到哪个就展开哪个，直接显示其待办
    this.setData({ navOpen: false, activeGid: gid });
    this._save(); this.rebuild();
  },
  // 下拉底部的「＋ 新建愿望」：收起下拉后走原有新建流程（newGoal 会切到新愿望）
  navAddGoal() {
    this.setData({ navOpen: false });
    this.newGoal();
  },
  // 概览卡片 / 「全部 ›」：进入该事项的单视图（展开全部待办）
  enterGoal(e) {
    const gid = e.currentTarget.dataset.gid;
    const g = this._findGoal(gid); if (!g) return;
    g.expanded = true;   // 进入即展开，直接显示其全部待办
    this.setData({ activeGid: gid });
    this._save(); this.rebuild();
  },
  // 概览卡片头部点击：仅概览态生效（单事项态由内部控件各自处理，避免误触）
  onHeadTap(e) {
    if (this.data.activeGid) return;
    this.enterGoal(e);
  },
  // 目录「全部事项」：回到概览态（每个事项 + 第一步）
  backToOverview() {
    this.setData({ navOpen: false, activeGid: '' });
    this.rebuild();
  },
  // 下拉里「已结束」分区的展开/收起
  toggleDoneNav() { this.setData({ doneOpen: !this.data.doneOpen }); },

  /* ---------- 目录下拉：拖动排序（仅未结束事项） ---------- */
  // 按住手柄开始拖动：测量面板与各事项的高度，记录起始位置
  onNavDragStart(e) {
    const index = e.currentTarget.dataset.index;
    const gid = e.currentTarget.dataset.gid;
    this.setData({ navDragging: true }); // 立即禁滚，避免首帧手势被面板滚动抢走
    const q = wx.createSelectorQuery();
    q.select('.jk-nav').boundingClientRect();
    q.selectAll('.jk-nav-act').boundingClientRect();
    q.exec(res => {
      const panel = res[0]; const items = res[1] || [];
      if (!panel || !items.length) { this.setData({ navDragging: false }); return; }
      const tops = items.map(r => r.top - panel.top);
      const heights = items.map(r => r.height);
      const firstTop = tops[0];
      const avgH = heights.reduce((a, b) => a + b, 0) / heights.length; // 事项等高，取均值足够精确
      this._drag = { index, gid, panelTop: panel.top, firstTop, avgH, n: items.length };
      this.setData({ dragGid: gid, dragIndex: index, dragY: 0 });
    });
  },
  // 手指移动：按中指位置换算目标位置，实时换序 + 让该项跟随手指
  onNavDragMove(e) {
    if (!this._drag) return;
    const relY = e.touches[0].clientY - this._drag.panelTop;
    let target = Math.round((relY - this._drag.firstTop - this._drag.avgH / 2) / this._drag.avgH);
    target = Math.max(0, Math.min(this._drag.n - 1, target));
    let navList = this.data.navList;
    if (target !== this._drag.index) {
      const list = navList.slice();
      const moved = list.splice(this._drag.index, 1)[0];
      list.splice(target, 0, moved);
      navList = list;
      this._drag.index = target;
    }
    const translate = relY - (this._drag.firstTop + target * this._drag.avgH + this._drag.avgH / 2);
    this.setData({ navList, dragIndex: target, dragY: translate });
  },
  // 松手：把新顺序写回各事项的 order 字段（未结束在前、已结束在后），持久化并刷新
  onNavDragEnd() {
    // 先复位 UI 状态，避免 exec 在 touchend 之后才返回导致状态残留卡住
    this.setData({ dragGid: '', dragIndex: -1, dragY: 0, navDragging: false });
    if (!this._drag) { this._drag = null; return; }
    const order = this.data.navList.map(n => n.gid).concat(this.data.doneNav.map(n => n.gid));
    order.forEach((gid, i) => { const g = this._findGoal(gid); if (g) g.order = i; });
    this._save();
    this._drag = null;
    this.rebuild();
  },

  /* ---------- 待办：新增（根 / 子 / 并列） ---------- */
  newRoot(e) {
    const gid = e.currentTarget.dataset.gid;
    this.setData({ active: { type: 'addRoot', gid }, draft: '' });
  },
  newChild(e) {
    const gid = e.currentTarget.dataset.gid, tid = e.currentTarget.dataset.tid;
    this.setData({ active: { type: 'addChild', gid, tid }, draft: '' });
    this.rebuild();   // 不加这一句，子待办输入框不会渲染（goalsView 里这条 add row 依赖 active）
  },
  newSib(e) {
    const gid = e.currentTarget.dataset.gid, tid = e.currentTarget.dataset.tid;
    this.setData({ active: { type: 'addSib', gid, tid }, draft: '' });
    this.rebuild();   // 同上：并列待办输入框依赖 rebuild 把 add row 加进 goalsView
  },
  onDraftInput(e) { this.setData({ draft: e.detail.value }); },
  confirmAdd() {
    const a = this.data.active; if (!a) return;
    const title = (this.data.draft || '').trim();
    if (!title) { wx.showToast({ title: '先写点什么', icon: 'none' }); return; }
    const g = this._findGoal(a.gid); if (!g) return;
    const t = mkTodo(title);
    if (a.type === 'addRoot') {
      (g.todos = g.todos || []).push(t);
    } else {
      const f = this._findTodo(a.gid, a.tid); if (!f) return;
      if (a.type === 'addChild') { f.node.children = f.node.children || []; f.node.children.push(t); f.node._collapsed = false; }
      else { f.list.push(t); }
    }
    this.setData({ active: null, draft: '' }); this._save(); this.rebuild();
  },

  /* ---------- 待办：改名 / 删除 / 子树展开 ---------- */
  editTodo(e) {
    const f = this._findTodo(e.currentTarget.dataset.gid, e.currentTarget.dataset.tid); if (!f) return;
    this.setData({ active: { type: 'editTodo', gid: e.currentTarget.dataset.gid, tid: e.currentTarget.dataset.tid }, draft: f.node.title });
    this.rebuild();   // 让 t.editing 翻成 true，改名输入框才出现
  },
  finishTodoEdit(e) {
    const f = this._findTodo(e.currentTarget.dataset.gid, e.currentTarget.dataset.tid); if (!f) return;
    const v = (this.data.draft || '').trim();
    if (v) f.node.title = v;
    this.setData({ active: null, draft: '' }); this._save(); this.rebuild();
  },
  delTodo(e) {
    const f = this._findTodo(e.currentTarget.dataset.gid, e.currentTarget.dataset.tid); if (!f) return;
    const kids = (f.node.children && f.node.children.length) || 0;
    wx.showModal({
      title: '删除待办',
      content: kids ? ('删除该待办及其 ' + kids + ' 个子待办？') : ('删除待办「' + f.node.title + '」？'),
      confirmText: '删除', confirmColor: '#B4544E',
      success: (r) => { if (!r.confirm) return; f.list.splice(f.i, 1); this._save(); this.rebuild(); }
    });
  },
  toggleNode(e) {
    const f = this._findTodo(e.currentTarget.dataset.gid, e.currentTarget.dataset.tid); if (!f) return;
    f.node._collapsed = !f.node._collapsed; this._save(); this.rebuild();
  },

  /* ---------- 待办详情：备注 / 实际结果 / 不定次重复 ---------- */
  // 点「✓ / ↻」：
  //  - 重复待办：只要所属愿望没「结束」，就能一直点「↻」完成，每次记一条完成（时间 + 实际结果），待办本身保持可再完成
  //  - 非重复待办：未完成先弹详情（顺手记实际结果）；已完成再点回退未完成、保留已填内容
  toggleDone(e) {
    const gid = e.currentTarget.dataset.gid, tid = e.currentTarget.dataset.tid;
    const f = this._findTodo(gid, tid); if (!f) return;
    const g = this._findGoal(gid);
    if (f.node.repeat) {
      if (g && g.endedAt) { wx.showToast({ title: '事项已结束，无法重复完成', icon: 'none' }); return; }
      this._openDetail(gid, tid, true, f.node);
      return;
    }
    if (f.node.status === 0) {
      this._openDetail(gid, tid, true, f.node);
    } else {
      f.node.status = 0; this._save(); this.rebuild();
    }
  },
  // 点「⊙」：随时打开详情，编辑备注、设/取消重复、看完成历史，不改变完成状态
  openDetail(e) {
    const f = this._findTodo(e.currentTarget.dataset.gid, e.currentTarget.dataset.tid); if (!f) return;
    this._openDetail(e.currentTarget.dataset.gid, e.currentTarget.dataset.tid, false, f.node);
  },
  _openDetail(gid, tid, willComplete, node) {
    const completions = node.completions || [];
    this.setData({
      detailOpen: {
        gid, tid, willComplete,
        repeat: node.repeat ? 1 : 0,
        repeatCount: completions.length,
        completionsView: completions.slice().reverse().map(c => ({ date: fmtDateTime(c.ts), actual: c.actual || '' }))
      },
      expectVal: (node.expect || ''),
      actualVal: willComplete ? '' : (node.actual || ''),
      expectCount: (node.expect || '').length,
      actualCount: willComplete ? 0 : (node.actual || '').length,
      repeatOn: !!node.repeat
    });
  },
  onRepeatToggle() { this.setData({ repeatOn: !this.data.repeatOn }); },
  onExpectInput(e) { this.setData({ expectVal: e.detail.value, expectCount: e.detail.value.length }); },
  onActualInput(e) { this.setData({ actualVal: e.detail.value, actualCount: e.detail.value.length }); },
  cancelDetail() { this.setData({ detailOpen: null, expectVal: '', actualVal: '', expectCount: 0, actualCount: 0 }); },
  confirmDetail() {
    const d = this.data.detailOpen; if (!d) return;
    const f = this._findTodo(d.gid, d.tid);
    if (f) {
      const node = f.node;
      node.expect = (this.data.expectVal || '').trim();
      node.repeat = this.data.repeatOn ? 1 : 0;
      // 标为「不定次重复」即永远算未完成：清掉可能残留的已完成状态，
      // 否则概览（全部事项）会把它当成已完成而跳过，只留一句「暂无进行中的待办」
      if (node.repeat) { node.status = 0; node.completedAt = 0; }
      if (d.willComplete) {
        if (node.repeat) {
          // 不定次重复：追加一条完成记录（时间 + 本次实际结果），待办保持可再完成
          node.completions = node.completions || [];
          node.completions.push({ ts: Date.now(), actual: (this.data.actualVal || '').trim() });
        } else {
          node.status = 1; node.completedAt = Date.now();
          node.actual = (this.data.actualVal || '').trim();
        }
      }
    }
    this.setData({ detailOpen: null, expectVal: '', actualVal: '', expectCount: 0, actualCount: 0, repeatOn: false }); this._save(); this.rebuild();
  },

  noop() {}
}));
