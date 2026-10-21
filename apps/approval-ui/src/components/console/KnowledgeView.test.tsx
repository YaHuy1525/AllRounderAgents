import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  KbAnswerList,
  KbCorpusList,
  KbSourceChip,
  KbUploadSection,
  type KbAnswerListProps,
  type KbCorpusListProps,
  type KbUploadSectionProps,
} from "@/components/console/KnowledgeView";
import {
  KB_UPLOAD_HINT,
  annotatePassage,
  emptyKbUploadDraft,
  latestVersionMap,
  type KbDocument,
  type KbPassage,
} from "@/lib/kb";

function document(overrides: Partial<KbDocument> = {}): KbDocument {
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

function passage(overrides: Partial<KbPassage> = {}): KbPassage {
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

function noteFor(value: KbPassage, documents: KbDocument[]) {
  return annotatePassage(value, latestVersionMap(documents), documents);
}

// ---------------------------------------------------------------- source chip

describe("knowledge source chips", () => {
  it("renders the citation, version, and score like a run receipt", () => {
    const value = passage({});
    const html = renderToString(
      <KbSourceChip passage={value} note={noteFor(value, [document({})])} />,
    );
    expect(html).toContain("hr_policy/leave-and-time-off.md:0-160");
    expect(html).toContain("v1");
    expect(html).toContain("0.030");
    expect(html).not.toContain("kb-chip-invalid");
  });

  it("dates a stale cite from its exact version's review horizon", () => {
    const docs = [
      document({
        stale: true,
        staleAfter: "2025-01-10T00:00:00Z",
        canonical: false,
      }),
    ];
    const value = passage({ stale: true });
    const html = renderToString(<KbSourceChip passage={value} note={noteFor(value, docs)} />);
    expect(html).toContain("stale · since Jan 2025");
    expect(html).toContain("not team-canonical");
  });

  it("highlights a cite behind the latest version as superseded", () => {
    const docs = [
      document({ sourceVersion: "v1", createdAt: "2026-09-01T00:00:00Z" }),
      document({ sourceVersion: "v2", createdAt: "2026-10-01T00:00:00Z" }),
    ];
    const value = passage({ sourceVersion: "v1" });
    const html = renderToString(<KbSourceChip passage={value} note={noteFor(value, docs)} />);
    expect(html).toContain("superseded by v2");
    expect(html).toContain("kb-chip-invalid");
  });

  it("highlights a cite absent from the current corpus", () => {
    const docs = [document({ sourceId: "hr_policy/other.md" })];
    const value = passage({});
    const html = renderToString(<KbSourceChip passage={value} note={noteFor(value, docs)} />);
    expect(html).toContain("not in the current corpus");
    expect(html).toContain("kb-chip-invalid");
  });

  it("makes no reference claims without a corpus listing", () => {
    const value = passage({ stale: true });
    const html = renderToString(<KbSourceChip passage={value} note={noteFor(value, [])} />);
    expect(html).toContain("stale");
    expect(html).not.toContain("superseded");
    expect(html).not.toContain("not in the current corpus");
  });
});

// ----------------------------------------------------------------- answers

function renderAnswers(overrides: Partial<KbAnswerListProps> = {}): string {
  const props: KbAnswerListProps = {
    asked: "leave days",
    passages: [passage({})],
    documents: [document({})],
    busy: false,
    error: null,
    degraded: false,
    ...overrides,
  };
  return renderToString(<KbAnswerList {...props} />);
}

describe("knowledge answers", () => {
  it("announces a search in flight", () => {
    const html = renderAnswers({ passages: null, busy: true });
    expect(html).toContain("Searching the corpus…");
    expect(html).toContain('role="status"');
  });

  it("surfaces a search failure as an alert", () => {
    const html = renderAnswers({ passages: null, error: "The search was rejected (500)." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("rejected (500)");
  });

  it("invites the first question before anything is asked", () => {
    const html = renderAnswers({ passages: null, asked: null });
    expect(html).toContain("Ask a question to see the passages");
  });

  it("counts the passages and renders one article per cite", () => {
    const html = renderAnswers({
      passages: [passage({}), passage({ span: "160-320" })],
    });
    expect(html).toContain("2 passages for");
    expect((html.match(/kb-answer-head/g) ?? []).length).toBe(2);
    expect(html).toContain("Employees accrue 25 days");
  });

  it("explains a no-match result and points at the toggle", () => {
    const html = renderAnswers({ passages: [] });
    expect(html).toContain("No passages matched");
    expect(html).toContain("team-canonical toggle");
  });

  it("banners a degraded index above cited passages", () => {
    const html = renderAnswers({ degraded: true });
    expect(html).toContain("answered degraded");
    expect(html).toContain("Employees accrue 25 days");
  });
});

// ------------------------------------------------------------------ corpus

function renderCorpus(overrides: Partial<KbCorpusListProps> = {}): string {
  const props: KbCorpusListProps = {
    domain: "hr:policy",
    documents: [document({})],
    failed: null,
    ...overrides,
  };
  return renderToString(<KbCorpusList {...props} />);
}

describe("knowledge corpus", () => {
  it("lists a version row with chunks, canonical state, and review horizon", () => {
    const html = renderCorpus();
    expect(html).toContain("Corpus · hr:policy");
    expect(html).toContain("1 version");
    expect(html).toContain("Leave and Time Off");
    expect(html).toContain("hr_policy/leave-and-time-off.md");
    expect(html).toContain("2 chunks");
    expect(html).toContain("team-canonical");
    expect(html).toContain("review by Jul 2027");
  });

  it("marks a superseded stale version as draft", () => {
    const html = renderCorpus({
      documents: [
        document({
          sourceVersion: "v1",
          stale: true,
          staleAfter: "2025-01-10T00:00:00Z",
          canonical: false,
          createdAt: "2026-09-01T00:00:00Z",
        }),
        document({ sourceVersion: "v2", createdAt: "2026-10-01T00:00:00Z" }),
      ],
    });
    expect(html).toContain("2 versions");
    expect(html).toContain("superseded by v2");
    expect(html).toContain("draft");
    expect(html).toContain("stale · since Jan 2025");
  });

  it("invites a first upload into an empty domain", () => {
    const html = renderCorpus({ documents: [] });
    expect(html).toContain("Nothing is ingested in hr:policy yet");
  });

  it("shows a skeleton while the listing loads and an error when it fails", () => {
    expect(renderCorpus({ documents: null })).toContain("Loading the corpus");
    const failed = renderCorpus({ documents: null, failed: "The corpus listing could not be loaded (503)." });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("could not be loaded (503)");
  });
});

// ------------------------------------------------------------------ upload

function uploadDraft() {
  return {
    ...emptyKbUploadDraft("hr:policy"),
    sourceId: "hr_policy/leave-and-time-off.md",
    title: "Leave and Time Off",
    content: "Employees accrue 25 days.",
    staleAfter: "2027-07-01",
  };
}

function renderUpload(overrides: Partial<KbUploadSectionProps> = {}): string {
  const props: KbUploadSectionProps = {
    draft: uploadDraft(),
    options: ["hr:policy", "support"],
    canUpload: true,
    busy: false,
    note: null,
    error: null,
    onField: () => {},
    onFile: () => {},
    onSubmit: () => {},
    ...overrides,
  };
  return renderToString(<KbUploadSection {...props} />);
}

describe("knowledge upload", () => {
  it("replaces the form with the admin hint for non-admins", () => {
    const html = renderUpload({ canUpload: false });
    expect(html).toContain(KB_UPLOAD_HINT);
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain("Ingest document");
  });

  it("renders the ingest form prefilled from the draft", () => {
    const html = renderUpload();
    expect(html).toContain('type="file"');
    expect(html).toContain("hr_policy/leave-and-time-off.md");
    expect(html).toContain("Leave and Time Off");
    expect(html).toContain('type="date"');
    expect(html).toContain("Team-canonical");
    expect(html).toContain("Ingest document");
  });

  it("locks the form while an ingest is in flight", () => {
    const html = renderUpload({ busy: true });
    expect(html).toContain("Ingesting…");
    expect(html).toContain("disabled");
    expect(html).not.toContain("<span>Ingest document</span>");
  });

  it("confirms an ingest and surfaces a failure", () => {
    const done = renderUpload({ note: "Ingested hr_policy/leave-and-time-off.md v1 — 2 chunks in hr:policy." });
    expect(done).toContain('role="status"');
    expect(done).toContain("2 chunks in hr:policy");

    const failed = renderUpload({ error: "The upload was rejected (422)." });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("rejected (422)");
  });
});
