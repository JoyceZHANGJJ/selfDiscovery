// 云函数 analysis —— AI 回看
//
// 【改这个文件之前请先看cloudfunctions/analysis/README.md】
//那里有每个 action 的控制台测试模板、参数与返回说明、额度与幂等规则、排错速查表。
// 改完请按那份文档的「更新约定」同步更新它，并跑一遍：
//   node --check cloudfunctions/analysis/index.js
//   python3 tools/check-syntax.py      ← 会检查「新增/改名的 action 有没有写进文档」
//
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
//   8) action:'promptPreview'：只读预览「大模型实际看到的资料」（system/user 消息全文 +
//      字数），用来核对喂给模型的原文长什么样；不调模型、不写库。
//      event.type: profile（默认）/ day / week / month / year。
//   9) action:'promptTest'：**调提示词用这个**。用真实记录跑一次模型，返回并落库结果，
//      但**绝不碰正式的 analysis / profile 文档**（试跑错多少次都不会影响线上内容）。
//      event.type 同上；event.rules 是**追加**到该类型规则末尾的提示词片段（留空=用线上那一版，
//      用来做基线对照）；event.overrideRules:true 则**完全替换**规则段（只保留人设与输出结构）。
//      event.label 是这次试跑的备注，会一起存下来，方便回头对比「哪一版更好」。
//   10) action:'ptestList' / 'ptestGet' / 'ptestDel'：读 / 删试跑记录（试跑页用）。
//   11) action:'promptList' / 'promptGet' / 'promptSave' / 'promptReset' /
//       'promptVersions' / 'promptVersionGet' / 'promptRevert' / 'promptAdopt'：
//       **提示词注册表**。提示词正文存在 promptset（当前生效）与 promptsetver（历史快照），
//       所以换提示词不用再「改代码 + 上传部署」，在小程序里改完保存即生效。
//       这组 action 只读写提示词，**不调大模型、不碰任何业务集合**，不花额度。
//       event.slot 是槽位名（见 PROMPT_BUILTIN）；promptAdopt 用 event.id 把某次试跑
//       的正文设为线上生效——这是「试跑 → 线上」闭环的最后一环。
//   ⚠️ 提示词读取失败（集合不存在 / 无权限 / 网络问题）一律静默退回 PROMPT_BUILTIN
//      里的出厂值，**绝不抛错**。提示词是增强项，不能成为回看 / 画像的单点故障。
//   ⚠️ 只有「人设 + 任务规则」可改；输出字段说明（fieldsSpec / profileFieldsSpec）是
//      与云函数解析、页面渲染一一对应的机器契约，只在 promptGet 里只读展示，不开放编辑。
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
// 提示词试跑结果（action:'promptTest' 写入）。只增不覆盖，用来对比不同提示词版本；
// 正式的回看 / 画像永远不写这里，所以试跑不会污染线上内容，也不会被幂等跳过。
const ptestCol = () => db.collection('promptlog');

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

// ---- AI 回看：两档提示词（对应用户给的参考提示词 A 完整版 / B 极简轻量版）----
// 每日 / 每周 → 极简轻量版（快速预览，篇幅短）；每月 / 每年 → 完整版（深度复盘，适合精读）
const REVIEW_RULES_LITE = [
  '角色：日志复盘分析师。',
  '任务：对日志做【日 / 周】回看，只抓模式与可落地动作；拒绝抒情、不流水复述原文。',
  '【硬性】禁止空话套话：不许写「调整心态、多休息、好好反思」这类无效建议；推论必须依托日志内容，禁止脑补资料里没有的信息。',
  '【硬性】事件分级：常态重复 / 短期波动 / 单次偶发——偶发事件不放大解读、不写成模式。',
  '【硬性】行动上限：日最多 2 条、周最多 3 条；每条严格写成「动作｜执行时机或频率｜目标｜自检指标」，四段缺一不可。',
  '【硬性】精简文字、突出重点，降低手机阅读负担；记录少就写得轻，不硬凑（没有的字段给空数组或空字符串）。',
  '【硬性·不重复】summary 是全文一句话结论，facts 里**不要**再把 summary 复读一遍；facts 与 patterns / compare / risks 之间也不要出现同一句话说两遍、或换个标签重说同一件事。'
].join('\n');

