# 云电脑、技能和浏览器

[← 回到 README](../README.md)

Worker 本身只能跑 JavaScript，跑不了 ffmpeg、LibreOffice 这类程序，也打不开要执行脚本的网页。这两件事分别交给容器和无头浏览器。

## 云电脑

`src/computer.ts`：一台 Cloudflare 容器，用托管的 Debian 镜像，不需要 Docker 构建。

| 项 | 值 |
|---|---|
| 规格 | 1 核、1 GiB 内存、4 GB 硬盘，只有一个实例 |
| 开机 | 要用时才开 |
| 关机 | 最后一次使用后 90 秒由闹钟关机，硬盘清空 |
| 卡住的命令 | 最多让它多开 35 分钟 |
| 计费 | 运行时间（含那 90 秒）和 CPU 秒数都记进套餐计数，到停止线就不再开机 |

工具怎么来：

- 基础工具（ffmpeg、git、Python、Node 26、字体）装好后打包存在 R2，开机时解压恢复；缓存没有或坏了就完整安装一遍并重新存缓存。
- 大件工具分成工具包（`src/packs.ts`：`office`、`ocr`、`tex`），各自在 R2 里存一层，哪次运行要用才恢复。
- 部署后云电脑对象要等机器睡过一次才换上新代码。

模型怎么用它：

| 工具 | 作用 |
|---|---|
| `computer` | 在里面跑命令。文件箱的 `x12` 可以直接作输入；超过 25 MB 的结果自动进文件箱 |
| `skill` | 跑一个技能（见下） |
| `watch_video` | 固定流程：取视频、抽音轨、截帧，音轨再交给转写 |
| `code_task` | 编码代理（OpenCode + DeepSeek）在里面改代码，改完开草稿 PR |
| `preview_app` `preview_link` `deploy_site` | 把仓库跑起来截图、给限时预览、构建静态站 |

云电脑和 R2 之间的大文件走 `transfer` 模块，用短时令牌。

## 技能

技能是写死的配方，在 `src/skills/`，一个文件一个技能（接口在 `src/skills/types.ts`）。

- `commands(args, files)` 返回要在云电脑里跑的 bash；输入在 `./in/`，结果写到 `./out/`。
- `skill` 工具负责找输入（聊天里的文件、`f12`、`g12`、文件箱 `x12`）、恢复需要的工具包、执行、把结果发回群里，超过 25 MB 的结果放进文件箱。
- 模型不用自己拼命令，结果稳定。

| 技能 | 做什么 |
|---|---|
| `doc-to-pdf` | Word、Excel、PPT、Markdown、图片等转 PDF |
| `pdf-tools` | 合并、拆分、抽页、旋转、压缩、转图片、加密解密、水印、页码 |
| `pdf-to-docx` `pdf-to-markdown` | PDF 转可编辑的 Word；PDF 和 Office 文档转 Markdown |
| `pdf-ocr` | 扫描件和图片做文字识别，出可搜索的 PDF 和文本 |
| `md-to-report` `md-to-slides` `resume` | Markdown 排成 PDF 报告（三种版式）、可编辑的 PPT、简历 |
| `image-batch` `image-collage` | 图片批量压缩、改格式、改名、加水印；拼图和九宫格 |
| `media-convert` | 音视频转格式、剪辑、压缩、变速、拼接、转 GIF、抽帧 |
| `qr-code` | 二维码（PNG 和 SVG，可带 logo 和说明文字） |

离线测试里要真跑外部程序（LibreOffice、pandoc、ffmpeg、tesseract）的那几条默认跳过，要跑就 `SKILLS_REAL=1 npm test`。

## 无头浏览器

`src/render.ts`，用 Cloudflare 的浏览器绑定（`BROWSER`），每月 10 小时，用到 8.5 小时停。

| 用途 | 哪里用 |
|---|---|
| 把文档、思维导图、流程图、网页排版渲染成图和 PDF | `show`、`make_book`、每周的奖状 |
| 打开要跑脚本才有内容的网页 | `read_url` 的兜底、`watch` |
| 批量用法：多个网页按字段摘成表格、网页存档（文字 + PDF + 整页截图）、站点地图 | `web_extract` `web_archive` `site_map` |
| 给跑起来的仓库截图 | `preview_app` |
