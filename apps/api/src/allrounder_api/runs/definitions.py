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
a new grant, not a reversal). Naming is not enough: a step only belongs in
the band if the flow actually performs the irreversible action, so the
dependency step that opens bump PRs for a human to merge and the security
step that executes whichever disposition a human approved (close, escalate or
recommend as often as containment) both fall back to the default rule in
``service._gate_risk`` (55 side-effecting, 10 pure).

Workflow ``start_fields`` publish the run input each flow's Zod
``InputSchema`` already enforces: what a run needs before its first step can
move. ``GET /workflows`` serves them and ``POST /runs`` refuses an
incomplete start, so a missing ``employeeId`` is a 422 naming the field
instead of a failure inside the drive loop. Fields the server derives from
the ticket itself (``ticketKey``, the candidate list) are not listed.
"""

from __future__ import annotations

from .ceilings import APPLY_SLOT, MODEL_SLOT
from .models import (
    RISK_IRREVERSIBLE,
    FieldDefinition,
    StartField,
    StepDefinition,
    WorkflowDefinition,
)

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
    start_fields=(
        StartField(
            id="repository",
            label="Repository",
            required=True,
            example="acme/app",
            help="Owner/name of the GitHub repository the pull request lives in.",
        ),
        StartField(
            id="prNumber",
            label="Pull request number",
            kind="number",
            example="7",
            help="Leave empty to let the flow pick the open pull request.",
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
    start_fields=(
        StartField(
            id="repository",
            label="Repository",
            example="acme/app",
            help="Optional: narrows the issue search and the patch to one repository.",
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
    start_fields=(
        StartField(
            id="repository",
            label="Repository",
            example="acme/app",
            help="Optional: scopes the implementation and its pull request to one repository.",
        ),
        StartField(
            id="acceptanceCriteria",
            label="Acceptance criteria",
            kind="list",
            example="Users can export CSV; the export is audited",
            help=(
                "Optional: comma-separated criteria; the flow drafts them "
                "from the ticket otherwise."
            ),
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
    start_fields=(
        StartField(
            id="repository",
            label="Repository",
            example="acme/app",
            help="Optional: one repository to scan; every connected repository otherwise.",
        ),
        StartField(
            id="manifestPath",
            label="Manifest path",
            example="package.json",
            help="Optional: the manifest to read instead of the repository default.",
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
    start_fields=(
        StartField(
            id="repository",
            label="Repository",
            required=True,
            example="acme/web",
            help="Owner/name of the repository the fix pull request opens against.",
        ),
        StartField(
            id="targetUrl",
            label="Target URL",
            required=True,
            example="https://acme.test/pricing",
            help="Where the crawl starts; routes below it are audited.",
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
    start_fields=(
        StartField(
            id="vendorName",
            label="Vendor name",
            required=True,
            example="Northwind Power Pty Ltd",
        ),
        StartField(
            id="taxId",
            label="Tax / ABN",
            required=True,
            example="51824753556",
            help="The idempotency key of the master record: never guess it.",
        ),
        StartField(id="requestor", label="Requested by", required=True, example="dana.whit"),
        StartField(
            id="country",
            label="Country",
            required=True,
            example="AU",
            help="Two-letter ISO code, uppercase.",
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
    start_fields=(
        StartField(id="employeeId", label="Employee id", required=True, example="EMP-1042"),
        StartField(
            id="leaveType",
            label="Leave type",
            kind="enum",
            required=True,
            values=("annual", "sick", "unpaid", "parental"),
        ),
        StartField(
            id="startDate", label="First day off", kind="date", required=True, example="2026-11-02"
        ),
        StartField(
            id="endDate", label="Last day off", kind="date", required=True, example="2026-11-06"
        ),
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
    start_fields=(
        StartField(id="fullName", label="New hire name", required=True, example="Sam Rivera"),
        StartField(id="roleTitle", label="Role title", required=True, example="Support Engineer"),
        StartField(id="department", label="Department", required=True, example="Customer Ops"),
        StartField(id="location", label="Location", required=True, example="Sydney"),
        StartField(
            id="startDate", label="First day", kind="date", required=True, example="2026-11-16"
        ),
        StartField(id="managerId", label="Manager id", example="EMP-1004"),
        StartField(
            id="accessTier",
            label="Access tier",
            kind="enum",
            values=("low", "medium", "high"),
            help="Leave empty to let the risk score pick the tier.",
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
    start_fields=(
        StartField(id="employeeId", label="Employee id", required=True, example="EMP-1042"),
        StartField(
            id="lastDay", label="Last day", kind="date", required=True, example="2026-11-30"
        ),
        StartField(
            id="reason",
            label="Reason",
            required=True,
            example="Resignation",
            help="Recorded on the case next to the final-pay attestation.",
        ),
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
    start_fields=(
        StartField(
            id="requisitionId",
            label="Requisition id",
            required=True,
            example="REQ-2026-014",
            help="Selects the rubric and the candidate pool; nothing is invented.",
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
    start_fields=(
        StartField(
            id="question",
            label="Employee question",
            required=True,
            example="How many days of carer's leave do I get?",
            help="The answer is drafted from the policy knowledge base and cited.",
        ),
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
    start_fields=(
        StartField(
            id="alertSource",
            label="Alert source",
            kind="enum",
            required=True,
            values=("edr", "siem", "email", "cloud"),
        ),
        StartField(
            id="title",
            label="Alert title",
            required=True,
            example="Encoded PowerShell from WIN-4471",
        ),
        StartField(
            id="rawAlert",
            label="Raw alert text",
            kind="text",
            help="Optional: the raw alert as received; triage reads it verbatim.",
        ),
        StartField(id="host", label="Host", example="WIN-4471"),
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
    start_fields=(
        StartField(
            id="messageId",
            label="Message id",
            required=True,
            help="Intake fills this from the inbound client email.",
        ),
        StartField(id="from", label="From", required=True, example="ops@client.test"),
        StartField(id="to", label="To", required=True, example="desk@acme-msp.test"),
        StartField(id="subject", label="Subject", required=True),
        StartField(id="text", label="Body", required=True),
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
    start_fields=(
        StartField(
            id="messageId",
            label="Message id",
            required=True,
            help="Intake fills this from the inbound vendor email.",
        ),
        StartField(id="from", label="From", required=True, example="billing@northwind.test"),
        StartField(id="to", label="To", required=True, example="bills@acme.test"),
        StartField(id="subject", label="Subject", required=True),
        StartField(id="text", label="Body", required=True),
    ),
)


QA_WORKFLOW = WorkflowDefinition(
    id="qa",
    mastra_workflow="qaFlow",
    title="QA Case Design & Run",
    steps=(
        StepDefinition(id="intake", title="Intake"),
        StepDefinition(id="analyse", title="Analyse", slots=(MODEL_SLOT,)),
        StepDefinition(id="design", title="Design Cases", slots=(MODEL_SLOT,)),
        # Approval is a checkpoint, not an outbound side effect: the step
        # refuses a set with an uncovered requirement and writes the approved
        # cases to the lane's own store.
        StepDefinition(id="approve-cases", title="Approve Cases"),
        # Driving the approved cases is the first side effect. It is safe to
        # repeat only because the flow reuses the execution record when the
        # case set hash matches, so a re-drive cannot spend or act twice.
        StepDefinition(
            id="execute", title="Execute Cases", side_effecting=True, integrations=("web",)
        ),
        StepDefinition(id="assess", title="Assess"),
        # The human keeps or drops each finding; the next step files only what
        # survives this gate.
        StepDefinition(id="approve-defects", title="Approve Defects"),
        # One governed write per approved finding, through the Python route
        # that keys on `{storyKey}:{caseId}` — a second failing run comments on
        # the existing defect instead of filing a twin.
        StepDefinition(
            id="file-defects", title="File Defects", side_effecting=True, integrations=("jira",)
        ),
        StepDefinition(id="close", title="Close"),
    ),
    start_fields=(
        StartField(
            id="storyKey",
            label="Story key",
            required=True,
            example="OPS-123",
            help="Jira key of the story the cases are written for.",
        ),
        StartField(
            id="scope",
            label="Scope",
            required=True,
            example="Approving a leave request from the console",
            help="What to test, in your words; the squad reads it as data, not as instructions.",
        ),
        StartField(
            id="target",
            label="Target",
            kind="enum",
            example="local-console",
            values=("local-console",),
            help="Which running app the cases are written against.",
        ),
        StartField(
            id="maxCases",
            label="Case budget",
            kind="number",
            example="10",
            help="Upper bound on cases per run; defaults to 10 and caps at 25.",
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
        QA_WORKFLOW,
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
    "QA_WORKFLOW",
    "REVIEW_WORKFLOW",
    "SCREENING_WORKFLOW",
    "SECURITY_WORKFLOW",
    "VENDORS_WORKFLOW",
    "WORKFLOW_DEFINITIONS",
    "side_effect_scope",
]
