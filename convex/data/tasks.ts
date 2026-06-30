// convex/data/tasks.ts
// Funciones Convex para manejar tasks/requerimientos
// (mutations, queries, internalActions, publish flow, sync flow)
//
// NOTA: Los tools de agentes están en convex/tools/
import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  internalAction,
} from "../_generated/server";
import { listMessages } from "@convex-dev/agent";
import { internal, components } from "../_generated/api";
import { getProjectManagementProvider } from "../integrations/registry";
import type { ProjectManagementProvider } from "../integrations/types";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  hashText,
  isStrategicPriority,
  type StrategicPriority,
} from "../lib/briefFormat";
import {
  shouldRetry,
  getRetryDelay,
  formatRetryError,
  isClientError,
  MAX_RETRY_ATTEMPTS,
} from "../lib/corRetry";
import { applyProjectDeliverablesDelta } from "../lib/deliverableAnalytics";
import { formatTrelloCommentForCOR } from "../lib/trelloCommentFormat";
import { isTrelloEnabledForCorClientId } from "../lib/trelloPolicy";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

const STRATEGIC_PRIORITY_LABEL_IDS: Record<StrategicPriority, number> = {
  I_NU: 370185,
  I_U: 370186,
  NI_NU: 370188,
  NI_U: 370187,
};
const PENDING_COR_MESSAGE_STATUSES = new Set(["pending_cor_task", "pending"]);
const EXTERNAL_COMMENT_SOURCES = new Set(["trello", "external_agent"]);
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\(https?:\/\/[^\s)]+(?:\s+"[^"]*")?\)/;

const MIN_PUBLISHABLE_DESCRIPTION_LENGTH = 40;
const DESCRIPTION_MIN_REMAINING_RATIO = 0.35;

async function isExternalUser(ctx: any, userId: any) {
  const approvedExternalUser = await ctx.db
    .query("approvedExternalUsers")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .unique();
  return Boolean(approvedExternalUser);
}

async function resolveCreationTaxonomy(
  ctx: any,
  args: {
    clientId?: any;
    corClientId?: number;
    clientBrandId?: any;
    subBrandId?: any;
  },
) {
  let clientId = args.clientId;
  if (!clientId && args.corClientId !== undefined) {
    const client = await ctx.db
      .query("corClients")
      .withIndex("by_corClientId", (q: any) =>
        q.eq("corClientId", args.corClientId!),
      )
      .unique();
    clientId = client?._id;
  }

  let brand = args.clientBrandId ? await ctx.db.get(args.clientBrandId) : null;
  if (args.clientBrandId && !brand) {
    throw new Error("❌ La categoría seleccionada no existe.");
  }

  if (clientId && brand?.clientId && brand.clientId !== clientId) {
    throw new Error(
      "❌ La categoría seleccionada no pertenece al cliente validado.",
    );
  }

  if (clientId && !brand) {
    const clientBrands = await ctx.db
      .query("clientBrands")
      .withIndex("by_client", (q: any) => q.eq("clientId", clientId))
      .collect();
    if (clientBrands.length > 0) {
      throw new Error(
        "❌ Este cliente tiene categorías configuradas. Debes seleccionar una categoría antes de crear el requerimiento.",
      );
    }
  }

  let subBrand = args.subBrandId ? await ctx.db.get(args.subBrandId) : null;
  if (args.subBrandId && !subBrand) {
    throw new Error("❌ La marca seleccionada no existe.");
  }

  if (!brand && subBrand) {
    brand = await ctx.db.get(subBrand.clientBrandId);
  }

  if (brand) {
    const subBrands = await ctx.db
      .query("subBrands")
      .withIndex("by_brand", (q: any) => q.eq("clientBrandId", brand!._id))
      .collect();

    if (subBrands.length > 0 && !subBrand) {
      throw new Error(
        `❌ La categoría "${brand.name}" tiene marcas configuradas. Debes seleccionar una marca antes de crear el requerimiento.`,
      );
    }

    if (subBrand && subBrand.clientBrandId !== brand._id) {
      throw new Error(
        "❌ La marca seleccionada no pertenece a la categoría validada.",
      );
    }
  }

  return {
    clientId,
    clientBrandId: brand?._id,
    brandId: brand?.corBrandId,
    brandName: brand?.name,
    subBrandId: subBrand?._id,
    productId: subBrand?.corProductId,
    subBrandName: subBrand?.name,
  };
}

function normalizeDescriptionText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForComparison(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isPlaceholderDescription(value: unknown): boolean {
  const normalized = normalizeForComparison(normalizeDescriptionText(value));
  if (!normalized) return true;
  return [
    "sin descripcion",
    "no especificado",
    "no especificada",
    "descripcion pendiente",
    "pendiente",
  ].includes(normalized);
}

function hasBriefStructure(value: unknown): boolean {
  const normalized = normalizeForComparison(normalizeDescriptionText(value));
  return (
    normalized.includes("tipo de requerimiento") &&
    normalized.includes("entregables")
  );
}

function validateDescriptionUpdate(
  currentDescription: unknown,
  nextDescription: unknown,
): string | null {
  const currentText = normalizeDescriptionText(currentDescription);
  const nextText = normalizeDescriptionText(nextDescription);

  if (isPlaceholderDescription(nextDescription)) {
    return "No se puede guardar una descripción vacía o placeholder. La descripción contiene el brief completo.";
  }

  if (
    currentText &&
    nextText.length <
      Math.max(20, currentText.length * DESCRIPTION_MIN_REMAINING_RATIO)
  ) {
    return "No se puede reemplazar la descripción por una versión mucho más corta. Edita solo la sección necesaria y conserva el resto del brief.";
  }

  if (
    hasBriefStructure(currentDescription) &&
    !hasBriefStructure(nextDescription)
  ) {
    return "No se puede guardar la descripción porque perdió secciones base del brief como tipo de requerimiento o entregables.";
  }

  return null;
}

function validatePublishableDescription(description: unknown): string | null {
  const text = normalizeDescriptionText(description);
  if (
    isPlaceholderDescription(description) ||
    text.length < MIN_PUBLISHABLE_DESCRIPTION_LENGTH
  ) {
    return "No se puede publicar en COR: la descripción/brief está vacía o incompleta.";
  }
  return null;
}

function isDateBeforeToday(value: string | undefined): boolean {
  if (!value) return false;
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date < new Date().toISOString().slice(0, 10);
}

function getTodayDateKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Cancun",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function getPublishDeadlineError(deadline: unknown): string | null {
  if (typeof deadline !== "string" || !deadline.trim()) {
    return "No se puede publicar en COR: completa la fecha de fin.";
  }

  const match = deadline
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/);
  if (!match) {
    return "No se puede publicar en COR: la fecha de fin debe ser una fecha valida en formato AAAA-MM-DD.";
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return "No se puede publicar en COR: la fecha de fin no es una fecha valida.";
  }

  const dateKey = `${match[1]}-${match[2]}-${match[3]}`;
  if (dateKey < getTodayDateKey()) {
    return "No se puede publicar en COR: la fecha de fin no puede ser una fecha pasada.";
  }

  return null;
}

function optionalStringFromExternal(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function optionalNumberFromExternal(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

async function syncStrategicPriorityLabelInCOR(
  taskId: number,
  strategicPriority: StrategicPriority,
): Promise<void> {
  const provider = getProjectManagementProvider();
  const targetLabelId = STRATEGIC_PRIORITY_LABEL_IDS[strategicPriority];

  for (const labelId of Object.values(STRATEGIC_PRIORITY_LABEL_IDS)) {
    if (labelId === targetLabelId) continue;
    const unassignResult = await provider.setTaskLabel({
      taskId,
      labelId,
      unassign: true,
    });
    if (!unassignResult.success) {
      throw new Error(
        unassignResult.error ||
          `No se pudo desasignar etiqueta ${labelId} en task COR ${taskId}`,
      );
    }
  }

  const assignResult = await provider.setTaskLabel({
    taskId,
    labelId: targetLabelId,
  });
  if (!assignResult.success) {
    throw new Error(
      assignResult.error ||
        `No se pudo asignar etiqueta ${targetLabelId} en task COR ${taskId}`,
    );
  }
}

// ==================== MUTATIONS ====================

// Mutation interna para crear task (llamada desde el tool o workflow)
export const createTaskInternal = internalMutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    deadline: v.optional(v.string()),
    deliverablesCount: v.optional(v.number()),
    priority: v.optional(v.number()), // 0=Low, 1=Medium, 2=High, 3=Urgent
    threadId: v.string(),
    status: v.string(),
    createdBy: v.optional(v.string()),
    // Referencia al proyecto local
    projectId: v.optional(v.string()),
    clientId: v.optional(v.id("corClients")),
    // Campos para sincronización con COR
    corTaskId: v.optional(v.string()),
    corProjectId: v.optional(v.number()),
    corSyncStatus: v.optional(v.string()),
    corSyncError: v.optional(v.string()),
    // Campos para identificar el cliente en el sistema externo
    corClientId: v.optional(v.number()),
    corClientName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log("[Tasks.createTaskInternal] Insertando en base de datos...");

    let clientId = args.clientId;
    if (!clientId && args.projectId) {
      const project = await ctx.db.get(args.projectId as any);
      if (project && "clientId" in project && project.clientId) {
        clientId = project.clientId;
      }
    }
    if (!clientId && args.corClientId !== undefined) {
      const client = await ctx.db
        .query("corClients")
        .withIndex("by_corClientId", (q) =>
          q.eq("corClientId", args.corClientId!),
        )
        .unique();
      clientId = client?._id;
    }

    const taskId = await ctx.db.insert("tasks", {
      title: args.title,
      description: args.description,
      deadline: args.deadline,
      deliverablesCount: args.deliverablesCount,
      priority: args.priority ?? 1,
      threadId: args.threadId,
      status: args.status,
      convexStatus: "active",
      createdBy: args.createdBy,
      // Referencia al proyecto local
      projectId: args.projectId as any,
      clientId,
      // Campos COR / sistema externo
      corTaskId: args.corTaskId,
      corProjectId: args.corProjectId,
      corSyncStatus: args.corSyncStatus,
      corSyncError: args.corSyncError,
      corClientId: args.corClientId,
      corClientName: args.corClientName,
    });

    console.log(`[Tasks.createTaskInternal] Task insertada con ID: ${taskId}`);

    return taskId;
  },
});

// Mutation interna para actualizar task (llamada desde el editTaskTool)
export const updateTaskInternal = internalMutation({
  args: {
    taskId: v.string(),
    updates: v.object({
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      deadline: v.optional(v.string()),
      priority: v.optional(v.number()), // 0=Low, 1=Medium, 2=High, 3=Urgent
      strategicPriority: v.optional(
        v.union(
          v.literal("I_U"),
          v.literal("I_NU"),
          v.literal("NI_U"),
          v.literal("NI_NU"),
        ),
      ),
    }),
    allowedFields: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    console.log(
      `[Tasks.updateTaskInternal] Actualizando task ${args.taskId}...`,
    );

    const task: any = await ctx.db.get(args.taskId as any);
    if (!task) throw new Error("Task no encontrada");

    // Filtrar campos undefined
    const updateData: any = {};
    for (const [key, value] of Object.entries(args.updates)) {
      if (value !== undefined) {
        updateData[key] = value;
      }
    }

    const updateKeys = Object.keys(updateData);
    if (args.allowedFields) {
      const allowedFields = new Set(args.allowedFields);
      const unexpectedFields = updateKeys.filter(
        (field) => !allowedFields.has(field),
      );
      if (unexpectedFields.length > 0) {
        throw new Error(
          `Edición rechazada: campos no permitidos para esta operación (${unexpectedFields.join(", ")}).`,
        );
      }
    }

    if (updateKeys.includes("description")) {
      const descriptionError = validateDescriptionUpdate(
        task.description,
        updateData.description,
      );
      if (descriptionError) throw new Error(descriptionError);
    }

    // Registrar timestamp de edición local (detección de conflictos bidireccional)
    updateData.lastLocalEditAt = Date.now();

    await ctx.db.patch(args.taskId as any, updateData);

    console.log(`[Tasks.updateTaskInternal] Task actualizada`);
    return args.taskId;
  },
});

export const setTaskStrategicPriorityInternal = internalMutation({
  args: {
    taskId: v.id("tasks"),
    strategicPriority: v.union(
      v.literal("I_U"),
      v.literal("I_NU"),
      v.literal("NI_U"),
      v.literal("NI_NU"),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId, {
      strategicPriority: args.strategicPriority,
    });
  },
});

// Query interna para obtener task por threadId
export const getTaskByThreadInternal = internalQuery({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    if (task?.convexStatus === "deleted") return null;
    return task;
  },
});

// Query interna para obtener task por ID
export const getTaskByIdInternal = internalQuery({
  args: {
    taskId: v.string(),
  },
  handler: async (ctx, args) => {
    const taskId = ctx.db.normalizeId("tasks", args.taskId);
    if (!taskId) return null;

    const task = await ctx.db.get(taskId);
    if (task?.convexStatus === "deleted") return null;
    return task;
  },
});

// Query interna liviana para workers de sync COR.
// Evita leer campos pesados como description cuando solo se necesitan guardas.
export const getTaskCORSyncSnapshotInternal = internalQuery({
  args: {
    taskId: v.string(),
  },
  handler: async (ctx, args) => {
    const taskId = ctx.db.normalizeId("tasks", args.taskId);
    if (!taskId) return null;

    const task = await ctx.db.get(taskId);
    if (task?.convexStatus === "deleted") return null;
    if (!task) return null;

    return {
      _id: task._id,
      status: task.status,
      corTaskId: task.corTaskId,
      corSyncStatus: task.corSyncStatus,
    };
  },
});

