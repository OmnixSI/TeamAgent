#!/usr/bin/env python3
"""DS-live input selector (read-only).

Pulls the real historical messages the replay uses from live D1 with SELECT only
(rows_written must stay 0), copies the matching real media bytes from the local
QQ cache (the signed QQ URLs in history have expired), and writes the private
case files under .agent/scenarios/ds-live/input/.

Usage:
  CF_TOKEN_FILE=/path/to/cf-token python3 scripts/ds-live/select-inputs.py
  DS_LIVE_SCEN=/path/to/.agent/scenarios/ds-live ...   # optional output dir

Never prints message IDs beyond a short tail, signed URLs, cookies or tokens.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import urllib.request

TOKEN = pathlib.Path(os.environ["CF_TOKEN_FILE"]).read_text().strip()
ACCOUNT = "fadeed4822ac4e4e518ed6eddc8d35ce"
DB = "42e95fb2-16f8-46d9-bf32-34f3e88a4443"
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DB}/query"
SC = pathlib.Path(os.environ.get(
    "DS_LIVE_SCEN",
    "/Users/yanghongming/Projects/.worktrees/TeamAgent-p4b-login/.agent/scenarios/ds-live",
)) / "input"
SC.mkdir(parents=True, exist_ok=True)
QQ = pathlib.Path(os.path.expanduser(
    "~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/"
    "nt_qq_74d065b03c1e15a61800b47344426bfc/nt_data"
))
AUDIT = []


def q(sql):
    assert sql.strip().upper().startswith("SELECT"), "read-only selector"
    req = urllib.request.Request(
        BASE,
        data=json.dumps({"sql": sql}).encode(),
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=40) as response:
        data = json.load(response)
    assert data["success"], data
    result = data["result"][0]
    assert result["meta"]["rows_written"] == 0 and result["meta"]["changes"] == 0, result["meta"]
    AUDIT.append({"sql": sql, "rows": len(result["results"]), "rows_written": 0})
    return result["results"]


def write(name, obj):
    path = SC / name
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    os.chmod(path, 0o600)
    print("wrote", name)


def rows_where(where, limit=1):
    return q(f"SELECT id,group_id,sender,body,ts,mentioned FROM messages WHERE {where} "
             f"ORDER BY datetime(ts) DESC LIMIT {limit}")


# 1. Two real @ messages for the reply-model lane.
reply = []
for body in [
    "看看ds的最新文章里面api的tts有没有语音克隆功能",
    "这黄仁勋怎么回事 怎么这么多出轨对象",
]:
    reply += rows_where("body='" + body.replace("'", "''") + "'")
write("reply-rows.json", reply)

# 2. Real bilibili message with no subtitles and a transcribable duration.
bili = rows_where("body LIKE '%BV1MEW46JEYB%'")[0]
bili.update({"bvid": "BV1MEW46JEYB", "duration": 951})
write("bili-row.json", bili)

# 3. Two real bot reply texts for TTS.
picked = []
for row in q("SELECT id,body FROM outbox WHERE status='sent' AND length(body) BETWEEN 8 AND 120 "
             "AND body NOT LIKE '%http%' AND body NOT LIKE '%```%' ORDER BY created_at DESC LIMIT 30"):
    text = row["body"].strip()
    if text in [p["text"] for p in picked]:
        continue
    picked.append({"text": text, "historical_id": row["id"]})
    if len(picked) == 2:
        break
write("tts-rows.json", picked)

# 4. Real group images (signed URLs are expired; the local QQ cache holds the
#    exact files received in the group, matched by filename).
IMAGES = {
    "512DB61278DE27DFBCA51DA495FBCE37.jpg": "Pic/2026-11/Thumb/512db61278de27dfbca51da495fbce37_720.jpg",
    "D2CA5B4308698710F717D194B869CE94.jpg": "Emoji/personal_emoji/Ori/D2CA5B4308698710F717D194B869CE94.jpg",
}
images = []
for filename, rel in IMAGES.items():
    src = QQ / rel
    if not src.exists():
        print("missing image", filename)
        continue
    data = src.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    name = "img-" + sha[:10] + (".png" if src.suffix == ".png" else ".jpg")
    (SC / name).write_bytes(data)
    os.chmod(SC / name, 0o600)
    images.append({
        "source_filename": filename, "file": name, "sha256": sha, "bytes": len(data),
        "mime": "image/png" if src.suffix == ".png" else "image/jpeg",
        "origin": "local QQ cache (same file received in group; signed URL expired)",
    })
write("images.json", images)

write("vision-cases.json", [
    {"id": "ROLEPLAY-VISION-1", "sha": "08c0f314d2", "kind": "person",
     "text": "这张图里的人在做什么？简单说。"},
    {"id": "ROLEPLAY-VISION-2", "sha": "63c1831a04", "kind": "news",
     "text": "这张截图讲了什么事？用两三句话说。"},
])
write("ocr-cases.json", [
    {"id": "ROLEPLAY-OCR-1", "sha": "63c1831a04", "kind": "text", "directTool": "read_image_text",
     "text": "用 read_image_text 读一下这张图里的文字，原样给我关键内容。"},
    {"id": "ROLEPLAY-OCR-2", "sha": "08c0f314d2", "kind": "portrait", "directTool": "read_image_text",
     "text": "用 read_image_text 读一下这张图里的文字。"},
])
write("search-cases.json", [
    {"id": "ROLEPLAY-SEARCH-1", "tool": "web_search",
     "text": "必须用 web_search 工具搜一下 DeepSeek V4.1 Flash 的发布与定价，把前 3 条标题和链接贴出来。",
     "toolInput": {"query": "DeepSeek V4.1 Flash 发布 定价"}},
    {"id": "ROLEPLAY-SEARCH-2", "tool": "web_search",
     "text": "用 web_search 搜下 sherpa-onnx 的中文语音识别模型，给我两条来源链接。",
     "toolInput": {"query": "sherpa-onnx 中文语音识别模型"}},
    {"id": "ROLEPLAY-FETCH-1", "tool": "fetch_page",
     "text": "用 fetch_page 读一下 https://github.com/Mai-with-u/MaiBot ，用三句话说明这个项目是做什么的。",
     "toolInput": {"url": "https://github.com/Mai-with-u/MaiBot"}},
    {"id": "ROLEPLAY-FETCH-2", "tool": "fetch_page",
     "text": "用 fetch_page 读一下 https://huggingface.co/taobao-mnn/MNN-Pocket-0.3B ，告诉我它是什么模型。",
     "toolInput": {"url": "https://huggingface.co/taobao-mnn/MNN-Pocket-0.3B"}},
])
# No real PDF/DOCX exists in group history (only one .zip); use a public paper.
write("doc-row.json", {
    "filename": "attention-is-all-you-need.pdf",
    "url": "https://arxiv.org/pdf/1706.03762",
    "size": 2215244,
    "question": "读一下这份 PDF 的第 2 页，用两句话说明它讲了什么。",
    "real_sample": "线上群里没有真实 PDF/DOCX 附件（唯一文件是 mausbot-team-v3.zip）；用公开真实论文 PDF 作最接近样本，走同一条 read_document→docread 链路",
})

# 5. Real SILK voice messages from the local QQ cache (group history has 0 voice
#    attachments). They are SILK despite the .amr suffix.
voice = []
for index, rel in enumerate([
    "Ptt/2025-08/Ori/87011fe66af9c0aaca63eec8e05671bd.amr",
    "Ptt/2025-07/Ori/8aaa195cf7fb7be2084dc056422d1862.amr",
], start=1):
    data = (QQ / rel).read_bytes()
    assert data.startswith(b"\x02#!SILK_V3") or data.startswith(b"#!SILK_V3"), "not SILK"
    sha = hashlib.sha256(data).hexdigest()
    name = f"voice-{index}-{sha[:8]}.silk"
    (SC / name).write_bytes(data)
    os.chmod(SC / name, 0o600)
    voice.append({
        "file": name, "bytes": len(data), "sha256": sha,
        "source": "本机 QQ 收到的真实语音（SILK，Ptt 缓存）；线上群历史 0 条语音附件，按施工单用最接近样本并注明",
    })
write("voice.json", voice)

# Read-only audit of every query used.
(SC.parent / "select-audit.json").write_text(json.dumps(AUDIT, ensure_ascii=False, indent=1))
os.chmod(SC.parent / "select-audit.json", 0o600)
print("queries", len(AUDIT), "rows_written 0")
