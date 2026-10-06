// 云函数 analysis —— AI 回看
// 两个入口：
//   1) 定时触发（每天中国 01:00）：遍历所有有记录的用户，为「昨天」生成一份 AI 回看，
//      存进 analysis 集合（按 openid + date 幂等，重复跑不会叠加）。
//   2) 客户端调用 action:'list'：返回当前用户的历史回看（按日期倒序）。
//
// 大模型密钥从「云函数环境变量」读（控制台 → 云函数 → 配置 → 环境变量），绝不写进代码。
// 默认用智谱 GLM-4-Flash（OpenAI 兼容接口，官方永久免费、中文强，适合日记回顾这种轻量场景）。
// 想换厂商：把 LLM_BASE_URL 设成「接口 base」（不含 /chat/completions），LLM_MODEL 设成对应模型名，
// 再在控制台配 LLM_API_KEY 即可。例如硅基流动：LLM_BASE_URL=https://api.siliconflow.cn/v1 ，
// LLM_MODEL=Qwen/Qwen2.5-7B-Instruct（9B 以下小模型也永久免费）。
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

// 维度中文名（与小程序 MODULES 对齐）
const MODULE_LABELS = {
  today: '今日', obs: '觉察', now: '此刻', want: '可做',
  todo: '待办', jot: '随记', sleep: '睡', wake: '起'
};

function pad(n) { return (n < 10 ? '0' : '') + n; }

// 中国时区的某一天（offset: 0=今天, -1=昨天）的 [start, end) 毫秒区间 + 'YYYY-MM-DD'
function cnDay(offset) {
  const CN = 8 * 3600 * 1000;
  const shifted = new Date(Date.now() + CN);          // 把当前时刻平移到中国时区再取日期
  const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth(), d = shifted.getUTCDate();
  const dayUtc = Date.UTC(y, m, d + (offset || 0), 0, 0, 0, 0);
  const start = dayUtc - CN;                          // 中国当天 00:00 的 epoch（毫秒）
  const end = start + 24 * 3600 * 1000;
  const dt = new Date(dayUtc);
  const dateStr = dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
  return { start, end, dateStr };
}

function hm(ts) {
  const d = new Date(ts || 0);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 组装发给大模型的消息
function buildMessages(recs, dateStr) {
  const list = (recs || []).slice(0, 80).map((r, i) => {
    const mod = MODULE_LABELS[r.m] || r.m || '记录';
    const parts = [];
    if (r.txt) parts.push(r.txt);
    const ext = (r.extSrc || []).map((s, idx) => (r.ext && r.ext[idx]) ? (s + '：' + r.ext[idx]) : null)
      .filter(Boolean);
    if (ext.length) parts.push('（' + ext.join('，') + '）');
    return (i + 1) + '. [' + mod + '] ' + parts.join(' ') + ' ' + hm(r.ts);
  }).join('\n');

  const sys = '你是「识己手札」的 AI 回看伙伴，陪用户温柔地回顾自己一天的自我觉察记录。\n'
    + '要求：\n'
    + '· 全程中文，用「你」称呼用户，语气温暖、像朋友，不评判。\n'
    + '· 只基于下面给出的记录，不编造没记过的事；记录少就写得轻一点，别硬凑。\n'
    + '· 输出严格 JSON（不要任何解释文字、不要代码块包裹），字段：\n'
    + '  summary（一句话总结今天，40 字以内）\n'
    + '  themes（数组，今天反复出现的主题 / 情绪，2-4 条，每条短）\n'
    + '  mood（今天整体情绪基调，一句话）\n'
    + '  highlight（今天值得记住的一件事或瞬间，可空字符串 ""）\n'
    + '  suggestion（给明天的一句温柔小建议，30 字以内）\n'
    + '  detail（150-300 字随想，像朋友一样陪你回顾这一天，可分段）';
  const user = '以下是 ' + dateStr + ' 这一天记录的自我觉察（按时间先后）：\n\n'
    + (list || '（这一天没有记录）') + '\n\n请基于这些给出今天的 AI 回看。';
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

// 为某个用户生成某天的回看（幂等：已有则跳过）
async function generateFor(openid, day) {
  const ex = await analysisCol().where({ openid, date: day.dateStr }).get();
  if (ex.data && ex.data.length) return { skipped: true, date: day.dateStr };

  const recs = await recCol().where({
    _openid: openid,
    ts: _.and([_.gte(day.start), _.lt(day.end)])
  }).orderBy('ts', 'asc').limit(100).get();

  const rows = (recs.data || []).map(d => ({
    m: d.m, txt: d.txt, ext: d.ext || [], extSrc: d.extSrc || [], ts: d.ts
  }));

  const parsed = await chatCompletion(buildMessages(rows, day.dateStr));
  const clean = v => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
  const doc = {
    openid,
    date: day.dateStr,
    summary: clean(parsed.summary).slice(0, 200),
    themes: Array.isArray(parsed.themes) ? parsed.themes.map(clean).filter(Boolean).slice(0, 8) : [],
    mood: clean(parsed.mood).slice(0, 200),
    highlight: clean(parsed.highlight).slice(0, 500),
    suggestion: clean(parsed.suggestion).slice(0, 200),
    detail: clean(parsed.detail).slice(0, 2000),
    model: LLM_MODEL,
    createdAt: Date.now()
  };
  await analysisCol().add({ data: doc });
  return { date: day.dateStr, ok: true };
}

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID || (event && event.openid);

  // 客户端：取历史列表
  if (event && event.action === 'list') {
    if (!openid) return { list: [] };
    const res = await analysisCol().where({ openid }).orderBy('date', 'desc').limit(60).get();
    return { list: res.data || [] };
  }

  // 定时任务（无用户上下文）：为所有用户生成「昨天」
  if (!openid) {
    const day = cnDay(-1);
    const agg = await recCol().aggregate().group({ _id: '$_openid' }).limit(1000).end();
    const ids = (agg.list || []).map(x => x._id).filter(Boolean);
    let done = 0, skipped = 0, err = 0;
    for (const oid of ids) {
      try {
        const r = await generateFor(oid, day);
        if (r.skipped) skipped++; else done++;
      } catch (e) {
        err++;
        console.error('[analysis] 生成失败 openid=' + oid + ' date=' + day.dateStr + '：' + e.message);
      }
    }
    return { trigger: true, day: day.dateStr, users: ids.length, done, skipped, err };
  }

  // 单用户手动生成（保留能力，未在小程序暴露按钮）：action:'gen'
  if (event && event.action === 'gen') {
    if (!openid) return { error: 'no openid' };
    const day = cnDay(typeof event.offset === 'number' ? event.offset : -1);
    return generateFor(openid, day);
  }

  return { ok: false };
};
