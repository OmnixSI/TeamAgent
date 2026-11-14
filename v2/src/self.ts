// What the bot knows about itself. The capability list is generated from the tools that are actually
// registered and the status comes from the running Hub, so neither can drift from reality. The prose
// below has to be kept true by hand: when the architecture changes, change it here in the same commit.
import type { Tool } from "./core.ts";
import type { Env } from "./util.ts";
import { BUILD } from "./util.ts";

export type LiveStatus = {
  gateway_connected: boolean; messages: number; saved_images: number; saved_characters: string[];
  schedules: { when: string; task: string }[]; logins: string[]; memory_chars: number; notes_today: number;
  last_24h: { kind: string; turns: number; avg_seconds: number }[]; last_memory_consolidation: string | null;
};

const PIPELINE = [
  "运行位置：整套跑在 Cloudflare Workers 上（Worker 名 teamagent）。核心是一个 Durable Object，代码里叫 Hub，它常驻持有和 QQ 的官方长连接（WebSocket 网关）。没有任何程序跑在群主的电脑上。",
  "收消息：QQ 通过长连接把群消息推给 Hub。Hub 解析出文字、@、引用、图片、语音（用 QQ 自带的转写文字）、文件、分享卡片，存进它自带的 SQLite。",
  "攒一下再看：被 @ 或被叫到等 0.35 秒，普通闲聊等 2.2 秒，把连发的几句合成一轮，最多等 6 秒。",
  "一轮对话：同一个模型（DeepSeek 的 deepseek-flash）读到人设、长期记忆、昨晚整理之后的全部聊天记录、新消息里的图片，自己决定不说话、直接回、还是调工具。没有单独的“判定模型”和“嘴替模型”。",
  "推理档位：没人叫我时先不思考地看一眼，约一秒决定接不接；只要开口回话就用 high；用了查资料、跑代码这类干活的工具之后用 max。",
  "工具循环：一轮最多 8 次往返，同一次里的多个工具并行跑，结果原样交回模型；工具带回来的图片我能直接看到。说“已经做了”只认工具的真实返回。",
  "发消息：走 QQ 官方接口，能发文字、图片、语音（SILK 格式）、文件。只有一个人找我、而我回的时候群里又有人说了新的话，第一条回复会自动引用他那条消息（这是代码自动做的，我自己控制不了引用谁）。回复要挂在最近约 5 分钟内的一条群消息上，每条最多挂 5 条；挂不上就试着主动发，发不出去就排队，等下一个人说话时带出去。",
  "自己醒：Hub 每 20 秒醒一次，检查长连接、跑到点的定时任务；每天悉尼时间 04:30 把当天聊天整理进长期记忆。部署新代码后它会自己重启换上新版本。",
];

const CONNECTED = (env: Env & { CODE_MODEL?: string }) => [
  "DeepSeek（主力）：对话和识图都用 " + (env.CHAT_MODEL || "deepseek-flash") + "；另外用它的联网搜索、网页抓取、服务端多轮联网调研、文档识别（OCR）、语音合成、余额查询。",
  "OpenAI：画图和改图（" + (env.IMAGE_MODEL || "gpt-image-2.5-flare") + "）、长音频转文字（gpt-4o-mini-transcribe，B 站无字幕视频用）、Python 代码沙箱（" + (env.CODE_MODEL || "gpt-5.4-mini") + " 带代码解释器）。",
  "香港中转：部署在 Vercel 香港的一个带密钥的小函数。B 站接口、小红书、知乎、微博、抖音这些拒绝 Cloudflare 出口地址的站点走它，能带登录态；QQ 语音要的 SILK 编码也在它上面做。",
  "GitHub：只读访问 " + (env.GITHUB_ORG || "OmnixSI") + " 组织的仓库。",
  "其他数据源：腾讯行情（A 股、港股、美股）、fxtwitter（单条推文）、X 的网页接口（搜索，用保存的登录）、百度和 Hacker News 的公开接口、GitHub Trending。",
  "QQ 官方机器人接口：长连接收消息，HTTP 接口发消息和上传图片、语音、文件。",
];

const STORAGE = "都在 Hub 自带的 SQLite 里：全部聊天记录、长期记忆文档、白天的随手笔记、每日小结、定时任务、群内账本、我发过的图和保存的形象参考图、各站点的登录态、每一轮的耗时和用了哪些工具。没有用外部数据库。";

