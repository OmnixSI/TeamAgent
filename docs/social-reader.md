# 社交平台只读读取（read_social / F9）

群里出现平台链接或明确提问时，`read_social` 只读地取标题、正文、作者、互动数和已加载评论；不登录平台、不批量抓取、不发布、不点赞、不关注。所有浏览器读取都在本机 runner 上完成，云端只拿筛选后的文本。

## 支持范围

| 平台 | 动作 | 需要登录 | 说明 |
|---|---|---|---|
| 小红书 | `read` / `search` / `comments` | 是（本机 Edge profile） | 正文必须带搜索返回的完整链接（含 `xsec_token`）；裸 `explore/<id>` 会被拒绝。评论只返回已加载的部分 |
| X / 推特 | `thread` / `profile` / `tweets` / `search` | 是（本机 Edge profile） | 走本机登录会话的 GraphQL，长推按 25k 字符上限保留；只读 |
| 雪球 | `quote` | 否 | 只读 `/S/<代码>` 行情，走腾讯行情并标注来源；社区热帖/搜索未接入（需雪球 Cookie，几小时过期） |
| 微博 | `hot` / `search` / `profile` | 否 | 公开页与公开 JSON；登录墙会返回 `login_required`，不绕过 |
| 知乎 | `hot` / `search` / `read` | 否 | 公开接口与页面；风控页返回 `platform_blocked` |
| 抖音 | `read` | 否 | 短链最多 6 次跳转；页面里取结构化详情，不下载音视频 |
| 微信公众号 | `read` | 否 | 只读公开文章页；删除/验证码分别返回 `not_found` / `platform_blocked` |
| B 站 | — | — | 保持原有 `fetch` 链路（标题、字幕、热评、音轨 ASR），不经过 `read_social` |

## 开关与冷却

默认关闭，先在 D1 打开总开关：

```sql
INSERT INTO settings(key,value) VALUES('reach:mode','on')
  ON CONFLICT(key) DO UPDATE SET value='on';
```

可用的运行时开关（`settings` 表）：

| key | 作用 |
|---|---|
| `reach:mode=on` | 总开关；缺失即关闭 |
| `off:reach=1` | 立即关闭全部平台读取（领取任务时也会跳过） |
| `off:reach:<channel>=1` | 只关某个平台，例如 `off:reach:xiaohongshu`；channel 取 `xiaohongshu`/`x`/`weibo`/`zhihu`/`douyin`/`weixin`/`xueqiu` |
| `reach:cooldown_ms` | 风控冷却时长，默认 1800000（30 分钟），范围 1 分钟–24 小时 |
| `reach:cooldown:<channel>` | 由 runner/Worker 写入的冷却截止，不要手改 |

登录平台在小红书账号登录完成前建议先关：`off:reach:xiaohongshu=1`。

## 一次性登录（团队在本机完成，不让成员点）

登录只写本机 profile，Cookie 不进入 D1、日志、PR 或群消息：

```sh
node ~/.inkboard-team/fetcher.mjs login xiaohongshu
node ~/.inkboard-team/fetcher.mjs login x     # 已登录可跳过
```

命令会打开一个可见的 Edge/Chrome 窗口，在该窗口完成平台登录，成功后窗口自动关闭，profile 留在
`~/.inkboard-team/browser/xiaohongshu/`、`~/.inkboard-team/browser/x/`（目录 0700）。五分钟未完成会自动关窗。

探活：X 只检查 `auth_token` 是否存在、不导出值；小红书检查 `web_session` 存在且页面不是验证码/登录墙。状态写到
`~/.inkboard-team/state/auth-<service>.json`，从 ok 变为过期/风控时只在本机提醒。

## 失败原因

工具只回这几类，`next_action` 说明下一步；不会把“成功但内容是错误页”当正文：

| error_kind | 含义 |
|---|---|
| `login_required` | 需要在该平台本机登录后重试 |
| `platform_blocked` | 验证码/风控，按站点冷却，换后端硬刷不会绕过 |
| `rate_limited` | 上游限流，带 `retry_after` |
| `timeout` | 超过 45 秒硬截止，进程组已回收 |
| `not_found` | 平台确认内容不存在 |
| `unsupported` | 链接/动作不在白名单，或小红书链接缺 `xsec_token` |
| `insufficient_content` | 取到了页面但不足以当正文（错误壳、空列表） |
| `upstream_unavailable` | 上游故障；不能据此判断未登录或已删除 |
| `tool_not_ready` | 组件未就绪或该平台开关关闭；查询不会自动安装 |
| `busy` | 浏览器/接口并发已满，稍后再试 |

返回契约：`{schema_version, ok, channel, action, backend, items[], meta.loaded, error, source_url, fetched_at, content_scope, completeness_verified, attempts[]}`；`content_scope` 区分 `post_text` / `search_results` / `loaded_comments` / `quote`，回答不能把检索摘要或已加载评论说成全文。

## 资源与清理

- 一次请求一个短命进程，最长 45 秒；浏览器全局 1 路、同站 1 路，普通接口 2 路，超出返回 `busy`。
- X 读取会在本机短暂打开一个 Edge 窗口（X 对 HeadlessChrome 返回 403），读完立即关闭；小红书同样用自己的 profile，不碰日常浏览器。
- 浏览器读完立即关闭自己启动的进程；不常驻 daemon、不装额外浏览器内核、不复制用户日常 Chrome 配置。
- 不下载音视频，临时文件为 0；登录 profile 是唯一持久化数据，换账号时删对应 `browser/<service>/` 即可。
- 风控冷却写在 `~/.inkboard-team/state/reach/cooldowns.json`（0600），过期自动失效。

## 回放与验收

```sh
npm run check && npm test
node scripts/f9-replay.mjs --cases /path/to/cases.json   # 只读，不发群、不写线上 D1
```

回放脚本直接调用 runner 适配器，逐条打印 `ok / error_kind / items / 耗时`；B 站链接走原有 `fetch` 链路的本地回放（cloud 用桩），不产生 QQ 发送。

## 回滚

1. D1 写 `off:reach=1`（最快，下一次领取即跳过）；
2. 或 `INSERT INTO settings VALUES('reach:mode','off')` 并在下一次发布移除工具；
3. 本机回滚 `python3 scripts/install-local.py --remove`（保留登录数据），或还原上一版 runner 文件后重启 `com.inkboard.team-fetch`。

## 边界

- 只读，不做发布/评论/点赞/关注/私信。
- 只按成员主动给出的链接或明确提问读取；不批量、不定时、不跨群抓取。
- 受平台服务条款和账号风控约束；被封控时按冷却停止，不换账号绕过。
- 小红书正文依赖签名链接，`xhslink.com` 短链必须展开成带 `xsec_token` 的完整链接，否则明确报 `unsupported`。
