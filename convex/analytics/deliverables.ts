import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { positiveDeliverables } from "../lib/deliverableAnalytics";
import type { AnalyticsPeriod } from "./calendar";
import type { taskShareValidator } from "./tables";

export const datedDeliverableMetrics = {
  total: "datedDeliverables",
  projects: "datedProjectsWithDeliverables",
  client: "datedDeliverablesByClient",
  brand: "datedDeliverablesByBrand",
  subBrand: "datedDeliverablesBySubBrand",
} as const;

export type TaskShare = Infer<typeof taskShareValidator>;

export function legacyTaskShare(task: Doc<"tasks">): TaskShare | null {
  if (!task.projectId || task.projectDeliverableAllocation?.trackedOnProject) return null;
  const amount = task.projectDeliverableAllocation?.amount ?? positiveDeliverables(task.deliverablesCount);
  return amount > 0 ? { projectId: task.projectId, amount } : null;
}

export function projectDeliverableRemainder(recorded: number, covered: number, legacyShares: number) {
  return Math.max(0, recorded - covered - legacyShares);
}

export function readLegacyShares(ctx: QueryCtx, projectId: Id<"projects">) {
  return ctx.db.query("analyticsLegacyDeliverableShares")
    .withIndex("by_project", q => q.eq("projectId", projectId)).unique();
}

export async function changeLegacyShares(ctx: MutationCtx, projectId: Id<"projects">, delta: number) {
  const row = await readLegacyShares(ctx, projectId);
  const amount = (row?.amount ?? 0) + delta;
  if (amount < 0) throw new Error("Analytics project deliverable shares are inconsistent");
  if (row && amount === 0) await ctx.db.delete(row._id);
  else if (row) await ctx.db.patch(row._id, { amount });
  else if (amount > 0) await ctx.db.insert("analyticsLegacyDeliverableShares", { projectId, amount });
}

export async function changeDeliverableMembership(
  ctx: MutationCtx, period: AnalyticsPeriod, projectId: Id<"projects"> | undefined,
  dimension: string, delta: number,
) {
  if (!projectId || !delta) return 0;
  const row = await ctx.db.query("analyticsDeliverableProjectPeriods")
    .withIndex("by_period_project_dimension", q => q.eq("periodType", period.periodType)
      .eq("periodKey", period.periodKey).eq("projectId", projectId).eq("dimension", dimension)).unique();
  const before = row?.sources ?? 0;
  const sources = before + delta;
  if (sources < 0) throw new Error("Analytics project-period membership is inconsistent");
  if (row && sources === 0) await ctx.db.delete(row._id);
  else if (row) await ctx.db.patch(row._id, { sources });
  else if (sources > 0) await ctx.db.insert("analyticsDeliverableProjectPeriods", {
    ...period, projectId, dimension, sources,
  });
  return Number(sources > 0) - Number(before > 0);
}