// Query interna para obtener task por COR ID
export const getTaskByCORIdInternal = internalQuery({
  args: {
    corTaskId: v.string(),
  },
  handler: async (ctx, args) => {
    // Buscar la task que tenga este COR ID
    const task = await ctx.db
      .query("tasks")
      .filter((q) => q.eq(q.field("corTaskId"), args.corTaskId))
      .first();
    if (task?.convexStatus === "deleted") return null;
    return task;
  },
});

// Query interna para obtener el userId del thread
export const getUserIdFromThread = internalQuery({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    return chatThread?.userId || null;
  },
});

export const getExternalEditableTaskContext = internalQuery({
  args: {
    threadId: v.string(),
    taskId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    if (!chatThread) {
      return { ok: false, error: "No se pudo identificar la conversación." };
    }

    const approvedExternalUser = await ctx.db
      .query("approvedExternalUsers")
      .withIndex("by_user", (q) => q.eq("userId", chatThread.userId))
      .unique();

    if (!approvedExternalUser) {
      return {
        ok: false,
        error: "Esta acción solo está disponible para usuarios externos aprobados.",
      };
    }

    let task = null;
    if (args.taskId) {
      const normalizedTaskId = ctx.db.normalizeId("tasks", args.taskId);
      if (!normalizedTaskId) {
        return { ok: false, error: "No se encontró ese requerimiento." };
      }
      task = await ctx.db.get(normalizedTaskId);
    } else {
      task = await ctx.db
        .query("tasks")
        .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
        .first();
    }

    if (!task || task.convexStatus === "deleted") {
      return { ok: false, error: "No se encontró ese requerimiento." };
    }

    if (task.source !== "external") {
      return {
        ok: false,
        error: "Este requerimiento no pertenece al flujo de clientes externos.",
      };
    }

    if (String(task.createdBy || "") !== String(chatThread.userId)) {
      return {
        ok: false,
        error: "Solo puedes editar requerimientos creados por tu usuario.",
      };
    }

    if (task.clientId && task.clientBrandId) {
      const assignments = await ctx.db
        .query("clientUserAssignments")
        .withIndex("by_client_and_user", (q) =>
          q.eq("clientId", task.clientId!).eq("userId", chatThread.userId),
        )
        .collect();

      const hasAccess = assignments.some(
        (assignment) =>
          !assignment.brandId ||
          String(assignment.brandId) === String(task.clientBrandId),
      );

      if (!hasAccess) {
        return {
          ok: false,
          error:
            "Ya no tienes autorización para editar requerimientos de esta categoría.",
        };
      }
    }

    const clientBrand = task.clientBrandId
      ? await ctx.db.get(task.clientBrandId)
      : null;

    return {
      ok: true,
      task,
      userId: chatThread.userId,
      approvedExternalUserId: approvedExternalUser._id,
      trelloBoardId: clientBrand?.trelloBoardId,
      trelloBoardUrl: clientBrand?.trelloBoardUrl,
    };
  },
});

export const applyExternalTaskEditInternal = internalMutation({
  args: {
    taskId: v.id("tasks"),
    updates: v.object({
      description: v.optional(v.string()),
      deadline: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") {
      throw new Error("Task no encontrada.");
    }

    const updateData: Record<string, unknown> = {};
    if (args.updates.description !== undefined) {
      const descriptionError = validateDescriptionUpdate(
        task.description,
        args.updates.description,
      );
      if (descriptionError) throw new Error(descriptionError);
      updateData.description = args.updates.description;
    }
    if (args.updates.deadline !== undefined) {
      updateData.deadline = args.updates.deadline;
    }

    if (Object.keys(updateData).length === 0) return;
    updateData.lastLocalEditAt = Date.now();

    await ctx.db.patch(args.taskId, updateData);
  },
});

export const createTaskMessageInternal = internalMutation({
  args: {
    taskId: v.id("tasks"),
    userId: v.optional(v.id("users")),
    source: v.union(
      v.literal("external_agent"),
      v.literal("trello"),
      v.literal("cor"),
      v.literal("internal"),
    ),
    message: v.string(),
    trelloCardId: v.optional(v.string()),
    trelloCommentId: v.optional(v.string()),
    trelloSyncStatus: v.optional(v.string()),
    corTaskId: v.optional(v.number()),
    corMessageSyncStatus: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("taskMessages", {
      ...args,
      trelloSyncedAt:
        args.trelloSyncStatus === "synced" ? now : undefined,
      corSyncedAt:
        args.corMessageSyncStatus === "synced" ? now : undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getTaskMessageByTrelloCommentId = internalQuery({
  args: {
    trelloCommentId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("taskMessages")
      .withIndex("by_trello_comment", (q) =>
        q.eq("trelloCommentId", args.trelloCommentId),
      )
      .first();
  },
});

export const updateTaskMessageSyncStatusInternal = internalMutation({
  args: {
    taskMessageId: v.id("taskMessages"),
    trelloSyncStatus: v.optional(v.string()),
    trelloSyncError: v.optional(v.string()),
    trelloCommentId: v.optional(v.string()),
    corTaskId: v.optional(v.number()),
    corMessageSyncStatus: v.optional(v.string()),
    corMessageSyncError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {
      updatedAt: Date.now(),
    };
    if (args.trelloSyncStatus !== undefined) {
      patch.trelloSyncStatus = args.trelloSyncStatus;
      patch.trelloSyncedAt =
        args.trelloSyncStatus === "synced" ? Date.now() : undefined;
    }
    if (args.trelloSyncError !== undefined) {
      patch.trelloSyncError = args.trelloSyncError;
    }
    if (args.trelloCommentId !== undefined) {
      patch.trelloCommentId = args.trelloCommentId;
    }
    if (args.corTaskId !== undefined) {
      patch.corTaskId = args.corTaskId;
    }
    if (args.corMessageSyncStatus !== undefined) {
      patch.corMessageSyncStatus = args.corMessageSyncStatus;
      patch.corSyncedAt =
        args.corMessageSyncStatus === "synced" ? Date.now() : undefined;
      if (args.corMessageSyncStatus === "synced") {
        patch.corMessageSyncError = undefined;
      }
    }
    if (args.corMessageSyncError !== undefined) {
      patch.corMessageSyncError = args.corMessageSyncError;
    }

    await ctx.db.patch(args.taskMessageId, patch);
  },
});

export const listPendingTaskMessagesForCORInternal = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("taskMessages")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();

    return messages
      .filter(
        (message) =>
          EXTERNAL_COMMENT_SOURCES.has(message.source) &&
          PENDING_COR_MESSAGE_STATUSES.has(message.corMessageSyncStatus || ""),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const listPendingExternalTaskMessages = query({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, userId)) return [];

    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") return [];
    if (!(await hasTaskAccess(ctx, task, userId))) return [];
    if (task.corTaskId || task.corSyncStatus === "synced") return [];

    const messages = await ctx.db
      .query("taskMessages")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();

    return messages
      .filter(
        (message) =>
          EXTERNAL_COMMENT_SOURCES.has(message.source) &&
          PENDING_COR_MESSAGE_STATUSES.has(message.corMessageSyncStatus || ""),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((message) => ({
        _id: message._id,
        source: message.source,
        message: message.message,
        trelloCommentId: message.trelloCommentId,
        trelloCardId: message.trelloCardId,
        corMessageSyncStatus: message.corMessageSyncStatus,
        createdAt: message.createdAt,
      }));
  },
});

// Mutation pública para actualizar campos de una task desde el frontend (Panel de Control)
// Si la task está publicada en COR (synced), dispara sincronización automática.
export const updateTaskFields = mutation({
  args: {
    taskId: v.id("tasks"),
    updates: v.object({
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      deadline: v.optional(v.string()),
      deliverablesCount: v.optional(v.number()),
      priority: v.optional(v.number()), // 0=Low, 1=Medium, 2=High, 3=Urgent
      status: v.optional(v.string()), // nueva, en_proceso, estancada, finalizada
      strategicPriority: v.optional(
        v.union(
          v.literal("I_U"),
          v.literal("I_NU"),
          v.literal("NI_U"),
          v.literal("NI_NU"),
        ),
      ),
    }),
  },
  handler: async (ctx, args) => {
    // Verificar que el usuario esté autenticado
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    const approvedExternalUser = await ctx.db
      .query("approvedExternalUsers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (approvedExternalUser) {
      throw new Error(
        "Los usuarios externos no pueden publicar o sincronizar con COR.",
      );
    }

    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task no encontrada");

    // ─── Bloquear edición durante sincronización ───
    if (task.corSyncStatus === "syncing" || task.corSyncStatus === "retrying") {
      throw new Error(
        "La tarea se está sincronizando con el sistema externo. Espera a que termine la sincronización antes de editar.",
      );
    }

    // ─── Validación de permisos ───
    if (!(await hasTaskAccess(ctx, task, userId))) {
      throw new Error(
        `No tienes permisos para editar tasks del cliente "${task.corClientName || "desconocido"}".`,
      );
    }

    // Filtrar campos undefined
    const updateData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args.updates)) {
      if (value !== undefined) {
        updateData[key] = value;
      }
    }

    if (Object.keys(updateData).length === 0) return args.taskId;

    if (
      updateData.deliverablesCount !== undefined &&
      (task.corSyncStatus === "synced" || task.corTaskId)
    ) {
      throw new Error(
        "La cantidad de entregables solo se puede editar antes de publicar la tarea en COR.",
      );
    }

    const updateKeys = Object.keys(updateData);
    if (updateKeys.includes("description")) {
      const descriptionError = validateDescriptionUpdate(
        task.description,
        updateData.description,
      );
      if (descriptionError) throw new Error(descriptionError);
    }

    // Agregar timestamp de edición local
    updateData.lastLocalEditAt = Date.now();

    console.log(
      `[Tasks.updateTaskFields] Actualizando task ${args.taskId}:`,
      Object.keys(updateData),
    );
    await ctx.db.patch(args.taskId, updateData as any);

    // Programar sync a COR si corresponde (via internalMutation)
    const changedFields = Object.keys(args.updates).filter(
      (k) => (args.updates as any)[k] !== undefined,
    );
    const syncableChangedFields = changedFields.filter((field) =>
      COR_SYNCABLE_FIELDS.has(field),
    );
    if (syncableChangedFields.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.data.tasks.scheduleTaskSyncToCOR,
        {
          taskId: args.taskId,
          changedFields: syncableChangedFields,
        },
      );
    }

    return args.taskId;
  },
});

// Mutation para actualizar el estado de una task
export const updateTaskStatus = mutation({
  args: {
    taskId: v.id("tasks"),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId, {
      status: args.status,
    });
    return args.taskId;
  },
});

// ==================== BACKGROUND JOB: Asociar archivos a task ====================
// Esta acción se ejecuta en background después de crear una task
// para buscar archivos del thread y crear registros en taskAttachments
export const associateFilesToTask = internalAction({
  args: {
    taskId: v.string(),
    threadId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    console.log(
      `[AssociateFiles] Buscando archivos para task ${args.taskId}...`,
    );

    try {
      // Obtener todos los mensajes del thread
      const messagesResult = await listMessages(ctx, components.agent, {
        threadId: args.threadId,
        paginationOpts: { cursor: null, numItems: 20 },
      });

      const allFileIds: string[] = [];

      // Buscar fileIds en cada mensaje
      for (const msg of messagesResult.page) {
        const msgAny = msg as any;
        if (msgAny.fileIds && Array.isArray(msgAny.fileIds)) {
          allFileIds.push(...msgAny.fileIds);
        }
      }

      if (allFileIds.length === 0) {
        console.log(`[AssociateFiles] No se encontraron archivos en el thread`);
        return;
      }

      console.log(
        `[AssociateFiles] Creando ${allFileIds.length} registros en taskAttachments...`,
      );

      for (const fileId of allFileIds) {
        try {
          const fileInfo = await ctx.runQuery(
            internal.data.tasks.getFileInfoInternal,
            { fileId },
          );
          if (fileInfo) {
            await ctx.runMutation(internal.data.tasks.createTaskAttachment, {
              taskId: args.taskId as any,
              fileId,
              storageId: fileInfo.storageId,
              filename: fileInfo.filename,
              mimeType: fileInfo.mimeType,
              size: fileInfo.size,
            });
            console.log(
              `[AssociateFiles] ✅ Attachment creado: ${fileInfo.filename}`,
            );
          }
        } catch (fileError) {
          console.error(
            `[AssociateFiles] ⚠️ Error con archivo ${fileId}:`,
            fileError,
          );
        }
      }

      console.log(`[AssociateFiles] ✅ Archivos asociados exitosamente`);
    } catch (error) {
      console.error(`[AssociateFiles] Error:`, error);
    }
  },
});

// Mutation interna para crear un registro de attachment
export const createTaskAttachment = internalMutation({
  args: {
    taskId: v.id("tasks"),
    fileId: v.string(),
    storageId: v.string(),
    filename: v.string(),
    mimeType: v.string(),
    size: v.optional(v.number()),
    trelloAttachmentId: v.optional(v.string()),
    trelloAttachmentUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("taskAttachments", {
      taskId: args.taskId,
      fileId: args.fileId,
      storageId: args.storageId,
      filename: args.filename,
      mimeType: args.mimeType,
      size: args.size,
      trelloAttachmentId: args.trelloAttachmentId,
      trelloAttachmentUrl: args.trelloAttachmentUrl,
      trelloSyncStatus: args.trelloAttachmentId ? "synced" : undefined,
      trelloSyncedAt: args.trelloAttachmentId ? Date.now() : undefined,
      createdAt: Date.now(),
    });
  },
});

// Mutation interna para marcar un attachment como sincronizado con COR
export const updateAttachmentCORSync = internalMutation({
  args: {
    attachmentId: v.id("taskAttachments"),
    corAttachmentId: v.number(),
    corUrl: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.attachmentId, {
      corAttachmentId: args.corAttachmentId,
      corUrl: args.corUrl,
    });
  },
});

