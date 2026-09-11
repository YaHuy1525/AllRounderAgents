"""One-off probe: MCP search path with a watchdog (run from repo root)."""

import os
import sys
import threading
import time


def watchdog() -> None:
    time.sleep(75)
    print("MCP probe watchdog: no result in 75s, aborting", flush=True)
    os._exit(3)


threading.Thread(target=watchdog, daemon=True).start()

from allrounder_api.jira_mcp import McpJiraTransport  # noqa: E402
from allrounder_api.settings import Settings  # noqa: E402

settings = Settings()
token = settings.jira_api_token.get_secret_value()
print("mcp url:", settings.atlassian_mcp_url, flush=True)
print("token tail:", token[-8:], flush=True)

mcp = McpJiraTransport(
    settings.jira_base_url,
    settings.jira_email,
    token,
    mcp_url=settings.atlassian_mcp_url,
    cloud_id=settings.jira_cloud_id,
)
try:
    issues = mcp.search_issues(settings.jira_project_key, 5)
    print("MCP search_issues:", len(issues), [getattr(i, "key", None) for i in issues], flush=True)
except Exception as error:  # noqa: BLE001
    print("MCP search FAILED:", type(error).__name__, str(error)[:400], flush=True)
finally:
    try:
        mcp.close()
    except Exception as close_error:  # noqa: BLE001
        print("mcp close warning:", close_error, flush=True)

sys.exit(0)
