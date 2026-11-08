import assert from "node:assert/strict";
import test from "node:test";
import { getFunctionName } from "convex/server";
import { analyticsDay, analyticsPeriod, analyticsTrendPeriods, shiftAnalyticsPeriod } from "../convex/analytics/calendar";
import {
  backfill, backfillStatus, beginScan, previewLegacyDeliverables, previewPage, previewProjectShares,
  reconcilePage, refreshAttention,
} from "../convex/analytics/maintenance";
import { failure, nightly, nightlyBatch, process, processPage, record } from "../convex/analytics/jobs";
import { notifyAnalytics } from "../convex/analytics/notify";
import { getDashboard, getPeriodDashboard } from "../convex/data/analytics";
import { attachProjectToExistingCORProject } from "../convex/data/projects";
import { updateTaskFields } from "../convex/data/tasks";
import { projectDeliverableShard } from "../convex/lib/deliverableAnalytics";
import { clientConfig } from "../config/tenant.config";

const sourceTables = new Set(["tasks", "projects", "taskEvaluations"]);

function fixture() {
  const rows = new Map<string, any>();
  const tableById = new Map<string, string>();
  let sequence = 0;
  let user = "admin";
  let writes = 0;
  let allowOperationalWrites = false;
  const put = (table: string, doc: any) => {
    tableById.set(doc._id, table);
    rows.set(doc._id, { _creationTime: ++sequence, ...doc, _table: table });
  };
  put("users", { _id: "admin", name: "Admin" });
  put("users", { _id: "requester", name: "Solicitante" });
  put("userAccessProfiles", { _id: "admin-role", userId: "admin", platformRole: "admin" });
  put("corClients", { _id: "client", name: "Cliente A" });
  put("clientBrands", { _id: "brand", name: "Marca A" });
  put("subBrands", { _id: "subBrand", name: "Submarca A" });

  const indexedOrder: Record<string, string> = {
    by_rank: "count",
    by_period_kind_created: "task.createdAt",
    by_next_attention_day: "nextAttentionDay",
    by_updatedAt: "updatedAt",
    by_pending_since: "pendingSince",
  };
  const ctx: any = {
    auth: { getUserIdentity: async () => ({ subject: `${user}|session` }) },
    db: {
      normalizeId: (table: string, id: string) => tableById.get(id) === table ? id : null,
      get: async (idOrTable: string, id?: string) => rows.get(id ?? idOrTable) ?? null,
      insert: async (table: string, value: any) => {
        assert.ok(table.startsWith("analytics"), `Unexpected insert into ${table}`);
        writes++;
        const id = `insert-${sequence + 1}`;
        put(table, { ...value, _id: id });
        return id;
      },
      patch: async (id: string, value: any) => {
        assert.ok(allowOperationalWrites || rows.get(id)?._table.startsWith("analytics"));
        writes++;
        Object.assign(rows.get(id), value);
      },
      replace: async (id: string, value: any) => {
        assert.ok(rows.get(id)?._table.startsWith("analytics"));
        writes++;
        const { _table, _creationTime } = rows.get(id);
        rows.set(id, { ...value, _id: id, _creationTime, _table });
      },
      delete: async (id: string) => {
        assert.ok(allowOperationalWrites || rows.get(id)?._table.startsWith("analytics"));
        writes++;
        rows.delete(id);
      },
      query: (table: string) => {
        const filters: Array<(row: any) => boolean> = [];
        let descending = false;
        let indexKey = "_creationTime";
        const get = (row: any, field: string) => field.split(".").reduce((doc, key) => doc?.[key], row);
        const compare = (a: any, b: any) => a === b ? 0
          : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
        const filter = (op: (a: any, b: any) => boolean) => (field: string, value: any) => {
          filters.push((row) => op(get(row, field), value));
          return range;
        };
        const range = {
          eq: filter((a, b) => a === b),
          gt: filter((a, b) => compare(a, b) > 0),
          gte: filter((a, b) => compare(a, b) >= 0),
          lt: filter((a, b) => compare(a, b) < 0),
          lte: filter((a, b) => compare(a, b) <= 0),
        };
        const selected = () => [...rows.values()]
          .filter((row) => row._table === table && filters.every((predicate) => predicate(row)))
          .sort((a, b) => (descending ? -1 : 1) * compare(get(a, indexKey), get(b, indexKey)));
        const query: any = {
          withIndex: (index: string, apply?: (builder: typeof range) => void) => {
            apply?.(range);
            indexKey = indexedOrder[index] ?? "_creationTime";
            return query;
          },
          order: (direction: string) => { descending = direction === "desc"; return query; },
          unique: async () => {
            const matches = selected();
            assert.ok(matches.length <= 1, `Duplicate row in ${table}`);
            return matches[0] ?? null;
          },
          first: async () => selected()[0] ?? null,
          collect: async () => selected(),
          take: async (limit: number) => selected().slice(0, limit),
          paginate: async ({ cursor, numItems }: { cursor: string | null; numItems: number }) => {
            const remaining = selected().filter((row) => !cursor || row._creationTime > Number(cursor));
            const page = remaining.slice(0, numItems);
            return {
              page,
              isDone: remaining.length <= numItems,
              continueCursor: String(page.at(-1)?._creationTime ?? cursor),
            };
          },
        };
        return query;
      },
    },
  };
  const functions = { beginScan, reconcilePage, previewPage, previewLegacyDeliverables, previewProjectShares,
    backfillStatus, refreshAttention, failure, nightlyBatch, process, processPage, record };
  const call = (fn: any, args: any = {}) => fn._handler(ctx, args);
  const callOperational = async (fn: any, args: any) => {
    allowOperationalWrites = true;
    try { return await call(fn, args); }
    finally { allowOperationalWrites = false; }
  };
  const run = (ref: Parameters<typeof getFunctionName>[0], args: any) => {
    const name = getFunctionName(ref).split(":").at(-1) as keyof typeof functions;
    return call(functions[name], args);
  };
  ctx.runQuery = run;
  ctx.runMutation = run;
  const scheduled: (() => Promise<unknown>)[] = [];
  ctx.scheduler = { runAfter: async (_delay: number, ref: Parameters<typeof run>[0], args: any) => {
    scheduled.push(() => run(ref, args));
  } };
  const drain = async () => {
    while (scheduled.length) await scheduled.shift()!();
  };
  const readDashboard = async (periodType: string, periodKey: string) => {
    const query = ctx.db.query;
    ctx.db.query = (table: string) => {
      assert.ok(!sourceTables.has(table), `Dashboard read operational table ${table}`);
      return query(table);
    };
    try {
      return await call(getPeriodDashboard, { periodType, periodKey, today: "2026-11-05" });
    } finally {
      ctx.db.query = query;
    }
  };
  return { ctx, put, rows, call, callOperational, drain, readDashboard, writes: () => writes, as: (id: string) => { user = id; } };
}

