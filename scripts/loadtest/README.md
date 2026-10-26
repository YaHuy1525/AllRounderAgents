# Load tests (k6)

Load-tests the console assistant on the Mastra host:

- `POST /api/agents/{id}/generate` — JSON completion request; the check asserts a
  non-empty `text` field.
- `POST /api/agents/{id}/stream` — streamed response; the check asserts the body
  carries `text-delta` frames.
- `HTTP 429` — there is no 429 handling. The host enforces no rate limit, so every
  response other than 200 is a real failure (`http.expectedStatuses(200)`), and
  nothing is discounted as expected traffic.

Every request sends `memory.resource: "loadtest:probe"` on purpose. The host writes the
reserved resource key from the verified token, which takes precedence over the
client-supplied value, so a foreign resource must not change what comes back — a load
run that returns another tenant's threads is a tenancy bug, and this is where it would
show up.

The numbers are model-dependent. The host has no local fallback, so a run without a
funded `OPENROUTER_API_KEY` measures the error path, not the assistant. Compare runs
only against each other, on the same model.

## Prerequisites

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) — Windows:
  `winget install k6 --source winget` (or `choco install k6`); macOS: `brew
  install k6`; Docker alternative: `grafana/k6` image.
- A running Mastra host (`npm run dev` from the repo root; default port 4111).
- A Supabase access token. The host verifies the JWT and derives the tenant and the
  memory resource from the signed claim, so an unauthenticated run only measures 401s.

## Run

```powershell
k6 run -e AUTH_TOKEN="$TOKEN" scripts/loadtest/k6-chat.js
k6 run -e AUTH_TOKEN="$TOKEN" -e FLOW=stream -e VUS=5 -e DURATION=30s scripts/loadtest/k6-chat.js
k6 run -e AUTH_TOKEN="$TOKEN" -e FLOW=mixed -e VUS=10 -e DURATION=60s scripts/loadtest/k6-chat.js
```

| Env          | Default                 | Meaning                                                         |
| ------------ | ----------------------- | --------------------------------------------------------------- |
| `BASE_URL`   | `http://localhost:4111` | Host origin.                                                     |
| `AUTH_TOKEN` | — (required)            | Supabase access token; the script throws when it is absent.      |
| `AGENT_ID`   | `console-assistant`     | Agent id on the host.                                            |
| `VUS`        | `5`                     | Virtual users.                                                   |
| `DURATION`   | `30s`                   | Test duration.                                                   |
| `FLOW`       | `generate`              | `generate`, `stream`, or `mixed` (streams every 3rd iteration).   |
| `PACE_MS`    | `0`                     | Pause between iterations per VU.                                 |

## Thresholds

| Metric                             | Threshold         | Notes                                                    |
| ---------------------------------- | ----------------- | -------------------------------------------------------- |
| `http_req_failed`                  | `< 5%`            | No 429s are expected, so this is a real failure rate.     |
| `checks`                           | `> 99%`           | Response-contract checks.                                 |
| `http_req_duration{kind:generate}` | `p(95) < 20000ms` | `generate` flow only.                                     |
| `http_req_duration{kind:stream}`   | `p(95) < 60000ms` | `stream` flow only.                                       |

Only the thresholds for the selected `FLOW` are applied; `mixed` keeps the two common
ones and leaves latency unconstrained, because it mixes both shapes.

## Reading the results

- `http_req_duration` percentiles — end-to-end latency as the caller sees it, which
  includes model time. A p95 that tracks the provider's own latency is the model, not
  the host.
- Failed checks — a `200` with no `text`, or no `text-delta` frames on a stream, means
  the host answered without content; look at the agent the id points at and its model
  key.
- Stream runs are capped by the 120 s request timeout, so many VUs on `stream` measure
  provider concurrency more than host capacity.
