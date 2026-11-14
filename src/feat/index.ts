// The list of features. Each lives in its own file and is wired in here once.
import type { Feature } from "./types.ts";
import { TUNABLES } from "../config.ts";
import backup from "./backup.ts";
import transfer from "./transfer.ts";
import meme from "./meme.ts";
import voice from "./voice.ts";
import codeagent from "./codeagent.ts";
import publish from "./publish.ts";
import preview from "./preview.ts";
import repocheck from "./repocheck.ts";
import search, { indexText, searchText } from "./search.ts";
import library, { setSemantic } from "./library.ts";
import watch from "./watch.ts";
import data from "./data.ts";

export const FEATURES: Feature[] = [backup, transfer, meme, voice, codeagent, publish, preview, repocheck, search, library, watch, data];
for (const f of FEATURES) Object.assign(TUNABLES, f.tunables || {});
// Saved links and files are also searchable by meaning, through the same index as the chat.
setSemantic({ index: indexText, search: searchText });
