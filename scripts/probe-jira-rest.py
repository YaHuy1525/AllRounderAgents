"""One-off probe: REST path only (fast, unbuffered prints)."""

import sys

from allrounder_api.jira import HttpJiraTransport
from allrounder_api.settings import Settings

settings = Settings()
token = settings.jira_api_token.get_secret_value()
print("transport setting:", settings.jira_transport, flush=True)
print("token tail:", token[-8:], flush=True)

rest = HttpJiraTransport(settings.jira_base_url, settings.jira_email, token)
try:
    boards = rest.list_boards(settings.jira_project_key)
    summary = [(getattr(b, "id", None), getattr(b, "name", None)) for b in boards][:5]
    print("REST list_boards:", summary, flush=True)
except Exception as error:  # noqa: BLE001
    print("REST list_boards FAILED:", type(error).__name__, error, flush=True)
try:
    issues = rest.search_issues(settings.jira_project_key, 5)
    print("REST search_issues:", len(issues), [getattr(i, "key", None) for i in issues], flush=True)
except Exception as error:  # noqa: BLE001
    print("REST search_issues FAILED:", type(error).__name__, error, flush=True)
sys.exit(0)
