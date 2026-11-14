// What the bot knows about itself. The capability list is generated from the tools that are actually
// registered and the status comes from the running Hub, so neither can drift from reality. The prose
// below has to be kept true by hand: when the architecture changes, change it here in the same commit.
import type { Tool } from "./core.ts";
import type { Env } from "./util.ts";

export type LiveStatus = {
  build: string; deployed: string; running_jobs: string;
  gateway_connected: boolean; messages: number; saved_images: number; saved_characters: string[];
  schedules: { when: string; task: string }[]; logins: string[]; memory_chars: number; notes_today: number;
  last_24h: { kind: string; turns: number; avg_seconds: number }[]; last_memory_consolidation: string | null;
};

const PIPELINE = [
  "运行位置：整套跑在 Cloudflare Workers 上（Worker 名 teamagent）。核心是一个 Durable Object，代码里叫 Hub，它常驻持有和 QQ 的官方长连接（WebSocket 网关）。没有任何程序跑在群主的电脑上。",
  "收消息：QQ 通过长连接把群消息推给 Hub。Hub 解析出文字、@、引用、图片、语音（QQ 自带转写文字；没带的我自己把录音转成文字）、视频、文件、分享卡片，存进它自带的 SQLite。群友发的图片和文件会立刻另存一份（QQ 给的链接会过期），所以之后还能拿编号引用。",
  "攒一下再看：被 @ 或被叫到等 0.35 秒，普通闲聊等 2.2 秒，把连发的几句合成一轮，最多等 6 秒。",
  "一轮对话：同一个模型（DeepSeek 的 deepseek-flash）读到人设、长期记忆、昨晚整理之后的全部聊天记录、新消息里的图片，自己决定不说话、直接回、还是调工具。没有单独的“判定模型”和“嘴替模型”。",
  "推理档位：没人叫我时先不思考地看一眼，约一秒决定接不接；只要开口回话就用 high；用了查资料、跑代码这类干活的工具之后用 max。",
  "工具循环：一轮最多 8 次往返，同一次里的多个工具并行跑，结果原样交回模型；工具带回来的图片我能直接看到。说“已经做了”只认工具的真实返回。",
  "发消息：走 QQ 官方接口，能发文字、图片、语音（SILK 格式）、文件。只有一个人找我、而我回的时候群里又有人说了新的话，第一条回复会自动引用他那条消息（这是代码自动做的，我自己控制不了引用谁）。回复要挂在最近约 5 分钟内的一条群消息上，每条最多挂 5 条；挂不上就试着主动发，发不出去（文字、图片、文件都一样）就排队，等下一个人说话时带出去。",
  "大活：需要多步的成品我先调 plan 定步骤，之后可以连续做最多 30 步、全程最高推理；中间素材（图、图表、数据文件）存成编号不发群，最后合成一件成品。",
  "后台任务：计划好的大活、做书、定时任务都是后台任务，不占着群聊，期间照常聊天。每个任务有编号和记录（做到第几步、成功还是失败），用 jobs 能查能叫停。每做完一步就存一次进度，进程重启后会从上一步接着做（最多接两次），做书已经画好的页不会重画；实在接不上会在群里说明没做完。定时任务失败也会在群里说。",
  "自己醒：Hub 每 20 秒醒一次，检查长连接、跑到点的定时任务；每天悉尼时间 04:30 把当天聊天整理进长期记忆；每天北京时间 10:30 自检一次（GitHub 令牌、各站登录、DeepSeek 余额、昨天花费、Cloudflare 套餐用量），有新问题才在群里说。部署新版本后它会自己发现版本变了并重启换上。",
];

const CONNECTED = (env: Env & { CODE_MODEL?: string }) => [
  "DeepSeek（主力）：对话和识图都用 " + (env.CHAT_MODEL || "deepseek-flash") + "；另外用它的联网搜索、网页抓取、服务端多轮联网调研、文档识别（OCR）、语音合成、余额查询。",
  "OpenAI：画图和改图（" + (env.IMAGE_MODEL || "gpt-image-2.5-flare") + "）、长音频转文字（gpt-4o-mini-transcribe，B 站无字幕视频用）、Python 代码沙箱（" + (env.CODE_MODEL || "gpt-6-luna") + " 带代码解释器；沙箱按 20 分钟一个会话收费，期间多次运行共用一个）。",
  "Cloudflare 的无头浏览器：把文档（Markdown）、思维导图、Mermaid 图和自定义网页渲染成图片和 PDF 发到群里；别的办法读不出来的动态网页用它真打开，也能给网页截图。",
  "云电脑：Cloudflare 上的一台 Linux 容器（Debian，1 核 1 GB 内存），要用时才开机、闲置 3 分钟关机并清空。里面有 ffmpeg、git、Python、Node、中文字体，LibreOffice 按需安装。用来处理视频和音频、克隆仓库看代码跑测试、做 PPT 和 Word。看视频（watch_video）就是在它里面把视频取下来、抽声音、截帧，声音再转成文字。",
  "香港中转：部署在 Vercel 香港的一个带密钥的小函数。B 站接口、小红书、知乎、微博、抖音这些拒绝 Cloudflare 出口地址的站点走它，能带登录态；QQ 语音要的 SILK 编码也在它上面做。",
  "GitHub：只读访问 " + (env.GITHUB_ORG || "OmnixSI") + " 组织的仓库。",
  "其他数据源：腾讯行情（A 股、港股、美股）、fxtwitter（单条推文）、X 的网页接口（搜索，用保存的登录）、百度和 Hacker News 的公开接口、GitHub Trending。",
  "QQ 官方机器人接口：长连接收消息，HTTP 接口发消息和上传图片、语音、文件。",
];

