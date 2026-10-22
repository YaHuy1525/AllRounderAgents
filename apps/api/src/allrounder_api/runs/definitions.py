"""Built-in workflow definitions.

Each entry names its Mastra counterpart (``mastra_workflow``) and the exact,
ordered step ids the flow must emit — the run service snapshots this list
when a run starts, so the stepper, decisions, and receipts all line up.
Later PRs append their workflows here.

Step ``integrations`` are display-only provider ids (github, okta, slack,
...): the flow graph renders them as satellites next to each step and they
never influence permissions — ``side_effect_scope`` remains the single
governance source for what a side-effecting step may act on.

Step ``fields`` (U7) are lane-declared custom inputs the console renders on
the step surface — configured here, not in the UI. Their values ride the
normal edit decision, so the receipt gate applies unchanged.

Step ``slots`` name the extra ceiling slots (besides ``run``) a drive pass
that may compute the step must hold — see ``ceilings.SLOT_ORDER``. Only
model-bearing and apply-bearing steps declare them; pure computation steps
keep the empty default and never queue on a second ceiling.

Step ``risk`` declares the approval-gate band (a ``RISK_BANDS`` anchor,
validated at import time). Only four shipped steps take the top band, each
an outbound write a revert cannot undo under ``policy/risk.yaml``'s own term
lists: ``bills.post`` (a ledger posting, corrected by a second document),
``vendors.create`` (an ERP master record plus its contact path),
``onboarding.provision`` (identities and a payroll enrollment created in
external systems) and ``offboarding.revoke`` (access destroyed; re-issuing is
a new grant, not a reversal). Naming is not enough — a step only belongs in
the band if the flow actually performs the irreversible action — so the
dependency step that opens bump PRs for a human to merge and the security
step that executes whichever disposition a human approved (close, escalate or
recommend as often as containment) both fall back to the default rule in
``service._gate_risk`` (55 side-effecting, 10 pure).
"""

from __future__ import annotations

from .ceilings import APPLY_SLOT, MODEL_SLOT
from .models import RISK_IRREVERSIBLE, FieldDefinition, StepDefinition, WorkflowDefinition

REVIEW_WORKFLOW = WorkflowDefinition(
    id="review",
    mastra_workflow="reviewFlow",
    title="PR Review",
    steps=(
        StepDefinition(id="select-pr", title="Select PR"),
        StepDefinition(id="review-options", title="Review Options"),
        StepDefinition(id="ai-review", title="AI Review", slots=(MODEL_SLOT,)),
        StepDefinition(
            id="complete", title="Complete", side_effecting=True, integrations=("github",)
        ),
    ),
)

ISSUES_WORKFLOW = WorkflowDefinition(
    id="issues",
    mastra_workflow="issuesFlow",
    title="Issue Resolution",
    steps=(
        StepDefinition(id="issue-selection", title="Issue Selection"),
        StepDefinition(id="analysis", title="Analysis", slots=(MODEL_SLOT,)),
        StepDefinition(id="implementation", title="Implementation", slots=(MODEL_SLOT,)),
        StepDefinition(
            id="complete", title="Complete", side_effecting=True, integrations=("github",)
        ),
    ),
)

FEATURES_WORKFLOW = WorkflowDefinition(
    id="features",
    mastra_workflow="featuresFlow",
    title="Feature Implementation",
    steps=(
        # The AC drafter runs inside feature-selection when the ticket carries
        # no structured criteria (best-effort, but the pass may call the
        # model), so the pass holds a model slot.
        StepDefinition(id="feature-selection", title="Feature Selection", slots=(MODEL_SLOT,)),
        StepDefinition(id="scope-design", title="Scope & Design", slots=(MODEL_SLOT,)),
        StepDefinition(id="implementation", title="Implementation", slots=(MODEL_SLOT,)),
        StepDefinition(
            id="complete", title="Complete", side_effecting=True, integrations=("github",)
        ),
    ),
)

DEPENDENCIES_WORKFLOW = WorkflowDefinition(
    id="dependencies",
    mastra_workflow="dependenciesFlow",
    title="Dependency Update",
    steps=(
        StepDefinition(id="scan", title="Scan"),
        StepDefinition(id="group", title="Group"),
        # The patch-apply executor: builds the bumped manifest/lockfile files
        # and asks the model to assess the bumps — both ceilings bind here.
        StepDefinition(
            id="apply", title="Apply", slots=(APPLY_SLOT, MODEL_SLOT)
        ),
        # A failing group asks the model for a repair suggestion.
        StepDefinition(id="validate", title="Validate", slots=(MODEL_SLOT,)),
        # Not the top band: this step opens one PR per group on a bump branch
        # and the flow's own PR body says "A human merges this pull request;
        # CI runs on the branch", so the step name overstates it. An open PR a
        # human merges and can close again is revertible, and neither "merge"
        # nor "open PR" is in policy/risk.yaml's irreversible or high-blast
        # term lists, so it keeps the default side-effecting band.
        StepDefinition(
            id="merge",
            title="Merge",
            side_effecting=True,
            integrations=("github",),
        ),
    ),
)

