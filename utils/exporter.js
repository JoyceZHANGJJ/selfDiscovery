// utils/exporter.js —— 记录导出（两种格式）
//
// 为什么分成两种：原先只有一个「导出」，产出的是给**导入**用的管道文本
// （日期 时间 | 维度 | 内容 | 细节）。它的问题有两个：
//   1) 人读不了——没有标题、没有分组、状态全丢（已完成 / 已放弃 / 在做 这些都没了）；
//   2) 表达力不够——待办的完成时间、计划完成、优先级、可做的流程节点都塞不进去。
// 现在给两种，各干各的事：
//
//   mode:'read' —— **给人读 / 喂给 AI**：按日期分小节，每条一行，字段带中文标签，
//        状态、计划完成、优先级、放弃原因全部写出来。人能直接读，AI 也能解析成结构。
//   mode:'backup' —— **给导入用**：仍是原来的管道格式（导入端零改动），
//        状态作为尾部标签追加在细节后面（✓已完成 / ✗已放弃 / 进行中 …），
//        导入时能还原回去，老备份文件照旧能导。
//
// 两个格式都吃同一个 filter：{ days:['2026-10-05'], dims:['todo','want'] } ——
// 按天 / 按维度筛选导出走这里，入口层只要把选择结果传进来。
const store = require('./store.js');

const DAY = 24 * 3600 * 1000;
const CN = 8 * 3600 * 1000;

function pad(n) { return (n < 10 ? '0' : '') + n; }
function ymd(ts) {
  const d = new Date((ts || 0) + CN);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function hhmm(ts) {
  const d = new Date(ts || 0);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function md(ts) {const s = ymd(ts); return s.slice(5, 7) + '月' + s.slice(8, 10) + '日'; }

// ---------------- 状态（待办的完成态 / 可做的流程节点）----------------
// 可做：未做 / 在做 / 做了 / 不做（与 store.recMname / 列表口径一致）
const WANT_STATE = { doing: '在做', done: '做了', abandon: '不做', '': '未做' };
function wantState(r) {
  if (r.m !== 'want') return '';
  return WANT_STATE[r.status || ''] || '未做';
}
// 待办：完成 / 放弃（与列表的两个分段一致）；abandonWhy 在 decorate 里已把「原因」换成它
function taskState(r) {
  if (!store.isTask(r.m)) return '';
  if (r.status === 'abandon') return '已放弃';
  if (r.done || r.doneAt) return '已完成';
  return '';
}

// 「完成于 / 放弃于 / 什么时候开始的」的时间戳 → 人读的日期
function stateAt(r) {
  if (store.isTask(r.m)) return r.status === 'abandon' ? r.abandonedAt : r.doneAt;
  return r.status === 'doing' ? r.startedAt : r.doneAt;      // 可做的「在做」记在 startedAt
}

// 待办的优先级（在细节里，但导出时要单独拎出来标注；细节那份要跳过，避免同一件事写两遍）
function isPrioSrc(src) { return src === 'todoPrio'; }

// ---------------- 筛选 ----------------
// filter: { days:[...], dims:[...] }，都是可选；空 / 缺省 = 全部
function applyFilter(recs, filter) {
  const f = filter || {};
  const days = (f.days || []).filter(Boolean);
  const dims = (f.dims || []).filter(Boolean);
  return recs.filter(r => {
    if (days.length && days.indexOf(ymd(r.ts)) < 0) return false;
    if (dims.length && dims.indexOf(r.m) < 0) return false;
    return true;
  }).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));   // 一律按时间正序
}

// ---------------- 可读导出 ----------------
// 一条记录 = 一行，「时间 维度 内容｜标签：值 …」。
// 分隔符用全角「｜」和「·」，人读清楚；也方便以后按分隔符解析喂给 AI。
function readLine(r) {
  const parts = [];
  parts.push((r.t || hhmm(r.ts)) + ' ' + store.mname(r.m));
  parts.push(String(r.txt || ''));

  // 状态：可做的流程节点 / 待办的完成态，后面跟那一刻的日期
  const ws = wantState(r), ts2 = taskState(r);
  const at = stateAt(r);
  const st = [];
  if (ws) st.push(ws + (at ? '（' + md(at) + '起）' : ''));       // 可做：在做（10月6日起）
  if (ts2) st.push(ts2 + (at ? '（' + md(at) + '）' : ''));// 待办：已完成（10月3日）
  if (st.length) parts.push(st.join('·'));

  // 细节：用中文标签（喜恶：喜欢 / 精力：耗尽），一个都没有就整段省掉。
  // 优先级单独成一栏（下面），所以要从细节里剔掉，别同一件事写两遍。
  const dl = (store.buildExt(r.m, r.ext, r.extSrc) || []).filter(d => !isPrioSrc(d.src));
  if (dl.length) parts.push(dl.map(d => (d.lbl ? d.lbl + '：' : '') + d.v).join('、'));

  // 待办特有：优先级 + 计划完成
  if (store.isTask(r.m)) {
    const p = store.taskPrio(r);
    if (p && store.prioShow(p)) parts.push('优先级：' + p);
    if (r.dueTs) parts.push('计划完成：' + store.dueLabel(r.dueTs) + (store.dueOver(r.dueTs) ? '（已逾期）' : ''));
  }
  return parts.join(' | ');
}

