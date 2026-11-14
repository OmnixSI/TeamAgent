// QQ official system emote ids. Names follow QQBot.Net's Emotes.System enum
// (https://github.com/gehongyan/QQBot.Net/blob/v0.2.0/src/QQBot.Net.Core/Entities/Emotes/Emotes.cs),
// which mirrors the face-id conventions used by NapCat and go-cqhttp. The table is
// only a fallback: QQ normally embeds the display name in ext as base64/URI JSON.
export const FACE_NAMES: Readonly<Record<number, string>> = {
  4: "得意",
  5: "流泪",
  8: "睡",
  9: "大哭",
  10: "尴尬",
  12: "调皮",
  14: "微笑",
  16: "酷",
  21: "可爱",
  23: "傲慢",
  24: "饥饿",
  25: "困",
  26: "惊恐",
  27: "流汗",
  28: "憨笑",
  29: "悠闲",
  30: "奋斗",
  32: "疑问",
  33: "嘘",
  34: "晕",
  38: "敲打",
  39: "再见",
  41: "发抖",
  42: "爱情",
  43: "跳跳",
  49: "拥抱",
  53: "蛋糕",
  60: "咖啡",
  63: "玫瑰",
  66: "爱心",
  74: "太阳",
  75: "月亮",
  76: "赞",
  78: "握手",
  79: "胜利",
  85: "飞吻",
  89: "西瓜",
  96: "冷汗",
  97: "擦汗",
  98: "抠鼻",
  99: "鼓掌",
  100: "糗大了",
  101: "坏笑",
  102: "左哼哼",
  103: "右哼哼",
  104: "哈欠",
  106: "委屈",
  109: "左亲亲",
  111: "可怜",
  116: "示爱",
  118: "抱拳",
  120: "拳头",
  122: "爱你",
  123: "NO",
  124: "OK",
  125: "转圈",
  129: "挥手",
  144: "喝彩",
  147: "棒棒糖",
  171: "茶",
  173: "泪奔",
  174: "无奈",
  175: "卖萌",
  176: "小纠结",
  179: "doge",
  180: "惊喜",
  181: "骚扰",
  182: "笑哭",
  183: "我最美",
  201: "点赞",
  203: "托脸",
  212: "托腮",
  214: "啵啵",
  219: "蹭一蹭",
  222: "抱抱",
  227: "拍手",
  232: "佛系",
  240: "喷脸",
  243: "甩头",
  246: "加油抱抱",
  262: "脑阔疼",
  264: "捂脸",
  265: "辣眼睛",
  266: "哦哟",
  267: "头秃",
  268: "问号脸",
  269: "暗中观察",
  270: "emm",
  271: "吃瓜",
  272: "呵呵哒",
  273: "我酸了",
  277: "汪汪",
  278: "汗",
  281: "无眼笑",
  282: "敬礼",
  284: "面无表情",
  285: "摸鱼",
  287: "哦",
  289: "睁眼",
  290: "敲开心",
  293: "摸锦鲤",
  294: "期待",
  297: "拜谢",
  298: "元宝",
  299: "牛啊",
  305: "右亲亲",
  306: "牛气冲天",
  307: "喵喵",
  314: "仔细分析",
  315: "加油",
  318: "崇拜",
  319: "比心",
  320: "庆祝",
  322: "拒绝",
  324: "吃糖",
  326: "生气",
  9728: "☀ 晴天",
  9749: "☕ 咖啡",
  9786: "☺ 可爱",
  10024: "✨ 闪光",
  10060: "❌ 错误",
  10068: "❔ 问号",
  127801: "🌹 玫瑰",
  127817: "🍉 西瓜",
  127822: "🍎 苹果",
  127827: "🍓 草莓",
  127836: "🍜 拉面",
  127838: "🍞 面包",
  127847: "🍧 刨冰",
  127866: "🍺 啤酒",
  127867: "🍻 干杯",
  127881: "🎉 庆祝",
  128027: "🐛 虫",
  128046: "🐮 牛",
  128051: "🐳 鲸鱼",
  128053: "🐵 猴",
  128074: "👊 拳头",
  128076: "👌 好的",
  128077: "👍 厉害",
  128079: "👏 鼓掌",
  128089: "👙 内衣",
  128102: "👦 男孩",
  128104: "👨 爸爸",
  128147: "💓 爱心",
  128157: "💝 礼物",
  128164: "💤 睡觉",
  128166: "💦 水",
  128168: "💨 吹气",
  128170: "💪 肌肉",
  128235: "📫 邮箱",
  128293: "🔥 火",
  128513: "😁 呲牙",
  128514: "😂 激动",
  128516: "😄 高兴",
  128522: "😊 嘿嘿",
  128524: "😌 羞涩",
  128527: "😏 哼哼",
  128530: "😒 不屑",
  128531: "😓 汗",
  128532: "😔 失落",
  128536: "😘 飞吻",
  128538: "😚 亲亲",
  128540: "😜 淘气",
  128541: "😝 吐舌",
  128557: "😭 大哭",
  128560: "😰 紧张",
  128563: "😳 瞪眼",
};

