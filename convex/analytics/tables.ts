import { defineTable } from "convex/server";
import { v } from "convex/values";

export const periodTypeValidator = v.union(
  v.literal("day"), v.literal("week"), v.literal("month"), v.literal("year"), v.literal("all"),
);

export const sourceTableValidator = v.union(
  v.literal("tasks"), v.literal("projects"), v.literal("taskEvaluations"),
);
export const sourceIdValidator = v.union(v.id("tasks"), v.id("projects"), v.id("taskEvaluations"));

export const attentionKindValidator = v.union(v.literal("overdue"), v.literal("dueSoon"));

const periodFields = { periodType: periodTypeValidator, periodKey: v.string() };
export const taskShareValidator = v.object({
  projectId: v.id("projects"),
  amount: v.number(),
});
const attentionTask = v.object({
  taskId: v.id("tasks"),
  createdAt: v.number(),
  title: v.string(),
  deadline: v.string(),
  status: v.string(),
  source: v.union(v.literal("internal"), v.literal("external")),
});

export const projectionValidator = v.union(
  v.object({
    kind: v.literal("task"),
    day: v.string(),
    status: v.string(),
    source: v.union(v.literal("internal"), v.literal("external")),
    priority: v.optional(v.string()),
    corStatus: v.optional(v.string()),
    clientId: v.optional(v.id("corClients")),
    brandId: v.optional(v.id("clientBrands")),
    subBrandId: v.optional(v.id("subBrands")),
    deliverables: v.optional(v.number()),
    deliverableProjectId: v.optional(v.id("projects")),
    userId: v.optional(v.string()),
    attentionTask: v.optional(attentionTask),
    attention: v.optional(attentionKindValidator),
    nextAttentionDay: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("project"),
    day: v.string(),
    status: v.string(),
    deliverables: v.number(),
    coveredDeliverables: v.optional(v.number()),
    deliverableRemainder: v.optional(v.number()),
    clientId: v.optional(v.id("corClients")),
    brandId: v.optional(v.id("clientBrands")),
    subBrandId: v.optional(v.id("subBrands")),
  }),
  v.object({
    kind: v.literal("evaluation"),
    day: v.string(),
    status: v.union(v.literal("processing"), v.literal("completed"), v.literal("failed")),
    taskId: v.id("tasks"),
    userId: v.optional(v.id("users")),
  }),
);

export const phaseValidator = v.union(sourceTableValidator, v.literal("cleanup"));
const scanStats = v.object({
  tasks: v.number(), projects: v.number(), taskEvaluations: v.number(),
  cleanup: v.number(), changed: v.number(),
});

export const analyticsTables = {
  analyticsPending: defineTable({
    sourceId: sourceIdValidator,
    pendingSince: v.number(),
    relatedCursor: v.optional(v.union(v.string(), v.null())),
    lastFailure: v.optional(v.union(v.literal("schedule"), v.literal("process"))),
    lastFailureAt: v.optional(v.number()),
  }).index("by_source", ["sourceId"]).index("by_pending_since", ["pendingSince"]),

  analyticsPeriodRollups: defineTable({
    ...periodFields,
    counts: v.record(v.string(), v.number()),
  }).index("by_period", ["periodType", "periodKey"]),

  analyticsPeriodBreakdowns: defineTable({
    ...periodFields,
    metric: v.string(),
    parentKey: v.string(),
    entityId: v.string(),
    count: v.number(),
    projectCount: v.number(),
  })
    .index("by_entity", ["periodType", "periodKey", "metric", "parentKey", "entityId"])
    .index("by_rank", ["periodType", "periodKey", "metric", "parentKey", "count", "entityId"]),

  analyticsContributions: defineTable({
    sourceId: sourceIdValidator,
    projection: v.union(projectionValidator, v.null()),
    taskShare: v.optional(taskShareValidator),
    nextAttentionDay: v.optional(v.string()),
  })
    .index("by_source", ["sourceId"])
    .index("by_next_attention_day", ["nextAttentionDay"]),

  analyticsLegacyDeliverableShares: defineTable(taskShareValidator)
    .index("by_project", ["projectId"]),

  analyticsDeliverableProjectPeriods: defineTable({
    ...periodFields,
    projectId: v.id("projects"),
    dimension: v.string(),
    sources: v.number(),
  }).index("by_period_project_dimension", ["periodType", "periodKey", "projectId", "dimension"]),

  analyticsEvaluatedTasks: defineTable({
    ...periodFields,
    taskId: v.id("tasks"),
    count: v.number(),
  }).index("by_period_task", ["periodType", "periodKey", "taskId"]),

  analyticsTaskAttention: defineTable({
    ...periodFields,
    task: attentionTask,
    kind: attentionKindValidator,
  })
    .index("by_task_period", ["task.taskId", "periodType", "periodKey"])
    .index("by_period_kind_created", ["periodType", "periodKey", "kind", "task.createdAt"]),

  analyticsState: defineTable(v.union(
    v.object({
      key: v.literal("scan"),
      phase: v.union(phaseValidator, v.null()),
      cursor: v.union(v.string(), v.null()),
      stats: scanStats,
      lastCompletedAt: v.optional(v.number()),
      deliverablesVersion: v.optional(v.literal(1)),
    }),
    v.object({ key: v.literal("published"), publishedAt: v.number() }),
    v.object({ key: v.literal("datedDeliverables"), publishedAt: v.number() }),
    v.object({
      key: v.literal("scheduledNightly"),
      through: v.number(),
      target: v.number(),
      phase: v.union(sourceTableValidator, v.literal("pending"), v.literal("attention"), v.literal("done")),
      cursor: v.union(v.string(), v.null()),
    }),
    // Accept state documents left by earlier development builds. No worker reads them.
    v.object({
      key: v.literal("sync"),
      cursor: v.union(v.string(), v.null()),
      caughtUp: v.boolean(),
      needsReconcile: v.boolean(),
      lastReadAt: v.optional(v.number()),
      lastError: v.optional(v.string()),
      lastErrorAt: v.optional(v.number()),
      failures: v.optional(v.number()),
      retryAt: v.optional(v.number()),
    }),
    v.object({
      key: v.literal("nightly"),
      firstDay: v.string(),
      lastDay: v.string(),
      phase: v.union(v.literal("changes"), v.literal("attention"), v.literal("prune"), v.literal("done")),
      cursor: v.union(v.string(), v.null()),
    }),
  )).index("by_key", ["key"]),
};
