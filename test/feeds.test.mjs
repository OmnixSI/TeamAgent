// Offline tests for feed subscriptions: real SQLite (node:sqlite), fake fetch, injected clock.
// The samples below are real responses fetched on 2026-11-15 (trimmed to the first one or two entries): Cloudflare blog
// (RSS 2.0), Simon Willison (Atom), GitHub releases and commits, arXiv API, rss.arxiv.org (empty on a weekend), hnrss, YouTube.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import feature, { deps, LIMITS, parseFeed, parseDate, expandSource, discoverFeed, checkFeed } from "../src/feat/feeds.ts";

const S = {"githubReleases":"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<feed xmlns=\"http://www.w3.org/2005/Atom\" xmlns:media=\"http://search.yahoo.com/mrss/\" xml:lang=\"en-US\">\n  <id>tag:github.com,2008:https://github.com/cloudflare/workers-sdk/releases</id>\n  <link type=\"text/html\" rel=\"alternate\" href=\"https://github.com/cloudflare/workers-sdk/releases\"/>\n  <link type=\"application/atom+xml\" rel=\"self\" href=\"https://github.com/cloudflare/workers-sdk/releases.atom\"/>\n  <title>Release notes from workers-sdk</title>\n  <updated>2026-11-13T17:11:04Z</updated>\n  <entry>\n    <id>tag:github.com,2008:Repository/426659329/wrangler@4.162.0</id>\n    <updated>2026-11-13T17:11:41Z</updated>\n    <link rel=\"alternate\" type=\"text/html\" href=\"https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.162.0\"/>\n    <title>wrangler@4.162.0</title>\n    <content type=\"html\">&lt;h3&gt;Minor Changes&lt;/h3&gt;\n&lt;ul&gt;\n&lt;li&gt;\n&lt;p&gt;&lt;a href=&quot;https://github.com/cloudflare/workers-sdk/pull/16735&quot; data-hovercard-type=&quot;pull_request&quot; data-hovercard-url=&quot;/cloudflare/workers-sdk/pull/16735/hovercard&quot;&gt;#16735&lt;/a&gt; &lt;a href=&quot;https://github.com/cloudflare/workers-sdk/commit/f005593c1ed0d1f429dafc6919c4335f4d5070c7&quot;&gt;&lt;code&gt;f005593&lt;/code&gt;&lt;/a&gt; Thanks &lt;a href=&quot;https://github.com/leostera&quot;&gt;@leostera&lt;/a&gt;! - Use the local simulator for Artifacts bindings that omit &lt;code&gt;remote&lt;/code&gt;&lt;/p&gt;\n&lt;p&gt;&lt;strong&gt;Behavior change:&lt;/strong&gt; Artifacts bindings now default to the local simulator during development, like KV, R2 and D1. Previously, an omitted &lt;code&gt;remote&lt;/code&gt; in Wrangler and the Vite plugin used the deployed Artifacts resource. If you want deployed repos in &lt;code&gt;wrangler dev&lt;/code&gt; or &lt;code&gt;vite dev&lt;/code&gt;, set &lt;code&gt;&quot;remote&quot;: true&lt;/code&gt; on the binding (&lt;code&gt;dev: { remote: true }&lt;/code&gt; in &lt;code&gt;cloudflare.config.ts&lt;/code&gt;). Artifacts is in beta, so this ships as a minor release.&lt;/p&gt;\n&lt;p&gt;While &lt;code&gt;remote&lt;/code&gt; is omitted, &lt;code&gt;wrangler dev&lt;/code&gt;, &lt;code&gt;getPlatformProxy()&lt;/code&gt; and the Vite plugin warn when remote bindings are enabled, once for each binding rather than on every config reload: &quot;Artifacts binding REPOS uses the local simulator by default. Set &lt;code&gt;remote: true&lt;/code&gt; to use deployed repos, or &lt;code&gt;remote: false&lt;/code&gt; to silence this warning.&quot; Workers Vitest and &lt;code&gt;wrangler dev --local&lt;/code&gt; already used the simulator, so</content>\n    <author>\n      <name>workers-devprod</name>\n    </author>\n    <media:thumbnail height=\"30\" width=\"30\" url=\"https://avatars.githubusercontent.com/u/116369605?s=60&amp;v=4\"/>\n  </entry>\n<entry>\n    <id>tag:github.com,2008:Repository/426659329/miniflare@5.20261113.0-beta</id>\n    <updated>2026-11-13T17:11:20Z</updated>\n    <link rel=\"alternate\" type=\"text/html\" href=\"https://github.com/cloudflare/workers-sdk/releases/tag/miniflare%405.20261113.0-beta\"/>\n    <title>miniflare@5.20261113.0-beta</title>\n    <content type=\"html\">&lt;h3&gt;Minor Changes&lt;/h3&gt;\n&lt;ul&gt;\n&lt;li&gt;\n&lt;p&gt;&lt;a href=&quot;https://github.com/cloudflare/workers-sdk/pull/16735&quot; data-hovercard-type=&quot;pull_request&quot; data-hovercard-url=&quot;/cloudflare/workers-sdk/pull/16735/hovercard&quot;&gt;#16735&lt;/a&gt; &lt;a href=&quot;https://github.com/cloudflare/workers-sdk/commit/f005593c1ed0d1f429dafc6919c4335f4d5070c7&quot;&gt;&lt;code&gt;f005593&lt;/code&gt;&lt;/a&gt; Thanks &lt;a href=&quot;https://github.com/leostera&quot;&gt;@leostera&lt;/a&gt;! - Use the local simulator for Artifacts bindings that omit &lt;code&gt;remote&lt;/code&gt;&lt;/p&gt;\n&lt;p&gt;&lt;strong&gt;Behavior change:&lt;/strong&gt; Artifacts bindings now default to the local simulator during development, like KV, R2 and D1. Previously, an omitted &lt;code&gt;remote&lt;/code&gt; in Wrangler and the Vite plugin used the deployed Artifacts resource. If you want deployed repos in &lt;code&gt;wrangler dev&lt;/code&gt; or &lt;code&gt;vite dev&lt;/code&gt;, set &lt;code&gt;&quot;remote&quot;: true&lt;/code&gt; on the binding (&lt;code&gt;dev: { remote: true }&lt;/code&gt; in &lt;code&gt;cloudflare.config.ts&lt;/code&gt;). Artifacts is in beta, so this ships as a minor release.&lt;/p&gt;\n&lt;p&gt;While &lt;code&gt;remote&lt;/code&gt; is omitted, &lt;code&gt;wrangler dev&lt;/code&gt;, &lt;code&gt;getPlatformProxy()&lt;/code&gt; and the Vite plugin warn when remote bindings are enabled, once for each binding rather than on every config reload: &quot;Artifacts binding REPOS uses the local simulator by default. Set &lt;code&gt;remote: true&lt;/code&gt; to use deployed repos, or &lt;code&gt;remote: false&lt;/code&gt; to silence this warning.&quot; Workers Vitest and &lt;code&gt;wrangler dev --local&lt;/code&gt; already used the simulator, so</content>\n    <author>\n      <name>workers-devprod</name>\n    </author>\n    <media:thumbnail height=\"30\" width=\"30\" url=\"https://avatars.githubusercontent.com/u/116369605?s=60&amp;v=4\"/>\n  </entry>\n</feed>\n","githubCommits":"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<feed xmlns=\"http://www.w3.org/2005/Atom\" xmlns:media=\"http://search.yahoo.com/mrss/\" xml:lang=\"en-US\">\n  <id>tag:github.com,2008:/cloudflare/workers-sdk/commits/main</id>\n  <link type=\"text/html\" rel=\"alternate\" href=\"https://github.com/cloudflare/workers-sdk/commits/main\"/>\n  <link type=\"application/atom+xml\" rel=\"self\" href=\"https://github.com/cloudflare/workers-sdk/commits/main.atom\"/>\n  <title>Recent Commits to workers-sdk:main</title>\n  <updated>2026-11-14T08:27:34Z</updated>\n  <entry>\n    <id>tag:github.com,2008:Grit::Commit/4335eacef350c98722418fbb58b012a6964e26d7</id>\n    <link type=\"text/html\" rel=\"alternate\" href=\"https://github.com/cloudflare/workers-sdk/commit/4335eacef350c98722418fbb58b012a6964e26d7\"/>\n    <title>\n        [wrangler] Reuse OAuth credentials refreshed by another process (#16874)\n    </title>\n    <updated>2026-11-14T08:27:34Z</updated>\n    <media:thumbnail height=\"30\" width=\"30\" url=\"https://avatars.githubusercontent.com/u/15655?s=30&amp;v=4\"/>\n    <author>\n      <name>petebacondarwin</name>\n      <uri>https://github.com/petebacondarwin</uri>\n    </author>\n    <content type=\"html\">\n      &lt;pre style=&#39;white-space:pre-wrap;width:81ex&#39;&gt;[wrangler] Reuse OAuth credentials refreshed by another process (#16874)\n\nCo-authored-by: clanky-the-clanker[bot] &amp;lt;342202840+clanky-the-clanker[bot]@users.noreply.github.com&amp;gt;&lt;/pre&gt;\n    </content>\n  </entry>\n<entry>\n    <id>tag:github.com,2008:Grit::Commit/b219078a4c1b008485ce022f01ad7292d613d9f0</id>\n    <link type=\"text/html\" rel=\"alternate\" href=\"https://github.com/cloudflare/workers-sdk/commit/b219078a4c1b008485ce022f01ad7292d613d9f0\"/>\n    <title>\n        [autoconfig] Resolve native Vite fallback commands for cf (#16803)\n    </title>\n    <updated>2026-11-14T08:22:11Z</updated>\n    <media:thumbnail height=\"30\" width=\"30\" url=\"https://avatars.githubusercontent.com/u/15655?s=30&amp;v=4\"/>\n    <author>\n      <name>petebacondarwin</name>\n      <uri>https://github.com/petebacondarwin</uri>\n    </author>\n    <content type=\"html\">\n      &lt;pre style=&#39;white-space:pre-wrap;width:81ex&#39;&gt;[autoconfig] Resolve native Vite fallback commands for cf (#16803)&lt;/pre&gt;\n    </content>\n  </entry>\n</feed>\n","arxivApi":"<?xml version='1.0' encoding='UTF-8'?>\n<feed xmlns:opensearch=\"http://a9.com/-/spec/opensearch/1.1/\" xmlns:arxiv=\"http://arxiv.org/schemas/atom\" xmlns=\"http://www.w3.org/2005/Atom\">\n  <id>https://arxiv.org/api/xEmvBKJS4h8LREVxFU7Pj8yKx4Y</id>\n  <title>arXiv Query: search_query=all:diffusion&amp;id_list=&amp;start=0&amp;max_results=2</title>\n  <updated>2026-11-14T19:17:19Z</updated>\n  <link href=\"https://arxiv.org/api/query?search_query=all:diffusion&amp;start=0&amp;max_results=2&amp;id_list=\" type=\"application/atom+xml\"/>\n  <opensearch:itemsPerPage>2</opensearch:itemsPerPage>\n  <opensearch:totalResults>110684</opensearch:totalResults>\n  <opensearch:startIndex>0</opensearch:startIndex>\n  <entry>\n    <id>http://arxiv.org/abs/2611.17336v1</id>\n    <title>Back to Pixels: Lifting Latent Video Diffusion into Pixel Space</title>\n    <updated>2026-11-12T18:59:55Z</updated>\n    <link href=\"https://arxiv.org/abs/2611.17336v1\" rel=\"alternate\" type=\"text/html\"/>\n    <link href=\"https://arxiv.org/pdf/2611.17336v1\" rel=\"related\" type=\"application/pdf\" title=\"pdf\"/>\n    <summary>Frontier video generation models work in a VAE latent space that compresses video in both space and time. This compression made training tractable, but now limits high-resolution, controllable, and interactive generation -- doubling resolution quadruples token count, conditions apply to groups of frames rather than individual ones, and each response must wait for the rest of its multi-frame block. We present PixVid, a simple yet effective method that lifts a pretrained latent video model to directly generate every frame in pixel space. PixVid keeps the diffusion transformer and replaces the VAE decoder with a convolutional head that renders its outputs into pixels. We find that predicting clean video rather than velocity, together with a larger noise shift, is key to quality. Finetuned from Wan2.1-14B, PixVid is competitive with the latent baseline within $\\sim 1.3$M training clips. Working framewise in pixels, it generates at $2\\times$ higher resolution with the same per-frame token count, keeps depth-conditioned video editing aligned under fast motion, and responds to each action at the next frame. Project page: https://chenshuo20.github.io/PixVid/</summary>\n    <category term=\"cs.CV\" scheme=\"http://arxiv.org/schemas/atom\"/>\n    <published>2026-11-12T18:59:55Z</published>\n    <arxiv:comment>Project Page: https://chenshuo20.github.io/PixVid/</arxiv:comment>\n    <arxiv:primary_category term=\"cs.CV\"/>\n    <author>\n      <name>Yanke Song</name>\n    </author>\n    <author>\n      <name>Shuo Chen</name>\n    </author>\n    <author>\n      <name>Chris Rockwell</name>\n    </author>\n    <author>\n      <name>Guande He</name>\n    </author>\n    <author>\n      <name>Nan Liu</name>\n    </author>\n    <author>\n      <name>Desai Xie</name>\n    </author>\n    <author>\n      <name>Tianpei Gu</name>\n    </author>\n    <author>\n      <name>Yong-Hyun Park</name>\n    </author>\n    <author>\n      <name>Aryan V S</name>\n    </author>\n    <author>\n      <name>Dennis Yuren Menn</name>\n    </author>\n    <author>\n      <name>Ming-Hsuan Yang</name>\n    </author>\n    <author>\n      <name>Xun Huang</name>\n    </author>\n  </entry>\n</feed>\n","arxivRssEmpty":"<?xml version='1.0' encoding='UTF-8'?>\n<rss xmlns:arxiv=\"http://arxiv.org/schemas/atom\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:atom=\"http://www.w3.org/2005/Atom\" xmlns:content=\"http://purl.org/rss/1.0/modules/content/\" version=\"2.0\">\n  <channel>\n    <title>cs.AI updates on arXiv.org</title>\n    <link>http://rss.arxiv.org/rss/cs.AI</link>\n    <description>cs.AI updates on the arXiv.org e-print archive.</description>\n    <atom:link href=\"http://rss.arxiv.org/rss/cs.AI\" rel=\"self\" type=\"application/rss+xml\"/>\n    <docs>http://www.rssboard.org/rss-specification</docs>\n    <language>en-us</language>\n    <lastBuildDate>Sat, 14 Nov 2026 05:00:03 +0000</lastBuildDate>\n    <managingEditor>rss-help@arxiv.org</managingEditor>\n    <pubDate>Sat, 14 Nov 2026 00:00:00 -0500</pubDate>\n    <skipDays>\n      <day>Saturday</day>\n      <day>Sunday</day>\n    </skipDays>\n  </channel>\n</rss>\n","hnrss":"<rss version=\"2.0\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:atom=\"http://www.w3.org/2005/Atom\"><channel><title>Hacker News: Front Page</title><link>https://news.ycombinator.com/</link><description>Hacker News RSS</description><docs>https://hnrss.org/</docs><generator>hnrss v2.1.1</generator><lastBuildDate>Sat, 14 Nov 2026 19:14:50 +0000</lastBuildDate><atom:link href=\"https://hnrss.org/frontpage\" rel=\"self\" type=\"application/rss+xml\"></atom:link><item><title><![CDATA[LinkedIn, Monster take down over 1000 fake job postings after CBC investigation]]></title><description><![CDATA[\n<p>Article URL: <a href=\"https://www.cbc.ca/news/canada/linkedin-monster-take-down-over-1-000-fake-job-postings-after-cbc-investigation-9.7415379\">https://www.cbc.ca/news/canada/linkedin-monster-take-down-over-1-000-fake-job-postings-after-cbc-investigation-9.7415379</a></p>\n<p>Comments URL: <a href=\"https://news.ycombinator.com/item?id=50499723\">https://news.ycombinator.com/item?id=50499723</a></p>\n<p>Points: 7</p>\n<p># Comments: 0</p>\n]]></description><pubDate>Sat, 14 Nov 2026 18:56:47 +0000</pubDate><link>https://www.cbc.ca/news/canada/linkedin-monster-take-down-over-1-000-fake-job-postings-after-cbc-investigation-9.7415379</link><dc:creator>gnabgib</dc:creator><comments>https://news.ycombinator.com/item?id=50499723</comments><guid isPermaLink=\"false\">https://news.ycombinator.com/item?id=50499723</guid></item>\n<item><title><![CDATA[The VHDL standard's float package gets sqrt(2) wrong]]></title><description><![CDATA[\n<p>Article URL: <a href=\"https://github.com/lmtlssss/speedrunpapi/tree/main/hardware/audit/ieee-float-pkg\">https://github.com/lmtlssss/speedrunpapi/tree/main/hardware/audit/ieee-float-pkg</a></p>\n<p>Comments URL: <a href=\"https://news.ycombinator.com/item?id=50499188\">https://news.ycombinator.com/item?id=50499188</a></p>\n<p>Points: 12</p>\n<p># Comments: 7</p>\n]]></description><pubDate>Sat, 14 Nov 2026 17:58:58 +0000</pubDate><link>https://github.com/lmtlssss/speedrunpapi/tree/main/hardware/audit/ieee-float-pkg</link><dc:creator>lmtlssss</dc:creator><comments>https://news.ycombinator.com/item?id=50499188</comments><guid isPermaLink=\"false\">https://news.ycombinator.com/item?id=50499188</guid></item></channel></rss>","youtube":"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<feed xmlns:yt=\"http://www.youtube.com/xml/schemas/2015\" xmlns:media=\"http://search.yahoo.com/mrss/\" xmlns=\"http://www.w3.org/2005/Atom\">\n <link rel=\"self\" href=\"http://www.youtube.com/feeds/videos.xml?channel_id=UCsBjURrPoezykLs9EqgamOA\"/>\n <id>yt:channel:sBjURrPoezykLs9EqgamOA</id>\n <yt:channelId>sBjURrPoezykLs9EqgamOA</yt:channelId>\n <title>Fireship</title>\n <link rel=\"alternate\" href=\"https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA\"/>\n <author>\n  <name>Fireship</name>\n  <uri>https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA</uri>\n </author>\n <published>2017-04-07T18:17:23+00:00</published>\n <entry>\n  <id>yt:video:SOwUWPtXQ9I</id>\n  <yt:videoId>SOwUWPtXQ9I</yt:videoId>\n  <yt:channelId>UCsBjURrPoezykLs9EqgamOA</yt:channelId>\n  <title>Jensen Huang just pulled out of Nvidia...</title>\n  <link rel=\"alternate\" href=\"https://www.youtube.com/watch?v=SOwUWPtXQ9I\"/>\n  <author>\n   <name>Fireship</name>\n   <uri>https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA</uri>\n  </author>\n  <published>2026-11-12T21:17:10+00:00</published>\n  <updated>2026-11-13T22:42:16+00:00</updated>\n  <media:group>\n   <media:title>Jensen Huang just pulled out of Nvidia...</media:title>\n   <media:content url=\"https://www.youtube.com/v/SOwUWPtXQ9I?version=3\" type=\"application/x-shockwave-flash\" width=\"640\" height=\"390\"/>\n   <media:thumbnail url=\"https://i4.ytimg.com/vi/SOwUWPtXQ9I/hqdefault.jpg\" width=\"480\" height=\"360\"/>\n   <media:description>Manufact is the easiest way to build and deploy your MCP. Get $100 in free credits: https://manufact.com/fireship\n\nJensen Huang just resigned as Nvidia’s CEO four days after admitting to an affair with a suspected Chinese spy whose tiny Singapore company bought $4.8 billion of Nvidia GPUs. Let's dive in.\n\nWant more Fireship?\n\n🗞️ Newsletter: https://bytes.dev\n🧠 Courses: https://fireship.dev</media:description>\n   <media:community>\n    <media:starRating count=\"26841\" average=\"5.00\" min=\"1\" max=\"5\"/>\n    <media:statistics views=\"2243206\"/>\n   </media:community>\n  </media:group>\n </entry>\n</feed>\n","rss":"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rss version=\"2.0\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:content=\"http://purl.org/rss/1.0/modules/content/\" xmlns:atom=\"http://www.w3.org/2005/Atom\">\n  <channel>\n    <title>Cloudflare Blog</title>\n    <description>Technical deep dives, product updates, and insights from the teams that are helping to build a better Internet.</description>\n    <link>https://blog.cloudflare.com/</link>\n    <language>en-us</language>\n    <atom:link href=\"https://blog.cloudflare.com/rss/\" rel=\"self\" type=\"application/rss+xml\"/>\n    <image>\n      <url>https://blog.cloudflare.com/favicon.ico</url>\n      <title>Cloudflare Blog</title>\n      <link>https://blog.cloudflare.com</link>\n    </image>\n    <lastBuildDate>Sat, 14 Nov 2026 19:16:54 GMT</lastBuildDate>\n    <item>\n      <title>Kitesurf is now open source</title>\n      <link>https://blog.cloudflare.com/kitesurf-open-source/</link>\n      <pubDate>Fri, 13 Nov 2026 20:20:21 GMT</pubDate>\n      <description>Kitesurf, our experimental browser engine for AI agents, is now open source. Inspect the code, run it locally, or deploy your own instance on Cloudflare Workers.</description>\n      <dc:creator>Celso Martinho</dc:creator>\n      <dc:creator>Rui Figueira</dc:creator>\n      <dc:creator>Bernardo Pereira</dc:creator>\n      <dc:creator>Luís Duarte</dc:creator>\n      <category>Agents</category>\n      <category>AI</category>\n      <category>Browser Run</category>\n      <category>Open Source</category>\n      <category>Rust</category>\n      <category>WebAssembly</category>\n      <category>Workers</category>\n      <content:encoded><![CDATA[<p>We <a href=\"https://blog.cloudflare.com/kitesurf/\"><span style=\"text-decoration:underline\">introduced</span></a> <a href=\"https://kitesurf.dev/\"><span style=\"text-decoration:underline\">Kitesurf</span></a>, our stateless browser for AI agents that runs entirely on top of Workers, in August and <a href=\"https://blog.cloudflare.com/kitesurf-update/\"><span style=\"text-decoration:underline\">followed up</span></a> in September with WebMCP support, new APIs, and improved compatibility. On every occasion, we mentioned our commitment to open sourcing it so that developers could run their own browser engine on their own Cloudflare accounts if they want to.</p><p>That promise is now real. <a href=\"https://github.com/cloudflare/kitesurf\"><span style=\"text-decoration:underline\">Kitesurf is open source on GitHub</span></a> under the Apache 2.0 license. You can read the code, run it locally]]></content:encoded>\n      <enclosure url=\"https://blog.cloudflare.com/_emdash/api/media/file/01M7B8M53647Q1KNRABY8VM2G7.png\" type=\"image/png\" length=\"0\"/>\n      <guid isPermaLink=\"false\">01M7B8MAKWAA44XACM7ZT7P4NN</guid>\n    </item>\n<item>\n      <title>Adapting to AI penetration testing orchestrators: The Modern Security Model</title>\n      <link>https://blog.cloudflare.com/adapting-to-ai-penetration-testing-orchestrators/</link>\n      <pubDate>Fri, 13 Nov 2026 19:26:07 GMT</pubDate>\n      <description>AI-orchestrated penetration testing platforms like ARTEX have become increasingly powerful tools enabling effective attacks on exposed infrastructure. Here we share Cloudflare’s observations and recommended countermeasures.</description>\n      <dc:creator>Blake Darché</dc:creator>\n      <dc:creator>Myles Sloan</dc:creator>\n      <dc:creator>Jacob Crisp</dc:creator>\n      <dc:creator>Cloudforce One</dc:creator>\n      <category>Attacks</category>\n      <category>LLM</category>\n      <category>Penetration Testing</category>\n      <category>Security</category>\n      <content:encoded><![CDATA[<p>Over the last month, the number of Large Language Model (LLM) penetration testing and orchestration frameworks has exploded. Just a few weeks ago, ARTEX — an open source agentic penetration testing system that automates offensive security workflows — was the only framework available. In just the last three days, we have seen over 50 framework families attempt to scan Cloudflare customers globally. The number of Internet Protocol (IP) addresses seen running these frameworks has grown into the thousands and continues to increase daily. The proliferation of these frameworks has significantly changed the status quo in cyber defense: defenders are struggling to keep up with the volumetric nature of these autonomously guided attacks.</p><p>ARTEX was taken down by its creator Autumn-27 on October 8. (“The malicious exploitation of this tool runs entirely counter to its original]]></content:encoded>\n      <enclosure url=\"https://blog.cloudflare.com/_emdash/api/media/file/01M7B3YN6VXD98D313GQ0MHPM2.png\" type=\"image/png\" length=\"0\"/>\n      <guid isPermaLink=\"false\">01M7B3YSRJB0B2GD4ZN00Q227F</guid>\n    </item>\n  </channel>\n</rss>","atom":"<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<feed xml:lang=\"en-us\" xmlns=\"http://www.w3.org/2005/Atom\"><title>Simon Willison's Weblog</title><link href=\"http://simonwillison.net/\" rel=\"alternate\"/><link href=\"http://simonwillison.net/atom/everything/\" rel=\"self\"/><id>http://simonwillison.net/</id><updated>2026-11-13T23:02:45+00:00</updated><author><name>Simon Willison</name></author><entry><title>datasette-cluster-map 0.19</title><link href=\"https://simonwillison.net/2026/Nov/13/datasette-cluster-map/\" rel=\"alternate\"/><published>2026-11-13T23:02:45+00:00</published><updated>2026-11-13T23:02:45+00:00</updated><id>https://simonwillison.net/2026/Nov/13/datasette-cluster-map/</id><summary type=\"html\">\n    \n        &lt;p&gt;&lt;strong&gt;Release:&lt;/strong&gt; &lt;a href=\"https://github.com/simonw/datasette-cluster-map/releases/tag/0.19\"&gt;datasette-cluster-map 0.19&lt;/a&gt;&lt;/p&gt;\n        &lt;p&gt;One of the oldest Datasette plugins, and still one of my favorites. It now works with Datasette 1.0a42, and depends on &lt;a href=\"https://simonwillison.net/2026/Nov/13/datasette-leaflet/\"&gt;the new datasette-leaflet&lt;/a&gt; to ensure OpenStreetMap tiles are requested with a referrer header.&lt;/p&gt;\n&lt;p&gt;Here's &lt;a href=\"https://datasette.io/global-power-plants/global-power-plants?owner=Pacific+Gas+%26+Electric+Co.\"&gt;a map of power plants owned by California's PG&amp;amp;E&lt;/a&gt;, also demonstrating Datasette's recently &lt;a href=\"https://github.com/simonw/datasette/pull/3032\"&gt;redesigned facets&lt;/a&gt;:&lt;/p&gt;\n&lt;p&gt;&lt;img alt=\"Screenshot of a faceted map interface. Three facet panels at the top: &amp;quot;country_long 1&amp;quot; with United States of America 81 selected; &amp;quot;owner 1&amp;quot; with Pacific Gas &amp;amp; Electric Co. 81 selected; &amp;quot;primary_fuel 5&amp;quot; listing Hydro 63, Solar 10, Gas 5, Storage 2, Nuclear 1. Each primary_fuel row has a pale blue horizontal bar behind its label, sized in proportion to its count: Hydro's bar fills most of the row width, Solar's is a short sliver, Gas's is shorter still, and Storage and Nuclear have only a thin strip at the left edge. Below is a Leaflet map with + and − zoom controls showing California and Nevada, with marker clusters across northern and central California: 9 near Redding, 21 near Chico, 2 to the west of Chico, 13 northeast of Sacramento, 7 east of Stockton, 6 at Oakland, 10 at Fresno, 9 west of Visalia, 2 north of Bakersfield, plus two individual blue pin</summary><category term=\"datasette\"/><category term=\"geospatial\"/><category term=\"openstreetmap\"/></entry>\n<entry><title>datasette-leaflet 0.3</title><link href=\"https://simonwillison.net/2026/Nov/13/datasette-leaflet/\" rel=\"alternate\"/><published>2026-11-13T22:30:54+00:00</published><updated>2026-11-13T22:30:54+00:00</updated><id>https://simonwillison.net/2026/Nov/13/datasette-leaflet/</id><summary type=\"html\">\n    \n        &lt;p&gt;&lt;strong&gt;Release:&lt;/strong&gt; &lt;a href=\"https://github.com/simonw/datasette-leaflet/releases/tag/0.3\"&gt;datasette-leaflet 0.3&lt;/a&gt;&lt;/p&gt;\n        &lt;p&gt;OpenStreetMap have a very reasonable policy that hits to their hosted tile server &lt;a href=\"https://wiki.openstreetmap.org/wiki/Referer\"&gt;should send a referrer header&lt;/a&gt;. Datasette table pages used the &lt;code&gt;Referrer-Policy: no-referrer&lt;/code&gt; HTTP header, causing plugins that loaded tiles from OpenStreetMap to violate that policy.&lt;/p&gt;\n&lt;p&gt;&lt;code&gt;datasette-leaflet&lt;/code&gt; is the plugin that loads a bundled Leaflet so other Datasette plugins can depend on it. It now sets the referrer policy on the tile requests themselves to &lt;code&gt;strict-origin-when-cross-origin&lt;/code&gt;, passing the host but not the full path to the page.&lt;/p&gt;\n    \n    \n        &lt;p&gt;Tags: &lt;a href=\"https://simonwillison.net/tags/leaflet\"&gt;leaflet&lt;/a&gt;, &lt;a href=\"https://simonwillison.net/tags/datasette\"&gt;datasette&lt;/a&gt;, &lt;a href=\"https://simonwillison.net/tags/openstreetmap\"&gt;openstreetmap&lt;/a&gt;&lt;/p&gt;\n    \n\n</summary><category term=\"leaflet\"/><category term=\"datasette\"/><category term=\"openstreetmap\"/></entry></feed>"};

