from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel

from .contracts import EvidencePack, RiskScore, Ticket, TriageVerdict

CONTRACTS: dict[str, type[BaseModel]] = {
    "ticket": Ticket,
    "triage-verdict": TriageVerdict,
    "risk-score": RiskScore,
    "evidence-pack": EvidencePack,
}


def export_canonical_schemas(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name, model in CONTRACTS.items():
        schema = model.model_json_schema(by_alias=True)
        (directory / f"{name}.schema.json").write_text(
            json.dumps(schema, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

