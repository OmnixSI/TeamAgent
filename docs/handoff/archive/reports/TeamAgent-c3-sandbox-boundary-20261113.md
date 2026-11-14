# C3 沙箱边界冲突：交架构师定规则（2026-11-13）

**结论：凭据 deny 已补，但整目录 `file-read*` 拒绝会阻断真实 DSH 的祖先路径解析；按 BINI 指令停止该项，不自行放宽。** `READER_VERIFIED=False`，只保留方案 B；无生产凭据、真实模型调用或部署。

## 发生冲突的规则

worktree：`/Users/yanghongming/Projects/.worktrees/TeamAgent-cap-c3`，分支 `agent/cap-c3-runner`。本批父提交为 `4579d7ae5e8a5400e6219cd6341d3570fcd02b79`；独立修复的新增提交与验证结果另见交付回报，P1-1 仍待规则修订。

```scheme
(deny file-read* (subpath "/Users/yanghongming/.openmausbot"))
(allow file-read* (subpath "/Users/yanghongming/.openmausbot/tools/npm"))
```

第一条覆盖文件内容与元数据读取。第二条只允许后代安装目录，未让 Node 对祖先 `.openmausbot` 的 `lstat/realpath` 检查通过。旧版只拒绝已存在的一级子目录，因而漏过一级凭据文件；不能恢复旧规则解决启动问题。

## 已做的实测

- 规则使用**真实 HOME** 生成；子进程使用临时 HOME、DSH_HOME、TMPDIR、合成仓库与专用精简 patch，环境不带生产模型 key 或 runner token。
- 真实安装的 DSH 运行 `--profile headless --patch <临时 patch> --dump-config`，以及同配置 `--help`，**均 exit 1**，不是 exit 71；都在模型调用前失败：

```text
Error: EPERM: operation not permitted, lstat '/Users/yanghongming/.openmausbot'
at Object.realpathSync (node:fs:2760:29)
at toRealPath (node:internal/modules/helpers:65:13)
Node.js v26.0.0
```

- 合成 `.openmausbot` 一级凭据文件、`.dsh/.credentials.yaml`、`qq-session.json` 的读取已被拒绝；合成安装目录文件可读。45 项本机测试全过、无跳过，包含复核环境因嵌套 sandbox/ps EPERM 失败的原有用例。
- 上轮成功的配置加载使用合成 HOME 生成规则，真实安装不在那一 deny 路径下；它不能证明当前“真实安装 + 真实 HOME 规则”可启动。
- 原始证据：worktree 下 `.agent/c3-review-step0.json`；其 `root` 指向临时 stdout/stderr 目录。未做权限例外探针，未读取真实凭据内容。

## 建议的规则方向（仅供架构师决定，尚未实现或验证）

优先保留整个 `.openmausbot` 的内容读取拒绝与仅 `tools/npm` 安装内容可读的边界；考虑只对安装路径的**必要祖先目录**允许 `file-read-metadata`，或拆分内容/元数据规则，避免向整个 HOME 开放元数据。`.dsh/.credentials.yaml`、`qq-session.json` 及明确的 browser/secrets 路径继续拒绝。

对 P1-1 的影响：若只开放必要祖先的 stat/realpath，而凭据文件内容与私有目录仍不可读，可以兼顾 DSH 入口解析与防泄露；但目录枚举、文件名/属性暴露范围及 SBPL 规则优先级须由架构师写明，并通过真实 DSH 启动、合成凭据拒读和目录遍历探针共同验证。不能只凭“可启动”认定安全，也不能把配置转储当成真实工具事件验收。

**独立修复已完成**：P1-2 改为精确敏感路径，三种合法源码文件均可读；P2 的 `~` 展开与 worktree 边界、reader patch 原子发布、两处 marker glob→stat 容错均已有先红后绿测试。当前严格 deny 不动，P1-1 标记为“待沙箱规则修订”，真实工具表与 S-26(g)(h) 仍待现场核。
