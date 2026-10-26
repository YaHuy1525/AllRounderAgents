# ruff: noqa: B008 -- FastAPI dependencies are declared as parameter defaults.

"""Read-only workflow catalog: the static run definitions, served for the UI.

It hands the console the same definitions the service snapshots at run start, so the
graph and the live stepper cannot disagree. ``startFields`` publish what a run needs
before step one, and ``POST /runs`` rejects a start that leaves a required one empty.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, status

from .auth import AuthenticationError, BearerVerifier, Principal
from .runs.definitions import WORKFLOW_DEFINITIONS

_VIEW_ROLES = {"viewer", "approver", "agent", "admin"}


def build_workflows_router(*, verifier: BearerVerifier) -> APIRouter:
    router = APIRouter(prefix="/workflows")

    async def principal(
        authorization: str | None = Header(default=None),
    ) -> Principal:
        if authorization is None or not authorization.startswith("Bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
        try:
            return await verifier.verify(authorization[7:])
        except AuthenticationError as error:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials") from error

    @router.get("")
    async def list_workflows(
        identity: Principal = Depends(principal),
    ) -> dict[str, object]:
        if identity.roles.isdisjoint(_VIEW_ROLES):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized")
        return {
            "workflows": [
                {
                    "id": definition.id,
                    "title": definition.title,
                    "mastraWorkflow": definition.mastra_workflow,
                    "startFields": [
                        {
                            "id": field.id,
                            "label": field.label,
                            "kind": field.kind,
                            "required": field.required,
                            "example": field.example,
                            "help": field.help,
                            "values": list(field.values),
                        }
                        for field in definition.start_fields
                    ],
                    "steps": [
                        {
                            "id": step.id,
                            "title": step.title,
                            "sideEffecting": step.side_effecting,
                            "integrations": list(step.integrations),
                        }
                        for step in definition.steps
                    ],
                }
                for definition in WORKFLOW_DEFINITIONS.values()
            ]
        }

    return router


__all__ = ["build_workflows_router"]
