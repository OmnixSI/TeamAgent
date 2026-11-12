import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('video-link and utility paths contain no Whisper invocation',()=>{
  for(const path of ['src/worker.ts','runner/utility.py','src/fetchjobs.ts']){
    const text=readFileSync(path,'utf8');
    assert.doesNotMatch(text,/whisper/i,path);
  }
});
