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
| `promptTest` | 小程序（提示词试跑页）+ 控制台 | 是 | **是** | 是（只写 `promptlog`） | **调提示词用这个**：用真实记录跑一次，返回并落库结果，不碰 `analysis` / `profile` |
| `ptestList` | 小程序（试跑页） | 是 | 否 | 否 | 读试跑记录列表（摘要，按时间倒序 50 条） |
| `ptestGet` | 小程序（试跑页） | 是 | 否 | 否 | 读一条试跑的完整结果 |
| `ptestDel` | 小程序（试跑页） | 是 | 否 | 是（删一条） | 删掉一条试跑记录 |
| `profileGet` | 小程序（进页先调） | 是 | 否 | 否 | 读已存画像（秒回，不花额度） |
| `profile` | 小程序（生成按钮）+ 控制台 | 是 | **是** | 是 | 按**全部历史记录**生成/ 覆盖个人画像（七章报告） |
| `promptList` | 小程序（提示词管理页）+ 控制台 | 否 | 否 | 否 | 列出全部提示词槽位（分组 / rev / 是否被改过；**不含正文**） |
| `promptGet` | 小程序（提示词管理页） | 是 | 否 | 否 | 读一个槽位的正文 + 出厂值 + 只读的输出字段契约 |
| `promptSave` | 小程序（提示词管理页） | 是 | 否 | 否 | **保存提示词正文，立即生效**；自动给旧版留快照，rev 恒 +1 |
| `promptReset` | 小程序（提示词管理页） | 是 | 否 | 否 | 恢复出厂默认（也是一次正常保存，同样留快照） |
| `promptVersions` | 小程序（提示词管理页） | 是 | 否 | 否 | 某槽位的历史版本列表（摘要，不含正文） |
| `promptVersionGet` | 小程序（提示词管理页） | 是 | 否 | 否 | 取某个历史版本的正文 |
| `promptRevert` | 小程序（提示词管理页） | 是 | 否 | 否 | 切回某个历史版本（走一次正常保存，新 rev 恒 +1） |
| `promptAdopt` | 小程序（试跑页） | 是 | 否 | 否 | **把某次试跑用的正文设为线上生效**——试跑→线上的桥 |

> `list` / `profileGet` / `ptestList` / `ptestGet` / `promptPreview` 不花大模型额度，可以随便点。
> `gen` / `backfill` / `profile` / `promptTest` 每次真正调用大模型都算一次额度，见「额度与幂等」。
> `promptTest` 是唯一「调模型但**不写正式文档**」的 action——试跑错多少次都不影响线上回看与画像。
>
> **提示词注册表**（`promptList` / `promptGet` / `promptSave` / `promptReset` / `promptVersions` /
> `promptVersionGet` / `promptRevert` / `promptAdopt`）只读写 `promptset` 与 `promptsetver`，
> **不调大模型、不碰任何业务集合**，所以随便调、不花额度。
> 提示词正文现在存在数据库里，改完保存即生效，**不用再「改代码 + 上传部署」**。
> 详见「五、提示词注册表」。

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

### 8. `promptTest` —— **调提示词就靠它**（不改代码、不动线上数据）

改提示词原来的循环是「改代码 → 上传部署 → 生成 → 翻页面看」，一轮几分钟，一天试不了两次。
这个 action 把循环缩成「改一段文字 → 点一下 → 看结果」：用**真实记录**跑一次模型（和线上生成同一套拼装），
结果返回并落库到 `promptlog`，但**完全不碰 `analysis` / `profile`**——试跑错多少次都不影响线上内容。

**基线对照**（`rules` 留空＝跑线上那一版，用来和改动后的版本比）：

```json
{ "action": "promptTest", "type": "profile", "openid": "你的openid" }
```

**追加一段提示词试**（在线上那版后面追加，最常用）：

```json
{
  "action": "promptTest",
  "type": "day",
  "openid": "你的openid",
  "label": "试试要求给出具体时间点",
  "rules": "【硬性】actions 里的「执行时机」必须写出具体钟点（如 21:30），不要写「晚上」。"
}
```

**整段换掉、从头试一版**（`overrideRules` 为真时，规则段整个替换，只保留任务说明与输出结构）：

