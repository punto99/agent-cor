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
  action,
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
import type { ActionCtx, MutationCtx } from "../_generated/server";
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
const TRELLO_ATTACHMENT_SYNC_STALE_MS = 10 * 60 * 1000;
const COR_MAX_TASK_COLLABORATORS = 20;

type ChatUploadedFileInput = {
  fileId: string;
  storageId: string;
  filename: string;
  mimeType: string;
  size?: number;
};

async function getOrCreateTaskDraft(
  ctx: MutationCtx,
  args: { threadId: string; userId: Id<"users"> },
) {
  const drafts = await ctx.db
    .query("taskDrafts")
    .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
    .collect();

  if (drafts.length > 1) {
    throw new Error(
      `Integridad inválida: el thread ${args.threadId} tiene más de un borrador.`,
    );
  }

  const existing = drafts[0];
  if (existing) {
    if (existing.userId !== args.userId) {
      throw new Error(
        "Integridad inválida: el borrador pertenece a otro usuario.",
      );
    }
    const taskForThread = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    if (existing.status === "created") {
      if (
        !existing.taskId ||
        !taskForThread ||
        existing.taskId !== taskForThread._id
      ) {
        throw new Error(
          "Integridad inválida: el borrador creado no coincide con la task del thread.",
        );
      }
      return existing;
    }
    if (taskForThread) {
      const now = Date.now();
      await ctx.db.patch(existing._id, {
        status: "created",
        taskId: taskForThread._id,
        updatedAt: now,
        completedAt: now,
      });
      if (!taskForThread.taskDraftId) {
        await ctx.db.patch(taskForThread._id, { taskDraftId: existing._id });
      }
      return (await ctx.db.get(existing._id))!;
    }
    return existing;
  }

  const existingTask = await ctx.db
    .query("tasks")
    .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
    .first();
  const now = Date.now();
  const draftId = await ctx.db.insert("taskDrafts", {
    threadId: args.threadId,
    userId: args.userId,
    status: existingTask ? "created" : "collecting",
    taskId: existingTask?._id,
    createdAt: now,
    updatedAt: now,
    completedAt: existingTask ? now : undefined,
  });
  if (existingTask && !existingTask.taskDraftId) {
    await ctx.db.patch(existingTask._id, { taskDraftId: draftId });
  }
  return (await ctx.db.get(draftId))!;
}

