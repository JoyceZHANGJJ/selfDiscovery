// 云函数 analysis —— AI 回看
// 入口：
//   1) 定时触发（每天中国 01:00）：遍历所有有记录的用户，生成到昨天为止「该生成」的回看：
//      · 日回看：每天（回顾昨天）
//      · 周回看：昨天恰好是周日时，回顾刚结束的那一周（周一~周日）
//      · 月回看：昨天恰好是月末时，回顾刚结束的那个月
//      · 年回看：昨天恰好是 12-31 时，回顾刚结束的那一年
//      按 openid + type + start 幂等，重复跑不会叠加；期间没有记录就不生成（不留空卡）。
//   2) 客户端 action:'list'：返回当前用户的历史回看（按起始日期倒序，带 type）。
//
// 提示词的设计目标（用户反馈迭代）：不做流水账复述，做有参考意义的复盘——
//   指出模式与连接、说可能的内在动机与张力、给具体可做且有方向性的建议；
//   不逐字引用用户原话，全部转述概括；覆盖全部维度，不只见某一类记录。
//
// 大模型密钥从「云函数环境变量」读（控制台 → 云函数 → 配置 → 环境变量），绝不写进代码。
// 默认智谱 GLM-4-Flash（OpenAI 兼容，免费）。换厂商改 LLM_BASE_URL（填 base）/ LLM_MODEL。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const recCol = () => db.collection('records');
const analysisCol = () => db.collection('analysis');

// ---- 配置（非密钥项可放 config.json 的 env；密钥 LLM_API_KEY 必须在控制台环境变量里配） ----
// LLM_BASE_URL 是「接口 base」，/chat/completions 由代码自动拼上，避免各家路径不一致写错。
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const LLM_MODEL = process.env.LLM_MODEL || 'glm-4-flash';

// 维度中文名（与小程序 MODULES 对齐；自定义维度不在表里，原样透出）
const MODULE_LABELS = {
  today: '今日能量', obs: '觉察', now: '此刻', want: '可做',
  todo: '待办', jot: '随记', sleep: '睡', wake: '起'
};

const TYPE_LABEL = { day: '日', week: '周', month: '月', year: '年' };

function pad(n) { return (n < 10 ? '0' : '') + n; }

