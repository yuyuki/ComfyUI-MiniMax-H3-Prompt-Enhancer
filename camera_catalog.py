# SPDX-License-Identifier: GPL-3.0-only
"""Canonical camera vocabulary. Regenerate browser/schema artifacts after edits."""

import json
from pathlib import Path

CAMERA_CATALOG = json.loads(Path(__file__).with_name("camera_catalog.json").read_text(encoding="utf-8"))
CAMERA_MOTIONS = {item["value"]: item for item in CAMERA_CATALOG["motions"]}
FRAME_ENUMS = {key: set(values) for key, values in CAMERA_CATALOG["frameEnums"].items()}
