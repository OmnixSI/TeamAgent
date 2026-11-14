import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDocJob,runDocCycle,downloadDoc,docUrl,safeDocName} from '../runner/docread-job.mjs';

const home=()=>fs.mkdtempSync(path.join(os.tmpdir(),'docread-job-'));
const job=()=>({id:'docread-m1-0-abc123',kind:'docread',payload:{message_id:'m1',group_id:'GROUP1',filename:'report.pdf',question:'第3页的金额',key:'doc:m1:0:abc123',url:'https://multimedia.nt.qq.com.cn/download?fileid=1',bytes:4,lease:'lease-1'}});
const parsed={ok:true,kind:'pdf',filename:'report.pdf',bytes:4,text:'===== 第 3 页 =====\n12,345.67',pages:[{page:3,chars:8}],sheets:[],meta:{},warnings:[],hits:[],truncated:false};

test('URL and filename guards keep jobs on https and inside the temp directory',async()=>{
 assert.equal(docUrl('http://example.com/a.pdf'),null);
 assert.equal(docUrl('https://user:pass@example.com/a.pdf'),null);
 assert.equal(docUrl('https://example.com:8443/a.pdf'),null);
 assert.equal(docUrl('https://multimedia.nt.qq.com.cn/a.pdf').hostname,'multimedia.nt.qq.com.cn');
 assert.equal(safeDocName('../../evil.pdf'),'evil.pdf');
 assert.equal(safeDocName('a\\b\\c.pdf'),'c.pdf');
 assert.equal(safeDocName(''),'document.bin');
 assert.equal(safeDocName('a\u0000b.pdf'),'ab.pdf');
 await assert.rejects(downloadDoc('http://example.com/a.pdf','/tmp/docread-never.pdf'),/invalid_url/);
 assert.equal(fs.existsSync('/tmp/docread-never.pdf'),false);
});

test('one job downloads into a private temp dir, calls docread.py and cleans up',async()=>{
 const dir=home();let downloaded,execArgs;
 try{
  const {report,cleanup}=await runDocJob(job(),{home:dir,python:'/fixture/python',
   download:async(url,dest)=>{downloaded={url,dest};fs.writeFileSync(dest,'PDF');},
   exec:async(python,args)=>{execArgs={python,args};return {code:0,stdout:JSON.stringify(parsed),stderr:''};}});
  assert.equal(report.success,true);
  assert.equal(report.id,'docread-m1-0-abc123');
  assert.equal(report.lease,'lease-1');
  assert.deepEqual(report.result,parsed);
  assert.equal(downloaded.url,'https://multimedia.nt.qq.com.cn/download?fileid=1');
  assert.ok(downloaded.dest.startsWith(path.join(dir,'doc-tmp')+path.sep));
  assert.equal(execArgs.python,'/fixture/python');
  assert.equal(execArgs.args[0],path.resolve('runner/docread.py'));
  assert.deepEqual(execArgs.args.slice(1,5),['--path',downloaded.dest,'--root',path.dirname(downloaded.dest)]);
  assert.deepEqual(execArgs.args.slice(5),['--json','--question','第3页的金额']);
  assert.equal(cleanup.residue,0);
  assert.equal(fs.existsSync(path.dirname(downloaded.dest)),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('parser failures are reported as data and cleanup still happens',async()=>{
 const dir=home();
 try{
  const {report,cleanup}=await runDocJob(job(),{home:dir,download:async(_u,d)=>fs.writeFileSync(d,'PDF'),
   exec:async()=>({code:2,stdout:JSON.stringify({ok:false,error_kind:'missing_library',error:'缺 pypdf，无法读 PDF',retryable:false}),stderr:''})});
  assert.equal(report.success,true);
  assert.equal(report.result.ok,false);
  assert.equal(report.result.error_kind,'missing_library');
  assert.equal(cleanup.residue,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('download and parser errors become bounded failure reports, never throw',async()=>{
 const dir=home();
 try{
  for(const [opts,reason] of [
   [{download:async()=>{throw Error('too_large')}}, 'too_large'],
   [{download:async()=>{},exec:async()=>({code:0,stdout:'not json',stderr:''})},'invalid_result'],
   [{download:async()=>{},exec:async()=>({code:'ENOENT',stdout:'',stderr:''})},'python_missing'],
   [{download:async()=>{},exec:async()=>({code:null,killed:true,stdout:'',stderr:''})},'timeout'],
  ]){
   const {report}=await runDocJob(job(),{home:dir,...opts});
   assert.equal(report.success,false);assert.equal(report.reason,reason);
  }
  const bad={...job(),payload:{...job().payload,url:'http://example.com/a.pdf'}};
  assert.equal((await runDocJob(bad,{home:dir,download:async()=>assert.fail('must not download')})).report.reason,'invalid_job');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a cycle claims, reports and stops when the queue is empty',async()=>{
 const dir=home(),calls=[],reports=[];
 const cloud=async(path,body)=>{
  calls.push(path);
  if(path==='claim'&&calls.filter(x=>x==='claim').length===1)return {job:job()};
  if(path==='claim')return {job:null};
  if(path==='report'){reports.push(body);return {ok:true}}
  if(path==='heartbeat')return {ok:true};
  throw Error('unexpected '+path);
 };
 try{
  const count=await runDocCycle({cloud,home:dir,download:async(_u,d)=>fs.writeFileSync(d,'PDF'),exec:async()=>({code:0,stdout:JSON.stringify(parsed),stderr:''})});
  assert.equal(count,1);
  assert.deepEqual(calls,['claim','report','claim']);
  assert.equal(reports[0].success,true);
  assert.equal(reports[0].result.text,'===== 第 3 页 =====\n12,345.67');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
