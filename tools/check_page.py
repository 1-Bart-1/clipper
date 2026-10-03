"""Fail when the page script reaches for an element id the markup does not define."""
import re
import sys
from pathlib import Path

static = Path(__file__).resolve().parent.parent / "pklipper" / "static"
markup = (static / "index.html").read_text()
script = (static / "app.js").read_text()
declared = set(re.findall(r'id="([^"]+)"', markup))
used = set(re.findall(r'element\("([^"]+)"\)', script)) | \
       set(re.findall(r'press\("([^"]+)"', script))
missing = sorted(used - declared)
if missing:
    sys.exit("app.js reaches for ids that index.html does not define: "
             + ", ".join(missing))
print(f"{len(used)} ids all present")
