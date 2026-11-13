import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

// A new direct writer bypasses shared segmentation and its guarded transaction API.
test('outbox writes only enter through enqueue or the atomic sticker transaction',()=>{
 const allowed=new Set(['src/send/enqueue.ts','src/stickers.ts']);
 const unexpected=[];
 function scan(dir){
  for(const entry of readdirSync(dir,{withFileTypes:true})){
   const path=join(dir,entry.name);
   if(entry.isDirectory())scan(path);
   else for(const [i,line] of readFileSync(path,'utf8').split('\n').entries()){
    if(/INTO outbox[ (]/.test(line)&&!allowed.has(path))unexpected.push(`${path}:${i+1}`);
   }
  }
 }
 scan('src');
 assert.deepEqual(unexpected,[],'direct outbox writers must use enqueueStatements/enqueueText');
});
