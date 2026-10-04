// utils/themes.js —— 主题配色的「单一来源」
// 背景（可优化点 #6）：以前配色要在 app.wxss 的 `.theme-*` 和 store 的 THEMES 各写一份，
// 加/改主题容易漏。现在只在这里维护；各页根节点用 themeStyle(k) 拼出内联 CSS 变量注入即可。
//   themeList()   —— 参与「主题切换」循环的主题（on: true）
//   themeStyle(k) —— 拼成 `--bg:#fff;--accent:#...` 的内联 style
// 说明：--r-card / --r-btn / --r-in 由 .app 统一给，这里不重复。

const THEMES = [
  { k: 'mint', n: '薄荷', on: true, vars: {
    bg: '#FFFFFF', surface: '#FFFFFF', soft: '#F4F5F5', line: '#EDEDED', line2: '#E3E3E3',
    ink: '#22252A', ink2: '#4A4E54', ink3: '#8A8F94', ink4: '#AAB0B5',
    ring: '0 0 0 3px rgba(47,143,123,.12)',
    accent: '#2F8F7B', 'accent-soft': '#E6F4F0', danger: '#C0574F',
    'c-obs': '#4FA894', 'c-now': '#4E8FB5', 'c-want': '#C89A3C', 'c-nope': '#8A7BB0', 'c-done': '#5C86B8'
  } },
  { k: 'sand', n: '暖沙', on: true, vars: {
    bg: '#FAF8F4', surface: '#FFFFFF', soft: '#F5F2EA', line: '#EAE5DC', line2: '#E0DACF',
    ink: '#33322D', ink2: '#5A574F', ink3: '#8B8779', ink4: '#AAA598',
    ring: '0 0 0 3px rgba(124,154,134,.14)',
    accent: '#7C9A86', 'accent-soft': '#EDF3EE', danger: '#C0574F',
    'c-obs': '#7C9A86', 'c-now': '#5E9A94', 'c-want': '#C0A05A', 'c-nope': '#948AA8', 'c-done': '#6E8CB0'
  } },
  { k: 'olive', n: '橄榄', on: true, vars: {
    bg: '#F8FAF2', surface: '#FFFFFF', soft: '#EEF1E2', line: '#E0E5D2', line2: '#D0D7BD',
    ink: '#252A20', ink2: '#4A5240', ink3: '#7B8470', ink4: '#A6AE9B',
    ring: '0 0 0 3px rgba(110,123,61,.13)',
    accent: '#6E7B3D', 'accent-soft': '#EAF0DC', danger: '#B4544E',
    'c-obs': '#3E97A0', 'c-now': '#4E8FB5', 'c-want': '#C2934A', 'c-nope': '#8A7BB0', 'c-done': '#5C86B8'
  } },
  { k: 'teal', n: '湖青', on: true, vars: {
    bg: '#FFFFFF', surface: '#FFFFFF', soft: '#EFF5F6', line: '#E3EDEC', line2: '#D6E5E4',
    ink: '#20282A', ink2: '#465356', ink3: '#7F9092', ink4: '#A6B4B6',
    ring: '0 0 0 3px rgba(46,139,154,.13)',
    accent: '#2E8B9A', 'accent-soft': '#E6F3F5', danger: '#B4544E',
    'c-obs': '#3E97A0', 'c-now': '#4E8FB5', 'c-want': '#C2934A', 'c-nope': '#8A7BB0', 'c-done': '#5C86B8'
  } },
  { k: 'graph', n: '石墨', on: true, vars: {
    bg: '#FFFFFF', surface: '#FFFFFF', soft: '#F3F3F3', line: '#EBEBEB', line2: '#E0E0E0',
    ink: '#1F1F1F', ink2: '#4A4A4A', ink3: '#8A8A8A', ink4: '#AEAEAE',
    ring: '0 0 0 3px rgba(79,84,89,.12)',
    accent: '#4F5459', 'accent-soft': '#ECEEF0', danger: '#B4544E',
    'c-obs': '#5B7C6B', 'c-now': '#5A7A8C', 'c-want': '#A89055', 'c-nope': '#7A7290', 'c-done': '#5E7A96'
  } },
  { k: 'amber', n: '琥珀', on: true, vars: {
    bg: '#FFFCF5', surface: '#FFFFFF', soft: '#F8F1E2', line: '#F1E9D8', line2: '#E6DBC5',
    ink: '#2E2A22', ink2: '#57503F', ink3: '#897E66', ink4: '#B0A78E',
    ring: '0 0 0 3px rgba(201,138,43,.13)',
    accent: '#C98A2B', 'accent-soft': '#F8EFD9', danger: '#C0574F',
    'c-obs': '#3E97A0', 'c-now': '#4E8FB5', 'c-want': '#C2934A', 'c-nope': '#8A7BB0', 'c-done': '#5C86B8'
  } },
  { k: 'butter', n: '鹅黄', on: true, vars: {
    bg: '#FBF8EE', surface: '#FFFFFF', soft: '#F5F0DF', line: '#ECE5CF', line2: '#E0D6BC',
    ink: '#2E2A22', ink2: '#57503F', ink3: '#897E66', ink4: '#B0A78E',
    ring: '0 0 0 3px rgba(201,178,94,.12)',
    accent: '#C9B25E', 'accent-soft': '#F4EED7', danger: '#B4544E',
    'c-obs': '#3E97A0', 'c-now': '#4E8FB5', 'c-want': '#C2934A', 'c-nope': '#8A7BB0', 'c-done': '#5C86B8'
  } },
  { k: 'apricot', n: '暖阳', on: true, vars: {
    bg: '#FFF8F2', surface: '#FFFFFF', soft: '#FAEEE2', line: '#F2E4D7', line2: '#E7D6C5',
    ink: '#2F2621', ink2: '#57493D', ink3: '#8A7967', ink4: '#B2A392',
    ring: '0 0 0 3px rgba(214,138,90,.15)',
    accent: '#D68A5A', 'accent-soft': '#FAEBE1', danger: '#C0574F',
    'c-obs': '#84A878', 'c-now': '#6E9BB5', 'c-want': '#C89A55', 'c-nope': '#A98BAE', 'c-done': '#7E90B5'
  } },
  { k: 'peach', n: '蜜桃', on: true, vars: {
    bg: '#FFF7F6', surface: '#FFFFFF', soft: '#FBEEEB', line: '#F4E2DE', line2: '#EAD3CE',
    ink: '#302523', ink2: '#57443F', ink3: '#8B746E', ink4: '#B39D97',
    ring: '0 0 0 3px rgba(201,128,122,.15)',
    accent: '#C9807A', 'accent-soft': '#F9ECEA', danger: '#B4544E',
    'c-obs': '#7FA88C', 'c-now': '#6E9BB5', 'c-want': '#C89A55', 'c-nope': '#A98BB0', 'c-done': '#7E90B5'
  } },
  { k: 'latte', n: '奶茶', on: true, vars: {
    bg: '#FAF5EF', surface: '#FFFFFF', soft: '#F2EAE0', line: '#E8DFD2', line2: '#DCD0BE',
    ink: '#2C2620', ink2: '#544A3E', ink3: '#857A69', ink4: '#ADA292',
    ring: '0 0 0 3px rgba(169,129,99,.15)',
    accent: '#A98163', 'accent-soft': '#F1E7DC', danger: '#B4544E',
    'c-obs': '#7FA88C', 'c-now': '#6E9BB5', 'c-want': '#C2934A', 'c-nope': '#A98BB0', 'c-done': '#7E90B5'
  } },

  // —— 以下为未启用的备选配色：保留配色，不出现在切换循环里 ——
  { k: 'mist', n: '雾蓝', vars: {
    bg: '#F6F8FA', surface: '#FFFFFF', soft: '#EEF1F5', line: '#E3E8EE', line2: '#D8DEE6',
    ink: '#26292E', ink2: '#4C525A', ink3: '#7C848F', ink4: '#A2A9B2',
    ring: '0 0 0 3px rgba(62,124,177,.13)',
    accent: '#3E7CB1', 'accent-soft': '#E8F0F8', danger: '#B4544E',
    'c-obs': '#4A85B5', 'c-now': '#5E9AA8', 'c-want': '#C2935A', 'c-nope': '#8B84AC', 'c-done': '#5E86B2'
  } },
  { k: 'lav', n: '薰衣', vars: {
    bg: '#F8F7FB', surface: '#FFFFFF', soft: '#F1EEF8', line: '#E7E3F0', line2: '#DBD5E8',
    ink: '#292632', ink2: '#4E4A5A', ink3: '#837E92', ink4: '#A8A3B5',
    ring: '0 0 0 3px rgba(124,107,168,.13)',
    accent: '#7C6BA8', 'accent-soft': '#EFEBF8', danger: '#B0504E',
    'c-obs': '#8A79B0', 'c-now': '#6B86B8', 'c-want': '#C0984A', 'c-nope': '#A87BA0', 'c-done': '#5E86B2'
  } },
  { k: 'bamboo', n: '竹青', vars: {
    bg: '#FFFFFF', surface: '#FFFFFF', soft: '#EAF4EF', line: '#D7EBE3', line2: '#C2DDD2',
    ink: '#1E2E29', ink2: '#416158', ink3: '#6E8A80', ink4: '#A1B8AF',
    ring: '0 0 0 3px rgba(62,158,124,.13)',
    accent: '#3E9E7C', 'accent-soft': '#E4F3EC', danger: '#B4544E',
    'c-obs': '#3E97A0', 'c-now': '#4E8FB5', 'c-want': '#C2934A', 'c-nope': '#8A7BB0', 'c-done': '#5C86B8'
  } },
  { k: 'fog', n: '雾灰', vars: {
    bg: '#F7F8F9', surface: '#FFFFFF', soft: '#EEF0F2', line: '#E2E5E8', line2: '#D4D8DC',
    ink: '#23282C', ink2: '#495059', ink3: '#7C838B', ink4: '#A6ABB1',
    ring: '0 0 0 3px rgba(110,117,123,.12)',
    accent: '#6E757B', 'accent-soft': '#ECEEF0', danger: '#B4544E',
    'c-obs': '#3E97A0', 'c-now': '#4E8FB5', 'c-want': '#C2934A', 'c-nope': '#8A7BB0', 'c-done': '#5C86B8'
  } },
  { k: 'lilac', n: '浅紫', vars: {
    bg: '#F7F5FC', surface: '#FFFFFF', soft: '#EFEBF6', line: '#E4DEF0', line2: '#D6CEE6',
    ink: '#262230', ink2: '#4C455A', ink3: '#847B96', ink4: '#AAA1BC',
    ring: '0 0 0 3px rgba(154,139,192,.12)',
    accent: '#9A8BC0', 'accent-soft': '#ECE6F4', danger: '#B4544E',
    'c-obs': '#3E97A0', 'c-now': '#4E8FB5', 'c-want': '#C2934A', 'c-nope': '#8A7BB0', 'c-done': '#5C86B8'
  } }
];

// 参与切换循环的主题（默认主题取第一个）
function themeList() { return THEMES.filter(t => t.on); }

// 取某主题的完整配置（找不到回落第一个）
function themeOf(k) { return THEMES.find(t => t.k === k) || THEMES[0]; }

// 拼成内联 style：`--bg:#fff;--accent:#2F8F7B;...`
function themeStyle(k) {
  const v = themeOf(k).vars || {};
  return Object.keys(v).map(name => '--' + name + ':' + v[name]).join(';');
}

// 主题的主色（切换器圆点用；直接读变量定义，避免再依赖单列字段）
function themeAccent(k) { return (themeOf(k).vars || {}).accent || ''; }

module.exports = { THEMES, themeList, themeOf, themeStyle, themeAccent };
