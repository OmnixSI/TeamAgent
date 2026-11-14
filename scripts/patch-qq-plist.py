#!/usr/bin/env python3
"""Add a launchd-safe PATH to the QQ service plist, and nothing else.

The live com.inkboard.team-qq service was created without
EnvironmentVariables.PATH, so launchd started the gateway with
PATH=/usr/bin:/bin:/usr/sbin:/sbin. runner/tts.mjs then spawned a bare
"ffmpeg", which launchd could not find even though Homebrew installed it in
/opt/homebrew/bin.

This script rewrites only EnvironmentVariables.PATH (node's directory,
/opt/homebrew/bin and the system directories, keeping any extra entries that
are already there). It never calls launchctl: run it with --apply, then let the
delivery step bootout/bootstrap the service.
"""
from __future__ import annotations

import argparse
import os
import plistlib
import sys
from pathlib import Path

LABEL = "com.inkboard.team-qq"
SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
HOMEBREW_BIN = "/opt/homebrew/bin"


def default_plist() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / (LABEL + ".plist")


def node_dir(value: dict) -> str:
    arguments = value.get("ProgramArguments") or []
    if not arguments:
        return ""
    return str(Path(str(arguments[0])).expanduser().parent)


def required_dirs(value: dict) -> list[str]:
    parts = []
    directory = node_dir(value)
    if directory:
        parts.append(directory)
    parts.append(HOMEBREW_BIN)
    parts.extend(SYSTEM_DIRS)
    return parts


def desired_path(value: dict) -> str:
    parts = required_dirs(value)
    current = str((value.get("EnvironmentVariables") or {}).get("PATH", ""))
    for item in current.split(":"):
        item = item.strip()
        if item and item not in parts:
            parts.append(item)
    return ":".join(parts)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plist", type=Path, default=default_plist())
    parser.add_argument(
        "--apply", action="store_true", help="write the patched plist"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 0 only when PATH already has the required directories",
    )
    args = parser.parse_args()
    path = args.plist.expanduser()
    if not path.exists():
        print("找不到 " + LABEL + " 的 plist：" + str(path), file=sys.stderr)
        return 2
    with path.open("rb") as handle:
        value = plistlib.load(handle)

    current = str((value.get("EnvironmentVariables") or {}).get("PATH", ""))
    want = desired_path(value)
    if args.check:
        present = set(current.split(":"))
        missing = [item for item in required_dirs(value) if item not in present]
        if missing:
            print("PATH 缺少：" + "、".join(missing), file=sys.stderr)
            return 1
        print("PATH 已包含所需目录。")
        return 0

    if current == want:
        print("PATH 无需修改：" + current)
        return 0
    if not args.apply:
        print("当前 PATH：" + (current or "（未设置，launchd 默认 /usr/bin:/bin:/usr/sbin:/sbin）"))
        print("建议 PATH：" + want)
        print("加 --apply 写入；本脚本不会重启服务。")
        return 0

    patched = dict(value)
    environment = dict(patched.get("EnvironmentVariables") or {})
    environment["PATH"] = want
    patched["EnvironmentVariables"] = environment
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("wb") as handle:
        plistlib.dump(patched, handle, sort_keys=False)
    os.replace(temp, path)
    print("已更新 PATH（只改 EnvironmentVariables.PATH）：" + str(path))
    print("  " + want)
    print("未重启服务。交付时执行：")
    print("  launchctl bootout gui/$(id -u)/" + LABEL)
    print("  launchctl bootstrap gui/$(id -u) " + str(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
