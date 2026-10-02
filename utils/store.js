// 自我觉察 · 共享数据层（常量 + 云开发 CRUD + 纯计算）
// 云开发环境 ID：在 app.js 顶部填写 wx.cloud.init 的 env。
// 集合：records（记录）、options（用户新增选项）、usercfg（问候语/自定义维度）

/* ---------------- 常量（与线上版同构） ---------------- */
const MODULES = [
  { k: 'obs', n: '观察', c: '#7C9A86' },
  { k: 'now', n: '此刻', c: '#5E9A94' },
  { k: 'want', n: '想做', c: '#C0A05A' },
  { k: 'nope', n: '不想', c: '#948AA8' },
  { k: 'done', n: '做了', c: '#6E8CB0' },
  { k: 'memo', n: '备忘', c: '#9A8C7A' },
  { k: 'buy', n: '购物', c: '#C08552' }
];

const OPT = {
  obsWhat: ['写方案', '写周报', '整理资料', '陪家人'],
  obsStart: ['工作必须', '自己想做', '别人提议'],
  genDoing: ['写代码', '开会', '散步', '带娃', '做饭'],
  genFeel: ['专注', '走神', '平静', '焦虑'],
  genWant: ['喝咖啡', '走一走', '看会儿书'],
  wantItem: ['学吉他', '早睡', '去旅行', '练字'],
  nopeThing: ['应酬', '刷手机', '加班', '回消息'],
  nopeDeg: ['微微', '有点', '很', '非常', '极度'],
  nopeMood: ['抵触', '心累', '反感'],
  memoItem: [], buyItem: [],
  doneItem: ['跑步', '读书', '打扫', '写周报', '冥想'],
  doneFeel: ['踏实', '轻松', '平静'],
  doneGain: ['完成感', '心情变好', '学到了'],
  obsMood: ['开心', '平静', '满足', '焦虑', '低落', '烦躁', '麻木']
};

const GLABEL = {
  obsWhat: '什么事', obsStart: '怎么开始的', genDoing: '正在做的事', genFeel: '情绪',
  genWant: '此刻想做的事', wantItem: '想做的事', nopeThing: '不想的事', nopeDeg: '程度', nopeMood: '不想的情绪',
  doneItem: '做了的事', doneFeel: '做了的感受', doneGain: '收获', obsMood: '做完心情如何', memoItem: '要记住什么', buyItem: '要买什么'
};

const OPTGROUPS = [
  { m: 'obs', gs: ['obsWhat', 'obsStart', 'obsMood'] },
  { m: 'now', gs: ['genDoing', 'genFeel', 'genWant'] },
  { m: 'want', gs: ['wantItem'] },
  { m: 'nope', gs: ['nopeThing', 'nopeDeg', 'nopeMood'] },
  { m: 'done', gs: ['doneItem', 'doneFeel', 'doneGain'] }
];

// 固定选项组（写死，不给“管理”入口）
const FIXED = {
  forgot: { label: '忘了时间吗（可不选）', opts: ['忘了时间', '没有', '不确定'] },
  nrg: { label: '做完精力如何（可不选）', opts: ['耗电', '充电', '没变化'] }
};

// 一次性前缀：半角 ~ 与全角 ～ 都认（中文输入法打出的通常是全角）
function isOnce(s) { const c = (s || '').trim().charAt(0); return c === '~' || c === '～'; }
function stripOnce(s) { const t = (s || '').trim(); return isOnce(t) ? t.slice(1).trim() : t; }

