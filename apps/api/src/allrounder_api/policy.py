"""Versioned governance policy: loader for ``policy/risk.yaml`` and
``policy/tools.yaml`` (Master Plan Phase 5 — one risk/approval/audit model).

The YAML files are the single source for the deterministic thresholds the
dispatcher enforces, the sensitive-ticket markers that force human approval,
the cross-domain spawn rule and the tool permission matrix. Loading validates
the whole document, so a malformed policy fails closed at startup instead of
silently drifting from the tests in ``apps/api/tests/test_governance.py``.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

POLICY_DIR_ENV = "POLICY_DIR"
RISK_FILE = "risk.yaml"
TOOLS_FILE = "tools.yaml"
SUPPORTED_VERSION = 1
SCOPE_PATTERN = r"^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$"
RUN_SIDE_EFFECT_SCOPE = "{workflow}:{step}"


class PolicyError(ValueError):
    """Raised when a policy file is missing, malformed or inconsistent."""


class ApprovalClass(StrEnum):
    AUTO = "auto"
    APPROVAL = "approval"
    REFUSE = "refuse"
    READ_ONLY = "read-only"


@dataclass(frozen=True)
class TriagePolicy:
    base_confidence: float
    signal_weight: float
    confidence_cap: float
    project_signal_bonus: int
    human_review_below: float


@dataclass(frozen=True)
class PreflightPolicy:
    irreversible_terms: tuple[str, ...]
    high_blast_terms: tuple[str, ...]
    score_both: int
    score_single: int
    score_benign: int
    refuse_at: int
    approval_at: int
    domain_terms: Mapping[str, tuple[str, ...]]


@dataclass(frozen=True)
class SensitivePolicy:
    clause: str
    markers: tuple[str, ...]
    required_gate: str


@dataclass(frozen=True)
class SpawnPolicy:
    enabled: bool
    from_domain: str
    target_project: str
    issue_type: str
    signals: tuple[str, ...]
    labels: tuple[str, ...]


@dataclass(frozen=True)
class RiskPolicy:
    version: int
    triage: TriagePolicy
    preflight: PreflightPolicy
    sensitive: SensitivePolicy
    spawn: SpawnPolicy


@dataclass(frozen=True)
class ToolPermission:
    name: str
    description: str
    scope: str
    approval_class: ApprovalClass
    idempotent: bool
    idempotency_key: str | None


@dataclass(frozen=True)
class ToolMatrix:
    version: int
    tools: tuple[ToolPermission, ...]

    def get(self, name: str) -> ToolPermission:
        for tool in self.tools:
            if tool.name == name:
                return tool
        raise KeyError(f"Tool {name!r} is not in the permission matrix")


def policy_dir() -> Path:
    """Resolve the ``policy/`` directory: env override, else walk up from the
    package (works both in the repo and in the API container)."""

    override = os.environ.get(POLICY_DIR_ENV)
    if override:
        candidate = Path(override)
        if not (candidate / RISK_FILE).is_file():
            raise PolicyError(f"{POLICY_DIR_ENV}={override} has no {RISK_FILE}")
        return candidate
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "policy"
        if (candidate / RISK_FILE).is_file():
            return candidate
    raise PolicyError(
        "policy/risk.yaml not found next to the package; set " + POLICY_DIR_ENV
    )


def load_risk_policy(directory: Path | str | None = None) -> RiskPolicy:
    document = _load_document(Path(directory) if directory is not None else policy_dir(), RISK_FILE)
    version = _integer(document.get("version"), "version")
    if version != SUPPORTED_VERSION:
        raise PolicyError(f"risk.yaml version {version} is not supported ({SUPPORTED_VERSION})")
    triage = _mapping(document.get("triage"), "triage")
    preflight = _mapping(document.get("preflight"), "preflight")
    scores = _mapping(preflight.get("scores"), "preflight.scores")
    gates = _mapping(preflight.get("gates"), "preflight.gates")
    domains = _mapping(preflight.get("domains"), "preflight.domains")
    sensitive = _mapping(document.get("sensitive"), "sensitive")
    spawn = _mapping(document.get("spawn"), "spawn")
    human_review_below = _number(triage.get("human_review_below"), "triage.human_review_below")
    if not 0 < human_review_below <= 1:
        raise PolicyError("triage.human_review_below must be in (0, 1]")
    refuse_at = _integer(gates.get("refuse_at"), "preflight.gates.refuse_at")
    approval_at = _integer(gates.get("approval_at"), "preflight.gates.approval_at")
    if not 0 <= approval_at < refuse_at <= 100:
        raise PolicyError("preflight gates must satisfy 0 <= approval_at < refuse_at <= 100")
    required_gate = _text(sensitive.get("required_gate"), "sensitive.required_gate")
    if required_gate != ApprovalClass.APPROVAL:
        raise PolicyError("sensitive.required_gate must be 'approval' (mandatory human review)")
    spawn_signals = _text_tuple(spawn.get("signals"), "spawn.signals")
    if not spawn_signals:
        raise PolicyError("spawn.signals must not be empty")
    return RiskPolicy(
        version=version,
        triage=TriagePolicy(
            base_confidence=_number(triage.get("base_confidence"), "triage.base_confidence"),
            signal_weight=_number(triage.get("signal_weight"), "triage.signal_weight"),
            confidence_cap=_number(triage.get("confidence_cap"), "triage.confidence_cap"),
            project_signal_bonus=_integer(
                triage.get("project_signal_bonus"), "triage.project_signal_bonus"
            ),
            human_review_below=human_review_below,
        ),
        preflight=PreflightPolicy(
            irreversible_terms=_text_tuple(
                preflight.get("irreversible_terms"), "preflight.irreversible_terms"
            ),
            high_blast_terms=_text_tuple(
                preflight.get("high_blast_terms"), "preflight.high_blast_terms"
            ),
            score_both=_integer(
                scores.get("irreversible_high_blast"), "preflight.scores.irreversible_high_blast"
            ),
            score_single=_integer(scores.get("single_risk"), "preflight.scores.single_risk"),
            score_benign=_integer(scores.get("benign"), "preflight.scores.benign"),
            refuse_at=refuse_at,
            approval_at=approval_at,
            domain_terms={
                str(domain): _text_tuple(
                    _mapping(entry, f"preflight.domains.{domain}").get("require_approval_terms"),
                    f"preflight.domains.{domain}.require_approval_terms",
                )
                for domain, entry in domains.items()
            },
        ),
        sensitive=SensitivePolicy(
            clause=_text(sensitive.get("clause"), "sensitive.clause"),
            markers=_text_tuple(sensitive.get("markers"), "sensitive.markers"),
            required_gate=required_gate,
        ),
        spawn=SpawnPolicy(
            enabled=_boolean(spawn.get("enabled"), "spawn.enabled"),
            from_domain=_text(spawn.get("from_domain"), "spawn.from_domain"),
            target_project=_text(spawn.get("target_project"), "spawn.target_project"),
            issue_type=_text(spawn.get("issue_type"), "spawn.issue_type"),
            signals=spawn_signals,
            labels=_text_tuple(spawn.get("labels"), "spawn.labels"),
        ),
    )


def load_tool_matrix(directory: Path | str | None = None) -> ToolMatrix:
    document = _load_document(
        Path(directory) if directory is not None else policy_dir(), TOOLS_FILE
    )
    version = _integer(document.get("version"), "version")
    if version != SUPPORTED_VERSION:
        raise PolicyError(f"tools.yaml version {version} is not supported ({SUPPORTED_VERSION})")
    entries = _sequence(document.get("tools"), "tools")
    if not entries:
        raise PolicyError("tools.yaml must declare at least one tool")
    tools: list[ToolPermission] = []
    seen: set[str] = set()
    for index, raw in enumerate(entries):
        where = f"tools[{index}]"
        entry = _mapping(raw, where)
        name = _text(entry.get("name"), f"{where}.name")
        if name in seen:
            raise PolicyError(f"duplicate tool {name!r} in the permission matrix")
        seen.add(name)
        scope = _text(entry.get("scope"), f"{where}.scope")
        if scope != RUN_SIDE_EFFECT_SCOPE and re.fullmatch(SCOPE_PATTERN, scope) is None:
            raise PolicyError(f"{where}.scope must match {SCOPE_PATTERN} (got {scope!r})")
        approval_class = _approval_class(entry.get("class"), f"{where}.class")
        idempotent, idempotency_key = _idempotency(entry, where, approval_class)
        tools.append(
            ToolPermission(
                name=name,
                description=_text(entry.get("description"), f"{where}.description"),
                scope=scope,
                approval_class=approval_class,
                idempotent=idempotent,
                idempotency_key=idempotency_key,
            )
        )
    return ToolMatrix(version=version, tools=tuple(tools))


@lru_cache(maxsize=1)
def default_risk_policy() -> RiskPolicy:
    return load_risk_policy()


@lru_cache(maxsize=1)
def default_tool_matrix() -> ToolMatrix:
    return load_tool_matrix()


def _idempotency(
    entry: Mapping[str, object], where: str, approval_class: ApprovalClass
) -> tuple[bool, str | None]:
    key = entry.get("idempotency_key")
    if approval_class is ApprovalClass.READ_ONLY:
        if entry.get("idempotent") or key is not None:
            raise PolicyError(f"{where}: read-only tools must not declare idempotency")
        return False, None
    idempotent = _boolean(entry.get("idempotent"), f"{where}.idempotent")
    if not idempotent:
        raise PolicyError(f"{where}: every write tool must be idempotent")
    return True, _text(key, f"{where}.idempotency_key")


def _approval_class(value: object, where: str) -> ApprovalClass:
    text = _text(value, where)
    try:
        return ApprovalClass(text)
    except ValueError as error:
        allowed = ", ".join(item.value for item in ApprovalClass)
        raise PolicyError(f"{where} must be one of {allowed}") from error


def _load_document(directory: Path, name: str) -> Mapping[str, object]:
    path = directory / name
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise PolicyError(f"{path} does not exist") from error
    except yaml.YAMLError as error:
        raise PolicyError(f"{path} is not valid YAML: {error}") from error
    return _mapping(raw, name)


def _mapping(value: object, where: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PolicyError(f"{where} must be an object")
    return value


def _sequence(value: object, where: str) -> Sequence[object]:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes):
        raise PolicyError(f"{where} must be a list")
    return value


def _text(value: object, where: str) -> str:
    if not isinstance(value, str) or not value:
        raise PolicyError(f"{where} must be a non-empty string")
    return value


def _text_tuple(value: object, where: str) -> tuple[str, ...]:
    return tuple(
        _text(item, f"{where}[{index}]")
        for index, item in enumerate(_sequence(value, where))
    )


def _number(value: object, where: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise PolicyError(f"{where} must be a number")
    return float(value)


def _integer(value: object, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise PolicyError(f"{where} must be an integer")
    return value


def _boolean(value: object, where: str) -> bool:
    if not isinstance(value, bool):
        raise PolicyError(f"{where} must be a boolean")
    return value


__all__ = [
    "ApprovalClass",
    "POLICY_DIR_ENV",
    "PolicyError",
    "PreflightPolicy",
    "RUN_SIDE_EFFECT_SCOPE",
    "RiskPolicy",
    "SensitivePolicy",
    "SpawnPolicy",
    "ToolMatrix",
    "ToolPermission",
    "TriagePolicy",
    "default_risk_policy",
    "default_tool_matrix",
    "load_risk_policy",
    "load_tool_matrix",
    "policy_dir",
]