// ---------- harness ----------
let hub, said, pending, calls, net;
const HOUR = 3600000, DAY = 24 * HOUR;

function makeHub(cfg = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(feature.schema);
  const kv = new Map();
  return {
    sql: { exec: (q, ...b) => { const r = db.prepare(q).all(...b); return { toArray: () => r }; } },
    get: k => (kv.has(k) ? kv.get(k) : null), set: (k, v) => void kv.set(k, String(v)),
    edit: { cfg: (c, k) => (k in cfg ? cfg[k] : feature.tunables[k].default) },
    ctx: { waitUntil: p => void pending.push(p) },
    say: async (conv, text) => void said.push({ conv, text }),
    db,
  };
}
const tool = (conv = "t:a") => feature.tools({ hub, conv, askers: [{ name: "小明" }], host: {} })[0];
const run = (a, conv) => tool(conv).run(a);
const settle = async () => { while (pending.length) await pending.shift(); };
const feedRow = id => hub.db.prepare("SELECT * FROM feed WHERE id=?").get(id);
const itemRows = id => hub.db.prepare("SELECT * FROM feeditem WHERE feed=? ORDER BY id").all(id);
const count = (t, w = "1") => hub.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${w}`).get().n;

/** An RSS document whose items are dated relative to the real clock. */
const rssDoc = (items, title = "Test Blog") =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://e.test/</link>` +
  items.map(i => `<item><title>${i.t ?? "post " + i.g}</title><link>https://e.test/${i.g}</link><guid>${i.g}</guid><pubDate>${new Date(i.at ?? Date.now() - HOUR).toUTCString()}</pubDate><description>${i.d ?? "body of " + i.g}</description></item>`).join("") +
  `</channel></rss>`;
