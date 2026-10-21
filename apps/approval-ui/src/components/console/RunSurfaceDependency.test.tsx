import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CI_STATUS_LABELS,
  CI_STATUS_NOT_RECORDED,
  DependencyGroupSurface,
  DependencyMergeSurface,
  ciStatusLine,
  movePackageBetween,
  parseCiStatus,
  readDependencyDragSource,
  type DependencyCiStatus,
  type DependencyGroupView,
  type GroupPackageView,
} from "@/components/console/RunSurface";

/* ---------------------------------------------------------------------------
 * T6 coverage: the pure move rule behind drag/keyboard/click, the drag
 * payload validation, and the CI-status row (labels + honest degradation).
 * RunSurface.test.tsx renders with renderToString only, so interaction
 * logic is tested as pure functions; the rows themselves get string
 * assertions on the rendered markup.
 * ------------------------------------------------------------------------- */

function pkg(name: string, jump: GroupPackageView["jump"]): GroupPackageView {
  return {
    name,
    kind: "dependency",
    from: "1.0.0",
    to: "1.1.0",
    jump,
    daysOutdated: 10,
    changelogExcerpt: "",
    vulnerabilities: [],
    excluded: false,
    excludeReason: "",
  };
}

function group(
  id: DependencyGroupView["id"],
  packages: GroupPackageView[],
): DependencyGroupView {
  return { id, label: `${id} updates`, riskNote: "", packages };
}

describe("movePackageBetween", () => {
  it("moves a package across groups, appending it to the target", () => {
    const groups = [
      group("patch", [pkg("left-pad", "patch")]),
      group("minor", [pkg("express", "minor")]),
      group("major", [pkg("react-router", "major")]),
    ];
    const result = movePackageBetween(groups, "minor", "express", "patch");
    const patch = result.find((item) => item.id === "patch");
    const minor = result.find((item) => item.id === "minor");
    expect(patch?.packages.map((item) => item.name)).toEqual(["left-pad", "express"]);
    expect(minor?.packages).toEqual([]);
  });

  it("returns the same array reference for a same-group move (no-op)", () => {
    const groups = [group("minor", [pkg("express", "minor")])];
    expect(movePackageBetween(groups, "minor", "express", "minor")).toBe(groups);
  });

  it("returns the same array reference for an unknown package (no-op)", () => {
    const groups = [group("minor", [pkg("express", "minor")]), group("major", [])];
    expect(movePackageBetween(groups, "minor", "ghost", "major")).toBe(groups);
    expect(movePackageBetween(groups, "patch", "express", "major")).toBe(groups);
  });

  it("preserves order and untouched group identity for the rest of the groups", () => {
    const major = group("major", [pkg("react-router", "major"), pkg("webpack", "major")]);
    const patch = group("patch", [pkg("left-pad", "patch")]);
    const minor = group("minor", [pkg("express", "minor"), pkg("zod", "minor")]);
    const groups = [patch, minor, major];
    const result = movePackageBetween(groups, "minor", "express", "major");
    expect(result.map((item) => item.id)).toEqual(["patch", "minor", "major"]);
    expect(result[0]).toBe(patch);
    expect(result[1]?.packages.map((item) => item.name)).toEqual(["zod"]);
    expect(result[2]?.packages.map((item) => item.name)).toEqual([
      "react-router",
      "webpack",
      "express",
    ]);
    // The moved row is carried unchanged (exclusion state included).
    expect(result[2]?.packages[2]).toBe(minor.packages[0]);
  });
});

describe("readDependencyDragSource", () => {
  const groups = [group("minor", [pkg("express", "minor")])];

  it("accepts a payload whose package really lives in the claimed group", () => {
    expect(readDependencyDragSource("express", "minor", groups)).toEqual({
      name: "express",
      from: "minor",
    });
  });

  it("rejects unknown groups, foreign packages, and empty payloads", () => {
    expect(readDependencyDragSource("express", "major", groups)).toBeNull();
    expect(readDependencyDragSource("ghost", "minor", groups)).toBeNull();
    expect(readDependencyDragSource("", "minor", groups)).toBeNull();
    expect(readDependencyDragSource("express", "", groups)).toBeNull();
    expect(readDependencyDragSource("express", "javascript", groups)).toBeNull();
    expect(readDependencyDragSource(null, null, groups)).toBeNull();
  });
});

