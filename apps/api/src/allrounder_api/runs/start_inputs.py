"""Start-input checks: refuse an incomplete run at the door.

Each flow's Zod ``InputSchema`` stays the authority on the exact value. This
module only enforces the contract the catalog already publishes through
``WorkflowDefinition.start_fields``, so a start that is missing a required
value comes back as one 422 naming every offending field — instead of a run
that saves, drives, and then fails (or, worse, suspends on a step whose gate
the flow cannot compute) because ``employeeId`` was absent.

Deliberately lenient where the flow is lenient: a number may arrive as ``7``
or ``"7"``, and an unlisted optional field is ignored rather than rejected.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import date

from .models import StartField, WorkflowDefinition

DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# One entry per offending field: the id the console and the rail key on, and
# the sentence a human reads next to that input.
FieldProblem = dict[str, str]


def start_problems(
    definition: WorkflowDefinition, run_input: Mapping[str, object]
) -> list[FieldProblem]:
    """Every reason ``run_input`` cannot start ``definition`` (empty when it can)."""

    problems: list[FieldProblem] = []
    for start_field in definition.start_fields:
        problem = _field_problem(start_field, run_input.get(start_field.id))
        if problem is not None:
            problems.append({"field": start_field.id, "problem": problem})
    return problems


def describe_problems(problems: list[FieldProblem]) -> str:
    """One sentence for the 422 body: the first field plus a count of the rest."""

    if not problems:
        return "Start input is valid"
    first = problems[0]
    rest = len(problems) - 1
    suffix = "" if rest == 0 else f" (+{rest} more field(s) to fix)"
    return f"{first['field']}: {first['problem']}{suffix}"


def _is_blank(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, (list, tuple, dict)):
        return len(value) == 0
    return False


def _field_problem(start_field: StartField, value: object) -> str | None:
    label = start_field.label
    if _is_blank(value):
        return f"{label} is required." if start_field.required else None
    if start_field.kind == "enum":
        if not isinstance(value, str) or value not in start_field.values:
            return f"{label} must be one of: {', '.join(start_field.values)}."
        return None
    if start_field.kind == "number":
        if not _is_number(value):
            return f"{label} must be a number."
        return None
    if start_field.kind == "date":
        if not isinstance(value, str) or not _is_date(value):
            return f"{label} must be a date in YYYY-MM-DD form."
        return None
    if start_field.kind == "list":
        if isinstance(value, (str, list, tuple)):
            return None
        return f"{label} must be a list or a comma-separated string."
    # ``text``: a list or object here would reach the flow as the wrong type.
    if not isinstance(value, str):
        return f"{label} must be text."
    return None


def _is_number(value: object) -> bool:
    # ``bool`` is an ``int`` in Python; a checkbox is not a pull request number.
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        try:
            float(value.strip())
        except ValueError:
            return False
        return True
    return False


def _is_date(value: str) -> bool:
    if DATE_PATTERN.match(value) is None:
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


__all__ = ["DATE_PATTERN", "FieldProblem", "describe_problems", "start_problems"]
