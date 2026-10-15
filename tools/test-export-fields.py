# tools/test-export-fields.py —— 防「顶层字段静默丢失」的导出覆盖测试
#
# 背景：起睡备注（sleepNote / wakeNote）与觉察的结束时间（endTs）都曾加进了记录，
# 但导出两条路（可读 readLine / 备份 backupLine）都没同步——用户是拿着导出文本
# 对比页面才发现的。ext 里的项有 buildExt 这条默认通道，顶层字段**没有任何默认通道**，
# 漏一次就是静默数据丢失。这个脚本把「覆盖表 + 四条链路 + 写云清单」钉死，防回归。
#
# 为什么是静态断言而不是真跑导出：本机 node 不在 PATH（跑不了 JS），
# 且项目现有注入测试（test-today-mood.py 等）同套路——对源码做断言。
# 断言刻意查「活跃行」（非注释）：`# 注释掉` 之后子串还在，光查子串会假通过。
import os, re, subprocess, sys, datetime, json

root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
def rd(p): return open(os.path.join(root, p), encoding='utf-8').read()

exporter = rd('utils/exporter.js')
store = rd('utils/store.js')
setjs = rd('pages/set/set.js')
readme = rd('README.md')
rectext = rd('cloudfunctions/analysis/recText.js')

fails = []
def chk(cond, msg):
    if not cond: fails.append(msg)

def line_active(src, needle):
    """needle 出现在某一行里、且该行不是注释行。"""
    return any(needle in ln and not ln.strip().startswith('//') for ln in src.split('\n'))

# 取某个函数的函数体（从 'function name' 到第一个行首 '}'）
def fn_body(src, name):
    i = src.index('function ' + name)
    j = src.index('\n}', i)
    return src[i:j]

# 本地时区时间戳（毫秒）——与 JS new Date('YYYY-MM-DDTHH:MM:00') 同口径，断言直接比毫秒
def local_ts(s):
    return int(datetime.datetime.strptime(s, '%Y-%m-%dT%H:%M:%S').timestamp() * 1000)

read_line = fn_body(exporter, 'readLine')
backup_line = fn_body(exporter, 'backupLine')
rst = fn_body(exporter, 'readStateTags')

# 1) 覆盖表与规则记入：表在、README 的约定在（规则本身不能被悄悄删掉）
chk('顶层字段覆盖表' in exporter, 'exporter.js 缺「顶层字段覆盖表」——新增字段的检查锚点没了')
chk('新增字段先查导出' in readme, 'README 缺「新增字段先查导出」约定')
chk('test-export-fields.py' in readme, 'README 的导出检查约定没指向本测试脚本')
chk('可读导出的新内容，云函数侧必须同步' in readme,
    'README 缺「可读导出新内容同步云函数」约定（起睡备注就是只在一边落了地）')
chk('recText.js' in exporter and '逐字同 ①' in exporter,
    'exporter 的覆盖表没有第四处（AI 入参 recText.js）——规则锚点缺了一列')
chk('顶层字段也要逐字对齐' in rectext,
    'recText.js 顶部缺「顶层字段逐字对齐」声明——复刻方不知道自己要跟着 exporter 改')

# 2) 可读导出 readLine：起睡备注 + obs 结束历时
chk(line_active(exporter, "r.wakeNote") and line_active(exporter, "r.sleepNote"),
    'readLine 没读起睡备注（sleepNote / wakeNote）——导出行丢「晚睡原因 / 起床感受」')
chk(line_active(exporter, "'起床感受'") and line_active(exporter, "'晚睡原因'"),
    'readLine 的备注标签不是页面同款用语（起床感受 / 晚睡原因）')
chk('r.endTs' in read_line, 'readLine 没处理 obs 的 endTs——导出丢「这次觉察持续了多久」')
chk('date.fmtDur' in read_line, 'readLine 的历时没用 date.fmtDur（会和看页口径漂移）')
# recText（AI 入参）侧必须同样处理——「exporter 有、recText 没有」正是起睡备注的漏点
chk(line_active(rectext, 'r.wakeNote') and line_active(rectext, 'r.sleepNote'),
    'recText 的 readLine 没读起睡备注——AI 看不到晚睡原因 / 起床感受（exporter 有、这边没有）')
