"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { ApiError } from "@/lib/api";
import type { JiraIssue } from "@/lib/board";
import {
  RUNNABLE_WORKFLOWS,
  applyRunEvent,
  completeReceipt,
  decideRunStep,
  getRun,
  isValidRepository,
  latestRunId,
  listGithubAccounts,
  listPullRequests,
  listRepositories,
  openCase,
  runVisualState,
  sortRunsNewestFirst,
  startRun,
  stepArtifact,
  subscribeToRunEvents,
  type GithubAccount,
  type PullRequestOption,
  type RunDecision,
  type RunDetail,
  type RunEvent,
  type RunStep,
  type RunSummary,
  type RunVisualState,
} from "@/lib/runs";

import {
  AccessibilityCrawlSurface,
  AccessibilityFixSurface,
  AccessibilityRescanSurface,
  AccessibilityViolationsSurface,
  AiReviewSurface,
  CompleteSurface,
  DependencyApplySurface,
  DependencyGroupSurface,
  DependencyMergeSurface,
  DependencyScanSurface,
  DependencyValidateSurface,
  FeatureCompleteSurface,
  FeatureImplementationSurface,
  FeatureSelectionSurface,
  IssueAnalysisSurface,
  IssueCompleteSurface,
  IssueImplementationSurface,
  IssueSelectionSurface,
  ReviewOptionsSurface,
  ScopeDesignSurface,
  SelectPrSurface,
  VendorApproveSurface,
  VendorCollectSurface,
  VendorCreateSurface,
  VendorRiskSurface,
  VendorVerifySurface,
  accessibilityRouteTotals,
  parseAccessibilityCrawl,
  parseAccessibilityFix,
  parseAccessibilityReceipt,
  parseAccessibilityRescan,
  parseCandidates,
  parseCategories,
  parseDependencyApply,
  parseDependencyGroups,
  parseDependencyMerge,
  parseDependencyReceipt,
  parseDependencyValidate,
  parseFeatureCompletion,
  parseFeatureImplementation,
  parseFeatureReceipt,
  parseFeatureSelection,
  parseGuidance,
  parseIssueAnalysis,
  parseIssueImplementation,
  parseIssueReceipt,
  parseIssueSelection,
  parseReceipt,
  parseReview,
  parseScopeDesign,
  parseSelected,
  parseVendorApprove,
  parseVendorCollect,
  parseVendorCreate,
  parseVendorReceipt,
  parseVendorRisk,
  parseVendorVerify,
  splitLines,
  vendorDocumentTotals,
  type AccessibilityCrawlDraft,
  type AccessibilityFixDraft,
  type AccessibilityWaiverDraft,
  type DependencyApplyDraft,
  type DependencyGroupDraft,
  type DependencyValidateDraft,
  type FeatureImplementationDraft,
  type FeatureSelectionDraft,
  type IssueAnalysisDraft,
  type IssueImplementationDraft,
  type IssueSelectionDraft,
  type OptionsDraft,
  type ReviewDraft,
  type ScopeDesignDraft,
  type VendorApproveDraft,
  type VendorCollectDraft,
  type VendorCreateDraft,
  type VendorVerifyDraft,
} from "./RunSurface";
import {
  HrHelpApproveSurface,
  HrHelpDraftSurface,
  HrHelpIntakeSurface,
  HrHelpRetrieveSurface,
  HrHelpSendSurface,
  LeaveApproveSurface,
  LeaveApplySurface,
  LeaveIntakeSurface,
  LeavePolicySurface,
  OffboardingApproveSurface,
  OffboardingAttestSurface,
  OffboardingAuditSurface,
  OffboardingIntakeSurface,
  OffboardingRevokeSurface,
  OnboardingApproveSurface,
  OnboardingCollectSurface,
  OnboardingProvisionSurface,
  OnboardingRiskSurface,
  OnboardingVerifySurface,
  onboardingDocumentTotals,
  parseHrHelpReceipt,
  parseLeaveReceipt,
  parseOffboardingApprove,
  parseOffboardingAttest,
  parseOffboardingAttestReceipt,
  parseOffboardingRevokeReceipt,
  parseOnboardingApprove,
  parseOnboardingCollect,
  parseOnboardingReceipt,
  parseOnboardingVerify,
  parseScreeningScheduleReceipt,
  parseScreeningShortlist,
  ScreeningRequisitionSurface,
  ScreeningScheduleSurface,
  ScreeningScreenSurface,
  ScreeningShortlistSurface,
  type OffboardingApproveDraft,
  type OffboardingAttestDraft,
  type OnboardingApproveDraft,
  type OnboardingCollectDraft,
  type OnboardingVerifyDraft,
  type ScreeningShortlistDraft,
} from "./RunSurfaceHr";
import { IconClock, IconCode } from "./icons";

const STATUS_COPY: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_human: "Awaiting you",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const RUN_STEP_COPY: Record<RunVisualState, string> = {
  done: "Completed",
  current: "In progress",
  awaiting: "Awaiting you",
  blocked: "Blocked",
  future: "Not started",
};

const PROCEED_LABELS: Record<string, string> = {
  "review-options": "Start review",
  "issue-selection": "Start fixing",
  analysis: "Implement fix",
  implementation: "Review Draft PR",
  "feature-selection": "Start planning",
  "scope-design": "Start implementation",
  scan: "Group the bumps",
  group: "Apply bumps",
  apply: "Validate bumps",
  validate: "Plan PRs",
  crawl: "Run audit",
  violations: "Plan fixes",
  fix: "Re-scan fixes",
  "re-scan": "Open fix PR",
  collect: "Start verification",
  verify: "Score the risk",
  "risk-score": "Review approvers",
  approve: "Preview vendor record",
  create: "Create vendor",
};

/** Proceed button copy; `implementation` and `complete` differ per workflow. */
function proceedLabel(workflow: string, stepId: string): string {
  if (stepId === "complete") {
    return workflow === "issues" || workflow === "features" ? "Open Draft PR" : "Post review";
  }
  if (workflow === "leave") {
    if (stepId === "intake") return "Run policy check";
    if (stepId === "policy-check") return "Send for approval";
    if (stepId === "approve") return "Approve request";
    if (stepId === "apply") return "Book leave";
  }
  if (workflow === "onboarding") {
    if (stepId === "approve") return "Preview employee record";
    if (stepId === "provision") return "Provision employee";
  }
  if (workflow === "offboarding") {
    if (stepId === "intake") return "Run access audit";
    if (stepId === "access-audit") return "Send for approval";
    if (stepId === "approve") return "Approve revocations";
    if (stepId === "revoke") return "Execute revocations";
    if (stepId === "attest") return "Attest & close case";
  }
  if (workflow === "screening") {
    if (stepId === "requisition") return "Run the screening";
    if (stepId === "screen") return "Build the shortlist";
    if (stepId === "shortlist") return "Plan the interviews";
    if (stepId === "schedule") return "Schedule interviews";
  }
  if (workflow === "hr-help") {
    if (stepId === "intake") return "Retrieve the policy";
    if (stepId === "retrieve") return "Draft the answer";
    if (stepId === "draft") return "Request approval";
    if (stepId === "approve") return "Approve the answer";
    if (stepId === "send") return "Record the answer";
  }
  if (workflow === "dependencies" && stepId === "merge") return "Open bump PRs";
  if (workflow === "features" && stepId === "implementation") return "Apply & Open PR";
  return PROCEED_LABELS[stepId] ?? "Proceed";
}

function workflowLabel(workflow: string): string {
  return RUNNABLE_WORKFLOWS.find((item) => item.id === workflow)?.label ?? workflow;
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function decisionErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "The run advanced or the lock changed — reloading the latest state.";
    if (error.status === 403) return "Your account cannot make this decision (approver role required).";
    if (error.status === 404) return "That step is no longer part of the run.";
    return `The decision was rejected (${error.status}).`;
  }
  return "The decision could not reach the API.";
}

function startErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Your account cannot start runs (agent or approver role required).";
    if (error.status === 404) return "That workflow is not registered on the API.";
    return `The run could not start (${error.status}).`;
  }
  return "The run could not reach the API — check the API logs and try again.";
}

function buildReviewEdits(draft: ReviewDraft): Record<string, unknown> {
  return {
    verdict: draft.verdict,
    summary: draft.summary.trim(),
    strengths: splitLines(draft.strengthsText).slice(0, 20),
    improvements: splitLines(draft.improvementsText).slice(0, 20),
    comments: draft.comments
      .map((comment) => ({ path: comment.path, line: comment.line, body: comment.body.trim() }))
      .filter((comment) => comment.body !== "")
      .slice(0, 100),
  };
}

/** The dependency lane records its side effect on the `merge` step (not `complete`). */
function mergeReceipt(run: RunDetail): Record<string, unknown> | null {
  const effect = run.sideEffects["merge"];
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) return null;
  const receipt = (effect as Record<string, unknown>)["receipt"];
  return typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
    ? (receipt as Record<string, unknown>)
    : null;
}

/** The accessibility lane records its side effect on the `re-scan` step. */
function rescanReceipt(run: RunDetail): Record<string, unknown> | null {
  const effect = run.sideEffects["re-scan"];
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) return null;
  const receipt = (effect as Record<string, unknown>)["receipt"];
  return typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
    ? (receipt as Record<string, unknown>)
    : null;
}

/** The vendors lane records its side effect on the `create` step. */
function vendorCreateReceipt(run: RunDetail): Record<string, unknown> | null {
  const effect = run.sideEffects["create"];
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) return null;
  const receipt = (effect as Record<string, unknown>)["receipt"];
  return typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
    ? (receipt as Record<string, unknown>)
    : null;
}

/** The leave lane records its side effect on the `apply` step. */
function leaveApplyReceipt(run: RunDetail): Record<string, unknown> | null {
  const effect = run.sideEffects["apply"];
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) return null;
  const receipt = (effect as Record<string, unknown>)["receipt"];
  return typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
    ? (receipt as Record<string, unknown>)
    : null;
}

/** The onboarding lane records its side effect on the `provision` step. */
function provisionReceipt(run: RunDetail): Record<string, unknown> | null {
  const effect = run.sideEffects["provision"];
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) return null;
  const receipt = (effect as Record<string, unknown>)["receipt"];
  return typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
    ? (receipt as Record<string, unknown>)
    : null;
}

/** The offboarding lane records its first side effect on the `revoke` step. */
function offboardingRevokeReceipt(run: RunDetail): Record<string, unknown> | null {
  const effect = run.sideEffects["revoke"];
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) return null;
  const receipt = (effect as Record<string, unknown>)["receipt"];
  return typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
    ? (receipt as Record<string, unknown>)
    : null;
}

/** The offboarding lane records its second side effect on the `attest` step. */
function offboardingAttestReceipt(run: RunDetail): Record<string, unknown> | null {
  const effect = run.sideEffects["attest"];
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) return null;
  const receipt = (effect as Record<string, unknown>)["receipt"];
  return typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
    ? (receipt as Record<string, unknown>)
    : null;
}

/** The screening lane records its side effect on the `schedule` step. */
function screeningScheduleReceipt(run: RunDetail): Record<string, unknown> | null {
  const effect = run.sideEffects["schedule"];
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) return null;
  const receipt = (effect as Record<string, unknown>)["receipt"];
  return typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
    ? (receipt as Record<string, unknown>)
    : null;
}

/** The HR help lane records its side effect on the `send` step. */
function hrHelpSendReceipt(run: RunDetail): Record<string, unknown> | null {
  const effect = run.sideEffects["send"];
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) return null;
  const receipt = (effect as Record<string, unknown>)["receipt"];
  return typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
    ? (receipt as Record<string, unknown>)
    : null;
}

/**
 * The collect Proceed is blocked until every required document is received
 * with a file name or waived with a reason (from the artifact or the draft).
 */
function vendorCollectBlocked(
  artifact: Record<string, unknown>,
  draft: VendorCollectDraft | null,
): boolean {
  const collect = parseVendorCollect(artifact);
  if (collect === null) return false;
  const documents = draft?.documents ?? collect.documents;
  return documents.some(
    (document) =>
      (document.required && document.status !== "received" && document.status !== "waived") ||
      (document.status === "received" && (document.fileName ?? "").trim() === "") ||
      (document.status === "waived" && (document.waivedReason ?? "").trim() === ""),
  );
}

