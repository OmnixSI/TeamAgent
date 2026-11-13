"""Private runtime location shared by the local runner.

INKBOARD_TEAM_HOME points every reader at an isolated runtime for replays and
tests. When it is unset the path is exactly the historical
``Path.home() / ".inkboard-team"``, byte for byte.
"""
import json
import os
from pathlib import Path


def home():
    value = os.environ.get("INKBOARD_TEAM_HOME")
    if value:
        return Path(value)
    return Path.home() / ".inkboard-team"


def config():
    return json.loads((home() / "config.json").read_text())
