# A2 next（架构师 2026-11-14 16:40，zipguard 68654ca 终审 P2）
- [已完成 1c68d0a] P2 版本闸：`_relationships` 的豁免模型逐条对照 openpyxl 3.1.5 的读取路径，但 openpyxl 没有锁版本。修法：`_relationships` 开头 `import openpyxl`，`openpyxl.__version__ != "3.1.5"` → 返回 (set(), set())（整包不豁免，退回 32MiB/2M）；安装说明锁 openpyxl==3.1.5。升级时重新核对 reader/excel.py read()、read_worksheets、read_chartsheet、drawings.find_images。
- P2 误拒：任一 .rels >1MiB（例如单表约 7k 个超链接）或 Strict OOXML（purl 类型）→ 整包不豁免 → 大表被 too_large。方向安全；如有用户反馈再把 rels 上限放宽到 4MiB，并认 purl 的 worksheet/sharedStrings 类型。
- P2 测试依赖：test/docread_test.py 需要 reportlab，运行 venv（~/.inkboard-team/venv）和系统 python3 都没有，本机直接跑 62 个全 ERROR；在测试说明或脚本里写明用哪个解释器。
