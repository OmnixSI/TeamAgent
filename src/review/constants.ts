// V-D 评判闭环 · 信号阈值/词表与规则 deny-list（D-2）
// 数值与词表逐字来自 design.md 第 285-300 行（信号规则表）与第 358 行（deny-list）。
// D-3 的 signalsOf 默认用这里的值，config/team.json 的 review.signals 可覆盖同名键；
// D-4/D-5b 用 DENY_WORDS 挡规则文本。
export const SIGNAL_DEFAULTS = {
  // S1：被点名后 15 分钟内没有 outbox，且决策不是带理由的 stop。
  s1: { no_outbox_minutes: 15 },
  // S2：回复里的拒答/降级措辞。
  s2: { words: ["做不了", "不知道", "无法", "拿不到", "看不到", "没拿到", "读不了", "不能", "输入已保留", "暂时"] },
  // S3：随后 3 条用户消息里的纠正/抱怨。
  s3: { window_messages: 3, words: ["不对", "错了", "别瞎说", "怎么又", "人呢", "怎么不回", "拉了", "服", "没跟你说", "收敛"] },
  // S4：outbox 状态 failed/unknown，或声称发了文件但 deliveries 为空（无阈值）。
  s4: {},
  // S5：job 失败，或 model_ms > 60000，或工具 ok=0。
  s5: { model_ms: 60000 },
  // S6：承诺措辞。`等…再` 是中间可夹字的模式（等 X 再），实现按模式处理，不要当字面量。
  s6: { words: ["明天", "每天", "每周", "几点", "以后", "稍后", "回头", "等…再", "我会"] },
  // S7：3 分钟内连发 ≥4 条，中间没有用户消息。
  s7: { window_minutes: 3, min_messages: 4 },
  // S8：能力自述措辞。
  s8: { words: ["我能", "可以帮你", "支持", "能力", "上线了"] },
  // S9：spoken_kind 是 proactive 或 research，且前 15 分钟内有 S3。
  s9: { lookback_minutes: 15, kinds: ["proactive", "research"] },
  // S10：30 分钟内与自己上一条回复 3-gram Jaccard ≥ 0.8；或对同一 capability 说法前后相反。
  s10: { window_minutes: 30, jaccard: 0.8, ngram: 3 },
  // S11：被点名的群友消息里出现长期要求词（以后/每天/别再/叫我/口头禅…），复盘必须看见。
  s11: { words: ["以后", "每天", "每周", "每早", "每晚", "定时", "别再", "不要再", "别老", "不许",
    "叫我", "称呼", "口头禅", "记住", "日报", "早报", "晨报", "周报"] },
  // 优先级：S1/S4/S10/S3/S11=3，S2/S5/S8/S9=2，S6/S7=1，按信号求和。
  priority: { S1: 3, S2: 2, S3: 3, S4: 3, S5: 2, S6: 1, S7: 1, S8: 2, S9: 2, S10: 3, S11: 3 },
  // 每晚另外抽 2 条「mentioned=1 且无信号」的 trace（priority 0）。
  sample_mentioned_no_signal: 2,
} as const;

export type SignalConfig = typeof SIGNAL_DEFAULTS;

// 规则文本不得命中的权限/密钥/工具开关/部署词表（design 第 358 行）。匹配时按小写比较。
export const DENY_WORDS = ["权限", "授权", "token", "密钥", "开关", "部署", "上线", "关闭", "删除", "管理员"] as const;
