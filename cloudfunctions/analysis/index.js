// 云函数 analysis —— AI 回看
// 入口：
//   1) 定时触发（每天中国 01:00）：遍历所有有记录的用户——
//      · 先给每人生成「昨天」的日回看；
//      · 再补齐历史周 / 月 / 年：往回扫最近 12 周 / 12 月 / 5 年，没生成过且期间有记录的
//        会补出来（按 openid + type + start 幂等，重复跑不会叠加；期间没记录就不生成、
//        不留空卡；还没结束的周期不生成）。单次调用最多真正调大模型 MAX_GEN_PER_RUN 次，
//        一次补不完的由下一次定时接着补，避免撞 60s 超时。
//   2) 客户端 action:'list'：返回当前用户的历史回看（按起始日期倒序，带 type）。
//   3) action:'gen'：手动给当前用户生成一份（day 可带 offset 往前推几天；周 / 月 / 年
//      取最近一个已完整结束的周期，不用等到边界日）。
//   4) action:'backfill'：手动给当前用户补齐历史周 / 月 / 年（控制台测试 / 排查用，
//      可带 maxGen 放宽单次生成上限）。
//   5) action:'stats'：诊断——返回当前用户记录的时间分布与「该补齐哪些周期」。
//   6) action:'profile'：根据当前用户【全部历史记录】生成「专属人物深度分析报告」——固定七章
//      （基础画像 / 核心盘点 / 适配方向 / 未来推演 / 行动方案 / 决策辅助 / 总结），
//      upsert 到 profile 集合。
//      同一 openid 只保留最新一份；每个自然周只能生成一次（上次生成还落在本周内就锁定，
//      下周一 00:00 按中国时区自动解锁；返回 cooling + retryAfter 省大模型额度），
//      event.force:true 可绕过（仅控制台排查用）。
//   7) action:'profileGet'：读取已存的画像（进页面先调，不花大模型额度）。
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
const profileCol = () => db.collection('profile');   // 个人画像（每 openid 一份最新）

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

// 历史补齐：往回扫多深 & 单次调用最多真正生成几条。
// LLM 一次要几秒~十几秒，60s 超时内最多做十来次；补不完的由下一次定时接着补（幂等，不会重）。
const BACKFILL_DEPTH = { week: 12, month: 12, year: 5 };
const MAX_GEN_PER_RUN = 15;
let genBudget = 0;   // 本次调用的剩余生成额度，main 入口重置

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

// 中国时区里某个时刻所属「自然周」的周一 00:00（周一为一周之始）。
// 「每周只能重新生成一次」按自然周算：只要上次生成还落在本周内就锁定，下周一 00:00 自动解锁。
function cnWeekStart(ts) {
  const CN = 8 * 3600 * 1000;
  const d = new Date(ts + CN);
  const dow = d.getUTCDay();                       // 0=周日
  const backToMon = (dow + 6) % 7;                 // 周一=0 … 周日=6
  const mid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0) - CN;
  return mid - backToMon * 24 * 3600 * 1000;
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