export const updateAttachmentTrelloSync = internalMutation({
  args: {
    attachmentId: v.id("taskAttachments"),
    trelloAttachmentId: v.string(),
    trelloAttachmentUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.attachmentId, {
      trelloAttachmentId: args.trelloAttachmentId,
      trelloAttachmentUrl: args.trelloAttachmentUrl,
      trelloSyncStatus: "synced",
      trelloSyncError: undefined,
      trelloSyncedAt: Date.now(),
    });
  },
});

export const updateAttachmentTrelloError = internalMutation({
  args: {
    attachmentId: v.id("taskAttachments"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.attachmentId, {
      trelloSyncStatus: "error",
      trelloSyncError: args.error,
    });
  },
});

export const updateTaskTrelloAttachmentSummary = internalMutation({
  args: {
    taskId: v.id("tasks"),
    status: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId, {
      trelloAttachmentSyncStatus: args.status,
      trelloAttachmentSyncError: args.error,
      trelloAttachmentSyncedAt:
        args.status === "synced" || args.status === "partial"
          ? Date.now()
          : undefined,
    });
  },
});

// Mutation interna para eliminar un attachment local de task
export const deleteTaskAttachment = internalMutation({
  args: {
    attachmentId: v.id("taskAttachments"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.attachmentId);
  },
});

// Query interna para obtener attachments pendientes de sync (sin corAttachmentId)
export const getPendingAttachments = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const attachments = await ctx.db
      .query("taskAttachments")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    return attachments.filter((a) => !a.corAttachmentId);
  },
});

// Query interna para obtener todos los attachments de una task
export const getTaskAttachments = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("taskAttachments")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
  },
});

export const getTaskAttachmentByTrelloId = internalQuery({
  args: {
    taskId: v.id("tasks"),
    trelloAttachmentId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("taskAttachments")
      .withIndex("by_task_and_trello", (q) =>
        q.eq("taskId", args.taskId).eq("trelloAttachmentId", args.trelloAttachmentId),
      )
      .first();
  },
});

export const getTaskAttachmentsForTrello = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("taskAttachments")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
  },
});

// Query pública para que la UI pueda mostrar los attachments
export const getTaskAttachmentsPublic = query({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, userId)) return [];

    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") return [];
    if (!(await hasTaskAccess(ctx, task, userId))) return [];

    const attachments = await ctx.db
      .query("taskAttachments")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();

    // Resolver URLs para cada attachment
    const results = [];
    for (const att of attachments) {
      const url = await ctx.storage.getUrl(att.storageId as any);
      results.push({
        _id: att._id,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        url,
        corAttachmentId: att.corAttachmentId,
        createdAt: att.createdAt,
      });
    }
    return results;
  },
});

// Query interna para obtener información de un archivo
export const getFileInfoInternal = internalQuery({
  args: {
    fileId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      // Obtener el documento file del componente agent
      const fileDoc = await ctx.runQuery(components.agent.files.get, {
        fileId: args.fileId,
      });

      if (!fileDoc) {
        console.error(
          `[Files] No se encontró el archivo con fileId: ${args.fileId}`,
        );
        return null;
      }

      // Obtener la URL desde el storageId
      const url = await ctx.storage.getUrl(fileDoc.storageId);

      return {
        fileId: args.fileId,
        storageId: fileDoc.storageId,
        filename: fileDoc.filename || `archivo_${args.fileId}`,
        mimeType: fileDoc.mimeType || "application/octet-stream",
        size: (fileDoc as any).size as number | undefined,
        url,
      };
    } catch (error) {
      console.error(
        `[Files] Error obteniendo info para fileId ${args.fileId}:`,
        error,
      );
      return null;
    }
  },
});

// ==================== CONSOLIDATED FUNCTIONS ====================
// Optimización: Reducir múltiples runQuery/runMutation a menos transacciones.
// Ref: https://docs.convex.dev/functions/actions#avoid-await-ctxrunmutation--await-ctxrunquery

/**
 * Validación consolidada para createTaskTool.
 * Una sola transacción que:
 * 1. Obtiene userId del thread
 * 2. Verifica idempotencia (no crear task duplicada)
 * 3. Verifica corUser (si integración habilitada)
 * 4. Verifica cliente local y autorización
 * 5. Verifica proyecto existente
 * 6. Resuelve localClientId y pmId
 */
export const validateAndPrepareTask = internalQuery({
  args: {
    threadId: v.string(),
    corClientId: v.optional(v.number()),
    corUserId: v.optional(v.number()),
    clientBrandId: v.optional(v.id("clientBrands")),
    requireIntegration: v.boolean(),
  },
  handler: async (ctx, args) => {
    // 1. userId del thread
    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    const userId = chatThread?.userId || null;

    // 2. Idempotencia — ¿ya existe task para este thread?
    const existingTask = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    if (existingTask) {
      return {
        ok: false as const,
        error: `Ya existe un requerimiento para esta conversación.\n\nID del requerimiento: ${existingTask._id}\nEstado: ${existingTask.status}\n\nSi necesitas crear un nuevo requerimiento, por favor inicia una nueva conversación.\nSi quieres modificar el existente, usa la herramienta "editTask".`,
      };
    }

    // 3-4. Validaciones de integración (si está habilitada)
    let localClientId: string | undefined;
    let pmId: number | undefined = args.corUserId;

    if (args.requireIntegration) {
      if (!userId) {
        return {
          ok: false as const,
          error: "❌ No se pudo identificar al usuario de esta conversación.",
        };
      }

      // corUser
      const corUser = await ctx.db
        .query("corUsers")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();
      if (!corUser) {
        return {
          ok: false as const,
          error:
            "❌ Tu usuario no está registrado en el sistema de gestión de proyectos (COR). Usa primero la herramienta 'validateUserForClient'.",
        };
      }
      if (!pmId) pmId = corUser.corUserId;

      // cliente local
      if (args.corClientId) {
        const corClientId = args.corClientId;
        const localClient = await ctx.db
          .query("corClients")
          .withIndex("by_corClientId", (q) => q.eq("corClientId", corClientId))
          .unique();
        if (!localClient) {
          return {
            ok: false as const,
            error:
              "❌ El cliente no está registrado localmente. Usa primero la herramienta 'validateUserForClient'.",
          };
        }
        localClientId = localClient._id;

        // autorización
        const assignments = await ctx.db
          .query("clientUserAssignments")
          .withIndex("by_client_and_user", (q) =>
            q.eq("clientId", localClient._id).eq("userId", userId),
          )
          .collect();
        const hasFullAccess = assignments.some(
          (assignment) => assignment.brandId === undefined,
        );
        const hasBrandAccess =
          args.clientBrandId !== undefined &&
          assignments.some(
            (assignment) => assignment.brandId === args.clientBrandId,
          );
        if (!hasFullAccess && !hasBrandAccess) {
          return {
            ok: false as const,
            error: `❌ No tienes autorización para crear briefs para este cliente o marca. Contacta al administrador.`,
          };
        }
      }
    } else {
      // Sin integración, resolver pmId si posible
      if (!pmId && userId) {
        const corUser = await ctx.db
          .query("corUsers")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .unique();
        if (corUser) pmId = corUser.corUserId;
      }
    }

    // 5. Proyecto existente para este thread
    const existingProject = await ctx.db
      .query("projects")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();

    // Si no hay integración y no resolvimos localClientId, intentar buscar
    if (!localClientId && args.corClientId) {
      const corClientId = args.corClientId;
      const localClient = await ctx.db
        .query("corClients")
        .withIndex("by_corClientId", (q) => q.eq("corClientId", corClientId))
        .unique();
      if (localClient) localClientId = localClient._id;
    }

    return {
      ok: true as const,
      userId: userId ? String(userId) : undefined,
      localClientId,
      pmId,
      existingProjectId: existingProject?._id || undefined,
    };
  },
});

/**
 * Validación consolidada para el agente externo.
 * Verifica usuario externo aprobado, idempotencia del thread y permiso por marca.
 */
export const validateAndPrepareExternalTask = internalQuery({
  args: {
    threadId: v.string(),
    clientBrandId: v.id("clientBrands"),
    subBrandId: v.optional(v.id("subBrands")),
  },
  handler: async (ctx, args) => {
    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    const userId = chatThread?.userId || null;

    if (!userId) {
      return {
        ok: false as const,
        error: "❌ No se pudo identificar al usuario de esta conversación.",
      };
    }

    const approvedExternalUser = await ctx.db
      .query("approvedExternalUsers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (!approvedExternalUser) {
      return {
        ok: false as const,
        error:
          "❌ Este flujo solo está disponible para usuarios externos aprobados.",
      };
    }

    const existingTask = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    if (existingTask) {
      return {
        ok: false as const,
        error: `Ya existe un requerimiento para esta conversación.\n\nID del requerimiento: ${existingTask._id}\nEstado: ${existingTask.status}\n\nSi necesitas crear un nuevo requerimiento, por favor inicia una nueva conversación.`,
      };
    }

    const brand = await ctx.db.get(args.clientBrandId);
    if (!brand) {
      return {
        ok: false as const,
        error: "❌ La categoría seleccionada no existe.",
      };
    }
    if (!brand.clientId) {
      return {
        ok: false as const,
        error:
          "❌ La categoría no está vinculada a un cliente local. Contacta al administrador.",
      };
    }

    const client = await ctx.db.get(brand.clientId);
    if (!client) {
      return {
        ok: false as const,
        error: "❌ El cliente asociado a esta categoría no existe localmente.",
      };
    }

    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_client_and_user", (q) =>
        q.eq("clientId", brand.clientId!).eq("userId", userId),
      )
      .collect();

    const hasAccess = assignments.some(
      (assignment) =>
        assignment.brandId === undefined ||
        assignment.brandId === args.clientBrandId,
    );

    if (!hasAccess) {
      return {
        ok: false as const,
        error: `❌ No tienes autorización para crear briefs para la categoría "${brand.name}".`,
      };
    }

    const subBrands = await ctx.db
      .query("subBrands")
      .withIndex("by_brand", (q) => q.eq("clientBrandId", brand._id))
      .collect();

    let subBrand = null as any;
    if (subBrands.length > 0) {
      if (!args.subBrandId) {
        return {
          ok: false as const,
          error: `❌ La categoría "${brand.name}" tiene marcas configuradas. Debes pedirle al cliente que elija una antes de crear el requerimiento.`,
          availableSubBrands: subBrands.map((candidate) => ({
            subBrandId: String(candidate._id),
            name: candidate.name,
            corProductId: candidate.corProductId,
          })),
        };
      }

      subBrand = await ctx.db.get(args.subBrandId);
      if (!subBrand || subBrand.clientBrandId !== brand._id) {
        return {
          ok: false as const,
          error:
            "❌ La marca seleccionada no pertenece a la categoría validada.",
          availableSubBrands: subBrands.map((candidate) => ({
            subBrandId: String(candidate._id),
            name: candidate.name,
            corProductId: candidate.corProductId,
          })),
        };
      }
    } else if (args.subBrandId) {
      return {
        ok: false as const,
        error:
          "❌ Esta categoría no tiene marcas configuradas. No envíes una marca adicional para este requerimiento.",
      };
    }

    const existingProject = await ctx.db
      .query("projects")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();

    return {
      ok: true as const,
      userId: String(userId),
      localClientId: brand.clientId,
      corClientId: brand.corClientId,
      corClientName: client.name,
      clientBrandId: brand._id,
      corBrandId: brand.corBrandId,
      brandName: brand.name,
      trelloBoardId: brand.trelloBoardId,
      trelloBoardUrl: brand.trelloBoardUrl,
      subBrandId: subBrand?._id,
      corProductId: subBrand?.corProductId,
      subBrandName: subBrand?.name,
      existingProjectId: existingProject?._id || undefined,
    };
  },
});

/**
 * Crea proyecto + task atómicamente en una sola mutation.
 * Reemplaza createProjectInternal + createTaskInternal como calls separados.
 */
