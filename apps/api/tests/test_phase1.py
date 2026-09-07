from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from allrounder_api.approvals import ApprovalReceiptSigner, ReceiptError
from allrounder_api.auth import (
    AuthenticationError,
    FakeBearerVerifier,
    Principal,
    SupabaseJWKSVerifier,
)
from allrounder_api.knowledge import (
    DeterministicEmbeddingProvider,
    EmptyRetrievalError,
    InMemoryKnowledgeStore,
    KnowledgeDocument,
    OpenAICompatibleAdapter,
    chunk_text,
)
from allrounder_api.repositories import (
    ApprovalRecord,
    CaseRecord,
    InMemoryApprovalRepository,
    InMemoryCaseRepository,
    InMemorySupportSendRepository,
)
from allrounder_api.support import SupportService
from fastapi.testclient import TestClient

NOW = datetime(2026, 9, 7, tzinfo=UTC)


@pytest.mark.asyncio
async def test_chunk_ingest_retrieve_scopes_and_escalates_empty() -> None:
    store = InMemoryKnowledgeStore(DeterministicEmbeddingProvider("fake-embed-v1", 8))
    await store.ingest(
        KnowledgeDocument(
            source_id="doc-1",
            tenant_id="tenant-a",
            domain="support",
            title="Refunds",
            content="Refunds take five business days. Contact support if delayed.",
            source_version="2026-09",
            stale_after=NOW + timedelta(days=30),
        ),
        chunk_size=35,
        overlap=5,
    )
    result = await store.retrieve("tenant-a", "support", "refund five days", 3, now=NOW)
    assert result.passages
    assert result.passages[0].citation.source_id == "doc-1"
    assert result.passages[0].citation.start >= 0
    assert result.embedding_model == "fake-embed-v1"
    with pytest.raises(EmptyRetrievalError):
        await store.retrieve("tenant-b", "support", "refund", 3, now=NOW)
    with pytest.raises(ValueError):
        chunk_text("text", 2, 2)
    with pytest.raises(ValueError):
        await store.retrieve("tenant-a", "support", "refund", 0)


@pytest.mark.asyncio
async def test_memory_retrieval_never_mixes_embedding_models() -> None:
    embeddings = DeterministicEmbeddingProvider("embed-v1", 8)
    store = InMemoryKnowledgeStore(embeddings)
    await store.ingest(
        KnowledgeDocument(
            source_id="doc-1",
            tenant_id="tenant-a",
            domain="support",
            title="Account help",
            content="Reset your password from account settings.",
            source_version="1",
            stale_after=NOW + timedelta(days=1),
        )
    )
    embeddings.model = "embed-v2"
    with pytest.raises(EmptyRetrievalError):
        await store.retrieve("tenant-a", "support", "password", 3, now=NOW)


