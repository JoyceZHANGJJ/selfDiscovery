// utils/calendar.js —— 把一条待办的「计划完成」推到手机系统日历
//
// ── 先说清这件事的能力边界（做之前查过官方文档与社区反馈，别误以为能"同步"）──
//
//  1. 小程序**没有"同步"**，只有一个 wx.addPhoneCalendar：它弹一个**系统级日程卡片**，
//     用户点确认才写进手机日历。写进去之后，小程序这边**读不回来，也改不了、删不了**。
//     所以这里只能"一次性往外推"，并且推完只在自己库里记一笔 calTs 供回显。
//
//  2. **必须真机**，开发者工具里调不通；必须由**用户直接点一下**触发
//     （写在 success 回调里再调会报 "can only be invoked by user TAP gesture"）。
//     → 本模块不做"批量推"，只在具体那一条的按钮上调用。
//
//  3. **iOS 授权有两个档**：「仅添加事件」与「完全访问」。选「仅添加」时
//     wx.addPhoneCalendar 会**静默失败**——success 照回调、前端不报错，但日程没进去。
//     这是最高频的"我明明点了怎么没有"。所以 iOS 上额外弹一次说明，让用户选「完全访问」。
//
//  4. **iOS 用户点取消走 fail，安卓点取消走 success**——安卓的"成功"不代表真加上了。
//     所以成功提示统一用「已提交」这种中性说法，不说"加好了"。
//
//  5. 首次拒绝后，wx.authorize 不会再弹窗（系统不让反复打扰），
//     只能 wx.openSetting 引导到设置页手动开。
//
// 用法：页面在「这条待办有计划完成时间」时给一个按钮 → onPushCal(id)
//       → 已推过会先问一句（避免在手机日历里堆重复日程）

const store = require('./store.js');

// 授权相关的提示文案（放在一起，别散在业务里）
const MSG = {
  iosFull: 'iOS 上要选「完全访问」日程才会真的写进去；选「仅添加事件」会看起来成功、实际没加。',
  goSet: '日历权限被拒了，去设置里手动打开「允许添加日程」再回来。',
  noPlan: '这条还没定计划完成时间，先定一个再推。'
};

// wx.getSetting 的 Promise 化（老基础库不支持 Promise 调用，兜一层）
function getSetting() {
  return new Promise(resolve => {
    if (!wx.getSetting) { resolve({ authSetting: {} }); return; }
    wx.getSetting({ success: resolve, fail: () => resolve({ authSetting: {} }) });
  });
}
function authorize(scope) {
  return new Promise(resolve => {
    wx.authorize({ scope, success: () => resolve(true), fail: () => resolve(false) });
  });
}
function openSetting() {
  return new Promise(resolve => {
    wx.openSetting({ success: res => resolve(res && res.authSetting), fail: () => resolve(null) });
  });
}
function addPhone(opts) {
  return new Promise(resolve => {
    wx.addPhoneCalendar(Object.assign({}, opts, {
      success: () => resolve({ ok: true }),
      fail: err => resolve({ ok: false, msg: (err && err.errMsg) || '' })
    }));
  });
}
function toast(title, icon) {
  wx.showToast({ title, icon: icon || 'none', duration: 2000 });
}
// 是不是 iOS —— 只为第 3 条那个「完全访问」的额外提醒
function isIOS() {
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : (wx.getSystemInfoSync ? wx.getSystemInfoSync() : {});
    return /ios/i.test(info.platform || info.system || '');
  } catch (e) { return false; }
}
function showModal(opts) {
  return new Promise(resolve => {
    wx.showModal(Object.assign({}, opts, { success: res => resolve(!!(res && res.confirm)) }));
  });
}

/* 这条能不能推：待办 + 定了计划完成时间。
   没计划就不推——与「没有计划是常态」一贯口径一致，不偷偷给一条待办补日期 */
function canPush(rec) {
  return !!(rec && store.isTask(rec.m) && rec.dueTs);
}

