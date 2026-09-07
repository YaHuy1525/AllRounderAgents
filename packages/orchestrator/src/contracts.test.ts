import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EvidencePackSchema,
  RiskScoreSchema,
  TicketSchema,
  TriageVerdictSchema,
} from "./contracts.js";

const parity = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../fixtures/contract_parity.json"), "utf8"),
) as Array<{ schema: string; valid: boolean; value: unknown }>;

const schemas = {
  Ticket: TicketSchema,
  TriageVerdict: TriageVerdictSchema,
  RiskScore: RiskScoreSchema,
  EvidencePack: EvidencePackSchema,
};

describe("Zod/Pydantic contract parity fixture", () => {
  for (const testCase of parity) {
    it(`${testCase.valid ? "accepts" : "rejects"} ${testCase.schema}`, () => {
      expect(schemas[testCase.schema as keyof typeof schemas].safeParse(testCase.value).success).toBe(
        testCase.valid,
      );
    });
  }

  it("uses strict objects so uncontracted fields fail", () => {
    const verdict = {
      domain: "support",
      confidence: 0.9,
      urgency: 2,
      needsHuman: false,
      rationale: "clear",
      secret: "must not pass",
    };
    expect(TriageVerdictSchema.safeParse(verdict).success).toBe(false);
  });
});

