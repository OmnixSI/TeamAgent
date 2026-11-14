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
import filebox from "./filebox.ts";
import skills from "./skills.ts";
import webkit from "./webkit.ts";
import feeds from "./feeds.ts";
import papers from "./papers.ts";
import minutes from "./minutes.ts";
import subtitle from "./subtitle.ts";
import doctrans from "./doctrans.ts";
import previewlink from "./previewlink.ts";
import staticsite from "./staticsite.ts";
import findimage from "./findimage.ts";
import uptime from "./uptime.ts";
import flashcards from "./flashcards.ts";
import steward from "./steward.ts";
import toolbox from "./toolbox.ts";

export const FEATURES: Feature[] = [backup, transfer, meme, voice, codeagent, publish, preview, repocheck, search, library, watch, data,
  filebox, skills, webkit, feeds, papers, minutes, subtitle, doctrans, previewlink, staticsite, findimage, uptime, flashcards, steward, toolbox];
for (const f of FEATURES) Object.assign(TUNABLES, f.tunables || {});
// Saved links and files are also searchable by meaning, through the same index as the chat.
setSemantic({ index: indexText, search: searchText });
