import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObservabilityInMemory } from "@mastra/core/storage";
import { Observability } from "@mastra/observability";

import { createAllRounderMastra } from "../../src/mastra/mastra.js";

// The Observability registry config is validated with a zod schema at
// construction time, so building the instance with the flag on is the real
// proof the wiring is correct. Off by default, so ordinary runs and the rest
// of the suites never boot the exporter.
//
// The storage assertions mirror what @mastra/server's system handler checks
// before Studio renders the metrics panel: `storage.stores.observability`
// must expose `getFeatures()` containing "metrics". The Postgres vNext
// domain does, the classic one did not, and the in-memory fallback does.
type FeaturesBearer = { getFeatures?: () => readonly string[] };

function featuresOf(domain: unknown): readonly string[] {
  return (domain as FeaturesBearer | undefined)?.getFeatures?.() ?? [];
}

describe("native Mastra observability wiring", () => {
  const original = process.env.MASTRA_OBSERVABILITY;

  beforeAll(() => {
    process.env.MASTRA_OBSERVABILITY = "true";
  });

  afterAll(() => {
    if (original === undefined) delete process.env.MASTRA_OBSERVABILITY;
    else process.env.MASTRA_OBSERVABILITY = original;
  });

  it("registers an Observability entrypoint when the flag is on", () => {
    const mastra = createAllRounderMastra();
    expect(mastra.observability).toBeInstanceOf(Observability);
  });

  it("stays off when the flag is unset", () => {
    delete process.env.MASTRA_OBSERVABILITY;
    const mastra = createAllRounderMastra();
    expect(mastra.observability).not.toBeInstanceOf(Observability);
  });

  it("serves metrics from the vNext Postgres observability domain when DATABASE_URL is set", async () => {
    // Constructor-level domain composition needs no live database, and the
    // documented MASTRA_DISABLE_STORAGE_INIT flag keeps the wrapper from
    // initializing domains against the fake URL.
    const originalDb = process.env.DATABASE_URL;
    const originalNoInit = process.env.MASTRA_DISABLE_STORAGE_INIT;
    process.env.MASTRA_OBSERVABILITY = "true";
    process.env.MASTRA_DISABLE_STORAGE_INIT = "true";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:1/allrounder";
    try {
      const mastra = createAllRounderMastra();
      const domain = await mastra.getStorage()?.getStore("observability");
      expect(featuresOf(domain)).toContain("metrics");
      expect(domain).not.toBeInstanceOf(ObservabilityInMemory);
    } finally {
      if (originalDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDb;
      if (originalNoInit === undefined) delete process.env.MASTRA_DISABLE_STORAGE_INIT;
      else process.env.MASTRA_DISABLE_STORAGE_INIT = originalNoInit;
    }
  });

  it("keeps the credential-free fallback on a metrics-capable in-memory domain", async () => {
    const originalDb = process.env.DATABASE_URL;
    process.env.MASTRA_OBSERVABILITY = "true";
    delete process.env.DATABASE_URL;
    try {
      const mastra = createAllRounderMastra();
      const domain = await mastra.getStorage()?.getStore("observability");
      expect(domain).toBeInstanceOf(ObservabilityInMemory);
      expect(featuresOf(domain)).toContain("metrics");
    } finally {
      if (originalDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDb;
    }
  });

  it("stays metrics-capable on the fallback even when the tracing flag is off", async () => {
    // The store shape no longer depends on the flag. Studio reads feature
    // capabilities from storage itself, and the exporter stays opt-in, so a
    // capacity regression here would silently re-break the metrics panel.
    const originalDb = process.env.DATABASE_URL;
    delete process.env.MASTRA_OBSERVABILITY;
    delete process.env.DATABASE_URL;
    try {
      const mastra = createAllRounderMastra();
      const domain = await mastra.getStorage()?.getStore("observability");
      expect(featuresOf(domain)).toContain("metrics");
    } finally {
      if (originalDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDb;
    }
  });
});
