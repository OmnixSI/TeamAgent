import {EventEmitter} from 'node:events';
import {createFetchClient} from '../../runner/fetcher.mjs';
const BV='BV1xx411c7mD';
export function twoPages({fallback=false,searchMiss=false,clientFactory=createFetchClient,redirectPage=2}={}){
  let time=10000;const calls=[];
  const request=(options,callback)=>{
    const req=new EventEmitter();
    req.end=()=>{
      calls.push(options);
      const url=new URL('https://'+options.host+options.path);
      let status=200,headers={},body={code:0,data:{}};
      if(options.host==='b23.tv'){status=fallback&&options.method==='HEAD'?405:302;headers.location='https://www.bilibili.com/video/'+BV+'?p='+redirectPage;}
      else if(url.pathname.endsWith('/spi'))body={code:0,data:{b_3:'fixture-device'}};
      else if(url.pathname.endsWith('/nav'))body={code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+ 'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+ 'b'.repeat(32)+'.png'}}};
      else if(url.pathname.endsWith('/search/type'))body={code:0,data:{result:searchMiss?[]:[{type:'video',bvid:BV,title:'第一页标题'}]}};
      else if(url.pathname.endsWith('/view'))body={code:0,data:{bvid:BV,aid:170001,title:'第一页标题',cid:202,pages:[{cid:101,part:'第一页标题'},{cid:202,part:'第二页标题'}]}};
      else if(url.pathname.endsWith('/v2'))body={code:0,data:{subtitle:{subtitles:[{lan:'zh-CN',subtitle_url:'https://a.hdslb.com/sub-'+url.searchParams.get('cid')}]}}};
      else if(options.host==='a.hdslb.com')body={body:[{content:url.pathname==='/sub-101'?'第一页字幕':'第二页字幕'}]};
      const res=new EventEmitter();res.statusCode=status;res.headers=headers;callback(res);
      queueMicrotask(()=>{res.emit('data',Buffer.from(JSON.stringify(body)));res.emit('end');});
    };
    req.destroy=()=>{};return req;
  };
  return {calls,client:clientFactory({request,lookup:(_h,_o,cb)=>cb(null,[{address:'8.8.8.8',family:4}]),now:()=>time,sleep:async ms=>{time+=ms;},random:()=>0})};
}