// Classic CQ face ids (0-54) are used only by the legacy [<face,id=N/>]
// marker. Source: pandolia/qqbot facemap.py
// https://github.com/pandolia/qqbot/blob/master/qqbot/facemap.py
export const CLASSIC_FACE_NAMES: Readonly<Record<number, string>> = {
  0: "微笑",
  1: "撇嘴",
  2: "色",
  3: "发呆",
  4: "得意",
  5: "流泪",
  6: "害羞",
  7: "闭嘴",
  8: "睡",
  9: "大哭",
  10: "尴尬",
  11: "发怒",
  12: "调皮",
  13: "呲牙",
  14: "惊讶",
  15: "难过",
  16: "酷",
  17: "冷汗",
  18: "抓狂",
  19: "吐",
  20: "偷笑",
  21: "可爱",
  22: "白眼",
  23: "傲慢",
  24: "饥饿",
  25: "困",
  26: "惊恐",
  27: "流汗",
  28: "憨笑",
  29: "大兵",
  30: "奋斗",
  31: "咒骂",
  32: "疑问",
  33: "嘘",
  34: "晕",
  35: "折磨",
  36: "衰",
  37: "骷髅",
  38: "敲打",
  39: "再见",
  40: "擦汗",
  41: "抠鼻",
  42: "鼓掌",
  43: "糗大了",
  44: "坏笑",
  45: "左哼哼",
  46: "右哼哼",
  47: "哈欠",
  48: "鄙视",
  49: "委屈",
  50: "快哭了",
  51: "阴险",
  52: "亲亲",
  53: "吓",
  54: "可怜",
};

function faceName(id: number): string {
  return FACE_NAMES[id] || "";
}

function legacyFaceName(id: number): string {
  return CLASSIC_FACE_NAMES[id] || FACE_NAMES[id] || "";
}

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
}

function textOfJson(raw: string): string {
  try {
    const value = JSON.parse(raw);
    return typeof value?.text === "string" ? value.text : "";
  } catch {
    return "";
  }
}

/** QQ sends ext as raw JSON, URI-encoded JSON, escaped JSON, or base64 JSON. */
export function decodeFaceExt(ext: string): string {
  const raw = String(ext || "").trim();
  if (!raw) return "";
  let text = textOfJson(raw);
  if (text) return clean(text);
  try { text = textOfJson(decodeURIComponent(raw)); } catch {}
  if (text) return clean(text);
  try { text = textOfJson(raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\")); } catch {}
  if (text) return clean(text);
  try {
    const b64 = raw.replace(/\s+/g, "");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const decoded = new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
    text = textOfJson(decoded);
    if (text) return clean(text);
    try { text = textOfJson(decodeURIComponent(decoded)); } catch {}
  } catch {}
  return clean(text);
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp("\\b" + name + "=(?:\"([^\"]*)\"|'([^']*)')"));
  const value = match ? (match[1] ?? match[2] ?? "") : "";
  if (!value) return "";
  try { return decodeURIComponent(value); } catch { return value; }
}

const LEGACY = /^\[<face,id=(\d+)\/>\]$/;
const FACE_TYPE = /^<faceType=(\d+),faceId="?(\d+)"?(?:,ext="([\s\S]*)")?[^>]*>$/;

/** Readable text for one QQ face/sticker tag; never member prose. */
export function faceTagText(tag: string): string {
  const legacy = tag.match(LEGACY);
  if (legacy) {
    const id = Number(legacy[1]), name = legacyFaceName(id);
    return name ? "[表情：" + name + "]" : "[表情（id=" + id + "）]";
  }
  if (/^<dice\b/i.test(tag)) return "[骰子]";
  if (/^<rps\b/i.test(tag)) return "[猜拳]";
  if (/^<(?:mface|marketface)\b/i.test(tag)) {
    const label = clean(attr(tag, "summary") || attr(tag, "face_name") || attr(tag, "name") || attr(tag, "text"))
      .replace(/^\[|\]$/g, "");
    return label ? "[表情包：" + label + "]" : "[表情包]";
  }
  const match = tag.match(FACE_TYPE);
  if (!match) return "[表情]";
  const type = Number(match[1]), id = Number(match[2]);
  const name = decodeFaceExt(match[3] || "") || faceName(id);
  if (name) return "[表情：" + name + "]";
  if (type === 6) return "[超级表情]";
  return "[表情（id=" + id + "）]";
}

export function hasSuperFace(body: string): boolean {
  return /<faceType=6\b/.test(body);
}

// ext may contain raw JSON or escaped JSON; a > inside its text is not a tag end.
export const FACE_TAG =
  /\[<face,id=\d+\/>\]|<faceType=(?:ext="\{(?:[^{}"]|"(?:\\.|[^"\\])*")*\}"|"(?:\\.|[^"\\])*"|[^">])*>|<mface\b[^>]*>|<marketface\b[^>]*>|<dice\b[^>]*>|<rps\b[^>]*>/g;