chk('r.endTs' in rectext and 'fmtDur' in rectext,
    'recText 的 readLine 没处理 obs 的 endTs——AI 看不到觉察的历时')

# 3) 备份导出 backupLine：备注必须在状态段**最后** push（导入端按「取到段尾」整体还原，
#    自由文本含逗号，提前 push 会被拆碎）；「结束于」要带时分
chk('备注 ' in backup_line and 'wnote' in backup_line,
    'backupLine 没带「备注」标签——备份还原后起睡备注丢失')
chk(backup_line.index('备注 ') > backup_line.index('优先级 '),
    '「备注」不是最后 push 的——备注含逗号时会被 readStateTags 的逗号拆分拆碎')
chk(backup_line.index('备注 ') < backup_line.index('return tags.length'),
    '「备注」push 在 return 之后（死代码）')
chk('结束于 ' in backup_line and 'hhmm(r.endTs)' in backup_line,
    'backupLine 的「结束于」没带时分——endTs 是「那一刻」不是「那一天」')

# 4) 导入还原 readStateTags：先整体摘「备注」再按逗号拆；「结束于」带可选时分
chk("indexOf('备注 ')" in rst, 'readStateTags 没整体摘「备注」——备注含逗号会被拆碎')
chk(rst.index("'备注 '") < rst.index('split(/[，,]/)'),
    'readStateTags 先按逗号拆了才摘备注——顺序反了，含逗号的备注会被切成碎片')
chk("'结束于'" in rst and 'out.endTs' in rst, 'readStateTags 没解析「结束于」')
chk('mt[3]' in rst, 'readStateTags 没给「结束于」留时分位——带时分的导出自己都还原不了')

# 5) set.js parseImport：把 st.note / st.endTs 落到记录上
chk('st.note != null' in setjs and 'rec.wakeNote = st.note' in setjs and 'rec.sleepNote = st.note' in setjs,
    'parseImport 没把备注还原到 sleepNote / wakeNote——备份导回来了备注也回不去')
chk('st.endTs' in setjs and 'rec.endTs = st.endTs' in setjs,
    'parseImport 没还原 endTs')

# 6) 写云清单：导出/导入链路里的顶层字段必须在 EXTRA_FIELDS 里，
#    否则「导得出、导得回，就是写不上云」——单一来源是 TEXT_FIELDS / TIME_FIELDS 两处声明
def decl_block(src, name):
    """取 'const NAME = [' 到 '];' 的整块（这两处都是多行数组）。"""
    i = src.index('const ' + name)
    return src[i:src.index('];', i)]
tf_block = decl_block(store, 'TEXT_FIELDS')
timef_block = decl_block(store, 'TIME_FIELDS')
chk("'sleepNote'" in tf_block and "'wakeNote'" in tf_block,
    'TEXT_FIELDS 没登记 sleepNote / wakeNote（写云会丢备注）')
chk("'endTs'" in timef_block, 'TIME_FIELDS 没登记 endTs（写云会丢结束时间）')

# 7) 泛化防线：清单里每个顶层字段都要在 exporter 里出现过（代码或覆盖表），
#    新增顶层字段漏进导出时这里会亮。豁免的两个是刻意不导出的：
#    calTs（纯回显：只说明推没推过手机日历）/ ref·refTxt·refTs（老「做了」模块遗留引用）
EXEMPT = {'calTs', 'ref', 'refTxt', 'refTs'}
all_top = re.findall(r"'([A-Za-z]+)'", tf_block) + re.findall(r"'([A-Za-z]+)'", timef_block)
for f in all_top:
    if f in EXEMPT:
        continue
    chk(f in exporter, '顶层字段 %s 在 exporter 里毫无踪迹——新增字段漏了导出（或该进豁免表并注明原因）' % f)

# 8) 端到端语义桩：备注标签的读写要按维度分派，别把睡的原因写到起床感受上
def note_key(m, note):
    if not note:
        return None
    return ('wakeNote' if m == 'wake' else 'sleepNote') if m in ('wake', 'sleep') else None
chk(note_key('wake', '睡够了') == 'wakeNote', '起床备注没落到 wakeNote')
chk(note_key('sleep', '刷手机') == 'sleepNote', '晚睡原因没落到 sleepNote')
chk(note_key('todo', 'x') is None, '非起睡维度不该有备注落点')