const REVIEW_RULES_FULL = [
  '角色：日志周期复盘分析师。',
  '任务：对日志做【月 / 年】回看复盘，重点挖掘行为、精力、情绪的长期模式，而不是简单重复写了什么。',
  '【硬性 1】严禁大段抒情、文学化描写，禁止流水账复述原文。',
  '【硬性 2】严格区分四类信息：客观事实 / 重复行为模式 / 合理推论 / 落地行动；推论必须有日志原文支撑，禁止无依据脑补。',
  '【硬性 3】事件分级：【稳定常态】反复出现、【短期波动】本周期新出现、【孤立偶发】一次性事件不放大解读。',
  '【硬性 4】行动建议上限 3 条，侧重中长期规划与方向校准，不写细碎每日小事；每条写明动作 + 执行时机或频率 + 判断是否有效的简易自检指标；拒绝空泛话术。',
  '【硬性 5】重点识别：能量消耗场景、能量充电场景、内耗触发条件、情绪波动规律、重复踩坑点、长期偏好与价值取向。',
  '【硬性 6】跨周期对比：只把多次重复的信号标记为风险，一次性事件不进风险；行动要有方向性、能落地、能自检。',
  '【硬性 7】精简文字、突出重点，降低手机阅读负担；记录少就写得轻，不硬凑（没有的字段给空数组或空字符串）。',
  '【硬性 8·不重复】summary 是全文一句话结论，facts 里**不要**再把 summary 复读一遍；facts 与 patterns / compare / risks 之间也不要出现同一句话说两遍、或换个标签重说同一件事。'
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

// ============ 提示词注册表 ============
// 把提示词从代码搬进数据库（promptset），让它变成可读、可改、可回滚的一等数据。
// 之前换提示词要「改代码 → 上传部署 → 等 1~2 分钟」，试跑页虽然能试，但试的那份和
// 线上生效的那份是两份独立文本，跑得再好也无法一键生效——这是「可随时更换」的卡点。
//
// 三条硬约定：
// 1) **出厂值兜底，永不报错**。集合不存在 / 读失败 / 正文为空，一律静默回到下面
//    PROMPT_BUILTIN 里的出厂值。提示词是增强项，绝不能成为 AI 回看的单点故障。
// 2) **只有「人设 + 任务规则」可改**。输出字段说明（fieldsSpec / profileFieldsSpec）
//    是与云函数解析、页面渲染一一对应的**机器契约**，改字段名会让页面直接白屏
//    且极难自查，所以只在 promptGet 里只读展示，不开放编辑。
// 3) **生成路径不写库**。loadPrompt 查不到就返回出厂值，不做补写——写入只发生在
//    prompt* 这几个管理 action 里（seedPrompts 用带 _id 的 add，已存在会失败，
//    所以播种不会覆盖用户改过的正文）。
const promptsetCol = () => db.collection('promptset');
const promptsetverCol = () => db.collection('promptsetver');

// 各槽位的出厂默认值。**这一份同时是「恢复默认」的还原目标**，所以改它等于改出厂设定。
// state:'active' = 已接入生成路径；'reserved' = 文案已就位，功能在后续阶段接入。
const PROMPT_BUILTIN = {
  'common.review': {
    slot: 'common.review', group: 'common', state: 'active',
    name: '回看人设与共同原则',
    desc: '所有回看共用的底子：身份、语气、不引用原话、覆盖全部维度。改这里等于换一个人格。',
    body: COMMON_RULES
  },
  'review.dayWeek': {
    slot: 'review.dayWeek', group: 'review', state: 'active',
    name: '周期复盘 · 简版（日 / 周）',
    desc: '日、周回看用。轻量、只抓模式与可落地动作，行动上限 2~3 条。',
    body: REVIEW_RULES_LITE
  },
  'review.monthYear': {
    slot: 'review.monthYear', group: 'review', state: 'active',
    name: '周期复盘 · 完整版（月 / 年）',
    desc: '月、年回看用。深度挖掘长期模式，与上一周期对比，行动偏中长期规划。',
    body: REVIEW_RULES_FULL
  },
  'report.core': {
    slot: 'report.core', group: 'report', state: 'active',
    name: '人物深度报告 · 核心规则',
    desc: '「人物深度报告」的全部硬性要求：只用原始资料、标注【推论】、禁止空话、七章固定结构。',
    body: PROFILE_RULES
  },
  'persona.full': {
    slot: 'persona.full', group: 'persona', state: 'reserved',
    name: '个人画像 · 完整版（增量迭代）',
    desc: '只沉淀跨周期稳定的特质，单次波动与偶发事件一律不进画像；每次更新附变更日志。',
    body: [
      '角色：个人画像迭代分析师。',
      '任务：根据本周期回看【增量更新】用户画像——不是全盘重写，而是新增补充、修正旧结论、淘汰过时结论。',
      '【信息分层·硬性】',
      '  稳定特质：多次周期重复、跨周期持续出现的精力模式、偏好、思维惯性、价值取舍 → 纳入画像。',
      '  短期波动：单次周期的临时情绪、偶然事件、一过性感受 → 不写入画像主体，仅可在备注区标记。',
      '  孤立偶发：一次性事件 → 直接忽略，不更新画像。',
      '【硬性 1】禁止文学抒情，不做道德评判，不贴标签（不要写「敏感 / 内向」这种定性，要用行为+ 模式描述）。',
      '【硬性 2】所有画像描述必须有复盘素材支撑，无依据的猜测禁止写入。',
      '【硬性 3】画像固定五大板块，不可删减：精力与能量模式 / 偏好与价值取向 / 思维习惯与内在卡点 / 取舍决策模式 / 健康与情绪反应特征。',
      '【硬性 4】区分「识己小程序开发」（自主创造类）与「本职工作」（外部约束任务）——两类精力反馈完全不同，画像里分开记录，禁止混为一谈。',
      '【硬性 5】每次更新末尾单独给出【画像变更日志】，只写本次新增 / 修改 / 淘汰的条目；若无变更则明确写「维持原有画像不变」。',
      '【硬性 6】画像保持简洁，每条都写成**可观测的行为模式**，避免抽象空话。'
    ].join('\n')
  },
  'persona.lite': {
    slot: 'persona.lite', group: 'persona', state: 'reserved',
    name: '个人画像 · 轻量版（周迭代）',
    desc: '周用。只做小幅补充，不重写，适合每周跑一次。',
    body: [
      '角色：轻量个人画像迭代分析师。',
      '素材来自识己手札周期回看。只提取跨周期稳定模式；单次波动与偶发事件不写入画像。',
      '区分本职工作与识己小程序两类任务，不混淆。',
      '任务：增量更新画像，不全部重写，仅补充 / 修正 / 淘汰内容，保留仍然有效的旧信息。',
      '【硬性】只写可观测的行为模式，拒绝主观标签；所有推论必须依托复盘原文，禁止脑补。'
    ].join('\n')
  },
  'preset.focusBody': {
    slot: 'preset.focusBody', group: 'preset', state: 'opt',
    name: '附加 · 聚焦身心，弱化项目',
    desc: '不想被小程序待办淹没时勾选：复盘重点放在身心、精力、情绪上。',
    body: '本次复盘重点：个人身心、精力、情绪模式；小程序开发仅作为影响精力的事件，不详细罗列功能待办清单。'
  },
  'preset.riskFirst': {
    slot: 'preset.riskFirst', group: 'preset', state: 'opt',
    name: '附加 · 强化风险权重',
    desc: '优先识别长期累积的精力透支、健康、决策类风险。',
    body: '评估时优先识别长期累积的精力透支、健康、决策类风险。'
  },
  'preset.sleepEnergy': {
    slot: 'preset.sleepEnergy', group: 'preset', state: 'opt',
    name: '附加 · 睡眠-能量关联专项',
    desc: '专门抓入睡 / 起床时间、睡眠时长与当日精力、情绪的关联规律。',
    body: '额外重点：捕捉入睡 / 起床时间、睡眠时长与当日剩余能量、情绪之间的关联规律。'
  },
  'preset.keepShort': {
    slot: 'preset.keepShort', group: 'preset', state: 'opt',
    name: '附加 · 压缩篇幅',
    desc: '任何一版都嫌太长时勾选：控制整体篇幅，不做多余解释。',
    body: '额外约束：文字尽量简短，控制整体篇幅，不用多余解释。'
  }
};

// 分组显示顺序与中文名
const PROMPT_GROUPS = [
  { group: 'common', name: '共同底子' },
  { group: 'review', name: '周期回看' },
  { group: 'persona', name: '个人画像' },
  { group: 'report', name: '人物深度报告' },
  { group: 'preset', name: '附加微调指令' }
];

let promptColsEnsured = false;
async function ensurePromptCols() {
  if (promptColsEnsured) return;
  // createCollection 幂等：已存在（-502004）或并发冲突一律吞掉，让后续查询报真实错误
  try { await db.createCollection('promptset'); } catch (e) { /* 忽略 */ }
  try { await db.createCollection('promptsetver'); } catch (e) { /* 忽略 */ }
  promptColsEnsured = true;
}

// 播种出厂值：只在管理 action 里调，生成路径不调。
// 用**带 _id 的 add**——已存在会失败，所以绝不会覆盖用户改过的正文。
async function seedPrompts() {
  await ensurePromptCols();
  const slots = Object.keys(PROMPT_BUILTIN);
  for (const slot of slots) {
    const meta = PROMPT_BUILTIN[slot];
    try {
      await promptsetCol().add({
        data: {
          _id: slot, slot: slot, group: meta.group, state: meta.state,
          name: meta.name, desc: meta.desc,
          body: meta.body, builtin: meta.body,
          rev: 1, updatedAt: Date.now(), openid: ''
        }
      });
    } catch (e) { /* 已有这条（或并发），不覆盖 */ }
  }
}

// 读生效中的提示词正文。**任何异常都退回出厂值**，绝不把错误往上抛。
async function loadPrompt(slot) {
  const meta = PROMPT_BUILTIN[slot];
  const fallback = meta ? meta.body : '';
  if (!meta) return { body: '', rev: 0 };
  try {
    const d = await promptsetCol().doc(slot).get();
    const doc = (d && d.data) || null;
    const body = doc && typeof doc.body === 'string' ? doc.body : '';
    return { body: body || fallback, rev: (doc && doc.rev) || 0 };
  } catch (e) {
    return { body: fallback, rev: 0 };     // 集合不存在 / 无权限 / 网络问题，都走兜底
  }
}

// 一次性取多个槽位（同一批生成里通常要读好几个，避免逐个await 串行）
async function loadPrompts(slots) {
  const out = {};
  for (const s of slots) out[s] = await loadPrompt(s);
  return out;
}

// 保存正文：先把旧内容存进 promptsetver 快照，再更新当前值，rev 恒 +1。
// 恒 +1 而不复用旧 rev：版本号必须唯一对应一份内容，否则「切回rev=5」之后
// rev=5 的含义会随时间漂移，历史记录就不可信了。
async function savePrompt(slot, body, note, openid) {
  const meta = PROMPT_BUILTIN[slot];
  if (!meta) return { error: '没有这个提示词槽位：' + slot };
  if (typeof body !== 'string') return { error: '提示词正文必须是文本' };
  const text = body.trim();
  if (!text) return { error: '提示词正文不能为空（想恢复出厂默认请点「恢复默认」）' };
  await ensurePromptCols();

  const cur = await loadPrompt(slot);
  let curRev = 0;
  try {
    const d = await promptsetCol().doc(slot).get();
    curRev = ((d && d.data) && d.data.rev) || 0;
  } catch (e) { /* 还没播种过，直接当 rev 0 */ }

  const newRev = Math.max(curRev, cur.rev) + 1;

  // 快照旧内容（rev = 0 说明之前一直是出厂值，那就没有「旧正文」需要留）
  if (curRev > 0 && cur.body) {
    // 先查这一版是不是已经有快照了。**为什么必须查**：并发保存时两次调用可能读到同一个
    // curRev，于是都往promptsetver 写 rev=curRev 的快照——「切回 rev=N」就会拿到
    // 不确定的那一份（用的是where().limit(1)，命中哪条不确定），而且这种不一致是静默的。
    // 单用户手动点保存几乎撞不上，但代价只是多一次极轻的查询，不值得留这个坑。
    let snapTaken = false;
    try {
      const exist = await promptsetverCol().where({ slot: slot, rev: curRev }).limit(1).get();
      snapTaken = !!(exist && exist.data && exist.data.length);
    } catch (e) { /* 查不到就按「还没留过」处理，多留一份快照不影响正确性 */ }
    if (!snapTaken) {
      try {
        await promptsetverCol().add({
          data: {
            slot: slot, rev: curRev, body: cur.body,
            note: (typeof note === 'string' ? note : '').slice(0, 100),
            openid: openid || '', createdAt: Date.now()
          }
        });
      } catch (e) { /* 快照失败不阻断保存：正文已经拿到用户手上，不能因为留档失败就不生效 */ }
    }
  }

  const data = {
    slot: slot, group: meta.group, state: meta.state,
    name: meta.name, desc: meta.desc,
    body: text, builtin: meta.body,
    rev: newRev, updatedAt: Date.now(), openid: openid || ''
  };
  try {
    await promptsetCol().doc(slot).set({ data: data });
  } catch (e) {
    // 播种过就一定存在，走不到这里；真走到了（并发删档等）退回 add
    try { await promptsetCol().add({ data: Object.assign({ _id: slot }, data) }); }
    catch (e2) { return { error: '保存失败：' + (e2 && e2.errMsg ? e2.errMsg : String(e2)) }; }
  }
  return { ok: true, rev: newRev };
}

// 读某个槽位的管理视图：正文 + 出厂值 + 只读的契约层说明
async function promptDetail(slot) {
  const meta = PROMPT_BUILTIN[slot];
  if (!meta) return { error: '没有这个提示词槽位：' + slot };
  await seedPrompts();
  const d = await promptsetCol().doc(slot).get();
  const doc = (d && d.data) || {};
  return {
    slot: slot, group: meta.group, state: meta.state,
    name: meta.name, desc: meta.desc,
    body: doc.body || meta.body,
    builtin: meta.body,
    edited: !!doc.body && doc.body !== meta.body,
    rev: doc.rev || 1,
    updatedAt: doc.updatedAt || 0,
    contract: contractOf(slot)
  };
}

// 契约层：输出字段说明的只读展示。**不给编辑**——它与云函数解析和页面渲染一一对应，
// 改了字段名，模型返回的名字云函数接不住，页面会白屏，而用户很难查出是自己改的。
function contractOf(slot) {
  if (slot === 'review.dayWeek') {
    return '【日复盘的输出字段】\n' + fieldsSpec('day') + '\n\n【周复盘的输出字段】\n' + fieldsSpec('week');
  }
  if (slot === 'review.monthYear') {
    return '【月复盘的输出字段】\n' + fieldsSpec('month') + '\n\n【年复盘的输出字段】\n' + fieldsSpec('year');
  }
  if (slot === 'report.core') return '【人物深度报告的输出字段】\n' + profileFieldsSpec();
  if (slot === 'common.review') {
    return '（本槽位只影响人设与语气，不决定输出结构。）\n回看的输出字段由「周期复盘·简版/完整版」两个槽位决定。';
  }
  if (PROMPT_BUILTIN[slot] && PROMPT_BUILTIN[slot].state === 'opt') {
    return '（附加指令只影响分析侧重，不改输出结构。）';
  }
  return '（本槽位不直接决定输出字段。）';
}

// 各粒度的输出字段说明。结构对齐参考提示词的「固定输出模板」六板：
// 客观事实汇总 / 核心模式提炼 / 变化对比 / 风险预警 / 优先行动方案 / 核心课题总结
function fieldsSpec(type) {
  const span = { day: '这一天', week: '这一周', month: '这个月', year: '这一年' }[type];
  const actionCap = type === 'day' ? 2 : 3;                // 日 2 条；周/月/年 3 条
  const year = type === 'year';
  const lines = [
    'summary（40~70 字 · 板块6「核心课题总结（一句话）」：' + span + '最值得留意的核心矛盾 / 关键发现，要说透而不是把记录压短）',
    'facts（数组 1~4 条 · 板块1「客观事实汇总」：只罗列' + span + '客观发生的关键事件 / 精力 / 情绪 / 健康 / 任务，每条 30 字内，不做主观渲染）',
    'patterns（对象 · 板块2「核心模式提炼」）：',
    '  drain（数组 1~4 条：高频消耗场景——什么任务、环境会消耗精力，触发抵触 / 疲惫 / 内耗）',
    '  charge（数组 1~4 条：稳定充电方式——哪些活动可以恢复状态；没信号给空数组 []）',
    '  moodRule（30~80 字：情绪规律——情绪波动一般在什么事件 / 时段后出现）',
    '  stuck（数组 1~4 条：惯性卡点——反复出现的思维习惯、同类型陷阱）',
    year ? '  values（数组 1~3 条 · 年度专属：长期价值偏好——一年里持续吸引你、符合你内在价值的方向）' : '  values（数组：仅年度需要填，其它周期一律给空数组 []）',
    'compare（' + (type === 'day' ? '40~100 字 · 板块3「变化对比」：【当日特殊波动】今天和你过往常态相比，异常或特殊的波动；只看当天信号，不做长期预判'
      : year ? '60~150 字 · 板块3「变化对比」：对比年初的状态，全年整体的演进、取舍与转变（要区分临时阶段性问题和底层长期模式）'
        : '50~130 字 · 板块3「变化对比」：对比上一周期，变好 / 加重 / 维持原样的地方') + '）',
    'risks（数组 0~3 条 · 板块4「风险预警」：仅列多次出现、持续下来会带来负面影响的信号，每条写清触发条件；没有就写「无明显重复风险」，孤立偶发事件不写预警' + (year ? '；年度重点识别长年反复、持续累积的内耗或健康风险' : '') + '）',
    'actions（数组 1~' + actionCap + ' 条 · 板块5「优先行动方案」（按优先级排序）：每条严格用「【动作】｜执行时机｜目标｜自检指标」四段格式，'
      + '自检指标必须是可观察的简易指标' + (year ? '；年度的动作是中长期方向 / 年度试验项目，自检指标为季度或半年可验证，不设每日小事' : '；拒绝「调整心态、多休息、好好反思」这类空话') + '）'
  ];
  return lines.map(s => '  ' + s).join('\n');
}

// opt: { overrideRules, extraRules, prompts }
//   prompts 由调用方用 loadPrompts(...) 预先取好（生成路径只读一次，避免串行 await）。
//   没传时退回出厂值——保持函数可独立调用（预览 / 试跑都靠这个兜底）。
// opt.overrideRules 为真时规则段整个换掉（从零试一版），此时不读线上那版。
async function buildMessages(rows, type, p, opt) {
  const o = opt || {};
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

  // 日 / 周用简版，月 / 年用完整版；两版现在都从 promptset 读，读不到自动退回出厂值。
  const lite = (type === 'day' || type === 'week');
  const ruleSlot = lite ? 'review.dayWeek' : 'review.monthYear';
  const prompts = o.prompts || await loadPrompts(['common.review', ruleSlot]);
  const rules = o.overrideRules ? '' : ((prompts[ruleSlot] && prompts[ruleSlot].body) || '');
  const focus = {
    day: '聚焦当日波动，对比个人常态，只看当天信号，不做长期预判。',
    week: '增加和上一周期的对比，观察阶段性变化；仅多次重复的信号标记为风险。',
    month: '做跨周的小周期汇总，观察阶段性变化并与上个月对比；仅多次重复的信号标记为风险。',
    year: '做跨月长周期汇总，提炼全年稳定特质与全年核心矛盾，对比年初状态，区分临时阶段性问题和底层长期模式；风险侧重长期持续累积的影响，行动偏向中长期规划与方向校准。'
  }[type];

  // 规则段的拼装：线上版 or 空（被整体替换），末尾再追加调用方传进来的片段。
  // 追加放在最后是有意的——模型对system 末尾的指令更敏感，新规则压得住旧规则。
  const rulesSeg = [rules, o.extraRules].filter(Boolean).join('\n');
  const common = (prompts['common.review'] && prompts['common.review'].body) || COMMON_RULES;

  const sys = common
    + '\n\n本次类型：' + (TYPE_LABEL[type] || type) + '复盘。' + focus
    + (rulesSeg ? '\n\n' + rulesSeg : '')
    + '\n\n输出 JSON 字段（严格按下面的固定板块结构，板块名不要改）：\n' + fieldsSpec(type);
  const user = '本次类型：' + (TYPE_LABEL[type] || type) + '复盘。\n以下是用户 ' + p.startStr + ' 至 ' + p.endStr + ' 这' + span
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
      // 收响应：必须**先按 Buffer 攒齐、最后一次 utf8 解码**，绝不能逐片解码。
      // 逐片（res.on('data', c => buf += c) 而不 setEncoding）时 c 是 Buffer，
      // buf += c 会让每个网络分片各自做一次 utf8 解码；而一个汉字是 3 字节，
      // 一旦被分片切开，每个残片都解码成替换字符 U+FFFD（页面显示成「�」）。
      // 出过一次：画像总结里「调整」→「调��」。setEncoding('utf8') 会用 StringDecoder
      // 跨片保留不完整的字节序列，等价于攒完再解码，是 Node 官方推荐的写法。
      res.setEncoding('utf8');
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
    '【格式硬要求】除 future/decision.rhythm 这类明确写了「字符串」的字段外，其余每一个字段都必须是**字符串或字符串数组**，',
    '  绝对不要返回嵌套对象、键值对、markdown 标题或代码块；需要分段时用「；」分隔写成一条字符串。',
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

// 人物深度报告（页面名「人物深度报告」）。规则段现在从 promptset 的report.core 读，
// 读不到自动退回出厂值 PROFILE_RULES。opt.prompts 由调用方预取（同 buildMessages）。
async function buildProfileMessages(rows, reviews, opt) {
  const o = opt || {};
  const prompts = o.prompts || await loadPrompts(['report.core']);
  const list = (rows || []).slice(0, 500).map(r => {
    const mod = MODULE_LABELS[r.m] || r.m || '记录';
    const parts = [];
    if (r.txt) parts.push(r.txt);
    const ext = (r.extSrc || []).map((s, idx) => (r.ext && r.ext[idx]) ? (s + '：' + r.ext[idx]) : null).filter(Boolean);
    if (ext.length) parts.push('（' + ext.join('，') + '）');
    return '[' + mod + '] ' + parts.join(' ') + (r.t ? ' ' + r.t : '');
  }).join('\n');

  // 联动素材：历次日/周/月/年回看里已提炼的「稳定行为、能量模式、长期价值偏好」——
  // 它们是跨记录归纳出来的，比原始记录更接近稳定特质，作为画像素材能提高准确度。
  const rv = (reviews || []).slice(-24);
  const rvLines = [];
  rv.forEach(a => {
    const p = a.patterns || {};
    const bits = [];
    const push = (label, v) => {
      const arr = Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
      if (arr.length) bits.push(label + '：' + arr.slice(0, 4).join('；'));
    };
    push('高频消耗场景', p.drain);
    push('稳定充电方式', p.charge);
    push('惯性卡点', p.stuck);
    push('长期价值偏好', p.values);
    if (p.moodRule) bits.push('情绪规律：' + p.moodRule);
    if (bits.length) {
      rvLines.push('· ' + (a.start || a.date || '') + '（' + (TYPE_LABEL[a.type] || '日') + '回看）' + bits.join('｜'));
    }
  });

  // 规则段：线上版或空（被整体替换）；追加片段放最后，对模型影响最大。
  const reportBody = (prompts['report.core'] && prompts['report.core'].body) || PROFILE_RULES;
  const rulesSeg = [o.overrideRules ? '' : reportBody, o.extraRules].filter(Boolean).join('\n');

  const sys = (rulesSeg || '你是一位擅长从个人日志中提炼稳定特质的心理分析顾问。')
    + '\n\n任务：根据用户【全部历史记录】做一份「专属人物深度分析报告」——是长期稳定的'
    + '「他大概是哪种人、适合往哪走、容易卡在哪、怎么决策」，不是某一段的复盘。'
    + '\n重点：挖出他的本能行为陷阱（下意识自动发生、事后反复纠结内耗的习惯），'
    + '并把内在矛盾拆到「两边各是什么诉求 + 什么场景爆发」，不要只写标题。'
    + '\n每一条建议都要能落到「适用场景 / 执行成本 / 潜在副作用 / 判断标准」上；'
    + '写不出具体场景与判据的建议，说明它太空，应当删除换成更具体的。'
    + (rvLines.length
      ? '\n素材说明：除了下面的原始记录，还附上了ta 历次回看里已提炼的稳定行为、能量模式与'
        + '长期价值偏好——这些是跨记录归纳出的稳定特质，与原始记录同等可信，'
        + '可用于印证或修正你的判断，但不要超出它们已表述的内容。'
      : '')
    + '\n输出严格按下面七章固定结构（不要随意合并删减板块），且严格为 JSON：\n'
    + profileFieldsSpec();
  let user = '下面是人物资料——用户从开始使用到现在（共 ' + (rows ? rows.length : 0)
    + ' 条）的全部自我觉察记录（按时间先后）：\n\n'
    + (list || '（没有记录）');
  if (rvLines.length) {
    user += '\n\n以下是从TA 历次日/周/月/年回看中提炼出的稳定模式（可作为画像素材）：\n' + rvLines.join('\n');
  }
  user += '\n\n请基于这些资料给出人物深度分析报告。';
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

// 把模型返回的任意值「压成一行可读文字」。
// 为什么要它：模型偶尔不听话，会把数组元素返回成对象（如 risks:[{触发,后果,预警}]），
// 或者把本该是字符串的字段返回成对象。直接 String(obj) 会变成 "[object Object]"
// 显示在页面上。这里递归摊平：对象 → "键：值；键：值"，数组 → 用"；"连接。
function flatText(v, depth) {
  const d = depth === undefined ? 0 : depth;
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (d > 3) return '';
  if (Array.isArray(v)) {
    return v.map(x => flatText(x, d + 1)).filter(Boolean).join('；');
  }
  if (typeof v === 'object') {
    const parts = [];
    Object.keys(v).forEach(k => {
      const val = v[k];
      const t = flatText(val, d + 1);
      if (t) parts.push((val && typeof val === 'object') ? (k + '：' + t) : (k + ' ' + t));
    });
    return parts.join('；');
  }
  return '';
}

function arrOf(v, cap) {
  const n = typeof cap === 'number' ? cap : 8;
  if (Array.isArray(v)) {
    return v.map(x => flatText(x)).filter(Boolean).slice(0, n);
  }
  const one = flatText(v);
  return one ? [one.slice(0, 400)].slice(0, n) : [];
}
// 把一个对象里指定的字段规整成数组（或字符串），方便把模型返回的嵌套结构安全落库
function objOf(v, keys) {
  const o = {};
  keys.forEach(k => { o[k] = arrOf(v && v[k]); });
  return o;
}

// ============ 跨板块去重 ============
// 为什么要它：模型常把同一句话说两遍——最典型是**卡片头的 summary 和 facts 第一条一模一样**
// （用户看到的是：折叠时一句、展开第一行又是同一句）；还爱给同一句套两个标签各说一次，
// 如「感觉疲惫：各项数据都比一般日常记录都低」与 compare 里的「整体状态：各项数据都比一般日常记录都低」。
// 提示词已要求「不要重复」，但免费档不保证；这里做一次兜底去重。
//
// 判重不只看字面完全相同：中文里换几个字换标点就是另一句字面，
// 但语义其实一样（「整体状态：X」vs「感觉疲惫：X」）。所以按下面两步走：
//   1) 归一化：去掉标点、空白、常见前后缀标签后比对；
//   2) 归一化后完全相同，或其中一条的归一化结果是另一条的前缀/子串 → 判为重复。
// 只做**保守**去重：宁可漏掉一条近义句，也不要误删掉真正不同的内容。
function normKey(s) {
  return String(s || '')
    .replace(/[（(【\[][^）)】\]]{0,12}[）)】\]]/g, '')   // 去掉短括号补充，如「（精力低）」
    .replace(/[\s，。、；：！？,.;:!?"'"'｜|/·\-—…]/g, '')            // 标点与空白
    .replace(/^(整体状态|主观感受|客观事实|核心课题|今日核心|本日核心|总体|状态)+/, '')   // 常见标签前缀
    .slice(0, 60);                                                  // 只看前60 字，够判重且快
}
// a 与 b 是否算重复
function isDup(a, b) {
  const ka = normKey(a), kb = normKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // 一条是另一条的前缀或子串（长度差够大才认，避免「工作」和「工作模式」这类误删）
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (short.length >= 6 && long.indexOf(short) >= 0) return true;
  return false;
}
// 数组内去重 + 与「参照文本」（如 summary）之间去重，保序
function dedupe(arr, refs) {
  const base = Array.isArray(refs) ? refs.filter(Boolean) : (refs ? [refs] : []);
  const kept = [];
  (Array.isArray(arr) ? arr : []).forEach(x => {
    const t = flatText(x);
    if (!t) return;
    if (base.some(r => isDup(t, r))) return;
    if (kept.some(k => isDup(t, k))) return;
    kept.push(t);
  });
  return kept;
}

// profile 集合可能还不存在（新环境首次使用，-502005）：首次用到时自动创建。
// createCollection 幂等失败（已存在 -502004 / 并发冲突）一律吞掉，让后续查询报真实错误。
let profileColEnsured = false;
async function ensureProfileCol() {
  if (profileColEnsured) return;
  try { await db.createCollection('profile'); } catch (e) { /* 已存在或并发冲突，忽略 */ }
  profileColEnsured = true;
}

// promptlog 同理：不用手动建。第一次试跑时自动创建，省掉「建了但存不进去」的折腾。
let ptestColEnsured = false;
async function ensurePtestCol() {
  if (ptestColEnsured) return;
  try { await db.createCollection('promptlog'); } catch (e) { /* 已存在，忽略 */ }
  ptestColEnsured = true;
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

  // 联动素材：已生成的回看（最多 24 份，够覆盖近期日/周/月/年），提炼出的模式更稳定
  let reviews = [];
  try {
    const rv = await analysisCol().where({ openid }).orderBy('start', 'desc').limit(24).get();
    reviews = rv.data || [];
  } catch (e) {
    // 旧文档没有 start 字段时 orderBy 可能出错，退回不排序取最新
    try {
      const rv2 = await analysisCol().where({ openid }).limit(24).get();
      reviews = rv2.data || [];
    } catch (e2) { reviews = []; }
  }

  // ⚠️ 必须 await：buildProfileMessages 现在是 async（提示词要从 promptset 读）。
  // 漏await 时 msgs 会是个 Promise，下面的 msgs[0].content 直接undefined。
  const parsed = await chatCompletion(await buildProfileMessages(rows, reviews), 0.7);
  genBudget--;
  const clean = v => flatText(v).slice(0, 800);   // 对象/数组也压成文字，绝不落[object Object]
  const f = parsed.future || {};
  const dec = parsed.decision || {};
  const doc = {
    openid,
    summary: flatText(parsed.summary).slice(0, 200),
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

  // ⚠️ 必须 await（buildMessages 是 async，提示词从 promptset 读）。
  const parsed = await chatCompletion(await buildMessages(rows, type, p));
  genBudget--;
  const clean = v => flatText(v);                 // 对象/数组也压成文字，绝不落[object Object]
  const listOf = (v, cap2) => (Array.isArray(v) ? v.map(clean).filter(Boolean).slice(0, cap2 || 5) : []);
  const pat = (parsed.patterns && typeof parsed.patterns === 'object') ? parsed.patterns : {};
  const summary = clean(parsed.summary).slice(0, 300);
  const compare = clean(parsed.compare).slice(0, 500);
  const doc = {
    openid,
    type,                                  // day / week / month / year
    date: p.startStr,// 兼容旧字段（日回看的日期；其它类型为起始日）
    start: p.startStr,
    end: p.endStr,
    // ---- 新版六板结构 ----
    // summary 是卡片头那句话；facts 若把它又说一遍，展开第一行就与折叠态重复，
    // compare 若是 facts 某条的换句话说，也一并去掉（保留先出现的那句）。
    summary: summary,
    facts: dedupe(listOf(parsed.facts, 5), [summary, compare]),
    patterns: {
      drain: dedupe(listOf(pat.drain, 5)),
      charge: dedupe(listOf(pat.charge, 5)),
      moodRule: clean(pat.moodRule).slice(0, 300),
      stuck: dedupe(listOf(pat.stuck, 5)),
      values: dedupe(listOf(pat.values, 4))
    },
    compare: compare,
    risks: dedupe(listOf(parsed.risks, 4)),
    actions: dedupe(listOf(parsed.actions, 3)),
    // ---- 旧字段（历史文档仍按这个渲染，保留以便统一展示）----
    themes: dedupe(listOf(parsed.themes, 6)),
    mood: clean(parsed.mood).slice(0, 200),
    highlight: clean(parsed.highlight).slice(0, 500),
    insight: clean(parsed.insight).slice(0, 1000),
    detail: clean(parsed.detail).slice(0, 3000),
    model: LLM_MODEL,
    createdAt: Date.now()
  };
  // 新结构为空时，用旧字段兜底出一份可读的 detail（保证前端任何情况都有内容）
  if (!doc.detail && (doc.patterns.drain.length || doc.compare || doc.risks.length)) {
    doc.detail = buildFallbackDetail(doc, type);
  }
  await analysisCol().add({ data: doc });
  return { key: type + ':' + p.startStr, ok: true };
}

// 新版六板 → 一段可读文字（给前端的「复盘随想」区兜底用；老字段全空时才走这里）
function buildFallbackDetail(doc, type) {
  const L = [];
  if (doc.facts && doc.facts.length) {
    L.push('客观事实：' + doc.facts.join('；') + '。');
  }
  const p = doc.patterns || {};
  const pat = [];
  if (p.drain && p.drain.length) pat.push('高频消耗场景：' + p.drain.join('；'));
  if (p.charge && p.charge.length) pat.push('稳定充电方式：' + p.charge.join('；'));
  if (p.stuck && p.stuck.length) pat.push('惯性卡点：' + p.stuck.join('；'));
  if (p.values && p.values.length) pat.push('长期价值偏好：' + p.values.join('；'));
  if (p.moodRule) pat.push('情绪规律：' + p.moodRule);
  if (pat.length) L.push('核心模式：\n' + pat.map(x => '· ' + x).join('\n'));
  if (doc.compare) L.push('变化对比：' + doc.compare);
  if (doc.risks && doc.risks.length) L.push('风险预警：' + doc.risks.join('；'));
  if (doc.actions && doc.actions.length) {
    L.push('优先行动：\n' + doc.actions.map(x => '· ' + x).join('\n'));
  }
  return L.join('\n\n').slice(0, 2000);
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

// 预览「到底把什么喂给了大模型」：只读、不调模型。
// 返回拼好的 system / user 消息全文 + 字数，方便核对模型看到的资料长什么样。
async function previewProfileMessages(openid) {
  const recs = await recCol().where({ _openid: openid }).orderBy('ts', 'asc').limit(500).get();
  const rows = (recs.data || []).map(d => ({
    m: d.m, txt: d.txt, ext: d.ext || [], extSrc: d.extSrc || [], ts: d.ts, t: hm(d.ts)
  }));
  let reviews = [];
  try {
    const rv = await analysisCol().where({ openid }).orderBy('start', 'desc').limit(24).get();
    reviews = rv.data || [];
  } catch (e) { reviews = []; }
  const msgs = await buildProfileMessages(rows, reviews);
  return {
    records: rows.length,
    reviewsUsed: reviews.length,
    // 记录条数可能上千，全量回传太长；只给前 40 条 + 总字数
    userHead: msgs[1].content.slice(0, 4000),
    userChars: msgs[1].content.length,
    systemChars: msgs[0].content.length
  };
}

// 预览某一周期回看喂给模型的内容（event.type，默认 day）
async function previewReviewMessages(openid, type) {
  const t = ['day', 'week', 'month', 'year'].indexOf(type) >= 0 ? type : 'day';
  const p = t === 'day' ? period('day', 1) : (pastPeriodList(t, 1)[0] || null);
  if (!p) return { error: '没有可预览的周期' };
  const recs = await recCol().where({
    _openid: openid, ts: _.and([_.gte(p.start), _.lt(p.end)])
  }).orderBy('ts', 'asc').limit(t === 'day' ? 100 : 500).get();
  const rows = (recs.data || []).map(d => ({
    m: d.m, txt: d.txt, ext: d.ext || [], extSrc: d.extSrc || [], ts: d.ts,
    ds: cnStr(d.ts || 0), t: hm(d.ts)
  }));
  const msgs = await buildMessages(rows, t, p);
  return {
    type: t, range: p.startStr + '~' + p.endStr, records: rows.length,
    userHead: msgs[1].content.slice(0, 4000),
    userChars: msgs[1].content.length,
    systemChars: msgs[0].content.length
  };
}

// ============ 提示词试跑 ============
// 调提示词的循环本来是「改代码 → 上传部署 → 生成 → 翻页面看」，一轮几分钟，
// 一天试不了两次。这个action 把循环缩短成「改一段文字 → 点一下 → 看结果」：
//   ·资料来自真实记录（和线上生成同一套拼装），所以看到的效果就是真实效果；
//   · event.rules 追加一段提示词；event.overrideRules 则把规则段整个换掉从头试；
//   · 结果写promptlog 集合返回，**完全不碰 analysis / profile**——
//     试跑错多少次都不会影响线上的回看与画像，也不会被幂等跳过。
// 落库是为了能在小程序里反复对比不同版本；也因此顺手记下当时用的提示词原文，
// 回头能对上「这个结果是哪一版提示词跑出来的」。
async function runPromptTest(openid, event) {
  const t = event.type || 'profile';
  const isProfile = t === 'profile';
  if (!isProfile && ['day', 'week', 'month', 'year'].indexOf(t) < 0) {
    return { error: 'type 只能是 profile / day / week / month / year' };
  }
  // 温度：画像 0.7（报告要稳），回看沿用线上默认 0.8；允许 event.temperature 覆盖
  const temp = typeof event.temperature === 'number' ? event.temperature : (isProfile ? 0.7 : 0.8);
  const opt = {
    extraRules: (typeof event.rules === 'string' ? event.rules.trim() : ''),
    overrideRules: !!event.overrideRules
  };

  let msgs, meta = {};
  if (isProfile) {
    const recs = await recCol().where({ _openid: openid }).orderBy('ts', 'asc').limit(500).get();
    const rows = (recs.data || []).map(d => ({
      m: d.m, txt: d.txt, ext: d.ext || [], extSrc: d.extSrc || [], ts: d.ts, t: hm(d.ts)
    }));
    let reviews = [];
    try {
      const rv = await analysisCol().where({ openid }).orderBy('start', 'desc').limit(24).get();
      reviews = rv.data || [];
    } catch (e) { reviews = []; }
    if (!rows.length) return { error: '没有记录可试' };
    msgs = await buildProfileMessages(rows, reviews, opt);
    meta = { records: rows.length, reviewsUsed: reviews.length };
  } else {
    // 与线上同一套取数：day 可指定 offset 往前推几天，周 / 月 / 年取最近一个已结束的周期
    const p = t === 'day'
      ? period('day', typeof event.offset === 'number' ? event.offset : 1)
      : (pastPeriodList(t, 1)[0] || null);
    if (!p) return { error: '没有可试的周期' };
    if (p.end > cnToday0()) return { error: '这个周期还没结束，不能试（未来的记录还不存在）' };
    const recs = await recCol().where({
      _openid: openid, ts: _.and([_.gte(p.start), _.lt(p.end)])
    }).orderBy('ts', 'asc').limit(t === 'day' ? 100 : 500).get();
    const rows = (recs.data || []).map(d => ({
      m: d.m, txt: d.txt, ext: d.ext || [], extSrc: d.extSrc || [], ts: d.ts,
      ds: cnStr(d.ts || 0), t: hm(d.ts)
    }));
    if (!rows.length) return { error: '这个周期没有记录可试' };
    msgs = await buildMessages(rows, t, p, opt);
    meta = { records: rows.length, range: p.startStr + '~' + p.endStr };
  }

  const started = Date.now();
  let parsed;
  try {
    parsed = await chatCompletion(msgs, temp);
  } catch (e) {
    return { error: '模型调用失败：' + (e && e.message ? e.message : String(e)), systemChars: msgs[0].content.length, userChars: msgs[1].content.length };
  }
  const ms = Date.now() - started;

  // 落库：连同当时的提示词原文一起存，回头能对上「这结果是哪一版跑出来的」
  const doc = Object.assign({
    openid,
    type: t,
    label: (typeof event.label === 'string' ? event.label : '').slice(0, 60),
    overrideRules: opt.overrideRules,
    rules: opt.extraRules,              // 追加的片段（空 = 跑的是线上那版）
    temperature: temp,
    systemChars: msgs[0].content.length,
    userChars: msgs[1].content.length,
    model: LLM_MODEL,
    ms,
    result: parsed,                     // 原样存，前端爱怎么渲染怎么渲染
    createdAt: Date.now()
  }, meta);

  let savedId = '';
  try {
    await ensurePtestCol();
    // ⚠️ 云函数端的 add 必须包一层 { data: {...} }（**服务端 SDK 与小程序端不同**）。
    // 直接 add(doc) 不会报错，而是**静默插入一条只有 _id 的空文档**——试跑页因此
    // 表现为「跑完了但历史里什么也没有」，极难察觉。本文件另外三处写入都包了 data。
    const add = await ptestCol().add({ data: doc });
    savedId = (add && add._id) || '';
    // 回读校验：确认字段真的落库了（而不是又一条空壳）。只在有 _id 时做，尽力而为。
    if (savedId) {
      try {
        const back = await ptestCol().doc(savedId).get();
        const d = (back && back.data) || {};
        if (!d.openid || d.createdAt == null) {
          savedId = '';
        }
      } catch (e2) { /* 回读失败不判定失败，add 已成功 */ }
    }
  } catch (e) {
    // 集合不存在 / 权限不足等：功能仍可用（下面就是本次输出），但要说清真实原因，
    // 统一说「集合可能还不存在」会让人一直去建集合，而真正的原因可能完全不是这个。
    return Object.assign({
      saved: false,
      saveError: (e && (e.errMsg || e.message)) ? String(e.errMsg || e.message) : String(e)
    }, doc);
  }

  return Object.assign({ saved: true, _id: savedId }, meta, {
    systemChars: doc.systemChars, userChars: doc.userChars, ms, model: LLM_MODEL,
    rulesUsed: opt.extraRules, overrideRules: opt.overrideRules, result: parsed
  });
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

  // 诊断：action:'promptPreview' —— 只读地预览「大模型实际看到的资料」。
  // event.type 可选 profile（默认）/ day / week / month / year。
  if (event && event.action === 'promptPreview') {
    if (!openid) return { error: 'no openid' };
    const t = event.type || 'profile';
    if (t === 'profile') return previewProfileMessages(openid);
    return previewReviewMessages(openid, t);
  }

  // 提示词试跑：用真实记录跑一次，返回并落库结果，但**不碰正式的 analysis / profile**。
  // event.type: profile / day / week / month / year
  //   event.rules 追加一段提示词（留空=用线上那版，做基线对照）
  //   event.overrideRules:true 把规则段整个换掉（从头试一版，不受现有规则束缚）
  //   event.label 备注、event.offset（日往前推几天）、event.temperature
  if (event && event.action === 'promptTest') {
    if (!openid) return { error: 'no openid' };
    return runPromptTest(openid, event);
  }

  // 试跑记录的读 / 删（小程序试跑页用）
  if (event && event.action === 'ptestList') {
    if (!openid) return { error: 'no openid' };
    const q = ptestCol().where({ openid });
    // ⚠️ 这里必须 await：.get() 返回 Promise，漏了 await 时list.data 恒为 undefined，
    // 会被下面的 `|| []` 兜成空数组 → 库里明明有记录，页面却永远显示「还没有试跑记录」。
    const list = await (event.type ? q.where({ type: event.type }) : q)
      .orderBy('createdAt', 'desc').limit(50).get();
    // 列表只要摘要：结果正文很大，全量回传既慢又撑爆小程序的数据量
    return {
      list: (list.data || []).map(d => ({
        _id: d._id, type: d.type, label: d.label, createdAt: d.createdAt,
        rules: (d.rules || '').slice(0, 60), overrideRules: !!d.overrideRules,
        temperature: d.temperature, ms: d.ms, records: d.records, range: d.range || ''
      }))
    };
  }
  if (event && event.action === 'ptestGet') {
    if (!openid) return { error: 'no openid' };
    if (!event.id) return { error: 'no id' };
    const one = await ptestCol().where({ openid, _id: event.id }).limit(1).get();
    return { doc: (one.data || [])[0] || null };
  }
  if (event && event.action === 'ptestDel') {
    if (!openid) return { error: 'no openid' };
    if (!event.id) return { error: 'no id' };
    await ptestCol().where({ openid, _id: event.id }).remove();
    return { deleted: event.id };
  }

  // ============ 提示词注册表（管理提示词用）============
  // 这组 action 只读写 promptset / promptsetver，**不调大模型、不碰任何业务集合**，
  // 所以随便调、不花额度。生成路径（generateFor / generateProfile）只经loadPrompt 读，
  // 读不到就静默退回出厂值——提示词是增强项，绝不能成为回看/画像的单点故障。

  // 列出全部槽位（分组 + rev + 是否被改过）。正文不进列表响应：提示词正文有几百上千字，
  // 一次全量回传既慢又占小程序数据量，所以只给字数，需要正文走 promptGet 单条取。
  if (event && event.action === 'promptList') {
    await seedPrompts();
    const out = [];
    for (const g of PROMPT_GROUPS) {
      const slots = [];
      for (const slot of Object.keys(PROMPT_BUILTIN)) {
        const meta = PROMPT_BUILTIN[slot];
        if (meta.group !== g.group) continue;
        let rev = 1, chars = (meta.body || '').length, edited = false;
        try {
          const d = await promptsetCol().doc(slot).get();
          const doc = (d && d.data) || null;
          if (doc) {
            rev = doc.rev || 1;
            chars = (doc.body || '').length;
            edited = !!doc.body && doc.body !== meta.body;
          }
        } catch (e) { /* 读不到就用出厂信息，列表不该因为单条失败而整体报错 */ }
        slots.push({
          slot: slot, name: meta.name, desc: meta.desc, state: meta.state,
          rev: rev, chars: chars, edited: edited
        });
      }
      if (slots.length) out.push({ group: g.group, name: g.name, slots: slots });
    }
    return { groups: out };
  }

  // 读单个槽位：正文 + 出厂值 + 只读的契约层说明
  if (event && event.action === 'promptGet') {
    if (!openid) return { error: 'no openid' };
    if (!event.slot) return { error: 'no slot' };
    return promptDetail(event.slot);
  }

  // 保存正文（自动留旧版快照，rev恒 +1）
  if (event && event.action === 'promptSave') {
    if (!openid) return { error: 'no openid' };
    if (!event.slot) return { error: 'no slot' };
    return savePrompt(event.slot, event.body, event.note, openid);
  }

  // 恢复出厂默认（也是一次正常保存，同样留快照、rev 恒 +1）
  if (event && event.action === 'promptReset') {
    if (!openid) return { error: 'no openid' };
    if (!event.slot) return { error: 'no slot' };
    const meta = PROMPT_BUILTIN[event.slot];
    if (!meta) return { error: '没有这个提示词槽位：' + event.slot };
    return savePrompt(event.slot, meta.body, '恢复出厂默认', openid);
  }

  // 某槽位的历史版本列表。**只回摘要不给正文**——正文要 promptVersionGet 单条取，
  // 几十个版本全量回传会把响应撑爆。
  if (event && event.action === 'promptVersions') {
    if (!openid) return { error: 'no openid' };
    if (!event.slot) return { error: 'no slot' };
    await ensurePromptCols();
    const q = await promptsetverCol().where({ slot: event.slot })
      .orderBy('rev', 'desc').limit(50).get();
    return {
      list: (q.data || []).map(d => ({
        rev: d.rev, note: (d.note || '').slice(0, 100),
        chars: (d.body || '').length, createdAt: d.createdAt
      }))
    };
  }

  // 取某个历史版本的正文
  if (event && event.action === 'promptVersionGet') {
    if (!openid) return { error: 'no openid' };
    if (!event.slot) return { error: 'no slot' };
    if (typeof event.rev !== 'number') return { error: 'no rev' };
    await ensurePromptCols();
    const q = await promptsetverCol().where({ slot: event.slot, rev: event.rev }).limit(1).get();
    const hit = (q.data || [])[0];
    if (!hit) return { error: '找不到 rev ' + event.rev };
    return { slot: event.slot, rev: hit.rev, body: hit.body, note: hit.note || '', createdAt: hit.createdAt };
  }

  // 切回某个历史版本。走 savePrompt 走一遍正常流程：新 rev 恒 +1（不复用旧 rev），
  // 这样「rev=N」永远唯一对应一份内容，历史不会因为回滚而变得不可信。
  if (event && event.action === 'promptRevert') {
    if (!openid) return { error: 'no openid' };
    if (!event.slot) return { error: 'no slot' };
    if (typeof event.rev !== 'number') return { error: 'no rev' };
    await ensurePromptCols();
    const q = await promptsetverCol().where({ slot: event.slot, rev: event.rev }).limit(1).get();
    const hit = (q.data || [])[0];
    if (!hit) return { error: '找不到 rev ' + event.rev };
    const r = await savePrompt(event.slot, hit.body, '回滚到 rev ' + hit.rev, openid);
    if (r.error) return r;
    return { ok: true, rev: r.rev, fromRev: hit.rev };
  }

  // **试跑 → 线上的桥**：把某次试跑用的正文设为线上生效。
  // 这是「可随时更换提示词」闭环的最后一环——之前试跑只能看，改不了线上。
  if (event && event.action === 'promptAdopt') {
    if (!openid) return { error: 'no openid' };
    if (!event.id) return { error: 'no id' };
    const one = await ptestCol().where({ openid, _id: event.id }).limit(1).get();
    const hit = (one.data || [])[0];
    if (!hit) return { error: '找不到这次试跑记录' };
    // 试跑的 type（day/week/...）要映射到对应槽位；overrideRules 为真说明它整段替换了
    // 规则段——那次的正文就是完整规则段，存进同一个槽位即可。
    const t = hit.type || 'profile';
    const slot = t === 'profile' ? 'report.core'
      : (t === 'day' || t === 'week') ? 'review.dayWeek' : 'review.monthYear';
    const body = (typeof hit.rules === 'string' ? hit.rules : '').trim();
    if (!body) {
      return { error: '这次试跑没有改提示词正文（它是拿线上那版跑的基线），没什么可采纳的。要先把提示词改一改再试。' };
    }
    const r = await savePrompt(slot, body, (hit.label ? '采纳试跑「' + hit.label + '」' : '采纳试跑'), openid);
    if (r.error) return r;
    return { ok: true, rev: r.rev, slot: slot, slotName: (PROMPT_BUILTIN[slot] || {}).name || slot };
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