@pytest.mark.asyncio
async def test_openai_compatible_adapter_without_live_calls() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/embeddings"):
            return httpx.Response(200, json={"data": [{"embedding": [1.0, 0.0]}]})
        return httpx.Response(
            200, json={"choices": [{"message": {"content": "cited draft"}}]}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        adapter = OpenAICompatibleAdapter(
            base_url="https://models.example/v1", api_key="fake",
            embedding_model="embed-v1", dimensions=2, chat_model="chat-v1", client=client,
        )
        assert await adapter.embed(["hello"]) == [[1.0, 0.0]]
        assert await adapter.complete("ground claims", "question") == "cited draft"


def test_receipts_bind_action_and_expire() -> None:
    with pytest.raises(ValueError):
        ApprovalReceiptSigner(b"short")
    signer = ApprovalReceiptSigner(b"x" * 32, clock=lambda: NOW)
    token = signer.issue(
        approval_id="approval-1",
        case_id="case-1",
        action={"draft": "exact"},
        approver="human@example.com",
        scope="support:send",
        decision="approved",
        expires_at=NOW + timedelta(minutes=5),
    )
    claims = signer.validate(
        token, approval_id="approval-1", case_id="case-1",
        action={"draft": "exact"}, scope="support:send", now=NOW,
    )
    assert claims.approver == "human@example.com"
    with pytest.raises(ReceiptError):
        signer.validate(
            token, approval_id="approval-1", case_id="case-1",
            action={"draft": "changed"}, scope="support:send", now=NOW,
        )
    with pytest.raises(ReceiptError):
        signer.validate(
            token, approval_id="approval-1", case_id="case-1",
            action={"draft": "exact"}, scope="support:send", now=NOW + timedelta(hours=1),
        )
    with pytest.raises(ReceiptError):
        signer.issue(
            approval_id="a", case_id="c", action={}, approver="u", scope="support:send",
            decision="rejected", expires_at=NOW + timedelta(minutes=1),
        )
    with pytest.raises(ReceiptError):
        signer.validate(
            token + "tampered", approval_id="approval-1", case_id="case-1",
            action={"draft": "exact"}, scope="support:send", now=NOW,
        )


@pytest.mark.asyncio
async def test_fake_and_supabase_auth_use_trusted_claims(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeBearerVerifier({})
    with pytest.raises(AuthenticationError):
        await fake.verify("bad")
    with pytest.raises(ValueError):
        SupabaseJWKSVerifier(jwks_url="", issuer="", audience="")

    verifier = SupabaseJWKSVerifier(
        jwks_url="https://auth.example/jwks", issuer="https://auth.example", audience="users"
    )
    monkeypatch.setattr(
        verifier._jwks, "get_signing_key_from_jwt", lambda _token: type("Key", (), {"key": "k"})()
    )
    monkeypatch.setattr(
        "allrounder_api.auth.jwt.decode",
        lambda *_args, **_kwargs: {
            "sub": "user", "app_metadata": {"tenant_id": "tenant-a", "roles": ["approver", 1]}
        },
    )
    assert (await verifier.verify("jwt")).roles == frozenset({"approver"})


@pytest.mark.asyncio
async def test_case_redaction_rollup_and_send_idempotency() -> None:
    cases = InMemoryCaseRepository()
    case = CaseRecord(
        id="case-1", tenant_id="tenant-a", ticket_key="SUP-1", domain="support",
        status="open",
    )
    await cases.create(case)
    await cases.append_event(
        "case-1", actor="agent", kind="model",
        payload={"email": "person@example.com", "api_key": "sk-secret", "costUsdMicro": 7},
    )
    await cases.append_event(
        "case-1", actor="agent", kind="tool",
        payload={"tool": "retrieve", "costUsdMicro": 5},
    )
    stored = await cases.get("case-1", "tenant-a")
    assert stored.cost_usd_micro == 12
    assert "person@example.com" not in str(stored.events)
    assert "sk-secret" not in str(stored.events)

    sends = InMemorySupportSendRepository()
    first = await sends.send_once("key-1", "case-1", "SUP-1", "hello")
    second = await sends.send_once("key-1", "case-1", "SUP-1", "hello")
    assert first == second
    assert len(sends.sent) == 1
    await sends.consume_receipt("r1", "a1", "case-1", "hash")
    with pytest.raises(ValueError):
        await sends.consume_receipt("r1", "a1", "case-1", "hash")
    with pytest.raises(KeyError):
        await cases.get("missing", "tenant-a")
    with pytest.raises(KeyError):
        await cases.get_by_ticket("SUP-404", "tenant-a")
    with pytest.raises(ValueError):
        await cases.append_event(
            "case-1", actor="agent", kind="bad", payload={"costUsdMicro": -1}
        )


@pytest.mark.asyncio
async def test_approval_repository_rejects_expired_and_duplicate_decisions() -> None:
    repository = InMemoryApprovalRepository(clock=lambda: NOW)
    pending = ApprovalRecord(
        id="a1", case_id="c1", tenant_id="tenant-a", action={"draft": "safe"},
        evidence=[{"sourceId": "doc", "span": "0-1"}], approver="user",
        scope="support:send", expires_at=NOW + timedelta(minutes=1),
    )
    await repository.create(pending)
    assert len(await repository.list("tenant-a")) == 1
    rejected = await repository.decide(
        "a1", "tenant-a", "rejected", "contains a@b.com"
    )
    assert rejected.decision == "rejected"
    with pytest.raises(ValueError):
        await repository.decide("a1", "tenant-a", "approved", None)
    with pytest.raises(KeyError):
        await repository.get("a1", "tenant-b")
    expired = ApprovalRecord(
        id="a2", case_id="c1", tenant_id="tenant-a", action={},
        evidence=[], approver="user", scope="support:send",
        expires_at=NOW - timedelta(seconds=1),
    )
    await repository.create(expired)
    assert (await repository.get("a2", "tenant-a")).decision == "expired"


def test_approval_api_roles_decisions_and_no_send_without_receipt() -> None:
    from allrounder_api.app import create_app
    from allrounder_api.settings import Settings

    verifier = FakeBearerVerifier(
        {
            "approver-token": Principal(
                subject="user-1", tenant_id="tenant-a", roles=frozenset({"approver"})
            ),
            "viewer-token": Principal(
                subject="user-2", tenant_id="tenant-a", roles=frozenset({"viewer"})
            ),
        }
    )
    approvals = InMemoryApprovalRepository(clock=lambda: NOW)
    cases = InMemoryCaseRepository()
    sends = InMemorySupportSendRepository()
    signer = ApprovalReceiptSigner(b"y" * 32, clock=lambda: NOW)
    app = create_app(
        settings=Settings(webhook_secret="test", cors_allow_origins=["https://ui.example"]),
        auth_verifier=verifier,
        approval_repository=approvals,
        case_repository=cases,
        send_repository=sends,
        receipt_signer=signer,
    )
    client = TestClient(app)
    headers = {"Authorization": "Bearer approver-token"}
    asyncio.run(cases.create(CaseRecord(
        id="case-1", tenant_id="tenant-a", ticket_key="SUP-1", domain="support", status="open"
    )))
    assert client.get("/approvals").status_code == 401
    created = client.post(
        "/approvals",
        headers=headers,
        json={
            "caseId": "case-1", "tenantId": "tenant-a",
            "action": {"draft": "Cited answer [doc-1:0-12]"},
            "evidence": [{"sourceId": "doc-1", "span": "0-12"}],
            "approver": "user-1", "scope": "support:send",
            "expiresAt": (NOW + timedelta(minutes=10)).isoformat(),
        },
    )
    assert created.status_code == 201, created.text
    approval_id = created.json()["id"]
    assert client.get(f"/approvals/{approval_id}", headers=headers).status_code == 200
    assert len(client.get("/approvals", headers=headers).json()) == 1
    assert client.get(
        "/approvals", headers={"Authorization": "Bearer viewer-token"}
    ).status_code == 403
    decision = client.post(
        f"/approvals/{approval_id}/decision", headers=headers,
        json={"decision": "approved", "comment": "ok"},
    )
    assert decision.status_code == 200
    receipt = decision.json()["receipt"]
    sent = client.post(
        "/support/send", headers=headers,
        json={
            "approvalId": approval_id, "caseId": "case-1",
            "ticketKey": "SUP-1",
            "action": {"draft": "Cited answer [doc-1:0-12]"},
            "receipt": receipt,
        },
    )
    assert sent.status_code == 200
    replay = client.post(
        "/support/send", headers=headers,
        json={
            "approvalId": approval_id, "caseId": "case-1", "ticketKey": "SUP-1",
            "action": {"draft": "Cited answer [doc-1:0-12]"}, "receipt": receipt,
        },
    )
    assert replay.status_code == 403
    assert client.post(
        "/support/send", headers=headers,
        json={
            "approvalId": approval_id, "caseId": "case-1", "ticketKey": "SUP-1",
            "action": {"draft": "Cited answer [doc-1:0-12]"}, "receipt": "invalid",
        },
    ).status_code == 403
    assert client.get("/cases/case-1", headers=headers).status_code == 200
    assert client.get("/tickets/SUP-1/status", headers=headers).status_code == 200
    assert client.post(
        "/support/drafts/start", headers=headers,
        json={
            "caseId": "case-1", "tenantId": "tenant-a", "ticketKey": "SUP-1",
            "draft": "Answer [doc-1:0-12]",
            "citations": [{"sourceId": "doc-1", "span": "0-12"}],
        },
    ).json()["status"] == "ready_for_approval"
    assert client.post(
        "/support/drafts/start", headers=headers,
        json={
            "caseId": "case-1", "tenantId": "tenant-a", "ticketKey": "SUP-1",
            "draft": "Unsupported", "citations": [],
        },
    ).json()["status"] == "escalated"


@pytest.mark.asyncio
async def test_support_service_requires_citations_and_escalates_empty() -> None:
    service = SupportService()
    assert service.validate_draft("claim", []).escalate is True
    assert service.validate_draft("claim [doc:0-5]", [{"sourceId": "doc", "span": "0-5"}]).valid
