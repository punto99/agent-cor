import test from "node:test";
import assert from "node:assert/strict";
import { setInternalUserRoles, viewerCanAccessInternalUserAdmin, getDashboard as internalDashboard, setInternalUserAssignments } from "../convex/data/internalUserAdmin";
import { setExternalUserRoles, viewerCanAccessExternalUserAdmin, getDashboard as externalDashboard, getExternalTrelloManualReviewNotificationContext } from "../convex/data/externalUserAdmin";
import { viewerCanAccessAnalytics, getDashboard as analyticsDashboard, rebuildDeliverableAnalyticsRollups } from "../convex/data/analytics";
import { viewerAccessProfile, hasPlatformAdminAccess } from "../convex/data/userAccess";
import { canAdministerPlatform, ensureDefaultRoleForNewInternalUser } from "../convex/lib/userRoles";
import { linkApprovedExternalUser } from "../convex/data/approvedExternalUsers";
import { getFunctionName } from "convex/server";
import { resolveInternalUserInCORNow, verifyInternalUserInCORNow } from "../convex/data/internalUserAdminActions";
import { searchTrelloBoardsForBrand } from "../convex/data/externalUserAdminActions";
import { assignUserToClient, assignUserToClientBrand, removeUserFromClient } from "../convex/data/corClients";

function fixture() {
  const adminId = "platform-admin";
  const rows = new Map<string, any>();
  let counter = 0;
  let actor: string | null = adminId;
  const put = (table: string, row: any) => rows.set(row._id, { ...row, _table: table });
  put("users", { _id: adminId, email: "admin@example.com" });
  put("userAccessProfiles", { _id: "admin-profile", userId: adminId, platformRole: "admin" });
  put("users", { _id: "internal", email: "internal@example.com" });
  put("users", { _id: "external", email: "external@example.com" });
  put("approvedExternalUsers", { _id: "approved", userId: "external", email: "external@example.com" });
  put("clientUserAssignments", { _id: "assignment", userId: "external", clientId: "client" });
  const ctx: any = {
    auth: { getUserIdentity: async () => actor ? { subject: `${actor}|session` } : null },
    db: {
      get: async (id: string) => rows.get(id) ?? null,
      normalizeId: (_table: string, id: string) => id || null,
      delete: async (id: string) => { rows.delete(id); },
      insert: async (table: string, row: any) => { const id = `insert-${++counter}`; put(table, { _id: id, ...row }); return id; },
      patch: async (id: string, patch: any) => { for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete rows.get(id)[key]; else rows.get(id)[key] = value; } },
      query: (table: string) => {
        const filters: Array<(row: any) => boolean> = [];
        const builder: any = { eq: (key: string, value: any) => { filters.push(row => row[key] === value); return builder; } };
        const selected = () => [...rows.values()].filter(row => row._table === table && filters.every(f => f(row)));
        const q: any = { withIndex: (_: string, build?: any) => { build?.(builder); return q; }, unique: async () => { assert.ok(selected().length <= 1); return selected()[0] ?? null; }, first: async () => selected()[0] ?? null, collect: async () => selected(), order: () => q, take: async (n: number) => selected().slice(0, n) };
        return q;
      },
    },
  };
  return { ctx, rows, put, adminId, as: (id: string | null) => { actor = id; }, call: (fn: any, args: any = {}) => fn._handler(ctx, args), table: (name: string) => [...rows.values()].filter(row => row._table === name) };
}

test("admin and super_admin roles from the database grant all three administration tabs", async () => {
  const f = fixture();
  for (const role of ["admin", "super_admin"]) {
    f.put("userAccessProfiles", { _id: "internal-profile", userId: "internal", platformRole: role });
    f.as("internal");
    for (const fn of [viewerCanAccessInternalUserAdmin, viewerCanAccessExternalUserAdmin, viewerCanAccessAnalytics]) {
      assert.equal((await f.call(fn)).canAccess, true);
    }
    assert.equal(await f.call(hasPlatformAdminAccess, { userId: "internal" }), true);
    assert.equal((await f.call(internalDashboard)).canAccess, true);
    assert.equal((await f.call(externalDashboard)).canAccess, true);
    assert.equal((await f.call(analyticsDashboard)).canAccess, true);
  }
});

