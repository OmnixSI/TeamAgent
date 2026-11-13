import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function sendFixture(now=Date.now()){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync('schema.sql','utf8'));
 const db={executed:0,failAfter:0,prepare(sql){const stmt=(args=[])=>({sql,args,bind(...values){return stmt(values);},async first(){db.executed++;return sqlite.prepare(sql).get(...args)||null;},async all(){db.executed++;return {results:sqlite.prepare(sql).all(...args)};},async run(){db.executed++;return {results:[],meta:sqlite.prepare(sql).run(...args)};}});return stmt();},async batch(ss){sqlite.exec('BEGIN');try{const rows=[];for(let i=0;i<ss.length;i++){const s=ss[i],p=sqlite.prepare(s.sql);db.executed++;rows.push(p.columns().length?{results:p.all(...s.args)}:{results:[],meta:p.run(...s.args)});if(db.failAfter===i+1){db.failAfter=0;throw Error('injected interruption');}}sqlite.exec('COMMIT');return rows;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 const e={DB:db,QQ_APP_ID:crypto.randomUUID(),QQ_APP_SECRET:'synthetic',WORK:{sent:[],async send(body,opts){this.sent.push({body,opts});}}};
 const out=(id='a',status='pending',group='g',msgId='src',body='测试',created=now)=>sqlite.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').run(id,group,msgId,body,status,created);
 const source=(id='src',used=0,at=now,group='g')=>{sqlite.prepare('INSERT INTO passive_claims VALUES(?,?,?,?)').run(id,group,at,used);sqlite.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?)').run(id,group,'member','原话',new Date(at).toISOString(),1,0);};
 const setting=(key,value)=>sqlite.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,value);
 return {e,sqlite,out,source,setting,row:(id='a')=>sqlite.prepare('SELECT o.*,s.passive_msg_id,s.msg_seq,s.tries,s.reason,s.not_before FROM outbox o LEFT JOIN outbox_send s ON s.id=o.id WHERE o.id=?').get(id)};
}
export async function mockQQ(fn,run){const old=globalThis.fetch,sends=[];globalThis.fetch=async(url,init)=>{if(String(url).includes('getAppAccessToken'))return Response.json({access_token:'fake',expires_in:300});const body=JSON.parse(init.body);sends.push(body);return fn(body,sends.length,url,init);};try{return await run(sends);}finally{globalThis.fetch=old;}}
