import type { Media } from "../inbound";

export type QuotedImage = {media:Media;owner:string;animated:boolean};

// Ported from Mai-with-u/MaiBot@03347c9b8f6fa2208e763da3cd4713db22af87bf
// src/plugins/built_in/qq_official_adapter/quoted_media.py::quoted_image_attachments (MIT).
// Copyright (c) 2026 MaiBot Team. Full MIT notice is retained in ../event/normalize.ts.
export function quotedImages(payload:any,limit=3):QuotedImage[] {
  const images:QuotedImage[]=[],seen=new Set<string>();let remaining=64;
  function visit(elements:any,depth:number,quoted:boolean,owner:string){
    if(!Array.isArray(elements) || depth>4)return;
    for(const element of elements){
      if(remaining<=0 || images.length>=limit)return;
      remaining--;
      if(!element || typeof element!=='object')continue;
      const kind=String(element.message_type ?? element.type ?? '');
      if(kind==='102')continue;
      const isQuote=quoted || kind==='103',author=String(element.author?.member_openid || element.author?.id || owner);
      if(isQuote && Array.isArray(element.attachments))for(const attachment of element.attachments){
        if(images.length>=limit)return;
        if(!attachment || typeof attachment!=='object')continue;
        const contentType=String(attachment.content_type || '').toLowerCase(),type=String(attachment.type || '').toLowerCase(),url=String(attachment.url || '').trim();
        if(!url || seen.has(url) || !(contentType.startsWith('image/') || ['image','emoji','face','sticker','mface'].includes(type)))continue;
        seen.add(url);images.push({media:{kind:'image',url,contentType,width:attachment.width,height:attachment.height,size:attachment.size,filename:attachment.filename},owner:author,animated:contentType==='image/gif'});
      }
      visit(element.msg_elements,depth+1,isQuote,author);
    }
  }
  if(limit>0)visit(payload?.msg_elements,0,String(payload?.message_type)==='103','');
  return images;
}

/** Stored previews share the same traversal/budget as fresh QQ payloads. */
export function quotedImagesFromMeta(meta:any,limit=3):QuotedImage[] {
  const knownQuote=!!(meta?.refMsgIdx || meta?.replyTo);
  if(meta?.forwarded?.length)return quotedImages({message_type:knownQuote?103:0,msg_elements:meta.forwarded},limit);
  if(!knownQuote || !meta?.quoted?.media?.length)return [];
  return quotedImages({message_type:103,msg_elements:[{author:{id:meta.quoted.authorId},attachments:meta.quoted.media.map((m:Media)=>({
    url:m.url,content_type:m.contentType || (m.kind==='image'?'image/unknown':''),width:m.width,height:m.height,size:m.size,filename:m.filename,
  }))}]},limit);
}
