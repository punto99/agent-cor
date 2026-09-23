import { clientConfig } from "../../config/tenant.config";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

function enabledClientIds() {
  return new Set(clientConfig.ui.externalRequestsClientIds.map(id => id.trim()).filter(Boolean));
}

async function taskClientId(ctx: QueryCtx, task: Doc<"tasks">) {
  let clientId = task.clientId;
  if (task.clientBrandId) clientId = (await ctx.db.get(task.clientBrandId))?.clientId;
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
  if (task.source !== "external" || task.createdBy !== String(userId) || task.convexStatus === "deleted") return false;
  const clientId = await taskClientId(ctx, task);
  if (!clientId || !enabledClientIds().has(String(clientId))) return false;
  const external = await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique();
  if (!external) return false;
  // Access to another enabled client must never grant access to this task's client.
  const assignment = await ctx.db.query("clientUserAssignments").withIndex("by_client_and_user", q => q.eq("clientId", clientId).eq("userId", userId)).first();
  return Boolean(assignment);
}

export async function isRequestsClientTask(ctx: QueryCtx, task: Doc<"tasks">) {
  const clientId = await taskClientId(ctx, task);
  return Boolean(clientId && enabledClientIds().has(String(clientId)));
}
