/**
 * HR lane surfaces for the runs console. Each surface mirrors the artifact
 * contract of the matching Mastra lane in `src/mastra/agents/*`: leave
 * (intake -> policy-check -> approve -> apply) first, with the onboarding,
 * offboarding, screening and hr-help lanes following the same layout.
 */

import { useState } from "react";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusClass(status: string): string {
  if (status === "pass") return "status-pass";
  if (status === "flag") return "status-flag";
  if (status === "fail") return "status-fail";
  return "status-neutral";
}

/* ---------------------------------------------------------------- leave */

export type LeaveCheckView = {
  id: string;
  label: string;
  status: string;
  detail: string;
};

export type LeaveIntakeView = {
  requestId: string;
  employeeLabel: string;
  department: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  balanceDays: number | null;
  note: string | null;
  summary: string;
};

export type LeavePolicyView = {
  requestId: string;
  employeeLabel: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  workingDays: number | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
  checks: LeaveCheckView[];
  overlaps: Array<{ requestId: string; startDate: string; endDate: string }>;
  blackoutHits: string[];
  verdict: string;
  summary: string;
  confidence: number | null;
};

export type LeaveApproveView = {
  requestId: string;
  employeeLabel: string;
  approverRole: string;
  approverLabel: string;
  slaHours: number | null;
  state: string;
  summary: string;
};

export type LeaveApplyView = {
  entryId: string;
  requestId: string;
  employeeLabel: string;
  startDate: string;
  endDate: string;
  workingDays: number | null;
  idempotencyKey: string;
  existing: { entryId: string; createdAt: string } | null;
  summary: string;
};

export type LeaveReceiptView = {
  entryId: string;
  requestId: string;
  created: boolean;
  registryRef: string;
};

function leaveChecks(value: unknown): LeaveCheckView[] {
  const checks: LeaveCheckView[] = [];
  if (!Array.isArray(value)) return checks;
  for (const item of value) {
    const record = asRecord(item);
    if (record === null) continue;
    const id = asString(record["id"]);
    if (id === null) continue;
    checks.push({
      id,
      label: asString(record["label"]) ?? id,
      status: asString(record["status"]) ?? "neutral",
      detail: asString(record["detail"]) ?? "",
    });
  }
  return checks;
}

export function parseLeaveIntake(artifact: Record<string, unknown>): LeaveIntakeView | null {
  const requestId = asString(artifact["requestId"]);
  const employeeLabel = asString(artifact["employeeLabel"]);
  if (requestId === null || employeeLabel === null) return null;
  return {
    requestId,
    employeeLabel,
    department: asString(artifact["department"]) ?? "",
    leaveType: asString(artifact["leaveType"]) ?? "",
    startDate: asString(artifact["startDate"]) ?? "",
    endDate: asString(artifact["endDate"]) ?? "",
    balanceDays: asNumber(artifact["balanceDays"]),
    note: asString(artifact["note"]),
    summary: asString(artifact["summary"]) ?? "",
  };
}

export function parseLeavePolicy(artifact: Record<string, unknown>): LeavePolicyView | null {
  const requestId = asString(artifact["requestId"]);
  if (requestId === null) return null;
  const overlaps: Array<{ requestId: string; startDate: string; endDate: string }> = [];
  if (Array.isArray(artifact["overlaps"])) {
    for (const item of artifact["overlaps"]) {
      const record = asRecord(item);
      const overlapId = record === null ? null : asString(record["requestId"]);
      if (record === null || overlapId === null) continue;
      overlaps.push({
        requestId: overlapId,
        startDate: asString(record["startDate"]) ?? "",
        endDate: asString(record["endDate"]) ?? "",
      });
    }
  }
  const blackoutHits: string[] = [];
  if (Array.isArray(artifact["blackoutHits"])) {
    for (const item of artifact["blackoutHits"]) {
      const text = asString(item);
      if (text !== null) blackoutHits.push(text);
    }
  }
  return {
    requestId,
    employeeLabel: asString(artifact["employeeLabel"]) ?? "",
    leaveType: asString(artifact["leaveType"]) ?? "",
    startDate: asString(artifact["startDate"]) ?? "",
    endDate: asString(artifact["endDate"]) ?? "",
    workingDays: asNumber(artifact["workingDays"]),
    balanceBefore: asNumber(artifact["balanceBefore"]),
    balanceAfter: asNumber(artifact["balanceAfter"]),
    checks: leaveChecks(artifact["checks"]),
    overlaps,
    blackoutHits,
    verdict: asString(artifact["verdict"]) ?? "ok",
    summary: asString(artifact["summary"]) ?? "",
    confidence: asNumber(artifact["confidence"]),
  };
}

export function parseLeaveApprove(artifact: Record<string, unknown>): LeaveApproveView | null {
  const requestId = asString(artifact["requestId"]);
  if (requestId === null) return null;
  return {
    requestId,
    employeeLabel: asString(artifact["employeeLabel"]) ?? "",
    approverRole: asString(artifact["approverRole"]) ?? "",
    approverLabel: asString(artifact["approverLabel"]) ?? "",
    slaHours: asNumber(artifact["slaHours"]),
    state: asString(artifact["state"]) ?? "pending",
    summary: asString(artifact["summary"]) ?? "",
  };
}

export function parseLeaveApply(artifact: Record<string, unknown>): LeaveApplyView | null {
  const request = asRecord(artifact["request"]);
  if (request === null) return null;
  const entryId = asString(request["entryId"]);
  const requestId = asString(request["requestId"]);
  if (entryId === null || requestId === null) return null;
  const existingRecord = asRecord(artifact["existing"]);
  const existingEntryId = existingRecord === null ? null : asString(existingRecord["entryId"]);
  return {
    entryId,
    requestId,
    employeeLabel: asString(request["employeeLabel"]) ?? "",
    startDate: asString(request["startDate"]) ?? "",
    endDate: asString(request["endDate"]) ?? "",
    workingDays: asNumber(request["workingDays"]),
    idempotencyKey: asString(artifact["idempotencyKey"]) ?? "",
    existing:
      existingRecord === null || existingEntryId === null
        ? null
        : { entryId: existingEntryId, createdAt: asString(existingRecord["createdAt"]) ?? "" },
    summary: asString(artifact["summary"]) ?? "",
  };
}

export function parseLeaveReceipt(value: unknown): LeaveReceiptView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const entryId = asString(record["entryId"]);
  const requestId = asString(record["requestId"]);
  if (entryId === null || requestId === null) return null;
  return {
    entryId,
    requestId,
    created: record["created"] === true,
    registryRef: asString(record["registryRef"]) ?? "",
  };
}

export function LeaveIntakeSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const view = parseLeaveIntake(artifact);
  if (view === null) {
    return <p className="step-empty">The intake artifact is not readable yet.</p>;
  }
  return (
    <div className="hr-surface">
      <div className="hr-head">
        <span className="hr-status-pill status-neutral">{view.leaveType}</span>
        <strong>{view.employeeLabel}</strong>
        <span className="hr-meta">{view.department}</span>
        <span className="hr-meta">{`${view.startDate} → ${view.endDate}`}</span>
      </div>
      <dl className="hr-kv">
        <div>
          <dt>Request</dt>
          <dd>{view.requestId}</dd>
        </div>
        <div>
          <dt>Balance</dt>
          <dd>{view.balanceDays === null ? "—" : `${view.balanceDays} day(s) available`}</dd>
        </div>
      </dl>
      {view.note !== null && <p className="step-summary">{`Note: ${view.note}`}</p>}
      <p className="step-summary">{view.summary}</p>
    </div>
  );
}

export function LeavePolicySurface({ artifact }: { artifact: Record<string, unknown> }) {
  const view = parseLeavePolicy(artifact);
  if (view === null) {
    return <p className="step-empty">The policy-check artifact is not readable yet.</p>;
  }
  return (
    <div className="hr-surface">
      <div className="hr-head">
        <span
          className={`hr-status-pill ${
            view.verdict === "ok" ? "status-pass" : "status-flag"
          }`}
        >
          {view.verdict === "ok" ? "policy ok" : "exception required"}
        </span>
        <strong>{view.employeeLabel}</strong>
        <span className="hr-meta">{`${view.startDate} → ${view.endDate}`}</span>
        <span className="hr-meta">{`${view.workingDays ?? "—"} working day(s)`}</span>
        <span className="hr-meta">
          {`balance ${view.balanceBefore ?? "—"} → ${view.balanceAfter ?? "—"}`}
        </span>
      </div>
      <ul className="hr-check-list">
        {view.checks.map((check) => (
          <li key={check.id} className={`hr-check-row ${statusClass(check.status)}`}>
            <div className="hr-check-head">
              <span className={`hr-status-pill ${statusClass(check.status)}`}>{check.status}</span>
              <strong>{check.label}</strong>
            </div>
            <p className="hr-meta">{check.detail}</p>
          </li>
        ))}
      </ul>
      {view.overlaps.length > 0 && (
        <p className="step-summary">
          {`Overlaps: ${view.overlaps
            .map((overlap) => `${overlap.requestId} (${overlap.startDate} → ${overlap.endDate})`)
            .join(", ")}`}
        </p>
      )}
      {view.blackoutHits.length > 0 && (
        <p className="step-summary">{`Blackout: ${view.blackoutHits.join(", ")}`}</p>
      )}
      <p className="step-summary">{view.summary}</p>
      {view.confidence !== null && (
        <p className="hr-meta">{`Advisor confidence ${Math.round(view.confidence * 100)}%`}</p>
      )}
    </div>
  );
}

export function LeaveApproveSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const view = parseLeaveApprove(artifact);
  if (view === null) {
    return <p className="step-empty">The approval artifact is not readable yet.</p>;
  }
  return (
    <div className="hr-surface">
      <div className="hr-head">
        <span className={`hr-status-pill ${view.state === "approved" ? "status-pass" : "status-flag"}`}>
          {view.state}
        </span>
        <strong>{view.approverLabel}</strong>
        <span className="hr-meta">{view.approverRole}</span>
        {view.slaHours !== null && <span className="hr-meta">{`target ${view.slaHours}h`}</span>}
      </div>
      <dl className="hr-kv">
        <div>
          <dt>Request</dt>
          <dd>{view.requestId}</dd>
        </div>
        <div>
          <dt>Requester</dt>
          <dd>{view.employeeLabel}</dd>
        </div>
      </dl>
      <p className="step-summary">{view.summary}</p>
    </div>
  );
}

export function LeaveApplySurface({
  artifact,
  receipt,
}: {
  artifact: Record<string, unknown>;
  receipt: LeaveReceiptView | null;
}) {
  const view = parseLeaveApply(artifact);
  if (view === null) {
    return <p className="step-empty">The apply artifact is not readable yet.</p>;
  }
  return (
    <div className="hr-surface">
      <div className="hr-head">
        <span className={`hr-status-pill ${receipt === null ? "status-neutral" : "status-pass"}`}>
          {receipt === null ? "preview" : receipt.created ? "booked" : "replayed"}
        </span>
        <strong>{view.entryId}</strong>
        <span className="hr-meta">{`${view.startDate} → ${view.endDate}`}</span>
        <span className="hr-meta">{`${view.workingDays ?? "—"} working day(s)`}</span>
      </div>
      <dl className="hr-kv">
        <div>
          <dt>Request</dt>
          <dd>{view.requestId}</dd>
        </div>
        <div>
          <dt>Requester</dt>
          <dd>{view.employeeLabel}</dd>
        </div>
        <div>
          <dt>Idempotency key</dt>
          <dd>{view.idempotencyKey}</dd>
        </div>
      </dl>
      {view.existing !== null && (
        <p className="hr-callout">
          {`This request is already booked as ${view.existing.entryId} (${view.existing.createdAt}); the apply replays idempotently.`}
        </p>
      )}
      <p className="step-summary">{view.summary}</p>
      {receipt !== null && (
        <p className="hr-receipt">
          {`Receipt: ${receipt.entryId} · ${receipt.created ? "created" : "replayed"} · ${receipt.registryRef}`}
        </p>
      )}
    </div>
  );
}

/* --------------------------------------------------------- onboarding */

export type OnboardingDocumentView = {
  id: string;
  label: string;
  required: boolean;
  status: string;
  fileName: string | null;
  waivedReason: string | null;
  nudges: number;
  lastNudgedAt: string | null;
};

const ONBOARDING_DOCUMENT_LABELS: Record<string, string> = {
  missing: "Missing",
  pending: "Pending",
  received: "Received",
  waived: "Waived",
};

function onboardingDocuments(value: unknown): OnboardingDocumentView[] {
  const documents: OnboardingDocumentView[] = [];
  if (!Array.isArray(value)) return documents;
  for (const item of value) {
    const record = asRecord(item);
    const id = record === null ? null : asString(record["id"]);
    if (record === null || id === null) continue;
    documents.push({
      id,
      label: asString(record["label"]) ?? id,
      required: record["required"] !== false,
      status: asString(record["status"]) ?? "missing",
      fileName: asString(record["fileName"]),
      waivedReason: asString(record["waivedReason"]),
      nudges: asNumber(record["nudges"]) ?? 0,
      lastNudgedAt: asString(record["lastNudgedAt"]),
    });
  }
  return documents;
}

export type OnboardingCollectView = {
  onboardingId: string;
  candidateLabel: string;
  roleTitle: string;
  department: string;
  location: string;
  startDate: string;
  managerId: string | null;
  accessTier: string;
  documents: OnboardingDocumentView[];
  totals: {
    documents: number;
    required: number;
    received: number;
    waived: number;
    outstanding: number;
  };
  returnedNote: string | null;
  summary: string;
};

export type OnboardingCollectDraft = {
  documents: OnboardingDocumentView[];
  returnedNote: string | null;
};

export function onboardingDocumentTotals(
  documents: OnboardingDocumentView[],
): OnboardingCollectView["totals"] {
  const required = documents.filter((document) => document.required);
  const received = required.filter((document) => document.status === "received").length;
  const waived = required.filter((document) => document.status === "waived").length;
  return {
    documents: documents.length,
    required: required.length,
    received,
    waived,
    outstanding: required.length - received - waived,
  };
}