// 模块字段：g=选项组（freeze 决定手填是否固化）/ fx=固定选项组 / free=自由文本
const FIELDS = {
  obs: { main: 'obsWhat', items: [
    { g: 'obsStart', freeze: true, single: true },
    { fx: 'forgot' }, { fx: 'nrg' },
    { g: 'obsMood', freeze: false, single: true, noInput: true },
    { free: 'obsfeel', label: '感受（自由记录 · 不进列表）', ph: '做完那一刻心里冒出来的话', ta: true }
  ] },
  now: { main: 'genDoing', items: [
    { g: 'genFeel', freeze: false, single: false, noInput: true },
    { free: 'nownote', label: '感受', ph: '这一刻心里的感觉，随便写', ta: true },
    { g: 'genWant', freeze: true, single: true }
  ] },
  want: { main: 'wantItem', items: [
    { free: 'trigger', label: '是什么让你想做', ph: '刚看到别人晒成果，有点不甘心' },
    { free: 'hope', label: '希望最终变成什么样', ph: '变成每天稳定的习惯' }
  ] },
  nope: { main: 'nopeThing', items: [
    { g: 'nopeDeg', freeze: false, single: true, noInput: true },
    { g: 'nopeMood', freeze: true, single: false, noInput: true },
    { free: 'nopefeel', label: '感受（自由记录）', ph: '那一刻心里冒出来的话', ta: true },
    { free: 'after', label: '硬着头皮做了之后', ph: '其实没那么糟' }
  ] },
  done: { main: 'doneItem', items: [
    { g: 'doneFeel', freeze: false, single: false },
    { g: 'doneGain', freeze: true, single: false }
  ] },
  /* 备忘 / 购物：只记一句话，没有细节；加 ~ 前缀可把这条存进选项池下次点选 */
  memo: { main: 'memoItem', items: [ { free: 'memonote', label: '原因', ph: '为什么记这条？可不填', ta: true } ] },
  buy:  { main: 'buyItem',  items: [ { free: 'buynote', label: '干什么用', ph: '买来做什么？可不填', ta: true } ] }
};

const THEMES = [
  { k: 'sand', n: '暖沙', bg: '#FAF8F4', ac: '#7C9A86' },
  { k: 'mint', n: '薄荷', bg: '#FFFFFF', ac: '#2F8F7B' },
  { k: 'mist', n: '雾蓝', bg: '#F6F8FA', ac: '#3E7CB1' },
  { k: 'lav', n: '薰衣草', bg: '#F8F7FB', ac: '#7C6BA8' },
  { k: 'graph', n: '石墨', bg: '#FFFFFF', ac: '#4F5459' },
  { k: 'teal', n: '湖青', bg: '#FFFFFF', ac: '#2E8B9A' }
];

const GREETS = {
  day: [
    '今天天气很好，去晒晒太阳怎么样？', '窗外有风的话，要不要闭上眼感受下？',
    '阳光落在桌上，好像挺暖的', '今天的云走得慢，看一会儿吧',
    '空气里有花香吗？要不要闻一闻？', '阳光照在手背上，暖洋洋的',
    '风把窗帘吹得轻轻动，好温柔', '晨雾散开时，远山像被谁轻轻描了一笔',
    '阳光落在叶尖，把叶子照得透亮', '风掠过整片芦苇，荡起一层温柔的银浪'
  ],
  night: [
    '晚风很温柔，是不是？', '夜色很美，赏赏月如何？', '今天有什么小小的开心事？',
    '灯亮起来了，屋里很安静吧', '窗外有星星的话，要不抬头看一眼？',
    '被窝外的世界安安静静的，是不是？', '月亮浸在湖里，碎成满池晃动的银',
    '路灯把树影投在墙上，像一幅会呼吸的画', '薄霜悄悄爬上窗，开出一树树细小的冰花',
    '星子落进杯里，茶也跟着亮了一下'
  ]
};

const DCOLORS = ['#7C9A86', '#5E9A94', '#C0A05A', '#948AA8', '#6E8CB0', '#B4544E', '#8A7B5C', '#5C7A8A'];

