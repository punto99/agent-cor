import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "../_generated/server";
import {
  analyticsFirstDay,
  analyticsPeriod,
  analyticsTrendPeriods,
  isAnalyticsDay,
  type AnalyticsPeriod,
} from "../analytics/calendar";
import {
  analyticsParentKey,
  evaluationStatuses as EVALUATION_STATUSES,
  priorities as STRATEGIC_PRIORITIES,
  projectStatuses as PROJECT_STATUSES,
  taskStatuses as TASK_STATUSES,
} from "../analytics/projection";
import { periodTypeValidator } from "../analytics/tables";
import { datedDeliverableMetrics } from "../analytics/deliverables";
import { canUserAccessAnalytics } from "../lib/analyticsAccess";
import type { Doc } from "../_generated/dataModel";
import { applyProjectDeliverablesDelta, positiveDeliverables } from "../lib/deliverableAnalytics";
import { isExcludedUserId } from "../lib/excludedUsers";
import { requireUserRoleAdmin } from "../lib/userRoles";

const MAX_ANALYTICS_TASKS = 2500;
const MAX_ANALYTICS_EVALUATIONS = 2500;

export const viewerCanAccessAnalytics = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { isAuthenticated: false, canAccess: false };
    }

    return {
      isAuthenticated: true,
      userId,
      canAccess: await canUserAccessAnalytics(ctx, userId),
    };
  },
});

export const rebuildDeliverableAnalyticsRollups = mutation({
  args: {
    confirm: v.string(),
  },
  handler: async (ctx, args) => {
    await requireUserRoleAdmin(ctx);
    if (args.confirm !== "REBUILD_DELIVERABLE_ANALYTICS") {
      throw new Error(
        "Confirmación inválida. Usa REBUILD_DELIVERABLE_ANALYTICS para recalcular.",
      );
    }

    const existingRollups = await ctx.db
      .query("deliverableAnalyticsRollups")
      .collect();
    for (const rollup of existingRollups) {
      await ctx.db.delete(rollup._id);
    }

    const projects = await ctx.db.query("projects").collect();
    let projectsProcessed = 0;
    let projectsSkippedDeleted = 0;
    let projectsWithDeliverables = 0;
    let deliverablesTotal = 0;
    for (const project of projects) {
      if (project.convexStatus === "deleted") {
        projectsSkippedDeleted += 1;
        continue;
      }
      await applyProjectDeliverablesDelta(ctx, null, project);
      projectsProcessed += 1;
      if (
        typeof project.deliverables === "number" &&
        Number.isFinite(project.deliverables) &&
        project.deliverables > 0
      ) {
        projectsWithDeliverables += 1;
        deliverablesTotal += Math.trunc(project.deliverables);
      }
    }

    return {
      success: true,
      rollupsCleared: existingRollups.length,
      projectsProcessed,
      projectsSkippedDeleted,
      projectsWithDeliverables,
      deliverablesTotal,
    };
  },
});

