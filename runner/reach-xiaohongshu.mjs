/**
 * Xiaohongshu read-only adapter (note / search / loaded comments).
 *
 * The signed-URL rule, NOTE_EXTRACT_JS and the search/comment selector scopes are
 * adapted from OpenCLI 1.7.22 (https://github.com/jackwener/opencli), files
 * clis/xiaohongshu/note.js, note-helpers.js, search.js and comments.js,
 * Apache-2.0. See NOTICE. Removed: automatic retry defaults, feed interception,
 * and every publish/comment/like action. This file only reads.
 */
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicSourceUrl,safeReachText} from './reach-contract.mjs';
import {validators,nextActions} from './reach-result.mjs';

const HOSTS=['www.xiaohongshu.com','xiaohongshu.com'];
const SEARCH_BASE='https://www.xiaohongshu.com/search_result';
const LIMIT=10,COMMENT_LIMIT=20;

/** Signed note URL rule adapted from OpenCLI note-helpers.js:buildNoteUrl. */
export function buildNoteUrl(input){
 const value=typeof input==='string'?input.trim():'';
 if(!/^https:\/\//i.test(value))throw Error('signed url required');
 let u;
 try{u=new URL(value);}catch{throw Error('signed url required');}
 if(!HOSTS.includes(u.hostname)||u.username||u.password||u.port&&u.port!=='443')throw Error('signed url required');
 const token=u.searchParams.get('xsec_token')?.trim();
 if(!token||!isNotePath(u.pathname))throw Error('signed url required');
 return value;
}
function isNotePath(pathname){
 return /^\/(?:explore|note|search_result|discovery\/item)\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname)
  ||/^\/user\/profile\/[^/?#]+\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname);
}
export function parseXhsNoteTarget(value){
 let url;
 try{url=buildNoteUrl(value);}catch{return {ok:false,error_kind:'unsupported'};}
 const u=new URL(url),match=u.pathname.match(/\/(?:explore|note|search_result|discovery\/item|profile\/[^/]+)\/([a-f0-9]+)/i);
 return {ok:true,noteId:match?.[1]||'',url};
}
export function buildSearchUrl(query){
 const q=typeof query==='string'?query.trim():'';
 if(!q||q.length>200)throw Error('query required');
 return SEARCH_BASE+'?keyword='+encodeURIComponent(q)+'&source=web_search_result_notes';
}

/** Normalize a rendered page into a structured error, before any text can be used. */
export function classifyXhsPage(data={}){
 const url=String(data?.pageUrl||''),body=String(data?.bodyText||data?.desc||''),evidence=url+'\n'+body;
 if(/error_code=300031|当前笔记暂时无法浏览|笔记暂时无法浏览/i.test(evidence))return {code:'300031',vendor_code:'300031'};
 if(data?.securityBlock||/SECURITY_BLOCK|安全限制|访问链接异常|请完成验证码|验证码|安全验证|website-login\/error|error_code=300017/i.test(evidence))return {code:'SECURITY_BLOCK'};
 if(data?.loginWall||/登录后查看|请登录|登录后继续|扫码登录/.test(body))return {code:'NEED_LOGIN'};
 if(data?.notFound||/页面不见了|笔记不存在|内容不存在|笔记已删除/.test(body))return {code:'NOT_FOUND'};
 return null;
}
function metric(value,label){
 const text=String(value??'').replace(/\s+/g,'').trim();
 return /^\d[\d.,]*[万千wWkK]?\+?$/.test(text)?label+' '+text:'';
}
export function noteToItems(data,target){
 const error=classifyXhsPage(data);
 if(error)return {ok:false,error};
 const title=safeReachText(data?.title,300).trim();
 const desc=safeReachText(data?.desc,12000).trim();
 const author=safeReachText(data?.author,100).trim();
 // A page shell with no associated author or body is not readable material.
 if(!desc||!author)return {ok:true,items:[]};
 const metrics=[metric(data?.likes,'点赞'),metric(data?.collects,'收藏'),metric(data?.comments,'评论')].filter(Boolean);
 const text=metrics.length?desc+'\n\n互动数据：'+metrics.join(' · '):desc;
 return {ok:true,items:[{title,text,author,source_url:publicSourceUrl(target),published_at:null}]};
}
export function searchRowsToItems(rows){
 const items=[],seen=new Set();
 for(const row of Array.isArray(rows)?rows:[]){
  const url=publicSourceUrl(row?.url),title=safeReachText(row?.title,300).trim();
  if(!url||!title||seen.has(url))continue;
  seen.add(url);
  items.push({title,text:'',author:safeReachText(row?.author,100).trim(),source_url:url,published_at:null});
  if(items.length>=LIMIT)break;
 }
 return {ok:true,items};
}
export function commentsToItems(data,target,limit=COMMENT_LIMIT){
 const error=classifyXhsPage(data);
 if(error)return {ok:false,error};
 const cap=Number.isFinite(Number(limit))?Math.max(0,Math.min(COMMENT_LIMIT,Math.floor(Number(limit)))):COMMENT_LIMIT;
 const items=[];
 for(const row of Array.isArray(data?.results)?data.results:[]){
  const text=safeReachText(row?.text,12000).trim(),author=safeReachText(row?.author,100).trim();
  if(!text||!author)continue;
  items.push({title:'',text,author,source_url:publicSourceUrl(target),published_at:null});
  if(items.length>=cap)break;
 }
 return {ok:true,items};
}

/**
 * DOM extraction scopes adapted from OpenCLI clis/xiaohongshu/note.js.
 * The interaction counts are scoped to .interact-container so a comment's
 * like button cannot be mistaken for the note's total.
 */
export const NOTE_EXTRACT_JS=`
      (() => {
        const bodyText = (document.body?.innerText || '').slice(0, 4000)
        const loginWall = /登录后查看|请登录/.test(bodyText)
        const notFound = /页面不见了|笔记不存在|无法浏览/.test(bodyText)
        const securityBlock = /安全限制|访问链接异常|请完成验证码|验证码/.test(bodyText)
          || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href)

        const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()

        const title = clean(document.querySelector('#detail-title, .title'))
        const desc = clean(document.querySelector('#detail-desc, .desc, .note-text'))
        const author = clean(document.querySelector('.username, .author-wrapper .name'))
        const likes = clean(document.querySelector('.interact-container .like-wrapper .count'))
        const collects = clean(document.querySelector('.interact-container .collect-wrapper .count'))
        const comments = clean(document.querySelector('.interact-container .chat-wrapper .count'))

        const tags = []
        document.querySelectorAll('#detail-desc a.tag, #detail-desc a[href*="search_result"]').forEach(el => {
          const t = (el.textContent || '').trim()
          if (t) tags.push(t)
        })

        return { pageUrl: location.href, bodyText, securityBlock, loginWall, notFound, title, desc, author, likes, collects, comments, tags }
      })()
    `;

/** Search cards adapted from OpenCLI search.js: signed detail links are kept on the page only. */
export const SEARCH_EXTRACT_JS=`
      (() => {
        const bodyText = (document.body?.innerText || '').slice(0, 4000)
        const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim()
        const normalizeUrl = (href) => {
          if (!href) return ''
          if (href.startsWith('http://') || href.startsWith('https://')) return href
          if (href.startsWith('/')) return 'https://www.xiaohongshu.com' + href
          return ''
        }
        const collectNoteCards = () => {
          const classMatches = document.querySelectorAll('section.note-item')
          if (classMatches.length > 0) return classMatches
          const sections = new Set()
          for (const a of document.querySelectorAll('a[href*="/search_result/"], a[href*="/explore/"]')) {
            const section = a.closest('section')
            if (section) sections.add(section)
          }
          return sections
        }
        const rows = [], seen = new Set()
        for (const el of collectNoteCards()) {
          if (el.classList?.contains('query-note-item')) continue
          const titleEl = el.querySelector('.title, .note-title, a.title, .footer .title span')
          const nameEl = el.querySelector('a.author .name, .author-name, .nick-name, .name')
          const authorWrapEl = el.querySelector('a.author')
          let author = clean(nameEl?.textContent || '')
          if (!author && authorWrapEl) {
            const nameChild = authorWrapEl.querySelector('.name')
            author = clean(nameChild ? nameChild.textContent : authorWrapEl.textContent)
          }
          const detailLinkEl = el.querySelector('a.cover.mask')
            || el.querySelector('a[href*="/search_result/"]')
            || el.querySelector('a[href*="/explore/"]')
            || el.querySelector('a[href*="/note/"]')
          const url = normalizeUrl(detailLinkEl?.getAttribute('href') || '')
          if (!url || seen.has(url)) continue
          seen.add(url)
          let title = clean(titleEl?.textContent || '')
          if (!title) title = clean(detailLinkEl?.querySelector('span')?.textContent || '')
          rows.push({ title, author, url })
        }
        const securityBlock = /安全限制|访问链接异常|请完成验证码|验证码/.test(bodyText)
          || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href)
        return { pageUrl: location.href, bodyText, securityBlock, loginWall: /登录后查看|请登录/.test(bodyText), rows }
      })()
    `;

/** Bounded scroll; virtualized cards may be evicted, so rows are merged in Node. */
export const SEARCH_SCROLL_JS=`
      (async () => {
        for (let i = 0; i < 4; i++) {
          const before = document.querySelectorAll('section.note-item').length
          window.scrollTo(0, document.body.scrollHeight)
          await new Promise((resolve) => setTimeout(resolve, 1200))
          const after = document.querySelectorAll('section.note-item').length
          if (after <= before) break
        }
        return document.querySelectorAll('section.note-item').length
      })()
    `;

/** Top-level loaded comments only; nested replies are deliberately not expanded. */
export const COMMENTS_EXTRACT_JS=`
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const bodyText = (document.body?.innerText || '').slice(0, 4000)
        const loginWall = /登录后查看|请登录/.test(bodyText)
        const securityBlock = /安全限制|访问链接异常|请完成验证码|验证码/.test(bodyText)
          || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href)

        const scroller = document.querySelector('.note-scroller') || document.querySelector('.container')
        if (scroller) {
          for (let i = 0; i < 3; i++) {
            const before = scroller.querySelectorAll('.parent-comment').length
            scroller.scrollTo(0, scroller.scrollHeight)
            await wait(900)
            const after = scroller.querySelectorAll('.parent-comment').length
            if (after <= before) break
          }
        }
        const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()
        const results = []
        for (const parent of document.querySelectorAll('.parent-comment')) {
          const item = parent.querySelector('.comment-item')
          if (!item) continue
          const author = clean(item.querySelector('.author-wrapper .name, .user-name'))
          const text = clean(item.querySelector('.content, .note-text'))
          const time = clean(item.querySelector('.date, .time'))
          if (!text) continue
          results.push({ author, text, time })
        }
        return { pageUrl: location.href, bodyText, securityBlock, loginWall, results }
      })()
    `;

function fail(code,extra={}){return {ok:false,error:{code,...extra}};}
async function navigate(page,url){
 let response;
 try{response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});}
 catch(error){
  const text=String(error?.name||'')+' '+String(error?.message||'');
  return /timeout/i.test(text)?{code:'TIMEOUT'}:{code:'UPSTREAM_BROKEN'};
 }
 let status=null;
 try{status=typeof response?.status==='function'?response.status():null;}catch{}
 if(status===412)return {code:'SECURITY_BLOCK',extra:{status:412}};
 if(Number.isFinite(status)&&status>=500)return {code:'UPSTREAM_BROKEN'};
 return {};
}
async function evaluate(page,script){
 try{return await page.evaluate(script);}catch{return undefined;}
}
async function pause(page,ms){
 try{await page.waitForTimeout(ms);}catch{}
}

