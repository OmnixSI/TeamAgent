import type { Segment, SegmentNode } from "./types";
import { untrusted } from "../untrusted";

type Forward = Extract<Segment,{type:"forward"}>;
const records = (value:any):any[] => Array.isArray(value) ? value.filter(x=>x && typeof x==='object') : [];

export function normalizeForward(elements:any[], decode:(node:any)=>Segment[], depth=1, budget={left:64,truncated:false}):Forward {
  const nodes:SegmentNode[]=[];
  if(depth>4){budget.truncated=true;return {type:'forward',nodes,truncated:true};}
  for(const node of records(elements)){
    if(budget.left--<=0){budget.truncated=true;break;}
    const segments=decode(node);
    if(Array.isArray(node.msg_elements))segments.push(normalizeForward(node.msg_elements,decode,depth+1,budget));
    nodes.push({authorId:node.author?.member_openid || node.author?.id,authorName:node.author?.username,segments});
  }
  return {type:'forward',nodes,truncated:budget.truncated};
}

function segmentLabel(s:Segment):string {
  switch(s.type){
    case 'text':return s.text;
    case 'mention':return '@'+(s.name || s.id);
    case 'face':return s.name ? '[表情：'+s.name+']' : '[表情（名称未知）]';
    case 'image':return s.animated ? '[动图]' : '[图片]';
    case 'voice':return s.asr ? '[语音：'+s.asr+']' : '[语音：无文字]';
    case 'video':return '[视频]';
    case 'file':return '[文件 '+(s.filename || '名称未知')+(s.size===undefined?'':' '+s.size+'字节')+']';
    case 'card':return '[卡片 '+(s.card.title || s.card.name || '')+']';
    default:return '';
  }
}

export function forwardMeta(forward:Forward | {nodes:any[];truncated:boolean}) {
  const nodes:{authorName:string;text:string}[]=[];
  let truncated=!!forward.truncated;
  function visit(value:any,depth:number){
    if(depth>4){truncated=true;return;}
    truncated ||= !!value.truncated;
    for(const node of records(value.nodes)){
      if(nodes.length>=64){truncated=true;break;}
      nodes.push({authorName:String(node.authorName || (node.authorId ? '成员'+String(node.authorId).slice(-4) : '作者未知')),
        text:typeof node.text==='string' ? node.text : (node.segments || []).map(segmentLabel).join('')});
      for(const segment of node.segments || [])if(segment.type==='forward')visit(segment,depth+1);
    }
  }
  visit(forward,1);
  return {nodes,truncated};
}

export function renderForward(forward:Forward | {nodes:any[];truncated:boolean}, at='原始转发'):string {
  const meta=forwardMeta(forward),source='QQ群转发';
  const budget=Math.max(0,1500-untrusted(source,'',at,0).length),suffix='\n[转发已截断]';
  let body=meta.nodes.map(node=>node.authorName.replace(/\s+/g,' ').slice(0,80)+'：'+node.text.slice(0,1500)).join('\n');
  if(meta.truncated || body.length>budget)body=body.slice(0,Math.max(0,budget-suffix.length))+suffix;
  return untrusted(source,body,at,budget);
}
