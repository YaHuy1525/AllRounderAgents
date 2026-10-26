from __future__ import annotations

import asyncio

import httpx
import pytest
from allrounder_api.app import create_app
from allrounder_api.auth import FakeBearerVerifier, Principal
from allrounder_api.repositories import InMemoryGithubAccountRepository
from allrounder_api.settings import Settings
from fastapi.testclient import TestClient

GITHUB_API = "https://api.github.com"
VIEWER = {"Authorization": "Bearer viewer"}
OUTSIDER = {"Authorization": "Bearer outsider"}
AGENT = {"Authorization": "Bearer agent"}
AGENT_B = {"Authorization": "Bearer agent-b"}


def github_payload() -> list[object]:
    return [
        {
            "number": 7,
            "title": "Harden the refund endpoint",
            "draft": False,
            "html_url": "https://github.com/acme/widget/pull/7",
            "user": {"login": "dev"},
            "head": {"ref": "fix/refund"},
            "base": {"ref": "main"},
        },
        {
            "number": 9,
            "title": "Bump lodash",
            "draft": True,
            "html_url": "https://github.com/acme/widget/pull/9",
            "user": {"login": "bot"},
            "head": {"ref": "deps/lodash"},
            "base": {"ref": "main"},
        },
        "junk-row",
    ]