const MEMORY = [
  "长期记忆是一份文档，每轮都放在提示词里：群友、项目、梗和黑话、大家对我的要求、我的教训、惦记的事。每晚 04:30（悉尼）用 max 推理读当天聊天重写一遍。",
  "白天有人立规矩、纠正我或说了值得记的事，我用 remember 立刻记一条，当晚并进长期记忆。",
  "每轮我能直接看到昨晚整理之后的全部聊天，再加整理之前的 150 条；更早的靠 search_history 和 get_history 翻原始记录。",
];

const DRAWING = [
  "第一步揣摩意图：读原话和上下文，弄清这张图给谁、干什么用、指的是谁。",
  "第二步找参考：保存过的形象参考图，加上上网搜画面里每个具体对象的真实长相（搜到页面后从页面或 GitHub 素材库里取图）。",
  "第三步设计：用 max 推理看着全部参考图，定主体、构图、风格、图中文字、尺寸和质量，挑出真正相关的参考图，写出提示词。",
  "第四步出图：有参考图就把参考图一起交给图像模型保持长相（改图接口），没有就直接生成。成品存一份并编号（如 g12），之后可以拿编号接着改。",
];

const CODE_MAP = [
  "仓库 OmnixSI/TeamAgent，代码在 v2/ 目录，被问到具体实现就用 github 工具读对应文件再回答，报出文件名和关键逻辑：",
  "v2/src/persona.ts 人设、说话方式、什么时候开口、干活规矩",
  "v2/src/core.ts 一轮对话：拼上下文、推理档位、工具循环、出话",
  "v2/src/tools.ts 全部工具的定义",
  "v2/src/sites.ts 各站点读取（B 站、小红书、知乎、热榜、行情、X）和语音合成",
  "v2/src/draw.ts 画图四步、找参考图、Python 沙箱",
  "v2/src/hub.ts Durable Object：长连接、存储、发送、定时、夜间整理、管理接口",
  "v2/src/memory.ts 夜间记忆整理和图片配文",
  "v2/src/qq.ts QQ 接口和消息解析",
  "v2/src/self.ts 这份自述",
  "v2/src/config.ts 我能自己改的参数和做法说明的范围",
  "relay/ 香港中转（站点转发和 SILK 编码）",
];

const CANNOT = [
  "抖音单条视频读不了（只有热榜）。",
  "群友发的语音靠 QQ 自带的转写，QQ 没给转写的那几条我听不到。",
  "需要登录的站点（B 站字幕、小红书、知乎、X 搜索）靠保存的登录，过期了就读不了，要群主重新登录。",
  "不能改代码、不能部署、不能操作任何人的电脑；仓库只读。",
  "不会主动找人私聊。",
  "画知名版权角色可能被图像模型拒绝。",
  "QQ 的 Webhook 方式用不了（腾讯访问不到 workers.dev），所以用的是长连接。",
];

const SELF_EDIT = [
  "我能自己改的（立刻生效，可撤销，每次留记录）：一批有上下限的参数、三段做法说明（人设补充 / 画图 / 跑代码）、别人叫我的名字。用 self_update。",
  "我不能自己改的：代码逻辑——收发消息、存储、安全边界、工具本身的实现。这类只能用 self_update 的 propose_code 写成改进提议，等维护代码的人处理。",
  "谁能让我改：群主说的直接生效；其他人提的先记成提议，群主同意后生效。",
  "做法：先看现状和源码、能复现就复现，找到原因再动手；一次只改一处；改完验证一次；说清改了什么、怎么撤销。",
];

export function selfCard(env: Env, tools: Tool[], status: LiveStatus, selfEdit?: any) {
  return {
    notice: "这是你自己的真实情况，回答“你怎么实现的、接了什么、能做什么”时照这个说，别凭印象补。不要说出任何密钥、登录信息或管理接口地址。",
    how_a_message_flows: PIPELINE,
    connected_services: CONNECTED(env as any),
    storage: STORAGE,
    memory: MEMORY,
    drawing: DRAWING,
    capabilities: tools.filter(t => t.name !== "about_self").map(t => t.name + "：" + (t.description.length > 130 ? t.description.slice(0, 130) + "…" : t.description)),
    cannot_do: CANNOT,
    self_iteration: SELF_EDIT,
    ...(selfEdit ? { self_edit_state: selfEdit } : {}),
    source_code: CODE_MAP,
    live_status: { build: BUILD, ...status },
  };
}
