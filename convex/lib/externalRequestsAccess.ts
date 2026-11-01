import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

async function isExternalBoardEnabled(ctx: QueryCtx, clientId: Id<"corClients">) {
  return (await ctx.db.get(clientId))?.externalBoardEnabled === true;
}

async function taskClientId(ctx: QueryCtx, task: Doc<"tasks">) {
  let clientId = task.clientId;
  if (task.clientBrandId) return (await ctx.db.get(task.clientBrandId))?.clientId;
  if (!clientId && task.corClientId !== undefined) clientId = (await ctx.db.query("corClients").withIndex("by_corClientId", q => q.eq("corClientId", task.corClientId!)).unique())?._id;
  return clientId;
}

// Categories do not restrict this feature: any assignment to an enabled client qualifies.
export async function hasExternalRequestsAccess(ctx: QueryCtx, userId: Id<"users">) {
  const external = await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique();
  if (!external) return false;
  const assignments = await ctx.db.query("clientUserAssignments").withIndex("by_user", q => q.eq("userId", userId)).collect();
  for (const clientId of new Set(assignments.map(assignment => assignment.clientId))) {
    if (await isExternalBoardEnabled(ctx, clientId)) return true;
  }
  return false;
}

export async function canViewExternalRequest(ctx: QueryCtx, userId: Id<"users">, task: Doc<"tasks">) {
  if (task.source !== "external" || task.convexStatus === "deleted" || task.convexStatus === "archived") return false;
  const clientId = await taskClientId(ctx, task);
  if (!clientId || !(await isExternalBoardEnabled(ctx, clientId))) return false;
  const external = await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique();
  if (!external) return false;
  // Access to another enabled client must never grant access to this task's client.
  const assignments = await ctx.db.query("clientUserAssignments").withIndex("by_client_and_user", q => q.eq("clientId", clientId).eq("userId", userId)).collect();
  return assignments.some(assignment => assignment.brandId === undefined || assignment.brandId === task.clientBrandId);
}

// Include legacy tasks linked only through COR or a brand, without scanning all tasks.
// Every candidate must still pass canViewExternalRequest before being returned.
export async function externalRequestCandidates(ctx: QueryCtx, userId: Id<"users">) {
  const assignments = await ctx.db.query("clientUserAssignments")
    .withIndex("by_user", q => q.eq("userId", userId)).collect();
  const candidates = new Map<string, Doc<"tasks">>();
  for (const clientId of new Set(assignments.map(a => a.clientId))) {
    const client = await ctx.db.get(clientId);
    if (client?.externalBoardEnabled !== true) continue;
    const brands = await ctx.db.query("clientBrands").withIndex("by_client", q => q.eq("clientId", clientId)).collect();
    const groups = await Promise.all([
      ctx.db.query("tasks").withIndex("by_clientId", q => q.eq("clientId", clientId)).collect(),
      ...(client ? [ctx.db.query("tasks").withIndex("by_corClientId", q => q.eq("corClientId", client.corClientId)).collect()] : []),
      ...brands.map(brand => ctx.db.query("tasks").withIndex("by_clientBrandId", q => q.eq("clientBrandId", brand._id)).collect()),
    ]);
    for (const task of groups.flat()) candidates.set(String(task._id), task);
  }
  return [...candidates.values()].sort((a, b) => b._creationTime - a._creationTime);
}