// 过去 n 个「已完整结束」的自然周期（从近到远），供补齐历史用。
// 与 period() 的区别：不要求「昨天」恰是周日 / 月末 / 12-31——任何时候都能把
// 历史上缺的周 / 月 / 年补出来。end 是排他边界（下一周期的开始）。
function pastPeriodList(type, n) {
  const DAY = 24 * 3600 * 1000;
  const CN = 8 * 3600 * 1000;
  const today0 = cnToday0();
  const d = new Date(today0 + CN);                 // 用中国时区分量做基准
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const out = [];
  for (let k = 1; k <= n; k++) {
    let start, end;
    if (type === 'week') {
      const back = (d.getUTCDay() + 6) % 7;        // 距本周周一的天数
      const mon0 = today0 - back * DAY;            // 本周一 00:00
      start = mon0 - k * 7 * DAY;
      end = start + 7 * DAY;
    } else if (type === 'month') {
      start = Date.UTC(y, m - k, 1, 0, 0, 0, 0) - CN;
      end = Date.UTC(y, m - k + 1, 1, 0, 0, 0, 0) - CN;
    } else if (type === 'year') {
      start = Date.UTC(y - k, 0, 1, 0, 0, 0, 0) - CN;
      end = Date.UTC(y - k + 1, 0, 1, 0, 0, 0, 0) - CN;
    } else {
      break;
    }
    out.push({ start, end, startStr: cnStr(start), endStr: cnStr(end - DAY) });
  }
  return out;
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

// 个人画像（人物深度分析报告）专属规则：在 COMMON_RULES 的「温暖专业 / 不引用原话 /
// 覆盖全维度」之上，叠加用户给的硬性要求——不脑补、区分事实与推论、不鸡汤、结构固定。
const PROFILE_RULES = [
  '你是「识己手札」的 AI 人物深度分析分析师：既温暖，又专业——像一位懂心理学、真的逐条读过用户全部记录的咨询师。',
  '全程中文，用「你」称呼用户。语气平和、真诚，但不甜腻客套、不一味夸奖、不安慰式话术。',
  '',
  '【硬性规则 1 · 只能使用原始资料】所有分析只能使用下面提供的记录资料，严禁编造资料里不存在的信息。',
  '  严格区分【客观事实】（从记录原文直接提取）与【推论】（你的分析），凡属推论必须在该条里标注【推论】。',
  '  每一条【推论】都必须能对应资料里至少 1 条具体事实，不得套用通用人格模板（MBTI / 星座 / 性格学套话）。',
  '【硬性规则 2 · 禁止空话】禁止通用鸡汤和空泛心理学套话，像「做好情绪管理」「制定成长计划」「保持心态平衡」这类笼统描述一律不许写。',
  '  每一条建议都必须写明：适用场景、执行成本、潜在副作用、判断标准。格式用「适用…；成本…；副作用…；判断…」紧凑写出，不要展开成大段文字。',
  '【硬性规则 3 · 重点挖掘本能行为陷阱】务必挖出这个人的「本能行为陷阱」——下意识自动发生、事后反复纠结、容易内耗的习惯；',
  '  并识别内在互相冲突的需求、拆解矛盾的底层逻辑（两边分别是什么诉求、在什么典型场景下爆发），而不是只罗列矛盾标题。',
  '【硬性规则 4 · 客观写实】不要美化、不做安慰式话术，缺点和风险照实写；资料里没有的信号，宁可该节给空数组，也不要硬凑。',
  '不要逐字引用用户的任何原话，全部用自己的话概括转述；也不罗列记录内容当流水账。',
  '要覆盖全部维度的记录（今日能量、觉察、此刻、可做、待办、随记，以及其它出现的维度），从不同维度的组合里找信息。',
  '输出严格 JSON，且字段严格按下面「七章固定结构」，不要随意合并或删减板块。'
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
function chatCompletion(messages, temperature) {
  return new Promise((resolve, reject) => {
    const key = process.env.LLM_API_KEY;
    if (!key) return reject(new Error('LLM_API_KEY 未配置（在云函数环境变量里设置）'));
    const temp = (typeof temperature === 'number') ? temperature : 0.8;
    const body = JSON.stringify({
      model: LLM_MODEL,
      messages,
      response_format: { type: 'json_object' },
      temperature: temp
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

// ============ 个人画像 ============
// 基于用户【全部历史记录】做「人物深度分析报告」——固定七章结构
// （字段名即章节，嵌套对象承载子项）
function profileFieldsSpec() {
  return [
    'summary（30~60 字：一句话核心课题 + 当下最高优先级的那 1~2 件事——用于回看页入口卡展示）',
    'basic（对象 · 第一章「基础人物画像」）：',
    '  info（数组 1~4 条：纯从资料提取的客观基础信息——身份 / 阶段 / 角色，不含推断）',
    '  energy（数组 2~4 条：能量模式——充电场景与耗电场景清单，每条标明「高消耗 / 低消耗」及资料依据）',
    '  decision（数组 1~4 条：决策模式——做选择时的天然倾向、固有漏洞、容易踩坑的思考习惯）',
    '  body（数组 0~4 条：身体约束——健康 / 精力 / 体力带来的硬性限制；没信号给空数组 []）',
    '  finance（数组 0~4 条：财务现状——资产、现金流约束、财务层面的底线与顾虑；没信号给 []）',
    '  env（数组 1~4 条：环境与社交偏好——写清「能接受什么」与「绝对排斥什么」）',
    'core（对象 · 第二章「核心盘点：优势 / 短板 / 内在冲突」）：',
    '  strengths（数组 2~5 条：核心优势，每条必须写明「在什么场景下能发挥价值」+「在什么场景会失效」）',
    '  downsides（数组 2~5 条：短板与天然限制，每条必须写明「触发条件」+「被激活后带来的后果」）',
    '  conflicts（数组 1~4 条：内在矛盾，每条拆解底层逻辑——两边分别是什么诉求 + 典型爆发场景，不只罗列标题）',
    'fit（对象 · 第三章「适配方向推荐（按优先级：优先尝试 / 谨慎尝试 / 尽量避开）」）：',
    '  workFirst（数组 2~4 条：优先尝试的工作模式、任务类型、工作环境——写清适合的任务类型、节奏、项目特征）',
    '  workCareful（数组 1~3 条：谨慎尝试的工作方式——可以但要设边界 / 限量 / 先小规模验证）',
    '  workAvoid（数组 1~4 条：尽量避开的工作场景 / 任务——写明会大量消耗精力、会放大哪条短板）',
    '  life（数组 2~4 条：适合的习惯与自我调节方案——写具体动作并写明「什么时候执行」）',
    '  risks（数组 1~4 条：风险清单，每条格式为「触发条件… → 连锁后果… → 预警信号…」）',
    'future（对象 · 第四章「未来图景推演」——是条件推演不是预言，每项都要先写触发条件，2~4 句）：',
    '  neutral（中性情景：维持现有习惯、选择不变，在关键时间节点会发生哪些具体事件、会卡在哪）',
    '  optimistic（乐观情景：必须做到哪几件关键动作才能进入这个走向；会收获什么 + 伴随哪些新的代价 / 挑战）',
    '  cautious（保守风险情景：哪些行为 / 选择会触发它；逐步出现哪些身心 / 财务 / 生活问题；早期预警信号）',
    'action（对象 · 第五章「实操行动方案」）：',
    '  quick（数组 2~4 条：低成本试错行动（优先，单次投入小、可随时终止），每条格式「做什么；多久一次；耗时…；判断…；止损…」）',
    '  rules（数组 1~4 条：长期规则 / 个人边界——明确边界红线，写明遇到哪些信号就要启动边界保护）',
    '  metrics（数组 1~4 条：复盘监测指标——必须可观察、可量化（不许写主观感受），并写明多久复盘一次）',
    'decision（对象 · 第六章「决策辅助专项」——解决反复思虑的痛点）：',
    '  rhythm（50~80 字：适合一次性拍板，还是分阶段小步验证；给出具体判断依据）',
    '  framework（数组 1~3 条：做重大选择时推荐的思考框架 + 要避开的思维陷阱）',
    '  trial（数组 1~3 条：试错策略——哪些事适合大胆试、哪些绝不能试，写清各自的判据）',
    'conclusion（50 字内 · 第七章「总结」：一句话提炼核心课题；列出当下最高优先级的 1~2 件事）'
  ].join('\n');
}

function buildProfileMessages(rows) {
  const list = (rows || []).slice(0, 500).map(r => {
    const mod = MODULE_LABELS[r.m] || r.m || '记录';
    const parts = [];
    if (r.txt) parts.push(r.txt);
    const ext = (r.extSrc || []).map((s, idx) => (r.ext && r.ext[idx]) ? (s + '：' + r.ext[idx]) : null).filter(Boolean);
    if (ext.length) parts.push('（' + ext.join('，') + '）');
    return '[' + mod + '] ' + parts.join(' ') + (r.t ? ' ' + r.t : '');
  }).join('\n');

  const sys = PROFILE_RULES
    + '\n\n任务：根据用户【全部历史记录】做一份「专属人物深度分析报告」——是长期稳定的'
    + '「他大概是哪种人、适合往哪走、容易卡在哪、怎么决策」，不是某一段的复盘。'
    + '\n重点：挖出他的本能行为陷阱（下意识自动发生、事后反复纠结内耗的习惯），'
    + '并把内在矛盾拆到「两边各是什么诉求 + 什么场景爆发」，不要只写标题。'
    + '\n每一条建议都要能落到「适用场景 / 执行成本 / 潜在副作用 / 判断标准」上；'
    + '写不出具体场景与判据的建议，说明它太空，应当删除换成更具体的。'
    + '\n输出严格按下面七章固定结构（不要随意合并删减板块），且严格为 JSON：\n'
    + profileFieldsSpec();
  const user = '下面是人物资料——用户从开始使用到现在（共 ' + (rows ? rows.length : 0)
    + ' 条）的全部自我觉察记录（按时间先后）：\n\n'
    + (list || '（没有记录）') + '\n\n请基于这些资料给出人物深度分析报告。';
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

function arrOf(v) { return Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x.trim() : String(x))).filter(Boolean).slice(0, 8) : []; }
// 把一个对象里指定的字段规整成数组（或字符串），方便把模型返回的嵌套结构安全落库
function objOf(v, keys) {
  const o = {};
  keys.forEach(k => {
    const val = v && v[k];
    if (Array.isArray(val)) o[k] = val.map(x => (typeof x === 'string' ? x.trim() : String(x))).filter(Boolean).slice(0, 8);
    else if (typeof val === 'string') o[k] = val.slice(0, 800);
    else o[k] = (val == null ? [] : val);
  });
  return o;
}

// profile 集合可能还不存在（新环境首次使用，-502005）：首次用到时自动创建。
// createCollection 幂等失败（已存在 -502004 / 并发冲突）一律吞掉，让后续查询报真实错误。
let profileColEnsured = false;
async function ensureProfileCol() {
  if (profileColEnsured) return;
  try { await db.createCollection('profile'); } catch (e) { /* 已存在或并发冲突，忽略 */ }
  profileColEnsured = true;
}

// 重新生成的冷却期：**每个自然周只能生成一次**（周一 00:00 按中国时区重置）。
// 首次生成不受限制；force:true 可绕过（仅供控制台排查用）。
// 判定用「上次生成时间是否还落在当前这一周」，而不是滚动 7×24h——
// 这样「周一零点后立刻可以再生成」符合「每周从星期一开始记」的直觉。
const REGEN_WEEK = true;   // 语义开关：true=自然周，false=滚动 7 天（保留可切）

// 生成（或重新生成）当前用户的个人画像：取全部记录 → 调大模型 → upsert 到 profile 集合
async function generateProfile(openid, force) {
  await ensureProfileCol();
  if (genBudget <= 0) return { error: '本次调用额度已用完，请稍后或加大 maxGen 再试' };

  // 同一 openid 只保留一份最新画像（先查出来：既用于冷却判断，也用于下面覆盖更新）
  const ex = await profileCol().where({ openid }).limit(1).get();
  const old = (ex.data && ex.data[0]) || null;
  if (old && !force && old.updatedAt) {
    let cooling = false, retryAfter = 0;
    if (REGEN_WEEK) {
      // 自然周：上次生成还落在本周（周一 00:00 起）内 → 锁定到下周一 00:00
      const wk = cnWeekStart(Date.now());
      if (old.updatedAt >= wk) { cooling = true; retryAfter = wk + 7 * 24 * 3600 * 1000; }
    } else {
      const left = 7 * 24 * 3600 * 1000 - (Date.now() - old.updatedAt);
      if (left > 0) { cooling = true; retryAfter = old.updatedAt + 7 * 24 * 3600 * 1000; }
    }
    if (cooling) {
      return { cooling: true, retryAfter, updatedAt: old.updatedAt };
    }
  }

  const recs = await recCol().where({ _openid: openid }).orderBy('ts', 'asc').limit(500).get();
  const rows = (recs.data || []).map(d => ({
    m: d.m, txt: d.txt, ext: d.ext || [], extSrc: d.extSrc || [], ts: d.ts, t: hm(d.ts)
  }));
  if (!rows.length) return { empty: true, summary: '还没有记录，先去「记」里留下一点觉察，再回来生成画像。' };

  const parsed = await chatCompletion(buildProfileMessages(rows), 0.7);
  genBudget--;
  const clean = v => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
  const f = parsed.future || {};
  const dec = parsed.decision || {};
  const doc = {
    openid,
    summary: clean(parsed.summary).slice(0, 200),
    basic: objOf(parsed.basic, ['info', 'energy', 'decision', 'body', 'finance', 'env']),
    core: objOf(parsed.core, ['strengths', 'downsides', 'conflicts']),
    fit: objOf(parsed.fit, ['workFirst', 'workCareful', 'workAvoid', 'life', 'risks']),
    future: {
      neutral: clean(f.neutral).slice(0, 800),
      optimistic: clean(f.optimistic).slice(0, 800),
      cautious: clean(f.cautious).slice(0, 800)
    },
    action: objOf(parsed.action, ['quick', 'rules', 'metrics']),
    decision: {
      rhythm: clean(dec.rhythm).slice(0, 400),
      framework: arrOf(dec.framework),
      trial: arrOf(dec.trial)
    },
    conclusion: clean(parsed.conclusion).slice(0, 300),
    model: LLM_MODEL,
    n: rows.length,
    updatedAt: Date.now()
  };
  // 同一 openid 只保留一份最新画像（update 优先，没有才 add）
  if (old) {
    await profileCol().doc(old._id).update({ data: doc });
    return Object.assign({ _id: old._id, ok: true }, doc);
  }
  const add = await profileCol().add({ data: doc });
  return Object.assign({ _id: add._id, ok: true }, doc);
}

// 读取当前用户已存的画像（没有则返回 null）
async function getProfile(openid) {
  await ensureProfileCol();
  const ex = await profileCol().where({ openid }).orderBy('updatedAt', 'desc').limit(1).get();
  return (ex.data && ex.data.length) ? ex.data[0] : null;
}

// 为某个用户生成某个周期的回看（幂等：已有则跳过；期间无记录则跳过且不落空卡）
async function generateFor(openid, type, p) {
  // 只生成「已完整结束」的周期：结束时刻还没到（未来 / 进行中）就不生成，
  // 防止误传 offset 把「明天」也生成出一份回看
  if (p.end > Date.now()) return { skipped: true, future: true, key: type + ':' + p.startStr };
  // 生成额度用完就先不调大模型（剩下的由下一次定时 / 手动补齐接着做）
  if (genBudget <= 0) return { skipped: true, deferred: true, key: type + ':' + p.startStr };

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
  genBudget--;
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

// 逐条生成并计数（错误只记日志不中断，一条失败不影响别的）
function tally(oid, t, p, out) {
  return generateFor(oid, t, p).then(r => { if (r.ok) out.done++; else out.skipped++; })
    .catch(e => {
      out.err++;
      console.error('[analysis] 生成失败 openid=' + oid + ' ' + t + ' ' + p.startStr + '：' + e.message);
    });
}

// 对单个用户跑「日回看 + 历史周 / 月 / 年补齐」
async function generateAllFor(openid, out) {
  // 1) 日回看：回顾昨天（保底，优先于补齐）
  const dp = period('day', 1);
  if (dp) await tally(openid, 'day', dp, out);
  // 2) 周 / 月 / 年：从最近的完整周期往回扫，没生成过且有记录的补出来
  for (const t of ['week', 'month', 'year']) {
    for (const p of pastPeriodList(t, BACKFILL_DEPTH[t])) {
      await tally(openid, t, p, out);
    }
  }
}

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID || (event && event.openid);
  // 生成额度：每次调用重置（实例热复用时也不能把上一次的余额带过来）
  genBudget = (event && typeof event.maxGen === 'number') ? event.maxGen : MAX_GEN_PER_RUN;

  // 客户端：取历史列表（带 type，按起始日期倒序）
  if (event && event.action === 'list') {
    if (!openid) return { list: [] };
    const res = await analysisCol().where({ openid }).orderBy('date', 'desc').limit(120).get();
    return { list: res.data || [] };
  }

  // 单用户手动生成：action:'gen'。day 用 event.offset（往前推几天，默认 1，须 ≥1）；
  // 周 / 月 / 年取最近一个已完整结束的周期（不必等到边界日）。
  if (event && event.action === 'gen') {
    if (!openid) return { error: 'no openid' };
    const t = ['day', 'week', 'month', 'year'].indexOf(event.type) >= 0 ? event.type : 'day';
    const p = t === 'day'
      ? period('day', typeof event.offset === 'number' ? event.offset : 1)
      : (pastPeriodList(t, 1)[0] || null);
    if (!p) return { error: '没有可生成的周期' };
    const r = await generateFor(openid, t, p);
    if (r.future) return { error: '不能生成未来的回看（day 的 offset 需 ≥ 1）' };
    return r;
  }

  // 单用户补齐历史：action:'backfill'（控制台测试 / 排查用）——
  // 扫最近 BACKFILL_DEPTH 个周 / 月 / 年，缺且有记录的补生成；默认上限 30 条，可 maxGen 放宽
  if (event && event.action === 'backfill') {
    if (!openid) return { error: 'no openid' };
    if (typeof event.maxGen === 'number') genBudget = event.maxGen;
    const out = { done: 0, skipped: 0, err: 0 };
    await generateAllFor(openid, out);
    return { backfill: true, done: out.done, skipped: out.skipped, err: out.err };
  }

  // 诊断：action:'stats' —— 当前用户记录的时间分布，用来核对「哪些周 / 月 / 年该有回看」。
  // 返回 total（记录条数）、first/last（最早最晚日期）、perDay（按天条数）、
  // backfillShouldGenerate（过去 12 周 / 12 月 / 5 年里「有记录」的周期清单——
  // backfill 应该刚好生成这些；如果 stats 里有、backfill 却没生成，才是真 bug）
  if (event && event.action === 'stats') {
    if (!openid) return { error: 'no openid' };
    const recs = await recCol().where({ _openid: openid }).orderBy('ts', 'asc').limit(1000).get();
    const rows = (recs.data || []).filter(r => r.ts);
    if (!rows.length) return { total: 0, note: '该 openid 下没有带时间的记录' };
    const perDay = {};
    rows.forEach(r => { const k = cnStr(r.ts); perDay[k] = (perDay[k] || 0) + 1; });
    const keys = Object.keys(perDay).sort();
    const cover = [];
    for (const t of ['week', 'month', 'year']) {
      pastPeriodList(t, BACKFILL_DEPTH[t]).forEach(p => {
        const n = rows.filter(r => r.ts >= p.start && r.ts < p.end).length;
        if (n) cover.push({ type: t, range: p.startStr + '~' + p.endStr, n });
      });
    }
    return { total: rows.length, first: keys[0], last: keys[keys.length - 1], perDay, backfillShouldGenerate: cover };
  }

  // 个人画像：读取已存的（前端进页先调这个，快、不花大模型额度）
  if (event && event.action === 'profileGet') {
    if (!openid) return { error: 'no openid' };
    const p = await getProfile(openid);
    return { profile: p };
  }

  // 个人画像：根据全部记录（重新）生成并落库（默认的「重新生成」按钮 / 下拉触发）
  // 7 天冷却：已有画像且 7 天内再点 → 返回 cooling + retryAfter（不花大模型额度）
  if (event && event.action === 'profile') {
    if (!openid) return { error: 'no openid' };
    return generateProfile(openid, !!event.force);
  }

  // 有用户上下文但没带可识别的 action（比如用测试模板直接跑）：不干活，
  // 也绝不能落到下面的定时批量分支——否则一次手动测试会给所有用户补齐一遍
  if (openid) return { ok: false, hint: '无 action；生成用 action:gen / backfill，列表用 action:list' };

  // 定时任务（无用户上下文）：先给所有用户出昨天的日回看，再逐人补齐历史周 / 月 / 年
  const agg = await recCol().aggregate().group({ _id: '$_openid' }).limit(1000).end();
  const ids = (agg.list || []).map(x => x._id).filter(Boolean);
  const out = { done: 0, skipped: 0, err: 0 };
  for (const oid of ids) await generateAllFor(oid, out);
  return { trigger: true, day: cnStr(cnToday0() - 86400000), users: ids.length, done: out.done, skipped: out.skipped, err: out.err };
};
