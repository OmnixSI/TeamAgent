import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {readFileSync} from "node:fs";
import {runDocJob} from "../runner/docread-job.mjs";

function python(){
 for(const candidate of ["python3.12", "/usr/local/bin/python3.12"]){
  try{execFileSync(candidate, ["-c", "import pypdf,reportlab,docx"], {stdio: "ignore"});return candidate}catch{}
 }
 return null;
}
const PY=python();

async function module(entry){
 const out=await build({entryPoints:[entry],bundle:true,format:"esm",platform:"neutral",write:false});
 return import("data:text/javascript;base64,"+Buffer.from(out.outputFiles[0].text).toString("base64"));
}
const schema=readFileSync(new URL("../schema.sql",import.meta.url),"utf8");
const tool=(await module("src/toolkit.ts")).findExtraTool("read_document");
const doc=await module("src/docjobs.ts");

function db(file){
 const raw=new DatabaseSync(file);raw.exec(schema);
 return {raw,DB:{prepare(sql){const statement=(args=[])=>({sql,bind(...values){return statement(values)},async first(){return raw.prepare(sql).get(...args)||null},async all(){return{results:raw.prepare(sql).all(...args)}},async run(){return raw.prepare(sql).run(...args)}});return statement()},
  async batch(statements){return Promise.all(statements.map(s=>s.all?s.all():s.run()))}}};
}
const seed=(e,id,attachments)=>{
 e.raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts) VALUES(?,?,?,?,?)").run(id,"GROUP1","member","看下这份文件","2026-11-14T00:00:00Z");
 e.raw.prepare("INSERT INTO message_meta VALUES(?,?)").run(id,JSON.stringify({attachments}));
};
const ctx=id=>({context:{latest:{id,group_id:"GROUP1"}},source:{id,group_id:"GROUP1"},messages:[],isTainted:()=>false});

test("real docread.py reads synthetic PDF/DOCX/XLSX through the whole queue", {skip:PY?false:"python3.12 with pypdf/reportlab/python-docx is not installed"},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"docread-replay-"));
 try{
  const fixtures=path.join(root,"fixtures");fs.mkdirSync(fixtures);
  execFileSync(PY,["-c",`
import importlib.util, pathlib, sys
spec=importlib.util.spec_from_file_location("docread_test", sys.argv[2])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
out=pathlib.Path(sys.argv[1])
m.make_pdf(out/"report.pdf", pages=2, amount_page=2)
m.make_docx(out/"report.docx")
m.make_xlsx(out/"book.xlsx")
`,fixtures,path.resolve("test/docread_test.py")],{stdio:"pipe"});

  const e=db(path.join(root,"replay.db"));
  e.raw.prepare("INSERT INTO settings VALUES('docread:enabled','1')").run();
  const docs=[
   {id:"m-pdf",file:"report.pdf",type:"application/pdf",question:"第2页的金额",expect:/12,345\.67/},
   {id:"m-docx",file:"report.docx",type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",question:"预算剩余多少",expect:/预算剩余 12,345\.67 元/},
   {id:"m-xlsx",file:"book.xlsx",type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",question:"哪个单元格是合计金额",expect:/SUM\(B2:B6\)/},
  ];
  const results=[];
  for(const item of docs){
   const size=fs.statSync(path.join(fixtures,item.file)).size;
   seed(e,item.id,[{url:`https://multimedia.nt.qq.com.cn/download?fileid=${item.id}`,filename:item.file,content_type:item.type,size}]);
   const started=Date.now();
   const first=await tool.run(e,{question:item.question},ctx(item.id));
   assert.equal(first.error_kind,"pending",item.file);
   const claimed=(await (await doc.docRoute(e,"/api/runner/doc/claim",{})).json()).job;
   assert.equal(claimed.payload.filename,item.file);
   const {report,cleanup}=await runDocJob(claimed,{home:root,python:PY,
    download:async(_url,dest)=>fs.copyFileSync(path.join(fixtures,item.file),dest)});
   assert.equal(cleanup.residue,0);
   assert.equal(report.success,true,JSON.stringify(report));
   assert.equal(report.result.ok,true,JSON.stringify(report.result));
   assert.equal((await doc.docRoute(e,"/api/runner/doc/report",report)).status,200);
   const second=await tool.run(e,{question:item.question},ctx(item.id));
   assert.equal(second.ok,true,JSON.stringify(second));
   assert.match(second.text,item.expect);
   results.push({filename:item.file,kind:second.kind,chars:second.text.length,ms:Date.now()-started,warnings:second.warnings,hits:second.hits.map(h=>h.label||h.page),text_head:second.text.slice(0,120)});
  }
  const summary={at:new Date().toISOString(),python:PY,db:"file:"+path.join(root,"replay.db"),documents:results,qq_real_sends:0,online_d1_rows_written:0};
  console.log(JSON.stringify(summary));
  if(process.env.DOCREAD_REPLAY_OUT)fs.writeFileSync(process.env.DOCREAD_REPLAY_OUT,JSON.stringify(summary,null,1));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
