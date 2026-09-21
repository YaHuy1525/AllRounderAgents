import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
  SecurityApproveSurface,
  SecurityContainSurface,
  SecurityDecideSurface,
  SecurityIngestSurface,
  SecurityInvestigateSurface,
  SecurityTriageSurface,
  SelectPrSurface,
  VendorApproveSurface,
  VendorCollectSurface,
  VendorCreateSurface,
  VendorRiskSurface,
  VendorVerifySurface,
  accessibilityRouteTotals,
  cveUrl,
  featureBranch,
  issueFixBranch,
  parseAccessibilityReceipt,
  parseDependencyReceipt,
  parseFeatureReceipt,
  parseIssueReceipt,
  parseSecurityApprove,
  parseSecurityDecide,
  parseSecurityIngest,
  parseSecurityInvestigate,
  parseSecurityPreview,
  parseSecurityReceipt,
  parseSecurityTriage,
  parseVendorCreate,
  parseVendorReceipt,
  SECURITY_CLASSIFICATION_LABELS,
  securityCitationLabel,
  securitySourceLabel,
  vendorDocumentTotals,
  type DependencyReceiptView,
  type FeatureReceiptView,
  type IssueReceiptView,
  type ReceiptView,
  type VendorDocumentView,
} from "@/components/console/RunSurface";
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
  ScreeningRequisitionSurface,
  ScreeningScheduleSurface,
  ScreeningScreenSurface,
  ScreeningShortlistSurface,
  parseHrHelpReceipt,
  parseHrHelpSend,
  parseLeaveReceipt,
  parseOffboardingAttestReceipt,
  parseOffboardingRevokeReceipt,
  parseOnboardingReceipt,
  parseScreeningScheduleReceipt,
  parseScreeningShortlist,
  type ScreeningShortlistDraft,
} from "@/components/console/RunSurfaceHr";

const PR = {
  number: 7,
  title: "Harden the refund endpoint",
  repository: "acme/app",
  author: "dev",
  baseBranch: "main",
  headSha: "a".repeat(40),
  draft: false,
};

const MALICIOUS_SUMMARY = '<script>alert("xss")</script> & <img src=x onerror=alert(1)>';

function reviewArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullRequest: PR,
    verdict: "request_changes",
    confidence: 0.82,
    summary: MALICIOUS_SUMMARY,
    strengths: ["Reuses the payments client."],
    improvements: ["Authorize before touching the payment."],
    comments: [
      { path: "src/api/refunds.ts", line: 11, body: '<img src=x onerror=alert(2)>' },
      { path: "src/api/refunds.ts", line: 18, body: "Second comment." },
      { path: "src/lib/auth.ts", line: 4, body: "Check the scope." },
    ],
    deltaOnly: false,
    reviewedSha: "a".repeat(40),
    ...overrides,
  };
}

