import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  action, internalAction, internalMutation, internalQuery, type MutationCtx,
} from "../_generated/server";
import { hasTaskAccess } from "../data/tasks";
import { hasProjectAccess } from "../data/projects";
import { canViewExternalRequest } from "../lib/externalRequestsAccess";
import { notifyAnalytics } from "./notify";
import { analyticsDay } from "./calendar";
import { refreshAttentionBatch } from "./maintenance";
import { applyProjectionBatch, projectSource, type SourceId } from "./projection";
import { sourceIdValidator } from "./tables";

const jobs = internal.analytics.jobs;
const batchSize = 6;
const dayMs = 86_400_000;

function lastClosedDayBoundary() {
  return Date.parse(analyticsDay(Date.now()) + "T05:00:00Z");
}

async function getOrCreatePending(ctx: MutationCtx, sourceId: SourceId) {
  const existing = await ctx.db.query("analyticsPending")
    .withIndex("by_source", q => q.eq("sourceId", sourceId)).unique();
  return existing?._id ?? await ctx.db.insert("analyticsPending", { sourceId, pendingSince: Date.now() });
}

export const record = internalMutation({
  args: { sourceIds: v.array(sourceIdValidator) },
  handler: async (ctx, { sourceIds }) => {
    if (sourceIds.length > batchSize) throw new Error("Too many analytics sources");
    const jobIds: Id<"analyticsPending">[] = [];
    for (const sourceId of new Set(sourceIds)) jobIds.push(await getOrCreatePending(ctx, sourceId));
    return jobIds;
  },
});

export const failure = internalMutation({
  args: {
    jobId: v.id("analyticsPending"),
    stage: v.union(v.literal("schedule"), v.literal("process")),
  },
  handler: async (ctx, { jobId, stage }) => {
    if (await ctx.db.get(jobId)) {
      await ctx.db.patch(jobId, { lastFailure: stage, lastFailureAt: Date.now() });
    }
  },
});

export const processPage = internalMutation({
  args: { jobId: v.id("analyticsPending") },
  handler: async (ctx, { jobId }): Promise<boolean> => {
    const pending = await ctx.db.get(jobId);
    if (!pending) return false;
    const { sourceId } = pending;
    const today = analyticsDay(Date.now());
    const source = await ctx.db.get(sourceId);
    const change = source ? await projectSource(ctx, source, today) : { sourceId, projection: null };
    const taskId = ctx.db.normalizeId("tasks", sourceId);
    const projectId = ctx.db.normalizeId("projects", sourceId);
    const previous = taskId || projectId ? await ctx.db.query("analyticsContributions")
      .withIndex("by_source", q => q.eq("sourceId", sourceId)).unique() : null;
    await applyProjectionBatch(ctx, [change]);

    const eligibilityChanged = (previous?.projection?.kind === "task") !== (change.projection?.kind === "task");
    if (taskId && (!source || eligibilityChanged
        || pending.relatedCursor !== undefined)) {
      const page = await ctx.db.query("taskEvaluations").withIndex("by_task", q => q.eq("taskId", taskId))
        .paginate({ cursor: eligibilityChanged ? null : pending.relatedCursor ?? null, numItems: 4 });
      const changes = await Promise.all(page.page.map(evaluation => projectSource(ctx, evaluation, today)));
      await applyProjectionBatch(ctx, changes);
      if (!page.isDone) {
        await ctx.db.patch(jobId, { relatedCursor: page.continueCursor });
        return true;
      }
    }
    // Recheck linked tasks when a project enters or leaves analytics.
    const projectEligibilityChanged = (previous?.projection?.kind === "project") !== (change.projection?.kind === "project");
    if (projectId && (projectEligibilityChanged || pending.relatedCursor !== undefined
        || !source || ("name" in source && (source.convexStatus === "deleted" || source.convexStatus === "archived")))) {
      const page = await ctx.db.query("tasks")
        .withIndex("by_projectId", q => q.eq("projectId", projectId))
        .paginate({ cursor: pending.relatedCursor ?? null, numItems: batchSize });
      for (const task of page.page) await scheduleSource(ctx, task._id);
      if (!page.isDone) {
        await ctx.db.patch(jobId, { relatedCursor: page.continueCursor });
        return true;
      }
    }

    await ctx.db.delete(jobId);
    return false;
  },
});

export const process = internalAction({
  args: { jobId: v.id("analyticsPending") },
  handler: async (ctx, { jobId }): Promise<void> => {
    try {
      if (!(await ctx.runMutation(jobs.processPage, { jobId }))) return;
    } catch (error) {
      console.error("[analytics] Processing failed", jobId, error);
      await ctx.runMutation(jobs.failure, { jobId, stage: "process" });
      return;
    }
    try {
      await ctx.scheduler.runAfter(0, jobs.process, { jobId });
    } catch (error) {
      console.error("[analytics] Scheduling continuation failed", jobId, error);
      await ctx.runMutation(jobs.failure, { jobId, stage: "schedule" });
    }
  },
});