export function parseOnboardingCollect(
  artifact: Record<string, unknown>,
): OnboardingCollectView | null {
  const onboardingId = asString(artifact["onboardingId"]);
  const candidateLabel = asString(artifact["candidateLabel"]);
  if (onboardingId === null || candidateLabel === null) return null;
  const documents = onboardingDocuments(artifact["documents"]);
  const totals = asRecord(artifact["totals"]);
  return {
    onboardingId,
    candidateLabel,
    roleTitle: asString(artifact["roleTitle"]) ?? "",
    department: asString(artifact["department"]) ?? "",
    location: asString(artifact["location"]) ?? "",
    startDate: asString(artifact["startDate"]) ?? "",
    managerId: asString(artifact["managerId"]),
    accessTier: asString(artifact["accessTier"]) ?? "",
    documents,
    totals: {
      documents: asNumber(totals?.["documents"]) ?? documents.length,
      required: asNumber(totals?.["required"]) ?? documents.filter((item) => item.required).length,
      received:
        asNumber(totals?.["received"]) ??
        documents.filter((item) => item.status === "received").length,
      waived:
        asNumber(totals?.["waived"]) ?? documents.filter((item) => item.status === "waived").length,
      outstanding:
        asNumber(totals?.["outstanding"]) ??
        documents.filter(
          (item) => item.required && item.status !== "received" && item.status !== "waived",
        ).length,
    },
    returnedNote: asString(artifact["returnedNote"]),
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type OnboardingCheckView = {
  id: string;
  label: string;
  status: string;
  source: string;
  checkedAt: string;
  detail: string;
};

export type OnboardingCandidateView = {
  employeeId: string;
  label: string;
  matchScore: number;
  matchedOn: string[];
};

export type OnboardingVerifyView = {
  onboardingId: string;
  candidateLabel: string;
  checks: OnboardingCheckView[];
  candidates: OnboardingCandidateView[];
  manualReview: { required: boolean; items: Array<{ checkId: string; reason: string }> };
  resolutions: Array<{ checkId: string; note: string }>;
  summary: string;
  confidence: number | null;
};

export type OnboardingVerifyDraft = { resolutions: Record<string, string> };

function onboardingStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function onboardingChecks(value: unknown): OnboardingCheckView[] {
  const checks: OnboardingCheckView[] = [];
  if (!Array.isArray(value)) return checks;
  for (const item of value) {
    const record = asRecord(item);
    const id = record === null ? null : asString(record["id"]);
    if (record === null || id === null) continue;
    checks.push({
      id,
      label: asString(record["label"]) ?? id,
      status: asString(record["status"]) ?? "neutral",
      source: asString(record["source"]) ?? "",
      checkedAt: asString(record["checkedAt"]) ?? "",
      detail: asString(record["detail"]) ?? "",
    });
  }
  return checks;
}

export function parseOnboardingVerify(
  artifact: Record<string, unknown>,
): OnboardingVerifyView | null {
  const onboardingId = asString(artifact["onboardingId"]);
  if (onboardingId === null) return null;
  const candidates: OnboardingCandidateView[] = [];
  if (Array.isArray(artifact["candidates"])) {
    for (const item of artifact["candidates"]) {
      const record = asRecord(item);
      const employeeId = record === null ? null : asString(record["employeeId"]);
      if (record === null || employeeId === null) continue;
      candidates.push({
        employeeId,
        label: asString(record["label"]) ?? "",
        matchScore: asNumber(record["matchScore"]) ?? 0,
        matchedOn: onboardingStrings(record["matchedOn"]),
      });
    }
  }
  const manualReview = asRecord(artifact["manualReview"]);
  const items: Array<{ checkId: string; reason: string }> = [];
  if (Array.isArray(manualReview?.["items"])) {
    for (const item of manualReview["items"]) {
      const record = asRecord(item);
      const checkId = record === null ? null : asString(record["checkId"]);
      if (record === null || checkId === null) continue;
      items.push({ checkId, reason: asString(record["reason"]) ?? "" });
    }
  }
  const resolutions: Array<{ checkId: string; note: string }> = [];
  if (Array.isArray(artifact["resolutions"])) {
    for (const item of artifact["resolutions"]) {
      const record = asRecord(item);
      const checkId = record === null ? null : asString(record["checkId"]);
      if (record === null || checkId === null) continue;
      resolutions.push({ checkId, note: asString(record["note"]) ?? "" });
    }
  }
  return {
    onboardingId,
    candidateLabel: asString(artifact["candidateLabel"]) ?? "",
    checks: onboardingChecks(artifact["checks"]),
    candidates,
    manualReview: { required: manualReview?.["required"] === true, items },
    resolutions,
    summary: asString(artifact["summary"]) ?? "",
    confidence: asNumber(artifact["confidence"]),
  };
}

export type OnboardingFactorView = { id: string; label: string; points: number; detail: string };

export type OnboardingMatrixRowView = { tier: string; requiredSigners: string[] };

export type OnboardingRiskView = {
  onboardingId: string;
  candidateLabel: string;
  roleTitle: string;
  department: string;
  score: number;
  tier: string;
  factors: OnboardingFactorView[];
  requiredSigners: string[];
  matrix: OnboardingMatrixRowView[];
  summary: string;
  confidence: number | null;
};

const ONBOARDING_ROLE_LABELS: Record<string, string> = {
  "people-partner": "People Partner",
  "department-head": "Department Head",
  "people-ops-director": "People Ops Director",
};

export function onboardingRoleLabel(role: string): string {
  return ONBOARDING_ROLE_LABELS[role] ?? role;
}

export function parseOnboardingRisk(artifact: Record<string, unknown>): OnboardingRiskView | null {
  const onboardingId = asString(artifact["onboardingId"]);
  const tier = asString(artifact["tier"]);
  if (onboardingId === null || tier === null) return null;
  const factors: OnboardingFactorView[] = [];
  if (Array.isArray(artifact["factors"])) {
    for (const item of artifact["factors"]) {
      const record = asRecord(item);
      const id = record === null ? null : asString(record["id"]);
      if (record === null || id === null) continue;
      factors.push({
        id,
        label: asString(record["label"]) ?? id,
        points: asNumber(record["points"]) ?? 0,
        detail: asString(record["detail"]) ?? "",
      });
    }
  }
  const matrix: OnboardingMatrixRowView[] = [];
  if (Array.isArray(artifact["matrix"])) {
    for (const item of artifact["matrix"]) {
      const record = asRecord(item);
      const rowTier = record === null ? null : asString(record["tier"]);
      if (record === null || rowTier === null) continue;
      matrix.push({ tier: rowTier, requiredSigners: onboardingStrings(record["requiredSigners"]) });
    }
  }
  return {
    onboardingId,
    candidateLabel: asString(artifact["candidateLabel"]) ?? "",
    roleTitle: asString(artifact["roleTitle"]) ?? "",
    department: asString(artifact["department"]) ?? "",
    score: asNumber(artifact["score"]) ?? 0,
    tier,
    factors,
    requiredSigners: onboardingStrings(artifact["requiredSigners"]),
    matrix,
    summary: asString(artifact["summary"]) ?? "",
    confidence: asNumber(artifact["confidence"]),
  };
}

export type OnboardingChainEntryView = {
  role: string;
  name: string;
  state: string;
  requestedAt: string;
  actedAt: string | null;
  note: string | null;
  nudges: number;
  lastNudgedAt: string | null;
};

export type OnboardingCommentView = { author: string; at: string; body: string };

export type OnboardingApproveView = {
  onboardingId: string;
  candidateLabel: string;
  tier: string;
  slaHours: number | null;
  chain: OnboardingChainEntryView[];
  comments: OnboardingCommentView[];
  allApproved: boolean;
  summary: string;
};

export type OnboardingApproveDraft = {
  chain: OnboardingChainEntryView[];
  comments: OnboardingCommentView[];
};

export function parseOnboardingApprove(
  artifact: Record<string, unknown>,
): OnboardingApproveView | null {
  const onboardingId = asString(artifact["onboardingId"]);
  if (onboardingId === null) return null;
  const chain: OnboardingChainEntryView[] = [];
  if (Array.isArray(artifact["chain"])) {
    for (const item of artifact["chain"]) {
      const record = asRecord(item);
      const role = record === null ? null : asString(record["role"]);
      if (record === null || role === null) continue;
      chain.push({
        role,
        name: asString(record["name"]) ?? onboardingRoleLabel(role),
        state: asString(record["state"]) ?? "pending",
        requestedAt: asString(record["requestedAt"]) ?? "",
        actedAt: asString(record["actedAt"]),
        note: asString(record["note"]),
        nudges: asNumber(record["nudges"]) ?? 0,
        lastNudgedAt: asString(record["lastNudgedAt"]),
      });
    }
  }
  const comments: OnboardingCommentView[] = [];
  if (Array.isArray(artifact["comments"])) {
    for (const item of artifact["comments"]) {
      const record = asRecord(item);
      if (record === null) continue;
      comments.push({
        author: asString(record["author"]) ?? "",
        at: asString(record["at"]) ?? "",
        body: asString(record["body"]) ?? "",
      });
    }
  }
  return {
    onboardingId,
    candidateLabel: asString(artifact["candidateLabel"]) ?? "",
    tier: asString(artifact["tier"]) ?? "low",
    slaHours: asNumber(artifact["slaHours"]),
    chain,
    comments,
    allApproved: artifact["allApproved"] === true,
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type OnboardingEmployeeView = {
  employeeId: string;
  label: string;
  roleTitle: string;
  department: string;
  location: string;
  managerId: string | null;
  accessTier: string;
  effectiveDate: string;
};

export type OnboardingProvisionView = {
  employee: OnboardingEmployeeView;
  accounts: string[];
  equipmentTicket: { id: string; item: string; location: string } | null;
  payrollEnrollment: { id: string; payGroup: string } | null;
  idempotencyKey: string;
  existing: { employeeId: string; createdAt: string } | null;
  summary: string;
};

export type OnboardingReceiptView = {
  employeeId: string;
  label: string;
  department: string;
  accessTier: string;
  effectiveDate: string;
  accounts: string[];
  equipmentTicketId: string;
  payrollEnrollmentId: string;
  created: boolean;
  registryRef: string;
};

export function parseOnboardingProvision(
  artifact: Record<string, unknown>,
): OnboardingProvisionView | null {
  const employee = asRecord(artifact["employee"]);
  const employeeId = employee === null ? null : asString(employee["employeeId"]);
  if (employee === null || employeeId === null) return null;
  const equipment = asRecord(artifact["equipmentTicket"]);
  const equipmentId = equipment === null ? null : asString(equipment["id"]);
  const payroll = asRecord(artifact["payrollEnrollment"]);
  const payrollId = payroll === null ? null : asString(payroll["id"]);
  const existing = asRecord(artifact["existing"]);
  const existingId = existing === null ? null : asString(existing["employeeId"]);
  return {
    employee: {
      employeeId,
      label: asString(employee["label"]) ?? "",
      roleTitle: asString(employee["roleTitle"]) ?? "",
      department: asString(employee["department"]) ?? "",
      location: asString(employee["location"]) ?? "",
      managerId: asString(employee["managerId"]),
      accessTier: asString(employee["accessTier"]) ?? "",
      effectiveDate: asString(employee["effectiveDate"]) ?? "",
    },
    accounts: onboardingStrings(artifact["accounts"]),
    equipmentTicket:
      equipment === null || equipmentId === null
        ? null
        : {
            id: equipmentId,
            item: asString(equipment["item"]) ?? "",
            location: asString(equipment["location"]) ?? "",
          },
    payrollEnrollment:
      payroll === null || payrollId === null
        ? null
        : { id: payrollId, payGroup: asString(payroll["payGroup"]) ?? "" },
    idempotencyKey: asString(artifact["idempotencyKey"]) ?? "",
    existing:
      existing === null || existingId === null
        ? null
        : { employeeId: existingId, createdAt: asString(existing["createdAt"]) ?? "" },
    summary: asString(artifact["summary"]) ?? "",
  };
}

export function parseOnboardingReceipt(value: unknown): OnboardingReceiptView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const employeeId = asString(record["employeeId"]);
  if (employeeId === null) return null;
  return {
    employeeId,
    label: asString(record["label"]) ?? "",
    department: asString(record["department"]) ?? "",
    accessTier: asString(record["accessTier"]) ?? "",
    effectiveDate: asString(record["effectiveDate"]) ?? "",
    accounts: onboardingStrings(record["accounts"]),
    equipmentTicketId: asString(record["equipmentTicketId"]) ?? "",
    payrollEnrollmentId: asString(record["payrollEnrollmentId"]) ?? "",
    created: record["created"] === true,
    registryRef: asString(record["registryRef"]) ?? "",
  };
}

function onboardingInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part !== "");
  const first = parts[0]?.charAt(0) ?? "?";
  const last = parts.length > 1 ? parts[parts.length - 1]?.charAt(0) ?? "" : "";
  return `${first}${last}`.toUpperCase();
}

function onboardingSlaAgeHours(requestedAt: string): number | null {
  const parsed = Date.parse(requestedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 3_600_000));
}

