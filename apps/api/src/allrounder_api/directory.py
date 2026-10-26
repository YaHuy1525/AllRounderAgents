"""Employee directory for start-field prefill.

The HR lanes read people through the TypeScript ``EmployeeDirectory`` seam,
which is fixture-backed. The serving plane needs the same records to fill a
start field the user did not type, so this module declares the same read
surface in Python and reads the same ``fixtures/hr_directory.json``. One
fixture, two readers: the sandbox stays consistent, and a real HRIS connector
replaces ``FixtureEmployeeDirectory`` without touching a caller.

The fixture holds one simulated company, so it answers the same rows for
whatever tenant asks. The seam keeps the read surface -- id, name, department --
so swapping in a per-tenant HRIS source is a change inside this module rather
than a change at every call site.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

FIXTURE_NAME = "hr_directory.json"

_NON_WORD = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class Employee:
    """The record the console may read; a flow still gets the full row."""

    employee_id: str
    full_name: str
    role_title: str
    department: str
    manager_id: str | None
    status: str
    leave_balance_days: int


class EmployeeDirectory(Protocol):
    """The HRIS seam: read-only, and ``None``/empty instead of a guessed row."""

    def list(self) -> tuple[Employee, ...]: ...

    def get(self, employee_id: str) -> Employee | None: ...

    def find_by_name(self, text: str) -> tuple[Employee, ...]: ...

    def search(self, query: str) -> tuple[Employee, ...]: ...


def normalize_name(value: str) -> str:
    """Lowercase word tokens joined by single spaces, so spacing never matters."""

    return " ".join(_NON_WORD.sub(" ", value.lower()).split())


@dataclass(frozen=True)
class FixtureEmployeeDirectory:
    """Reads the simulated company directory shipped with the repo."""

    employees: tuple[Employee, ...] = ()

    @classmethod
    def load(cls, path: Path) -> FixtureEmployeeDirectory:
        raw = json.loads(path.read_text(encoding="utf-8"))
        rows = raw.get("employees") if isinstance(raw, dict) else None
        if not isinstance(rows, list):
            raise ValueError(f"{path.name} carries no employees list")
        employees = tuple(
            _employee(row) for row in rows if isinstance(row, dict)
        )
        return cls(employees=employees)

    @classmethod
    def default(cls) -> FixtureEmployeeDirectory:
        """The repo fixture, found by walking up from this package."""

        return cls.load(fixture_file())

    def list(self) -> tuple[Employee, ...]:
        return self.employees

    def get(self, employee_id: str) -> Employee | None:
        wanted = employee_id.strip().lower()
        if wanted == "":
            return None
        for employee in self.employees:
            if employee.employee_id.lower() == wanted:
                return employee
        return None

    def find_by_name(self, text: str) -> tuple[Employee, ...]:
        """Every employee whose full name appears as words inside ``text``.

        A full name only: matching a surname alone would let "Sam" resolve to
        the wrong colleague, and a wrong subject is worse than an empty field.
        """

        haystack = normalize_name(text)
        if haystack == "":
            return ()
        padded = f" {haystack} "
        matches = [
            employee
            for employee in self.employees
            if f" {normalize_name(employee.full_name)} " in padded
        ]
        return tuple(matches)

    def search(self, query: str) -> tuple[Employee, ...]:
        """Rows a person asked about, exact name first then partial name.

        A query is a human question, so every name token may match: "Jordan"
        finds Jordan Avery. Prefill deliberately uses ``find_by_name`` instead,
        where a partial name is not enough to pick the run's subject.
        """

        tokens = normalize_name(query).split()
        if not tokens:
            return ()
        exact = self.find_by_name(query)
        if exact:
            return exact
        return tuple(
            employee
            for employee in self.employees
            if set(tokens) <= set(normalize_name(employee.full_name).split())
        )


def fixture_file() -> Path:
    """``fixtures/hr_directory.json``, resolved the way ``policy/`` is."""

    for parent in Path(__file__).resolve().parents:
        candidate = parent / "fixtures" / FIXTURE_NAME
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        f"{FIXTURE_NAME} not found next to the package; the employee directory is unreadable"
    )


def load_directory() -> FixtureEmployeeDirectory:
    """The shipped directory, or an empty one so prefill degrades to asking."""

    try:
        return FixtureEmployeeDirectory.default()
    except (OSError, ValueError):
        return FixtureEmployeeDirectory()


def _employee(row: dict[str, object]) -> Employee:
    employee_id = str(row.get("employeeId", "")).strip()
    full_name = str(row.get("fullName", "")).strip()
    if employee_id == "" or full_name == "":
        raise ValueError("employee row without employeeId or fullName")
    manager = row.get("managerId")
    balance = row.get("leaveBalanceDays")
    return Employee(
        employee_id=employee_id,
        full_name=full_name,
        role_title=str(row.get("roleTitle", "")).strip(),
        department=str(row.get("department", "")).strip(),
        manager_id=None if manager is None else str(manager).strip(),
        status=str(row.get("status", "")).strip(),
        leave_balance_days=int(balance) if isinstance(balance, int) else 0,
    )


def employee_payload(employee: Employee) -> dict[str, object]:
    """The shape a tool may show: org facts, never the personal balance."""

    return {
        "employeeId": employee.employee_id,
        "fullName": employee.full_name,
        "roleTitle": employee.role_title,
        "department": employee.department,
        "managerId": employee.manager_id,
        "status": employee.status,
    }


__all__ = [
    "Employee",
    "EmployeeDirectory",
    "FixtureEmployeeDirectory",
    "employee_payload",
    "fixture_file",
    "load_directory",
    "normalize_name",
]
