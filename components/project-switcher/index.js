// 顶部左侧「项目切换器」：常驻，居左，与右上角的起/睡胶囊左右呼应。
// 半屏 sheet 只做三件事：切全局 / 切项目 / 新建（名称 + 颜色）。项目之间**只用颜色圆点区分**，不放图标。
// 切换即写 store.setCurProject（持久化 + 通知各页重新取数）；全局 = 不过滤（见 store.recWhere）。
const store = require('../../utils/store.js');
const ui = require('../../utils/ui.js');

Component({
  data: {
    style: '',
    open: false,
    projects: [],
    editId: '',
    editName: '',
    editColor: store.PROJ_COLORS ? store.PROJ_COLORS[0] : '#7C9A86',
    curId: '',
    curName: '全局',
    curColor: '#C4C9CE',
    newName: '',
    newColor: store.PROJ_COLORS ? store.PROJ_COLORS[0] : '#7C9A86',
    colors: store.PROJ_COLORS || ['#7C9A86', '#5E9A94', '#C0A05A', '#9A8C7A', '#948AA8', '#3F7A8A', '#B08968', '#6E8CB0']
  },
  lifetimes: {
    attached() {
      this.position();
      this.refresh();
      this._off = store.onProjectChange(() => this.refresh());
    },
    detached() { if (this._off) this._off(); }
  },
  pageLifetimes: {
    // 回该页时重对位置（胶囊矩形走缓存，切页不会带偏）并刷新当前项目
    show() { this.position(); this.refresh(); }
  },
  methods: {
    position() {
      const mb = ui.capsuleRect();
      if (!mb) { this.setData({ style: 'position:fixed;top:24px;left:12px;z-index:60;' }); return; }
      // 左上：贴状态栏下沿、左侧安全区，高度对齐胶囊，方便与右上起/睡胶囊形成「左右两角」的对称
      this.setData({ style: 'position:fixed;top:' + mb.top + 'px;left:12px;height:' + mb.height + 'px;z-index:60;' });
    },
    refresh() {
      const id = store.curProject();
      let name = '全局', color = '#C4C9CE';
      if (id) {
        const p = store.projectById(id);
        if (p) { name = p.name || '未命名'; color = p.color || '#C4C9CE'; }
      }
      const all = (store.globalData.projects || []);
      this.setData({
        projects: all.filter(p => !p.archived),
        curId: id, curName: name, curColor: color,
        editId: '', editName: '', editColor: this.data.colors[0]
      });
    },
    onToggle() { this.setData({ open: !this.data.open, newName: '', editId: '' }); this.refresh(); },
    onMask() { this.setData({ open: false }); },
    // 「完成」：名字写了就直接创建（少一步找按钮）；没写就是收起
    onDone() {
      if ((this.data.newName || '').trim()) { this.onCreate(); return; }
      this.setData({ open: false });
    },
    onNoop() {},
    onSwitch(e) {
      const id = e.currentTarget.dataset.id || '';
      const p = id ? store.projectById(id) : null;
      if (p && p.archived) return;   // 归档项目不可切回
      store.setCurProject(id);
      this.setData({ open: false });
    },
    onNewName(e) { this.setData({ newName: e.detail.value }); },
    onPickColor(e) { this.setData({ newColor: e.currentTarget.dataset.c }); },
    onCreate() {
      const name = (this.data.newName || '').trim();
      if (!name) { wx.showToast({ title: '先给项目起个名', icon: 'none' }); return; }
      store.addProject({ name, color: this.data.newColor }).then(p => {
        store.setCurProject(p._id);   // 建完直接切过去
        this.setData({ open: false, newName: '' });
      }).catch(() => { wx.showToast({ title: '没建上，再试一次', icon: 'none' }); });
    },
    // 改名：进入行内编辑态（名字 + 颜色都能改，颜色是项目唯一视觉标识）
    onEdit(e) {
      const id = e.currentTarget.dataset.id;
      const p = store.projectById(id) || {};
      this.setData({ editId: id, editName: p.name || '', editColor: p.color || this.data.colors[0] });
    },
    onEditName(e) { this.setData({ editName: e.detail.value }); },
    onEditColor(e) { this.setData({ editColor: e.currentTarget.dataset.c }); },
    onSaveEdit() {
      const name = (this.data.editName || '').trim();
      if (!name) { wx.showToast({ title: '名字不能为空', icon: 'none' }); return; }
      store.updateProject(this.data.editId, { name, color: this.data.editColor }).then(() => {
        this.setData({ editId: '', editName: '', editColor: this.data.colors[0] });
        this.refresh();
      });
    },
    onCancelEdit() { this.setData({ editId: '', editName: '', editColor: this.data.colors[0] }); },
    // 归档：从活跃列表消失、不可切回，但其下记录保留（projectId 不变）。
    // 已归档项目的「查看 / 恢复」放在「设置」页，切换器里不再列出（避免置顶/挤占）。
    onArchive(e) {
      const id = e.currentTarget.dataset.id;
      store.updateProject(id, { archived: true }).then(() => {
        if (store.curProject() === id) store.setCurProject('');  // 归档当前项目→回到全局
        this.refresh();
        store.reload();   // 重新拉记录：归档项目的记录在「全局」视图里立即隐藏
      });
    }
  }
});
