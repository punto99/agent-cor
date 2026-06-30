import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { canUserAccessAnalytics } from "../lib/analyticsAccess";
import { applyProjectDeliverablesDelta } from "../lib/deliverableAnalytics";
import { isExcludedUserId } from "../lib/excludedUsers";

const TASK_STATUSES = [
  "nueva",
  "en_proceso",
  "en_revision",
  "en_diseno",
  "estancada",
  "finalizada",
] as const;

const PROJECT_STATUSES = [
  "active",
  "in_process",
  "suspended",
  "finished",
] as const;

const STRATEGIC_PRIORITIES = ["I_U", "I_NU", "NI_U", "NI_NU"] as const;
const EVALUATION_STATUSES = ["processing", "completed", "failed"] as const;
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
      canAccess: canUserAccessAnalytics(String(userId)),
    };
  },
});

export const rebuildDeliverableAnalyticsRollups = mutation({
  args: {
    confirm: v.string(),
  },
  handler: async (ctx, args) => {
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
    if (!userId || !canUserAccessAnalytics(String(userId))) {
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
    const deliverableAnalytics = await buildDeliverableAnalytics(ctx);
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

async function buildDeliverableAnalytics(ctx: any) {
  const rollups = await ctx.db
    .query("deliverableAnalyticsRollups")
    .collect();

  const aggregated = new Map<
    string,
    {
      scope: "global" | "client" | "brand" | "subBrand";
      clientId?: string;
      clientBrandId?: string;
      subBrandId?: string;
      deliverablesTotal: number;
      projectCount: number;
    }
  >();

  for (const rollup of rollups) {
    if (
      (rollup as any).periodType !== undefined ||
      (rollup as any).periodKey !== undefined
    ) {
      continue;
    }
    if (rollup.deliverablesTotal <= 0) continue;
    const key = [
      rollup.scope,
      rollup.clientId ? String(rollup.clientId) : "-",
      rollup.clientBrandId ? String(rollup.clientBrandId) : "-",
      rollup.subBrandId ? String(rollup.subBrandId) : "-",
    ].join("|");
    const current = aggregated.get(key);
    if (current) {
      current.deliverablesTotal += rollup.deliverablesTotal;
      current.projectCount += rollup.projectCount;
      continue;
    }
    aggregated.set(key, {
      scope: rollup.scope,
      clientId: rollup.clientId ? String(rollup.clientId) : undefined,
      clientBrandId: rollup.clientBrandId
        ? String(rollup.clientBrandId)
        : undefined,
      subBrandId: rollup.subBrandId ? String(rollup.subBrandId) : undefined,
      deliverablesTotal: rollup.deliverablesTotal,
      projectCount: rollup.projectCount,
    });
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
  tasks: Array<{ _creationTime: number }>,
  weeks: number,
) {
  const buckets = new Map<string, number>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let index = weeks - 1; index >= 0; index--) {
    const start = new Date(today);
    start.setDate(start.getDate() - index * 7);
    const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
    buckets.set(key, 0);
  }

  const bucketKeys = Array.from(buckets.keys());
  const firstBucketTime = Date.parse(bucketKeys[0]);
  for (const task of tasks) {
    if (task._creationTime < firstBucketTime) continue;
    const diffWeeks = Math.floor(
      (task._creationTime - firstBucketTime) / (7 * 24 * 60 * 60 * 1000),
    );
    const key = bucketKeys[Math.min(diffWeeks, bucketKeys.length - 1)];
    if (key) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  return bucketKeys.map((key) => ({ week: key, count: buckets.get(key) ?? 0 }));
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