describe("CI status mapping", () => {
  it("labels each of the four states", () => {
    const states: DependencyCiStatus[] = ["pending", "success", "failure", "neutral"];
    for (const state of states) {
      expect(parseCiStatus(state)).toBe(state);
      expect(ciStatusLine(state)).toBe(`CI status: ${CI_STATUS_LABELS[state]}`);
    }
    expect(CI_STATUS_LABELS.pending).toBe("Pending");
    expect(CI_STATUS_LABELS.success).toBe("Success");
    expect(CI_STATUS_LABELS.failure).toBe("Failure");
    expect(CI_STATUS_LABELS.neutral).toBe("Neutral");
  });

  it("degrades unknown and missing states to the not-recorded line", () => {
    expect(parseCiStatus("skipped")).toBeNull();
    expect(parseCiStatus(undefined)).toBeNull();
    expect(parseCiStatus(42)).toBeNull();
    expect(ciStatusLine(null)).toBe(CI_STATUS_NOT_RECORDED);
  });
});

describe("CI status row rendering", () => {
  const mergeArtifact = (extra: Record<string, unknown>): Record<string, unknown> => ({
    repository: "acme/app",
    baseBranch: "main",
    sourceSha: "b".repeat(40),
    manifestPath: "package.json",
    groups: [],
    ...extra,
  });

  it("renders the labelled row with its state class when the artifact carries ciStatus", () => {
    const html = renderToString(
      <DependencyMergeSurface
        artifact={mergeArtifact({ ciStatus: "success" })}
        receipt={null}
      />,
    );
    expect(html).toContain("CI status: Success");
    expect(html).toContain("ci-status-success");
    expect(html).not.toContain(CI_STATUS_NOT_RECORDED);
  });

  it("renders the explicit not-recorded line when the artifact has no ciStatus", () => {
    const html = renderToString(
      <DependencyMergeSurface artifact={mergeArtifact({})} receipt={null} />,
    );
    expect(html).toContain(CI_STATUS_NOT_RECORDED);
    expect(html).toContain("ci-status-none");
  });

  it("renders the not-recorded line for a null artifact too", () => {
    const html = renderToString(<DependencyMergeSurface artifact={null} receipt={null} />);
    expect(html).toContain(CI_STATUS_NOT_RECORDED);
  });

  it("never invents a status from an unknown value", () => {
    const html = renderToString(
      <DependencyMergeSurface
        artifact={mergeArtifact({ ciStatus: "green" })}
        receipt={null}
      />,
    );
    expect(html).toContain(CI_STATUS_NOT_RECORDED);
    expect(html).not.toContain("CI status: green");
  });
});

describe("dependency group surface interaction affordances", () => {
  const artifact: Record<string, unknown> = {
    repository: "acme/app",
    baseBranch: "main",
    sourceSha: "b".repeat(40),
    manifestPath: "package.json",
    groups: [
      {
        id: "patch",
        label: "Patch updates",
        riskNote: "",
        packages: [],
      },
      {
        id: "minor",
        label: "Minor updates",
        riskNote: "",
        packages: [
          {
            name: "express",
            kind: "dependency",
            from: "^4.18.2",
            to: "4.19.2",
            jump: "minor",
            daysOutdated: 30,
            changelogExcerpt: "",
            vulnerabilities: [],
            excluded: true,
            excludeReason: "Waiting.",
          },
        ],
      },
      {
        id: "major",
        label: "Major updates",
        riskNote: "",
        packages: [
          {
            name: "react-router",
            kind: "dependency",
            from: "^5.3.4",
            to: "6.26.0",
            jump: "major",
            daysOutdated: 400,
            changelogExcerpt: "",
            vulnerabilities: [],
            excluded: false,
            excludeReason: "",
          },
        ],
      },
    ],
  };

  it("exposes drag, keyboard, and live-region affordances when editable", () => {
    const html = renderToString(
      <DependencyGroupSurface
        artifact={artifact}
        editable
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('draggable="true"');
    expect(html).toContain('aria-label="Move express from minor to another group"');
    expect(html).toContain('aria-label="Move react-router from major to another group"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    // The frozen exclusion class must survive the new row attributes.
    expect(html).toContain('class="excluded"');
  });

  it("is not draggable when the step is not editable", () => {
    const html = renderToString(
      <DependencyGroupSurface
        artifact={artifact}
        editable={false}
        draft={null}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain('draggable="true"');
  });
});
