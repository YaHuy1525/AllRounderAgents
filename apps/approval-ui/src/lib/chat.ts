export type ContextChip = { key: string; summary: string };

export const CHAT_AGENTS = [
  { id: "triage", label: "Triage assistant" },
  { id: "support", label: "Support assistant" },
  { id: "coding", label: "Coding assistant" },
] as const;

export const QUICK_PROMPTS = [
  {
    id: "sprint-status",
    label: "Current Sprint Status",
    prompt: "Give me the current sprint status: ticket totals, progress, and what is blocked or in progress.",
  },
  {
    id: "project-review",
    label: "Project Status Review",
    prompt: "Review the project status and call out the most important tickets and risks.",
  },
] as const;

const TICKET_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,19}-\d+$/;
const CHIP_LIMIT = 8;
const TICKET_PAYLOAD_LIMIT = 40;

export function normalizeChip(value: { key: string; summary: string }): ContextChip | null {
  const key = value.key.trim().toUpperCase();
  if (!TICKET_KEY_PATTERN.test(key)) return null;
  return { key, summary: value.summary.trim().slice(0, 240) };
}

export function addContextChip(
  chips: ContextChip[],
  chip: { key: string; summary: string },
  limit = CHIP_LIMIT,
): ContextChip[] {
  const normalized = normalizeChip(chip);
  if (!normalized) return chips;
  const without = chips.filter((item) => item.key !== normalized.key);
  return [normalized, ...without].slice(0, Math.max(1, limit));
}

export function removeContextChip(chips: ContextChip[], key: string): ContextChip[] {
  return chips.filter((item) => item.key !== key);
}

/**
 * Build the /chat payload: context chips ride in front of the board snapshot
 * (deduplicated by key, capped at the server's 40-ticket limit), and the
 * first chip becomes the selected ticket the assistant focuses on.
 */
export function buildChatRequest(input: {
  message: string;
  agent: string;
  chips: ContextChip[];
  tickets: Array<Record<string, unknown>>;
  selectedKey?: string;
}): {
  message: string;
  agent: string;
  selectedKey: string | undefined;
  tickets: Array<Record<string, unknown>>;
} {
  const tickets: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const chip of input.chips) {
    if (seen.has(chip.key)) continue;
    seen.add(chip.key);
    tickets.push({ key: chip.key, summary: chip.summary });
  }
  for (const ticket of input.tickets) {
    if (tickets.length >= TICKET_PAYLOAD_LIMIT) break;
    const key = typeof ticket.key === "string" ? ticket.key : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tickets.push(ticket);
  }
  return {
    message: input.message.trim(),
    agent: input.agent,
    selectedKey: input.chips[0]?.key ?? input.selectedKey,
    tickets: tickets.slice(0, TICKET_PAYLOAD_LIMIT),
  };
}
