// Offline tests for the voice feature: the Edge protocol pieces and the cloud-computer command builders.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import voice, {
  VOICES, DEFAULT_VOICE, pickVoice, secMsGec, edgeUrl, dateLine, configMessage, escapeXml, cleanForSpeech, ssml, ssmlMessage,
  rateString, pitchString, splitEscaped, parseFrame, pcmToWav, shq, videoKbps, subtitlePages, subtitleText, pageShares,
  decodeMp3, edgeSpeak, edgeSynthesize,
  subtitlesFilter, SUB_STYLE, filterEscape, motionFilter, narrateTexts, narrateScript, narrateCommands, podcastScript, podcastCommands, podcastTexts, ttsLoop, safeName, NARRATE_LIMITS,
} from "../src/feat/voice.ts";

const enc = s => new TextEncoder().encode(s);
const frame = (header, payload = new Uint8Array()) => {
  const h = enc(header), out = new Uint8Array(2 + h.length + payload.length);
  out[0] = h.length >> 8; out[1] = h.length & 255; out.set(h, 2); out.set(payload, 2 + h.length);
  return out;
};

describe("token", () => {
  // Reference values come from edge-tts 7.3.1 generate_sec_ms_gec_v2 at these Unix times.
  const known = {
    1700000000: "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
    1763200000: "D3FE64A6A27FCCFA-D2F4E1ED43481E029BF5565B34083B638EC95540E698264C0C9F9195B2BA5444",
    1763200299: "87D7813C79DBB460-E9B1714D9DAB346C16F94D2E1571DF28DBED717033EF68978C219F8E46A1947C",
    1790000123: "25DE39E082B2F802-135E7D0D6846115501860D25B87529E42A501FCA6D01B105B0584682863C784C",
  };
  test("matches the Python package at a fixed clock", () => { for (const [t, v] of Object.entries(known)) assert.equal(secMsGec(Number(t)), v); });
  test("is constant inside a 5-minute window and changes at its edge", () => {
    assert.equal(secMsGec(1763200200), secMsGec(1763200499.9));
    assert.notEqual(secMsGec(1763200199), secMsGec(1763200200));
    assert.notEqual(secMsGec(1763200499), secMsGec(1763200500));
  });
  test("url carries token, connection id, version", () => {
    const u = new URL(edgeUrl(1700000000, "abc123"));
    assert.equal(u.protocol, "https:");
    assert.equal(u.hostname, "speech.platform.bing.com");
    assert.equal(u.searchParams.get("ConnectionId"), "abc123");
    assert.equal(u.searchParams.get("Sec-MS-GEC"), known[1700000000]);
    assert.match(u.searchParams.get("Sec-MS-GEC-Version"), /^2-\d+\.\d+\.\d+\.\d+$/);
    assert.ok(u.searchParams.get("TrustedClientToken"));
  });
  test("date line looks like a JavaScript date", () => {
    assert.equal(dateLine(new Date(Date.UTC(2026, 10, 15, 9, 5, 7))), "Sun Nov 15 2026 09:05:07 GMT+0000 (Coordinated Universal Time)");
  });
});