const BOOKS = "我给自己记账：每次调 DeepSeek 和 OpenAI，都把 token 数、次数和按官方价格估的花费按天、按用途记下来（聊天、画图构思、画图、跑代码、联网调研、搜索、抓网页、语音合成、文档识别、音频转写、夜间记忆整理）。DeepSeek 另外每天记一次账户余额，用余额变化对账。用 usage 工具查。OpenAI 的真实账单我查不到，只有估算。";

const STORAGE = "主要在 Hub 自带的 SQLite 里：全部聊天记录、长期记忆文档（最近 14 天每晚的旧版本也留着）、白天的随手笔记、每日小结、定时任务、后台任务记录、群内账本、各站点的登录态、每一轮的耗时、每次工具调用的耗时和成败。图片和文件：我画的图（连同当时的提示词和参考图）、保存的形象、表情包、群友发的图和文件（留 45 天）；1.5MB 以内的在 SQLite，更大的放 Cloudflare R2。";

const PLAN_NOTE = "Cloudflare 是每月 5 美元的固定套餐。套餐里按量的东西我自己计数、到停止线就停，不会产生额外费用：无头浏览器每月 10 小时（用到 8.5 小时停）、云电脑每月 25 小时运行时间和 375 分钟 CPU（用到 20 小时或 300 分钟 CPU 停）、R2 存储 10GB（存到 8GB 停）。常驻 QQ 长连接让我 24 小时在线，这一项固定占掉套餐在线时长的八成多。用 usage 能看到每项用了多少。";

const MEMORY = [
  "长期记忆是一份文档，每轮都放在提示词里：群友、项目、梗和黑话、大家对我的要求、我的教训、惦记的事。每晚 04:30（悉尼）用 max 推理读当天聊天重写一遍。",
  "白天有人立规矩、纠正我或说了值得记的事，我用 remember 立刻记一条，当晚并进长期记忆。",
  "每轮我能直接看到昨晚整理之后的全部聊天，再加整理之前的 150 条；更早的靠 search_history 和 get_history 翻原始记录。",
  "每晚整理时会对照我现在实际有的能力，把过时的规矩（说我做不到、让我用已经不存在的东西）删掉；整理结果比原来短一半以上会被当成出错不采用。某条记忆要作废，用 forget 可以当场从长期记忆里删掉。",
];

const DRAWING = [
  "第一步揣摩意图：我（看得到全天聊天的主模型）在调画图工具时写明这张图给谁、干什么用、指的是谁，并列出哪些对象要先查长相。",
  "第二步找参考：保存过的形象参考图（原话里提到名字的会自动带上），加上上网搜画面里每个具体对象的真实长相（搜到页面后从页面或 GitHub 素材库里取图）。",
  "第三步设计：用 max 推理看着全部参考图，定主体、构图、风格、图中文字、尺寸和质量，挑出真正相关的参考图，写出提示词。",
  "被拒时：图像接口拒了某一版，会带着它给的原因重新设计一版离原意最近的再画，最多三版；改过的版本会说明哪里不一样。",
  "尺寸和清晰度：群友没要求时用 1024 级别的平常规格；提了 2K、4K、具体分辨率或比例就照着传给接口，最高 4K（3840x2160），越大越贵越慢。",
  "第四步出图：有参考图就把参考图一起交给图像模型保持长相（改图接口），没有就直接生成。成品存一份并编号（如 g12），连同当时的原话、提示词和用了哪些参考图一起存，之后可以拿编号接着改。",
];