/** Step 1 — the document checklist: uploads, waivers, nudges and totals. */
export function OnboardingCollectSurface({
  artifact,
  editable,
  draft,
  returnNote,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: OnboardingCollectDraft | null;
  returnNote: string | null;
  onChange: (draft: OnboardingCollectDraft) => void;
}) {
  const view = parseOnboardingCollect(artifact);
  if (view === null) {
    return <p className="step-empty">The document checklist is not readable yet.</p>;
  }
  const note = returnNote ?? view.returnedNote;
  const value: OnboardingCollectDraft = draft ?? {
    documents: view.documents.map((document) => ({ ...document })),
    returnedNote: note,
  };
  const totals = onboardingDocumentTotals(value.documents);
  const outstandingLabels = value.documents
    .filter(
      (document) =>
        document.required && document.status !== "received" && document.status !== "waived",
    )
    .map((document) => document.label);

  function setDocument(id: string, patch: Partial<OnboardingDocumentView>): void {
    onChange({
      documents: value.documents.map((document) =>
        document.id === id ? { ...document, ...patch } : document,
      ),
      returnedNote: value.returnedNote,
    });
  }

  function receiveFile(id: string, file: File | null): void {
    if (file === null) return;
    setDocument(id, { status: "received", fileName: file.name.slice(0, 200), waivedReason: null });
  }

  function nudge(id: string): void {
    const document = value.documents.find((item) => item.id === id);
    if (document === undefined) return;
    setDocument(id, { nudges: document.nudges + 1, lastNudgedAt: new Date().toISOString() });
  }

  return (
    <div className="vendors-collect-surface">
      <p className="step-summary">
        {`${view.candidateLabel} · ${view.roleTitle} · ${view.department} · starts ${view.startDate}`}
      </p>
      {note !== null && note.trim() !== "" && (
        <aside className="similar-callout vendors-returned-callout">
          <h4>Returned for rework</h4>
          <p>{note}</p>
        </aside>
      )}
      <div className="analysis-meta">
        <span className="file-count-badge">
          {`${totals.received} of ${totals.required} received`}
        </span>
        {totals.waived > 0 ? (
          <span className="file-count-badge">{`${totals.waived} waived`}</span>
        ) : null}
        <span className="file-count-badge">{`${totals.outstanding} outstanding`}</span>
        <span className={`vendors-tier-badge tier-${view.accessTier}`}>{view.accessTier}</span>
      </div>
      <p className="step-summary">{view.summary}</p>
      <ul className="vendors-doc-list">
        {value.documents.map((document) => (
          <li
            key={document.id}
            className={`vendors-doc-row status-${document.status}`}
            onDragOver={(event) => {
              if (editable) event.preventDefault();
            }}
            onDrop={(event) => {
              if (!editable) return;
              event.preventDefault();
              receiveFile(document.id, event.dataTransfer.files?.[0] ?? null);
            }}
          >
            <div className="vendors-doc-head">
              <strong>{document.label}</strong>
              <span className={`vendors-status-pill status-${document.status}`}>
                {ONBOARDING_DOCUMENT_LABELS[document.status] ?? document.status}
              </span>
              {!document.required && <span className="line-pill">optional</span>}
            </div>
            <p className="vendors-doc-meta">
              {document.fileName !== null && document.fileName !== ""
                ? `File: ${document.fileName}`
                : "No file attached"}
              {document.nudges > 0
                ? ` · nudged ${document.nudges}×${
                    document.lastNudgedAt !== null ? ` (${document.lastNudgedAt})` : ""
                  }`
                : ""}
            </p>
            {document.status === "waived" && (
              <label className="vendors-waive-editor">
                <span>Waiver reason</span>
                <input
                  type="text"
                  maxLength={500}
                  value={document.waivedReason ?? ""}
                  readOnly={!editable}
                  placeholder="Why is this document not required?"
                  onChange={(event) => setDocument(document.id, { waivedReason: event.target.value })}
                />
              </label>
            )}
            {editable && (
              <div className="vendors-doc-actions">
                <label className="vendors-upload">
                  <span>{document.status === "received" ? "Replace file" : "Upload"}</span>
                  <input
                    type="file"
                    className="sr-only"
                    aria-label={`Upload ${document.label}`}
                    onChange={(event) => {
                      receiveFile(document.id, event.target.files?.[0] ?? null);
                      event.target.value = "";
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setDocument(
                      document.id,
                      document.status === "waived"
                        ? { status: "missing", waivedReason: null }
                        : { status: "waived" },
                    )
                  }
                >
                  {document.status === "waived" ? "Un-waive" : "Waive"}
                </button>
                <button
                  type="button"
                  disabled={document.status === "received" || document.status === "waived"}
                  onClick={() => nudge(document.id)}
                >
                  Nudge requester
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {outstandingLabels.length > 0 && (
        <p className="run-action-error" role="alert">
          {`Collect every required document or waive it with a reason (${outstandingLabels.join(
            ", ",
          )} outstanding).`}
        </p>
      )}
      <p className="step-summary">
        Drop a file on a row (or use Upload) to mark it received; waive with a reason when a document
        does not apply. The start-date and duplicate checks run at the Verify checkpoint.
      </p>
    </div>
  );
}

/** Step 2 — the check table, directory lookalikes and the manual review notes. */
export function OnboardingVerifySurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: OnboardingVerifyDraft | null;
  onChange: (draft: OnboardingVerifyDraft) => void;
}) {
  const view = parseOnboardingVerify(artifact);
  if (view === null) {
    return <p className="step-empty">The verification results are not readable yet.</p>;
  }
  const failing = view.checks.filter((check) => check.status === "fail");
  const noteFor = (checkId: string): string =>
    draft?.resolutions[checkId] ??
    view.resolutions.find((resolution) => resolution.checkId === checkId)?.note ??
    "";
  const setNote = (checkId: string, note: string): void => {
    onChange({ resolutions: { ...(draft?.resolutions ?? {}), [checkId]: note } });
  };

  return (
    <div className="vendors-verify-surface">
      <div className="impl-head">
        <p className="analysis-summary">{view.summary}</p>
        <div className="analysis-meta">
          {view.confidence !== null ? (
            <span className="verdict-confidence">
              {`confidence ${(view.confidence * 100).toFixed(0)}%`}
            </span>
          ) : null}
          <span className="file-count-badge">{`${view.checks.length} checks`}</span>
        </div>
      </div>
      <table className="dependency-table vendors-check-table">
        <thead>
          <tr>
            <th>Check</th>
            <th>Result</th>
            <th>Source</th>
            <th>Checked</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {view.checks.map((check) => (
            <tr key={check.id} className={`check-${check.status}`}>
              <td>
                <strong>{check.label}</strong>
              </td>
              <td>
                <span className={`vendors-check-pill check-${check.status}`}>{check.status}</span>
              </td>
              <td className="dependency-version-cell">{check.source}</td>
              <td className="dependency-version-cell">{check.checkedAt}</td>
              <td className="change-description">{check.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="vendors-candidates">
        <h4 className="a11y-section-head">{`Directory lookalikes · ${view.candidates.length}`}</h4>
        {view.candidates.length === 0 ? (
          <p className="step-empty">No directory lookalikes were found for this name.</p>
        ) : (
          <div className="vendors-candidate-grid">
            {view.candidates.map((candidate) => (
              <article
                key={candidate.employeeId}
                className="dependency-group-card vendors-candidate-card"
              >
                <header className="file-card-head">
                  <strong>{candidate.label}</strong>
                  <span className="line-pill">
                    {`match ${Math.round(candidate.matchScore * 100)}%`}
                  </span>
                </header>
                <p className="vendors-doc-meta">{candidate.employeeId}</p>
                <p className="file-validators">
                  {`Matched on: ${candidate.matchedOn.join(", ") || "none"}`}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="vendors-manual-review">
        <h4 className="a11y-section-head">{`Manual review · ${failing.length}`}</h4>
        {failing.length === 0 ? (
          <p className="vendors-passed-note" role="status">
            Every check passed — no manual review is required.
          </p>
        ) : (
          <>
            <p className="step-summary">
              Each failing check needs a review note before verification can proceed; the note is the
              evidence recorded with the decision.
            </p>
            <ul className="vendors-review-list">
              {failing.map((check) => (
                <li key={check.id}>
                  <div className="vendors-doc-head">
                    <strong>{check.label}</strong>
                    <span className="vendors-check-pill check-fail">fail</span>
                  </div>
                  <p className="change-description">{check.detail}</p>
                  <label className="vendors-review-note">
                    <span>Manual-review note</span>
                    <textarea
                      rows={2}
                      maxLength={1000}
                      value={noteFor(check.id)}
                      placeholder="Why is this finding acceptable or already handled?"
                      readOnly={!editable}
                      onChange={(event) => setNote(check.id, event.target.value)}
                    />
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

/** Step 3 — the score meter, tier badge, factor breakdown and approver matrix. */
export function OnboardingRiskSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const view = parseOnboardingRisk(artifact);
  if (view === null) {
    return <p className="step-empty">The risk score is not readable yet.</p>;
  }
  const scoreWidth = Math.min(100, Math.max(0, view.score));
  return (
    <div className="vendors-risk-surface">
      <div className="impl-head">
        <p className="analysis-summary">{view.summary}</p>
        <div className="analysis-meta">
          {view.confidence !== null ? (
            <span className="verdict-confidence">
              {`confidence ${(view.confidence * 100).toFixed(0)}%`}
            </span>
          ) : null}
          <span className={`vendors-tier-badge tier-${view.tier}`}>{view.tier}</span>
        </div>
      </div>
      <div
        className={`vendors-score-meter tier-${view.tier}`}
        role="img"
        aria-label={`Risk score ${view.score} of 100`}
      >
        <div className="vendors-score-fill" style={{ width: `${scoreWidth}%` }} />
        <span className="vendors-score-value">{`${view.score} / 100`}</span>
      </div>
      <p className="step-summary">
        {`Tier ${view.tier} — required signers: ${view.requiredSigners
          .map((role) => onboardingRoleLabel(role))
          .join(", ")}`}
      </p>
      <h4 className="a11y-section-head">Factor breakdown</h4>
      <ul className="vendors-factor-list">
        {view.factors.map((factor) => (
          <li key={factor.id} className="vendors-factor-row">
            <div className="vendors-factor-head">
              <strong>{factor.label}</strong>
              <span className="line-pill">{`+${factor.points}`}</span>
            </div>
            <p className="change-description">{factor.detail}</p>
          </li>
        ))}
      </ul>
      <h4 className="a11y-section-head">Approver matrix</h4>
      <table className="dependency-table vendors-matrix-table">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Required signers</th>
          </tr>
        </thead>
        <tbody>
          {view.matrix.map((row) => (
            <tr key={row.tier} className={row.tier === view.tier ? "current-tier" : ""}>
              <td>
                <span className={`vendors-tier-badge tier-${row.tier}`}>{row.tier}</span>
              </td>
              <td>{row.requiredSigners.map((role) => onboardingRoleLabel(role)).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Step 4 — the signer chain tracker, comments and the reject-to-collect loop. */
export function OnboardingApproveSurface({
  artifact,
  editable,
  draft,
  onChange,
  returnFlow,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: OnboardingApproveDraft | null;
  onChange: (draft: OnboardingApproveDraft) => void;
  returnFlow?: { onReturn: (reason: string) => void; busy: boolean };
}) {
  const [commentText, setCommentText] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const view = parseOnboardingApprove(artifact);
  if (view === null) {
    return <p className="step-empty">The approval chain is not readable yet.</p>;
  }
  const chain = draft?.chain ?? view.chain;
  const comments = draft?.comments ?? view.comments;
  const allApproved = chain.length > 0 && chain.every((entry) => entry.state === "approved");

  function setEntry(role: string, patch: Partial<OnboardingChainEntryView>): void {
    onChange({
      chain: chain.map((entry) => (entry.role === role ? { ...entry, ...patch } : entry)),
      comments,
    });
  }

  function toggleApproval(entry: OnboardingChainEntryView): void {
    if (entry.state === "approved") {
      setEntry(entry.role, { state: "pending", actedAt: null, note: null });
      return;
    }
    setEntry(entry.role, {
      state: "approved",
      actedAt: new Date().toISOString(),
      note: entry.note ?? "Approved in review.",
    });
  }

  function nudge(entry: OnboardingChainEntryView): void {
    setEntry(entry.role, { nudges: entry.nudges + 1, lastNudgedAt: new Date().toISOString() });
  }

  function addComment(): void {
    const body = commentText.trim();
    if (body === "") return;
    onChange({
      chain,
      comments: [
        ...comments,
        { author: "You", at: new Date().toISOString(), body: body.slice(0, 1000) },
      ],
    });
    setCommentText("");
  }

  return (
    <div className="vendors-approve-surface">
      <p className="step-summary">{view.summary}</p>
      <div className="analysis-meta">
        <span className={`vendors-tier-badge tier-${view.tier}`}>{view.tier}</span>
        {view.slaHours !== null && (
          <span className="file-count-badge">{`SLA ${view.slaHours}h`}</span>
        )}
        <span className="file-count-badge">{allApproved ? "All approved" : "Awaiting signers"}</span>
      </div>

      <ul className="vendors-chain-list">
        {chain.map((entry) => {
          const age = onboardingSlaAgeHours(entry.requestedAt);
          const slaLabel =
            age === null || view.slaHours === null
              ? "SLA pending"
              : `${age}h of ${view.slaHours}h SLA`;
          return (
            <li key={entry.role} className={`vendors-chain-row state-${entry.state}`}>
              <span className={`vendors-avatar state-${entry.state}`} aria-hidden="true">
                {onboardingInitials(entry.name)}
              </span>
              <div className="vendors-chain-body">
                <div className="vendors-chain-head">
                  <strong>{entry.name}</strong>
                  <span className="vendors-chain-role">{onboardingRoleLabel(entry.role)}</span>
                  <span className={`vendors-chain-state state-${entry.state}`}>{entry.state}</span>
                </div>
                <p className="a11y-location">
                  {`Requested ${entry.requestedAt} · ${slaLabel}`}
                  {entry.actedAt !== null ? ` · acted ${entry.actedAt}` : ""}
                  {entry.nudges > 0 ? ` · nudged ${entry.nudges}×` : ""}
                </p>
                {entry.note !== null && entry.note.trim() !== "" && (
                  <p className="change-description">{entry.note}</p>
                )}
                {editable && (
                  <div className="vendors-chain-actions">
                    <button
                      type="button"
                      className={entry.state === "approved" ? "" : "approve"}
                      onClick={() => toggleApproval(entry)}
                    >
                      {entry.state === "approved" ? "Undo approval" : "Approve"}
                    </button>
                    <button
                      type="button"
                      disabled={entry.state !== "pending"}
                      onClick={() => nudge(entry)}
                    >
                      Nudge signer
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <section className="vendors-comments">
        <h4 className="a11y-section-head">{`Comments · ${comments.length}`}</h4>
        {comments.length === 0 ? (
          <p className="step-empty">No comments were recorded on this chain.</p>
        ) : (
          <ul className="vendors-comment-list">
            {comments.map((comment, index) => (
              <li key={`${comment.at}-${index}`}>
                <div className="vendors-comment-head">
                  <strong>{comment.author}</strong>
                  <span className="a11y-location">{comment.at}</span>
                </div>
                <p className="change-description">{comment.body}</p>
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <div className="vendors-comment-editor">
            <textarea
              rows={2}
              maxLength={1000}
              value={commentText}
              placeholder="Add a decision comment"
              onChange={(event) => setCommentText(event.target.value)}
            />
            <button type="button" disabled={commentText.trim() === ""} onClick={addComment}>
              Add comment
            </button>
          </div>
        )}
      </section>

      {editable && !allApproved && (
        <p className="step-summary">
          Approve every required signer to preview the employee record, or reject with a reason to
          return this run to Collect.
        </p>
      )}
      {editable && returnFlow !== undefined && (
        <div className="vendors-return-editor">
          <label>
            <span>Reject reason (returns the run to Collect)</span>
            <textarea
              rows={2}
              maxLength={2000}
              value={returnReason}
              placeholder="What must be re-collected before this hire can be provisioned?"
              onChange={(event) => setReturnReason(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="danger"
            disabled={returnFlow.busy || returnReason.trim() === ""}
            onClick={() => returnFlow.onReturn(returnReason.trim().slice(0, 2000))}
          >
            Reject — return to Collect
          </button>
        </div>
      )}
    </div>
  );
}

/** Step 5 — the employee-record preview, provisioning plan and the receipt. */
export function OnboardingProvisionSurface({
  artifact,
  receipt,
}: {
  artifact: Record<string, unknown>;
  receipt: OnboardingReceiptView | null;
}) {
  const view = parseOnboardingProvision(artifact);
  if (view === null) {
    if (receipt !== null) {
      return (
        <div className="vendors-create-surface">
          <article className="receipt-card">
            <strong>
              {receipt.created
                ? `Employee ${receipt.employeeId} provisioned`
                : `${receipt.employeeId} already existed — provisioning replayed idempotently`}
            </strong>
            <ul className="completion-files">
              <li>{`Effective ${receipt.effectiveDate}`}</li>
              <li>{`Accounts: ${receipt.accounts.join(", ")}`}</li>
              <li>{`Equipment ticket ${receipt.equipmentTicketId}`}</li>
              <li>{`Payroll enrollment ${receipt.payrollEnrollmentId}`}</li>
              <li>{`Registry: ${receipt.registryRef}`}</li>
            </ul>
          </article>
        </div>
      );
    }
    return <p className="step-empty">The provision preview is not readable yet.</p>;
  }
  return (
    <div className="vendors-create-surface">
      <p className="analysis-summary">{view.summary}</p>
      {view.existing !== null && (
        <aside className="similar-callout vendors-existing-callout">
          <h4>Existing employee record</h4>
          <p>
            {`${view.existing.employeeId} · created ${view.existing.createdAt}. Provisioning again replays idempotently — no duplicate record.`}
          </p>
        </aside>
      )}
      <dl className="vendors-record-grid">
        <div>
          <dt>Employee ID</dt>
          <dd>{view.employee.employeeId}</dd>
        </div>
        <div>
          <dt>Initials</dt>
          <dd>{view.employee.label}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{view.employee.roleTitle}</dd>
        </div>
        <div>
          <dt>Department</dt>
          <dd>{view.employee.department}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>{view.employee.location}</dd>
        </div>
        <div>
          <dt>Manager</dt>
          <dd>{view.employee.managerId ?? "—"}</dd>
        </div>
        <div>
          <dt>Access tier</dt>
          <dd>{view.employee.accessTier}</dd>
        </div>
        <div>
          <dt>Effective date</dt>
          <dd>{view.employee.effectiveDate}</dd>
        </div>
        <div>
          <dt>Idempotency key</dt>
          <dd>{view.idempotencyKey}</dd>
        </div>
      </dl>
      <h4 className="a11y-section-head">
        {`Provisioning plan · ${view.accounts.length} account(s)`}
      </h4>
      <ul className="completion-files">
        {view.accounts.map((account) => (
          <li key={account}>{`Account · ${account}`}</li>
        ))}
        {view.equipmentTicket !== null && (
          <li>
            {`Equipment: ${view.equipmentTicket.item} → ${view.equipmentTicket.location} (${view.equipmentTicket.id})`}
          </li>
        )}
        {view.payrollEnrollment !== null && (
          <li>
            {`Payroll: ${view.payrollEnrollment.payGroup} (${view.payrollEnrollment.id})`}
          </li>
        )}
      </ul>
      {receipt !== null && (
        <article className="receipt-card">
          <strong>
            {receipt.created
              ? `Employee ${receipt.employeeId} provisioned`
              : `${receipt.employeeId} already existed — provisioning replayed idempotently`}
          </strong>
          <ul className="completion-files">
            <li>{`Effective ${receipt.effectiveDate}`}</li>
            <li>{`Accounts: ${receipt.accounts.join(", ")}`}</li>
            <li>{`Equipment ticket ${receipt.equipmentTicketId}`}</li>
            <li>{`Payroll enrollment ${receipt.payrollEnrollmentId}`}</li>
            <li>{`Registry: ${receipt.registryRef}`}</li>
          </ul>
        </article>
      )}
      <p className="step-summary">
        Provisioning is idempotent by employee ID — replaying this decision returns the original
        receipt and never creates duplicate accounts.
      </p>
    </div>
  );
}

/* ------------------------------------------------------- offboarding */

function offboardingStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function offboardingFailures(value: unknown): OffboardingFailureView[] {
  const failures: OffboardingFailureView[] = [];
  if (!Array.isArray(value)) return failures;
  for (const item of value) {
    const record = asRecord(item);
    const system = record === null ? null : asString(record["system"]);
    if (record === null || system === null) continue;
    failures.push({ system, reason: asString(record["reason"]) ?? "" });
  }
  return failures;
}

export type OffboardingIntakeView = {
  offboardingId: string;
  employeeId: string;
  employeeLabel: string;
  roleTitle: string;
  department: string;
  location: string;
  accessTier: string;
  managerId: string | null;
  lastDay: string;
  reason: string;
  systems: string[];
  summary: string;
};

export function parseOffboardingIntake(
  artifact: Record<string, unknown>,
): OffboardingIntakeView | null {
  const offboardingId = asString(artifact["offboardingId"]);
  const employeeId = asString(artifact["employeeId"]);
  if (offboardingId === null || employeeId === null) return null;
  return {
    offboardingId,
    employeeId,
    employeeLabel: asString(artifact["employeeLabel"]) ?? "",
    roleTitle: asString(artifact["roleTitle"]) ?? "",
    department: asString(artifact["department"]) ?? "",
    location: asString(artifact["location"]) ?? "",
    accessTier: asString(artifact["accessTier"]) ?? "",
    managerId: asString(artifact["managerId"]),
    lastDay: asString(artifact["lastDay"]) ?? "",
    reason: asString(artifact["reason"]) ?? "",
    systems: offboardingStrings(artifact["systems"]),
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type OffboardingAuditEntryView = {
  system: string;
  label: string;
  blastRadius: string;
  riskScore: number;
  reversibility: string;
  detail: string;
};

export type OffboardingOwnershipView = { system: string; dataClass: string; owner: string };

export type OffboardingRiskItemView = { id: string; label: string; tier: string; detail: string };

export type OffboardingAuditView = {
  offboardingId: string;
  employeeId: string;
  employeeLabel: string;
  roleTitle: string;
  department: string;
  accessTier: string;
  lastDay: string;
  entries: OffboardingAuditEntryView[];
  dataOwnership: OffboardingOwnershipView[];
  risks: OffboardingRiskItemView[];
  summary: string;
  confidence: number | null;
};

export function parseOffboardingAudit(
  artifact: Record<string, unknown>,
): OffboardingAuditView | null {
  const offboardingId = asString(artifact["offboardingId"]);
  if (offboardingId === null) return null;
  const entries: OffboardingAuditEntryView[] = [];
  if (Array.isArray(artifact["entries"])) {
    for (const item of artifact["entries"]) {
      const record = asRecord(item);
      const system = record === null ? null : asString(record["system"]);
      if (record === null || system === null) continue;
      entries.push({
        system,
        label: asString(record["label"]) ?? system,
        blastRadius: asString(record["blastRadius"]) ?? "low",
        riskScore: asNumber(record["riskScore"]) ?? 0,
        reversibility: asString(record["reversibility"]) ?? "reversible",
        detail: asString(record["detail"]) ?? "",
      });
    }
  }
  const ownership: OffboardingOwnershipView[] = [];
  if (Array.isArray(artifact["dataOwnership"])) {
    for (const item of artifact["dataOwnership"]) {
      const record = asRecord(item);
      const system = record === null ? null : asString(record["system"]);
      if (record === null || system === null) continue;
      ownership.push({
        system,
        dataClass: asString(record["dataClass"]) ?? "",
        owner: asString(record["owner"]) ?? "",
      });
    }
  }
  const risks: OffboardingRiskItemView[] = [];
  if (Array.isArray(artifact["risks"])) {
    for (const item of artifact["risks"]) {
      const record = asRecord(item);
      const id = record === null ? null : asString(record["id"]);
      if (record === null || id === null) continue;
      risks.push({
        id,
        label: asString(record["label"]) ?? id,
        tier: asString(record["tier"]) ?? "low",
        detail: asString(record["detail"]) ?? "",
      });
    }
  }
  return {
    offboardingId,
    employeeId: asString(artifact["employeeId"]) ?? "",
    employeeLabel: asString(artifact["employeeLabel"]) ?? "",
    roleTitle: asString(artifact["roleTitle"]) ?? "",
    department: asString(artifact["department"]) ?? "",
    accessTier: asString(artifact["accessTier"]) ?? "",
    lastDay: asString(artifact["lastDay"]) ?? "",
    entries,
    dataOwnership: ownership,
    risks,
    summary: asString(artifact["summary"]) ?? "",
    confidence: asNumber(artifact["confidence"]),
  };
}

export type OffboardingApproveItemView = {
  system: string;
  label: string;
  blastRadius: string;
  riskScore: number;
  reversibility: string;
  requiresExplicitApproval: boolean;
  approved: boolean;
  approver: string | null;
  note: string | null;
};

export type OffboardingApproveView = {
  offboardingId: string;
  employeeId: string;
  employeeLabel: string;
  lastDay: string;
  items: OffboardingApproveItemView[];
  explicitApprovalsRequired: number;
  allApproved: boolean;
  summary: string;
};

export type OffboardingApproveDraft = { items: OffboardingApproveItemView[] };

export function parseOffboardingApprove(
  artifact: Record<string, unknown>,
): OffboardingApproveView | null {
  const offboardingId = asString(artifact["offboardingId"]);
  if (offboardingId === null) return null;
  const items: OffboardingApproveItemView[] = [];
  if (Array.isArray(artifact["items"])) {
    for (const item of artifact["items"]) {
      const record = asRecord(item);
      const system = record === null ? null : asString(record["system"]);
      if (record === null || system === null) continue;
      items.push({
        system,
        label: asString(record["label"]) ?? system,
        blastRadius: asString(record["blastRadius"]) ?? "low",
        riskScore: asNumber(record["riskScore"]) ?? 0,
        reversibility: asString(record["reversibility"]) ?? "reversible",
        requiresExplicitApproval: record["requiresExplicitApproval"] === true,
        approved: record["approved"] === true,
        approver: asString(record["approver"]),
        note: asString(record["note"]),
      });
    }
  }
  return {
    offboardingId,
    employeeId: asString(artifact["employeeId"]) ?? "",
    employeeLabel: asString(artifact["employeeLabel"]) ?? "",
    lastDay: asString(artifact["lastDay"]) ?? "",
    items,
    explicitApprovalsRequired: asNumber(artifact["explicitApprovalsRequired"]) ?? 0,
    allApproved: artifact["allApproved"] === true,
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type OffboardingRevokeActionView = {
  system: string;
  label: string;
  blastRadius: string;
  status: string;
  detail: string;
};

export type OffboardingFailureView = { system: string; reason: string };

export type OffboardingRevokeView = {
  offboardingId: string;
  employeeId: string;
  employeeLabel: string;
  lastDay: string;
  actions: OffboardingRevokeActionView[];
  summary: string;
};

export function parseOffboardingRevoke(
  artifact: Record<string, unknown>,
): OffboardingRevokeView | null {
  const offboardingId = asString(artifact["offboardingId"]);
  if (offboardingId === null) return null;
  const actions: OffboardingRevokeActionView[] = [];
  if (Array.isArray(artifact["actions"])) {
    for (const item of artifact["actions"]) {
      const record = asRecord(item);
      const system = record === null ? null : asString(record["system"]);
      if (record === null || system === null) continue;
      actions.push({
        system,
        label: asString(record["label"]) ?? system,
        blastRadius: asString(record["blastRadius"]) ?? "low",
        status: asString(record["status"]) ?? "pending",
        detail: asString(record["detail"]) ?? "",
      });
    }
  }
  return {
    offboardingId,
    employeeId: asString(artifact["employeeId"]) ?? "",
    employeeLabel: asString(artifact["employeeLabel"]) ?? "",
    lastDay: asString(artifact["lastDay"]) ?? "",
    actions,
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type OffboardingRevokeReceiptView = {
  employeeId: string;
  label: string;
  revoked: string[];
  failed: OffboardingFailureView[];
  replayed: number;
  idempotencyKey: string;
  registryRef: string;
  completedAt: string;
};

export function parseOffboardingRevokeReceipt(
  value: unknown,
): OffboardingRevokeReceiptView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const employeeId = asString(record["employeeId"]);
  if (employeeId === null) return null;
  return {
    employeeId,
    label: asString(record["label"]) ?? "",
    revoked: offboardingStrings(record["revoked"]),
    failed: offboardingFailures(record["failed"]),
    replayed: asNumber(record["replayed"]) ?? 0,
    idempotencyKey: asString(record["idempotencyKey"]) ?? "",
    registryRef: asString(record["registryRef"]) ?? "",
    completedAt: asString(record["completedAt"]) ?? "",
  };
}

export type OffboardingFinalPayView = {
  id: string;
  label: string;
  status: string;
  detail: string;
};

export type OffboardingEquipmentView = {
  id: string;
  label: string;
  status: string;
  detail: string;
};

export type OffboardingAcknowledgementView = { system: string; note: string };

export type OffboardingAttestView = {
  offboardingId: string;
  employeeId: string;
  employeeLabel: string;
  lastDay: string;
  finalPay: { items: OffboardingFinalPayView[]; outstanding: number };
  equipment: { items: OffboardingEquipmentView[]; outstanding: number };
  revocation: { revoked: string[]; failed: OffboardingFailureView[] };
  acknowledgements: OffboardingAcknowledgementView[];
  existing: { closedAt: string } | null;
  summary: string;
};

export type OffboardingAttestDraft = { acknowledgements: OffboardingAcknowledgementView[] };

export function parseOffboardingAttest(
  artifact: Record<string, unknown>,
): OffboardingAttestView | null {
  const offboardingId = asString(artifact["offboardingId"]);
  if (offboardingId === null) return null;
  const finalPay = asRecord(artifact["finalPay"]);
  const equipment = asRecord(artifact["equipment"]);
  const revocation = asRecord(artifact["revocation"]);
  const existing = asRecord(artifact["existing"]);
  const finalPayItems: OffboardingFinalPayView[] = [];
  if (Array.isArray(finalPay?.["items"])) {
    for (const item of finalPay["items"]) {
      const record = asRecord(item);
      const id = record === null ? null : asString(record["id"]);
      if (record === null || id === null) continue;
      finalPayItems.push({
        id,
        label: asString(record["label"]) ?? id,
        status: asString(record["status"]) ?? "pending",
        detail: asString(record["detail"]) ?? "",
      });
    }
  }
  const equipmentItems: OffboardingEquipmentView[] = [];
  if (Array.isArray(equipment?.["items"])) {
    for (const item of equipment["items"]) {
      const record = asRecord(item);
      const id = record === null ? null : asString(record["id"]);
      if (record === null || id === null) continue;
      equipmentItems.push({
        id,
        label: asString(record["label"]) ?? id,
        status: asString(record["status"]) ?? "outstanding",
        detail: asString(record["detail"]) ?? "",
      });
    }
  }
  const acknowledgements: OffboardingAcknowledgementView[] = [];
  if (Array.isArray(artifact["acknowledgements"])) {
    for (const item of artifact["acknowledgements"]) {
      const record = asRecord(item);
      const system = record === null ? null : asString(record["system"]);
      if (record === null || system === null) continue;
      acknowledgements.push({ system, note: asString(record["note"]) ?? "" });
    }
  }
  const closedAt = existing === null ? null : asString(existing["closedAt"]);
  return {
    offboardingId,
    employeeId: asString(artifact["employeeId"]) ?? "",
    employeeLabel: asString(artifact["employeeLabel"]) ?? "",
    lastDay: asString(artifact["lastDay"]) ?? "",
    finalPay: {
      items: finalPayItems,
      outstanding: asNumber(finalPay?.["outstanding"]) ?? 0,
    },
    equipment: {
      items: equipmentItems,
      outstanding: asNumber(equipment?.["outstanding"]) ?? 0,
    },
    revocation: {
      revoked: offboardingStrings(revocation?.["revoked"]),
      failed: offboardingFailures(revocation?.["failed"]),
    },
    acknowledgements,
    existing: closedAt === null ? null : { closedAt },
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type OffboardingAttestReceiptView = {
  offboardingId: string;
  employeeId: string;
  label: string;
  revokedSystems: string[];
  failedSystems: string[];
  equipmentOutstanding: string[];
  finalPayReady: boolean;
  caseClosed: boolean;
  created: boolean;
  registryRef: string;
  closedAt: string;
};

export function parseOffboardingAttestReceipt(
  value: unknown,
): OffboardingAttestReceiptView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const offboardingId = asString(record["offboardingId"]);
  const employeeId = asString(record["employeeId"]);
  if (offboardingId === null || employeeId === null) return null;
  return {
    offboardingId,
    employeeId,
    label: asString(record["label"]) ?? "",
    revokedSystems: offboardingStrings(record["revokedSystems"]),
    failedSystems: offboardingStrings(record["failedSystems"]),
    equipmentOutstanding: offboardingStrings(record["equipmentOutstanding"]),
    finalPayReady: record["finalPayReady"] === true,
    caseClosed: record["caseClosed"] === true,
    created: record["created"] === true,
    registryRef: asString(record["registryRef"]) ?? "",
    closedAt: asString(record["closedAt"]) ?? "",
  };
}

function offboardingPayStatusClass(status: string): string {
  if (status === "ready") return "received";
  if (status === "blocked") return "missing";
  return "pending";
}

function offboardingEquipmentStatusClass(status: string): string {
  return status === "returned" ? "received" : "pending";
}

function offboardingRevokeStatusClass(status: string): string {
  if (status === "revoked") return "pass";
  if (status === "failed") return "fail";
  return "neutral";
}

/** Step 1 — the resolved leaver, the departure facts and the system list. */
export function OffboardingIntakeSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const view = parseOffboardingIntake(artifact);
  if (view === null) {
    return <p className="step-empty">The offboarding intake is not readable yet.</p>;
  }
  return (
    <div className="hr-surface">
      <div className="hr-head">
        <span className={`hr-status-pill status-${view.accessTier === "high" ? "fail" : "pass"}`}>
          {`${view.accessTier} tier`}
        </span>
        <strong>{view.offboardingId}</strong>
        <span className="hr-meta">{view.employeeLabel}</span>
        <span className="hr-meta">{`last day ${view.lastDay}`}</span>
      </div>
      <dl className="hr-kv">
        <div>
          <dt>Employee</dt>
          <dd>{`${view.employeeId} · ${view.employeeLabel}`}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{`${view.roleTitle} · ${view.department}`}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>{view.location}</dd>
        </div>
        <div>
          <dt>Manager</dt>
          <dd>{view.managerId ?? "—"}</dd>
        </div>
        <div>
          <dt>Reason</dt>
          <dd>{view.reason}</dd>
        </div>
      </dl>
      <h4 className="a11y-section-head">{`Systems to revoke · ${view.systems.length}`}</h4>
      <ul className="completion-files">
        {view.systems.map((system) => (
          <li key={system}>{system}</li>
        ))}
      </ul>
      <p className="step-summary">{view.summary}</p>
    </div>
  );
}

/** Step 2 — the per-system blast radius, reversibility and data ownership. */
export function OffboardingAuditSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const view = parseOffboardingAudit(artifact);
  if (view === null) {
    return <p className="step-empty">The access audit is not readable yet.</p>;
  }
  return (
    <div className="vendors-verify-surface">
      <div className="impl-head">
        <p className="analysis-summary">{view.summary}</p>
        <div className="analysis-meta">
          {view.confidence !== null ? (
            <span className="verdict-confidence">
              {`confidence ${(view.confidence * 100).toFixed(0)}%`}
            </span>
          ) : null}
          <span className={`vendors-tier-badge tier-${view.accessTier}`}>{view.accessTier}</span>
        </div>
      </div>
      <table className="dependency-table vendors-check-table">
        <thead>
          <tr>
            <th>System</th>
            <th>Blast radius</th>
            <th>Risk</th>
            <th>Reversibility</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {view.entries.map((entry) => (
            <tr key={entry.system}>
              <td>
                <strong>{entry.label}</strong>
              </td>
              <td>
                <span className={`vendors-tier-badge tier-${entry.blastRadius}`}>
                  {entry.blastRadius}
                </span>
              </td>
              <td className="dependency-version-cell">{`${entry.riskScore} / 100`}</td>
              <td className="dependency-version-cell">{entry.reversibility}</td>
              <td className="change-description">{entry.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="vendors-candidates">
        <h4 className="a11y-section-head">{`Data ownership · ${view.dataOwnership.length}`}</h4>
        <table className="dependency-table vendors-check-table">
          <thead>
            <tr>
              <th>System</th>
              <th>Data class</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {view.dataOwnership.map((row) => (
              <tr key={row.system}>
                <td>{row.system}</td>
                <td>{row.dataClass}</td>
                <td>{row.owner}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="vendors-manual-review">
        <h4 className="a11y-section-head">{`Departure risks · ${view.risks.length}`}</h4>
        <ul className="vendors-review-list">
          {view.risks.map((risk) => (
            <li key={risk.id}>
              <div className="vendors-doc-head">
                <strong>{risk.label}</strong>
                <span className={`vendors-tier-badge tier-${risk.tier}`}>{risk.tier}</span>
              </div>
              <p className="change-description">{risk.detail}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Step 3 — per-item sign-off; high-blast revocations need a named approver. */
export function OffboardingApproveSurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: OffboardingApproveDraft | null;
  onChange: (draft: OffboardingApproveDraft) => void;
}) {
  const view = parseOffboardingApprove(artifact);
  if (view === null) {
    return <p className="step-empty">The revocation approval list is not readable yet.</p>;
  }
  const items = draft?.items ?? view.items;
  const allApproved = items.length > 0 && items.every((item) => item.approved);
  const outstanding = items.filter(
    (item) =>
      !item.approved || (item.requiresExplicitApproval && (item.approver ?? "").trim() === ""),
  );

  function setItem(system: string, patch: Partial<OffboardingApproveItemView>): void {
    onChange({ items: items.map((item) => (item.system === system ? { ...item, ...patch } : item)) });
  }

  function toggleApproval(item: OffboardingApproveItemView): void {
    if (item.approved) {
      setItem(item.system, { approved: false });
      return;
    }
    setItem(item.system, { approved: true, note: item.note ?? "Approved in review." });
  }

  return (
    <div className="vendors-approve-surface">
      <p className="step-summary">{view.summary}</p>
      <div className="analysis-meta">
        <span className="file-count-badge">
          {`${view.explicitApprovalsRequired} explicit approval(s) required`}
        </span>
        <span className="file-count-badge">{allApproved ? "All approved" : "Awaiting sign-off"}</span>
      </div>
      <ul className="vendors-chain-list">
        {items.map((item) => (
          <li
            key={item.system}
            className={`vendors-chain-row state-${item.approved ? "approved" : "pending"}`}
          >
            <div className="vendors-chain-body">
              <div className="vendors-chain-head">
                <strong>{item.label}</strong>
                <span className={`vendors-tier-badge tier-${item.blastRadius}`}>
                  {item.blastRadius}
                </span>
                <span className="vendors-chain-role">
                  {`risk ${item.riskScore} / 100 · ${item.reversibility}`}
                </span>
                <span
                  className={`vendors-chain-state state-${item.approved ? "approved" : "pending"}`}
                >
                  {item.approved ? "approved" : "pending"}
                </span>
              </div>
              {item.requiresExplicitApproval && (
                <p className="a11y-location">
                  High-blast revocation — an explicit per-item sign-off is required (destructive
                  action).
                </p>
              )}
              {editable && item.requiresExplicitApproval && (
                <label className="vendors-review-note">
                  <span>Approver (sign-off required)</span>
                  <input
                    type="text"
                    maxLength={120}
                    value={item.approver ?? ""}
                    placeholder="Who signed off on this revocation?"
                    onChange={(event) => setItem(item.system, { approver: event.target.value })}
                  />
                </label>
              )}
              {editable && (
                <div className="vendors-chain-actions">
                  <button
                    type="button"
                    className={item.approved ? "" : "approve"}
                    onClick={() => toggleApproval(item)}
                  >
                    {item.approved ? "Undo approval" : "Approve"}
                  </button>
                </div>
              )}
              {!editable && item.approver !== null && item.approver !== "" && (
                <p className="change-description">{`Approved by ${item.approver}`}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {outstanding.length > 0 && (
        <p className="run-action-error" role="alert">
          {`Every revocation needs approval, and high-blast items need a recorded approver (${outstanding
            .map((item) => item.label)
            .join(", ")} outstanding).`}
        </p>
      )}
      <p className="step-summary">
        Approving every item releases the Revoke checkpoint; high-blast revocations stay blocked
        until a named sign-off is recorded.
      </p>
    </div>
  );
}

/** Step 4 — the per-system revocation plan, its failures and its receipt. */
export function OffboardingRevokeSurface({
  artifact,
  receipt,
}: {
  artifact: Record<string, unknown>;
  receipt: OffboardingRevokeReceiptView | null;
}) {
  const view = parseOffboardingRevoke(artifact);
  if (view === null) {
    return <p className="step-empty">The revocation plan is not readable yet.</p>;
  }
  return (
    <div className="vendors-collect-surface">
      <div className="impl-head">
        <p className="analysis-summary">{view.summary}</p>
        <div className="analysis-meta">
          <span className={`hr-status-pill ${receipt === null ? "status-neutral" : "status-pass"}`}>
            {receipt === null
              ? "preview"
              : receipt.failed.length > 0
                ? "completed with failures"
                : "revoked"}
          </span>
        </div>
      </div>
      <table className="dependency-table vendors-check-table">
        <thead>
          <tr>
            <th>System</th>
            <th>Blast radius</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {view.actions.map((action) => (
            <tr key={action.system} className={`check-${offboardingRevokeStatusClass(action.status)}`}>
              <td>
                <strong>{action.label}</strong>
              </td>
              <td>
                <span className={`vendors-tier-badge tier-${action.blastRadius}`}>
                  {action.blastRadius}
                </span>
              </td>
              <td>
                <span
                  className={`vendors-check-pill check-${offboardingRevokeStatusClass(action.status)}`}
                >
                  {action.status}
                </span>
              </td>
              <td className="change-description">{action.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {receipt !== null && receipt.failed.length > 0 && (
        <section className="vendors-manual-review">
          <h4 className="a11y-section-head">{`Failures · ${receipt.failed.length}`}</h4>
          <ul className="vendors-review-list">
            {receipt.failed.map((failure) => (
              <li key={failure.system}>
                <div className="vendors-doc-head">
                  <strong>{failure.system}</strong>
                  <span className="vendors-check-pill check-fail">failed</span>
                </div>
                <p className="change-description">{failure.reason}</p>
              </li>
            ))}
          </ul>
          <p className="step-summary">
            Failures are listed verbatim and must be acknowledged at the Attest checkpoint before
            the case closes.
          </p>
        </section>
      )}
      {receipt !== null && (
        <article className="receipt-card">
          <strong>
            {receipt.failed.length > 0
              ? `${receipt.label} revoked with ${receipt.failed.length} failure(s)`
              : `${receipt.label} — all ${receipt.revoked.length} system(s) revoked`}
          </strong>
          <ul className="completion-files">
            <li>{`Revoked: ${receipt.revoked.join(", ") || "none"}`}</li>
            <li>{`Failed: ${receipt.failed.map((failure) => failure.system).join(", ") || "none"}`}</li>
            <li>{`Replayed: ${receipt.replayed}`}</li>
            <li>{`Idempotency key: ${receipt.idempotencyKey}`}</li>
            <li>{`Registry: ${receipt.registryRef}`}</li>
            <li>{`Completed ${receipt.completedAt}`}</li>
          </ul>
        </article>
      )}
      <p className="step-summary">
        Revocation is idempotent per employee and system — replaying this decision returns the
        original receipt and never revokes twice.
      </p>
    </div>
  );
}

/** Step 5 — final pay, equipment returns, failure acknowledgements and both receipts. */
export function OffboardingAttestSurface({
  artifact,
  receipt,
  revokeReceipt,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  receipt: OffboardingAttestReceiptView | null;
  revokeReceipt: OffboardingRevokeReceiptView | null;
  editable: boolean;
  draft: OffboardingAttestDraft | null;
  onChange: (draft: OffboardingAttestDraft) => void;
}) {
  const view = parseOffboardingAttest(artifact);
  if (view === null) {
    if (receipt !== null) {
      return (
        <div className="vendors-create-surface">
          <article className="receipt-card">
            <strong>
              {receipt.created
                ? `Case closed for ${receipt.employeeId} (${receipt.label})`
                : `${receipt.employeeId} was already attested — the close replayed idempotently`}
            </strong>
            <ul className="completion-files">
              <li>{`Revoked: ${receipt.revokedSystems.join(", ") || "none"}`}</li>
              <li>{`Failed: ${receipt.failedSystems.join(", ") || "none"}`}</li>
              <li>{`Registry: ${receipt.registryRef}`}</li>
              <li>{`Closed ${receipt.closedAt}`}</li>
            </ul>
          </article>
        </div>
      );
    }
    return <p className="step-empty">The attestation preview is not readable yet.</p>;
  }
  const acknowledgements = draft?.acknowledgements ?? view.acknowledgements;
  const noteFor = (system: string): string =>
    acknowledgements.find((entry) => entry.system === system)?.note ?? "";
  const setNote = (system: string, note: string): void => {
    onChange({
      acknowledgements: [
        ...acknowledgements.filter((entry) => entry.system !== system),
        { system, note },
      ],
    });
  };
  return (
    <div className="vendors-create-surface">
      <p className="analysis-summary">{view.summary}</p>
      {view.existing !== null && (
        <aside className="similar-callout vendors-existing-callout">
          <h4>Existing attestation</h4>
          <p>
            {`The case was already closed at ${view.existing.closedAt}. Attesting again replays idempotently — the original close is returned.`}
          </p>
        </aside>
      )}
      <dl className="vendors-record-grid">
        <div>
          <dt>Employee</dt>
          <dd>{`${view.employeeId} · ${view.employeeLabel}`}</dd>
        </div>
        <div>
          <dt>Last day</dt>
          <dd>{view.lastDay}</dd>
        </div>
        <div>
          <dt>Final pay</dt>
          <dd>{`${view.finalPay.outstanding} pending`}</dd>
        </div>
        <div>
          <dt>Equipment</dt>
          <dd>{`${view.equipment.outstanding} outstanding`}</dd>
        </div>
      </dl>
      <h4 className="a11y-section-head">{`Final-pay checklist · ${view.finalPay.items.length}`}</h4>
      <ul className="vendors-doc-list">
        {view.finalPay.items.map((item) => (
          <li
            key={item.id}
            className={`vendors-doc-row status-${offboardingPayStatusClass(item.status)}`}
          >
            <div className="vendors-doc-head">
              <strong>{item.label}</strong>
              <span
                className={`vendors-status-pill status-${offboardingPayStatusClass(item.status)}`}
              >
                {item.status}
              </span>
            </div>
            <p className="vendors-doc-meta">{item.detail}</p>
          </li>
        ))}
      </ul>
      <h4 className="a11y-section-head">{`Equipment returns · ${view.equipment.items.length}`}</h4>
      <ul className="vendors-doc-list">
        {view.equipment.items.map((item) => (
          <li
            key={item.id}
            className={`vendors-doc-row status-${offboardingEquipmentStatusClass(item.status)}`}
          >
            <div className="vendors-doc-head">
              <strong>{item.label}</strong>
              <span
                className={`vendors-status-pill status-${offboardingEquipmentStatusClass(item.status)}`}
              >
                {item.status}
              </span>
            </div>
            <p className="vendors-doc-meta">{item.detail}</p>
          </li>
        ))}
      </ul>
      <h4 className="a11y-section-head">
        {`Access revocation · ${view.revocation.revoked.length} revoked · ${view.revocation.failed.length} failed`}
      </h4>
      <ul className="completion-files">
        {view.revocation.revoked.map((system) => (
          <li key={system}>{`Revoked · ${system}`}</li>
        ))}
      </ul>
      {view.revocation.failed.length > 0 && (
        <section className="vendors-manual-review">
          <h4 className="a11y-section-head">{`Failed revocations · ${view.revocation.failed.length}`}</h4>
          <p className="step-summary">
            Every failed revocation needs an acknowledgement note before the case can close.
          </p>
          <ul className="vendors-review-list">
            {view.revocation.failed.map((failure) => (
              <li key={failure.system}>
                <div className="vendors-doc-head">
                  <strong>{failure.system}</strong>
                  <span className="vendors-check-pill check-fail">failed</span>
                </div>
                <p className="change-description">{failure.reason}</p>
                <label className="vendors-review-note">
                  <span>Acknowledgement note</span>
                  <textarea
                    rows={2}
                    maxLength={500}
                    value={noteFor(failure.system)}
                    placeholder="How will this failure be tracked after the close?"
                    readOnly={!editable}
                    onChange={(event) => setNote(failure.system, event.target.value)}
                  />
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}
      {receipt !== null && (
        <article className="receipt-card">
          <strong>
            {receipt.created
              ? `Case closed for ${receipt.employeeId} (${receipt.label})`
              : `${receipt.employeeId} was already attested — the close replayed idempotently`}
          </strong>
          <ul className="completion-files">
            <li>{`Revoked: ${receipt.revokedSystems.join(", ") || "none"}`}</li>
            <li>{`Failed: ${receipt.failedSystems.join(", ") || "none"}`}</li>
            <li>{`Equipment outstanding: ${receipt.equipmentOutstanding.join(", ") || "none"}`}</li>
            <li>{`Final pay ready: ${receipt.finalPayReady ? "yes" : "no"}`}</li>
            <li>{`Case closed: ${receipt.caseClosed ? "yes" : "no"}`}</li>
            <li>{`Registry: ${receipt.registryRef}`}</li>
            <li>{`Closed ${receipt.closedAt}`}</li>
          </ul>
        </article>
      )}
      {revokeReceipt !== null && receipt === null && (
        <article className="receipt-card">
          <strong>
            {`Revocation receipt — ${revokeReceipt.revoked.length} revoked, ${revokeReceipt.failed.length} failed`}
          </strong>
          <ul className="completion-files">
            <li>{`Idempotency key: ${revokeReceipt.idempotencyKey}`}</li>
            <li>{`Completed ${revokeReceipt.completedAt}`}</li>
          </ul>
        </article>
      )}
      <p className="step-summary">
        Attesting closes the case: final pay and equipment start tracked from here, and replaying
        the decision returns the original close instead of a duplicate.
      </p>
    </div>
  );
}

/* ------------------------------------------------------- screening */

function screeningStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export type ScreeningCriterionView = {
  id: string;
  label: string;
  weight: number;
  mustHave: boolean;
  detail: string;
};

export type ScreeningRequisitionView = {
  requisitionId: string;
  roleTitle: string;
  department: string;
  location: string;
  seniority: string;
  criteria: ScreeningCriterionView[];
  mustHaves: number;
  candidateIds: string[];
  interviewers: string[];
  summary: string;
};

export function parseScreeningRequisition(
  artifact: Record<string, unknown>,
): ScreeningRequisitionView | null {
  const requisitionId = asString(artifact["requisitionId"]);
  if (requisitionId === null) return null;
  const criteria: ScreeningCriterionView[] = [];
  if (Array.isArray(artifact["criteria"])) {
    for (const item of artifact["criteria"]) {
      const record = asRecord(item);
      const id = record === null ? null : asString(record["id"]);
      if (record === null || id === null) continue;
      criteria.push({
        id,
        label: asString(record["label"]) ?? id,
        weight: asNumber(record["weight"]) ?? 0,
        mustHave: record["mustHave"] === true,
        detail: asString(record["detail"]) ?? "",
      });
    }
  }
  return {
    requisitionId,
    roleTitle: asString(artifact["roleTitle"]) ?? "",
    department: asString(artifact["department"]) ?? "",
    location: asString(artifact["location"]) ?? "",
    seniority: asString(artifact["seniority"]) ?? "",
    criteria,
    mustHaves: asNumber(artifact["mustHaves"]) ?? 0,
    candidateIds: screeningStrings(artifact["candidateIds"]),
    interviewers: screeningStrings(artifact["interviewers"]),
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type ScreeningCitationView = { sourceId: string; span: string; text: string };

export type ScreeningVerdictView = {
  criterionId: string;
  label: string;
  weight: number;
  mustHave: boolean;
  verdict: string;
  citations: ScreeningCitationView[];
};

export type ScreeningFlagView = {
  candidateId: string;
  kind: string;
  detail: string;
  sourceId: string | null;
  span: string | null;
};

export type ScreeningCandidateView = {
  candidateId: string;
  candidateLabel: string;
  headline: string;
  verdicts: ScreeningVerdictView[];
  score: number;
  mustHaveMisses: string[];
  flags: ScreeningFlagView[];
};

export type ScreeningGuardrailView = {
  allowed: boolean;
  summary: string;
  confidence: number | null;
};

export type ScreeningScreenView = {
  requisitionId: string;
  roleTitle: string;
  department: string;
  candidates: ScreeningCandidateView[];
  guardrail: ScreeningGuardrailView;
  totalFlags: number;
  summary: string;
};

function screeningCitations(value: unknown): ScreeningCitationView[] {
  const citations: ScreeningCitationView[] = [];
  if (!Array.isArray(value)) return citations;
  for (const item of value) {
    const record = asRecord(item);
    const sourceId = record === null ? null : asString(record["sourceId"]);
    if (record === null || sourceId === null) continue;
    citations.push({
      sourceId,
      span: asString(record["span"]) ?? "",
      text: asString(record["text"]) ?? "",
    });
  }
  return citations;
}

function screeningFlags(value: unknown): ScreeningFlagView[] {
  const flags: ScreeningFlagView[] = [];
  if (!Array.isArray(value)) return flags;
  for (const item of value) {
    const record = asRecord(item);
    const candidateId = record === null ? null : asString(record["candidateId"]);
    if (record === null || candidateId === null) continue;
    flags.push({
      candidateId,
      kind: asString(record["kind"]) ?? "non-rubric",
      detail: asString(record["detail"]) ?? "",
      sourceId: asString(record["sourceId"]),
      span: asString(record["span"]),
    });
  }
  return flags;
}

export function parseScreeningScreen(
  artifact: Record<string, unknown>,
): ScreeningScreenView | null {
  const requisitionId = asString(artifact["requisitionId"]);
  if (requisitionId === null) return null;
  const guardrail = asRecord(artifact["guardrail"]);
  const candidates: ScreeningCandidateView[] = [];
  if (Array.isArray(artifact["candidates"])) {
    for (const item of artifact["candidates"]) {
      const record = asRecord(item);
      const candidateId = record === null ? null : asString(record["candidateId"]);
      if (record === null || candidateId === null) continue;
      const verdicts: ScreeningVerdictView[] = [];
      if (Array.isArray(record["verdicts"])) {
        for (const verdictItem of record["verdicts"]) {
          const verdictRecord = asRecord(verdictItem);
          const criterionId =
            verdictRecord === null ? null : asString(verdictRecord["criterionId"]);
          if (verdictRecord === null || criterionId === null) continue;
          verdicts.push({
            criterionId,
            label: asString(verdictRecord["label"]) ?? criterionId,
            weight: asNumber(verdictRecord["weight"]) ?? 0,
            mustHave: verdictRecord["mustHave"] === true,
            verdict: asString(verdictRecord["verdict"]) ?? "fail",
            citations: screeningCitations(verdictRecord["citations"]),
          });
        }
      }
      candidates.push({
        candidateId,
        candidateLabel: asString(record["candidateLabel"]) ?? candidateId,
        headline: asString(record["headline"]) ?? "",
        verdicts,
        score: asNumber(record["score"]) ?? 0,
        mustHaveMisses: screeningStrings(record["mustHaveMisses"]),
        flags: screeningFlags(record["flags"]),
      });
    }
  }
  return {
    requisitionId,
    roleTitle: asString(artifact["roleTitle"]) ?? "",
    department: asString(artifact["department"]) ?? "",
    candidates,
    guardrail: {
      allowed: guardrail !== null && guardrail["allowed"] === true,
      summary: asString(guardrail?.["summary"]) ?? "",
      confidence: guardrail === null ? null : asNumber(guardrail["confidence"]),
    },
    totalFlags: asNumber(artifact["totalFlags"]) ?? 0,
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type ScreeningShortlistEntryView = {
  candidateId: string;
  candidateLabel: string;
  score: number;
  decision: string;
  reason: string;
  flags: number;
};

export type ScreeningShortlistView = {
  requisitionId: string;
  roleTitle: string;
  entries: ScreeningShortlistEntryView[];
  included: number;
  excluded: number;
  summary: string;
};

export type ScreeningShortlistDraft = { entries: ScreeningShortlistEntryView[] };

export function parseScreeningShortlist(
  artifact: Record<string, unknown>,
): ScreeningShortlistView | null {
  const requisitionId = asString(artifact["requisitionId"]);
  if (requisitionId === null) return null;
  const entries: ScreeningShortlistEntryView[] = [];
  if (Array.isArray(artifact["entries"])) {
    for (const item of artifact["entries"]) {
      const record = asRecord(item);
      const candidateId = record === null ? null : asString(record["candidateId"]);
      if (record === null || candidateId === null) continue;
      entries.push({
        candidateId,
        candidateLabel: asString(record["candidateLabel"]) ?? candidateId,
        score: asNumber(record["score"]) ?? 0,
        decision: asString(record["decision"]) ?? "exclude",
        reason: asString(record["reason"]) ?? "",
        flags: asNumber(record["flags"]) ?? 0,
      });
    }
  }
  return {
    requisitionId,
    roleTitle: asString(artifact["roleTitle"]) ?? "",
    entries,
    included: asNumber(artifact["included"]) ?? 0,
    excluded: asNumber(artifact["excluded"]) ?? 0,
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type ScreeningInviteView = {
  candidateId: string;
  candidateLabel: string;
  slot: string;
  interviewer: string;
  status: string;
  detail: string;
};

export type ScreeningScheduleView = {
  requisitionId: string;
  roleTitle: string;
  invites: ScreeningInviteView[];
  summary: string;
};

export function parseScreeningSchedule(
  artifact: Record<string, unknown>,
): ScreeningScheduleView | null {
  const requisitionId = asString(artifact["requisitionId"]);
  if (requisitionId === null) return null;
  const invites: ScreeningInviteView[] = [];
  if (Array.isArray(artifact["invites"])) {
    for (const item of artifact["invites"]) {
      const record = asRecord(item);
      const candidateId = record === null ? null : asString(record["candidateId"]);
      if (record === null || candidateId === null) continue;
      invites.push({
        candidateId,
        candidateLabel: asString(record["candidateLabel"]) ?? candidateId,
        slot: asString(record["slot"]) ?? "",
        interviewer: asString(record["interviewer"]) ?? "",
        status: asString(record["status"]) ?? "pending",
        detail: asString(record["detail"]) ?? "",
      });
    }
  }
  return {
    requisitionId,
    roleTitle: asString(artifact["roleTitle"]) ?? "",
    invites,
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type ScreeningScheduleFailureView = { candidateId: string; reason: string };

export type ScreeningScheduleReceiptView = {
  requisitionId: string;
  scheduled: Array<{ candidateId: string; slot: string }>;
  failed: ScreeningScheduleFailureView[];
  replayed: number;
  idempotencyKey: string;
  registryRef: string;
  completedAt: string;
};

export function parseScreeningScheduleReceipt(
  value: unknown,
): ScreeningScheduleReceiptView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const requisitionId = asString(record["requisitionId"]);
  if (requisitionId === null) return null;
  const scheduled: Array<{ candidateId: string; slot: string }> = [];
  if (Array.isArray(record["scheduled"])) {
    for (const item of record["scheduled"]) {
      const entry = asRecord(item);
      const candidateId = entry === null ? null : asString(entry["candidateId"]);
      if (entry === null || candidateId === null) continue;
      scheduled.push({ candidateId, slot: asString(entry["slot"]) ?? "" });
    }
  }
  const failed: ScreeningScheduleFailureView[] = [];
  if (Array.isArray(record["failed"])) {
    for (const item of record["failed"]) {
      const entry = asRecord(item);
      const candidateId = entry === null ? null : asString(entry["candidateId"]);
      if (entry === null || candidateId === null) continue;
      failed.push({ candidateId, reason: asString(entry["reason"]) ?? "" });
    }
  }
  return {
    requisitionId,
    scheduled,
    failed,
    replayed: asNumber(record["replayed"]) ?? 0,
    idempotencyKey: asString(record["idempotencyKey"]) ?? "",
    registryRef: asString(record["registryRef"]) ?? "",
    completedAt: asString(record["completedAt"]) ?? "",
  };
}

function screeningVerdictClass(verdict: string): string {
  if (verdict === "pass") return "pass";
  if (verdict === "partial") return "flag";
  return "fail";
}

function screeningFlagClass(kind: string): string {
  return kind === "protected-attribute" ? "fail" : "flag";
}

function screeningInviteStatusClass(status: string): string {
  if (status === "scheduled") return "pass";
  if (status === "failed") return "fail";
  return "neutral";
}

/** Step 1 — the role, its weighted rubric and the pipeline. */
export function ScreeningRequisitionSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const view = parseScreeningRequisition(artifact);
  if (view === null) {
    return <p className="step-empty">The requisition is not readable yet.</p>;
  }
  return (
    <div className="hr-surface">
      <div className="hr-head">
        <strong>{view.requisitionId}</strong>
        <span className="hr-meta">{view.roleTitle}</span>
        <span className="hr-status-pill status-neutral">{view.seniority}</span>
        <span className="hr-meta">{view.location}</span>
      </div>
      <dl className="hr-kv">
        <div>
          <dt>Department</dt>
          <dd>{view.department}</dd>
        </div>
        <div>
          <dt>Pipeline</dt>
          <dd>{`${view.candidateIds.length} candidate(s)`}</dd>
        </div>
        <div>
          <dt>Interviewers</dt>
          <dd>{view.interviewers.join(", ")}</dd>
        </div>
        <div>
          <dt>Must-haves</dt>
          <dd>{`${view.mustHaves} of ${view.criteria.length} criteria`}</dd>
        </div>
      </dl>
      <h4 className="a11y-section-head">{`Hiring rubric · ${view.criteria.length}`}</h4>
      <table className="dependency-table vendors-check-table">
        <thead>
          <tr>
            <th>Criterion</th>
            <th>Weight</th>
            <th>Kind</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {view.criteria.map((criterion) => (
            <tr key={criterion.id}>
              <td>
                <strong>{criterion.label}</strong>
              </td>
              <td className="dependency-version-cell">{`${criterion.weight}%`}</td>
              <td>
                <span className="line-pill">
                  {criterion.mustHave ? "must-have" : "nice-to-have"}
                </span>
              </td>
              <td className="change-description">{criterion.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="step-summary">{view.summary}</p>
    </div>
  );
}

/** Step 2 — per-criterion verdicts with citations plus the guardrail verdict. */
export function ScreeningScreenSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const view = parseScreeningScreen(artifact);
  if (view === null) {
    return <p className="step-empty">The screening results are not readable yet.</p>;
  }
  return (
    <div className="vendors-verify-surface">
      <div className="impl-head">
        <p className="analysis-summary">{view.summary}</p>
        <div className="analysis-meta">
          {view.guardrail.confidence !== null ? (
            <span className="verdict-confidence">
              {`confidence ${(view.guardrail.confidence * 100).toFixed(0)}%`}
            </span>
          ) : null}
          <span
            className={`hr-status-pill ${view.guardrail.allowed ? "status-pass" : "status-fail"}`}
          >
            {view.guardrail.allowed ? "guardrail clear" : "guardrail flagged"}
          </span>
          <span className="file-count-badge">{`${view.totalFlags} guardrail flag(s)`}</span>
          <span className="vendors-tier-badge tier-medium">{view.department}</span>
        </div>
      </div>
      <p className="step-summary">{view.guardrail.summary}</p>
      <section className="vendors-candidates">
        {view.candidates.map((candidate) => (
          <article
            key={candidate.candidateId}
            className="dependency-group-card vendors-candidate-card"
          >
            <header className="file-card-head">
              <strong>{`${candidate.candidateLabel} · ${candidate.candidateId}`}</strong>
              <span className="line-pill">{`score ${candidate.score}`}</span>
              {candidate.flags.length > 0 ? (
                <span className="vendors-check-pill check-flag">
                  {`${candidate.flags.length} flag(s)`}
                </span>
              ) : (
                <span className="vendors-check-pill check-pass">clear</span>
              )}
            </header>
            <p className="vendors-doc-meta">{candidate.headline}</p>
            {candidate.mustHaveMisses.length > 0 ? (
              <p className="file-validators">
                {`Must-have misses: ${candidate.mustHaveMisses.join(", ")}`}
              </p>
            ) : null}
            <table className="dependency-table vendors-check-table">
              <thead>
                <tr>
                  <th>Criterion</th>
                  <th>Verdict</th>
                  <th>Citations</th>
                </tr>
              </thead>
              <tbody>
                {candidate.verdicts.map((verdict) => (
                  <tr
                    key={verdict.criterionId}
                    className={`check-${screeningVerdictClass(verdict.verdict)}`}
                  >
                    <td>
                      <strong>{verdict.label}</strong>
                      <span className="vendors-doc-meta">
                        {` · weight ${verdict.weight}${verdict.mustHave ? " · must-have" : ""}`}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`vendors-check-pill check-${screeningVerdictClass(
                          verdict.verdict,
                        )}`}
                      >
                        {verdict.verdict}
                      </span>
                    </td>
                    <td>
                      {verdict.citations.length === 0 ? (
                        <span className="vendors-doc-meta">No citations</span>
                      ) : (
                        <ul className="completion-files">
                          {verdict.citations.map((citation) => (
                            <li key={`${citation.sourceId}:${citation.span}`}>
                              {`${citation.sourceId} @ ${citation.span} — ${citation.text}`}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {candidate.flags.length > 0 ? (
              <section className="vendors-manual-review">
                <h4 className="a11y-section-head">{`Guardrail flags · ${candidate.flags.length}`}</h4>
                <ul className="vendors-review-list">
                  {candidate.flags.map((flag, index) => (
                    <li key={`${flag.kind}:${flag.sourceId ?? "none"}:${index}`}>
                      <div className="vendors-doc-head">
                        <strong>{flag.kind}</strong>
                        <span
                          className={`vendors-check-pill check-${screeningFlagClass(flag.kind)}`}
                        >
                          {flag.kind}
                        </span>
                      </div>
                      <p className="change-description">{flag.detail}</p>
                      {flag.sourceId !== null ? (
                        <p className="vendors-doc-meta">
                          {`Source: ${flag.sourceId}${
                            flag.span === null || flag.span === "" ? "" : ` @ ${flag.span}`
                          }`}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </article>
        ))}
      </section>
    </div>
  );
}

/** Step 3 — per-candidate include/exclude with the recorded reasons. */
export function ScreeningShortlistSurface({
  artifact,
  editable,
  draft,
  onChange,
}: {
  artifact: Record<string, unknown>;
  editable: boolean;
  draft: ScreeningShortlistDraft | null;
  onChange: (draft: ScreeningShortlistDraft) => void;
}) {
  const view = parseScreeningShortlist(artifact);
  if (view === null) {
    return <p className="step-empty">The shortlist is not readable yet.</p>;
  }
  const entries = draft?.entries ?? view.entries;
  const included = entries.filter((entry) => entry.decision === "include").length;
  const excluded = entries.length - included;
  const noneIncluded = entries.length > 0 && included === 0;
  const missingReason = entries.find(
    (entry) => entry.decision === "exclude" && entry.reason.trim() === "",
  );

  function setEntry(candidateId: string, patch: Partial<ScreeningShortlistEntryView>): void {
    onChange({
      entries: entries.map((entry) =>
        entry.candidateId === candidateId ? { ...entry, ...patch } : entry,
      ),
    });
  }

  return (
    <div className="vendors-approve-surface">
      <p className="step-summary">{view.summary}</p>
      <div className="analysis-meta">
        <span className="file-count-badge">{`${included} included`}</span>
        <span className="file-count-badge">{`${excluded} excluded`}</span>
        <span className="file-count-badge">
          {noneIncluded ? "Awaiting at least one include" : "Ready to schedule"}
        </span>
      </div>
      <ul className="vendors-chain-list">
        {entries.map((entry) => (
          <li
            key={entry.candidateId}
            className={`vendors-chain-row state-${
              entry.decision === "include" ? "approved" : "pending"
            }`}
          >
            <div className="vendors-chain-body">
              <div className="vendors-chain-head">
                <strong>{`${entry.candidateLabel} · ${entry.candidateId}`}</strong>
                <span className="line-pill">{`score ${entry.score}`}</span>
                <span className="vendors-chain-role">
                  {entry.flags > 0 ? `${entry.flags} guardrail flag(s)` : "no guardrail flags"}
                </span>
                <span
                  className={`vendors-chain-state state-${
                    entry.decision === "include" ? "approved" : "pending"
                  }`}
                >
                  {entry.decision}
                </span>
              </div>
              {editable && (
                <div className="vendors-chain-actions">
                  <button
                    type="button"
                    className={entry.decision === "include" ? "approve" : ""}
                    onClick={() => setEntry(entry.candidateId, { decision: "include" })}
                  >
                    Include
                  </button>
                  <button
                    type="button"
                    className={entry.decision === "exclude" ? "approve" : ""}
                    onClick={() => setEntry(entry.candidateId, { decision: "exclude" })}
                  >
                    Exclude
                  </button>
                </div>
              )}
              {editable && entry.decision === "exclude" && (
                <label className="vendors-review-note">
                  <span>Exclusion reason</span>
                  <textarea
                    rows={2}
                    maxLength={500}
                    value={entry.reason}
                    placeholder="Why is this candidate excluded?"
                    onChange={(event) =>
                      setEntry(entry.candidateId, { reason: event.target.value })
                    }
                  />
                </label>
              )}
              {!editable && entry.reason !== "" && (
                <p className="change-description">
                  {entry.decision === "exclude" ? `Excluded: ${entry.reason}` : entry.reason}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {noneIncluded && (
        <p className="run-action-error" role="alert">
          Include at least one candidate before scheduling interviews.
        </p>
      )}
      {missingReason !== undefined && (
        <p className="run-action-error" role="alert">
          {`${missingReason.candidateLabel} is excluded without a reason; record why.`}
        </p>
      )}
      <p className="step-summary">
        Scheduling sends one invite per included candidate; every exclusion keeps its reason on the
        record.
      </p>
    </div>
  );
}

/** Step 4 — the invite plan, per-invite failures and the schedule receipt. */
export function ScreeningScheduleSurface({
  artifact,
  receipt,
}: {
  artifact: Record<string, unknown>;
  receipt: ScreeningScheduleReceiptView | null;
}) {
  const view = parseScreeningSchedule(artifact);
  if (view === null) {
    if (receipt !== null) {
      return (
        <div className="vendors-collect-surface">
          <article className="receipt-card">
            <strong>{`Interview invites for ${receipt.requisitionId}`}</strong>
            <ul className="completion-files">
              <li>
                {`Scheduled: ${
                  receipt.scheduled.map((entry) => entry.candidateId).join(", ") || "none"
                }`}
              </li>
              <li>
                {`Failed: ${
                  receipt.failed.map((failure) => failure.candidateId).join(", ") || "none"
                }`}
              </li>
              <li>{`Registry: ${receipt.registryRef}`}</li>
              <li>{`Completed ${receipt.completedAt}`}</li>
            </ul>
          </article>
        </div>
      );
    }
    return <p className="step-empty">The interview plan is not readable yet.</p>;
  }
  return (
    <div className="vendors-collect-surface">
      <div className="impl-head">
        <p className="analysis-summary">{view.summary}</p>
        <div className="analysis-meta">
          <span className={`hr-status-pill ${receipt === null ? "status-neutral" : "status-pass"}`}>
            {receipt === null
              ? "preview"
              : receipt.failed.length > 0
                ? "scheduled with failures"
                : "scheduled"}
          </span>
        </div>
      </div>
      <table className="dependency-table vendors-check-table">
        <thead>
          <tr>
            <th>Candidate</th>
            <th>Slot</th>
            <th>Interviewer</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {view.invites.map((invite) => (
            <tr
              key={invite.candidateId}
              className={`check-${screeningInviteStatusClass(invite.status)}`}
            >
              <td>
                <strong>{`${invite.candidateLabel} · ${invite.candidateId}`}</strong>
              </td>
              <td className="dependency-version-cell">{invite.slot}</td>
              <td className="dependency-version-cell">{invite.interviewer}</td>
              <td>
                <span
                  className={`vendors-check-pill check-${screeningInviteStatusClass(
                    invite.status,
                  )}`}
                >
                  {invite.status}
                </span>
              </td>
              <td className="change-description">{invite.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {receipt !== null && receipt.failed.length > 0 && (
        <section className="vendors-manual-review">
          <h4 className="a11y-section-head">{`Failures · ${receipt.failed.length}`}</h4>
          <ul className="vendors-review-list">
            {receipt.failed.map((failure) => (
              <li key={failure.candidateId}>
                <div className="vendors-doc-head">
                  <strong>{failure.candidateId}</strong>
                  <span className="vendors-check-pill check-fail">failed</span>
                </div>
                <p className="change-description">{failure.reason}</p>
              </li>
            ))}
          </ul>
          <p className="step-summary">
            Failures are listed verbatim; re-running the schedule replays the invites that already
            exist and only retries the missing ones.
          </p>
        </section>
      )}
      {receipt !== null && (
        <article className="receipt-card">
          <strong>
            {receipt.failed.length > 0
              ? `Interview invites sent with ${receipt.failed.length} failure(s)`
              : `Interview invites scheduled for ${receipt.scheduled.length} candidate(s)`}
          </strong>
          <ul className="completion-files">
            <li>
              {`Scheduled: ${
                receipt.scheduled
                  .map((entry) => `${entry.candidateId} @ ${entry.slot}`)
                  .join(", ") || "none"
              }`}
            </li>
            <li>
              {`Failed: ${
                receipt.failed.map((failure) => failure.candidateId).join(", ") || "none"
              }`}
            </li>
            <li>{`Replayed: ${receipt.replayed}`}</li>
            <li>{`Idempotency key: ${receipt.idempotencyKey}`}</li>
            <li>{`Registry: ${receipt.registryRef}`}</li>
            <li>{`Completed ${receipt.completedAt}`}</li>
          </ul>
        </article>
      )}
      <p className="step-summary">
        Scheduling is idempotent per candidate and requisition — replaying this decision returns
        the original receipt and never sends the same invite twice.
      </p>
    </div>
  );
}

/* ------------------------------------------------------- hr help */

function hrHelpStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export type HrHelpIntakeView = {
  caseId: string;
  ticketKey: string;
  question: string;
  topics: string[];
  summary: string;
};

export function parseHrHelpIntake(artifact: Record<string, unknown>): HrHelpIntakeView | null {
  const caseId = asString(artifact["caseId"]);
  if (caseId === null) return null;
  return {
    caseId,
    ticketKey: asString(artifact["ticketKey"]) ?? "",
    question: asString(artifact["question"]) ?? "",
    topics: hrHelpStrings(artifact["topics"]),
    summary: asString(artifact["summary"]) ?? "",
  };
}

/** Step 1 — the employee question plus the terms retrieval will match on. */
export function HrHelpIntakeSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const view = parseHrHelpIntake(artifact);
  if (view === null) {
    return <p className="step-empty">The help request is not readable yet.</p>;
  }
  return (
    <div className="hr-surface">
      <div className="hr-head">
        <span className="hr-status-pill status-neutral">question</span>
        <strong>{view.caseId}</strong>
        <span className="hr-meta">{view.ticketKey}</span>
      </div>
      <p className="analysis-summary">{view.question}</p>
      <dl className="hr-kv">
        <div>
          <dt>Case</dt>
          <dd>{view.caseId}</dd>
        </div>
        <div>
          <dt>Ticket</dt>
          <dd>{view.ticketKey}</dd>
        </div>
      </dl>
      <h4 className="a11y-section-head">{`Retrieval topics · ${view.topics.length}`}</h4>
      <ul className="completion-files">
        {view.topics.map((topic) => (
          <li key={topic}>{topic}</li>
        ))}
      </ul>
      <p className="step-summary">{view.summary}</p>
    </div>
  );
}

export type HrHelpPassageView = {
  sourceId: string;
  span: string;
  title: string;
  text: string;
  score: number;
  stale: boolean;
};

export type HrHelpRetrieveView = {
  caseId: string;
  ticketKey: string;
  question: string;
  passages: HrHelpPassageView[];
  staleCount: number;
  matchedTerms: string[];
  summary: string;
};

function hrHelpPassages(value: unknown): HrHelpPassageView[] {
  const passages: HrHelpPassageView[] = [];
  if (!Array.isArray(value)) return passages;
  for (const item of value) {
    const record = asRecord(item);
    const sourceId = record === null ? null : asString(record["sourceId"]);
    if (record === null || sourceId === null) continue;
    passages.push({
      sourceId,
      span: asString(record["span"]) ?? "",
      title: asString(record["title"]) ?? sourceId,
      text: asString(record["text"]) ?? "",
      score: asNumber(record["score"]) ?? 0,
      stale: record["stale"] === true,
    });
  }
  return passages;
}

export function parseHrHelpRetrieve(artifact: Record<string, unknown>): HrHelpRetrieveView | null {
  const caseId = asString(artifact["caseId"]);
  if (caseId === null) return null;
  return {
    caseId,
    ticketKey: asString(artifact["ticketKey"]) ?? "",
    question: asString(artifact["question"]) ?? "",
    passages: hrHelpPassages(artifact["passages"]),
    staleCount: asNumber(artifact["staleCount"]) ?? 0,
    matchedTerms: hrHelpStrings(artifact["matchedTerms"]),
    summary: asString(artifact["summary"]) ?? "",
  };
}

/** Step 2 — the ranked passages the draft must cite, with staleness flags. */
export function HrHelpRetrieveSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const view = parseHrHelpRetrieve(artifact);
  if (view === null) {
    return <p className="step-empty">The retrieval results are not readable yet.</p>;
  }
  return (
    <div className="vendors-collect-surface">
      <div className="impl-head">
        <p className="analysis-summary">{view.summary}</p>
        <div className="analysis-meta">
          <span className="file-count-badge">{`${view.passages.length} passage(s)`}</span>
          <span
            className={`hr-status-pill ${view.staleCount > 0 ? "status-flag" : "status-pass"}`}
          >
            {`${view.staleCount} stale`}
          </span>
        </div>
      </div>
      {view.matchedTerms.length > 0 && (
        <p className="vendors-doc-meta">{`Matched terms: ${view.matchedTerms.join(", ")}`}</p>
      )}
      <section className="vendors-candidates">
        {view.passages.map((passage) => (
          <article
            key={`${passage.sourceId}:${passage.span}`}
            className="dependency-group-card vendors-candidate-card"
          >
            <header className="file-card-head">
              <strong>{passage.title}</strong>
              <span className="line-pill">{`score ${passage.score}`}</span>
              <span
                className={`vendors-check-pill ${passage.stale ? "check-fail" : "check-pass"}`}
              >
                {passage.stale ? "stale" : "current"}
              </span>
            </header>
            <p className="vendors-doc-meta">{`${passage.sourceId} @ ${passage.span}`}</p>
            <p className="change-description">{passage.text}</p>
          </article>
        ))}
      </section>
    </div>
  );
}

export type HrHelpCitationView = { sourceId: string; span: string };

export type HrHelpFlagView = {
  kind: string;
  detail: string;
  sourceId: string | null;
  span: string | null;
};

export type HrHelpDraftView = {
  caseId: string;
  ticketKey: string;
  question: string;
  answer: string;
  citations: HrHelpCitationView[];
  flags: HrHelpFlagView[];
  guardrail: { allowed: boolean; summary: string; confidence: number | null };
  totalFlags: number;
  summary: string;
};

function hrHelpCitations(value: unknown): HrHelpCitationView[] {
  const citations: HrHelpCitationView[] = [];
  if (!Array.isArray(value)) return citations;
  for (const item of value) {
    const record = asRecord(item);
    const sourceId = record === null ? null : asString(record["sourceId"]);
    if (record === null || sourceId === null) continue;
    citations.push({ sourceId, span: asString(record["span"]) ?? "" });
  }
  return citations;
}

function hrHelpFlags(value: unknown): HrHelpFlagView[] {
  const flags: HrHelpFlagView[] = [];
  if (!Array.isArray(value)) return flags;
  for (const item of value) {
    const record = asRecord(item);
    if (record === null) continue;
    const kind = asString(record["kind"]);
    if (kind === null) continue;
    flags.push({
      kind,
      detail: asString(record["detail"]) ?? "",
      sourceId: asString(record["sourceId"]),
      span: asString(record["span"]),
    });
  }
  return flags;
}

export function parseHrHelpDraft(artifact: Record<string, unknown>): HrHelpDraftView | null {
  const caseId = asString(artifact["caseId"]);
  if (caseId === null) return null;
  const guardrail = asRecord(artifact["guardrail"]);
  return {
    caseId,
    ticketKey: asString(artifact["ticketKey"]) ?? "",
    question: asString(artifact["question"]) ?? "",
    answer: asString(artifact["answer"]) ?? "",
    citations: hrHelpCitations(artifact["citations"]),
    flags: hrHelpFlags(artifact["flags"]),
    guardrail: {
      allowed: guardrail !== null && guardrail["allowed"] === true,
      summary: asString(guardrail?.["summary"]) ?? "",
      confidence: guardrail === null ? null : asNumber(guardrail["confidence"]),
    },
    totalFlags: asNumber(artifact["totalFlags"]) ?? 0,
    summary: asString(artifact["summary"]) ?? "",
  };
}

function hrHelpFlagClass(kind: string): string {
  return kind === "pii-leakage" ? "fail" : "flag";
}

/** Step 3 — the cited answer plus the guardrail verdict. */
export function HrHelpDraftSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const view = parseHrHelpDraft(artifact);
  if (view === null) {
    return <p className="step-empty">The drafted answer is not readable yet.</p>;
  }
  return (
    <div className="vendors-verify-surface">
      <div className="impl-head">
        <p className="analysis-summary">{view.question}</p>
        <div className="analysis-meta">
          {view.guardrail.confidence !== null ? (
            <span className="verdict-confidence">
              {`confidence ${(view.guardrail.confidence * 100).toFixed(0)}%`}
            </span>
          ) : null}
          <span
            className={`hr-status-pill ${view.guardrail.allowed ? "status-pass" : "status-fail"}`}
          >
            {view.guardrail.allowed ? "guardrail clear" : "guardrail flagged"}
          </span>
          <span className="file-count-badge">{`${view.totalFlags} guardrail flag(s)`}</span>
        </div>
      </div>
      <p className="step-summary">{view.guardrail.summary}</p>
      <section className="vendors-manual-review">
        <h4 className="a11y-section-head">Answer</h4>
        <p className="change-description">{view.answer}</p>
      </section>
      <h4 className="a11y-section-head">{`Citations · ${view.citations.length}`}</h4>
      <ul className="completion-files">
        {view.citations.map((citation) => (
          <li key={`${citation.sourceId}:${citation.span}`}>
            {`${citation.sourceId} @ ${citation.span}`}
          </li>
        ))}
      </ul>
      {view.flags.length > 0 && (
        <section className="vendors-manual-review">
          <h4 className="a11y-section-head">{`Guardrail flags · ${view.flags.length}`}</h4>
          <ul className="vendors-review-list">
            {view.flags.map((flag, index) => (
              <li key={`${flag.kind}:${flag.sourceId ?? "none"}:${index}`}>
                <div className="vendors-doc-head">
                  <strong>{flag.kind}</strong>
                  <span className={`vendors-check-pill check-${hrHelpFlagClass(flag.kind)}`}>
                    {flag.kind}
                  </span>
                </div>
                <p className="change-description">{flag.detail}</p>
                {flag.sourceId !== null ? (
                  <p className="vendors-doc-meta">
                    {`Source: ${flag.sourceId}${
                      flag.span === null || flag.span === "" ? "" : ` @ ${flag.span}`
                    }`}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="step-summary">{view.summary}</p>
    </div>
  );
}

export type HrHelpApproveView = {
  caseId: string;
  ticketKey: string;
  approverRole: string;
  approverLabel: string;
  slaHours: number | null;
  state: string;
  requestedAt: string;
  decidedAt: string | null;
  note: string | null;
  summary: string;
};

export function parseHrHelpApprove(artifact: Record<string, unknown>): HrHelpApproveView | null {
  const caseId = asString(artifact["caseId"]);
  if (caseId === null) return null;
  return {
    caseId,
    ticketKey: asString(artifact["ticketKey"]) ?? "",
    approverRole: asString(artifact["approverRole"]) ?? "",
    approverLabel: asString(artifact["approverLabel"]) ?? "",
    slaHours: asNumber(artifact["slaHours"]),
    state: asString(artifact["state"]) ?? "pending",
    requestedAt: asString(artifact["requestedAt"]) ?? "",
    decidedAt: asString(artifact["decidedAt"]),
    note: asString(artifact["note"]),
    summary: asString(artifact["summary"]) ?? "",
  };
}

/** Step 4 — the people-partner approval the send receipt will back. */
export function HrHelpApproveSurface({ artifact }: { artifact: Record<string, unknown> }) {
  const view = parseHrHelpApprove(artifact);
  if (view === null) {
    return <p className="step-empty">The approval artifact is not readable yet.</p>;
  }
  return (
    <div className="hr-surface">
      <div className="hr-head">
        <span
          className={`hr-status-pill ${view.state === "approved" ? "status-pass" : "status-flag"}`}
        >
          {view.state}
        </span>
        <strong>{view.approverLabel}</strong>
        <span className="hr-meta">{view.approverRole}</span>
        {view.slaHours !== null && <span className="hr-meta">{`target ${view.slaHours}h`}</span>}
      </div>
      <dl className="hr-kv">
        <div>
          <dt>Case</dt>
          <dd>{view.caseId}</dd>
        </div>
        <div>
          <dt>Ticket</dt>
          <dd>{view.ticketKey}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>{view.requestedAt}</dd>
        </div>
        <div>
          <dt>Decided</dt>
          <dd>{view.decidedAt ?? "—"}</dd>
        </div>
      </dl>
      {view.note !== null && <p className="hr-callout">{`Note: ${view.note}`}</p>}
      <p className="step-summary">{view.summary}</p>
    </div>
  );
}

export type HrHelpSendView = {
  caseId: string;
  ticketKey: string;
  answerId: string;
  citationCount: number;
  status: string;
  idempotencyKey: string;
  existing: { answerId: string; createdAt: string } | null;
  summary: string;
};

export function parseHrHelpSend(artifact: Record<string, unknown>): HrHelpSendView | null {
  const response = asRecord(artifact["response"]);
  const answerId = response === null ? null : asString(response["answerId"]);
  if (response === null || answerId === null) return null;
  const existingRecord = asRecord(artifact["existing"]);
  const existingAnswerId = existingRecord === null ? null : asString(existingRecord["answerId"]);
  return {
    caseId: asString(response["caseId"]) ?? "",
    ticketKey: asString(response["ticketKey"]) ?? "",
    answerId,
    citationCount: asNumber(response["citationCount"]) ?? 0,
    status: asString(response["status"]) ?? "sent",
    idempotencyKey: asString(artifact["idempotencyKey"]) ?? "",
    existing:
      existingRecord === null || existingAnswerId === null
        ? null
        : {
            answerId: existingAnswerId,
            createdAt: asString(existingRecord["createdAt"]) ?? "",
          },
    summary: asString(artifact["summary"]) ?? "",
  };
}

export type HrHelpReceiptView = {
  caseId: string;
  ticketKey: string;
  answerId: string;
  citations: HrHelpCitationView[];
  created: boolean;
  registryRef: string;
  completedAt: string;
};

export function parseHrHelpReceipt(value: unknown): HrHelpReceiptView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const answerId = asString(record["answerId"]);
  const caseId = asString(record["caseId"]);
  if (answerId === null || caseId === null) return null;
  return {
    caseId,
    ticketKey: asString(record["ticketKey"]) ?? "",
    answerId,
    citations: hrHelpCitations(record["citations"]),
    created: record["created"] === true,
    registryRef: asString(record["registryRef"]) ?? "",
    completedAt: asString(record["completedAt"]) ?? "",
  };
}

/** Step 5 — the recorded answer preview and the signed send receipt. */
export function HrHelpSendSurface({
  artifact,
  receipt,
}: {
  artifact: Record<string, unknown>;
  receipt: HrHelpReceiptView | null;
}) {
  const view = parseHrHelpSend(artifact);
  if (view === null) {
    if (receipt === null) {
      return <p className="step-empty">The recorded answer is not readable yet.</p>;
    }
    return (
      <div className="vendors-collect-surface">
        <article className="receipt-card">
          <strong>{`Answer ${receipt.answerId} for case ${receipt.caseId}`}</strong>
          <ul className="completion-files">
            <li>{`Ticket: ${receipt.ticketKey}`}</li>
            <li>{`Citations: ${receipt.citations.length}`}</li>
            <li>{`Created: ${receipt.created ? "yes" : "replayed"}`}</li>
            <li>{`Registry: ${receipt.registryRef}`}</li>
            <li>{`Completed ${receipt.completedAt}`}</li>
          </ul>
        </article>
      </div>
    );
  }
  return (
    <div className="vendors-collect-surface">
      <div className="impl-head">
        <p className="analysis-summary">{view.summary}</p>
        <div className="analysis-meta">
          <span className={`hr-status-pill ${receipt === null ? "status-neutral" : "status-pass"}`}>
            {receipt === null ? "preview" : receipt.created ? "recorded" : "replayed"}
          </span>
        </div>
      </div>
      <dl className="hr-kv">
        <div>
          <dt>Answer</dt>
          <dd>{view.answerId}</dd>
        </div>
        <div>
          <dt>Case</dt>
          <dd>{view.caseId}</dd>
        </div>
        <div>
          <dt>Ticket</dt>
          <dd>{view.ticketKey}</dd>
        </div>
        <div>
          <dt>Citations</dt>
          <dd>{`${view.citationCount}`}</dd>
        </div>
        <div>
          <dt>Idempotency key</dt>
          <dd>{view.idempotencyKey}</dd>
        </div>
      </dl>
      {view.existing !== null && (
        <p className="hr-callout">
          {`This case already has answer ${view.existing.answerId} (${view.existing.createdAt}); the send replays idempotently.`}
        </p>
      )}
      {receipt !== null && (
        <article className="receipt-card">
          <strong>
            {receipt.created
              ? `Answer ${receipt.answerId} recorded for case ${receipt.caseId}`
              : `Answer ${receipt.answerId} already recorded; the send replayed`}
          </strong>
          <ul className="completion-files">
            <li>{`Ticket: ${receipt.ticketKey}`}</li>
            <li>
              {`Citations: ${
                receipt.citations
                  .map((citation) => `${citation.sourceId} @ ${citation.span}`)
                  .join(", ") || "none"
              }`}
            </li>
            <li>{`Registry: ${receipt.registryRef}`}</li>
            <li>{`Completed ${receipt.completedAt}`}</li>
          </ul>
        </article>
      )}
      <p className="step-summary">
        Sending is idempotent per case and ticket — replaying this decision returns the original
        receipt and never records the answer twice.
      </p>
    </div>
  );
}