describe("AI review surface", () => {
  it("renders the verdict, the confidence, and every comment group", () => {
    const html = renderToString(
      <AiReviewSurface artifact={reviewArtifact()} editing={false} draft={null} onChange={() => {}} />,
    );
    expect(html).toContain("Request changes");
    expect(html).toContain("confidence 82%");
    expect(html).toContain("Inline comments (3)");
    expect(html).toContain("src/api/refunds.ts");
    expect(html).toContain("src/lib/auth.ts");
    expect(html).toContain("Expand All");
    expect(html).toContain("Collapse All");
  });

  it("renders server content as text, never as markup", () => {
    const html = renderToString(
      <AiReviewSurface artifact={reviewArtifact()} editing={false} draft={null} onChange={() => {}} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("flags delta-only reviews on follow-ups", () => {
    const html = renderToString(
      <AiReviewSurface
        artifact={reviewArtifact({ deltaOnly: true })}
        editing={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("new pushes only");
  });

  it("switches to the inline editor with per-comment fields", () => {
    const html = renderToString(
      <AiReviewSurface artifact={reviewArtifact()} editing draft={null} onChange={() => {}} />,
    );
    expect(html).toContain("Strengths (one per line)");
    expect(html).toContain("Suggested improvements (one per line)");
    expect(html).toContain("src/api/refunds.ts:11");
    expect(html).toContain("src/lib/auth.ts:4");
  });
});

describe("select PR surface", () => {
  it("offers the candidate picker until a pull request is chosen", () => {
    const html = renderToString(
      <SelectPrSurface
        artifact={{
          repository: "acme/app",
          candidates: [PR, { ...PR, number: 8, title: "Second candidate" }],
          selected: null,
        }}
        editable
        selectedNumber={null}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("Choose a pull request");
    expect(html).toContain("#7");
    expect(html).toContain("#8");
    expect(html).toContain('type="radio"');
  });

  it("shows the selected pull request with a Change button", () => {
    const html = renderToString(
      <SelectPrSurface
        artifact={{ repository: "acme/app", candidates: [PR], selected: PR }}
        editable
        selectedNumber={7}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("#7");
    expect(html).toContain("Change");
    expect(html).not.toContain("Choose a pull request");
  });
});

describe("review options surface", () => {
  const artifact = {
    pullRequest: PR,
    categories: [
      { id: "code-quality", label: "Code Quality", enabled: true },
      { id: "security", label: "Security", enabled: false },
    ],
    guidance: "",
  };

  it("renders the category cards and the bulk controls", () => {
    const html = renderToString(
      <ReviewOptionsSurface artifact={artifact} editable draft={null} onChange={() => {}} />,
    );
    expect(html).toContain("1 of 2 categories enabled");
    expect(html).toContain("Code Quality");
    expect(html).toContain("Security");
    expect(html).toContain("Select All");
    expect(html).toContain("Clear");
    expect(html).toContain("Custom guidance");
    expect(html).toContain("4000");
  });
});

describe("complete surface", () => {
  const receipt: ReceiptView = {
    reviewId: "review-42",
    url: "https://github.com/acme/app/pull/7#pullrequestreview-42",
    verdict: "approve",
    reviewedSha: "a".repeat(40),
    postedComments: [{ path: "src/api/refunds.ts", line: 11 }],
  };

  it("renders the receipt, the review link, and the follow-up action", () => {
    const html = renderToString(
      <CompleteSurface
        artifact={reviewArtifact({ verdict: "approve" })}
        receipt={receipt}
        followUp={{ onStart: () => {}, busy: false }}
      />,
    );
    expect(html).toContain("Review #review-42");
    expect(html).toContain("View the posted review");
    expect(html).toContain("https://github.com/acme/app/pull/7#pullrequestreview-42");
    expect(html).toContain("1 inline comment posted");
    expect(html).toContain("Start follow-up review (deltas only)");
  });

  it("drops non-https receipt links", () => {
    const html = renderToString(
      <CompleteSurface
        artifact={reviewArtifact()}
        receipt={{ ...receipt, url: "javascript:alert(1)" }}
        followUp={{ onStart: () => {}, busy: false }}
      />,
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain("the link is unavailable");
  });

  it("shows the pending card before the review is posted", () => {
    const html = renderToString(<CompleteSurface artifact={reviewArtifact()} receipt={null} />);
    expect(html).toContain("The review is ready to post");
    expect(html).not.toContain("Start follow-up review");
  });
});

const ISSUE_TICKET = { key: "ABC-1", summary: "Payment retries fail", status: "open" };

function issueSelectionArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticket: ISSUE_TICKET,
    candidates: [
      ISSUE_TICKET,
      { key: "ABC-2", summary: "Refund page crashes", status: "in progress" },
    ],
    repositories: ["acme/app", "acme/lib"],
    branches: ["main", "release/1.x"],
    repository: "acme/app",
    baseBranch: "main",
    advanced: { includeRegressionTest: true, maxChangedFiles: 10, guidance: "" },
    ...overrides,
  };
}

function issueAnalysisArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "The retry loop swallows the 409 before the backoff.",
    confidence: 0.62,
    similarUpdates: [
      { reference: "ABC-9", note: "The same guard shipped for the refunds client." },
    ],
    affectedFiles: [
      {
        path: "src/lib/retry.ts",
        startLine: 2,
        endLine: 10,
        changeDescription: "Guard the 409 before scheduling the next attempt.",
        validators: ["basic-syntax", "json"],
      },
    ],
    regressionTest: { path: "tests/retry.test.ts", description: "Reproduces the 409 retry loop." },
    ...overrides,
  };
}

function issueImplementationArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    summary: "Guard the 409 before scheduling a retry.",
    files: [
      {
        path: "src/lib/retry.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        diff: "@@ -1,2 +1,4 @@\n-const retry = schedule();\n+const retry = guarded() ? schedule() : null;\n+logRetry();",
        content: "const retry = guarded() ? schedule() : null;",
        validators: ["basic-syntax"],
      },
    ],
    regressionTest: {
      path: "tests/retry.test.ts",
      content: "expect(guard(409)).toBe(true);",
      additions: 2,
      deletions: 0,
      diff: "+expect(guard(409)).toBe(true);",
    },
    validation: {
      passed: true,
      attempts: 1,
      results: [
        { validator: "basic-syntax", path: "src/lib/retry.ts", passed: true, message: "" },
      ],
    },
    repair: { attempted: true, applied: true },
    ...overrides,
  };
}

const ISSUE_COMPLETION = {
  branch: "fix/abc-1",
  files: [{ path: "src/lib/retry.ts", status: "modified", additions: 3, deletions: 1 }],
  regressionTestPath: "tests/retry.test.ts",
  ticketTransition: { ticketKey: "ABC-1", targetStatus: "In Review" },
  validation: {
    passed: true,
    attempts: 1,
    results: [{ validator: "basic-syntax", path: "src/lib/retry.ts", passed: true, message: "" }],
  },
};

describe("issue selection surface", () => {
  it("renders the ticket chips, the pickers, and the fix-branch preview", () => {
    const html = renderToString(
      <IssueSelectionSurface
        artifact={issueSelectionArtifact()}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Bug ticket");
    expect(html).toContain("ABC-1");
    expect(html).toContain("ABC-2");
    expect(html).toContain("Payment retries fail");
    expect(html).toContain('type="radio"');
    expect(html).toContain("ticket-chip selected");
    expect(html).toContain("acme/app");
    expect(html).toContain("release/1.x");
    expect(html).toContain("The fix lands on acme/app@fix/abc-1, branched from main.");
    expect(html).toContain("Advanced Settings");
    expect(html).not.toContain("· edited");
    expect(html).not.toContain("Produce a regression test together with the fix");
  });

  it("flags edited advanced settings and previews the derived fix branch", () => {
    const html = renderToString(
      <IssueSelectionSurface
        artifact={issueSelectionArtifact()}
        editable
        draft={{
          ticket: { key: "ABC-2", summary: "Refund page crashes", status: "in progress" },
          repository: "acme/lib",
          baseBranch: "release/1.x",
          advanced: { includeRegressionTest: false, maxChangedFiles: 5, guidance: "Keep the guard." },
        }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Advanced Settings · edited");
    expect(html).toContain("The fix lands on acme/lib@fix/abc-2, branched from release/1.x.");
  });

  it("disables every control when the run is not editable", () => {
    const html = renderToString(
      <IssueSelectionSurface
        artifact={issueSelectionArtifact()}
        editable={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("disabled");
  });

  it("keeps candidate tickets as text, never markup", () => {
    const html = renderToString(
      <IssueSelectionSurface
        artifact={issueSelectionArtifact({
          candidates: [{ key: "ABC-2", summary: MALICIOUS_SUMMARY, status: "open" }],
        })}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("issueFixBranch", () => {
  it("derives the deterministic fix branch slug", () => {
    expect(issueFixBranch("ABC-1")).toBe("fix/abc-1");
    expect(issueFixBranch("Hot Fix!!")).toBe("fix/hot-fix");
    expect(issueFixBranch("!!!")).toBe("fix/ticket");
  });
});

describe("issue analysis surface", () => {
  const artifact = issueAnalysisArtifact();

  it("renders the summary, the similar-updates callout, the files, and the regression cross-link", () => {
    const html = renderToString(
      <IssueAnalysisSurface artifact={artifact} editing={false} draft={null} onChange={() => {}} />,
    );
    expect(html).toContain("The retry loop swallows the 409 before the backoff.");
    expect(html).toContain("confidence 62%");
    expect(html).toContain("Similar updates");
    expect(html).toContain("ABC-9");
    expect(html).toContain("Affected files");
    expect(html).toContain("src/lib/retry.ts");
    expect(html).toContain("L2–L10");
    expect(html).toContain("Modify");
    expect(html).toContain("Validators: basic-syntax, json");
    expect(html).toContain("Regression test — produced with the fix");
    expect(html).toContain("tests/retry.test.ts — Reproduces the 409 retry loop.");
    expect(html).toContain(
      "The implementation step generates this regression test together with the patch.",
    );
  });

  it("notes when the regression test is turned off", () => {
    const html = renderToString(
      <IssueAnalysisSurface
        artifact={issueAnalysisArtifact({ regressionTest: null })}
        editing={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(
      "No regression test will be produced for this ticket (turned off in Advanced Settings).",
    );
  });

  it("switches to the editor with per-file line-range and validator fields", () => {
    const html = renderToString(
      <IssueAnalysisSurface artifact={artifact} editing draft={null} onChange={() => {}} />,
    );
    expect(html).toContain("Analysis summary");
    expect(html).toContain("Affected files (1)");
    expect(html).toContain("Start line");
    expect(html).toContain("End line");
    expect(html).toContain("Validator");
    expect(html).toContain("basic-syntax");
    expect(html).toContain("Change description");
  });

  it("keeps the analysis content as text, never markup", () => {
    const html = renderToString(
      <IssueAnalysisSurface
        artifact={issueAnalysisArtifact({ summary: MALICIOUS_SUMMARY })}
        editing={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("issue implementation surface", () => {
  const artifact = issueImplementationArtifact();

  it("renders the patch stats, the validators report, and the repair trail", () => {
    const html = renderToString(
      <IssueImplementationSurface artifact={artifact} editing={false} draft={null} onChange={() => {}} />,
    );
    expect(html).toContain("Guard the 409 before scheduling a retry.");
    expect(html).toContain("+3 / −1 across the patch");
    expect(html).toContain("Validators passed · 1 attempt");
    expect(html).toContain("✓ basic-syntax · src/lib/retry.ts");
    expect(html).toContain(
      "Validators failed once; the fix was repaired automatically and re-validated.",
    );
    expect(html).toContain("regression test");
    expect(html).toContain("tests/retry.test.ts");
    expect(html).toContain("diff-add");
    expect(html).toContain("+expect(guard(409)).toBe(true);");
    expect(html).toContain("Hide diff");
    expect(html).toContain("Modify");
  });

  it("reports a failed validation attempt and the failed repair", () => {
    const html = renderToString(
      <IssueImplementationSurface
        artifact={issueImplementationArtifact({
          validation: {
            passed: false,
            attempts: 2,
            results: [
              { validator: "json", path: "package.json", passed: false, message: "Unexpected token" },
            ],
          },
          repair: { attempted: true, applied: false },
        })}
        editing={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Validators failed · 2 attempts");
    expect(html).toContain("✗ json · package.json — Unexpected token");
    expect(html).toContain(
      "the single repair attempt did not pass — review carefully before proceeding.",
    );
  });

  it("switches to the content editors for the patch and the regression test", () => {
    const html = renderToString(
      <IssueImplementationSurface artifact={artifact} editing draft={null} onChange={() => {}} />,
    );
    expect(html).toContain("Implementation summary");
    expect(html).toContain("content-editor");
    expect(html).toContain("const retry = guarded() ? schedule() : null;");
    expect(html).toContain("regression test");
  });

  it("keeps patch content as text, never markup", () => {
    const html = renderToString(
      <IssueImplementationSurface
        artifact={issueImplementationArtifact({ summary: MALICIOUS_SUMMARY })}
        editing={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("issue complete surface", () => {
  it("previews the completion before the Draft PR is opened", () => {
    const html = renderToString(
      <IssueCompleteSurface artifact={ISSUE_COMPLETION} receipt={null} />,
    );
    expect(html).toContain("The fix is validated — opening the Draft PR completes the run");
    expect(html).toContain("1 file on fix/abc-1 · regression test tests/retry.test.ts");
    expect(html).toContain("Ticket ABC-1 → In Review");
    expect(html).toContain("Validators passed · 1 attempt");
    expect(html).toContain("src/lib/retry.ts · modified · +3 −1");
  });

  it("renders the Draft PR receipt with the transition and the case record", () => {
    const receipt: IssueReceiptView = {
      url: "https://github.example/acme/app/pull/12",
      number: 12,
      draft: true,
      branch: "fix/abc-1",
      ticketTransition: { ticketKey: "ABC-1", targetStatus: "In Review" },
      validation: { passed: true, attempts: 1, results: [] },
      regressionTestPath: "tests/retry.test.ts",
      caseId: "case-42",
    };
    const html = renderToString(
      <IssueCompleteSurface artifact={ISSUE_COMPLETION} receipt={receipt} />,
    );
    expect(html).toContain("Draft PR #12");
    expect(html).toContain("draft");
    expect(html).toContain("View the Draft PR");
    expect(html).toContain("https://github.example/acme/app/pull/12");
    expect(html).toContain("Branch fix/abc-1");
    expect(html).toContain("Ticket ABC-1 → In Review");
    expect(html).toContain("Regression test tests/retry.test.ts");
    expect(html).toContain("Recorded on case case-42");
  });

  it("drops non-https receipt links through the parser", () => {
    const parsed = parseIssueReceipt({
      pr: { url: "javascript:alert(1)", number: 12, draft: true },
      branch: "fix/abc-1",
      caseId: "case-42",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.url).toBeNull();
    const html = renderToString(
      <IssueCompleteSurface artifact={ISSUE_COMPLETION} receipt={parsed} />,
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain("the link is unavailable");
  });
});

const FEATURE_TICKET = {
  key: "FEAT-7",
  summary: "Add status filters to the orders search page",
  status: "open",
};

function featureSelectionArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticket: FEATURE_TICKET,
    candidates: [
      FEATURE_TICKET,
      { key: "FEAT-12", summary: "CSV export for orders", status: "in progress" },
    ],
    repositories: ["acme/app", "acme/lib"],
    branches: ["main", "release/1.x"],
    repository: "acme/app",
    baseBranch: "main",
    acceptanceCriteria: [
      { id: "ac-1", text: "Filter by order status.", included: true },
      { id: "ac-2", text: "Remember the filter in the URL.", included: false },
    ],
    advanced: { maxChangedFiles: 10, guidance: "" },
    ...overrides,
  };
}

const SCOPE_DESIGN = {
  ticket: FEATURE_TICKET,
  repository: "acme/app",
  baseBranch: "main",
  sourceSha: "b".repeat(40),
  targetSummary: "Add a status filter row above the orders table.",
  confidence: 0.7,
  areas: [
    { id: "ui", label: "UI", enabled: true },
    { id: "api-data", label: "API & Data", enabled: false },
    { id: "state-logic", label: "State & Logic", enabled: true },
    { id: "tests", label: "Tests", enabled: true },
    { id: "docs-flags", label: "Docs & Flags", enabled: false },
  ],
  guidance: "",
};

function featureImplementationArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    summary: "Add the filter bar and wire it into the orders query.",
    verdict: "needs_attention",
    confidence: 0.55,
    strengths: ["Reuses the existing query hook."],
    risksOpenQuestions: ["URL persistence lands in a follow-up."],
    crossCuttingNotes: ["The shared table wrapper changes for all pages."],
    files: [
      {
        path: "src/orders/SearchPage.tsx",
        status: "added",
        area: "ui",
        changeDescription: "Render the status filter row.",
        criteriaIds: ["ac-1"],
        additions: 4,
        deletions: 0,
        diff: "+<FilterRow />",
        content: "export function SearchPage() {}",
        validators: ["basic-syntax"],
      },
    ],
    criteriaCoverage: [
      {
        id: "ac-1",
        text: "Filter by order status.",
        covered: true,
        evidence: "src/orders/SearchPage.tsx",
      },
    ],
    validation: {
      passed: true,
      attempts: 1,
      results: [
        { validator: "basic-syntax", path: "src/orders/SearchPage.tsx", passed: true, message: "" },
      ],
    },
    repair: { attempted: false, applied: false },
    ...overrides,
  };
}

const FEATURE_COMPLETION = {
  ticket: FEATURE_TICKET,
  repository: "acme/app",
  baseBranch: "main",
  branch: "feat/feat-7",
  sourceSha: "c".repeat(40),
  summary: "Add the filter bar and wire it into the orders query.",
  files: [
    { path: "src/orders/SearchPage.tsx", status: "added", area: "ui", additions: 4, deletions: 0 },
  ],
  validation: { passed: true, attempts: 1, results: [] },
  criteriaCoverage: [
    {
      id: "ac-1",
      text: "Filter by order status.",
      covered: true,
      evidence: "src/orders/SearchPage.tsx",
    },
    { id: "ac-2", text: "Remember the filter in the URL.", covered: false, evidence: null },
  ],
  criteriaTotal: 2,
  criteriaCovered: 1,
  ticketTransition: { ticketKey: "FEAT-7", targetStatus: "In Review" },
};

describe("feature selection surface", () => {
  it("renders the ticket chips, the pickers, the criteria checklist, and the branch preview", () => {
    const html = renderToString(
      <FeatureSelectionSurface
        artifact={featureSelectionArtifact()}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Feature ticket");
    expect(html).toContain("FEAT-7");
    expect(html).toContain("FEAT-12");
    expect(html).toContain("Add status filters to the orders search page");
    expect(html).toContain('type="radio"');
    expect(html).toContain("ticket-chip selected");
    expect(html).toContain("Acceptance criteria (1 of 2 included)");
    expect(html).toContain("ac-1");
    expect(html).toContain("Filter by order status.");
    expect(html).toContain("ac-2");
    expect(html).toContain("excluded");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("The feature lands on acme/app@feat/feat-7, branched from main.");
    expect(html).toContain("Advanced Settings");
    expect(html).not.toContain("· edited");
  });

  it("flags edited advanced settings and previews the derived feature branch", () => {
    const html = renderToString(
      <FeatureSelectionSurface
        artifact={featureSelectionArtifact()}
        editable
        draft={{
          ticket: { key: "FEAT-12", summary: "CSV export for orders", status: "in progress" },
          repository: "acme/lib",
          baseBranch: "release/1.x",
          acceptanceCriteria: [{ id: "ac-1", text: "Filter by order status.", included: false }],
          advanced: { maxChangedFiles: 5, guidance: "Keep the filter row sticky." },
        }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Advanced Settings · edited");
    expect(html).toContain("The feature lands on acme/lib@feat/feat-12, branched from release/1.x.");
    expect(html).toContain("Acceptance criteria (0 of 1 included)");
  });

  it("disables every control when the run is not editable", () => {
    const html = renderToString(
      <FeatureSelectionSurface
        artifact={featureSelectionArtifact()}
        editable={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("disabled");
  });

  it("keeps ticket and criteria text as text, never markup", () => {
    const html = renderToString(
      <FeatureSelectionSurface
        artifact={featureSelectionArtifact({
          candidates: [{ key: "FEAT-12", summary: MALICIOUS_SUMMARY, status: "open" }],
          acceptanceCriteria: [{ id: "ac-1", text: MALICIOUS_SUMMARY, included: true }],
        })}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("featureBranch", () => {
  it("derives the deterministic feature branch slug", () => {
    expect(featureBranch("FEAT-7")).toBe("feat/feat-7");
    expect(featureBranch("Hot Feature!!")).toBe("feat/hot-feature");
    expect(featureBranch("!!!")).toBe("feat/ticket");
  });
});

describe("scope design surface", () => {
  it("renders the target summary bar, the area cards, and the bulk controls", () => {
    const html = renderToString(
      <ScopeDesignSurface artifact={SCOPE_DESIGN} editable draft={null} onChange={() => {}} />,
    );
    expect(html).toContain("Add a status filter row above the orders table.");
    expect(html).toContain("confidence 70%");
    expect(html).toContain("Change");
    expect(html).toContain("3 of 5 areas enabled");
    expect(html).toContain("UI");
    expect(html).toContain("API &amp; Data");
    expect(html).toContain("State &amp; Logic");
    expect(html).toContain("Tests");
    expect(html).toContain("Docs &amp; Flags");
    expect(html).toContain("Select All");
    expect(html).toContain("Clear");
    expect(html).toContain("Custom guidance");
  });

  it("renders the draft values when the reviewer edits the scope", () => {
    const html = renderToString(
      <ScopeDesignSurface
        artifact={SCOPE_DESIGN}
        editable
        draft={{
          targetSummary: "Filter row plus URL persistence.",
          areas: SCOPE_DESIGN.areas.map((area) => ({ ...area, enabled: true })),
          guidance: "Keep the table wrapper untouched.",
        }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Filter row plus URL persistence.");
    expect(html).toContain("5 of 5 areas enabled");
    expect(html).toContain("Keep the table wrapper untouched.");
  });

  it("disables the controls when the run is not editable", () => {
    const html = renderToString(
      <ScopeDesignSurface artifact={SCOPE_DESIGN} editable={false} draft={null} onChange={() => {}} />,
    );
    expect(html).toContain("disabled");
    expect(html).not.toContain("Select All");
  });

  it("keeps the target summary as text, never markup", () => {
    const html = renderToString(
      <ScopeDesignSurface
        artifact={{ ...SCOPE_DESIGN, targetSummary: MALICIOUS_SUMMARY }}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("feature implementation surface", () => {
  const artifact = featureImplementationArtifact();

  it("renders the verdict, the summary blocks, the cross-cutting callout, and the planned changes", () => {
    const html = renderToString(
      <FeatureImplementationSurface
        artifact={artifact}
        editing={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Needs attention");
    expect(html).toContain("confidence 55%");
    expect(html).toContain("Add the filter bar and wire it into the orders query.");
    expect(html).toContain("Strengths");
    expect(html).toContain("Reuses the existing query hook.");
    expect(html).toContain("Risks &amp; open questions");
    expect(html).toContain("URL persistence lands in a follow-up.");
    expect(html).toContain("Cross-cutting notes");
    expect(html).toContain("The shared table wrapper changes for all pages.");
    expect(html).toContain("+4 / −0 across the plan");
    expect(html).toContain("src/orders/SearchPage.tsx");
    expect(html).toContain("new file");
    expect(html).toContain("+4 −0");
    expect(html).toContain("Criteria: ac-1");
    expect(html).toContain("Validators: basic-syntax");
    expect(html).toContain("Modify");
    expect(html).toContain("Validators passed · 1 attempt");
  });

  it("reports a failed validation attempt and the failed repair", () => {
    const html = renderToString(
      <FeatureImplementationSurface
        artifact={featureImplementationArtifact({
          verdict: "ready",
          validation: {
            passed: false,
            attempts: 2,
            results: [
              {
                validator: "json",
                path: "src/config/app.json",
                passed: false,
                message: "Unexpected token",
              },
            ],
          },
          repair: { attempted: true, applied: false },
        })}
        editing={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Ready");
    expect(html).toContain("Validators failed · 2 attempts");
    expect(html).toContain("✗ json · src/config/app.json — Unexpected token");
    expect(html).toContain(
      "the single repair attempt did not pass — review carefully before proceeding.",
    );
  });

  it("switches to the plan editor with per-file content fields", () => {
    const html = renderToString(
      <FeatureImplementationSurface artifact={artifact} editing draft={null} onChange={() => {}} />,
    );
    expect(html).toContain("Implementation summary");
    expect(html).toContain("content-editor");
    expect(html).toContain("export function SearchPage() {}");
  });

  it("keeps the plan content as text, never markup", () => {
    const html = renderToString(
      <FeatureImplementationSurface
        artifact={featureImplementationArtifact({ summary: MALICIOUS_SUMMARY })}
        editing={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("feature complete surface", () => {
  it("previews the completion with the coverage checklist before the Draft PR is opened", () => {
    const html = renderToString(
      <FeatureCompleteSurface artifact={FEATURE_COMPLETION} receipt={null} />,
    );
    expect(html).toContain("The feature is validated — opening the Draft PR completes the run");
    expect(html).toContain("1 file on feat/feat-7");
    expect(html).toContain("Ticket FEAT-7 → In Review");
    expect(html).toContain("Acceptance criteria: 1 of 2 covered");
    expect(html).toContain("ac-1: Filter by order status.");
    expect(html).toContain("— src/orders/SearchPage.tsx");
    expect(html).toContain("ac-2: Remember the filter in the URL.");
    expect(html).toContain("uncovered");
    expect(html).toContain("Validators passed · 1 attempt");
    expect(html).toContain("src/orders/SearchPage.tsx · added · +4 −0");
    expect(html).not.toContain("Start PR Review");
  });

  it("renders the Draft PR receipt, the coverage checklist, and the review cross-link", () => {
    const receipt: FeatureReceiptView = {
      url: "https://github.example/acme/app/pull/21",
      number: 21,
      draft: true,
      branch: "feat/feat-7",
      ticketTransition: { ticketKey: "FEAT-7", targetStatus: "In Review" },
      validation: { passed: true, attempts: 1 },
      criteriaTotal: 2,
      criteriaCovered: 1,
      caseId: "case-7",
    };
    const html = renderToString(
      <FeatureCompleteSurface
        artifact={FEATURE_COMPLETION}
        receipt={receipt}
        reviewLink={{ onStart: () => {}, busy: false }}
      />,
    );
    expect(html).toContain("Draft PR #21");
    expect(html).toContain("draft");
    expect(html).toContain("View the Draft PR");
    expect(html).toContain("https://github.example/acme/app/pull/21");
    expect(html).toContain("Branch feat/feat-7");
    expect(html).toContain("Ticket FEAT-7 → In Review");
    expect(html).toContain("Acceptance criteria: 1 of 2 covered");
    expect(html).toContain("Validators passed · 1 attempt");
    expect(html).toContain("Recorded on case case-7");
    expect(html).toContain("Start PR Review for this PR");
    expect(html).toContain("A human merges the Draft PR.");
  });

  it("drops non-https receipt links through the parser", () => {
    const parsed = parseFeatureReceipt({
      pr: { url: "javascript:alert(1)", number: 21, draft: true },
      branch: "feat/feat-7",
      caseId: "case-7",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.url).toBeNull();
    const html = renderToString(
      <FeatureCompleteSurface artifact={FEATURE_COMPLETION} receipt={parsed} />,
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain("the link is unavailable");
  });

  it("hides the review cross-link without a receipt", () => {
    const html = renderToString(
      <FeatureCompleteSurface
        artifact={FEATURE_COMPLETION}
        receipt={null}
        reviewLink={{ onStart: () => {}, busy: false }}
      />,
    );
    expect(html).not.toContain("Start PR Review for this PR");
  });
});

/* --- Dependency Update lane --- */

const DEPENDENCY_VULNERABILITY = {
  cve: "CVE-2024-29041",
  cvss: 6.1,
  severity: "moderate",
  summary: "Open redirect in express before 4.19.2.",
};

function dependencyScanArtifact(): Record<string, unknown> {
  return {
    repository: "acme/app",
    baseBranch: "main",
    sourceSha: "b".repeat(40),
    manifestPath: "package.json",
    packages: [
      {
        name: "express",
        kind: "dependency",
        current: "^4.18.2",
        latest: "4.19.2",
        jump: "minor",
        daysOutdated: 30,
        changelogExcerpt: "Fixes the open redirect in the router.",
        vulnerabilities: [DEPENDENCY_VULNERABILITY],
      },
      {
        name: "react-router",
        kind: "dependency",
        current: "^5.3.4",
        latest: "6.26.0",
        jump: "major",
        daysOutdated: 400,
        changelogExcerpt: "The Switch component moved to Routes.",
        vulnerabilities: [],
      },
      {
        name: "typescript",
        kind: "devDependency",
        current: "^5.5.0",
        latest: "5.5.0",
        jump: "up_to_date",
        daysOutdated: 0,
        changelogExcerpt: "",
        vulnerabilities: [],
      },
    ],
    totals: { packages: 3, outdated: 2, vulnerable: 1, major: 1 },
  };
}

function dependencyGroupArtifact(): Record<string, unknown> {
  return {
    repository: "acme/app",
    baseBranch: "main",
    sourceSha: "b".repeat(40),
    manifestPath: "package.json",
    groups: [
      {
        id: "patch",
        label: "Patch updates",
        riskNote: "Low risk — bug fixes only.",
        packages: [],
      },
      {
        id: "minor",
        label: "Minor updates",
        riskNote: "Backwards-compatible features.",
        packages: [
          {
            name: "express",
            kind: "dependency",
            from: "^4.18.2",
            to: "4.19.2",
            jump: "minor",
            daysOutdated: 30,
            changelogExcerpt: "Fixes the open redirect in the router.",
            vulnerabilities: [DEPENDENCY_VULNERABILITY],
            excluded: false,
            excludeReason: "",
          },
        ],
      },
      {
        id: "major",
        label: "Major updates",
        riskNote: "Breaking changes — review each package.",
        packages: [
          {
            name: "react-router",
            kind: "dependency",
            from: "^5.3.4",
            to: "6.26.0",
            jump: "major",
            daysOutdated: 400,
            changelogExcerpt: "The Switch component moved to Routes.",
            vulnerabilities: [],
            excluded: true,
            excludeReason: "Waiting for the routing migration.",
          },
        ],
      },
    ],
  };
}

function dependencyApplyArtifact(): Record<string, unknown> {
  return {
    repository: "acme/app",
    baseBranch: "main",
    sourceSha: "b".repeat(40),
    manifestPath: "package.json",
    lockfilePath: "package-lock.json",
    summary: "Bundle the patch and minor bumps; majors need individual review.",
    confidence: 0.71,
    groups: [
      {
        id: "minor",
        label: "Minor updates",
        riskNote: "Backwards-compatible features.",
        accepted: true,
        breakingNotes: [],
        packages: [
          {
            name: "express",
            kind: "dependency",
            from: "^4.18.2",
            to: "4.19.2",
            jump: "minor",
            vulnerabilities: [DEPENDENCY_VULNERABILITY],
            included: true,
          },
        ],
        manifest: {
          path: "package.json",
          additions: 1,
          deletions: 1,
          diff: '-    "express": "^4.18.2",\n+    "express": "4.19.2",',
          content: '{ "dependencies": { "express": "4.19.2" } }',
          validators: ["json", "lockfile"],
        },
        lockfile: {
          path: "package-lock.json",
          additions: 2,
          deletions: 2,
          diff: '-    "express": "^4.18.2",\n+    "express": "4.19.2",',
          content: '{ "packages": { "express": "4.19.2" } }',
          validators: ["json"],
        },
      },
      {
        id: "major",
        label: "Major updates",
        riskNote: "Breaking changes — review each package.",
        accepted: false,
        breakingNotes: ["react-router v6 removes the Switch component."],
        packages: [
          {
            name: "react-router",
            kind: "dependency",
            from: "^5.3.4",
            to: "6.26.0",
            jump: "major",
            vulnerabilities: [],
            included: false,
          },
        ],
        manifest: {
          path: "package.json",
          additions: 1,
          deletions: 1,
          diff: '-    "react-router": "^5.3.4",\n+    "react-router": "6.26.0",',
          content: '{ "dependencies": { "react-router": "6.26.0" } }',
          validators: ["json"],
        },
        lockfile: null,
      },
    ],
  };
}

function dependencyValidateArtifact(): Record<string, unknown> {
  return {
    repository: "acme/app",
    baseBranch: "main",
    sourceSha: "b".repeat(40),
    manifestPath: "package.json",
    lockfilePath: "package-lock.json",
    groups: [
      {
        id: "minor",
        label: "Minor updates",
        skipped: false,
        status: "green",
        install: { passed: true, message: "Installed without warnings." },
        tests: { passed: 2, total: 2, failures: [] },
        log: "npm install ok\ntests ok",
        suggestion: null,
      },
      {
        id: "major",
        label: "Major updates",
        skipped: false,
        status: "failed",
        install: { passed: false, message: "Install blocked — Invalid JSON" },
        tests: {
          passed: 1,
          total: 2,
          failures: [
            { path: "package.json", validator: "json", message: "Invalid JSON", isNew: true },
          ],
        },
        log: "npm install\nerror Invalid JSON",
        suggestion: "Regenerate the lockfile from package.json.",
      },
    ],
  };
}

function dependencyMergeArtifact(): Record<string, unknown> {
  return {
    repository: "acme/app",
    baseBranch: "main",
    sourceSha: "b".repeat(40),
    manifestPath: "package.json",
    groups: [
      {
        id: "minor",
        label: "Minor updates",
        branch: "deps/acme-app-minor",
        title: "Update minor dependencies (1)",
        packageCount: 1,
        cveFixes: ["CVE-2024-29041"],
        packages: [{ name: "express", from: "^4.18.2", to: "4.19.2" }],
        files: [{ path: "package.json", status: "modified", additions: 1, deletions: 1 }],
      },
    ],
  };
}

const DEPENDENCY_RECEIPT: DependencyReceiptView = {
  caseId: "case-9",
  repository: "acme/app",
  baseBranch: "main",
  prs: [
    {
      groupId: "minor",
      url: "https://github.example/acme/app/pull/21",
      number: 21,
      draft: true,
      branch: "deps/acme-app-minor",
    },
  ],
  cveFixes: ["CVE-2024-29041"],
};

describe("dependency scan surface", () => {
  it("lists the inventory with jump badges, CVE links, and filter chips", () => {
    const html = renderToString(<DependencyScanSurface artifact={dependencyScanArtifact()} />);
    expect(html).toContain(
      "acme/app@main · package.json — 3 packages, 2 outdated, 1 vulnerable, 1 major.",
    );
    expect(html).toContain(">All<");
    expect(html).toContain(">Security<");
    expect(html).toContain(">Major<");
    expect(html).toContain("jump-badge jump-minor");
    expect(html).toContain("jump-badge jump-major");
    expect(html).toContain("jump-badge jump-up_to_date");
    expect(html).toContain("^4.18.2 → 4.19.2");
    expect(html).toContain("https://nvd.nist.gov/vuln/detail/CVE-2024-29041");
    expect(html).toContain(" · moderate · CVSS 6.1");
    expect(html).toContain("30 days");
    expect(html).toContain("400 days");
    expect(html).toContain(">dev<");
    expect(html).toContain(
      "Scanning is informational — Abort if this is the wrong repository or manifest.",
    );
  });

  it("escapes hostile server content in the inventory", () => {
    const artifact = dependencyScanArtifact();
    const packages = artifact["packages"] as Array<Record<string, unknown>>;
    const first = packages[0];
    if (first === undefined) throw new Error("fixture is missing the express package");
    first["name"] = '<script>alert("xss")</script>';
    const html = renderToString(<DependencyScanSurface artifact={artifact} />);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("dependency group surface", () => {
  it("shows the groups with counts, risk notes, and the recorded exclude reason", () => {
    const html = renderToString(
      <DependencyGroupSurface
        artifact={dependencyGroupArtifact()}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("3 groups · 2 packages · 1 excluded");
    expect(html).toContain("Patch updates");
    expect(html).toContain("Minor updates");
    expect(html).toContain("Major updates");
    expect(html).toContain("Low risk — bug fixes only.");
    expect(html).toContain("No packages in this group.");
    expect(html).toContain("1 CVE");
    expect(html).toContain("30d");
    expect(html).toContain("400d");
    expect(html).toContain("Fixes the open redirect in the router.");
    expect(html).toContain("Waiting for the routing migration.");
    expect(html).toContain('class="excluded"');
    expect(html).not.toContain("An exclude reason is required");
  });

  it("flags an excluded package that lost its reason", () => {
    const html = renderToString(
      <DependencyGroupSurface
        artifact={dependencyGroupArtifact()}
        editable
        draft={{
          groups: [
            {
              id: "minor",
              label: "Minor updates",
              riskNote: "Backwards-compatible features.",
              packages: [
                {
                  name: "express",
                  kind: "dependency",
                  from: "^4.18.2",
                  to: "4.19.2",
                  jump: "minor",
                  daysOutdated: 30,
                  changelogExcerpt: "Fixes the open redirect in the router.",
                  vulnerabilities: [],
                  excluded: true,
                  excludeReason: "",
                },
              ],
            },
          ],
        }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("An exclude reason is required for express.");
    expect(html).toContain("Reason (required)");
    expect(html).toContain("Why is this package excluded?");
  });
});

describe("dependency apply surface", () => {
  it("keeps majors package-by-package with breaking notes and per-group diffs", () => {
    const html = renderToString(
      <DependencyApplySurface
        artifact={dependencyApplyArtifact()}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Bundle the patch and minor bumps; majors need individual review.");
    expect(html).toContain("confidence 71%");
    expect(html).toContain("1 bumps included");
    expect(html).toContain("package-by-package");
    expect(html).toContain(
      "Major upgrades are accepted package by package — there is no bulk accept.",
    );
    expect(html).toContain("Breaking-change notes");
    expect(html).toContain("react-router v6 removes the Switch component.");
    expect(html).toContain("Show manifest + lockfile diffs");
    expect(html).toContain("CVE-2024-29041");
    expect(html.split("Include this group").length - 1).toBe(1);
    expect(html).not.toContain("Turn on at least one package before validating the bumps.");
  });

  it("warns when no package is selected for validation", () => {
    const html = renderToString(
      <DependencyApplySurface
        artifact={dependencyApplyArtifact()}
        editable
        draft={{
          groups: [
            { id: "minor", accepted: false, packages: [{ name: "express", included: true }] },
            {
              id: "major",
              accepted: false,
              packages: [{ name: "react-router", included: false }],
            },
          ],
        }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("0 bumps included");
    expect(html).toContain("Turn on at least one package before validating the bumps.");
  });
});

describe("dependency validate surface", () => {
  it("summarizes install and test results and gates on open failures", () => {
    const html = renderToString(
      <DependencyValidateSurface
        artifact={dependencyValidateArtifact()}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("1 green · 1 failing · 0 skipped");
    expect(html).toContain("Green");
    expect(html).toContain("Failed");
    expect(html).toContain("✓ Installed without warnings.");
    expect(html).toContain("2/2 passed");
    expect(html).toContain("✗ Install blocked — Invalid JSON");
    expect(html).toContain("new failure · json · package.json — Invalid JSON");
    expect(html).toContain("Repair suggestion");
    expect(html).toContain("Regenerate the lockfile from package.json.");
    expect(html).toContain("Skip this group");
    expect(html).toContain("Show log (2 lines)");
    expect(html).toContain(
      "All groups must be green (or explicitly skipped) before the pull requests can be planned.",
    );
  });

  it("lets a failed group be skipped so the gate opens", () => {
    const html = renderToString(
      <DependencyValidateSurface
        artifact={dependencyValidateArtifact()}
        editable
        draft={{ skipped: { major: true } }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("1 green · 0 failing · 1 skipped");
    expect(html).toContain("Skipped");
    expect(html).not.toContain("All groups must be green");
  });
});

describe("dependency merge surface", () => {
  it("previews one Draft PR per group with the CVE callout", () => {
    const html = renderToString(
      <DependencyMergeSurface artifact={dependencyMergeArtifact()} receipt={null} />,
    );
    expect(html).toContain("acme/app@main · one Draft PR per group");
    expect(html).toContain("Update minor dependencies (1)");
    expect(html).toContain("1 package");
    expect(html).toContain("Branch deps/acme-app-minor");
    expect(html).toContain("Security fixes");
    expect(html).toContain("https://nvd.nist.gov/vuln/detail/CVE-2024-29041");
    expect(html).toContain("express: ^4.18.2 → 4.19.2");
    expect(html).toContain("package.json · modified · +1 −1");
    expect(html).toContain(
      "Opening the bump PRs is the side effect; CI runs on each branch and a human merges them.",
    );
  });

  it("renders the receipt and the per-PR review cross-links once the PRs open", () => {
    const html = renderToString(
      <DependencyMergeSurface
        artifact={dependencyMergeArtifact()}
        receipt={DEPENDENCY_RECEIPT}
        reviewLink={{ onStart: () => {}, busy: false }}
      />,
    );
    expect(html).toContain("1 bump pull request opened");
    expect(html).toContain("Draft PR #21");
    expect(html).toContain("https://github.example/acme/app/pull/21");
    expect(html).toContain("branch deps/acme-app-minor");
    expect(html).toContain("Security fixes: CVE-2024-29041");
    expect(html).toContain("Recorded on case case-9");
    expect(html).toContain("Start PR Review for #21");
    expect(html).not.toContain("one Draft PR per group");
  });

  it("drops non-https receipt links and malformed CVE ids through the parser", () => {
    const parsed = parseDependencyReceipt({
      caseId: "case-9",
      prs: [
        {
          groupId: "minor",
          pr: {
            url: "javascript:alert(1)",
            number: 21,
            draft: true,
            branch: "deps/acme-app-minor",
          },
        },
      ],
      cveFixes: ["not-a-cve", "CVE-2024-29041"],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.prs[0]?.url).toBeNull();
    expect(parsed?.cveFixes).toEqual(["CVE-2024-29041"]);
    const html = renderToString(<DependencyMergeSurface artifact={null} receipt={parsed} />);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("the link is unavailable");
  });
});

describe("cveUrl", () => {
  it("only builds detail links for well-formed CVE ids", () => {
    expect(cveUrl("CVE-2024-29041")).toBe("https://nvd.nist.gov/vuln/detail/CVE-2024-29041");
    expect(cveUrl("not-a-cve")).toBeNull();
    expect(cveUrl("javascript:alert(1)")).toBeNull();
  });
});

const ACCESSIBILITY_ROUTES = [
  { path: "/", component: "HomePage", selected: true, authenticated: false, checks: 42 },
  { path: "/checkout", component: "CheckoutPage", selected: true, authenticated: true, checks: 61 },
  { path: "/admin", component: "AdminPanel", selected: false, authenticated: true, checks: 18 },
];

function accessibilityCrawlArtifact(): Record<string, unknown> {
  return {
    repository: "acme/storefront",
    baseBranch: "main",
    sourceSha: "c".repeat(40),
    targetUrl: "https://shop.example.com",
    routes: ACCESSIBILITY_ROUTES,
    totals: { routes: 3, selected: 2, authenticated: 2, checks: 103 },
  };
}

const ACCESSIBILITY_CONTRAST = {
  id: "color-contrast:/checkout",
  rule: "color-contrast",
  wcagRef: "WCAG 2.1 AA 1.4.3",
  impact: "critical",
  elementPath: "main > form > button#pay",
  routePath: "/checkout",
  occurrences: 4,
  description: "Text contrast is below 4.5:1.",
  screenshotUrl: "https://audit.example.com/shots/contrast.png",
};

const ACCESSIBILITY_BUTTON_NAME = {
  id: "button-name:/",
  rule: "button-name",
  wcagRef: "WCAG 2.1 AA 4.1.2",
  impact: "serious",
  elementPath: "header > nav > button.menu",
  routePath: "/",
  occurrences: 2,
  description: "The menu button has no accessible name.",
  screenshotUrl: null,
};

function accessibilityViolationsArtifact(): Record<string, unknown> {
  return {
    repository: "acme/storefront",
    targetUrl: "https://shop.example.com",
    analyzer: "axe-core 4.9.1",
    ruleset: "WCAG 2.1 AA",
    violations: [ACCESSIBILITY_CONTRAST, ACCESSIBILITY_BUTTON_NAME],
    totals: { critical: 1, serious: 1, moderate: 0, minor: 0, total: 2 },
    summary: MALICIOUS_SUMMARY,
    confidence: 0.77,
  };
}

function accessibilityFixArtifact(): Record<string, unknown> {
  return {
    repository: "acme/storefront",
    targetUrl: "https://shop.example.com",
    summary: "Fixes two violations with CSS and markup patches.",
    confidence: 0.71,
    fixes: [
      {
        violationId: "color-contrast:/checkout",
        rule: "color-contrast",
        wcagRef: "WCAG 2.1 AA 1.4.3",
        impact: "critical",
        elementPath: "main > form > button#pay",
        routePath: "/checkout",
        explanation: "Darken the pay button label.",
        before: "color: #9aa0a6;",
        after: "color: #1f1f1f;",
        manualRedesign: false,
        applied: true,
        files: [
          {
            path: "app/checkout.css",
            content: ".pay { color: #1f1f1f; }",
            validators: ["contrast"],
          },
        ],
      },
      {
        violationId: "button-name:/",
        rule: "button-name",
        wcagRef: "WCAG 2.1 AA 4.1.2",
        impact: "serious",
        elementPath: "header > nav > button.menu",
        routePath: "/",
        explanation: "Give the menu button an aria-label.",
        before: '<button class="menu">',
        after: '<button class="menu" aria-label="Menu">',
        manualRedesign: false,
        applied: true,
        files: [{ path: "components/Menu.tsx", content: "/* patch */", validators: ["jsx-a11y"] }],
      },
      {
        violationId: "target-size:/admin",
        rule: "target-size",
        wcagRef: "WCAG 2.2 AA 2.5.8",
        impact: "moderate",
        elementPath: "aside.toolbar",
        routePath: "/admin",
        explanation: "The toolbar needs a layout redesign.",
        before: "",
        after: "",
        manualRedesign: true,
        applied: false,
        files: [],
      },
    ],
    totals: { fixes: 3, applied: 2, manualRedesign: 1, files: 2 },
  };
}

function accessibilityRescanArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: "acme/storefront",
    baseBranch: "main",
    sourceSha: "c".repeat(40),
    targetUrl: "https://shop.example.com",
    branch: "a11y/acme-storefront-case-9",
    analyzer: "axe-core 4.9.1",
    ruleset: "WCAG 2.1 AA",
    before: { critical: 1, serious: 1, moderate: 0, minor: 0, total: 2 },
    after: { critical: 0, serious: 1, moderate: 0, minor: 0, total: 1 },
    delta: { critical: 1, serious: 0, moderate: 0, minor: 0 },
    resolvedIds: ["color-contrast:/checkout"],
    remaining: [ACCESSIBILITY_BUTTON_NAME],
    introduced: [],
    waivers: [],
    gate: { criticalsOpen: 0, criticalsWaived: 0, passing: true },
    summary: "Re-scan: 2 → 1 violations; 1 resolved, 0 new.",
    ...overrides,
  };
}

const ACCESSIBILITY_RECEIPT = {
  caseId: "case-9",
  repository: "acme/storefront",
  branch: "a11y/acme-storefront-case-9",
  resolvedCount: 1,
  waivedCount: 1,
  remainingCount: 1,
  gate: { criticalsOpen: 0, criticalsWaived: 1, passing: true },
  pr: {
    url: "https://github.example/acme/storefront/pull/33",
    number: 33,
    draft: true,
    branch: "a11y/acme-storefront-case-9",
  },
};

describe("accessibility crawl surface", () => {
  it("lists the route tree with the selection and the check estimate", () => {
    const html = renderToString(
      <AccessibilityCrawlSurface
        artifact={accessibilityCrawlArtifact()}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(
      "acme/storefront@main · https://shop.example.com — 3 routes, 2 selected, 2 authenticated · ~103 checks",
    );
    expect(html).toContain("Select all");
    expect(html).toContain("Clear");
    expect(html).toContain("HomePage");
    expect(html).toContain("CheckoutPage");
    expect(html).toContain("AdminPanel");
    expect(html).toContain('class="excluded"');
    expect(html).not.toContain("Select at least one route");
  });

  it("recomputes the totals from a draft and flags an empty selection", () => {
    const html = renderToString(
      <AccessibilityCrawlSurface
        artifact={accessibilityCrawlArtifact()}
        editable
        draft={{ routes: ACCESSIBILITY_ROUTES.map((route) => ({ ...route, selected: false })) }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("0 selected");
    expect(html).toContain("~0 checks");
    expect(html).toContain("Select at least one route before running the audit.");
  });

  it("estimates checks from the selected routes only", () => {
    expect(accessibilityRouteTotals(ACCESSIBILITY_ROUTES)).toEqual({
      routes: 3,
      selected: 2,
      authenticated: 2,
      checks: 103,
    });
  });
});

describe("accessibility violations surface", () => {
  it("groups findings by impact with rule, WCAG ref, occurrences, and the screenshot", () => {
    const html = renderToString(
      <AccessibilityViolationsSurface artifact={accessibilityViolationsArtifact()} />,
    );
    expect(html).toContain("axe-core 4.9.1 · WCAG 2.1 AA · https://shop.example.com");
    expect(html).toContain("All (2)");
    expect(html).toContain("Critical (1)");
    expect(html).toContain("Serious (1)");
    expect(html).toContain("a11y-impact-pill impact-critical");
    expect(html).toContain("a11y-impact-pill impact-serious");
    expect(html).toContain("WCAG 2.1 AA 1.4.3");
    expect(html).toContain("main &gt; form &gt; button#pay");
    expect(html).toContain("4×");
    expect(html).toContain("https://audit.example.com/shots/contrast.png");
    expect(html).toContain("Review the findings");
  });

  it("renders hostile server content as text, never as markup", () => {
    const artifact = accessibilityViolationsArtifact();
    const violations = artifact["violations"] as Array<Record<string, unknown>>;
    const first = violations[0];
    if (first === undefined) throw new Error("fixture is missing the first violation");
    first["description"] = MALICIOUS_SUMMARY;
    const html = renderToString(<AccessibilityViolationsSurface artifact={artifact} />);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("accessibility fix surface", () => {
  it("renders the fix cards with before/after diffs and the manual redesign callout", () => {
    const html = renderToString(
      <AccessibilityFixSurface
        artifact={accessibilityFixArtifact()}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("confidence 71%");
    expect(html).toContain("2 of 2 fixes applied");
    expect(html).toContain("1 manual");
    expect(html).toContain("Apply all fixes");
    expect(html).toContain("Skip all fixes");
    expect(html).toContain("diff-body a11y-before");
    expect(html).toContain("diff-body a11y-after");
    expect(html).toContain("&lt;button class=&quot;menu&quot;&gt;");
    expect(html).toContain("app/checkout.css · Validators: contrast");
    expect(html).toContain("components/Menu.tsx · Validators: jsx-a11y");
    expect(html).toContain("Manual redesign · 1");
    expect(html).toContain("Needs a manual redesign");
    expect(html).not.toContain("Apply at least one fix before the re-scan");
  });

  it("warns when every fix was skipped in the draft", () => {
    const html = renderToString(
      <AccessibilityFixSurface
        artifact={accessibilityFixArtifact()}
        editable
        draft={{ applied: { "color-contrast:/checkout": false, "button-name:/": false } }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("0 of 2 fixes applied");
    expect(html).toContain("Apply at least one fix before the re-scan can open the fix pull request.");
  });
});

describe("accessibility re-scan surface", () => {
  it("shows the before/after table with delta badges and the passing gate", () => {
    const html = renderToString(
      <AccessibilityRescanSurface
        artifact={accessibilityRescanArtifact()}
        receipt={null}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(
      "acme/storefront@main · branch a11y/acme-storefront-case-9 · axe-core 4.9.1 · WCAG 2.1 AA",
    );
    expect(html).toContain("Gate passed — no critical violations remain open.");
    expect(html).toContain("delta-badge delta-good");
    expect(html).toContain("Resolved: color-contrast:/checkout");
    expect(html).toContain("Remaining · 1");
    expect(html).toContain("Back returns to the Fix step with everything pre-loaded");
    expect(html).not.toContain("Waiver reason");
  });

  it("blocks the gate note while criticals stay open and offers waiver editors", () => {
    const html = renderToString(
      <AccessibilityRescanSurface
        artifact={accessibilityRescanArtifact({
          after: { critical: 1, serious: 0, moderate: 0, minor: 0, total: 1 },
          delta: { critical: 0, serious: 1, moderate: 0, minor: 0 },
          resolvedIds: [],
          remaining: [ACCESSIBILITY_CONTRAST],
          introduced: [ACCESSIBILITY_CONTRAST],
          gate: { criticalsOpen: 1, criticalsWaived: 0, passing: false },
        })}
        receipt={null}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(
      "1 critical violation(s) remain open — fix them, or record an approver waiver with an expiry before opening the fix pull request.",
    );
    expect(html).toContain("run-banner failed");
    expect(html).toContain("Waiver reason");
    expect(html).toContain("Expires");
    expect(html).toContain("New since the first audit · 1");
  });

  it("renders the receipt and drops unsafe PR links", () => {
    const parsed = parseAccessibilityReceipt({
      ...ACCESSIBILITY_RECEIPT,
      pr: { url: "javascript:alert(1)", number: 33, draft: true, branch: "a11y/x" },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.prUrl).toBeNull();
    const html = renderToString(
      <AccessibilityRescanSurface
        artifact={null}
        receipt={parsed}
        editable={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Fix pull request opened for acme/storefront");
    expect(html).toContain("the link is unavailable");
    expect(html).toContain("1 resolved · 1 waived · 1 remaining");
    expect(html).toContain("Recorded on case case-9");
  });

  it("shows the receipt card alongside the comparison once the PR opens", () => {
    const parsed = parseAccessibilityReceipt(ACCESSIBILITY_RECEIPT);
    const html = renderToString(
      <AccessibilityRescanSurface
        artifact={accessibilityRescanArtifact()}
        receipt={parsed}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Draft PR #33");
    expect(html).toContain("https://github.example/acme/storefront/pull/33");
    expect(html).toContain("branch a11y/acme-storefront-case-9");
    expect(html).toContain("1 resolved · 1 waived · 1 remaining");
  });
});

const VENDOR_DOCUMENTS: VendorDocumentView[] = [
  {
    id: "registration",
    label: "Company registration",
    required: true,
    status: "received",
    fileName: "registration.pdf",
    waivedReason: null,
    nudges: 1,
    lastNudgedAt: "2026-09-12T08:00:00Z",
  },
  {
    id: "tax-id",
    label: "Tax identification",
    required: true,
    status: "pending",
    fileName: null,
    waivedReason: null,
    nudges: 0,
    lastNudgedAt: null,
  },
  {
    id: "bank-letter",
    label: "Bank letter",
    required: true,
    status: "missing",
    fileName: null,
    waivedReason: null,
    nudges: 0,
    lastNudgedAt: null,
  },
  {
    id: "insurance",
    label: "Insurance certificate",
    required: true,
    status: "waived",
    fileName: null,
    waivedReason: "Self-insured; risk accepted.",
    nudges: 0,
    lastNudgedAt: null,
  },
];

function vendorCollectArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vendorName: "Northwind Supply Limited",
    taxId: "GB812345678",
    country: "GB",
    requestor: "procurement@acme.test",
    documents: VENDOR_DOCUMENTS,
    totals: { documents: 4, required: 4, received: 1, waived: 1, outstanding: 2 },
    returnedNote: null,
    summary: "1 of 4 documents on file; 2 outstanding.",
    ...overrides,
  };
}

const VENDOR_CHECKS = [
  {
    id: "registry-lookup",
    label: "Registry lookup",
    status: "pass",
    source: "vendor registry",
    checkedAt: "2026-09-12T09:00:00Z",
    detail: "No matches for the legal name.",
  },
  {
    id: "duplicate-screening",
    label: "Duplicate screening",
    status: "fail",
    source: "vendor registry",
    checkedAt: "2026-09-12T09:01:00Z",
    detail: "Possible duplicate: Northwind Supplies Ltd.",
  },
  {
    id: "document-match",
    label: "Document match",
    status: "flag",
    source: "document register",
    checkedAt: "2026-09-12T09:02:00Z",
    detail: "Insurance certificate was waived.",
  },
];

const VENDOR_CANDIDATES = [
  {
    vendorId: "V-001",
    legalName: "Northwind Supplies Ltd",
    taxId: "GB812345600",
    country: "GB",
    matchScore: 0.86,
    matchedOn: ["name", "country"],
  },
];

function vendorVerifyArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vendorName: "Northwind Supply Limited",
    taxId: "GB812345678",
    country: "GB",
    checks: VENDOR_CHECKS,
    candidates: VENDOR_CANDIDATES,
    manualReview: {
      required: true,
      items: [{ checkId: "duplicate-screening", reason: "Possible duplicate." }],
    },
    resolutions: [],
    summary: "3 checks: 1 pass, 1 flag, 1 fail — manual review required.",
    confidence: 0.74,
    ...overrides,
  };
}

function vendorRiskArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vendorName: "Northwind Supply Limited",
    taxId: "GB812345678",
    score: 42,
    tier: "medium",
    factors: [
      { id: "country-risk", label: "Country risk", points: 18, detail: "Standard jurisdiction." },
      { id: "spend", label: "Annual spend", points: 24, detail: "Above the review threshold." },
    ],
    requiredSigners: ["procurement-lead", "finance-manager"],
    matrix: [
      { tier: "low", requiredSigners: ["procurement-lead"] },
      { tier: "medium", requiredSigners: ["procurement-lead", "finance-manager"] },
      { tier: "high", requiredSigners: ["procurement-lead", "finance-manager", "cfo"] },
    ],
    summary: "Score 42 lands in the medium tier.",
    confidence: 0.8,
    ...overrides,
  };
}

const VENDOR_REQUESTED_AT = new Date(Date.now() - 2 * 3_600_000).toISOString();

function vendorApproveArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vendorName: "Northwind Supply Limited",
    taxId: "GB812345678",
    tier: "medium",
    slaHours: 48,
    chain: [
      {
        role: "procurement-lead",
        name: "Dana Lee",
        state: "approved",
        requestedAt: VENDOR_REQUESTED_AT,
        actedAt: VENDOR_REQUESTED_AT,
        note: "Budget confirmed.",
        nudges: 0,
        lastNudgedAt: null,
      },
      {
        role: "finance-manager",
        name: "Sam Ortiz",
        state: "pending",
        requestedAt: VENDOR_REQUESTED_AT,
        actedAt: null,
        note: null,
        nudges: 2,
        lastNudgedAt: VENDOR_REQUESTED_AT,
      },
    ],
    comments: [{ author: "Dana Lee", at: VENDOR_REQUESTED_AT, body: "Budget confirmed for FY26." }],
    allApproved: false,
    summary: "1 of 2 signers approved.",
    ...overrides,
  };
}

const VENDOR_RECORD = {
  vendorId: "V-2026-0042",
  legalName: "Northwind Supply Limited",
  taxId: "GB812345678",
  country: "GB",
  requestor: "procurement@acme.test",
  status: "active",
  effectiveDate: "2026-09-12",
};

function vendorCreateArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record: VENDOR_RECORD,
    idempotencyKey: "GB812345678",
    welcomePacket: true,
    existing: null,
    summary: "Creates V-2026-0042 as an active vendor effective 2026-09-12.",
    ...overrides,
  };
}

const VENDOR_RECEIPT = {
  vendorId: "V-2026-0042",
  legalName: "Northwind Supply Limited",
  taxId: "GB812345678",
  effectiveDate: "2026-09-12",
  welcomePacket: true,
  created: true,
  registryRef: "registry/vendors/V-2026-0042",
};

describe("vendor collect surface", () => {
  it("lists the checklist with status pills, totals and the outstanding gate", () => {
    const html = renderToString(
      <VendorCollectSurface
        artifact={vendorCollectArtifact()}
        editable
        draft={null}
        returnNote={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(
      "Northwind Supply Limited · GB812345678 · GB · requested by procurement@acme.test",
    );
    expect(html).toContain("1 of 4 received");
    expect(html).toContain("1 waived");
    expect(html).toContain("2 outstanding");
    expect(html).toContain("vendors-status-pill status-received");
    expect(html).toContain("vendors-status-pill status-pending");
    expect(html).toContain("vendors-status-pill status-missing");
    expect(html).toContain("vendors-status-pill status-waived");
    expect(html).toContain("File: registration.pdf");
    expect(html).toContain("nudged 1×");
    expect(html).toContain("Waiver reason");
    expect(html).toContain("Self-insured; risk accepted.");
    expect(html).toContain("Replace file");
    expect(html).toContain("Upload Tax identification");
    expect(html).toContain("Un-waive");
    expect(html).toContain("Nudge requester");
    expect(html).toContain(
      "Collect every required document or waive it with a reason (Tax identification, Bank letter outstanding).",
    );
  });

  it("shows the returned-for-rework note from the panel state", () => {
    const html = renderToString(
      <VendorCollectSurface
        artifact={vendorCollectArtifact()}
        editable
        draft={null}
        returnNote="Documents were illegible; re-upload the bank letter."
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Returned for rework");
    expect(html).toContain("Documents were illegible; re-upload the bank letter.");
  });

  it("hides the upload and waiver controls when the step is not interactive", () => {
    const html = renderToString(
      <VendorCollectSurface
        artifact={vendorCollectArtifact()}
        editable={false}
        draft={null}
        returnNote={null}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("Upload Tax identification");
    expect(html).not.toContain("Nudge requester");
    expect(html).toContain("Waiver reason");
  });

  it("renders hostile server content as text, never as markup", () => {
    const html = renderToString(
      <VendorCollectSurface
        artifact={vendorCollectArtifact({ vendorName: MALICIOUS_SUMMARY })}
        editable
        draft={null}
        returnNote={MALICIOUS_SUMMARY}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("computes live totals from the document list", () => {
    expect(vendorDocumentTotals(VENDOR_DOCUMENTS)).toEqual({
      documents: 4,
      required: 4,
      received: 1,
      waived: 1,
      outstanding: 2,
    });
  });
});

describe("vendor verify surface", () => {
  it("renders the check table, duplicate candidates and the manual review notes", () => {
    const html = renderToString(
      <VendorVerifySurface
        artifact={vendorVerifyArtifact()}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("confidence 74%");
    expect(html).toContain("3 checks");
    expect(html).toContain("vendors-check-pill check-pass");
    expect(html).toContain("vendors-check-pill check-flag");
    expect(html).toContain("vendors-check-pill check-fail");
    expect(html).toContain("Possible duplicate: Northwind Supplies Ltd.");
    expect(html).toContain("Duplicate candidates · 1");
    expect(html).toContain("match 86%");
    expect(html).toContain("V-001 · GB812345600 · GB");
    expect(html).toContain("Matched on: name, country");
    expect(html).toContain("Manual review · 1");
    expect(html).toContain("Manual-review note");
  });

  it("renders the draft resolution note in the failing check editor", () => {
    const html = renderToString(
      <VendorVerifySurface
        artifact={vendorVerifyArtifact()}
        editable
        draft={{ resolutions: { "duplicate-screening": "Separate legal entity; see case notes." } }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Separate legal entity; see case notes.");
  });

  it("reports a clean pass when no check fails", () => {
    const html = renderToString(
      <VendorVerifySurface
        artifact={vendorVerifyArtifact({
          checks: VENDOR_CHECKS.filter((check) => check.status !== "fail"),
          manualReview: { required: false, items: [] },
        })}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Every check passed — no manual review is required.");
    expect(html).toContain("Manual review · 0");
  });
});

describe("vendor risk surface", () => {
  it("renders the score meter, tier badge, factor breakdown and the approver matrix", () => {
    const html = renderToString(<VendorRiskSurface artifact={vendorRiskArtifact()} />);
    expect(html).toContain('aria-label="Risk score 42 of 100"');
    expect(html).toContain("42 / 100");
    expect(html).toContain("vendors-tier-badge tier-medium");
    expect(html).toContain("Tier medium — required signers: Procurement Lead, Finance Manager");
    expect(html).toContain("Country risk");
    expect(html).toContain("+18");
    expect(html).toContain("+24");
    expect(html).toContain("current-tier");
    expect(html).toContain("Chief Financial Officer");
  });

  it("keeps the meter width inside the 0-100 range", () => {
    const html = renderToString(<VendorRiskSurface artifact={vendorRiskArtifact({ score: 130 })} />);
    expect(html).toContain("width:100%");
  });
});

describe("vendor approve surface", () => {
  it("renders the chain tracker with avatars, SLA age, nudges and comments", () => {
    const html = renderToString(
      <VendorApproveSurface
        artifact={vendorApproveArtifact()}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("DL");
    expect(html).toContain("SO");
    expect(html).toContain("Dana Lee");
    expect(html).toContain("Sam Ortiz");
    expect(html).toContain("vendors-chain-state state-approved");
    expect(html).toContain("vendors-chain-state state-pending");
    expect(html).toContain("2h of 48h SLA");
    expect(html).toContain("nudged 2×");
    expect(html).toContain("Undo approval");
    expect(html).toContain("Nudge signer");
    expect(html).toContain("Comments · 1");
    expect(html).toContain("Budget confirmed for FY26.");
    expect(html).toContain("Awaiting signers");
  });

  it("offers the reject-with-reason loop when the return flow is wired", () => {
    const html = renderToString(
      <VendorApproveSurface
        artifact={vendorApproveArtifact()}
        editable
        draft={null}
        onChange={() => {}}
        returnFlow={{ onReturn: () => {}, busy: false }}
      />,
    );
    expect(html).toContain("Reject reason (returns the run to Collect)");
    expect(html).toContain("Reject — return to Collect");
  });

  it("marks the chain fully approved and hides the return flow without one", () => {
    const approved = vendorApproveArtifact({
      chain: vendorApproveArtifact()["chain"],
      allApproved: true,
    });
    const chain = approved["chain"] as Array<Record<string, unknown>>;
    for (const entry of chain) entry["state"] = "approved";
    const html = renderToString(
      <VendorApproveSurface artifact={approved} editable draft={null} onChange={() => {}} />,
    );
    expect(html).toContain("All approved");
    expect(html).not.toContain("Reject — return to Collect");
  });
});

describe("vendor create surface", () => {
  it("renders the master-record preview with the welcome toggle and the receipt", () => {
    const parsed = parseVendorReceipt(VENDOR_RECEIPT);
    const html = renderToString(
      <VendorCreateSurface
        artifact={vendorCreateArtifact()}
        receipt={parsed}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("V-2026-0042");
    expect(html).toContain("2026-09-12");
    expect(html).toContain("GB812345678");
    expect(html).toContain("Welcome packet will be sent");
    expect(html).toContain("Vendor V-2026-0042 created");
    expect(html).toContain("registry/vendors/V-2026-0042");
  });

  it("flags idempotent replays and existing master records", () => {
    const parsed = parseVendorReceipt({ ...VENDOR_RECEIPT, created: false });
    const html = renderToString(
      <VendorCreateSurface
        artifact={vendorCreateArtifact({
          existing: {
            vendorId: "V-2026-0001",
            legalName: "Northwind Supply Limited",
            createdAt: "2026-08-01T12:00:00Z",
          },
        })}
        receipt={parsed}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Existing master record");
    expect(html).toContain("no duplicate record");
    expect(html).toContain("V-2026-0042 already existed — creation replayed idempotently");
  });

  it("falls back to the receipt card once the artifact is gone", () => {
    const html = renderToString(
      <VendorCreateSurface
        artifact={{}}
        receipt={parseVendorReceipt(VENDOR_RECEIPT)}
        editable={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Vendor V-2026-0042 created");
  });

  it("parses receipts strictly and shares contract values", () => {
    expect(parseVendorReceipt({})).toBeNull();
    expect(parseVendorReceipt(VENDOR_RECEIPT)?.created).toBe(true);
    const created = parseVendorCreate(vendorCreateArtifact());
    expect(created?.record.vendorId).toBe("V-2026-0042");
    expect(created?.welcomePacket).toBe(true);
  });
});

function leaveIntakeArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "LR-1A2B3C4D",
    employeeId: "E-1001",
    employeeLabel: "J. A.",
    department: "Engineering",
    leaveType: "annual",
    startDate: "2026-10-05",
    endDate: "2026-10-09",
    note: "Family trip",
    balanceDays: 18,
    summary: "Annual leave request for five calendar days.",
    ...overrides,
  };
}

function leavePolicyArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...leaveIntakeArtifact(),
    workingDays: 5,
    balanceBefore: 18,
    balanceAfter: 13,
    checks: [
      {
        id: "balance",
        label: "Sufficient balance",
        status: "pass",
        detail: "18 day(s) available, 13 remain after this request.",
      },
      {
        id: "blackout",
        label: "No blackout overlap",
        status: "pass",
        detail: "No blackout window covers the range.",
      },
      {
        id: "notice",
        label: "Notice period",
        status: "flag",
        detail: "Starts in 3 day(s); the policy prefers 3.",
      },
    ],
    overlaps: [],
    blackoutHits: [],
    verdict: "ok",
    confidence: 0.86,
    ...overrides,
  };
}

function leaveApproveArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "LR-1A2B3C4D",
    employeeId: "E-1001",
    employeeLabel: "J. A.",
    approverRole: "Manager",
    approverLabel: "J. B.",
    slaHours: 24,
    state: "pending",
    requestedAt: "2026-09-20T09:00:00Z",
    decidedAt: null,
    note: null,
    summary: "Manager decision pending for the annual leave request.",
    ...overrides,
  };
}

function leaveApplyArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request: {
      entryId: "LE-1A2B3C4D",
      requestId: "LR-1A2B3C4D",
      employeeId: "E-1001",
      employeeLabel: "J. A.",
      leaveType: "annual",
      startDate: "2026-10-05",
      endDate: "2026-10-09",
      workingDays: 5,
      status: "booked",
    },
    idempotencyKey: "E-1001:2026-10-05:2026-10-09",
    existing: null,
    summary: "Preview: booking creates calendar entry LE-1A2B3C4D.",
    ...overrides,
  };
}

const LEAVE_RECEIPT = {
  entryId: "LE-1A2B3C4D",
  requestId: "LR-1A2B3C4D",
  employeeId: "E-1001",
  startDate: "2026-10-05",
  endDate: "2026-10-09",
  workingDays: 5,
  created: true,
  registryRef: "registry/leave/LE-1A2B3C4D",
};

describe("leave intake surface", () => {
  it("renders the request, the requester and the balance snapshot", () => {
    const html = renderToString(<LeaveIntakeSurface artifact={leaveIntakeArtifact()} />);
    expect(html).toContain("LR-1A2B3C4D");
    expect(html).toContain("J. A.");
    expect(html).toContain("Engineering");
    expect(html).toContain("annual");
    expect(html).toContain("2026-10-05 → 2026-10-09");
    expect(html).toContain("18 day(s) available");
    expect(html).toContain("Family trip");
  });

  it("shows an empty-state hint when the artifact is not readable", () => {
    const html = renderToString(<LeaveIntakeSurface artifact={{}} />);
    expect(html).toContain("not readable yet");
  });
});

describe("leave policy surface", () => {
  it("renders the verdict, the checks and the working-day math", () => {
    const html = renderToString(<LeavePolicySurface artifact={leavePolicyArtifact()} />);
    expect(html).toContain("policy ok");
    expect(html).toContain("5 working day(s)");
    expect(html).toContain("balance 18 → 13");
    expect(html).toContain("Sufficient balance");
    expect(html).toContain("No blackout overlap");
    expect(html).toContain("Advisor confidence 86%");
  });

  it("flags exception verdicts, overlaps and blackout hits", () => {
    const html = renderToString(
      <LeavePolicySurface
        artifact={leavePolicyArtifact({
          verdict: "exception_required",
          balanceAfter: -1,
          overlaps: [{ requestId: "LR-99", startDate: "2026-10-07", endDate: "2026-10-08" }],
          blackoutHits: ["Year-end close (2026-12-21 → 2026-12-31)"],
        })}
      />,
    );
    expect(html).toContain("exception required");
    expect(html).toContain("LR-99");
    expect(html).toContain("Year-end close");
  });
});

describe("leave approve surface", () => {
  it("renders the approver, the role and the target SLA", () => {
    const html = renderToString(<LeaveApproveSurface artifact={leaveApproveArtifact()} />);
    expect(html).toContain("J. B.");
    expect(html).toContain("Manager");
    expect(html).toContain("target 24h");
    expect(html).toContain("pending");
  });

  it("marks approved decisions", () => {
    const html = renderToString(
      <LeaveApproveSurface artifact={leaveApproveArtifact({ state: "approved" })} />,
    );
    expect(html).toContain("approved");
  });
});

describe("leave apply surface", () => {
  it("renders the entry preview and the signed receipt", () => {
    const html = renderToString(
      <LeaveApplySurface
        artifact={leaveApplyArtifact()}
        receipt={parseLeaveReceipt(LEAVE_RECEIPT)}
      />,
    );
    expect(html).toContain("LE-1A2B3C4D");
    expect(html).toContain("E-1001:2026-10-05:2026-10-09");
    expect(html).toContain("booked");
    expect(html).toContain("registry/leave/LE-1A2B3C4D");
  });

  it("flags idempotent replays with the original entry", () => {
    const html = renderToString(
      <LeaveApplySurface
        artifact={leaveApplyArtifact({
          existing: { entryId: "LE-OLD", createdAt: "2026-09-01T10:00:00Z" },
        })}
        receipt={parseLeaveReceipt({ ...LEAVE_RECEIPT, created: false })}
      />,
    );
    expect(html).toContain("already booked as LE-OLD");
    expect(html).toContain("replayed");
  });

  it("shows the preview state while the side effect has not run", () => {
    const html = renderToString(<LeaveApplySurface artifact={leaveApplyArtifact()} receipt={null} />);
    expect(html).toContain("preview");
  });

  it("parses receipts strictly", () => {
    expect(parseLeaveReceipt({})).toBeNull();
    expect(parseLeaveReceipt(LEAVE_RECEIPT)?.created).toBe(true);
    expect(parseLeaveReceipt({ ...LEAVE_RECEIPT, created: false })?.created).toBe(false);
  });
});

function onboardingCollectArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    onboardingId: "OB-1A2B3C4D",
    candidateLabel: "P. R.",
    roleTitle: "Backend Engineer",
    department: "Engineering",
    location: "London, UK",
    startDate: "2026-10-05",
    managerId: "E-1003",
    accessTier: "medium",
    documents: [
      {
        id: "id-verification",
        label: "ID verification",
        required: true,
        status: "received",
        fileName: "passport.pdf",
        waivedReason: null,
        nudges: 0,
        lastNudgedAt: null,
      },
      {
        id: "right-to-work",
        label: "Right to work",
        required: true,
        status: "waived",
        fileName: null,
        waivedReason: "Citizen — no permit needed.",
        nudges: 1,
        lastNudgedAt: "2026-09-20T09:00:00Z",
      },
      {
        id: "signed-contract",
        label: "Signed contract",
        required: true,
        status: "missing",
        fileName: null,
        waivedReason: null,
        nudges: 0,
        lastNudgedAt: null,
      },
      {
        id: "tax-form",
        label: "Tax form",
        required: true,
        status: "pending",
        fileName: null,
        waivedReason: null,
        nudges: 0,
        lastNudgedAt: null,
      },
      {
        id: "bank-details",
        label: "Bank details",
        required: true,
        status: "pending",
        fileName: null,
        waivedReason: null,
        nudges: 0,
        lastNudgedAt: null,
      },
    ],
    totals: { documents: 5, required: 5, received: 1, waived: 1, outstanding: 3 },
    returnedNote: null,
    summary: "Collect identity documents for P. R. (Backend Engineer, Engineering).",
    ...overrides,
  };
}

describe("onboarding collect surface", () => {
  it("renders the candidate, the checklist statuses and the outstanding gate", () => {
    const html = renderToString(
      <OnboardingCollectSurface
        artifact={onboardingCollectArtifact()}
        editable
        draft={null}
        returnNote={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("P. R. · Backend Engineer · Engineering · starts 2026-10-05");
    expect(html).toContain("1 of 5 received");
    expect(html).toContain("1 waived");
    expect(html).toContain("3 outstanding");
    expect(html).toContain("ID verification");
    expect(html).toContain("Signed contract");
    expect(html).toContain("File: passport.pdf");
    expect(html).toContain("nudged 1×");
    expect(html).toContain("Citizen — no permit needed.");
    expect(html).toContain("Upload ID verification");
    expect(html).toContain("Signed contract, Tax form, Bank details outstanding");
  });

  it("shows the returned-for-rework note after a reject loop", () => {
    const html = renderToString(
      <OnboardingCollectSurface
        artifact={onboardingCollectArtifact()}
        editable={false}
        draft={null}
        returnNote="Bank details page is illegible — re-collect."
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Returned for rework");
    expect(html).toContain("Bank details page is illegible — re-collect.");
  });

  it("shows an empty-state hint when the artifact is not readable", () => {
    const html = renderToString(
      <OnboardingCollectSurface
        artifact={{}}
        editable={false}
        draft={null}
        returnNote={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("The document checklist is not readable yet.");
  });
});

function onboardingVerifyArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    onboardingId: "OB-1A2B3C4D",
    candidateLabel: "P. R.",
    checks: [
      {
        id: "id-verification",
        label: "ID verification",
        status: "pass",
        source: "documents",
        checkedAt: "2026-09-20T09:00:00Z",
        detail: "ID verification received with a file.",
      },
      {
        id: "start-date",
        label: "Start date policy",
        status: "flag",
        source: "calendar",
        checkedAt: "2026-09-20T09:00:00Z",
        detail: "Starts in 15 day(s); the policy prefers 10.",
      },
      {
        id: "duplicate-screening",
        label: "Duplicate screening",
        status: "fail",
        source: "directory",
        checkedAt: "2026-09-20T09:00:00Z",
        detail: "Likely duplicate of E-1001 (score 1.00).",
      },
    ],
    candidates: [
      {
        employeeId: "E-1001",
        label: "J. A.",
        matchScore: 1,
        matchedOn: ["name", "department"],
      },
    ],
    manualReview: {
      required: true,
      items: [
        { checkId: "duplicate-screening", reason: "Directory lookalike needs a human call." },
      ],
    },
    resolutions: [],
    summary: "Verification found one failing check for P. R.",
    confidence: 0.78,
    ...overrides,
  };
}

describe("onboarding verify surface", () => {
  it("renders the check table, the lookalikes and the manual review notes", () => {
    const html = renderToString(
      <OnboardingVerifySurface
        artifact={onboardingVerifyArtifact()}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Verification found one failing check for P. R.");
    expect(html).toContain("confidence 78%");
    expect(html).toContain("3 checks");
    expect(html).toContain("Start date policy");
    expect(html).toContain("Likely duplicate of E-1001 (score 1.00).");
    expect(html).toContain("Directory lookalikes · 1");
    expect(html).toContain("match 100%");
    expect(html).toContain("Matched on: name, department");
    expect(html).toContain("Manual review · 1");
    expect(html).toContain("Manual-review note");
  });

  it("clears the manual review state when every check passes", () => {
    const html = renderToString(
      <OnboardingVerifySurface
        artifact={onboardingVerifyArtifact({
          checks: [
            {
              id: "id-verification",
              label: "ID verification",
              status: "pass",
              source: "documents",
              checkedAt: "2026-09-20T09:00:00Z",
              detail: "ID verification received with a file.",
            },
          ],
          candidates: [],
        })}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Every check passed — no manual review is required.");
    expect(html).toContain("Directory lookalikes · 0");
  });
});

function onboardingRiskArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    onboardingId: "OB-1A2B3C4D",
    candidateLabel: "P. R.",
    roleTitle: "Backend Engineer",
    department: "Engineering",
    score: 46,
    tier: "medium",
    factors: [
      {
        id: "access-tier",
        label: "Access tier — medium",
        points: 20,
        detail: "Medium tier adds 20 points.",
      },
      {
        id: "department",
        label: "Department — Engineering",
        points: 16,
        detail: "Engineering adds 16 points.",
      },
    ],
    requiredSigners: ["people-partner", "department-head"],
    matrix: [
      { tier: "low", requiredSigners: ["people-partner"] },
      { tier: "medium", requiredSigners: ["people-partner", "department-head"] },
      {
        tier: "high",
        requiredSigners: ["people-partner", "department-head", "people-ops-director"],
      },
    ],
    summary: "Medium access risk for this hire.",
    confidence: 0.83,
    ...overrides,
  };
}

describe("onboarding risk surface", () => {
  it("renders the meter, the tier and the factor breakdown", () => {
    const html = renderToString(<OnboardingRiskSurface artifact={onboardingRiskArtifact()} />);
    expect(html).toContain("Medium access risk for this hire.");
    expect(html).toContain("confidence 83%");
    expect(html).toContain("Risk score 46 of 100");
    expect(html).toContain("46 / 100");
    expect(html).toContain("Tier medium — required signers: People Partner, Department Head");
    expect(html).toContain("Access tier — medium");
    expect(html).toContain("+20");
    expect(html).toContain("Medium tier adds 20 points.");
    expect(html).toContain("Approver matrix");
    expect(html).toContain("People Ops Director");
  });

  it("shows an empty-state hint when the artifact is not readable", () => {
    const html = renderToString(<OnboardingRiskSurface artifact={{}} />);
    expect(html).toContain("The risk score is not readable yet.");
  });
});

function onboardingApproveArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    onboardingId: "OB-1A2B3C4D",
    candidateLabel: "P. R.",
    tier: "medium",
    slaHours: 48,
    chain: [
      {
        role: "people-partner",
        name: "L. F.",
        state: "approved",
        requestedAt: "2026-09-18T09:00:00Z",
        actedAt: "2026-09-18T12:00:00Z",
        note: "Paperwork checked.",
        nudges: 0,
        lastNudgedAt: null,
      },
      {
        role: "department-head",
        name: "T. B.",
        state: "pending",
        requestedAt: "2026-09-18T09:00:00Z",
        actedAt: null,
        note: null,
        nudges: 1,
        lastNudgedAt: "2026-09-19T09:00:00Z",
      },
    ],
    comments: [
      { author: "L. F.", at: "2026-09-18T12:00:00Z", body: "Headcount confirmed." },
    ],
    allApproved: false,
    summary: "Two signers must approve this medium-risk hire.",
    ...overrides,
  };
}

describe("onboarding approve surface", () => {
  it("renders the signer chain with the SLA age, nudges and comments", () => {
    const html = renderToString(
      <OnboardingApproveSurface
        artifact={onboardingApproveArtifact()}
        editable
        draft={null}
        onChange={() => {}}
        returnFlow={{ onReturn: () => {}, busy: false }}
      />,
    );
    expect(html).toContain("Two signers must approve this medium-risk hire.");
    expect(html).toContain("SLA 48h");
    expect(html).toContain("Awaiting signers");
    expect(html).toContain("People Partner");
    expect(html).toContain("Department Head");
    expect(html).toContain("L. F.");
    expect(html).toContain("T. B.");
    expect(html).toContain("of 48h SLA");
    expect(html).toContain("nudged 1×");
    expect(html).toContain("Paperwork checked.");
    expect(html).toContain("Comments · 1");
    expect(html).toContain("Headcount confirmed.");
    expect(html).toContain("Reject — return to Collect");
  });

  it("marks a fully approved chain", () => {
    const html = renderToString(
      <OnboardingApproveSurface
        artifact={onboardingApproveArtifact({
          allApproved: true,
          chain: [
            {
              role: "people-partner",
              name: "L. F.",
              state: "approved",
              requestedAt: "2026-09-18T09:00:00Z",
              actedAt: "2026-09-18T12:00:00Z",
              note: null,
              nudges: 0,
              lastNudgedAt: null,
            },
            {
              role: "department-head",
              name: "T. B.",
              state: "approved",
              requestedAt: "2026-09-18T09:00:00Z",
              actedAt: "2026-09-19T10:00:00Z",
              note: null,
              nudges: 0,
              lastNudgedAt: null,
            },
          ],
        })}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("All approved");
    expect(html).not.toContain("Reject — return to Collect");
  });

  it("shows an empty-state hint when the artifact is not readable", () => {
    const html = renderToString(
      <OnboardingApproveSurface
        artifact={{}}
        editable={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("The approval chain is not readable yet.");
  });
});

function onboardingProvisionArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    employee: {
      employeeId: "E-1042",
      label: "P. R.",
      roleTitle: "Backend Engineer",
      department: "Engineering",
      location: "London, UK",
      managerId: "E-1003",
      accessTier: "medium",
      effectiveDate: "2026-10-05",
      status: "onboarding",
    },
    accounts: ["sso", "email", "slack"],
    equipmentTicket: { id: "EQ-77", item: "Laptop (MacBook Pro 14)", location: "London, UK" },
    payrollEnrollment: { id: "PE-88", payGroup: "UK Monthly" },
    idempotencyKey: "provision:E-1042",
    existing: null,
    summary: "Preview: provisioning creates E-1042 with 3 accounts.",
    ...overrides,
  };
}

const ONBOARDING_RECEIPT = {
  employeeId: "E-1042",
  label: "P. R.",
  department: "Engineering",
  accessTier: "medium",
  effectiveDate: "2026-10-05",
  accounts: ["sso", "email", "slack"],
  equipmentTicketId: "EQ-77",
  payrollEnrollmentId: "PE-88",
  created: true,
  registryRef: "registry/hr/E-1042",
};

describe("onboarding provision surface", () => {
  it("renders the employee preview, the provisioning plan and the receipt", () => {
    const html = renderToString(
      <OnboardingProvisionSurface
        artifact={onboardingProvisionArtifact()}
        receipt={parseOnboardingReceipt(ONBOARDING_RECEIPT)}
      />,
    );
    expect(html).toContain("Preview: provisioning creates E-1042 with 3 accounts.");
    expect(html).toContain("E-1042");
    expect(html).toContain("Backend Engineer");
    expect(html).toContain("E-1003");
    expect(html).toContain("2026-10-05");
    expect(html).toContain("provision:E-1042");
    expect(html).toContain("Provisioning plan · 3 account(s)");
    expect(html).toContain("Account · sso");
    expect(html).toContain("Equipment: Laptop (MacBook Pro 14) → London, UK (EQ-77)");
    expect(html).toContain("Payroll: UK Monthly (PE-88)");
    expect(html).toContain("Employee E-1042 provisioned");
    expect(html).toContain("Registry: registry/hr/E-1042");
    expect(html).toContain("replaying this decision returns the original receipt");
  });

  it("flags idempotent replays with the existing record", () => {
    const html = renderToString(
      <OnboardingProvisionSurface
        artifact={onboardingProvisionArtifact({
          existing: { employeeId: "E-1042", createdAt: "2026-09-01T10:00:00Z" },
        })}
        receipt={parseOnboardingReceipt({ ...ONBOARDING_RECEIPT, created: false })}
      />,
    );
    expect(html).toContain("Existing employee record");
    expect(html).toContain("E-1042 · created 2026-09-01T10:00:00Z.");
    expect(html).toContain("already existed — provisioning replayed idempotently");
  });

  it("falls back to the receipt-only card when the preview is not readable", () => {
    const html = renderToString(
      <OnboardingProvisionSurface
        artifact={{}}
        receipt={parseOnboardingReceipt(ONBOARDING_RECEIPT)}
      />,
    );
    expect(html).toContain("Employee E-1042 provisioned");
    expect(html).toContain("Registry: registry/hr/E-1042");
  });

  it("parses receipts strictly", () => {
    expect(parseOnboardingReceipt({})).toBeNull();
    expect(parseOnboardingReceipt(ONBOARDING_RECEIPT)?.created).toBe(true);
    expect(parseOnboardingReceipt({ ...ONBOARDING_RECEIPT, created: false })?.created).toBe(false);
  });
});

function offboardingIntakeArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    offboardingId: "OF-1A2B3C4D",
    employeeId: "E-1005",
    employeeLabel: "M. S.",
    roleTitle: "Staff Accountant",
    department: "Finance",
    location: "Lisbon, PT",
    accessTier: "high",
    managerId: "E-1002",
    lastDay: "2026-10-30",
    reason: "Resignation — moving on",
    systems: ["banking", "erp", "okta", "payroll", "slack"],
    summary: "Departure on 2026-10-30 with 5 systems to revoke.",
    ...overrides,
  };
}

describe("offboarding intake surface", () => {
  it("renders the leaver, the departure facts and the systems", () => {
    const html = renderToString(<OffboardingIntakeSurface artifact={offboardingIntakeArtifact()} />);
    expect(html).toContain("OF-1A2B3C4D");
    expect(html).toContain("high tier");
    expect(html).toContain("M. S.");
    expect(html).toContain("last day 2026-10-30");
    expect(html).toContain("E-1005 · M. S.");
    expect(html).toContain("Staff Accountant · Finance");
    expect(html).toContain("Lisbon, PT");
    expect(html).toContain("E-1002");
    expect(html).toContain("Resignation — moving on");
    expect(html).toContain("Systems to revoke · 5");
    expect(html).toContain("payroll");
  });

  it("shows an empty-state hint when the artifact is not readable", () => {
    const html = renderToString(<OffboardingIntakeSurface artifact={{}} />);
    expect(html).toContain("The offboarding intake is not readable yet.");
  });
});

function offboardingAuditArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    offboardingId: "OF-1A2B3C4D",
    employeeId: "E-1005",
    employeeLabel: "M. S.",
    roleTitle: "Staff Accountant",
    department: "Finance",
    accessTier: "high",
    lastDay: "2026-10-30",
    reason: "Resignation — moving on",
    entries: [
      {
        system: "banking",
        label: "Banking portal",
        blastRadius: "high",
        riskScore: 75,
        reversibility: "irreversible",
        detail: "Moves money — revoking locks the account.",
      },
      {
        system: "payroll",
        label: "Payroll",
        blastRadius: "high",
        riskScore: 70,
        reversibility: "recoverable",
        detail: "Final payslip data must be exported first.",
      },
      {
        system: "slack",
        label: "Slack",
        blastRadius: "low",
        riskScore: 20,
        reversibility: "reversible",
        detail: "Deactivating frees the seat.",
      },
    ],
    dataOwnership: [
      { system: "banking", dataClass: "Payment approvals", owner: "Finance Ops" },
      { system: "slack", dataClass: "Chat history", owner: "IT" },
    ],
    risks: [
      {
        id: "dual-custody",
        label: "Dual custody on banking",
        tier: "high",
        detail: "A second signer still holds the token.",
      },
    ],
    summary: "Three systems audited; banking and payroll are high blast.",
    confidence: 0.81,
    ...overrides,
  };
}

describe("offboarding audit surface", () => {
  it("renders the blast table, the ownership map and the departure risks", () => {
    const html = renderToString(<OffboardingAuditSurface artifact={offboardingAuditArtifact()} />);
    expect(html).toContain("Three systems audited; banking and payroll are high blast.");
    expect(html).toContain("confidence 81%");
    expect(html).toContain("Banking portal");
    expect(html).toContain("75 / 100");
    expect(html).toContain("irreversible");
    expect(html).toContain("Moves money — revoking locks the account.");
    expect(html).toContain("Data ownership · 2");
    expect(html).toContain("Payment approvals");
    expect(html).toContain("Finance Ops");
    expect(html).toContain("Departure risks · 1");
    expect(html).toContain("Dual custody on banking");
  });

  it("shows an empty-state hint when the artifact is not readable", () => {
    const html = renderToString(<OffboardingAuditSurface artifact={{}} />);
    expect(html).toContain("The access audit is not readable yet.");
  });
});

function offboardingApproveArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    offboardingId: "OF-1A2B3C4D",
    employeeId: "E-1005",
    employeeLabel: "M. S.",
    lastDay: "2026-10-30",
    items: [
      {
        system: "banking",
        label: "Banking portal",
        blastRadius: "high",
        riskScore: 75,
        reversibility: "irreversible",
        requiresExplicitApproval: true,
        approved: true,
        approver: "F. O.",
        note: "Second signer confirmed.",
      },
      {
        system: "payroll",
        label: "Payroll",
        blastRadius: "high",
        riskScore: 70,
        reversibility: "recoverable",
        requiresExplicitApproval: true,
        approved: false,
        approver: null,
        note: null,
      },
      {
        system: "slack",
        label: "Slack",
        blastRadius: "low",
        riskScore: 20,
        reversibility: "reversible",
        requiresExplicitApproval: false,
        approved: false,
        approver: null,
        note: null,
      },
    ],
    explicitApprovalsRequired: 2,
    allApproved: false,
    summary: "Two high-blast revocations need a named sign-off before revoking.",
    ...overrides,
  };
}

describe("offboarding approve surface", () => {
  it("renders the revocation list, the sign-offs and the outstanding gate", () => {
    const html = renderToString(
      <OffboardingApproveSurface
        artifact={offboardingApproveArtifact()}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Two high-blast revocations need a named sign-off before revoking.");
    expect(html).toContain("2 explicit approval(s) required");
    expect(html).toContain("Awaiting sign-off");
    expect(html).toContain("Banking portal");
    expect(html).toContain("risk 75 / 100 · irreversible");
    expect(html).toContain("Approver (sign-off required)");
    expect(html).toContain("Undo approval");
    expect(html).toContain(
      "Every revocation needs approval, and high-blast items need a recorded approver (Payroll, Slack outstanding).",
    );
  });

  it("marks a fully approved list", () => {
    const html = renderToString(
      <OffboardingApproveSurface
        artifact={offboardingApproveArtifact({
          allApproved: true,
          items: [
            {
              system: "banking",
              label: "Banking portal",
              blastRadius: "high",
              riskScore: 75,
              reversibility: "irreversible",
              requiresExplicitApproval: true,
              approved: true,
              approver: "F. O.",
              note: null,
            },
          ],
        })}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("All approved");
  });

  it("shows an empty-state hint when the artifact is not readable", () => {
    const html = renderToString(
      <OffboardingApproveSurface artifact={{}} editable={false} draft={null} onChange={() => {}} />,
    );
    expect(html).toContain("The revocation approval list is not readable yet.");
  });
});

function offboardingRevokeArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    offboardingId: "OF-1A2B3C4D",
    employeeId: "E-1005",
    employeeLabel: "M. S.",
    lastDay: "2026-10-30",
    actions: [
      {
        system: "banking",
        label: "Banking portal",
        blastRadius: "high",
        status: "revoked",
        detail: "Account locked by Finance Ops.",
      },
      {
        system: "payroll",
        label: "Payroll",
        blastRadius: "high",
        status: "failed",
        detail: "Registry rejected: final payslip pending.",
      },
      {
        system: "slack",
        label: "Slack",
        blastRadius: "low",
        status: "pending",
        detail: "Queued for deactivation.",
      },
    ],
    summary: "Revocation plan for 3 systems.",
    ...overrides,
  };
}

const OFFBOARDING_REVOKE_RECEIPT = {
  employeeId: "E-1005",
  label: "M. S.",
  revoked: ["banking", "slack"],
  failed: [{ system: "payroll", reason: "Registry rejected: final payslip pending." }],
  replayed: 1,
  idempotencyKey: "offboard:E-1005:banking",
  registryRef: "registry/offboarding/E-1005",
  completedAt: "2026-10-30T18:00:00Z",
};

describe("offboarding revoke surface", () => {
  it("renders the plan, the failures and the signed receipt", () => {
    const html = renderToString(
      <OffboardingRevokeSurface
        artifact={offboardingRevokeArtifact()}
        receipt={parseOffboardingRevokeReceipt(OFFBOARDING_REVOKE_RECEIPT)}
      />,
    );
    expect(html).toContain("Revocation plan for 3 systems.");
    expect(html).toContain("completed with failures");
    expect(html).toContain("Banking portal");
    expect(html).toContain("revoked");
    expect(html).toContain("Failures · 1");
    expect(html).toContain("Registry rejected: final payslip pending.");
    expect(html).toContain("Revoked: banking, slack");
    expect(html).toContain("Failed: payroll");
    expect(html).toContain("Replayed: 1");
    expect(html).toContain("Idempotency key: offboard:E-1005:banking");
    expect(html).toContain("Registry: registry/offboarding/E-1005");
  });

  it("shows the preview state while the side effect has not run", () => {
    const html = renderToString(
      <OffboardingRevokeSurface artifact={offboardingRevokeArtifact()} receipt={null} />,
    );
    expect(html).toContain("preview");
    expect(html).not.toContain("Failures · 1");
  });

  it("parses receipts strictly", () => {
    expect(parseOffboardingRevokeReceipt({})).toBeNull();
    expect(parseOffboardingRevokeReceipt(OFFBOARDING_REVOKE_RECEIPT)?.replayed).toBe(1);
  });
});

function offboardingAttestArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    offboardingId: "OF-1A2B3C4D",
    employeeId: "E-1005",
    employeeLabel: "M. S.",
    lastDay: "2026-10-30",
    finalPay: {
      items: [
        {
          id: "final-payslip",
          label: "Final payslip",
          status: "ready",
          detail: "Exported to payroll.",
        },
        {
          id: "expense-claims",
          label: "Expense claims",
          status: "pending",
          detail: "Two claims still in review.",
        },
      ],
      outstanding: 1,
    },
    equipment: {
      items: [
        {
          id: "laptop",
          label: "Laptop (ThinkPad X1)",
          status: "returned",
          detail: "Received by IT on 2026-10-28.",
        },
        {
          id: "badge",
          label: "Building badge",
          status: "outstanding",
          detail: "Not yet returned.",
        },
      ],
      outstanding: 1,
    },
    revocation: {
      revoked: ["banking", "slack"],
      failed: [{ system: "payroll", reason: "Registry rejected: final payslip pending." }],
    },
    acknowledgements: [],
    existing: null,
    summary: "Case closes for E-1005 on 2026-10-30: 2 revoked, 1 failed, 1 outstanding.",
    ...overrides,
  };
}

const OFFBOARDING_ATTEST_RECEIPT = {
  offboardingId: "OF-1A2B3C4D",
  employeeId: "E-1005",
  label: "M. S.",
  revokedSystems: ["banking", "slack"],
  failedSystems: ["payroll"],
  equipmentOutstanding: ["Building badge"],
  finalPayReady: false,
  caseClosed: true,
  created: true,
  registryRef: "offboard:E-1005",
  closedAt: "2026-10-30T18:30:00Z",
};

describe("offboarding attest surface", () => {
  it("renders final pay, equipment, the ack note and the receipt", () => {
    const html = renderToString(
      <OffboardingAttestSurface
        artifact={offboardingAttestArtifact()}
        receipt={parseOffboardingAttestReceipt(OFFBOARDING_ATTEST_RECEIPT)}
        revokeReceipt={null}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Case closes for E-1005 on 2026-10-30");
    expect(html).toContain("E-1005 · M. S.");
    expect(html).toContain("1 pending");
    expect(html).toContain("1 outstanding");
    expect(html).toContain("Final-pay checklist · 2");
    expect(html).toContain("Final payslip");
    expect(html).toContain("Equipment returns · 2");
    expect(html).toContain("Laptop (ThinkPad X1)");
    expect(html).toContain("Access revocation · 2 revoked · 1 failed");
    expect(html).toContain("Revoked · banking");
    expect(html).toContain(
      "Every failed revocation needs an acknowledgement note before the case can close.",
    );
    expect(html).toContain("Acknowledgement note");
    expect(html).toContain("Case closed for E-1005 (M. S.)");
    expect(html).toContain("Final pay ready: no");
    expect(html).toContain("Registry: offboard:E-1005");
  });

  it("shows the existing-attestation callout and the revoke receipt before the close", () => {
    const html = renderToString(
      <OffboardingAttestSurface
        artifact={offboardingAttestArtifact({
          existing: { closedAt: "2026-10-29T09:00:00Z" },
        })}
        receipt={null}
        revokeReceipt={parseOffboardingRevokeReceipt(OFFBOARDING_REVOKE_RECEIPT)}
        editable={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("The case was already closed at 2026-10-29T09:00:00Z");
    expect(html).toContain("Revocation receipt — 2 revoked, 1 failed");
    expect(html).toContain("Idempotency key: offboard:E-1005:banking");
  });

  it("falls back to the receipt-only card when the artifact is not readable", () => {
    const html = renderToString(
      <OffboardingAttestSurface
        artifact={{}}
        receipt={parseOffboardingAttestReceipt(OFFBOARDING_ATTEST_RECEIPT)}
        revokeReceipt={null}
        editable={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Case closed for E-1005 (M. S.)");
    expect(html).toContain("Closed 2026-10-30T18:30:00Z");
  });

  it("marks idempotent replays of the close", () => {
    const html = renderToString(
      <OffboardingAttestSurface
        artifact={offboardingAttestArtifact()}
        receipt={parseOffboardingAttestReceipt({ ...OFFBOARDING_ATTEST_RECEIPT, created: false })}
        revokeReceipt={null}
        editable={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("was already attested — the close replayed idempotently");
  });

  it("parses receipts strictly", () => {
    expect(parseOffboardingAttestReceipt({})).toBeNull();
    expect(parseOffboardingAttestReceipt(OFFBOARDING_ATTEST_RECEIPT)?.caseClosed).toBe(true);
    expect(
      parseOffboardingAttestReceipt({ ...OFFBOARDING_ATTEST_RECEIPT, created: false })?.created,
    ).toBe(false);
  });
});

function screeningRequisitionArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requisitionId: "REQ-2001",
    roleTitle: "Senior Frontend Engineer",
    department: "Engineering",
    location: "Remote (EU)",
    seniority: "senior",
    criteria: [
      {
        id: "react-depth",
        label: "React depth",
        weight: 30,
        mustHave: true,
        detail: "Ships and reviews production React; comfortable with modern server components.",
      },
      {
        id: "typescript",
        label: "TypeScript",
        weight: 25,
        mustHave: true,
        detail: "Strong typing discipline in strict mode across a real codebase.",
      },
      {
        id: "testing",
        label: "Testing discipline",
        weight: 20,
        mustHave: false,
        detail: "Automated tests around UI behaviour, not just snapshots.",
      },
    ],
    mustHaves: 2,
    candidateIds: ["C-3001", "C-3002", "C-3003"],
    interviewers: ["E-1001", "E-1002"],
    summary:
      "Senior Frontend Engineer (Engineering, Remote (EU)) — 3 weighted criteria with 2 must-have(s) and 3 candidate(s) to screen.",
    ...overrides,
  };
}

describe("screening requisition surface", () => {
  it("renders the role, the weighted rubric and the pipeline", () => {
    const html = renderToString(
      <ScreeningRequisitionSurface artifact={screeningRequisitionArtifact()} />,
    );
    expect(html).toContain("REQ-2001");
    expect(html).toContain("Senior Frontend Engineer");
    expect(html).toContain("senior");
    expect(html).toContain("Remote (EU)");
    expect(html).toContain("Engineering");
    expect(html).toContain("3 candidate(s)");
    expect(html).toContain("E-1001, E-1002");
    expect(html).toContain("2 of 3 criteria");
    expect(html).toContain("Hiring rubric · 3");
    expect(html).toContain("React depth");
    expect(html).toContain("30%");
    expect(html).toContain("must-have");
    expect(html).toContain("nice-to-have");
    expect(html).toContain("Ships and reviews production React");
  });

  it("falls back to the empty hint when the artifact is not readable", () => {
    const html = renderToString(<ScreeningRequisitionSurface artifact={{}} />);
    expect(html).toContain("The requisition is not readable yet.");
  });
});

function screeningScreenArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requisitionId: "REQ-2001",
    roleTitle: "Senior Frontend Engineer",
    department: "Engineering",
    candidates: [
      {
        candidateId: "C-3001",
        candidateLabel: "I. V.",
        headline: "Staff engineer, 9 years",
        verdicts: [
          {
            criterionId: "react-depth",
            label: "React depth",
            weight: 30,
            mustHave: true,
            verdict: "pass",
            citations: [
              {
                sourceId: "cv:C-3001",
                span: "83-140",
                text: "Led the migration of the billing console to React 19.",
              },
            ],
          },
          {
            criterionId: "testing",
            label: "Testing discipline",
            weight: 20,
            mustHave: false,
            verdict: "partial",
            citations: [
              {
                sourceId: "screen-call:C-3001",
                span: "12-96",
                text: "Writes tests when the schedule allows.",
              },
            ],
          },
          {
            criterionId: "mentoring",
            label: "Mentoring",
            weight: 10,
            mustHave: false,
            verdict: "fail",
            citations: [],
          },
        ],
        score: 84,
        mustHaveMisses: [],
        flags: [],
      },
      {
        candidateId: "C-3003",
        candidateLabel: "H. S.",
        headline: "Senior engineer, 8 years",
        verdicts: [
          {
            criterionId: "react-depth",
            label: "React depth",
            weight: 30,
            mustHave: true,
            verdict: "pass",
            citations: [
              {
                sourceId: "cv:C-3003",
                span: "64-120",
                text: "Leads the React guild across teams.",
              },
            ],
          },
          {
            criterionId: "typescript",
            label: "TypeScript",
            weight: 25,
            mustHave: true,
            verdict: "fail",
            citations: [],
          },
          {
            criterionId: "design-systems",
            label: "Design systems",
            weight: 15,
            mustHave: false,
            verdict: "partial",
            citations: [
              {
                sourceId: "screen-call:C-3003",
                span: "30-104",
                text: "Contributed a few tokens; mostly consumed the library.",
              },
            ],
          },
        ],
        score: 76,
        mustHaveMisses: ["TypeScript"],
        flags: [
          {
            candidateId: "C-3003",
            kind: "protected-attribute",
            detail: "The note references age; it must not inform screening.",
            sourceId: "screen-call:C-3003",
            span: "160-198",
          },
          {
            candidateId: "C-3003",
            kind: "non-rubric",
            detail: "Fast-tracking reasoning is not tied to a rubric criterion.",
            sourceId: null,
            span: null,
          },
        ],
      },
    ],
    guardrail: {
      allowed: false,
      summary: "One protected-attribute flag needs a human decision before the shortlist is final.",
      confidence: 0.88,
    },
    totalFlags: 2,
    summary: "Screened 2 candidate(s) against 3 criteria: 2 guardrail flag(s) recorded.",
    ...overrides,
  };
}

describe("screening screen surface", () => {
  it("renders per-criterion verdicts with citations, misses and guardrail flags", () => {
    const html = renderToString(<ScreeningScreenSurface artifact={screeningScreenArtifact()} />);
    expect(html).toContain("confidence 88%");
    expect(html).toContain("guardrail flagged");
    expect(html).toContain("2 guardrail flag(s)");
    expect(html).toContain("I. V. · C-3001");
    expect(html).toContain("score 84");
    expect(html).toContain("clear");
    expect(html).toContain("H. S. · C-3003");
    expect(html).toContain("score 76");
    expect(html).toContain("2 flag(s)");
    expect(html).toContain(
      "cv:C-3001 @ 83-140 — Led the migration of the billing console to React 19.",
    );
    expect(html).toContain("No citations");
    expect(html).toContain("Must-have misses: TypeScript");
    expect(html).toContain("Guardrail flags · 2");
    expect(html).toContain("protected-attribute");
    expect(html).toContain("non-rubric");
    expect(html).toContain("Source: screen-call:C-3003 @ 160-198");
    expect(html).toContain("Screened 2 candidate(s) against 3 criteria: 2 guardrail flag(s) recorded.");
  });

  it("shows the clear pill when the guardrail allows the pool", () => {
    const html = renderToString(
      <ScreeningScreenSurface
        artifact={screeningScreenArtifact({
          guardrail: { allowed: true, summary: "No flags.", confidence: 0.9 },
          totalFlags: 0,
        })}
      />,
    );
    expect(html).toContain("guardrail clear");
    expect(html).toContain("0 guardrail flag(s)");
  });

  it("falls back to the empty hint when the artifact is not readable", () => {
    const html = renderToString(<ScreeningScreenSurface artifact={{}} />);
    expect(html).toContain("The screening results are not readable yet.");
  });
});

function screeningShortlistArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requisitionId: "REQ-2001",
    roleTitle: "Senior Frontend Engineer",
    entries: [
      {
        candidateId: "C-3001",
        candidateLabel: "I. V.",
        score: 84,
        decision: "include",
        reason: "Meets every must-have at score 84.",
        flags: 0,
      },
      {
        candidateId: "C-3003",
        candidateLabel: "H. S.",
        score: 76,
        decision: "exclude",
        reason: "Protected-attribute language flagged; a human decision is required before including.",
        flags: 2,
      },
    ],
    included: 1,
    excluded: 1,
    summary: "1 of 2 candidate(s) included; 1 excluded pending review.",
    ...overrides,
  };
}

describe("screening shortlist surface", () => {
  it("renders the include/exclude decisions and the recorded reasons", () => {
    const html = renderToString(
      <ScreeningShortlistSurface
        artifact={screeningShortlistArtifact()}
        editable={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("1 included");
    expect(html).toContain("1 excluded");
    expect(html).toContain("Ready to schedule");
    expect(html).toContain("I. V. · C-3001");
    expect(html).toContain("score 84");
    expect(html).toContain("no guardrail flags");
    expect(html).toContain("state-approved");
    expect(html).toContain("Meets every must-have at score 84.");
    expect(html).toContain("H. S. · C-3003");
    expect(html).toContain("2 guardrail flag(s)");
    expect(html).toContain("state-pending");
    expect(html).toContain(
      "Excluded: Protected-attribute language flagged; a human decision is required before including.",
    );
  });

  it("gates the scheduling with the include and reason errors", () => {
    const draft: ScreeningShortlistDraft = {
      entries: [
        {
          candidateId: "C-3001",
          candidateLabel: "I. V.",
          score: 84,
          decision: "exclude",
          reason: "",
          flags: 0,
        },
        {
          candidateId: "C-3003",
          candidateLabel: "H. S.",
          score: 76,
          decision: "exclude",
          reason: "Protected-attribute flag.",
          flags: 2,
        },
      ],
    };
    const html = renderToString(
      <ScreeningShortlistSurface
        artifact={screeningShortlistArtifact()}
        editable
        draft={draft}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Awaiting at least one include");
    expect(html).toContain("0 included");
    expect(html).toContain("2 excluded");
    expect(html).toContain("Include at least one candidate before scheduling interviews.");
    expect(html).toContain("I. V. is excluded without a reason; record why.");
    expect(html).toContain("Exclusion reason");
    expect(html).toContain("Include");
    expect(html).toContain("Exclude");
  });

  it("falls back to the empty hint and parses strictly", () => {
    const html = renderToString(
      <ScreeningShortlistSurface
        artifact={{}}
        editable={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("The shortlist is not readable yet.");
    expect(parseScreeningShortlist({})).toBeNull();
    expect(parseScreeningShortlist(screeningShortlistArtifact())?.included).toBe(1);
  });
});

function screeningScheduleArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requisitionId: "REQ-2001",
    roleTitle: "Senior Frontend Engineer",
    invites: [
      {
        candidateId: "C-3001",
        candidateLabel: "I. V.",
        slot: "2026-09-15 10:00",
        interviewer: "E-1001",
        status: "scheduled",
        detail: "Panel interview with E-1001 at 2026-09-15 10:00.",
      },
      {
        candidateId: "C-3002",
        candidateLabel: "B. C.",
        slot: "2026-09-17 10:00",
        interviewer: "E-1002",
        status: "failed",
        detail: "ATS calendar rejected the slot.",
      },
    ],
    summary:
      "Schedules 2 interview(s) for requisition REQ-2001; every invite is idempotent by candidate and requisition.",
    ...overrides,
  };
}

const SCREENING_SCHEDULE_RECEIPT = {
  requisitionId: "REQ-2001",
  scheduled: [{ candidateId: "C-3001", slot: "2026-09-15 10:00" }],
  failed: [{ candidateId: "C-3002", reason: "ATS calendar rejected the slot." }],
  replayed: 1,
  idempotencyKey: "schedule:REQ-2001",
  registryRef: "screening:REQ-2001",
  completedAt: "2026-09-08T09:30:00Z",
};

describe("screening schedule surface", () => {
  it("renders the invite plan, the failures and the signed receipt", () => {
    const html = renderToString(
      <ScreeningScheduleSurface
        artifact={screeningScheduleArtifact()}
        receipt={parseScreeningScheduleReceipt(SCREENING_SCHEDULE_RECEIPT)}
      />,
    );
    expect(html).toContain("scheduled with failures");
    expect(html).toContain("I. V. · C-3001");
    expect(html).toContain("2026-09-15 10:00");
    expect(html).toContain("Panel interview with E-1001 at 2026-09-15 10:00.");
    expect(html).toContain("Failures · 1");
    expect(html).toContain("ATS calendar rejected the slot.");
    expect(html).toContain("Interview invites sent with 1 failure(s)");
    expect(html).toContain("Scheduled: C-3001 @ 2026-09-15 10:00");
    expect(html).toContain("Failed: C-3002");
    expect(html).toContain("Replayed: 1");
    expect(html).toContain("Idempotency key: schedule:REQ-2001");
    expect(html).toContain("Registry: screening:REQ-2001");
  });

  it("shows the preview state while the side effect has not run", () => {
    const html = renderToString(
      <ScreeningScheduleSurface artifact={screeningScheduleArtifact()} receipt={null} />,
    );
    expect(html).toContain("preview");
    expect(html).not.toContain("Failures · 1");
    expect(html).not.toContain("Idempotency key");
  });

  it("falls back to the receipt-only card when the artifact is not readable", () => {
    const html = renderToString(
      <ScreeningScheduleSurface
        artifact={{}}
        receipt={parseScreeningScheduleReceipt(SCREENING_SCHEDULE_RECEIPT)}
      />,
    );
    expect(html).toContain("Interview invites for REQ-2001");
    expect(html).toContain("Scheduled: C-3001");
    expect(html).toContain("Failed: C-3002");
    expect(html).toContain("Registry: screening:REQ-2001");
    expect(html).toContain("Completed 2026-09-08T09:30:00Z");
  });

  it("parses receipts strictly", () => {
    expect(parseScreeningScheduleReceipt({})).toBeNull();
    expect(parseScreeningScheduleReceipt(SCREENING_SCHEDULE_RECEIPT)?.replayed).toBe(1);
  });
});

function hrHelpIntakeArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    caseId: "case-1",
    ticketKey: "HR-42",
    question: "How much parental leave can a primary caregiver take?",
    topics: ["how", "much", "parental", "leave", "primary", "caregivers", "get"],
    summary: "Intake the question for case case-1 (ticket HR-42).",
    ...overrides,
  };
}

describe("hr help intake surface", () => {
  it("renders the case, the question and the retrieval topics", () => {
    const html = renderToString(<HrHelpIntakeSurface artifact={hrHelpIntakeArtifact()} />);
    expect(html).toContain("case-1");
    expect(html).toContain("HR-42");
    expect(html).toContain("How much parental leave can a primary caregiver take?");
    expect(html).toContain("Retrieval topics · 7");
    expect(html).toContain("parental");
    expect(html).toContain("Intake the question for case case-1 (ticket HR-42).");
  });

  it("falls back to the empty hint when the artifact is not readable", () => {
    const html = renderToString(<HrHelpIntakeSurface artifact={{}} />);
    expect(html).toContain("The help request is not readable yet.");
  });
});

function hrHelpRetrieveArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    caseId: "case-1",
    ticketKey: "HR-42",
    question: "How much parental leave can a primary caregiver take?",
    passages: [
      {
        sourceId: "hr_policy/leave-and-time-off.md",
        span: "118-207",
        title: "Parental leave",
        text: "Primary caregivers may take 20 weeks of parental leave.",
        score: 0.43,
        stale: false,
      },
      {
        sourceId: "hr_policy/remote-work-legacy.md",
        span: "1-60",
        title: "Legacy stipend reference",
        text: "The home-office stipend is superseded.",
        score: 0.12,
        stale: true,
      },
    ],
    staleCount: 1,
    matchedTerms: ["parental", "leave"],
    summary: "Retrieved 2 policy passage(s) for the question; 1 flagged stale.",
    ...overrides,
  };
}

describe("hr help retrieve surface", () => {
  it("renders the ranked passages with scores, sources and staleness flags", () => {
    const html = renderToString(<HrHelpRetrieveSurface artifact={hrHelpRetrieveArtifact()} />);
    expect(html).toContain("2 passage(s)");
    expect(html).toContain("1 stale");
    expect(html).toContain("Matched terms: parental, leave");
    expect(html).toContain("Parental leave");
    expect(html).toContain("score 0.43");
    expect(html).toContain("hr_policy/leave-and-time-off.md @ 118-207");
    expect(html).toContain("Primary caregivers may take 20 weeks of parental leave.");
    expect(html).toContain("stale");
    expect(html).toContain("Legacy stipend reference");
  });

  it("falls back to the empty hint when the artifact is not readable", () => {
    const html = renderToString(<HrHelpRetrieveSurface artifact={{}} />);
    expect(html).toContain("The retrieval results are not readable yet.");
  });
});

function hrHelpDraftArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    caseId: "case-1",
    ticketKey: "HR-42",
    question: "How much parental leave can a primary caregiver take?",
    answer:
      "Primary caregivers may take 20 weeks [hr_policy/leave-and-time-off.md:118-207]. Submit the request at least 8 weeks ahead.",
    citations: [
      { sourceId: "hr_policy/leave-and-time-off.md", span: "118-207" },
      { sourceId: "hr_policy/leave-and-time-off.md", span: "210-260" },
    ],
    flags: [
      {
        kind: "legal-advice",
        detail: "The closing line reads like legal advice; soften it.",
        sourceId: "answer",
        span: "142-190",
      },
      {
        kind: "pii-leakage",
        detail: "A colleague name appears in the example.",
        sourceId: null,
        span: null,
      },
    ],
    guardrail: {
      allowed: false,
      summary: "One legal-advice phrase needs a human decision before recording.",
      confidence: 0.9,
    },
    totalFlags: 2,
    summary: "Drafted the answer with 2 citation(s); 2 guardrail flag(s) recorded.",
    ...overrides,
  };
}

describe("hr help draft surface", () => {
  it("renders the answer, the citations and the guardrail flags", () => {
    const html = renderToString(<HrHelpDraftSurface artifact={hrHelpDraftArtifact()} />);
    expect(html).toContain("confidence 90%");
    expect(html).toContain("guardrail flagged");
    expect(html).toContain("2 guardrail flag(s)");
    expect(html).toContain("Primary caregivers may take 20 weeks");
    expect(html).toContain("Citations · 2");
    expect(html).toContain("hr_policy/leave-and-time-off.md @ 118-207");
    expect(html).toContain("Guardrail flags · 2");
    expect(html).toContain("legal-advice");
    expect(html).toContain("pii-leakage");
    expect(html).toContain("Source: answer @ 142-190");
  });

  it("shows the clear pill when the guardrail allows the draft", () => {
    const html = renderToString(
      <HrHelpDraftSurface
        artifact={hrHelpDraftArtifact({
          flags: [],
          guardrail: { allowed: true, summary: "No flags.", confidence: 0.92 },
          totalFlags: 0,
        })}
      />,
    );
    expect(html).toContain("guardrail clear");
    expect(html).toContain("0 guardrail flag(s)");
  });

  it("falls back to the empty hint when the artifact is not readable", () => {
    const html = renderToString(<HrHelpDraftSurface artifact={{}} />);
    expect(html).toContain("The drafted answer is not readable yet.");
  });
});

function hrHelpApproveArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    caseId: "case-1",
    ticketKey: "HR-42",
    approverRole: "people-partner",
    approverLabel: "People Partner on duty",
    slaHours: 24,
    state: "pending",
    requestedAt: "2026-09-12T09:00:00Z",
    decidedAt: null,
    note: null,
    summary:
      "People Partner on duty approval requested for the HR help answer · guardrail flags need sign-off.",
    ...overrides,
  };
}

describe("hr help approve surface", () => {
  it("renders the people-partner approval state and the SLA target", () => {
    const html = renderToString(<HrHelpApproveSurface artifact={hrHelpApproveArtifact()} />);
    expect(html).toContain("People Partner on duty");
    expect(html).toContain("people-partner");
    expect(html).toContain("target 24h");
    expect(html).toContain("pending");
    expect(html).toContain("—");
    expect(html).toContain(
      "People Partner on duty approval requested for the HR help answer · guardrail flags need sign-off.",
    );
  });

  it("renders the decided state once the approval is recorded", () => {
    const html = renderToString(
      <HrHelpApproveSurface
        artifact={hrHelpApproveArtifact({
          state: "approved",
          decidedAt: "2026-09-12T09:30:00Z",
          note: "Guardrail flag reviewed.",
        })}
      />,
    );
    expect(html).toContain("approved");
    expect(html).toContain("2026-09-12T09:30:00Z");
    expect(html).toContain("Note: Guardrail flag reviewed.");
  });

  it("falls back to the empty hint when the artifact is not readable", () => {
    const html = renderToString(<HrHelpApproveSurface artifact={{}} />);
    expect(html).toContain("The approval artifact is not readable yet.");
  });
});

function hrHelpSendArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    response: {
      answerId: "HA-7F3A1C2D",
      caseId: "case-1",
      ticketKey: "HR-42",
      citationCount: 2,
      status: "sent",
    },
    idempotencyKey: "send:case-1:HR-42",
    existing: null,
    summary:
      "Records answer HA-7F3A1C2D for case case-1 (ticket HR-42) with 2 citation(s); idempotent by case and ticket.",
    ...overrides,
  };
}

const HR_HELP_RECEIPT = {
  caseId: "case-1",
  ticketKey: "HR-42",
  answerId: "HA-7F3A1C2D",
  citations: [{ sourceId: "hr_policy/leave-and-time-off.md", span: "118-207" }],
  created: true,
  registryRef: "hr-help:case-1#HR-42",
  completedAt: "2026-09-12T09:05:00Z",
};

describe("hr help send surface", () => {
  it("renders the recorded-answer preview and the signed receipt", () => {
    const html = renderToString(
      <HrHelpSendSurface
        artifact={hrHelpSendArtifact()}
        receipt={parseHrHelpReceipt(HR_HELP_RECEIPT)}
      />,
    );
    expect(html).toContain("recorded");
    expect(html).toContain("HA-7F3A1C2D");
    expect(html).toContain("send:case-1:HR-42");
    expect(html).toContain("Answer HA-7F3A1C2D recorded for case case-1");
    expect(html).toContain("Citations: hr_policy/leave-and-time-off.md @ 118-207");
    expect(html).toContain("Registry: hr-help:case-1#HR-42");
    expect(html).toContain("Completed 2026-09-12T09:05:00Z");
  });

  it("shows the replay callout when the case already has an answer", () => {
    const html = renderToString(
      <HrHelpSendSurface
        artifact={hrHelpSendArtifact({
          existing: { answerId: "HA-OLD0001", createdAt: "2026-09-01T08:00:00Z" },
          summary: "Case case-1 already has answer HA-OLD0001; the send replays idempotently.",
        })}
        receipt={parseHrHelpReceipt({ ...HR_HELP_RECEIPT, created: false })}
      />,
    );
    expect(html).toContain("replayed");
    expect(html).toContain(
      "This case already has answer HA-OLD0001 (2026-09-01T08:00:00Z); the send replays idempotently.",
    );
    expect(html).toContain("Answer HA-7F3A1C2D already recorded; the send replayed");
  });

  it("shows the preview state while the side effect has not run", () => {
    const html = renderToString(
      <HrHelpSendSurface artifact={hrHelpSendArtifact()} receipt={null} />,
    );
    expect(html).toContain("preview");
    expect(html).not.toContain("Registry: hr-help:case-1#HR-42");
  });

  it("falls back to the receipt-only card when the artifact is not readable", () => {
    const html = renderToString(
      <HrHelpSendSurface artifact={{}} receipt={parseHrHelpReceipt(HR_HELP_RECEIPT)} />,
    );
    expect(html).toContain("Answer HA-7F3A1C2D for case case-1");
    expect(html).toContain("Ticket: HR-42");
    expect(html).toContain("Registry: hr-help:case-1#HR-42");
  });

  it("parses artifacts and receipts strictly", () => {
    expect(parseHrHelpSend({})).toBeNull();
    expect(parseHrHelpReceipt({})).toBeNull();
    expect(parseHrHelpSend(hrHelpSendArtifact())?.answerId).toBe("HA-7F3A1C2D");
    expect(parseHrHelpReceipt(HR_HELP_RECEIPT)?.created).toBe(true);
  });
});

function securityIngestArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alertId: "SEC-102",
    alertSource: "edr",
    title: "Suspicious encoded PowerShell on fin-db-01",
    host: "fin-db-01",
    user: "FIN\\svc-backup",
    indicators: ["203.0.113.77"],
    provenance: "edr:alert-9f21",
    checks: [
      { id: "caps", label: "Field caps", status: "pass", detail: "All fields within caps." },
      { id: "dedupe", label: "Dedupe", status: "pass", detail: "First occurrence." },
    ],
    dedupe: { seenBefore: false, priorCaseId: null },
    summary: "Normalized EDR alert for fin-db-01.",
    ...overrides,
  };
}

describe("security ingest surface", () => {
  it("renders the normalized alert with provenance, dedupe and checks", () => {
    const html = renderToString(<SecurityIngestSurface artifact={securityIngestArtifact()} />);
    expect(html).toContain("EDR");
    expect(html).toContain("Suspicious encoded PowerShell on fin-db-01");
    expect(html).toContain("SEC-102");
    expect(html).toContain("fin-db-01");
    expect(html).toContain("edr:alert-9f21");
    expect(html).toContain("First occurrence");
    expect(html).toContain("Validation checks · all 2 clear");
    expect(html).toContain("203.0.113.77");
    expect(html).toContain("Normalized EDR alert for fin-db-01.");
  });

  it("counts failing checks and links the duplicate case", () => {
    const html = renderToString(
      <SecurityIngestSurface
        artifact={securityIngestArtifact({
          checks: [
            {
              id: "caps",
              label: "Field caps",
              status: "fail",
              detail: "Raw alert exceeds 20 000 chars.",
            },
          ],
          dedupe: { seenBefore: true, priorCaseId: "case-7777" },
        })}
      />,
    );
    expect(html).toContain("Validation checks · 1 failing");
    expect(html).toContain("Seen before — prior case case-7777");
  });

  it("keeps the alert text as text, never markup", () => {
    const html = renderToString(
      <SecurityIngestSurface artifact={securityIngestArtifact({ summary: MALICIOUS_SUMMARY })} />,
    );
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("parses artifacts and labels strictly", () => {
    expect(parseSecurityIngest({})).toBeNull();
    expect(parseSecurityIngest(securityIngestArtifact())?.alertId).toBe("SEC-102");
    expect(securitySourceLabel("edr")).toBe("EDR");
    expect(securitySourceLabel("zeek")).toBe("ZEEK");
  });
});

function securityTriageArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    classification: "tp",
    severity: "high",
    confidence: 0.86,
    mitreTechniques: [
      { id: "T1059.001", name: "PowerShell", tactic: "Execution" },
      { id: "T1053.005", name: "Scheduled Task/Job", tactic: "Persistence" },
    ],
    injectionFlags: [],
    rationale: "Signals fired: encoded_command, c2_beacon.",
    needsInvestigation: true,
    ...overrides,
  };
}

describe("security triage surface", () => {
  it("renders the verdict, the ATT&CK map and the investigation flag", () => {
    const html = renderToString(<SecurityTriageSurface artifact={securityTriageArtifact()} />);
    expect(html).toContain("True positive");
    expect(html).toContain("high");
    expect(html).toContain("confidence 86%");
    expect(html).toContain("Investigation required");
    expect(html).toContain("map · 2");
    expect(html).toContain("T1059.001");
    expect(html).toContain("PowerShell");
  });

  it("flags prompt-injection signals and pins the verdict", () => {
    const html = renderToString(
      <SecurityTriageSurface
        artifact={securityTriageArtifact({
          classification: "unknown",
          injectionFlags: ["system_tag", "override_instruction"],
        })}
      />,
    );
    expect(html).toContain("Unknown");
    expect(html).toContain("Prompt-injection signals detected");
    expect(html).toContain("system_tag, override_instruction");
    expect(html).toContain("escalates to a human");
  });

  it("parses verdicts strictly", () => {
    expect(renderToString(<SecurityTriageSurface artifact={{}} />)).toContain(
      "The triage verdict is not available yet.",
    );
    expect(parseSecurityTriage({})).toBeNull();
    expect(SECURITY_CLASSIFICATION_LABELS["fp"]).toBe("False positive");
    expect(parseSecurityTriage(securityTriageArtifact())?.severity).toBe("high");
  });
});

function securityInvestigateArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    claims: [
      {
        claim: "The encoded payload registered a scheduled task named WinUpdate.",
        sourceTool: "memory",
        retrievedAt: "2026-09-12T09:02:00Z",
        snippetRef: { sourceId: "telemetry/fin-db-01", span: "40-88" },
      },
    ],
    timeline: [
      {
        at: "2026-09-12T08:55:00Z",
        event: "Scheduled task created",
        sourceId: "telemetry/fin-db-01",
        span: "12-20",
      },
    ],
    resolvedIndicators: [
      {
        indicator: "203.0.113.77",
        verdict: "malicious",
        detail: "C2 beacon in three intel feeds.",
        sourceTool: "memory",
        retrievedAt: "2026-09-12T09:03:00Z",
        snippetRef: { sourceId: "intel/feeds", span: "3-9" },
      },
    ],
    missingEvidence: ["Process-tree capture for the parent shell"],
    unsourcedCount: 0,
    summary: "Evidence pack for SEC-102.",
    ...overrides,
  };
}

describe("security investigate surface", () => {
  it("renders the timeline, cited claims and resolved indicators", () => {
    const html = renderToString(
      <SecurityInvestigateSurface artifact={securityInvestigateArtifact()} />,
    );
    expect(html).toContain("1 cited claims");
    expect(html).toContain("0 unsourced");
    expect(html).toContain("1 timeline events");
    expect(html).toContain("Scheduled task created");
    expect(html).toContain("telemetry/fin-db-01#12-20");
    expect(html).toContain("The encoded payload registered a scheduled task named WinUpdate.");
    expect(html).toContain("memory · retrieved 2026-09-12T09:02:00Z");
    expect(html).toContain("malicious");
    expect(html).toContain("intel/feeds#3-9");
    expect(html).toContain("Missing evidence");
    expect(html).toContain("Process-tree capture for the parent shell");
  });

  it("shows the return note when approval bounced the run back", () => {
    const html = renderToString(
      <SecurityInvestigateSurface
        artifact={securityInvestigateArtifact()}
        returnNote="The cited task name does not match the EDR event."
      />,
    );
    expect(html).toContain("Returned from approval");
    expect(html).toContain("The cited task name does not match the EDR event.");
  });

  it("parses evidence packs strictly", () => {
    expect(renderToString(<SecurityInvestigateSurface artifact={{ claims: [] }} />)).toContain(
      "The evidence pack is not available yet.",
    );
    expect(parseSecurityInvestigate({})).toBeNull();
    expect(securityCitationLabel({ sourceId: "intel/feeds", span: "3-9" })).toBe("intel/feeds#3-9");
    expect(parseSecurityInvestigate(securityInvestigateArtifact())?.claims).toHaveLength(1);
  });
});

function securityDecideArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "contain",
    confidence: 0.79,
    reasoningClaims: [0],
    risk: {
      score: 78,
      tier: "critical",
      factors: [
        { id: "blast", label: "Blast radius", points: 30, detail: "Production database host." },
        { id: "beacon", label: "Active C2 beacon", points: 24, detail: "Beacon observed twice." },
      ],
      blastRadius: "high",
      reversibility: "reversible",
      refused: false,
    },
    requiresHuman: true,
    detectionProposal: "Add rule: encoded PowerShell spawning schtasks.exe.",
    summary: "Contain SEC-102 at tier critical.",
    ...overrides,
  };
}

describe("security decide surface", () => {
  it("renders the risk meter, factors and the requires-human flag", () => {
    const html = renderToString(<SecurityDecideSurface artifact={securityDecideArtifact()} />);
    expect(html).toContain("tier critical");
    expect(html).toContain("Human decision required");
    expect(html).toContain("78 / 100");
    expect(html).toContain("Blast radius high · reversible");
    expect(html).toContain("Risk factors");
    expect(html).toContain("+30");
    expect(html).toContain("Active C2 beacon");
    expect(html).toContain("Detection-tuning proposal");
    expect(html).toContain("Contain SEC-102 at tier critical.");
  });

  it("links reasoning claims to the investigation pack", () => {
    const claims = [
      {
        claim: "Task created on fin-db-01.",
        sourceTool: "memory",
        retrievedAt: "2026-09-12T09:02:00Z",
        citation: { sourceId: "telemetry/fin-db-01", span: "40-88" },
      },
    ];
    const linked = renderToString(
      <SecurityDecideSurface artifact={securityDecideArtifact()} claims={claims} />,
    );
    expect(linked).toContain("Task created on fin-db-01.");
    expect(linked).toContain("Claim #0 · memory");
    expect(linked).toContain("telemetry/fin-db-01#40-88");

    const unlinked = renderToString(<SecurityDecideSurface artifact={securityDecideArtifact()} />);
    expect(unlinked).toContain("Claim #0 — see the investigation pack");
  });

  it("marks the lane risk refusal", () => {
    const html = renderToString(
      <SecurityDecideSurface
        artifact={securityDecideArtifact({
          risk: {
            score: 95,
            tier: "critical",
            factors: [],
            blastRadius: "high",
            reversibility: "irreversible",
            refused: true,
          },
        })}
      />,
    );
    expect(html).toContain("refused by the lane risk policy");
  });

  it("parses dispositions strictly", () => {
    expect(renderToString(<SecurityDecideSurface artifact={{}} />)).toContain(
      "The disposition proposal is not available yet.",
    );
    expect(parseSecurityDecide({})).toBeNull();
    expect(parseSecurityDecide(securityDecideArtifact())?.risk.tier).toBe("critical");
  });
});

function securityApproveArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alertId: "SEC-102",
    action: "contain",
    tier: "critical",
    requiredSigners: ["soc-analyst", "soc-lead"],
    signers: [
      {
        role: "soc-analyst",
        name: "Rivka Adler",
        state: "approved",
        approvedAt: "2026-09-12T09:04:00Z",
        comment: "Verified the beacon against the intel feeds.",
      },
      { role: "soc-lead", name: "Marcus Bell", state: "pending", approvedAt: null, comment: null },
    ],
    allApproved: false,
    returnedNote: null,
    summary: "Approval chain for SEC-102.",
    ...overrides,
  };
}

describe("security approve surface", () => {
  it("renders the signer chain with states and timestamps", () => {
    const html = renderToString(
      <SecurityApproveSurface
        artifact={securityApproveArtifact()}
        editable={false}
        draft={null}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("Rivka Adler");
    expect(html).toContain("soc-analyst");
    expect(html).toContain("Signed 2026-09-12T09:04:00Z");
    expect(html).toContain("No signature recorded yet");
    expect(html).toContain("Awaiting signers");
    expect(html).toContain("tier critical");
    expect(html).toContain("Verified the beacon against the intel feeds.");
  });

  it("renders the editable approve controls and the reject editor", () => {
    const html = renderToString(
      <SecurityApproveSurface
        artifact={securityApproveArtifact()}
        editable
        draft={null}
        onChange={() => undefined}
        returnFlow={{ onReturn: () => undefined, busy: false }}
      />,
    );
    expect(html).toContain("Approve");
    expect(html).toContain(
      "Every required signer must approve before containment can be previewed",
    );
    expect(html).toContain("Reject — return to Investigate");
  });

  it("reports the fully-signed chain and parses strictly", () => {
    const approved = securityApproveArtifact({
      signers: [
        {
          role: "soc-analyst",
          name: "Rivka Adler",
          state: "approved",
          approvedAt: "2026-09-12T09:04:00Z",
          comment: null,
        },
        {
          role: "soc-lead",
          name: "Marcus Bell",
          state: "approved",
          approvedAt: "2026-09-12T09:05:00Z",
          comment: null,
        },
      ],
      allApproved: true,
    });
    const html = renderToString(
      <SecurityApproveSurface
        artifact={approved}
        editable={false}
        draft={null}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("All approved");
    expect(parseSecurityApprove({})).toBeNull();
    expect(parseSecurityApprove(approved)?.signers).toHaveLength(2);
  });
});

function securityContainArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alertId: "SEC-102",
    action: "contain",
    outcome: "contained",
    containmentId: "SEC-2FCF0A5A",
    idempotencyKey: "SEC-2FCF0A5A",
    target: "containment:SEC-2FCF0A5A",
    summary: "Contain SEC-102 by quarantining fin-db-01.",
    ...overrides,
  };
}

const SECURITY_RECEIPT = {
  alertId: "SEC-102",
  action: "contain",
  outcome: "contained",
  containmentId: "SEC-2FCF0A5A",
  idempotencyKey: "SEC-2FCF0A5A",
  target: "containment:SEC-2FCF0A5A",
  registryRef: "containment-registry:SEC-2FCF0A5A",
  completedAt: "2026-09-12T09:06:00Z",
  evidenceRef: "run:run-1#investigate",
  summary: "Executed contain as contained (SEC-2FCF0A5A).",
};

describe("security contain surface", () => {
  it("renders the preview before the side effect runs", () => {
    const html = renderToString(
      <SecurityContainSurface
        artifact={securityContainArtifact()}
        receipt={null}
        replayed={false}
      />,
    );
    expect(html).toContain("contained");
    expect(html).toContain("Not executed");
    expect(html).toContain("SEC-2FCF0A5A");
    expect(html).toContain("Idempotent — replaying this decision returns the original receipt");
    expect(html).not.toContain("Registry reference");
  });

  it("renders the executed receipt with the replay badge", () => {
    const html = renderToString(
      <SecurityContainSurface
        artifact={securityContainArtifact()}
        receipt={parseSecurityReceipt(SECURITY_RECEIPT)}
        replayed
      />,
    );
    expect(html).toContain("Executed");
    expect(html).toContain("already replayed");
    expect(html).toContain("Containment SEC-2FCF0A5A recorded — outcome contained");
    expect(html).toContain("Registry: containment-registry:SEC-2FCF0A5A");
    expect(html).toContain("Evidence: run:run-1#investigate");
    expect(html).toContain("Completed 2026-09-12T09:06:00Z");
  });

  it("omits the replay badge on a first execution", () => {
    const html = renderToString(
      <SecurityContainSurface
        artifact={securityContainArtifact()}
        receipt={parseSecurityReceipt(SECURITY_RECEIPT)}
        replayed={false}
      />,
    );
    expect(html).toContain("Executed");
    expect(html).not.toContain("already replayed");
  });

  it("parses previews and receipts strictly", () => {
    expect(parseSecurityPreview({})).toBeNull();
    expect(parseSecurityReceipt({})).toBeNull();
    expect(parseSecurityPreview(securityContainArtifact())?.containmentId).toBe("SEC-2FCF0A5A");
    expect(parseSecurityReceipt(SECURITY_RECEIPT)?.registryRef).toBe(
      "containment-registry:SEC-2FCF0A5A",
    );
  });
});