/** Where the source lives in the repository. */
const DIR = "src/";
const CODE_MAP = [
  "仓库 OmnixSI/TeamAgent，被问到具体实现就用 github 工具读对应文件再回答，报出文件名和关键逻辑：",
  DIR + "persona.ts 人设、说话方式、什么时候开口、干活规矩",
  DIR + "core.ts 一轮对话：拼上下文、推理档位、工具循环、出话",
  DIR + "tools.ts 全部工具的定义",
  DIR + "hub.ts Durable Object 主干：收消息、跑一轮、发消息、后台任务、时钟",
  DIR + "gateway.ts 和 QQ 的长连接",
  DIR + "store.ts 图片和文件的存取（SQLite 和 R2）、群图存档",
  DIR + "host.ts 工具能碰到的东西（按群、按提问的人）",
  DIR + "selfedit.ts 我能自己改的参数和做法说明、谁有权改",
  DIR + "config.ts 可改参数的范围",
  DIR + "accounts.ts 和 meter.ts 记账：价格表、每次调用的花费、余额对账",
  DIR + "budget.ts Cloudflare 套餐的月度额度和停止线",
  DIR + "health.ts 每日自检",
  DIR + "render.ts 无头浏览器：渲染成图、PDF、打开网页",
  DIR + "computer.ts 云电脑：容器的开机、装软件、跑命令、收发文件、计时",
  DIR + "sites.ts 各站点读取（B 站、小红书、知乎、热榜、行情、X）和语音合成",
  DIR + "draw.ts 画图：找参考图、设计、出图；Python 沙箱",
  DIR + "book.ts 做书：写故事定画风、逐页画插图、排版成 PDF",
  DIR + "show.ts 文档、思维导图、流程图、网页的排版模板",
  DIR + "memory.ts 夜间记忆整理和图片配文",
  DIR + "qq.ts QQ 接口和消息解析",
  DIR + "self.ts 这份自述",
  DIR + "admin.ts 管理接口",
  "relay/ 香港中转（站点转发和 SILK 编码）",
];

const CANNOT = [
  "看视频靠云电脑去取，站点拦截数据中心地址时会取不下来（B 站网页就是，所以 B 站走专门的 bilibili 工具）；抖音还没实测过。",
  "云电脑关机后里面的文件全部清空，隔一阵再用要重新放文件；每月有固定额度，用到停止线就停到下个周期。",
  "需要登录的站点（B 站字幕、小红书、知乎、X 搜索）靠保存的登录，过期了就读不了，要群主重新登录；每天自检会发现并在群里说。",
  "不能改代码、不能部署、不能操作任何人的电脑；仓库只读。",
  "不会主动找人私聊。",
  "画知名版权角色可能被图像模型拒绝。",
  "QQ 的 Webhook 方式用不了（腾讯访问不到 workers.dev），所以用的是长连接。",
];

const SELF_EDIT = [
  "我能自己改的（立刻生效，可撤销，每次留记录）：一批有上下限的参数、三段做法说明（人设补充 / 画图 / 跑代码）、别人叫我的名字。用 self_update。",
  "我不能自己改的：代码逻辑——收发消息、存储、安全边界、工具本身的实现。这类只能用 self_update 的 propose_code 写成改进提议，等维护代码的人处理。",
  "谁能让我改：群主，和群主授权过的人（现在是谁见 self_edit_state 里的 who_can_change），说了直接生效；其他人提的先记成提议，他们同意后生效。授权和收回只有群主本人能做。",
  "做法：先看现状和源码、能复现就复现，找到原因再动手；一次只改一处；改完验证一次；说清改了什么、怎么撤销。",
];

export function selfCard(env: Env, tools: Tool[], status: LiveStatus, selfEdit?: any, health?: any, features: { name: string; about?: string[] }[] = []) {
  return {
    notice: "这是你自己的真实情况，回答“你怎么实现的、接了什么、能做什么”时照这个说，别凭印象补。不要说出任何密钥、登录信息或管理接口地址。",
    how_a_message_flows: PIPELINE,
    connected_services: CONNECTED(env as any),
    storage: STORAGE,
    my_own_books: BOOKS,
    cloudflare_plan: PLAN_NOTE,
    memory: MEMORY,
    drawing: DRAWING,
    capabilities: tools.filter(t => t.name !== "about_self").map(t => t.name + "：" + (t.description.length > 130 ? t.description.slice(0, 130) + "…" : t.description)),
    added_abilities_and_how_they_work: Object.fromEntries(features.filter(f => f.about?.length).map(f => [f.name, f.about])),
    cannot_do: CANNOT,
    self_iteration: SELF_EDIT,
    ...(selfEdit ? { self_edit_state: selfEdit } : {}),
    source_code: CODE_MAP,
    live_status: status,
    self_check: health || "今天还没跑过自检；想现在查就调 about_self 并填 check=true",
  };
}
