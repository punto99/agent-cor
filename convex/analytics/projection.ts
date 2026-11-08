import { convexToJson, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { positiveDeliverables } from "../lib/deliverableAnalytics";
import { isExcludedUserId } from "../lib/excludedUsers";
import {
  addAnalyticsDays, analyticsDay, analyticsPeriod, analyticsPeriodTypes, isAnalyticsDay,
  type AnalyticsPeriod,
} from "./calendar";
import {
  changeDeliverableMembership, changeLegacyShares, datedDeliverableMetrics, legacyTaskShare,
  projectDeliverableRemainder, readLegacyShares, type TaskShare,
} from "./deliverables";
import type { projectionValidator, sourceIdValidator } from "./tables";

export const taskStatuses = ["nueva", "en_proceso", "en_revision", "en_diseno", "estancada", "finalizada"] as const;
export const projectStatuses = ["active", "in_process", "suspended", "finished"] as const;
export const priorities = ["I_U", "I_NU", "NI_U", "NI_NU"] as const;
export const evaluationStatuses = ["processing", "completed", "failed"] as const;

type Projection = Infer<typeof projectionValidator>;
type TaskProjection = Extract<Projection, { kind: "task" }>;
type Source = Doc<"tasks"> | Doc<"projects"> | Doc<"taskEvaluations">;
export type SourceId = Infer<typeof sourceIdValidator>;
type RecordExclusion = "deleted" | "archived" | "excludedCreator" | "unsupportedStatus";
const linkedTaskExclusions = {
  deleted: "taskDeleted",
  archived: "taskArchived",
  excludedCreator: "excludedTaskCreator",
  unsupportedStatus: "taskUnsupportedStatus",
} as const satisfies Record<RecordExclusion, string>;
export type ExclusionReason = RecordExclusion | "excludedRequester" | "missingTask"
  | (typeof linkedTaskExclusions)[RecordExclusion];
export type ProjectionChange = {
  sourceId: SourceId;
  projection: Projection | null;
  exclusionReasons?: ExclusionReason[];
  taskShare?: TaskShare | null;
};

export function classifyAttention(projection: TaskProjection, today: string): TaskProjection {
  const deadline = projection.attentionTask?.deadline;
  if (!deadline) return projection;
  if (deadline < today) return { ...projection, attention: "overdue", nextAttentionDay: undefined };
  const dueSoonDay = addAnalyticsDays(deadline, -7);
  if (dueSoonDay <= today) {
    return { ...projection, attention: "dueSoon", nextAttentionDay: addAnalyticsDays(deadline, 1) };
  }
  return { ...projection, attention: undefined, nextAttentionDay: dueSoonDay };
}

function recordExclusions(doc: Doc<"tasks"> | Doc<"projects">): RecordExclusion[] {
  const reasons: RecordExclusion[] = [];
  if (doc.convexStatus === "deleted" || doc.convexStatus === "archived") reasons.push(doc.convexStatus);
  if (isExcludedUserId(doc.createdBy)) reasons.push("excludedCreator");
  const validStatuses: readonly string[] = "name" in doc ? projectStatuses : taskStatuses;
  if (!validStatuses.includes(doc.status)) reasons.push("unsupportedStatus");
  return reasons;
}

export async function projectSource(
  ctx: QueryCtx, doc: Source, today: string, explainExclusions = false,
): Promise<ProjectionChange> {
  const sourceId = doc._id;
  if ("evaluationThreadId" in doc) {
    const requesterExcluded = isExcludedUserId(doc.requestedBy);
    if (requesterExcluded && !explainExclusions) {
      return { sourceId, projection: null, exclusionReasons: ["excludedRequester"] };
    }
    const task = await ctx.db.get("tasks", doc.taskId);
    const exclusionReasons: ExclusionReason[] = [];
    if (requesterExcluded) exclusionReasons.push("excludedRequester");
    if (task) exclusionReasons.push(...recordExclusions(task).map((reason) => linkedTaskExclusions[reason]));
    else exclusionReasons.push("missingTask");
    if (exclusionReasons.length) {
      return { sourceId, projection: null, exclusionReasons };
    }
    return { sourceId, projection: {
      kind: "evaluation",
      day: analyticsDay(doc.createdAt),
      status: doc.status,
      taskId: doc.taskId,
      userId: doc.requestedBy,
    } };
  }
  const taskShare = "name" in doc ? undefined : legacyTaskShare(doc);
  const exclusionReasons = recordExclusions(doc);
  if (exclusionReasons.length) {
    return { sourceId, projection: null, exclusionReasons, taskShare };
  }
  const day = analyticsDay(doc._creationTime);
  if ("name" in doc) {
    const deliverables = positiveDeliverables(doc.deliverables);
    return { sourceId, projection: {
      kind: "project", day, status: doc.status, deliverables,
      coveredDeliverables: positiveDeliverables(doc.deliverablesCoveredByTasks) || undefined,
      clientId: doc.clientId, brandId: doc.clientBrandId, subBrandId: doc.subBrandId,
    } };
  }
  const source = doc.source ?? "internal";
  const deadline = doc.deadline?.slice(0, 10);
  const attentionTask = doc.status !== "finalizada" && deadline && isAnalyticsDay(deadline)
    ? { taskId: doc._id, createdAt: doc._creationTime, title: doc.title.slice(0, 1000).replace(/[\uD800-\uDBFF]$/, ""),
        deadline, status: doc.status, source }
    : undefined;
  const deliverables = positiveDeliverables(doc.deliverablesCount) || undefined;
  const project = deliverables && doc.projectId ? await ctx.db.get(doc.projectId) : null;
  return { sourceId, taskShare, projection: classifyAttention({
    kind: "task", day, status: doc.status, source, priority: doc.strategicPriority,
    corStatus: doc.corSyncStatus, clientId: doc.clientId, brandId: doc.clientBrandId,
    subBrandId: deliverables ? doc.subBrandId : undefined,
    deliverables, deliverableProjectId: project && !recordExclusions(project).length ? project._id : undefined,
    userId: doc.createdBy, attentionTask,
  }, today) };
}

type CountDelta = { period: AnalyticsPeriod; counts: Record<string, number> };
type BreakdownDelta = AnalyticsPeriod & {
  metric: string; parentKey: string; entityId: string; count: number; projectCount: number;
};

export function analyticsParentKey(clientId: string, brandId: string) {
  return JSON.stringify([clientId, brandId]);
}

async function applyEvaluationMembership(
  ctx: MutationCtx, period: AnalyticsPeriod, taskId: Doc<"tasks">["_id"], change: number,
) {
  const existing = await ctx.db.query("analyticsEvaluatedTasks")
    .withIndex("by_period_task", (q) => q.eq("periodType", period.periodType)
      .eq("periodKey", period.periodKey).eq("taskId", taskId)).unique();
  const previous = existing?.count ?? 0;
  const next = previous + change;
  if (next < 0) throw new Error("Analytics evaluated-task count is inconsistent");
  if (existing && next === 0) await ctx.db.delete(existing._id);
  else if (existing) await ctx.db.patch(existing._id, { count: next });
  else if (next > 0) await ctx.db.insert("analyticsEvaluatedTasks", { ...period, taskId, count: next });
  return (next > 0) !== (previous > 0);
}

async function projectAttention(
  ctx: MutationCtx, before: Projection | null, after: Projection | null,
) {
  const oldTask = before?.kind === "task" && before.attention ? before : null;
  const newTask = after?.kind === "task" && after.attention ? after : null;
  if (!oldTask && !newTask) return;
  const taskId = oldTask?.attentionTask?.taskId ?? newTask?.attentionTask?.taskId;
  if (!taskId) throw new Error("Analytics attention entry is missing its task");
  for (const periodType of analyticsPeriodTypes) {
    const oldPeriod = oldTask ? analyticsPeriod(periodType, oldTask.day) : null;
    const newPeriod = newTask ? analyticsPeriod(periodType, newTask.day) : null;
    const existing = oldPeriod ? await ctx.db.query("analyticsTaskAttention")
      .withIndex("by_task_period", (q) => q.eq("task.taskId", taskId)
        .eq("periodType", periodType).eq("periodKey", oldPeriod.periodKey)).unique() : null;
    if (newPeriod && newTask?.attentionTask && newTask.attention) {
      const value = { ...newPeriod, task: newTask.attentionTask, kind: newTask.attention };
      if (existing) {
        const before = { periodType: existing.periodType, periodKey: existing.periodKey, task: existing.task, kind: existing.kind };
        if (!sameValue(before, value)) await ctx.db.replace(existing._id, value);
      } else await ctx.db.insert("analyticsTaskAttention", value);
    } else if (existing) await ctx.db.delete(existing._id);
  }
}

function sameValue(before: Projection | null | object, after: Projection | null | object) {
  return JSON.stringify(convexToJson(before as Parameters<typeof convexToJson>[0]))
    === JSON.stringify(convexToJson(after as Parameters<typeof convexToJson>[0]));
}

export async function applyProjectionBatch(ctx: MutationCtx, changes: ProjectionChange[]) {
  const totals = new Map<string, CountDelta>();
  const breakdowns = new Map<string, BreakdownDelta>();
  const memberships = new Map<string, {
    period: AnalyticsPeriod; projectId: Id<"projects">; dimension: string;
    delta: number; target: CountDelta | BreakdownDelta;
  }>();

  async function add(projection: Projection, sign: 1 | -1, sourceId: SourceId) {
    for (const periodType of analyticsPeriodTypes) {
      const period = analyticsPeriod(periodType, projection.day);
      const key = JSON.stringify([periodType, period.periodKey]);
      let total = totals.get(key);
      if (!total) {
        total = { period, counts: {} };
        totals.set(key, total);
      }
      const count = (metric: string, amount = 1) => {
        total.counts[metric] = (total.counts[metric] ?? 0) + amount * sign;
      };
      const breakdown = (metric: string, entityId?: string, parentKey = "", amount = 1, projects = 0) => {
        if (!entityId) return;
        const dimension = JSON.stringify([key, metric, parentKey, entityId]);
        let delta = breakdowns.get(dimension);
        if (!delta) {
          delta = { ...period, metric, parentKey, entityId, count: 0, projectCount: 0 };
          breakdowns.set(dimension, delta);
        }
        delta.count += amount * sign;
        delta.projectCount += projects * sign;
        return delta;
      };

      function recordMembership(projectId: Id<"projects"> | undefined, dimension: string, target: CountDelta | BreakdownDelta) {
        if (!projectId) return;
        const membershipKey = JSON.stringify([key, projectId, dimension]);
        const prior = memberships.get(membershipKey);
        if (prior) prior.delta += sign;
        else memberships.set(membershipKey, { period, projectId, dimension, delta: sign, target });
      }

      function addDatedDeliverables(
        amount: number, projectId: Id<"projects"> | undefined,
        clientId: string | undefined, brandId: string | undefined, subBrandId: string | undefined,
      ) {
        if (amount <= 0 || !total) return;
        const metrics = datedDeliverableMetrics;
        count(metrics.total, amount);
        recordMembership(projectId, metrics.total, total);
        if (!clientId) return;
        const client = breakdown(metrics.client, clientId, "", amount);
        if (client) recordMembership(projectId, JSON.stringify([metrics.client, clientId]), client);
        if (!brandId) return;
        const brand = breakdown(metrics.brand, brandId, clientId, amount);
        if (brand) recordMembership(projectId, JSON.stringify([metrics.brand, clientId, brandId]), brand);
        const subBrand = breakdown(metrics.subBrand, subBrandId, analyticsParentKey(clientId, brandId), amount);
        if (subBrand) recordMembership(projectId, JSON.stringify([metrics.subBrand, clientId, brandId, subBrandId]), subBrand);
      }

      switch (projection.kind) {
        case "task":
          count("tasks");
          count(`source_${projection.source}`);
          if (taskStatuses.some((status) => status === projection.status)) count(`task_${projection.status}`);
          if (priorities.some((priority) => priority === projection.priority)) count(`priority_${projection.priority}`);
          if (projection.corStatus === "pending" || projection.corStatus === "synced" || projection.corStatus === "error") {
            count(`cor_${projection.corStatus}`);
          }
          if (projection.attention) count(projection.attention);
          breakdown("tasksByClient", projection.clientId);
          breakdown("tasksByBrand", projection.brandId);
          breakdown("tasksByUser", projection.userId);
          addDatedDeliverables(projection.deliverables ?? 0, projection.deliverableProjectId,
            projection.clientId, projection.brandId, projection.subBrandId);
          break;
        case "project":
          count("projects");
          if (projectStatuses.some((status) => status === projection.status)) count(`project_${projection.status}`);
          if (projection.deliverables > 0) {
            const { deliverables, clientId, brandId, subBrandId } = projection;
            count("deliverables", deliverables);
            count("projectsWithDeliverables");
            breakdown("deliverablesByClient", clientId, "", deliverables, 1);
            if (clientId) breakdown("deliverablesByBrand", brandId, clientId, deliverables, 1);
            if (clientId && brandId) {
              breakdown("deliverablesBySubBrand", subBrandId, analyticsParentKey(clientId, brandId), deliverables, 1);
            }
          }
          addDatedDeliverables(projection.deliverableRemainder ?? 0, sourceId as Id<"projects">,
            projection.clientId, projection.brandId, projection.subBrandId);
          break;
        case "evaluation":
          count("evaluations");
          count(`evaluation_${projection.status}`);
          breakdown("evaluationsByUser", projection.userId);
          if (projection.status === "completed"
            && await applyEvaluationMembership(ctx, period, projection.taskId, sign)) {
            count("evaluatedTasks");
          }
          break;
      }
    }
  }

  function contribution(sourceId: SourceId) {
    return ctx.db.query("analyticsContributions")
      .withIndex("by_source", (q) => q.eq("sourceId", sourceId)).unique();
  }
  const work = new Map<SourceId, ProjectionChange>(changes.map(change => [change.sourceId, change]));
  const previous = new Map<SourceId, Doc<"analyticsContributions"> | null>();
  const shares = new Map<Id<"projects">, number>();
  function addShare(share: TaskShare | undefined | null, sign: number) {
    if (share) shares.set(share.projectId, (shares.get(share.projectId) ?? 0) + share.amount * sign);
  }
  for (const [sourceId, change] of work) {
    const before = await contribution(sourceId);
    previous.set(sourceId, before);
    if (change.taskShare === undefined && change.projection?.kind === "task") {
      // Deadline refreshes reuse the stored task projection.
      change.taskShare = before?.taskShare;
    }
    addShare(before?.taskShare, -1);
    addShare(change.taskShare, 1);
  }
  for (const [projectId, delta] of shares) {
    if (!delta) continue;
    await changeLegacyShares(ctx, projectId, delta);
    if (!work.has(projectId)) {
      const doc = await ctx.db.get(projectId);
      work.set(projectId, doc ? await projectSource(ctx, doc, analyticsDay(Date.now())) : {
        sourceId: projectId, projection: null,
      });
      previous.set(projectId, await contribution(projectId));
    }
  }

  let changed = 0;
  for (const { sourceId, projection: sourceProjection, taskShare } of work.values()) {
    const existing = previous.get(sourceId);
    const before = existing?.projection ?? null;
    let projection = sourceProjection;
    if (projection?.kind === "project") {
      const legacy = await readLegacyShares(ctx, sourceId as Id<"projects">);
      projection = { ...projection, deliverableRemainder: projectDeliverableRemainder(
        projection.deliverables, projection.coveredDeliverables ?? 0, legacy?.amount ?? 0,
      ) };
    }
    const projectionChanged = !sameValue(before, projection);
    if (!projectionChanged && sameValue(existing?.taskShare ?? null, taskShare ?? null)) continue;
    if (projectionChanged) {
      if (before) await add(before, -1, sourceId);
      if (projection) await add(projection, 1, sourceId);
      await projectAttention(ctx, before, projection);
    }

    if (projection || taskShare) {
      const nextAttentionDay = projection?.kind === "task" ? projection.nextAttentionDay : undefined;
      const value = { projection, taskShare: taskShare ?? undefined, nextAttentionDay };
      if (existing) await ctx.db.patch(existing._id, value);
      else await ctx.db.insert("analyticsContributions", { sourceId, ...value });
    } else if (existing) await ctx.db.delete(existing._id);
    changed++;
  }

  for (const { period, projectId, dimension, delta, target } of memberships.values()) {
    const change = await changeDeliverableMembership(ctx, period, projectId, dimension, delta);
    if (!change) continue;
    if ("projectCount" in target) target.projectCount += change;
    else {
      const metric = datedDeliverableMetrics.projects;
      target.counts[metric] = (target.counts[metric] ?? 0) + change;
    }
  }

  for (const { period, counts } of totals.values()) {
    if (Object.values(counts).every((delta) => delta === 0)) continue;
    const existing = await ctx.db.query("analyticsPeriodRollups").withIndex("by_period", (q) =>
      q.eq("periodType", period.periodType).eq("periodKey", period.periodKey)).unique();
    const next = { ...existing?.counts };
    for (const [metric, delta] of Object.entries(counts)) {
      if (delta === 0) continue;
      const value = (next[metric] ?? 0) + delta;
      if (value < 0) throw new Error(`Analytics count is inconsistent for ${metric}`);
      if (value === 0) delete next[metric];
      else next[metric] = value;
    }
    if (existing && Object.keys(next).length === 0) await ctx.db.delete(existing._id);
    else if (existing) await ctx.db.patch(existing._id, { counts: next });
    else await ctx.db.insert("analyticsPeriodRollups", { ...period, counts: next });
  }

  for (const delta of breakdowns.values()) {
    if (delta.count === 0 && delta.projectCount === 0) continue;
    const { periodType, periodKey, metric, parentKey, entityId } = delta;
    const existing = await ctx.db.query("analyticsPeriodBreakdowns").withIndex("by_entity", (q) =>
      q.eq("periodType", periodType).eq("periodKey", periodKey).eq("metric", metric)
        .eq("parentKey", parentKey).eq("entityId", entityId)).unique();
    const count = (existing?.count ?? 0) + delta.count;
    const projectCount = (existing?.projectCount ?? 0) + delta.projectCount;
    if (count < 0 || projectCount < 0) throw new Error(`Analytics breakdown is inconsistent for ${metric}`);
    if (existing && count === 0) await ctx.db.delete(existing._id);
    else if (existing) await ctx.db.patch(existing._id, { count, projectCount });
    else if (count > 0) await ctx.db.insert("analyticsPeriodBreakdowns", {
      periodType, periodKey, metric, parentKey, entityId, count, projectCount,
    });
  }
  return changed;
}