const october = Date.parse("2026-10-15T13:00:00Z");
const november = Date.parse("2026-11-04T13:00:00Z");

test("analytics calendar follows Ecuador midnight and handles period boundaries", () => {
  assert.equal(analyticsDay(Date.parse("2026-01-01T04:59:59Z")), "2025-12-31");
  assert.equal(analyticsDay(Date.parse("2026-01-01T05:00:00Z")), "2026-01-01");
  assert.deepEqual(analyticsPeriod("week", "2026-01-01"), { periodType: "week", periodKey: "2025-12-29" });
  assert.equal(shiftAnalyticsPeriod(analyticsPeriod("month", "2026-12-31"), 1), "2027-01-01");
  assert.equal(analyticsTrendPeriods(analyticsPeriod("month", "2024-02-15"), "2026-11-05").length, 29);
});

test("the creation trend preserves totals and splits task sources in every period", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-05T14:00:00Z") });
  const f = fixture();
  f.put("tasks", { _id: "internal", _creationTime: november, title: "Interna", status: "nueva" });
  f.put("tasks", { _id: "external", _creationTime: november, title: "Externa", status: "nueva", source: "external" });
  const legacy = await f.call(getDashboard);
  const nonEmptyLegacyBuckets = legacy.weeklyTrend.filter((point: { count: number }) => point.count);
  assert.equal(nonEmptyLegacyBuckets.length, 1);
  assert.equal(nonEmptyLegacyBuckets[0].count, 2);
  assert.equal(nonEmptyLegacyBuckets[0].internal, 1);
  assert.equal(nonEmptyLegacyBuckets[0].external, 1);

  await f.call(backfill, { dryRun: false });
  for (const [periodType, periodKey, bucket] of [
    ["day", "2026-11-04", "2026-11-04"],
    ["week", "2026-11-02", "2026-11-04"],
    ["month", "2026-11-01", "2026-11-04"],
    ["year", "2026-01-01", "2026-11-01"],
    ["all", "all", "2026-11-02"],
  ]) {
    const dashboard = await f.readDashboard(periodType, periodKey);
    assert.deepEqual(dashboard.weeklyTrend.filter((point: { count: number }) => point.count), [
      { week: bucket, count: 2, internal: 1, external: 1 },
    ]);
    assert.ok(dashboard.weeklyTrend.every(
      (point: { count: number; internal: number; external: number }) => point.count === point.internal + point.external,
    ));
  }
});