const ok = (body, headers = {}) => () => new Response(body, { status: 200, headers: { "content-type": "application/rss+xml", ...headers } });
const URL_A = "https://a.test/feed.xml", URL_B = "https://b.test/rss";

beforeEach(() => {
  said = []; pending = []; calls = []; net = {};
  deps.random = () => 0;
  deps.fetch = async (url, init) => {
    calls.push({ url, headers: init?.headers || {}, signal: init?.signal });
    const h = net[url];
    if (!h) return new Response("nope", { status: 404 });
    return h(init);
  };
  hub = makeHub();
});

const add = (a = {}, conv) => run({ op: "add", url: URL_A, ...a }, conv);
const addFeed = async (url, doc, a = {}, conv) => { net[url] = ok(doc, { etag: '"e1"', "last-modified": "Sat, 14 Nov 2026 19:00:00 GMT" }); return add({ url, ...a }, conv); };

// ---------- the reader on real samples ----------
describe("parsing real feeds", () => {
  test("RSS 2.0 (Cloudflare blog): title, link, guid, date, summary, authors, categories", () => {
    const p = parseFeed(S.rss);
    assert.equal(p.format, "rss");
    assert.equal(p.title, "Cloudflare Blog");
    assert.equal(p.items.length, 2);
    const it = p.items[0];
    assert.equal(it.title, "Kitesurf is now open source");
    assert.equal(it.link, "https://blog.cloudflare.com/kitesurf-open-source/");
    assert.equal(it.guid, "01M7B8MAKWAA44XACM7ZT7P4NN");
    assert.equal(it.published, Date.UTC(2026, 10, 13, 20, 20, 21));
    assert.match(it.summary, /^Kitesurf, our experimental browser engine/);
    assert.equal(it.authors.length, 4);
    assert.ok(it.categories.includes("Open Source"));
  });
  test("Atom (Simon Willison): alternate link, HTML summary stripped, dates, categories", () => {
    const p = parseFeed(S.atom);
    assert.equal(p.format, "atom");
    assert.equal(p.title, "Simon Willison's Weblog");
    const it = p.items[0];
    assert.equal(it.link, "https://simonwillison.net/2026/Nov/13/datasette-cluster-map/");
    assert.equal(it.guid, it.link);
    assert.equal(it.published, Date.UTC(2026, 10, 13, 23, 2, 45));
    assert.match(it.summary, /^Release: datasette-cluster-map 0\.19 One of the oldest Datasette plugins/);
    assert.ok(!/[<>]|&lt;|&gt;/.test(it.summary.replace(/<img.*/, "")), "tags are gone");
    assert.deepEqual(it.categories.slice(0, 2), ["datasette", "geospatial"]);
    assert.ok(it.summary.length <= 400);
  });
  test("GitHub releases: tag title, escaped HTML body to plain text, percent-encoded link kept", () => {
    const p = parseFeed(S.githubReleases);
    assert.equal(p.title, "Release notes from workers-sdk");
    assert.equal(p.items[0].title, "wrangler@4.162.0");
    assert.equal(p.items[0].link, "https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.162.0");
    assert.equal(p.items[0].guid, "tag:github.com,2008:Repository/426659329/wrangler@4.162.0");
    assert.equal(p.items[0].published, Date.UTC(2026, 10, 13, 17, 11, 41));
    assert.match(p.items[0].summary, /^Minor Changes #16735 f005593 Thanks @leostera! - Use the local simulator/);
    assert.ok(!p.items[0].summary.includes("<"));
    assert.ok(p.items[0].summary.length <= 400);
  });
  test("GitHub commits: whitespace-padded title trimmed, entities decoded", () => {
    const p = parseFeed(S.githubCommits);
    assert.equal(p.items[0].title, "[wrangler] Reuse OAuth credentials refreshed by another process (#16874)");
    assert.match(p.items[0].summary, /Co-authored-by: clanky-the-clanker\[bot\] <342202840\+/);
    assert.equal(p.items[0].link, "https://github.com/cloudflare/workers-sdk/commit/4335eacef350c98722418fbb58b012a6964e26d7");
  });
  test("arXiv API (Atom): authors, categories, id, dates, summary with head line", () => {
    const p = parseFeed(S.arxivApi);
    const it = p.items[0];
    assert.equal(it.guid, "http://arxiv.org/abs/2611.17336v1");
    assert.equal(it.link, "https://arxiv.org/abs/2611.17336v1");
    assert.equal(it.title, "Back to Pixels: Lifting Latent Video Diffusion into Pixel Space");
    assert.equal(it.authors.length, 12);
    assert.deepEqual(it.categories, ["cs.CV"]);
    assert.equal(it.published, Date.UTC(2026, 10, 12, 18, 59, 55));
    assert.match(it.summary, /^\[cs\.CV\] Yanke Song, Shuo Chen, Chris Rockwell 等 12 人：Frontier video generation models/);
    assert.ok(it.summary.length <= 400);
  });
  test("arXiv category RSS as served on a weekend: valid channel, zero items", () => {
    const p = parseFeed(S.arxivRssEmpty);
    assert.equal(p.title, "cs.AI updates on arXiv.org");
    assert.equal(p.items.length, 0);
  });
  test("arXiv category RSS item (documented layout): announce prefix removed, authors split, offset date", () => {
    const xml = S.arxivRssEmpty.replace("</channel>", `<item><title>Attention Is Not All You Need</title><link>https://arxiv.org/abs/2511.01234</link><description>arXiv:2511.01234v1 Announce Type: new \nAbstract: We study how often it is not.</description><guid isPermaLink="false">oai:arXiv.org:2511.01234v1</guid><category>cs.AI</category><category>cs.LG</category><pubDate>Mon, 17 Nov 2025 00:00:00 -0500</pubDate><arxiv:announce_type>new</arxiv:announce_type><dc:creator>Ada Lovelace, Alan Turing, Grace Hopper, Edsger Dijkstra</dc:creator></item></channel>`);
    const it = parseFeed(xml).items[0];
    assert.equal(it.guid, "oai:arXiv.org:2511.01234v1");
    assert.equal(it.published, Date.UTC(2025, 10, 17, 5, 0, 0));
    assert.equal(it.summary, "[cs.AI, cs.LG] Ada Lovelace, Alan Turing, Grace Hopper 等 4 人：We study how often it is not.");
  });
  test("hnrss: CDATA titles, guid, comments link as the summary", () => {
    const p = parseFeed(S.hnrss);
    assert.equal(p.title, "Hacker News: Front Page");
    assert.equal(p.items[0].title, "LinkedIn, Monster take down over 1000 fake job postings after CBC investigation");
    assert.equal(p.items[0].guid, "https://news.ycombinator.com/item?id=50499723");
    assert.equal(p.items[0].link, "https://www.cbc.ca/news/canada/linkedin-monster-take-down-over-1-000-fake-job-postings-after-cbc-investigation-9.7415379");
    assert.equal(p.items[0].summary, "讨论：https://news.ycombinator.com/item?id=50499723");
    assert.equal(p.items[0].published, Date.UTC(2026, 10, 14, 18, 56, 47));
  });
  test("YouTube channel feed: yt:video id, watch link, media:description as summary", () => {
    const it = parseFeed(S.youtube).items[0];
    assert.equal(it.guid, "yt:video:SOwUWPtXQ9I");
    assert.equal(it.link, "https://www.youtube.com/watch?v=SOwUWPtXQ9I");
    assert.equal(it.published, Date.UTC(2026, 10, 12, 21, 17, 10));
    assert.match(it.summary, /^Manufact is the easiest way to build and deploy your MCP/);
    assert.equal(parseFeed(S.youtube).title, "Fireship");
  });
  test("not a feed", () => {
    assert.throws(() => parseFeed("<html><body>hello</body></html>"), /不是订阅源/);
    assert.throws(() => parseFeed(""), /不是订阅源/);
  });
});

describe("reader details", () => {
  test("dates: RFC 822 variants and ISO 8601", () => {
    const t = Date.UTC(2026, 10, 14, 18, 56, 47);
    assert.equal(parseDate("Sat, 14 Nov 2026 18:56:47 +0000"), t);
    assert.equal(parseDate("Sat, 14 Nov 2026 18:56:47 GMT"), t);
    assert.equal(parseDate("14 Nov 2026 18:56:47 UT"), t);
    assert.equal(parseDate("Sat, 14 Nov 2026 13:56:47 -0500"), t);
    assert.equal(parseDate("Sat, 14 Nov 2026 13:56:47 EST"), t);
    assert.equal(parseDate("Sun, 15 Nov 2026 02:56:47 +0800"), t);
    assert.equal(parseDate("Sat, 14 Nov 26 18:56 Z"), Date.UTC(2026, 10, 14, 18, 56, 0));
    assert.equal(parseDate("2026-11-14T18:56:47Z"), t);
    assert.equal(parseDate("2026-11-14T18:56:47+00:00"), t);
    assert.equal(parseDate("2026-11-15T02:56:47.000+08:00"), t);
    assert.equal(parseDate("2026-11-14 18:56:47"), t);
    assert.equal(parseDate("2026-11-14"), Date.UTC(2026, 10, 14));
    assert.equal(parseDate("yesterday"), null);
    assert.equal(parseDate(""), null);
    assert.equal(parseDate(undefined), null);
  });
  test("entities, CDATA and HTML in titles and summaries", () => {
    const xml = `<rss version="2.0"><channel><title>AT&amp;T &#8212; news</title><item>
      <title><![CDATA[Tom &amp; <b>Jerry</b>]]></title><link>https://e.test/1</link><guid>1</guid>
      <description><![CDATA[<p>It&#8217;s &quot;fine&quot;&nbsp;now</p><script>alert(1)</script><ul><li>one</li><li>two &#x4e2d;&#25991;</li></ul>]]></description></item>
      <item><title>Escaped &lt;i&gt;html&lt;/i&gt; &amp;amp; more</title><guid>2</guid><description>&lt;p&gt;Fish &amp;amp; chips&lt;br/&gt;second&lt;/p&gt;</description></item></channel></rss>`;
    const p = parseFeed(xml);
    assert.equal(p.title, "AT&T — news");
    assert.equal(p.items[0].title, "Tom & Jerry");
    assert.equal(p.items[0].summary, "It’s \"fine\" now one two 中文");
    assert.equal(p.items[1].title, "Escaped html & more");
    assert.equal(p.items[1].summary, "Fish & chips second");
    assert.equal(p.items[1].link, "");
  });
  test("tolerant of junk: comments, stray <, unclosed tags, missing channel, RDF items", () => {
    const messy = `<?xml version="1.0"?><!-- c --><rss><channel><title>T</title><item><title>a < b</title><guid>1</guid><description><p>one<br>two</p></description></item><item><title>second<guid>2</guid></item></channel>`;
    const p = parseFeed(messy);
    assert.equal(p.items.length, 2);
    assert.equal(p.items[0].title, "a < b");
    assert.equal(p.items[0].summary, "one two");
    const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel rdf:about="x"><title>Old Site</title></channel><item rdf:about="https://old.test/a"><title>A</title><link>https://old.test/a</link><dc:date>2026-11-01T10:00:00+09:00</dc:date></item></rdf:RDF>`;
    const r = parseFeed(rdf);
    assert.equal(r.title, "Old Site");
    assert.equal(r.items[0].guid, "https://old.test/a");
    assert.equal(r.items[0].published, Date.UTC(2026, 10, 1, 1, 0, 0));
  });
  test("link choice: rel=alternate wins, self is ignored, relative links resolved, summary clipped to 400", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><entry><id>e1</id><title>E</title>
      <link rel="self" href="https://e.test/self"/><link rel="enclosure" href="https://e.test/a.mp3"/><link rel="alternate" href="/posts/1"/>
      <updated>2026-11-01T00:00:00Z</updated><content type="html">${"x".repeat(900)}</content></entry></feed>`;
    const it = parseFeed(xml, "https://e.test/feed").items[0];
    assert.equal(it.link, "https://e.test/posts/1");
    assert.equal(it.summary.length, 400);
    assert.ok(it.summary.endsWith("…"));
    assert.equal(it.published, Date.UTC(2026, 10, 1));
  });
  test("discoverFeed finds the advertised feed in a web page", () => {
    const html = `<html><head><link rel="stylesheet" href="/a.css"><link rel="alternate" type="application/rss+xml" title="t" href="/feed.xml"></head></html>`;
    assert.equal(discoverFeed(html, "https://site.test/blog/"), "https://site.test/feed.xml");
    assert.equal(discoverFeed("<html></html>", "https://site.test/"), null);
  });
});

describe("shorthand", () => {
  test("github, arxiv, hn, youtube, plain URLs", () => {
    assert.deepEqual(expandSource("github:cloudflare/workers-sdk"), { url: "https://github.com/cloudflare/workers-sdk/releases.atom" });
    assert.deepEqual(expandSource("github:o/r@dev"), { url: "https://github.com/o/r/commits/dev.atom" });
    assert.deepEqual(expandSource("https://github.com/o/r"), { url: "https://github.com/o/r/releases.atom" });
    assert.deepEqual(expandSource("https://github.com/o/r/releases"), { url: "https://github.com/o/r/releases.atom" });
    assert.deepEqual(expandSource("https://github.com/o/r/commits/main"), { url: "https://github.com/o/r/commits/main.atom" });
    assert.deepEqual(expandSource("arxiv:cs.AI"), { url: "https://rss.arxiv.org/rss/cs.AI" });
    assert.deepEqual(expandSource("arxiv:cs.ai"), { url: "https://rss.arxiv.org/rss/cs.AI" });
    assert.deepEqual(expandSource("arxiv:stat.ML"), { url: "https://rss.arxiv.org/rss/stat.ML" });
    assert.deepEqual(expandSource("arxiv:physics.optics"), { url: "https://rss.arxiv.org/rss/physics.optics" });
    assert.deepEqual(expandSource("arxiv:diffusion"), { url: "https://export.arxiv.org/api/query?search_query=all:diffusion&sortBy=submittedDate&sortOrder=descending&max_results=20" });
    assert.deepEqual(expandSource("arxiv:video diffusion model"), { url: "https://export.arxiv.org/api/query?search_query=all:video+AND+all:diffusion+AND+all:model&sortBy=submittedDate&sortOrder=descending&max_results=20" });
    assert.deepEqual(expandSource("hn"), { url: "https://hnrss.org/frontpage" });
    assert.deepEqual(expandSource("youtube:UCsBjURrPoezykLs9EqgamOA"), { url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCsBjURrPoezykLs9EqgamOA" });
    assert.deepEqual(expandSource("https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA"), { url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCsBjURrPoezykLs9EqgamOA" });
    assert.deepEqual(expandSource("https://blog.example.com/rss"), { url: "https://blog.example.com/rss" });
  });
  test("refusals: bilibili, bad shorthand, Chinese arXiv keywords, junk", () => {
    assert.match(expandSource("https://space.bilibili.com/2267573").error, /B 站没有订阅源/);
    assert.match(expandSource("bilibili:2267573").error, /B 站没有订阅源/);
    assert.match(expandSource("github:oops").error, /github:owner\/repo/);
    assert.match(expandSource("arxiv:扩散模型").error, /英文/);
    assert.match(expandSource("ftp://x.test/f").error, /http/);
    assert.match(expandSource("").error, /订阅源/);
    assert.match(expandSource("foo:bar").error, /不认识/);
  });
});

// ---------- the tool ----------
describe("add / list / remove", () => {
  test("add validates by fetching, reports title and the three newest items, stores everything quietly", async () => {
    net[URL_A] = ok(rssDoc([{ g: "1", at: Date.now() - 5 * HOUR }, { g: "2", at: Date.now() - 4 * HOUR }, { g: "3", at: Date.now() - 3 * HOUR }, { g: "4", at: Date.now() - 2 * HOUR }]), { etag: '"v1"' });
    const r = await add({ notify: true });
    assert.equal(r.ok, true);
    assert.equal(r.title, "Test Blog");
    assert.equal(r.kind, "rss");
    assert.deepEqual(r.newest.map(x => x.title), ["post 4", "post 3", "post 2"]);
    assert.equal(r.newest[0].link, "https://e.test/4");
    assert.equal(calls.length, 1);
    assert.equal(count("feeditem"), 4);
    assert.equal(said.length, 0, "first fetch announces nothing, even with notify");
    const f = feedRow(r.id);
    assert.equal(f.every_min, 60);
    assert.equal(f.notify, 1);
    assert.equal(f.etag, '"v1"');
    assert.equal(f.active, 1);
    assert.equal(f.by, "小明");
    assert.ok(f.last > 0 && f.next > f.last);
  });
  test("shorthand is expanded before fetching; GitHub kind is recorded", async () => {
    net["https://github.com/o/r/releases.atom"] = ok(S.githubReleases);
    const r = await run({ op: "add", url: "github:o/r" });
    assert.equal(r.ok, true);
    assert.equal(calls[0].url, "https://github.com/o/r/releases.atom");
    assert.equal(r.kind, "github-releases");
    assert.equal(r.title, "Release notes from workers-sdk");
    assert.equal(r.newest[0].title, "wrangler@4.162.0");
  });
  test("arXiv search feeds get a readable name; an empty weekend feed is accepted", async () => {
    net["https://export.arxiv.org/api/query?search_query=all:diffusion&sortBy=submittedDate&sortOrder=descending&max_results=20"] = ok(S.arxivApi);
    const a = await run({ op: "add", url: "arxiv:diffusion" });
    assert.equal(a.title, "arXiv 搜索：diffusion");
    assert.equal(a.kind, "arxiv");
    net["https://rss.arxiv.org/rss/cs.AI"] = ok(S.arxivRssEmpty);
    const b = await run({ op: "add", url: "arxiv:cs.AI" });
    assert.equal(b.ok, true);
    assert.equal(b.newest.length, 0);
    assert.match(b.note, /一条内容都没有/);
  });
  test("a site address that advertises a feed is followed once", async () => {
    net["https://site.test/"] = ok(`<html><head><link rel="alternate" type="application/atom+xml" href="/atom.xml"></head></html>`, { "content-type": "text/html" });
    net["https://site.test/atom.xml"] = ok(S.atom);
    const r = await run({ op: "add", url: "https://site.test/" });
    assert.equal(r.ok, true);
    assert.equal(r.url, "https://site.test/atom.xml");
    assert.equal(feedRow(r.id).url, "https://site.test/atom.xml");
  });
  test("a YouTube @handle is resolved through the channel page", async () => {
    net["https://www.youtube.com/@Fireship"] = ok(`<html><head><link rel="canonical" href="https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA"></head></html>`, { "content-type": "text/html" });
    net["https://www.youtube.com/feeds/videos.xml?channel_id=UCsBjURrPoezykLs9EqgamOA"] = ok(S.youtube);
    const r = await run({ op: "add", url: "https://www.youtube.com/@Fireship" });
    assert.equal(r.ok, true);
    assert.equal(r.kind, "youtube");
    assert.equal(r.title, "Fireship");
  });
  test("bilibili, non-feeds, dead links and oversize bodies are refused without storing anything", async () => {
    assert.match((await run({ op: "add", url: "https://space.bilibili.com/1" })).error, /B 站没有订阅源/);
    net[URL_A] = ok("<html><body>no feed here</body></html>", { "content-type": "text/html" });
    assert.match((await add()).error, /不是订阅源/);
    assert.match((await add({ url: "https://dead.test/x" })).error, /404/);
    net[URL_B] = ok("x".repeat(LIMITS.maxBytes + 10));
    assert.match((await add({ url: URL_B })).error, /太大/);
    net["https://big.test/f"] = ok("<rss/>", { "content-length": String(LIMITS.maxBytes + 1) });
    assert.match((await add({ url: "https://big.test/f" })).error, /太大/);
    assert.equal(count("feed"), 0);
    assert.equal(count("feeditem"), 0);
  });
  test("interval is clamped to 15 minutes..7 days, default 60", async () => {
    net[URL_A] = ok(rssDoc([]));
    assert.equal(feedRow((await add({ every: 1 })).id).every_min, 15);
    net[URL_B] = ok(rssDoc([]));
    assert.equal(feedRow((await add({ url: URL_B, every: 999999 })).id).every_min, 10080);
    net["https://c.test/"] = ok(rssDoc([]));
    assert.equal(feedRow((await add({ url: "https://c.test/", every: 120 })).id).every_min, 120);
  });
  test("adding the same source again updates it (and revives a paused one) instead of duplicating", async () => {
    net[URL_A] = ok(rssDoc([{ g: "1" }]));
    const r = await add();
    hub.db.prepare("UPDATE feed SET active=0, fails=10 WHERE id=?").run(r.id);
    const r2 = await add({ notify: true, every: 30, title: "我的博客" });
    assert.equal(r2.id, r.id);
    assert.match(r2.already, /订过/);
    const f = feedRow(r.id);
    assert.deepEqual([f.active, f.fails, f.notify, f.every_min, f.title], [1, 0, 1, 30, "我的博客"]);
    assert.equal(count("feed"), 1);
  });
  test("at most 40 feeds per conversation; list and remove are per conversation", async () => {
    for (let i = 0; i < 40; i++) { net[`https://s${i}.test/f`] = ok(rssDoc([], "S" + i)); assert.equal((await add({ url: `https://s${i}.test/f` })).ok, true); }
    net[URL_A] = ok(rssDoc([]));
    assert.match((await add()).error, /40/);
    assert.equal((await add({}, "t:other")).ok, true, "another conversation has its own allowance");
    const l = await run({ op: "list" });
    assert.equal(l.count, 40);
    assert.equal(l.feeds[0].status, "在订");
    assert.equal(l.feeds[0].every, "1 小时");
    assert.equal((await run({ op: "remove", id: l.feeds[0].id }, "t:other")).ok, false);
    const rm = await run({ op: "remove", id: l.feeds[0].id });
    assert.equal(rm.ok, true);
    assert.equal(count("feed", "conv='t:a'"), 39);
    assert.equal(count("feeditem", `feed=${l.feeds[0].id}`), 0);
  });
  test("remove by name; ambiguous names ask for the id", async () => {
    net[URL_A] = ok(rssDoc([], "Rust Blog")); net[URL_B] = ok(rssDoc([], "Rust Weekly"));
    await add(); await add({ url: URL_B });
    assert.match((await run({ op: "remove", feed: "rust" })).error, /好几个/);
    assert.equal((await run({ op: "remove", feed: "weekly" })).ok, true);
    assert.equal(count("feed"), 1);
  });
});