```json
{
  "action": "promptTest",
  "type": "profile",
  "overrideRules": true,
  "openid": "你的openid",
  "rules": "你是资深临床心理师。只做一件事：指出这个人最可能被自己忽视的一个行为模式，并给出证据。"
}
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `type` | 否 | `profile`（默认）/ `day` / `week` / `month` / `year` |
| `rules` | 否 | 追加到规则段末尾的提示词片段。**追加放在最后是有意的**——模型对system 末尾的指令更敏感，新规则压得住旧规则 |
| `overrideRules` | 否 | `true`＝规则段整个换掉，只保留任务说明与输出结构（从头试一版） |
| `label` | 否 | 备注（≤60 字），跟结果一起存下来，回头能对上「这结果是哪一版跑出来的」 |
| `offset` | 否 | 仅 `type:"day"`：往前推几天，默认 1，须 ≥1 |
| `temperature` | 否 | 缺省画像 0.7、回看 0.8（与线上一致） |

| 返回 | 含义 |
| --- | --- |
| `{ saved:true, _id:"…", records:…, ms:…, result:{…} }` | 跑通了，结果已存进 `promptlog` |
| `{ saved:false, saveError:"…", result:{…} }` | 模型跑通了但**落库失败**，`saveError` 是真实原因（不要只看它是不是集合不存在）；`result` 仍然可用，只是不进历史 |
| `{ error:"这个周期没有记录可试" }` | 该周期一条记录都没有，换个 `type` 或 `offset` |
| `{ error:"这个周期还没结束，不能试" }` | 未来的周期记录还不存在 |
| `{ error:"模型调用失败：…" }` | 见「排错速查表」 |

**要点**

- 结果里连**当时用的提示词原文**一起存了（`rules` / `overrideRules` / `temperature` / `systemChars`），
  所以不用另外记「这个结果是哪一版跑出来的」。
- 试跑**不受幂等保护**、也不受画像的自然周冷却限制——它压根不写正式文档，想跑多少次跑多少次（但每次都花额度）。
- 有 `records:0` / `empty` 语义的返回都带上了，`result` 是模型返回的**原始结构**，未做任何摊平，
  方便你看模型到底吐了什么形状（前端渲染时才做兜底）。

---

### 9. `ptestList` / `ptestGet` / `ptestDel` —— 试跑记录的读与删

```json
{ "action": "ptestList", "openid": "你的openid" }
{ "action": "ptestList", "type": "profile", "openid": "你的openid" }
{ "action": "ptestGet", "id": "试跑记录_id", "openid": "你的openid" }
{ "action": "ptestDel", "id": "试跑记录_id", "openid": "你的openid" }
```

- `ptestList` 返回**摘要**（`_id / type / label / createdAt / rules 前 60 字 / temperature / ms / records / range`），
  最多 50 条、按 `createdAt` 倒序。**不含 `result`**——正文很大，全量回传既慢又占小程序数据量。
  - 控制台测这条要带 `openid`（控制台测试没有用户身份）。带 `type` 只看某一类。
  - ⚠️ 这里的 `.get()` **必须 await**：漏了会让 `list.data` 恒为 `undefined`、被 `|| []` 兜成空数组，
    表现为「库里明明有记录，页面却永远显示还没有试跑记录」。改这块时先确认 await 在。
- `ptestGet` 返回单条完整文档（含 `result` 全文与 system/user 字数）。
- `ptestDel` 按 `{ openid, _id }` 删——所以只能删自己的，删不掉别人的。
- ⚠️ 删试跑记录是**动存量数据**的操作，代码里不自动清；需要清空时手动删集合里的文档。

---

### 10. 定时任务（无 action、无 openid）

控制台**不要**直接测这条分支（手动测需要放开 openid 判断）。
定时器配在 `config.json`：`0 0 17 * * * *` = UTC 17:00 = **中国 01:00**。
返回形如：

```json
{ "trigger": true, "day": "2026-10-05", "users": 4, "done": 6, "skipped": 31, "err": 0 }
```

`trigger: true` 说明走的是定时分支（而不是被某个 action 拦下了）。

---

## 五、提示词注册表（换提示词不用再部署云函数）

以前换提示词只能「改代码 → 上传部署 → 等 1~2 分钟」，一轮几分钟。
现在提示词正文存在 `promptset`里，在小程序里改完保存**立即生效**。

### 为什么要分两层（重要）

现在的提示词由三段拼成：

```
common.review（人设与共同原则）
  + review.dayWeek / review.monthYear（任务规则）
  + fieldsSpec() / profileFieldsSpec()（**输出字段契约**）