ACCESSIBILITY_WORKFLOW = WorkflowDefinition(
    id="accessibility",
    mastra_workflow="accessibilityFlow",
    title="Accessibility Audit",
    steps=(
        StepDefinition(id="crawl", title="Crawl"),
        StepDefinition(id="violations", title="Violations", slots=(MODEL_SLOT,)),
        StepDefinition(id="fix", title="Fix", slots=(MODEL_SLOT,)),
        # Opening the fix PR is the side effect once the re-scan gate passes.
        StepDefinition(
            id="re-scan",
            title="Re-scan",
            side_effecting=True,
            integrations=("github",),
        ),
    ),
)

VENDORS_WORKFLOW = WorkflowDefinition(
    id="vendors",
    mastra_workflow="vendorsFlow",
    title="Vendor Onboarding",
    steps=(
        # U7: the lane owner declares the extra inputs here — the console
        # renders them on the collect surface with a doc-snap shortcut tied
        # to the canonical extraction keys (abn, expiry).
        StepDefinition(
            id="collect",
            title="Collect",
            fields=(
                FieldDefinition(
                    id="abn",
                    label="Australian Business Number (ABN)",
                    placeholder="11 digits, e.g. 51 824 753 556",
                    help="Snap the tax registration and the ABN fills in with a checksum check.",
                    snap_key="abn",
                    required=True,
                ),
                FieldDefinition(
                    id="certificate_expiry",
                    label="Insurance certificate expiry",
                    kind="date",
                    help="Snap the certificate to flag coverage that is expiring.",
                    snap_key="expiry",
                ),
            ),
        ),
        StepDefinition(id="verify", title="Verify", integrations=("web",), slots=(MODEL_SLOT,)),
        StepDefinition(id="risk-score", title="Risk Score", slots=(MODEL_SLOT,)),
        StepDefinition(id="approve", title="Approve"),
        # Creating the vendor master record is the side effect (idempotent by
        # tax-ID key). An ERP master write a revert cannot undo.
        StepDefinition(
            id="create",
            title="Create",
            side_effecting=True,
            integrations=("erp",),
            risk=RISK_IRREVERSIBLE,
        ),
    ),
)

LEAVE_WORKFLOW = WorkflowDefinition(
    id="leave",
    mastra_workflow="leaveFlow",
    title="Leave Request",
    steps=(
        StepDefinition(id="intake", title="Intake"),
        StepDefinition(id="policy-check", title="Policy Check", slots=(MODEL_SLOT,)),
        StepDefinition(id="approve", title="Approve"),
        # Booking the leave entry is the side effect (idempotent by request id).
        StepDefinition(id="apply", title="Apply", side_effecting=True, integrations=("workday",)),
    ),
)

ONBOARDING_WORKFLOW = WorkflowDefinition(
    id="onboarding",
    mastra_workflow="onboardingFlow",
    title="New-Hire Onboarding",
    steps=(
        # U7: a date field the doc-snap expiry check can fill automatically.
        StepDefinition(
            id="collect",
            title="Collect",
            fields=(
                FieldDefinition(
                    id="right_to_work_expiry",
                    label="Right-to-work document expiry",
                    kind="date",
                    help="Snap the document to flag an expiry inside the onboarding window.",
                    snap_key="expiry",
                ),
            ),
        ),
        StepDefinition(id="verify", title="Verify", slots=(MODEL_SLOT,)),
        StepDefinition(id="risk-score", title="Risk Score", slots=(MODEL_SLOT,)),
        StepDefinition(id="approve", title="Approve"),
        # Provisioning accounts, the equipment ticket and payroll enrollment is
        # the side effect (idempotent by employee id). Six outbound system
        # writes — identities plus a payroll enrollment — that no revert can
        # collectively undo.
        StepDefinition(
            id="provision",
            title="Provision",
            side_effecting=True,
            integrations=("okta", "github", "aws", "jira", "slack", "workday"),
            risk=RISK_IRREVERSIBLE,
        ),
    ),
)

OFFBOARDING_WORKFLOW = WorkflowDefinition(
    id="offboarding",
    mastra_workflow="offboardingFlow",
    title="Employee Offboarding",
    steps=(
        StepDefinition(id="intake", title="Intake"),
        StepDefinition(id="access-audit", title="Access Audit", slots=(MODEL_SLOT,)),
        StepDefinition(id="approve", title="Approve"),
        # Revoking per-system access is the first side effect (idempotent by
        # employee + system). An identity revocation across production
        # systems a revert cannot undo.
        StepDefinition(
            id="revoke",
            title="Revoke",
            side_effecting=True,
            integrations=("okta", "slack", "banking", "erp", "payroll"),
            risk=RISK_IRREVERSIBLE,
        ),
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
        StepDefinition(id="screen", title="Screen", slots=(MODEL_SLOT,)),
        StepDefinition(id="shortlist", title="Shortlist"),
        # Scheduling the interview invites is the side effect (idempotent by
        # candidate + requisition).
        StepDefinition(
            id="schedule", title="Schedule", side_effecting=True, integrations=("email",)
        ),
    ),
)

