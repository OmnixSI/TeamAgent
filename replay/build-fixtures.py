#!/usr/bin/env python3
"""Build the B-l9 replay fixtures from a read-only production D1 export.

The input directory is produced by the existing read-only exporter
`scripts/review-export.py` (single SELECTs, every response asserted
rows_written=0 / changes=0).  This script never talks to the network; it only
selects rows that already exist in that export.  No message body is invented.

Usage:
  python3 replay/build-fixtures.py --export /tmp/teamagent-l9-export-20261114
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import sys

REFERENCE_NOW = datetime.datetime.fromisoformat("2026-11-14T14:19:00+11:00")
KEYWORDS = ["别再", "口头禅", "叫我", "以后", "每天"]
GROUP = "9968A083EE07797A987010E64CD421B9"
SCRUB = re.compile(r"(^|[，。！？!?,；;：:\s])草[！!。.~～…，,]*(?=$|[，。！？!?,；;：:\s])")


def epoch(text):
    return datetime.datetime.fromisoformat(text).timestamp()


def load(export, name):
    return json.loads((export / f"{name}.json").read_text(encoding="utf-8"))


def row(rows, rid):
    for item in rows:
        if item["rid"] == rid:
            return item
    raise SystemExit(f"missing rowid {rid}")


def classification(body):
    standalone, protected = [], []
    for match in SCRUB.finditer(body):
        standalone.append({"index": match.start(), "text": match.group(0)})
    for match in re.finditer("草", body):
        index = match.start()
        if any(item["index"] <= index < item["index"] + len(item["text"]) for item in standalone):
            continue
        before = body[max(0, index - 1):index]
        after = body[index + 1:index + 2]
        if after in ("稿", "案"):
            protected.append({"index": index, "kind": "draft", "word": "草" + after})
        elif before in ("“", "「"):
            protected.append({"index": index, "kind": "quoted", "word": "“草”"})
        else:
            protected.append({"index": index, "kind": "embedded", "word": body[max(0, index - 2):index + 3]})
    if standalone:
        kind = "standalone"
    elif protected and all(item["kind"] == "draft" for item in protected):
        kind = "draft"
    elif protected and all(item["kind"] == "quoted" for item in protected):
        kind = "quoted"
    else:
        kind = "embedded"
    return kind, standalone, protected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--export", required=True)
    parser.add_argument("--out", default=str(pathlib.Path(__file__).parent / "fixtures"))
    args = parser.parse_args()
    export = pathlib.Path(args.export)
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    audit = json.loads((export / "audit.json").read_text(encoding="utf-8"))
    bad = [item for item in audit if item["rows_written"] != 0 or item["changes"] != 0]
    if bad:
        raise SystemExit(f"export contains writes: {bad}")
    counts = json.loads((export / "online-counts.json").read_text(encoding="utf-8"))
    if counts != {"messages": 466, "outbox": 264, "chat_decisions": 133}:
        print(f"note: unexpected counts {counts}", file=sys.stderr)

    messages = load(export, "messages")
    outbox = load(export, "outbox")

    too = next(m for m in messages if "悉尼时间每天早上8点" in m["body"])
    weekly = next(m for m in messages if "按周吧，每个星期日" in m["body"])
    bot_replies = [row(outbox, 203), row(outbox, 206), row(outbox, 207)]
    weekly_json = {
        "source": "线上 D1 只读导出 2026-11-14T14:19+11:00（scripts/review-export.py；audit 每条 rows_written=0 / changes=0）",
        "group_id": GROUP,
        "request": {k: too[k] for k in ("rid", "id", "group_id", "sender", "body", "ts", "mentioned")},
        "weekly_request": {k: weekly[k] for k in ("rid", "id", "group_id", "sender", "body", "ts", "mentioned")},
        "bot_replies": bot_replies,
        "note": "消息 id 里的 sk- 被导出脚本在 id 字段规范为 sk_；正文未改。chat-drain-350 是真实 outbox 行，不是合成回复。",
    }
    (out / "too-daily-request.json").write_text(json.dumps(weekly_json, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    window_start = REFERENCE_NOW.timestamp() - 7 * 24 * 3600
    keyword_rows = []
    for message in messages:
        if epoch(message["ts"]) < window_start:
            continue
        hits = [word for word in KEYWORDS if word in message["body"]]
        if hits:
            keyword_rows.append({**{k: message[k] for k in ("rid", "id", "group_id", "sender", "body", "ts", "mentioned")}, "keywords": hits})
    signals = {
        "source": weekly_json["source"],
        "window": f"{datetime.datetime.fromtimestamp(window_start, REFERENCE_NOW.tzinfo).isoformat()} – {REFERENCE_NOW.isoformat()}",
        "keywords": KEYWORDS,
        "count": len(keyword_rows),
        "matches": keyword_rows,
        "zero_hit_keywords": [word for word in KEYWORDS if not any(word in m["body"] for m in messages)],
        "note": "全部为 messages 真实行；没有为凑数改字或造消息。",
    }
    (out / "learning-signals-7d.json").write_text(json.dumps(signals, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    ban = next(m for m in messages if m["body"] == "把你说草的这个口头禅给我改了")
    ban_ms = int(epoch(ban["ts"]) * 1000)
    cao = []
    for item in outbox:
        if "草" in item["body"] and item["created_at"] >= ban_ms:
            kind, standalone, protected = classification(item["body"])
            cao.append({
                **{k: item[k] for k in ("rid", "id", "group_id", "msg_id", "body", "status", "created_at")},
                "sydney": datetime.datetime.fromtimestamp(item["created_at"] / 1000, REFERENCE_NOW.tzinfo).isoformat(),
                "classification": kind,
                "standalone": standalone,
                "protected": protected,
            })
    cao_json = {
        "source": weekly_json["source"],
        "ban_message": {k: ban[k] for k in ("rid", "id", "group_id", "sender", "body", "ts")},
        "ban_sydney": "2026-11-11T21:09:24+11:00",
        "rule": "outbox.body 含「草」且 created_at >= 禁令消息时间（真实 outbox 行）",
        "count": len(cao),
        "standalone_count": sum(1 for item in cao if item["classification"] == "standalone"),
        "protected_count": sum(1 for item in cao if item["classification"] != "standalone"),
        "rows": cao,
        "note": "18 条里 8 条只有「草稿/草案」或引用「草」，10 条有单独成句的「草」；分类由 replay/build-fixtures.py 的 scrub 正则逐字计算。",
    }
    (out / "outbox-cao-18.json").write_text(json.dumps(cao_json, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    (out / "chat-drain-350.json").write_text(json.dumps({
        "source": weekly_json["source"],
        "request_rid": too["rid"],
        "request_id": too["id"],
        "row": row(outbox, 203),
        "note": "真实 outbox 行，对应 11-13 04:11 Sydney 的「明早 8:00 出第一份日推」口头承诺。",
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    p1_messages = [row(messages, rid) for rid in range(428, 433)]
    p1 = {
        "source": weekly_json["source"],
        "case": "V-D v2-notes #17：22 分钟无回复（S1）",
        "messages": p1_messages,
        "outbox": [row(outbox, 239)],
        "note": "真实行；review 判决 fixture 另行录制，不在本文件里伪造模型输出。",
    }
    (out / "review-p1-case.json").write_text(json.dumps(p1, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    quiet = [m for m in messages if "2026-11-12T00:00:00+08:00" <= m["ts"] < "2026-11-12T09:00:00+08:00"]
    (out / "quiet-night.json").write_text(json.dumps({
        "source": weekly_json["source"],
        "window": "2026-11-12T00:00:00+08:00 – 2026-11-12T09:00:00+08:00",
        "count": len(quiet),
        "messages": quiet,
        "note": "线上该窗口真实记录为 0 条；用于「没什么可说的那天」场景。",
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    daytime = [row(messages, rid) for rid in range(420, 426)]
    (out / "daytime-batch.json").write_text(json.dumps({
        "source": weekly_json["source"],
        "messages": daytime,
        "outbox_context": [row(outbox, 236), row(outbox, 237), row(outbox, 238)],
        "note": "真实白天批次（11-13 18:12–18:41 +08），用于 VL-20 的聊天路径 prompt 对比。",
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    audit_out = [{k: item[k] for k in ("query", "records", "rows_written", "changes", "rows_read")} for item in audit]
    (out / "export-audit.json").write_text(json.dumps({
        "source": "scripts/review-export.py（线上 D1 只读 SELECT）",
        "at": "2026-11-14T14:19:00+11:00",
        "database": "42e95fb2-16f8-46d9-bf32-34f3e88a4443",
        "counts": counts,
        "queries": audit_out,
        "all_rows_written_zero": all(item["rows_written"] == 0 for item in audit_out),
        "all_changes_zero": all(item["changes"] == 0 for item in audit_out),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    index = {"built_at": REFERENCE_NOW.isoformat(), "files": {}}
    for path in sorted(out.glob("*.json")):
        if path.name == "index.json":
            continue
        index["files"][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("wrote", len(index["files"]), "fixtures to", out)
    print("too", too["rid"], "weekly", weekly["rid"], "cao", len(cao), "standalone", cao_json["standalone_count"])
    print("keyword rows", len(keyword_rows), "zero-hit", signals["zero_hit_keywords"], "quiet", len(quiet))
    print("线上 D1 写入 0 行；QQ 真实发送 0 次")


if __name__ == "__main__":
    main()