export const getDashboard = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || !(await canUserAccessAnalytics(ctx, userId))) {
      return { canAccess: false as const };
    }

    const recentTasks = await ctx.db
      .query("tasks")
      .order("desc")
      .take(MAX_ANALYTICS_TASKS);
    const allProjects = await ctx.db
      .query("projects")
      .order("desc")
      .take(MAX_ANALYTICS_TASKS);
    const recentEvaluations = await ctx.db
      .query("taskEvaluations")
      .withIndex("by_createdAt")
      .order("desc")
      .take(MAX_ANALYTICS_EVALUATIONS);

    const excludedTaskIds = new Set(
      recentTasks
        .filter((task) => isExcludedUserId(task.createdBy))
        .map((task) => String(task._id)),
    );

    const activeTasks = recentTasks.filter(
      (task) =>
        task.convexStatus !== "deleted" && !isExcludedUserId(task.createdBy),
    );
    const activeProjects = allProjects.filter(
      (project) =>
        project.convexStatus !== "deleted" &&
        !isExcludedUserId(project.createdBy),
    );
    const activeEvaluations = recentEvaluations.filter(
      (evaluation) =>
        !isExcludedUserId(evaluation.requestedBy) &&
        !excludedTaskIds.has(String(evaluation.taskId)),
    );

    const clientNameById = new Map<string, string>();
    const clientIds = Array.from(
      new Set(activeTasks.map((task) => task.clientId).filter(Boolean)),
    );
    for (const clientId of clientIds) {
      const client = await ctx.db.get(clientId!);
      if (client) clientNameById.set(String(client._id), client.name);
    }

    const brandNameById = new Map<string, string>();
    const brandIds = Array.from(
      new Set(activeTasks.map((task) => task.clientBrandId).filter(Boolean)),
    );
    for (const brandId of brandIds) {
      const brand = await ctx.db.get(brandId!);
      if (brand) brandNameById.set(String(brand._id), brand.name);
    }

    const taskUserCounts = countBy(
      activeTasks.filter((task) => task.createdBy),
      (task) => String(task.createdBy),
    );
    const evaluationUserCounts = new Map<string, number>();

    for (const evaluation of activeEvaluations) {
      if (!evaluation.requestedBy) continue;
      const createdBy = String(evaluation.requestedBy);
      evaluationUserCounts.set(
        createdBy,
        (evaluationUserCounts.get(createdBy) ?? 0) + 1,
      );
    }

    const userNameById = new Map<string, string>();
    const userIds = Array.from(
      new Set([...taskUserCounts.keys(), ...evaluationUserCounts.keys()]),
    );
    for (const analyticsUserId of userIds) {
      const user = await ctx.db.get(analyticsUserId as any);
      if (user) userNameById.set(analyticsUserId, formatUserName(user));
    }

    const statusCounts = TASK_STATUSES.map((status) => ({
      key: status,
      label: getTaskStatusLabel(status),
      count: activeTasks.filter((task) => task.status === status).length,
    }));

    const projectStatusCounts = PROJECT_STATUSES.map((status) => ({
      key: status,
      label: getProjectStatusLabel(status),
      count: activeProjects.filter((project) => project.status === status)
        .length,
    }));

    const sourceCounts = [
      {
        key: "internal",
        label: "Internas",
        count: activeTasks.filter((task) => task.source !== "external").length,
      },
      {
        key: "external",
        label: "Clientes externos",
        count: activeTasks.filter((task) => task.source === "external").length,
      },
    ];

    const strategicPriorityCounts = STRATEGIC_PRIORITIES.map((priority) => ({
      key: priority,
      label: priority,
      count: activeTasks.filter((task) => task.strategicPriority === priority)
        .length,
    }));

    const tasksByClient = topEntries(
      countBy(
        activeTasks.filter((task) => task.clientId),
        (task) => String(task.clientId),
      ),
      8,
    ).map(([clientId, count]) => ({
      clientId,
      name: clientNameById.get(clientId) ?? "Cliente sin nombre",
      count,
    }));

    const tasksByBrand = topEntries(
      countBy(
        activeTasks.filter((task) => task.clientBrandId),
        (task) => String(task.clientBrandId),
      ),
      8,
    ).map(([brandId, count]) => ({
      brandId,
      name: brandNameById.get(brandId) ?? "Marca sin nombre",
      count,
    }));

    const tasksByUser = topEntries(taskUserCounts, 10).map(
      ([analyticsUserId, count]) => ({
        userId: analyticsUserId,
        name: userNameById.get(analyticsUserId) ?? "Usuario sin nombre",
        count,
      }),
    );

    const evaluationsByUser = topEntries(evaluationUserCounts, 10).map(
      ([analyticsUserId, count]) => ({
        userId: analyticsUserId,
        name: userNameById.get(analyticsUserId) ?? "Usuario sin nombre",
        count,
      }),
    );

    const now = Date.now();
    const overdueTasks = activeTasks.filter((task) => {
      if (!task.deadline || task.status === "finalizada") return false;
      const deadlineTime = Date.parse(task.deadline.slice(0, 10));
      return Number.isFinite(deadlineTime) && deadlineTime < startOfToday(now);
    });

    const dueSoonTasks = activeTasks.filter((task) => {
      if (!task.deadline || task.status === "finalizada") return false;
      const deadlineTime = Date.parse(task.deadline.slice(0, 10));
      return (
        Number.isFinite(deadlineTime) &&
        deadlineTime >= startOfToday(now) &&
        deadlineTime <= startOfToday(now) + 7 * 24 * 60 * 60 * 1000
      );
    });

    const weeklyTrend = buildWeeklyTrend(activeTasks, 8);
    const deliverableAnalytics = await buildDeliverableAnalytics(ctx, activeProjects);
    const evaluationStatusCounts = EVALUATION_STATUSES.map((status) => ({
      key: status,
      label: getEvaluationStatusLabel(status),
      count: activeEvaluations.filter(
        (evaluation) => evaluation.status === status,
      ).length,
    }));
    const evaluatedTaskIds = new Set(
      activeEvaluations
        .filter((evaluation) => evaluation.status === "completed")
        .map((evaluation) => String(evaluation.taskId)),
    );

    return {
      canAccess: true as const,
      generatedAt: now,
      limits: {
        maxTasksRead: MAX_ANALYTICS_TASKS,
        maxEvaluationsRead: MAX_ANALYTICS_EVALUATIONS,
        taskSampleSize: activeTasks.length,
        evaluationSampleSize: activeEvaluations.length,
      },
      summary: {
        tasks: activeTasks.length,
        projects: activeProjects.length,
        externalTasks: activeTasks.filter((task) => task.source === "external")
          .length,
        syncedTasks: activeTasks.filter(
          (task) => task.corSyncStatus === "synced",
        ).length,
        pendingCorTasks: activeTasks.filter(
          (task) => task.corSyncStatus === "pending",
        ).length,
        errorCorTasks: activeTasks.filter(
          (task) => task.corSyncStatus === "error",
        ).length,
        overdueTasks: overdueTasks.length,
        dueSoonTasks: dueSoonTasks.length,
        evaluatedTasks: evaluatedTaskIds.size,
        deliverables: deliverableAnalytics.historicalTotal,
      },
      statusCounts,
      projectStatusCounts,
      sourceCounts,
      strategicPriorityCounts,
      tasksByClient,
      tasksByBrand,
      tasksByUser,
      evaluationsByUser,
      weeklyTrend,
      deliverables: deliverableAnalytics,
      evaluations: {
        total: activeEvaluations.length,
        evaluatedTasks: evaluatedTaskIds.size,
        statusCounts: evaluationStatusCounts,
        recent: activeEvaluations.slice(0, 8).map((evaluation) => ({
          taskId: evaluation.taskId,
          status: evaluation.status,
          createdAt: evaluation.createdAt,
        })),
      },
      attention: {
        overdue: overdueTasks.slice(0, 8).map(formatTaskListItem),
        dueSoon: dueSoonTasks.slice(0, 8).map(formatTaskListItem),
      },
    };
  },
});