describe("messages", () => {
  test("config asks for the 24 kHz mono MP3 the service supports", () => {
    const m = configMessage("D");
    assert.match(m, /^X-Timestamp:D\r\nContent-Type:application\/json; charset=utf-8\r\nPath:speech\.config\r\n\r\n/);
    const body = JSON.parse(m.split("\r\n\r\n")[1]);
    assert.equal(body.context.synthesis.audio.outputFormat, "audio-24khz-48kbitrate-mono-mp3");
  });
  test("SSML escaping of <, &, quotes", () => {
    assert.equal(escapeXml(`a<b & "c" 'd' >`), "a&lt;b &amp; &quot;c&quot; &apos;d&apos; &gt;");
    const x = ssml("zh-CN-XiaoxiaoNeural", escapeXml(`x<y & "z"`));
    assert.ok(x.includes("<voice name='zh-CN-XiaoxiaoNeural'>") && x.includes("x&lt;y &amp; &quot;z&quot;"));
    assert.ok(!/<y/.test(x), "no raw tag from the text survives");
  });
  test("ssml request headers", () => {
    const m = ssmlMessage("rid", "Sun Nov 15 2026 09:05:07 GMT+0000 (Coordinated Universal Time)", "<speak/>");
    assert.equal(m.split("\r\n\r\n")[0], "X-RequestId:rid\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:Sun Nov 15 2026 09:05:07 GMT+0000 (Coordinated Universal Time)Z\r\nPath:ssml");
    assert.ok(m.endsWith("\r\n\r\n<speak/>"));
  });
  test("control characters are blanked, rate and pitch normalised", () => {
    assert.equal(cleanForSpeech("a\u000bb\u0000c\nd"), "a b c\nd");
    assert.equal(rateString(10), "+10%"); assert.equal(rateString(-20), "-20%"); assert.equal(rateString("+5%"), "+5%"); assert.equal(rateString(undefined), "+0%"); assert.equal(rateString(999), "+100%");
    assert.equal(pitchString(5), "+5Hz"); assert.equal(pitchString(), "+0Hz");
  });
  test("splitting keeps pieces under the byte limit and never cuts an entity or character", () => {
    const text = "你好&amp;世界".repeat(1000);
    const parts = splitEscaped(text, 4096);
    assert.ok(parts.length > 1);
    for (const p of parts) { assert.ok(enc(p).length <= 4096); assert.ok(!/&[a-z]*$/.test(p), "no dangling entity: " + p.slice(-6)); }
    assert.equal(parts.join(""), text);
    assert.deepEqual(splitEscaped("短"), ["短"]);
    assert.deepEqual(splitEscaped("  "), []);
  });
});

describe("binary frames", () => {
  test("audio frame: header length prefix then payload", () => {
    const f = parseFrame(frame("X-RequestId:1\r\nContent-Type:audio/x-wav\r\nX-Timestamp:t\r\nPath:audio", new Uint8Array([1, 2, 3, 4])).buffer);
    assert.equal(f.type, "audio"); assert.deepEqual([...f.data], [1, 2, 3, 4]);
  });
  test("accepts Uint8Array and empty payload at the end of the stream", () => {
    const f = parseFrame(frame("X-RequestId:1\r\nPath:audio"));
    assert.equal(f.type, "audio"); assert.equal(f.data.length, 0);
  });
  test("a header length of 256 or more uses both prefix bytes", () => {
    const long = "X-Pad:" + "x".repeat(300) + "\r\nPath:audio";
    const f = parseFrame(frame(long, new Uint8Array([9])));
    assert.deepEqual([...f.data], [9]);
  });
  test("text frames: turn.end ends, others pass", () => {
    assert.deepEqual(parseFrame("X-RequestId:1\r\nPath:turn.end\r\n\r\n{}"), { type: "end" });
    assert.deepEqual(parseFrame("X-RequestId:1\r\nContent-Type:application/json\r\nPath:turn.start\r\n\r\n{}"), { type: "other", path: "turn.start" });
    assert.deepEqual(parseFrame("Path:response\r\n\r\n{}"), { type: "other", path: "response" });
  });
  test("malformed frames throw", () => {
    assert.throws(() => parseFrame(new Uint8Array([0])), /不完整/);
    assert.throws(() => parseFrame(new Uint8Array([0, 200, 65])), /长度/);
    assert.throws(() => parseFrame(frame("Path:other")), /没见过/);
  });
  test("PCM to WAV header", () => {
    const wav = pcmToWav(new Uint8Array(48000));
    const dv = new DataView(wav.buffer);
    assert.equal(wav.length, 44 + 48000); assert.equal(dv.getUint32(24, true), 24000); assert.equal(dv.getUint16(34, true), 16); assert.equal(dv.getUint32(40, true), 48000);
  });
});

