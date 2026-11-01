import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import { getDashboard, setExternalBoardEnabled } from "../convex/data/clientAdmin";
import { syncClientsFromCOR } from "../convex/data/clientAdminActions";
import { hasPlatformAdminAccess } from "../convex/data/userAccess";
import { getClientByCorId, upsertClient } from "../convex/data/corClients";
import { backfillCorClients } from "../convex/data/backfill";
import { hasExternalRequestsAccess, canViewExternalRequest } from "../convex/lib/externalRequestsAccess";
import { canReceiveTaskCreation } from "../convex/lib/taskCreationNotifications";

function fixture() {
  const rows = new Map<string, any>();
  const puts: string[] = [];
  let actor: string | null = "admin";
  let sequence = 0;
  const put = (table: string, row: any) => { rows.set(row._id, { _table: table, ...row }); return row._id; };
  put("users", { _id: "admin", email: "admin@example.com" });
  put("userAccessProfiles", { _id: "admin-role", userId: "admin", platformRole: "admin" });
  put("users", { _id: "external", email: "external@example.com" });
  put("approvedExternalUsers", { _id: "approved", userId: "external", email: "external@example.com", isCoordinator: true });
  put("users", { _id: "internal", email: "internal@example.com" });
  put("corClients", { _id: "client", corClientId: 101, name: "Cliente", nomenclature: "CLI", syncedAt: 1 });
  put("clientBrands", { _id: "brand", clientId: "client" });
  put("clientUserAssignments", { _id: "assignment", userId: "external", clientId: "client", brandId: "brand" });
  put("tasks", { _id: "task", source: "external", createdBy: "other", clientId: "client", clientBrandId: "brand" });
  const ctx: any = {
    auth: { getUserIdentity: async () => actor ? { subject: actor + "|session" } : null },
    db: {
      get: async (id: string) => rows.get(id) ?? null,
      insert: async (table: string, value: any) => { puts.push("insert:" + table); return put(table, { _id: "generated-" + ++sequence, ...value }); },
      patch: async (id: string, value: any) => {
        puts.push("patch:" + id);
        assert.ok(rows.has(id));
        for (const [key, val] of Object.entries(value)) { if (val === undefined) delete rows.get(id)[key]; else rows.get(id)[key] = val; }
      },
      query: (table: string) => {
        const filters: Array<(row: any) => boolean> = [];
        const builder: any = { eq: (key: string, value: any) => { filters.push(row => row[key] === value); return builder; } };
        const selected = () => [...rows.values()].filter(row => row._table === table && filters.every(f => f(row)));
        const q: any = { withIndex: (_: string, build: any) => { build(builder); return q; }, collect: async () => selected(), unique: async () => { assert.ok(selected().length <= 1); return selected()[0] ?? null; } };
        return q;
      },
    },
  };
  const call = (fn: any, args: any = {}) => fn._handler(ctx, args);
  ctx.runQuery = async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    if (name === "data/userAccess:hasPlatformAdminAccess") return call(hasPlatformAdminAccess, args);
    if (name === "data/corClients:getClientByCorId") return call(getClientByCorId, args);
    throw Error("Unexpected query: " + name);
  };
  ctx.runMutation = async (ref: any, args: any) => {
    assert.equal(getFunctionName(ref), "data/corClients:upsertClient");
    return call(upsertClient, args);
  };
  ctx.runAction = async (ref: any, args: any) => {
    assert.equal(getFunctionName(ref), "data/backfill:backfillCorClients");
    return call(backfillCorClients, args);
  };
  return { ctx, rows, put, puts, call, as: (userId: string | null) => { actor = userId; } };
}

test("client administration rejects anonymous, ordinary internal and external callers", async () => {
  const f = fixture();
  const before = structuredClone([...f.rows]);
  for (const userId of [null, "internal", "external"]) {
    f.as(userId);
    assert.deepEqual(await f.call(getDashboard), { canAccess: false });
    await assert.rejects(f.call(setExternalBoardEnabled, { clientId: "client", enabled: true }), /permisos/);
    await assert.rejects(f.call(syncClientsFromCOR), /permisos/);
  }
  f.put("userAccessProfiles", { _id: "invalid-external", userId: "external", platformRole: "super_admin" });
  assert.deepEqual(await f.call(getDashboard), { canAccess: false });
  f.rows.delete("invalid-external");
  assert.deepEqual([...f.rows], before);
  assert.deepEqual(f.puts, []);
});

test("admin/super_admin can list clients without populating unset board settings", async () => {
  const f = fixture();
  const before = structuredClone([...f.rows]);
  for (const role of ["admin", "super_admin"]) {
    f.rows.get("admin-role").platformRole = role;
    const result = await f.call(getDashboard);
    assert.equal(result.canAccess, true);
    assert.equal(result.clients[0].externalBoardEnabled, undefined);
    assert.equal(Object.hasOwn(f.rows.get("client"), "externalBoardEnabled"), false);
  }
  f.rows.get("admin-role").platformRole = "admin";
  assert.deepEqual([...f.rows], before);
  assert.deepEqual(f.puts, []);
});

