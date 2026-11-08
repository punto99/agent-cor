import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx,
} from "../_generated/server";
import { positiveDeliverables, projectDeliverableShard } from "../lib/deliverableAnalytics";
import { analyticsDay } from "./calendar";
import { legacyTaskShare, projectDeliverableRemainder } from "./deliverables";
import {
  applyProjectionBatch, classifyAttention, projectSource, type ExclusionReason, type ProjectionChange,
} from "./projection";
import { sourceTableValidator } from "./tables";

const sourceTables = ["tasks", "projects", "taskEvaluations"] as const;
type SourceTable = Infer<typeof sourceTableValidator>;
const cursorValidator = v.union(v.string(), v.null());
const emptyStats = () => ({ tasks: 0, projects: 0, taskEvaluations: 0, cleanup: 0, changed: 0 });

function scanState(ctx: QueryCtx) {
  return ctx.db.query("analyticsState").withIndex("by_key", (q) => q.eq("key", "scan")).unique();
}

// Convex documents can be up to 1 MiB. Evaluation batches also load up to six linked tasks.
function sourceBatchSize(table: SourceTable) {
  // Each task can also refresh its previous and current project.
  return table === "tasks" ? 3 : table === "taskEvaluations" ? 6 : 10;
}

async function readPage(ctx: QueryCtx, table: SourceTable, cursor: string | null, explainExclusions = false) {
  const result = await ctx.db.query(table).paginate({ cursor, numItems: sourceBatchSize(table) });
  if (result.pageStatus === "SplitRequired") throw new Error("An analytics source page exceeded its read budget");
  const today = analyticsDay(Date.now());
  const changes = await Promise.all(result.page.map((doc) => projectSource(ctx, doc, today, explainExclusions)));
  return { changes, docs: result.page, cursor: result.isDone ? null : result.continueCursor };
}

export const beginScan = internalMutation({
  args: { manual: v.boolean() },
  handler: async (ctx, { manual }) => {
    const state = await scanState(ctx);
    if (state?.key !== "scan") {
      if (!manual) return { active: false, published: false };
      await ctx.db.insert("analyticsState", {
        key: "scan", phase: "tasks", cursor: null, stats: emptyStats(), deliverablesVersion: 1,
      });
      return { active: true, published: false };
    }
    const published = state.lastCompletedAt !== undefined;
    if (state.phase && state.deliverablesVersion === 1) return { active: true, published };
    if (!state.phase && !manual) return { active: false, published };
    await ctx.db.patch(state._id, { phase: "tasks", cursor: null, stats: emptyStats(), deliverablesVersion: 1 });
    return { active: true, published };
  },
});

export const reconcilePage = internalMutation({
  args: {},
  handler: async (ctx) => {
    const state = await scanState(ctx);
    if (state?.key !== "scan" || !state.phase || state.deliverablesVersion !== 1) return { active: false };
    const { phase } = state;
    let changes: ProjectionChange[];
    let cursor: string | null;
    let scanned: number;

    if (phase === "cleanup") {
      // This pass also catches physical deletes without requiring hooks in source mutations.
      const page = await ctx.db.query("analyticsContributions")
        .paginate({ cursor: state.cursor, numItems: 4 });
      if (page.pageStatus === "SplitRequired") throw new Error("An analytics cleanup page exceeded its read budget");
      const sources = await Promise.all(page.page.map((row) => ctx.db.get(row.sourceId)));
      changes = page.page.flatMap((row, i) => sources[i] ? [] : [{ sourceId: row.sourceId, projection: null }]);
      scanned = page.page.length;
      cursor = page.isDone ? null : page.continueCursor;
    } else {
      ({ changes, cursor } = await readPage(ctx, phase, state.cursor));
      scanned = changes.length;
    }

    const changed = await applyProjectionBatch(ctx, changes);
    const stats = {
      ...state.stats,
      [phase]: state.stats[phase] + scanned,
      changed: state.stats.changed + changed,
    };
    const nextPhase = cursor !== null ? phase : phase === "cleanup" ? null
      : sourceTables[sourceTables.indexOf(phase) + 1] ?? "cleanup";
    if (nextPhase === null) {
      const completedAt = Date.now();
      if (state.lastCompletedAt === undefined) {
        await ctx.db.insert("analyticsState", { key: "published", publishedAt: completedAt });
      }
      const dated = await ctx.db.query("analyticsState")
        .withIndex("by_key", q => q.eq("key", "datedDeliverables")).unique();
      if (!dated) await ctx.db.insert("analyticsState", { key: "datedDeliverables", publishedAt: completedAt });
      await ctx.db.patch(state._id, { phase: null, cursor: null, stats, lastCompletedAt: completedAt });
    } else {
      await ctx.db.patch(state._id, { phase: nextPhase, cursor, stats });
    }
    return { active: nextPhase !== null };
  },
});

