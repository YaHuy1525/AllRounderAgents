import { describe, expect, it } from "vitest";

import {
  annotatePassage,
  defaultKbDomain,
  emptyKbUploadDraft,
  formatMonthYear,
  kbDomainOptions,
  latestVersionMap,
  parseKbDocuments,
  parseKbDomains,
  parseKbSearch,
  staleAfterIso,
  suggestUploadMeta,
  validKbDomain,
  validateKbUploadDraft,
  type KbDocument,
  type KbDomain,
  type KbPassage,
} from "./kb.js";

function domain(overrides: Partial<KbDomain>): KbDomain {
  return {
    domain: "hr:policy",
    documents: 4,
    stale: 1,
    canonical: 3,
    updatedAt: "2026-10-01T09:00:00Z",
    ...overrides,
  };
}

function document(overrides: Partial<KbDocument>): KbDocument {
  return {
    sourceId: "hr_policy/leave-and-time-off.md",
    title: "Leave and Time Off",
    sourceVersion: "v1",
    sourceUri: "kb://hr_policy/leave-and-time-off.md",
    stale: false,
    staleAfter: "2027-07-01T00:00:00Z",
    canonical: true,
    chunks: 2,
    createdAt: "2026-10-01T09:00:00Z",
    ...overrides,
  };
}

function passage(overrides: Partial<KbPassage>): KbPassage {
  return {
    sourceId: "hr_policy/leave-and-time-off.md",
    span: "0-160",
    title: "Leave and Time Off",
    text: "Employees accrue 25 days of paid annual leave per calendar year.",
    score: 0.03,
    stale: false,
    sourceVersion: "v1",
    domain: "hr:policy",
    ...overrides,
  };
}

// ------------------------------------------------------------------ parsing

describe("parseKbDomains", () => {
  it("keeps valid rows and drops malformed ones", () => {
    const result = parseKbDomains({
      domains: [
        domain({}),
        domain({ domain: "support", documents: "four" as unknown as number }),
        { documents: 1 },
        null,
      ],
      configured: true,
    });
    expect(result.configured).toBe(true);
    expect(result.domains).toHaveLength(2);
    expect(result.domains[1]!.domain).toBe("support");
    expect(result.domains[1]!.documents).toBe(0);
  });

  it("treats a missing configured flag as configured", () => {
    expect(parseKbDomains({ domains: [] }).configured).toBe(true);
    expect(parseKbDomains({ domains: [], configured: false }).configured).toBe(false);
    expect(parseKbDomains(null).domains).toEqual([]);
  });
});

describe("parseKbDocuments", () => {
  it("keeps valid rows and defaults every flag", () => {
    const result = parseKbDocuments({
      documents: [document({}), { sourceId: "" }, "junk"],
    });
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.canonical).toBe(true);
    expect(result.documents[0]!.stale).toBe(false);
  });
});

describe("parseKbSearch", () => {
  it("keeps valid passages and carries the degraded flag", () => {
    const result = parseKbSearch({
      passages: [passage({}), { span: "1-2" }],
      degraded: true,
    });
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0]!.sourceId).toBe("hr_policy/leave-and-time-off.md");
    expect(result.degraded).toBe(true);
    expect(result.configured).toBe(true);
  });
});

// ------------------------------------------------------------------ domains

describe("domain vocabulary", () => {
  it("mirrors the API pattern", () => {
    for (const value of ["code", "finance", "marketing", "support", "msp:acme", "hr:policy"]) {
      expect(validKbDomain(value)).toBe(true);
    }
    for (const value of ["HR:policy", "random", "msp:", "", "hr:"]) {
      expect(validKbDomain(value)).toBe(false);
    }
  });

  it("lists existing partitions first, then suggestions", () => {
    const options = kbDomainOptions([domain({ domain: "hr:policy" })]);
    expect(options).toEqual(["hr:policy", "support"]);
    expect(kbDomainOptions([])).toEqual(["support", "hr:policy"]);
  });

  it("defaults to the first partition and falls back to the first suggestion", () => {
    expect(defaultKbDomain([domain({ domain: "msp:acme" })])).toBe("msp:acme");
    expect(defaultKbDomain([])).toBe("support");
  });
});

// --------------------------------------------------------------- annotations

describe("latestVersionMap", () => {
  it("keeps the most recently ingested version per source", () => {
    const latest = latestVersionMap([
      document({ sourceVersion: "v1", createdAt: "2026-09-01T00:00:00Z" }),
      document({ sourceVersion: "v2", createdAt: "2026-10-01T00:00:00Z" }),
    ]);
    expect(latest.get("hr_policy/leave-and-time-off.md")?.sourceVersion).toBe("v2");
  });

  it("breaks recency ties by version label and treats unreadable stamps as oldest", () => {
    const latest = latestVersionMap([
      document({ sourceVersion: "v1", createdAt: "2026-10-01T00:00:00Z" }),
      document({ sourceVersion: "v2", createdAt: "2026-10-01T00:00:00Z" }),
      document({ sourceVersion: "v3", createdAt: null }),
    ]);
    expect(latest.get("hr_policy/leave-and-time-off.md")?.sourceVersion).toBe("v2");
  });
});

