# 读文档（docread）实机上线证据

- 时间：2026-11-14 16:36–16:50 Sydney（交付员）
- 施工单：主程「TeamAgent 读文档 docread 上线」，架构师 PASS `pkg/A2-zipguard` @ `1c68d0a`
- 结论：**已上线（本机 runner + 开关 + 公告）；Worker 代码相对线上无变化，未重新部署 Worker。**

## 1. 合并与 main

| 项 | 值 |
|---|---|
| 源分支 | `pkg/A2-zipguard` @ `1c68d0a` |
| 合并方式 | `git merge --no-ff`，无冲突（main 自 merge-base 后未改过 docread 4 个文件） |
| 合并提交 | **`0a16658`**（`Merge pkg/A2-zipguard into main (docread: PDF/DOCX/XLSX read-only, zip-bomb guard)`） |
| 推送 | `3a90a3d..0a16658  main -> main`；`git ls-remote` 已确认 `refs/heads/main = 0a16658` |
| 改动 | `runner/docread.py`、`runner/docread-job.mjs`、`test/docread_test.py`、`test/docread-job.test.mjs`（+1368/−76），无 `src/` 改动 |

Worker 差异：`git diff 8c768b1..0a16658 -- src clients web migrations wrangler.toml package.json` 为空 → 线上 Worker 仍是 `8c768b1`，不触发重新部署。

## 2. 合并后门槛（集成 worktree `/Users/yanghongming/Projects/.worktrees/TeamAgent-V-D-release`）

- `npm run check`：**exit 0**（precheck 重新生成 self-card，无 diff）
- `npm test`：**2091 tests / 2081 pass / 0 fail / 10 skip**（32.1 s）
- `./.venv-runner/bin/python -m unittest discover -s test -p docread_test.py`：**62/62 OK**（34.2 s；openpyxl 3.1.5）
- 合并前 worktree 干净；`node_modules` 用 B-release 已有依赖；`.venv-runner` 是临时软链，未提交、已在收尾删除

## 3. 本机 runner 安装

`~/.inkboard-team/venv`（Python 3.14.5）补装：

| 包 | 版本 |
|---|---|
| python-docx | 1.2.0 |
| python-pptx | 1.0.2 |
| xlrd | 2.0.2 |
| reportlab | 5.1.0 |
| openpyxl | **3.1.5（保持，不升级）** |
| pypdf | 7.0.1（原有，未动） |

- 依赖版本与架构师验收用的 `A2-zipguard/.venv-runner` 一致（除 pypdf：验收用 6.21.4，线上原为 7.0.1，PDF 实测可读，未降级）。
- `python3 scripts/install-local.py --apply`：`runner 依赖自检通过：silk-wasm 可用`；`~/.inkboard-team/docread.py` 与仓库同哈希 `733d1825c8d721268e55653a657afbca19974b713a2cd1a8dea82f9c1243be6e`，`docread-job.mjs` 同哈希 `125c3d06…`。
- `launchctl kickstart -k gui/$(id -u)/com.inkboard.team-fetch` → `state = running`、`pid = 12969`；`fetch.log` 有 `fetcher start c829984fc17a`，无 `docread worker stopped`、`fetch-error.log` 为空。

## 4. 实机只读验证

### 4.1 三种文件（合成夹具 → 真实 `runner/docread.py` 通路）

夹具在 `/tmp/docread-live`，用后已删。调用方式与生产一致：`python docread.py --path <file> --root <dir> --json`。

| 文件 | 大小 | 结果 | 读回内容 |
|---|---|---|---|
| `live.pdf` | 1,362 B | `ok=true kind=pdf pages=1` | `LIVE-PDF-MARKER-1636` |
| `live.docx` | 36,702 B | `ok=true kind=docx` | `LIVE-DOCX-MARKER-1636` + 第二段正文 |
| `live.xlsx` | 5,364 B | `ok=true kind=xlsx sheets=2` | `LIVE-XLSX-MARKER-1636`、A2=42、第二表 `sheet2 文本` |

### 4.2 完整作业通路（真实 https 下载 → 临时目录 → docread.py → 回传）