/**
 * The verify Proceed is blocked while a failing check lacks a manual-review
 * note (from the artifact resolutions or the draft).
 */
function vendorVerifyBlocked(
  artifact: Record<string, unknown>,
  draft: VendorVerifyDraft | null,
): boolean {
  const verify = parseVendorVerify(artifact);
  if (verify === null) return false;
  return verify.checks.some(
    (check) =>
      check.status === "fail" &&
      (draft?.resolutions[check.id] ?? "").trim() === "" &&
      (verify.resolutions.find((resolution) => resolution.checkId === check.id)?.note ?? "").trim() ===
        "",
  );
}

/** The create preview opens only once every required signer has approved. */
function vendorApproveBlocked(
  artifact: Record<string, unknown>,
  draft: VendorApproveDraft | null,
): boolean {
  const approve = parseVendorApprove(artifact);
  if (approve === null) return false;
  const chain = draft?.chain ?? approve.chain;
  return !chain.every((entry) => entry.state === "approved");
}

/**
 * The onboarding collect Proceed mirrors the vendors document gate: every
 * required document received with a file name or waived with a reason.
 */
function onboardingCollectBlocked(
  artifact: Record<string, unknown>,
  draft: OnboardingCollectDraft | null,
): boolean {
  const collect = parseOnboardingCollect(artifact);
  if (collect === null) return false;
  const documents = draft?.documents ?? collect.documents;
  return documents.some(
    (document) =>
      (document.required && document.status !== "received" && document.status !== "waived") ||
      (document.status === "received" && (document.fileName ?? "").trim() === "") ||
      (document.status === "waived" && (document.waivedReason ?? "").trim() === ""),
  );
}

/**
 * The onboarding verify Proceed is blocked while a failing check lacks a
 * manual-review note (from the artifact resolutions or the draft).
 */
function onboardingVerifyBlocked(
  artifact: Record<string, unknown>,
  draft: OnboardingVerifyDraft | null,
): boolean {
  const verify = parseOnboardingVerify(artifact);
  if (verify === null) return false;
  return verify.checks.some(
    (check) =>
      check.status === "fail" &&
      (draft?.resolutions[check.id] ?? "").trim() === "" &&
      (verify.resolutions.find((resolution) => resolution.checkId === check.id)?.note ?? "").trim() ===
        "",
  );
}

/** The onboarding provision preview opens once every required signer approved. */
function onboardingApproveBlocked(
  artifact: Record<string, unknown>,
  draft: OnboardingApproveDraft | null,
): boolean {
  const approve = parseOnboardingApprove(artifact);
  if (approve === null) return false;
  const chain = draft?.chain ?? approve.chain;
  return !chain.every((entry) => entry.state === "approved");
}

/**
 * The offboarding approve gate opens only once every revocation item is
 * approved and high-blast items carry a recorded approver.
 */
function offboardingApproveBlocked(
  artifact: Record<string, unknown>,
  draft: OffboardingApproveDraft | null,
): boolean {
  const approve = parseOffboardingApprove(artifact);
  if (approve === null) return false;
  const items = draft?.items ?? approve.items;
  return items.some(
    (item) =>
      !item.approved || (item.requiresExplicitApproval && (item.approver ?? "").trim() === ""),
  );
}

/**
 * The offboarding attest gate opens only once every failed revocation carries
 * an acknowledgement note (from the artifact or the draft).
 */
function offboardingAttestBlocked(
  artifact: Record<string, unknown>,
  draft: OffboardingAttestDraft | null,
): boolean {
  const attest = parseOffboardingAttest(artifact);
  if (attest === null) return false;
  const acknowledgements = draft?.acknowledgements ?? attest.acknowledgements;
  return attest.revocation.failed.some(
    (failure) =>
      (acknowledgements.find((entry) => entry.system === failure.system)?.note ?? "").trim() === "",
  );
}

/**
 * The scheduling gate opens only once at least one candidate is included and
 * every exclusion carries a reason (from the artifact or the draft).
 */
