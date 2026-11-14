结论：已在 Cloudflare SYD 边缘确定根因：运行时不支持 redirect:"error"；与 QQ 返回 302 无关，请求在发出前就失败。
线上核验：2026-11-13 悉尼 11:10，/health HTTP200，release=68ef1c393ca169dbd41ce210ef7af710332fcf37；该版本 vision.ts:180 仍使用 redirect:"error"，catch 把异常归为 network。
方法：按 [Cloudflare 远程开发说明](https://developers.cloudflare.com/workers/local-development/) 使用隔离 wrangler dev --remote 临时预览，无生产绑定；实际导入当前 src/vision.ts 的 fetchImage，仅在探针包装层对照 redirect/请求头。
数据：D1 只 SELECT 原 traceId 03664041-5ba6-45e3-815a-8b9694496fff 对应图片 URL；URL 仅在内存中传入探针，不落盘、不输出；图像仅在边缘内存读取，不保存正文或调用模型。
旧参数对照 2/2 失败，耗时均0ms、无HTTP响应，异常类型 TypeError，原文如下：
Invalid redirect value, must be one of "follow" or "manual" ("error" won't be implemented since it does not make sense at the edge; use "manual" and check the response status code).
manual 对照 6/6 成功：默认无自定义头、Accept:image/*、浏览器UA+Referer+Accept各2次；HTTP200，image/jpeg，679176字节，Location为空，完整读到679176字节，耗时599–2686ms。
已确认图片域名仅 multimedia.nt.qq.com.cn；没有观察到真实跳转域名；证据不支持必须补请求头或QQ拦截Cloudflare出口。
修复已在提交8d3eb662a7368504d1b77e309d453a4ab5eab70b（父68ef1c3）中：manual最多2跳，逐跳安全及白名单检查，大小/MIME/共享超时保持；无需追加生产代码或新提交。
验证：本轮定向21/21通过、0skip；已核对同一提交的干净clone记录，check0、npm test668/668、runner61/61、check:ui/config:check/diff-check0，均0skip；工作区干净，semantic未改。
工作树：/Users/yanghongming/Projects/.worktrees/TeamAgent-image-fix（agent/image-fetch-redirect）；原始边缘证据 .agent/image-edge-probe.json；本轮定向日志 .agent/image-edge-regression.log。
探针入口最初曾因Python-urllib UA返回403/1010，尚未进入Worker；改本地入口UA后正常。此403属于预览入口，与QQ图床响应无关。
清理与限制：临时wrangler及子进程已结束，无新增常驻服务、媒体缓存、生产写入、push或部署；已知修复尚未上线，未验证发布后的真实群消息。
