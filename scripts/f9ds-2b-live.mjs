// Explicit opt-in: one short TTS request, in-memory output only, no QQ/D1 calls.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const text='今天的语音回复测试通过了。';
const units=[...text].reduce((n,c)=>n+(/[\u3400-\u9fff]/u.test(c)?2:1),0);
const estimated=units*0.225/10000;
if(estimated>0.01)throw Error('live cost cap exceeded');
if(!process.env.DEEPSEEK_API_KEY_FILE)throw Error('DEEPSEEK_API_KEY_FILE is required');
const key=readFileSync(process.env.DEEPSEEK_API_KEY_FILE,'utf8').trim();
const start=Date.now();
const r=await fetch('https://api.deepseek.com/v1/tools/tts',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({text,voice_id:'stella',format:'wav',filter_markdown:true}),signal:AbortSignal.timeout(30000),redirect:'manual'});
if(!r.ok){console.log(JSON.stringify({ok:false,status:r.status,estimated_cost_usd:estimated}));process.exitCode=1;}
else {const wav=Buffer.from(await r.arrayBuffer());if(wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw Error('invalid wav');console.log(JSON.stringify({ok:true,status:r.status,bytes:wav.length,sha256:createHash('sha256').update(wav).digest('hex'),latency_ms:Date.now()-start,units,estimated_cost_usd:estimated,qq_real_sends:0,online_d1_rows_written:0,audio_files_retained:0}));}