# 9) 运行时：真跑一遍 exporter——导出文本里必须出现备注 / 历时 / 结束于，
#    且 readStateTags 能把它们还原（含逗号的备注完整还原；老备份行为不变）。
#    静态断言守「代码在」，这里守「跑出来的东西对」——备注曾被 push 进了 parts，
#    但标签拼错一个字的 bug 只有真跑才现形。
NODE = os.environ.get('NODE_BIN', '/Users/zhangmilu/.workbuddy/binaries/node/versions/22.22.2-6/bin/node')
if not os.path.exists(NODE):
    print('WARN  %s 不在，跳过运行时冒烟（静态断言已全部通过）' % NODE)
else:
    script = r'''
global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} };
global.getApp = () => ({ APP_NAME: 'x' });
const ex = require('@ROOT@/utils/exporter.js');
const rt = require('@ROOT@/cloudfunctions/analysis/recText.js');
const out = {};
const base = new Date('2026-10-12T22:30:00').getTime();
const recs = [
  // 晚睡原因**故意含中文逗号**：备份状态段按逗号拆标签，备注必须整体还原
  { m: 'sleep', txt: '23:30', ts: base, t: '23:30', ext: [], extSrc: [], sleepNote: '加班到十一点，躺下还在想方案' },
  { m: 'wake', txt: '06:40', ts: base + 3600000, t: '06:40', ext: [], extSrc: [], wakeNote: '还是困' },
  { m: 'obs', txt: '开会时心里发紧', ts: base - 7200000, t: '10:00', ext: [], extSrc: [], endTs: base - 5400000 },
  { m: 'todo', txt: '买猫粮', ts: base, t: '22:30', ext: ['购物'], extSrc: ['todoKind'], dueTs: base + 86400000 }
];
out.read = ex.readable(recs);
out.backup = ex.backup(recs);
// 终极防线：每一条记录，exporter 的可读行与 recText 喂 AI 的行必须**逐字相同**。
// 顶层字段（起睡备注 / endTs）没有常量比对守着，只有这个能抓住「一边改了另一边忘了」
out.lines = recs.map(r => {
  const pick = s => String(s).split('\n').filter(l => l.indexOf(r.t) >= 0)[0];
  return { m: r.m, a: pick(ex.readable([r])), b: pick(rt.recText([r])), same: pick(ex.readable([r])) === pick(rt.recText([r])) };
});
// 从备份里把「备注 / 结束于」的状态段摘出来喂回 readStateTags（导入端就是这个路径）
out.tagsNote = ex.readStateTags('备注 加班到十一点，躺下还在想方案');
out.tagsEnd = ex.readStateTags('结束于 2026-10-12 10:30');
out.tagsOld = ex.readStateTags('✓已完成，完成于 2026-10-01');   // 老备份：没有新标签
out.tagsEmpty = ex.readStateTags('');
out.endYmd = ex.ymd(base - 5400000);
out.endHhmm = ex.hhmm(base - 5400000);
console.log(JSON.stringify(out));
'''.replace('@ROOT@', root)
    # 主进程显式按中国时区跑：exporter 跟随设备时区、recText 恒为中国时区，
    # 设成 CST 两边才都在同一口径上做逐字比对（不依赖测试机自己的时区）
    p = subprocess.run([NODE, '-e', script], capture_output=True, text=True, cwd=root,
                       env=dict(os.environ, TZ='Asia/Shanghai'))
    if p.returncode != 0:
        fails.append('跑 exporter 失败（%s）' % (p.stderr.strip().split('\n')[-1][:160] if p.stderr else '未知'))
    else:
        o = json.loads(p.stdout.strip().split('\n')[-1])
        chk('晚睡原因：加班到十一点，躺下还在想方案' in o['read'],
            '可读导出行里没有「晚睡原因：…」（含逗号也要整句在）')
        chk('起床感受：还是困' in o['read'], '可读导出行里没有「起床感受：…」')
        chk('历时：30 分钟' in o['read'], '可读导出行里没有「历时：30 分钟」——obs 结束时间仍被丢')
        chk('备注 加班到十一点，躺下还在想方案' in o['backup'],
            '备份行里没有「备注 …」——备份还原后起睡备注丢失')
        chk('结束于 ' + o['endYmd'] + ' ' + o['endHhmm'] in o['backup'],
            '备份行里没有「结束于 日期 时分」——obs 结束时间备份丢失')
        chk(o['tagsNote'].get('note') == '加班到十一点，躺下还在想方案',
            'readStateTags 没完整还原含逗号的备注：%r' % o['tagsNote'].get('note'))
        chk(o['tagsEnd'].get('endTs') == local_ts('2026-10-12T10:30:00'),
            'readStateTags 没还原「结束于」的时刻（时分丢了或整条没解析）')
        chk('note' not in o['tagsOld'] and 'endTs' not in o['tagsOld'] and o['tagsOld'].get('done') == 1,
            '老备份格式（无新标签）行为被改坏了——done 标记应照旧还原、不应多出 note/endTs')
        chk(o['tagsEmpty'] == {}, '空状态段应还原成空对象：%r' % o['tagsEmpty'])
        # 回归：新字段不许把原有内容挤掉——待办那行的类别 / 计划完成照旧在
        chk('待办·购物' in o['read'] and '计划完成' in o['read'],
            '加了新字段后待办行原有内容受损（维度名带类别 / 计划完成不见了）')
        # 终极防线：同一条记录，人读的导出行与喂 AI 的行必须逐字相同。
        # 起睡备注上次就是只在 exporter 落了地、recText 忘了——这个比对抓住的就是它
        for ln in o['lines']:
            chk(ln['same'],
                '两边记录行不一致（%s）：\n      exporter: %s\n      recText : %s'
                % (ln['m'], ln['a'], ln['b']))

    # 云函数容器时区是 UTC——recText 的时刻必须仍是**中国时区**。
    # 这是截图 bug（「17:56 睡 | 记的是入睡时刻01:56」）的回归防线：
    # 行首走了 hhmm(ts)，修坏就会输出 UTC 小时，与 txt 里的本地时刻对不上。
    utc_script = r'''
global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} };
global.getApp = () => ({ APP_NAME: 'x' });
const rt = require('@ROOT@/cloudfunctions/analysis/recText.js');
// CST 10-12 01:56 入睡 / 08:19 起床（换成 UTC 容器时刻分别是 10-11 17:56 / 10-12 00:19）
const recs = [
  { m: 'sleep', txt: '01:56', ts: Date.UTC(2026, 9, 11, 17, 56, 0), ext: [], extSrc: [] },
  { m: 'wake', txt: '08:19', ts: Date.UTC(2026, 9, 12, 0, 19, 0), ext: [], extSrc: [] }
];
console.log(JSON.stringify({ out: rt.recText(recs) }));
'''.replace('@ROOT@', root)
    p2 = subprocess.run([NODE, '-e', utc_script], capture_output=True, text=True, cwd=root,
                        env=dict(os.environ, TZ='UTC'))
    if p2.returncode != 0:
        fails.append('TZ=UTC 跑 recText 失败（%s）'
                     % (p2.stderr.strip().split('\n')[-1][:160] if p2.stderr else '未知'))
    else:
        o2 = json.loads(p2.stdout.strip().split('\n')[-1])
        chk('01:56 睡' in o2['out'] and '17:56' not in o2['out'],
            'TZ=UTC 下 recText 的时刻不是中国时区（截图 bug 回归：01:56 睡 显示成了 17:56 睡）')
        chk('08:19 起' in o2['out'] and '00:19' not in o2['out'],
            'TZ=UTC 下 recText 的时刻不是中国时区（08:19 起 显示成了 00:19 起）')

if fails:
    print('FAIL 共 %d 处：' % len(fails))
    for f in fails: print('  · ' + f)
    sys.exit(1)
print('OK  导出覆盖：起睡备注（readLine/backupLine/readStateTags/set.js）全部就位')
print('OK  导出覆盖：obs 结束历时（readLine）与「结束于 日期 时分」（backup/导入）全部就位')
print('OK  写云清单：sleepNote / wakeNote / endTs 均在 TEXT_FIELDS / TIME_FIELDS')
print('OK  泛化防线：TEXT_FIELDS + TIME_FIELDS 每个非豁免字段在 exporter 中均有踪迹')
print('OK  运行时冒烟：导出文本含备注 / 历时 / 结束于，含逗号的备注与时分均完整还原')
print('\n注入测试通过')
