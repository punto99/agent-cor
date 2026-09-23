import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import * as sync from "../convex/data/corInboundSync";

const task = { _id: "task1", corTaskId: "11", corProjectId: 22, projectId: "project1", status: "en_proceso", corSyncStatus: "synced" };
const remoteTask = { id: 11, title: "Updated task", description: "Brief", deadline: "2026-10-01", priority: 2, status: "inProgress", project_id: 22 };
const remoteProject = { id: 22, name: "Updated project", brief: "Project brief", status: "active" };

function context() {
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
      return name.endsWith(":applyInboundTaskUpdate") ? { statusChanged: true, trelloFieldsChanged: true } : undefined;
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
    assert.equal(scheduled.scheduled.length, 1);
    // Also exercise a previously queued attachment worker: no import, existing Trello forwarding preserved.
    await (sync.pullTaskAttachmentsFromCORWorker as any)._handler(scheduled.ctx, scheduled.scheduled[0].args);
    assert.deepEqual(scheduled.actions, [{ name: "data/trello:syncClientAttachmentsFromCORToTrello", args: { taskId: "task1" } }]);
    assert.ok(requested.every(url => /\/oauth\/token|\/tasks\/11$|\/projects\/22$/.test(url)));
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