describe("annotatePassage", () => {
  it("makes no claims without a corpus listing", () => {
    const note = annotatePassage(passage({ stale: true }), new Map(), []);
    expect(note).toEqual({
      latestVersion: null,
      supersededBy: null,
      missing: false,
      staleSince: null,
      canonical: null,
    });
  });

  it("flags a cite behind the latest version as superseded", () => {
    const docs = [
      document({ sourceVersion: "v1", createdAt: "2026-09-01T00:00:00Z" }),
      document({ sourceVersion: "v2", createdAt: "2026-10-01T00:00:00Z" }),
    ];
    const note = annotatePassage(passage({ sourceVersion: "v1" }), latestVersionMap(docs), docs);
    expect(note.supersededBy).toBe("v2");
    expect(note.missing).toBe(false);
  });

  it("flags a cite absent from a non-empty listing as missing", () => {
    const docs = [document({ sourceId: "hr_policy/other.md" })];
    const note = annotatePassage(passage({}), latestVersionMap(docs), docs);
    expect(note.missing).toBe(true);
    expect(note.supersededBy).toBeNull();
  });

  it("dates the stale window from the exact cited version", () => {
    const docs = [
      document({
        sourceVersion: "v1",
        stale: true,
        staleAfter: "2025-01-10T00:00:00Z",
        canonical: false,
      }),
    ];
    const note = annotatePassage(
      passage({ sourceVersion: "v1", stale: true }),
      latestVersionMap(docs),
      docs,
    );
    expect(note.staleSince).toBe("Jan 2025");
    expect(note.canonical).toBe(false);
  });

  it("leaves staleSince empty when the review date is unknown", () => {
    const docs = [document({ staleAfter: null })];
    const note = annotatePassage(
      passage({ stale: true }),
      latestVersionMap(docs),
      docs,
    );
    expect(note.staleSince).toBeNull();
  });
});

describe("formatMonthYear", () => {
  it("renders UTC month and year", () => {
    expect(formatMonthYear("2025-01-10T00:00:00Z")).toBe("Jan 2025");
    expect(formatMonthYear("2026-06-15T00:00:00Z")).toBe("Jun 2026");
    expect(formatMonthYear("not a date")).toBe("");
  });
});

// ------------------------------------------------------------------ upload

describe("suggestUploadMeta", () => {
  it("prefills title, review horizon, and the hr:policy cite prefix", () => {
    const content = "# Leave and Time Off\n\nReviewed: 2026-07-01\n\nBody text.\n";
    const suggested = suggestUploadMeta(content, "leave-and-time-off.md", "hr:policy");
    expect(suggested.sourceId).toBe("hr_policy/leave-and-time-off.md");
    expect(suggested.title).toBe("Leave and Time Off");
    expect(suggested.sourceVersion).toBe("v1");
    expect(suggested.staleAfter).toBe("2027-07-01");
  });

  it("keeps other domains unprefixed and tolerates missing headers", () => {
    const suggested = suggestUploadMeta("Plain body.", "runbook vpn.md", "support");
    expect(suggested.sourceId).toBe("runbook-vpn.md");
    expect(suggested.title).toBeNull();
    expect(suggested.staleAfter).toBe("");
  });

  it("computes the horizon across a leap year the way the fixtures do", () => {
    const suggested = suggestUploadMeta("Reviewed: 2024-01-10", "legacy.md", "hr:policy");
    expect(suggested.staleAfter).toBe("2025-01-09");
  });
});

describe("validateKbUploadDraft", () => {
  function validDraft() {
    return {
      ...emptyKbUploadDraft("hr:policy"),
      sourceId: "hr_policy/leave-and-time-off.md",
      title: "Leave and Time Off",
      content: "Employees accrue 25 days.",
      staleAfter: "2027-07-01",
    };
  }

  it("accepts a complete draft", () => {
    expect(validateKbUploadDraft(validDraft())).toEqual([]);
  });

  it("rejects each malformed field with its own message", () => {
    expect(
      validateKbUploadDraft({ ...validDraft(), domain: "HR:policy" })[0],
    ).toContain("supported domain");
    expect(
      validateKbUploadDraft({ ...validDraft(), sourceId: "-leading" })[0],
    ).toContain("Source id");
    expect(validateKbUploadDraft({ ...validDraft(), title: "  " })[0]).toContain(
      "Title is required",
    );
    expect(
      validateKbUploadDraft({ ...validDraft(), sourceVersion: " " })[0],
    ).toContain("Version");
    expect(
      validateKbUploadDraft({ ...validDraft(), staleAfter: "13/13/13" })[0],
    ).toContain("Stale after");
    expect(validateKbUploadDraft({ ...validDraft(), content: "" })[0]).toContain(
      "content is required",
    );
  });

  it("caps content at the upload limit", () => {
    const errors = validateKbUploadDraft({
      ...validDraft(),
      content: "x".repeat(200_001),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("upload limit");
  });

  it("starts a fresh draft with team-canonical on", () => {
    const draft = emptyKbUploadDraft("support");
    expect(draft.canonical).toBe(true);
    expect(draft.sourceVersion).toBe("v1");
    expect(draft.domain).toBe("support");
  });
});

describe("staleAfterIso", () => {
  it("maps the date input to an ISO instant or null", () => {
    expect(staleAfterIso("2027-07-01")).toBe("2027-07-01T00:00:00.000Z");
    expect(staleAfterIso("")).toBeNull();
    expect(staleAfterIso("13/13/13")).toBeNull();
  });
});