// ---------- checking ----------
describe("checks", () => {
  test("first fetch does not flood; later new items are announced once, as one line each", async () => {
    const old = [{ g: "1", at: Date.now() - 3 * HOUR }, { g: "2", at: Date.now() - 2 * HOUR }];
    net[URL_A] = ok(rssDoc(old));
    const r = await add({ notify: true, title: "博客" });
    assert.equal(said.length, 0);
    net[URL_A] = ok(rssDoc([...old, { g: "3", t: "Third post", at: Date.now() - 60000 }]));
    const res = await checkFeed(hub, feedRow(r.id), Date.now() + 3600000);
    assert.deepEqual([res.ok, res.added], [true, 1]);
    assert.equal(said.length, 1);
    assert.equal(said[0].conv, "t:a");
    assert.equal(said[0].text, "【博客】Third post https://e.test/3");
    await checkFeed(hub, feedRow(r.id), Date.now() + 2 * 3600000);
    assert.equal(said.length, 1, "nothing new, nothing said");
  });
  test("a feed row that has never been fetched also fills quietly on its first check", async () => {
    hub.db.prepare("INSERT INTO feed(conv,url,title,kind,every_min,last,next,fails,active,notify,by,created) VALUES('t:a',?,'X','rss',60,NULL,0,0,1,1,'u',1)").run(URL_A);
    net[URL_A] = ok(rssDoc([{ g: "1" }, { g: "2" }]));
    const res = await checkFeed(hub, feedRow(1), Date.now());
    assert.equal(res.added, 0);
    assert.equal(said.length, 0);
    assert.equal(count("feeditem"), 2);
  });
  test("silent feeds store items but never speak", async () => {
    net[URL_A] = ok(rssDoc([{ g: "1" }]));
    const r = await add();
    net[URL_A] = ok(rssDoc([{ g: "1" }, { g: "2" }, { g: "3" }]));
    const res = await checkFeed(hub, feedRow(r.id), Date.now() + HOUR);
    assert.equal(res.added, 2);
    assert.equal(said.length, 0);
    assert.equal(count("feeditem"), 3);
  });
  test("de-duplication by guid: repeats and edited titles do not make new rows or announcements", async () => {
    net[URL_A] = ok(rssDoc([{ g: "1" }, { g: "1" }, { g: "2" }]));
    const r = await add({ notify: true });
    assert.equal(count("feeditem"), 2);
    net[URL_A] = ok(rssDoc([{ g: "1", t: "edited title" }, { g: "2" }]));
    const res = await checkFeed(hub, feedRow(r.id), Date.now() + HOUR);
    assert.equal(res.added, 0);
    assert.equal(count("feeditem"), 2);
    assert.equal(said.length, 0);
  });
  test("conditional requests: validators are sent, 304 keeps the items and moves next", async () => {
    net[URL_A] = ok(rssDoc([{ g: "1" }, { g: "2" }]), { etag: 'W/"abc"', "last-modified": "Sat, 14 Nov 2026 19:00:00 GMT" });
    const r = await add({ every: 30 });
    assert.equal(calls[0].headers["if-none-match"], undefined);
    assert.ok(calls[0].signal, "a timeout signal is attached");
    net[URL_A] = init => (init.headers["if-none-match"] === 'W/"abc"' && init.headers["if-modified-since"] === "Sat, 14 Nov 2026 19:00:00 GMT" ? new Response(null, { status: 304 }) : new Response("wrong", { status: 500 }));
    hub.db.prepare("UPDATE feed SET fails=3 WHERE id=?").run(r.id);
    const now = Date.now() + 3 * HOUR;
    const res = await checkFeed(hub, feedRow(r.id), now);
    assert.deepEqual([res.ok, res.notModified], [true, true]);
    const f = feedRow(r.id);
    assert.equal(f.next, now + 30 * 60000);
    assert.equal(f.last, now);
    assert.equal(f.fails, 0);
    assert.equal(f.etag, 'W/"abc"');
    assert.equal(count("feeditem"), 2);
    // `fresh` (admin) skips the validators
    net[URL_A] = ok(rssDoc([{ g: "1" }, { g: "2" }, { g: "9" }]));
    await checkFeed(hub, feedRow(r.id), now + HOUR, true);
    assert.equal(calls.at(-1).headers["if-none-match"], undefined);
    assert.equal(count("feeditem"), 3);
  });
  test("failures back off exponentially, pause at 10 with a single message, and a re-add revives", async () => {
    net[URL_A] = ok(rssDoc([{ g: "1" }]));
    const r = await add({ every: 60, title: "坏掉的源" });
    net[URL_A] = () => new Response("boom", { status: 503 });
    let now = Date.now();
    const gaps = [];
    for (let i = 1; i <= 10; i++) {
      now += DAY;
      const res = await checkFeed(hub, feedRow(r.id), now);
      assert.equal(res.ok, false);
      const f = feedRow(r.id);
      gaps.push(f.next - now);
      assert.equal(f.fails, i);
      assert.equal(f.active, i < 10 ? 1 : 0);
      assert.equal(said.length, i < 10 ? 0 : 1);
    }
    assert.deepEqual(gaps.slice(0, 5), [2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR, DAY]);
    assert.equal(gaps[9], DAY, "capped at a day");
    assert.match(said[0].text, /坏掉的源.*10 次/s);
    assert.equal(count("feeditem"), 1, "items survive failures");
    hub.db.prepare("UPDATE feed SET next=0 WHERE id=?").run(r.id);
    feature.tick(hub, now + DAY); await settle();
    assert.equal(calls.filter(c => c.url === URL_A).length, 1 + 10, "paused feeds are not fetched");
    net[URL_A] = ok(rssDoc([{ g: "1" }, { g: "7" }]));
    assert.equal((await add()).ok, true);
    assert.deepEqual([feedRow(r.id).active, feedRow(r.id).fails], [1, 0]);
  });
  test("timeouts and network errors count as failures", async () => {
    net[URL_A] = ok(rssDoc([{ g: "1" }]));
    const r = await add();
    net[URL_A] = () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };
    let res = await checkFeed(hub, feedRow(r.id), Date.now() + HOUR);
    assert.match(res.error, /超时/);
    net[URL_A] = () => { throw new Error("socket closed"); };
    res = await checkFeed(hub, feedRow(r.id), Date.now() + 2 * HOUR);
    assert.match(res.error, /连不上/);
    assert.equal(feedRow(r.id).fails, 2);
    net[URL_A] = ok(rssDoc([{ g: "1" }]));
    await checkFeed(hub, feedRow(r.id), Date.now() + 3 * HOUR);
    assert.equal(feedRow(r.id).fails, 0, "a good fetch clears the count");
  });
  test("a 2 MB body limit applies while streaming, not only to the header", async () => {
    net[URL_A] = ok(rssDoc([{ g: "1" }]));
    const r = await add();
    const big = new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(600 * 1024).fill(65)); c.close(); } });
    net[URL_A] = () => new Response(big, { status: 200 });
    const res = await checkFeed(hub, feedRow(r.id), Date.now() + HOUR);
    assert.equal(res.ok, false);
    assert.match(res.error, /太大/);
  });
});

