"""Phase 5 governance suite: one risk/approval/audit model, asserted.

* ``policy/risk.yaml`` is the single source for dispatcher thresholds, the
  sensitive-ticket clause and the cross-domain spawn rule — the numeric pins
  below make every threshold change a deliberate, reviewed edit.
* ``policy/tools.yaml`` is walked tool by tool: scope, approval class and
  idempotency discipline are pinned, read-only tools declare no idempotency,
  and every transport write maps to a matrix entry.
* The N2 connectable providers (``connectors:``) are pinned provider by
  provider: each scope is a reviewed permission scope and each class an
  approval posture; connecting never grants a tool.
* Every ``side_effecting`` workflow step maps to the ``run.side-effect``
  template via the shared ``side_effect_scope`` helper.
* Audit-first redaction cites frozen clauses.

Denial paths for each approval-class tool live next to their executors
(test_phase1 support.send, test_phase3 finance.post, test_runs tampered
receipts, the Mastra bills suites for xero.post, src/mastra/agents/qa for the
squad's two gate-backed writes, and test_qa_defects for its filing route) —
the registry test below keeps that set complete.
"""

from __future__ import annotations

import re
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest
from allrounder_api.contracts import Domain, Gate, Ticket
from allrounder_api.dispatcher import DeterministicDispatcher
from allrounder_api.jira import FakeJiraTransport, HttpJiraTransport
from allrounder_api.jira_mcp import McpJiraTransport
from allrounder_api.policy import (
    RUN_SIDE_EFFECT_SCOPE,
    SCOPE_PATTERN,
    ApprovalClass,
    PolicyError,
    RiskPolicy,
    default_risk_policy,
    default_tool_matrix,
    load_risk_policy,
    load_tool_matrix,
    policy_dir,
)
from allrounder_api.repositories import (
    CLAUSE_ACCOUNT,
    CLAUSE_EMAIL,
    CLAUSE_SECRET_KEY,
    CLAUSE_SECRET_VALUE,
    REDACTION_CLAUSES,
    audit_redaction,
)
from allrounder_api.runs.definitions import WORKFLOW_DEFINITIONS, side_effect_scope

# The permission matrix as reviewed: name -> (class, scope, idempotency key).
EXPECTED_TOOLS: dict[str, tuple[str, str, str | None]] = {
    "jira.comment": ("auto", "jira-projects", "eventId"),
    "jira.transition": ("auto", "jira-projects", "eventId"),
    "jira.create-ticket": ("auto", "jira-projects", "correlationId"),
    # The desk seam (src/mastra/desks/types.ts) mirrors these names 1:1.
    "desk.create-ticket": ("auto", "desk-tickets", "correlationId"),
    "desk.comment": ("auto", "desk-tickets", "receiptRef"),
    "desk.transition": ("auto", "desk-tickets", "eventId"),
    "desk.attach": ("auto", "desk-tickets", "evidenceRef"),
    "support.send": ("approval", "support:send", "draftHash"),
    "finance.post": ("approval", "finance:post", "ledgerKey"),
    # The bills lane's ledger seam: reading is read-only, posting is approval
    # only behind the signed receipt and idempotent by the flow's ledger key.
    "xero.read": ("read-only", "xero-ledger", None),
    "xero.post": ("approval", "xero:post", "ledgerKey"),
    "run.side-effect": ("approval", RUN_SIDE_EFFECT_SCOPE, "actionHash"),
    # The MSP audit pack is a deterministic derived view; packKey is
    # tenant:clientRef:month, so re-exporting the same month is idempotent.
    "auditpack.export": ("auto", "audit-packs", "packKey"),
    "jira.read": ("read-only", "jira-projects", None),
    "desk.read": ("read-only", "desk-tickets", None),
    "github.read": ("read-only", "repo-allowlist", None),
    "knowledge.retrieve": ("read-only", "knowledge-domains", None),
    # Coding-lane web search (Path B tool loop): read-only function tool the
    # investigator/actor/critic may call for current external context.
    "web.search": ("read-only", "web-search", None),
    # Coding-lane repository reads (agent quality upgrade): read-only agent
    # tools over the allowlisted repo; the write side stays flow-owned behind
    # run.side-effect receipts. patch.validate is the actor's in-turn
    # self-check against the deterministic structure floor (pure, local).
    "repo.read_file": ("read-only", "repo-allowlist", None),
    "repo.list_dir": ("read-only", "repo-allowlist", None),
    "repo.search_code": ("read-only", "repo-allowlist", None),
    "patch.validate": ("read-only", "coding-lane-local", None),
    # Console assistant reads (the rail's start card): the three Mastra tools
    # are reads over the published start contract, the employee directory, and
    # the tenant's ticket search, so the assistant holds no writer — the
    # confirm button posts /runs itself.
    "console.resolve_start_fields": ("read-only", "workflow-start-fields", None),
    "console.lookup_employee": ("read-only", "employee-directory", None),
    "console.list_tickets": ("read-only", "jira-projects", None),
    "console.execute_ticket": ("read-only", "jira-projects", None),
    # QA squad writes (the qa lane): both act only on a human forward decision
    # at their gate, and both key their replay (caseSetHash, correlationId).
    "qa.cases-write": ("approval", "qa-cases", "caseSetHash"),
    "qa.file-defect": ("approval", "qa-defects", "correlationId"),
}

