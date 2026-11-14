结论：需修改（方案核查；未发现新增 P0/P1，以下为 P2 与验收缺口）。
测试：先读两份复核报告，再读方案、关键 diff 和调用方；未重复跑其已通过的 96 项测试；仅在 /tmp 做隔离探针，临时目录已自动删除，worktree 未改。
探针 A：Apple Git 2.39.5；空裸仓库显式 GIT_DIR，去掉 GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL；git config --show-origin --show-scope --get-all credential.helper 与普通环境输出完全一致，均发现 Apple 内置 osxkeychain。
探针 B：临时 HOME/XDG；用 GIT_EXEC_PATH 中的同名记录器替代 git-credential-osxkeychain，仅返回 synthetic-*；从恶意源仓库 cwd 执行 git credential fill，GIT_DIR 指向空裸仓库：rc=0，仅 get 一次，源仓库 helper/askPass marker 未生成；真实钥匙串未访问。
探针 C：逐条使用方案步骤 4 的过滤条件，再执行真实本地 git fetch --prune origin；目标含 ../ 或 *.lock 的 refspec 均被保留，fetch 均 rc=128；已用临时测试复现。
问题 P2：方案步骤 4/T9（:92-103/:128）→ runner/gitsafe.py:168：仅检查前缀和 * 数量不等于合法 refspec；非法条目导致整次 fetch 失败，repo_index.py:306-308 跳过索引。建议分别用 git check-ref-format --refspec-pattern 验证源/目标，明确仅解析一个可选 force 前缀，并补 ../、.lock、有效 force/通配符用例。
问题 P2：方案步骤 4/T9（:103/:128）→ runner/gitsafe.py:168、runner/repo_index.py:107：合法负向 ^refs/heads/tmp 被丢弃；探针中 tmp 被实际取回，违背源仓库排除规则且进入分支索引。建议保留合法负向规则，与有效正向规则一起交给 Git；修改 T9 的“负向一律丢弃”预期。
问题 P2：方案风险 2（:150）→ 拟新增 _lookup_credential（替换 runner/gitsafe.py:109）：弹窗风险不限于 GCM；osxkeychain get 调用 SecKeychainFindInternetPassword，钥匙串锁定时也可能弹解锁框；GIT_TERMINAL_PROMPT=0 和 GIT_ASKPASS 不控制此系统弹窗。应写明当前 Apple helper 也有此前提，不得把无弹窗作为已证实结果。
问题 P2：方案 V3/风险回滚（:137/:152）→ runner/gitsafe.py:164、:182：仅看一个 github.com 条目的修改时间不足以证明所有 helper 无副作用；git revert 代码也不会撤销已写入的源对象、refs/reflog。将保证收窄为“不向可信 helper 发送 store/erase”，用记录器断言 get-only，并写清对象和引用的持久化边界。
测试清单：T1 的路径计算在本机正确；通用配置对比应在 Linux/macOS 都跑，Apple 专项仅在相应文件存在且含 osxkeychain 时断言，否则明确 skip 原因，不能把整个 T1 跳过。
测试清单：现有 CI 是 .github/workflows/check.yml:15 的 self-hosted macOS，并非 Linux；T2/T3 的 HTTP 回环可跨平台。T1–T10 没覆盖 HTTPS CONNECT 的 TLS 攻击，V2 仍须单列证据；建议用合成凭据/临时证书跑 CONNECT 回归，不依赖真实钥匙串，缺 OpenSSL 时仅跳过该项并说明。
夹具核查：GIT_CONFIG_NOSYSTEM=1 在本机确实隐藏 Apple osxkeychain（查询 rc=1）；T2/T3/T6/T9 还应固定临时 XDG_CONFIG_HOME，避免继承真实 XDG global helper。
调用方核查：_credential_helpers 仅 run() 调用，_fetch 仅 run() 调用；测试 :113 与 :265 依赖旧机制，方案已列删除/改造；生产 fetch 仅 repo_index.py:305；READ/_validate 不允许 ls-remote，无遗漏的 gitsafe 网络入口；新增脱敏名与 :71-81 的递归实现相容。
出处：[Git v2.39.5 osxkeychain 源码](https://raw.githubusercontent.com/git/git/v2.39.5/contrib/credential/osxkeychain/git-credential-osxkeychain.c)、[Apple 锁定钥匙串解锁行为](https://developer.apple.com/documentation/security/seckeychainfindinternetpassword%28_%3A_%3A_%3A_%3A_%3A_%3A_%3A_%3A_%3A_%3A_%3A_%3A_%3A_%3A_%3A%29)。未验证：真实 GitHub 凭据获取、V1 私库 fetch、真实钥匙串弹窗/修改时间及 V2；常驻边界禁止读取钥匙串，故使用替身验证派发路径，不能据此签署真机验收。