test("no external, including one with a stored admin role or awaiting account linking, can receive an internal role", async () => {
  for (const platformRole of ["user", "admin", "super_admin"]) {
    for (const linked of [true, false]) {
      const f = fixture();
      if (!linked) delete f.rows.get("approved").userId;
      await assert.rejects(f.call(setInternalUserRoles, { targetUserId: "external", platformRole }), /externo/);
      assert.equal(f.table("userAccessProfiles").length, 1);
      assert.equal(f.table("userRoleAuditLog").length, 0);
    }
  }
  const f = fixture();
  f.put("approvedExternalUsers", { _id: "external-admin", userId: f.adminId, email: "admin@example.com", isCoordinator: true });
  for (const [fn, args] of [
    [setInternalUserRoles, { targetUserId: "internal", platformRole: "super_admin" }],
    [setExternalUserRoles, { approvedExternalUserId: "approved", isCoordinator: true }],
  ] as const) await assert.rejects(f.call(fn, args), /permisos/);
});

test("missing/user/unknown roles and former allowlisted IDs cannot access administrative data or mutations", async () => {
  const f = fixture();
  const oldId = "k972vsx708w0bdmryeaqsw9qfh842tav";
  f.put("users", { _id: oldId, email: "formerly-allowed@example.com" });
  for (const userId of ["internal", oldId]) {
    f.as(userId);
    for (const role of [undefined, "user", "designer"]) {
      if (role) f.put("userAccessProfiles", { _id: "test-profile", userId, platformRole: role });
      else f.rows.delete("test-profile");
      for (const fn of [viewerCanAccessInternalUserAdmin, viewerCanAccessExternalUserAdmin, viewerCanAccessAnalytics]) assert.equal((await f.call(fn)).canAccess, false);
      for (const fn of [internalDashboard, externalDashboard, analyticsDashboard]) assert.deepEqual(await f.call(fn), { canAccess: false });
      await assert.rejects(f.call(setInternalUserAssignments, { targetUserId: "internal", fullClientIds: [], brandIds: [] }), /permisos/);
      await assert.rejects(f.call(rebuildDeliverableAnalyticsRollups, { confirm: "REBUILD_DELIVERABLE_ANALYTICS" }), /permisos/);
    }
  }
  f.as(null);
  for (const fn of [internalDashboard, externalDashboard, analyticsDashboard]) assert.deepEqual(await f.call(fn), { canAccess: false });
});

test("external coordinators are denied every admin entry point even with an incorrectly stored super_admin role", async () => {
  for (const linked of [true, false]) {
    const f = fixture();
    f.rows.get("approved").isCoordinator = true;
    if (!linked) delete f.rows.get("approved").userId;
    f.put("userAccessProfiles", { _id: "invalid-external-profile", userId: "external", platformRole: "super_admin" });
    f.as("external");
    assert.equal(await canAdministerPlatform(f.ctx, "external" as any), false);
    for (const fn of [viewerCanAccessInternalUserAdmin, viewerCanAccessExternalUserAdmin, viewerCanAccessAnalytics]) assert.equal((await f.call(fn)).canAccess, false);
    for (const fn of [internalDashboard, externalDashboard, analyticsDashboard]) assert.deepEqual(await f.call(fn), { canAccess: false });
    await assert.rejects(f.call(setExternalUserRoles, { approvedExternalUserId: "approved", isCoordinator: false }), /permisos/);
    await assert.rejects(f.call(setInternalUserAssignments, { targetUserId: "internal", fullClientIds: [], brandIds: [] }), /permisos/);
  }
});