# Transport writes -> matrix tool; adding a write method without an entry is a
# governance failure. Denial semantics of the approval tools are exercised in
# test_phase1 (support.send 403), test_phase3 (finance.post 403) and test_runs
# (tampered side-effect receipt -> RunConflictError).
TRANSPORT_WRITES: dict[str, str] = {
    "add_comment": "jira.comment",
    "transition": "jira.transition",
    "create_issue": "jira.create-ticket",
}

# The run lane's side effects, as reviewed: workflow id -> side-effecting steps.
EXPECTED_SIDE_EFFECTS: dict[str, tuple[str, ...]] = {
    "review": ("complete",),
    "issues": ("complete",),
    "features": ("complete",),
    "dependencies": ("merge",),
    "accessibility": ("re-scan",),
    "vendors": ("create",),
    "leave": ("apply",),
    "onboarding": ("provision",),
    "offboarding": ("revoke", "attest"),
    "screening": ("schedule",),
    "hr-help": ("send",),
    "security": ("contain",),
    "msp": ("ticket", "send"),
    "bills": ("post",),
    # QA drives the approved cases and files the findings the human kept; both
    # are governed writes, so both cross the receipt band. approve-cases is a
    # checkpoint that writes only to the lane's own case store.
    "qa": ("execute", "file-defects"),
}

# The N2 connectable providers, as reviewed: provider -> (scope, class). The
# scope is the reviewed permission the connection is registered under (slack
# is catalog-only: `approver-notify` never carries a workflow action), and the
# class is the strongest approval posture of any action flowing through it.
EXPECTED_CONNECTORS: dict[str, tuple[str, str]] = {
    "github": ("repo-allowlist", "read-only"),
    "jira": ("jira-projects", "auto"),
    "gmail": ("hr-help:send", "approval"),
    "calendar": ("screening:schedule", "approval"),
    "slack": ("approver-notify", "approval"),
}


def _ticket(
    key: str = "XYZ-1",
    project: str = "XYZ",
    summary: str = "Customer question",
    description: str = "",
    labels: list[str] | None = None,
) -> Ticket:
    return Ticket(
        key=key,
        project=project,
        issue_type="Task",
        labels=labels or [],
        priority="Medium",
        summary=summary,
        description=description,
        reporter="tester",
        attachments=[],
        event_id=f"event-{key}",
        received_at=datetime.now(UTC),
    )


def _risk_with_triage(**overrides: float | int) -> RiskPolicy:
    base = default_risk_policy()
    return replace(base, triage=replace(base.triage, **overrides))


def test_policy_directory_resolves_the_repo_files() -> None:
    root = policy_dir()
    assert (root / "risk.yaml").is_file()
    assert (root / "tools.yaml").is_file()


def test_policy_dir_env_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    (tmp_path / "risk.yaml").write_text("version: 1", encoding="utf-8")
    monkeypatch.setenv("POLICY_DIR", str(tmp_path))
    assert policy_dir() == tmp_path
    monkeypatch.setenv("POLICY_DIR", str(tmp_path / "missing"))
    with pytest.raises(PolicyError):
        policy_dir()