async function insertExclusiveTaskAttachment(
  ctx: MutationCtx,
  args: {
    taskId: Id<"tasks">;
    fileId: string;
    storageId: string;
    filename: string;
    mimeType: string;
    size?: number;
    taskDraftId?: Id<"taskDrafts">;
    threadUploadedFileId?: Id<"threadUploadedFiles">;
    trelloAttachmentId?: string;
    trelloAttachmentUrl?: string;
  },
) {
  const task = await ctx.db.get(args.taskId);
  if (!task || task.convexStatus === "deleted") {
    throw new Error("No se puede adjuntar un archivo a una task inexistente.");
  }

  // fileId identifica el blob físico y puede repetirse legítimamente porque el
  // Agent deduplica archivos iguales. La identidad exclusiva es la fila de
  // threadUploadedFiles, que representa una subida concreta del usuario.
  const ownership = args.threadUploadedFileId
    ? await ctx.db.get(args.threadUploadedFileId)
    : null;
  if (args.threadUploadedFileId && !ownership) {
    throw new Error("Integridad inválida: no existe el registro de la subida.");
  }

  if (ownership) {
    const draft = await ctx.db.get(ownership.draftId);
    if (
      !draft ||
      draft.threadId !== ownership.threadId ||
      draft.userId !== ownership.userId ||
      ownership.fileId !== args.fileId ||
      ownership.storageId !== args.storageId ||
      ownership.filename !== args.filename ||
      ownership.mimeType !== args.mimeType
    ) {
      throw new Error(
        "Integridad inválida: los datos de la subida no coinciden con su archivo o borrador.",
      );
    }
    if (
      ownership.threadId !== task.threadId ||
      (ownership.taskId && ownership.taskId !== task._id) ||
      (draft.taskId && draft.taskId !== task._id) ||
      (args.taskDraftId && ownership.draftId !== args.taskDraftId) ||
      (task.taskDraftId && ownership.draftId !== task.taskDraftId) ||
      (ownership.status === "attached" && ownership.taskId !== task._id) ||
      (ownership.status === "pending" && ownership.taskId)
    ) {
      throw new Error(
        "Integridad inválida: la subida pertenece a otra conversación, borrador o task.",
      );
    }

    const attachmentsForUpload = await ctx.db
      .query("taskAttachments")
      .withIndex("by_thread_uploaded_file", (q) =>
        q.eq("threadUploadedFileId", ownership._id),
      )
      .collect();
    if (attachmentsForUpload.length > 1) {
      throw new Error(
        "Integridad inválida: una misma subida está asociada más de una vez.",
      );
    }
    const existingForUpload = attachmentsForUpload[0];
    if (existingForUpload) {
      if (
        existingForUpload.taskId !== task._id ||
        existingForUpload.fileId !== ownership.fileId ||
        existingForUpload.taskDraftId !== ownership.draftId
      ) {
        throw new Error(
          "Integridad inválida: la subida ya está asociada a otra task.",
        );
      }
      return existingForUpload._id;
    }
  }

  const sameTaskAttachments = (
    await ctx.db
      .query("taskAttachments")
      .withIndex("by_file", (q) => q.eq("fileId", args.fileId))
      .collect()
  ).filter((attachment) => attachment.taskId === args.taskId);

  // Compatibilidad: un attachment antiguo puede existir sin referencia a la
  // subida. Solo se adopta si hay exactamente uno y todavía no tiene origen.
  const legacyCandidates = sameTaskAttachments.filter(
    (attachment) => !attachment.threadUploadedFileId,
  );
  if (ownership && legacyCandidates.length > 1) {
    throw new Error(
      `Integridad inválida: hay múltiples attachments antiguos para ${args.fileId}.`,
    );
  }
  const existingForTask = ownership
    ? legacyCandidates[0]
    : sameTaskAttachments[0];
  if (existingForTask) {
    if (
      (existingForTask.taskDraftId &&
        args.taskDraftId &&
        existingForTask.taskDraftId !== args.taskDraftId)
    ) {
      throw new Error(
        `Integridad inválida: el attachment de ${args.fileId} tiene otro origen.`,
      );
    }
    if (
      (!existingForTask.taskDraftId && args.taskDraftId) ||
      (!existingForTask.threadUploadedFileId && args.threadUploadedFileId)
    ) {
      await ctx.db.patch(existingForTask._id, {
        taskDraftId:
          existingForTask.taskDraftId ?? ownership?.draftId ?? args.taskDraftId,
        threadUploadedFileId:
          existingForTask.threadUploadedFileId ?? ownership?._id,
      });
    }
    return existingForTask._id;
  }

  const attachmentId = await ctx.db.insert("taskAttachments", {
    taskId: args.taskId,
    taskDraftId: ownership?.draftId ?? args.taskDraftId,
    threadUploadedFileId: ownership?._id,
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
  if (ownership && ownership.status === "pending") {
    const attachedAt = Date.now();
    await ctx.db.patch(ownership._id, {
      status: "attached",
      taskId: task._id,
      attachedAt,
    });
  }
  return attachmentId;
}

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

function normalizeCollaboratorEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function formatCollaboratorName(
  user: Record<string, unknown> | null,
  corUser?: { corFirstName: string; corLastName: string; corEmail: string },
) {
  const localName =
    user && typeof user.name === "string" ? user.name.trim() : "";
  const corName = corUser
    ? `${corUser.corFirstName} ${corUser.corLastName}`.trim()
    : "";
  return localName || corName || normalizeCollaboratorEmail(user?.email) ||
    corUser?.corEmail || "Usuario sin nombre";
}

async function resolveCollaboratorUsersInCOR(
  ctx: any,
  userIds: Id<"users">[],
) {
  const normalizedUserIds = Array.from(
    new Set(userIds.map((userId) => String(userId))),
  ).map((userId) => {
    const normalized = ctx.db.normalizeId("users", userId);
    if (!normalized) throw new Error(`Usuario colaborador inválido: ${userId}.`);
    return normalized;
  });

  if (normalizedUserIds.length > COR_MAX_TASK_COLLABORATORS) {
    throw new Error(
      `La selección supera el máximo de ${COR_MAX_TASK_COLLABORATORS} colaboradores permitido por COR.`,
    );
  }

  const corUserIds = new Set<number>();
  for (const userId of normalizedUserIds) {
    const [user, approvedExternalUser, corUser] = await Promise.all([
      ctx.db.get(userId),
      ctx.db
        .query("approvedExternalUsers")
        .withIndex("by_user", (q: any) => q.eq("userId", userId))
        .unique(),
      ctx.db
        .query("corUsers")
        .withIndex("by_userId", (q: any) => q.eq("userId", userId))
        .unique(),
    ]);
    if (!user || approvedExternalUser || !corUser) {
      throw new Error(
        `La selección contiene un usuario externo, inexistente o no resuelto en COR: ${userId}.`,
      );
    }

    const localEmail = normalizeCollaboratorEmail(
      (user as Record<string, unknown>).email,
    );
    const corEmail = normalizeCollaboratorEmail(corUser.corEmail);
    if (!localEmail || localEmail !== corEmail) {
      throw new Error(
        `El email local de ${formatCollaboratorName(user as Record<string, unknown>, corUser)} no coincide con COR.`,
      );
    }
    corUserIds.add(corUser.corUserId);
  }

  return {
    collaboratorUserIds: normalizedUserIds,
    requiredCorUserIds: Array.from(corUserIds),
  };
}

async function getClientPublishingCollaboratorUserIds(
  ctx: any,
  args: {
    clientId?: Id<"corClients">;
    corClientId?: number;
  },
) {
  let clientId = args.clientId;
  if (!clientId && args.corClientId !== undefined) {
    const client = await ctx.db
      .query("corClients")
      .withIndex("by_corClientId", (q: any) =>
        q.eq("corClientId", args.corClientId),
      )
      .unique();
    clientId = client?._id;
  }
  if (!clientId) {
    return {
      clientId: undefined,
      collaboratorUserIds: [] as Id<"users">[],
    };
  }

  const settings = await ctx.db
    .query("clientCorPublishingSettings")
    .withIndex("by_client", (q: any) => q.eq("clientId", clientId))
    .unique();
  return {
    clientId,
    collaboratorUserIds:
      settings?.externalTaskCollaboratorUserIds ?? ([] as Id<"users">[]),
  };
}

async function resolveExternalTaskCollaboratorConfig(
  ctx: any,
  args: {
    clientId?: Id<"corClients">;
    corClientId?: number;
  },
) {
  const configured = await getClientPublishingCollaboratorUserIds(ctx, args);
  if (!configured.clientId) {
    throw new Error(
      "No se puede publicar la tarea externa: no se pudo resolver su cliente local.",
    );
  }

  // La configuración es opt-in por cliente. Una lista ausente o vacía conserva
  // el comportamiento histórico de publicación sin colaboradores automáticos.
  if (configured.collaboratorUserIds.length === 0) {
    return {
      clientId: configured.clientId,
      collaboratorUserIds: [] as Id<"users">[],
      requiredCorUserIds: [] as number[],
    };
  }

  const resolved = await resolveCollaboratorUsersInCOR(
    ctx,
    configured.collaboratorUserIds,
  );

  return {
    clientId: configured.clientId,
    ...resolved,
  };
}

async function getTaskCollaboratorUserIdsForDisplay(ctx: any, task: any) {
  if (task.corCollaboratorUserIds !== undefined) {
    return task.corCollaboratorUserIds as Id<"users">[];
  }
  if (task.source !== "external") return [] as Id<"users">[];
  const configured = await getClientPublishingCollaboratorUserIds(ctx, {
    clientId: task.clientId,
    corClientId: task.corClientId,
  });
  return configured.collaboratorUserIds;
}

async function resolveTaskCollaboratorSelection(ctx: any, task: any) {
  if (task.corCollaboratorUserIds !== undefined) {
    return await resolveCollaboratorUsersInCOR(
      ctx,
      task.corCollaboratorUserIds,
    );
  }

  if (task.source === "external") {
    const config = await resolveExternalTaskCollaboratorConfig(ctx, {
      clientId: task.clientId,
      corClientId: task.corClientId,
    });
    return {
      collaboratorUserIds: config.collaboratorUserIds,
      requiredCorUserIds: config.requiredCorUserIds,
    };
  }

  return {
    collaboratorUserIds: [] as Id<"users">[],
    requiredCorUserIds: [] as number[],
  };
}

async function ensureProjectCollaborators(
  provider: ProjectManagementProvider,
  projectId: number,
  requiredCorUserIds: number[],
) {
  if (requiredCorUserIds.length === 0) return;
  const current = await provider.getProjectCollaborators(projectId);
  const currentIds = new Set(current.map((collaborator) => collaborator.id));
  const missingIds = requiredCorUserIds.filter((id) => !currentIds.has(id));
  if (missingIds.length === 0) return;

  const result = await provider.addProjectCollaborators(projectId, missingIds);
  if (!result.success) {
    throw new Error(
      result.error ||
        `No se pudieron agregar colaboradores al proyecto COR ${projectId}.`,
    );
  }
}

async function ensureTaskCollaborators(
  provider: ProjectManagementProvider,
  taskId: number,
  requiredCorUserIds: number[],
) {
  if (requiredCorUserIds.length === 0) return;
  const current = await provider.getTaskCollaborators(taskId);
  const currentIds = new Set(current.map((collaborator) => collaborator.id));
  const missingIds = requiredCorUserIds.filter((id) => !currentIds.has(id));
  if (missingIds.length === 0) return;

  const finalIds = Array.from(new Set([...currentIds, ...requiredCorUserIds]));
  if (finalIds.length > COR_MAX_TASK_COLLABORATORS) {
    throw new Error(
      `No se pueden agregar los colaboradores obligatorios: la task COR ${taskId} superaría el máximo de ${COR_MAX_TASK_COLLABORATORS}.`,
    );
  }

  const result = await provider.setTaskCollaborators(taskId, finalIds);
  if (!result.success) {
    throw new Error(
      result.error ||
        `No se pudieron sincronizar colaboradores de la task COR ${taskId}.`,
    );
  }
}

async function ensurePublishedCollaborators(
  provider: ProjectManagementProvider,
  projectId: number,
  taskId: number,
  requiredCorUserIds: number[],
) {
  const errors: string[] = [];

  try {
    await ensureProjectCollaborators(provider, projectId, requiredCorUserIds);
  } catch (error) {
    errors.push(`Proyecto: ${formatRetryError(error)}`);
  }

  // Intentar también la task aunque COR rechace los colaboradores del proyecto.
  // Así cada reintento manual completa todo lo que COR permita en esa llamada.
  try {
    await ensureTaskCollaborators(provider, taskId, requiredCorUserIds);
  } catch (error) {
    errors.push(`Task: ${formatRetryError(error)}`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }
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

export const getTaskCollaboratorSelectionInternal = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") {
      throw new Error("Task no encontrada al resolver colaboradores COR.");
    }
    return await resolveTaskCollaboratorSelection(ctx, task);
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

// Garantiza un único borrador por conversación. Se usa al crear threads nuevos
// y como compatibilidad para conversaciones existentes previas a este schema.
export const ensureTaskDraftForThread = internalMutation({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!chatThread) {
      throw new Error(`No existe el thread ${args.threadId}.`);
    }
    const draft = await getOrCreateTaskDraft(ctx, {
      threadId: args.threadId,
      userId: chatThread.userId,
    });
    return draft._id;
  },
});

// Registra los archivos originales del usuario en un ledger propio del draft.
// Si la task del thread ya existe, los adjunta inmediatamente a esa misma task.
export const registerThreadUploadedFiles = internalMutation({
  args: {
    threadId: v.string(),
    messageId: v.string(),
    files: v.array(
      v.object({
        fileId: v.string(),
        storageId: v.string(),
        filename: v.string(),
        mimeType: v.string(),
        size: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (!args.messageId.trim()) {
      throw new Error("Integridad inválida: la subida no tiene messageId.");
    }
    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!chatThread) {
      throw new Error(`No existe el thread ${args.threadId}.`);
    }

    const draft = await getOrCreateTaskDraft(ctx, {
      threadId: args.threadId,
      userId: chatThread.userId,
    });
    const task = draft.taskId ? await ctx.db.get(draft.taskId) : null;
    if (draft.status === "created" && !task) {
      throw new Error(
        `Integridad inválida: el borrador ${draft._id} no tiene una task válida.`,
      );
    }
    if (task && task.threadId !== args.threadId) {
      throw new Error(
        "Integridad inválida: la task del borrador pertenece a otro thread.",
      );
    }

    const uniqueFiles = new Map<string, ChatUploadedFileInput>();
    for (const file of args.files) uniqueFiles.set(file.fileId, file);

    let registered = 0;
    let attached = 0;
    for (const file of uniqueFiles.values()) {
      // La idempotencia corresponde a la misma aparición en el mismo mensaje,
      // no al fileId global (que puede ser compartido por blobs deduplicados).
      let existingRecords = await ctx.db
        .query("threadUploadedFiles")
        .withIndex("by_thread_message_and_file", (q) =>
          q
            .eq("threadId", args.threadId)
            .eq("messageId", args.messageId)
            .eq("fileId", file.fileId),
        )
        .collect();

      // Migración no destructiva de filas creadas antes de guardar messageId.
      if (existingRecords.length === 0) {
        const legacyRecords = (
          await ctx.db
            .query("threadUploadedFiles")
            .withIndex("by_thread_and_file", (q) =>
              q.eq("threadId", args.threadId).eq("fileId", file.fileId),
            )
            .collect()
        ).filter(
          (record) =>
            record.draftId === draft._id && record.messageId === undefined,
        );
        if (legacyRecords.length === 1) {
          await ctx.db.patch(legacyRecords[0]._id, {
            messageId: args.messageId,
          });
          existingRecords = [
            { ...legacyRecords[0], messageId: args.messageId },
          ];
        } else if (legacyRecords.length > 1) {
          throw new Error(
            `Integridad inválida: hay múltiples subidas antiguas sin mensaje para ${file.fileId}.`,
          );
        }
      }

      if (existingRecords.length > 1) {
        throw new Error(
          `Integridad inválida: la misma subida de ${file.fileId} está registrada más de una vez.`,
        );
      }

      const existing = existingRecords[0];
      if (existing) {
        if (
          existing.threadId !== args.threadId ||
          existing.draftId !== draft._id ||
          existing.userId !== chatThread.userId ||
          existing.fileId !== file.fileId ||
          existing.storageId !== file.storageId ||
          existing.filename !== file.filename ||
          existing.mimeType !== file.mimeType
        ) {
          throw new Error(
            `Integridad inválida: la subida de ${file.fileId} no coincide con este mensaje o borrador.`,
          );
        }
        if (existing.taskId && task && existing.taskId !== task._id) {
          throw new Error(
            `Integridad inválida: el archivo ${file.fileId} ya pertenece a otra task.`,
          );
        }
        if (
          (existing.status === "attached" &&
            (!task || existing.taskId !== task._id)) ||
          (existing.status === "pending" && existing.taskId)
        ) {
          throw new Error(
            `Integridad inválida: el estado del archivo ${file.fileId} no coincide con su task.`,
          );
        }
        if (task && existing.status === "pending") {
          await insertExclusiveTaskAttachment(ctx, {
            taskId: task._id,
            taskDraftId: draft._id,
            threadUploadedFileId: existing._id,
            ...file,
          });
          const now = Date.now();
          await ctx.db.patch(existing._id, {
            status: "attached",
            taskId: task._id,
            attachedAt: now,
          });
          attached += 1;
        }
        continue;
      }

      const now = Date.now();
      const uploadedFileId = await ctx.db.insert("threadUploadedFiles", {
        draftId: draft._id,
        threadId: args.threadId,
        userId: chatThread.userId,
        messageId: args.messageId,
        fileId: file.fileId,
        storageId: file.storageId,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
        status: task ? "attached" : "pending",
        taskId: task?._id,
        uploadedAt: now,
        attachedAt: task ? now : undefined,
      });
      registered += 1;

      if (task) {
        await insertExclusiveTaskAttachment(ctx, {
          taskId: task._id,
          taskDraftId: draft._id,
          threadUploadedFileId: uploadedFileId,
          ...file,
        });
        attached += 1;
      }
    }

    if (task && attached > 0) {
      if (task.corTaskId) {
        await ctx.db.patch(task._id, {
          corSyncStatus: "syncing",
          corSyncAttempt: 0,
          corSyncError: undefined,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.data.tasks.syncEditToCORAction,
          { taskId: task._id, changedFields: [], attempt: 0 },
        );
      }
      if (task.trelloCardId) {
        await ctx.scheduler.runAfter(
          0,
          (internal as any).data.trello.syncPendingTaskAttachmentsToTrello,
          { taskId: task._id },
        );
      }
    }

    return {
      draftId: draft._id,
      taskId: task?._id,
      registered,
      attached,
      total: uniqueFiles.size,
    };
  },
});

export const getTaskDraftFilesForCreation = internalQuery({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!chatThread) throw new Error(`No existe el thread ${args.threadId}.`);

    const drafts = await ctx.db
      .query("taskDrafts")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
    if (drafts.length !== 1) {
      throw new Error(
        `Integridad inválida: se esperaba un único borrador para ${args.threadId}.`,
      );
    }
    const draft = drafts[0];
    if (draft.userId !== chatThread.userId || draft.status !== "collecting") {
      throw new Error("El borrador no está disponible para crear una task.");
    }

    const files = await ctx.db
      .query("threadUploadedFiles")
      .withIndex("by_draft_and_status", (q) =>
        q.eq("draftId", draft._id).eq("status", "pending"),
      )
      .collect();
    const prematurelyAttached = await ctx.db
      .query("threadUploadedFiles")
      .withIndex("by_draft_and_status", (q) =>
        q.eq("draftId", draft._id).eq("status", "attached"),
      )
      .first();
    if (prematurelyAttached) {
      throw new Error(
        "Integridad inválida: un borrador sin task contiene archivos ya adjuntados.",
      );
    }
    const withUrls = await Promise.all(
      files.map(async (file) => ({
        ...file,
        url: await ctx.storage.getUrl(file.storageId as any),
      })),
    );
    return { draftId: draft._id, files: withUrls };
  },
});

// Compatibilidad con invocaciones antiguas del background job. El ledger y la
// validación thread -> draft -> task siguen siendo obligatorios.
export const associateFilesToTask = internalAction({
  args: {
    taskId: v.string(),
    threadId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, {
      taskId: args.taskId,
    });
    if (!task || task.threadId !== args.threadId) {
      throw new Error(
        "No se pueden asociar archivos: la task no pertenece al thread indicado.",
      );
    }
    await registerLegacyThreadFilesForDraft(ctx, args.threadId);
  },
});

// Mutation interna para crear un registro de attachment
export const createTaskAttachment = internalMutation({
  args: {
    taskId: v.id("tasks"),
    taskDraftId: v.optional(v.id("taskDrafts")),
    threadUploadedFileId: v.optional(v.id("threadUploadedFiles")),
    fileId: v.string(),
    storageId: v.string(),
    filename: v.string(),
    mimeType: v.string(),
    size: v.optional(v.number()),
    trelloAttachmentId: v.optional(v.string()),
    trelloAttachmentUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") {
      throw new Error("No se puede adjuntar un archivo a una task inexistente.");
    }

    if (args.threadUploadedFileId) {
      const uploadedFile = await ctx.db.get(args.threadUploadedFileId);
      if (!uploadedFile || uploadedFile.fileId !== args.fileId) {
        throw new Error(
          "Integridad inválida: el registro de archivo no corresponde al fileId.",
        );
      }
      if (
        uploadedFile.threadId !== task.threadId ||
        (uploadedFile.taskId && uploadedFile.taskId !== task._id)
      ) {
        throw new Error(
          "Integridad inválida: el archivo pertenece a otra conversación o task.",
        );
      }
    }

    return await insertExclusiveTaskAttachment(ctx, args);
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
      trelloSyncStartedAt: undefined,
      trelloSyncedAt: Date.now(),
    });
  },
});

