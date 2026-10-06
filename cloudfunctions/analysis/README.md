# 云函数 `analysis` 使用与测试说明

> 一句话：这是「识己手札」**唯一**的云函数，负责 AI 回看（日 / 周 / 月 / 年）与个人画像的生成、读取和诊断。
> 它的所有能力都通过 `event.action` 分发；本文档就是把每个 action 的**控制台测试模板**、参数、返回和排错写全，
> 改代码时**必须同步更新本文档**（见文末「更新约定」）。

代码位置：`cloudfunctions/analysis/index.js`
配置文件：`cloudfunctions/analysis/config.json`（定时触发器 + 非密钥环境变量）

---

## 一、入口一览

云函数 `exports.main` 收到 `event` 后按 `action` 分发，**没有 action 也区分两种情况**：

| 触发方式 | 判定条件 | 行为 |
| --- | --- | --- |
| **定时触发器** | 拿不到用户 openid（`cloud.getWXContext().OPENID` 为空） | 遍历所有有记录的用户：先补「昨天」的日回看，再逐人补齐历史周 / 月 / 年 |
| **客户端调用** | 有 openid（小程序内 `wx.cloud.callFunction`）且 `action` 可识别 | 执行对应 action |
| **手动测试** | 有 openid 但 `action` 为空 / 不认识 | 返回 `{ok:false, hint:…}`，**什么都不做** |

⚠️ 定时器触发**没有用户上下文**，所以云函数内部用 `records.aggregate().group({_id:'$_openid'})` 反查所有用户。
这也是为什么「有 openid 但没 action」必须提前拦下来——否则手动测一次就会给**所有用户**补齐一遍历史。

### action 总表

| action | 谁在用 | 需要 openid | 调大模型 | 写库 | 一句话说明 |
| --- | --- | --- | --- | --- | --- |
| `list` | 小程序（回看页 / AI 回看页） | 是 | 否 | 否 | 读当前用户已有的回看列表（按 `date` 倒序，最多 120 条） |
| `gen` | 小程序 + 控制台 | 是 | **是** | 是 | 生成**一份**指定周期的回看 |
| `backfill` | 控制台（排查 / 补历史） | 是 | **是** | 是 | 给当前用户补齐最近 12 周 / 12 月 / 5 年的回看 |
| `stats` | 控制台（诊断） | 是 | 否 | 否 | 诊断：记录时间分布 + 「该补齐哪些周期」 |
| `promptPreview` | 控制台（诊断） | 是 | 否 | 否 | 只读预览「大模型实际看到的资料」，不调模型不写库 |
| `profileGet` | 小程序（进页先调） | 是 | 否 | 否 | 读已存画像（秒回，不花额度） |
| `profile` | 小程序（生成按钮）+ 控制台 | 是 | **是** | 是 | 按**全部历史记录**生成/ 覆盖个人画像（七章报告） |

> `list` / `profileGet` 不花大模型额度，可以随便点。
> `gen` / `backfill` / `profile` 每次真正调用大模型都算一次额度，见「额度与幂等」。

---

## 二、控制台测试模板（可直接复制）

**在哪测**：微信开发者工具 → 云开发 → 云函数 → `analysis` → 「测试」。
控制台测试**没有用户身份**，所以除了纯诊断的用法，**必须自己带上 `openid`**：

> 从 `records` 集合随便打开一条文档，复制它的 `_openid` 字段（形如 `o6xxxxxxxxxxxxxxxxxxxx`）。

### 0. 冒烟：先确认代码是活的（不带 action）

```json
{}
```

预期返回：

```json
{ "ok": false, "hint": "无 action；生成用 action:gen / backfill，列表用 action:list" }
```

看到这句话 = 云函数部署成功、代码是新版。**什么都返回不了（`ret=-3`）** 见文末排错表。

---

### 1. `stats` —— 诊断：我有哪些数据、该补哪些回看

```json
{ "action": "stats", "openid": "你的openid" }
```

返回：

