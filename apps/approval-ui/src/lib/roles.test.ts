import { describe, expect, it } from "vitest";

import {
  ADMIN_ROLES,
  DECIDE_ROLES,
  START_RUN_ROLES,
  canAdminSettings,
  canDecide,
  canManageAccounts,
  canStartRun,
  hasAnyRole,
} from "./roles.js";

describe("role gates", () => {
  it("matches any allowed role", () => {
    expect(hasAnyRole(["viewer", "agent"], START_RUN_ROLES)).toBe(true);
    expect(hasAnyRole(["viewer"], START_RUN_ROLES)).toBe(false);
    expect(hasAnyRole(["admin"], DECIDE_ROLES)).toBe(true);
    expect(hasAnyRole(["approver", "agent"], ADMIN_ROLES)).toBe(false);
  });

  it("gates starting runs to agent and admin", () => {
    expect(canStartRun(["agent"])).toBe(true);
    expect(canStartRun(["admin"])).toBe(true);
    expect(canStartRun(["approver"])).toBe(false);
    expect(canStartRun(["viewer"])).toBe(false);
  });

  it("gates approvals to approver and admin", () => {
    expect(canDecide(["approver"])).toBe(true);
    expect(canDecide(["admin"])).toBe(true);
    expect(canDecide(["agent"])).toBe(false);
    expect(canDecide(["viewer"])).toBe(false);
  });

  it("gates server settings to admin only", () => {
    expect(canAdminSettings(["admin"])).toBe(true);
    expect(canAdminSettings(["approver", "agent"])).toBe(false);
  });

  it("gates GitHub account writes to agent and admin", () => {
    expect(canManageAccounts(["agent"])).toBe(true);
    expect(canManageAccounts(["admin"])).toBe(true);
    expect(canManageAccounts(["approver"])).toBe(false);
    expect(canManageAccounts(["viewer"])).toBe(false);
    expect(canManageAccounts([])).toBe(true);
  });

  it("stays permissive while the session roles are unknown", () => {
    expect(canStartRun([])).toBe(true);
    expect(canDecide([])).toBe(true);
    expect(canAdminSettings([])).toBe(true);
  });
});