export const createProjectAndTask = internalMutation({
  args: {
    // Project fields
    projectName: v.string(),
    projectBrief: v.optional(v.string()),
    projectEndDate: v.optional(v.string()),
    projectDeliverables: v.optional(v.number()),
    projectEstimatedTime: v.optional(v.number()),
    projectPmId: v.optional(v.number()),
    projectCorClientId: v.optional(v.number()),
    projectClientId: v.optional(v.id("corClients")),
    projectCreatedBy: v.optional(v.string()),
    projectSource: v.optional(
      v.union(v.literal("internal"), v.literal("external")),
    ),
    projectClientBrandId: v.optional(v.id("clientBrands")),
    projectBrandId: v.optional(v.number()),
    projectBrandName: v.optional(v.string()),
    projectSubBrandId: v.optional(v.id("subBrands")),
    projectProductId: v.optional(v.number()),
    projectSubBrandName: v.optional(v.string()),
    // Task fields
    taskTitle: v.string(),
    taskDescription: v.optional(v.string()),
    taskDeadline: v.optional(v.string()),
    taskDeliverablesCount: v.optional(v.number()),
    taskPriority: v.optional(v.number()),
    taskStatus: v.string(),
    taskCreatedBy: v.optional(v.string()),
    taskClientId: v.optional(v.id("corClients")),
    taskCorClientId: v.optional(v.number()),
    taskCorClientName: v.optional(v.string()),
    taskSource: v.optional(
      v.union(v.literal("internal"), v.literal("external")),
    ),
    taskClientBrandId: v.optional(v.id("clientBrands")),
    taskBrandId: v.optional(v.number()),
    taskBrandName: v.optional(v.string()),
    taskSubBrandId: v.optional(v.id("subBrands")),
    taskProductId: v.optional(v.number()),
    taskSubBrandName: v.optional(v.string()),
    // Shared
    threadId: v.string(),
    existingProjectId: v.optional(v.id("projects")),
    externalTrelloAccessVerified: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const isExternalCreation =
      args.taskSource === "external" || args.projectSource === "external";
    const trelloRequired =
      isExternalCreation &&
      isTrelloEnabledForCorClientId(
        args.taskCorClientId ?? args.projectCorClientId,
      );
    if (trelloRequired && !args.externalTrelloAccessVerified) {
      throw new Error(
        "❌ No se verificó el acceso del usuario externo al tablero de Trello.",
      );
    }

    const existingProject = args.existingProjectId
      ? await ctx.db.get(args.existingProjectId)
      : null;

    const resolved = await resolveCreationTaxonomy(ctx, {
      clientId:
        args.taskClientId ?? args.projectClientId ?? existingProject?.clientId,
      corClientId: args.taskCorClientId ?? args.projectCorClientId,
      clientBrandId:
        args.taskClientBrandId ??
        args.projectClientBrandId ??
        existingProject?.clientBrandId,
      subBrandId:
        args.taskSubBrandId ??
        args.projectSubBrandId ??
        existingProject?.subBrandId,
    });

    // 1. Crear o reutilizar proyecto
    let projectId: string;
    if (args.existingProjectId) {
      projectId = args.existingProjectId;
      console.log(`[CreateProjectAndTask] ℹ️ Proyecto ya existe: ${projectId}`);
    } else {
      projectId = await ctx.db.insert("projects", {
        name: args.projectName,
        brief: args.projectBrief,
        startDate: new Date().toISOString().split("T")[0],
        endDate: args.projectEndDate,
        status: "active",
        convexStatus: "active",
        pmId: args.projectPmId,
        deliverables: args.projectDeliverables,
        estimatedTime: args.projectEstimatedTime,
        createdBy: args.projectCreatedBy,
        threadId: args.threadId,
        source: args.projectSource || "internal",
        clientBrandId: resolved.clientBrandId,
        brandId: resolved.brandId ?? args.projectBrandId,
        brandName: resolved.brandName ?? args.projectBrandName,
        subBrandId: resolved.subBrandId,
        productId: resolved.productId ?? args.projectProductId,
        subBrandName: resolved.subBrandName ?? args.projectSubBrandName,
        corClientId: args.projectCorClientId,
        clientId: resolved.clientId ?? args.projectClientId,
        corSyncStatus: "pending",
      });
      const createdProject = await ctx.db.get(projectId as any);
      await applyProjectDeliverablesDelta(ctx, null, createdProject as any);
      console.log(`[CreateProjectAndTask] ✅ Proyecto creado: ${projectId}`);
    }

    let taskClientId =
      resolved.clientId ?? args.taskClientId ?? args.projectClientId;
    if (!taskClientId && args.existingProjectId) {
      if (existingProject?.clientId) taskClientId = existingProject.clientId;
    }
    if (!taskClientId && args.taskCorClientId !== undefined) {
      const client = await ctx.db
        .query("corClients")
        .withIndex("by_corClientId", (q) =>
          q.eq("corClientId", args.taskCorClientId!),
        )
        .unique();
      taskClientId = client?._id;
    }

    // 2. Crear task
    const taskId = await ctx.db.insert("tasks", {
      title: args.taskTitle,
      description: args.taskDescription,
      deadline: args.taskDeadline,
      deliverablesCount: args.taskDeliverablesCount,
      priority: args.taskPriority ?? 1,
      threadId: args.threadId,
      status: args.taskStatus,
      convexStatus: "active",
      createdBy: args.taskCreatedBy,
      projectId: projectId as any,
      source: args.taskSource || "internal",
      clientId: taskClientId,
      clientBrandId: resolved.clientBrandId ?? args.taskClientBrandId,
      brandId: resolved.brandId ?? args.taskBrandId,
      brandName: resolved.brandName ?? args.taskBrandName,
      subBrandId: resolved.subBrandId ?? args.taskSubBrandId,
      productId: resolved.productId ?? args.taskProductId,
      subBrandName: resolved.subBrandName ?? args.taskSubBrandName,
      corSyncStatus: "pending",
      corClientId: args.taskCorClientId,
      corClientName: args.taskCorClientName,
    });
    console.log(`[CreateProjectAndTask] ✅ Task creada: ${taskId}`);

    try {
      await ctx.scheduler.runAfter(
        0,
        (internal as any).messaging.threadTitle.generateAndApplyThreadTitle,
        {
          threadId: args.threadId,
          taskId: taskId as string,
        },
      );
    } catch (error) {
      console.log(
        "[CreateProjectAndTask] No se pudo programar renombrado del thread:",
        error,
      );
    }

    return { projectId, taskId: taskId as string };
  },
});

export const listTasksForClientIdBackfill = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 500;
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_clientId", (q) => q.eq("clientId", undefined))
      .take(limit);

    return tasks
      .filter((task) => task.convexStatus !== "deleted")
      .map((task) => ({
        _id: task._id,
        title: task.title,
        projectId: task.projectId,
        clientBrandId: task.clientBrandId,
        corClientId: task.corClientId,
        corClientName: task.corClientName,
      }));
  },
});

export const backfillTaskClientId = internalMutation({
  args: {
    taskId: v.id("tasks"),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return { status: "missing" as const };
    if (task.clientId) {
      return {
        status: "already_set" as const,
        clientId: task.clientId,
        reason: "task.clientId",
      };
    }

    let clientId = null as any;
    let reason: string | undefined;

    if (task.clientBrandId) {
      const brand = await ctx.db.get(task.clientBrandId);
      if (brand?.clientId) {
        clientId = brand.clientId;
        reason = "clientBrandId";
      }
    }

    if (!clientId && task.projectId) {
      const project = await ctx.db.get(task.projectId as any);
      if (project && "clientId" in project && project.clientId) {
        clientId = project.clientId;
        reason = "projectId";
      }
    }

    if (!clientId && task.corClientId !== undefined) {
      const client = await ctx.db
        .query("corClients")
        .withIndex("by_corClientId", (q) =>
          q.eq("corClientId", task.corClientId!),
        )
        .unique();
      if (client) {
        clientId = client._id;
        reason = "corClientId";
      }
    }

    if (!clientId && task.corClientName) {
      const normalizedTaskClientName = normalizeClientName(task.corClientName);
      const clients = await ctx.db.query("corClients").collect();
      const client = clients.find(
        (candidate) =>
          normalizeClientName(candidate.name) === normalizedTaskClientName,
      );
      if (client) {
        clientId = client._id;
        reason = "corClientName";
      }
    }

    if (!clientId) {
      return {
        status: "unresolved" as const,
        taskId: task._id,
        title: task.title,
        corClientId: task.corClientId,
        corClientName: task.corClientName,
      };
    }

    if (!args.dryRun) {
      await ctx.db.patch(task._id, { clientId });
    }

    return {
      status: args.dryRun ? ("would_update" as const) : ("updated" as const),
      taskId: task._id,
      title: task.title,
      clientId,
      reason,
    };
  },
});

export const listTasksForDeliverablesCountBackfill = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 500;
    const tasks = await ctx.db.query("tasks").collect();

    return tasks
      .filter((task) => task.convexStatus !== "deleted")
      .filter((task) => task.deliverablesCount === undefined)
      .slice(0, limit)
      .map((task) => ({
        _id: task._id,
        title: task.title,
        projectId: task.projectId,
      }));
  },
});

export const backfillTaskDeliverablesCount = internalMutation({
  args: {
    taskId: v.id("tasks"),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return { status: "missing" as const };

    if (typeof task.deliverablesCount === "number") {
      return {
        status: "already_set" as const,
        taskId: task._id,
        title: task.title,
        deliverablesCount: task.deliverablesCount,
      };
    }

    if (!task.projectId) {
      return {
        status: "unresolved" as const,
        reason: "missing_project",
        taskId: task._id,
        title: task.title,
      };
    }

    const project = await ctx.db.get(task.projectId as Id<"projects">);
    const deliverablesCount =
      project &&
      project.convexStatus !== "deleted" &&
      typeof project.deliverables === "number" &&
      Number.isFinite(project.deliverables) &&
      project.deliverables > 0
        ? Math.trunc(project.deliverables)
        : null;

    if (!deliverablesCount) {
      return {
        status: "unresolved" as const,
        reason: "missing_project_deliverables",
        taskId: task._id,
        title: task.title,
        projectId: task.projectId,
      };
    }

    if (!args.dryRun) {
      await ctx.db.patch(task._id, { deliverablesCount });
    }

    return {
      status: args.dryRun ? ("would_update" as const) : ("updated" as const),
      taskId: task._id,
      title: task.title,
      projectId: task.projectId,
      deliverablesCount,
    };
  },
});

function normalizeClientName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Programa la clasificación de prioridad estratégica en background.
 * La clasificación corre como un action separado (via scheduler) sin bloquear la creación.
 */
export const schedulePriorityClassification = internalMutation({
  args: {
    taskId: v.id("tasks"),
    title: v.string(),
    requestType: v.string(),
    brand: v.string(),
    objective: v.optional(v.string()),
    keyMessage: v.optional(v.string()),
    kpis: v.optional(v.string()),
    deadline: v.optional(v.string()),
    budget: v.optional(v.string()),
    approvers: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log(
      `[SchedulePriority] 🎯 Programando clasificación para task ${args.taskId}`,
    );
    await ctx.scheduler.runAfter(
      0,
      internal.data.tasks.classifyAndUpdatePriority,
      {
        taskId: args.taskId,
        title: args.title,
        requestType: args.requestType,
        brand: args.brand,
        objective: args.objective,
        keyMessage: args.keyMessage,
        kpis: args.kpis,
        deadline: args.deadline,
        budget: args.budget,
        approvers: args.approvers,
      },
    );
  },
});

/**
 * Action que clasifica la prioridad y actualiza la task (corre en background).
 * Llama al priorityAgent (cross-runtime, "use node") y luego actualiza description.
 */
export const classifyAndUpdatePriority = internalAction({
  args: {
    taskId: v.id("tasks"),
    title: v.string(),
    requestType: v.string(),
    brand: v.string(),
    objective: v.optional(v.string()),
    keyMessage: v.optional(v.string()),
    kpis: v.optional(v.string()),
    deadline: v.optional(v.string()),
    budget: v.optional(v.string()),
    approvers: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const classification = await ctx.runAction(
        internal.agents.priorityAgent.classifyPriorityAction,
        {
          title: args.title,
          requestType: args.requestType,
          brand: args.brand,
          objective: args.objective,
          keyMessage: args.keyMessage,
          kpis: args.kpis,
          deadline: args.deadline,
          budget: args.budget,
          approvers: args.approvers,
        },
      );

      if (classification && isStrategicPriority(classification)) {
        // Guardar prioridad estratégica en campo dedicado (no en description)
        await ctx.runMutation(
          internal.data.tasks.setTaskStrategicPriorityInternal,
          {
            taskId: args.taskId,
            strategicPriority: classification,
          },
        );

        // Si ya está publicada en COR, sincronizar etiqueta inmediatamente
        const task = await ctx.runQuery(
          internal.data.tasks.getTaskByIdInternal,
          {
            taskId: args.taskId as string,
          },
        );

        if (task?.corTaskId) {
          const corTaskId = parseInt(task.corTaskId, 10);
          if (Number.isFinite(corTaskId)) {
            await syncStrategicPriorityLabelInCOR(corTaskId, classification);
            console.log(
              `[ClassifyAndUpdate] ✅ Prioridad ${classification} sincronizada como etiqueta en task COR ${corTaskId}`,
            );
          }
        }

        console.log(
          `[ClassifyAndUpdate] ✅ Prioridad ${classification} guardada en task ${args.taskId}`,
        );
      }
    } catch (error) {
      console.log(
        `[ClassifyAndUpdate] ⚠️ No se pudo clasificar prioridad (task ${args.taskId}):`,
        error,
      );
      // No falla — la task ya fue creada exitosamente
    }
  },
});

/**
 * Helper para asociar archivos del thread a una task.
 * Se ejecuta directamente como función TypeScript (sin runAction).
 * Ref: https://docs.convex.dev/functions/actions#await-ctxrunaction-should-only-be-used-for-crossing-js-runtimes
 */
