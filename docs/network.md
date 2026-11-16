# 网络

[← 回到 README](../README.md)

## 出网的三条路

有些站点拒绝 Cloudflare 的出口地址（B 站 412、微博 403、小红书跳登录）。`src/sites.ts` 按站点选路：

| 路 | 走这条的 | 说明 |
|---|---|---|
| 直连 | GitHub、百度、腾讯行情、X、B 站音视频 CDN、OpenAI、DeepSeek | Worker 直接请求 |
| 中转 | B 站接口、小红书、知乎、微博、抖音 | `relay/` 里一个带密钥的 Vercel 香港函数，只放行名单内的站点，能带登录 cookie |
| DeepSeek 抓取接口 | 不带登录的公开页面 | 兜底；再读不出来就用无头浏览器真打开 |

## 站点登录态

- 登录态存在 Hub 里（`cookie:<站点>`）。
- 用 `scripts/login-cookies.mjs` 刷新：在一个没有自动化标记的普通浏览器窗口里手动登录，脚本从本机调试端口读出 cookie 写进 Hub。不用带自动化标记的浏览器。
- 小红书在大陆以外会被它自己跳到 rednote.com，登录态取 rednote.com 的。
- 每日自检会看 B 站和知乎的登录是否还在，掉了会在群里说。

## 香港中转（`relay/`）

一个单独部署在 Vercel 香港区的小项目，三个函数：

| 文件 | 作用 |
|---|---|
| `relay/api/fetch.js` | 出口中转。要带 `x-relay-key`，只放行名单内的站点 |
| `relay/api/silk.js` | 把音频编码成 QQ 语音用的 SILK，以及解码 |
| `relay/api/site.js` | 页面镜像（见下） |

部署：

```sh
cd relay && npx vercel deploy --prod --yes
```

密钥 `RELAY_KEY` 是 Vercel 项目的固定环境变量（`npx vercel env ls production` 能看到），同一个密钥写进 Worker 的 `RELAY_KEY`。部署后务必验一下：带密钥的请求返回 200，不带的返回 401。密钥丢了的话，语音编码和国内站点抓取会一起失效。

## 香港镜像

`relay/api/site.js` 把 Bot 自己的公开页面原样转发：

```
https://relay-dusky-five.vercel.app/x/…  →  Worker 的 /x/…
https://relay-dusky-five.vercel.app/p/…  →  Worker 的 /p/…
```

- 给打不开 `workers.dev` 的网络用。看板、文件箱、发布的网页、本地 AI 的 MCP 地址都能走它。
- 只转发这两个前缀，管理接口不经过它。
- 经镜像上传最多 4 MB。
- 地址写在 `wrangler.toml` 的 `PUBLIC_URL_CN`；Bot 给链接时两个地址都给。
- `*.vercel.app` 在大陆是否稳定可达没有验证过。不行的话只剩自己的域名这一条路。

## 公开路由

Worker 上不带管理令牌就能访问的，除了 `/health`，只有 `/p/` 和 `/x/` 两个前缀，由功能模块的 `open` 提供：

| 前缀 | 内容 |
|---|---|
| `/p/<id>/` | 发布的网页、小游戏、托管的静态站 |
| `/x/board` | 团队看板（要个人链接） |
| `/x/mcp/<令牌>` | 本地 AI 的 MCP 接口 |
| `/x/toolbox` | 工具箱网页，全部在访问者的浏览器里运行 |
| `/x/…` 其他 | 文件箱的上传页和下载链接、大文件传输、限时预览 |

其余路径都要 `Authorization: Bearer <ADMIN_TOKEN>`，见 [运维](operations.md#管理接口)。
