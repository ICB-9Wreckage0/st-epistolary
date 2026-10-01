# 书信簿 · 数据结构（schema 1，v0.30）

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
      "hand": "personal",                // 此人的字迹，新信件和 AI 回信默认用它（可空）
      "wobble": ""                       // 此人笔迹的抖动程度 0-3（可空）
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
      "enclosures": [                // 随信附上的东西（旧版本的 attachments 字符串数组会自动转成这个）
        { "id": "ENC1", "kind": "money", "name": "五枚二十法郎金币", "value": "100 法郎", "desc": "用亚麻布包着", "letterRef": "" }
        // kind：money 钱 | sketch 速写 | photo 照片 | flower 压花 | gift 礼物 | document 附页 | letter 另一封信（letterRef = 信的编号）| other
      ],
      "code": "【信1】",           // 暗号：用户消息里出现它，那一轮就把这封信交给 AI（唯一）
      "codeFloors": [{ "chatId": "…", "mes": 120 }], // 暗号在哪个聊天的哪几层（你的消息）出现过
      "folder": "勒鲁的月信",      // 文件夹（空 = 未分类）；档案顶层 folders 是文件夹的顺序
      "shell": false,              // 空壳信：剧情里已经有这封信了，正文还没写（写了正文自动变 false）
      "memories": [                // 读过这封信的人记得什么（v0.21）；同步到聊天绑定的世界书
        { "person": "提奥", "text": "提奥记得……「原话」……", "gist": "一句话概括", "updatedAt": "…",
          "chatId": "…", "fromMes": 120, "prev": { "text": "…", "gist": "…", "fromMes": 80 },
          "wiBook": "书信簿记忆-…", "wiUid": 3, "auto": true }
        // auto=false：用户改过，自动整理不再覆盖，也不会被撤回
        // fromMes：由哪一层整理出来；那一层被换掉 / 删掉时退回 prev（没有 prev 就删掉）
      ],
      "whereabouts": {             // 信在谁手里（v0.25 起只记用户填的；和寄送状态 delivery 分开）
        "current": { "holder": "提奥", "place": "抽屉", "state": "kept", "note": "", "date": "1890-07-01", "by": "user" },
        // state：kept 收着 | carried 随身带着 | given 交给了别人 | burned 烧了 | lost 丢了 | unknown
        "suggest": { "holder": "提奥", "place": "抽屉", "state": "kept", "mes": 41, "by": "ai" }, // AI 的建议，用户点“采用”才变成 current
        "history": []
      },
      "recallKeys": ["七月的信"],  // 世界书条目的额外关键词

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
        "paper": "cream",          // plain | cream | aged | lined | redline | blue
        "ink": "blueblack",        // black | blueblack | navy | brown | crimson | green | faded | custom
        "inkColor": "",            // ink 为 custom 时的颜色，如 #0b2a6b
        "font": "personal",        // 字迹：formal 端正 | personal 自然 | elegant 优雅 | casual 随意 | typewriter 打字机
                                   // （旧版的 serif / kai / hand / mono 读入时自动换算）
        "orientation": "portrait", // portrait 竖版（对折入封）| landscape 横版（平放入封）
        "flourish": false,         // 称呼和署名用花体
        "envelope": "ivory",       // ivory | kraft | blue | white | airmail（信封动画）
        "wax": "crimson",          // 封缄：crimson | navy | forest | black | gold 火漆，chop 朱印“缄”，none 不封
        "wear": 0,                 // 纸张磨损 0 崭新 | 1 轻微 | 2 旧信 | 3 破损
        "size": "md",              // 字号 sm 小 | md 标准 | lg 大 | xl 特大
        "wobble": ""               // 笔迹抖动 0-3；"" = 跟随写信人档案（再没有就按字迹默认）
      },
      "openedAt": "",              // 收信人第一次拆开的时间；拆信动画只播放一次
      "delivery": {                // 寄送状态（没寄过的信为 null）
        "mode": "date",            // date 按剧情日期 | floors 按楼层 | instant 立即
        "eta": "1889-06-13",       // 按日期送达时的送达日期
        "floors": 0,               // 按楼层送达时，寄出后再过几层
        "sentFloor": 42,           // 寄出时聊天有几条消息
        "chatId": "…",             // 在哪个聊天里寄出（只在这个聊天里检查送达）
        "status": "transit",       // transit 在途 | arrived 送到了、还没看 | viewed 看过了
                                   // 托人转交时还有：atVia 在转交人手里、等 TA 决定 | held 转交人先留着 | withheld 转交人扣下不交
        "reader": "文森特",
        "arrivedAt": "",           // 实际送达的剧情日期
        "followup": false,         // 刚切过去看了收信反应，信箱里显示“回到原场景 / 写回信”
        "auto": false,             // 送到后自动切过去
        // ---- 托人转交（没有转交人时没有这些字段）----
        "via": "女仆玛莎",          // 转交人
        "stage": "toVia",          // toVia 送往转交人 | atVia 在转交人手里 | toRecipient 已转交、送往收信人 | done 送到
        "leg2": { "days": 1, "floors": 2 }, // 第二段路：转交人拿到后再过几天 / 几层
        "target": "1889-06-20",    // 希望收信人最晚哪天收到（可选）
        "viaDeadline": "1889-06-17", // 转交人最晚哪天要转交出去 = target − 第二段路的天数
        "viaArrivedFloor": 40,     // 送到转交人手里时的楼层（按楼层提醒用）
        "remindedOn": "",          // 上次提醒的剧情日期（同一天只提醒一次）
        "detected": false,         // 是从剧情文字里发现收信的
        "viaArrivedAt": "",        // 送到转交人手里的剧情日期
        "viaViewed": false,        // 已经切过去看过转交人那边
        "awaitingDecision": false, // 等转交人那段剧情写完，再让 AI 判断 TA 的决定
        "decisionFrom": 0,         // 从第几条消息开始算转交人的那段剧情
        "viaGuess": null,          // AI 的判断 { opened, resealed, action: forward|later|withhold|unclear, note }
        "opened": false,           // 转交人拆看过
        "tampered": false,         // 拆过而且没封好，收信人可能看得出来
        "openly": false,           // 光明正大地拆阅（有授权、注明拆阅过），收信人那边知道
        "viaNote": "",             // 转交人在信封上写的话 / 附的字条
        "lastJudged": 0,           // 上次判断转交人决定时的楼层（同一层只判断一次）
        "viaFollowup": false       // 信箱里显示“回到写信人这边”
      },
      "source": { "chatId": "…", "mes": 17 },  // 从聊天记录导入的信：出自哪条消息
      "translations": { "zh": { "text": "…", "source": "…原文…" } }, // 阅读页的中文译文缓存
      "links": { "works": ["WORK-MINE-0003"] },   // 创作助手的作品 ID，只存 ID 不存内容
      "inReplyTo": "LETTER-0009",  // 这封信回复的是哪封信（整封级别）
      "aiDraft": false,            // AI 代写、用户还没收下的回信草稿
      "notes": "",
      "createdAt": "…", "updatedAt": "…"
    }
  },

  "attachments": {},               // 预留：ATT-0001 → { kind, title, … }
  "presets": [],                   // 用户自己添加的套语
  "styles": [                      // 用户自己存的款式包
    { "id": "mine-…", "name": "我的旧信", "language": "", "appearance": { "paper": "aged", "wear": 2, "…": "…" } }
  ]
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

