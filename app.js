// app.js
// 云开发环境 ID：去微信开发者工具「云开发」控制台复制环境 ID 填到这里。
// 若留空则使用默认环境（控制台中设为“当前环境”的那个）。
const CLOUD_ENV = 'cloud1-d2g8lnbu47a1b530a';
const store = require('./utils/store.js');
const APP_NAME = '识己手札';

App({
  globalData: store.globalData,
  APP_NAME,
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    wx.cloud.init({ env: CLOUD_ENV || undefined, traceUser: true });
    // 启动自检：确认云数据库可达
    this.pingCloud();
    // 首次启动拉取数据（页面 onShow 也会再确保加载）
    store.ensureAll();
    // 清理历史残留的已删除主题：避免冷启动套上不存在的 theme 类导致变量全空
    const savedTheme = wx.getStorageSync('theme');
    if (savedTheme && !store.THEMES.some(t => t.k === savedTheme)) {
      wx.setStorageSync('theme', 'mint');
    }
    // 新包发布后：冷启动静默下载，下次进入即最新；有更新时弹提示
    this.checkUpdate();
  },

  checkUpdate() {
    if (!wx.getUpdateManager) return; // 基础库低于 1.9.90 不支持
    const um = wx.getUpdateManager();
    um.onUpdateReady(() => {
      wx.showModal({
        title: '更新提示',
        content: '已为你准备好新版本，重启后生效',
        showCancel: false,
        confirmText: '立即重启',
        success: () => um.applyUpdate()
      });
    });
    um.onUpdateFailed(() => {
      console.error('[更新] 新版本下载失败，请删除小程序后重试');
    });
  },

  pingCloud() {
    try {
      const db = wx.cloud.database();
      db.collection('records').count()
        .then(res => console.log('[云自检] records 集合已连通，当前记录数：', res.total))
        .catch(err => console.error('[云自检] records 集合访问失败：', err));
      db.collection('options').count().catch(err => console.error('[云自检] options 集合访问失败：', err));
      db.collection('usercfg').count().catch(err => console.error('[云自检] usercfg 集合访问失败：', err));
    } catch (e) {
      console.error('[云自检] 云能力初始化异常：', e);
    }
  }
});
