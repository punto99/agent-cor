import { clientConfig } from "../../config/tenant.config";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

function enabledClientIds() {
  return new Set(clientConfig.ui.externalRequestsClientIds.map(id => id.trim()).filter(Boolean));
}

async function taskClientId(ctx: QueryCtx, task: Doc<"tasks">) {
  let clientId = task.clientId;
  if (task.clientBrandId) return (await ctx.db.get(task.clientBrandId))?.clientId;
  if (!clientId && task.corClientId !== undefined) clientId = (await ctx.db.query("corClients").withIndex("by_corClientId", q => q.eq("corClientId", task.corClientId!)).unique())?._id;
  return clientId;
}

// Categories do not restrict this feature: any assignment to an enabled client qualifies.
export async function hasExternalRequestsAccess(ctx: QueryCtx, userId: Id<"users">) {
  const configured = enabledClientIds();
  if (!configured.size) return false;
  const external = await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique();
  if (!external) return false;
  const assignments = await ctx.db.query("clientUserAssignments").withIndex("by_user", q => q.eq("userId", userId)).collect();
  return assignments.some(assignment => configured.has(String(assignment.clientId)));
}

export async function canViewExternalRequest(ctx: QueryCtx, userId: Id<"users">, task: Doc<"tasks">) {
  if (task.source !== "external" || task.convexStatus === "deleted") return false;
  const clientId = await taskClientId(ctx, task);
  if (!clientId || !enabledClientIds().has(String(clientId))) return false;
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
  const configured = enabledClientIds();
  const candidates = new Map<string, Doc<"tasks">>();
  for (const clientId of new Set(assignments.map(a => a.clientId))) {
    if (!configured.has(String(clientId))) continue;
    const client = await ctx.db.get(clientId);
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

export async function isRequestsClientTask(ctx: QueryCtx, task: Doc<"tasks">) {
  const clientId = await taskClientId(ctx, task);
  return Boolean(clientId && enabledClientIds().has(String(clientId)));
}
