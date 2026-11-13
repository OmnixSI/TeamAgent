// Private runtime location shared by the local Node runners. INKBOARD_TEAM_HOME
// selects an isolated runtime for replays; unset keeps the historical path.
import {homedir} from 'node:os';
import {join} from 'node:path';

export function runtimeHome(env = process.env) {
  return env.INKBOARD_TEAM_HOME || join(homedir(), '.inkboard-team');
}
