import { fromADF } from "mdast-util-from-adf";
import { toMarkdown } from "mdast-util-to-markdown";

/**
 * Convert a Jira Atlassian Document Format body into markdown. The console
 * renders the result through the shared Markdown component (react-markdown),
 * so the conversion rides the same unified pipeline as the prose it feeds:
 * marks, lists, code blocks and links survive as real markdown and unsafe
 * links stay filtered at render time. Anything unparseable becomes empty
 * text rather than a raw dump; the server payload is untrusted input.
 */
export function adfToMarkdown(adf: unknown): string {
  if (adf === null || typeof adf !== "object") return "";
  if (Object.keys(adf).length === 0) return "";
  try {
    return toMarkdown(fromADF(adf as Parameters<typeof fromADF>[0])).trim();
  } catch {
    return "";
  }
}
