"""Built-in workflow definitions.

Each entry names its Mastra counterpart (``mastra_workflow``) and the exact,
ordered step ids the flow must emit — the run service snapshots this list
when a run starts, so the stepper, decisions, and receipts all line up.
Later PRs append their workflows here.
"""

from __future__ import annotations

from .models import StepDefinition, WorkflowDefinition

REVIEW_WORKFLOW = WorkflowDefinition(
    id="review",
    mastra_workflow="reviewFlow",
    title="PR Review",
    steps=(
        StepDefinition(id="select-pr", title="Select PR"),
        StepDefinition(id="review-options", title="Review Options"),
        StepDefinition(id="ai-review", title="AI Review"),
        StepDefinition(id="complete", title="Complete", side_effecting=True),
    ),
)

ISSUES_WORKFLOW = WorkflowDefinition(
    id="issues",
    mastra_workflow="issuesFlow",
    title="Issue Resolution",
    steps=(
        StepDefinition(id="issue-selection", title="Issue Selection"),
        StepDefinition(id="analysis", title="Analysis"),
        StepDefinition(id="implementation", title="Implementation"),
        StepDefinition(id="complete", title="Complete", side_effecting=True),
    ),
)

FEATURES_WORKFLOW = WorkflowDefinition(
    id="features",
    mastra_workflow="featuresFlow",
    title="Feature Implementation",
    steps=(
        StepDefinition(id="feature-selection", title="Feature Selection"),
        StepDefinition(id="scope-design", title="Scope & Design"),
        StepDefinition(id="implementation", title="Implementation"),
        StepDefinition(id="complete", title="Complete", side_effecting=True),
    ),
)

DEPENDENCIES_WORKFLOW = WorkflowDefinition(
    id="dependencies",
    mastra_workflow="dependenciesFlow",
    title="Dependency Update",
    steps=(
        StepDefinition(id="scan", title="Scan"),
        StepDefinition(id="group", title="Group"),
        StepDefinition(id="apply", title="Apply"),
        StepDefinition(id="validate", title="Validate"),
        StepDefinition(id="merge", title="Merge", side_effecting=True),
    ),
)

ACCESSIBILITY_WORKFLOW = WorkflowDefinition(
    id="accessibility",
    mastra_workflow="accessibilityFlow",
    title="Accessibility Audit",
    steps=(
        StepDefinition(id="crawl", title="Crawl"),
        StepDefinition(id="violations", title="Violations"),
        StepDefinition(id="fix", title="Fix"),
        # Opening the fix PR is the side effect once the re-scan gate passes.
        StepDefinition(id="re-scan", title="Re-scan", side_effecting=True),
    ),
)

VENDORS_WORKFLOW = WorkflowDefinition(
    id="vendors",
    mastra_workflow="vendorsFlow",
    title="Vendor Onboarding",
    steps=(
        StepDefinition(id="collect", title="Collect"),
        StepDefinition(id="verify", title="Verify"),
        StepDefinition(id="risk-score", title="Risk Score"),
        StepDefinition(id="approve", title="Approve"),
        # Creating the vendor master record is the side effect (idempotent by
        # tax-ID key).
        StepDefinition(id="create", title="Create", side_effecting=True),
    ),
)

LEAVE_WORKFLOW = WorkflowDefinition(
    id="leave",
    mastra_workflow="leaveFlow",
    title="Leave Request",
    steps=(
        StepDefinition(id="intake", title="Intake"),
        StepDefinition(id="policy-check", title="Policy Check"),
        StepDefinition(id="approve", title="Approve"),
        # Booking the leave entry is the side effect (idempotent by request id).
        StepDefinition(id="apply", title="Apply", side_effecting=True),
    ),
)

ONBOARDING_WORKFLOW = WorkflowDefinition(
    id="onboarding",
    mastra_workflow="onboardingFlow",
    title="New-Hire Onboarding",
    steps=(
        StepDefinition(id="collect", title="Collect"),
        StepDefinition(id="verify", title="Verify"),
        StepDefinition(id="risk-score", title="Risk Score"),
        StepDefinition(id="approve", title="Approve"),
        # Provisioning accounts, the equipment ticket and payroll enrollment is
        # the side effect (idempotent by employee id).
        StepDefinition(id="provision", title="Provision", side_effecting=True),
    ),
)