test("promotions and revocations take effect on the next admin request without changing client assignments", async () => {
  const f = fixture();
  const assignments = structuredClone(f.table("clientUserAssignments"));
  await f.call(setInternalUserRoles, { targetUserId: "internal", platformRole: "admin" });
  f.as("internal");
  assert.equal((await f.call(viewerCanAccessInternalUserAdmin)).canAccess, true);
  f.as(f.adminId);
  await f.call(setInternalUserRoles, { targetUserId: "internal", platformRole: "user" });
  f.as("internal");
  for (const fn of [viewerCanAccessInternalUserAdmin, viewerCanAccessExternalUserAdmin, viewerCanAccessAnalytics]) assert.equal((await f.call(fn)).canAccess, false);
  await assert.rejects(f.call(setInternalUserRoles, { targetUserId: "internal", platformRole: "admin" }), /permisos/);
  assert.deepEqual(f.table("clientUserAssignments"), assignments);
});

test("super_admin can never be assigned or demoted through the application, including by another super_admin", async () => {
  for (const actorRole of ["admin", "super_admin"]) {
    const f = fixture();
    f.rows.get("admin-profile").platformRole = actorRole;
    await assert.rejects(f.call(setInternalUserRoles, { targetUserId: "internal", platformRole: "super_admin" }), /base de datos/);
    f.put("userAccessProfiles", { _id: "super-profile", userId: "internal", platformRole: "super_admin" });
    for (const role of ["user", "admin"]) await assert.rejects(f.call(setInternalUserRoles, { targetUserId: "internal", platformRole: role }), /base de datos/);
    await f.call(setInternalUserRoles, { targetUserId: "internal", workRole: "" });
    assert.equal(f.rows.get("super-profile").platformRole, "super_admin");
    await f.call(setInternalUserRoles, { targetUserId: "internal", workRole: "Cuentas" });
    assert.equal(f.rows.get("super-profile").platformRole, "super_admin");
    assert.equal(f.rows.get("super-profile").workRole, "Cuentas");
    f.as("internal");
    await assert.rejects(f.call(setInternalUserRoles, { targetUserId: "internal", platformRole: "user" }), /base de datos/);
    assert.equal((await f.call(viewerCanAccessInternalUserAdmin)).canAccess, true);
  }
});

test("COR and Trello actions use database roles and reject unauthorized callers before provider access", async () => {
  const f = fixture();
  const queries: string[] = [];
  const actionCtx: any = { auth: f.ctx.auth, runQuery: async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    queries.push(name);
    if (name === "data/userAccess:hasPlatformAdminAccess") return await f.call(hasPlatformAdminAccess, args);
    if (name === "data/approvedExternalUsers:getApprovedExternalUserByUserId") return f.rows.get("approved");
    if (name === "data/clientBrands:getById") return null;
    throw new Error(`Unexpected query: ${name}`);
  } };
  for (const userId of [null, "internal", "external", f.adminId]) {
    f.as(userId);
    for (const fn of [resolveInternalUserInCORNow, verifyInternalUserInCORNow, searchTrelloBoardsForBrand]) {
      queries.length = 0;
      const call = () => (fn as any)._handler(actionCtx, { targetUserId: "external", clientBrandId: "missing" });
      if (userId === f.adminId) {
        assert.equal((await call()).ok, false); // Passes auth, stops at a local missing/ineligible target.
        assert.equal(queries.length, 2);
      } else {
        await assert.rejects(call(), /autenticado|permisos/);
        assert.equal(queries.length, userId ? 1 : 0);
      }
    }
  }
});

test("manual Trello review recipients come from current admin roles and exclude external and revoked profiles", async () => {
  const f = fixture();
  f.put("userAccessProfiles", { _id: "internal-profile", userId: "internal", platformRole: "super_admin" });
  f.put("userAccessProfiles", { _id: "external-profile", userId: "external", platformRole: "admin" });
  const getContext = () => f.call(getExternalTrelloManualReviewNotificationContext, { approvedExternalUserId: "approved", clientBrandId: "missing" });
  assert.deepEqual((await getContext()).adminEmails.sort(), ["admin@example.com", "internal@example.com"]);
  f.rows.get("internal-profile").platformRole = "user";
  assert.deepEqual((await getContext()).adminEmails, ["admin@example.com"]);
});