test("backfill previews without writes, publishes when finished and reconciles edits without duplicates", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-05T14:00:00Z") });
  const f = fixture();
  f.put("tasks", { _id: "task-a", _creationTime: october, title: "Tarea de octubre",
    status: "en_proceso", deadline: "2026-01-01", createdBy: "admin", source: "external",
    clientId: "client", clientBrandId: "brand", strategicPriority: "I_U", corSyncStatus: "pending" });
  f.put("tasks", { _id: "task-b", _creationTime: november, title: "Tarea de noviembre", status: "nueva" });
  f.put("projects", { _id: "project", _creationTime: october, name: "Proyecto",
    status: "active", deliverables: 5, clientId: "client", clientBrandId: "brand", subBrandId: "subBrand" });
  f.put("projects", { _id: "archived", _creationTime: october, name: "Archivado", status: "active",
    deliverables: 99, convexStatus: "archived" });
  for (const [id, createdAt, status] of [
    ["a", october, "completed"], ["b", october, "completed"], ["c", november, "completed"],
  ] as const) f.put("taskEvaluations", {
    _id: id, taskId: "task-a", evaluationThreadId: "same-thread", createdAt, status, requestedBy: "requester",
  });

  const preview = await f.call(backfill, { dryRun: true, maxBatches: 1 });
  assert.equal(preview.complete, false);
  assert.deepEqual(preview.resume, { table: "projects", cursor: null });
  const resumed = await f.call(backfill, { dryRun: true, resume: preview.resume });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.deliverables, 5);
  assert.equal(resumed.stats.taskEvaluations.eligible, 3);
  assert.equal(f.writes(), 0);
  assert.deepEqual(await f.readDashboard("all", "all"), { canAccess: true, ready: false });

  const partial = await f.call(backfill, { dryRun: false, maxBatches: 1 });
  assert.equal(partial.status, "running");
  assert.equal(partial.published, false);
  assert.equal(partial.phase, "projects");
  const done = await f.call(backfill, { dryRun: false });
  assert.equal(done.status, "complete");
  assert.equal(done.scanned.tasks, 2);

  const octoberDashboard = await f.readDashboard("month", "2026-10-01");
  assert.equal(octoberDashboard.summary.tasks, 1);
  assert.equal(octoberDashboard.summary.projects, 1);
  assert.equal(octoberDashboard.summary.pendingCorTasks, 1);
  assert.equal(octoberDashboard.summary.evaluatedTasks, 1);
  assert.equal(octoberDashboard.evaluations.total, 2);
  assert.equal(octoberDashboard.evaluationsByUser[0].name, "Solicitante");
  assert.equal(octoberDashboard.attention.overdue[0]._id, "task-a");
  assert.equal(octoberDashboard.deliverables.byClient[0].brands[0].subBrands[0].deliverablesTotal, 5);
  const all = await f.readDashboard("all", "all");
  assert.equal(all.evaluations.total, 3);
  assert.equal(all.summary.evaluatedTasks, 1);
  assert.equal((await f.readDashboard("month", "2026-09-01")).summary.tasks, 0);

  assert.equal((await f.call(backfill, { dryRun: false })).scanned.changed, 0);

  f.put("tasks", { _id: "task-c", _creationTime: Date.now(), title: "Tarea nueva", status: "nueva" });
  await notifyAnalytics(f.ctx, ["task-c" as any]);
  await f.drain();
  assert.equal((await f.readDashboard("day", "2026-11-05")).summary.tasks, 1);
  assert.equal((await f.readDashboard("all", "all")).summary.tasks, 3);

  f.rows.get("task-a").status = "finalizada";
  f.rows.get("task-a").corSyncStatus = "synced";
  f.rows.get("a").status = "failed";
  f.rows.delete("project");
  await f.call(backfill, { dryRun: false });
  const updated = await f.readDashboard("month", "2026-10-01");
  assert.equal(updated.summary.tasks, 1);
  assert.equal(updated.summary.projects, 0);
  assert.equal(updated.summary.pendingCorTasks, 0);
  assert.equal(updated.statusCounts.find((item: any) => item.key === "finalizada").count, 1);
  assert.equal(updated.summary.evaluatedTasks, 1);
  assert.equal(updated.summary.deliverables, 0);
  assert.deepEqual(updated.attention.overdue, []);
  f.rows.delete("b");
  await f.call(backfill, { dryRun: false });
  assert.equal((await f.readDashboard("month", "2026-10-01")).summary.evaluatedTasks, 0);
  assert.equal((await f.readDashboard("all", "all")).summary.evaluatedTasks, 1);

  f.as("requester");
  assert.deepEqual(await f.readDashboard("all", "all"), { canAccess: false });
});

