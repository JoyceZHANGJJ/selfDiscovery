// utils/date.js —— 日期 / 时长工具（各页原本各写一份，这里统一，避免改一处漏三处）
// dayStart(某天 0 点时间戳) / agoOf(距今天数) / datePrefix(时间线日期前缀) /
// dayLabel(今天·昨天·X月X日) / hhmm(HH:MM) / fmtDur(时长文案)
const DAY = 86400000;

// 某天 0 点的时间戳（跨年也不会撞 key）
function dayStart(ts) {
  const d = new Date(ts || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 距今天数：0=今天，1=昨天……未来按 0 处理
function agoOf(ts) {
  if (!ts) return 0;
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const n = new Date(); n.setHours(0, 0, 0, 0);
  const a = Math.round((n - d) / DAY);
  return a < 0 ? 0 : a;
}

// 时间线（非待办）记录的日期前缀：今天＝空串；昨天 / 前天用相对说法；更早给日期（跨年才带年份）
function datePrefix(ts) {
  const ago = agoOf(ts);
  if (ago <= 0) return '';
  if (ago === 1) return '昨天 ';
  if (ago === 2) return '前天 ';
  const d = new Date(ts), now = new Date();
  const md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return (d.getFullYear() === now.getFullYear() ? md : (d.getFullYear() + '年' + md)) + ' ';
}

// 按「距今天数」给日标签：今天 / 昨天 / X月X日
function dayLabel(ago) {
  if (ago <= 0) return '今天';
  if (ago === 1) return '昨天';
  const d = new Date(); d.setDate(d.getDate() - ago);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

// 时间戳 -> HH:MM
function hhmm(ts) {
  const d = new Date(ts);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

// 用时格式化：不足 1 天用小时（不足 1 小时用分钟，再短「片刻」）；满 1 天用「天」保留一位小数
function fmtDur(ms) {
  if (ms <= 0) return '';
  const HOUR = 3600000, MIN = 60000;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    if (h > 0) return h + ' 小时';
    const m = Math.floor(ms / MIN);
    if (m > 0) return m + ' 分钟';
    return '片刻';
  }
  const d = ms / DAY;
  return (Math.round(d * 10) / 10) + ' 天';
}

// ---------- 日历（选日期用） ----------

function pad2(n) { return ('0' + n).slice(-2); }
// 时间戳 -> 'YYYY-MM-DD'
function ymd(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
// 'YYYY-MM-DD' -> 当天 0 点的时间戳；认不出来给 0（不猜）
function parseYmd(s) {
  const p = String(s || '').split('-');
  if (p.length !== 3) return 0;
  const y = +p[0], mo = +p[1], d = +p[2];
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return 0;
  return new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();
}

/* 某个月的日历格子：固定 6 行 × 7 列（周一起始，与「回看」的自然周一致），
   前后补空格补到 42 格——**固定高度**是故意的：翻月时格子不会整体跳一下。
   每格 { ymd, d, inMonth, today, sel, past }
     inMonth 本月那几号（前后补的空格为 false，画淡一点）
     today 今天 / sel 等于传入的选中日 / past 早于今天（画淡，但仍可点）
   past 仍可点：改一条已经逾期的待办时，它的计划时间就在过去，得能原样看到、也能重挑一天。 */
function monthGrid(y, m, selYmd) {
  const lead = (new Date(y, m, 1).getDay() + 6) % 7;   // 1 号是周日 → 前面空 6 格
  const start = new Date(y, m, 1 - lead);
  const t = ymd(Date.now());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = ymd(d.getTime());
    cells.push({
      ymd: key,
      d: d.getDate(),
      inMonth: d.getMonth() === m && d.getFullYear() === y,
      today: key === t,
      sel: !!selYmd && key === selYmd,
      past: key < t
    });
  }
  return cells;
}

module.exports = { DAY, dayStart, agoOf, datePrefix, dayLabel, hhmm, fmtDur, ymd, parseYmd, monthGrid };
