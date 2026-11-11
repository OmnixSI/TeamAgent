import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const cases = JSON.parse(readFileSync(new URL('./fixtures/authz-completion-cases.json', import.meta.url), 'utf8'));
const outfile = `.wrangler/authz-completion-${process.pid}.mjs`;
await build({stdin:{contents:'export {authorize,cleanWorkRequest} from "./src/authz"; export {isDirectRequest} from "./src/engagement";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',outfile});
const { authorize, cleanWorkRequest, isDirectRequest } = await import('../' + outfile);

for (const scenario of cases) for (const tool of ['prepare_project_task', 'create_file_task']) {
  test(`completion ${scenario.id} ${tool}: ${scenario.text}`, () => {
    const source = {id:'current',body:scenario.text,meta:{direct:true}}, context = {batch:[source]};
    assert.equal(cleanWorkRequest(source.body), scenario.allow, 'shared clean predicate');
    assert.equal(isDirectRequest(source, context), scenario.allow, 'routing');
    assert.equal(authorize(tool, source.body, source, context, []).ok, scenario.allow, 'tool authorization');
    if (!scenario.allow) {
      assert.equal(authorize(tool, source.body, source, {...context,materials:['external']}, []).ok, false, 'tainted turn remains denied');
      // A model cannot crop away completion markers to obtain authorization.
      const cropped = source.body.replace(/了|过|已经|搞定|弄好/g, '');
      assert.equal(authorize(tool, cropped, source, context, []).ok, false, 'cropped evidence');
    }
  });
}