export async function readXhsPage({page,action,target,limit=COMMENT_LIMIT}={}){
 if(!page)return fail('UPSTREAM_BROKEN');
 if(action==='read'){
  let url;
  try{url=buildNoteUrl(target);}catch{return fail('BAD_INPUT');}
  const nav=await navigate(page,url);
  if(nav.code)return fail(nav.code,nav.extra);
  await pause(page,2500);
  const data=await evaluate(page,NOTE_EXTRACT_JS);
  if(!data||typeof data!=='object')return fail('UPSTREAM_BROKEN');
  return noteToItems(data,target);
 }
 if(action==='search'){
  let url;
  try{url=buildSearchUrl(target);}catch{return fail('BAD_INPUT');}
  const nav=await navigate(page,url);
  if(nav.code)return fail(nav.code,nav.extra);
  await pause(page,2000);
  let data=await evaluate(page,SEARCH_EXTRACT_JS);
  if(!data||typeof data!=='object')return fail('UPSTREAM_BROKEN');
  const error=classifyXhsPage(data);
  if(error)return {ok:false,error};
  let rows=Array.isArray(data.rows)?data.rows:[];
  if(rows.length<LIMIT){
   await evaluate(page,SEARCH_SCROLL_JS);
   const more=await evaluate(page,SEARCH_EXTRACT_JS);
   if(more&&typeof more==='object'&&Array.isArray(more.rows))rows=rows.concat(more.rows);
  }
  return searchRowsToItems(rows);
 }
 if(action==='comments'){
  let url;
  try{url=buildNoteUrl(target);}catch{return fail('BAD_INPUT');}
  const nav=await navigate(page,url);
  if(nav.code)return fail(nav.code,nav.extra);
  await pause(page,2500);
  const data=await evaluate(page,COMMENTS_EXTRACT_JS);
  if(!data||typeof data!=='object')return fail('UPSTREAM_BROKEN');
  return commentsToItems(data,target,limit);
 }
 return fail('BAD_INPUT');
}