test("direct client/category assignment endpoints require an internal admin without changing existing read permissions", async () => {
  const f = fixture();
  f.put("corClients", { _id: "client", name: "Cliente" });
  f.put("clientBrands", { _id: "brand", name: "Categoría", clientId: "client" });
  const endpoints = [
    [assignUserToClient, { targetUserId: "internal", clientId: "client" }],
    [assignUserToClientBrand, { targetUserId: "internal", brandId: "brand" }],
    [removeUserFromClient, { targetUserId: "internal", clientId: "client" }],
  ] as const;
  const before = structuredClone(f.table("clientUserAssignments"));
  for (const userId of [null, "internal", "external"]) {
    f.as(userId);
    for (const [fn, args] of endpoints) await assert.rejects(f.call(fn, args), /permisos/);
  }
  assert.deepEqual(f.table("clientUserAssignments"), before);
  f.as(f.adminId);
  const fullId = await f.call(assignUserToClient, endpoints[0][1]);
  assert.equal(f.rows.get(fullId).assignedBy, f.adminId);
  assert.equal(await f.call(assignUserToClient, endpoints[0][1]), fullId);
  const brandId = await f.call(assignUserToClientBrand, endpoints[1][1]);
  assert.equal(f.rows.get(brandId).brandId, "brand");
  await f.call(removeUserFromClient, endpoints[2][1]);
  assert.equal(f.rows.has(fullId), false);
  assert.equal(f.rows.has(brandId), true);
});

test("anonymous, regular internal and external users cannot change anyone's roles", async () => {
  const f = fixture();
  const before = structuredClone([...f.rows]);
  for (const id of [null, "internal", "external"]) {
    f.as(id);
    await assert.rejects(f.call(setExternalUserRoles, { approvedExternalUserId: "approved", isCoordinator: true }), /permisos/);
    await assert.rejects(f.call(setInternalUserRoles, { targetUserId: "internal", platformRole: "admin" }), /permisos/);
  }
  assert.deepEqual([...f.rows], before);
});

test("coordinator metadata preserves kind, feature visibility and assignments, including before first login", async () => {
  const f = fixture();
  f.as("external");
  const beforeAccess = await f.call(viewerAccessProfile);
  const assignments = structuredClone(f.table("clientUserAssignments"));
  f.as(f.adminId);
  await f.call(setExternalUserRoles, { approvedExternalUserId: "approved", isCoordinator: true, workRole: "" });
  f.as("external");
  assert.deepEqual(await f.call(viewerAccessProfile), beforeAccess);
  assert.deepEqual(f.table("clientUserAssignments"), assignments);
  assert.equal(f.rows.get("approved").isCoordinator, true);
  assert.equal(f.rows.get("approved").workRole, undefined);
  assert.equal(f.table("userAccessProfiles").length, 1);
  for (const fn of [viewerCanAccessInternalUserAdmin, viewerCanAccessExternalUserAdmin, viewerCanAccessAnalytics]) assert.equal((await f.call(fn)).canAccess, false);
  f.as(f.adminId);
  f.put("approvedExternalUsers", { _id: "invited", email: "invited@example.com" });
  await f.call(setExternalUserRoles, { approvedExternalUserId: "invited", isCoordinator: true });
  assert.equal(f.rows.get("invited").isCoordinator, true);
  assert.equal(f.rows.get("invited").userId, undefined);
});

test("role updates audit actor and before/after values, remain idempotent and allow clearing work roles", async () => {
  const f = fixture();
  const args = { targetUserId: "internal", platformRole: "admin", workRole: " Cuentas " };
  await f.call(setInternalUserRoles, args);
  await f.call(setInternalUserRoles, args);
  assert.equal(f.table("userAccessProfiles").length, 2);
  assert.equal(f.table("userRoleAuditLog").length, 1);
  const log = f.table("userRoleAuditLog")[0];
  assert.equal(log.actorId, f.adminId);
  assert.deepEqual(JSON.parse(log.before), { platformRole: null });
  assert.deepEqual(JSON.parse(log.after), { platformRole: "admin", workRole: "Cuentas" });
  await f.call(setInternalUserRoles, { ...args, workRole: "" });
  assert.equal(f.table("userAccessProfiles").find(row => row.userId === "internal").workRole, undefined);
  await f.call(setExternalUserRoles, { approvedExternalUserId: "approved", isCoordinator: true });
  await f.call(setExternalUserRoles, { approvedExternalUserId: "approved", isCoordinator: false });
  assert.equal(f.rows.get("approved").isCoordinator, false);
  const externalLog = f.table("userRoleAuditLog").at(-1);
  assert.equal(externalLog.approvedExternalUserId, "approved");
  assert.deepEqual(JSON.parse(externalLog.after), { isCoordinator: false });
});