export const claimAttachmentTrelloSync = internalMutation({
  args: {
    taskId: v.id("tasks"),
    attachmentId: v.id("taskAttachments"),
  },
  handler: async (ctx, args) => {
    const attachment = await ctx.db.get(args.attachmentId);
    if (!attachment || attachment.taskId !== args.taskId) return null;
    if (attachment.trelloAttachmentId) return null;

    const now = Date.now();
    const syncStartedAt =
      typeof attachment.trelloSyncStartedAt === "number"
        ? attachment.trelloSyncStartedAt
        : 0;
    if (
      attachment.trelloSyncStatus === "syncing" &&
      now - syncStartedAt < TRELLO_ATTACHMENT_SYNC_STALE_MS
    ) {
      return null;
    }

    await ctx.db.patch(args.attachmentId, {
      trelloSyncStatus: "syncing",
      trelloSyncError: undefined,
      trelloSyncStartedAt: now,
    });

    return attachment;
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
      trelloSyncStartedAt: undefined,
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
    clientBrandId: v.optional(v.string()),
    requireIntegration: v.boolean(),
  },
  handler: async (ctx, args) => {
    const clientBrandId = normalizeClientBrandId(ctx, args.clientBrandId);

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
          clientBrandId !== undefined &&
          assignments.some(
            (assignment) => assignment.brandId === clientBrandId,
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
    clientBrandId: v.optional(v.id("clientBrands")),
    localClientId: v.optional(v.id("corClients")),
    corClientId: v.optional(v.number()),
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

    let brand = args.clientBrandId ? await ctx.db.get(args.clientBrandId) : null;
    if (args.clientBrandId && !brand) {
      return {
        ok: false as const,
        error: "❌ La categoría seleccionada no existe.",
      };
    }

    let client = null as any;
    if (brand) {
      if (!brand.clientId) {
        return {
          ok: false as const,
          error:
            "❌ La categoría no está vinculada a un cliente local. Contacta al administrador.",
        };
      }
      client = await ctx.db.get(brand.clientId);
    } else if (args.localClientId) {
      client = await ctx.db.get(args.localClientId);
    } else if (args.corClientId !== undefined) {
      client = await ctx.db
        .query("corClients")
        .withIndex("by_corClientId", (q) =>
          q.eq("corClientId", args.corClientId!),
        )
        .unique();
    }

    if (!client) {
      return {
        ok: false as const,
        error: "❌ El cliente seleccionado no existe localmente.",
      };
    }

    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_client_and_user", (q) =>
        q.eq("clientId", client._id).eq("userId", userId),
      )
      .collect();

    const hasAccess = brand
      ? assignments.some(
          (assignment) =>
            assignment.brandId === undefined ||
            assignment.brandId === args.clientBrandId,
        )
      : assignments.some((assignment) => assignment.brandId === undefined);

    if (!hasAccess) {
      return {
        ok: false as const,
        error: brand
          ? `❌ No tienes autorización para crear briefs para la categoría "${brand.name}".`
          : `❌ No tienes autorización para crear briefs para este cliente.`,
      };
    }

    if (!brand) {
      const clientBrands = await ctx.db
        .query("clientBrands")
        .withIndex("by_client", (q) => q.eq("clientId", client._id))
        .collect();

      if (clientBrands.length > 0) {
        return {
          ok: false as const,
          error: "❌ Este cliente requiere seleccionar una categoría antes de crear el requerimiento.",
          availableCategories: clientBrands.map((candidate) => ({
            clientBrandId: String(candidate._id),
            name: candidate.name,
          })),
        };
      }

      if (args.subBrandId) {
        return {
          ok: false as const,
          error:
            "❌ Este cliente no tiene marcas configuradas. No envíes una marca adicional para este requerimiento.",
        };
      }

      const existingProject = await ctx.db
        .query("projects")
        .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
        .unique();

      return {
        ok: true as const,
        userId: String(userId),
        localClientId: client._id,
        corClientId: client.corClientId,
        corClientName: client.name,
        clientBrandId: undefined,
        corBrandId: undefined,
        brandName: undefined,
        trelloBoardId: undefined,
        trelloBoardUrl: undefined,
        subBrandId: undefined,
        corProductId: undefined,
        subBrandName: undefined,
        existingProjectId: existingProject?._id || undefined,
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
    taskDraftId: v.id("taskDrafts"),
    expectedThreadUploadedFileIds: v.array(v.id("threadUploadedFiles")),
    existingProjectId: v.optional(v.id("projects")),
    externalTrelloAccessVerified: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!chatThread) {
      throw new Error(`No existe el thread ${args.threadId}.`);
    }

    const draft = await ctx.db.get(args.taskDraftId);
    if (
      !draft ||
      draft.threadId !== args.threadId ||
      draft.userId !== chatThread.userId ||
      draft.status !== "collecting" ||
      draft.taskId
    ) {
      throw new Error(
        "Integridad inválida: el borrador no está disponible para esta conversación.",
      );
    }
    if (
      args.taskCreatedBy &&
      args.taskCreatedBy !== String(chatThread.userId)
    ) {
      throw new Error(
        "Integridad inválida: el creador de la task no coincide con el dueño del borrador.",
      );
    }

    const existingTaskForThread = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    if (existingTaskForThread) {
      throw new Error(
        `Ya existe un requerimiento para esta conversación: ${existingTaskForThread._id}.`,
      );
    }

    const pendingFiles = await ctx.db
      .query("threadUploadedFiles")
      .withIndex("by_draft_and_status", (q) =>
        q.eq("draftId", draft._id).eq("status", "pending"),
      )
      .collect();
    const prematurelyAttached = await ctx.db
      .query("threadUploadedFiles")
      .withIndex("by_draft_and_status", (q) =>
        q.eq("draftId", draft._id).eq("status", "attached"),
      )
      .first();
    if (prematurelyAttached) {
      throw new Error(
        "Integridad inválida: un borrador sin task contiene archivos ya adjuntados.",
      );
    }
    const expectedUploadIds = args.expectedThreadUploadedFileIds
      .map(String)
      .sort();
    const pendingUploadIds = pendingFiles.map((file) => String(file._id)).sort();
    if (
      new Set(expectedUploadIds).size !== expectedUploadIds.length ||
      expectedUploadIds.length !== pendingUploadIds.length ||
      expectedUploadIds.some(
        (uploadedFileId, index) => uploadedFileId !== pendingUploadIds[index],
      )
    ) {
      throw new Error(
        "Los archivos del requerimiento cambiaron durante la creación. Intenta guardar nuevamente.",
      );
    }
    for (const file of pendingFiles) {
      if (
        file.threadId !== args.threadId ||
        file.userId !== chatThread.userId ||
        file.taskId
      ) {
        throw new Error(
          `Integridad inválida: el archivo ${file.fileId} no pertenece exclusivamente a este borrador.`,
        );
      }
    }

    const isExternalCreation =
      args.taskSource === "external" || args.projectSource === "external";
    const trelloRequired =
      isExternalCreation &&
      Boolean(args.taskClientBrandId ?? args.projectClientBrandId) &&
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
      taskDraftId: draft._id,
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

    const attachedAt = Date.now();
    for (const file of pendingFiles) {
      await insertExclusiveTaskAttachment(ctx, {
        taskId,
        taskDraftId: draft._id,
        threadUploadedFileId: file._id,
        fileId: file.fileId,
        storageId: file.storageId,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
      });
      await ctx.db.patch(file._id, {
        status: "attached",
        taskId,
        attachedAt,
      });
    }

    const createdAttachments = await ctx.db
      .query("taskAttachments")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
    if (createdAttachments.length !== pendingFiles.length) {
      throw new Error(
        `No se creó la task porque solo se asociaron ${createdAttachments.length} de ${pendingFiles.length} archivos.`,
      );
    }

    await ctx.db.patch(draft._id, {
      status: "created",
      taskId,
      updatedAt: attachedAt,
      completedAt: attachedAt,
    });

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

    return {
      projectId,
      taskId: taskId as string,
      attachmentCount: createdAttachments.length,
    };
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

function normalizeClientBrandId(
  ctx: any,
  value: string | undefined,
): Id<"clientBrands"> | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return ctx.db.normalizeId("clientBrands", trimmed) ?? undefined;
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
 * Compatibilidad para conversaciones creadas antes del ledger de archivos.
 * Recorre todo el historial una sola vez de forma idempotente y registra los
 * archivos originales en el draft. El flujo normal registra cada upload desde chat.ts.
 */
export async function registerLegacyThreadFilesForDraft(
  ctx: ActionCtx,
  threadId: string,
): Promise<void> {
  await ctx.runMutation(internal.data.tasks.ensureTaskDraftForThread, {
    threadId,
  });

  const originalsByMessage = new Map<
    string,
    Map<string, ChatUploadedFileInput>
  >();
  let cursor: string | null = null;
  do {
    const messagesResult = await listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor, numItems: 100 },
    });

    for (const msg of messagesResult.page as any[]) {
      if (msg?.message?.role !== "user" || !Array.isArray(msg.fileIds)) {
        continue;
      }
      const messageId = String(msg?._id ?? msg?.id ?? msg?.messageId ?? "");
      if (!messageId) {
        throw new Error(
          `No se pudo identificar un mensaje histórico con archivos del thread ${threadId}.`,
        );
      }
      const fileIds: string[] = Array.from(
        new Set<string>(
          (msg.fileIds as unknown[]).map((fileId: unknown) => String(fileId)),
        ),
      );
      const resolved: ChatUploadedFileInput[] = [];
      for (const fileId of fileIds) {
        const fileInfo = await ctx.runQuery(
          internal.data.tasks.getFileInfoInternal,
          { fileId },
        );
        if (!fileInfo) {
          throw new Error(
            `No se pudo resolver el archivo histórico ${fileId} del thread ${threadId}.`,
          );
        }
        resolved.push({
          fileId,
          storageId: fileInfo.storageId,
          filename: fileInfo.filename,
          mimeType: fileInfo.mimeType,
          size: fileInfo.size,
        });
      }

      const originals = resolved.filter(
        (candidate) =>
          !resolved.some(
            (possibleOriginal) =>
              possibleOriginal.fileId !== candidate.fileId &&
              candidate.filename.startsWith(`${possibleOriginal.filename}-img-`),
          ),
      );
      const originalsForMessage =
        originalsByMessage.get(messageId) ??
        new Map<string, ChatUploadedFileInput>();
      for (const original of originals) {
        originalsForMessage.set(original.fileId, original);
      }
      originalsByMessage.set(messageId, originalsForMessage);
    }

    if (messagesResult.isDone) break;
    cursor = messagesResult.continueCursor;
  } while (cursor);

  for (const [messageId, originalsByFileId] of originalsByMessage) {
    await ctx.runMutation(internal.data.tasks.registerThreadUploadedFiles, {
      threadId,
      messageId,
      files: Array.from(originalsByFileId.values()),
    });
  }
}

/**
 * @deprecated El flujo de creación usa taskDrafts + threadUploadedFiles.
 * Se conserva temporalmente para llamadas antiguas, con exclusividad reforzada
 * por createTaskAttachment.
 */
export async function associateFilesHelper(
  ctx: ActionCtx,
  taskId: string,
  threadId: string,
): Promise<void> {
  const task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, {
    taskId,
  });
  if (!task || task.threadId !== threadId) {
    throw new Error(
      "No se pueden asociar archivos: la task no pertenece al thread indicado.",
    );
  }
  await registerLegacyThreadFilesForDraft(ctx, threadId);
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

/**
 * Devuelve la selección efectiva que se mostrará en el panel.
 * Una selección propia de la task siempre prevalece sobre los defaults del cliente.
 */
export const getTaskCorCollaborators = query({
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

    const selectedUserIds = await getTaskCollaboratorUserIdsForDisplay(
      ctx,
      task,
    );
    const defaultIds =
      task.source === "external"
        ? (
            await getClientPublishingCollaboratorUserIds(ctx, {
              clientId: task.clientId,
              corClientId: task.corClientId,
            })
          ).collaboratorUserIds
        : [];
    const defaultIdSet = new Set(defaultIds.map(String));

    const collaborators = [];
    for (const collaboratorUserId of selectedUserIds) {
      const [user, corUser] = await Promise.all([
        ctx.db.get(collaboratorUserId),
        ctx.db
          .query("corUsers")
          .withIndex("by_userId", (q: any) =>
            q.eq("userId", collaboratorUserId),
          )
          .unique(),
      ]);
      const localEmail = normalizeCollaboratorEmail(
        user ? (user as Record<string, unknown>).email : undefined,
      );
      const corEmail = normalizeCollaboratorEmail(corUser?.corEmail);

      collaborators.push({
        userId: collaboratorUserId,
        corUserId: corUser?.corUserId,
        name: formatCollaboratorName(
          user ? (user as Record<string, unknown>) : null,
          corUser ?? undefined,
        ),
        email: localEmail || corEmail,
        availableInCOR: Boolean(
          user && corUser && localEmail && localEmail === corEmail,
        ),
        source: defaultIdSet.has(String(collaboratorUserId))
          ? ("client_default" as const)
          : ("task" as const),
      });
    }

    const published =
      Boolean(task.corTaskId) || task.corSyncStatus === "synced";
    return {
      collaborators,
      customized: task.corCollaboratorUserIds !== undefined,
      published,
      editable:
        !published &&
        task.corSyncStatus !== "syncing" &&
        task.corSyncStatus !== "retrying",
      maxCollaborators: COR_MAX_TASK_COLLABORATORS,
    };
  },
});

