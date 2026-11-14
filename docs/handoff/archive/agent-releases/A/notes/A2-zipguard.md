# A2-zipguard 返工（架构师 BLOCK 三条 P1）

- 2026-11-14 15:40–15:47 Sydney。worktree `/Users/yanghongming/Projects/.worktrees/TeamAgent-A2-zipguard`，分支 `pkg/A2-zipguard`，未 push、未部署。
- 提交：`419436b`（test）→ `b396d6a`（fix）。基线 `205d42d`。

## 改了什么

- P1-1 `runner/docread.py:99-249`：`xl/worksheets/*.xml` 与 `xl/sharedStrings.xml` 不再计入 2M 元素预算和 48 MiB 合计。worksheet 由 `_scan_xml(worksheet=True)` 扫描：第 5001 行开始即 `_Done` 停止并通过；单行内元素 >100k → `too_large`（100000）；行外元素/16384 列旧限制保留。sharedStrings 只受 32 MiB 单文件上限（另加 4 MiB 单标签结构上限，不计元素）。
- P1-2 `runner/docread.py:131-165`：新增 `_checked_chunks`，每个 64 KiB chunk 送 expat 前用一次 `rfind(b">")` 跟踪「自上一个 `>` 以来的字节数」，>4 MiB → `too_large`；同一检查覆盖单个文本节点。`_scan_xml` 与 sharedStrings 预检共用。
- P1-3 `runner/docread.py:108-128, 274-315`：`_member_is_xml` 读每个成员头 64 字节，去 UTF-8/UTF-16 BOM 和空白后以 `<` 开头即视为 XML；32 MiB/48 MiB 字节上限和元素扫描都按内容判断，不再看 `.xml/.rels` 后缀。

## 测试

- `docread_test.py`：42/42 通过（原 35 条 + 新增 7 条）。新增：三种大表（100k×10 数值、40k×30 数值、70k×10 文本，均 rows=5000/truncated/含「超过 5000 行」警告）、100 万 sharedStrings、2.5M 属性宽标签、>4MiB 文本节点、.bin 改名 40MiB、.bin 改名 2,000,001 元素、单行 100,001 元素。
- `node --test test/docjobs.test.mjs test/docread-job.test.mjs`：18/18。
- `node --test test/read-document.test.mjs test/docjobs-replay.test.mjs test/docjobs-route.test.mjs`：14/14。
- `npm run check`：通过（precheck 重新生成 self-card，commit 205d42d，无 diff）。
- `npm test`：1944 条，1934 pass / 0 fail / 10 skip。
- `npm run test:runner`：278 条，8F+2E，全部为 `subagent_test.py` 的 `sandbox-exec: Operation not permitted`，与基线 8F+2E 相同；`node --test runner/test_fetcher.mjs` 79/79。
- 测试环境：项目未带 venv，临时 `/tmp/a2zipguard-venv`（Python 3.12.12 + reportlab/python-docx/python-pptx/openpyxl/pypdf/xlrd），未改项目依赖。

## 实测（macOS，Python 3.12.12，冷进程；fixtures 在 /tmp，用完删除）

| 场景 | 结果 | 耗时 | maxrss |
|---|---|---|---|
| 2.5M 属性、28 MiB 单标签 docx（修前，整条测试） | guard 未拒（测试失败），峰值 667 MiB | 2.85s | 699,170,816 B（667 MiB） |
| 同上（修后，guard 单独） | `too_large`「单个标签或文本节点超过 4 MiB」 | 0.015s | 27.2 MiB |
| 同上（修后，整条测试） | 同左 | 0.81s | 75,743,232 B（72 MiB） |
| 100k×10 数值表 read_document | ok，rows=5000，truncated | 0.329s | 40.4 MiB |
| 40k×30 数值表 read_document | ok，rows=5000，truncated | 0.625s | 45.8 MiB |
| 70k×10 文本表 read_document | ok，rows=5000，truncated | 0.484s | 41.4 MiB |
| 1M 不同字符串 sharedStrings（22 MiB）+ guard | ok，strings=1000000 | 2.419s | 188.4 MiB |
| 40 MiB `word/document.bin`（内容 XML） | `too_large`「XML 单文件上限 32 MiB」 | 0.001s | 18.1 MiB |

## 需要说明

- 原 `test_guard_allows_large_worksheet_member` 的夹具是「40 MiB 单一文本节点」的假 worksheet；在 P1-2 的 4 MiB 文本节点上限下它应当被拒。已改为真实的 75k×10 文本表（43 MiB、压缩比 <100），断言「>40 MiB 的 worksheet 允许通过 guard」不变。
- sharedStrings 的 4 MiB 单标签检查是 P1-2 的同一结构上限，不参与元素计数；若架构师要求「只受 32 MiB」严格到不加此检查，可去掉 `_check_xml_tokens` 一行调用，但 `_shared_strings` 的 expat 仍有同类风险。
- 未实测：真实 45 MB/3M 元素 `.bin` docx 经 python-docx 完整解析（guard 已在其前面拒绝）；多 worksheet 合计 >48 MiB 的显式用例。

