/**
 * Role gates for console controls. The server stays the source of truth —
 * every endpoint re-checks roles — so these helpers only shape the UI:
 * buttons that would certainly 403 render disabled with a hint instead.
 *
 * An empty role list means the session snapshot has not resolved yet, and the
 * gates stay permissive so a slow auth round trip cannot lock out a working
 * session; the first 401/403 from the API still surfaces.
 */

export const START_RUN_ROLES = ["agent", "admin"] as const;
export const DECIDE_ROLES = ["approver", "admin"] as const;
export const ADMIN_ROLES = ["admin"] as const;
/** Mirrors the API's write roles for `/github/accounts` (github_api._WRITE_ROLES). */
export const ACCOUNT_WRITE_ROLES = ["agent", "admin"] as const;

export const START_RUN_HINT = "Starting runs requires the agent or admin role.";
export const DECIDE_HINT = "Deciding approvals requires the approver or admin role.";
export const ADMIN_HINT = "Managing server settings requires the admin role.";
export const ACCOUNT_HINT = "Managing GitHub accounts requires the agent or admin role.";

export function hasAnyRole(roles: readonly string[], allowed: readonly string[]): boolean {
  return roles.some((role) => allowed.includes(role));
}

/** True when the principal may start workflow runs (agent/admin). */
export function canStartRun(roles: readonly string[]): boolean {
  return roles.length === 0 || hasAnyRole(roles, START_RUN_ROLES);
}

/** True when the principal may approve or reject gates (approver/admin). */
export function canDecide(roles: readonly string[]): boolean {
  return roles.length === 0 || hasAnyRole(roles, DECIDE_ROLES);
}

/** True when the principal may mutate server-backed settings (admin). */
export function canAdminSettings(roles: readonly string[]): boolean {
  return roles.length === 0 || hasAnyRole(roles, ADMIN_ROLES);
}

/** True when the principal may manage GitHub accounts (agent/admin, per the API). */
export function canManageAccounts(roles: readonly string[]): boolean {
  return roles.length === 0 || hasAnyRole(roles, ACCOUNT_WRITE_ROLES);
}
