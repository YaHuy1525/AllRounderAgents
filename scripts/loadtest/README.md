# Load tests (k6)

Load-tests the chat surface of the API:

- `POST /chat` — JSON completion request (model with local fallback).
- `POST /chat/stream` — SSE stream; the script validates the terminating
  `"done": true` event and the `X-Accel-Buffering: no` header.
- `HTTP 429` — rate-limit responses are treated as expected traffic: the script
  asserts the `Retry-After` header and counts them in `rate_limited_total`
  instead of letting them pollute `http_req_failed`.

TTFT (time to first streamed token) is measured server-side, not by k6: while a
test runs, watch `chat_first_token_seconds` (histogram buckets, per `source`)
on `GET /metrics`, or the Grafana dashboard `chat-stream` if the ops stack from
`compose.yaml` is up (Prometheus :9090, Grafana :3001).

## Prerequisites

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) — Windows:
  `winget install k6 --source winget` (or `choco install k6`); macOS: `brew
  install k6`; Docker alternative: `grafana/k6` image.
- A running API (`docker compose up -d api` or the production factory).
- A bearer token with role `viewer`, `agent`, `approver`, or `admin` in
  `app_metadata`. The production app validates Supabase Auth JWTs via JWKS
  (`SUPABASE_JWKS_URL` / `SUPABASE_JWT_ISSUER`), so pass a Supabase access
  token. Note the bare `create_app` factory rejects every token (it wires an
  empty `FakeBearerVerifier`), so run the production factory or compose stack
  for real traffic.

## Run

```powershell
k6 run -e AUTH_TOKEN="$TOKEN" scripts/loadtest/k6-chat.js
k6 run -e AUTH_TOKEN="$TOKEN" -e FLOW=stream -e VUS=5 -e DURATION=30s scripts/loadtest/k6-chat.js
k6 run -e AUTH_TOKEN="$TOKEN" -e FLOW=mixed -e VUS=10 -e DURATION=60s scripts/loadtest/k6-chat.js
```

| Env        | Default                 | Meaning                                   |
| ---------- | ----------------------- | ----------------------------------------- |
| `BASE_URL` | `http://localhost:8000` | Target origin.                             |
| `AUTH_TOKEN` | — (required)          | Bearer JWT.                                |
| `VUS`      | `5`                     | Virtual users.                             |
| `DURATION` | `30s`                   | Test duration.                             |
| `FLOW`     | `chat`                  | `chat`, `stream`, or `mixed` (streams every 3rd iteration). |
| `PACE_MS`  | `0`                     | Pause between iterations per VU.           |

## Thresholds

| Metric                        | Threshold   | Notes                                     |
| ----------------------------- | ----------- | ----------------------------------------- |
| `http_req_failed`             | `< 5%`      | Excludes expected 429s.                    |
| `checks`                      | `> 99%`     | All response-contract checks.              |
| `http_req_duration{kind:chat}`   | `p(95) < 2000ms` | Chat flow only.                    |
| `http_req_duration{kind:stream}` | `p(95) < 8000ms` | Stream flow only.                  |

Only the thresholds for the selected `FLOW` are applied. The default server
rate limit is 120 requests/minute per key (`RATE_LIMIT_PER_MINUTE`), so a
sustained run above that rate will show expected 429s in `rate_limited_total`
— that is the rate limiter working, not a test failure.

## Reading the results

- `chat_source_total{source=…}` — how often the model answered vs. the local
  fallback. A `local`-heavy run points at model connectivity, not the API.
- `rate_limited_total` — 429 count; every sample also asserts a numeric
  `Retry-After`.
- `http_req_duration` percentiles — end-to-end latency; correlate with
  `chat_first_token_seconds` on `/metrics` to separate queueing from
  time-to-first-token.