export async function refreshAttentionBatch(ctx: MutationCtx) {
  const today = analyticsDay(Date.now());
  const due = await ctx.db.query("analyticsContributions")
    .withIndex("by_next_attention_day", (q) => q.gt("nextAttentionDay", undefined).lte("nextAttentionDay", today))
    .take(16);
  await applyProjectionBatch(ctx, due.flatMap(({ sourceId, projection }) => projection?.kind === "task"
    ? [{ sourceId, projection: classifyAttention(projection, today) }] : []));
  return due.length === 16;
}

export const refreshAttention = internalMutation({
  args: {},
  handler: refreshAttentionBatch,
});

const jobs = internal.analytics.maintenance;

async function runBatches(ctx: ActionCtx, maxBatches: number): Promise<boolean> {
  // Leave headroom for the function runner. Each completed batch is already checkpointed.
  const endBy = Date.now() + 25_000;
  for (let i = 0; i < maxBatches && Date.now() < endBy; i++) {
    const result = await ctx.runMutation(jobs.reconcilePage, {});
    if (!result.active) return false;
  }
  return true;
}

export const resumeBackfill = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const state = await ctx.runMutation(jobs.beginScan, { manual: false });
    if (state.active && await runBatches(ctx, 32)) {
      await ctx.scheduler.runAfter(0, jobs.resumeBackfill, {});
    }
  },
});

export const backfillStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const state = await scanState(ctx);
    if (state?.key !== "scan") return { status: "notStarted" as const };
    return {
      status: state.phase ? "running" as const : "complete" as const,
      published: state.lastCompletedAt !== undefined,
      datedDeliverablesReady: Boolean(await ctx.db.query("analyticsState")
        .withIndex("by_key", q => q.eq("key", "datedDeliverables")).unique()),
      phase: state.phase,
      scanned: state.stats,
      lastCompletedAt: state.lastCompletedAt,
    };
  },
});

const diagnosticExampleLimit = 25;
type ExclusionExample = {
  id: string;
  reasons: ExclusionReason[];
  status: string;
  convexStatus?: string;
  creatorId?: string;
  taskId?: string;
  requestedBy?: string;
};
type DeliverableSample = {
  projectId: Id<"projects">; shard: number; recorded: number; counted: number;
  covered: number; day?: string; reason?: ExclusionReason;
};
type DeliverableTotals = { projects: number; deliverables: number };

function emptyExclusionStats() {
  return {
    total: 0,
    byPrimaryReason: {} as Partial<Record<ExclusionReason, number>>,
    examples: [] as ExclusionExample[],
  };
}

function addDeliverables(target: DeliverableTotals, amount: number) {
  target.projects++;
  target.deliverables += amount;
}

export const previewPage = internalQuery({
  args: { table: sourceTableValidator, cursor: cursorValidator },
  handler: async (ctx, { table, cursor }) => {
    const page = await readPage(ctx, table, cursor, true);
    let eligible = 0;
    let deliverables = 0;
    let deliverablesWithoutEligibleProject = 0;
    let oldestDay: string | undefined;
    let newestDay: string | undefined;
    const exclusions: ExclusionExample[] = [];
    const projectDeliverables: DeliverableSample[] = [];
    for (const [index, change] of page.changes.entries()) {
      const { projection } = change;
      const doc = page.docs[index];
      if (projection === null) {
        const { exclusionReasons: reasons = [] } = change;
        exclusions.push("evaluationThreadId" in doc
          ? { id: doc._id, reasons, status: doc.status, taskId: doc.taskId, requestedBy: doc.requestedBy }
          : { id: doc._id, reasons, status: doc.status, convexStatus: doc.convexStatus, creatorId: doc.createdBy });
      } else {
        eligible++;
        if (projection.kind === "task") {
          const amount = projection.deliverables ?? 0;
          deliverables += amount;
          if (!projection.deliverableProjectId) deliverablesWithoutEligibleProject += amount;
        }
        if (!oldestDay || projection.day < oldestDay) oldestDay = projection.day;
        if (!newestDay || projection.day > newestDay) newestDay = projection.day;
      }
      if ("name" in doc) {
        const recorded = positiveDeliverables(doc.deliverables);
        const counted = projection?.kind === "project" ? projection.deliverables : 0;
        const reason = projection === null ? change.exclusionReasons?.[0] : undefined;
        projectDeliverables.push({ projectId: doc._id, shard: projectDeliverableShard(doc._id),
          recorded, counted, covered: positiveDeliverables(doc.deliverablesCoveredByTasks), day: projection?.day, reason });
      }
    }
    return { cursor: page.cursor, scanned: page.changes.length, eligible, deliverables,
      deliverablesWithoutEligibleProject, oldestDay, newestDay, exclusions, projectDeliverables };
  },
});

