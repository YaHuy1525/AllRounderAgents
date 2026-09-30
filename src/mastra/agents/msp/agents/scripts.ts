import type { AgentScenario } from "../../script.js";

/**
 * Few-shot scenarios for the MSP reply drafter. Expected outputs are
 * on-contract (`DraftModelOutputSchema`): the reply body with its
 * `[sourceId:span]` markers and the citation list the draft validation
 * checks against the retrieved knowledge passages.
 */
export const mspDrafterScenarios: AgentScenario[] = [
  {
    name: "vpn session limit",
    input: {
      subject: "VPN drops for the whole office",
      text: "Hi, since this morning the VPN keeps dropping for three of our users. Can you help?",
      passages: [
        {
          sourceId: "kb/vpn-troubleshooting.md",
          span: "120-360",
          title: "VPN troubleshooting",
          text: "A VPN that drops for several users at once usually means the site's session limit was reached; raise the limit on the gateway or remove stale sessions.",
          stale: false,
        },
      ],
    },
    expectedOutput: {
      body:
        "Thanks for the report. Drops for several users at once usually mean the gateway session limit was reached, so we will raise the limit and clear any stale sessions. We will confirm once you are back online [kb/vpn-troubleshooting.md:120-360].\n\nService desk",
      citations: [{ sourceId: "kb/vpn-troubleshooting.md", span: "120-360" }],
    },
  },
  {
    name: "locked account",
    input: {
      subject: "Account locked after holiday",
      text: "I cannot log in to my laptop, it says the account is locked. I was away for two weeks.",
      passages: [
        {
          sourceId: "kb/account-lockout.md",
          span: "40-210",
          title: "Account lockout handling",
          text: "Accounts lock after repeated failed sign-ins; verify the person's identity, then unlock the account and require a password reset.",
          stale: false,
        },
      ],
    },
    expectedOutput: {
      body:
        "Thanks for letting us know. After time away, accounts can lock from cached sign-in attempts, so once we verify your identity we will unlock the account and set a required password reset [kb/account-lockout.md:40-210].\n\nService desk",
      citations: [{ sourceId: "kb/account-lockout.md", span: "40-210" }],
    },
  },
];