test("attention moves into due soon and then overdue without rewriting the task", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-05T14:00:00Z") });
  const f = fixture();
  f.put("tasks", { _id: "task", _creationTime: october, title: "Tarea",
    status: "nueva", deadline: "2026-11-13" });
  await f.call(backfill, { dryRun: false });
  assert.deepEqual((await f.readDashboard("all", "all")).attention.dueSoon, []);
  t.mock.timers.setTime(Date.parse("2026-11-06T05:00:00Z"));
  await f.call(refreshAttention);
  assert.equal((await f.readDashboard("all", "all")).attention.dueSoon[0]._id, "task");
  t.mock.timers.setTime(Date.parse("2026-11-14T05:00:00Z"));
  await f.call(refreshAttention);
  const { dueSoon, overdue } = (await f.readDashboard("all", "all")).attention;
  assert.deepEqual(dueSoon, []);
  assert.equal(overdue[0]._id, "task");
});

test("dry run reconciles stored deliverables and explains source exclusions without writing", async () => {
  const f = fixture();
  const excludedCreator = clientConfig.excludedUserIds[0];
  f.put("tasks", { _id: "deleted-task", _creationTime: october, title: "Eliminada", status: "nueva",
    createdBy: excludedCreator, convexStatus: "deleted" });
  f.put("taskEvaluations", { _id: "evaluation", taskId: "deleted-task", evaluationThreadId: "thread",
    createdAt: october, requestedBy: excludedCreator, status: "completed" });
  for (const [id, deliverables, convexStatus] of [
    ["project", 5, "active"], ["archived-project", 3, "archived"], ["deleted-project", 2, "deleted"],
  ] as const) {
    f.put("projects", { _id: id, _creationTime: october, name: id, status: "active", convexStatus, deliverables });
  }
  const shard = projectDeliverableShard("project");
  f.put("deliverableAnalyticsRollups", { _id: "rollup", scope: "global", shard,
    deliverablesTotal: 12, projectCount: 4 });

  const result = await f.call(backfill, { dryRun: true });
  assert.deepEqual(result.stats.projects, { scanned: 3, eligible: 1 });
  assert.deepEqual(result.diagnostics.exclusions.projects.byPrimaryReason, { archived: 1, deleted: 1 });
  assert.deepEqual(result.diagnostics.exclusions.tasks.byPrimaryReason, { deleted: 1 });
  assert.deepEqual(result.diagnostics.exclusions.tasks.examples[0].reasons, ["deleted", "excludedCreator"]);
  assert.deepEqual(result.diagnostics.exclusions.taskEvaluations.examples[0].reasons,
    ["excludedRequester", "taskDeleted", "excludedTaskCreator"]);
  const { recorded, projected, ignoredByReason, comparison } = result.diagnostics.deliverables;
  assert.deepEqual(recorded, { projects: 3, deliverables: 10 });
  assert.deepEqual(projected, { projects: 1, deliverables: 5 });
  assert.deepEqual(ignoredByReason, {
    archived: { projects: 1, deliverables: 3 },
    deleted: { projects: 1, deliverables: 2 },
  });
  assert.deepEqual(comparison.legacyMinusProjected, { projects: 3, deliverables: 7 });
  assert.equal(comparison.shardDifferences[0].shard, shard);
  assert.equal(f.writes(), 0);
});

