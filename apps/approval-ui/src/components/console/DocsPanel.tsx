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
    id: "security",
    title: "Rendering and secrets",
    body: "All Jira and run content renders as plain text nodes, so markup in a summary can never execute. Secrets never reach the browser bundle.",
  },
];

export function DocsPanel() {
  return (
    <section id="docs-view" className="panel-view">
      <div className="panel-heading">
        <p className="eyebrow">Docs</p>
        <h2>How this console works</h2>
        <p className="panel-note">A short tour of the board, ticket runs, approvals and the assistant.</p>
      </div>
      <div className="docs-grid">
        {DOC_TOPICS.map((topic) => (
          <article key={topic.id} className="doc-card">
            <h3>{topic.title}</h3>
            <p>{topic.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