## 世界书条目（v0.22）

书信簿只动备注末尾带 `⟨epi:…⟩` 的条目：`mem:信ID:人` 某人对某封信的记忆；`sum:写信人:人` 来信一览（读过同一写信人两封以上时）；`txt:信ID` 信还在某人手里时的原文（重读用）。打开聊天、改记忆、删信时整本对齐。

## 聊天消息里的标记

寄出的信和收下的回信发到聊天时，消息的 `extra.epistolary` 里会记录：

```jsonc
{ "kind": "letter", "letterId": "LETTER-0001", "reader": "文森特", "arrival": "1889-06-17" } // 寄出的信
{ "kind": "reply",  "letterId": "LETTER-0002" }                                              // 角色的回信
```

最近一条用户消息如果是 `kind: "letter"`，下一次生成（包括重新生成）会注入收信反应的提醒；出现在最近几条消息里的信件，不会再被检索重复注入。

## 聊天元数据里的“待读的信”（v0.12）

每个聊天的 `chatMetadata.epistolary.inbox`：下一次生成时要把原文直接交给 AI 的信（原文不进聊天记录）。

```jsonc
[{ "letterId": "LETTER-0012", "reader": "提奥", "arrival": "1890-06-30", "peek": true, "queuedAt": 652, "answeredAt": 0 }]
```

`answeredAt` 是角色读完回复的楼层；在这一层重新生成或换回复时，仍会带上这封信。
