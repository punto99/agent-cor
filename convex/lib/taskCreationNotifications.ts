import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { hasTaskAccess } from "../data/tasks";

export async function canReceiveTaskCreation(ctx: QueryCtx, userId: Id<"users">, task: Doc<"tasks">) {
  if (task.source !== "external" || task.convexStatus === "deleted" || task.convexStatus === "archived") return false;
  if (await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique()) return false;
  return await hasTaskAccess(ctx, task, userId);
}

export async function notifyExternalTaskCreated(ctx: MutationCtx, taskId: Id<"tasks">) {
  const task = await ctx.db.get(taskId);
  if (!task || task.source !== "external" || !task.createdBy) return;
  const creator = ctx.db.normalizeId("users", task.createdBy);
  if (!creator || !(await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", creator)).unique())) return;
  let clientId = task.clientId;
  if (task.clientBrandId) clientId = (await ctx.db.get(task.clientBrandId))?.clientId;
  if (!clientId && task.corClientId) clientId = (await ctx.db.query("corClients").withIndex("by_corClientId", q => q.eq("corClientId", task.corClientId!)).unique())?._id;
  if (!clientId) return;
  const assignments = await ctx.db.query("clientUserAssignments").withIndex("by_client", q => q.eq("clientId", clientId!)).collect();
  for (const userId of new Set(assignments.map(a => a.userId))) {
    if (!(await canReceiveTaskCreation(ctx, userId, task))) continue;
    if (await ctx.db.query("taskCreationNotifications").withIndex("by_user_task", q => q.eq("userId", userId).eq("taskId", taskId)).unique()) continue;
    await ctx.db.insert("taskCreationNotifications", { userId, taskId, read: false, createdAt: Date.now(), emailState: "pending", attempts: 0, nextAttemptAt: Date.now() });
  }
}

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function taskCreationEmail(args: { from: string; to: string; baseUrl: string; taskId: string; title: string; author: string; client: string; category?: string; brand?: string; deadline?: string }) {
  const base = new URL(args.baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(local && base.protocol === "http:")) || base.username || base.password) throw new Error("APP_URL/SITE_URL debe usar HTTPS, o HTTP en localhost para pruebas locales.");
  const url = new URL("/workspace/control-panel", base);
  url.searchParams.set("taskId", args.taskId); url.searchParams.set("tab", "task");
  const lines = [`${args.author} creó una nueva tarea.`, `Tarea: ${args.title}`, `Cliente: ${args.client}`, args.category && `Categoría: ${args.category}`, args.brand && `Marca: ${args.brand}`, args.deadline && `Vencimiento: ${args.deadline}`].filter((line): line is string => Boolean(line));
  return { from: args.from, to: [args.to], subject: `Nueva tarea de ${args.client}: ${args.title}`.replace(/[\r\n]/g, " ").slice(0, 200), text: [...lines, "", `Ver tarea: ${url.href}`].join("\n"), html: `<div style="font-family:Arial,sans-serif;color:#172b4d;line-height:1.6"><h2>Nueva tarea externa</h2>${lines.map(line => `<p>${escape(line)}</p>`).join("")}<p><a style="display:inline-block;padding:10px 18px;background:#0c66e4;color:#fff;border-radius:6px;text-decoration:none" href="${escape(url.href)}">Ver tarea</a></p></div>` };
}