def build_client(
    handler,
    *,
    token: str = "ghp_test",
) -> tuple[TestClient, httpx.AsyncClient, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    def recorded(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    github_client = httpx.AsyncClient(
        base_url=GITHUB_API,
        transport=httpx.MockTransport(recorded),
    )
    verifier = FakeBearerVerifier(
        {
            "viewer": Principal("viewer-1", "tenant-a", frozenset({"viewer"})),
            "outsider": Principal("dev-1", "tenant-a", frozenset({"intern"})),
            "agent": Principal("agent-1", "tenant-a", frozenset({"agent"})),
            "agent-b": Principal("agent-2", "tenant-b", frozenset({"agent"})),
        }
    )
    app = create_app(
        settings=Settings(
            webhook_secret="test",
            github_repository_allowlist=["acme/widget"],
            github_token=token,
        ),
        auth_verifier=verifier,
        github_client=github_client,
        github_accounts=InMemoryGithubAccountRepository(),
    )
    return TestClient(app), github_client, requests


def close(client: httpx.AsyncClient) -> None:
    asyncio.run(client.aclose())


def test_repositories_require_sign_in_and_list_every_accessible_repository() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/user/repos"
        return httpx.Response(
            200,
            json=[
                {"full_name": "acme/other"},
                {"full_name": "acme/widget"},
                "junk-row",
            ],
        )

    client, github_client, requests = build_client(handler)
    try:
        assert client.get("/github/repositories").status_code == 401
        assert client.get("/github/repositories", headers=OUTSIDER).status_code == 403
        listed = client.get("/github/repositories", headers=VIEWER)
        assert listed.status_code == 200, listed.text
        # The allowlist entry is not duplicated when GitHub already returned it.
        assert listed.json() == {"repositories": ["acme/other", "acme/widget"]}
        assert len(requests) == 1
        sent = requests[0]
        assert str(sent.url) == (
            "https://api.github.com/user/repos"
            "?per_page=100&sort=pushed&direction=desc&page=1"
        )
        assert sent.headers["authorization"] == "Bearer ghp_test"
        assert sent.headers["x-github-api-version"] == "2022-11-28"
    finally:
        close(github_client)


def test_repositories_follow_pagination_and_keep_the_allowlist_as_a_floor() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["page"])
        if page == 1:
            return httpx.Response(
                200, json=[{"full_name": f"acme/repo-{index}"} for index in range(100)]
            )
        return httpx.Response(200, json=[{"full_name": "acme/last"}])

    client, github_client, requests = build_client(handler)
    try:
        listed = client.get("/github/repositories", headers=VIEWER)
        assert listed.status_code == 200, listed.text
        repositories = listed.json()["repositories"]
        assert repositories[0] == "acme/repo-0"
        assert repositories[99] == "acme/repo-99"
        assert repositories[100:] == ["acme/last", "acme/widget"]
        assert [int(request.url.params["page"]) for request in requests] == [1, 2]
    finally:
        close(github_client)


def test_repositories_surface_github_failures_and_missing_tokens() -> None:
    client, github_client, _ = build_client(
        lambda request: httpx.Response(500, json={"message": "boom"})
    )
    try:
        failed = client.get("/github/repositories", headers=VIEWER)
        assert failed.status_code == 502
    finally:
        close(github_client)

    no_token, no_token_client, requests = build_client(
        lambda request: httpx.Response(200, json=[]), token=""
    )
    try:
        unavailable = no_token.get("/github/repositories", headers=VIEWER)
        assert unavailable.status_code == 503
        assert not requests
    finally:
        close(no_token_client)


def test_repositories_use_the_selected_account_token() -> None:
    client, github_client, requests = build_client(
        lambda request: httpx.Response(200, json=[])
    )
    try:
        created = client.post(
            "/github/accounts",
            headers=AGENT,
            json={"label": "Work", "token": "ghp_account_token"},
        )
        account_id = created.json()["id"]
        unknown = client.get(
            "/github/repositories", headers=VIEWER, params={"accountId": "nope"}
        )
        assert unknown.status_code == 404
        listed = client.get(
            "/github/repositories", headers=VIEWER, params={"accountId": account_id}
        )
        assert listed.status_code == 200, listed.text
        assert listed.json() == {"repositories": ["acme/widget"]}
        fallback = client.get("/github/repositories", headers=VIEWER)
        assert fallback.status_code == 200
        assert [request.headers["authorization"] for request in requests] == [
            "Bearer ghp_account_token",
            "Bearer ghp_test",
        ]
    finally:
        close(github_client)


def test_pull_requests_gate_on_roles_and_token() -> None:
    client, github_client, requests = build_client(
        lambda request: httpx.Response(200, json=github_payload())
    )
    try:
        assert (
            client.get(
                "/github/repositories/acme/widget/pull-requests", headers=OUTSIDER
            ).status_code
            == 403
        )
        assert not requests
        # Repositories outside the static allowlist flow through: the token
        # scopes the read, so any repository it can see may be inspected.
        outside = client.get(
            "/github/repositories/evil/repo/pull-requests", headers=VIEWER
        )
        assert outside.status_code == 200, outside.text
        assert len(requests) == 1
    finally:
        close(github_client)

    no_token, no_token_client, _ = build_client(
        lambda request: httpx.Response(200, json=[]), token=""
    )
    try:
        unavailable = no_token.get(
            "/github/repositories/acme/widget/pull-requests", headers=VIEWER
        )
        assert unavailable.status_code == 503
    finally:
        close(no_token_client)


def test_pull_requests_maps_the_github_payload() -> None:
    client, github_client, requests = build_client(
        lambda request: httpx.Response(200, json=github_payload())
    )
    try:
        listed = client.get(
            "/github/repositories/acme/widget/pull-requests", headers=VIEWER
        )
        assert listed.status_code == 200, listed.text
        body = listed.json()
        assert body["repository"] == "acme/widget"
        assert body["pullRequests"] == [
            {
                "number": 7,
                "title": "Harden the refund endpoint",
                "headRef": "fix/refund",
                "baseRef": "main",
                "author": "dev",
                "draft": False,
                "url": "https://github.com/acme/widget/pull/7",
            },
            {
                "number": 9,
                "title": "Bump lodash",
                "headRef": "deps/lodash",
                "baseRef": "main",
                "author": "bot",
                "draft": True,
                "url": "https://github.com/acme/widget/pull/9",
            },
        ]
        assert len(requests) == 1
        sent = requests[0]
        assert str(sent.url) == (
            "https://api.github.com/repos/acme/widget/pulls"
            "?state=open&sort=updated&direction=desc&per_page=50"
        )
        assert sent.headers["authorization"] == "Bearer ghp_test"
        assert sent.headers["x-github-api-version"] == "2022-11-28"
    finally:
        close(github_client)


def test_pull_requests_surface_github_failures_as_bad_gateway() -> None:
    client, github_client, _ = build_client(
        lambda request: httpx.Response(500, json={"message": "boom"})
    )
    try:
        failed = client.get(
            "/github/repositories/acme/widget/pull-requests", headers=VIEWER
        )
        assert failed.status_code == 502
    finally:
        close(github_client)


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/github/repositories/acme%20inc/widget/pull-requests", 422),
        ("/github/repositories/acme/widget/extra/pull-requests", 404),
    ],
)
def test_pull_requests_reject_malformed_paths(path: str, expected: int) -> None:
    client, github_client, requests = build_client(
        lambda request: httpx.Response(200, json=[])
    )
    try:
        response = client.get(path, headers=VIEWER)
        assert response.status_code == expected
        assert not requests
    finally:
        close(github_client)


