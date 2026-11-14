# C1 PR #23 复核：a676a24（父 e659698）

结论：打回（不通过）。Codex 两条 P1 的原始症状已关闭；但恢复 system/global credential helper 后，仓库本地 `.git/config` 的 `http.proxy`/`http.sslVerify` 能把 helper 返回的凭据外带到攻击者代理（新的 P1）。

## 测试

- `/usr/local/bin/python3` 3.12.3：`PYTHONPATH=.:runner python3 -m unittest discover -s test -p '*_test.py'` → **94/94**；`test/gitsafe_test.py` + `test/repo_index_test.py` → **41/41**。
- 真实 401 探针：无 helper、或仅 repo 本地 general/URL-specific helper + `core.askPass` 时，`gitsafe.run(...,'fetch','--prune','origin')` 在 **0.05s** 内 `GitFailed`，本地 helper/askpass marker 均未生成。
- 套件内真实 HTTP server + 全局 helper：fetch 成功；本地 general 与 URL-specific helper 均未执行。
- 另写本地 MITM 代理探针，见下，复现 P1。

## P1（已用测试复现）

`runner/gitsafe.py:23-26,137`

- 触发条件：临时 HOME 的 `~/.gitconfig` 有
  `[credential "https://github.com"] helper = !/tmp/helper.sh`（返回固定 token）；
  repo（remote 为生产同款 `https://github.com/OmnixSI/TeamAgent.git`）的本地 `.git/config` 设
  `http.https://github.com.proxy=http://127.0.0.1:<port>` 与
  `http.https://github.com.sslVerify=false`。
- 复现：本地 CONNECT 代理对 `CONNECT github.com:443` 回 200，用自签 github.com 证书做 TLS，先回 401 `WWW-Authenticate: Basic` 触发 helper，再抓重试请求头。
- 结果：`gitsafe.run(root,'lifecycle','fetch','--prune','origin')` 失败，但代理收到
  `Authorization: Basic cmV2aWV3ZXI6U1VQRVJTRUNSRVQtVE9LRU4tMTIz`（`reviewer:SUPERSECRET-TOKEN-123`），即全局 helper 的真实凭据。
- 原因：PREFIX/环境固定了 `core.sshCommand`、`credential.helper`、`core.askPass`（GIT_ASKPASS）等，但没有固定仓库本地的 `http.proxy`/`http.sslVerify`；恢复 helper 后 fetch 首次带上了可被代理截获的凭据。
- 修法：对 `_matches_remote` 允许的四种远端，在 `-c` 中同时固定 `http.<url>.proxy=` 与 `http.<url>.sslVerify=true`（URL-specific 键会压过普通 `http.*`；同时考虑 `http.sslCAInfo`），并加“代理收不到 Authorization”的回归测试。

## P2

`runner/repo_index.py:62,72-73`：敏感键按子串 `key` 匹配且值不限长度。合成配置 `{"key":"a"}` 使 `const on = true;` → `c[REDACTED]st [REDACTED] = true;`；`{"hotkeys":{"save":"cmd+s"}}` 也会把 `cmd+s` 当密钥。生产 `config.json` 的 `url/adminToken/runnerToken/hub/sourceKey/repos/index` 中只有 adminToken/runnerToken/sourceKey 命中且均为长值，所以当前不阻塞；建议精确键名（`*token`、`*secret`、`password`、`*_key` 等）并设最小长度。

## 两条 Codex P1 的验收

- P1-1（私有 HTTPS 无认证通道）：关闭。system/global helper 被重放；本地 `credential.helper`（general 和 URL-specific）与 `core.askPass` 未执行；无 `safe.directory=*`；401 无凭据时 0.05s 失败不挂起。
- P1-2（adminToken 未脱敏）：关闭。`_config_secrets` 递归收集 config 中的 adminToken/sourceKey/嵌套 secret/cookie/access_token，`sync_once` 传入 patch/subject/body/author；新增测试断言整个上传 batch 不含裸值。

## 备注

- `config.json` 的全部字段已核对，未发现漏掉的密钥类字段；`worker-secrets.json` 的 `DEEPSEEK_API_KEY` 仍未进 known_values（`sk-` 正则可兜底），属既有取舍。
- 本提交不会回洗 D1 中已上传的旧行；若真实 token 曾在旧提交里入库，需按方案风险表手工删除污染行。
- worktree 未改；`git status` 仅有未跟踪的 `.agent/`。