export async function associateFilesHelper(
  ctx: ActionCtx,
  taskId: string,
  threadId: string,
): Promise<void> {
  console.log(`[AssociateFiles] Buscando archivos para task ${taskId}...`);

  try {
    const messagesResult = await listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    });

    const allFileIds: string[] = [];
    for (const msg of messagesResult.page) {
      const msgAny = msg as any;
      if (msgAny.fileIds && Array.isArray(msgAny.fileIds)) {
        allFileIds.push(...msgAny.fileIds);
      }
    }

    if (allFileIds.length === 0) {
      console.log(`[AssociateFiles] No se encontraron archivos en el thread`);
      return;
    }

    console.log(
      `[AssociateFiles] Creando ${allFileIds.length} registros en taskAttachments...`,
    );

    for (const fileId of allFileIds) {
      try {
        const fileInfo = await ctx.runQuery(
          internal.data.tasks.getFileInfoInternal,
          { fileId },
        );
        if (fileInfo) {
          await ctx.runMutation(internal.data.tasks.createTaskAttachment, {
            taskId: taskId as any,
            fileId,
            storageId: fileInfo.storageId,
            filename: fileInfo.filename,
            mimeType: fileInfo.mimeType,
            size: fileInfo.size,
          });
          console.log(
            `[AssociateFiles] ✅ Attachment creado: ${fileInfo.filename}`,
          );
        }
      } catch (fileError) {
        console.error(
          `[AssociateFiles] ⚠️ Error con archivo ${fileId}:`,
          fileError,
        );
      }
    }

    console.log(`[AssociateFiles] ✅ Archivos asociados exitosamente`);
  } catch (error) {
    console.error(`[AssociateFiles] Error:`, error);
  }
}

// ==================== QUERIES ====================

// Obtener task por threadId
export const getTaskByThread = query({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, userId)) return null;

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    if (task?.convexStatus === "deleted") return null;
    if (task && !(await hasTaskAccess(ctx, task, userId))) return null;

    return task;
  },
});

// Obtener una task por ID
export const getTask = query({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, userId)) return null;

    const task = await ctx.db.get(args.taskId);
    if (task?.convexStatus === "deleted") return null;
    if (task && !(await hasTaskAccess(ctx, task, userId))) return null;
    return task;
  },
});

// Listar todas las tasks
export const listTasks = query({
  args: {
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, userId)) return [];

    const tasksById = new Map<string, any>();

    const ownTasks = await ctx.db
      .query("tasks")
      .withIndex("by_createdBy", (q) => q.eq("createdBy", String(userId)))
      .collect();
    for (const task of ownTasks) tasksById.set(task._id, task);

    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    for (const assignment of assignments) {
      if (assignment.brandId) {
        const brandTasks = await ctx.db
          .query("tasks")
          .withIndex("by_clientBrandId", (q) =>
            q.eq("clientBrandId", assignment.brandId),
          )
          .collect();
        for (const task of brandTasks) tasksById.set(task._id, task);
        continue;
      }

      const client = await ctx.db.get(assignment.clientId);
      if (!client) continue;
      const clientTasks = await ctx.db
        .query("tasks")
        .withIndex("by_corClientId", (q) =>
          q.eq("corClientId", client.corClientId),
        )
        .collect();
      for (const task of clientTasks) tasksById.set(task._id, task);
    }

    return Array.from(tasksById.values())
      .filter((t) => t.convexStatus !== "deleted")
      .filter((t) => !args.status || t.status === args.status)
      .sort((a, b) => b._creationTime - a._creationTime);
  },
});

// Listar tasks por threadId
export const listByThread = query({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, userId)) return [];

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
    const visibleTasks = [];
    for (const task of tasks) {
      if (task.convexStatus === "deleted") continue;
      if (await hasTaskAccess(ctx, task, userId)) visibleTasks.push(task);
    }
    return visibleTasks;
  },
});

// ==================== QUERY: LISTAR TASKS DEL USUARIO AUTENTICADO ====================

/**
 * Lista las tasks creadas por el usuario autenticado.
 * Se usa en el Panel de Control para mostrar las tasks del usuario.
 * Soporta filtro opcional por status.
 * Retorna ordenadas por fecha de creación descendente (más recientes primero).
 */
export const listMyTasks = query({
  args: {
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Obtener el userId autenticado via @convex-dev/auth
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const approvedExternalUser = await ctx.db
      .query("approvedExternalUsers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (approvedExternalUser) return [];

    const userIdStr = String(userId);
    const tasksById = new Map<string, any>();

    const ownTasks = await ctx.db
      .query("tasks")
      .withIndex("by_createdBy", (q) => q.eq("createdBy", userIdStr))
      .order("desc")
      .collect();

    for (const task of ownTasks) {
      tasksById.set(task._id, task);
    }

    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    for (const assignment of assignments) {
      if (assignment.brandId) {
        const brandTasks = await ctx.db
          .query("tasks")
          .withIndex("by_clientBrandId", (q) =>
            q.eq("clientBrandId", assignment.brandId),
          )
          .collect();
        for (const task of brandTasks) tasksById.set(task._id, task);
        continue;
      }

      const client = await ctx.db.get(assignment.clientId);
      if (!client) continue;

      const clientTasks = await ctx.db
        .query("tasks")
        .withIndex("by_corClientId", (q) =>
          q.eq("corClientId", client.corClientId),
        )
        .collect();
      for (const task of clientTasks) tasksById.set(task._id, task);
    }

    let tasks = Array.from(tasksById.values())
      .filter((t) => t.convexStatus !== "deleted")
      .sort((a, b) => b._creationTime - a._creationTime);

    // Filtrar por status si se proporcionó
    if (args.status) {
      tasks = tasks.filter((t) => t.status === args.status);
    }

    return tasks;
  },
});

/**
 * Soft delete de task local (Convex): marca convexStatus="deleted".
 * No elimina ni modifica nada en COR.
 */
export const softDeleteTask = mutation({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task no encontrada");

    if (task.convexStatus === "deleted") {
      return { success: true, message: "La task ya estaba eliminada." };
    }

    await ctx.db.patch(args.taskId, {
      convexStatus: "deleted",
    });

    return { success: true, message: "Task eliminada del panel." };
  },
});

/**
 * Soft delete seguro para borradores internos que aún no fueron publicados
 * ni en COR ni en Trello. Si el proyecto propuesto ya no tiene otras tasks
 * activas, también marca el proyecto como deleted.
 */
export const softDeleteUnpublishedDraftTask = mutation({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, userId)) {
      throw new Error("Los usuarios externos no pueden eliminar tareas desde el panel.");
    }

    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task no encontrada.");
    if (task.convexStatus === "deleted") {
      return {
        success: true,
        deletedProject: false,
        message: "La tarea ya estaba eliminada.",
      };
    }

    if (!(await hasTaskAccess(ctx, task, userId))) {
      throw new Error("No tienes permisos para eliminar esta tarea.");
    }

    const isPublishedInCOR =
      task.corSyncStatus === "synced" || Boolean(task.corTaskId);
    if (isPublishedInCOR) {
      throw new Error("No se puede eliminar una tarea que ya fue publicada en COR.");
    }

    const isPublishedInTrello =
      task.trelloSyncStatus === "synced" ||
      Boolean(task.trelloCardId || task.trelloCardUrl);
    if (isPublishedInTrello) {
      throw new Error("No se puede eliminar una tarea que ya fue publicada en Trello.");
    }

    if (task.source === "external") {
      throw new Error("No se puede eliminar desde aquí una tarea creada por un cliente externo.");
    }

    await ctx.db.patch(args.taskId, {
      convexStatus: "deleted",
    });

    let deletedProject = false;
    if (task.projectId) {
      const project = await ctx.db.get(task.projectId);
      if (project && project.convexStatus !== "deleted") {
        const isProjectPublishedExternally =
          project.corSyncStatus === "synced" ||
          Boolean(project.corProjectId) ||
          project.trelloSyncStatus === "synced" ||
          Boolean(project.trelloCardId || project.trelloCardUrl);
        const activeProjectTasks = [
          ...(await ctx.db
            .query("tasks")
            .withIndex("by_projectId_convexStatus", (q) =>
              q.eq("projectId", task.projectId).eq("convexStatus", "active"),
            )
            .collect()),
          ...(await ctx.db
            .query("tasks")
            .withIndex("by_projectId_convexStatus", (q) =>
              q.eq("projectId", task.projectId).eq("convexStatus", undefined),
            )
            .collect()),
        ];

        const hasOtherActiveTasks = activeProjectTasks.some(
          (projectTask) => projectTask._id !== args.taskId,
        );

        if (!hasOtherActiveTasks && !isProjectPublishedExternally) {
          await ctx.db.patch(project._id, {
            convexStatus: "deleted",
          });
          const deletedProjectDoc = await ctx.db.get(project._id);
          await applyProjectDeliverablesDelta(ctx, project, deletedProjectDoc);
          deletedProject = true;
        }
      }
    }

    return {
      success: true,
      deletedProject,
      message: deletedProject
        ? "Tarea y proyecto propuesto eliminados del panel."
        : "Tarea eliminada del panel.",
    };
  },
});

// ==================== SYNC: CONVEX → COR (mapeo 1:1) ====================

/**
 * Campos de Convex que tienen equivalente directo en COR.
 * Estos se sincronizan 1:1 sin transformación.
 *
 *   Convex field  →  COR field
 *   title         →  title
 *   description   →  description
 *   deadline      →  deadline
 *   priority      →  priority
 *   status        →  status
 */
const COR_SYNCABLE_FIELDS = new Set([
  "title",
  "description",
  "deadline",
  "priority",
  "status",
  "strategicPriority",
]);

async function hasFullClientAccess(ctx: any, clientId: any, userId: any) {
  const assignments = await ctx.db
    .query("clientUserAssignments")
    .withIndex("by_client_and_user", (q: any) =>
      q.eq("clientId", clientId).eq("userId", userId),
    )
    .collect();

  return assignments.some(
    (assignment: any) => assignment.brandId === undefined,
  );
}

async function hasTaskAccess(ctx: any, task: any, userId: any) {
  if (task.clientBrandId) {
    const brand = await ctx.db.get(task.clientBrandId);
    if (!brand?.clientId) return false;
    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_client_and_user", (q: any) =>
        q.eq("clientId", brand.clientId).eq("userId", userId),
      )
      .collect();

    return assignments.some(
      (assignment: any) =>
        assignment.brandId === undefined ||
        assignment.brandId === task.clientBrandId,
    );
  }

  if (task.corClientId) {
    const client = await ctx.db
      .query("corClients")
      .withIndex("by_corClientId", (q: any) =>
        q.eq("corClientId", task.corClientId),
      )
      .unique();
    if (!client) return false;
    return await hasFullClientAccess(ctx, client._id, userId);
  }

  return task.createdBy === String(userId);
}

async function hasBrandAccess(ctx: any, clientBrandId: any, userId: any) {
  const brand = await ctx.db.get(clientBrandId);
  if (!brand?.clientId) return false;

  const assignments = await ctx.db
    .query("clientUserAssignments")
    .withIndex("by_client_and_user", (q: any) =>
      q.eq("clientId", brand.clientId).eq("userId", userId),
    )
    .collect();

  return assignments.some(
    (assignment: any) =>
      assignment.brandId === undefined || assignment.brandId === clientBrandId,
  );
}

export const listTaskTaxonomyOptions = query({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, userId)) return null;

    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") return null;
    if (!(await hasTaskAccess(ctx, task, userId))) return null;

    let clientId = task.clientId;
    if (!clientId && task.corClientId) {
      const client = await ctx.db
        .query("corClients")
        .withIndex("by_corClientId", (q) =>
          q.eq("corClientId", task.corClientId!),
        )
        .unique();
      clientId = client?._id;
    }

    if (!clientId) return null;

    const client = await ctx.db.get(clientId);
    if (!client) return null;

    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_client_and_user", (q) =>
        q.eq("clientId", clientId).eq("userId", userId),
      )
      .collect();
    const hasFullAccess = assignments.some(
      (assignment) => assignment.brandId === undefined,
    );
    const assignedBrandIds = new Set(
      assignments
        .map((assignment) => assignment.brandId)
        .filter(Boolean)
        .map(String),
    );

    const brands = await ctx.db
      .query("clientBrands")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();

    const visibleBrands = brands.filter(
      (brand) => hasFullAccess || assignedBrandIds.has(String(brand._id)),
    );

    const brandsWithSubBrands = [];
    for (const brand of visibleBrands) {
      const subBrands = await ctx.db
        .query("subBrands")
        .withIndex("by_brand", (q) => q.eq("clientBrandId", brand._id))
        .collect();
      brandsWithSubBrands.push({
        _id: brand._id,
        name: brand.name,
        corBrandId: brand.corBrandId,
        subBrands: subBrands
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((subBrand) => ({
            _id: subBrand._id,
            name: subBrand.name,
            corProductId: subBrand.corProductId,
          })),
      });
    }

    return {
      client: {
        _id: client._id,
        name: client.name,
        corClientId: client.corClientId,
      },
      brands: brandsWithSubBrands.sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    };
  },
});

