// Things too big or too structured for a chat bubble — documents, mind maps, diagrams, custom pages —
// are built as a web page here, rendered to a picture by a headless browser, and sent with the source file.
export type Page = { html: string; width: number; height: number; full: boolean; selector?: string; settle: number; file: { name: string; text: string } };

const FONT = `"Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const embed = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c");
const slug = (title: string) => (title.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "doc");

const DOC_CSS = `
  body{margin:0;background:#f4f1ea;font-family:${FONT};color:#23211d;-webkit-font-smoothing:antialiased}
  main{width:820px;margin:0 auto;padding:44px 52px 56px;background:#fffdf8;min-height:100vh;box-sizing:border-box}
  h1{font-size:30px;line-height:1.3;margin:0 0 18px;padding-bottom:14px;border-bottom:3px solid #23211d}
  h2{font-size:22px;margin:34px 0 12px;padding-left:12px;border-left:5px solid #c8553d}
  h3{font-size:18px;margin:24px 0 8px;color:#3a362f}
  p,li{font-size:16px;line-height:1.8}
  ul,ol{padding-left:26px} li{margin:3px 0}
  strong{color:#c8553d}
  a{color:#2d6a8e;text-decoration:none;word-break:break-all}
  blockquote{margin:16px 0;padding:10px 18px;background:#f4f1ea;border-left:4px solid #b8b0a0;color:#5a554b}
  code{font-family:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;font-size:14px;background:#efe9dc;padding:2px 6px;border-radius:4px}
  pre{background:#23211d;color:#f4f1ea;padding:16px 18px;border-radius:8px;overflow:hidden;white-space:pre-wrap;word-break:break-all}
  pre code{background:none;padding:0;color:inherit;font-size:13.5px;line-height:1.6}
  table{border-collapse:collapse;width:100%;margin:16px 0;font-size:15px}
  th{background:#23211d;color:#fffdf8;text-align:left;padding:9px 12px}
  td{padding:9px 12px;border-bottom:1px solid #e3dccb;vertical-align:top}
  tr:nth-child(even) td{background:#faf6ec}
  hr{border:none;border-top:1px solid #d8d0bd;margin:28px 0}
  img{max-width:100%}
  footer{margin-top:36px;font-size:12.5px;color:#9a927f;text-align:right}`;

export function buildPage(kind: string, title: string, content: string, when: string): Page {
  const name = slug(title);
  if (kind === "mindmap") {
    const md = /^#\s/m.test(content) ? content : "# " + title + "\n" + content;
    return {
      width: 1500, height: 920, full: false, settle: 1800, file: { name: name + ".md", text: md },
      html: `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#fffdf8;font-family:${FONT}}
        .markmap{width:100vw;height:100vh}.markmap>svg{width:100%;height:100%}</style></head><body>
        <div class="markmap"><script type="text/template">${md.replace(/<\/script/gi, "<\\/script")}</script></div>
        <script>window.markmap={autoLoader:{toolbar:false}}</script>
        <script src="https://cdn.jsdelivr.net/npm/markmap-autoloader@0.18"></script></body></html>`,
    };
  }
  if (kind === "diagram") {
    return {
      width: 2600, height: 1400, full: false, selector: "#wrap", settle: 1500, file: { name: name + ".mmd", text: content },
      html: `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fffdf8;font-family:${FONT}}
        #wrap{display:inline-block;padding:30px 40px 36px;background:#fffdf8}h1{font-size:22px;margin:0 0 20px;color:#23211d}.mermaid{font-family:${FONT};margin:0}</style></head><body>
        <div id="wrap"><h1>${esc(title)}</h1><pre class="mermaid">${esc(content)}</pre></div>
        <script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
        const natural={useMaxWidth:false};
        mermaid.initialize({startOnLoad:true,theme:"neutral",themeVariables:{fontFamily:'${FONT.replace(/"/g, "")}',fontSize:"17px"},
          flowchart:natural,sequence:natural,gantt:natural,state:natural,class:natural,er:natural,journey:natural,pie:natural,mindmap:natural,timeline:natural});</script></body></html>`,
    };
  }
  if (kind === "html") {
    const html = /<html[\s>]/i.test(content) ? content : `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:${FONT}}</style></head><body>${content}</body></html>`;
    // A page built as one root block is cropped to that block, so there is no stray margin around it.
    return { width: 900, height: 700, full: true, selector: "body > :only-child, body > :first-child:nth-last-child(1)", settle: 1200, file: { name: name + ".html", text: html }, html };
  }
  const md = /^#\s/m.test(content) ? content : "# " + title + "\n\n" + content;
  return {
    width: 820, height: 700, full: true, settle: 500, file: { name: name + ".md", text: md },
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_CSS}</style></head><body><main><div id="c"></div><footer>${esc(when)} · Bot 整理</footer></main>
      <script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
      <script>document.getElementById("c").innerHTML=marked.parse(${embed(md)},{gfm:true,breaks:false});</script></body></html>`,
  };
}