OFFBOARDING_WORKFLOW = WorkflowDefinition(
    id="offboarding",
    mastra_workflow="offboardingFlow",
    title="Employee Offboarding",
    steps=(
        StepDefinition(id="intake", title="Intake"),
        StepDefinition(id="access-audit", title="Access Audit"),
        StepDefinition(id="approve", title="Approve"),
        # Revoking per-system access is the first side effect (idempotent by
        # employee + system).
        StepDefinition(id="revoke", title="Revoke", side_effecting=True),
        # Closing the case with the final-pay attestation is the second side
        # effect (idempotent by employee id).
        StepDefinition(id="attest", title="Attest", side_effecting=True),
    ),
)

SCREENING_WORKFLOW = WorkflowDefinition(
    id="screening",
    mastra_workflow="screeningFlow",
    title="Candidate Screening",
    steps=(
        StepDefinition(id="requisition", title="Requisition"),
        StepDefinition(id="screen", title="Screen"),
        StepDefinition(id="shortlist", title="Shortlist"),
        # Scheduling the interview invites is the side effect (idempotent by
        # candidate + requisition).
        StepDefinition(id="schedule", title="Schedule", side_effecting=True),
    ),
)

HR_HELP_WORKFLOW = WorkflowDefinition(
    id="hr-help",
    mastra_workflow="hrHelpFlow",
    title="HR Help",
    steps=(
        StepDefinition(id="intake", title="Intake"),
        StepDefinition(id="retrieve", title="Retrieve"),
        StepDefinition(id="draft", title="Draft"),
        StepDefinition(id="approve", title="Approve"),
        # Recording the answer is the side effect (idempotent by case + ticket).
        StepDefinition(id="send", title="Send", side_effecting=True),
    ),
)

SECURITY_WORKFLOW = WorkflowDefinition(
    id="security",
    mastra_workflow="securityFlow",
    title="SOC Alert Triage",
    steps=(
        StepDefinition(id="ingest", title="Ingest"),
        StepDefinition(id="triage", title="Triage"),
        StepDefinition(id="investigate", title="Investigate"),
        StepDefinition(id="decide", title="Decide"),
        StepDefinition(id="approve", title="Approve"),
        # Executing the approved disposition (containment or close) is the
        # side effect (idempotent by alert + host).
        StepDefinition(id="contain", title="Contain", side_effecting=True),
    ),
)


def side_effect_scope(workflow: str, step_id: str) -> str:
    """The ``workflow:step`` permission scope a side-effecting step acts under.

    Single source for the run lane's side-effect permission: policy/tools.yaml
    declares the ``{workflow}:{step}`` template for ``run.side-effect`` and the
    governance suite cross-checks every ``side_effecting`` step against it.
    """

    return f"{workflow}:{step_id}"


WORKFLOW_DEFINITIONS: dict[str, WorkflowDefinition] = {
    definition.id: definition
    for definition in (
        REVIEW_WORKFLOW,
        ISSUES_WORKFLOW,
        FEATURES_WORKFLOW,
        DEPENDENCIES_WORKFLOW,
        ACCESSIBILITY_WORKFLOW,
        VENDORS_WORKFLOW,
        LEAVE_WORKFLOW,
        ONBOARDING_WORKFLOW,
        OFFBOARDING_WORKFLOW,
        SCREENING_WORKFLOW,
        HR_HELP_WORKFLOW,
        SECURITY_WORKFLOW,
    )
}


__all__ = [
    "ACCESSIBILITY_WORKFLOW",
    "DEPENDENCIES_WORKFLOW",
    "FEATURES_WORKFLOW",
    "HR_HELP_WORKFLOW",
    "ISSUES_WORKFLOW",
    "LEAVE_WORKFLOW",
    "OFFBOARDING_WORKFLOW",
    "ONBOARDING_WORKFLOW",
    "REVIEW_WORKFLOW",
    "SCREENING_WORKFLOW",
    "SECURITY_WORKFLOW",
    "VENDORS_WORKFLOW",
    "WORKFLOW_DEFINITIONS",
    "side_effect_scope",
]