export const updateTaskTaxonomy = mutation({
  args: {
    taskId: v.id("tasks"),
    clientBrandId: v.id("clientBrands"),
    subBrandId: v.optional(v.id("subBrands")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, userId)) {
      throw new Error("Los usuarios externos no pueden cambiar esta asignación.");
    }

    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") {
      throw new Error("Task no encontrada.");
    }
    if (task.corTaskId || task.corSyncStatus === "synced") {
      throw new Error("No se puede cambiar la marca de una task publicada en COR.");
    }
    if (task.corSyncStatus === "syncing" || task.corSyncStatus === "retrying") {
      throw new Error(
        "La task se está sincronizando. Espera a que termine antes de cambiar la marca.",
      );
    }
    if (!(await hasTaskAccess(ctx, task, userId))) {
      throw new Error("No tienes permisos para editar esta task.");
    }

    const brand = await ctx.db.get(args.clientBrandId);
    if (!brand?.clientId) throw new Error("Marca no encontrada.");

    let taskClientId = task.clientId;
    if (!taskClientId && task.corClientId) {
      const client = await ctx.db
        .query("corClients")
        .withIndex("by_corClientId", (q) =>
          q.eq("corClientId", task.corClientId!),
        )
        .unique();
      taskClientId = client?._id;
    }

    if (!taskClientId || brand.clientId !== taskClientId) {
      throw new Error("La marca seleccionada no pertenece al cliente de la task.");
    }

    if (!(await hasBrandAccess(ctx, args.clientBrandId, userId))) {
      throw new Error("No tienes permisos para usar esta marca.");
    }

    const subBrands = await ctx.db
      .query("subBrands")
      .withIndex("by_brand", (q) => q.eq("clientBrandId", brand._id))
      .collect();

    let subBrand = null as any;
    if (subBrands.length > 0) {
      if (!args.subBrandId) {
        throw new Error("Esta marca requiere seleccionar un producto.");
      }
      subBrand = await ctx.db.get(args.subBrandId);
      if (!subBrand || subBrand.clientBrandId !== brand._id) {
        throw new Error("El producto seleccionado no pertenece a esta marca.");
      }
    } else if (args.subBrandId) {
      throw new Error("Esta marca no tiene productos configurados.");
    }

    const taxonomyPatch = {
      clientId: taskClientId,
      clientBrandId: brand._id,
      brandId: brand.corBrandId,
      brandName: brand.name,
      subBrandId: subBrand?._id,
      productId: subBrand?.corProductId,
      subBrandName: subBrand?.name,
    };

    await ctx.db.patch(args.taskId, taxonomyPatch);

    if (task.projectId) {
      const project = await ctx.db.get(task.projectId);
      if (
        project &&
        project.convexStatus !== "deleted" &&
        !project.corProjectId &&
        project.corSyncStatus !== "synced" &&
        project.corSyncStatus !== "syncing" &&
        project.corSyncStatus !== "retrying"
      ) {
        await ctx.db.patch(task.projectId, taxonomyPatch);
        const updatedProject = await ctx.db.get(task.projectId);
        await applyProjectDeliverablesDelta(ctx, project, updatedProject);
      }
    }

    return {
      success: true,
      brandName: brand.name,
      subBrandName: subBrand?.name,
    };
  },
});

/**
 * Mutation interna: programa la sincronización de ediciones locales hacia COR.
 *
 * Verifica que la task esté publicada y luego schedula la action de sync.
 * Marca estado como "syncing" y resetea el attempt counter.
 * Uso: desde updateTaskFields (UI) y editTaskTool (agente) para unificar el flujo.
 */
export const scheduleTaskSyncToCOR = internalMutation({
  args: {
    taskId: v.id("tasks"),
    changedFields: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return;

    if (
      task.corSyncStatus !== "synced" &&
      task.corSyncStatus !== "retrying" &&
      task.corSyncStatus !== "error"
    ) {
      if (!task.corTaskId) {
        console.log(
          `[scheduleTaskSyncToCOR] Task ${args.taskId} no está publicada en COR, omitiendo sync.`,
        );
        return;
      }
    }

    if (!task.corTaskId) return;

    console.log(
      `[scheduleTaskSyncToCOR] 🔄 Programando sync para task ${args.taskId}`,
    );
    await ctx.db.patch(args.taskId, {
      corSyncStatus: "syncing",
      corSyncAttempt: 0,
      corSyncError: undefined,
    });

    await ctx.scheduler.runAfter(0, internal.data.tasks.syncEditToCORAction, {
      taskId: args.taskId,
      changedFields: args.changedFields,
      attempt: 0,
    });
  },
});

/**
 * Action interna: sincroniza una edición local de Convex hacia COR.
 *
 * SEGURIDAD CRÍTICA:
 * - Lee el corTaskId y corProjectId directamente de la task de Convex
 * - Verifica que la task siga en estado "synced" antes de tocar COR
 * - Solo edita la task COR que corresponde al corTaskId guardado
 * - Verifica que la task en COR pertenece al proyecto correcto (corProjectId)
 * - Logea exhaustivamente cada operación para auditoría
 *
 * Flujo:
 * 1. Lee la task actualizada de Convex
 * 2. Si cambiaron campos nativos (title, deadline, priority) → updateTask directo
 * 3. Si cambiaron campos de descripción → regenera con buildCORDescription
 * 4. Actualiza hash y timestamps
 */
export const syncEditToCORAction = internalAction({
  args: {
    taskId: v.id("tasks"),
    changedFields: v.array(v.string()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 0;
    console.log("\n========================================");
    console.log("[SyncEdit] 🔄 SINCRONIZANDO EDICIÓN LOCAL → COR");
    console.log(`[SyncEdit] Task Convex ID: ${args.taskId}`);
    console.log(
      `[SyncEdit] Campos cambiados: ${args.changedFields.join(", ")}`,
    );
    console.log(`[SyncEdit] Intento: ${attempt + 1}/${MAX_RETRY_ATTEMPTS}`);
    console.log("========================================\n");

    try {
      // 1. Leer la task actualizada de Convex
      const task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, {
        taskId: args.taskId as string,
      });

      if (!task) {
        console.error("[SyncEdit] ❌ Task no encontrada en Convex");
        return;
      }

      // ═══════════════════════════════════════════════════
      // VERIFICACIONES DE SEGURIDAD — NUNCA SALTEAR
      // ═══════════════════════════════════════════════════

      // Verificar que la task sigue en estado sincronizable
      if (
        !["synced", "syncing", "retrying"].includes(task.corSyncStatus || "")
      ) {
        console.error(
          `[SyncEdit] ❌ Task no está en estado sincronizable (estado: ${task.corSyncStatus}). Abortando.`,
        );
        return;
      }

      // Verificar que tiene corTaskId
      const corTaskId = task.corTaskId;
      if (!corTaskId) {
        console.error("[SyncEdit] ❌ Task no tiene corTaskId. Abortando.");
        return;
      }

      // Verificar que tiene corProjectId
      const corProjectId = task.corProjectId;
      if (!corProjectId) {
        console.error("[SyncEdit] ❌ Task no tiene corProjectId. Abortando.");
        return;
      }

      // Verificar que tiene corClientId
      if (!task.corClientId) {
        console.error("[SyncEdit] ❌ Task no tiene corClientId. Abortando.");
        return;
      }

      console.log(`[SyncEdit] ✅ Verificaciones de seguridad OK:`);
      console.log(`  - corTaskId: ${corTaskId}`);
      console.log(`  - corProjectId: ${corProjectId}`);
      console.log(`  - corClientId: ${task.corClientId}`);
      console.log(`  - corClientName: ${task.corClientName}`);

      // 2. Obtener el provider
      const provider = getProjectManagementProvider();

      // 3. Primero, obtener la task actual de COR para verificación cruzada
      const corTask = await provider.getTask(parseInt(corTaskId));
      if (!corTask) {
        console.error(
          `[SyncEdit] ❌ Task COR ${corTaskId} no encontrada. ¿Fue eliminada?`,
        );
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: `Task COR ${corTaskId} no encontrada — puede haber sido eliminada`,
        });
        return;
      }

      // VERIFICACIÓN CRUZADA: la task de COR debe pertenecer al proyecto correcto
      if (corTask.projectId !== corProjectId) {
        console.error(
          `[SyncEdit] 🚨 ALERTA DE SEGURIDAD: La task COR ${corTaskId} pertenece al proyecto ${corTask.projectId}, no al esperado ${corProjectId}. ABORTANDO.`,
        );
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: `Error de seguridad: task COR pertenece a proyecto incorrecto`,
        });
        return;
      }

      console.log(
        `[SyncEdit] ✅ Verificación cruzada OK — task COR ${corTaskId} pertenece al proyecto ${corProjectId}`,
      );

      // ═══════════════════════════════════════════════════
      // CONSTRUIR EL UPDATE (mapeo 1:1)
      // ═══════════════════════════════════════════════════

      const updatePayload: Record<string, unknown> = {};

      // Solo sincronizar campos que tienen equivalente en COR
      const syncableChanges = args.changedFields.filter((f) =>
        COR_SYNCABLE_FIELDS.has(f),
      );

      if (syncableChanges.length === 0) {
        console.log(
          "[SyncEdit] ℹ️ No hay campos sincronizables con COR (cambios son solo locales)",
        );
      } else {
        console.log(
          `[SyncEdit] 📝 Campos a sincronizar: ${syncableChanges.join(", ")}`,
        );

        const strategicPriorityChanged =
          syncableChanges.includes("strategicPriority");
        const shouldSyncStrategicLabel =
          strategicPriorityChanged &&
          !!task.strategicPriority &&
          isStrategicPriority(task.strategicPriority);

        const taskFieldChanges = syncableChanges.filter(
          (f) => f !== "strategicPriority",
        );

        // Mapeo directo 1:1
        if (taskFieldChanges.includes("title"))
          updatePayload.title = task.title;
        if (taskFieldChanges.includes("description"))
          updatePayload.description = task.description || "";
        if (taskFieldChanges.includes("deadline"))
          updatePayload.deadline = task.deadline;
        if (taskFieldChanges.includes("priority"))
          updatePayload.priority = task.priority;
        if (taskFieldChanges.includes("status"))
          updatePayload.status = task.status;

        // 4. Actualizar la task en COR
        if (Object.keys(updatePayload).length > 0) {
          console.log(
            `[SyncEdit] 🚀 Enviando actualización a COR task ${corTaskId}:`,
            Object.keys(updatePayload),
          );

          const result = await provider.updateTask(
            parseInt(corTaskId),
            updatePayload as any,
          );

          if (!result.success) {
            console.error(
              `[SyncEdit] ❌ Error actualizando COR: ${result.error}`,
            );
            throw new Error(result.error || "Error desconocido de COR");
          }
        }

        if (shouldSyncStrategicLabel) {
          console.log(
            `[SyncEdit] 🏷️ Sincronizando etiqueta estratégica ${task.strategicPriority} en task COR ${corTaskId}`,
          );
          await syncStrategicPriorityLabelInCOR(
            parseInt(corTaskId),
            task.strategicPriority as StrategicPriority,
          );
        }
      }

      // 5. Subir archivos pendientes a COR (no-fatal)
      try {
        await uploadPendingAttachmentsToCOR(
          ctx,
          args.taskId,
          parseInt(corTaskId),
        );
      } catch (fileError) {
        console.error(
          "[SyncEdit] ⚠️ Error subiendo archivos pendientes:",
          fileError,
        );
      }

      // 6. Marcar como synced, actualizar hash y timestamp
      const successUpdate: Record<string, unknown> = {
        taskId: args.taskId,
        corSyncStatus: "synced",
        corSyncedAt: Date.now(),
      };
      if (updatePayload.description) {
        const newHash = hashText(updatePayload.description as string);
        successUpdate.corDescriptionHash = newHash;
        console.log(`[SyncEdit] ✅ Hash actualizado: ${newHash}`);
      }
      await ctx.runMutation(
        internal.data.tasks.updatePublishStatus,
        successUpdate as any,
      );

      console.log(`[SyncEdit] ✅ Sincronización completada exitosamente`);
      console.log("========================================\n");
    } catch (error) {
      const errorMsg = formatRetryError(error);
      console.error(
        `[SyncEdit] ❌ Error en sincronización (intento ${attempt + 1}):`,
        errorMsg,
      );

      // Errores 4xx son de validación/cliente — nunca se resuelven reintentando
      const canRetry = !isClientError(error) && shouldRetry(attempt);

      if (canRetry) {
        const delay = getRetryDelay(attempt)!;
        console.log(
          `[SyncEdit] 🔄 Reintentando en ${delay / 1000}s (intento ${attempt + 2}/${MAX_RETRY_ATTEMPTS})`,
        );

        // Marcar como "retrying" con el error actual
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "retrying",
          corSyncError: `Intento ${attempt + 1}/${MAX_RETRY_ATTEMPTS} falló: ${errorMsg}`,
        });
        await ctx.runMutation(internal.data.tasks.updateSyncMetadata, {
          taskId: args.taskId,
          corSyncAttempt: attempt + 1,
        });

        // Programar siguiente intento
        await ctx.scheduler.runAfter(
          delay,
          internal.data.tasks.syncEditToCORAction,
          {
            taskId: args.taskId,
            changedFields: args.changedFields,
            attempt: attempt + 1,
          },
        );
      } else {
        // Error de cliente (4xx) o reintentos agotados → marcar como error definitivo
        if (isClientError(error)) {
          console.error(
            `[SyncEdit] 🚫 Error de cliente (4xx) — no se reintenta: ${errorMsg}`,
          );
        } else {
          console.error(
            `[SyncEdit] 🚫 Reintentos agotados para task ${args.taskId}`,
          );
        }
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: isClientError(error)
            ? `Error de validación COR (no reintentable): ${errorMsg}`
            : `Falló después de ${MAX_RETRY_ATTEMPTS} intentos. Último error: ${errorMsg}`,
        });
        await ctx.runMutation(internal.data.tasks.updateSyncMetadata, {
          taskId: args.taskId,
          corSyncAttempt: attempt,
        });
      }
    }
  },
});

/**
 * Mutation interna para actualizar metadata de sync sin tocar otros campos.
 */
