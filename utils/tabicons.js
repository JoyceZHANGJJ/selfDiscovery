// utils/tabicons.js —— 底部 tab 的 5 个图标（单一来源，现画、不依赖字体）
//
// 为什么不用字符（原来是 ✎ ☰ ◐ ◎ ⚙）：它们来自系统字体，字形本身的大小 / 粗细 / 空心实心
// 就不统一（◐ 天生比 ⚙ 小一圈、✎ 是实心块、◎ 是双线），底栏看着就是「五个图标大小不一」，
// 换机型或换系统字体还会再变一次。这里改成现画的 SVG：同一个 24×24 视框、同一条 1.8 描边、
// 同样的圆头圆角，视觉尺寸都收在约 17/24 的范围内。
//
// 颜色：<image> 里的 SVG 拿不到页面的 CSS 变量（没有 currentColor），所以生成时就把颜色
// 写进描边里——未选中取主题的 ink3、选中取 accent；主题一变由 custom-tab-bar 重新生成一对。
//
// 小程序没有 btoa，这里自带一个 base64 编码（内容全是 ASCII 的 URL 安全字符，按 charCode 编就够）。

const STROKE = 1.8;   // 五个图标共用——描边一粗一细就是「不统一」最显眼的那一半

// 视框、描边线帽/线接全部写死在这里，各图标只提供自己的路径
const OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"'
  + ' fill="none" stroke-linecap="round" stroke-linejoin="round"';

// 各图标的画法（c = 颜色，只有需要实心的那个用得上）。
// 共同约束：都画在 24×24 里、视觉范围约 17 个单位高（3.5 → 20.5），谁都不要顶到边
const BODY = {
  // 记：一支 45° 的笔（笔身 + 笔尖 + 笔箍那道短线）。
  // **先竖着画再整组转 45°**：直接在斜角上写坐标容易把笔身画窄，描边一挤就成了实心块；
  // 竖着写（宽 5.2、长 17）转过去，笔身的净空才够，与旁边的圆形视觉重量也相当
  write: () => '<g transform="rotate(45 12 12)">'
    + '<path d="M9.4 15.2V4.9a1.4 1.4 0 0 1 1.4-1.4h2.4a1.4 1.4 0 0 1 1.4 1.4v10.3L12 20.5z"/>'
    + '<path d="M9.4 7.2h5.2"/></g>',
  // 看：三行长短不一的横线（都从左边起）——一眼看出是「一列内容」；等长的 ≡ 更像菜单
  look: () => '<path d="M4.5 7h15M4.5 12h11M4.5 17h13"/>',
  // 作息：半明半暗的圆（右半实心）——原来 ◐ 的意思，重画成同一套粗细与外径
  rest: (c) => '<circle cx="12" cy="12" r="8.5"/>'
    + '<path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="' + c + '" stroke="none"/>',
  // 回看：同心圆（原来的 ◎）。外圈与「作息」那颗一样大，两个圆的大小差就够表达层级了
  review: () => '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.6"/>',
  // 设置：齿轮（Lucide 那枚，本来画满整个视框）。缩到与圆同大时描边会跟着变细，
  // 所以组内把 stroke-width 反着放大（2.09 × .86 ≈ 1.8）——五个图标笔画才一样粗
  set: () => '<g transform="translate(12 12) scale(.86) translate(-12 -12)" stroke-width="2.09">'
    + '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>'
    + '<circle cx="12" cy="12" r="3"/></g>'
};

// 与 wxss 里的兜底色一致（主题读不到时不至于画成黑色）
const DEF = { accent: '#7C9A86', ink3: '#8B8779' };

// 5 个图标的顺序 = 底部 tab 的顺序（记 / 看 / 作息 / 回看 / 设置）
const NAMES = ['write', 'look', 'rest', 'review', 'set'];

function svg(name, color) {
  const body = BODY[name] || BODY.look;
  return OPEN + ' stroke="' + color + '" stroke-width="' + STROKE + '">' + body(color) + '</svg>';
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const c1 = s.charCodeAt(i), c2 = s.charCodeAt(i + 1), c3 = s.charCodeAt(i + 2);
    const has2 = !isNaN(c2), has3 = !isNaN(c3);
    out += B64[c1 >> 2];
    out += B64[((c1 & 3) << 4) | (has2 ? c2 >> 4 : 0)];
    out += has2 ? B64[((c2 & 15) << 2) | (has3 ? c3 >> 6 : 0)] : '=';
    out += has3 ? B64[c3 & 63] : '=';
  }
  return out;
}

// 一个图标 + 一个颜色 → 可直接塞进 <image src> 的 data URI
function dataUri(name, color) { return 'data:image/svg+xml;base64,' + b64(svg(name, color || DEF.ink3)); }

// 一次算好 5 个图标的两种状态（选中 / 未选中），键就是 NAMES 里的名字
function iconsFor(accent, ink3) {
  const on = accent || DEF.accent, off = ink3 || DEF.ink3;
  const out = {};
  NAMES.forEach(n => { out[n] = { iconOn: dataUri(n, on), iconOff: dataUri(n, off) }; });
  return out;
}

module.exports = { NAMES, STROKE, DEF, svg, dataUri, iconsFor };
