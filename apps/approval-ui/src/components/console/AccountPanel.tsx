import type { SessionInfo } from "@/lib/models";

function formatExpiry(value: string | null): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * Account panel. Everything shown comes from the signed-in Supabase session
 * (email, tenant and roles claims, expiry). Secrets never reach the browser;
 * the only token stored locally is the Supabase access token.
 */
export function AccountPanel({
  session,
  signOutBusy,
  onSignOut,
}: {
  session: SessionInfo;
  signOutBusy: boolean;
  onSignOut: () => void;
}) {
  return (
    <section id="account-view" className="panel-view">
      <div className="panel-heading">
        <p className="eyebrow">Account</p>
        <h2>{session.email}</h2>
        <p className="panel-note">Signed in through the Supabase magic-link session.</p>
      </div>

      <dl className="account-facts">
        <div className="fact-row">
          <dt>Email</dt>
          <dd>{session.email}</dd>
        </div>
        <div className="fact-row">
          <dt>Tenant</dt>
          <dd>{session.tenantId || "—"}</dd>
        </div>
        <div className="fact-row">
          <dt>Roles</dt>
          <dd>{session.roles.length > 0 ? session.roles.join(", ") : "—"}</dd>
        </div>
        <div className="fact-row">
          <dt>Session expires</dt>
          <dd>{formatExpiry(session.expiresAt)}</dd>
        </div>
      </dl>

      <p className="panel-note">
        Tenant and roles are read-only claims of the signed-in session. When the session expires
        you will be asked to sign in again with a magic link. Only the Supabase access token is
        kept in this browser — service-role keys and other secrets are never sent to this page.
      </p>

      <div className="settings-actions">
        <button id="account-signout" type="button" disabled={signOutBusy} onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </section>
  );
}
