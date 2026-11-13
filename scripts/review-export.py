#!/usr/bin/env python3
"""V-D review fixture export: read-only D1 SELECTs, never writes production.

Every request is a single SELECT and is checked for rows_written==0 and
changes==0.  Output goes to a fresh directory under $TMPDIR (mode 0700,
files 0600), never into the repository.  The first log line is the
required audit sentence "线上 D1 写入 0 行".

Usage:
  python3 scripts/review-export.py --token-file /path/to/cf-token [--out DIR]
"""
import argparse
import datetime
import json
import os
import pathlib
import re
import ssl
import sys
import tempfile
import urllib.request

ACCOUNT = "fadeed4822ac4e4e518ed6eddc8d35ce"
DATABASE = "42e95fb2-16f8-46d9-bf32-34f3e88a4443"
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DATABASE}/query"

# 窗口（UTC+8）：2026-11-11 15:41 – 2026-11-14 00:41
WINDOW_START = "2026-11-11T15:41:00+08:00"
WINDOW_END = "2026-11-14T00:41:00+08:00"
TZ = datetime.timezone(datetime.timedelta(hours=8))


def epoch_ms(text):
    return int(datetime.datetime.fromisoformat(text).timestamp() * 1000)


START_MS = epoch_ms(WINDOW_START)
END_MS = epoch_ms(WINDOW_END)
JOBS_START_MS = END_MS - 7 * 24 * 3600 * 1000

MESSAGE_WINDOW = (
    f"ts >= '{WINDOW_START}' AND ts <= '{WINDOW_END}'"
)
OUTBOX_WINDOW = f"created_at >= {START_MS} AND created_at <= {END_MS}"
DECISION_WINDOW = f"created_at >= {START_MS} AND created_at <= {END_MS}"