export const updateSyncMetadata = internalMutation({
  args: {
    taskId: v.id("tasks"),
    corDescriptionHash: v.optional(v.string()),
    corSyncedAt: v.optional(v.number()),
    lastLocalEditAt: v.optional(v.number()),
    corSyncAttempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const updateData: Record<string, unknown> = {};
    if (args.corDescriptionHash !== undefined)
      updateData.corDescriptionHash = args.corDescriptionHash;
    if (args.corSyncedAt !== undefined)
      updateData.corSyncedAt = args.corSyncedAt;
    if (args.lastLocalEditAt !== undefined)
      updateData.lastLocalEditAt = args.lastLocalEditAt;
    if (args.corSyncAttempt !== undefined)
      updateData.corSyncAttempt = args.corSyncAttempt;

    if (Object.keys(updateData).length > 0) {
      await ctx.db.patch(args.taskId, updateData as any);
    }
  },
});

/**
 * Mutation pública: reintento manual de sincronización con COR.
 * Llamada desde la UI cuando el usuario hace clic en "Reintentar" después de un error.
 */
export const retryTaskSync = mutation({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    const approvedExternalUser = await ctx.db
      .query("approvedExternalUsers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (approvedExternalUser) {
      throw new Error(
        "Los usuarios externos no pueden publicar o sincronizar con COR.",
      );
    }

    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task no encontrada");

    // Verificar permisos (clientUserAssignments)
    if (!(await hasTaskAccess(ctx, task, userId))) {
      throw new Error(
        "No tienes permisos para reintentar la sincronización de esta task.",
      );
    }

    // Solo permitir retry si está en error o retrying
    if (!["error", "retrying"].includes(task.corSyncStatus || "")) {
      throw new Error("La task no está en estado de error para reintentar.");
    }

    // Si la task nunca fue publicada (no tiene corTaskId), reintentar publicación
    if (!task.corTaskId) {
      console.log(
        `[retryTaskSync] 🔄 Reintentando PUBLICACIÓN de task ${args.taskId}`,
      );
      await ctx.db.patch(args.taskId, {
        corSyncStatus: "syncing",
        corSyncAttempt: 0,
        corSyncError: undefined,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.data.tasks.publishTaskToExternalAction,
        {
          taskId: args.taskId,
          attempt: 0,
        },
      );
      return { success: true, message: "Publicación reintentada" };
    }

    // Si ya tiene corTaskId, reintentar sincronización de edición
    console.log(`[retryTaskSync] 🔄 Reintentando SYNC de task ${args.taskId}`);
    await ctx.db.patch(args.taskId, {
      corSyncStatus: "syncing",
      corSyncAttempt: 0,
      corSyncError: undefined,
    });

    // Sincronizar todos los campos sincronizables
    const allSyncFields = [
      "title",
      "description",
      "deadline",
      "priority",
      "status",
      "strategicPriority",
    ];
    await ctx.scheduler.runAfter(0, internal.data.tasks.syncEditToCORAction, {
      taskId: args.taskId,
      changedFields: allSyncFields,
      attempt: 0,
    });

    return { success: true, message: "Sincronización reintentada" };
  },
});

// ==================== PUBLICAR TASK EN SISTEMA EXTERNO (COR) ====================

/**
 * Sube los attachments pendientes (sin corAttachmentId) de una task a COR.
 * Función reutilizable llamada desde publishTaskToExternalAction y syncEditToCORAction.
 *
 * Flujo por attachment:
 * 1. Descarga el blob desde Convex storage
 * 2. Sube a COR via provider.uploadTaskAttachment (multipart/form-data)
 * 3. Marca como sincronizado (corAttachmentId + corUrl)
 *
 * No lanza excepciones — los errores individuales se logean y se continúa.
 */
async function uploadPendingAttachmentsToCOR(
  ctx: ActionCtx,
  taskId: string,
  corTaskId: number,
): Promise<void> {
  const pendingAttachments = await ctx.runQuery(
    internal.data.tasks.getPendingAttachments,
    { taskId: taskId as any },
  );

  if (pendingAttachments.length === 0) return;

  console.log(
    `[Attachments] 📎 Subiendo ${pendingAttachments.length} archivos pendientes a COR task ${corTaskId}...`,
  );
  const provider = getProjectManagementProvider();
  let uploaded = 0;

  for (const att of pendingAttachments) {
    try {
      // Descargar blob desde Convex storage
      const blob = await ctx.storage.get(att.storageId as any);
      if (!blob) {
        console.error(
          `[Attachments] ⚠️ Blob no encontrado para storageId ${att.storageId}, omitiendo`,
        );
        continue;
      }

      const fileBuffer = await blob.arrayBuffer();

      // Subir a COR via multipart/form-data
      const result = await provider.uploadTaskAttachment({
        taskId: corTaskId,
        fileBuffer,
        filename: att.filename,
        mimeType: att.mimeType,
      });

      if (result.success && result.attachment) {
        // Marcar como sincronizado
        await ctx.runMutation(internal.data.tasks.updateAttachmentCORSync, {
          attachmentId: att._id,
          corAttachmentId: result.attachment.id,
          corUrl: result.attachment.url,
        });
        uploaded++;
        console.log(
          `[Attachments] ✅ ${att.filename} → COR attachment ${result.attachment.id}`,
        );
      } else {
        console.error(
          `[Attachments] ⚠️ Error subiendo ${att.filename}: ${result.error}`,
        );
      }
    } catch (fileError) {
      console.error(
        `[Attachments] ⚠️ Error con archivo ${att.filename}:`,
        fileError,
      );
    }
  }

  console.log(
    `[Attachments] 📎 ${uploaded}/${pendingAttachments.length} archivos subidos exitosamente`,
  );
}

