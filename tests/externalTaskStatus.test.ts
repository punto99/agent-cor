import test from "node:test";
import assert from "node:assert/strict";
import { get } from "../convex/data/externalTaskStatus";
import { getExternalTaskStatusTool } from "../convex/tools/getExternalTaskStatusTool";
import { TASK_STATUS_OPTIONS } from "../convex/lib/taskStatuses";

function fixture(taskPatch: any = {}, assignmentPatch: any = {}) {
  const rows: any = {
    chatThreads: [{ _id: "chat1", threadId: "thread1", userId: "user1" }],
    approvedExternalUsers: [{ _id: "approved1", userId: "user1" }],
    tasks: [{ _id: "task1", threadId: "thread1", createdBy: "user1", clientId: "client1", source: "external", title: "Campaña", status: "nueva", description: "Private brief", corTaskId: "123", ...taskPatch }],
    clientUserAssignments: [{ _id: "assignment1", userId: "user1", clientId: "client1", ...assignmentPatch }],
  };
  // Deliberately no writes, scheduler, provider, or network operations.
  const ctx: any = { db: {
    get: async (id: string) => Object.values(rows).flat().find((r: any) => r._id === id) ?? null,
    normalizeId: (_: string, id: string) => id === "task1" ? id : null,
    query: (table: string) => {
      const filters: any[] = [];
      const builder: any = { eq: (key: string, value: any) => { filters.push((r: any) => r[key] === value); return builder; } };
      const selected = () => rows[table].filter((r: any) => filters.every(f => f(r)));
      const q: any = { withIndex: (_: string, build: any) => { build(builder); return q; }, collect: async () => selected(), first: async () => selected()[0] ?? null, unique: async () => selected()[0] ?? null };
      return q;
    },
  } };
  return { rows, call: (args: any = { threadId: "thread1" }) => (get as any)._handler(ctx, args) };
}

for (const trello of [false, true]) {
  test(`all published statuses, with Trello=${trello}`, async () => {
    for (const status of TASK_STATUS_OPTIONS) {
      const f = fixture({ status: status.value, ...(trello ? { clientBrandId: "brand1", trelloCardId: "card1" } : {}) }, trello ? { brandId: "brand1" } : {});
      const snapshot = structuredClone(f.rows);
      const result = await f.call();
      assert.equal(result.state, "recorded_status");
      assert.equal(result.status, status.name);
      assert.deepEqual(Object.keys(result).sort(), ["message", "ok", "state", "status", "title"]);
      assert.deepEqual(f.rows, snapshot);
    }
  });
  test(`unpublished task reports pending team review, with Trello=${trello}`, async () => {
    const f = fixture({ corTaskId: undefined, status: "en_revision", ...(trello ? { clientBrandId: "brand1", trelloCardId: "card1" } : {}) });
    const result = await f.call();
    assert.equal(result.state, "pending_review");
    assert.equal(result.status, undefined);
  });
}

test("unknown or absent stored status is not presented as a known state", async () => {
  for (const status of ["future_status", "", undefined]) {
    assert.equal((await fixture({ status }).call()).state, "unknown");
  }
});

test("explicit local ID still requires creator ownership and current client/category access", async () => {
  assert.equal((await fixture({ threadId: "original" }).call({ threadId: "thread1", taskId: "task1" })).ok, true);
  for (const [task, assignment] of [
    [{ createdBy: "other" }, {}], [{ source: "internal" }, {}], [{ convexStatus: "deleted" }, {}],
    [{ clientId: undefined }, {}], [{}, { clientId: "other" }], [{}, { userId: "other" }],
    [{}, { brandId: "brand1" }], [{ clientBrandId: "brand1" }, { brandId: "brand2" }],
  ]) {
    const result = await fixture(task, assignment).call({ threadId: "thread1", taskId: "task1" });
    assert.equal(result.ok, false); assert.equal(result.title, undefined);
  }
});

test("rejects missing thread, unapproved user, invalid ID, missing task and revoked assignment", async () => {
  for (const table of ["chatThreads", "approvedExternalUsers", "tasks", "clientUserAssignments"]) {
    const f = fixture(); f.rows[table] = [];
    assert.equal((await f.call()).ok, false);
  }
  assert.equal((await fixture().call({ threadId: "thread1", taskId: "bad-id" })).ok, false);
});

test("tool only calls the local query and does not invent a state on failure", async () => {
  let calls = 0;
  const tool: any = Object.assign({}, getExternalTaskStatusTool, { ctx: { threadId: "thread1", runQuery: async (_: any, args: any) => {
    calls++; assert.deepEqual(args, { threadId: "thread1", taskId: undefined });
    return { ok: true, state: "recorded_status", title: "Campaña", status: "Ajustes" };
  } } });
  assert.equal(JSON.parse(await tool.execute({}, {})).status, "Ajustes");
  assert.equal(calls, 1);
  tool.ctx.runQuery = async () => { throw Error("unavailable"); };
  const error = JSON.parse(await tool.execute({}, {}));
  assert.equal(error.ok, false); assert.equal(error.state, undefined);
});
