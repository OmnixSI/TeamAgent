import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadBiliCookies,writeBiliCookies} from '../runner/browser-auth.mjs';

test('B2 legacy flat cookies retain the same names and migrate on next save',async t=>{
 const home=await mkdtemp(join(tmpdir(),'team-F2a-'));t.after(()=>rm(home,{recursive:true,force:true}));
 await mkdir(join(home,'secrets'));
 const path=join(home,'secrets/bili-cookie.json');
 const flat={SESSDATA:'fake-session',bili_jct:'fake-csrf',DedeUserID:'fake-user',buvid3:'fake-device',unrelated:'ignored'};
 await writeFile(path,JSON.stringify(flat));
 const legacy=await loadBiliCookies(home);
 assert.deepEqual(Object.keys(legacy).sort(),['DedeUserID','SESSDATA','bili_jct','buvid3']);
 assert.deepEqual(legacy.SESSDATA,{value:'fake-session',expires:-1});
 assert.ok(Object.values(legacy).every(c=>c.expires===-1));
 await writeBiliCookies(home,Object.entries(legacy).map(([name,c])=>({name,...c})));
 assert.deepEqual(JSON.parse(await readFile(path,'utf8')),legacy);
 assert.deepEqual(await loadBiliCookies(home),legacy);
 const modern=Object.fromEntries(Object.entries(legacy).map(([name,c])=>[name,{...c,expires:2000000000}]));
 await writeFile(path,JSON.stringify(modern));
 const loaded=await loadBiliCookies(home);
 assert.deepEqual(Object.keys(loaded).sort(),Object.keys(legacy).sort());
 assert.deepEqual(loaded,modern);
});