test("only supported statuses contribute and archiving removes existing analytics", async () => {
  const f = fixture();
  f.put("tasks", { _id: "task", _creationTime: october, title: "Tarea", status: "finalizada" });
  f.put("tasks", { _id: "unknown-task", _creationTime: october, title: "Otra", status: "unknown" });
  f.put("projects", { _id: "project", _creationTime: october, name: "Proyecto", status: "suspended", deliverables: 5 });
  f.put("projects", { _id: "unknown-project", _creationTime: october, name: "Otro", status: "unknown", deliverables: 10 });
  f.put("taskEvaluations", { _id: "evaluation", taskId: "task", evaluationThreadId: "thread",
    createdAt: november, status: "completed" });
  await f.call(backfill, { dryRun: false });
  const before = await f.readDashboard("all", "all");
  assert.equal(before.summary.tasks, 1);
  assert.equal(before.summary.projects, 1);
  assert.equal(before.summary.evaluatedTasks, 1);
  assert.equal(before.summary.deliverables, 5);

  f.rows.get("task").convexStatus = "archived";
  f.rows.get("project").convexStatus = "archived";
  const preview = await f.call(backfill, { dryRun: true });
  assert.deepEqual(preview.diagnostics.exclusions.tasks.byPrimaryReason, { archived: 1, unsupportedStatus: 1 });
  assert.deepEqual(preview.diagnostics.exclusions.projects.byPrimaryReason, { archived: 1, unsupportedStatus: 1 });
  assert.deepEqual(preview.diagnostics.exclusions.taskEvaluations.byPrimaryReason, { taskArchived: 1 });
  await f.call(backfill, { dryRun: false });
  const after = await f.readDashboard("all", "all");
  assert.equal(after.summary.tasks, 0);
  assert.equal(after.summary.projects, 0);
  assert.equal(after.summary.evaluatedTasks, 0);
  assert.equal(after.summary.deliverables, 0);
  assert.equal((await f.readDashboard("month", "2026-10-01")).summary.tasks, 0);
  assert.equal((await f.readDashboard("month", "2026-11-01")).evaluations.total, 0);
});