// 日历卡片的内容：标题带类别（同一批推出去时在手机日历里能分清），
// 说明里带上优先级与「记在识己」这一句，location 不给（这类待办没有地点）
function buildOpts(rec) {
  const cat = store.taskCat(rec) || '';
  const prio = store.taskPrio(rec);
  const desc = [];
  if (prio) desc.push('优先级：' + prio);
  desc.push('记在「识己」里');
  return {
    title: (cat ? '［' + cat + '］' : '') + (rec.txt || '待办'),
    startTime: Math.floor((rec.dueTs || 0) / 1000),   // 接口要**秒**
    endTime: Math.floor((rec.dueTs || 0) / 1000),     // 只到某时刻、没时长 → 与开始相同
    description: desc.join('\n'),
    allDay: false,
    alarm: true,
    alarmOffset: 0                                    // 到点提醒（不提前）
  };
}

/* 推到手机日历。**必须由用户直接点一下触发**（能力边界第 2 条）。
   返回 Promise<{done:boolean, reason?:string}>：
     done=true  已提交给系统日历
     done=false 没推成（reason 说明为什么，页面据此给提示） */
async function push(rec) {
  if (!canPush(rec)) return { done: false, reason: 'noplan' };
  // 接口本身不存在（老基础库 < 2.15.0）→ 直接说清楚，别抛错
  if (typeof wx.addPhoneCalendar !== 'function') return { done: false, reason: 'nosupport' };

  const SCOPE = 'scope.addPhoneCalendar';
  const setting = await getSetting();
  let auth = (setting.authSetting || {})[SCOPE];
  if (!auth) auth = await authorize(SCOPE);              // 首次：弹一次授权窗
  if (!auth) {
    // 拒绝过：authorize 不会再弹（系统不让反复打扰），只能引导去设置页
    const again = await openSetting();
    auth = (again || {})[SCOPE];
    if (!auth) { toast(MSG.goSet, 'none'); return { done: false, reason: 'auth' }; }
  }

  const r = await addPhone(buildOpts(rec));
  if (!r.ok) { toast('没推成：' + (r.msg || '未知原因').slice(0, 40)); return { done: false, reason: 'fail' }; }

  // iOS 的「仅添加事件」会静默失败：这里补一句提醒（第 3 条）。
  // 放在推成功之后——事后再解释「刚才可能没加上」，比事前一堆前置说明省事。
  // 措辞不能说「加好了」：安卓上用户点取消也走 success（边界 4），一律用中性说法
  if (isIOS()) await showModal({ title: '已提交', content: MSG.iosFull, showCancel: false, confirmText: '知道了' });
  toast('已提交到日历', 'none');
  return { done: true };
}

/* 页面入口：已推过就先问一句，避免在手机日历里堆一堆重复日程。
   确认后推，并给记录打一个 calTs 标记（只说明"我推过"，不保证日历里是新的） */
async function pushById(id) {
  const rec = (getApp().globalData.records || []).find(x => x.id === id);
  if (!rec) return { done: false, reason: 'norec' };
  if (!canPush(rec)) { toast(MSG.noPlan, 'none'); return { done: false, reason: 'noplan' }; }
  if (rec.calTs) {
    const go = await showModal({
      title: '这条推过了',
      content: store.dueLabel(rec.dueTs) + ' 推到过日历了。要再推一遍吗？（手机日历里会有两条）',
      confirmText: '再推一次',
      cancelText: '不用了'
    });
    if (!go) return { done: false, reason: 'cancel' };
  }
  const r = await push(rec);
  if (!r.done) return r;
  // 打标记：只是"我推过"，不保证系统日历里现在就是这个样子（读不回来）
  rec.calTs = Date.now();
  store.updateRecord(rec).catch(() => {});   // 标记写不上不影响这次推送的结果，别拿它拦住用户
  return r;
}

module.exports = { canPush, push, pushById, buildOpts, MSG };