HR_HELP_WORKFLOW = WorkflowDefinition(
    id="hr-help",
    mastra_workflow="hrHelpFlow",
    title="HR Help",
    steps=(
        StepDefinition(id="intake", title="Intake"),
        StepDefinition(id="retrieve", title="Retrieve", integrations=("kb",)),
        StepDefinition(id="draft", title="Draft", slots=(MODEL_SLOT,)),
        StepDefinition(id="approve", title="Approve"),
        # Recording the answer is the side effect (idempotent by case + ticket).
        StepDefinition(id="send", title="Send", side_effecting=True, integrations=("email",)),
    ),
)

SECURITY_WORKFLOW = WorkflowDefinition(
    id="security",
    mastra_workflow="securityFlow",
    title="SOC Alert Triage",
    steps=(
        StepDefinition(id="ingest", title="Ingest"),
        StepDefinition(id="triage", title="Triage", slots=(MODEL_SLOT,)),
        StepDefinition(id="investigate", title="Investigate", slots=(MODEL_SLOT,)),
        StepDefinition(id="decide", title="Decide", slots=(MODEL_SLOT,)),
        StepDefinition(id="approve", title="Approve"),
        # Executing the approved disposition (containment or close) is the
        # side effect (idempotent by alert + host). The preview the human
        # reviews is model-written, so this pass is model-bearing too.
        # Not the top band: the disposition it executes is chosen by the human
        # and close/escalate/recommend are dispositions too, while genuinely
        # high-blast targets are refused before any approval is raised. A
        # static 90 would rank a routine alert close above a ledger posting,
        # so this step keeps the default side-effecting band.
        StepDefinition(
            id="contain", title="Contain", side_effecting=True, integrations=("aws",),
            slots=(MODEL_SLOT,),
        ),
    ),
)

MSP_WORKFLOW = WorkflowDefinition(
    id="msp",
    mastra_workflow="mspFlow",
    title="MSP Client Reply",
    steps=(
        StepDefinition(id="intake", title="Intake", integrations=("email",)),
        # Creating the client ticket on the desk is the first side effect; the
        # flow fixes its identity by correlation id because a desk without
        # native dedupe would otherwise mint a second ticket on a re-derive.
        # The desk is Jira Cloud or HaloPSA depending on the tenant wiring.
        StepDefinition(
            id="ticket",
            title="Ticket",
            side_effecting=True,
            integrations=("jira", "halopsa"),
        ),
        StepDefinition(id="draft", title="Draft", integrations=("kb",), slots=(MODEL_SLOT,)),
        StepDefinition(id="approve", title="Approve"),
        # Sending the reply and recording it on the desk ticket is the second
        # side effect (idempotent by case + ticket through the mail key).
        StepDefinition(
            id="send",
            title="Send",
            side_effecting=True,
            integrations=("email", "jira", "halopsa"),
        ),
    ),
)

BILLS_WORKFLOW = WorkflowDefinition(
    id="bills",
    mastra_workflow="billsFlow",
    title="Vendor Bill Posting",
    steps=(
        StepDefinition(id="intake", title="Intake", integrations=("email",)),
        StepDefinition(id="extract", title="Extract", slots=(MODEL_SLOT,)),
        StepDefinition(id="approve", title="Approve"),
        # Posting the draft bill to the ledger is the side effect (idempotent
        # by the flow's ledger key; Xero receives ACCPAY bills in DRAFT only).
        # A ledger posting is an outbound write a revert cannot undo.
        StepDefinition(
            id="post",
            title="Post",
            side_effecting=True,
            integrations=("xero",),
            risk=RISK_IRREVERSIBLE,
        ),
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
        MSP_WORKFLOW,
        BILLS_WORKFLOW,
    )
}


__all__ = [
    "ACCESSIBILITY_WORKFLOW",
    "BILLS_WORKFLOW",
    "DEPENDENCIES_WORKFLOW",
    "FEATURES_WORKFLOW",
    "HR_HELP_WORKFLOW",
    "ISSUES_WORKFLOW",
    "LEAVE_WORKFLOW",
    "MSP_WORKFLOW",
    "OFFBOARDING_WORKFLOW",
    "ONBOARDING_WORKFLOW",
    "REVIEW_WORKFLOW",
    "SCREENING_WORKFLOW",
    "SECURITY_WORKFLOW",
    "VENDORS_WORKFLOW",
    "WORKFLOW_DEFINITIONS",
    "side_effect_scope",
]
