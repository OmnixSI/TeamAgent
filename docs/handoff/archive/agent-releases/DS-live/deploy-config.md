# DS-live 配置落地：runner DeepSeek key + media 服务 + Worker OPENAI_API_KEY

> 2026-11-14 13:52 Sydney · 交付员
> 范围：只做配置。没有改仓库代码、没有部署 Worker 代码、没有发群、没有写线上业务数据（只按主程指令写了一条 settings `off:image_gen=1`）、没有调用 OpenAI。
> 证据：本文件与下列命令输出（所有检查只打印“有/无”、长度、名字、状态，不打印密钥值）。

## 1. 结论

- **runner / qq / media 已能读到 DeepSeek key**：`readKey({})` 返回 35 字符；用该 key 请求 `GET https://api.deepseek.com/models` 返回 **HTTP 200**。
- **`com.inkboard.team-media` 已加载并在跑**：`runs=4`、`last exit code=0`；`media-error.log` 本次无新增、无 auth 错误。
- **Worker secret 已有 `OPENAI_API_KEY`**：secret 名单共 7 个；`/health.release` 仍是 `41db2b5…`（只改 secret，没换代码版本）。

## 2. DeepSeek key（本机 runner）

### 2.1 来源

1. 先按 `credential_id=deepseekApiKey` 请求：返回 **already configured**（当时没有 file 交付路径）。
2. 再按 label「DeepSeek API key」+ `delivery=file` 请求，生成安全卡；13:51 保存后交付文件：`.openmausbot-secrets/c1613f5d-894e-4534-a9f3-840eb5d66a8c/1dcf6043-5647-4489-88a4-8c3e5deff8fa`（24 小时有效）。
3. 该文件为 35 字符，SHA-256 前 8 位 `334df5d6`，与本机 `~/.inkboard-team/worker-secrets.json` 的 `DEEPSEEK_API_KEY` **完全相同**；`/models` 返回 HTTP 200。因此已落盘的 0600 副本无需替换（同一把 key），只是来源确认为 Vault 交付文件。

### 2.2 落盘与权限

- 文件：`/Users/yanghongming/.inkboard-team/secrets/deepseek-api-key`
- 权限：`-rw-------`（0600），36 字节（35 字符 + 换行）；目录 `drwx------`（0700）
- 没有进入仓库、没有写进日志或聊天；仓库 worktree `git status` 干净。

### 2.3 读取方式（先 rg 确认过）

`runner/deepseek-client.mjs` 的 `readKey()` 顺序：`options.keyFile` → `DEEPSEEK_API_KEY_FILE` → `DEEPSEEK_API_KEY` → `config.deepseek.key_file`。
选 **`DEEPSEEK_API_KEY_FILE`**，不改仓库 `config/team.json`。

### 2.4 plist 与服务重启

`DEEPSEEK_API_KEY_FILE` 已写入三个 plist 的 `EnvironmentVariables`：

- `com.inkboard.team-qq.plist`
- `com.inkboard.team-runner.plist`
- `com.inkboard.team-media.plist`

旧 plist 备份：`/Users/yanghongming/Projects/.agent/releases/DS-live/plist-backup/`。

另外把 `deepseek.key_file` 写进了 `~/.inkboard-team/config.json`（0600，只打印了是否有该字段）：`install-local.py --apply` 每次会重写 media plist 的 `EnvironmentVariables`，靠这一项 media 在下次部署后仍能拿到 key；`sync-runtime-secrets.py` 与 `install-local.py` 都只增改自己的字段，会保留它。

重启结果：

| 服务 | 状态 | PID |
|---|---|---|
| qq | running | 21342 |
| runner | running | 22050 |
| media | loaded，60 秒定时单次 worker；runs=4，last exit 0 | 运行瞬时才有 |

日志：`qq-error.log` 0 字节、`runner-error.log` 0 字节；`media-error.log` mtime 仍为 02:15（本次无新增）。qq.log 末尾为 `QQ gateway resumed`（13:48 Sydney）。所有相关日志里 `sk-` 形状的匹配计数为 0。

### 2.5 验证命令（只显示有无/长度）

```bash
DEEPSEEK_API_KEY_FILE=/Users/yanghongming/.inkboard-team/secrets/deepseek-api-key \
  node --input-type=module -e "import {readKey} from './deepseek-client.mjs'; const k=readKey({}); console.log(k?'key present':'key missing','len='+k.length)"
# key present len=35

# GET https://api.deepseek.com/models → HTTP 200（只打印状态码）
```

## 3. media 服务

- launchd：`gui/501/com.inkboard.team-media` 已加载。
- 设计说明：`media.mjs` 是**每 60 秒跑一次的单次 worker**（plist `StartInterval=60`，无 `KeepAlive`），跑完即退出；所以两次运行之间 `state = not running` 是正常的，`runs=4 / last exit 0` 证明它已按新环境执行。
- launchd 环境里已见 `DEEPSEEK_API_KEY_FILE => /Users/yanghongming/.inkboard-team/secrets/deepseek-api-key`。
- 7 个服务：qq / fetch / runner / utility / utility-quick / owner 常驻 **running**；media **已加载 + 定时运行**（合计 7 个已加载）。