describe("notification caps", () => {
  const burst = (from, n) => Array.from({ length: n }, (_, i) => ({ g: "n" + (from + i), t: "item " + (from + i), at: Date.now() - (n - i) * 60000 }));
  test("per feed: 5 a day, the newest five, one overflow line for the conversation", async () => {
    net[URL_A] = ok(rssDoc([{ g: "base" }]));
    const r = await add({ notify: true, title: "源" });
    net[URL_A] = ok(rssDoc([{ g: "base" }, ...burst(1, 8)]));
    const now = Date.now() + HOUR;
    await checkFeed(hub, feedRow(r.id), now);
    assert.equal(said.length, 1);
    const lines = said[0].text.split("\n");
    assert.equal(lines.length, 6);
    assert.deepEqual(lines.slice(0, 5).map(l => l.match(/item (\d+)/)[1]), ["4", "5", "6", "7", "8"], "oldest to newest of the newest five");
    assert.match(lines[5], /还有 3 条没逐条发/);
    net[URL_A] = ok(rssDoc([{ g: "base" }, ...burst(1, 12)]));
    await checkFeed(hub, feedRow(r.id), now + HOUR);
    assert.equal(said.length, 1, "allowance spent: no more lines today, and the overflow note is not repeated");
    assert.equal(count("feeditem"), 13, "everything is still stored for latest");
    net[URL_A] = ok(rssDoc([{ g: "base" }, ...burst(1, 12), ...burst(100, 2)]));
    await checkFeed(hub, feedRow(r.id), now + DAY + 2 * HOUR);
    assert.equal(said.length, 2, "next day, the allowance is back");
    assert.equal(said[1].text.split("\n").length, 2);
  });
  test("per conversation: feeds_notify_daily caps all feeds together", async () => {
    hub = makeHub({ feeds_notify_daily: 7 });
    net[URL_A] = ok(rssDoc([])); net[URL_B] = ok(rssDoc([]));
    const a = await add({ notify: true }), b = await add({ url: URL_B, notify: true });
    net[URL_A] = ok(rssDoc(burst(1, 5))); net[URL_B] = ok(rssDoc(burst(50, 5)));
    const now = Date.now() + HOUR;
    await checkFeed(hub, feedRow(a.id), now);
    await checkFeed(hub, feedRow(b.id), now);
    const shown = said.flatMap(s => s.text.split("\n")).filter(l => l.startsWith("【"));
    assert.equal(shown.length, 7);
    assert.equal(said.flatMap(s => s.text.split("\n")).filter(l => /没逐条发/.test(l)).length, 1);
    assert.equal(count("feeditem"), 10);
  });
  test("the cap is per conversation, not shared between rooms", async () => {
    hub = makeHub({ feeds_notify_daily: 2 });
    net[URL_A] = ok(rssDoc([]));
    const a = await add({ notify: true }, "t:a"), b = await add({ notify: true }, "t:b");
    net[URL_A] = ok(rssDoc(burst(1, 2)));
    await checkFeed(hub, feedRow(a.id), Date.now() + HOUR);
    await checkFeed(hub, feedRow(b.id), Date.now() + HOUR);
    assert.deepEqual(said.map(s => s.conv).sort(), ["t:a", "t:b"]);
  });
});