test("nightly recovers missed notifications, failed scheduling and archived tasks with evaluations", async (t) => {
  const edited = Date.parse("2026-11-05T14:00:00Z");
  const clock = t.mock.timers;
  clock.enable({ apis: ["Date"], now: new Date(edited) });
  const f = fixture();
  f.put("tasks", { _id: "task", _creationTime: october, title: "Tarea", status: "nueva" });
  f.put("projects", { _id: "project", _creationTime: october, name: "Proyecto", status: "active", deliverables: 5 });
  f.put("projects", { _id: "replaced", _creationTime: october, name: "Reemplazado", status: "active", deliverables: 2 });
  f.put("taskEvaluations", { _id: "evaluation", taskId: "task", evaluationThreadId: "thread",
    createdAt: october, updatedAt: october, status: "completed" });
  await f.call(backfill, { dryRun: false });

  f.rows.get("task").convexStatus = "archived";
  f.rows.get("task").updatedAt = edited;
  f.rows.get("task").replacedProjectIds = ["replaced"];
  f.rows.delete("replaced");
  f.rows.get("project").deliverables = 8;
  f.rows.get("project").updatedAt = edited;

  const runAfter = f.ctx.scheduler.runAfter;
  f.ctx.scheduler.runAfter = async () => { throw new Error("Scheduler unavailable"); };
  await notifyAnalytics(f.ctx, ["project" as any]);
  const pending = [...f.rows.values()].find(row => row._table === "analyticsPending");
  assert.equal(pending.lastFailure, "schedule");
  assert.equal(f.rows.get("project").deliverables, 8);
  assert.equal((await f.readDashboard("all", "all")).summary.deliverables, 7);

  f.ctx.scheduler.runAfter = runAfter;
  clock.setTime(Date.parse("2026-11-06T05:10:00Z"));
  await f.call(nightly);
  await f.drain();
  const dashboard = await f.readDashboard("all", "all");
  assert.equal(dashboard.summary.tasks, 0);
  assert.equal(dashboard.summary.evaluatedTasks, 0);
  assert.equal(dashboard.summary.projects, 1);
  assert.equal(dashboard.summary.deliverables, 8);
  assert.equal([...f.rows.values()].filter(row => row._table === "analyticsPending").length, 0);
});

test("publishing a new task into an older project keeps its dated deliverables and removes the draft", async () => {
  const f = fixture();
  const taxonomy = { clientId: "client", clientBrandId: "brand", subBrandId: "subBrand" };
  f.put("projects", { _id: "original", _creationTime: october, name: "Proyecto anterior", status: "active",
    corProjectId: 101, deliverables: 5, ...taxonomy });
  f.put("projects", { _id: "draft", _creationTime: november, name: "Borrador", status: "active",
    deliverables: 2, deliverablesCoveredByTasks: 2, ...taxonomy });
  f.put("tasks", { _id: "new-task", _creationTime: november, title: "Tarea nueva", status: "nueva",
    projectId: "draft", deliverablesCount: 2, projectDeliverableAllocation: { amount: 2, trackedOnProject: true },
    ...taxonomy });
  await f.call(backfill, { dryRun: false });
  assert.equal((await f.readDashboard("all", "all")).summary.deliverables, 7);
  assert.equal((await f.readDashboard("month", "2026-11-01")).summary.deliverables, 2);

  await f.callOperational(attachProjectToExistingCORProject, {
    projectId: "draft", taskId: "new-task", corProjectId: 101, deliverables: 7, taskDeliverablesIncluded: 2,
  });
  assert.equal(f.rows.get("new-task").projectId, "original");
  assert.equal(f.rows.get("original").deliverablesCoveredByTasks, 2);
  assert.equal(f.rows.has("draft"), false);

  // Process the older project first, as independent jobs can run out of order.
  for (const sourceId of ["original", "draft", "new-task", "original", "new-task"]) {
    await notifyAnalytics(f.ctx, [sourceId as any]);
    await f.drain();
    assert.equal((await f.readDashboard("all", "all")).summary.deliverables, 7);
  }
  const octoberDashboard = await f.readDashboard("month", "2026-10-01");
  const novemberDashboard = await f.readDashboard("month", "2026-11-01");
  const historical = await f.readDashboard("all", "all");
  assert.equal(octoberDashboard.summary.deliverables, 5);
  assert.equal(novemberDashboard.summary.deliverables, 2);
  assert.equal(novemberDashboard.summary.tasks, 1);
  assert.equal(novemberDashboard.summary.projects, 0);
  assert.equal(novemberDashboard.deliverables.projectCount, 1);
  assert.equal(historical.summary.projects, 1);
  assert.equal(historical.deliverables.projectCount, 1);
  assert.equal(historical.deliverables.byClient[0].brands[0].subBrands[0].deliverablesTotal, 7);
  assert.equal(historical.deliverables.byClient[0].brands[0].subBrands[0].projectCount, 1);

  const dryRun = await f.call(backfill, { dryRun: true });
  assert.equal(dryRun.deliverables, 7);
  assert.deepEqual(dryRun.diagnostics.deliverables.attribution, {
    taskDeliverables: 2, taskDeliverablesWithoutEligibleProject: 0,
    projectRemainder: 5, projectsWithRemainder: 1,
    remainderExamples: [{ projectId: "original", day: "2026-10-15", deliverables: 5 }],
    projectsWithExcessShares: 0, excessExamples: [],
  });
});

