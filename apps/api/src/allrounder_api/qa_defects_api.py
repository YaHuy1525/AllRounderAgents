"""The one governed write the QA squad may make: filing a defect.

The agent plane does not get a second Jira client. It posts here, and this
route wraps ``JiraTools.create_ticket``, which already owns receipts, the
MCP-to-REST degradation and the replay rule. Two transports would mean two
idempotency records for one defect (decision D2 in the QA squad plan).

Idempotency is ``"{storyKey}:{caseId}"`` — one defect per case per story:

* first failure: create the ticket, and remember its key in this process;
* repeat failure: comment the new evidence on the remembered ticket;
* a create the shared idempotency store has already claimed: answer
  ``replayed`` with no second ticket, which is what survives the restart the
  in-process ledger does not;
* a case that now passes: comment that it passes, or answer ``skipped`` when
  the correlation has no defect at all.

That is what stops a nightly suite from producing a ticket avalanche, and it
is why the route answers 200 with an ``action`` even when the write failed: a
governed write reports what happened, and the caller keeps the finding visible
instead of losing it to an exception.
"""

from __future__ import annotations

import asyncio
import re
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import Field

from .agent_tools_api import authorize_service_token
from .context import RequestContext
from .jira import JIRA_PROJECT_KEY_PATTERN, JIRA_TICKET_KEY_PATTERN, JiraTools
from .logging import get_logger
from .runs.api import ApiModel

# A case id is the console's vocabulary (`QA-RAIL-003`), so an id that does not
# look like one is a caller bug rather than a new naming scheme.
QA_CASE_ID_PATTERN = r"^QA-[A-Z][A-Z0-9]*-\d{3}$"

# The label every filed defect carries, so a board filter can find them.
QA_DEFECT_LABEL = "qa-defect"


class AgentQaDefectAsk(ApiModel):
    """One case's outcome, as the executor reported it.

    ``correlationId`` is accepted only to be checked: the route derives the key
    from the story and the case, so a client cannot split one defect across two
    correlations by sending a different string.
    """

    story_key: str = Field(pattern=JIRA_TICKET_KEY_PATTERN)
    case_id: str = Field(pattern=QA_CASE_ID_PATTERN)
    correlation_id: str = Field(min_length=3, max_length=200)
    target_key: str = Field(min_length=1, max_length=60)
    run_id: str = Field(min_length=1, max_length=200)
    status: Literal["failed", "passed"]
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=4_000)
    severity: Literal["high", "medium", "low"]
    evidence_refs: list[str] = Field(default_factory=list, max_length=20)


def build_qa_defects_router(*, service_token: str, jira: JiraTools) -> APIRouter:
    router = APIRouter(prefix="/agent-tools/qa", tags=["agent-tools"])
    logger = get_logger()
    # correlation id -> the ticket it was filed as. In-process on purpose: the
    # durable half of the guarantee is the shared idempotency store behind
    # create_ticket, which answers `replayed` after a restart.
    filed: dict[str, str] = {}

    def answer(
        payload: AgentQaDefectAsk,
        correlation_id: str,
        action: str,
        ticket_key: str,
        detail: str,
    ) -> dict[str, object]:
        return {
            "ok": True,
            "action": action,
            "ticketKey": ticket_key,
            "status": detail,
            "caseId": payload.case_id,
            "correlationId": correlation_id,
        }

    @router.post("/file-defect")
    async def file_defect(
        payload: AgentQaDefectAsk,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """File, comment on, or skip one finding; never throws at Jira's expense."""

        authorize_service_token(authorization, service_token)
        correlation_id = f"{payload.story_key}:{payload.case_id}"
        if payload.correlation_id != correlation_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"correlationId must be {correlation_id}",
            )
        project = payload.story_key.split("-", 1)[0]
        if not project or re.fullmatch(JIRA_PROJECT_KEY_PATTERN, project) is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "storyKey must start with a Jira project key",
            )

        logger.info(
            "agent_tool_qa_file_defect",
            story_key=payload.story_key,
            case_id=payload.case_id,
            run_id=payload.run_id,
            outcome=payload.status,
        )
        context = RequestContext(
            request_id=str(uuid4()),
            correlation_id=correlation_id,
            actor="qa-squad",
        )
        ticket_key = filed.get(correlation_id)

        try:
            if payload.status == "passed":
                if ticket_key is None:
                    # No defect was ever filed for this case, so there is
                    # nothing to resolve and nothing to write.
                    return answer(payload, correlation_id, "skipped", "", "no_defect")
                body = "\n".join(
                    [
                        f"Case {payload.case_id} now passes against story {payload.story_key}.",
                        f"Run: {payload.run_id}",
                        "",
                        payload.body,
                    ]
                )
                receipt = await asyncio.to_thread(
                    jira.comment,
                    context,
                    ticket_key,
                    body,
                    idempotency_key=f"{correlation_id}:{payload.run_id}:passed",
                )
                return answer(payload, correlation_id, "commented", ticket_key, receipt.status)

            body = "\n".join(
                [
                    f"Case {payload.case_id} failed again on run {payload.run_id} "
                    f"against {payload.target_key}.",
                    "",
                    payload.body,
                ]
            )
            if ticket_key is not None:
                receipt = await asyncio.to_thread(
                    jira.comment,
                    context,
                    ticket_key,
                    body,
                    idempotency_key=f"{correlation_id}:{payload.run_id}",
                )
                return answer(payload, correlation_id, "commented", ticket_key, receipt.status)

            receipt = await asyncio.to_thread(
                jira.create_ticket,
                context,
                project=project,
                summary=payload.title,
                issue_type="Bug",
                labels=[QA_DEFECT_LABEL, payload.case_id.lower(), payload.story_key.lower()],
                description=payload.body,
                idempotency_key=correlation_id,
            )
            if receipt.status == "replayed" or receipt.ticket_key == "":
                # The store knows this defect; the ledger does not, because it
                # was filed before this process started. No twin ticket.
                return answer(
                    payload, correlation_id, "replayed", receipt.ticket_key, receipt.status
                )
            filed[correlation_id] = receipt.ticket_key
            return answer(payload, correlation_id, "created", receipt.ticket_key, receipt.status)
        except Exception:  # noqa: BLE001 - a governed write reports, never raises
            logger.exception(
                "agent_tool_qa_file_defect_failed",
                story_key=payload.story_key,
                case_id=payload.case_id,
            )
            return answer(payload, correlation_id, "failed", "", "jira_write_failed")

    return router


__all__ = [
    "QA_CASE_ID_PATTERN",
    "QA_DEFECT_LABEL",
    "AgentQaDefectAsk",
    "build_qa_defects_router",
]
