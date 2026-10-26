"""Workflow catalog API: static definitions with display-only integrations."""

from __future__ import annotations

from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.runs import WORKFLOW_DEFINITIONS
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

VIEWER = Principal("user-2", "omnidewalt", frozenset({"viewer"}))
ROLELESS = Principal("user-3", "omnidewalt", frozenset())

# Display-only provider vocabulary the console integration registry renders.
# The last two ids are connectable-only (N2): no step declares them, the
# console swaps the connected provider in for the generic channel glyph
# (gmail replaces the email channel on the steps it serves).
PROVIDER_VOCAB = {
    "github",
    "jira",
    "slack",
    "okta",
    "workday",
    "aws",
    "zendesk",
    "email",
    "web",
    "kb",
    "erp",
    "banking",
    "payroll",
    "xero",
    "halopsa",
    "gmail",
    "calendar",
}

# The seeded satellites, pinned exactly: loosening or adding seeds must be a
# deliberate edit here (and in the frontend registry) rather than silent drift.
EXPECTED_INTEGRATIONS = {
    ("review", "complete"): ("github",),
    ("issues", "complete"): ("github",),
    ("features", "complete"): ("github",),
    ("dependencies", "merge"): ("github",),
    ("accessibility", "re-scan"): ("github",),
    ("vendors", "verify"): ("web",),
    ("vendors", "create"): ("erp",),
    ("leave", "apply"): ("workday",),
    ("onboarding", "provision"): ("okta", "github", "aws", "jira", "slack", "workday"),
    ("offboarding", "revoke"): ("okta", "slack", "banking", "erp", "payroll"),
    ("screening", "schedule"): ("email",),
    ("hr-help", "retrieve"): ("kb",),
    ("hr-help", "send"): ("email",),
    ("security", "contain"): ("aws",),
    ("msp", "intake"): ("email",),
    ("msp", "ticket"): ("jira", "halopsa"),
    ("msp", "draft"): ("kb",),
    ("msp", "send"): ("email", "jira", "halopsa"),
    ("bills", "intake"): ("email",),
    ("bills", "post"): ("xero",),
    ("qa", "execute"): ("web",),
    ("qa", "file-defects"): ("jira",),
}


def _api() -> TestClient:
    app = create_app(
        settings=Settings(webhook_secret="test"),
        auth_verifier=FakeBearerVerifier({"tok": VIEWER, "roleless": ROLELESS}),
    )
    return TestClient(app)


def test_workflows_requires_auth_and_a_view_role() -> None:
    http = _api()
    assert http.get("/workflows").status_code == 401
    forbidden = http.get("/workflows", headers={"Authorization": "Bearer roleless"})
    assert forbidden.status_code == 403


def test_workflows_catalog_matches_the_run_definitions() -> None:
    http = _api()
    payload = http.get("/workflows", headers={"Authorization": "Bearer tok"}).json()
    catalog = payload["workflows"]
    assert [item["id"] for item in catalog] == list(WORKFLOW_DEFINITIONS)
    for item in catalog:
        definition = WORKFLOW_DEFINITIONS[item["id"]]
        assert item["title"] == definition.title
        assert item["mastraWorkflow"] == definition.mastra_workflow
        assert [step["id"] for step in item["steps"]] == [
            step.id for step in definition.steps
        ]
        for served, expected in zip(item["steps"], definition.steps, strict=True):
            assert set(served) == {"id", "title", "sideEffecting", "integrations"}
            assert served["title"] == expected.title
            assert served["sideEffecting"] is expected.side_effecting
            assert served["integrations"] == list(expected.integrations)


def test_integration_seeds_are_exact_and_within_vocabulary() -> None:
    http = _api()
    payload = http.get("/workflows", headers={"Authorization": "Bearer tok"}).json()
    seeded: dict[tuple[str, str], tuple[str, ...]] = {}
    for item in payload["workflows"]:
        for step in item["steps"]:
            providers = tuple(step["integrations"])
            for provider in providers:
                assert provider in PROVIDER_VOCAB, provider
            if providers:
                seeded[(item["id"], step["id"])] = providers
    assert seeded == EXPECTED_INTEGRATIONS


def test_connectable_providers_are_renderable() -> None:
    """The N2 connector catalog is a display subset: every connectable
    provider must be in the console's renderable vocabulary."""

    from allrounder_api.policy import default_tool_matrix

    catalog = {connector.provider for connector in default_tool_matrix().connectors}
    assert catalog <= PROVIDER_VOCAB, sorted(catalog - PROVIDER_VOCAB)