async function publishPendingTaskMessagesToCOR(
  ctx: ActionCtx,
  taskId: string,
  corTaskId: number,
  provider: ProjectManagementProvider,
): Promise<void> {
  const pendingMessages = await ctx.runQuery(
    internal.data.tasks.listPendingTaskMessagesForCORInternal,
    { taskId: taskId as any },
  );

  if (pendingMessages.length === 0) return;

  console.log(
    `[TaskMessages] Publicando ${pendingMessages.length} comentario(s) pendiente(s) en COR task ${corTaskId}...`,
  );

  for (const message of pendingMessages) {
    try {
      const corMessage =
        message.source === "trello" ||
        (message.source === "external_agent" &&
          MARKDOWN_LINK_PATTERN.test(message.message))
          ? formatTrelloCommentForCOR(message.message)
          : message.message;

      const result = await provider.postTaskMessage({
        taskId: corTaskId,
        message: corMessage,
      });

      await ctx.runMutation(
        internal.data.tasks.updateTaskMessageSyncStatusInternal,
        {
          taskMessageId: message._id,
          corTaskId,
          corMessageSyncStatus: result.success ? "synced" : "error",
          corMessageSyncError: result.success
            ? undefined
            : result.error || "No se pudo publicar el comentario en COR.",
        },
      );

      if (!result.success) {
        console.error(
          `[TaskMessages] Error publicando comentario ${message._id} en COR: ${result.error}`,
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(
        internal.data.tasks.updateTaskMessageSyncStatusInternal,
        {
          taskMessageId: message._id,
          corTaskId,
          corMessageSyncStatus: "error",
          corMessageSyncError: errorMessage,
        },
      );
      console.error(
        `[TaskMessages] Error publicando comentario ${message._id} en COR: ${errorMessage}`,
      );
    }
  }
}

/**
 * Mutation pública que inicia la publicación de una task en el sistema externo.
 *
 * Patrón: mutation (feedback inmediato) → scheduler.runAfter(0, action) (trabajo async)
 *
 * 1. Valida que la task existe y pertenece al usuario
 * 2. Pone corSyncStatus: "syncing" (feedback inmediato para la UI)
 * 3. Schedula la action que hace el trabajo pesado (crear proyecto + task en COR)
 * 4. Retorna inmediatamente — la UI se actualiza reactivamente via subscriptions
 */
export const startPublishTaskToExternal = mutation({
  args: {
    taskId: v.id("tasks"),
    existingCorProjectId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Verificar autenticación usando getAuthUserId (consistente con el resto del codebase)
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("No autenticado");
    }

    const approvedExternalUser = await ctx.db
      .query("approvedExternalUsers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (approvedExternalUser) {
      throw new Error("Los usuarios externos no pueden publicar en COR.");
    }

    // Obtener la task
    const task = await ctx.db.get(args.taskId);
    if (!task) {
      throw new Error("Task no encontrada");
    }

    // Verificar que la task no está ya sincronizada
    if (task.corSyncStatus === "synced") {
      throw new Error("La task ya está publicada en el sistema externo");
    }

    // Verificar que no está en proceso de sincronización
    if (task.corSyncStatus === "syncing" || task.corSyncStatus === "retrying") {
      throw new Error(
        "La task ya está en proceso de publicación o sincronización. Espera a que termine.",
      );
    }

    // Verificar que la task tiene un cliente asociado
    if (!task.corClientId) {
      throw new Error(
        "No se puede publicar: no hay un cliente asociado a esta tarea.",
      );
    }

    const deadlineError = getPublishDeadlineError(task.deadline);
    if (deadlineError) {
      throw new Error(deadlineError);
    }

    if (
      args.existingCorProjectId !== undefined &&
      (!Number.isInteger(args.existingCorProjectId) ||
        args.existingCorProjectId <= 0)
    ) {
      throw new Error("El proyecto seleccionado no es válido.");
    }

    const descriptionError = validatePublishableDescription(task.description);
    if (descriptionError) {
      throw new Error(descriptionError);
    }

    // Buscar el cliente local por corClientId
    const localClient = await ctx.db
      .query("corClients")
      .withIndex("by_corClientId", (q) =>
        q.eq("corClientId", task.corClientId!),
      )
      .unique();

    if (!localClient) {
      throw new Error(
        "No se puede publicar: el cliente no está registrado en el sistema.",
      );
    }

    // Obtener el usuario directamente por su ID (ya autenticado por getAuthUserId)
    const user = await ctx.db.get(userId);

    if (!user) {
      throw new Error(
        "No se puede publicar: usuario no encontrado en el sistema.",
      );
    }

    // Verificar que el usuario tiene autorización para esta task.
    // Si la task tiene marca, alcanza con permiso a esa marca; si no, exige permiso completo al cliente.
    if (!(await hasTaskAccess(ctx, task, userId))) {
      throw new Error(
        `No tienes autorización para publicar esta tarea. Contacta al administrador.`,
      );
    }

    // Poner estado "syncing" — la UI lo verá inmediatamente
    await ctx.db.patch(args.taskId, {
      corSyncStatus: "syncing",
      corSyncError: undefined,
      corSyncAttempt: 0,
    });

    // Schedular la action que hace el trabajo pesado
    // runAfter(0, ...) = ejecutar inmediatamente en background
    await ctx.scheduler.runAfter(
      0,
      internal.data.tasks.publishTaskToExternalAction,
      {
        taskId: args.taskId,
        existingCorProjectId: args.existingCorProjectId,
      },
    );

    return { success: true, message: "Publicación iniciada" };
  },
});

/**
 * Action interna que ejecuta la publicación real en el sistema externo.
 * Se ejecuta en background via scheduler para no bloquear al usuario.
 *
 * Flujo:
 * 1. Lee la task de Convex
 * 2. Crea un PROYECTO en COR (POST /projects) asociado al client_id
 * 3. Crea una TASK en COR (POST /tasks) dentro del proyecto
 * 4. Actualiza la task local con los IDs externos y estado "synced"
 * 5. Asocia los archivos del thread a la task en COR
 */
export const publishTaskToExternalAction = internalAction({
  args: {
    taskId: v.id("tasks"),
    existingCorProjectId: v.optional(v.number()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 0;
    console.log("\n========================================");
    console.log("[PublishTask] 🚀 PUBLICANDO TASK EN SISTEMA EXTERNO");
    console.log(`[PublishTask] Task ID: ${args.taskId}`);
    console.log(`[PublishTask] Intento: ${attempt + 1}/${MAX_RETRY_ATTEMPTS}`);
    console.log("========================================\n");

    try {
      // 1. Leer la task de Convex
      const task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, {
        taskId: args.taskId as string,
      });

      if (!task) {
        console.error("[PublishTask] ❌ Task no encontrada");
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: "Task no encontrada en la base de datos",
        });
        return;
      }

      const deadlineError = getPublishDeadlineError(task.deadline);
      if (deadlineError) {
        console.error(`[PublishTask] ❌ ${deadlineError}`);
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: deadlineError,
        });
        return;
      }

      const descriptionError = validatePublishableDescription(task.description);
      if (descriptionError) {
        console.error(`[PublishTask] ❌ ${descriptionError}`);
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: descriptionError,
        });
        return;
      }

      // 2. Obtener el provider de integraciones
      const provider = getProjectManagementProvider();
      console.log(`[PublishTask] Provider: ${provider.name}`);

      // 3. Crear PROYECTO en el sistema externo (o reusar si ya fue publicado)
      const clientId = task.corClientId;
      if (!clientId) {
        console.error(
          "[PublishTask] ❌ No hay corClientId — no se puede crear proyecto",
        );
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError:
            "No se encontró un cliente asociado. Busca el cliente antes de publicar.",
        });
        return;
      }

      // Verificar si existe un proyecto local en la tabla projects
      let corProjectId: number | undefined;
      let localProjectDeliverables: number | undefined;
      let localProjectPmId: number | undefined;
      let localProjectBrandId: number | undefined;
      let localProjectProductId: number | undefined;
      let localProjectEstimatedTime: number | undefined;
      let shouldUpdateProjectFields = true;
      const projectId = (task as any).projectId as string | undefined;

      if (args.existingCorProjectId !== undefined) {
        console.log(
          `[PublishTask] 📁 Usando proyecto COR existente: ${args.existingCorProjectId}`,
        );

        const existingProject = await provider.getProject(
          args.existingCorProjectId,
        );
        if (!existingProject) {
          throw new Error(
            "No se pudo encontrar el proyecto seleccionado en COR.",
          );
        }
        if (existingProject.clientId !== clientId) {
          throw new Error(
            "El proyecto seleccionado no pertenece al cliente de esta tarea.",
          );
        }
        const existingProjectEndDate = optionalStringFromExternal(
          existingProject.endDate,
        );
        if (isDateBeforeToday(existingProjectEndDate)) {
          throw new Error(
            "El proyecto seleccionado ya está vencido. Selecciona otro proyecto activo.",
          );
        }

        corProjectId = existingProject.id;
        const localProject = projectId
          ? await ctx.runQuery(internal.data.projects.getProjectInternal, {
              projectId: projectId as any,
            })
          : null;
        const taskDeliverablesCount =
          typeof task.deliverablesCount === "number" &&
          Number.isFinite(task.deliverablesCount) &&
          task.deliverablesCount > 0
            ? Math.trunc(task.deliverablesCount)
            : undefined;
        localProjectDeliverables =
          taskDeliverablesCount !== undefined
            ? Math.max(
                0,
                Math.trunc(
                  optionalNumberFromExternal(existingProject.deliverables) ?? 0,
                ),
              ) +
              taskDeliverablesCount
            : optionalNumberFromExternal(existingProject.deliverables);
        const proposedEstimatedTime =
          typeof localProject?.estimatedTime === "number" &&
          Number.isFinite(localProject.estimatedTime) &&
          localProject.estimatedTime > 0
            ? localProject.estimatedTime
            : undefined;
        localProjectEstimatedTime =
          proposedEstimatedTime !== undefined
            ? Math.max(
                0,
                optionalNumberFromExternal(existingProject.estimatedTime) ?? 0,
              ) +
              proposedEstimatedTime
            : optionalNumberFromExternal(existingProject.estimatedTime);
        localProjectPmId = undefined;
        shouldUpdateProjectFields =
          taskDeliverablesCount !== undefined ||
          proposedEstimatedTime !== undefined;

        await ctx.runMutation(
          internal.data.projects.attachProjectToExistingCORProject,
          {
            projectId: projectId ? (projectId as any) : undefined,
            taskId: args.taskId,
            corProjectId: existingProject.id,
            name: optionalStringFromExternal(existingProject.name),
            brief: optionalStringFromExternal(existingProject.brief),
            startDate: optionalStringFromExternal(existingProject.startDate),
            endDate: existingProjectEndDate,
            status: optionalStringFromExternal(existingProject.status),
            deliverables: localProjectDeliverables,
            estimatedTime: localProjectEstimatedTime,
          },
        );
      } else if (projectId) {
        // Leer el proyecto local
        const localProject = await ctx.runQuery(
          internal.data.projects.getProjectInternal,
          {
            projectId: projectId as any,
          },
        );
        localProjectDeliverables = localProject?.deliverables;
        localProjectPmId = localProject?.pmId;
        localProjectBrandId = localProject?.brandId ?? task.brandId;
        localProjectProductId = localProject?.productId ?? task.productId;

        if (localProject?.corProjectId) {
          // El proyecto ya fue publicado en COR — reutilizar
          corProjectId = localProject.corProjectId;
          console.log(
            `[PublishTask] ℹ️ Reutilizando proyecto COR existente: ${corProjectId}`,
          );
        } else {
          // Crear el proyecto en COR
          console.log(
            `[PublishTask] 📁 Creando proyecto en COR para cliente ID: ${clientId}...`,
          );
          const projectName =
            localProject?.name ||
            `${task.corClientName || "Sin cliente"} - ${task.title}`;
          const corProjectBrief = localProject?.brief
            ? `Brief: ${localProject.brief}`
            : undefined;

          const project = await provider.createProject({
            name: projectName,
            clientId,
            description: corProjectBrief,
            deadline: localProject?.endDate || task.deadline,
            estimatedTime: localProject?.estimatedTime,
            brandId: localProjectBrandId,
            productId: localProjectBrandId ? localProjectProductId : undefined,
          });

          corProjectId = project.id;
          console.log(
            `[PublishTask] ✅ Proyecto creado en COR: ID ${corProjectId}`,
          );

          // Actualizar el proyecto local con el corProjectId
          await ctx.runMutation(
            internal.data.projects.updateProjectPublishStatus,
            {
              projectId: projectId as any,
              corProjectId: project.id,
              corSyncStatus: "synced",
            },
          );
        }
      } else {
        // Fallback: no hay proyecto local, crear directamente en COR (backward compat)
        console.log(
          `[PublishTask] 📁 Creando proyecto en COR (sin proyecto local) para cliente ID: ${clientId}...`,
        );
        const projectName = `${task.corClientName || "Sin cliente"} - ${task.title}`;

        const project = await provider.createProject({
          name: projectName,
          clientId,
          deadline: task.deadline,
          brandId: task.brandId,
          productId: task.brandId ? task.productId : undefined,
        });

        corProjectId = project.id;
        console.log(
          `[PublishTask] ✅ Proyecto creado en COR: ID ${corProjectId}`,
        );
      }

      // 3.5 Guardar campos soportados solo por update (deliverables, pm_id)
      if (
        corProjectId &&
        shouldUpdateProjectFields &&
        (localProjectDeliverables !== undefined ||
          localProjectPmId !== undefined ||
          localProjectEstimatedTime !== undefined)
      ) {
        console.log(
          `[PublishTask] 📝 Guardando deliverables/pm_id/estimated_time en proyecto COR ${corProjectId}...`,
        );

        const projectUpdate = await provider.updateProject(corProjectId, {
          deliverables: localProjectDeliverables,
          pmId: localProjectPmId,
          estimatedTime: localProjectEstimatedTime,
        });

        if (!projectUpdate.success) {
          throw new Error(
            projectUpdate.error ||
              `No se pudo guardar deliverables/pm_id en proyecto COR ${corProjectId}`,
          );
        }

        console.log(
          `[PublishTask] ✅ Deliverables/pm_id/estimated_time guardados en proyecto COR ${corProjectId}`,
        );
      }

      console.log(
        `[PublishTask] ✅ Proyecto listo: corProjectId=${corProjectId}`,
      );

      // 4. Crear TASK dentro del proyecto
      // Mapeo 1:1: cada campo de Convex va a su campo equivalente en COR
      // description → description, deadline → deadline, priority → priority
      console.log(
        `[PublishTask] 📋 Creando task en proyecto ${corProjectId}...`,
      );

      const externalTask = await provider.createTask({
        projectId: corProjectId!,
        title: task.title,
        description: task.description || "",
        deadline: task.deadline,
        priority: task.priority,
        status: task.status,
      });

      console.log(`[PublishTask] ✅ Task creada: ID ${externalTask.id}`);

      const strategicPriority = (task as any).strategicPriority;
      if (strategicPriority && isStrategicPriority(strategicPriority)) {
        console.log(
          `[PublishTask] 🏷️ Sincronizando etiqueta estratégica ${strategicPriority} en task COR ${externalTask.id}...`,
        );
        await syncStrategicPriorityLabelInCOR(
          externalTask.id,
          strategicPriority,
        );
        console.log(
          `[PublishTask] ✅ Etiqueta estratégica ${strategicPriority} aplicada en task COR ${externalTask.id}`,
        );
      }

      // 5. Actualizar task local con IDs externos y estado "synced"
      const descriptionHash = hashText(task.description || "");

      await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
        taskId: args.taskId,
        corSyncStatus: "synced",
        corTaskId: String(externalTask.id),
        corProjectId: corProjectId,
        corSyncedAt: Date.now(),
        corDescriptionHash: descriptionHash,
      });

      console.log(
        `[PublishTask] ✅ IDs guardados — corTaskId: ${externalTask.id}, corProjectId: ${corProjectId}, clientId: ${clientId}, hash: ${descriptionHash}`,
      );

      // 6. Publicar comentarios externos pendientes en COR (no-fatal: la task ya está publicada)
      try {
        await publishPendingTaskMessagesToCOR(
          ctx,
          args.taskId,
          externalTask.id,
          provider,
        );
      } catch (messageError) {
        console.error(
          "[PublishTask] ⚠️ Error publicando comentarios pendientes (task ya publicada):",
          messageError,
        );
      }

      // 7. Subir archivos pendientes a COR (no-fatal: la task ya está publicada)
      try {
        await uploadPendingAttachmentsToCOR(ctx, args.taskId, externalTask.id);
      } catch (fileError) {
        console.error(
          "[PublishTask] ⚠️ Error subiendo archivos (task ya publicada):",
          fileError,
        );
      }

      console.log("\n========================================");
      console.log("[PublishTask] 🏁 PUBLICACIÓN COMPLETADA");
      console.log(`[PublishTask] Proyecto: ${corProjectId}`);
      console.log(`[PublishTask] Task COR: ${externalTask.id}`);
      console.log("========================================\n");
    } catch (error) {
      const errorMsg = formatRetryError(error);
      console.error(
        `[PublishTask] ❌ Error publicando (intento ${attempt + 1}):`,
        errorMsg,
      );

      // Errores 4xx son de validación/cliente — nunca se resuelven reintentando
      const canRetry = !isClientError(error) && shouldRetry(attempt);

      if (canRetry) {
        const delay = getRetryDelay(attempt)!;
        console.log(
          `[PublishTask] 🔄 Reintentando en ${delay / 1000}s (intento ${attempt + 2}/${MAX_RETRY_ATTEMPTS})`,
        );

        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "retrying",
          corSyncError: `Intento ${attempt + 1}/${MAX_RETRY_ATTEMPTS} falló: ${errorMsg}`,
        });
        await ctx.runMutation(internal.data.tasks.updateSyncMetadata, {
          taskId: args.taskId,
          corSyncAttempt: attempt + 1,
        });

        await ctx.scheduler.runAfter(
          delay,
          internal.data.tasks.publishTaskToExternalAction,
          {
            taskId: args.taskId,
            existingCorProjectId: args.existingCorProjectId,
            attempt: attempt + 1,
          },
        );
      } else {
        if (isClientError(error)) {
          console.error(
            `[PublishTask] 🚫 Error de cliente (4xx) — no se reintenta: ${errorMsg}`,
          );
        } else {
          console.error(
            `[PublishTask] 🚫 Reintentos agotados para task ${args.taskId}`,
          );
        }
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: isClientError(error)
            ? `Error de validación COR (no reintentable): ${errorMsg}`
            : `Falló después de ${MAX_RETRY_ATTEMPTS} intentos. Último error: ${errorMsg}`,
        });
        await ctx.runMutation(internal.data.tasks.updateSyncMetadata, {
          taskId: args.taskId,
          corSyncAttempt: attempt,
        });
      }
    }
  },
});

/**
 * Mutation interna para actualizar el estado de publicación.
 * Llamada desde publishTaskToExternalAction para actualizar
 * la task con el resultado (éxito o error).
 */
export const updatePublishStatus = internalMutation({
  args: {
    taskId: v.id("tasks"),
    corSyncStatus: v.string(),
    corSyncError: v.optional(v.string()),
    corTaskId: v.optional(v.string()),
    corProjectId: v.optional(v.number()),
    corSyncedAt: v.optional(v.number()),
    corDescriptionHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updateData: Record<string, unknown> = {
      corSyncStatus: args.corSyncStatus,
    };

    if (args.corSyncError !== undefined)
      updateData.corSyncError = args.corSyncError;
    if (args.corTaskId !== undefined) updateData.corTaskId = args.corTaskId;
    if (args.corProjectId !== undefined)
      updateData.corProjectId = args.corProjectId;
    if (args.corSyncedAt !== undefined)
      updateData.corSyncedAt = args.corSyncedAt;
    if (args.corDescriptionHash !== undefined)
      updateData.corDescriptionHash = args.corDescriptionHash;

    // Auto-cleanup: cuando se marca "synced", limpiar error y resetear attempt
    if (args.corSyncStatus === "synced") {
      updateData.corSyncError = undefined;
      updateData.corSyncAttempt = 0;
    }

    await ctx.db.patch(args.taskId, updateData as any);
    console.log(
      `[UpdatePublishStatus] Task ${args.taskId} → ${args.corSyncStatus}`,
    );
  },
});

/**
 * Mutation interna para actualizar el estado de sincronización con el sistema externo.
 * Equivalente a la anterior updateCORSyncStatus de cor.ts, pero como mutation en tasks.ts.
 */
export const updateCORSyncStatus = internalMutation({
  args: {
    taskId: v.string(),
    corTaskId: v.optional(v.number()),
    syncStatus: v.string(), // "pending" | "synced" | "error"
    syncError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log(
      `[Tasks] Actualizando sync status de task ${args.taskId} a ${args.syncStatus}`,
    );

    await ctx.db.patch(args.taskId as any, {
      corTaskId: args.corTaskId ? String(args.corTaskId) : undefined,
      corSyncStatus: args.syncStatus,
      corSyncError: args.syncError,
    });

    return args.taskId;
  },
});

/**
 * Actualiza el timestamp de sincronización con COR.
 * Migrado desde workflows/taskCreation.ts.
 */
export const updateCORSyncTimestamp = internalMutation({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId as any, {
      corSyncedAt: Date.now(),
    });
  },
});
