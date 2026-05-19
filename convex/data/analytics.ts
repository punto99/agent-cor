import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "../_generated/server";
import { canUserAccessAnalytics } from "../lib/analyticsAccess";

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
const EVALUATION_STATUSES = ["pending", "in_progress", "completed"] as const;
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
      .query("evaluationThreads")
      .withIndex("by_createdAt")
      .order("desc")
      .take(MAX_ANALYTICS_EVALUATIONS);

    const activeTasks = recentTasks.filter(
      (task) => task.convexStatus !== "deleted",
    );
    const activeProjects = allProjects.filter(
      (project) => project.convexStatus !== "deleted",
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

    const tasksById = new Map(
      activeTasks.map((task) => [String(task._id), task]),
    );
    const taskUserCounts = countBy(
      activeTasks.filter((task) => task.createdBy),
      (task) => String(task.createdBy),
    );
    const evaluationUserCounts = new Map<string, number>();

    for (const evaluation of recentEvaluations) {
      let task = tasksById.get(String(evaluation.taskId));
      if (!task) {
        const fetchedTask = await ctx.db.get(evaluation.taskId);
        if (fetchedTask && fetchedTask.convexStatus !== "deleted") {
          task = fetchedTask;
        }
      }
      if (!task?.createdBy) continue;
      const createdBy = String(task.createdBy);
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
    const evaluationStatusCounts = EVALUATION_STATUSES.map((status) => ({
      key: status,
      label: getEvaluationStatusLabel(status),
      count: recentEvaluations.filter(
        (evaluation) => evaluation.status === status,
      ).length,
    }));
    const evaluatedTaskIds = new Set(
      recentEvaluations.map((evaluation) => String(evaluation.taskId)),
    );

    return {
      canAccess: true as const,
      generatedAt: now,
      limits: {
        maxTasksRead: MAX_ANALYTICS_TASKS,
        maxEvaluationsRead: MAX_ANALYTICS_EVALUATIONS,
        taskSampleSize: activeTasks.length,
        evaluationSampleSize: recentEvaluations.length,
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
      evaluations: {
        total: recentEvaluations.length,
        evaluatedTasks: evaluatedTaskIds.size,
        statusCounts: evaluationStatusCounts,
        recent: recentEvaluations.slice(0, 8).map((evaluation) => ({
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
    pending: "Pendiente",
    in_progress: "En progreso",
    completed: "Completada",
  };
  return labels[status] ?? status;
}