test("invalid targets and oversized work roles do not create profiles or change access", async () => {
  const f = fixture();
  const before = structuredClone([...f.rows]);
  await assert.rejects(f.call(setInternalUserRoles, { targetUserId: "missing", platformRole: "admin" }));
  await assert.rejects(f.call(setExternalUserRoles, { approvedExternalUserId: "missing", isCoordinator: true }));
  await assert.rejects(f.call(setInternalUserRoles, { targetUserId: "internal", platformRole: "admin", workRole: "x".repeat(101) }));
  await assert.rejects(f.call(setExternalUserRoles, { approvedExternalUserId: "approved", isCoordinator: true, workRole: "x".repeat(101) }));
  assert.deepEqual([...f.rows], before);
});

test("assigning user to a previously unassigned internal creates an audited profile without ever granting admin", async () => {
  const f = fixture();
  const args = { targetUserId: "internal", platformRole: "user" };
  assert.equal(f.table("userAccessProfiles").some(row => row.userId === "internal"), false);
  assert.equal(await canAdministerPlatform(f.ctx, "internal" as any), false);
  const assignments = structuredClone(f.table("clientUserAssignments"));
  await f.call(setInternalUserRoles, args);
  const profiles = f.table("userAccessProfiles").filter(row => row.userId === "internal");
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].platformRole, "user");
  assert.equal(await canAdministerPlatform(f.ctx, "internal" as any), false);
  assert.deepEqual(f.table("clientUserAssignments"), assignments);
  const log = f.table("userRoleAuditLog")[0];
  assert.deepEqual(JSON.parse(log.before), { platformRole: null });
  assert.deepEqual(JSON.parse(log.after), { platformRole: "user" });
  await f.call(setInternalUserRoles, args);
  assert.equal(f.table("userAccessProfiles").filter(row => row.userId === "internal").length, 1);
  assert.equal(f.table("userRoleAuditLog").length, 1);
});

test("updating visible roles preserves hidden work roles when the field is omitted", async () => {
  const f = fixture();
  await f.call(setInternalUserRoles, { targetUserId: "internal", platformRole: "user", workRole: "Diseño" });
  await f.call(setInternalUserRoles, { targetUserId: "internal", platformRole: "admin" });
  assert.equal(f.table("userAccessProfiles").find(row => row.userId === "internal").workRole, "Diseño");
  f.rows.get("approved").workRole = "Coordinación";
  await f.call(setExternalUserRoles, { approvedExternalUserId: "approved", isCoordinator: true });
  assert.equal(f.rows.get("approved").workRole, "Coordinación");
  await f.call(setExternalUserRoles, { approvedExternalUserId: "approved", isCoordinator: false });
  assert.equal(f.rows.get("approved").workRole, "Coordinación");
});

test("linking an external removes any previously stored internal role, retaining coordinator metadata and assignments", async () => {
  for (const alreadyLinked of [false, true]) {
    const f = fixture();
    f.put("userAccessProfiles", { _id: "old-profile", userId: "external", platformRole: "super_admin", workRole: "Cuentas" });
    f.rows.get("approved").isCoordinator = true;
    f.rows.get("approved").workRole = "";
    if (!alreadyLinked) delete f.rows.get("approved").userId;
    const assignments = structuredClone(f.table("clientUserAssignments"));
    await f.call(linkApprovedExternalUser, { userId: "external", email: "external@example.com" });
    assert.equal(f.table("userAccessProfiles").length, 1);
    assert.equal(f.rows.get("approved").userId, "external");
    assert.equal(f.rows.get("approved").isCoordinator, true);
    assert.deepEqual(f.table("clientUserAssignments"), assignments);
    assert.equal(f.table("userRoleAuditLog").length, 1);
    await f.call(linkApprovedExternalUser, { userId: "external", email: "external@example.com" });
    assert.equal(f.table("userRoleAuditLog").length, 1);
  }
});