```

**只有前两层可改，最后一层锁死。** 原因：输出字段说明是**机器契约**——
`fieldsSpec()` 生成的字段名，和云函数 `generateFor` 里的 JSON 解析、和 `review.wxml`
里的渲染，是一一对应的。如果把它开放给用户改，用户把 `patterns.drain` 改成别的名字，
模型会照着新名字返回，云函数解析不到 → **页面白屏，而且很难查出是自己改了字段名**。

所以 `promptGet` 会把契约层原文返回给前端**只读展示**（让人看懂模型被要求返回什么结构），
但**不提供编辑入口**。

### 槽位清单

| 槽位名 | 界面名 | 接在哪 |
|---|---|---|
| `common.review` | 回看人设与共同原则 | 所有周期回看的开头 |
| `review.dayWeek` | 周期复盘 · 简版（日 / 周） | 日、周回看的规则段 |
| `review.monthYear` | 周期复盘 · 完整版（月 / 年） | 月、年回看的规则段 |
| `report.core` | 人物深度报告 · 核心规则 | 「人物深度报告」的全部硬性要求 |
| `persona.full` | 个人画像 · 完整版 | 增量画像（后续阶段接入） |
| `persona.lite` | 个人画像 · 轻量版 | 增量画像（后续阶段接入） |
| `preset.focusBody` | 附加 · 聚焦身心 | 可勾选的附加指令 |
| `preset.riskFirst` | 附加 · 强化风险 | 可勾选的附加指令 |
| `preset.sleepEnergy` | 附加 · 睡眠-能量关联 | 可勾选的附加指令 |
| `preset.keepShort` | 附加 · 压缩篇幅 | 可勾选的附加指令 |

### 出厂值兜底：绝不报错

`loadPrompt()` 在任何情况下都会返回一段可用的提示词，**不会抛错**：

| 情况 | 行为 |
|---|---|
| 集合不存在（新环境没部署过） | 静默返回 `PROMPT_BUILTIN` 里的出厂值 |
| 某条记录不存在 / 读取报错 | 同上 |
| 正文是空字符串 | 同上（不会给模型一段空规则） |

**这是硬性要求**：提示词是增强项，绝不能成为 AI 回看的单点故障。
桩测确认：集合完全不存在时，system 消息仍有完整内容，回看照常工作。

出厂值就写在代码里（`PROMPT_BUILTIN`），它同时是「恢复默认」的还原目标——
改它等于改出厂设定。首次调用 `promptList` / `promptGet` / `promptSave` 时会自动播种。

### 版本与回滚

- 每次保存：**先把旧正文写进 `promptsetver` 快照**，再更新 `promptset`，`rev` 恒 +1。
- `rev` **恒 +1 而不复用旧号**。这样「rev=N」永远唯一对应一份内容——
  否则切回 rev=5 之后，rev=5 的含义会随时间漂移，历史记录就不可信了。
- 留快照前会先查「这一版是不是已经有快照了」。**为什么必须查**：并发保存时两次调用
  可能读到同一个 `curRev`，都往`promptsetver` 写同 rev 的快照，而「切回 rev=N」用的是
  `where().limit(1)`，命中哪条不确定——这种不一致是**静默的**。单用户手动点几乎撞不上，
  但多一次极轻的查询就能堵住，值得。

### 控制台测试模板

```json
{ "action": "promptList", "openid": "你的openid" }
```

```json
{ "action": "promptGet", "openid": "你的openid", "slot": "review.dayWeek" }
```

```json
{ "action": "promptSave", "openid": "你的openid", "slot": "review.dayWeek",
  "body": "角色：日志复盘分析师。\n任务：只抓睡眠与精力。\n行动上限 2 条。",
  "note": "试一下只看睡眠" }