// 细节回读标签：来源 -> 字段名
const COLMAP = {
  obsStart: '怎么开始', 'fx:forgot': '沉浸', 'fx:nrg': '精力', 'fx:mood': '心情', obsMood: '心情',
  'free:obsfeel': '感受', genFeel: '情绪', genWant: '此刻想做', 'free:nownote': '感受', 'free:memonote': '原因', 'free:buynote': '干什么用',
  'free:trigger': '诱因', 'free:hope': '希望实现成',
  nopeMood: '情绪', nopeDeg: '程度', 'free:nopefeel': '不想感受', 'free:after': '之后',
  doneFeel: '做了感受', doneGain: '做了收获'
};
const FALLBACK = { obs: '感受', want: '诱因', nope: '不想感受', done: '做了感受', now: '感受' };

/* ---------------- 纯计算 ---------------- */
function dayLabel(ago) {
  if (ago <= 0) return '今天';
  if (ago === 1) return '昨天';
  const d = new Date(); d.setDate(d.getDate() - ago);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
function mname(k) { const m = MODULES.concat((G.dims || []).map(d => ({ k: d.k, n: d.n }))).find(x => x.k === k); return m ? m.n : k; }
function mcolor(k) { const m = MODULES.concat((G.dims || []).map(d => ({ k: d.k, n: d.n, c: d.c }))).find(x => x.k === k); return m ? m.c : '#7C9A86'; }
function isSingle(g) { for (const m of OPTGROUPS) { if (m.gs.indexOf(g) >= 0) { const f = FIELDS[m.m]; return !!(f.items.find(it => it.g === g && it.single)); } } return false; }
// 该选项组是否隐藏手填输入框（这类组不能手填，编辑时不留残值）
function isNoInput(g) { for (const m of OPTGROUPS) { if (m.gs.indexOf(g) >= 0) { const f = FIELDS[m.m]; return !!(f.items.find(it => it.g === g && it.noInput)); } } return false; }
function getOPT(g) { const O = G.OPT || OPT; return O[g] || []; }

function agoOf(ts) {
  if (!ts) return 0;
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const n = new Date(); n.setHours(0, 0, 0, 0);
  const a = Math.round((n - d) / 86400000);
  return a < 0 ? 0 : a;
}
function extLabel(src, m) {
  if (src && src.indexOf('fallback:') === 0) return FALLBACK[m] || '';
  return COLMAP[src] || FALLBACK[m] || '';
}
// 生成记录的细节展示列表 [{lbl, v}]；nope 模块把「程度」并入「情绪」一行
// 例：程度=微微，情绪=抵触 → 显示「情绪 微微抵触」
function buildExt(m, ext, extSrc) {
  const list = (ext || []).map((v, i) => {
    const src = (extSrc || [])[i] || '';
    return { src, lbl: extLabel(src, m), v };
  });
  if (m === 'nope') {
    const deg = list.find(d => d.src === 'nopeDeg');
    const degV = deg ? deg.v : '';
    return list
      .filter(d => d.src !== 'nopeDeg') // 程度不单独成行
      .map(d => (d.src === 'nopeMood' ? { lbl: '情绪', v: (degV ? degV : '') + d.v } : d));
  }
  return list;
}
// 某模块的细节来源列表（有序），用于导入时按标签反查真实来源
// 返回 [{ src, lbl }]，src 为记录里的来源键（如 obsStart / fx:forgot / free:xxx）
function srcList(m) {
  const f = FIELDS[m];
  if (!f) {
    const d = (G.dims || []).find(x => x.k === m);
    if (d) return [{ src: 'm_' + m, lbl: d.n }, { src: 'free:note', lbl: '补充' }];
    return [];
  }
  const out = [];
  f.items.forEach(it => {
    if (it.g) out.push({ src: it.g, lbl: GLABEL[it.g] || it.g });
    else if (it.fx) out.push({ src: 'fx:' + it.fx, lbl: (FIXED[it.fx] || {}).label || it.fx });
    else if (it.free) out.push({ src: 'free:' + it.free, lbl: it.label || it.free });
  });
  return out;
}
// 导入用：细节按模块字段顺序对齐到真实来源（导出文本只含值、不含标签，按顺序最稳）
// 若值里恰好等于某个标签名，则优先按标签匹配（兼容带标签的文本）
function mapExtSrc(m, labels) {
  const list = srcList(m);
  const vals = labels || [];
  const used = {};
  const out = new Array(vals.length);
  vals.forEach((v, i) => {
    const hit = list.find(it => it.lbl === v && !used[it.src]);
    if (hit) { used[hit.src] = 1; out[i] = hit.src; }
  });
  // 剩余未命中的，按字段顺序依次填未使用过的来源
  let p = 0;
  vals.forEach((v, i) => {
    if (out[i]) return;
    while (p < list.length && used[list[p].src]) p++;
    if (p < list.length) { used[list[p].src] = 1; out[i] = list[p].src; }
    else out[i] = 'fallback:' + m;
  });
  return out;
}
// 规范化时间显示：只保留 HH:MM；t 里混入的日期会剥掉，缺失时用 ts 补
function normTime(t, ts) {
  const s = String(t || '').trim();
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return ('0' + (+m[1])).slice(-2) + ':' + m[2];
  if (ts) { const d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  return s;
}
// 给一条记录补上 ago / day
function decorate(r) {
  const o = Object.assign({}, r);
  o.ago = agoOf(o.ts);
  o.day = dayLabel(o.ago);
  o.t = normTime(o.t, o.ts);
  o.extSrc = fixExtSrc(o.m, o.ext, o.extSrc);
  o.done = !!o.done;
  o.doneAt = o.doneAt || 0;
  // 备忘「原因」/ 购物「什么用」：从细节里提取对应 free 字段
  o.reason = '';
  o.usefor = '';
  const _es = o.extSrc || [], _ex = o.ext || [];
  for (let i = 0; i < _es.length; i++) {
    if (!_ex[i]) continue;
    if (_es[i] === 'free:memonote') o.reason = _ex[i];
    else if (_es[i] === 'free:buynote') o.usefor = _ex[i];
  }
  return o;
}
// 备忘 / 购物 = 待办型记录
function isTask(m) { return m === 'memo' || m === 'buy'; }
// 完成时间文案：已完成 · X月X日 HH:MM
function doneLabel(ts) {
  if (!ts) return '已完成';
  const d = new Date(ts);
  const hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
  return '已完成 · ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hh + ':' + mm;
}
// 修正历史数据的来源：整条细节都挂 fallback:<模块> 时，按字段顺序重新对齐回真实来源
function fixExtSrc(m, ext, extSrc) {
  const src = (extSrc || []).slice();
  const extArr = ext || [];
  while (src.length < extArr.length) src.push('');
  const list = srcList(m);
  if (!list.length) return src;
  // 已明确来源的保留；fallback/空 的按「标签匹配 → 顺序补齐」重新分配
  const used = {};
  src.forEach(s => { if (s && s.indexOf('fallback:') !== 0) used[s] = 1; });
  const pending = [];
  src.forEach((s, i) => { if (!s || s.indexOf('fallback:') === 0) pending.push(i); });
  if (!pending.length) return src; // 无需修正
  // 先按值与标签同名匹配
  const out = src.slice();
  pending.forEach(i => {
    const hit = list.find(it => it.lbl === extArr[i] && !used[it.src]);
    if (hit) { used[hit.src] = 1; out[i] = hit.src; }
  });
  // 剩余按字段顺序补齐
  let p = 0;
  pending.forEach(i => {
    if (out[i] && out[i].indexOf('fallback:') !== 0) return;
    while (p < list.length && used[list[p].src]) p++;
    out[i] = p < list.length ? (used[list[p].src] = 1, list[p].src) : 'fallback:' + m;
  });
  return out;
}

/* ---------------- 云开发 ---------------- */
function db() { return wx.cloud.database(); }
function recCol() { return db().collection('records'); }
function optCol() { return db().collection('options'); }
function cfgCol() { return db().collection('usercfg'); }

// 记录按微信用户（_openid）隔离：云数据库默认「仅创建者可读写」，
// 不同用户创建的文档彼此不可见，这里无需手动加 openid 过滤。
function loadRecords() {
  return new Promise((resolve) => {
    recCol().orderBy('ts', 'desc').limit(300).get().then(res => {
      const list = (res.data || []).map(d => decorate({
        id: d._id, _rid: d._id, m: d.m, t: d.t, txt: d.txt, ext: d.ext || [], extSrc: d.extSrc || [], ts: d.ts, done: !!d.done, doneAt: d.doneAt || 0
      }));
      resolve(list);
    }).catch(() => resolve([]));
  });
}
function addRecord(rec) {
  const data = { m: rec.m, t: rec.t, txt: rec.txt, ext: rec.ext || [], extSrc: rec.extSrc || [], ts: rec.ts || Date.now(), done: !!rec.done, doneAt: rec.doneAt || 0, createTime: db().serverDate() };
  return recCol().add({ data }).then(res => res._id);
}
function updateRecord(rec) {
  return recCol().doc(rec._rid).update({ data: { m: rec.m, t: rec.t, txt: rec.txt, ext: rec.ext || [], extSrc: rec.extSrc || [], ts: rec.ts || Date.now(), done: !!rec.done, doneAt: rec.doneAt || 0 } });
}
function deleteRecord(rec) {
  return recCol().doc(rec._rid).remove();
}
// 清空全部记录（递归分批删除，仅删当前用户自己的）
function clearAllRecords() {
  return recCol().limit(100).get().then(res => {
    const docs = res.data || [];
    if (!docs.length) return 0;
    return Promise.all(docs.map(d => recCol().doc(d._id).remove()))
      .then(() => clearAllRecords()).then(rest => docs.length + rest);
  }).catch(() => 0);
}

// 选项池：合并默认值、云端、本地存储（本地兜底，保证改动不丢）
const OPT_LS = 'self_opt_v1';
function loadLocalOpts() {
  try { return wx.getStorageSync(OPT_LS) || {}; } catch (e) { return {}; }
}
function persistLocalOpts() {
  try {
    const O = G.OPT || OPT;
    const copy = {};
    Object.keys(O).forEach(g => { copy[g] = (O[g] || []).slice(); });
    wx.setStorageSync(OPT_LS, copy);
  } catch (e) {}
}
function mergeOpts(O, src) {
  Object.keys(src || {}).forEach(g => {
    if (!O[g]) O[g] = [];
    (src[g] || []).forEach(v => { if (O[g].indexOf(v) < 0) O[g].push(v); });
  });
}

// 默认项的「删除/改名」覆盖：记录被删掉的默认项 key（group|value），加载时剔除，避免从 OPT 常量回弹
const DELDEF_LS = 'self_deldef_v1';
let _delDef = [];
function loadDelDefLocal() { try { return wx.getStorageSync(DELDEF_LS) || []; } catch (e) { return []; } }
function persistDelDefLocal(arr) { try { wx.setStorageSync(DELDEF_LS, arr); } catch (e) {} }
function isDefault(g, v) { return (OPT[g] || []).indexOf(v) >= 0; }
function applyDelDef(O, delDef) {
  const set = new Set(delDef || []);
  Object.keys(O).forEach(g => { if (O[g]) O[g] = O[g].filter(v => !set.has(g + '|' + v)); });
}
function loadDelDef() {
  return new Promise(resolve => {
    const local = loadDelDefLocal();
    cfgCol().where({ type: 'delDef' }).get().then(res => {
      const docs = res.data || [];
      const cloud = (docs[0] && docs[0].data) || [];
      const merged = Array.from(new Set([...local, ...cloud]));
      persistDelDefLocal(merged);
      _delDef = merged;
      resolve(merged);
    }).catch(() => { _delDef = local; resolve(local); });
  });
}
function saveDelDef(arr) {
  _delDef = arr.slice();
  persistDelDefLocal(arr);
  return cfgCol().where({ type: 'delDef' }).get().then(res => {
    const docs = res.data || [];
    if (docs.length) return cfgCol().doc(docs[0]._id).update({ data: { data: arr } }).then(() => true).catch(() => false);
    return cfgCol().add({ data: { type: 'delDef', data: arr } }).then(() => true).catch(() => false);
  }).catch(() => false);
}
function addDelDef(g, v) {
  if (!isDefault(g, v)) return Promise.resolve(false);
  const k = g + '|' + v;
  if (_delDef.indexOf(k) < 0) _delDef.push(k);
  return saveDelDef(_delDef);
}
function clearDelDef(g, v) {
  const k = g + '|' + v;
  const i = _delDef.indexOf(k);
  if (i < 0) return Promise.resolve(false);
  _delDef.splice(i, 1);
  return saveDelDef(_delDef);
}

function loadOptions() {
  return new Promise((resolve) => {
    const local = loadLocalOpts();
    Promise.all([
      optCol().limit(1000).get().catch(() => ({ data: [] })),
      loadDelDef()
    ]).then(([res, delDef]) => {
      const O = JSON.parse(JSON.stringify(OPT));
      const docs = res.data || [];
      docs.forEach(d => {
        const g = d.group, v = d.value;
        if (!O[g]) O[g] = [];
        if (O[g].indexOf(v) < 0) O[g].push(v);
      });
      mergeOpts(O, local);
      applyDelDef(O, delDef); // 剔除被删/改的默认项，避免常量回弹
      console.log('[options] 云端读取到 ' + docs.length + ' 条用户选项');
      resolve(O);
    }).catch(e => {
      console.error('[options] 云端读取失败，回退默认+本地：', e);
      const O = JSON.parse(JSON.stringify(OPT)); mergeOpts(O, local); applyDelDef(O, _delDef);
      resolve(O);
    });
  });
}
function addOption(g, v) {
  persistLocalOpts(); // 先落本地，保证不丢
  return optCol().add({ data: { group: g, value: v, sort: (getOPT(g).length) } })
    .then(res => {
      console.log('[options] 云写入成功 id=', res._id, 'group=', g, 'value=', v);
      return true;
    })
    .catch(e => { console.error('[options] 云写入失败（已存本地）：', e); return false; });
}
function removeOption(g, v) {
  persistLocalOpts();
  return new Promise((resolve) => {
    optCol().where({ group: g, value: v }).limit(1000).get().then(res => {
      const docs = res.data || [];
      let p = Promise.resolve();
      docs.forEach(d => { p = p.then(() => optCol().doc(d._id).remove()); });
      p.then(() => resolve(true)).catch(() => resolve(false));
    }).catch(() => resolve(false));
  });
}
function renameOption(g, ov, nv) {
  persistLocalOpts();
  return new Promise((resolve) => {
    optCol().where({ group: g, value: ov }).limit(1000).get().then(res => {
      const docs = res.data || [];
      let p = Promise.resolve();
      docs.forEach(d => { p = p.then(() => optCol().doc(d._id).update({ data: { value: nv } })); });
      p.then(() => resolve(true)).catch(() => resolve(false));
    }).catch(() => resolve(false));
  });
}

// 自定义维度
function loadDims() {
  return new Promise((resolve) => {
    cfgCol().where({ type: 'dims' }).get().then(res => {
      const d = (res.data && res.data[0] && res.data[0].data) || [];
      resolve(d);
    }).catch(() => resolve([]));
  });
}
function saveDims(arr) {
  return new Promise((resolve) => {
    cfgCol().where({ type: 'dims' }).get().then(res => {
      const docs = res.data || [];
      if (docs.length) return cfgCol().doc(docs[0]._id).update({ data: { data: arr } }).then(resolve).catch(resolve);
      cfgCol().add({ data: { type: 'dims', data: arr } }).then(resolve).catch(resolve);
    }).catch(() => resolve());
  });
}

// 问候语
function loadGreets() {
  return new Promise((resolve) => {
    cfgCol().where({ type: 'greets' }).get().then(res => {
      const d = (res.data && res.data[0] && res.data[0].data) || null;
      resolve(d);
    }).catch(() => resolve(null));
  });
}
function saveGreets(obj) {
  return new Promise((resolve) => {
    cfgCol().where({ type: 'greets' }).get().then(res => {
      const docs = res.data || [];
      if (docs.length) return cfgCol().doc(docs[0]._id).update({ data: { data: obj } }).then(resolve).catch(resolve);
      cfgCol().add({ data: { type: 'greets', data: obj } }).then(resolve).catch(resolve);
    }).catch(() => resolve());
  });
}

/* ---------------- 自定义维度（注册进全局常量） ---------------- */
function regDim(d) {
  if (!d || !d.k || FIELDS[d.k]) return false;
  const gk = 'm_' + d.k;
  MODULES.push({ k: d.k, n: d.n, c: d.c, custom: true });
  OPT[gk] = (d.opt || []).slice();
  GLABEL[gk] = d.n;
  FIELDS[d.k] = { main: gk, items: [{ g: gk, freeze: true, single: true }, { free: 'note', label: '补充', ph: '随便记点什么，可跳过', ta: true }] };
  return true;
}
function unregDim(k) {
  const i = MODULES.findIndex(m => m.k === k);
  if (i >= 0) MODULES.splice(i, 1);
  delete FIELDS[k];
  delete GLABEL['m_' + k];
  delete OPT['m_' + k];
}

/* ---------------- 全局状态（store 自有，避免依赖 getApp） ---------------- */
const G = {
  theme: 'sand',
  OPT: null,
  dims: [],
  greets: null,
  records: [],
  loaded: false,
  editRec: null
};

/* ---------------- 启动加载 ---------------- */
let _loading = false;
function ensureAll() {
  if (G.loaded) return Promise.resolve();
  if (_loading) return new Promise(res => { const t = setInterval(() => { if (G.loaded) { clearInterval(t); res(); } }, 120); });
  _loading = true;
  return Promise.all([loadRecords(), loadOptions(), loadDims(), loadGreets()]).then(([recs, O, dims, greets]) => {
    G.records = recs;
    G.OPT = O;
    G.dims = dims || [];
    G.greets = greets;
    (dims || []).forEach(d => regDim(d));
    G.loaded = true;
    _loading = false;
  }).catch(() => { _loading = false; });
}

// 下拉刷新用：忽略 loaded 缓存，重新从云端全量拉取（同步多端数据）
function reload() {
  return Promise.all([loadRecords(), loadOptions(), loadDims(), loadGreets()]).then(([recs, O, dims, greets]) => {
    (G.dims || []).forEach(d => unregDim(d.k)); // 先注销自定义维度，避免重复注册
    G.records = recs;
    G.OPT = O;
    G.dims = dims || [];
    G.greets = greets;
    (dims || []).forEach(d => regDim(d));
    G.loaded = true;
  });
}

module.exports = {
  MODULES, OPT, GLABEL, OPTGROUPS, FIXED, FIELDS, THEMES, GREETS, DCOLORS, COLMAP, FALLBACK,
  dayLabel, mname, mcolor, isSingle, isNoInput, getOPT, agoOf, extLabel, srcList, mapExtSrc, buildExt, decorate, isOnce, stripOnce, isTask, doneLabel,
  loadRecords, addRecord, updateRecord, deleteRecord, clearAllRecords,
  loadOptions, addOption, removeOption, renameOption,
  isDefault, addDelDef, clearDelDef,
  loadDims, saveDims, loadGreets, saveGreets, ensureAll, reload, regDim, unregDim,
  globalData: G
};
