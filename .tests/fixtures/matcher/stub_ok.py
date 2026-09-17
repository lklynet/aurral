import json
import os
import sys

request = json.load(sys.stdin)
response = os.environ.get("STUB_MATCHER_RESPONSE")
if response:
    sys.stdout.write(response)
else:
    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "protocol": 1,
                "operation": request.get("operation"),
                "beetsVersion": "stub-1.0.0",
            }
        )
    )
sys.stdout.write("\n")