```

```json
{ "action": "promptVersions", "openid": "你的openid", "slot": "review.dayWeek" }
```

```json
{ "action": "promptVersionGet", "openid": "你的openid", "slot": "review.dayWeek", "rev": 1 }
```

```json
{ "action": "promptRevert", "openid": "你的openid", "slot": "review.dayWeek", "rev": 1 }
```

```json
{ "action": "promptReset", "openid": "你的openid", "slot": "review.dayWeek" }
```

```json
{ "action": "promptAdopt", "openid": "你的openid", "id": "promptlog里的那条_id" }
```

### 返回值

| 返回 | 含义 |
|---|---|
| `{ groups:[{ group, name, slots:[{ slot,name,desc,state,rev,chars,edited }] }] }` | `promptList`。**正文不进列表**（几百上千字），只给字数与 rev |
| `{ slot,name,desc,body,builtin,edited,rev,updatedAt,contract }` | `promptGet`。`contract` 是**只读**的输出字段说明 |
| `{ ok:true, rev:N }` | `promptSave` / `promptReset` / `promptRevert` 成功，`rev` 是新的版本号 |
| `{ ok:true, rev:N, fromRev:M }` | `promptRevert` 成功，`fromRev` 是切回去的那一版 |
| `{ ok:true, rev:N, slot, slotName }` | `promptAdopt` 成功，`slotName` 是这次改的是哪个槽位 |
| `{ list:[{ rev,note,chars,createdAt }] }` | `promptVersions`。**不含正文**，正文要 `promptVersionGet` 单条取 |
| `{ error:"提示词正文不能为空…" }` | 想清空正文。点「恢复默认」而不是删内容 |
| `{ error:"这次试跑没有改提示词正文…" }` | `promptAdopt` 拿的是基线试跑（没改正文），没什么可采纳 |

### 排错

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `promptList` 返回的 `edited` 一直是 `false` | 说明一直是出厂值（没保存过） | 正常。`promptSave` 一次后就会变true |
| 保存成功但生成结果没变化 | 该槽位没接到这个功能上（看 `state`） | `state:"reserved"` 的槽位是后续阶段才接入的 |
| 改了提示词，输出结构乱了 | 不该发生——契约层不给编辑 | 若确实需要改结构，必须改代码里的 `fieldsSpec()` |
| 看不到历史版本 | 之前一直是出厂值，rev=1 从没被替换过 | 出厂值不算「旧版」，没有快照；改一次就有了 |
| `promptGet` 报 `没有这个提示词槽位` | `slot` 名拼错了 | 对照上面的槽位清单 |

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
| `promptlog` | 仅创建者可读写 | **提示词试跑结果**（`promptTest` 写入）。只增不删，供对比不同提示词版本；正式文档一个字都不碰 |
| `promptset` | **仅云函数读写** | 提示词注册表，**每个槽位一条**（`_id` 就是槽位名）。小程序不直读，全走云函数 |
| `promptsetver` | **仅云函数读写** | 提示词历史快照，每次保存追加一条 |

`profile` 不存在会报 `-502005`；云函数首次用到时会自动创建，所以**手动建或不管都行**。
`promptlog` 同理，**云函数也会自动创建**，不用手动建（缺了试跑仍可用，只是 `saved:false`）。
`promptset` / `promptsetver` 也自动创建；**而且就算它们完全不存在，AI 回看和画像照常工作**
（`loadPrompt` 会静默退回代码里的出厂值），见「五、提示词注册表」。
（集合是**整个云环境共享**的，不是每个用户各有一份——用户靠文档里的 `openid` 字段区分。）

> 💡 `promptset` / `promptsetver` 里存的是**提示词**，对所有用户共用一份（不是每人各存一份）。
> `openid` 字段只用于记录「最后是谁改的」，不做权限隔离。
> `savePrompt` 用 `doc(slot).set({ data })` **按槽位覆盖**，所以同一个槽位永远只有一条当前记录；
> 历史全在 `promptsetver` 里另存。

> ⚠️ **写库姿势提醒（踩过）**：云函数端 `wx-server-sdk` 的写入方法必须包一层 `data`：
> `collection.add({ data: doc })`、`doc(id).update({ data: {...} })`。
> 直接 `add(doc)` **不会报错**，而是**静默插入一条只有 `_id` 的空文档**——代码还会以为成功了
> （因为 `add` 照样返回 `_id`），表现就是「提示已保存，但列表里永远空着」。
> 小程序端的 `wx.cloud.database()` 才是不包 `data` 的，两端规则相反，别混。
> 本文件所有写入点都已包 `data`；`promptTest` 还额外做了一次**回读校验**，
> 确认 `openid` / `createdAt` 真落库了才认成功（同类静默失败能被当场抓住，而不是留到看页面才发现）。

### 部署后必做

1. 等 **1~2 分钟**（云端重建实例有瞬时 `ret=-3`，不是代码问题）。
2. 先跑 `{}` 冒烟，再跑 `{"action":"promptPreview","openid":"…"}` 确认能读到数据。
3. 最后跑 `{"action":"gen","type":"day","offset":1,"openid":"…"}` 验证大模型链路。
4. 想调提示词的话，先跑 `{"action":"promptTest","type":"day","openid":"…"}`（不填 `rules` 即为基线对照）。

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
💡 不想删文档、只想看新提示词什么效果 → 用 `promptTest`（不写正式文档，没有幂等）。

### 生成额度

- 每次调用重置预算：`MAX_GEN_PER_RUN = 15`；`event.maxGen` 可覆盖（`backfill` 就是靠它放宽）。
- 大模型一次要几秒到十几秒，60s 内最多做十来次；补不完的由**下一次定时接着补**，不会丢。
- 额度用尽时相关周期返回 `skipped:true, deferred:true`，**不算错误**。
- `promptTest` 一次只调一个模型，**不占 `genBudget`**（也不受画像自然周冷却限制），
  但仍会花掉一次真实的模型额度。

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
| 试跑页提示「调用失败」 | 多半是控制台偶发的 `ret=-3`，或刚部署完实例还在重建 | 等 1~2 分钟重试；持续则重新部署云函数 |
| 试跑返回 `saved: false` | 看 `saveError` 的真实原因，别默认是集合不存在 | 集合会自动创建；若是权限问题，把 `promptlog` 权限设为「仅创建者可读写」 |
| **试跑提示「已存进历史」但历史列表一直是空的** | 版本太老：写入漏包 `{ data: ... }`，被静默写成了只有 `_id` 的空文档 | 重新部署云函数；库里已有的空壳文档手动删掉（它们没有任何内容） |
| 库里 `promptlog` 文档只有 `_id` 一个字段 | 写入漏包 `{ data: ... }`，被静默写成了空文档 | 同上；这批空壳是脏数据，代码不会自动清（动存量数据需人工确认） |
| **库里有记录、页面却显示「还没有试跑记录」** | 读取的 `.get()` 漏了 `await`，`list.data` 恒为 `undefined`，被 `|| []` 兜成空数组 | 重新部署云函数。控制台测 `{"action":"ptestList","openid":"你的openid"}`，返回的 `list` 应该有内容 |
| 试跑返回「这个周期没有记录可试」 | 该周期一条记录都没有 | 换 `type`，或用 `offset` 往前推几天找有记录的日期 |
| 试跑返回「这个周期还没结束，不能试」 | 未来的周期记录还不存在 | 加 `offset` 指向已过去的日期，或换 `type` |
| 试跑返回「模型调用失败：…」 | 与正式生成同一种原因（key / 限流 / 输出不纯） | 看上面几条对应行 |

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
| 2026-10-06 | **阶段一：提示词从代码搬进数据库（提示词注册表）。** 新增 `promptset`（每槽位一条当前值）+ `promptsetver`（每次保存留快照），以及 8 个只读写提示词、**不调大模型不碰业务集合**的 action：`promptList` / `promptGet` / `promptSave` / `promptReset` / `promptVersions` / `promptVersionGet` / `promptRevert` / `promptAdopt`。`buildMessages` / `buildProfileMessages` 改为从库里取提示词——**换提示词不用再「改代码 + 上传部署」，保存即生效**。三条硬约束：①**出厂值兜底绝不报错**（集合不存在 / 读失败 / 正文为空，一律静默退回 `PROMPT_BUILTIN` 里的出厂值，桩测确认集合完全不存在时 system 仍有完整内容，AI 回看照常工作——提示词是增强项，不能成为单点故障）；②**输出字段契约锁死**（`fieldsSpec` / `profileFieldsSpec` 只在 `promptGet` 里只读展示、不给编辑：字段名与云函数解析、页面渲染一一对应，改了会让页面白屏且极难自查）；③`rev` **恒 +1 不复用旧号**，让「rev=N」唯一对应一份内容、回滚后历史不漂移。留快照前先查该 rev 是否已有快照——并发保存会写出同 rev 的两条快照，「切回 rev=N」用 `where().limit(1)` 命中哪条不确定，这类不一致是**静默的**，多一次极轻的查询即可堵住。`promptAdopt` 是「试跑→线上」的桥：把某次试跑用的正文设为线上生效（此前试跑只能看、改不了线上）。两个 build 函数改成 async，**6 处调用点全部补 `await`**（漏 await 不报错，只会静默拿到 Promise）。本阶段行为与改动前完全一致，是纯重构。 |
| 2026-10-06 | 修「库里有试跑记录、页面却永远显示还没有试跑记录」：`ptestList` 里 `.get()` **漏了 `await`**，`list.data` 恒为 `undefined`，被 `|| []` 兜成空数组，于是无论库里有多少条都显示为空。补上 `await`（已全项目扫过，其余数据库调用都带 await）。同时试跑页不再吞掉列表读取的错误——读不到时显示真实原因，而不是一律显示「还没有记录」。 |
| 2026-10-06 | 修「试跑结果存不进历史（库里只有 `_id`）」：`promptTest` 写入时写成了 `add(doc)`，**漏包 `{ data: ... }`**。云函数端 `wx-server-sdk` 的 `add` 必须包 `data`（与小程序端相反），漏包时**不报错、照样返回 `_id`**，但插进去的是一条只有 `_id` 的空文档——所以表现是「提示已存进历史，列表却永远空着」，属于静默失败。同文件另三处写入都包了，只有这一处漏。修复：① 包上 `data`；② 加**回读校验**（读回确认 `openid`/`createdAt` 真落库才认成功），同类静默失败当场暴露；③ `promptlog` 改为**云函数自动创建**，不用手动建；④ 落库失败时回真实原因 `saveError`，不再笼统说「集合可能不存在」。**已写入的空壳文档需手动删除**（它们没有内容）。 |
| 2026-10-06 | 新建本文档：把散落在 README 与代码注释里的测试模板、参数、返回、额度、幂等、排错整理成一份；补上 `promptPreview` / `profileGet` / `force` 等此前只在README 一句话里带过的用法；给 `tools/check-syntax.py` 加了「action 必须在本文档里有模板」的同步检查。 |
| 2026-10-06 | 新增 **提示词试跑**：`promptTest`（用真实记录跑一次，接受 `rules` 追加 / `overrideRules` 整段替换，结果写 `promptlog`，**完全不碰 `analysis` / `profile`**）＋ `ptestList` / `ptestGet` / `ptestDel` 三个读写删；小程序新增 `pages/prompt` 试跑页（设置页入口）。`buildMessages` / `buildProfileMessages` 增加 `opt.extraRules` 与 `opt.overrideRules`，追加片段排在规则段末尾（模型对system 末尾更敏感）。新增 `promptlog` 集合（可选，缺了仍可用只是不存历史）。 |
| 2026-10-06 | 修「页面出现 `�`」：读大模型响应时没 `res.setEncoding('utf8')`，`buf += c` 会对**每个网络分片**各做一次 utf8 解码，而一个汉字 3 字节，一旦被分片切开就解码成替换字符（画像总结里「调整」变成「调��」）。改为 `setEncoding('utf8')`，由 StringDecoder 跨片保留不完整字节序列。**注意：修的是「新生成的内容」，已落库的旧文档里的坏字符不会自动修复，需重新生成。** |
| 2026-10-06 | 修「内容重复」：模型常把卡片头那句 `summary` 原样复读进 `facts` 第一条（折叠看一句、展开第一行又是同一句），也爱给同一件事套两个标签各说一次（「整体状态：各项数据都比一般日常记录都低」与「感觉疲惫：各项数据都比一般日常记录都低」）。两道处理：① 提示词加硬要求（summary 不许进 facts、板块间不许复读）；② 落库前 `dedupe()` 兜底——归一化（去标点空白与「整体状态 / 感觉疲惫」这类标签前缀）后判重，同句或一方为另一方子串即去掉，数组内部也去重，**保序**、只做保守判定以免误删真正不同的内容。同步把落库的 `clean` 从 `String(v)` 换成 `flatText(v)`（顺带堵住回看文档里可能出现的 `[object Object]`）。**修复只在生成侧**，已生成的旧文档仍带重复，需删掉对应周期的 `analysis` 文档后重跑。 |