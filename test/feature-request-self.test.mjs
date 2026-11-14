import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { build } from 'esbuild';
const outfile = `.wrangler/feature-request-self-${process.pid}.mjs`;
await build({ stdin: { contents: 'export {SELF_CARD} from "./src/self-card.generated"; export {renderSelf} from "./src/self-card"; export {TOOLS_CATALOG} from "./src/review/catalog";', resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'browser', format: 'esm', outfile });
const api = await import('../' + outfile);
after(() => rmSync(outfile, {force:true}));
test('F11 describe_self explains feature intake and its human approval boundary', () => {
  const out = api.renderSelf(api.SELF_CARD, {release:api.SELF_CARD.commit,switches:{},envPresent:{}}, 'capability', 'request_feature');
  assert.match(out, /request_feature/);
  assert.match(out, /管理员确认/);
  assert.match(out, /src\/feature-request/);
  const off = api.renderSelf(api.SELF_CARD, {release:api.SELF_CARD.commit,switches:{'off:feature_request':'1'},envPresent:{}}, 'capability', 'request_feature');
  assert.match(off, /当前已关闭/);
});
test('F11 review catalog identifies feature requests as a switched write tool', () => {
  assert.deepEqual(api.TOOLS_CATALOG.find(t => t.name === 'request_feature'), {name:'request_feature',readonly:false,needs:['switch']});
});