describe("retention", () => {
  test("keeps the newest 200 items of a feed", async () => {
    const mk = (n, base = 0) => Array.from({ length: n }, (_, i) => ({ g: "g" + (base + i), at: Date.now() - (n - i + base) * 60000 }));
    net[URL_A] = ok(rssDoc(mk(210)));
    const r = await add();
    assert.equal(count("feeditem"), 200);
    assert.equal(count("feeditem", "guid='g0'"), 0, "the oldest ones are not kept");
    assert.equal(count("feeditem", "guid='g209'"), 1);
    net[URL_A] = ok(rssDoc([...mk(210), { g: "fresh", at: Date.now() }]));
    await checkFeed(hub, feedRow(r.id), Date.now() + HOUR);
    assert.equal(count("feeditem"), 200);
    assert.equal(count("feeditem", "guid='fresh'"), 1);
  });
  test("items older than 60 days (by first seen) are dropped on the daily sweep and on each fetch", async () => {
    net[URL_A] = ok(rssDoc([{ g: "1" }]));
    const r = await add();
    const now = Date.now();
    hub.db.prepare("INSERT INTO feeditem(feed,guid,title,link,summary,published,seen) VALUES(?,?,?,?,?,?,?)").run(r.id, "old", "old", "", "", null, now - 61 * DAY);
    hub.db.prepare("INSERT INTO feeditem(feed,guid,title,link,summary,published,seen) VALUES(?,?,?,?,?,?,?)").run(r.id, "mid", "mid", "", "", null, now - 59 * DAY);
    feature.tick(hub, now); await settle();
    assert.equal(count("feeditem", "guid='old'"), 0);
    assert.equal(count("feeditem", "guid='mid'"), 1);
    hub.db.prepare("UPDATE feeditem SET seen=? WHERE guid='mid'").run(now - 62 * DAY);
    await checkFeed(hub, feedRow(r.id), now + HOUR, true);
    assert.equal(count("feeditem", "guid='mid'"), 0);
    assert.equal(count("feeditem", "guid='1'"), 1);
  });
});

