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

// Slice UTF-16 only at whole code points; the QQ limit counts code units.
function safeEnd(text:string,limit:number):number {
  let end=Math.min(text.length,Math.max(0,limit));
  if(end>0 && /[\uD800-\uDBFF]/.test(text[end-1]) && /[\uDC00-\uDFFF]/.test(text[end] || ''))end--;
  return end;
}

type Piece = {text:string;header?:string;footer?:string};
function oversizedPieces(atom:string,max:number):Piece[] {
  const fence=atom.match(/^(```|~~~)/)?.[0];
  const closed=fence && atom.endsWith(fence),end=closed?atom.length-3:atom.length;
  const newline=atom.indexOf('\n',3);
  const header=fence ? newline>=0 && newline<end ? atom.slice(0,newline+1) : fence+'\n' : '';
  const footer=fence?'\n'+fence:'';
  const content=fence ? atom.slice(newline>=0 && newline<end?newline+1:3,end) : atom;
  const capacity=max-header.length-footer.length;
  // Unsendable fence metadata at very small custom limits falls back to text.
  if(capacity<2)return Array.from(atom).reduce<Piece[]>((out,char)=>{
    if(out.at(-1) && out.at(-1)!.text.length+char.length<=max)out.at(-1)!.text+=char;
    else if(char.length<=max)out.push({text:char});
    return out;
  },[]);
  const result:Piece[]=[];
  for(let start=0;start<content.length;){
    let end=start+safeEnd(content.slice(start),capacity);
    if(fence && end<content.length){
      const line=content.lastIndexOf('\n',end-1);
      if(line>=start)end=line+1;
    }
    result.push({text:header+content.slice(start,end)+footer,header,footer});start=end;
  }
  return result;
}

export function splitForQQ(text:string,{max=1800,parts=3}:{max?:number;parts?:number}={}):string[] {
  if(!text || max<=0 || parts<=0)return [];
  const spans=protectedSpans(text),result:string[]=[];
  const oversized=spans.filter(span=>span.end-span.start>max);
  if(oversized.length){
    // Keep explanatory prose separate; only oversized atoms relax the no-split rule.
    const pieces:Piece[]=[];let cursor=0;
    for(const span of oversized){
      pieces.push(...splitForQQ(text.slice(cursor,span.start),{max,parts:Infinity}).map(text=>({text})),
        ...oversizedPieces(text.slice(span.start,span.end),max));
      cursor=span.end;
    }
    pieces.push(...splitForQQ(text.slice(cursor),{max,parts:Infinity}).map(text=>({text})));
    if(pieces.length<=parts)return pieces.map(p=>p.text);
    const kept=pieces.slice(0,parts),last=kept.at(-1)!;
    if(last.header){
      const body=last.text.slice(last.header.length,-last.footer!.length);
      const budget=max-last.header.length-last.footer!.length;
      const marker=TRUNCATED.slice(0,budget);
      last.text=last.header+body.slice(0,safeEnd(body,budget-marker.length))+marker+last.footer;
    }else{
      // Reuse ordinary protected-span truncation for prose; URL fragments permit hard cuts.
      if(last.header===''){
        const marker=TRUNCATED.slice(0,max);
        last.text=last.text.slice(0,safeEnd(last.text,max-marker.length))+marker;
      }else last.text=splitForQQ(last.text+'\n'+TRUNCATED,{max,parts:1})[0];
    }
    return kept.map(p=>p.text);
  }
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