// 中国时区「今天 00:00」的 epoch（毫秒）。把当前时刻 +8h 再取日期，就能无视服务器时区。
function cnToday0() {
  const CN = 8 * 3600 * 1000;
  const shifted = new Date(Date.now() + CN);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 0, 0, 0, 0) - CN;
}
// 把中国时区 epoch 转成 'YYYY-MM-DD'（先用 +8h 平移再取 UTC 分量）
function cnStr(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

// 某一段 [start, end) + 起止字符串。type：
//   day   —— offset 天前的那一天
//   week  —— 上一个完整自然周（周一 00:00 ~ 下周一 00:00），即包含「昨天」且昨天为周日的周
//   month —— 上一个完整自然月（1 号 00:00 ~ 本月 1 号 00:00），仅当昨天是月末时才算「该生成」
//   year  —— 上一个自然年，仅当昨天是 12-31 时才算「该生成」
function period(type, offset) {
  const DAY = 24 * 3600 * 1000;
  const today0 = cnToday0();
  const yst0 = today0 - (offset || 0) * DAY;              // 「昨天」00:00
  const ystD = new Date(yst0 + 8 * 3600 * 1000);          // 用中国时区分量判断周几/几号
  const ystUc = ystD.getUTCDate();                        // 昨天几号
  if (type === 'day') {
    return { start: yst0, end: yst0 + DAY, startStr: cnStr(yst0), endStr: cnStr(yst0) };
  }
  if (type === 'week') {
    const dow = ystD.getUTCDay();                         // 0=周日
    if (dow !== 0) return null;                           // 只有昨天是周日，上周才算刚结束
    const start = yst0 - 6 * DAY;
    return { start, end: yst0 + DAY, startStr: cnStr(start), endStr: cnStr(yst0) };
  }
  if (type === 'month') {
    const y = ystD.getUTCFullYear(), m = ystD.getUTCMonth();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();  // 该月天数
    if (ystUc !== last) return null;                      // 只有昨天是月末，上月才算刚结束
    const start = Date.UTC(y, m, 1, 0, 0, 0, 0) - 8 * 3600 * 1000;
    return { start, end: yst0 + DAY, startStr: cnStr(start), endStr: cnStr(yst0) };
  }
  if (type === 'year') {
    const y = ystD.getUTCFullYear();
    if (ystD.getUTCMonth() !== 11 || ystUc !== 31) return null; // 只有 12-31，这一年才算刚结束
    const start = Date.UTC(y, 0, 1, 0, 0, 0, 0) - 8 * 3600 * 1000;
    return { start, end: yst0 + DAY, startStr: cnStr(start), endStr: cnStr(yst0) };
  }
  return null;
}

function hm(ts) {
  const d = new Date(ts || 0);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ============ 提示词 ============
// 共同的「人设与原则」。核心诉求：有参考意义、有建设性、不引用原话、覆盖全部维度。
const COMMON_RULES = [
  '你是「识己手札」的 AI 回看伙伴：既温暖，又专业——像一位懂心理学、真的读过你全部记录的咨询师，而不是客套的树洞。',
  '全程中文，用「你」称呼用户。语气平和、真诚、有温度，但不要甜腻客套，也不要一味夸奖。',
  '只基于给出的记录推理，不编造没记过的事；记录少就写得轻，不硬凑。',
  '重要：不要逐字引用用户的任何原话，全部用自己的话概括转述；也不要罗列记录内容当流水账。',
  '要覆盖全部维度的记录（今日能量、觉察、此刻、可做、待办、随记，以及其它出现的维度），从不同维度的**组合**里找信息，不要只盯着某一类。',
  '有建设性：指出反复出现的模式、不同记录之间的连接、可能的内在需求与张力、被忽略的信号；也明确说出做得好的地方。',
  '建议要具体、可执行、有方向感：告诉用户「可以往哪看、可以试什么、为什么值得试」，帮 TA 更了解自己，而不是「早点休息」这类空话。',
  '输出严格 JSON（不要解释文字、不要代码块包裹）。'
].join('\n');

// 各粒度的输出字段说明（结构一致，指导语按粒度变）
function fieldsSpec(type) {
  const span = { day: '这一天', week: '这一周', month: '这个月', year: '这一年' }[type];
  const lines = [
    'summary（40~70 字：' + span + '真正的主线是什么——用你的分析把它说透，不是把记录压短）',
    'themes（数组 2~5 条：' + span + '反复出现的主题 / 情绪 / 张力，每条 14 字以内）',
    'mood（' + span + '整体情绪基调，带强度与变化，如「平静偏紧，后半段明显耗竭」，25 字内）',
    'insight（100~200 字：一个更深的自我观察——' + span + '里用户可能没意识到的模式、需求或矛盾；这是全文最要有分量的部分）',
    'actions（数组 2~3 条：接下来具体可以试的小行动，每条 30 字以内，要可执行、有方向性，并暗含「为什么」）',
    'detail（300~500 字：像咨询师做复盘一样展开——主线 → 模式与连接 → 盲点与张力 → 值得肯定的地方 → 调整方向。自然分段，不用小标题，不引用原话）'
  ];
  if (type === 'day') {
    lines.splice(3, 0, 'highlight（' + span + '最值得记住的一个瞬间或自我发现，40 字内，可空字符串 ""）');
  }
  return lines.map(s => '  ' + s).join('\n');
}

function buildMessages(rows, type, p) {
  const span = { day: '一天', week: '一周', month: '一个月', year: '一年' }[type];
  const cap = type === 'day' ? 100 : 400;
  const list = (rows || []).slice(0, cap).map(r => {
    const mod = MODULE_LABELS[r.m] || r.m || '记录';
    const parts = [];
    if (r.txt) parts.push(r.txt);
    const ext = (r.extSrc || []).map((s, idx) => (r.ext && r.ext[idx]) ? (s + '：' + r.ext[idx]) : null)
      .filter(Boolean);
    if (ext.length) parts.push('（' + ext.join('，') + '）');
    return (r.ds && r.ds !== p.startStr ? r.ds + ' ' : '') + '[' + mod + '] ' + parts.join(' ') + (r.t ? ' ' + r.t : '');
  }).join('\n');

  const sys = COMMON_RULES + '\n\n输出 JSON 字段（' + (TYPE_LABEL[type] || type) + '回看）：\n' + fieldsSpec(type);
  const user = '以下是用户 ' + p.startStr + ' 至 ' + p.endStr + ' 这' + span
    + '记录的自我觉察（按时间先后，日期只在与起始日不同时标注）：\n\n'
    + (list || '（这段期间没有记录）') + '\n\n请基于这些给出这' + span + '的 AI 回看。';
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

// 把模型返回的文本尽可能解析成 JSON（免费档对 response_format:json_object 支持不如付费稳，
// 模型偶尔会包一层 ```json 或前后加废话，这里逐层兜底。实在解析不出才抛错。）
function parseContent(content) {
  if (typeof content !== 'string') throw new Error('返回内容不是字符串');
  let s = content.trim();
  try { return JSON.parse(s); } catch (e) {}
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) { try { return JSON.parse(m[1].trim()); } catch (e) {} }
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  if (a >= 0 && z > a) {
    try { return JSON.parse(s.slice(a, z + 1)); } catch (e2) {}
  }
  throw new Error('无法从返回内容解析出 JSON：' + s.slice(0, 120));
}

// 调大模型（用内置 https，不引第三方依赖）
function chatCompletion(messages) {
  return new Promise((resolve, reject) => {
    const key = process.env.LLM_API_KEY;
    if (!key) return reject(new Error('LLM_API_KEY 未配置（在云函数环境变量里设置）'));
    const body = JSON.stringify({
      model: LLM_MODEL,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.8
    });
    let u;
    try { u = new URL(LLM_BASE_URL); } catch (e) { return reject(new Error('LLM_BASE_URL 非法：' + LLM_BASE_URL)); }
    // base 可能带或不带结尾斜杠，统一处理成 base + /chat/completions
    let path = u.pathname || '/';
    if (!path.endsWith('/')) path += '/';
    path = path + 'chat/completions' + (u.search || '');
    const port = u.port || (u.protocol === 'http:' ? 80 : 443);
    const req = require('https').request({
      hostname: u.hostname, port, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('LLM HTTP ' + res.statusCode + '：' + buf.slice(0, 300)));
        }
        try {
          const j = JSON.parse(buf);
          const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!content) return reject(new Error('LLM 返回内容为空'));
          resolve(parseContent(content));
        } catch (e) {
          reject(new Error('LLM 返回解析失败：' + e.message + ' | ' + buf.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 为某个用户生成某个周期的回看（幂等：已有则跳过；期间无记录则跳过且不落空卡）
async function generateFor(openid, type, p) {
  // 旧日回看文档没有 type/start 字段，沿用 openid+date 判重，避免重复生成
  const where = type === 'day'
    ? { openid, date: p.startStr }
    : { openid, type, start: p.startStr };
  const ex = await analysisCol().where(where).get();
  if (ex.data && ex.data.length) return { skipped: true, key: type + ':' + p.startStr };

  const recs = await recCol().where({
    _openid: openid,
    ts: _.and([_.gte(p.start), _.lt(p.end)])
  }).orderBy('ts', 'asc').limit(type === 'day' ? 100 : 500).get();

  const rows = (recs.data || []).map(d => ({
    m: d.m, txt: d.txt, ext: d.ext || [], extSrc: d.extSrc || [], ts: d.ts,
    ds: cnStr(d.ts || 0), t: hm(d.ts)
  }));
  if (!rows.length) return { skipped: true, empty: true, key: type + ':' + p.startStr };

  const parsed = await chatCompletion(buildMessages(rows, type, p));
  const clean = v => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
  const doc = {
    openid,
    type,                                  // day / week / month / year
    date: p.startStr,                      // 兼容旧字段（日回看的日期；其它类型为起始日）
    start: p.startStr,
    end: p.endStr,
    summary: clean(parsed.summary).slice(0, 300),
    themes: Array.isArray(parsed.themes) ? parsed.themes.map(clean).filter(Boolean).slice(0, 8) : [],
    mood: clean(parsed.mood).slice(0, 200),
    highlight: clean(parsed.highlight).slice(0, 500),
    insight: clean(parsed.insight).slice(0, 1000),
    actions: Array.isArray(parsed.actions) ? parsed.actions.map(clean).filter(Boolean).slice(0, 5) : [],
    detail: clean(parsed.detail).slice(0, 3000),
    model: LLM_MODEL,
    createdAt: Date.now()
  };
  await analysisCol().add({ data: doc });
  return { key: type + ':' + p.startStr, ok: true };
}

// 对单个用户跑一遍「该生成」的清单：昨天(日) + 刚结束的周/月/年（若昨天恰是边界）
async function generateAllFor(openid) {
  const types = ['day', 'week', 'month', 'year'];
  const out = { done: 0, skipped: 0, err: 0 };
  for (const t of types) {
    const p = period(t, 1);                // offset 1 = 昨天
    if (!p) continue;                      // 周月年只在边界日生成
    try {
      const r = await generateFor(openid, t, p);
      if (r.ok) out.done++; else out.skipped++;
    } catch (e) {
      out.err++;
      console.error('[analysis] 生成失败 openid=' + openid + ' ' + t + ' ' + p.startStr + '：' + e.message);
    }
  }
  return out;
}

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID || (event && event.openid);

  // 客户端：取历史列表（带 type，按起始日期倒序）
  if (event && event.action === 'list') {
    if (!openid) return { list: [] };
    const res = await analysisCol().where({ openid }).orderBy('date', 'desc').limit(120).get();
    return { list: res.data || [] };
  }

  // 定时任务（无用户上下文）：为所有用户生成该生成的日/周/月/年回看
  if (!openid) {
    const agg = await recCol().aggregate().group({ _id: '$_openid' }).limit(1000).end();
    const ids = (agg.list || []).map(x => x._id).filter(Boolean);
    let done = 0, skipped = 0, err = 0;
    for (const oid of ids) {
      const r = await generateAllFor(oid);
      done += r.done; skipped += r.skipped; err += r.err;
    }
    return { trigger: true, day: cnStr(cnToday0() - 86400000), users: ids.length, done, skipped, err };
  }

  // 单用户手动生成（保留能力，未在小程序暴露按钮）：action:'gen'
  // event.type: day/week/month/year（默认 day），event.offset: 往前推几天（默认 1）
  if (event && event.action === 'gen') {
    if (!openid) return { error: 'no openid' };
    const t = ['day', 'week', 'month', 'year'].indexOf(event.type) >= 0 ? event.type : 'day';
    const p = period(t, typeof event.offset === 'number' ? event.offset : 1);
    if (!p) return { error: '该周期尚未结束，无可生成' };
    return generateFor(openid, t, p);
  }

  return { ok: false };
};
