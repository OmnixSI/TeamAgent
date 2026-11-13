/** QQ-specific splitting rules from the event-layer v2 plan.
 * Behavior reference: langbot-app/LangBot@4625b5772a63968129ff92bf10d1388ad3578c49
 * src/langbot/pkg/pipeline/longtext (Apache-2.0). No upstream implementation copied:
 * QQ needs bounded text segments rather than LangBot's forward/image strategy.
 */
type Span = {start:number;end:number};
const TRUNCATED = "…（太长，已截断）";

function protectedSpans(text:string):Span[] {
  const spans:Span[]=[];
  // An unclosed fence extends to the end, so truncation cannot leak half a code block.
  const fences=/```|~~~/g;
  for(let match:RegExpExecArray|null;(match=fences.exec(text));){
    const close=text.indexOf(match[0],match.index+3),end=close<0?text.length:close+3;
    spans.push({start:match.index,end});fences.lastIndex=end;
    if(close<0)break;
  }
  for(const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g))spans.push({start:match.index!,end:match.index!+match[0].length});
  const merged:Span[]=[];
  for(const span of spans.sort((a,b)=>a.start-b.start || b.end-a.end)){
    const last=merged.at(-1);
    if(last && span.start<last.end)last.end=Math.max(last.end,span.end);
    else merged.push({...span});
  }
  return merged;
}

export function splitForQQ(text:string,{max=1800,parts=3}:{max?:number;parts?:number}={}):string[] {
  if(!text || max<=0 || parts<=0)return [];
  const spans=protectedSpans(text),result:string[]=[];
  const inside=(at:number)=>spans.find(span=>span.start<at&&at<span.end);
  function boundary(start:number,limit:number):number {
    let end=Math.min(text.length,start+limit),span=inside(end);
    if(span)end=Math.max(start,span.start);
    if(end>start && /[\uD800-\uDBFF]/.test(text[end-1]) && /[\uDC00-\uDFFF]/.test(text[end] || ''))end--;
    return end;
  }
  function cut(start:number,limit:number):number {
    const end=boundary(start,limit),window=text.slice(start,end);
    for(const regex of [/\n\s*\n/g,/[。！？!?；;][”’"']?\s*|\.(?=\s|$)\s*/g]){
      let best=0;
      for(const match of window.matchAll(regex)){
        const at=start+match.index!+match[0].length;
        if(at>start && !inside(at))best=at;
      }
      if(best)return best;
    }
    return end;
  }
  function truncated(start:number):string {
    const suffix=TRUNCATED.slice(0,max),end=boundary(start,max-suffix.length);
    return text.slice(start,end)+suffix;
  }
  let start=0;
  while(start<text.length && result.length<parts){
    if(text.length-start<=max){result.push(text.slice(start));break;}
    if(result.length===parts-1){result.push(truncated(start));break;}
    const end=cut(start,max);
    if(end===start){
      // A single atom larger than a message cannot be sent intact: omit it and
      // the remaining tail rather than emitting a broken URL/fence or exceeding max.
      const last=result.at(-1);
      if(last && last.length+TRUNCATED.length<=max)result[result.length-1]=last+TRUNCATED;
      else result.push(truncated(start));
      break;
    }
    result.push(text.slice(start,end));start=end;
  }
  return result;
}