function screeningShortlistBlocked(
  artifact: Record<string, unknown>,
  draft: ScreeningShortlistDraft | null,
): boolean {
  const shortlist = parseScreeningShortlist(artifact);
  if (shortlist === null) return false;
  const entries = draft?.entries ?? shortlist.entries;
  return (
    !entries.some((entry) => entry.decision === "include") ||
    entries.some((entry) => entry.decision === "exclude" && entry.reason.trim() === "")
  );
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function waiverExpiryInFuture(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

/**
 * The re-scan Proceed is blocked while a critical violation stays open and no
 * valid waiver (from the artifact or the current draft) covers it.
 */
function accessibilityRescanBlocked(
  artifact: Record<string, unknown>,
  draft: AccessibilityWaiverDraft | null,
): boolean {
  const rescan = parseAccessibilityRescan(artifact);
  if (rescan === null) return false;
  const waived = (id: string): boolean => {
    if (
      rescan.waivers.some(
        (waiver) => waiver.violationId === id && waiverExpiryInFuture(waiver.expiresAt),
      )
    ) {
      return true;
    }
    const entry = draft?.entries[id];
    return (
      entry !== undefined && entry.reason.trim() !== "" && waiverExpiryInFuture(entry.expiresAt)
    );
  };
  return rescan.remaining.some(
    (violation) => violation.impact === "critical" && !waived(violation.id),
  );
}

/**
 * The run surface for a ticket: per-run SSE subscription, the queue/lock
 * banners, the run stepper, the standard action bar, and the History menu.
 * Every decision goes through the runs API so the receipt trail stays intact.
 */
export function RunPanel({
  issue,
  runs,
  debugOpen,
  onToggleDebug,
  onRunsChanged,
  onActiveRun,
}: {
  issue: JiraIssue;
  runs: RunSummary[];
  debugOpen: boolean;
  onToggleDebug: () => void;
  onRunsChanged: () => void;
  onActiveRun: (run: RunDetail | null) => void;
}) {
  const sortedRuns = useMemo(() => sortRunsNewestFirst(runs), [runs]);
  const [activeRunId, setActiveRunId] = useState<string | null>(() => latestRunId(runs));
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [loadTick, setLoadTick] = useState(0);
  const [streamDown, setStreamDown] = useState(false);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editActive, setEditActive] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [armedAction, setArmedAction] = useState<"back" | "abort" | null>(null);
  const [selectDraft, setSelectDraft] = useState<number | null>(null);
  const [optionsDraft, setOptionsDraft] = useState<OptionsDraft | null>(null);
  const [reviewDraft, setReviewDraft] = useState<ReviewDraft | null>(null);
  const [issueSelectionDraft, setIssueSelectionDraft] = useState<IssueSelectionDraft | null>(null);
  const [analysisDraft, setAnalysisDraft] = useState<IssueAnalysisDraft | null>(null);
  const [implementationDraft, setImplementationDraft] = useState<IssueImplementationDraft | null>(
    null,
  );
  const [featureSelectionDraft, setFeatureSelectionDraft] = useState<FeatureSelectionDraft | null>(
    null,
  );
  const [scopeDesignDraft, setScopeDesignDraft] = useState<ScopeDesignDraft | null>(null);
  const [featureImplementationDraft, setFeatureImplementationDraft] =
    useState<FeatureImplementationDraft | null>(null);
  const [dependencyGroupDraft, setDependencyGroupDraft] = useState<DependencyGroupDraft | null>(
    null,
  );
  const [dependencyApplyDraft, setDependencyApplyDraft] = useState<DependencyApplyDraft | null>(
    null,
  );
  const [dependencyValidateDraft, setDependencyValidateDraft] =
    useState<DependencyValidateDraft | null>(null);
  const [accessibilityCrawlDraft, setAccessibilityCrawlDraft] =
    useState<AccessibilityCrawlDraft | null>(null);
  const [accessibilityFixDraft, setAccessibilityFixDraft] =
    useState<AccessibilityFixDraft | null>(null);
  const [accessibilityWaiverDraft, setAccessibilityWaiverDraft] =
    useState<AccessibilityWaiverDraft | null>(null);
  const [vendorCollectDraft, setVendorCollectDraft] = useState<VendorCollectDraft | null>(null);
  const [vendorVerifyDraft, setVendorVerifyDraft] = useState<VendorVerifyDraft | null>(null);
  const [vendorApproveDraft, setVendorApproveDraft] = useState<VendorApproveDraft | null>(null);
  const [vendorCreateDraft, setVendorCreateDraft] = useState<VendorCreateDraft | null>(null);
  const [vendorReturnNote, setVendorReturnNote] = useState<string | null>(null);
  const [onboardingCollectDraft, setOnboardingCollectDraft] =
    useState<OnboardingCollectDraft | null>(null);
  const [onboardingVerifyDraft, setOnboardingVerifyDraft] =
    useState<OnboardingVerifyDraft | null>(null);
  const [onboardingApproveDraft, setOnboardingApproveDraft] =
    useState<OnboardingApproveDraft | null>(null);
  const [onboardingReturnNote, setOnboardingReturnNote] = useState<string | null>(null);
  const [offboardingApproveDraft, setOffboardingApproveDraft] =
    useState<OffboardingApproveDraft | null>(null);
  const [offboardingAttestDraft, setOffboardingAttestDraft] =
    useState<OffboardingAttestDraft | null>(null);
  const [screeningShortlistDraft, setScreeningShortlistDraft] =
    useState<ScreeningShortlistDraft | null>(null);
  const [followUpBusy, setFollowUpBusy] = useState(false);

  const onRunsChangedRef = useRef(onRunsChanged);
  onRunsChangedRef.current = onRunsChanged;
  const onActiveRunRef = useRef(onActiveRun);
  onActiveRunRef.current = onActiveRun;
  const refreshRef = useRef<() => void>(() => {});

  const activeStep = useMemo(
    () => detail?.steps.find((step) => step.stepId === detail.currentStepId) ?? null,
    [detail],
  );
  const focusKey =
    detail === null ? "" : `${detail.runId}:${detail.currentStepId ?? ""}:${activeStep?.updatedAt ?? ""}`;

  // Keep the displayed run valid as the ticket's run list refreshes.
  useEffect(() => {
    if (activeRunId === null || !runs.some((run) => run.runId === activeRunId)) {
      setActiveRunId(latestRunId(runs));
    }
  }, [runs, activeRunId]);

  const reload = useMemo(
    () => async (): Promise<void> => {
      if (activeRunId === null) return;
      try {
        const run = await getRun(activeRunId);
        setDetail(run);
        setDetailError(false);
        onActiveRunRef.current(run);
      } catch {
        setDetailError(true);
      }
    },
    [activeRunId],
  );
  refreshRef.current = () => {
    void reload();
  };

  useEffect(() => {
    if (activeRunId === null) {
      setDetail(null);
      onActiveRunRef.current(null);
      return;
    }
    // A different run drops panel-scoped state (e.g. the vendors return note).
    setVendorReturnNote(null);
    setOnboardingReturnNote(null);
    setDetail(null);
    void reload();
  }, [activeRunId, loadTick, reload]);

  // Per-run SSE: events apply instantly, then a full reload reconciles.
  useEffect(() => {
    if (activeRunId === null) return;
    let cancelled = false;
    let close: (() => void) | null = null;
    void (async () => {
      const closer = await subscribeToRunEvents(activeRunId, {
        onEvent: (event: RunEvent) => {
          setDetail((previous) => (previous === null ? previous : applyRunEvent(previous, event)));
          if (event.type !== "run.created") {
            setStreamDown(false);
            refreshRef.current();
          }
        },
        onError: () => setStreamDown(true),
        onDone: () => refreshRef.current(),
      });
      if (cancelled) {
        closer();
        return;
      }
      close = closer;
    })();
    return () => {
      cancelled = true;
      close?.();
    };
  }, [activeRunId]);

  // Polling fallback while the stream is down so the panel never freezes.
  useEffect(() => {
    if (!streamDown || activeRunId === null) return;
    const timer = setInterval(() => refreshRef.current(), 5_000);
    return () => clearInterval(timer);
  }, [streamDown, activeRunId]);

  // Fresh drafts whenever the run's current step (or its artifact) changes.
  useEffect(() => {
    setEditActive(false);
    setRegenerateOpen(false);
    setGuidance("");
    setArmedAction(null);
    setActionError(null);
    setSelectDraft(null);
    setOptionsDraft(null);
    setReviewDraft(null);
    setIssueSelectionDraft(null);
    setAnalysisDraft(null);
    setImplementationDraft(null);
    setFeatureSelectionDraft(null);
    setScopeDesignDraft(null);
    setFeatureImplementationDraft(null);
    setDependencyGroupDraft(null);
    setDependencyApplyDraft(null);
    setDependencyValidateDraft(null);
    setAccessibilityCrawlDraft(null);
    setAccessibilityFixDraft(null);
    setAccessibilityWaiverDraft(null);
    setVendorCollectDraft(null);
    setVendorVerifyDraft(null);
    setVendorApproveDraft(null);
    setVendorCreateDraft(null);
    setOnboardingCollectDraft(null);
    setOnboardingVerifyDraft(null);
    setOnboardingApproveDraft(null);
    setOffboardingApproveDraft(null);
    setOffboardingAttestDraft(null);
    setScreeningShortlistDraft(null);
  }, [focusKey]);

  // Auto-focus the step that is awaiting the user (or the last step when done).
  useEffect(() => {
    if (detail === null) return;
    setExpandedStepId(detail.currentStepId ?? detail.steps[detail.steps.length - 1]?.stepId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.runId, detail?.currentStepId]);

  function selectStep(stepId: string): void {
    setExpandedStepId(stepId);
  }

  async function submitDecision(decision: RunDecision): Promise<void> {
    if (detail === null || activeStep === null) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await decideRunStep(detail.runId, activeStep.stepId, decision);
      setDetail(result.run);
      onActiveRunRef.current(result.run);
      onRunsChangedRef.current();
      // The vendors return note is consumed once Collect moves forward again.
      if (
        detail.workflow === "vendors" &&
        activeStep.stepId === "collect" &&
        (decision.action === "proceed" || decision.action === "edit")
      ) {
        setVendorReturnNote(null);
      }
      // The onboarding return note is consumed once Collect moves forward again.
      if (
        detail.workflow === "onboarding" &&
        activeStep.stepId === "collect" &&
        (decision.action === "proceed" || decision.action === "edit")
      ) {
        setOnboardingReturnNote(null);
      }
      setEditActive(false);
      setRegenerateOpen(false);
      setGuidance("");
      setArmedAction(null);
    } catch (error) {
      setActionError(decisionErrorCopy(error));
      if (error instanceof ApiError && error.status === 409) refreshRef.current();
    } finally {
      setBusy(false);
    }
  }

  function armOrSubmit(action: "back" | "abort"): void {
    if (armedAction !== action) {
      setArmedAction(action);
      return;
    }
    setArmedAction(null);
    void submitDecision({ action });
  }

  /** Build the Proceed decision: an edit when the surface draft differs, else plain proceed. */
  function buildProceed(): RunDecision {
    if (activeStep === null || activeStep.artifact === null) return { action: "proceed" };
    const artifact = activeStep.artifact;
    if (activeStep.stepId === "select-pr") {
      const selected = parseSelected(artifact);
      const target = selectDraft ?? selected?.number ?? null;
      const candidate = parseCandidates(artifact).find((item) => item.number === target) ?? null;
      if (candidate !== null && candidate.number !== selected?.number) {
        return { action: "edit", edits: { selected: candidate } };
      }
      return { action: "proceed" };
    }
    if (activeStep.stepId === "review-options") {
      if (optionsDraft !== null) {
        const baseline = parseCategories(artifact);
        const baselineGuidance = parseGuidance(artifact);
        const dirty =
          JSON.stringify(optionsDraft.categories) !== JSON.stringify(baseline) ||
          optionsDraft.guidance !== baselineGuidance;
        if (dirty) {
          return {
            action: "edit",
            edits: { categories: optionsDraft.categories, guidance: optionsDraft.guidance.slice(0, 4_000) },
          };
        }
      }
      return { action: "proceed" };
    }
    if (activeStep.stepId === "issue-selection") {
      const selection = parseIssueSelection(artifact);
      if (selection === null || issueSelectionDraft === null) return { action: "proceed" };
      const dirty =
        issueSelectionDraft.ticket.key !== selection.ticket.key ||
        issueSelectionDraft.repository !== selection.repository ||
        issueSelectionDraft.baseBranch !== selection.baseBranch ||
        JSON.stringify(issueSelectionDraft.advanced) !== JSON.stringify(selection.advanced);
      if (!dirty) return { action: "proceed" };
      return {
        action: "edit",
        edits: {
          ticket: issueSelectionDraft.ticket,
          repository: issueSelectionDraft.repository,
          baseBranch: issueSelectionDraft.baseBranch,
          advanced: {
            ...issueSelectionDraft.advanced,
            guidance: issueSelectionDraft.advanced.guidance.slice(0, 4_000),
          },
        },
      };
    }
    if (activeStep.stepId === "analysis") {
      const analysis = parseIssueAnalysis(artifact);
      if (analysis === null || analysisDraft === null) return { action: "proceed" };
      const dirty =
        analysisDraft.summary !== analysis.summary ||
        JSON.stringify(analysisDraft.affectedFiles) !== JSON.stringify(analysis.affectedFiles);
      if (!dirty) return { action: "proceed" };
      return {
        action: "edit",
        edits: {
          summary: analysisDraft.summary,
          affectedFiles: analysisDraft.affectedFiles
            .filter((file) => file.path.trim() !== "" && file.changeDescription.trim() !== "")
            .slice(0, 25),
        },
      };
    }
    if (activeStep.stepId === "feature-selection") {
      const selection = parseFeatureSelection(artifact);
      if (selection === null || featureSelectionDraft === null) return { action: "proceed" };
      const dirty =
        featureSelectionDraft.ticket.key !== selection.ticket.key ||
        featureSelectionDraft.repository !== selection.repository ||
        featureSelectionDraft.baseBranch !== selection.baseBranch ||
        JSON.stringify(featureSelectionDraft.acceptanceCriteria) !==
          JSON.stringify(selection.acceptanceCriteria) ||
        JSON.stringify(featureSelectionDraft.advanced) !== JSON.stringify(selection.advanced);
      if (!dirty) return { action: "proceed" };
      return {
        action: "edit",
        edits: {
          ticket: featureSelectionDraft.ticket,
          repository: featureSelectionDraft.repository,
          baseBranch: featureSelectionDraft.baseBranch,
          acceptanceCriteria: featureSelectionDraft.acceptanceCriteria,
          advanced: {
            ...featureSelectionDraft.advanced,
            guidance: featureSelectionDraft.advanced.guidance.slice(0, 4_000),
          },
        },
      };
    }
    if (activeStep.stepId === "scope-design") {
      const scope = parseScopeDesign(artifact);
      if (scope === null || scopeDesignDraft === null) return { action: "proceed" };
      const dirty =
        scopeDesignDraft.targetSummary !== scope.targetSummary ||
        JSON.stringify(scopeDesignDraft.areas) !== JSON.stringify(scope.areas) ||
        scopeDesignDraft.guidance !== scope.guidance;
      if (!dirty) return { action: "proceed" };
      return {
        action: "edit",
        edits: {
          targetSummary: scopeDesignDraft.targetSummary,
          areas: scopeDesignDraft.areas,
          guidance: scopeDesignDraft.guidance.slice(0, 4_000),
        },
      };
    }
    if (activeStep.stepId === "group") {
      const groups = parseDependencyGroups(artifact);
      if (groups === null || dependencyGroupDraft === null) return { action: "proceed" };
      const dirty = JSON.stringify(dependencyGroupDraft.groups) !== JSON.stringify(groups.groups);
      if (!dirty) return { action: "proceed" };
      return { action: "edit", edits: { groups: dependencyGroupDraft.groups.slice(0, 3) } };
    }
    if (activeStep.stepId === "apply") {
      const apply = parseDependencyApply(artifact);
      if (apply === null || dependencyApplyDraft === null) return { action: "proceed" };
      const dirty = dependencyApplyDraft.groups.some((group) => {
        const baseline = apply.groups.find((item) => item.id === group.id);
        if (baseline === undefined) return false;
        if (baseline.accepted !== group.accepted) return true;
        return group.packages.some((pkg) => {
          const original = baseline.packages.find((item) => item.name === pkg.name);
          return original !== undefined && original.included !== pkg.included;
        });
      });
      if (!dirty) return { action: "proceed" };
      const rebuilt = apply.groups.map((group) => {
        const draftGroup = dependencyApplyDraft.groups.find((item) => item.id === group.id);
        if (draftGroup === undefined) return group;
        return {
          ...group,
          accepted: draftGroup.accepted,
          packages: group.packages.map((pkg) => {
            const draftPkg = draftGroup.packages.find((item) => item.name === pkg.name);
            return draftPkg === undefined ? pkg : { ...pkg, included: draftPkg.included };
          }),
        };
      });
      return { action: "edit", edits: { groups: rebuilt } };
    }
    if (activeStep.stepId === "validate") {
      const validate = parseDependencyValidate(artifact);
      if (validate === null || dependencyValidateDraft === null) return { action: "proceed" };
      const dirty = validate.groups.some(
        (group) => (dependencyValidateDraft.skipped[group.id] ?? group.skipped) !== group.skipped,
      );
      if (!dirty) return { action: "proceed" };
      return {
        action: "edit",
        edits: {
          groups: validate.groups.map((group) => ({
            ...group,
            skipped: dependencyValidateDraft.skipped[group.id] ?? group.skipped,
          })),
        },
      };
    }
    if (activeStep.stepId === "implementation") {
      if (detail?.workflow === "features") {
        const implementation = parseFeatureImplementation(artifact);
        if (implementation === null || featureImplementationDraft === null) {
          return { action: "proceed" };
        }
        const files = implementation.files.map((file) => ({
          ...file,
          content: featureImplementationDraft.files[file.path] ?? file.content,
        }));
        const dirty =
          featureImplementationDraft.summary !== implementation.summary ||
          files.some((file, index) => file.content !== implementation.files[index]?.content);
        if (!dirty) return { action: "proceed" };
        return {
          action: "edit",
          edits: { summary: featureImplementationDraft.summary, files },
        };
      }
      const implementation = parseIssueImplementation(artifact);
      if (implementation === null || implementationDraft === null) return { action: "proceed" };
      const files = implementation.files.map((file) => ({
        ...file,
        content: implementationDraft.files[file.path] ?? file.content,
      }));
      const regressionTest =
        implementation.regressionTest === null
          ? null
          : {
              ...implementation.regressionTest,
              content: implementationDraft.regressionTest ?? implementation.regressionTest.content,
            };
      const dirty =
        implementationDraft.summary !== implementation.summary ||
        files.some((file, index) => file.content !== implementation.files[index]?.content) ||
        (implementation.regressionTest !== null &&
          regressionTest !== null &&
          regressionTest.content !== implementation.regressionTest.content);
      if (!dirty) return { action: "proceed" };
      return {
        action: "edit",
        edits: { summary: implementationDraft.summary, files, regressionTest },
      };
    }
    if (activeStep.stepId === "crawl") {
      const crawl = parseAccessibilityCrawl(artifact);
      if (crawl === null || accessibilityCrawlDraft === null) return { action: "proceed" };
      const dirty =
        JSON.stringify(accessibilityCrawlDraft.routes) !== JSON.stringify(crawl.routes);
      if (!dirty) return { action: "proceed" };
      const routes = accessibilityCrawlDraft.routes;
      return { action: "edit", edits: { routes, totals: accessibilityRouteTotals(routes) } };
    }
    if (activeStep.stepId === "fix") {
      const fix = parseAccessibilityFix(artifact);
      if (fix === null || accessibilityFixDraft === null) return { action: "proceed" };
      const dirty = fix.fixes.some(
        (item) => (accessibilityFixDraft.applied[item.violationId] ?? item.applied) !== item.applied,
      );
      if (!dirty) return { action: "proceed" };
      const fixes = fix.fixes.map((item) => ({
        ...item,
        applied: accessibilityFixDraft.applied[item.violationId] ?? item.applied,
      }));
      return {
        action: "edit",
        edits: {
          fixes,
          totals: {
            fixes: fixes.length,
            applied: fixes.filter((item) => item.applied).length,
            manualRedesign: fixes.filter((item) => item.manualRedesign).length,
            files: fixes.reduce((total, item) => total + item.files.length, 0),
          },
        },
      };
    }
    if (activeStep.stepId === "re-scan") {
      const rescan = parseAccessibilityRescan(artifact);
      if (rescan === null || accessibilityWaiverDraft === null) return { action: "proceed" };
      const remainingIds = new Set(rescan.remaining.map((violation) => violation.id));
      const waivers: Array<{ violationId: string; reason: string; expiresAt: string }> = [];
      for (const [violationId, entry] of Object.entries(accessibilityWaiverDraft.entries)) {
        if (!remainingIds.has(violationId)) continue;
        const reason = entry.reason.trim();
        if (reason === "" || !waiverExpiryInFuture(entry.expiresAt)) continue;
        waivers.push({
          violationId,
          reason: reason.slice(0, 1_000),
          expiresAt: new Date(entry.expiresAt).toISOString(),
        });
      }
      if (waivers.length === 0) return { action: "proceed" };
      return { action: "edit", edits: { waivers } };
    }
    if (activeStep.stepId === "collect") {
      if (detail?.workflow === "onboarding") {
        const collect = parseOnboardingCollect(artifact);
        if (collect === null) return { action: "proceed" };
        const documents = onboardingCollectDraft?.documents ?? collect.documents;
        const returnedNote = (
          onboardingReturnNote ??
          onboardingCollectDraft?.returnedNote ??
          collect.returnedNote ??
          ""
        ).slice(0, 500);
        const dirty =
          (onboardingCollectDraft !== null &&
            JSON.stringify(onboardingCollectDraft.documents) !==
              JSON.stringify(collect.documents)) ||
          returnedNote !== (collect.returnedNote ?? "");
        if (!dirty) return { action: "proceed" };
        return {
          action: "edit",
          edits: {
            documents,
            totals: onboardingDocumentTotals(documents),
            returnedNote: returnedNote === "" ? null : returnedNote,
          },
        };
      }
      const collect = parseVendorCollect(artifact);
      if (collect === null) return { action: "proceed" };
      const documents = vendorCollectDraft?.documents ?? collect.documents;
      const returnedNote = (
        vendorReturnNote ??
        vendorCollectDraft?.returnedNote ??
        collect.returnedNote ??
        ""
      ).slice(0, 500);
      const dirty =
        (vendorCollectDraft !== null &&
          JSON.stringify(vendorCollectDraft.documents) !== JSON.stringify(collect.documents)) ||
        returnedNote !== (collect.returnedNote ?? "");
      if (!dirty) return { action: "proceed" };
      return {
        action: "edit",
        edits: {
          documents,
          totals: vendorDocumentTotals(documents),
          returnedNote: returnedNote === "" ? null : returnedNote,
        },
      };
    }
    if (activeStep.stepId === "verify") {
      if (detail?.workflow === "onboarding") {
        const verify = parseOnboardingVerify(artifact);
        if (verify === null) return { action: "proceed" };
        const resolutions: Array<{ checkId: string; note: string }> = [];
        for (const check of verify.checks) {
          if (check.status !== "fail") continue;
          const note = (
            onboardingVerifyDraft?.resolutions[check.id] ??
            verify.resolutions.find((resolution) => resolution.checkId === check.id)?.note ??
            ""
          ).trim();
          if (note === "") continue;
          resolutions.push({ checkId: check.id, note: note.slice(0, 1_000) });
        }
        const baseline = verify.resolutions
          .filter((resolution) =>
            verify.checks.some(
              (check) => check.id === resolution.checkId && check.status === "fail",
            ),
          )
          .map((resolution) => ({ checkId: resolution.checkId, note: resolution.note.trim() }));
        if (JSON.stringify(resolutions) === JSON.stringify(baseline)) return { action: "proceed" };
        return { action: "edit", edits: { resolutions } };
      }
      const verify = parseVendorVerify(artifact);
      if (verify === null) return { action: "proceed" };
      const resolutions: Array<{ checkId: string; note: string }> = [];
      for (const check of verify.checks) {
        if (check.status !== "fail") continue;
        const note = (
          vendorVerifyDraft?.resolutions[check.id] ??
          verify.resolutions.find((resolution) => resolution.checkId === check.id)?.note ??
          ""
        ).trim();
        if (note === "") continue;
        resolutions.push({ checkId: check.id, note: note.slice(0, 1_000) });
      }
      const baseline = verify.resolutions
        .filter((resolution) =>
          verify.checks.some(
            (check) => check.id === resolution.checkId && check.status === "fail",
          ),
        )
        .map((resolution) => ({ checkId: resolution.checkId, note: resolution.note.trim() }));
      if (JSON.stringify(resolutions) === JSON.stringify(baseline)) return { action: "proceed" };
      return { action: "edit", edits: { resolutions } };
    }
    if (activeStep.stepId === "approve") {
      if (detail?.workflow === "offboarding") {
        const approve = parseOffboardingApprove(artifact);
        if (approve === null || offboardingApproveDraft === null) return { action: "proceed" };
        const items = offboardingApproveDraft.items;
        if (JSON.stringify(items) === JSON.stringify(approve.items)) return { action: "proceed" };
        return {
          action: "edit",
          edits: {
            items,
            allApproved: items.length > 0 && items.every((item) => item.approved),
          },
        };
      }
      if (detail?.workflow === "onboarding") {
        const approve = parseOnboardingApprove(artifact);
        if (approve === null || onboardingApproveDraft === null) return { action: "proceed" };
        const chain = onboardingApproveDraft.chain;
        const comments = onboardingApproveDraft.comments;
        const dirty =
          JSON.stringify(chain) !== JSON.stringify(approve.chain) ||
          JSON.stringify(comments) !== JSON.stringify(approve.comments);
        if (!dirty) return { action: "proceed" };
        return {
          action: "edit",
          edits: {
            chain,
            comments,
            allApproved: chain.length > 0 && chain.every((entry) => entry.state === "approved"),
          },
        };
      }
      const approve = parseVendorApprove(artifact);
      if (approve === null || vendorApproveDraft === null) return { action: "proceed" };
      const chain = vendorApproveDraft.chain;
      const comments = vendorApproveDraft.comments;
      const dirty =
        JSON.stringify(chain) !== JSON.stringify(approve.chain) ||
        JSON.stringify(comments) !== JSON.stringify(approve.comments);
      if (!dirty) return { action: "proceed" };
      return {
        action: "edit",
        edits: {
          chain,
          comments,
          allApproved: chain.length > 0 && chain.every((entry) => entry.state === "approved"),
        },
      };
    }
    if (activeStep.stepId === "create") {
      const create = parseVendorCreate(artifact);
      if (create === null || vendorCreateDraft === null) return { action: "proceed" };
      if (vendorCreateDraft.welcomePacket === create.welcomePacket) return { action: "proceed" };
      return { action: "edit", edits: { welcomePacket: vendorCreateDraft.welcomePacket } };
    }
    if (activeStep.stepId === "attest") {
      const attest = parseOffboardingAttest(artifact);
      if (attest === null) return { action: "proceed" };
      const acknowledgements = offboardingAttestDraft?.acknowledgements ?? attest.acknowledgements;
      const current = acknowledgements
        .filter((entry) =>
          attest.revocation.failed.some((failure) => failure.system === entry.system),
        )
        .map((entry) => ({ system: entry.system, note: entry.note.trim() }))
        .filter((entry) => entry.note !== "");
      const baseline = attest.acknowledgements.map((entry) => ({
        system: entry.system,
        note: entry.note.trim(),
      }));
      if (JSON.stringify(current) === JSON.stringify(baseline)) return { action: "proceed" };
      return { action: "edit", edits: { acknowledgements: current } };
    }
    if (activeStep.stepId === "shortlist") {
      const shortlist = parseScreeningShortlist(artifact);
      if (shortlist === null || screeningShortlistDraft === null) return { action: "proceed" };
      const entries = screeningShortlistDraft.entries;
      if (JSON.stringify(entries) === JSON.stringify(shortlist.entries)) {
        return { action: "proceed" };
      }
      return {
        action: "edit",
        edits: {
          entries,
          included: entries.filter((entry) => entry.decision === "include").length,
          excluded: entries.filter((entry) => entry.decision === "exclude").length,
        },
      };
    }
    if (editActive && reviewDraft !== null) {
      return { action: "edit", edits: buildReviewEdits(reviewDraft) };
    }
    return { action: "proceed" };
  }

  async function startFollowUp(): Promise<void> {
    if (detail === null) return;
    const artifact = stepArtifact(detail, "complete");
    const receipt = completeReceipt(detail);
    const candidate = artifact === null ? null : parseReview(artifact)?.pullRequest ?? null;
    if (candidate === null) return;
    const reviewedSha = receipt?.["reviewedSha"];
    setFollowUpBusy(true);
    setActionError(null);
    try {
      await startRun({
        workflow: detail.workflow,
        ticketKey: issue.key,
        caseId: detail.caseId,
        input: {
          repository: candidate.repository,
          prNumber: candidate.number,
          ...(typeof reviewedSha === "string" && reviewedSha !== ""
            ? { lastReviewedSha: reviewedSha }
            : {}),
        },
      });
      onRunsChangedRef.current();
    } catch (error) {
      setActionError(startErrorCopy(error));
    } finally {
      setFollowUpBusy(false);
    }
  }

  /** Cross-link from the features complete step: run the PR Review workflow on the Draft PR. */
  async function startPrReview(): Promise<void> {
    if (detail === null) return;
    const artifact = stepArtifact(detail, "complete");
    const completion = artifact === null ? null : parseFeatureCompletion(artifact);
    const prNumber = parseFeatureReceipt(completeReceipt(detail))?.number ?? null;
    if (completion === null || completion.repository === "" || prNumber === null) return;
    setFollowUpBusy(true);
    setActionError(null);
    try {
      await startRun({
        workflow: "review",
        ticketKey: issue.key,
        caseId: detail.caseId,
        input: { repository: completion.repository, prNumber },
      });
      onRunsChangedRef.current();
    } catch (error) {
      setActionError(startErrorCopy(error));
    } finally {
      setFollowUpBusy(false);
    }
  }

  /** Cross-link from an opened dependency bump PR: run the PR Review workflow on it. */
  async function startDependencyReview(prNumber: number): Promise<void> {
    if (detail === null) return;
    const artifact = stepArtifact(detail, "merge");
    const merge = artifact === null ? null : parseDependencyMerge(artifact);
    if (merge === null) return;
    setFollowUpBusy(true);
    setActionError(null);
    try {
      await startRun({
        workflow: "review",
        ticketKey: issue.key,
        caseId: detail.caseId,
        input: { repository: merge.repository, prNumber },
      });
      onRunsChangedRef.current();
    } catch (error) {
      setActionError(startErrorCopy(error));
    } finally {
      setFollowUpBusy(false);
    }
  }

  /**
   * The vendors reject loop: a reason at Approve walks the run back through
   * three `back` decisions (approve -> risk-score -> verify) until it rests at
   * Collect; the reason is kept in panel state and drafted into the next
   * Collect edit as `returnedNote` (the API caps the decision comment at 500).
   */
  async function rejectVendorToCollect(reason: string): Promise<void> {
    if (detail === null) return;
    const note = reason.trim().slice(0, 500);
    if (note === "") return;
    setBusy(true);
    setActionError(null);
    setVendorReturnNote(note);
    try {
      let run = detail;
      for (const stepId of ["approve", "risk-score", "verify"]) {
        const result = await decideRunStep(run.runId, stepId, { action: "back", comment: note });
        run = result.run;
      }
      setDetail(run);
      onActiveRunRef.current(run);
      onRunsChangedRef.current();
      setEditActive(false);
      setRegenerateOpen(false);
      setGuidance("");
      setArmedAction(null);
    } catch (error) {
      setVendorReturnNote(null);
      setActionError(decisionErrorCopy(error));
      if (error instanceof ApiError && error.status === 409) refreshRef.current();
    } finally {
      setBusy(false);
    }
  }

  /**
   * The onboarding reject loop mirrors the vendors one: a reason at Approve
   * walks the run back through three `back` decisions (approve -> risk-score ->
   * verify) until it rests at Collect; the reason is kept in panel state and
   * drafted into the next Collect edit as `returnedNote` (the API caps the
   * decision comment at 500).
   */
  async function rejectOnboardingToCollect(reason: string): Promise<void> {
    if (detail === null) return;
    const note = reason.trim().slice(0, 500);
    if (note === "") return;
    setBusy(true);
    setActionError(null);
    setOnboardingReturnNote(note);
    try {
      let run = detail;
      for (const stepId of ["approve", "risk-score", "verify"]) {
        const result = await decideRunStep(run.runId, stepId, { action: "back", comment: note });
        run = result.run;
      }
      setDetail(run);
      onActiveRunRef.current(run);
      onRunsChangedRef.current();
      setEditActive(false);
      setRegenerateOpen(false);
      setGuidance("");
      setArmedAction(null);
    } catch (error) {
      setOnboardingReturnNote(null);
      setActionError(decisionErrorCopy(error));
      if (error instanceof ApiError && error.status === 409) refreshRef.current();
    } finally {
      setBusy(false);
    }
  }

  const receipt = detail === null ? null : parseReceipt(completeReceipt(detail));
  const issueReceipt =
    detail === null || detail.workflow !== "issues"
      ? null
      : parseIssueReceipt(completeReceipt(detail));
  const featureReceipt =
    detail === null || detail.workflow !== "features"
      ? null
      : parseFeatureReceipt(completeReceipt(detail));
  const dependencyReceipt =
    detail === null || detail.workflow !== "dependencies"
      ? null
      : parseDependencyReceipt(mergeReceipt(detail));
  const accessibilityReceipt =
    detail === null || detail.workflow !== "accessibility"
      ? null
      : parseAccessibilityReceipt(rescanReceipt(detail));
  const vendorReceipt =
    detail === null || detail.workflow !== "vendors"
      ? null
      : parseVendorReceipt(vendorCreateReceipt(detail));
  const leaveReceipt =
    detail === null || detail.workflow !== "leave"
      ? null
      : parseLeaveReceipt(leaveApplyReceipt(detail));
  const onboardingReceipt =
    detail === null || detail.workflow !== "onboarding"
      ? null
      : parseOnboardingReceipt(provisionReceipt(detail));
  const offboardingRevokeReceiptView =
    detail === null || detail.workflow !== "offboarding"
      ? null
      : parseOffboardingRevokeReceipt(offboardingRevokeReceipt(detail));
  const offboardingAttestReceiptView =
    detail === null || detail.workflow !== "offboarding"
      ? null
      : parseOffboardingAttestReceipt(offboardingAttestReceipt(detail));
  const screeningReceipt =
    detail === null || detail.workflow !== "screening"
      ? null
      : parseScreeningScheduleReceipt(screeningScheduleReceipt(detail));
  const hrHelpReceiptView =
    detail === null || detail.workflow !== "hr-help"
      ? null
      : parseHrHelpReceipt(hrHelpSendReceipt(detail));
  const historyRuns = sortedRuns.filter(
    (run) => detail === null || run.workflow === detail.workflow,
  );

  function decisionLine(step: RunStep): ReactNode {
    const action = step.decision === null ? null : step.decision["action"];
    if (typeof action !== "string") return null;
    const approver = step.decision === null ? null : step.decision["approver"];
    return (
      <p className="step-summary">
        {`Decision recorded: ${action}${typeof approver === "string" ? ` by ${approver}` : ""}${
          step.receipt !== null ? " · receipt signed" : ""
        }`}
      </p>
    );
  }

  function actionBar(step: RunStep, proceedDisabled: boolean): ReactNode {
    const index = detail === null ? 0 : detail.steps.findIndex((item) => item.stepId === step.stepId);
    const issuesFlow = detail?.workflow === "issues";
    const featuresFlow = detail?.workflow === "features";
    const dependenciesFlow = detail?.workflow === "dependencies";
    const accessibilityFlow = detail?.workflow === "accessibility";
    const vendorsFlow = detail?.workflow === "vendors";
    const leaveFlow = detail?.workflow === "leave";
    const onboardingFlow = detail?.workflow === "onboarding";
    const offboardingFlow = detail?.workflow === "offboarding";
    const screeningFlow = detail?.workflow === "screening";
    const hrHelpFlow = detail?.workflow === "hr-help";
    const regenerateAvailable =
      step.stepId === "ai-review" ||
      (issuesFlow && (step.stepId === "analysis" || step.stepId === "implementation")) ||
      (featuresFlow && (step.stepId === "scope-design" || step.stepId === "implementation")) ||
      (dependenciesFlow && step.stepId === "apply") ||
      (accessibilityFlow && (step.stepId === "violations" || step.stepId === "fix")) ||
      (vendorsFlow && (step.stepId === "verify" || step.stepId === "risk-score")) ||
      (leaveFlow && step.stepId === "policy-check") ||
      (onboardingFlow && (step.stepId === "verify" || step.stepId === "risk-score")) ||
      (offboardingFlow && step.stepId === "access-audit") ||
      (screeningFlow && step.stepId === "screen") ||
      (hrHelpFlow && step.stepId === "draft");
    if (regenerateOpen && regenerateAvailable) {
      return (
        <div className="run-actions-wrap">
          <div className="run-regenerate">
            <label>
              <span>
                {issuesFlow ||
                featuresFlow ||
                dependenciesFlow ||
                accessibilityFlow ||
                vendorsFlow ||
                leaveFlow ||
                onboardingFlow ||
                offboardingFlow ||
                screeningFlow ||
                hrHelpFlow
                  ? "What should change in this step?"
                  : "What should the reviewer change?"}
              </span>
              <textarea
                rows={2}
                maxLength={2000}
                value={guidance}
                placeholder="Optional guidance for the regeneration"
                onChange={(event) => setGuidance(event.target.value)}
              />
            </label>
            <div className="run-actions">
              <button
                type="button"
                className="approve"
                disabled={busy}
                onClick={() =>
                  void submitDecision(
                    guidance.trim() === ""
                      ? { action: "regenerate" }
                      : { action: "regenerate", guidance: guidance.trim().slice(0, 2_000) },
                  )
                }
              >
                Regenerate now
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setRegenerateOpen(false);
                  setGuidance("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="run-actions-wrap">
        <div className="run-actions" role="group" aria-label={`Actions for ${step.title}`}>
          <button
            type="button"
            disabled={busy || index <= 0}
            title={index <= 0 ? "This is the first checkpoint" : "Re-open the previous checkpoint; downstream steps re-derive"}
            onClick={() => armOrSubmit("back")}
          >
            {armedAction === "back" ? "Confirm back" : "Back"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setArmedAction(null);
              setEditActive((value) => !value);
            }}
          >
            {editActive ? "Stop editing" : "Edit"}
          </button>
          <button
            type="button"
            disabled={busy || !regenerateAvailable}
            title={
              regenerateAvailable
                ? issuesFlow ||
                  featuresFlow ||
                  dependenciesFlow ||
                  accessibilityFlow ||
                  vendorsFlow ||
                  leaveFlow ||
                  onboardingFlow ||
                  offboardingFlow ||
                  screeningFlow ||
                  hrHelpFlow
                  ? "Re-run this step with optional guidance"
                  : "Re-run the review with optional guidance"
                : "Only the AI review step re-runs"
            }
            onClick={() => {
              setArmedAction(null);
              setRegenerateOpen(true);
            }}
          >
            Regenerate
          </button>
          <button
            type="button"
            className="approve"
            disabled={busy || proceedDisabled}
            onClick={() => void submitDecision(buildProceed())}
          >
            {proceedLabel(detail?.workflow ?? "", step.stepId)}
          </button>
          <button type="button" className="danger" disabled={busy} onClick={() => armOrSubmit("abort")}>
            {armedAction === "abort" ? "Confirm abort" : "Abort"}
          </button>
        </div>
        <p className="run-edit-hint">
          {editActive
            ? "Editing inline — Proceed applies your changes with the decision receipt."
            : "Every checkpoint pauses for your decision; nothing advances without a receipt-backed approval."}
        </p>
      </div>
    );
  }

  function renderStepBody(step: RunStep, state: RunVisualState): ReactNode {
    const artifact = step.artifact;
    const interactive = state === "awaiting";
    if (artifact === null) {
      return (
        <p className="step-empty">
          {state === "future" || state === "current"
            ? "This checkpoint opens after the earlier steps are approved."
            : "No output was recorded for this step."}
        </p>
      );
    }
    switch (step.stepId) {
      case "intake":
        if (detail?.workflow === "hr-help") {
          return (
            <>
              <HrHelpIntakeSurface artifact={artifact} />
              {decisionLine(step)}
              {interactive && actionBar(step, false)}
            </>
          );
        }
        if (detail?.workflow === "offboarding") {
          return (
            <>
              <OffboardingIntakeSurface artifact={artifact} />
              {decisionLine(step)}
              {interactive && actionBar(step, false)}
            </>
          );
        }
        return (
          <>
            <LeaveIntakeSurface artifact={artifact} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "policy-check":
        return (
          <>
            <LeavePolicySurface artifact={artifact} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "retrieve":
        return (
          <>
            <HrHelpRetrieveSurface artifact={artifact} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "draft":
        return (
          <>
            <HrHelpDraftSurface artifact={artifact} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "access-audit":
        return (
          <>
            <OffboardingAuditSurface artifact={artifact} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "issue-selection":
        return (
          <>
            <IssueSelectionSurface
              artifact={artifact}
              editable={interactive}
              draft={issueSelectionDraft}
              onChange={setIssueSelectionDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "analysis":
        return (
          <>
            <IssueAnalysisSurface
              artifact={artifact}
              editing={interactive && editActive}
              draft={analysisDraft}
              onChange={setAnalysisDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "feature-selection": {
        const selection = parseFeatureSelection(artifact);
        const criteria =
          featureSelectionDraft?.acceptanceCriteria ?? selection?.acceptanceCriteria ?? [];
        const includedCount = criteria.filter((criterion) => criterion.included).length;
        return (
          <>
            <FeatureSelectionSurface
              artifact={artifact}
              editable={interactive}
              draft={featureSelectionDraft}
              onChange={setFeatureSelectionDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, criteria.length > 0 && includedCount === 0)}
          </>
        );
      }
      case "scope-design": {
        const scope = parseScopeDesign(artifact);
        const areas = scopeDesignDraft?.areas ?? scope?.areas ?? [];
        const enabledCount = areas.filter((area) => area.enabled).length;
        return (
          <>
            <ScopeDesignSurface
              artifact={artifact}
              editable={interactive}
              draft={scopeDesignDraft}
              onChange={setScopeDesignDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, areas.length > 0 && enabledCount === 0)}
          </>
        );
      }
      case "scan":
        return (
          <>
            <DependencyScanSurface artifact={artifact} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "group": {
        const groups = parseDependencyGroups(artifact);
        const packages = (dependencyGroupDraft?.groups ?? groups?.groups ?? []).flatMap(
          (group) => group.packages,
        );
        const missingReason = packages.some(
          (pkg) => pkg.excluded && pkg.excludeReason.trim() === "",
        );
        return (
          <>
            <DependencyGroupSurface
              artifact={artifact}
              editable={interactive}
              draft={dependencyGroupDraft}
              onChange={setDependencyGroupDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, missingReason)}
          </>
        );
      }
      case "apply": {
        if (detail?.workflow === "leave") {
          return (
            <>
              <LeaveApplySurface artifact={artifact} receipt={leaveReceipt} />
              {decisionLine(step)}
              {interactive && actionBar(step, false)}
            </>
          );
        }
        const apply = parseDependencyApply(artifact);
        const value =
          dependencyApplyDraft?.groups ??
          apply?.groups.map((group) => ({
            id: group.id,
            accepted: group.accepted,
            packages: group.packages.map((pkg) => ({ name: pkg.name, included: pkg.included })),
          })) ??
          [];
        const nothingIncluded =
          value.length > 0 &&
          value.every(
            (group) => !group.accepted || group.packages.every((pkg) => !pkg.included),
          );
        return (
          <>
            <DependencyApplySurface
              artifact={artifact}
              editable={interactive}
              draft={dependencyApplyDraft}
              onChange={setDependencyApplyDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, nothingIncluded)}
          </>
        );
      }
      case "validate": {
        const validate = parseDependencyValidate(artifact);
        const hasOpenFailure =
          validate !== null &&
          validate.groups.some(
            (group) =>
              !(dependencyValidateDraft?.skipped[group.id] ?? group.skipped) &&
              group.status === "failed",
          );
        return (
          <>
            <DependencyValidateSurface
              artifact={artifact}
              editable={interactive}
              draft={dependencyValidateDraft}
              onChange={setDependencyValidateDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, hasOpenFailure)}
          </>
        );
      }
      case "merge":
        return (
          <>
            <DependencyMergeSurface
              artifact={artifact}
              receipt={dependencyReceipt}
              reviewLink={{
                onStart: (prNumber) => void startDependencyReview(prNumber),
                busy: followUpBusy,
              }}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "crawl": {
        const crawl = parseAccessibilityCrawl(artifact);
        const routes = accessibilityCrawlDraft?.routes ?? crawl?.routes ?? [];
        const selectedCount = routes.filter((route) => route.selected).length;
        return (
          <>
            <AccessibilityCrawlSurface
              artifact={artifact}
              editable={interactive}
              draft={accessibilityCrawlDraft}
              onChange={setAccessibilityCrawlDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, selectedCount === 0)}
          </>
        );
      }
      case "violations":
        return (
          <>
            <AccessibilityViolationsSurface artifact={artifact} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "fix": {
        const fix = parseAccessibilityFix(artifact);
        const applicable =
          fix === null
            ? []
            : fix.fixes.filter((item) => !item.manualRedesign && item.files.length > 0);
        const appliedCount = applicable.filter(
          (item) => accessibilityFixDraft?.applied[item.violationId] ?? item.applied,
        ).length;
        return (
          <>
            <AccessibilityFixSurface
              artifact={artifact}
              editable={interactive}
              draft={accessibilityFixDraft}
              onChange={setAccessibilityFixDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, applicable.length > 0 && appliedCount === 0)}
          </>
        );
      }
      case "re-scan":
        return (
          <>
            <AccessibilityRescanSurface
              artifact={artifact}
              receipt={accessibilityReceipt}
              editable={interactive}
              draft={accessibilityWaiverDraft}
              onChange={setAccessibilityWaiverDraft}
            />
            {decisionLine(step)}
            {interactive &&
              actionBar(step, accessibilityRescanBlocked(artifact, accessibilityWaiverDraft))}
          </>
        );
      case "collect":
        if (detail?.workflow === "onboarding") {
          return (
            <>
              <OnboardingCollectSurface
                artifact={artifact}
                editable={interactive}
                draft={onboardingCollectDraft}
                returnNote={onboardingReturnNote}
                onChange={setOnboardingCollectDraft}
              />
              {decisionLine(step)}
              {interactive &&
                actionBar(step, onboardingCollectBlocked(artifact, onboardingCollectDraft))}
            </>
          );
        }
        return (
          <>
            <VendorCollectSurface
              artifact={artifact}
              editable={interactive}
              draft={vendorCollectDraft}
              returnNote={vendorReturnNote}
              onChange={setVendorCollectDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, vendorCollectBlocked(artifact, vendorCollectDraft))}
          </>
        );
      case "verify":
        if (detail?.workflow === "onboarding") {
          return (
            <>
              <OnboardingVerifySurface
                artifact={artifact}
                editable={interactive}
                draft={onboardingVerifyDraft}
                onChange={setOnboardingVerifyDraft}
              />
              {decisionLine(step)}
              {interactive &&
                actionBar(step, onboardingVerifyBlocked(artifact, onboardingVerifyDraft))}
            </>
          );
        }
        return (
          <>
            <VendorVerifySurface
              artifact={artifact}
              editable={interactive}
              draft={vendorVerifyDraft}
              onChange={setVendorVerifyDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, vendorVerifyBlocked(artifact, vendorVerifyDraft))}
          </>
        );
      case "risk-score":
        if (detail?.workflow === "onboarding") {
          return (
            <>
              <OnboardingRiskSurface artifact={artifact} />
              {decisionLine(step)}
              {interactive && actionBar(step, false)}
            </>
          );
        }
        return (
          <>
            <VendorRiskSurface artifact={artifact} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "approve":
        if (detail?.workflow === "hr-help") {
          return (
            <>
              <HrHelpApproveSurface artifact={artifact} />
              {decisionLine(step)}
              {interactive && actionBar(step, false)}
            </>
          );
        }
        if (detail?.workflow === "leave") {
          return (
            <>
              <LeaveApproveSurface artifact={artifact} />
              {decisionLine(step)}
              {interactive && actionBar(step, false)}
            </>
          );
        }
        if (detail?.workflow === "offboarding") {
          return (
            <>
              <OffboardingApproveSurface
                artifact={artifact}
                editable={interactive}
                draft={offboardingApproveDraft}
                onChange={setOffboardingApproveDraft}
              />
              {decisionLine(step)}
              {interactive &&
                actionBar(step, offboardingApproveBlocked(artifact, offboardingApproveDraft))}
            </>
          );
        }
        if (detail?.workflow === "onboarding") {
          return (
            <>
              <OnboardingApproveSurface
                artifact={artifact}
                editable={interactive}
                draft={onboardingApproveDraft}
                onChange={setOnboardingApproveDraft}
                returnFlow={{ onReturn: (reason) => void rejectOnboardingToCollect(reason), busy }}
              />
              {decisionLine(step)}
              {interactive &&
                actionBar(step, onboardingApproveBlocked(artifact, onboardingApproveDraft))}
            </>
          );
        }
        return (
          <>
            <VendorApproveSurface
              artifact={artifact}
              editable={interactive}
              draft={vendorApproveDraft}
              onChange={setVendorApproveDraft}
              returnFlow={{ onReturn: (reason) => void rejectVendorToCollect(reason), busy }}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, vendorApproveBlocked(artifact, vendorApproveDraft))}
          </>
        );
      case "create":
        return (
          <>
            <VendorCreateSurface
              artifact={artifact}
              receipt={vendorReceipt}
              editable={interactive}
              draft={vendorCreateDraft}
              onChange={setVendorCreateDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "provision":
        return (
          <>
            <OnboardingProvisionSurface artifact={artifact} receipt={onboardingReceipt} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "revoke":
        return (
          <>
            <OffboardingRevokeSurface artifact={artifact} receipt={offboardingRevokeReceiptView} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "attest":
        return (
          <>
            <OffboardingAttestSurface
              artifact={artifact}
              receipt={offboardingAttestReceiptView}
              revokeReceipt={offboardingRevokeReceiptView}
              editable={interactive}
              draft={offboardingAttestDraft}
              onChange={setOffboardingAttestDraft}
            />
            {decisionLine(step)}
            {interactive &&
              actionBar(step, offboardingAttestBlocked(artifact, offboardingAttestDraft))}
          </>
        );
      case "requisition":
        return (
          <>
            <ScreeningRequisitionSurface artifact={artifact} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "screen":
        return (
          <>
            <ScreeningScreenSurface artifact={artifact} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "shortlist":
        return (
          <>
            <ScreeningShortlistSurface
              artifact={artifact}
              editable={interactive}
              draft={screeningShortlistDraft}
              onChange={setScreeningShortlistDraft}
            />
            {decisionLine(step)}
            {interactive &&
              actionBar(step, screeningShortlistBlocked(artifact, screeningShortlistDraft))}
          </>
        );
      case "schedule":
        return (
          <>
            <ScreeningScheduleSurface artifact={artifact} receipt={screeningReceipt} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "send":
        return (
          <>
            <HrHelpSendSurface artifact={artifact} receipt={hrHelpReceiptView} />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "implementation":
        if (detail?.workflow === "features") {
          return (
            <>
              <FeatureImplementationSurface
                artifact={artifact}
                editing={interactive && editActive}
                draft={featureImplementationDraft}
                onChange={setFeatureImplementationDraft}
              />
              {decisionLine(step)}
              {interactive && actionBar(step, false)}
            </>
          );
        }
        return (
          <>
            <IssueImplementationSurface
              artifact={artifact}
              editing={interactive && editActive}
              draft={implementationDraft}
              onChange={setImplementationDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "select-pr": {
        const selected = parseSelected(artifact);
        const effective = selectDraft ?? selected?.number ?? null;
        return (
          <>
            <SelectPrSurface
              artifact={artifact}
              editable={interactive}
              selectedNumber={effective}
              onSelect={setSelectDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, effective === null)}
          </>
        );
      }
      case "review-options":
        return (
          <>
            <ReviewOptionsSurface
              artifact={artifact}
              editable={interactive}
              draft={optionsDraft}
              onChange={setOptionsDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "ai-review":
        return (
          <>
            <AiReviewSurface
              artifact={artifact}
              editing={interactive && editActive}
              draft={reviewDraft}
              onChange={setReviewDraft}
            />
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      case "complete":
        if (detail?.workflow === "features") {
          return (
            <>
              <FeatureCompleteSurface
                artifact={artifact}
                receipt={featureReceipt}
                reviewLink={{ onStart: () => void startPrReview(), busy: followUpBusy }}
              />
              {decisionLine(step)}
              {interactive && actionBar(step, false)}
            </>
          );
        }
        if (detail?.workflow === "issues") {
          return (
            <>
              <IssueCompleteSurface artifact={artifact} receipt={issueReceipt} />
              {decisionLine(step)}
              {interactive && actionBar(step, false)}
            </>
          );
        }
        return (
          <>
            <CompleteSurface
              artifact={artifact}
              receipt={receipt}
              followUp={{ onStart: () => void startFollowUp(), busy: followUpBusy }}
            />
            {interactive && editActive && (
              <AiReviewSurface
                artifact={artifact}
                editing
                draft={reviewDraft}
                onChange={setReviewDraft}
              />
            )}
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
      default:
        return (
          <>
            <p className="step-empty">
              This step has no dedicated surface yet — use the action bar to decide.
            </p>
            {decisionLine(step)}
            {interactive && actionBar(step, false)}
          </>
        );
    }
  }

  if (detail === null) {
    return (
      <section className="run-panel" aria-label="Workflow run">
        {detailError ? (
          <div className="run-banner failed" role="alert">
            <p>The run could not be loaded.</p>
            <div className="run-banner-actions">
              <button type="button" onClick={() => setLoadTick((tick) => tick + 1)}>
                Retry
              </button>
            </div>
          </div>
        ) : (
          <p className="ticket-notice" role="status">
            Loading the run…
          </p>
        )}
      </section>
    );
  }

  // One step at a time: the stepper selects, the panel below renders only it.
  const focusedStep =
    detail.steps.find((step) => step.stepId === expandedStepId) ??
    detail.steps.find((step) => step.stepId === detail.currentStepId) ??
    detail.steps[detail.steps.length - 1] ??
    null;
  const focusedState: RunVisualState =
    focusedStep === null ? "future" : runVisualState(focusedStep);

  return (
    <section className="run-panel" aria-label="Workflow run">
      <div className="run-panel-toolbar">
        <div className="run-panel-status">
          <span className={`run-status status-${detail.status}`}>
            {STATUS_COPY[detail.status] ?? detail.status}
          </span>
          <span className="run-panel-meta">
            {`${workflowLabel(detail.workflow)} · ${detail.stepsDone}/${detail.stepCount} steps`}
            {detail.attempt > 0 ? ` · attempt ${detail.attempt + 1}` : ""}
          </span>
        </div>
        <div className="run-panel-actions">
          <div className="history-wrap">
            <button
              type="button"
              className="history-button"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              <IconClock />
              <span>History</span>
            </button>
            {historyOpen && (
              <div className="history-menu run-history-menu" role="menu">
                {historyRuns.length === 0 ? (
                  <p className="history-empty">No prior runs for this workflow on this ticket.</p>
                ) : (
                  historyRuns.map((run) => (
                    <button
                      key={run.runId}
                      type="button"
                      role="menuitem"
                      className="history-item"
                      onClick={() => {
                        setHistoryOpen(false);
                        setActiveRunId(run.runId);
                      }}
                    >
                      <strong>{`${workflowLabel(run.workflow)} · ${STATUS_COPY[run.status] ?? run.status}`}</strong>
                      <span>
                        {`${formatTime(run.startedAt)} · ${run.stepsDone}/${run.stepCount} steps${
                          run.runId === activeRunId ? " · viewing" : ""
                        }`}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <button type="button" className="debug-toggle" aria-expanded={debugOpen} onClick={onToggleDebug}>
            <IconCode />
            <span>Debug Info</span>
          </button>
        </div>
      </div>

      {detail.status === "queued" && (
        <p className="run-banner queued" role="status">
          {detail.queuePosition !== null
            ? `Queued at position #${detail.queuePosition}.`
            : "Queued — waiting for a free slot."}
          {" "}It starts automatically when a slot frees up; other runs are not blocked by it.
        </p>
      )}

      {detail.status === "blocked" && (
        <div className="run-banner blocked" role="status">
          <p>
            {detail.lockedBy !== null
              ? `Locked by run ${shortId(detail.lockedBy)} on ${detail.lockTarget ?? "the target"}. Retry when that run finishes, or abort this one.`
              : `Blocked on the target lock for ${detail.lockTarget ?? "the target"}.`}
          </p>
          <div className="run-banner-actions">
            <button type="button" disabled={busy} onClick={() => void submitDecision({ action: "retry_lock" })}>
              Retry lock
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void submitDecision({ action: "abort" })}>
              Abort run
            </button>
          </div>
        </div>
      )}

      {detail.status === "completed" && (
        <p className="run-banner completed" role="status">
          Run completed — every checkpoint was approved and the side effect is recorded.
        </p>
      )}
      {detail.status === "failed" && (
        <p className="run-banner failed" role="alert">
          {`Run failed: ${detail.outcome ?? "unknown error"}.`}
        </p>
      )}
      {detail.status === "cancelled" && (
        <p className="run-banner cancelled" role="status">
          {`Run cancelled${detail.cancelReason !== null ? `: ${detail.cancelReason}` : "."}`}
        </p>
      )}

      {actionError !== null && (
        <p className="run-action-error" role="alert">
          {actionError}
        </p>
      )}

      <div className="stepper-row run-stepper-row">
        <ol className="stepper" aria-label="Run steps">
          {detail.steps.map((step, index) => {
            const state = runVisualState(step);
            return (
              <li key={step.stepId} className={`step step-${state}`}>
                <button
                  type="button"
                  className="step-button"
                  aria-expanded={expandedStepId === step.stepId}
                  onClick={() => selectStep(step.stepId)}
                >
                  <span className="step-dot" aria-hidden="true">
                    {state === "done" ? "✓" : index + 1}
                  </span>
                  <span className="step-label">
                    {step.title}
                    <span className="sr-only">{` — ${RUN_STEP_COPY[state]}`}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      {focusedStep !== null && (
        <div className="step-panels">
          <section className="step-panel expanded">
            <header>
              <button
                type="button"
                className="step-panel-toggle"
                aria-expanded
                onClick={() => selectStep(focusedStep.stepId)}
              >
                <span className={`step-state state-${focusedState}`}>
                  {RUN_STEP_COPY[focusedState]}
                </span>
                <h3>{focusedStep.title}</h3>
              </button>
            </header>
            <div className="step-panel-body">{renderStepBody(focusedStep, focusedState)}</div>
          </section>
        </div>
      )}
    </section>
  );
}

/**
 * The empty-state card: start a run for this ticket. When the ticket has no
 * case yet the card still renders — starting opens the case on demand
 * (POST /cases) and passes its id to the run service. Callers may preselect
 * the workflow and restrict the dropdown (the New-tab picker passes the
 * workflows supported for the ticket type).
 */
export function StartRunCard({
  issue,
  caseId,
  onStarted,
  initialWorkflow,
  workflowOptions,
}: {
  issue: JiraIssue;
  caseId: string | null;
  onStarted: () => void;
  initialWorkflow?: string;
  workflowOptions?: ReadonlyArray<{ id: string; label: string }>;
}) {
  const options =
    workflowOptions !== undefined && workflowOptions.length > 0
      ? workflowOptions
      : RUNNABLE_WORKFLOWS;
  const [workflow, setWorkflow] = useState(
    initialWorkflow !== undefined && options.some((item) => item.id === initialWorkflow)
      ? initialWorkflow
      : (options[0]?.id ?? "review"),
  );
  const [repository, setRepository] = useState("");
  const [pullNumber, setPullNumber] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [vendorTaxId, setVendorTaxId] = useState("");
  const [vendorCountry, setVendorCountry] = useState("");
  const [vendorRequestor, setVendorRequestor] = useState("");
  const [leaveEmployeeId, setLeaveEmployeeId] = useState("");
  const [leaveType, setLeaveType] = useState("annual");
  const [leaveStart, setLeaveStart] = useState("");
  const [leaveEnd, setLeaveEnd] = useState("");
  const [hireName, setHireName] = useState("");
  const [hireRoleTitle, setHireRoleTitle] = useState("");
  const [hireDepartment, setHireDepartment] = useState("");
  const [hireLocation, setHireLocation] = useState("");
  const [hireStartDate, setHireStartDate] = useState("");
  const [hireManagerId, setHireManagerId] = useState("");
  const [hireAccessTier, setHireAccessTier] = useState("medium");
  const [offboardEmployeeId, setOffboardEmployeeId] = useState("");
  const [offboardLastDay, setOffboardLastDay] = useState("");
  const [offboardReason, setOffboardReason] = useState("");
  const [screeningRequisitionId, setScreeningRequisitionId] = useState("");
  const [hrHelpQuestion, setHrHelpQuestion] = useState("");
  const [repositories, setRepositories] = useState<string[] | null>(null);
  const [repositoriesFailed, setRepositoriesFailed] = useState(false);
  const [accounts, setAccounts] = useState<GithubAccount[] | null>(null);
  const [accountsFailed, setAccountsFailed] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [pullRequests, setPullRequests] = useState<PullRequestOption[]>([]);
  const [pullRequestsNote, setPullRequestsNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const issuesFlow = workflow === "issues";
  const featuresFlow = workflow === "features";
  const dependenciesFlow = workflow === "dependencies";
  const accessibilityFlow = workflow === "accessibility";
  const vendorsFlow = workflow === "vendors";
  const leaveFlow = workflow === "leave";
  const onboardingFlow = workflow === "onboarding";
  const offboardingFlow = workflow === "offboarding";
  const screeningFlow = workflow === "screening";
  const hrHelpFlow = workflow === "hr-help";
  const repositoryOptional = !accessibilityFlow && (issuesFlow || featuresFlow || dependenciesFlow);
  const reviewFlow =
    !repositoryOptional &&
    !accessibilityFlow &&
    !vendorsFlow &&
    !leaveFlow &&
    !onboardingFlow &&
    !offboardingFlow &&
    !screeningFlow &&
    !hrHelpFlow;
  const accountsSettled = accounts !== null || accountsFailed;

  useEffect(() => {
    if (!accountsSettled) return undefined;
    let cancelled = false;
    setRepositories(null);
    setRepositoriesFailed(false);
    listRepositories(accountId)
      .then((items) => {
        if (!cancelled) setRepositories(items);
      })
      .catch(() => {
        if (!cancelled) setRepositoriesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, accountsSettled]);

  useEffect(() => {
    let cancelled = false;
    listGithubAccounts()
      .then((items) => {
        if (cancelled) return;
        setAccounts(items);
        const preferred = items.find((item) => item.isDefault);
        if (preferred !== undefined) setAccountId(preferred.id);
      })
      .catch(() => {
        if (!cancelled) {
          setAccounts([]);
          setAccountsFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!reviewFlow || !isValidRepository(repository)) {
      setPullRequests([]);
      setPullRequestsNote(null);
      return undefined;
    }
    let cancelled = false;
    setPullRequestsNote(null);
    listPullRequests(repository.trim(), accountId === "" ? undefined : accountId)
      .then((items) => {
        if (!cancelled) setPullRequests(items);
      })
      .catch(() => {
        if (!cancelled) {
          setPullRequests([]);
          setPullRequestsNote(
            "Open pull requests could not be loaded — the run selects one at the select-pr checkpoint.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reviewFlow, repository, accountId]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (vendorsFlow) {
      const name = vendorName.trim();
      const taxId = vendorTaxId.trim();
      const country = vendorCountry.trim().toUpperCase();
      const requestor = vendorRequestor.trim();
      if (name.length < 2) {
        setError("Enter the vendor name (at least 2 characters).");
        return;
      }
      if (taxId.length < 5) {
        setError("Enter the tax ID (at least 5 characters).");
        return;
      }
      if (!/^[A-Za-z]{2}$/.test(country)) {
        setError("Enter the country as a two-letter ISO code, for example GB.");
        return;
      }
      if (requestor.length < 3) {
        setError("Enter who requested the onboarding (at least 3 characters).");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const activeCaseId = caseId ?? (await openCase(issue.key)).caseId;
        await startRun({
          workflow,
          ticketKey: issue.key,
          caseId: activeCaseId,
          input: { vendorName: name, taxId, requestor, country },
        });
        onStarted();
      } catch (submitError) {
        setError(startErrorCopy(submitError));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (leaveFlow) {
      const employeeId = leaveEmployeeId.trim().toUpperCase();
      if (!/^[A-Za-z0-9-]{2,40}$/.test(employeeId)) {
        setError("Enter the employee ID from the directory, for example E-1001.");
        return;
      }
      if (leaveStart === "" || leaveEnd === "") {
        setError("Pick the first and the last day of the leave.");
        return;
      }
      if (leaveEnd < leaveStart) {
        setError("The last day cannot be before the first day.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const activeCaseId = caseId ?? (await openCase(issue.key)).caseId;
        await startRun({
          workflow,
          ticketKey: issue.key,
          caseId: activeCaseId,
          input: { employeeId, leaveType, startDate: leaveStart, endDate: leaveEnd },
        });
        onStarted();
      } catch (submitError) {
        setError(startErrorCopy(submitError));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (onboardingFlow) {
      const fullName = hireName.trim();
      const roleTitle = hireRoleTitle.trim();
      const department = hireDepartment.trim();
      const location = hireLocation.trim();
      const managerId = hireManagerId.trim().toUpperCase();
      if (fullName.length < 2) {
        setError("Enter the new hire's full name (at least 2 characters).");
        return;
      }
      if (roleTitle.length < 2) {
        setError("Enter the role title (at least 2 characters).");
        return;
      }
      if (department.length < 2) {
        setError("Enter the department (at least 2 characters).");
        return;
      }
      if (location.length < 2) {
        setError("Enter the work location (at least 2 characters).");
        return;
      }
      if (hireStartDate === "") {
        setError("Pick the employee's start date.");
        return;
      }
      if (managerId !== "" && !/^[A-Za-z0-9-]{2,40}$/.test(managerId)) {
        setError("Enter the manager's employee ID from the directory, for example E-1003.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const activeCaseId = caseId ?? (await openCase(issue.key)).caseId;
        await startRun({
          workflow,
          ticketKey: issue.key,
          caseId: activeCaseId,
          input: {
            fullName,
            roleTitle,
            department,
            location,
            startDate: hireStartDate,
            ...(managerId === "" ? {} : { managerId }),
            accessTier: hireAccessTier,
          },
        });
        onStarted();
      } catch (submitError) {
        setError(startErrorCopy(submitError));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (offboardingFlow) {
      const employeeId = offboardEmployeeId.trim().toUpperCase();
      const reason = offboardReason.trim();
      if (!/^[A-Za-z0-9-]{2,40}$/.test(employeeId)) {
        setError("Enter the leaver's employee ID from the directory, for example E-1005.");
        return;
      }
      if (offboardLastDay === "") {
        setError("Pick the employee's last day.");
        return;
      }
      if (reason.length < 2) {
        setError("Enter the offboarding reason (at least 2 characters).");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const activeCaseId = caseId ?? (await openCase(issue.key)).caseId;
        await startRun({
          workflow,
          ticketKey: issue.key,
          caseId: activeCaseId,
          input: { employeeId, lastDay: offboardLastDay, reason: reason.slice(0, 500) },
        });
        onStarted();
      } catch (submitError) {
        setError(startErrorCopy(submitError));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (screeningFlow) {
      const requisitionId = screeningRequisitionId.trim().toUpperCase();
      if (!/^[A-Za-z0-9-]{2,40}$/.test(requisitionId)) {
        setError("Enter the requisition ID from the ATS, for example REQ-2001.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const activeCaseId = caseId ?? (await openCase(issue.key)).caseId;
        await startRun({
          workflow,
          ticketKey: issue.key,
          caseId: activeCaseId,
          input: { requisitionId },
        });
        onStarted();
      } catch (submitError) {
        setError(startErrorCopy(submitError));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (hrHelpFlow) {
      const question = hrHelpQuestion.trim();
      if (question.length < 5) {
        setError("Enter the employee question (at least 5 characters).");
        return;
      }
      if (question.length > 2000) {
        setError("Keep the question under 2000 characters.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const activeCaseId = caseId ?? (await openCase(issue.key)).caseId;
        await startRun({
          workflow,
          ticketKey: issue.key,
          caseId: activeCaseId,
          input: { question },
        });
        onStarted();
      } catch (submitError) {
        setError(startErrorCopy(submitError));
      } finally {
        setBusy(false);
      }
      return;
    }
    const repo = repository.trim();
    if (repositoryOptional ? repo !== "" && !isValidRepository(repo) : !isValidRepository(repo)) {
      setError("Choose the repository as owner/name, for example acme/app.");
      return;
    }
    if (accessibilityFlow && !isValidHttpUrl(targetUrl.trim())) {
      setError("Enter the site to audit as a full URL, for example https://app.example.com.");
      return;
    }
    const trimmedNumber = pullNumber.trim();
    const parsedNumber =
      repositoryOptional || accessibilityFlow || trimmedNumber === "" ? null : Number(trimmedNumber);
    if (parsedNumber !== null && (!Number.isInteger(parsedNumber) || parsedNumber <= 0)) {
      setError("The pull request number must be a positive whole number.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const activeCaseId = caseId ?? (await openCase(issue.key)).caseId;
      await startRun({
        workflow,
        ticketKey: issue.key,
        caseId: activeCaseId,
        input: accessibilityFlow
          ? { repository: repo, targetUrl: targetUrl.trim() }
          : dependenciesFlow
            ? repo === ""
              ? {}
              : { repository: repo }
            : repositoryOptional
              ? {
                  ticketKey: issue.key,
                  ticketSummary: issue.summary,
                  candidates: [{ key: issue.key, summary: issue.summary, status: issue.status }],
                  ...(repo === "" ? {} : { repository: repo }),
                }
              : parsedNumber === null
                ? { repository: repo }
                : { repository: repo, prNumber: parsedNumber },
      });
      onStarted();
    } catch (submitError) {
      setError(startErrorCopy(submitError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="start-run-card" onSubmit={(event) => void submit(event)}>
      <h3>Start a run</h3>
      <p className="step-summary">
        Runs pause at every checkpoint for your review — nothing is posted without a decision.
      </p>
      {caseId === null && (
        <p className="step-summary">
          Starting the run will open (or reuse) this ticket's case record automatically.
        </p>
      )}
      <label className="field-row">
        <span>Workflow</span>
        <select
          value={workflow}
          onChange={(event) => {
            setWorkflow(event.target.value);
            setError(null);
          }}
        >
          {options.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {issuesFlow ? (
        <p className="step-summary">
          Issue Resolution: pick the bug ticket, review the analysis, approve the fix, then open the
          Draft PR. The repository defaults to the server allowlist when left empty.
        </p>
      ) : null}
      {featuresFlow ? (
        <p className="step-summary">
          Feature Implementation: pick the feature ticket, plan the scope, review the planned
          changes, then open the Draft PR. The repository defaults to the server allowlist when
          left empty.
        </p>
      ) : null}
      {dependenciesFlow ? (
        <p className="step-summary">
          Dependency Update: scan the manifest, group the bumps, review the diffs and validation
          results, then open one Draft PR per group. The repository defaults to the server
          allowlist when left empty.
        </p>
      ) : null}
      {accessibilityFlow ? (
        <p className="step-summary">
          Accessibility Audit: crawl the routes, review the violations, apply the fixes, then
          re-scan — the fix PR opens only when no critical violation stays open. Enter the deployed
          site URL to audit.
        </p>
      ) : null}
      {vendorsFlow ? (
        <p className="step-summary">
          Vendor Onboarding: collect the documents, verify the checks against the vendor registry,
          score the risk, approve the chain, then create the master record — creation is idempotent
          by tax ID.
        </p>
      ) : null}
      {leaveFlow ? (
        <p className="step-summary">
          Leave Request: intake the request, run the working-day and balance policy check, approve,
          then book the calendar entry — booking is idempotent per request.
        </p>
      ) : null}
      {onboardingFlow ? (
        <p className="step-summary">
          New-Hire Onboarding: collect the paperwork, verify the checks against the directory, score
          the access risk, approve the signer chain, then provision the employee — provisioning is
          idempotent by employee ID.
        </p>
      ) : null}
      {offboardingFlow ? (
        <p className="step-summary">
          Employee Offboarding: intake the leaver, audit the per-system blast radius, approve each
          high-blast revocation, revoke access system by system, then attest the case close — both
          side effects are idempotent.
        </p>
      ) : null}
      {screeningFlow ? (
        <p className="step-summary">
          Candidate Screening: frame the weighted rubric, screen the candidates with citations and
          guardrail flags, review the shortlist, then schedule the interviews — scheduling is
          idempotent per candidate and requisition.
        </p>
      ) : null}
      {hrHelpFlow ? (
        <p className="step-summary">
          HR Help: intake the question, retrieve the policy passages, draft a cited answer, get the
          people-partner approval, then record the answer — sending is idempotent per case and
          ticket.
        </p>
      ) : null}
      {!vendorsFlow &&
        !leaveFlow &&
        !onboardingFlow &&
        !offboardingFlow &&
        !screeningFlow &&
        !hrHelpFlow && (
        <label className="field-row">
          <span>{repositoryOptional ? "Repository (optional)" : "Repository"}</span>
          {repositoriesFailed ? (
            <input
              type="text"
              value={repository}
              placeholder="owner/repository"
              onChange={(event) => setRepository(event.target.value)}
            />
          ) : (
            <select
              value={repository}
              onChange={(event) => {
                setRepository(event.target.value);
                setPullNumber("");
                setError(null);
              }}
            >
              <option value="">
                {repositories === null
                  ? "Loading repositories…"
                  : repositoryOptional
                    ? "Server default (allowlist)"
                    : "Select a repository…"}
              </option>
              {(repositories ?? []).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          )}
        </label>
      )}
      {repositoriesFailed && (
        <p className="step-summary">
          Repositories could not be loaded from GitHub — type owner/name, or check the
          token in Settings → GitHub accounts.
        </p>
      )}
      {!repositoriesFailed && repositories !== null && repositories.length === 0 && (
        <p className="step-summary">
          No repositories were found for this GitHub account — check the token's access
          in Settings → GitHub accounts.
        </p>
      )}
      {accessibilityFlow && (
        <label className="field-row">
          <span>Site URL</span>
          <input
            type="text"
            value={targetUrl}
            placeholder="https://app.example.com"
            onChange={(event) => setTargetUrl(event.target.value)}
          />
        </label>
      )}
      {vendorsFlow && (
        <>
          <label className="field-row">
            <span>Vendor name</span>
            <input
              type="text"
              value={vendorName}
              placeholder="Northwind Supply Limited"
              onChange={(event) => setVendorName(event.target.value)}
            />
          </label>
          <label className="field-row">
            <span>Tax ID</span>
            <input
              type="text"
              value={vendorTaxId}
              placeholder="GB812345678"
              onChange={(event) => setVendorTaxId(event.target.value)}
            />
          </label>
          <label className="field-row">
            <span>Country (ISO code)</span>
            <input
              type="text"
              value={vendorCountry}
              maxLength={2}
              placeholder="GB"
              onChange={(event) => setVendorCountry(event.target.value)}
            />
          </label>
          <label className="field-row">
            <span>Requestor</span>
            <input
              type="text"
              value={vendorRequestor}
              placeholder="procurement@acme.test"
              onChange={(event) => setVendorRequestor(event.target.value)}
            />
          </label>
        </>
      )}
      {leaveFlow && (
        <>
          <label className="field-row">
            <span>Employee ID</span>
            <input
              type="text"
              value={leaveEmployeeId}
              placeholder="E-1001"
              onChange={(event) => {
                setLeaveEmployeeId(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="field-row">
            <span>Leave type</span>
            <select
              value={leaveType}
              onChange={(event) => {
                setLeaveType(event.target.value);
                setError(null);
              }}
            >
              <option value="annual">Annual</option>
              <option value="sick">Sick</option>
              <option value="unpaid">Unpaid</option>
              <option value="parental">Parental</option>
            </select>
          </label>
          <label className="field-row">
            <span>First day</span>
            <input
              type="date"
              value={leaveStart}
              onChange={(event) => {
                setLeaveStart(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="field-row">
            <span>Last day</span>
            <input
              type="date"
              value={leaveEnd}
              onChange={(event) => {
                setLeaveEnd(event.target.value);
                setError(null);
              }}
            />
          </label>
        </>
      )}
      {onboardingFlow && (
        <>
          <label className="field-row">
            <span>Full name</span>
            <input
              type="text"
              value={hireName}
              placeholder="Priya Raman"
              onChange={(event) => {
                setHireName(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="field-row">
            <span>Role title</span>
            <input
              type="text"
              value={hireRoleTitle}
              placeholder="Backend Engineer"
              onChange={(event) => {
                setHireRoleTitle(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="field-row">
            <span>Department</span>
            <input
              type="text"
              value={hireDepartment}
              placeholder="Engineering"
              onChange={(event) => {
                setHireDepartment(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="field-row">
            <span>Location</span>
            <input
              type="text"
              value={hireLocation}
              placeholder="London, UK"
              onChange={(event) => {
                setHireLocation(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="field-row">
            <span>Start date</span>
            <input
              type="date"
              value={hireStartDate}
              onChange={(event) => {
                setHireStartDate(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="field-row">
            <span>Manager ID (optional)</span>
            <input
              type="text"
              value={hireManagerId}
              placeholder="E-1003"
              onChange={(event) => {
                setHireManagerId(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="field-row">
            <span>Access tier</span>
            <select
              value={hireAccessTier}
              onChange={(event) => {
                setHireAccessTier(event.target.value);
                setError(null);
              }}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        </>
      )}
      {offboardingFlow && (
        <>
          <label className="field-row">
            <span>Employee ID</span>
            <input
              type="text"
              value={offboardEmployeeId}
              placeholder="E-1005"
              onChange={(event) => {
                setOffboardEmployeeId(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="field-row">
            <span>Last day</span>
            <input
              type="date"
              value={offboardLastDay}
              onChange={(event) => {
                setOffboardLastDay(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="field-row">
            <span>Reason</span>
            <input
              type="text"
              value={offboardReason}
              placeholder="Resignation — moving on"
              onChange={(event) => {
                setOffboardReason(event.target.value);
                setError(null);
              }}
            />
          </label>
        </>
      )}
      {screeningFlow && (
        <label className="field-row">
          <span>Requisition ID</span>
          <input
            type="text"
            value={screeningRequisitionId}
            placeholder="REQ-2001"
            onChange={(event) => {
              setScreeningRequisitionId(event.target.value);
              setError(null);
            }}
          />
        </label>
      )}
      {hrHelpFlow && (
        <label className="field-row">
          <span>Employee question</span>
          <input
            type="text"
            value={hrHelpQuestion}
            placeholder="How much parental leave can a primary caregiver take?"
            onChange={(event) => {
              setHrHelpQuestion(event.target.value);
              setError(null);
            }}
          />
        </label>
      )}
      {reviewFlow && (
        <label className="field-row">
          <span>GitHub account</span>
          <select
            value={accountId}
            disabled={accounts === null || accounts.length === 0}
            onChange={(event) => {
              setAccountId(event.target.value);
              setPullNumber("");
              setError(null);
            }}
          >
            <option value="">
              {accounts === null
                ? "Loading accounts…"
                : accounts.length === 0
                  ? "No accounts configured"
                  : "Server default token"}
            </option>
            {accounts?.map((account) => (
              <option key={account.id} value={account.id}>
                {`${account.label}${account.isDefault ? " (default)" : ""}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {reviewFlow && accounts !== null && accounts.length === 0 && !accountsFailed && (
        <p className="step-summary">
          No GitHub accounts are set up yet — add one in Settings first, then pick it here.
        </p>
      )}
      {reviewFlow && (
        <label className="field-row">
          <span>Pull request (optional)</span>
          <select
            value={pullNumber}
            onChange={(event) => {
              setPullNumber(event.target.value);
              setError(null);
            }}
          >
            <option value="">Let the run select one</option>
            {pullRequests.map((item) => (
              <option key={item.number} value={String(item.number)}>
                {`#${item.number} — ${item.title}${item.draft ? " (draft)" : ""}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {pullRequestsNote !== null && <p className="step-summary">{pullRequestsNote}</p>}
      {error !== null && (
        <p className="run-action-error" role="alert">
          {error}
        </p>
      )}
      <div className="run-actions">
        <button type="submit" className="approve" disabled={busy}>
          {busy ? "Starting…" : "Start run"}
        </button>
      </div>
    </form>
  );
}
