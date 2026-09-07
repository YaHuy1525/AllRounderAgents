from __future__ import annotations

import json
from pathlib import Path

import pytest
from allrounder_api.contracts import EvidencePack, RiskScore, Ticket, TriageVerdict
from allrounder_api.schemas import export_canonical_schemas
from pydantic import ValidationError

ROOT = Path(__file__).parents[3]
PARITY = json.loads((ROOT / "fixtures" / "contract_parity.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", PARITY)
def test_pydantic_contract_parity_cases(case: dict[str, object]) -> None:
    models = {
        "Ticket": Ticket,
        "TriageVerdict": TriageVerdict,
        "RiskScore": RiskScore,
        "EvidencePack": EvidencePack,
    }
    if case["valid"]:
        models[case["schema"]].model_validate(case["value"])
    else:
        with pytest.raises(ValidationError):
            models[case["schema"]].model_validate(case["value"])


def test_canonical_json_schemas_are_current(tmp_path: Path) -> None:
    export_canonical_schemas(tmp_path)
    committed = ROOT / "contracts" / "jsonschema"
    for generated in tmp_path.glob("*.json"):
        assert json.loads(generated.read_text()) == json.loads(
            (committed / generated.name).read_text()
        )


def test_contracts_forbid_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        TriageVerdict.model_validate(
            {
                "domain": "support",
                "confidence": 0.9,
                "urgency": 2,
                "needsHuman": False,
                "rationale": "clear",
                "secret": "must not pass",
            }
        )