test("editing task quantities adjusts a shared project by delta and preserves its dated remainder", async (t) => {
  for (const tracked of [undefined, false, true]) {
    await t.test(`allocation trackedOnProject=${tracked}`, async () => {
      const f = fixture();
      f.put("projects", { _id: "project", _creationTime: october, name: "Compartido", status: "active",
        deliverables: 7, ...(tracked === true ? { deliverablesCoveredByTasks: 5 } : {}) });
      for (const [id, count] of [["first", 2], ["second", 3]] as const) {
        f.put("tasks", { _id: id, _creationTime: november, title: id, status: "nueva", createdBy: "admin",
          projectId: "project", deliverablesCount: count,
          ...(tracked !== undefined ? { projectDeliverableAllocation: { amount: count, trackedOnProject: tracked } } : {}) });
      }
      await f.call(backfill, { dryRun: false });
      for (const [taskId, quantity, projectTotal, taskTotal] of [
        ["first", 5, 10, 8],
        ["second", 1, 8, 6],
        ["first", 5, 8, 6], // Repeating a save must not add the delta again.
        ["first", 1, 4, 2],
      ] as const) {
        await f.callOperational(updateTaskFields, { taskId, updates: { deliverablesCount: quantity } });
        assert.equal(f.rows.get("project").deliverables, projectTotal);
        assert.equal(f.rows.get(taskId).deliverablesCount, quantity);
        if (tracked === true) assert.equal(f.rows.get("project").deliverablesCoveredByTasks, taskTotal);
        // Independent analytics jobs may process the project before its task.
        await notifyAnalytics(f.ctx, ["project", taskId] as any);
        await f.drain();
        assert.equal((await f.readDashboard("month", "2026-10-01")).summary.deliverables, 2);
        assert.equal((await f.readDashboard("month", "2026-11-01")).summary.deliverables, taskTotal);
        assert.equal((await f.readDashboard("all", "all")).summary.deliverables, projectTotal);
        const preview = await f.call(backfill, { dryRun: true });
        assert.equal(preview.deliverables, projectTotal);
        assert.equal(preview.diagnostics.deliverables.attribution.projectRemainder, 2);
        assert.equal(preview.diagnostics.deliverables.attribution.projectsWithExcessShares, 0);
      }
    });
  }
});