test("new Google internals get an audited user role once without any additional client or administrative access", async () => {
  const f = fixture();
  const originalRows = structuredClone([...f.rows]);
  const args = { userId: "internal" as any, existingUserId: null, providerId: "google" };
  await ensureDefaultRoleForNewInternalUser(f.ctx, args);
  const profiles = f.table("userAccessProfiles").filter(row => row.userId === "internal");
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].platformRole, "user");
  assert.equal(profiles[0].workRole, undefined);
  assert.equal(profiles[0].updatedBy, "internal");
  const log = f.table("userRoleAuditLog")[0];
  assert.equal(log.actorId, "internal");
  assert.equal(log.targetUserId, "internal");
  assert.equal(log.createdAt, profiles[0].updatedAt);
  assert.deepEqual(JSON.parse(log.before), { platformRole: null });
  assert.deepEqual(JSON.parse(log.after), { platformRole: "user" });
  for (const [id, row] of originalRows) assert.deepEqual(f.rows.get(id), row);
  f.as("internal");
  for (const fn of [viewerCanAccessInternalUserAdmin, viewerCanAccessExternalUserAdmin, viewerCanAccessAnalytics]) assert.equal((await f.call(fn)).canAccess, false);
  await ensureDefaultRoleForNewInternalUser(f.ctx, args);
  assert.equal(f.table("userAccessProfiles").filter(row => row.userId === "internal").length, 1);
  assert.equal(f.table("userRoleAuditLog").length, 1);
});

test("returning Google users are not backfilled or changed, including admins and users without a profile", async () => {
  for (const role of [undefined, "user", "admin", "super_admin"]) {
    const f = fixture();
    if (role) f.put("userAccessProfiles", { _id: "existing-profile", userId: "internal", platformRole: role, workRole: "Cuentas", updatedAt: 1 });
    const before = structuredClone([...f.rows]);
    await ensureDefaultRoleForNewInternalUser(f.ctx, { userId: "internal" as any, existingUserId: "internal" as any, providerId: "google" });
    assert.deepEqual([...f.rows], before);
  }
});

test("signup initialization preserves every existing profile even if retried as a new account", async () => {
  for (const role of ["user", "admin", "super_admin"]) {
    const f = fixture();
    f.put("userAccessProfiles", { _id: "existing-profile", userId: "internal", platformRole: role, workRole: "Diseño", updatedAt: 1 });
    const before = structuredClone([...f.rows]);
    await ensureDefaultRoleForNewInternalUser(f.ctx, { userId: "internal" as any, existingUserId: null, providerId: "google" });
    assert.deepEqual([...f.rows], before);
  }
});

test("external OTP and other providers never initialize an internal role", async () => {
  const f = fixture();
  const before = structuredClone([...f.rows]);
  for (const providerId of ["external-email-otp", "email", "other"]) {
    for (const userId of ["internal", "external"]) {
      await ensureDefaultRoleForNewInternalUser(f.ctx, { userId: userId as any, existingUserId: null, providerId });
    }
  }
  assert.deepEqual([...f.rows], before);
});

test("Google signup does not initialize externals identified by account or preapproved email", async () => {
  for (const linked of [true, false]) {
    const f = fixture();
    if (!linked) delete f.rows.get("approved").userId;
    f.rows.get("external").email = " External@Example.COM ";
    const before = structuredClone([...f.rows]);
    await ensureDefaultRoleForNewInternalUser(f.ctx, { userId: "external" as any, existingUserId: null, providerId: "google" });
    assert.deepEqual([...f.rows], before);
  }
});

test("signup initialization never creates a role for a missing user account", async () => {
  const f = fixture();
  const before = structuredClone([...f.rows]);
  await ensureDefaultRoleForNewInternalUser(f.ctx, { userId: "missing" as any, existingUserId: null, providerId: "google" });
  assert.deepEqual([...f.rows], before);
});