def test_risk_policy_thresholds_are_pinned() -> None:
    policy = default_risk_policy()
    assert policy.version == 1
    assert policy.triage.base_confidence == pytest.approx(0.55)
    assert policy.triage.signal_weight == pytest.approx(0.08)
    assert policy.triage.confidence_cap == pytest.approx(0.99)
    assert policy.triage.project_signal_bonus == 3
    assert policy.triage.human_review_below == pytest.approx(0.7)
    assert policy.preflight.score_both == 90
    assert policy.preflight.score_single == 55
    assert policy.preflight.score_benign == 10
    assert policy.preflight.refuse_at == 80
    assert policy.preflight.approval_at == 40
    assert policy.sensitive.clause == "sensitive/personal-data"
    assert policy.sensitive.required_gate == "approval"
    assert policy.spawn.enabled is True
    assert policy.spawn.from_domain == "support"
    assert policy.spawn.target_project == "ENG"
    assert policy.spawn.issue_type == "Bug"


def test_risk_loader_rejects_unsupported_version(tmp_path: Path) -> None:
    source = (policy_dir() / "risk.yaml").read_text(encoding="utf-8")
    (tmp_path / "risk.yaml").write_text(
        source.replace("version: 1", "version: 2", 1), encoding="utf-8"
    )
    with pytest.raises(PolicyError):
        load_risk_policy(tmp_path)


def test_tool_loader_rejects_unsupported_version(tmp_path: Path) -> None:
    source = (policy_dir() / "tools.yaml").read_text(encoding="utf-8")
    (tmp_path / "tools.yaml").write_text(
        source.replace("version: 1", "version: 2", 1), encoding="utf-8"
    )
    with pytest.raises(PolicyError):
        load_tool_matrix(tmp_path)


def test_tool_loader_rejects_read_only_idempotency(tmp_path: Path) -> None:
    (tmp_path / "tools.yaml").write_text(
        "version: 1\ntools:\n"
        "  - name: jira.read\n"
        "    description: read\n"
        "    scope: jira-projects\n"
        "    class: read-only\n"
        "    idempotent: true\n",
        encoding="utf-8",
    )
    with pytest.raises(PolicyError):
        load_tool_matrix(tmp_path)


def test_tool_loader_rejects_non_idempotent_write(tmp_path: Path) -> None:
    (tmp_path / "tools.yaml").write_text(
        "version: 1\ntools:\n"
        "  - name: jira.comment\n"
        "    description: write\n"
        "    scope: jira-projects\n"
        "    class: auto\n"
        "    idempotent: false\n",
        encoding="utf-8",
    )
    with pytest.raises(PolicyError):
        load_tool_matrix(tmp_path)


def test_tool_loader_rejects_scope_outside_pattern(tmp_path: Path) -> None:
    (tmp_path / "tools.yaml").write_text(
        "version: 1\ntools:\n"
        "  - name: finance.post\n"
        "    description: write\n"
        "    scope: Finance Post!\n"
        "    class: approval\n"
        "    idempotent: true\n"
        "    idempotency_key: ledgerKey\n",
        encoding="utf-8",
    )
    with pytest.raises(PolicyError):
        load_tool_matrix(tmp_path)


def test_connector_loader_rejects_duplicate_providers(tmp_path: Path) -> None:
    (tmp_path / "tools.yaml").write_text(
        "version: 1\ntools:\n"
        "  - name: jira.read\n"
        "    description: read\n"
        "    scope: jira-projects\n"
        "    class: read-only\n"
        "connectors:\n"
        "  - provider: gmail\n"
        "    description: mail\n"
        "    scope: hr-help:send\n"
        "    class: approval\n"
        "  - provider: gmail\n"
        "    description: mail again\n"
        "    scope: hr-help:send\n"
        "    class: approval\n",
        encoding="utf-8",
    )
    with pytest.raises(PolicyError):
        load_tool_matrix(tmp_path)


def test_connector_loader_rejects_bad_provider_id(tmp_path: Path) -> None:
    (tmp_path / "tools.yaml").write_text(
        "version: 1\ntools:\n"
        "  - name: jira.read\n"
        "    description: read\n"
        "    scope: jira-projects\n"
        "    class: read-only\n"
        "connectors:\n"
        "  - provider: Gmail!\n"
        "    description: mail\n"
        "    scope: hr-help:send\n"
        "    class: approval\n",
        encoding="utf-8",
    )
    with pytest.raises(PolicyError):
        load_tool_matrix(tmp_path)


