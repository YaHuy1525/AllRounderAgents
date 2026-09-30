import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the bill extractor. Expected outputs are on-contract
 * (`BillModelOutputSchema`): the vendor's remittance details next to the
 * bill's number, dates, amounts in integer cents and line items. Whatever the
 * email does not state stays null — the lane escalates unreadable bills
 * instead of guessing.
 */
export const billExtractorScenarios: AgentScenario[] = [
  {
    name: "power bill with remittance details",
    input: {
      caseId: "bill-acme-power-482913",
      ticketKey: "BILL-482913",
      vendorRef: "acme-power",
      from: "billing@acme-power.example",
      subject: "Tax invoice INV-2041",
      text:
        "Hi, your electricity invoice INV-2041 for August 2026 is attached below. "
        + "Total due: $1,320.00 AUD (includes $120.00 GST). Issue date 1 September 2026, "
        + "due 15 September 2026. Pay to Acme Power Pty Ltd, BSB 012-345, account 12345678.",
    },
    expectedOutput: {
      vendor: {
        name: "Acme Power Pty Ltd",
        accountName: "Acme Power Pty Ltd",
        bsb: "012-345",
        accountNumber: "12345678",
      },
      bill: {
        number: "INV-2041",
        issueDate: "2026-09-01",
        dueDate: "2026-09-15",
        currency: "AUD",
        totalCents: 132000,
        taxCents: 12000,
        lineItems: [{ description: "Electricity, August 2026", amountCents: 132000 }],
      },
    },
  },
  {
    name: "subscription invoice without bank details",
    input: {
      caseId: "bill-nimbus-771204",
      ticketKey: "BILL-771204",
      vendorRef: "nimbus",
      from: "accounts@nimbus.example",
      subject: "Invoice NT-8842 for your subscription",
      text:
        "Your Nimbus Tools subscription for October 2026 renewed. Invoice NT-8842, "
        + "issued 20 September 2026, payment due 4 October 2026. Amount $88.00 AUD "
        + "(includes $8.00 GST). Pay by card on file; bank transfer is not accepted.",
    },
    expectedOutput: {
      vendor: {
        name: "Nimbus Tools Pty Ltd",
        accountName: null,
        bsb: null,
        accountNumber: null,
      },
      bill: {
        number: "NT-8842",
        issueDate: "2026-09-20",
        dueDate: "2026-10-04",
        currency: "AUD",
        totalCents: 8800,
        taxCents: 800,
        lineItems: [
          { description: "Nimbus Tools subscription, October 2026", amountCents: 8800 },
        ],
      },
    },
  },
];