export const getPeriodDashboard = query({
  args: { periodType: periodTypeValidator, periodKey: v.string(), today: v.string() },
  handler: async (ctx, { periodType, periodKey, today }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || !(await canUserAccessAnalytics(ctx, userId))) {
      return { canAccess: false as const };
    }
    if (!isAnalyticsDay(today) || (periodType === "all"
      ? periodKey !== "all"
      : !isAnalyticsDay(periodKey) || periodKey > today
        || analyticsPeriod(periodType, periodKey).periodKey !== periodKey)) {
      throw new Error("Periodo de analíticas inválido.");
    }

    const published = await ctx.db.query("analyticsState")
      .withIndex("by_key", (q) => q.eq("key", "published")).unique();
    if (!published) return { canAccess: true as const, ready: false as const };
    const datedDeliverables = Boolean(await ctx.db.query("analyticsState")
      .withIndex("by_key", (q) => q.eq("key", "datedDeliverables")).unique());

    const firstPeriod = analyticsPeriod(periodType, analyticsFirstDay);
    const period = periodKey < firstPeriod.periodKey ? firstPeriod : { periodType, periodKey };
    const trendPeriods = analyticsTrendPeriods(period, today).filter((bucket) =>
      bucket.periodKey >= analyticsPeriod(bucket.periodType, analyticsFirstDay).periodKey);
    const [counts, tasksByClient, tasksByBrand, tasksByUser, evaluationsByUser,
      byClient, weeklyTrend, overdue, dueSoon] = await Promise.all([
      readPeriodCounts(ctx, period),
      rankedAnalytics(ctx, period, "tasksByClient", "corClients", 8),
      rankedAnalytics(ctx, period, "tasksByBrand", "clientBrands", 8),
      rankedAnalytics(ctx, period, "tasksByUser", "users", 10),
      rankedAnalytics(ctx, period, "evaluationsByUser", "users", 10),
      readPeriodDeliverables(ctx, period, datedDeliverables),
      Promise.all(trendPeriods.map(async (bucket) => {
        const counts = await readPeriodCounts(ctx, bucket);
        return {
          week: bucket.periodKey < analyticsFirstDay ? analyticsFirstDay : bucket.periodKey,
          count: counts.tasks ?? 0,
          internal: counts.source_internal ?? 0,
          external: counts.source_external ?? 0,
        };
      })),
      periodAttention(ctx, period, "overdue"),
      periodAttention(ctx, period, "dueSoon"),
    ]);
    const count = (key: string) => counts[key] ?? 0;
    const deliverables = count(datedDeliverables ? datedDeliverableMetrics.total : "deliverables");
    const sourceCounts = [
      { key: "internal", label: "Internas", count: count("source_internal") },
      { key: "external", label: "Clientes externos", count: count("source_external") },
    ];
    return {
      canAccess: true as const,
      ready: true as const,
      summary: {
        tasks: count("tasks"),
        projects: count("projects"),
        externalTasks: count("source_external"),
        syncedTasks: count("cor_synced"),
        pendingCorTasks: count("cor_pending"),
        errorCorTasks: count("cor_error"),
        overdueTasks: count("overdue"),
        dueSoonTasks: count("dueSoon"),
        evaluatedTasks: count("evaluatedTasks"),
        deliverables,
      },
      statusCounts: TASK_STATUSES.map((key) => ({
        key, label: getTaskStatusLabel(key), count: count(`task_${key}`),
      })),
      projectStatusCounts: PROJECT_STATUSES.map((key) => ({
        key, label: getProjectStatusLabel(key), count: count(`project_${key}`),
      })),
      sourceCounts,
      strategicPriorityCounts: STRATEGIC_PRIORITIES.map((key) => ({
        key, label: key, count: count(`priority_${key}`),
      })),
      tasksByClient: tasksByClient.map(({ entityId, name, count }) => ({ clientId: entityId, name, count })),
      tasksByBrand: tasksByBrand.map(({ entityId, name, count }) => ({ brandId: entityId, name, count })),
      tasksByUser: tasksByUser.map(({ entityId, name, count }) => ({ userId: entityId, name, count })),
      evaluationsByUser: evaluationsByUser.map(({ entityId, name, count }) => ({ userId: entityId, name, count })),
      weeklyTrend,
      deliverables: {
        historicalTotal: deliverables,
        projectCount: count(datedDeliverables ? datedDeliverableMetrics.projects : "projectsWithDeliverables"),
        byClient,
      },
      evaluations: {
        total: count("evaluations"),
        evaluatedTasks: count("evaluatedTasks"),
        statusCounts: EVALUATION_STATUSES.map((key) => ({
          key, label: getEvaluationStatusLabel(key), count: count(`evaluation_${key}`),
        })),
      },
      attention: { overdue, dueSoon },
    };
  },
});

