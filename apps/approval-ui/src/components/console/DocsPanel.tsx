import { IconApprovals, IconBoard, IconChat, IconGrid, IconLock, IconPlay, IconPlus } from "./icons";

const DOC_TOPICS = [
  {
    id: "board",
    title: "Sprint board",
    body: "The Dashboard tab shows the active sprint as four columns — Blocked, Open, In Progress and Review — mapped from Jira status categories. Empty columns stay visible with a placeholder.",
  },
  {
    id: "tabs",
    title: "Ticket tabs",
    body: "Details on a card opens a tab named after the issue. Tabs close with ×; the History button in the top bar reopens recently viewed tickets.",
  },
  {
    id: "runs",
    title: "Run steps",
    body: "Each ticket tab shows only the steps its lane actually runs — the support lane has no environment selection, so no such step is drawn. Click a step to expand its recorded data; Debug Info shows the raw case JSON.",
  },
  {
    id: "approvals",
    title: "Approvals",
    body: "Approval gates appear inline in the ticket tab and in the Approvals view. Approving or rejecting calls the decision endpoint and updates the gate without a reload.",
  },
  {
    id: "assistant",
    title: "Assistant",
    body: "Drag a ticket card onto the chat to attach it as removable context. Quick actions send canned sprint and project prompts to the selected assistant.",
  },
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    body: "Press g then b, r or w to jump to the Board, Runs or Workflows; + opens a new tab. In the Runs table, j and k walk the rows and Enter opens the focused run. Shortcuts pause while you are typing in a field.",
  },
  {
    id: "security",
    title: "Rendering and secrets",
    body: "Summaries, reviews and chat replies render as markdown: formatting is shown, but raw HTML stays inert text and only https links become clickable, so markup in server content can never execute. Secrets never reach the browser bundle.",
  },
];

/** Icon tile per doc topic, falling back to the board mark. */
const DOC_ICONS: Record<string, typeof IconBoard> = {
  board: IconBoard,
  tabs: IconGrid,
  runs: IconPlay,
  approvals: IconApprovals,
  assistant: IconChat,
  shortcuts: IconPlus,
  security: IconLock,
};

export function DocsPanel() {
  return (
    <section id="docs-view" className="panel-view">
      <div className="panel-heading">
        <p className="eyebrow">Docs</p>
        <h2>How this console works</h2>
        <p className="panel-note">
          A short tour of the board, ticket runs, approvals, the assistant and the keyboard
          shortcuts.
        </p>
      </div>
      <div className="docs-grid">
        {DOC_TOPICS.map((topic) => {
          const DocIcon = DOC_ICONS[topic.id] ?? IconBoard;
          return (
            <article key={topic.id} className="doc-card">
              <span className="doc-card-icon" aria-hidden="true">
                <DocIcon />
              </span>
              <h3>{topic.title}</h3>
              <p>{topic.body}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