## 第五轮返工（架构师 BLOCK，四条 P1）

- 2026-11-14 15:52–16:20 Sydney。`pkg/A2-zipguard` @ `70c48f3`（`65e67ef` test / `70c48f3` fix），未 push、未部署，worktree 干净。基线 `b396d6a`。
- P1-1 `runner/docread.py:171-200`：`_checked_chunks` 改为测量相邻两个 `<` 的字节间隔（>4 MiB 拒）；属性值/文本里的 `>` 不再重置计数。2.5M 个 `a{i:x}=">"` 属性、28.9 MB 单标签：新版 0.015s / 28.1 MiB，旧版同夹具 status=ok、680,263,680 B（648.8 MiB）；500k 属性旧版 147.2 MiB / 新版 27.2 MiB。
- P1-2 `:128-168` + `:335-385`：新增 `_relationships`。只有包是 `.xlsx/.xlsm`，且成员是 `xl/_rels/workbook.xml.rels` 中 Type 为 worksheet 或 sharedStrings 的目标时才豁免；chartsheet、docx/pptx 的所有成员一律 32 MiB 单件 + 2M 元素。测试：docx 主文档放 `xl/worksheets/a.xml`（1.2M 段落 = 2.4M 元素、31.2 MB）→ too_large（旧版 ok）；xlsx chartsheet 指向 `xl/worksheets/sheet1.xml`（43.5 MB）→ 「XML 单文件上限」（旧版 ok）。`MAX_RELS_BYTES = 1 MiB`：更大的 rels 不给豁免，避免把 32 MiB rels 先建成树。
- P1-3 `:203-309`：sharedStrings 改为 `_scan_xml(shared_strings=True)`：si 外元素 ≤100k、单个 si 内元素 ≤100k，仍不参与 2M 全包预算。测试：sharedStrings 18.9 MB、2M 个 `<x{i:x}/>` 垃圾 → too_large「si 外元素」（旧版 ok）；单 si 100,001 个元素 → too_large「单个 si 内元素」（旧版 ok）。
- P1-4 `:101-111`：`_looks_like_xml` 先剥 UTF-32/16/8 BOM，再删头 64B 中的 NUL，再去空白后看 `<`。测试：UTF-16BE 无 BOM 有声明、UTF-32LE 带 BOM 各 34 MiB → too_large「XML 单文件上限」（旧版均 ok）。
- 其它：`_member_is_xml`/`_scan_xml` 改为 `archive.open(ZipInfo)`，同名重复成员按各自的 ZipInfo 检查；`_guard_ooxml` 接受 str/Path。

### 验证（第五轮）

- `docread_test.py`：49/49（原 42 + 新 7）。
- docjobs + docread-job：18/18；read-document + docjobs-replay + docjobs-route：14/14。
- `npm run check`：通过；`npm test`：1944 条，1934 pass / 0 fail / 10 skip。
- `npm run test:runner`：285 条，8F+2E（全部 `subagent_test.py` 的 `sandbox-exec: Operation not permitted`，与基线同）；`node --test runner/test_fetcher.mjs`：79/79。
- 正常大表仍截 5000 行：100k×10 0.342s / 42.5 MiB；40k×30 0.639s / 47.8 MiB；70k×10 文本 0.481s / 42.3 MiB；均 `rows=5000 truncated=True`。
- 旧版对照（同夹具，子进程）：P1-2 docx-under-worksheets old=ok / new=too_large；chartsheet old=ok；P1-3 两例 old=ok；P1-4 两例 old=ok。

### 仍未实测

- `.xlsm` 只走同一 `.xlsx` 分支，未单独造夹具。
- 真实 45 MB/3M 元素 `.bin` docx 交给 python-docx 解析（guard 先拒）；多 worksheet 合计 >48 MiB 的显式用例。

- 2026-11-14 主程 round 6: _relationships 改白名单（Content_Types 定位 workbook；worksheet 类型且所有关系都是 worksheet 才豁免；sharedStrings 只认登记的第一个且无其他关系）+ keep_links=False；3 个新回归测试（改名 workbook 诱饵 rels / 第二条 chartsheet 关系 / 第二条 externalLink 关系），旧代码上失败新代码通过。docread 54/54，check 干净，npm test 1944/1934/0/10。
- 2026-11-14 主程 round 7 (架构师 5 条 P1): 严格全有或全无白名单：任一 rels 成员超 1MiB/含 DTD、PartName 重复或不是恰好一个前导 /、部件被工作簿 rels 以外的任何关系引用→整包不豁免；Type/ContentType 精确（sharedStrings 区分大小写）；styles/docProps/theme/workbook/rels/sharedStrings.xml(作 worksheet) 永不豁免。8 个新测试(7 个在 f8b0457 上失败)；docread 62/62，check 干净，npm test 1944/1934/0/10。
- 版本闸：openpyxl != 3.1.5 时不给任何豁免；62/62、check 通过。