async function readPeriodCounts(ctx: QueryCtx, { periodType, periodKey }: AnalyticsPeriod) {
  const row = await ctx.db.query("analyticsPeriodRollups").withIndex("by_period", (q) =>
    q.eq("periodType", periodType).eq("periodKey", periodKey)).unique();
  return row?.counts ?? {};
}

type AnalyticsNameTable = "corClients" | "clientBrands" | "subBrands" | "users";

async function rankedAnalytics(
  ctx: QueryCtx,
  { periodType, periodKey }: AnalyticsPeriod,
  metric: string,
  table: AnalyticsNameTable,
  limit: number,
  parentKey = "",
) {
  const rows = await ctx.db.query("analyticsPeriodBreakdowns").withIndex("by_rank", (q) =>
    q.eq("periodType", periodType).eq("periodKey", periodKey).eq("metric", metric)
      .eq("parentKey", parentKey)).order("desc").take(limit);
  const fallback = {
    corClients: "Cliente sin nombre",
    clientBrands: "Marca sin nombre",
    subBrands: "Submarca sin nombre",
    users: "Usuario sin nombre",
  };
  return await Promise.all(rows.map(async ({ entityId, count, projectCount }) => {
    const id = ctx.db.normalizeId(table, entityId);
    const doc = id ? await ctx.db.get(table, id) : null;
    const name = doc && table === "users" ? formatUserName(doc) : doc?.name;
    return { entityId, name: name ?? fallback[table], count, projectCount };
  }));
}