function xhsValidator(raw,request){
 let evidence='';
 try{evidence=JSON.stringify(raw).slice(0,65536);}catch{}
 if(/error_code=300031|300031|当前笔记暂时无法浏览|笔记暂时无法浏览/i.test(evidence))return 'insufficient_content';
 if(['read','comments'].includes(request?.action)&&Array.isArray(raw?.items)
  &&!raw.items.some(item=>String(item?.text||'').trim()&&String(item?.author||'').trim()))return 'insufficient_content';
 return null;
}
validators.set('xiaohongshu',xhsValidator);
nextActions.set('xiaohongshu',{login_required:'请在 Edge 里登录 xiaohongshu.com 后主动重试；本次没有读取内容。'});
export {xhsValidator,validators,nextActions};

const script=fileURLToPath(new URL('./reach-xiaohongshu.mjs',import.meta.url));
export const XHS_COMMANDS=Object.freeze({
 'xiaohongshu:read:local':{access:'read',resource:'browser',requires_login:true,content_scope:'post_text',argv:target=>[process.execPath,script,'note',target]},
 'xiaohongshu:search:local':{access:'read',resource:'browser',requires_login:true,content_scope:'search_results',argv:target=>[process.execPath,script,'search',target]},
 'xiaohongshu:comments:local':{access:'read',resource:'browser',requires_login:true,content_scope:'loaded_comments',argv:target=>[process.execPath,script,'comments',target]},
});