// Read-only previews derive the shares from operational data, even before backfill.
export const previewProjectShares = internalQuery({
  args: { projectId: v.id("projects"), cursor: cursorValidator },
  handler: async (ctx, { projectId, cursor }) => {
    const page = await ctx.db.query("tasks").withIndex("by_projectId", q => q.eq("projectId", projectId))
      .paginate({ cursor, numItems: 10 });
    return {
      amount: page.page.reduce((sum, task) => sum + (legacyTaskShare(task)?.amount ?? 0), 0),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const previewLegacyDeliverables = internalQuery({
  args: {},
  handler: async (ctx) => {
    // The legacy writer has 16 global shards. Allow extra rows so a malformed
    // deployment can be reported as incomplete instead of comparing partial totals.
    const rows = await ctx.db.query("deliverableAnalyticsRollups")
      .withIndex("by_scope", (q) => q.eq("scope", "global")).take(33);
    return {
      complete: rows.length < 33,
      rows: rows.filter((row) => row.deliverablesTotal > 0
        && !("periodType" in row && row.periodType !== undefined)
        && !("periodKey" in row && row.periodKey !== undefined))
        .map(({ shard, deliverablesTotal, projectCount }) => ({ shard, deliverablesTotal, projectCount })),
    };
  },
});

// Run from the deployment dashboard. The dry run calls only internal queries.
export const backfill = internalAction({
  args: {
    dryRun: v.boolean(),
    maxBatches: v.optional(v.number()),
    resume: v.optional(v.object({ table: sourceTableValidator, cursor: cursorValidator })),
  },
  handler: async (ctx, { dryRun, maxBatches: requestedBatches, resume }): Promise<unknown> => {
    const maxBatches = requestedBatches ?? 180;
    if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 400) {
      throw new Error("maxBatches debe ser un entero entre 1 y 400.");
    }
    if (!dryRun) {
      if (resume) throw new Error("resume solo se usa en dryRun. El backfill real guarda su propio progreso.");
      await ctx.runMutation(jobs.beginScan, { manual: true });
      if (await runBatches(ctx, maxBatches) && requestedBatches === undefined) {
        await ctx.scheduler.runAfter(0, jobs.resumeBackfill, {});
      }
      return await ctx.runQuery(jobs.backfillStatus, {});
    }

    const stats = {
      tasks: { scanned: 0, eligible: 0 },
      projects: { scanned: 0, eligible: 0 },
      taskEvaluations: { scanned: 0, eligible: 0 },
    };
    const exclusions = {
      tasks: emptyExclusionStats(), projects: emptyExclusionStats(), taskEvaluations: emptyExclusionStats(),
    };
    const recorded = { projects: 0, deliverables: 0 };
    const projected = { projects: 0, deliverables: 0 };
    const projectedByShard = new Map<number, DeliverableTotals>();
    const ignoredByReason: Record<string, DeliverableTotals> = {};
    const ignoredExamples: DeliverableSample[] = [];
    let tableIndex = resume ? sourceTables.indexOf(resume.table) : 0;
    let cursor = resume?.cursor ?? null;
    let taskDeliverables = 0;
    let taskDeliverablesWithoutEligibleProject = 0;
    let projectRemainder = 0;
    let projectsWithRemainder = 0;
    const remainderExamples: { projectId: Id<"projects">; day: string; deliverables: number }[] = [];
    let projectsWithExcessShares = 0;
    const excessExamples: { projectId: Id<"projects">; recorded: number; covered: number; legacyShares: number }[] = [];
    let oldestDay: string | undefined;
    let newestDay: string | undefined;
    const endBy = Date.now() + 25_000;
    for (let i = 0; i < maxBatches && tableIndex < sourceTables.length && Date.now() < endBy; i++) {
      const table = sourceTables[tableIndex];
      const page = await ctx.runQuery(jobs.previewPage, { table, cursor });
      stats[table].scanned += page.scanned;
      stats[table].eligible += page.eligible;
      taskDeliverables += page.deliverables;
      taskDeliverablesWithoutEligibleProject += page.deliverablesWithoutEligibleProject;
      for (const item of page.exclusions) {
        const detail = exclusions[table];
        detail.total++;
        const primary = item.reasons[0];
        if (primary) detail.byPrimaryReason[primary] = (detail.byPrimaryReason[primary] ?? 0) + 1;
        if (detail.examples.length < diagnosticExampleLimit) detail.examples.push(item);
      }
      const allocations = await Promise.all(page.projectDeliverables.map(async (item: DeliverableSample) => {
        let legacyShares = 0;
        if (!item.reason) {
          let taskCursor: string | null = null;
          do {
            const taskPage: { amount: number; cursor: string | null } =
              await ctx.runQuery(jobs.previewProjectShares, { projectId: item.projectId, cursor: taskCursor });
            legacyShares += taskPage.amount;
            taskCursor = taskPage.cursor;
          } while (taskCursor !== null);
        }
        return { item, legacyShares };
      }));
      for (const { item, legacyShares } of allocations) {
        if (item.day) {
          const remainder = projectDeliverableRemainder(item.recorded, item.covered, legacyShares);
          projectRemainder += remainder;
          if (remainder > 0) {
            projectsWithRemainder++;
            if (remainderExamples.length < diagnosticExampleLimit) {
              remainderExamples.push({ projectId: item.projectId, day: item.day, deliverables: remainder });
            }
          }
          if (item.covered + legacyShares > item.recorded) {
            projectsWithExcessShares++;
            if (excessExamples.length < diagnosticExampleLimit) {
              excessExamples.push({ projectId: item.projectId, recorded: item.recorded, covered: item.covered, legacyShares });
            }
          }
        }
        if (item.recorded === 0) continue;
        addDeliverables(recorded, item.recorded);
        if (item.counted > 0) {
          addDeliverables(projected, item.counted);
          let shard = projectedByShard.get(item.shard);
          if (!shard) {
            shard = { projects: 0, deliverables: 0 };
            projectedByShard.set(item.shard, shard);
          }
          addDeliverables(shard, item.counted);
        } else if (item.reason) {
          const totals = (ignoredByReason[item.reason] ??= { projects: 0, deliverables: 0 });
          addDeliverables(totals, item.recorded);
          if (ignoredExamples.length < diagnosticExampleLimit) ignoredExamples.push(item);
        }
      }
      if (page.oldestDay && (!oldestDay || page.oldestDay < oldestDay)) oldestDay = page.oldestDay;
      if (page.newestDay && (!newestDay || page.newestDay > newestDay)) newestDay = page.newestDay;
      cursor = page.cursor;
      if (cursor === null) tableIndex++;
    }
    const complete = tableIndex === sourceTables.length;
    let comparison = null;
    if (complete && !resume) {
      const legacy = await ctx.runQuery(jobs.previewLegacyDeliverables, {});
      if (legacy.complete) {
        const legacyByShard = new Map<number, DeliverableTotals>();
        const legacyTotal = { projects: 0, deliverables: 0 };
        for (const { shard, deliverablesTotal, projectCount } of legacy.rows) {
          legacyTotal.deliverables += deliverablesTotal;
          legacyTotal.projects += projectCount;
          const value = legacyByShard.get(shard) ?? { projects: 0, deliverables: 0 };
          value.deliverables += deliverablesTotal;
          value.projects += projectCount;
          legacyByShard.set(shard, value);
        }
        const shardDifferences = [...new Set([...legacyByShard.keys(), ...projectedByShard.keys()])]
          .sort((a, b) => a - b).flatMap((shard) => {
            const legacy = legacyByShard.get(shard) ?? { projects: 0, deliverables: 0 };
            const fromProjects = projectedByShard.get(shard) ?? { projects: 0, deliverables: 0 };
            return legacy.deliverables !== fromProjects.deliverables || legacy.projects !== fromProjects.projects
              ? [{ shard, legacy, fromProjects, legacyMinusProjected: legacy.deliverables - fromProjects.deliverables }]
              : [];
          });
        comparison = { legacy: legacyTotal, legacyMinusProjected: {
          projects: legacyTotal.projects - projected.projects,
          deliverables: legacyTotal.deliverables - projected.deliverables,
        }, shardDifferences };
      }
    }
    return {
      dryRun: true, complete, stats, deliverables: taskDeliverables + projectRemainder, oldestDay, newestDay,
      diagnostics: { exclusions, exampleLimit: diagnosticExampleLimit, deliverables: {
        recorded, projected, ignoredByReason, ignoredExamples, comparison,
        attribution: {
          taskDeliverables, taskDeliverablesWithoutEligibleProject,
          projectRemainder, projectsWithRemainder, remainderExamples,
          projectsWithExcessShares, excessExamples,
        },
      } },
      resume: complete ? null : { table: sourceTables[tableIndex], cursor },
    };
  },
});
