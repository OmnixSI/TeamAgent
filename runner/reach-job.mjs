import {createReachAdapter} from './reach-adapter.mjs';
const adapter=createReachAdapter();
export async function runReachJob(job,cloud,options={}){
 const p=job.payload||{},controller=new AbortController();let interrupted=null;
 const handlers=['SIGINT','SIGTERM'].map(name=>{
  const handler=()=>{interrupted=name;controller.abort();};process.once(name,handler);return [name,handler];
 });
 try{
  const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
  const result=await (options.adapter||adapter).run({id:job.id,lease:p.lease,version:p.version,channel:p.channel,action:p.action,target:p.target,backend:p.backend,deadline_ms:p.deadline_ms,cooldown_ms:p.cooldown_ms},{signal});
  if(!interrupted)await cloud('report',{id:job.id,lease:p.lease,source:'reach',result});
  return result;
 }finally{
  for(const [name,handler] of handlers)process.removeListener(name,handler);
  // Restore normal termination only after owned processes have been reaped and locks released.
  if(interrupted)process.kill(process.pid,interrupted);
 }
}
