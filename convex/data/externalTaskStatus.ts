import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { TASK_STATUS_OPTIONS } from "../lib/taskStatuses";

// Read only: the state is the latest value stored in Convex, never a live
// request to COR or Trello. Do not expose the full task to the external agent.
export const get = internalQuery({
  args: { threadId: v.string(), taskId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const denied = { ok: false as const, message: "No se encontró un requerimiento al que tengas acceso." };
    const thread = await ctx.db.query("chatThreads")
      .withIndex("by_thread", q => q.eq("threadId", args.threadId)).first();
    if (!thread) return denied;
    const approved = await ctx.db.query("approvedExternalUsers")
      .withIndex("by_user", q => q.eq("userId", thread.userId)).unique();
    if (!approved) return denied;

    const id = args.taskId ? ctx.db.normalizeId("tasks", args.taskId) : null;
    const task = args.taskId
      ? (id ? await ctx.db.get(id) : null)
      : await ctx.db.query("tasks")
        .withIndex("by_thread", q => q.eq("threadId", args.threadId)).first();
    if (!task || task.source !== "external" || task.convexStatus === "deleted" ||
        task.createdBy !== String(thread.userId) || !task.clientId) return denied;

    const assignments = await ctx.db.query("clientUserAssignments")
      .withIndex("by_client_and_user", q => q.eq("clientId", task.clientId!).eq("userId", thread.userId)).collect();
    const allowed = assignments.some(a => a.brandId === undefined ||
      (task.clientBrandId !== undefined && a.brandId === task.clientBrandId));
    if (!allowed) return denied;

    if (!task.corTaskId?.trim()) {
      return {
        ok: true as const, title: task.title, state: "pending_review" as const,
        message: "Tu requerimiento está pendiente de revisión por el equipo.",
      };
    }
    const status = TASK_STATUS_OPTIONS.find(option => option.value === task.status);
    if (!status) {
      return {
        ok: true as const, title: task.title, state: "unknown" as const,
        message: "No puedo confirmar el estado actual del requerimiento con la información registrada.",
      };
    }
    return {
      ok: true as const, title: task.title, state: "recorded_status" as const,
      status: status.name, message: `El último estado registrado de tu requerimiento es: ${status.name}.`,
    };
  },
});
