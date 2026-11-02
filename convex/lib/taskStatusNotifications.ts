import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { canViewExternalRequest, taskClientId } from "./externalRequestsAccess";
import { getTaskStatusName } from "./taskStatuses";

export async function canReceiveTaskStatus(ctx: QueryCtx, userId: Id<"users">, task: Doc<"tasks">) {
  const external = await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique();
  return external?.isCoordinator === true && await canViewExternalRequest(ctx, userId, task);
}

// The update and notifications share a transaction. Reading the current status here
// makes repeated syncs a no-op, while A -> B -> A -> B remains three distinct events.
export async function patchTaskWithStatusNotification(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  updates: Partial<Omit<Doc<"tasks">, "_id" | "_creationTime">>,
  source: "platform" | "cor" | "trello",
) {
  const before = await ctx.db.get(taskId);
  if (!before) throw new Error("Task no encontrada.");
  const fromStatus = before.status;
  await ctx.db.patch(taskId, updates);
  if (updates.status === undefined || updates.status === fromStatus) return;
  const task = { ...before, ...updates };
  if (task.source !== "external" || task.convexStatus === "deleted" || task.convexStatus === "archived") return;
  const clientId = await taskClientId(ctx, task);
  if (!clientId) return;
  const assignments = await ctx.db.query("clientUserAssignments").withIndex("by_client", q => q.eq("clientId", clientId)).collect();
  const now = Date.now();
  for (const userId of new Set(assignments.map(assignment => assignment.userId))) {
    if (!(await canReceiveTaskStatus(ctx, userId, task))) continue;
    await ctx.db.insert("taskStatusNotifications", {
      userId, taskId, fromStatus, toStatus: updates.status, source,
      read: false, createdAt: now, emailState: "pending", attempts: 0, nextAttemptAt: now,
    });
  }
}

export function taskStatusEmail(args: {
  from: string; to: string; baseUrl: string; taskId: string; title: string;
  fromStatus: string; toStatus: string; client: string;
}) {
  const base = new URL(args.baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(local && base.protocol === "http:")) || base.username || base.password) {
    throw new Error("APP_URL/SITE_URL debe usar HTTPS, o HTTP en localhost para pruebas locales.");
  }
  const url = new URL("/workspace/requests", base);
  url.searchParams.set("taskId", args.taskId);
  url.searchParams.set("tab", "task");
  const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const transition = `${getTaskStatusName(args.fromStatus)} → ${getTaskStatusName(args.toStatus)}`;
  const lines = [`La tarea cambió de estado.`, `Tarea: ${args.title}`, `Cliente: ${args.client}`, `Estado: ${transition}`];
  return {
    from: args.from, to: [args.to],
    subject: `Cambio de estado: ${args.title}`.replace(/[\r\n]/g, " ").slice(0, 200),
    text: [...lines, "", `Ver tarea: ${url.href}`].join("\n"),
    html: `<div style="font-family:Arial,sans-serif;color:#172b4d;line-height:1.6"><h2>Cambio de estado</h2>${lines.map(line => `<p>${escape(line)}</p>`).join("")}<p><a style="display:inline-block;padding:10px 18px;background:#0c66e4;color:#fff;border-radius:6px;text-decoration:none" href="${escape(url.href)}">Ver tarea</a></p></div>`,
  };
}
