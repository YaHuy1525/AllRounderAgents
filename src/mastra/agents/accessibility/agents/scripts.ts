import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the accessibility auditor. Expected outputs are
 * on-contract (`AuditModelOutputSchema`): the audit summary and the
 * confidence the violations checkpoint shows beside the grouped findings.
 */
export const accessibilityAuditorScenarios: AgentScenario[] = [
  {
    name: "checkout contrast sweep",
    input: {
      repository: "acme/app-web",
      targetUrl: "https://preview.acme.test",
      analyzer: "axe-core 4.10.2",
      ruleset: "wcag22aa",
      routes: ["/checkout", "/checkout/payment"],
      violations: [
        {
          id: "violation-1",
          rule: "color-contrast",
          impact: "critical",
          wcagRef: "WCAG 2.2 · 1.4.3",
          elementPath: ".cta-primary",
          routePath: "/checkout",
          occurrences: 3,
          description: "Elements must meet minimum color contrast ratio thresholds.",
        },
      ],
    },
    expectedOutput: {
      summary:
        "The checkout flow carries three contrast failures on the primary call to action; the payment step is otherwise clean.",
      confidence: 0.82,
    },
  },
  {
    name: "marketing landing sweep",
    input: {
      repository: "acme/site",
      targetUrl: "https://staging.acme.test",
      analyzer: "axe-core 4.10.2",
      ruleset: "wcag22aa",
      routes: ["/", "/pricing"],
      violations: [
        {
          id: "violation-1",
          rule: "image-alt",
          impact: "serious",
          wcagRef: "WCAG 2.2 · 1.1.1",
          elementPath: "img.hero-illustration",
          routePath: "/",
          occurrences: 2,
          description: "Images must have alternate text.",
        },
        {
          id: "violation-2",
          rule: "region",
          impact: "minor",
          wcagRef: "WCAG 2.2 · 1.3.6",
          elementPath: "body > footer",
          routePath: "/pricing",
          occurrences: 1,
          description: "All page content should be contained by landmarks.",
        },
      ],
    },
    expectedOutput: {
      summary:
        "Two missing alt texts on the landing hero dominate this sweep; the pricing page only misses a footer landmark.",
      confidence: 0.76,
    },
  },
];

/**
 * Few-shot scenarios for the accessibility fixer. Expected outputs are
 * on-contract (`FixModelOutputSchema`): one whole-file patch per fixable
 * violation, or a manual-redesign flag with no files when the fix needs a
 * design decision.
 */
export const accessibilityFixerScenarios: AgentScenario[] = [
  {
    name: "contrast fix on the checkout button",
    input: {
      repository: "acme/app-web",
      targetUrl: "https://preview.acme.test",
      violations: [
        {
          id: "violation-1",
          rule: "color-contrast",
          wcagRef: "WCAG 2.2 · 1.4.3",
          impact: "critical",
          elementPath: ".cta-primary",
          routePath: "/checkout",
          occurrences: 3,
          description: "Elements must meet minimum color contrast ratio thresholds.",
        },
      ],
      files: [
        {
          path: "src/app/checkout/CheckoutButton.tsx",
          content: "export function CheckoutButton() {\n  return <button className=\"cta-primary\">Pay now</button>;\n}",
        },
      ],
    },
    expectedOutput: {
      summary: "Darkens the primary CTA to pass 4.5:1 without changing the layout.",
      confidence: 0.84,
      fixes: [
        {
          violationId: "violation-1",
          explanation:
            "The amber CTA only reaches 3.1:1 against white; a darker shade passes while keeping the same size and spacing.",
          manualRedesign: false,
          before: "<button className=\"cta-primary\">",
          after: "<button className=\"cta-primary cta-primary-dark\">",
          files: [
            {
              path: "src/app/checkout/CheckoutButton.tsx",
              content:
                "export function CheckoutButton() {\n  return <button className=\"cta-primary cta-primary-dark\">Pay now</button>;\n}",
              validators: ["basic-syntax"],
            },
          ],
        },
      ],
    },
  },
  {
    name: "modal focus trap needs redesign",
    input: {
      repository: "acme/app-web",
      targetUrl: "https://preview.acme.test",
      violations: [
        {
          id: "violation-2",
          rule: "focus-trap",
          wcagRef: "WCAG 2.2 · 2.1.2",
          impact: "serious",
          elementPath: "div.modal-overlay",
          routePath: "/checkout/payment",
          occurrences: 1,
          description: "Focus must not be trapped in a component without an escape path.",
        },
      ],
      files: [
        {
          path: "src/app/checkout/PaymentModal.tsx",
          content: "export function PaymentModal({ children }: { children: React.ReactNode }) {\n  return <div className=\"modal-overlay\">{children}</div>;\n}",
        },
      ],
    },
    expectedOutput: {
      summary: "No safe in-code fix for the modal focus trap; it is flagged for manual redesign.",
      confidence: 0.68,
      fixes: [
        {
          violationId: "violation-2",
          explanation:
            "The overlay has no keyboard escape or focus return; the dialog pattern needs a design decision before code changes.",
          manualRedesign: true,
          before: "",
          after: "",
          files: [],
        },
      ],
    },
  },
];