def test_connector_loader_rejects_unknown_class(tmp_path: Path) -> None:
    (tmp_path / "tools.yaml").write_text(
        "version: 1\ntools:\n"
        "  - name: jira.read\n"
        "    description: read\n"
        "    scope: jira-projects\n"
        "    class: read-only\n"
        "connectors:\n"
        "  - provider: gmail\n"
        "    description: mail\n"
        "    scope: hr-help:send\n"
        "    class: notify\n",
        encoding="utf-8",
    )
    with pytest.raises(PolicyError):
        load_tool_matrix(tmp_path)


def test_tool_matrix_matches_the_reviewed_registry() -> None:
    matrix = default_tool_matrix()
    assert matrix.version == 1
    names = [tool.name for tool in matrix.tools]
    assert len(names) == len(set(names))
    assert set(names) == set(EXPECTED_TOOLS)
    for name, (approval_class, scope, idempotency_key) in EXPECTED_TOOLS.items():
        tool = matrix.get(name)
        assert tool.approval_class is ApprovalClass(approval_class), name
        assert tool.scope == scope, name
        assert tool.idempotency_key == idempotency_key, name
        assert tool.idempotent is (approval_class != "read-only"), name
        if scope != RUN_SIDE_EFFECT_SCOPE:
            assert re.fullmatch(SCOPE_PATTERN, scope) is not None, name


def test_connector_catalog_matches_the_reviewed_registry() -> None:
    matrix = default_tool_matrix()
    pins = {connector.provider: connector for connector in matrix.connectors}
    assert set(pins) == set(EXPECTED_CONNECTORS)
    reviewed_scopes = {tool.scope for tool in matrix.tools} | {
        side_effect_scope(workflow, step)
        for workflow, steps in EXPECTED_SIDE_EFFECTS.items()
        for step in steps
    }
    for provider, (scope, approval_class) in EXPECTED_CONNECTORS.items():
        connector = pins[provider]
        assert connector.scope == scope, provider
        assert connector.approval_class is ApprovalClass(approval_class), provider
        assert connector.description != "", provider
        if provider == "slack":
            # Catalog-only scope: the connection never carries a workflow
            # action, it only notifies approvers.
            assert connector.scope not in reviewed_scopes
            assert "approver" in connector.description.lower()
        else:
            assert connector.scope in reviewed_scopes, provider


def test_approval_class_tools_have_denial_paths_in_the_suite() -> None:
    matrix = default_tool_matrix()
    approval_tools = {
        tool.name for tool in matrix.tools if tool.approval_class is ApprovalClass.APPROVAL
    }
    # Each of these acts only after a human forward decision — a signed
    # receipt for the run lanes, a gate decision for the QA squad's two steps —
    # and the denial path for every one is exercised in its lane suite (see
    # module docstring).
    assert approval_tools == {
        "support.send",
        "finance.post",
        "xero.post",
        "run.side-effect",
        "qa.cases-write",
        "qa.file-defect",
    }


def test_transport_writes_are_declared_in_the_matrix() -> None:
    matrix = default_tool_matrix()
    for method, tool_name in TRANSPORT_WRITES.items():
        for transport in (FakeJiraTransport, HttpJiraTransport, McpJiraTransport):
            assert hasattr(transport, method), (transport.__name__, method)
        assert matrix.get(tool_name).idempotent is True


def test_the_console_agent_tools_are_declared_read_only() -> None:
    """The tool ids the Mastra console assistant attaches, pinned to the matrix.

    A tool the agent can call but the matrix does not declare is an undeclared
    capability, which is exactly what this suite exists to prevent. The ids are
    read from the agent's own tool module so the two cannot drift apart.
    """

    source = policy_dir().parent / "src" / "mastra" / "shared" / "console-tools.ts"
    if not source.is_file():
        pytest.skip("the Mastra source tree is not present in this checkout")
    ids = set(re.findall(r'id: "([a-z_]+)"', source.read_text(encoding="utf-8")))
    assert ids == {
        "resolve_start_fields",
        "lookup_employee",
        "list_tickets",
        "execute_ticket",
    }
    matrix = default_tool_matrix()
    for tool_id in ids:
        declared = matrix.get(f"console.{tool_id}")
        assert declared.approval_class is ApprovalClass.READ_ONLY, tool_id