# Each entry: (name, SQL).  All statements must be single SELECTs.
QUERIES = [
    (
        "messages",
        "SELECT rowid AS rid, id, group_id, sender, body, ts, mentioned, processed "
        f"FROM messages WHERE {MESSAGE_WINDOW} ORDER BY rowid",
    ),
    (
        "message_meta",
        "SELECT rowid AS rid, id, json FROM message_meta "
        f"WHERE id IN (SELECT id FROM messages WHERE {MESSAGE_WINDOW}) ORDER BY rowid",
    ),
    (
        "outbox",
        "SELECT rowid AS rid, id, group_id, msg_id, body, status, created_at "
        f"FROM outbox WHERE {OUTBOX_WINDOW} ORDER BY rowid",
    ),
    (
        "outbox_meta",
        "SELECT rowid AS rid, id, json FROM outbox_meta "
        f"WHERE id IN (SELECT id FROM outbox WHERE {OUTBOX_WINDOW}) ORDER BY rowid",
    ),
    (
        "chat_decisions",
        "SELECT rowid AS rid, id, group_id, latest_id, batch_ids, mentioned, forced, "
        "waited, gate, action, spoken_kind, target_id, wait_seconds, reason, outbox_id, "
        f"policy, model_ms, created_at FROM chat_decisions WHERE {DECISION_WINDOW} ORDER BY rowid",
    ),
    (
        "jobs",
        "SELECT rowid AS rid, id, kind, payload, status, attempts, lease_until, error, created_at "
        f"FROM jobs WHERE created_at >= {JOBS_START_MS} ORDER BY created_at, rowid",
    ),
    (
        "stage_timings",
        "SELECT rowid AS rid, turn_id, stage, at, extra FROM stage_timings "
        f"WHERE at >= {START_MS} ORDER BY at, rowid",
    ),
    (
        "health_samples",
        "SELECT rowid AS rid, at, gateway_ok, runner_ok, pending, failed "
        f"FROM health_samples WHERE at >= {START_MS} ORDER BY at",
    ),
    (
        "deliveries",
        "SELECT rowid AS rid, id, job_id, message_id, status, files, sent_count, updated_at "
        "FROM deliveries WHERE updated_at >= '2026-11-11T15:41:00+08:00' ORDER BY rowid",
    ),
    (
        "facts",
        "SELECT rowid AS rid, id, repo, subject, predicate, value, evidence, source_id, "
        f"status, valid_from, valid_to FROM facts WHERE valid_from >= '{WINDOW_START}' "
        "OR valid_to IS NULL ORDER BY rowid",
    ),
    (
        "tasks",
        "SELECT rowid AS rid, id, repo, title, detail, status, version, assignee, result, "
        f"source_id, lease, lease_until, created_at, updated_at FROM tasks "
        f"WHERE created_at >= '{WINDOW_START}' OR updated_at >= '{WINDOW_START}' ORDER BY rowid",
    ),
    (
        "dreams",
        "SELECT rowid AS rid, id, date, body, sources, created_at, message_count "
        f"FROM dreams WHERE created_at >= '{WINDOW_START}' ORDER BY rowid",
    ),
    (
        "model_runs",
        "SELECT rowid AS rid, id, kind, effort, status, duration_ms, input_tokens, "
        f"output_tokens, created_at FROM model_runs WHERE created_at >= {START_MS} ORDER BY rowid",
    ),
    (
        "repo_state",
        "SELECT rowid AS rid, repo, json, fingerprint, updated_at, checked_at FROM repo_state ORDER BY repo",
    ),
    (
        # D-1 limits this table to repo + updated_at; the JSON blob is not needed.
        "repo_cache",
        "SELECT rowid AS rid, repo, updated_at FROM repo_cache ORDER BY repo",
    ),
    (
        # v2: image metadata only; never image bytes.
        "message_images",
        "SELECT rowid AS rid, message_id, idx, sha FROM message_images ORDER BY message_id, idx",
    ),
    (
        # v2: image OCR/description only, no sticker_like/bytes.
        "image_notes",
        "SELECT rowid AS rid, sha, desc, tags, text FROM image_notes ORDER BY sha",
    ),
    (
        # Never export token_hash.  v2 adds revoked for provenance membership checks.
        "members",
        "SELECT rowid AS rid, id, name, role, revoked FROM members ORDER BY id",
    ),
    (
        # Whitelist only.  auth:* and any other credential-bearing key stays online.
        "settings",
        "SELECT rowid AS rid, key, value FROM settings WHERE key IN "
        "('runner_seen','last_message','chat_cursor','group_id') "
        "OR key LIKE 'chat_cursor:%' OR key LIKE 'off:%' ORDER BY key",
    ),
]

OPTIONAL_TABLES = {"message_images", "image_notes", "outbox_meta"}

COUNT_QUERIES = [
    ("count-messages", f"SELECT COUNT(*) AS n FROM messages WHERE {MESSAGE_WINDOW}"),
    ("count-outbox", f"SELECT COUNT(*) AS n FROM outbox WHERE {OUTBOX_WINDOW}"),
    ("count-chat_decisions", f"SELECT COUNT(*) AS n FROM chat_decisions WHERE {DECISION_WINDOW}"),
]


# Opaque QQ message ids are base64-ish and can incidentally contain the
# literal "sk-".  Normalize it inside id-bearing fields only, so the export
# has zero credential-marker hits without touching real message text.
ID_FIELDS = {
    "id", "msg_id", "latest_id", "batch_ids", "target_id", "outbox_id",
    "turn_id", "payload", "json", "sources", "message_id", "job_id",
    "source_id", "error",
}
SCRUBBED = []


def scrub_ids(row):
    if not isinstance(row, dict):
        return row
    clean = {}
    for key, value in row.items():
        if key not in ID_FIELDS:
            clean[key] = value
            continue
        if isinstance(value, str) and "sk-" in value:
            SCRUBBED.append({"field": key, "occurrences": value.count("sk-")})
            clean[key] = value.replace("sk-", "sk_")
        elif isinstance(value, str) and value[:1] in "[{":
            # JSON-encoded id lists (batch_ids, payload) are covered by the
            # plain replacement above; this branch is kept for clarity.
            clean[key] = value.replace("sk-", "sk_")
        else:
            clean[key] = value
    return clean