async function scheduleSource(ctx: MutationCtx, sourceId: SourceId) {
  const jobId = await getOrCreatePending(ctx, sourceId);
  await ctx.scheduler.runAfter(0, jobs.process, { jobId });
}

export const allowedHints = internalQuery({
  args: { sourceIds: v.array(sourceIdValidator) },
  handler: async (ctx, { sourceIds }): Promise<SourceId[]> => {
    const userId = await getAuthUserId(ctx);
    if (!userId || sourceIds.length > batchSize) return [];
    const external = Boolean(await ctx.db.query("approvedExternalUsers")
      .withIndex("by_user", q => q.eq("userId", userId)).first());
    const result: SourceId[] = [];
    const recent = Date.now() - 10 * 60_000;
    for (const sourceId of new Set(sourceIds)) {
      const doc = await ctx.db.get(sourceId);
      if (!doc || (doc.updatedAt ?? doc._creationTime) < recent) continue;
      if ("evaluationThreadId" in doc) {
        if (doc.requestedBy === userId) result.push(sourceId);
      } else if ("name" in doc) {
        if (!external && await hasProjectAccess(ctx, doc, userId)) result.push(sourceId);
      } else if (external ? await canViewExternalRequest(ctx, userId, doc) : await hasTaskAccess(ctx, doc, userId)) {
        result.push(sourceId);
      }
    }
    return result;
  },
});

export const hint = action({
  args: { sourceIds: v.array(sourceIdValidator) },
  handler: async (ctx, args): Promise<void> => {
    const sourceIds: SourceId[] = await ctx.runQuery(jobs.allowedHints, args);
    await notifyAnalytics(ctx, sourceIds);
  },
});

export const nightly = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const target = lastClosedDayBoundary();
    const state = await ctx.db.query("analyticsState")
      .withIndex("by_key", q => q.eq("key", "scheduledNightly")).unique();
    if (state?.key === "scheduledNightly") {
      if (state.phase === "done") {
        if (state.through >= target) return;
        await ctx.db.patch(state._id, { target, phase: "tasks", cursor: null });
      }
    } else {
      await ctx.db.insert("analyticsState", {
        key: "scheduledNightly", through: target - dayMs, target, phase: "tasks", cursor: null,
      });
    }
    await ctx.scheduler.runAfter(0, jobs.nightlyBatch, {});
  },
});

export const nightlyBatch = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const state = await ctx.db.query("analyticsState")
      .withIndex("by_key", q => q.eq("key", "scheduledNightly")).unique();
    if (state?.key !== "scheduledNightly" || state.phase === "done") return;
    const { phase, through, target, cursor } = state;
    const pageOptions = { cursor, numItems: batchSize };
    if (phase === "attention") {
      if (!(await refreshAttentionBatch(ctx))) {
        const nextTarget = lastClosedDayBoundary();
        if (nextTarget <= target) {
          await ctx.db.patch(state._id, { phase: "done", through: target });
          return;
        }
        await ctx.db.patch(state._id, { phase: "tasks", through: target, target: nextTarget, cursor: null });
      }
    } else if (phase === "pending") {
      const page = await ctx.db.query("analyticsPending")
        .withIndex("by_pending_since", q => q.lt("pendingSince", target)).paginate(pageOptions);
      for (const row of page.page) await ctx.scheduler.runAfter(0, jobs.process, { jobId: row._id });
      await ctx.db.patch(state._id, page.isDone
        ? { phase: "attention", cursor: null } : { cursor: page.continueCursor });
    } else {
      const page = await ctx.db.query(phase)
        .withIndex("by_updatedAt", q => q.gte("updatedAt", through).lt("updatedAt", target))
        .paginate(pageOptions);
      for (const row of page.page) {
        await scheduleSource(ctx, row._id);
        if ("replacedProjectIds" in row) {
          for (const projectId of row.replacedProjectIds ?? []) await scheduleSource(ctx, projectId);
        }
      }
      const nextPhase = { tasks: "projects", projects: "taskEvaluations", taskEvaluations: "pending" } as const;
      await ctx.db.patch(state._id, page.isDone
        ? { phase: nextPhase[phase], cursor: null } : { cursor: page.continueCursor });
    }
    await ctx.scheduler.runAfter(0, jobs.nightlyBatch, {});
  },
});

export const status = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ pending: Doc<"analyticsPending">[]; nightly: Doc<"analyticsState"> | null }> => {
    const [pending, nightly] = await Promise.all([
      ctx.db.query("analyticsPending").withIndex("by_pending_since").take(20),
      ctx.db.query("analyticsState").withIndex("by_key", q => q.eq("key", "scheduledNightly")).unique(),
    ]);
    return { pending, nightly };
  },
});