function loggedIn(home){
 try{const state=JSON.parse(readFileSync(resolve(home,'state/auth-xiaohongshu.json'),'utf8'));return state?.state==='ok';}catch{return false;}
}
function launchError(error){
 const text=String(error?.message||'');
 if(/需要装一次浏览器|Executable doesn't exist|browser.*not found|ENOENT/i.test(text))return 'NEED_SETUP';
 if(/ProcessSingleton|SingletonLock|already in use|profile.*in use/i.test(text))return 'BUSY';
 return 'UPSTREAM_BROKEN';
}
function allowedHost(host){
 return host==='xiaohongshu.com'||host.endsWith('.xiaohongshu.com')||host==='xhslink.com'
  ||host==='xhscdn.com'||host.endsWith('.xhscdn.com')
  ||host==='rednote.com'||host.endsWith('.rednote.com')||host==='rednotecdn.com'||host.endsWith('.rednotecdn.com');
}
async function launch(home){
 const require=createRequire(import.meta.url);
 const {chromium}=require(resolve(dirname(fileURLToPath(import.meta.url)),'sdk/node_modules/playwright'));
 const {browserOptions,browserLaunchOptions}=await import('./browser-auth.mjs');
 const profile=resolve(home,'browser/xiaohongshu');
 await mkdir(profile,{recursive:true,mode:0o700});
 const browser=await browserOptions(chromium);
 const context=await chromium.launchPersistentContext(profile,{...browserLaunchOptions(browser,true),serviceWorkers:'block'});
 await context.route('**/*',route=>{
  try{
   const u=new URL(route.request().url());
   return (u.protocol==='https:'||u.protocol==='http:')&&allowedHost(u.hostname)?route.continue():route.abort();
  }catch{return route.abort();}
 });
 return context;
}
function emit(result){process.stdout.write(JSON.stringify(result)+'\n');}

async function main(){
 const action=process.argv[2],target=process.argv[3];
 if(!['note','search','comments'].includes(action)||typeof target!=='string'||!target){emit(fail('BAD_INPUT'));return;}
 const internal=action==='note'?'read':action;
 try{
  if(internal==='search')buildSearchUrl(target);
  else buildNoteUrl(target);
 }catch{emit(fail('BAD_INPUT'));return;}
 const home=resolve(homedir(),'.inkboard-team');
 if(!loggedIn(home)){emit(fail('NEED_LOGIN'));return;}
 let context;
 try{context=await launch(home);}catch(error){emit(fail(launchError(error)));return;}
 try{
  const page=context.pages()[0]||await context.newPage();
  emit(await readXhsPage({page,action:internal,target,limit:COMMENT_LIMIT}));
 }catch{emit(fail('UPSTREAM_BROKEN'));}
 finally{await context.close().catch(()=>{});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>emit(fail('UPSTREAM_BROKEN')));