def test_accounts_require_write_role_and_hide_tokens() -> None:
    client, github_client, requests = build_client(
        lambda request: httpx.Response(200, json=[])
    )
    try:
        assert client.get("/github/accounts").status_code == 401
        listed = client.get("/github/accounts", headers=VIEWER)
        assert listed.status_code == 200
        assert listed.json() == {"accounts": []}
        denied = client.post(
            "/github/accounts",
            headers=VIEWER,
            json={"label": "Work", "token": "ghp_secret_value"},
        )
        assert denied.status_code == 403
        created = client.post(
            "/github/accounts",
            headers=AGENT,
            json={
                "label": "  Work  ",
                "username": " octocat ",
                "token": "ghp_secret_value",
            },
        )
        assert created.status_code == 201, created.text
        body = created.json()
        assert body["label"] == "Work"
        assert body["username"] == "octocat"
        assert body["isDefault"] is True
        assert body["tokenHint"] == "\u2026alue"
        assert "ghp_secret_value" not in created.text
        listed = client.get("/github/accounts", headers=VIEWER)
        assert listed.json() == {"accounts": [body]}
        assert "ghp_secret_value" not in listed.text
        assert not requests
    finally:
        close(github_client)


def test_account_labels_are_unique_and_default_rotates() -> None:
    client, github_client, _ = build_client(lambda request: httpx.Response(200, json=[]))
    try:
        first = client.post(
            "/github/accounts",
            headers=AGENT,
            json={"label": "Work", "token": "ghp_one_token"},
        )
        assert first.status_code == 201
        first_id = first.json()["id"]
        duplicate = client.post(
            "/github/accounts",
            headers=AGENT,
            json={"label": "work", "token": "ghp_two_token"},
        )
        assert duplicate.status_code == 409
        second = client.post(
            "/github/accounts",
            headers=AGENT,
            json={"label": "Personal", "token": "ghp_three_token"},
        )
        assert second.status_code == 201
        second_id = second.json()["id"]
        assert second.json()["isDefault"] is False

        def labels(headers: dict[str, str]) -> list[str]:
            listed = client.get("/github/accounts", headers=headers)
            assert listed.status_code == 200
            return [account["label"] for account in listed.json()["accounts"]]

        # The default account always sorts first.
        assert labels(VIEWER) == ["Work", "Personal"]
        switched = client.post(f"/github/accounts/{second_id}/default", headers=AGENT)
        assert switched.status_code == 200
        assert switched.json()["isDefault"] is True
        assert labels(VIEWER) == ["Personal", "Work"]
        removed = client.delete(f"/github/accounts/{second_id}", headers=AGENT)
        assert removed.status_code == 204
        listed = client.get("/github/accounts", headers=VIEWER)
        accounts = {account["id"]: account for account in listed.json()["accounts"]}
        assert accounts[first_id]["isDefault"] is True
    finally:
        close(github_client)


def test_accounts_are_tenant_scoped() -> None:
    client, github_client, _ = build_client(lambda request: httpx.Response(200, json=[]))
    try:
        created = client.post(
            "/github/accounts",
            headers=AGENT,
            json={"label": "Work", "token": "ghp_tenant_token"},
        )
        account_id = created.json()["id"]
        other_list = client.get("/github/accounts", headers=AGENT_B)
        assert other_list.json() == {"accounts": []}
        stolen_default = client.post(
            f"/github/accounts/{account_id}/default", headers=AGENT_B
        )
        assert stolen_default.status_code == 404
        stolen_delete = client.delete(f"/github/accounts/{account_id}", headers=AGENT_B)
        assert stolen_delete.status_code == 404
        assert len(client.get("/github/accounts", headers=VIEWER).json()["accounts"]) == 1
    finally:
        close(github_client)


def test_pull_requests_use_the_selected_account_token() -> None:
    client, github_client, requests = build_client(
        lambda request: httpx.Response(200, json=[])
    )
    try:
        created = client.post(
            "/github/accounts",
            headers=AGENT,
            json={"label": "Work", "token": "ghp_account_token"},
        )
        account_id = created.json()["id"]
        unknown = client.get(
            "/github/repositories/acme/widget/pull-requests",
            headers=VIEWER,
            params={"accountId": "nope"},
        )
        assert unknown.status_code == 404
        listed = client.get(
            "/github/repositories/acme/widget/pull-requests",
            headers=VIEWER,
            params={"accountId": account_id},
        )
        assert listed.status_code == 200, listed.text
        fallback = client.get(
            "/github/repositories/acme/widget/pull-requests", headers=VIEWER
        )
        assert fallback.status_code == 200
        assert [request.headers["authorization"] for request in requests] == [
            "Bearer ghp_account_token",
            "Bearer ghp_test",
        ]
    finally:
        close(github_client)