def test_every_side_effecting_step_maps_to_the_run_scope_template() -> None:
    assert default_tool_matrix().get("run.side-effect").scope == RUN_SIDE_EFFECT_SCOPE
    actual = {
        workflow_id: tuple(step.id for step in definition.steps if step.side_effecting)
        for workflow_id, definition in WORKFLOW_DEFINITIONS.items()
    }
    assert actual == EXPECTED_SIDE_EFFECTS
    for workflow_id, step_ids in actual.items():
        for step_id in step_ids:
            scope = side_effect_scope(workflow_id, step_id)
            assert re.fullmatch(SCOPE_PATTERN, scope) is not None, scope
            assert scope != RUN_SIDE_EFFECT_SCOPE


def test_sensitive_ticket_forces_human_and_cites_the_clause() -> None:
    dispatcher = DeterministicDispatcher()
    ticket = _ticket(key="SUP-900", project="SUP", summary="Payroll discrepancy for a customer")
    verdict = dispatcher.triage(ticket)
    assert verdict.needs_human is True
    assert "sensitive/personal-data" in verdict.rationale
    assert "payroll" in verdict.rationale
    assert dispatcher.dispatch(ticket).gate is Gate.APPROVAL


def test_sensitive_markers_match_whole_words_only() -> None:
    dispatcher = DeterministicDispatcher()
    ticket = _ticket(key="SUP-901", project="SUP", summary="Salaryman costume for a customer")
    verdict = dispatcher.triage(ticket)
    assert verdict.needs_human is False
    assert "Sensitive-ticket policy clause" not in verdict.rationale


def test_dispatcher_triage_reads_the_policy_numbers() -> None:
    ticket = _ticket(summary="Customer question")
    strict = DeterministicDispatcher()
    assert strict.triage(ticket).needs_human is True
    lenient = DeterministicDispatcher(_risk_with_triage(human_review_below=0.5))
    assert lenient.triage(ticket).needs_human is False
    capped = DeterministicDispatcher(_risk_with_triage(confidence_cap=0.6))
    assert capped.triage(ticket).confidence == pytest.approx(0.6)


def test_dispatcher_preflight_reads_the_policy_gates() -> None:
    base = default_risk_policy()
    lax = replace(base, preflight=replace(base.preflight, refuse_at=100, approval_at=95))
    assert DeterministicDispatcher(lax).preflight("delete production cluster").gate is Gate.AUTO
    assert DeterministicDispatcher().preflight("delete production cluster").gate is Gate.REFUSE
    assert DeterministicDispatcher().preflight("delete the branch").gate is Gate.APPROVAL
    assert DeterministicDispatcher().preflight("jira_comment").gate is Gate.AUTO


def test_domain_floors_raise_but_never_lower_a_gate() -> None:
    dispatcher = DeterministicDispatcher()
    approval_at = default_risk_policy().preflight.approval_at
    floored = dispatcher.preflight("refund the customer", domain=Domain.SUPPORT)
    assert floored.gate is Gate.APPROVAL
    assert floored.score >= approval_at
    assert any("support lane policy floors" in reason for reason in floored.reasons)
    refused = dispatcher.preflight("refund and delete production data", domain=Domain.SUPPORT)
    assert refused.gate is Gate.REFUSE
    assert dispatcher.preflight("refund the customer").gate is Gate.AUTO


def test_audit_redaction_cites_frozen_clauses() -> None:
    report = audit_redaction(
        {
            "token": "sk-abc123456",
            "note": "reach jane@example.io, card 4111 1111 1111 1111",
        },
        path="payload",
    )
    clauses = {entry.clause for entry in report.entries}
    assert clauses == {CLAUSE_SECRET_KEY, CLAUSE_EMAIL, CLAUSE_ACCOUNT}
    assert clauses <= REDACTION_CLAUSES
    assert CLAUSE_SECRET_VALUE in REDACTION_CLAUSES
    paths = {entry.path for entry in report.entries}
    assert paths == {"payload.token", "payload.note"}
    value = report.value
    assert isinstance(value, dict)
    assert value["token"] == "[REDACTED]"
    assert "[REDACTED_EMAIL]" in str(value["note"])
    assert "[REDACTED_ACCOUNT]" in str(value["note"])
