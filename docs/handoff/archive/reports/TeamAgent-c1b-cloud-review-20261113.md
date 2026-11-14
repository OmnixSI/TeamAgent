# C1b v2 云端直读复核（working tree vs 210ed47）

结论：打回（P1 1 条；P2 3 条）。
测试：`node --test test/github.test.mjs` **38/38**；3 处变异（去掉 120000 分支、budget 10→100、`readFile` 去掉 `redactKnown`）分别使 T2/T3、T5、T10 变红；未跑全量 629。
P1 `src/repo.ts:19-33`：`redactPatch` 仍不处理 `Authorization: Bearer …` 与长 base64；探针 `Bearer opaque-token-…`、`c2Vj…` 原样返回，会进模型文本。方案 ③ 明确要求；补 Bearer/base64 规则并加测试。
P2 `src/repo.ts:20-31`：未闭合 `-----BEGIN PRIVATE KEY-----` 到 EOF 不脱敏（探针原样）；现有测试只测线性成本、未测泄漏，截断 PEM 会漏。
P2 `src/github.ts:11-15`：DENY `.git/*` 锚定全路径/文件名，`foo/.git/config` 不命中；read/list/find 可读嵌套 `.git`。
P2 `src/github.ts:32-36`：`validPath` 不归一化 `foo/./bar`、`%2e%2e`；只挡显式 `..`，编码变体未验证。
其余已核：symlink 走 git tree（120000 只回元信息、中间段 404）、私有门（5 白名单 + 非白名单 public 检查）、manual redirect 同源、预算 10/5s/8s/256KB/512KB、`repo_file` 0 D1、三工具 untrusted。
未验收：真实 GitHub 公开/私有、生产子请求/CPU、全量 629。

---

# C1b 4 条返工复核（2026-11-13 10:15）

结论：通过（P1/P0 无；P2 3 条）。
测试：`node --test test/github.test.mjs` **43/43**；`python3.12 repo_index_test` **37/37**；原探针重放：Bearer、长 base64、未闭合 PEM 均 `[REDACTED]`；`foo/.git/config`、`a/b/.git/HEAD` 均 denied；`foo/./bar` 归一化后 denied；`%2e%2e`/`%2E%2E`/重复斜杠/反斜杠/首尾空白均 invalid；短 base64、`src/key.ts`、`README.md` 正常。
变异：去掉 `parts.includes('.git')` → `review DENY protects every nested component` 红；去掉未闭合 PEM 分支 → `review truncated PEM redacts through EOF` 红。
P2-1 `deny_cases.json` 无嵌套 `.git`；Python `denied('foo/.git/config')` 仍 false（TS true），C1 本机/云端两端 DENY 有差；建议补夹具并同步 Python。
P2-2 `redactPatch` 的 Bearer 规则会把正文 “Bearer token” 也替换；≥128 且 4 倍长的普通标识符会被当 base64 脱敏；建议限定 Authorization 上下文。
P2-3 `validPath` 拒绝任何 `%xx`（含合法 `%20` 文件名）；如需字面 `%` 要放宽。
未验收：真实 GitHub/生产子请求、全量 629。

---

# C1b 三条 P2 修复复核（2026-11-13 10:20）

结论：通过（P1/P0 无；P2 3 条）。
测试：`node --test test/github.test.mjs` **47/47**；`python3.12 repo_index_test` **37/37**；原探针重放：`Authorization: Bearer` 脱敏、正文 `Bearer token` 不变、长 base64 脱敏/短 base64 保留、未闭合 PEM 仍脱敏；`foo/.git/config`、`a/b/.git/HEAD` 双端 deny；`%20` 保留，`%2e%2e`/`%2E%2E`/`%252e%252e`/`%2e./.%2E`、`%2f`/`%5c`/`%00`、`//`、`\`、首尾空白均拒；`repo:other/private` find 仍只读 cli/cli tree，无 `/search/code`，grep 为 `invalid_args`。
变异：恢复全量 `%` 拒绝 → `literal percent` 红；恢复 broad Bearer → `Bearer prose` 红。
P2-1 Python `denied` 仍按 full/base，TS 按 any part：`dir/secret.pem/notes.txt` Python false、TS true；TS 云端读安全，但本机索引可能把该内容写进 D1，建议 Python 同步 parts 判定。
P2-2 base64 规则要求同时含大小写和数字：128 位 hex/纯小写长随机串不脱敏；真实私钥 base64 通常满足，记录。
P2-3 `validPath` 拒绝字面 `%2f`/`%5c`/`%00` 文件名（放行 `%20`、`%2e` 等）；合法此类名会被拒，记录。
未验收：真实 GitHub/生产、全量 629。