describe("latest and find", () => {
  async function setup() {
    net[URL_A] = ok(rssDoc([
      { g: "a1", t: "Rust 2.0 released", at: Date.now() - 2 * HOUR, d: "big compiler news" },
      { g: "a2", t: "Gardening tips", at: Date.now() - 30 * HOUR },
      { g: "a3", t: "Weekly notes", at: Date.now() - 5 * HOUR, d: "mentions rust briefly" },
    ], "Rust Blog"));
    net[URL_B] = ok(rssDoc([{ g: "b1", t: "Python 4 beta", at: Date.now() - HOUR }, { g: "b2", t: "Old python news", at: Date.now() - 100 * HOUR }], "Py News"));
    const a = await add(), b = await add({ url: URL_B });
    return { a, b };
  }
  test("grouped by feed, newest first, with links, within the hours window", async () => {
    const { a, b } = await setup();
    const r = await run({ op: "latest" });
    assert.equal(r.ok, true);
    assert.equal(r.hours, 24);
    assert.equal(r.count, 3);
    assert.deepEqual(r.groups.map(g => [g.feed, g.source]), [[b.id, "Py News"], [a.id, "Rust Blog"]]);
    const rust = r.groups[1];
    assert.deepEqual(rust.items.map(i => i.title), ["Rust 2.0 released", "Weekly notes"]);
    assert.equal(rust.items[0].link, "https://e.test/a1");
    assert.equal(rust.items[0].summary, "big compiler news");
    assert.match(rust.items[0].time, /\d/);
    const wide = await run({ op: "latest", hours: 200 });
    assert.equal(wide.count, 5);
  });
  test("filters: feed by id or name, keyword in title or summary, all words required", async () => {
    const { a, b } = await setup();
    assert.deepEqual((await run({ op: "latest", feed: b.id })).groups.map(g => g.source), ["Py News"]);
    assert.deepEqual((await run({ op: "latest", feed: "rust" })).groups.map(g => g.source), ["Rust Blog"]);
    const k = await run({ op: "latest", keyword: "rust" });
    assert.deepEqual(k.groups[0].items.map(i => i.title), ["Rust 2.0 released", "Weekly notes"], "summary match counts");
    assert.equal(k.groups.length, 1);
    assert.equal((await run({ op: "latest", keyword: "rust compiler" })).count, 1);
    const none = await run({ op: "latest", keyword: "zzz" });
    assert.equal(none.count, 0);
    assert.match(none.note, /没有新内容/);
    assert.match((await run({ op: "latest", feed: "nothing" })).error, /没有这个订阅/);
  });
  test("another conversation sees nothing; no subscriptions gives a plain note; wildcard characters are literal", async () => {
    await setup();
    assert.match((await run({ op: "latest" }, "t:other")).note, /还没订阅/);
    assert.equal((await run({ op: "latest", keyword: "%" })).count, 0);
    assert.equal((await run({ op: "latest", keyword: "_" })).count, 0);
  });
  test("items without a date use the time they were first seen; first-fetch items are kept for latest", async () => {
    net[URL_A] = ok(`<rss version="2.0"><channel><title>NoDates</title><item><title>undated</title><guid>u1</guid></item></channel></rss>`);
    await add();
    const r = await run({ op: "latest", hours: 1 });
    assert.equal(r.count, 1);
    assert.equal(r.groups[0].items[0].title, "undated");
  });
  test("find searches all stored items and shows the source", async () => {
    await setup();
    const r = await run({ op: "find", keyword: "python" });
    assert.deepEqual(r.items.map(i => [i.source, i.title]), [["Py News", "Python 4 beta"], ["Py News", "Old python news"]]);
    assert.equal((await run({ op: "find", keyword: "python", limit: 1 })).count, 1);
    assert.equal((await run({ op: "find", keyword: "python", feed: "rust" })).count, 0);
    assert.match((await run({ op: "find" })).error, /关键词/);
  });
  test("long lists are trimmed per feed with a count of what was left out", async () => {
    net[URL_A] = ok(rssDoc(Array.from({ length: 30 }, (_, i) => ({ g: "p" + i, at: Date.now() - i * 60000 }))));
    await add();
    const r = await run({ op: "latest" });
    assert.equal(r.groups[0].items.length, 12);
    assert.equal(r.groups[0].more, 18);
    assert.equal(r.count, 30);
  });
});

