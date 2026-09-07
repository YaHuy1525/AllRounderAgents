import { createClient } from "@supabase/supabase-js";

type Approval = {
  id: string;
  caseId: string;
  action: Record<string, unknown>;
  evidence: Array<{ sourceId: string; span: string }>;
  decision: "approved" | "rejected" | "expired" | null;
  expiresAt: string;
};

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
if (!url || !anonKey || !apiUrl) throw new Error("Browser-safe environment is incomplete");
const supabase = createClient(url, anonKey);

function required<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Required UI node is missing: ${selector}`);
  return node;
}

const statusNode = required<HTMLParagraphElement>("#status");
const approvalsNode = required<HTMLElement>("#approvals");
const login = required<HTMLFormElement>("#login");

function text(tag: string, value: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("Sign in first");
  return data.session.access_token;
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error("Request failed");
  return response.json();
}

async function decide(id: string, decision: "approved" | "rejected"): Promise<void> {
  await api(`/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
  await load();
}

async function load(): Promise<void> {
  try {
    const approvals = (await api("/approvals")) as Approval[];
    approvalsNode.replaceChildren();
    for (const approval of approvals) {
      const card = document.createElement("article");
      card.append(
        text("h2", `Case ${approval.caseId}`),
        text("pre", JSON.stringify(approval.action, null, 2)),
        text(
          "p",
          `Evidence: ${approval.evidence.map((item) => `${item.sourceId}:${item.span}`).join(", ")}`,
        ),
        text("p", `Expires: ${approval.expiresAt}`),
      );
      if (approval.decision === null) {
        for (const decision of ["approved", "rejected"] as const) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = decision === "approved" ? "Approve" : "Reject";
          button.addEventListener("click", () => void decide(approval.id, decision));
          card.append(button);
        }
      } else {
        card.append(text("strong", `Decision: ${approval.decision}`));
      }
      approvalsNode.append(card);
    }
    statusNode.textContent = `${approvals.length} approvals`;
  } catch {
    statusNode.textContent = "Sign in to view approvals.";
  }
}

login.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = document.querySelector<HTMLInputElement>("#email")?.value;
  if (!email) return;
  void supabase.auth.signInWithOtp({ email }).then(({ error }) => {
    statusNode.textContent = error ? "Sign-in failed." : "Check your email for the sign-in link.";
  });
});

supabase.auth.onAuthStateChange(() => void load());
void load();