| 字段 | 含义 |
| --- | --- |
| `total` | 该 openid 下带时间的记录总条数 |
| `first` / `last` | 最早 / 最晚记录日期（`YYYY-MM-DD`） |
| `perDay` | 按天条数 `{ "2026-10-05": 12, ... }` |
| `backfillShouldGenerate` | 过去 12 周 / 12 月 / 5 年里**有记录**的周期清单 `{type, range, n}` |

**怎么用它判 bug**：`backfill` 应该**刚好**生成 `backfillShouldGenerate` 里列的那些周期。
如果 stats 里有、backfill 却没生成，那才是真 bug（通常是那批记录没被读到）。

---

### 2. `promptPreview` —— 诊断：到底把什么喂给了模型

```json
{ "action": "promptPreview", "type": "profile", "openid": "你的openid" }
```

`type` 可选：`profile`（默认）/ `day` / `week` / `month` / `year`。

返回：

| 字段 | 含义 |
| --- | --- |
| `records` | 喂进去的记录条数（画像最多取 500 条） |
| `reviewsUsed` | 联动用了几份历史回看（画像最多 24 份） |
| `userChars` / `systemChars` | user / system 消息的字数 |
| `userHead` | 拼给模型的资料原文（最多 4000 字） |
| `range` | 仅周期类型有：`起~止` 日期 |

原始记录会被加工成这种格式再拼进去（不是裸字段）：

```
[觉察] 加班 （喜恶：喜欢，精力：耗尽） 22:10
[随记] 突然想到一个产品点子 2026-09-30 08:30
```

`2026-09-30` 只在与起始日不同时才标注；时间只到分钟。

> 这个 action **不调模型、不写库、不花额度**，随便跑。

---

### 3. `gen` —— 生成一份指定周期的回看

日回看（`offset` 是「往前推几天」，**必须 ≥ 1**，不能生成未来）：

```json
{ "action": "gen", "type": "day", "offset": 1, "openid": "你的openid" }
```

周 / 月 / 年（取**最近一个已完整结束**的周期，不必等到周日 / 月末 / 12-31）：

```json
{ "action": "gen", "type": "week", "openid": "你的openid" }
{ "action": "gen", "type": "month", "openid": "你的openid" }
{ "action": "gen", "type": "year", "openid": "你的openid" }
```

| 返回 | 含义 |
| --- | --- |
| `{ ok:true, key:"day:2026-10-05" }` | 生成成功，已写入 `analysis` |
| `{ skipped:true, key:… }` | 该周期**已生成过**（幂等跳过），想重做请先删旧文档 |
| `{ skipped:true, empty:true, key:… }` | 该周期**没有记录**，不生成也不留空卡 |
| `{ skipped:true, deferred:true, key:… }` | 本次调用额度用完了，用 `backfill` 并调大 `maxGen` |
| `{ error:"不能生成未来的回看（day 的 offset 需 ≥ 1）" }` | offset 传了 0 或负数 |

---

### 4. `backfill` —— 补齐历史周 / 月 / 年

```json
{ "action": "backfill", "openid": "你的openid" }
```

返回：`{ "backfill": true, "done": 3, "skipped": 21, "err": 0 }`
（`done`= 真生成了几条，`skipped` = 已存在 / 没记录 / 没额度，`err` = 报错条数）

一次默认最多真生成 **30** 条，扫不完的放宽上限：

```json
{ "action": "backfill", "maxGen": 50, "openid": "你的openid" }
```

⚠️ 上限越大越容易撞云函数 **60s超时**。宁可分两次跑。

---

### 5. `list` —— 读已有回看列表

```json
{ "action": "list", "openid": "你的openid" }
```

返回 `{ "list": [ …回看文档… ] }`，按 `date` 倒序，最多 120 条。
小程序里这个 action **不带 openid**（云函数自己从上下文取）。

---

### 6. `profile` —— 生成个人画像（七章报告）

```json
{ "action": "profile", "openid": "你的openid" }
```

