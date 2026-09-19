"""Bundled, versioned icon identifiers; no external SVG URLs or uploads."""
import json
from pathlib import Path
ICONS = json.loads((Path(__file__).parent / "icons" / "catalog.json").read_text(encoding="utf-8"))
ICON_IDS = frozenset(item["id"] for item in ICONS)
