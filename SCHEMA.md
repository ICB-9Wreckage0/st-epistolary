# 书信簿 · 数据结构（schema 1，v0.4）

整个档案是一个 JSON 文件。原则只有三条：

1. **原文 `body` 是唯一的事实来源。** 段落由它按空行切出来，重新分段时尽量保住旧段落的 ID 和关键词。
2. **“谁知道什么”不单独存。** 它由流转事件 `events` 推算出来，所以只有一处记录，不会出现两处对不上。
3. **外观和内容分开。** 换信纸不会动原文。

```jsonc
{
  "schema": 1,
  "counters": { "letter": 12, "attachment": 0 },   // 编号计数器

  "people": [                                        // 人物、别名与文风档案
    {
      "name": "文森特·梵高",
      "aliases": ["文森特", "Vincent"],
      "historical": true,                // 真实历史人物：回信时参照其现存书信的口吻
      "styleSource": "梵高书信（致提奥）", // 参考的书信集
      "styleNotes": "……",                // 文风要点
      "styleSamples": ["……", "……"],     // 书信样本，写回信时随机挑几段
      "language": "",                    // 常用书信语言（可空）
      "hand": "personal"                 // 此人的字迹，新信件和 AI 回信默认用它（可空）
    }
  ],

  "letters": {
    "LETTER-0012": {
      "id": "LETTER-0012",
      "kind": "letter",            // letter 信件 | postcard 明信片 | telegram 电报 | note 便条 | invitation 请柬
      "status": "sent",            // draft 草稿 | sealed 已封口 | sent 已寄出 | unsent 写了未寄 | lost 遗失
      "authenticity": "original",  // original 原件 | copy 抄本 | transcript 誊录 | translation 译本 | forged 伪造 | fragment 残片
      "title": "",
      "author": "EE",              // 写信人（用于知情推算）
      "signature": "E.",           // 信末实际署名（只用于显示）
      "recipients": ["提奥"],
      "writtenAt": "1890-11-03",   // 支持 1890 / 1890-11 / 1890-11-03；写不成日期的（如“某年秋”）不参与时间过滤
      "placeFrom": "巴黎",
      "placeTo": "奥维尔",
      "language": "法语（中文显示）",
      "tags": ["佛罗里达"],        // 整封信的关键词（命中时权重减半）
      "body": "亲爱的提奥：……",   // 逐字原文

      "segments": [
        {
          "id": "S3",              // 稳定 ID；显示时的 §3 是位置，不是 ID
          "text": "我最近一直有些担心文森特……",
          "tags": ["文森特", "担心"],   // 人工关键词
          "aiTags": [],                 // AI 建议的关键词（同样参与匹配）
          "summary": "EE 说她担心文森特。", // 被“转述”的角色只会看到这句
          "references": [{ "letter": "LETTER-0009", "segment": "S2" }] // 这一段在回应哪封信的哪一段
        }
      ],

      "events": [
        // type 决定当事人得到什么程度的知情：
        //   read 阅读 / heard 听人念过 / copied 抄录 → 原文
        //   told 听人转述 → 大意
        //   received 收到 / aware 知道存在 → 只知道存在
        //   sent 寄出 / forwarded 转寄 / returned 退回 / lost 遗失 → 不带来知情
        { "id": "E1", "type": "sent",     "who": "EE",   "date": "1890-11-03", "segments": null },
        { "id": "E2", "type": "received", "who": "提奥", "date": "1890-11-05", "segments": null },
        { "id": "E3", "type": "read",     "who": "提奥", "date": "1890-11-05", "segments": null },
        { "id": "E4", "type": "heard",    "who": "文森特", "date": "1890-11-19", "segments": ["S3", "S4"] }
        // segments 为 null 表示整封；forwarded 事件的 to 字段记转寄给谁
      ],

      "attachments": [],           // 附件 ID 列表（v0.1 界面未实现）
      "appearance": {
        "paper": "cream",          // plain | cream | aged | lined | blue
        "ink": "blueblack",        // black | blueblack | brown | faded
        "font": "personal",        // 字迹：formal 端正 | personal 自然 | elegant 优雅 | casual 随意 | typewriter 打字机
                                   // （旧版的 serif / kai / hand / mono 读入时自动换算）
        "orientation": "portrait", // portrait 竖版（对折入封）| landscape 横版（平放入封）
        "flourish": false,         // 称呼和署名用花体
        "envelope": "ivory",       // ivory | kraft | blue | white（信封动画）
        "wax": "crimson"           // crimson | navy | forest | black | gold（火漆）
      },
      "openedAt": "",              // 收信人第一次拆开的时间；拆信动画只播放一次
      "links": { "works": ["WORK-MINE-0003"] },   // 创作助手的作品 ID，只存 ID 不存内容
      "inReplyTo": "LETTER-0009",  // 这封信回复的是哪封信（整封级别）
      "aiDraft": false,            // AI 代写、用户还没收下的回信草稿
      "notes": "",
      "createdAt": "…", "updatedAt": "…"
    }
  },

  "attachments": {},               // 预留：ATT-0001 → { kind, title, … }
  "presets": []                    // 用户自己添加的套语
}
```

## 知情推算

给定一个人（按别名展开）和一个剧情日期：

- 信的 `writtenAt` 晚于剧情日期 → 信还不存在，谁都不知道；
- 这个人是 `author` → 全部段落都是原文级；
- 逐条看 `events`：`who` 是这个人，并且 `date` 不晚于剧情日期 → 按事件类型给对应段落升级知情；
- 同一段取最高等级。

日期任一方写不成标准格式时，按“已经发生”处理，宁可多给也不会莫名其妙地挡住。

## 以后怎么扩展

新增字段一律在 `migrateArchive()`（`src/model.js`）里补默认值；`schema` 版本号升一级时，在那里写迁移。批注、未回复事项、承诺追踪这类功能，计划做成挂在信件或段落 ID 上的独立列表，不改动信件本身的结构。

## 聊天消息里的标记

寄出的信和收下的回信发到聊天时，消息的 `extra.epistolary` 里会记录：

```jsonc
{ "kind": "letter", "letterId": "LETTER-0001", "reader": "文森特", "arrival": "1889-06-17" } // 寄出的信
{ "kind": "reply",  "letterId": "LETTER-0002" }                                              // 角色的回信
```

最近一条用户消息如果是 `kind: "letter"`，下一次生成（包括重新生成）会注入收信反应的提醒；出现在最近几条消息里的信件，不会再被检索重复注入。
