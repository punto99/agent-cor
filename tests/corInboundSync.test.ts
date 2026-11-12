import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import * as sync from "../convex/data/corInboundSync";

const task = { _id: "task1", corTaskId: "11", corProjectId: 22, projectId: "project1", status: "en_proceso", corSyncStatus: "synced" };
const remoteTask = { id: 11, title: "Updated task", description: "Brief", deadline: "2026-10-01", priority: 2, status: "inProgress", project_id: 22 };
const remoteProject = { id: 22, name: "Updated project", brief: "Project brief", status: "active" };

function context({ changed = true, failAnalytics = false } = {}) {
  const mutations: any[] = [], actions: any[] = [], scheduled: any[] = [];
  const ctx: any = {
    runQuery: async (ref: any) => {
      const name = getFunctionName(ref);
      if (name === "data/tasks:getTaskByIdInternal" || name === "data/tasks:getTaskCORSyncSnapshotInternal") return task;
      if (name === "data/projects:getProjectInternal") return { _id: "project1", corProjectId: 22, status: "active", corSyncStatus: "synced" };
      throw new Error(`Unexpected query (including attachment reads): ${name}`);
    },
    runMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      assert.ok(!/Attachment/.test(name), `Unexpected attachment mutation: ${name}`);
      mutations.push({ name, args });
      if (name.endsWith(":applyInboundTaskUpdate")) {
        return { analyticsChanged: changed, statusChanged: changed, trelloFieldsChanged: changed };
      }
      if (name.endsWith(":applyInboundProjectUpdate")) return changed;
      if (name === "analytics/jobs:record") {
        if (failAnalytics) throw new Error("Analytics unavailable");
        return args.sourceIds.map((id: string) => "job-" + id);
      }
    },
    runAction: async (ref: any, args: any) => { actions.push({ name: getFunctionName(ref), args }); },
    scheduler: { runAfter: async (delay: number, ref: any, args: any) => { scheduled.push({ delay, name: getFunctionName(ref), args }); } },
  };
  return { ctx, mutations, actions, scheduled };
}

