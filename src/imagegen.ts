import { callOpenAi, type OpenAiFail } from './openai';
import { sha256 } from './vision';
import { sendRichMedia } from './stickers';
import type { CronJob } from './cron-extra';

export const IMAGE_MODEL = 'gpt-image-1';
export const MAX_GENERATED_IMAGE_BYTES = 1_500_000;
type ImageSize = '1024x1024'|'1024x1536'|'1536x1024';
type ImageQuality = 'low'|'medium'|'high';
const invalidImage = (reason_text:string): OpenAiFail => ({ok:false,error_kind:'upstream',retryable:false,reason_text,next_action:'请稍后重新提出生图请求'});

/** Parse SOF segments instead of trusting API metadata or decoding pixels in a Worker. */
function jpegDimensions(data:Uint8Array): {width:number;height:number}|null {
  if(data.length<4||data[0]!==255||data[1]!==216||data[data.length-2]!==255||data[data.length-1]!==217)return null;
  const sof=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  for(let at=2;at<data.length-2;){
    if(data[at++]!==255)return null;
    while(data[at]===255)at++;
    const marker=data[at++];
    if(marker===0xda||marker===0xd9||marker===undefined)return null;
    if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(at+2>data.length)return null;
    const length=(data[at]<<8)|data[at+1];
    if(length<2||at+length>data.length)return null;
    if(sof.has(marker)){
      if(length<8)return null;
      const height=(data[at+3]<<8)|data[at+4],width=(data[at+5]<<8)|data[at+6],components=data[at+7];
      return width>0&&height>0&&components>0&&length===8+3*components?{width,height}:null;
    }
    at+=length;
  }
  return null;
}
function checkedImage(jpeg:Uint8Array) {
  if(jpeg.byteLength>MAX_GENERATED_IMAGE_BYTES)throw Error('图片太大');
  const dimensions=jpegDimensions(jpeg);if(!dimensions)throw Error('图片格式无效');
  return dimensions;
}
/** Approximate output prices plus a conservative UTF-8 text-token upper bound, in micro USD.
 * https://developers.openai.com/api/docs/models/gpt-image-1 (2026-11-14).
 * Overrides retain this estimate; actual billing belongs to the shared OpenAI channel. */
function estimatedCost(prompt:string,size:ImageSize,quality:ImageQuality):number {
  const prices={low:[11000,16000],medium:[42000,63000],high:[167000,250000]};
  return prices[quality][size==='1024x1024'?0:1]+new TextEncoder().encode(prompt).length*5;
}
export async function generateImage(e:any,o:{prompt:string;size?:ImageSize;quality?:ImageQuality;group:string;sender:string}) {
  const size=o.size??'1024x1024',quality=o.quality??'low';
  if(typeof o.prompt!=='string'||!o.prompt.trim()||!['1024x1024','1024x1536','1536x1024'].includes(size)||!['low','medium','high'].includes(quality))return invalidImage('生图参数无效');
  const setting=await e.DB.prepare("SELECT value FROM settings WHERE key='imagegen:model'").first();
  const model=setting?.value?.trim()||IMAGE_MODEL,est_cost_micro_usd=estimatedCost(o.prompt,size,quality);
  const result=await callOpenAi<{data?:{b64_json?:string}[]}>(e,{purpose:'image_gen',path:'/v1/images/generations',body:{model,prompt:o.prompt,size,quality,n:1,output_format:'jpeg',output_compression:80},timeoutMs:100000,group:o.group,sender:o.sender,model,estCostMicroUsd:est_cost_micro_usd});
  if(result.ok===false)return result;
  const encoded=result.json?.data?.[0]?.b64_json;
  if(typeof encoded!=='string'||!encoded)return invalidImage('图片响应无效');
  if(encoded.length>4*Math.ceil(MAX_GENERATED_IMAGE_BYTES/3))return invalidImage('图片太大');
  try{
    const jpeg=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
    const dimensions=checkedImage(jpeg);
    return {ok:true as const,jpeg,bytes:jpeg.byteLength,...dimensions,model,est_cost_micro_usd,latency_ms:result.latency_ms};
  }catch{return invalidImage('图片格式无效');}
}

/** D1 batch is atomic; retrying a turn never overwrites the image or reopens a delivered row. */
export async function enqueueGeneratedImage(e:any,o:{id:string;group:string;message:string|null;jpeg:Uint8Array;prompt:string;sender:string;caption?:string}):Promise<{outbox_id:string}> {
  const dimensions=checkedImage(o.jpeg),now=Date.now(),outbox_id=o.id+'~g',hash=await sha256(new TextEncoder().encode(o.prompt));
  await e.DB.batch([
    e.DB.prepare('INSERT OR IGNORE INTO generated_images(id,group_id,sender_id,prompt_hash,mime,bytes,width,height,data,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .bind(o.id,o.group,o.sender,hash,'image/jpeg',o.jpeg.byteLength,dimensions.width,dimensions.height,o.jpeg.buffer.slice(o.jpeg.byteOffset,o.jpeg.byteOffset+o.jpeg.byteLength),now,now+7*86400000),
    e.DB.prepare("INSERT OR IGNORE INTO outbox(id,group_id,msg_id,body,status,created_at) SELECT ?,?,?,'[图片]','pending',? WHERE EXISTS(SELECT 1 FROM generated_images WHERE id=? AND group_id=?)")
      .bind(outbox_id,o.group,o.message,now,o.id,o.group),
    e.DB.prepare('INSERT OR IGNORE INTO outbox_meta(id,json) SELECT ?,? WHERE EXISTS(SELECT 1 FROM outbox WHERE id=? AND group_id=?)')
      .bind(outbox_id,JSON.stringify({gen_image:o.id}),outbox_id,o.group),
  ]);
  return {outbox_id};
}
export async function sendGeneratedImage(e:any,o:any,token:string,source:any,sequence:number):Promise<number|null> {
  const result=await sendRichMedia(e,o,token,source,sequence,{
    failureStatus:'failed',
    load:async()=>{
      const meta=JSON.parse(o.meta||'{}');if(typeof meta.gen_image!=='string')return null;
      const row=await e.DB.prepare("SELECT * FROM generated_images WHERE id=? AND group_id=? AND expires_at>? AND mime='image/jpeg'").bind(meta.gen_image,o.group_id,Date.now()).first();
      if(row)checkedImage(new Uint8Array(row.data));
      return row;
    },
    cache:async(row,info,expires)=>{await e.DB.prepare('UPDATE generated_images SET file_info=?,file_info_expires=? WHERE id=? AND group_id=?').bind(info,expires,row.id,o.group_id).run();},
  });
  return result.http;
}
export const generatedImagesCleanupJob:CronJob={name:'generated-images-cleanup',async run(e,now){
  await e.DB.prepare('DELETE FROM generated_images WHERE expires_at<=?').bind(now.getTime()).run();
}};