绕过「一个自然周只能生成一次」的冷却（⚠️ **仅供排查**，会真花额度）：

```json
{ "action": "profile", "force": true, "openid": "你的openid" }
```

| 返回 | 含义 |
| --- | --- |
| `{ ok:true, _id:"…", summary:"…", basic:{…}, core:{…}, … }` | 生成成功，已 upsert 到 `profile` |
| `{ cooling:true, retryAfter:1759…, updatedAt:1750… }` | 本自然周（周一 00:00 起）生成过，锁定到下周一 00:00；加 `force:true` 可绕过 |
| `{ empty:true, summary:"还没有记录…" }` | 该用户一条记录都没有，先去「记」里留几条 |

`retryAfter` / `updatedAt` 是毫秒时间戳。

**冷却规则**：判定用「上次生成时间是否落在**当前这一自然周**内」（周一 00:00 按中国时区起算），
**不是**滚动 7×24 小时——这样「周一零点后立刻可以再生成」符合直觉。
拦截点在云函数 `generateProfile` 里，前端只负责把按钮置灰。

---

### 7. `profileGet` —— 读已存画像

```json
{ "action": "profileGet", "openid": "你的openid" }
```

返回 `{ "profile": { …七章报告… } }`；还没生成过时 `profile` 为 `null`。

---

### 8. 定时任务（无 action、无 openid）

控制台**不要**直接测这条分支（手动测需要放开 openid 判断）。
定时器配在 `config.json`：`0 0 17 * * * *` = UTC 17:00 = **中国 01:00**。
返回形如：

```json
{ "trigger": true, "day": "2026-10-05", "users": 4, "done": 6, "skipped": 31, "err": 0 }
```

`trigger: true` 说明走的是定时分支（而不是被某个 action 拦下了）。

---

## 三、配置

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `LLM_API_KEY` | ✅ **必填** | — | 大模型密钥。**只能在控制台配**（云函数 → 配置 → 环境变量），绝不写进代码 |
| `LLM_BASE_URL` | 否 | `https://open.bigmodel.cn/api/paas/v4`（智谱） | 接口 **base**，不含 `/chat/completions`，代码自动拼。换厂商改这里 |
| `LLM_MODEL` | 否 | `glm-4-flash` | 模型名。默认智谱 GLM-4-Flash（免费、中文强、OpenAI 兼容） |

换厂商示例：

|厂商 | `LLM_BASE_URL` | `LLM_MODEL` |
| --- | --- | --- |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |

### 其它必须配对的地方

- **执行超时改60s**：云函数 → 配置 → 超时时间。默认 3s 一定会让每次调用都失败。
- **依赖**：必须「上传并部署（**云端安装依赖**）」，`package.json` 里是 `wx-server-sdk`。

### 集合要求

| 集合 | 权限 | 说明 |
| --- | --- | --- |
| `records` | 仅创建者可读写 | 原始记录，云函数按 `_openid` 读取 |
| `analysis` | 仅创建者可读写 | 回看文档（day / week / month / year） |
| `profile` | 仅创建者可读写 | 个人画像，**每 openid 只保留最新一份** |

`profile` 不存在会报 `-502005`；云函数首次用到时会自动创建，所以**手动建或不管都行**。
（集合是**整个云环境共享**的，不是每个用户各有一份——用户靠文档里的 `openid` 字段区分。）

### 部署后必做

1. 等 **1~2 分钟**（云端重建实例有瞬时 `ret=-3`，不是代码问题）。
2. 先跑 `{}` 冒烟，再跑 `{"action":"promptPreview","openid":"…"}` 确认能读到数据。
3. 最后跑 `{"action":"gen","type":"day","offset":1,"openid":"…"}` 验证大模型链路。

---

## 四、额度与幂等

### 幂等键

| 类型 | 判重键 |
| --- | --- |
| `day` | `openid + date` |
| `week` / `month` / `year` | `openid + type + start` |
| `profile` | `openid`（存在即覆盖更新） |