describe("tick and admin", () => {
  test("at most 3 due feeds per tick; claimed feeds are not picked twice; checks run through waitUntil", async () => {
    const ins = hub.db.prepare("INSERT INTO feed(conv,url,title,kind,every_min,last,next,fails,active,notify,by,created) VALUES('t:a',?,?,'rss',60,1,?,0,1,0,'u',1)");
    for (let i = 1; i <= 5; i++) { net[`https://t${i}.test/f`] = ok(rssDoc([{ g: "x" }], "T" + i)); ins.run(`https://t${i}.test/f`, "T" + i, 1000 * i); }
    ins.run("https://later.test/f", "later", Date.now() + DAY);
    hub.db.prepare("UPDATE feed SET active=0 WHERE url='https://t5.test/f'").run();
    const now = Date.now();
    feature.tick(hub, now);
    assert.equal(pending.length, 3, "three per tick");
    feature.tick(hub, now + 1000);
    assert.equal(pending.length, 4, "the claimed three are skipped; only the fourth due feed is new");
    await settle();
    assert.deepEqual(calls.map(c => c.url).sort(), ["https://t1.test/f", "https://t2.test/f", "https://t3.test/f", "https://t4.test/f"], "each fetched exactly once; the paused and the not-yet-due feeds are left alone");
    assert.equal(count("feed", `next>${now + 30 * 60000}`), 5);
    assert.equal(count("feeditem"), 4);
  });
  test("a tick check that fails is contained", async () => {
    hub.db.prepare("INSERT INTO feed(conv,url,title,kind,every_min,last,next,fails,active,notify,by,created) VALUES('t:a',?,'X','rss',60,1,0,0,1,0,'u',1)").run("https://dead.test/f");
    feature.tick(hub, Date.now()); await settle();
    assert.equal(feedRow(1).fails, 1);
  });
  test("admin: GET lists feeds, POST {check} forces one check and reports the result", async () => {
    net[URL_A] = ok(rssDoc([{ g: "1" }]), { etag: '"x"' });
    const r = await add({ notify: true });
    net[URL_A] = ok(rssDoc([{ g: "1" }, { g: "2", t: "new one" }]));
    assert.equal(await feature.admin(hub, new Request("https://x/admin/other"), new URL("https://x/admin/other"), null), null);
    const post = await feature.admin(hub, new Request("https://x/admin/feeds", { method: "POST" }), new URL("https://x/admin/feeds"), { check: r.id, fresh: true });
    const res = await post.json();
    assert.deepEqual([res.ok, res.added], [true, 1]);
    assert.equal(said.length, 1);
    const get = await (await feature.admin(hub, new Request("https://x/admin/feeds"), new URL("https://x/admin/feeds"), null)).json();
    assert.equal(get.feeds.length, 1);
    assert.equal(get.feeds[0].items, 2);
    assert.equal(get.feeds[0].conv, "t:a");
    assert.deepEqual(await (await feature.admin(hub, new Request("https://x/admin/feeds", { method: "POST" }), new URL("https://x/admin/feeds"), { check: 999 })).json(), { ok: false, error: "没有这个编号的订阅" });
  });
  test("the feature declares its tunable and Chinese about lines", () => {
    assert.equal(feature.tunables.feeds_notify_daily.default, 20);
    assert.ok(feature.about.length >= 3 && feature.about.every(l => /[一-鿿]/.test(l)));
    assert.match(tool().description, /每日摘要/);
    assert.match(tool().description, /latest/);
  });
});