// 7200 bytes (0.9 s) of the service's own MP3 for a short Mandarin sentence, and every 160th sample of what ffmpeg decodes from it.
const FRAG_B64 =
  "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";
const FRAG_REF = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,-1,-1,-4,0,-26,18,6,-3,12,-1,154,372,2817,-1415,811,-348,-2747,1292,8927,6389,599,-9066,-4292,1316,39,-602,103,-633,-487,-489,-2135,3125,-327,1410,1551,4321,733,-6445,-2486,-1060,5591,2801,-7426,1161,732,105,-3198,5706,4137,-963,-2965,-1474,3535,-3985,40,2523,5823,793,-1799,4096,5521,229,601,-448,-3407,734,564,2059,-1040,1050,-6642,2536,-3274,-13422,3007,136,-3027,4017,-6759,-2967,-661,-438,-1991,-636,-2401,-2294,-7017,2119,420,567,-951,3196,289,-796,242,-108,54,-66,4,22,-19,-8,32,-12,-28,24,-1,11,5,-27,21,83,-21,-53,88,147,71,-22,125,-203,-156,-180,-144,-146,67,-20,-70,-274,183,-33,137,10,-57,-23,-38,-6,-14,15,9,-8,-35,32,46,-33,-16,-20,-39,44,1086,1931,1713,1334,1148,2234,6665,220,-5456,-3986,2708,5077,2084,-8299];
const FRAG_LEN = 28817;

describe("mp3 decoder and the speak path", () => {
  const frag = () => Uint8Array.from(Buffer.from(FRAG_B64, "base64"));
  test("decodes the service's MP3 to the same samples as ffmpeg", () => {
    const { pcm, hz } = decodeMp3(frag());
    assert.equal(hz, 24000);
    assert.ok(pcm.length <= FRAG_LEN && pcm.length >= FRAG_LEN - 40, "length " + pcm.length + " vs " + FRAG_LEN);
    // ffmpeg drops the encoder delay differently: its output is 17 samples further along
    FRAG_REF.forEach((v, k) => { const i = 17 + 64 + k * 160 - 17; assert.ok(Math.abs(pcm[i] - v) <= 4, `sample ${i}: ${pcm[i]} vs ${v}`); });
  });
  test("garbage and stereo-less input fail with a clear error", () => {
    assert.throws(() => decodeMp3(new Uint8Array(500)), /没有解出声音/);
    assert.throws(() => decodeMp3(new Uint8Array([0xff, 0xfd, 0x90, 0x00, 1, 2, 3, 4])), /./);
  });
  test("edgeSpeak talks the protocol and returns 24 kHz PCM", async () => {
    const sent = [];
    const handlers = {};
    const ws = {
      accept() {}, close() {}, addEventListener(t, f) { (handlers[t] ||= []).push(f); },
      send(m) {
        sent.push(m);
        if (sent.length === 2) setTimeout(() => {
          const mp3 = frag(), half = mp3.length >> 1;
          const audio = part => frame("X-RequestId:r\r\nContent-Type:audio/mpeg\r\nX-StreamId:s\r\nPath:audio", part).buffer;
          for (const f of handlers.message) {
            f({ data: "X-RequestId:r\r\nPath:turn.start\r\n\r\n{}" }); f({ data: audio(mp3.subarray(0, half)) }); f({ data: audio(mp3.subarray(half)) });
            f({ data: "X-RequestId:r\r\nPath:turn.end\r\n\r\n{}" });
          }
        }, 0);
      },
    };
    const real = globalThis.fetch; let url, headers;
    globalThis.fetch = async (u, init) => { url = String(u); headers = init.headers; return { status: 101, webSocket: ws }; };
    try {
      const r = await edgeSpeak("a<b & \"c\"", "dongbei", { rate: 10 });
      assert.ok(r.pcm instanceof Uint8Array && r.pcm.length > 40000 && r.pcm.length % 2 === 0);
      assert.ok(Math.abs(r.seconds - r.pcm.length / 48000) < 0.01);
      assert.match(url, /^https:\/\/speech\.platform\.bing\.com\/.*Sec-MS-GEC=[0-9A-F]{16}-[0-9A-F]{64}/);
      assert.equal(headers.Upgrade, "websocket"); assert.match(headers.Origin, /^chrome-extension:/); assert.match(headers.Cookie, /^muid=/);
      assert.match(sent[0], /Path:speech\.config/); assert.match(sent[0], /audio-24khz-48kbitrate-mono-mp3/);
      assert.match(sent[1], /Path:ssml/); assert.match(sent[1], /voice name='zh-CN-liaoning-XiaobeiNeural'/); assert.match(sent[1], /rate='\+10%'/);
      assert.ok(sent[1].includes("a&lt;b &amp; &quot;c&quot;"));
    } finally { globalThis.fetch = real; }
  });
  test("a refused connection says why", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 403, headers: new Headers(), text: async () => "nope" });
    try { await assert.rejects(edgeSpeak("你好", "female"), /连不上（403 nope）/); } finally { globalThis.fetch = real; }
  });
});

