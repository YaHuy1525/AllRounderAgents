"""Temporary probe: console-assistant generate + stream with the real bridge body."""

import json
import urllib.request

BODY = {
    "messages": [{"role": "user", "content": "can you list all the HR related tasks?"}],
    "system": "You are a helpful assistant for a Jira console.",
    "memory": {"resource": "probe:tenant", "thread": "console-chat"},
    "requestContext": {"tenantId": "probe-tenant"},
}

url = "http://localhost:4111/api/agents/console-assistant/generate"
req = urllib.request.Request(
    url, data=json.dumps(BODY).encode(),
    headers={"Content-Type": "application/json"}, method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode())
        print(f"generate -> {resp.status}, text[:200]: {payload.get('text', '')[:200]!r}")
except Exception as error:  # noqa: BLE001
    print(f"generate -> ERROR {error}")

surl = "http://localhost:4111/api/agents/console-assistant/stream"
sreq = urllib.request.Request(
    surl, data=json.dumps(BODY).encode(),
    headers={"Content-Type": "application/json"}, method="POST",
)
try:
    with urllib.request.urlopen(sreq, timeout=120) as resp:
        deltas = 0
        sample = ""
        done = False
        for raw in resp:
            line = raw.decode().rstrip("\n")
            if not line.startswith("data: "):
                continue
            data = line[6:]
            if data == "[DONE]":
                done = True
                break
            try:
                event = json.loads(data)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and event.get("type") == "text-delta":
                deltas += 1
                sample += (event.get("payload") or {}).get("text", "")
        print(f"stream -> deltas={deltas}, done={done}, text[:200]: {sample[:200]!r}")
except Exception as error:  # noqa: BLE001
    print(f"stream -> ERROR {error}")
