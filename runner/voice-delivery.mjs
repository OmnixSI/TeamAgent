// One claimed outbox row gets one delivery attempt. Cloud owns the claim;
// uncertain sends/reports are never returned to the pending queue.
import { voiceReply, synthesize } from './tts.mjs';
import { sendQQVoice } from './qq-voice.mjs';
export async function processVoiceOutbox({cloud,bot,deps={}}) {
  const {items=[]}=await cloud('voice-outbox',{});
  for(const item of items){
    const start=Date.now();let uncertain=false,expired=false,result,audio;
    const valid=()=>!item.expires_at||(deps.now||Date.now)()<item.expires_at;
    let token=deps.token;
    try { token ||= await bot?.api?.getToken?.(); } catch {}
    const sendVoice=async options=>{
      if(!valid()){expired=true;return {ok:true};}
      let sent;
      try { sent=await (deps.sendQQVoice||sendQQVoice)({...options,fetch:async(url,request)=>{
        // The passive window may close during upload; check before *each* QQ request.
        if(!valid()){expired=true;return new Response('{"code":400}',{status:400});}
        return (deps.fetch||fetch)(url,request);
      }}); }
      catch { uncertain=true; return {ok:true}; }
      // Uploads cannot create a message. Once the send request may have reached
      // QQ, suppress voiceReply's text fallback to avoid a second message.
      if((sent.ok&&!sent.message_id)||(!sent.ok&&sent.stage==='send'&&(!sent.http_status||sent.http_status>=500||sent.http_status<300))){
        uncertain=true;return {ok:true};
      }
      return sent;
    };
    const textBot={sendText:async(_target,text)=>{
      if(!valid()){expired=true;return;}
      if(!token)throw Error('voice_auth');
      const response=await (deps.fetch||fetch)((deps.qqBaseUrl||'https://api.bot.qq.com')+'/v2/groups/'+encodeURIComponent(item.group_id)+'/messages',{
        method:'POST',headers:{Authorization:'QQBot '+token,'Content-Type':'application/json'},
        body:JSON.stringify({msg_type:0,content:text,msg_id:item.msg_id,msg_seq:item.msg_seq}),
        signal:AbortSignal.timeout(20000),redirect:'manual',
      });
      const body=await response.json();
      if(!response.ok||!body?.id)throw Error('text_delivery_unconfirmed');
    }};
    try{
      if(!valid()){expired=true;result={via:'none',reason:'expired'};}
      else result=await (deps.voiceReply||voiceReply)({bot:textBot,group:item.group_id,text:item.text,cfg:item.cfg,deps:{...deps,token,msgId:item.msg_id,msgSeq:item.msg_seq,sendVoice,synthesize:async(...args)=>{audio=await (deps.synthesize||synthesize)(...args);return audio;}}});
    }catch{uncertain=true;result={via:'none',reason:'unconfirmed'};}
    const status=uncertain?'unknown':expired?'failed':result.via==='voice'||result.via==='text'?'sent':'failed';
    try{await cloud('voice/report',{id:item.id,status,via:uncertain?'none':result.via,reason:uncertain?'unconfirmed':expired?'expired':result.reason,latency_ms:Date.now()-start,provider:audio?.provider||result.provider,cached:audio?.cached===true});}
    catch{deps.log?.('voice report unconfirmed; row will not be resent');}
  }
}
