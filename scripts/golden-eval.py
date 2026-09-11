"""Golden-ticket routing gate: replay evals/golden_tickets.jsonl through the dispatcher.

Each case pins the expected domain and gate for a Jira webhook payload, so routing
regressions fail CI with an exact expected-vs-actual line instead of a silent change.
"""

import json
import sys
from collections.abc import Mapping
from pathlib import Path

from allrounder_api.dispatcher import DeterministicDispatcher, normalize_jira_payload

ROOT = Path(__file__).resolve().parents[1]
GOLDEN_PATH = ROOT / "evals" / "golden_tickets.jsonl"


def load_cases(path: Path) -> list[dict[str, object]]:
    cases: list[dict[str, object]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        case = json.loads(line)
        if not isinstance(case, dict):
            raise ValueError(f"{path}:{number} is not a JSON object")
        cases.append(case)
    return cases


def expected_pair(case: Mapping[str, object]) -> dict[str, str]:
    expected = case.get("expected")
    if not isinstance(expected, Mapping):
        raise ValueError(f"{case.get('id')}: missing 'expected' object")
    return {"domain": str(expected.get("domain")), "gate": str(expected.get("gate"))}


def main() -> int:
    dispatcher = DeterministicDispatcher()
    cases = load_cases(GOLDEN_PATH)
    mismatches = 0
    for case in cases:
        case_id = str(case.get("id"))
        payload = case.get("payload")
        if not isinstance(payload, Mapping):
            raise ValueError(f"{case_id}: missing 'payload' object")
        actions = case.get("actions")
        ticket = normalize_jira_payload(payload)
        routed = dispatcher.dispatch(ticket, actions if isinstance(actions, list) else None)
        actual = {"domain": routed.verdict.domain.value, "gate": routed.gate.value}
        expected = expected_pair(case)
        if actual == expected:
            print(f"PASS {case_id}: domain={actual['domain']} gate={actual['gate']}")
        else:
            mismatches += 1
            print(f"FAIL {case_id}: expected {expected} got {actual}")
    print(f"{len(cases) - mismatches}/{len(cases)} golden cases matched")
    if mismatches:
        print("Golden gate failed.", file=sys.stderr)
        return 1
    print("Golden gate passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