/** Busca únicamente usuarios internos que ya tienen una correspondencia válida en COR. */
export const searchTaskCorCollaboratorCandidates = query({
  args: {
    taskId: v.id("tasks"),
    search: v.string(),
  },
  handler: async (ctx, args) => {
    const viewerId = await getAuthUserId(ctx);
    if (!viewerId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, viewerId)) return [];

    const term = args.search.trim().toLowerCase();
    if (term.length < 2) return [];

    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") return [];
    if (!(await hasTaskAccess(ctx, task, viewerId))) return [];
    if (
      task.corTaskId ||
      task.corSyncStatus === "synced" ||
      task.corSyncStatus === "syncing" ||
      task.corSyncStatus === "retrying"
    ) {
      return [];
    }

    const selectedUserIds = await getTaskCollaboratorUserIdsForDisplay(
      ctx,
      task,
    );
    const selectedIds = new Set(selectedUserIds.map(String));
    const corUsers = await ctx.db.query("corUsers").collect();
    const candidates = [];

    for (const corUser of corUsers) {
      if (selectedIds.has(String(corUser.userId))) continue;
      const [user, approvedExternalUser] = await Promise.all([
        ctx.db.get(corUser.userId),
        ctx.db
          .query("approvedExternalUsers")
          .withIndex("by_user", (q: any) => q.eq("userId", corUser.userId))
          .unique(),
      ]);
      if (!user || approvedExternalUser) continue;

      const localEmail = normalizeCollaboratorEmail(
        (user as Record<string, unknown>).email,
      );
      const corEmail = normalizeCollaboratorEmail(corUser.corEmail);
      if (!localEmail || localEmail !== corEmail) continue;

      const name = formatCollaboratorName(
        user as Record<string, unknown>,
        corUser,
      );
      const searchable = [
        name,
        localEmail,
        corUser.corFirstName,
        corUser.corLastName,
      ]
        .join(" ")
        .toLowerCase();
      if (!searchable.includes(term)) continue;

      candidates.push({
        userId: corUser.userId,
        corUserId: corUser.corUserId,
        name,
        email: localEmail,
      });
    }

    return candidates
      .sort((a, b) =>
        a.name.localeCompare(b.name, "es", { sensitivity: "base" }),
      )
      .slice(0, 10);
  },
});

