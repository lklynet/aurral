import json
import sys

json.dump(
    {
        "ok": False,
        "error": {"code": "internal_error", "message": "stub failure"},
    },
    sys.stdout,
)
sys.stdout.write("\n")