test("task corrections and exclusions do not reappear in the project remainder", async () => {
  const f = fixture();
  f.put("projects", { _id: "project", _creationTime: october, name: "Histórico", status: "active", deliverables: 7 });
  f.put("tasks", { _id: "active", _creationTime: november, title: "Tarea nueva", status: "nueva",
    projectId: "project", deliverablesCount: 2 });
  f.put("tasks", { _id: "archived", _creationTime: november, title: "Archivada", status: "nueva",
    projectId: "project", deliverablesCount: 3, convexStatus: "archived" });
  const preview = await f.call(backfill, { dryRun: true });
  assert.equal(preview.deliverables, 4);
  assert.equal(preview.diagnostics.deliverables.attribution.projectRemainder, 2);
  assert.equal(f.writes(), 0);

  await f.call(backfill, { dryRun: false });
  assert.equal((await f.readDashboard("all", "all")).summary.deliverables, 4);
  const task = f.rows.get("active");
  task.projectDeliverableAllocation = { amount: 2, trackedOnProject: false };
  task.deliverablesCount = 1;
  await notifyAnalytics(f.ctx, ["active" as any]);
  await f.drain();
  assert.equal((await f.readDashboard("month", "2026-10-01")).summary.deliverables, 2);
  assert.equal((await f.readDashboard("month", "2026-11-01")).summary.deliverables, 1);
  assert.equal((await f.readDashboard("all", "all")).summary.deliverables, 3);

  task.convexStatus = "deleted";
  await notifyAnalytics(f.ctx, ["active" as any]);
  await f.drain();
  assert.equal((await f.readDashboard("month", "2026-11-01")).summary.deliverables, 0);
  assert.equal((await f.readDashboard("all", "all")).summary.deliverables, 2);
  assert.equal((await f.call(backfill, { dryRun: true })).deliverables, 2);
});

test("existing dashboards keep their published deliverables until the dated backfill completes", async () => {
  const f = fixture();
  f.put("analyticsState", { _id: "published", key: "published", publishedAt: october });
  f.put("analyticsState", { _id: "scan", key: "scan", phase: "projects", cursor: null,
    lastCompletedAt: october, stats: { tasks: 1, projects: 0, taskEvaluations: 0, cleanup: 0, changed: 0 } });
  f.put("analyticsPeriodRollups", { _id: "legacy-total", periodType: "all", periodKey: "all",
    counts: { tasks: 1, projects: 1, deliverables: 5, projectsWithDeliverables: 1 } });
  f.put("projects", { _id: "project", _creationTime: october, name: "Proyecto", status: "active", deliverables: 5 });
  f.put("tasks", { _id: "task", _creationTime: november, title: "Tarea", status: "nueva",
    projectId: "project", deliverablesCount: 2 });
  f.put("analyticsContributions", { _id: "legacy-project", sourceId: "project",
    projection: { kind: "project", day: "2026-10-15", status: "active", deliverables: 5 } });
  f.put("analyticsContributions", { _id: "legacy-task", sourceId: "task",
    projection: { kind: "task", day: "2026-11-04", status: "nueva", source: "internal" } });

  assert.equal((await f.readDashboard("all", "all")).summary.deliverables, 5);
  const partial = await f.call(backfill, { dryRun: false, maxBatches: 1 });
  assert.equal(partial.datedDeliverablesReady, false);
  assert.equal(partial.scanned.tasks, 1);
  assert.equal((await f.readDashboard("month", "2026-11-01")).summary.deliverables, 0);
  assert.equal((await f.readDashboard("all", "all")).summary.deliverables, 5);

  const complete = await f.call(backfill, { dryRun: false });
  assert.equal(complete.datedDeliverablesReady, true);
  assert.equal((await f.readDashboard("month", "2026-10-01")).summary.deliverables, 3);
  assert.equal((await f.readDashboard("month", "2026-11-01")).summary.deliverables, 2);
  assert.equal((await f.readDashboard("all", "all")).summary.deliverables, 5);
});

test("known deliverables on a task with a missing project count without inventing a project", async () => {
  const f = fixture();
  f.put("tasks", { _id: "task", _creationTime: november, title: "Tarea", status: "nueva",
    projectId: "missing-project", deliverablesCount: 4, clientId: "client", clientBrandId: "brand" });
  const preview = await f.call(backfill, { dryRun: true });
  assert.equal(preview.deliverables, 4);
  assert.equal(preview.diagnostics.deliverables.attribution.taskDeliverablesWithoutEligibleProject, 4);
  await f.call(backfill, { dryRun: false });
  const dashboard = await f.readDashboard("all", "all");
  assert.equal(dashboard.summary.deliverables, 4);
  assert.equal(dashboard.summary.projects, 0);
  assert.equal(dashboard.deliverables.projectCount, 0);
  assert.equal(dashboard.deliverables.byClient[0].brands[0].deliverablesTotal, 4);
});
