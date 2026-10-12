"""Jira board API endpoints."""

from fastapi import APIRouter
from .auth import BearerVerifier


def build_jira_board_router(*, verifier: BearerVerifier) -> APIRouter:
    """Build the board router with ranked strips support."""
    router = APIRouter()
    # Existing endpoints...
    return router