## 4. Worker `OPENAI_API_KEY`

- 令牌来源：Vault「OpenAI-api」交付文件；Cloudflare 令牌用「Cloudflare API token（TeamAgent 部署用）」交付文件。两者都只在命令环境/标准输入里过一遍，没有打印、没有落盘。
- 命令（worktree @ main `41db2b5`，wrangler 4.159.0）：

```bash
tr -d '\n' < "$OPENAI_KEY_FILE" | npx wrangler secret put OPENAI_API_KEY
# ✨ Success! Uploaded secret OPENAI_API_KEY
```

- `wrangler secret list`（只显示名字）：`ADMIN_TOKEN DEEPSEEK_API_KEY GITHUB_TOKEN OPENAI_API_KEY QQ_APP_ID QQ_APP_SECRET RUNNER_TOKEN`。
- `/health`：`release` 与 `selfCard.commit` 均仍为 `41db2b52ebddd4eb1f46871e9d260ef504da8dc3`，说明本次只改 secret，**没有换代码版本**。
- 没有用 OpenAI 做任何调用（生图/识图自检留给测试员）。

## 5. F8 image_gen 默认行为与处置

- `off:image_gen` **未设 = 开**（`src/tools/generate-image.ts:273-277`）；`generate_image` 已在 `EXTRA_TOOLS` 里（`src/tools/index.ts:25`），**所有群回合都能调用，没有按 key 是否存在来隐藏**。
- 现在 `OPENAI_API_KEY` 已配，所以**下一条群里的生图请求就会真的调用 gpt-image-1 并扣费**，不再 auth 失败。
- 现有护栏：
  - 一回合最多一张（`image_gen_log` 的 pending/ok 去重）；
  - 每成员 5 张 / 24h（`DEFAULT_USER_DAILY`），每群 20 张 / 24h（`DEFAULT_GROUP_DAILY`）；
  - `off:openai` 总开关（`src/openai.ts:288`）；
  - OpenAI 全用途日预算默认 `3_000_000 µUSD = $3`（`OPENAI_DAILY_CAP_MICRO_USD`，悉尼 0 点重置）；
  - 夹带外部资料（`isTainted`）直接拒绝；
  - 每次调用写 `image_gen_log` 审计。
- 成本估算：low 1024×1024 ≈ **11,000 µUSD（$0.011）** + prompt 字节 × 5 µUSD；portrait 约 16,000 µUSD；medium/high 更高。
- **结论/建议：先设 `off:image_gen=1`，直到测试员验收通过再放开。** 理由：这个开关只挡 `generate_image` 工具，**不挡 owner 的 `/api/team/imagegen/selftest`**（自检直接走 `callOpenAi`），所以测试照常可做；验收后删掉该 setting 即可。
- **2026-11-14 13:57 已按主程指令写入 `off:image_gen=1`**（`INSERT … ON CONFLICT DO UPDATE`，changes=1，读回 value=1），生图工具对群关闭；owner 自检不受影响。回滚：`DELETE FROM settings WHERE key='off:image_gen'`。

## 6. 回滚

1. **runner/qq/media 的 DeepSeek key**
   - 恢复 `plist-backup/` 里的三个 plist（或 `PlistBuddy -c "Delete :EnvironmentVariables:DEEPSEEK_API_KEY_FILE" <plist>`）；
   - `launchctl bootout gui/501/<label>` → `sleep 3` → `launchctl bootstrap gui/501 ~/Library/LaunchAgents/<label>.plist`；
   - 从 `~/.inkboard-team/config.json` 删掉 `deepseek.key_file`；
   - 可选：`rm ~/.inkboard-team/secrets/deepseek-api-key`。
2. **media 服务**：`launchctl bootout gui/501/com.inkboard.team-media`（保留 plist，可再 bootstrap）；或 `python3 scripts/install-local.py --remove-media`。
3. **Worker secret**：`CLOUDFLARE_API_TOKEN="$(cat <cloudflare令牌文件>)" npx wrangler secret delete OPENAI_API_KEY`；或设 `off:openai=1` / `off:image_gen=1` 立即停用（secret 保留）。

## 7. 未验证 / 局限

- 没有跑真实 ASR/TTS/media job（避免付费调用）；DeepSeek key 只验证到 `/models` 200 与 `readKey` 可读。
- 没有调用 OpenAI；生图与识图自检由测试员执行。
- 没有往群里发消息；线上 D1 只写了 `off:image_gen=1` 一条 settings。
- DeepSeek 的 Vault 交付文件 24 小时后自动删除；本机 0600 副本保留（与 Vault 值同一把 key）。