/** Guarda una selección propia de la task; nunca modifica la configuración del cliente. */
export const setTaskCorCollaborators = mutation({
  args: {
    taskId: v.id("tasks"),
    userIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const viewerId = await getAuthUserId(ctx);
    if (!viewerId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, viewerId)) {
      throw new Error("Los usuarios externos no pueden editar colaboradores.");
    }

    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") {
      throw new Error("Task no encontrada.");
    }
    if (!(await hasTaskAccess(ctx, task, viewerId))) {
      throw new Error("No tienes permisos para editar esta task.");
    }
    if (task.corTaskId || task.corSyncStatus === "synced") {
      throw new Error(
        "Los colaboradores no se pueden editar después de publicar la task en COR.",
      );
    }
    if (
      task.corSyncStatus === "syncing" ||
      task.corSyncStatus === "retrying"
    ) {
      throw new Error(
        "La task se está publicando. Espera a que termine antes de editar colaboradores.",
      );
    }

    const selection = await resolveCollaboratorUsersInCOR(ctx, args.userIds);
    const update: Record<string, unknown> = {
      corCollaboratorUserIds: selection.collaboratorUserIds,
    };
    if (task.corSyncStatus === "error" && !task.corTaskId) {
      // Si ya existe un proyecto parcial, conservar el flujo de reanudación aun
      // cuando el usuario deje la lista vacía para no crear un segundo proyecto.
      update.corExternalCollaboratorsPending =
        Boolean(task.corProjectId) || selection.requiredCorUserIds.length > 0;
    }
    await ctx.db.patch(args.taskId, update);

    return {
      success: true,
      collaboratorCount: selection.collaboratorUserIds.length,
    };
  },
});

