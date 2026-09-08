from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt


class LedgerLine(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    account: str = Field(min_length=1, max_length=32)
    amount_cents: StrictInt = Field(alias="amountCents")
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    external_ref: str = Field(alias="externalRef", min_length=1, max_length=80)


@dataclass(frozen=True, slots=True)
class FinanceException:
    type: Literal["amount_mismatch", "unmatched_ledger", "unmatched_bank"]
    account: str
    currency: str
    external_ref: str
    ledger_cents: int | None
    bank_cents: int | None
    delta_cents: int


def parse_lines(raw: list[dict[str, object]] | list[LedgerLine]) -> list[LedgerLine]:
    return [
        item if isinstance(item, LedgerLine) else LedgerLine.model_validate(item)
        for item in raw
    ]


def reconcile(
    ledger: list[dict[str, object]] | list[LedgerLine],
    bank: list[dict[str, object]] | list[LedgerLine],
) -> list[FinanceException]:
    left_lines = parse_lines(ledger)
    right_lines = parse_lines(bank)
    keys = sorted({_line_key(item) for item in (*left_lines, *right_lines)})
    exceptions: list[FinanceException] = []
    for key in keys:
        left = _sum_cents([item for item in left_lines if _line_key(item) == key])
        right = _sum_cents([item for item in right_lines if _line_key(item) == key])
        sample = next((item for item in left_lines if _line_key(item) == key), None) or next(
            (item for item in right_lines if _line_key(item) == key), None
        )
        if sample is None or left == right:
            continue
        exception_type: Literal["amount_mismatch", "unmatched_ledger", "unmatched_bank"]
        if left is None:
            exception_type = "unmatched_bank"
        elif right is None:
            exception_type = "unmatched_ledger"
        else:
            exception_type = "amount_mismatch"
        exceptions.append(
            FinanceException(
                type=exception_type,
                account=sample.account,
                currency=sample.currency,
                external_ref=sample.external_ref,
                ledger_cents=left,
                bank_cents=right,
                delta_cents=(right or 0) - (left or 0),
            )
        )
    return exceptions


def specialist_findings(exception: FinanceException) -> list[dict[str, str]]:
    if exception.type == "unmatched_bank":
        return [
            {
                "specialist": "treasury",
                "exceptionRef": exception.external_ref,
                "summary": (
                    f"Bank {exception.external_ref} has no ledger match; "
                    "check cutoff and deposits in transit."
                ),
            }
        ]
    if exception.type == "unmatched_ledger":
        return [
            {
                "specialist": "gl",
                "exceptionRef": exception.external_ref,
                "summary": (
                    f"Ledger {exception.external_ref} has no bank match; review unpresented items."
                ),
            }
        ]
    return [
        {
            "specialist": "gl",
            "exceptionRef": exception.external_ref,
            "summary": (
                f"Amount mismatch of {exception.delta_cents} cents on {exception.external_ref}."
            ),
        },
        {
            "specialist": "tax",
            "exceptionRef": exception.external_ref,
            "summary": (
                f"Confirm tax timing is not the {exception.delta_cents} cent variance "
                f"on {exception.external_ref}."
            ),
        },
    ]


def propose_posting(period: str, exceptions: list[FinanceException]) -> dict[str, object] | None:
    lines = [
        {
            "account": exception.account,
            "amountCents": exception.delta_cents,
            "currency": exception.currency,
            "memo": f"Adjust {exception.external_ref} ({exception.type})",
        }
        for exception in exceptions
        if exception.delta_cents != 0
    ]
    if not lines:
        return None
    return {"ledger": "sandbox", "period": period, "lines": lines}


def audit(
    period: str,
    exceptions: list[FinanceException],
    findings: list[dict[str, str]],
    posting: dict[str, object] | None,
) -> dict[str, object]:
    refs = {item.external_ref for item in exceptions}
    covered = all(finding.get("exceptionRef") in refs for finding in findings)
    integer_cents = all(isinstance(item.delta_cents, int) for item in exceptions)
    sandbox_only = posting is None or posting.get("ledger") == "sandbox"
    return {
        "period": period,
        "balanced": not exceptions,
        "exceptionCount": len(exceptions),
        "findings": findings,
        "checks": [
            {
                "id": "exceptions-have-rca",
                "passed": covered and len(findings) >= len(exceptions),
                "detail": "Every exception has at least one specialist finding.",
            },
            {
                "id": "integer-money",
                "passed": integer_cents,
                "detail": "All money values are integer cents.",
            },
            {
                "id": "sandbox-ledger-only",
                "passed": sandbox_only,
                "detail": (
                    "Posting adapters stay on the sandbox ledger until a later production unlock."
                ),
            },
        ],
    }


def run_reconciliation(
    period: str,
    ledger: list[dict[str, object]],
    bank: list[dict[str, object]],
) -> tuple[list[FinanceException], dict[str, object], dict[str, object] | None]:
    exceptions = reconcile(ledger, bank)
    findings = [finding for exception in exceptions for finding in specialist_findings(exception)]
    posting = propose_posting(period, exceptions)
    pack = audit(period, exceptions, findings, posting)
    return exceptions, pack, posting


def exception_dict(exception: FinanceException) -> dict[str, object]:
    return {
        "type": exception.type,
        "account": exception.account,
        "currency": exception.currency,
        "externalRef": exception.external_ref,
        "ledgerCents": exception.ledger_cents,
        "bankCents": exception.bank_cents,
        "deltaCents": exception.delta_cents,
    }


def _line_key(line: LedgerLine) -> str:
    return f"{line.account}|{line.currency}|{line.external_ref}"


def _sum_cents(lines: list[LedgerLine]) -> int | None:
    if not lines:
        return None
    return sum(item.amount_cents for item in lines)
