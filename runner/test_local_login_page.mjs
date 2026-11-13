import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// The login page ships as a Python string; run its real countdown code in a tiny stub DOM.
test('L22 the login page keeps a bounded settle window before declaring the QR expired',async()=>{
 const source=await readFile('runner/local_login_page.py','utf8');
 const page=source.match(/PAGE = r'''([\s\S]*?)'''/)[1];
 const code=page.split('\n').filter(line=>/^function (?:finishExpired|countdown)\(/.test(line)).join('\n');
 assert.match(code,/finishExpired/,page);
 const elements={},get=id=>elements[id]||(elements[id]={textContent:'',className:'',replaceChildren(){}});
 const clock={value:1000};
 const context=vm.createContext({document:{getElementById:get},Date:{now:()=>clock.value},clearInterval(){context.cleared=true;},setInterval(){}});
 vm.runInContext(`const $=id=>document.getElementById(id);let poll=1,deadline=1000,settleUntil=0,current='id';\n${code}`,context);
 vm.runInContext('countdown()',context);
 assert.equal(elements['bili-status'].textContent,'正在确认登录结果…');
 assert.equal(elements['bili-status'].className,'note');
 assert.equal(vm.runInContext('poll',context),1);
 clock.value=1000+30001;
 vm.runInContext('countdown()',context);
 assert.equal(elements['bili-status'].textContent,'二维码已过期，请重新获取');
 assert.equal(elements['bili-status'].className,'error');
 assert.equal(vm.runInContext('poll',context),null);
});
