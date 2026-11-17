# TeamAgent

English | [简体中文](README.md)

The resident bot in the "做 AI 高手" QQ group. It chats in the group, looks things up, draws, handles files, and also manages the team's task lists, board and points. The whole thing runs on Cloudflare and needs no process on any local machine.

- Live site: https://teamagent.inkboard-server.workers.dev (`/health` shows whether it is up)
- Team board: `/x/board` (each person enters with their own personal link; say "give me the board link" to the bot in the group)
- Web interface supports Chinese / English, following the system language by default (since v2.0.0).
- Worker name `teamagent`. The old version (v1) lives in the tag `v1-archive` and is retired.

## What it can do

| Area | Details |
|---|---|
| Chat | Sees all of the day's messages and images and decides whether to join in; remembers members, projects, memes and the rules the group has set for it |
| Research | Web search, reading pages and content from platforms (Bilibili, Xiaohongshu, Zhihu, WeChat Official Accounts, X), multi-turn research, paper search, feeds |
| Content creation | Image generation and editing, memes, voice and dialects, dubbed videos, audio shows, documents and mind maps, illustrated books, clickable web pages and mini-games |
| File handling | PDF conversion, PDF tools, OCR, full-document translation, notes from recordings, video subtitles, audio/video processing, large-file upload and download |
| Coding | Reads team repositories, has coding agents change code and open draft PRs, runs branches for screenshots or time-limited previews, runs repository tests every night |
| Teamwork | Task lists (priority, order, handover materials), bots picking up and doing work on their own, board, points and a hall of fame, weekly reports and awards, an MCP interface for local AI |
| Watching | Page changes, site uptime, market quotes and trending lists, scheduled jobs, daily digests |

Which module and tools each item uses is in [docs/features.md](docs/features.md).

## Tech stack at a glance

```
QQ group ⇄ QQ official long connection ⇄ Hub (Durable Object)
                          ├─ SQLite: chat history, memory, tasks, ledger, scheduled and background jobs
                          ├─ R2: large files, backups, published pages, cloud-computer tool cache
                          ├─ DeepSeek: conversation, search, page reading, research, image recognition, speech synthesis
                          ├─ OpenAI: image generation and editing, long-audio transcription, Python sandbox
                          ├─ Headless browser: renders documents and pages to images and PDF, opens dynamic pages
                          ├─ Cloud computer (container): ffmpeg, git, Python, LibreOffice, started on demand
                          ├─ Workers AI: free transcription, vectors for semantic search
                          ├─ Hong Kong relay (Vercel): egress for mainland sites, SILK voice encoding, page mirroring
                          └─ GitHub: reads organization repositories; code changes only as draft PRs
```

| Technology | What it is used for | Details |
|---|---|---|
| Cloudflare Worker + Durable Object | Entry point and the single always-on object, Hub: holds the QQ long connection and runs every conversation turn, scheduled and background job | [Architecture](docs/architecture.md) |
| SQLite built into the DO | All structured data, including vectors for semantic search | [Storage and budget](docs/storage-and-budget.md) |
| R2 | Large things that do not fit in SQLite | [Storage and budget](docs/storage-and-budget.md) |
| DeepSeek `deepseek-flash` | All conversation and reasoning; prompts are ordered to be cache-friendly | [Model, prompts and memory](docs/model-and-memory.md) |
| OpenAI | Only for image generation, long-audio transcription and the Python sandbox | [Model, prompts and memory](docs/model-and-memory.md) |
| Cloudflare headless browser | Rendering, screenshots, PDF, opening pages that need scripts | [Cloud computer, skills and browser](docs/compute.md) |
| Cloudflare container | An on-demand Linux machine for command-line tools and fixed recipes (skills) | [Cloud computer, skills and browser](docs/compute.md) |
| Workers AI | Transcription and vectors within the free daily allowance | [Storage and budget](docs/storage-and-budget.md) |
| Vercel Hong Kong functions | Mainland sites that Cloudflare egress is refused by, SILK encoding, page mirroring for mainland networks | [Network](docs/network.md) |
| QQ official bot API | Long connection for receiving messages; sending text, images, voice and files | [Architecture](docs/architecture.md) |
| GitHub API | Reading repositories, opening draft PRs, counting each person's contributions across organization repositories | [Teamwork](docs/teamwork.md) |
| MCP (HTTP) | Local Claude Code and Codex on members' machines pick up tasks and deliver results | [Teamwork](docs/teamwork.md) |

## Documentation

| Document | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How a message travels from arrival to reply, background jobs, clocks, restarts, and what each code file owns |
| [docs/model-and-memory.md](docs/model-and-memory.md) | Reasoning tiers, prompt order and caching, long-term memory, the image workflow, what the bot can change itself |
| [docs/storage-and-budget.md](docs/storage-and-budget.md) | Where data lives, the allowance and stop line for each metered item in the plan, how spending is recorded |
| [docs/compute.md](docs/compute.md) | Cloud computer, toolbox, skills, headless browser |
| [docs/network.md](docs/network.md) | The three outbound routes, site login state, the Hong Kong relay and mirroring |
| [docs/features.md](docs/features.md) | Full list of feature modules, tools and skills |
| [docs/teamwork.md](docs/teamwork.md) | Tasks, bots doing work on their own, handover materials, how the group is kept posted, points and repository contributions, board, local AI interface |
| [docs/operations.md](docs/operations.md) | Deployment, secrets, test rooms, admin endpoints, self-checks, FAQ |
| [AGENTS.md](AGENTS.md) | Rules for people and AI changing this repository: hard constraints, verification and release process |

## Three hard constraints

1. **Stay within the Cloudflare plan.** Workers Paid is USD 5 per month; everything metered counts itself and refuses work at its stop line ([allowance table](docs/storage-and-budget.md#套餐额度)).
2. **Use only the DeepSeek `deepseek-flash` model.** high for replies, max for work; OpenAI only for image generation, transcription and the Python sandbox.
3. **Tools return real results, and the model may only speak from them.** Whether an image was sent, whether a task was created, what the score is — all follow the tool's return value.

## Local checks and deployment

```sh
npm install
npm run check      # type check + offline tests (no network, no cost), a few seconds
npm run deploy     # deploys only if check passes; needs CLOUDFLARE_API_TOKEN
```

Pushing to `main` deploys automatically: Cloudflare Workers Builds runs `npm run check` first and only then `npx wrangler deploy`. The build machine uses Node 24 (`.node-version`). For restarts, secrets and how to try things in a test room after deployment, see [docs/operations.md](docs/operations.md).

## Directory layout

| Path | Contents |
|---|---|
| `src/` | Core: entry, Hub, one conversation turn, tools, persona, storage, accounting, cloud computer |
| `src/feat/` | Feature modules, one file per module |
| `src/skills/` | Skills: fixed recipes that run in the cloud computer, one file per skill |
| `test/` | Offline tests |
| `relay/` | The Hong Kong relay and mirroring (deployed to Vercel separately) |
| `scripts/` | Scripts that refresh site login state |
| `docs/` | The technical documents listed above |