// 按日期分小节；每节前加一行「## 2026-10-05 周三」类的标题（## 便于 AI 分段）
function readable(recs, filter) {
  const list = applyFilter(recs, filter);
  const WK = '日一二三四五六';
  const L = [];
  L.push('# ' + (getApp().APP_NAME || '识己手札') + ' · 记录');
  L.push('# 导出时间：' + ymd(Date.now()) + ' · 共 ' + list.length + ' 条');
  L.push('# 格式：每天一节，每条写成「时间 维度 内容 | 状态 | 标签：值」');
  L.push('');
  if (!list.length) return L.join('\n') + '\n';

  let cur = '';
  list.forEach(r => {
    const d = ymd(r.ts);
    if (d !== cur) {
      cur = d;
      const dt = new Date((r.ts || 0) + CN);
      const w = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay();
      L.push('## ' + d + ' 周' + WK[w]);
    }
    L.push('- ' + readLine(r));
  });
  return L.join('\n') + '\n';
}

// ---------------- 备份导出（导入用）----------------
// 保持原来的管道格式：日期 时间 | 维度 | 内容 | 细节（顿号分隔）
// 状态作为**尾部追加**的一段标签接在细节后面，导入端能还原；老备份文件没有这一段，照样能导。
const ST_TAGS = {
  done: '✓已完成', abandon: '✗已放弃', doing: '进行中'
};
function backupLine(r) {
  const head = ymd(r.ts) + ' ' + (r.t || hhmm(r.ts)) + ' | ' + store.mname(r.m) + ' | ' + String(r.txt || '')
    + ((r.ext && r.ext.length) ? ' | ' + r.ext.join('、') : '');
  const tags = [];
  // 状态标记看status / done（不看时间戳）：startedAt / abandonedAt 可能为 0，
  // 但状态本身是确定的，漏掉就等于信息丢了。
  if (r.status === 'abandon') tags.push(ST_TAGS.abandon);
  else if (r.status === 'doing') tags.push(ST_TAGS.doing);
  else if (r.done || r.doneAt) tags.push(ST_TAGS.done);
  // 那一刻的日期（有才带）
  const at = stateAt(r);
  if (at) tags.push((r.status === 'abandon' ? '放弃于' : (r.status === 'doing' ? '开始于' : '完成于')) + ' ' + ymd(at));
  if (store.isTask(r.m) && r.dueTs) tags.push('计划完成 ' + ymd(r.dueTs));
  if (store.isTask(r.m)) {
    const p = store.taskPrio(r);
    if (p) tags.push('优先级 ' + p);
  }
  // 状态段必须带「状态：」前缀：否则「没有细节」的行里，最后一段到底是细节还是状态分不清
  // （细节用顿号、状态用逗号，可末段仍可能两者皆像）。有这个前缀，导入端按前缀取末段即可。
  return tags.length ? head + ' | 状态：' + tags.join('，') : head;
}
function backup(recs, filter) {
  const list = applyFilter(recs, filter);
  const head = '# ' + (getApp().APP_NAME || '识己手札') + ' · 备份\n'
    + '# 时间：' + ymd(Date.now()) + ' · 共 ' + list.length + ' 条\n'
    + '# 格式：日期 时间 | 维度 | 内容 | 细节 | 状态标签\n';
  return head + list.map(backupLine).join('\n') + '\n';
}

// 统一入口：mode = 'read' | 'backup'
function build(recs, mode, filter) {
  return mode === 'backup' ? backup(recs, filter) : readable(recs, filter);
}

// 恢复：把备份里的状态标签解析回记录字段（导入用；解析不出就留空，不影响原有流程）
const TAG_F = {
  '✓已完成': { done: 1 },
  '✗已放弃': { status: 'abandon' },
  '进行中': { status: 'doing' }
};
function readStateTags(seg) {
  const out = {};
  String(seg || '').split(/[，,]/).forEach(t => {
    t = t.trim();
    if (!t) return;
    const mt = t.match(/^(完成于|放弃于|开始于|计划完成)\s+(\d{4}-\d{2}-\d{2})/);
    if (mt) {
      const ts = new Date(mt[2] + 'T12:00:00').getTime();
      if (mt[1] === '计划完成') out.dueTs = ts;
      else if (mt[1] === '完成于') { out.doneAt = ts; if (!out.done) out.done = 1; }
      else if (mt[1] === '开始于') { out.startedAt = ts; if (!out.status) out.status = 'doing'; }
      else out.abandonedAt = ts;
      return;
    }
    const mp = t.match(/^优先级\s+(.+)$/);
    if (mp) { out.prio = mp[1].trim(); return; }
    if (TAG_F[t]) Object.assign(out, TAG_F[t]);   // 不 return：可能同一格里既有标记又有日期
  });
  return out;
}

module.exports = { build, readable, backup, applyFilter, ymd, hhmm, wantState, taskState, readStateTags };