#!/usr/bin/env python3
"""Check that every acceptance input points at a real exported record.

Read-only: loads the local JSON export only, never contacts D1.
Usage:
  python3 replay/check-acceptance.py \
    --acceptance ../TeamAgent-p4b-login/.agent/releases/V-D-learning/acceptance.json \
    --fixtures replay/fixtures
"""
import argparse
import json
import pathlib
import re
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--acceptance", required=True)
    parser.add_argument("--fixtures", default="replay/fixtures")
    parser.add_argument("--export", default="")
    args = parser.parse_args()
    entries = json.loads(pathlib.Path(args.acceptance).read_text(encoding="utf-8"))
    messages, outbox = {}, {}
    export = pathlib.Path(args.export) if args.export else None
    if export:
        messages.update({row["rid"]: row for row in json.loads((export / "messages.json").read_text(encoding="utf-8"))})
        outbox.update({row["rid"]: row for row in json.loads((export / "outbox.json").read_text(encoding="utf-8"))})
    fixtures = pathlib.Path(args.fixtures)
    for path in sorted(fixtures.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for key in ("request", "weekly_request", "ban_message"):
            if isinstance(data.get(key), dict) and "rid" in data[key]:
                messages[data[key]["rid"]] = data[key]
        for key in ("matches", "messages"):
            for row in data.get(key, []):
                if isinstance(row, dict) and "rid" in row:
                    messages[row["rid"]] = row
        for key in ("bot_replies", "rows", "outbox", "outbox_context"):
            for row in data.get(key, []):
                if isinstance(row, dict) and "rid" in row and "created_at" in row:
                    outbox[row["rid"]] = row
        row = data.get("row")
        if isinstance(row, dict) and "rid" in row and "created_at" in row:
            outbox[row["rid"]] = row

    errors = []
    if len(entries) != 20:
        errors.append(f"expected 20 entries, got {len(entries)}")
    expected_ids = [f"VL-{n}" for n in range(1, 21)]
    if [entry.get("id") for entry in entries] != expected_ids:
        errors.append("ids are not VL-1..VL-20 in order")
    for entry in entries:
        for key in ("id", "场景", "输入", "期望", "负责包", "passes", "evidence"):
            if key not in entry:
                errors.append(f"{entry.get('id')}: missing {key}")
        if entry.get("passes") is not False:
            errors.append(f"{entry.get('id')}: passes must be false before acceptance")
        if entry.get("evidence") != "":
            errors.append(f"{entry.get('id')}: evidence must be empty before acceptance")

    refs = []
    for entry in entries:
        text = entry["输入"]
        for match in re.finditer(r"messages\.rid=(\d+)(?:\.\.(\d+))?", text):
            start = int(match.group(1))
            end = int(match.group(2) or start)
            for rid in range(start, end + 1):
                refs.append((entry["id"], "messages", rid))
        for match in re.finditer(r"outbox\.rid=(\d+)", text):
            refs.append((entry["id"], "outbox", int(match.group(1))))
    for entry_id, table, rid in refs:
        rows = messages if table == "messages" else outbox
        if rid not in rows:
            errors.append(f"{entry_id}: {table}.rid={rid} not found in export")

    # Key quotes must be verbatim in the referenced rows.
    quotes = [
        ("VL-4", "messages", 134, "把你说草的这个口头禅给我改了"),
        ("VL-5", "messages", 134, "把你说草的这个口头禅给我改了"),
        ("VL-7", "messages", 214, "小马是你叫的吗，要叫马哥"),
        ("VL-8", "messages", 351, "然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。"),
        ("VL-9", "messages", 351, "然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。"),
        ("VL-10", "messages", 351, "然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。"),
        ("VL-12", "messages", 351, "然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。"),
        ("VL-14", "messages", 351, "然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。"),
        ("VL-15", "messages", 351, "然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。"),
        ("VL-19", "messages", 351, "然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。"),
        ("VL-19", "messages", 141, "怎么还不回答 你以后去做耗时任务的时候能不能先回答一下"),
        ("VL-19", "outbox", 203, "明早 8:00 出第一份日推"),
        ("VL-14", "messages", 350, "按周吧，每个星期日是一周的开始"),
    ]
    for entry_id, table, rid, quote in quotes:
        rows = messages if table == "messages" else outbox
        body = rows.get(rid, {}).get("body", "")
        if quote not in body:
            errors.append(f"{entry_id}: quote not in {table}.rid={rid}: {quote}")

    print(f"entries: {len(entries)}")
    print(f"rid references checked: {len(refs)}")
    print(f"verbatim quote checks: {len(quotes)}")
    print(f"errors: {len(errors)}")
    for error in errors:
        print(" -", error)
    if errors:
        sys.exit(1)
    print("PASS: every acceptance input traces to an exported real record")


if __name__ == "__main__":
    main()
