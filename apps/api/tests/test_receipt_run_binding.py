"""Task 3 (PR1 T3): opt-in mandatory runId binding on receipt validation.

The signer-level tests pin the ``require_run_id`` flag's meaning; the lane
test proves the run-driven conversion is observable end to end: a receipt
bound to a different run cannot record a decision or drive the step.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from allrounder_api.approvals import ApprovalReceiptSigner, ReceiptError
from allrounder_api.auth import Principal
from allrounder_api.repositories import InMemoryApprovalRepository
from allrounder_api.runs import RunConflictError, ScriptedMastraRunClient, build_memory_run_service

SECRET = b"run-receipt-secret-for-tests-0123456789"
NOW = datetime(2026, 10, 21, 12, 0, 0, tzinfo=UTC)
PRINCIPAL = Principal("user-1", "omnidewalt", frozenset({"agent", "approver", "admin"}))
TENANT = "omnidewalt"
SECURITY_STEPS = ("ingest", "triage", "investigate", "decide", "approve", "contain")


def _signer() -> ApprovalReceiptSigner:
    return ApprovalReceiptSigner(SECRET, clock=lambda: NOW)


def _issue(signer: ApprovalReceiptSigner, *, run_id: str | None = None) -> str:
    return signer.issue(
        approval_id="approval-1",
        case_id="case-1",
        action={"draft": "exact"},
        approver="user-1",
        scope="support:send",
        decision="approved",
        expires_at=NOW + timedelta(minutes=5),
        run_id=run_id,
    )


def _validate(
    signer: ApprovalReceiptSigner, token: str, *, run_id: str | None = None,
    require_run_id: bool = False,
) -> object:
    return signer.validate(
        token,
        approval_id="approval-1",
        case_id="case-1",
        action={"draft": "exact"},
        scope="support:send",
        now=NOW,
        run_id=run_id,
        require_run_id=require_run_id,
    )


def test_unbound_token_fails_with_flag_and_passes_without_it() -> None:
    """The flag's meaning, pinned in one test: same token, same caller, the
    only difference is ``require_run_id``. Default False skips the run check
    entirely; True demands a non-empty binding on the token itself."""
    signer = _signer()
    token = _issue(signer)  # no run_id at issue time
    with pytest.raises(ReceiptError):
        _validate(signer, token, require_run_id=True)
    claims = _validate(signer, token)  # default False: as before
    assert claims.run_id is None  # type: ignore[attr-defined]


def test_token_for_run_a_never_validates_for_run_b_under_either_flag() -> None:
    signer = _signer()
    token = _issue(signer, run_id="run-a")
    with pytest.raises(ReceiptError):
        _validate(signer, token, run_id="run-b")
    with pytest.raises(ReceiptError):
        _validate(signer, token, run_id="run-b", require_run_id=True)
    # Sanity: the same token still validates for its own run under the flag.
    claims = _validate(signer, token, run_id="run-a", require_run_id=True)
    assert claims.run_id == "run-a"  # type: ignore[attr-defined]


def test_legacy_unbound_token_still_passes_default_path() -> None:
    """Legacy behavior (D3) is provably unchanged: no run binding at issue,
    no run supplied at validation, flag off -> accepted exactly as before."""
    signer = _signer()
    token = _issue(signer)
    claims = _validate(signer, token)
    assert claims.approval_id == "approval-1"  # type: ignore[attr-defined]
    assert claims.run_id is None  # type: ignore[attr-defined]


def test_run_binding_rejection_is_indistinguishable_from_signature_failure() -> None:
    """A failed run binding must leak nothing: same type, same generic wording
    as a tampered signature or any other failed check."""
    signer = _signer()
    unbound = _issue(signer)
    with pytest.raises(ReceiptError) as binding:
        _validate(signer, unbound, run_id="run-1", require_run_id=True)
    with pytest.raises(ReceiptError) as signature:
        signer.validate(
            unbound + "tampered",
            approval_id="approval-1",
            case_id="case-1",
            action={"draft": "exact"},
            scope="support:send",
            now=NOW,
        )
    with pytest.raises(ReceiptError) as field:
        signer.validate(
            unbound,
            approval_id="approval-OTHER",
            case_id="case-1",
            action={"draft": "exact"},
            scope="support:send",
            now=NOW,
        )
    assert str(binding.value) == str(signature.value) == str(field.value) == "Invalid receipt"
    assert type(binding.value) is type(signature.value) is ReceiptError


class _CrossBoundSigner(ApprovalReceiptSigner):
    """Simulates a cross-run receipt: the side-effect step's token is issued
    with a valid signature but a run binding that points at a different run."""

    def issue(
        self,
        *,
        approval_id: str,
        case_id: str,
        action: dict[str, object],
        approver: str,
        scope: str,
        decision: str,
        expires_at: datetime,
        run_id: str | None = None,
    ) -> str:
        bound_to = "run-elsewhere" if scope == "security:contain" else run_id
        return super().issue(
            approval_id=approval_id,
            case_id=case_id,
            action=action,
            approver=approver,
            scope=scope,
            decision=decision,
            expires_at=expires_at,
            run_id=bound_to,
        )


async def test_cross_run_receipt_cannot_drive_the_side_effect_step() -> None:
    """End to end through the security lane: review steps (scope
    ``run:security``) proceed normally, but the ``security:contain`` receipt
    bound to a foreign run is rejected by the converted validation sites —
    no decision recorded, no side effect executed, run stays parked."""
    client = ScriptedMastraRunClient(
        {"securityFlow": SECURITY_STEPS}, side_effecting=frozenset({"contain"})
    )
    service = build_memory_run_service(
        signer=_CrossBoundSigner(SECRET),
        approvals=InMemoryApprovalRepository(),
        mastra=client,
    )
    run = await service.start(
        workflow="security",
        ticket_key="SEC-201",
        case_id="case-cross-run",
        run_input={
            "alertSource": "edr",
            "title": "Encoded PowerShell beacon from fin-db-01",
            "rawAlert": "powershell.exe -enc registering a scheduled task",
            "host": "fin-db-01",
            "indicators": ["203.0.113.77"],
        },
        principal=PRINCIPAL,
    )
    for step_id in SECURITY_STEPS[:-1]:
        result = await service.decide(
            run_id=run.run_id, step_id=step_id, action="proceed", principal=PRINCIPAL
        )
        assert result.receipt is not None

    with pytest.raises(RunConflictError):
        await service.decide(
            run_id=run.run_id, step_id="contain", action="proceed", principal=PRINCIPAL
        )

    parked = await service.get(run.run_id, TENANT)
    assert parked.status == "awaiting_human"
    contain = parked.step("contain")
    assert contain.decision is None
    assert contain.receipt is None
    # The containment side effect never acted on the cross-bound token.
    assert "contain" not in client.effect_executions
