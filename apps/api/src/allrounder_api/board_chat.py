from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Protocol

from .jira import JIRA_TICKET_KEY_PATTERN

_TICKET_MENTION = re.compile(r"\b[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,9}\b")

APP_GUIDE = "\n".join(
    [
        "AllRounderAgent is a Jira console for the signed-in tenant.",
        "- The board lists Jira tickets for the allowlisted project.",
        "- Click a card to open a detail window.",
        "- Sign in with work email and password. Do not send magic-link emails when rate-limited.",
        "- Settings chooses the Jira site, project, and board stored in this browser.",
        "- Approvals lists human gates. Outbound actions need an HMAC approval receipt.",
        "- Finance recon uses integer cents and posts only to a sandbox after finance:post.",
        "- Never invent tickets that are not in the provided board snapshot.",
    ]
)


class ChatCompleter(Protocol):
    async def complete(self, system: str, user: str) -> str: ...


def sanitize_tickets(raw: object) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    tickets: list[dict[str, str]] = []
    for item in raw[:40]:
        if not isinstance(item, Mapping):
            continue
        key = str(item.get("key", ""))
        if re.fullmatch(JIRA_TICKET_KEY_PATTERN, key) is None:
            continue
        labels = item.get("labels")
        label_text = (
            ", ".join(str(label) for label in labels[:8] if str(label).strip())
            if isinstance(labels, list)
            else ""
        )
        tickets.append(
            {
                "key": key,
                "summary": str(item.get("summary", ""))[:240],
                "status": str(item.get("status", ""))[:80],
                "issue_type": str(item.get("issue_type") or item.get("issueType") or "")[:80],
                "priority": str(item.get("priority", ""))[:40],
                "assignee": str(item.get("assignee") or "Unassigned")[:80],
                "labels": label_text[:200],
            }
        )
    return tickets


def system_prompt(tickets: list[dict[str, str]], selected_key: str | None) -> str:
    selected = (
        f"The user currently has {selected_key} open."
        if selected_key
        else "No ticket is open."
    )
    snapshot = "\n".join(
        (
            f"- {item['key']}: {item['summary']} "
            f"(status {item['status']}, type {item['issue_type']}, "
            f"priority {item['priority']}, assignee {item['assignee']})"
        )
        for item in tickets
    ) or "- none"
    return f"{APP_GUIDE}\n\n{selected}\nBoard snapshot:\n{snapshot}"


def local_answer(
    message: str,
    tickets: list[dict[str, str]],
    selected_key: str | None,
) -> str:
    lowered = message.lower()
    mentioned = _TICKET_MENTION.findall(message.upper())
    keys = mentioned or ([selected_key] if selected_key else [])
    keyed = {item["key"]: item for item in tickets}
    matched = [keyed[key] for key in keys if key in keyed]
    if matched:
        return "\n\n".join(_format_ticket(item) for item in matched)
    if any(term in lowered for term in ("sign in", "password", "login", "magic")):
        return (
            "Sign in with your work email and password. "
            "Do not send another magic-link email if Supabase says the mailer is rate-limited."
        )
    if "approv" in lowered:
        return (
            "Open the Approvals tab for human gates. "
            "Support sends and finance sandbox posts both require a valid approval receipt."
        )
    if any(term in lowered for term in ("finance", "reconcil", "invoice", "ledger")):
        return (
            "The finance lane reconciles integer-cent ledger and bank lines, "
            "builds an audit pack, and posts only to a sandbox journal after "
            "a finance:post receipt."
        )
    summary_terms = ("how many", "count", "status", "board", "ticket", "summary")
    if any(term in lowered for term in summary_terms):
        return _board_summary(tickets)
    return (
        f"{APP_GUIDE.splitlines()[0]} I can see {len(tickets)} tickets on the current board. "
        "Ask about a ticket key, board status, sign-in, approvals, or the finance lane."
    )


def _format_ticket(item: dict[str, str]) -> str:
    return (
        f"{item['key']} — {item['summary']}\n"
        f"Status: {item['status']}\n"
        f"Type: {item['issue_type']}\n"
        f"Priority: {item['priority']}\n"
        f"Assignee: {item['assignee']}\n"
        f"Labels: {item['labels'] or 'None'}"
    )


def _board_summary(tickets: list[dict[str, str]]) -> str:
    if not tickets:
        return "The current board snapshot has no tickets."
    counts: dict[str, int] = {}
    for item in tickets:
        status = item["status"] or "Unknown"
        counts[status] = counts.get(status, 0) + 1
    breakdown = ", ".join(f"{status} {count}" for status, count in sorted(counts.items()))
    keys = ", ".join(item["key"] for item in tickets[:12])
    extra = "" if len(tickets) <= 12 else f", plus {len(tickets) - 12} more"
    return f"There are {len(tickets)} tickets: {breakdown}. Keys: {keys}{extra}."