export const getPublishedTaskCollaboratorContextInternal = internalQuery({
  args: {
    taskId: v.id("tasks"),
    viewerId: v.id("users"),
  },
  handler: async (ctx, args) => {
    if (await isExternalUser(ctx, args.viewerId)) return null;
    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted" || !task.corTaskId) {
      return null;
    }
    if (!(await hasTaskAccess(ctx, task, args.viewerId))) return null;
    return { corTaskId: task.corTaskId };
  },
});

/** Lee desde COR los colaboradores actuales de una task ya publicada. */
export const getPublishedTaskCorCollaborators = action({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const viewerId = await getAuthUserId(ctx);
    if (!viewerId) throw new Error("No autenticado");

    const context = await ctx.runQuery(
      internal.data.tasks.getPublishedTaskCollaboratorContextInternal,
      { taskId: args.taskId, viewerId },
    );
    if (!context) {
      throw new Error("No tienes acceso a una task COR publicada.");
    }

    const corTaskId = Number(context.corTaskId);
    if (!Number.isInteger(corTaskId) || corTaskId <= 0) {
      throw new Error("La task tiene un identificador COR inválido.");
    }

    const collaborators = await getProjectManagementProvider().getTaskCollaborators(
      corTaskId,
    );
    return collaborators.map((collaborator) => ({
      corUserId: collaborator.id,
      name:
        `${collaborator.firstName || ""} ${collaborator.lastName || ""}`.trim() ||
        collaborator.email ||
        `Usuario COR ${collaborator.id}`,
      email: collaborator.email,
    }));
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

    // Compatibilidad con publicaciones iniciadas antes de separar ambos estados:
    // si proyecto y task ya existen, reintentar únicamente colaboradores.
    if (
      task.corExternalCollaboratorsPending === true &&
      task.corProjectId &&
      task.corTaskId
    ) {
      await resolveTaskCollaboratorSelection(ctx, task);
      await ctx.db.patch(args.taskId, {
        corSyncStatus: "synced",
        corSyncAttempt: 0,
        corSyncError: undefined,
        corCollaboratorSyncStatus: "syncing",
        corCollaboratorSyncError: undefined,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.data.tasks.retryTaskCollaboratorsAction,
        {
          taskId: args.taskId,
        },
      );
      return {
        success: true,
        message: "Sincronización de colaboradores reintentada",
      };
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

/**
 * Reintenta exclusivamente colaboradores de una task ya publicada.
 * Nunca crea ni modifica el proyecto o la task principal en COR.
 */
export const retryTaskCollaborators = mutation({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, userId)) {
      throw new Error(
        "Los usuarios externos no pueden sincronizar colaboradores con COR.",
      );
    }

    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") {
      throw new Error("Task no encontrada");
    }
    if (!(await hasTaskAccess(ctx, task, userId))) {
      throw new Error(
        "No tienes permisos para reintentar los colaboradores de esta task.",
      );
    }
    if (!task.corProjectId || !task.corTaskId) {
      throw new Error(
        "No se pueden reintentar colaboradores porque la publicación en COR está incompleta.",
      );
    }
    if (task.corCollaboratorSyncStatus !== "error") {
      throw new Error(
        "Los colaboradores no están en estado de error para reintentar.",
      );
    }

    await resolveTaskCollaboratorSelection(ctx, task);
    await ctx.db.patch(args.taskId, {
      corCollaboratorSyncStatus: "syncing",
      corCollaboratorSyncError: undefined,
      corExternalCollaboratorsPending: true,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.data.tasks.retryTaskCollaboratorsAction,
      { taskId: args.taskId },
    );

    return {
      success: true,
      message: "Sincronización de colaboradores iniciada",
    };
  },
});

/** Ejecuta un único intento manual de colaboradores; no agenda reintentos. */
export const retryTaskCollaboratorsAction = internalAction({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    try {
      const task = await ctx.runQuery(
        internal.data.tasks.getTaskByIdInternal,
        { taskId: args.taskId as string },
      );
      if (!task) throw new Error("Task no encontrada");

      const projectId = task.corProjectId;
      const taskId = Number(task.corTaskId);
      if (!projectId || !Number.isInteger(taskId) || taskId <= 0) {
        throw new Error(
          "La task no tiene identificadores COR válidos para sincronizar colaboradores.",
        );
      }

      const selection = await ctx.runQuery(
        internal.data.tasks.getTaskCollaboratorSelectionInternal,
        { taskId: args.taskId },
      );
      await ensurePublishedCollaborators(
        getProjectManagementProvider(),
        projectId,
        taskId,
        selection.requiredCorUserIds,
      );
      await ctx.runMutation(
        internal.data.tasks.updateCollaboratorSyncStatus,
        {
          taskId: args.taskId,
          status: "synced",
          pending: false,
        },
      );
    } catch (error) {
      const errorMsg = formatRetryError(error);
      await ctx.runMutation(
        internal.data.tasks.updateCollaboratorSyncStatus,
        {
          taskId: args.taskId,
          status: "error",
          error: errorMsg,
          pending: true,
        },
      );
      console.error(
        "[RetryTaskCollaborators] No se pudieron sincronizar colaboradores:",
        errorMsg,
      );
    }
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

    // Congelar la selección final antes de iniciar la publicación. Para una task
    // externa sin personalización se toman los defaults actuales del cliente;
    // una task interna sin selección conserva una lista vacía.
    const collaboratorSelection = await resolveTaskCollaboratorSelection(ctx, {
      ...task,
      clientId: task.clientId ?? localClient._id,
    });
    const shouldManageCollaborators =
      collaboratorSelection.requiredCorUserIds.length > 0;

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
      corCollaboratorUserIds: collaboratorSelection.collaboratorUserIds,
      corExternalCollaboratorsPending: shouldManageCollaborators,
      corCollaboratorSyncStatus: shouldManageCollaborators
        ? "pending"
        : undefined,
      corCollaboratorSyncError: undefined,
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
 * 2. Crea o reutiliza un PROYECTO en COR asociado al client_id
 * 3. Crea una TASK en COR dentro del proyecto
 * 4. Guarda ambos IDs y marca la publicación principal como "synced"
 * 5. Sincroniza colaboradores con estado independiente y sin reintentos
 * 6. Asocia comentarios y archivos pendientes a la task en COR
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

      const collaboratorSelection = await ctx.runQuery(
        internal.data.tasks.getTaskCollaboratorSelectionInternal,
        { taskId: args.taskId },
      );
      const requiredCorUserIds = collaboratorSelection.requiredCorUserIds;
      const collaboratorPublicationPending =
        task.corExternalCollaboratorsPending === true;

      // Verificar si existe un proyecto local en la tabla projects
      let corProjectId: number | undefined;
      let localProjectDeliverables: number | undefined;
      let localProjectPmId: number | undefined;
      let localProjectBrandId: number | undefined;
      let localProjectProductId: number | undefined;
      let localProjectEstimatedTime: number | undefined;
      let shouldUpdateProjectFields = true;
      const projectId = (task as any).projectId as string | undefined;

      if (task.corProjectId) {
        const resumedProject = await provider.getProject(task.corProjectId);
        if (!resumedProject || resumedProject.clientId !== clientId) {
          throw new Error(
            `No se pudo reanudar la publicación: el proyecto COR ${task.corProjectId} no existe o pertenece a otro cliente.`,
          );
        }
        corProjectId = resumedProject.id;
        // Los campos de proyecto ya fueron aplicados antes de persistir este ID.
        // No se vuelven a sumar deliverables/horas en un reintento.
        shouldUpdateProjectFields = false;
        console.log(
          `[PublishTask] Reanudando publicación con proyecto COR ${corProjectId}`,
        );
      } else if (args.existingCorProjectId !== undefined) {
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

      if (!corProjectId) {
        throw new Error("No se pudo resolver el proyecto COR de la task.");
      }

      // Persistir el proyecto antes de crear la task permite reanudar un error
      // de publicación sin crear un segundo proyecto.
      await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
        taskId: args.taskId,
        corSyncStatus: "syncing",
        corProjectId,
      });

      console.log(
        `[PublishTask] ✅ Proyecto listo: corProjectId=${corProjectId}`,
      );

      // 4. Crear TASK dentro del proyecto
      // Mapeo 1:1: cada campo de Convex va a su campo equivalente en COR
      // description → description, deadline → deadline, priority → priority
      let externalTask;
      if (task.corTaskId) {
        externalTask = await provider.getTask(parseInt(task.corTaskId, 10));
        if (!externalTask || externalTask.projectId !== corProjectId) {
          throw new Error(
            `No se pudo reanudar la publicación: la task COR ${task.corTaskId} no existe o pertenece a otro proyecto.`,
          );
        }
        console.log(
          `[PublishTask] Reanudando publicación con task COR ${externalTask.id}`,
        );
      } else {
        console.log(
          `[PublishTask] 📋 Creando task en proyecto ${corProjectId}...`,
        );
        externalTask = await provider.createTask({
          projectId: corProjectId,
          title: task.title,
          description: task.description || "",
          deadline: task.deadline,
          priority: task.priority,
          status: task.status,
        });
        console.log(`[PublishTask] ✅ Task creada: ID ${externalTask.id}`);
      }

      // Guardar ambos IDs antes de cualquier operación posterior garantiza que
      // un error de etiqueta u otra sincronización no pueda duplicar recursos.
      await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
        taskId: args.taskId,
        corSyncStatus: "syncing",
        corTaskId: String(externalTask.id),
        corProjectId,
      });

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

      // La publicación principal ya terminó. Los colaboradores tienen un
      // estado independiente: un error aquí no revierte ni reintenta proyecto/task.
      if (collaboratorPublicationPending && requiredCorUserIds.length > 0) {
        try {
          await ctx.runMutation(
            internal.data.tasks.updateCollaboratorSyncStatus,
            {
              taskId: args.taskId,
              status: "syncing",
              pending: true,
            },
          );
          await ensurePublishedCollaborators(
            provider,
            corProjectId,
            externalTask.id,
            requiredCorUserIds,
          );
          await ctx.runMutation(
            internal.data.tasks.updateCollaboratorSyncStatus,
            {
              taskId: args.taskId,
              status: "synced",
              pending: false,
            },
          );
          console.log(
            `[PublishTask] ✅ Colaboradores sincronizados en proyecto ${corProjectId} y task ${externalTask.id}`,
          );
        } catch (collaboratorError) {
          const collaboratorErrorMsg = formatRetryError(collaboratorError);
          try {
            await ctx.runMutation(
              internal.data.tasks.updateCollaboratorSyncStatus,
              {
                taskId: args.taskId,
                status: "error",
                error: collaboratorErrorMsg,
                pending: true,
              },
            );
          } catch (statusError) {
            console.error(
              "[PublishTask] ⚠️ No se pudo guardar el error independiente de colaboradores:",
              statusError,
            );
          }
          console.error(
            "[PublishTask] ⚠️ Proyecto y task publicados; falló únicamente la sincronización de colaboradores:",
            collaboratorErrorMsg,
          );
        }
      } else if (collaboratorPublicationPending) {
        try {
          await ctx.runMutation(
            internal.data.tasks.updateCollaboratorSyncStatus,
            {
              taskId: args.taskId,
              status: "synced",
              pending: false,
            },
          );
        } catch (statusError) {
          console.error(
            "[PublishTask] ⚠️ No se pudo cerrar el estado independiente de colaboradores:",
            statusError,
          );
        }
      }

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
    corExternalCollaboratorsPending: v.optional(v.boolean()),
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
    if (args.corExternalCollaboratorsPending !== undefined) {
      updateData.corExternalCollaboratorsPending =
        args.corExternalCollaboratorsPending;
    }

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

export const updateCollaboratorSyncStatus = internalMutation({
  args: {
    taskId: v.id("tasks"),
    status: v.union(
      v.literal("pending"),
      v.literal("syncing"),
      v.literal("synced"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
    pending: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId, {
      corCollaboratorSyncStatus: args.status,
      corCollaboratorSyncError: args.error,
      corExternalCollaboratorsPending: args.pending,
    });
    console.log(
      `[UpdateCollaboratorSyncStatus] Task ${args.taskId} → ${args.status}`,
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