已存在就跳过，所以定时器偶尔重跑不会叠两份。
⚠️ **换了提示词想看新效果，必须先删掉对应周期的旧文档**，否则永远跳过。

### 生成额度

- 每次调用重置预算：`MAX_GEN_PER_RUN = 15`；`event.maxGen` 可覆盖（`backfill` 就是靠它放宽）。
- 大模型一次要几秒到十几秒，60s 内最多做十来次；补不完的由**下一次定时接着补**，不会丢。
- 额度用尽时相关周期返回 `skipped:true, deferred:true`，**不算错误**。

### 保护规则

- **未来 / 进行中的周期一律不生成**（`p.end > Date.now()` 直接跳过）。
- 补齐只往回扫：周12、月 12、年 5。
- 期间没记录 → 不生成、不留空卡。

---

## 五、返回结构

### `analysis` 集合（回看文档）

新结构（六板，`type` 为 `day/week/month/year`）：

```js
{
  openid, type, date, start, end,
  summary:  '……',                // 核心课题总结（一句话）
  facts:    ['……'],              // 客观事实
  patterns: {
    drain:    ['……'],            // 高频消耗场景
    charge:   ['……'],            // 稳定充电方式
    moodRule: '……',              // 情绪规律
    stuck:    ['……'],            // 惯性卡点
    values:   ['……']             // 长期价值偏好（仅年度有内容）
  },
  compare: '……',                 // 变化对比
  risks:   ['……'],               // 风险预警
  actions: ['动作｜执行时机｜目标｜自检指标'],  // 优先行动（日≤2条，周年≤3条）
  model, createdAt
}
```

旧字段 `themes` / `mood` / `highlight` / `insight` / `detail` **并存**：历史文档按旧字段照常显示；
`detail` 为空时用六板内容兜底拼一段，保证任何文档都有可读正文。

### `profile` 集合（七章报告）

```js
{
  openid, summary, updatedAt, model, n,
  basic:    { info, energy, decision, body, finance, env },        // 一、基础画像
  core:     { strengths, downsides, conflicts },                   // 二、核心盘点
  fit:      { workFirst, workCareful, workAvoid, life, risks },   // 三、适配方向
  future:   { neutral, optimistic, cautious },                     // 四、未来推演
  action:   { quick, rules, metrics },                             // 五、实操方案
  decision: { rhythm, framework, trial },                          // 六、决策辅助
  conclusion: '……'                                                 // 七、总结
}
```

**所有字段保证是字符串或字符串数组**，不会出现 `[object Object]`：
模型偶尔会把字符串字段返回成对象，落库前统一用 `flatText()` 递归摊平（对象 → `键：值；键：值`，数组用 `；` 连接），
前端渲染时再兜一层。早期版本已写入 `[object Object]` 的文档内容不可还原，**只能重新生成**。

---

## 六、排错速查表

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `ret=-3 [UPSTREAM] system error` | 部署后云端重建实例的**瞬时**错误 | 等 1~2 分钟重试；持续则重新「上传并部署」再等一两分钟 |
| 返回内容为空 / `-502005` | 集合 `profile` 不存在 | 云函数会自动创建；也可在控制台手动新建，权限「仅创建者可读写」 |
| `LLM API_KEY 未配置` | 没配环境变量 | 云函数 → 配置 → 环境变量加 `LLM_API_KEY` |
| `LLM HTTP 401 / 4xx` | key 失效或`LLM_BASE_URL` 填错 | 核对环境变量；`LLM_BASE_URL` 只填 base，不带 `/chat/completions` |
| `LLM HTTP 429` | 免费额度用完 / 限流 | 换模型或等限流恢复；画像一周一次即可，别反复点 |
| `3s` 超时 | 超时时间没改 | 执行超时改成 60s |
| `无法从返回内容解析出 JSON` | 模型输出不纯 | 先看日志里的原文；提示词已要求严格 JSON，偶发可重试 |
| 页面出现 `[object Object]` | 早期生成时写进了脏数据 | 重新点一次「生成个人画像」 |
| 页面出现 `�`（替换字符，文字被咬掉一块） | 旧版本逐片解码 HTTP 响应，一个汉字的 3 字节被网络分片切开时损坏（已修） | 重新生成即可；已生成的旧文档不会自动变干净 |
| 展开后某条内容和卡片头那句话一模一样，或同一件事出现两次 | 模型把`summary` 复读进了 `facts`，或给同一件事套两个标签各说一次（已修） | 重新生成即可；**修复只在生成侧**，已生成的旧文档仍带重复，需删掉对应周期的 `analysis` 文档后重跑 |
| 生成的内容「很干」 | 提示词效果问题 | 删掉 `analysis` 里对应周期的旧文档再重跑（幂等会跳过已存在的） |
| `cooling: true` | 本自然周已生成过画像 | 等到下周一 00:00（控制台可加 `force:true` 绕过） |
| `deferred: true` | 单次生成额度用完 | 用 `backfill` + `"maxGen": 50` 放宽，或等下一次定时 |
| 定时任务 `users: 0` | `records` 里没有带`_openid` 的文档 | 确认记录确实写进了云数据库 |