async function readPeriodDeliverables(ctx: QueryCtx, period: AnalyticsPeriod, dated: boolean) {
  const clientMetric = dated ? datedDeliverableMetrics.client : "deliverablesByClient";
  const brandMetric = dated ? datedDeliverableMetrics.brand : "deliverablesByBrand";
  const subBrandMetric = dated ? datedDeliverableMetrics.subBrand : "deliverablesBySubBrand";
  const clients = await rankedAnalytics(ctx, period, clientMetric, "corClients", 8);
  return await Promise.all(clients.map(async (client) => {
    const brands = await rankedAnalytics(ctx, period, brandMetric, "clientBrands", 4, client.entityId);
    return {
      clientId: client.entityId, name: client.name, deliverablesTotal: client.count, projectCount: client.projectCount,
      brands: await Promise.all(brands.map(async (brand) => {
        const subBrands = await rankedAnalytics(ctx, period, subBrandMetric, "subBrands", 3,
          analyticsParentKey(client.entityId, brand.entityId));
        return {
          clientBrandId: brand.entityId, name: brand.name, deliverablesTotal: brand.count, projectCount: brand.projectCount,
          subBrands: subBrands.map((subBrand) => ({
            subBrandId: subBrand.entityId, name: subBrand.name,
            deliverablesTotal: subBrand.count, projectCount: subBrand.projectCount,
          })),
        };
      })),
    };
  }));
}

async function periodAttention(
  ctx: QueryCtx, { periodType, periodKey }: AnalyticsPeriod, kind: "overdue" | "dueSoon",
) {
  const rows = await ctx.db.query("analyticsTaskAttention").withIndex("by_period_kind_created", (q) =>
    q.eq("periodType", periodType).eq("periodKey", periodKey).eq("kind", kind)).order("desc").take(8);
  return rows.map(({ task }) => ({ _id: String(task.taskId), title: task.title,
    deadline: task.deadline, status: task.status, source: task.source }));
}

async function buildDeliverableAnalytics(ctx: QueryCtx, projects: Doc<"projects">[]) {
  type Dimension = {
    scope: "global" | "client" | "brand" | "subBrand";
    clientId?: string;
    clientBrandId?: string;
    subBrandId?: string;
  };
  const aggregated = new Map<string, Dimension & { deliverablesTotal: number; projectCount: number }>();
  function add(dimension: Dimension, deliverables: number) {
    const key = JSON.stringify(dimension);
    const existing = aggregated.get(key);
    if (existing) {
      existing.deliverablesTotal += deliverables;
      existing.projectCount++;
    } else {
      aggregated.set(key, { ...dimension, deliverablesTotal: deliverables, projectCount: 1 });
    }
  }
  for (const project of projects) {
    if (project.convexStatus === "archived" || !PROJECT_STATUSES.some(status => status === project.status)) continue;
    const deliverables = positiveDeliverables(project.deliverables);
    if (!deliverables) continue;
    const { clientId, clientBrandId, subBrandId } = project;
    add({ scope: "global" }, deliverables);
    if (clientId) add({ scope: "client", clientId }, deliverables);
    if (clientId && clientBrandId) add({ scope: "brand", clientId, clientBrandId }, deliverables);
    if (clientId && clientBrandId && subBrandId) add({ scope: "subBrand", clientId, clientBrandId, subBrandId }, deliverables);
  }

  const globalTotals = Array.from(aggregated.values()).filter(
    (item) => item.scope === "global",
  );
  const clientRows = Array.from(aggregated.values()).filter(
    (item) => item.scope === "client",
  );
  const brandRows = Array.from(aggregated.values()).filter(
    (item) => item.scope === "brand",
  );
  const subBrandRows = Array.from(aggregated.values()).filter(
    (item) => item.scope === "subBrand",
  );

  const clientNameById = await loadNames(ctx, clientRows, "clientId");
  const brandNameById = await loadNames(
    ctx,
    brandRows,
    "clientBrandId",
  );
  const subBrandNameById = await loadNames(
    ctx,
    subBrandRows,
    "subBrandId",
  );

  const byClient = clientRows
    .map((client) => {
      const brands = brandRows
        .filter((brand) => brand.clientId === client.clientId)
        .map((brand) => {
          const subBrands = subBrandRows
            .filter((subBrand) => subBrand.clientBrandId === brand.clientBrandId)
            .map((subBrand) => ({
              subBrandId: subBrand.subBrandId!,
              name:
                subBrandNameById.get(subBrand.subBrandId!) ??
                "Submarca sin nombre",
              deliverablesTotal: subBrand.deliverablesTotal,
              projectCount: subBrand.projectCount,
            }))
            .sort((a, b) => b.deliverablesTotal - a.deliverablesTotal);

          return {
            clientBrandId: brand.clientBrandId!,
            name: brandNameById.get(brand.clientBrandId!) ?? "Marca sin nombre",
            deliverablesTotal: brand.deliverablesTotal,
            projectCount: brand.projectCount,
            subBrands,
          };
        })
        .sort((a, b) => b.deliverablesTotal - a.deliverablesTotal);

      return {
        clientId: client.clientId!,
        name: clientNameById.get(client.clientId!) ?? "Cliente sin nombre",
        deliverablesTotal: client.deliverablesTotal,
        projectCount: client.projectCount,
        brands,
      };
    })
    .sort((a, b) => b.deliverablesTotal - a.deliverablesTotal);

  return {
    historicalTotal: globalTotals.reduce(
      (sum, item) => sum + item.deliverablesTotal,
      0,
    ),
    projectCount: globalTotals.reduce((sum, item) => sum + item.projectCount, 0),
    byClient,
  };
}