describe("voices", () => {
  test("keys, labels and the default", () => {
    for (const k of ["female", "male", "dongbei", "shaanxi", "cantonese", "taiwan"]) assert.ok(VOICES[k], k);
    for (const v of Object.values(VOICES)) { assert.match(v.id, /^zh-(CN|HK|TW)-.*Neural$/); assert.match(v.label, /[一-鿿]/); }
    assert.equal(VOICES.dongbei.id, "zh-CN-liaoning-XiaobeiNeural");
    assert.equal(VOICES.cantonese.id, "zh-HK-HiuGaaiNeural");
  });
  test("unknown key falls back to the default; full ids and prototype names are handled", () => {
    assert.equal(pickVoice("nope").key, DEFAULT_VOICE);
    assert.equal(pickVoice(undefined).id, VOICES[DEFAULT_VOICE].id);
    assert.equal(pickVoice("toString").key, DEFAULT_VOICE);
    assert.equal(pickVoice("dongbei").id, VOICES.dongbei.id);
    assert.equal(pickVoice("zh-HK-WanLungNeural").key, "cantonese_male");
  });
});

describe("ffmpeg builders", () => {
  test("shell quoting", () => {
    assert.equal(shq("it's"), `'it'\\''s'`);
    assert.equal(shq("奶蛙: \"你好\" 50%"), `'奶蛙: "你好" 50%'`);
  });
  test("bitrate choice for the size cap", () => {
    assert.equal(videoKbps(30), NARRATE_LIMITS.maxVideoKbps);
    const long = videoKbps(600);
    assert.ok(long < 300 && long >= NARRATE_LIMITS.minVideoKbps);
    for (const s of [30, 120, 300, 600, 900]) assert.ok(((videoKbps(s) + NARRATE_LIMITS.audioKbps) * s) / 8192 <= NARRATE_LIMITS.capMB + 0.5 || videoKbps(s) === NARRATE_LIMITS.minVideoKbps, "fits at " + s);
    assert.equal(videoKbps(0), NARRATE_LIMITS.maxVideoKbps);
    assert.equal(videoKbps(100000), NARRATE_LIMITS.minVideoKbps);
  });
  test("subtitle pages wrap CJK by width and keep all the text", () => {
    const t = "这是一段比较长的中文旁白，用来检查字幕会不会换行，而且每一页最多只有两行，不会撑出画面。".repeat(2);
    const pages = subtitlePages(t);
    assert.ok(pages.length >= 2);
    for (const p of pages) { assert.ok(p.length <= 2); for (const l of p) assert.ok([...l].length <= 26, l); }
    assert.equal(pages.flat().join(""), t.replace(/\s/g, ""));
    const sh = pageShares(pages);
    assert.ok(Math.abs(sh.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.deepEqual(subtitlePages("hello world"), [["hello world"]]);
    assert.equal(subtitleText("好😀 啊\n\n呀"), "好 啊 呀");
  });
  test("hostile text never reaches the filter: only file names and the style do", () => {
    const f = subtitlesFilter("s1.srt");
    assert.equal(f, "subtitles=filename=s1.srt:original_size=1280x720:force_style='" + SUB_STYLE + "'");
    assert.match(SUB_STYLE, /FontName=Noto Sans CJK SC/);
    assert.equal(subtitlesFilter("a:b,c.srt").split(":original_size")[0], "subtitles=filename=a\\:b\\,c.srt");
    assert.throws(() => subtitlesFilter("s.srt", "FontName=It's"), /quotes/);
    const text = `他说："50% off; it's 3:00, [ok]" 奶蛙'`;
    const job = { scenes: [{ file: "vimg1.jpg", text }], voiceId: "zh-CN-XiaoxiaoNeural", rate: "+0%", subtitles: true };
    const script = narrateScript(job), texts = narrateTexts(job);
    assert.equal(texts["vs1.txt"], text);
    assert.equal(texts["vc1_1.txt"], text);
    assert.ok(!script.includes("50%") && !script.includes("奶蛙") && !script.includes("3:00"), "script holds no scene text");
    for (const c of narrateCommands(job)) assert.ok(!c.includes("奶蛙"), "commands hold no scene text");
  });
  test("filter escaping of file names and option values", () => {
    assert.equal(filterEscape("a:b,c'd[e];f%g\\h"), "a\\:b\\,c\\'d\\[e\\]\\;f\\%g\\\\h");
  });
  test("motion filters use the frame expression and stay at 720p", () => {
    for (let i = 0; i < 3; i++) { const m = motionFilter(i, "$FR"); assert.ok(m.startsWith("zoompan=") && m.includes("d=$FR") && m.includes("s=1280x720") && m.includes("fps=25")); }
    assert.notEqual(motionFilter(0, "$FR"), motionFilter(1, "$FR"));
  });
  test("narrate script: one clip per scene, concat, size cap, both streams probed", () => {
    const job = { scenes: [{ file: "vimg1.png", text: "第一段。" }, { file: "vimg1.png", text: "第二段，同一张图。" }, { file: "vimg2.jpg", text: "third" }], voiceId: "zh-HK-HiuGaaiNeural", rate: "+10%", subtitles: true };
    const s = narrateScript(job);
    assert.equal((s.match(/-c:v libx264/g) || []).length, 3);
    assert.equal((s.match(/subtitles=filename=/g) || []).length, 3);
    assert.ok(s.includes("-f concat") && s.includes("-c copy") && s.includes("-b:a 64k") && s.includes("maxrate ${VB}k"));
    assert.ok(s.includes(`int(${NARRATE_LIMITS.capMB}*8192/`));
    assert.ok(s.startsWith("set -e"));
    const bare = narrateScript({ ...job, subtitles: false });
    assert.ok(!bare.includes("subtitles") && !bare.includes(".srt"));
    assert.ok(s.includes("tc(){") && s.includes("> s1.srt") && s.includes("> s3.srt"));
    const cmds = narrateCommands(job);
    assert.equal(cmds.length, 4);
    assert.ok(cmds[2].includes("--voice 'zh-HK-HiuGaaiNeural'") && cmds[2].includes("--rate='+10%'") && cmds[2].includes("--file 'vs3.txt'"));
    assert.ok(cmds[3].includes("vbuild.sh"));
    assert.equal(Object.keys(narrateTexts(job)).filter(k => k.startsWith("vs")).length, 3);
  });
  test("tts loop runs four at a time and checks every output", () => {
    const l = ttsLoop(Array.from({ length: 6 }, (_, i) => ({ input: `in${i}.txt`, voiceId: "v", rate: "+0%", output: `o${i}.mp3` })));
    assert.equal((l.match(/wait;/g) || []).length, 2);
    for (let i = 0; i < 6; i++) assert.ok(l.includes(`[ -s 'o${i}.mp3' ] ||`));
  });
  test("tts loop really runs: parallel, retries, reports a failed scene", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-"));
    try {
      // a stand-in for edge-tts: fails once for the second file, never succeeds for the file named bad
      writeFileSync(join(dir, "fake-tts"), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --file) F="$2"; shift;; --write-media) O="$2"; shift;; esac; shift; done
if [ "$F" = bad.txt ]; then echo "service said no" >&2; exit 1; fi
if [ "$F" = flaky.txt ] && [ ! -f flaky.once ]; then touch flaky.once; exit 1; fi
cat "$F" > "$O"
`, { mode: 0o755 });
      for (const f of ["a.txt", "flaky.txt", "c.txt", "d.txt", "e.txt"]) writeFileSync(join(dir, f), "音" + f);
      const mk = names => names.map(n => ({ input: n, voiceId: "v", rate: "+0%", output: n.replace(".txt", ".mp3") }));
      const run = names => spawnSync("bash", ["-c", "cd " + dir + " && " + ttsLoop(mk(names), join(dir, "fake-tts")).replaceAll("sleep 2", "sleep 0")], { encoding: "utf8" });
      const ok = run(["a.txt", "flaky.txt", "c.txt", "d.txt", "e.txt"]);
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      for (const n of ["a", "flaky", "c", "d", "e"]) assert.equal(readFileSync(join(dir, n + ".mp3"), "utf8"), "音" + n + ".txt");
      writeFileSync(join(dir, "bad.txt"), "x");
      const bad = run(["a.txt", "bad.txt"]);
      assert.equal(bad.status, 1); assert.match(bad.stdout, /配音失败：bad\.txt/); assert.match(bad.stdout, /service said no/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("podcast builders", () => {
    const job = { lines: [{ speaker: "A", text: "你好" }, { speaker: "B", text: "嗨，\"你\"好" }], voices: { A: "zh-CN-YunxiNeural", B: "zh-CN-liaoning-XiaobeiNeural" }, rate: "+0%", pause: 0.4 };
    const c = podcastCommands(job);
    assert.ok(c[2].includes("--voice 'zh-CN-YunxiNeural'") && c[2].includes("--file 'pl1.txt'"));
    assert.ok(c[2].includes("--voice 'zh-CN-liaoning-XiaobeiNeural'") && c[2].includes("--file 'pl2.txt'"));
    assert.equal(podcastTexts(job)["pl2.txt"], "嗨，\"你\"好");
    const s = podcastScript(job);
    assert.ok(s.includes("-t 0.40") && s.includes("libmp3lame") && s.includes("show.mp3"));
  });
  test("scripts are valid shell", () => {
    const job = { scenes: [{ file: "vimg1.jpg", text: "一" }, { file: "vimg2.png", text: "二" }], voiceId: "v", rate: "+0%", subtitles: true };
    execFileSync("bash", ["-n"], { input: narrateScript(job) });
    execFileSync("bash", ["-n"], { input: podcastScript({ lines: [{ speaker: "A", text: "a" }], voices: { A: "v", B: "v" }, rate: "+0%", pause: 0.3 }) });
    for (const c of narrateCommands(job)) execFileSync("bash", ["-n"], { input: c });
  });
  test("file names", () => {
    assert.equal(safeName("奶蛙: 的 \"一天\"/日记", "mp4"), "奶蛙_的_一天_日记.mp4");
    assert.equal(safeName("", "mp3"), "作品.mp3");
  });
});

describe("tools", () => {
  const fakeHost = (over = {}) => ({ cfg: k => ({ narrate_daily: 10, podcast_daily: 6 })[k], quota: async () => true, ...over });
  const get = (name, host) => voice.tools({ hub: {}, conv: "t:x", askers: [], host }).find(t => t.name === name);
  test("feature exposes both tools, tunables and Chinese about lines", () => {
    assert.deepEqual(voice.tools({ hub: {}, conv: "t:x", askers: [], host: fakeHost() }).map(t => t.name), ["narrate", "podcast"]);
    assert.equal(voice.tunables.narrate_daily.default, 10); assert.equal(voice.tunables.podcast_daily.default, 6);
    assert.ok(voice.about.every(l => /[一-鿿]/.test(l)));
  });
  test("narrate rejects empty scenes and missing pictures before spending anything", async () => {
    let used = 0;
    const host = fakeHost({ quota: async () => { used++; return true; }, imageRef: async r => (r === "g1" ? { bytes: new Uint8Array([1]), mime: "image/png" } : null), computer: async () => { throw new Error("must not run"); } });
    const t = get("narrate", host);
    assert.equal((await t.run({ title: "x", scenes: [] })).ok, false);
    const r = await t.run({ title: "x", scenes: [{ image: "g1", text: "a" }, { image: "g99", text: "b" }] });
    assert.equal(r.ok, false); assert.match(r.error, /g99/); assert.equal(used, 0);
  });
  test("narrate runs one computer call, sends the video, falls back to a file", async () => {
    const calls = { computer: 0, video: 0, file: 0 };
    const mp4 = new Uint8Array(5000);
    const host = fakeHost({
      imageRef: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" }),
      computer: async req => {
        calls.computer++;
        const job = JSON.parse(new TextDecoder().decode(req.files[0].bytes));
        assert.ok(job["vimg1.jpg"].b64 && job["vs1.txt"] && job["vbuild.sh"] && job["vc1_1.txt"]);
        assert.equal(req.files.length, 1); assert.deepEqual(req.collect, ["voice/out.mp4"]);
        const out = "duration=12.500000\nsize=4321\ncodec_name=h264\ncodec_type=video\ncodec_name=aac\ncodec_type=audio\n";
        return { ok: true, steps: [{ command: "", exit: 0, stdout: out, stderr: "", seconds: 1 }], files: [{ name: "voice/out.mp4", bytes: mp4 }], seconds: 3 };
      },
      sendVideo: async () => { calls.video++; return { ok: false, error: "no" }; },
      sendFile: async () => { calls.file++; return { ok: true }; },
      keepFile: async () => "f7",
    });
    const r = await get("narrate", host).run({ title: "奶蛙日记", scenes: [{ image: "奶蛙", text: "大家好" }], voice: "dongbei" });
    assert.equal(r.ok, true); assert.equal(r.seconds, 12.5); assert.deepEqual(r.streams, ["video", "audio"]); assert.equal(r.sent, true); assert.equal(r.sent_as, "file");
    assert.deepEqual(calls, { computer: 1, video: 1, file: 1 });
  });
  test("podcast reports the duration and honours deliver=false", async () => {
    const host = fakeHost({
      computer: async req => {
        const job = JSON.parse(new TextDecoder().decode(req.files[0].bytes));
        assert.ok(job["pl1.txt"] && job["pl2.txt"] && job["pbuild.sh"]);
        return { ok: true, steps: [{ command: "", exit: 0, stdout: "duration=8.2\nsize=40000\n", stderr: "", seconds: 1 }], files: [{ name: "pod/show.mp3", bytes: new Uint8Array(40000) }], seconds: 2 };
      },
      sendFile: async () => { throw new Error("must not send"); }, keepFile: async () => "f9",
    });
    const r = await get("podcast", host).run({ title: "t", lines: [{ speaker: "A", text: "a" }, { speaker: "B", text: "b" }], voices: { A: "male", B: "cantonese" }, deliver: false });
    assert.equal(r.ok, true); assert.equal(r.seconds, 8.2); assert.equal(r.kept_as, "f9"); assert.equal(r.sent, false);
  });
  test("quota stops the tools", async () => {
    const host = fakeHost({ quota: async () => false, imageRef: async () => ({ bytes: new Uint8Array([1]), mime: "image/png" }), computer: async () => { throw new Error("no"); } });
    assert.match((await get("narrate", host).run({ title: "x", scenes: [{ image: "g1", text: "a" }] })).error, /次数用完/);
    assert.match((await get("podcast", host).run({ title: "x", lines: [{ speaker: "A", text: "a" }], voices: { A: "male" } })).error, /次数用完/);
  });
});