---

## 七、更新约定

**每次改动 `cloudfunctions/analysis/index.js` 之后，必须同步做这三件事：**

1. **更新本文档**：新增/改名 action → 在「action 总表」加一行；改参数 → 改对应模板的表格；
   改默认额度 / 扫描深度 / 超时 → 改「额度与幂等」；改集合字段 → 改「返回结构」。
2. **在文末「变更记录」追加一行**（日期倒序，写清改了什么、为什么）。
3. **跑一遍自查**：

   ```bash
   node --check cloudfunctions/analysis/index.js
   python3 tools/check-syntax.py
   ```

`tools/check-syntax.py` 里有一条**文档同步检查**：它会扫出云函数代码里出现的所有 `action` 字符串，
逐个到本文档里查；查不到就报错退出码 1。**加了 action 却忘了写文档，跑一次自查就会拦下来。**

同时建议在 `utils/changelog.js` 追加一条面向用户的更新说明（用户看到的是「设置 → 更新日志」）。

---

## 八、变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-06 | 新建本文档：把散落在 README 与代码注释里的测试模板、参数、返回、额度、幂等、排错整理成一份；补上 `promptPreview` / `profileGet` / `force` 等此前只在README 一句话里带过的用法；给 `tools/check-syntax.py` 加了「action 必须在本文档里有模板」的同步检查。 |
| 2026-10-06 | 修「页面出现 `�`」：读大模型响应时没 `res.setEncoding('utf8')`，`buf += c` 会对**每个网络分片**各做一次 utf8 解码，而一个汉字 3 字节，一旦被分片切开就解码成替换字符（画像总结里「调整」变成「调��」）。改为 `setEncoding('utf8')`，由 StringDecoder 跨片保留不完整字节序列。**注意：修的是「新生成的内容」，已落库的旧文档里的坏字符不会自动修复，需重新生成。** |
| 2026-10-06 | 修「内容重复」：模型常把卡片头那句 `summary` 原样复读进 `facts` 第一条（折叠看一句、展开第一行又是同一句），也爱给同一件事套两个标签各说一次（「整体状态：各项数据都比一般日常记录都低」与「感觉疲惫：各项数据都比一般日常记录都低」）。两道处理：① 提示词加硬要求（summary 不许进 facts、板块间不许复读）；② 落库前 `dedupe()` 兜底——归一化（去标点空白与「整体状态 / 感觉疲惫」这类标签前缀）后判重，同句或一方为另一方子串即去掉，数组内部也去重，**保序**、只做保守判定以免误删真正不同的内容。同步把落库的 `clean` 从 `String(v)` 换成 `flatText(v)`（顺带堵住回看文档里可能出现的 `[object Object]`）。**修复只在生成侧**，已生成的旧文档仍带重复，需删掉对应周期的 `analysis` 文档后重跑。 |