async function loadNames(
  ctx: any,
  rows: Array<Record<string, any>>,
  key: string,
) {
  const names = new Map<string, string>();
  const ids = Array.from(new Set(rows.map((row) => row[key]).filter(Boolean)));
  for (const id of ids) {
    const doc = await ctx.db.get(id as any);
    if (doc?.name) names.set(id, doc.name);
  }
  return names;
}

function countBy<T>(items: T[], keyFn: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function topEntries(map: Map<string, number>, limit: number) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function startOfToday(now: number) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function buildWeeklyTrend(
  tasks: Array<{ _creationTime: number; source?: "internal" | "external" }>,
  weeks: number,
) {
  const buckets = new Map<string, { internal: number; external: number }>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let index = weeks - 1; index >= 0; index--) {
    const start = new Date(today);
    start.setDate(start.getDate() - index * 7);
    const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
    buckets.set(key, { internal: 0, external: 0 });
  }

  const bucketKeys = Array.from(buckets.keys());
  const firstBucketTime = Date.parse(bucketKeys[0]);
  for (const task of tasks) {
    if (task._creationTime < firstBucketTime) continue;
    const diffWeeks = Math.floor(
      (task._creationTime - firstBucketTime) / (7 * 24 * 60 * 60 * 1000),
    );
    const bucket = buckets.get(bucketKeys[Math.min(diffWeeks, bucketKeys.length - 1)]);
    if (bucket) bucket[task.source ?? "internal"]++;
  }

  return Array.from(buckets, ([week, { internal, external }]) => ({
    week, count: internal + external, internal, external,
  }));
}

function formatTaskListItem(task: any) {
  return {
    _id: String(task._id),
    title: task.title,
    deadline: task.deadline,
    status: task.status,
    source: task.source,
  };
}

function formatUserName(user: any) {
  return user.name || user.email || String(user._id);
}

function getTaskStatusLabel(status: string) {
  const labels: Record<string, string> = {
    nueva: "Nueva",
    en_proceso: "En proceso",
    en_revision: "En revisión",
    en_diseno: "Ajustes",
    estancada: "Suspendida",
    finalizada: "Finalizada",
  };
  return labels[status] ?? status;
}

function getProjectStatusLabel(status: string) {
  const labels: Record<string, string> = {
    active: "Activo",
    in_process: "En proceso",
    suspended: "Suspendido",
    finished: "Finalizado",
  };
  return labels[status] ?? status;
}

function getEvaluationStatusLabel(status: string) {
  const labels: Record<string, string> = {
    processing: "En proceso",
    completed: "Completada",
    failed: "Fallida",
  };
  return labels[status] ?? status;
}
