# 交办与完成态对照表

这 26 条是本轮验收合同：12 条真交办、12 条完成陈述、2 条裸「把」边界。两个工具逐条运行同一组测试。

数据源：`test/fixtures/authz-completion-cases.json`；验证：`node --test test/authz-completion.test.mjs`。

| ID | 成员本条原话 | prepare_project_task | create_file_task |
| --- | --- | --- | --- |
| A01 | 帮我把登录错误修一下 | ALLOW | ALLOW |
| A02 | 帮我把 README 整理一下 | ALLOW | ALLOW |
| A03 | 请你把这个做成文档 | ALLOW | ALLOW |
| A04 | 麻烦把项目说明整理一下 | ALLOW | ALLOW |
| A05 | 请把视频内容整理成文档 | ALLOW | ALLOW |
| A06 | 你把登录模块重构一下 | ALLOW | ALLOW |
| A07 | 帮我修复 WhalePartner 的登录错误 | ALLOW | ALLOW |
| A08 | 帮我出一份 WhalePartner 的开发方案 | ALLOW | ALLOW |
| A09 | 麻烦你把这个 README 整理一下 | ALLOW | ALLOW |
| A10 | 请问帮我检查登录错误 | ALLOW | ALLOW |
| A11 | 建个任务 | ALLOW | ALLOW |
| A12 | 帮我记个任务修登录 | ALLOW | ALLOW |
| D01 | 把登录错误修好了 | DENY | DENY |
| D02 | 把 README 整理好了 | DENY | DENY |
| D03 | 把视频内容整理成文档了 | DENY | DENY |
| D04 | 我把它修好了 | DENY | DENY |
| D05 | 已经把文档写完了 | DENY | DENY |
| D06 | 把登录改成了 OAuth | DENY | DENY |
| D07 | 上次把这个整理过了 | DENY | DENY |
| D08 | 帮我把登录错误修好了 | DENY | DENY |
| D09 | 请把 README 整理完了 | DENY | DENY |
| D10 | 麻烦把这个做成文档完成了 | DENY | DENY |
| D11 | 帮我把这个搞定 | DENY | DENY |
| D12 | 请把资料弄好 | DENY | DENY |
| D13 | 把登录错误修一下 | DENY | DENY |
| D14 | 把 README 整理成文档 | DENY | DENY |

完成态统一按整句识别，不再按动作后缀逐个补漏；工作交办出现「了／过／已经／搞定／弄好」即拒绝，其中「了／过」覆盖动词后、补语后与句尾的完成标记。裸「把」不是请求语气，「帮我把／麻烦把／请把／你把」才进入请求判断。纠正记忆走既有独立规则。