直接调用生产消费者 `runDocJob`（`runner/docread-job.mjs`），不经过群、不入队：

| 公网 https 文件 | 结果 | 证据 |
|---|---|---|
| `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf` | `success=true`，`ok=true kind=pdf`，13264 B | 正文 `Dummy PDF file` |
| `https://calibre-ebook.com/downloads/demos/demo.docx` | `success=true`，`ok=true kind=docx`，1,311,881 B | 正文 `Demonstration of DOCX support in calibre…` |
| `https://go.microsoft.com/fwlink/?LinkID=521962` | `success=true`，`ok=true kind=xlsx`，83,418 B | `Sheet1` 表头 Segment/Country/Product… |

三次 `cleanup={"residue":0,"paths":[]}`，临时目录无残留。

### 4.3 炸弹 / 超大拒绝

| 夹具 | 结果 |
|---|---|
| `bomb.docx` 5.9 MB：`word/document.xml` 单标签 250 万个属性（解压约 28 MB） | `ok=false error_kind=too_large`，「单个标签或文本节点超过 4 MiB，不解压」 |
| `big.pdf` 53,477,376 B（51 MiB） | `ok=false error_kind=too_large`，「超过上限 52428800」 |

### 4.4 真实 QQ 附件回放（未完成，原因如下）

- `message_meta` 全表查询：**0 条** pdf/docx/xlsx/pptx 附件；群里从未发过文档类文件。唯一真实附件是 2026-11-14 12:37–12:39 的两张图片。
- 取最近一条真实 QQ 图片附件（`F6B41C64…jpg`，115,455 B）回放：
  - `docUrl` 校验：`https` 接受、同 URL 改 `http` 拒绝；
  - 实际 HTTP：**400**（QQ CDN `rkey` 已过期，文件 254 字节的下载链接）；4 小时前的链接即失效；
  - `runDocJob` 结果 `success=false reason=download_failed`，`cleanup residue=0`（失败路径也清理临时目录）。
- 因此「用真实 QQ 文件消息读回文档」这一项没有可用的真实样本，未验证；下载/解析/清理通路已用 4.2 的公网 https 文件验证。

## 5. 开关

```sql
INSERT INTO settings(key,value) VALUES('docread:enabled','1')
ON CONFLICT(key) DO UPDATE SET value=excluded.value;
```

- `changes=1`；读回 `{'key':'docread:enabled','value':'1'}`。
- 线上 Worker `8c768b1` 已含 `read_document` 与本开关判断（`src/tools/read-document.ts:214-220`），无需部署。

## 6. 公告

- 去重键 `release-notice:docread`，outbox **rowid 297**，2026-11-14 16:43:57 Sydney 入队。
- 正文：「群里发的 PDF、Word、Excel 我现在能读了：发上来直接问要哪一页、哪个表，我按原文回答。文件只读，我不会改。」
- 只入出站队列，未动游标、未写其他表；同键仅 1 行。
- 发送复核：2026-11-14 16:47 Sydney，`status=sent`、`msg_id=null`、`outbox_attempts.http_status=200`；同键仅 1 行。

## 7. 回滚

1. 立即止血：`settings.docread:enabled = 0`（工具变回「本机读取端没有开启」，不读文件）。
2. runner 回到上一版：在任一 worktree `git checkout 3a90a3d` → `python3 scripts/install-local.py --apply` → `kickstart com.inkboard.team-fetch`；或从 `3a90a3d` 取 `runner/docread.py`、`runner/docread-job.mjs` 覆盖 `~/.inkboard-team/` 后重启 fetch。
3. Worker 未变（`8c768b1`），无需 Worker 回滚；main 如需回退用 `git revert 0a16658`。

## 8. 未验证 / 遗留

- 真实 QQ 文档文件回放（无样本，见 4.4）；QQ 附件链接 4 小时即 400，等群里真发一份 PDF/Word/Excel 才能补这一项。
- 未在真实群里发测试消息（按约定不往群里发测试消息）；公告由出站队列正常发出。
- `.xlsm`、多 worksheet 合计 >48 MiB 的显式用例仍未单独造（架构师验收已注明）。
