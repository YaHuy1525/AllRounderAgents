"""Deterministic start-field prefill: fill only what a record can prove.

The console asks the human for the values it cannot obtain, and asks the
directory for the ones it can. Every suggestion carries the record it came
from, because a filled field the user cannot trace is worse than an empty one:
a wrong employee id starts a leave request against the wrong person, and no
chat reply should be able to do that quietly.

What is never suggested, on purpose:

* ``date``, ``number`` and ``text`` fields, which the flow derives or the user
  owns;
* enum values, which would be a guess about intent;
* a second employee, when two directory rows match, because the tie is exactly
  the case where a human must choose.

The catalog's ``WorkflowDefinition.start_fields`` stays the only declaration of
what a workflow needs, so this module adds no second contract to keep in sync.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from ..directory import EmployeeDirectory
from .models import StartField, WorkflowDefinition

# Fields resolved from the directory by matching a full name in the request.
NAME_FIELDS = ("employeeId",)


@dataclass(frozen=True)
class FieldSuggestion:
    """One value plus the record it came from, so the card can cite it."""

    field_id: str
    label: str
    value: str
    source: str


@dataclass(frozen=True)
class PrefillResult:
    suggestions: tuple[FieldSuggestion, ...]
    missing: tuple[StartField, ...]


def prefill_start_fields(
    definition: WorkflowDefinition,
    *,
    text: str = "",
    ticket_summary: str = "",
    values: Mapping[str, object] | None = None,
    employees: EmployeeDirectory | None = None,
    repositories: Sequence[str] = (),
) -> PrefillResult:
    """Suggest values for the fields ``values`` leaves empty, and name the rest.

    ``values`` is what the caller already has: values typed in the message, or
    a field the user filled on the card. A suggestion never overwrites one,
    because the human's value is the one the run must use.
    """

    given: dict[str, object] = {
        key: value for key, value in (values or {}).items() if not _blank(value)
    }
    suggestions: list[FieldSuggestion] = []
    for start_field in definition.start_fields:
        if start_field.id in given:
            continue
        suggestion = _suggest(
            start_field,
            text=f"{text} {ticket_summary}".strip(),
            employees=employees,
            repositories=repositories,
        )
        if suggestion is None:
            continue
        suggestions.append(suggestion)
        given[start_field.id] = suggestion.value
    missing = tuple(
        start_field
        for start_field in definition.start_fields
        if start_field.required and _blank(given.get(start_field.id))
    )
    return PrefillResult(tuple(suggestions), missing)


def suggestion_payload(suggestion: FieldSuggestion) -> dict[str, str]:
    return {
        "id": suggestion.field_id,
        "label": suggestion.label,
        "value": suggestion.value,
        "source": suggestion.source,
    }


def missing_payload(start_field: StartField) -> dict[str, str]:
    return {"id": start_field.id, "label": start_field.label}


def _suggest(
    start_field: StartField,
    *,
    text: str,
    employees: EmployeeDirectory | None,
    repositories: Sequence[str],
) -> FieldSuggestion | None:
    if start_field.id == "repository":
        return _repository(start_field, repositories)
    if start_field.id in NAME_FIELDS and employees is not None:
        return _employee(start_field, text, employees)
    return None


def _employee(
    start_field: StartField, text: str, employees: EmployeeDirectory
) -> FieldSuggestion | None:
    matched = employees.find_by_name(text)
    if len(matched) != 1:
        # No name, or a tie two people share: only a human can pick.
        return None
    employee = matched[0]
    return FieldSuggestion(
        field_id=start_field.id,
        label=start_field.label,
        value=employee.employee_id,
        source=f"directory: {employee.full_name} ({employee.employee_id})",
    )


def _repository(
    start_field: StartField, repositories: Sequence[str]
) -> FieldSuggestion | None:
    names = [name.strip() for name in repositories if name.strip() != ""]
    if len(names) != 1:
        # Several allowlisted repositories, or none: the choice is the user's.
        return None
    return FieldSuggestion(
        field_id=start_field.id,
        label=start_field.label,
        value=names[0],
        source="allowed repositories",
    )


def _blank(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, (list, tuple, dict)):
        return len(value) == 0
    return False


__all__ = [
    "FieldSuggestion",
    "NAME_FIELDS",
    "PrefillResult",
    "missing_payload",
    "prefill_start_fields",
    "suggestion_payload",
]
