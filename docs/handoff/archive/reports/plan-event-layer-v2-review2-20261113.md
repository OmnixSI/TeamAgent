结论：打回；四项原 P1 中三项已解决，P1-2 因新增中断恢复缺口未关闭；P0 无。本轮只复核四项，不代表全文重审。
依据：方案279行；固定代码 main 9707610fa8f2f70e7bd4dcabb97fc2e204e5d85d；通过 git show 读取，未改活跃工作区。
P1-1 调用方遗漏【已解决】：方案:116、144–147、216 已列全8处并保留ci/fetchjobs原batch guard，开放semantic两窄点；与semantic.ts:527/813、ci.ts:264/386、fetchjobs.ts:232、rhythm.ts:39实际形态一致。
P1-2 并发认领【未解决】：方案:152–163 的3条锁batch与4条认领batch之间中断，outbox=sending且outbox_send无行；按:163回收式实测变unknown（账本数0），默认unknown_resend=1永不重试，兄弟held被挡；旧入口worker.ts:1185正是要替换之处。须把锁和认领合入一次原子batch，或在锁事务写明确“尚未发送”标记，并补锁后中断→恢复→发送一次的测试；不得把可能已请求的旧无账本行一概重试。
P1-3 48条预算【已解决，属方案账目】：方案:105–107要求COST.send_row由10→15，与现码d1.ts:32的sticker=6及timing.ts:18–35最多2条尾写一致；2+15+2=19、表情入口需2+21+2=25。初始left=48/31/19/18/3算术探针最坏分别发2/1/1/0/0行，调用累计均≤48；实际新sender尚未实现，需按:208做完整入口计数，以上不是新实现实测。
P1-4 回滚兼容【已解决，按明确降级语义】：方案:109–113、165、219新增retry/held隔离与两遍SQL；五类残留探针仅“根pending及其held尾段”恢复为旧版候选，其余retry/held→skipped、unknown/sending不取，与worker.ts:951一致；允许丢尾段和版本交叠乱序已明写，不再声称原行为无损。
SQL验证：对方案:153–155将伪参数?g等落实为标准绑定/合成常量后，本地Wrangler D1引擎12条SQL全成功，第二tok抢租失败、同群仅1个sending；SQLite事务探针同结果。官方说明支持SQLite语义及batch原子回滚：[SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/)、[batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)。远程D1及真实双调用未测，保留方案:224的预发验证门控。
新P1即锁/认领间隙误终态；未发现本次四项修订的其他新增P0/P1。未重跑已有全量构建、未部署、未读取账号或密钥；临时探针与本地D1状态已删除。
