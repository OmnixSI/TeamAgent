// D-6 executes the real Worker with an isolated SQLite driver and fake providers.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
let evidence;
export async function vdWorker(ctx,item) {
  const replay=ctx.paths().replay;
  if(!existsSync(join(replay,'seed-437.sqlite'))) return {blocked:true,blockedBy:'replay-data',reason:'D-6 requires a local seed database copy'};
  if(!evidence){
    const result=spawnSync(process.execPath,['--test','test/review-worker.test.mjs','test/review-worker-density.test.mjs'],{encoding:'utf8',timeout:90000,env:{...process.env,REVIEW_REPLAY_DIR:replay}});
    if(result.status!==0)throw Error('D-6 worker checks failed: '+(result.stdout+result.stderr).slice(-4000));
    evidence=(result.stdout+result.stderr);
    if(!/\bpass 21\b/.test(evidence))throw Error('D-6 worker check count is incomplete');
  }
  return {detail:'D-6 21 tests: lease/CAS, density, cross-night, replay, modes, budget, auth; '+(evidence.match(/real_fixture=.*real_sends=0; online_rows_written=0/)?.[0]??'synthetic fixture'),evidence:[]};
}