// Real COR provider with mocked HTTP: no live requests or credentials.
test("manual and scheduled pulls preserve task/project fields without reading COR attachments", async t => {
  const saved = { COR_API_KEY: process.env.COR_API_KEY, COR_CLIENT_SECRET: process.env.COR_CLIENT_SECRET };
  process.env.COR_API_KEY = "test"; process.env.COR_CLIENT_SECRET = "test";
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = String(input); requested.push(url);
    if (url.includes("/oauth/token")) return Response.json({ access_token: "test-token" });
    if (url.endsWith("/tasks/11")) return Response.json(remoteTask);
    if (url.endsWith("/projects/22")) return Response.json(remoteProject);
    throw new Error(`Unexpected HTTP request: ${url}`);
  });
  try {
    const manual = context();
    await (sync.pullFromCORAction as any)._handler(manual.ctx, { taskId: "task1" });
    const scheduled = context();
    await (sync.pullTaskFromCORWorker as any)._handler(scheduled.ctx, { taskId: "task1" });
    await (sync.pullProjectFromCORWorker as any)._handler(scheduled.ctx, { projectId: "project1" });
    for (const f of [manual, scheduled]) {
      assert.equal(f.mutations.find(m => m.name.endsWith(":applyInboundTaskUpdate"))?.args.corTitle, remoteTask.title);
      assert.equal(f.mutations.find(m => m.name.endsWith(":applyInboundProjectUpdate"))?.args.corName, remoteProject.name);
      assert.deepEqual(f.mutations.filter(m => m.name.endsWith(":enqueueTrelloOutboundSyncFromCOR")).map(m => m.args.kind), ["status", "fields"]);
    }
    for (const f of [manual, scheduled]) {
      assert.deepEqual(f.mutations.filter(m => m.name === "analytics/jobs:record").map(m => m.args.sourceIds), [["task1"], ["project1"]]);
      assert.deepEqual(f.scheduled.filter(s => s.name === "analytics/jobs:process").map(s => s.args.jobId), ["job-task1", "job-project1"]);
    }
    const attachments = scheduled.scheduled.filter(s => s.name.endsWith(":pullTaskAttachmentsFromCORWorker"));
    assert.equal(attachments.length, 1);
    // Also exercise a previously queued attachment worker: no import, existing Trello forwarding preserved.
    await (sync.pullTaskAttachmentsFromCORWorker as any)._handler(scheduled.ctx, attachments[0].args);
    assert.deepEqual(scheduled.actions, [{ name: "data/trello:syncClientAttachmentsFromCORToTrello", args: { taskId: "task1" } }]);
    assert.ok(requested.every(url => /\/oauth\/token|\/tasks\/11$|\/projects\/22$/.test(url)));

    const unchanged = context({ changed: false });
    await (sync.pullFromCORAction as any)._handler(unchanged.ctx, { taskId: "task1" });
    assert.ok(!unchanged.mutations.some(m => m.name === "analytics/jobs:record"));

    const unavailable = context({ failAnalytics: true });
    await (sync.pullFromCORAction as any)._handler(unavailable.ctx, { taskId: "task1" });
    assert.ok(unavailable.mutations.some(m => m.name.endsWith(":applyInboundProjectUpdate")));
    assert.deepEqual(unavailable.mutations.filter(m => m.name.endsWith(":enqueueTrelloOutboundSyncFromCOR")).map(m => m.args.kind), ["status", "fields"]);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("both cron entry points retain current/expired dispatch and the same workers", async () => {
  for (const [handler, mode] of [[sync.runScheduledInboundSyncAction, "current"], [sync.runScheduledExpiredInboundSyncAction, "expired"]] as const) {
    const f = context();
    f.ctx.runMutation = async () => ({ claimed: true, taskStatusIndex: 0, projectStatusIndex: 0, taskBucketCursors: {}, projectBucketCursors: {} });
    await (handler as any)._handler(f.ctx, {});
    assert.equal(f.scheduled.length, 1);
    assert.equal(f.scheduled[0].name, "data/corInboundSync:dispatchScheduledInboundSyncPage");
    assert.equal(f.scheduled[0].args.dateMode, mode);
  }
});

test("scheduled pulls narrow only the undated scan and preserve eligibility for both statuses", async () => {
  const dateKey = "2026-11-10";
  for (const { handler, table, dateField, corIdField, corId, finished } of [
    { handler: sync.listTasksForScheduledPull, table: "tasks", dateField: "deadline", corIdField: "corTaskId", corId: "11", finished: "finalizada" },
    { handler: sync.listProjectsForScheduledPull, table: "projects", dateField: "endDate", corIdField: "corProjectId", corId: 22, finished: "finished" },
  ]) {
    for (const convexStatus of ["active", undefined]) {
      const otherStatus = convexStatus === "active" ? undefined : "active";
      const eligible = { convexStatus, [corIdField]: corId, status: "open" };
      const docs: Record<string, unknown>[] = [
        { ...eligible, _id: "today", [dateField]: dateKey },
        { ...eligible, _id: "future", [dateField]: "2026-11-11" },
        { ...eligible, _id: "past", [dateField]: "2026-11-09" },
        { ...eligible, _id: "undated" },
        { ...eligible, _id: "empty", [dateField]: "" },
        { ...eligible, _id: "blank", [dateField]: " " },
        { ...eligible, _id: "finished", status: finished },
        { ...eligible, _id: "no-cor", [corIdField]: undefined },
        { ...eligible, _id: "syncing", corSyncStatus: "syncing" },
        { ...eligible, _id: "retrying", corSyncStatus: "retrying" },
        { ...eligible, _id: "other-status", convexStatus: otherStatus },
        { ...eligible, _id: "archived", convexStatus: "archived" },
        { ...eligible, _id: "deleted", convexStatus: "deleted" },
      ];
      for (const { dateMode, includeUndated, expected } of [
        { dateMode: "current", includeUndated: false, expected: ["today", "future"] },
        { dateMode: "current", includeUndated: true, expected: ["undated"] },
        { dateMode: "expired", includeUndated: false, expected: ["past"] },
      ]) {
        const paginationOpts = { cursor: "page-start", numItems: 100 };
        const ctx = {
          db: {
            query(tableName: string) {
              assert.equal(tableName, table);
              return {
                withIndex(indexName: string, range: (builder: unknown) => unknown) {
                  assert.equal(indexName, includeUndated ? `by_convexStatus_${dateField}` : "by_convexStatus");
                  const equalities: [string, unknown][] = [];
                  const builder = {
                    eq(field: string, value: unknown) {
                      equalities.push([field, value]);
                      return builder;
                    },
                  };
                  range(builder);
                  assert.deepEqual(equalities, includeUndated
                    ? [["convexStatus", convexStatus], [dateField, undefined]]
                    : [["convexStatus", convexStatus]]);
                  return {
                    order(direction: string) {
                      assert.equal(direction, "desc");
                      return {
                        async paginate(opts: unknown) {
                          assert.equal(opts, paginationOpts);
                          const page = docs.filter(doc => equalities.every(([field, value]) => doc[field] === value));
                          return { page, isDone: false, continueCursor: "page-end" };
                        },
                      };
                    },
                  };
                },
              };
            },
          },
        };
        const result = await (handler as any)._handler(ctx, { convexStatus, dateMode, dateKey, includeUndated, paginationOpts });
        assert.deepEqual(result.page.map((doc: { _id: string }) => doc._id), expected);
        assert.equal(result.isDone, false);
        assert.equal(result.continueCursor, "page-end");
      }
    }
  }
});