test("board settings govern external visibility and creation notifications together while retaining assignment boundaries", async () => {
  const f = fixture();
  const task = f.rows.get("task");
  assert.equal(await hasExternalRequestsAccess(f.ctx, "external" as any), false);
  assert.equal(await canViewExternalRequest(f.ctx, "external" as any, task), false);
  assert.equal(await canReceiveTaskCreation(f.ctx, "external" as any, task), false);
  const assignments = structuredClone(f.rows.get("assignment"));
  await f.call(setExternalBoardEnabled, { clientId: "client", enabled: true });
  assert.equal(await hasExternalRequestsAccess(f.ctx, "external" as any), true);
  assert.equal(await canViewExternalRequest(f.ctx, "external" as any, task), true);
  assert.equal(await canReceiveTaskCreation(f.ctx, "external" as any, task), true);
  f.rows.get("assignment").brandId = "other-brand";
  assert.equal(await canViewExternalRequest(f.ctx, "external" as any, task), false);
  assert.equal(await canReceiveTaskCreation(f.ctx, "external" as any, task), false);
  f.rows.get("assignment").brandId = "brand";
  await f.call(setExternalBoardEnabled, { clientId: "client", enabled: false });
  assert.equal(await hasExternalRequestsAccess(f.ctx, "external" as any), false);
  assert.equal(await canReceiveTaskCreation(f.ctx, "external" as any, task), false);
  assert.deepEqual(f.rows.get("assignment"), assignments);
  assert.equal(f.rows.get("client")._id, "client");
  assert.equal(f.rows.get("client").syncedAt, 1);
  assert.equal(f.rows.get("task"), task);
});

test("upsert retains Convex ID, local board setting, nomenclature and all client references", async () => {
  for (const enabled of [undefined, false, true]) {
    const f = fixture();
    if (enabled !== undefined) f.rows.get("client").externalBoardEnabled = enabled;
    const references = [...f.rows.values()].filter(row => row.clientId === "client").map(row => structuredClone(row));
    const id = await f.call(upsertClient, { corClientId: 101, name: "Nombre actualizado", emailContact: "new@example.com" });
    assert.equal(id, "client");
    assert.equal(f.rows.get("client")._id, "client");
    assert.equal(f.rows.get("client").name, "Nombre actualizado");
    assert.equal(f.rows.get("client").externalBoardEnabled, enabled);
    assert.equal(f.rows.get("client").nomenclature, "CLI");
    assert.deepEqual([...f.rows.values()].filter(row => row.clientId === "client"), references);
    assert.deepEqual(f.puts, ["patch:client"]);
    const newId = await f.call(upsertClient, { corClientId: 202, name: "Nuevo cliente" });
    assert.notEqual(newId, "client");
    assert.equal(Object.hasOwn(f.rows.get(newId), "externalBoardEnabled"), false);
  }
});

test("manual sync runs the existing COR importer, updates in place and never seeds the board setting", async t => {
  const f = fixture();
  f.rows.get("client").externalBoardEnabled = true;
  const saved = { COR_API_KEY: process.env.COR_API_KEY, COR_CLIENT_SECRET: process.env.COR_CLIENT_SECRET };
  process.env.COR_API_KEY = "test";
  process.env.COR_CLIENT_SECRET = "test";
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = String(input);
    if (url.includes("/oauth/token")) return Response.json({ access_token: "test-token" });
    assert.ok(url.endsWith("/clients?page=false"));
    return Response.json([{ id: 101, name: "Cliente actualizado" }, { id: 202, name: "Cliente nuevo" }]);
  });
  try {
    const first = await f.call(syncClientsFromCOR);
    assert.equal(first.success, true);
    assert.equal(first.stats.created, 1);
    assert.equal(first.stats.updated, 1);
    assert.equal(f.rows.get("client").name, "Cliente actualizado");
    assert.equal(f.rows.get("client").externalBoardEnabled, true);
    const newClient = [...f.rows.values()].find(row => row._table === "corClients" && row.corClientId === 202);
    assert.equal(Object.hasOwn(newClient, "externalBoardEnabled"), false);
    const second = await f.call(syncClientsFromCOR);
    assert.equal(second.stats.created, 0);
    assert.equal(second.stats.updated, 2);
    assert.equal([...f.rows.values()].filter(row => row._table === "corClients").length, 2);
    assert.equal([...f.rows.values()].find(row => row.corClientId === 202)._id, newClient._id);
    assert.equal(f.rows.get("assignment").clientId, "client");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