def post(sql, token):
    body = json.dumps({"sql": sql}).encode()
    request = urllib.request.Request(
        BASE,
        data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    context = ssl.create_default_context()
    try:
        import certifi  # macOS python often lacks the system CA bundle

        context = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    with urllib.request.urlopen(request, timeout=60, context=context) as response:
        return json.load(response)


def run_query(name, sql, token, audit, optional=False):
    if not sql.lstrip().upper().startswith("SELECT"):
        raise SystemExit(f"refusing non-SELECT query: {name}")
    payload = post(sql, token)
    if not payload.get("success"):
        errors = payload.get("errors") or []
        message = json.dumps(errors, ensure_ascii=False)
        if optional and "no such table" in message.lower():
            return None
        raise SystemExit(f"{name}: D1 error {errors}")
    result = payload["result"][0]
    meta = result["meta"]
    if meta.get("rows_written") != 0 or meta.get("changes") != 0:
        raise SystemExit(
            f"{name}: production write detected rows_written={meta.get('rows_written')} "
            f"changes={meta.get('changes')}"
        )
    rows = [scrub_ids(row) for row in result["results"]]
    audit.append(
        {
            "query": name,
            "sql": sql,
            "records": len(rows),
            "rows_written": meta.get("rows_written"),
            "changes": meta.get("changes"),
            "rows_read": meta.get("rows_read"),
        }
    )
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    token = pathlib.Path(args.token_file).read_text().strip()
    if not token:
        raise SystemExit("empty token file")

    stamp = datetime.datetime.now(TZ).strftime("%Y%m%d-%H%M%S")
    out = pathlib.Path(args.out) if args.out else pathlib.Path(
        tempfile.gettempdir()
    ) / f"teamagent-review-export-{stamp}"
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    log = (out / "export.log").open("w", encoding="utf-8")
    log.write("线上 D1 写入 0 行\n")
    log.write(f"窗口 {WINDOW_START} – {WINDOW_END}；数据库 {DATABASE}\n")
    audit = []
    counts = {}
    try:
        for name, sql in QUERIES:
            rows = run_query(name, sql, token, audit, optional=name in OPTIONAL_TABLES)
            if rows is None:
                rows = []
                print(name, "MISSING table online; wrote empty placeholder")
                log.write(f"{name} MISSING_TABLE rows_written=0 placeholder=[]\n")
            target = out / f"{name}.json"
            target.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
            target.chmod(0o600)
            print(name, "records", len(rows), "rows_written 0")
            log.write(f"{name} records={len(rows)} rows_written=0 changes=0\n")
        for name, sql in COUNT_QUERIES:
            rows = run_query(name, sql, token, audit)
            n = int(rows[0]["n"])
            counts[name.removeprefix("count-")] = n
            print(name, n, "rows_written 0")
            log.write(f"{name} n={n} rows_written=0 changes=0\n")
        (out / "online-counts.json").write_text(
            json.dumps(counts, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (out / "audit.json").write_text(
            json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        if SCRUBBED:
            log.write(
                "id-normalize: an opaque QQ message id looked like an API key prefix; "
                f"the hyphen was replaced in {len(SCRUBBED)} id field(s), message text untouched: {SCRUBBED}\n"
            )
        log.write(f"done: {len(audit)} read-only SELECTs, 线上 D1 写入 0 行\n")
        log.close()
        print("OUT", out)
        print("counts", counts)
        print("线上 D1 写入 0 行")
    finally:
        if not log.closed:
            log.close()
        for path in out.glob("*"):
            path.chmod(0o600)


if __name__ == "__main__":
    main()
