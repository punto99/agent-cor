import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { trelloProvider } from "../integrations/trelloProvider";
import { PRIORITY_LABELS } from "../lib/briefFormat";
import { TASK_STATUS_OPTIONS, getTaskStatusName } from "../lib/taskStatuses";

const CUSTOM_FIELDS = [
  { key: "brand", name: "Marca", type: "text" as const },
  { key: "requestType", name: "Tipo de requerimiento", type: "text" as const },
  { key: "priority", name: "Prioridad", type: "text" as const },
  { key: "deliverablesCount", name: "Cantidad de entregables", type: "number" as const },
];

const internalTrello: any = (internal as any).data.trello;
const TRELLO_LABEL_COLORS = [
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
  "blue",
  "sky",
  "lime",
  "pink",
  "black",
];
const LABEL_SYNC_STALE_MS = 60_000;
const LABEL_SYNC_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function normalizeTrelloLabelName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function htmlToTrelloMarkdown(value: string | undefined) {
  if (!value) return "";
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/strong>/gi, "**")
    .replace(/<strong>/gi, "**")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .trim();
}

function buildTrelloDescription(args: {
  project: any;
  task: any;
  requestType: string;
  deliverablesCount: number;
}) {
  const lines = [
    `## Proyecto`,
    `**Nombre:** ${args.project.name}`,
    `**Marca:** ${args.task.brandName || args.project.brandName || "No especificada"}`,
    `**Tipo de requerimiento:** ${args.requestType}`,
    `**Deadline:** ${args.task.deadline || args.project.endDate || "No especificado"}`,
    `**Cantidad de entregables:** ${args.deliverablesCount}`,
    `**Prioridad:** ${PRIORITY_LABELS[args.task.priority ?? 1] ?? "Media"}`,
    "",
    `## Brief`,
    htmlToTrelloMarkdown(args.task.description),
  ];

  if (args.project.brief) {
    lines.push("", "## Archivos de referencia", args.project.brief);
  }

  return lines.filter((line) => line !== undefined).join("\n");
}

export const getTaskProjectForTrello = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") {
      return { ok: false as const, error: "Task no encontrada." };
    }

    if (task.source !== "external") {
      return { ok: false as const, error: "Solo se sincronizan a Trello tasks externas." };
    }

    if (!task.projectId) {
      return { ok: false as const, error: "La task no tiene proyecto asociado." };
    }

    const project = await ctx.db.get(task.projectId);
    if (!project || project.convexStatus === "deleted") {
      return { ok: false as const, error: "Proyecto no encontrado." };
    }

    if (!task.clientBrandId) {
      return { ok: false as const, error: "La task no tiene marca asociada." };
    }

    const brand = await ctx.db.get(task.clientBrandId);
    if (!brand) {
      return { ok: false as const, error: "Marca no encontrada." };
    }

    if (!brand.trelloBoardId) {
      return {
        ok: false as const,
        error: `La marca "${brand.name}" no tiene trelloBoardId configurado.`,
      };
    }

    const listMapping = await ctx.db
      .query("trelloBoardLists")
      .withIndex("by_brand_and_status", (q) =>
        q.eq("clientBrandId", brand._id).eq("status", task.status)
      )
      .unique();

    if (!listMapping) {
      return {
        ok: false as const,
        error: `No hay lista Trello configurada para el status "${getTaskStatusName(task.status)}" en la marca "${brand.name}".`,
      };
    }

    const existingCard = await ctx.db
      .query("trelloCards")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .first();

    const customFields = await ctx.db
      .query("trelloBoardCustomFields")
      .withIndex("by_brand", (q) => q.eq("clientBrandId", brand._id))
      .collect();

    return {
      ok: true as const,
      task,
      project,
      brand,
      boardId: brand.trelloBoardId,
      listId: listMapping.trelloListId,
      existingCard,
      customFields,
    };
  },
});

export const upsertBoardListMapping = internalMutation({
  args: {
    clientBrandId: v.id("clientBrands"),
    trelloBoardId: v.string(),
    status: v.string(),
    name: v.string(),
    trelloListId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("trelloBoardLists")
      .withIndex("by_brand_and_status", (q) =>
        q.eq("clientBrandId", args.clientBrandId).eq("status", args.status)
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        trelloBoardId: args.trelloBoardId,
        name: args.name,
        trelloListId: args.trelloListId,
        syncedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("trelloBoardLists", {
      clientBrandId: args.clientBrandId,
      trelloBoardId: args.trelloBoardId,
      status: args.status,
      name: args.name,
      trelloListId: args.trelloListId,
      syncedAt: now,
    });
  },
});

export const upsertCustomFieldMapping = internalMutation({
  args: {
    clientBrandId: v.id("clientBrands"),
    trelloBoardId: v.string(),
    fieldKey: v.string(),
    name: v.string(),
    type: v.string(),
    trelloCustomFieldId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("trelloBoardCustomFields")
      .withIndex("by_brand_and_key", (q) =>
        q.eq("clientBrandId", args.clientBrandId).eq("fieldKey", args.fieldKey)
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        trelloBoardId: args.trelloBoardId,
        name: args.name,
        type: args.type,
        trelloCustomFieldId: args.trelloCustomFieldId,
        syncedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("trelloBoardCustomFields", {
      clientBrandId: args.clientBrandId,
      trelloBoardId: args.trelloBoardId,
      fieldKey: args.fieldKey,
      name: args.name,
      type: args.type,
      trelloCustomFieldId: args.trelloCustomFieldId,
      syncedAt: now,
    });
  },
});

export const getSubBrandLabelContext = internalQuery({
  args: {
    subBrandId: v.id("subBrands"),
    clientBrandId: v.id("clientBrands"),
  },
  handler: async (ctx, args) => {
    const subBrand = await ctx.db.get(args.subBrandId);
    if (!subBrand) {
      return { ok: false as const, error: "Marca no encontrada." };
    }
    if (subBrand.clientBrandId !== args.clientBrandId) {
      return {
        ok: false as const,
        error: "La marca no pertenece a la categoría de la task.",
      };
    }

    const siblings = await ctx.db
      .query("subBrands")
      .withIndex("by_brand", (q) => q.eq("clientBrandId", args.clientBrandId))
      .collect();

    siblings.sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.corProductId - b.corProductId;
    });

    return {
      ok: true as const,
      subBrand,
      siblings: siblings.map((sibling) => ({
        _id: sibling._id,
        name: sibling.name,
        corProductId: sibling.corProductId,
      })),
    };
  },
});

export const claimSubBrandLabelSync = internalMutation({
  args: {
    subBrandId: v.id("subBrands"),
    clientBrandId: v.id("clientBrands"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const subBrand = await ctx.db.get(args.subBrandId);
    if (!subBrand) {
      return { status: "error" as const, error: "Marca no encontrada." };
    }
    if (subBrand.clientBrandId !== args.clientBrandId) {
      return {
        status: "error" as const,
        error: "La marca no pertenece a la categoría de la task.",
      };
    }

    if (subBrand.trelloLabelId) {
      if (subBrand.trelloLabelSyncStatus !== "synced") {
        await ctx.db.patch(subBrand._id, {
          trelloLabelSyncStatus: "synced",
          trelloLabelSyncError: undefined,
          trelloLabelSyncedAt: subBrand.trelloLabelSyncedAt ?? now,
        });
      }
      return {
        status: "synced" as const,
        labelId: subBrand.trelloLabelId,
        labelName: subBrand.trelloLabelName ?? subBrand.name,
        labelColor: subBrand.trelloLabelColor,
      };
    }

    if (
      subBrand.trelloLabelSyncStatus === "syncing" &&
      subBrand.trelloLabelSyncStartedAt &&
      now - subBrand.trelloLabelSyncStartedAt < LABEL_SYNC_STALE_MS
    ) {
      return { status: "locked" as const };
    }

    await ctx.db.patch(subBrand._id, {
      trelloLabelSyncStatus: "syncing",
      trelloLabelSyncError: undefined,
      trelloLabelSyncStartedAt: now,
    });

    return { status: "claimed" as const };
  },
});

export const markSubBrandLabelSynced = internalMutation({
  args: {
    subBrandId: v.id("subBrands"),
    clientBrandId: v.id("clientBrands"),
    trelloLabelId: v.string(),
    trelloLabelName: v.string(),
    trelloLabelColor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const subBrand = await ctx.db.get(args.subBrandId);
    if (!subBrand) throw new Error("Marca no encontrada.");
    if (subBrand.clientBrandId !== args.clientBrandId) {
      throw new Error("La marca no pertenece a la categoría de la task.");
    }

    const now = Date.now();
    await ctx.db.patch(subBrand._id, {
      trelloLabelId: args.trelloLabelId,
      trelloLabelName: args.trelloLabelName,
      trelloLabelColor: args.trelloLabelColor,
      trelloLabelSyncStatus: "synced",
      trelloLabelSyncError: undefined,
      trelloLabelSyncedAt: now,
      trelloLabelSyncStartedAt: undefined,
    });
  },
});

export const markSubBrandLabelError = internalMutation({
  args: {
    subBrandId: v.id("subBrands"),
    clientBrandId: v.id("clientBrands"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const subBrand = await ctx.db.get(args.subBrandId);
    if (!subBrand) return;
    if (subBrand.clientBrandId !== args.clientBrandId) return;

    await ctx.db.patch(subBrand._id, {
      trelloLabelSyncStatus: "error",
      trelloLabelSyncError: args.error,
      trelloLabelSyncStartedAt: undefined,
    });
  },
});

export const markTrelloCardSyncing = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    clientBrandId: v.id("clientBrands"),
    trelloBoardId: v.string(),
    trelloListId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("trelloCards")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        trelloBoardId: args.trelloBoardId,
        trelloListId: args.trelloListId,
        syncStatus: "syncing",
        syncError: undefined,
      });
      return existing._id;
    }

    return await ctx.db.insert("trelloCards", {
      taskId: args.taskId,
      projectId: args.projectId,
      clientBrandId: args.clientBrandId,
      trelloBoardId: args.trelloBoardId,
      trelloListId: args.trelloListId,
      syncStatus: "syncing",
      createdAt: now,
    });
  },
});

export const markTrelloCardSynced = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    trelloListId: v.string(),
    trelloCardId: v.string(),
    trelloCardUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("trelloCards")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        trelloListId: args.trelloListId,
        trelloCardId: args.trelloCardId,
        trelloCardUrl: args.trelloCardUrl,
        syncStatus: "synced",
        syncError: undefined,
        syncedAt: now,
      });
    }

    await ctx.db.patch(args.taskId, {
      trelloCardId: args.trelloCardId,
      trelloCardUrl: args.trelloCardUrl,
      trelloSyncStatus: "synced",
      trelloSyncError: undefined,
      trelloSyncedAt: now,
    });

    await ctx.db.patch(args.projectId, {
      trelloCardId: args.trelloCardId,
      trelloCardUrl: args.trelloCardUrl,
      trelloSyncStatus: "synced",
      trelloSyncError: undefined,
      trelloSyncedAt: now,
    });
  },
});

export const markTrelloCardError = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.optional(v.id("projects")),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("trelloCards")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        syncStatus: "error",
        syncError: args.error,
      });
    }

    await ctx.db.patch(args.taskId, {
      trelloSyncStatus: "error",
      trelloSyncError: args.error,
    });

    if (args.projectId) {
      await ctx.db.patch(args.projectId, {
        trelloSyncStatus: "error",
        trelloSyncError: args.error,
      });
    }
  },
});

async function ensureTrelloLabelForSubBrand(ctx: any, args: {
  subBrandId: any;
  clientBrandId: any;
  boardId: string;
}) {
  for (let attempt = 0; attempt <= LABEL_SYNC_RETRY_DELAYS_MS.length; attempt += 1) {
    const claim = await ctx.runMutation(internalTrello.claimSubBrandLabelSync, {
      subBrandId: args.subBrandId,
      clientBrandId: args.clientBrandId,
    });

    if (claim.status === "synced") {
      console.log(
        `[TrelloSync] Usando label Trello existente para marca ${args.subBrandId}: ${claim.labelId}`
      );
      return claim.labelId;
    }

    if (claim.status === "locked") {
      const delay = LABEL_SYNC_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        throw new Error(
          "La etiqueta Trello de esta marca todavía se está sincronizando. Intenta nuevamente en unos segundos.",
        );
      }
      console.log(
        `[TrelloSync] Label Trello para marca ${args.subBrandId} en sincronización; reintento en ${delay}ms`
      );
      await sleep(delay);
      continue;
    }

    if (claim.status === "error") {
      throw new Error(claim.error);
    }

    try {
      const context = await ctx.runQuery(internalTrello.getSubBrandLabelContext, {
        subBrandId: args.subBrandId,
        clientBrandId: args.clientBrandId,
      });
      if (!context.ok) throw new Error(context.error);

      const subBrand = context.subBrand;
      const siblingIndex = Math.max(
        0,
        context.siblings.findIndex(
          (sibling: any) => String(sibling._id) === String(args.subBrandId),
        ),
      );
      const color = TRELLO_LABEL_COLORS[siblingIndex % TRELLO_LABEL_COLORS.length];
      const desiredName = subBrand.name.trim();
      const desiredNameNormalized = normalizeTrelloLabelName(desiredName);

      console.log(
        `[TrelloSync] Asegurando label Trello "${desiredName}" para marca ${args.subBrandId}`
      );

      const labels = await trelloProvider.getBoardLabels(args.boardId);
      let label = labels.find(
        (candidate) => normalizeTrelloLabelName(candidate.name || "") === desiredNameNormalized,
      );

      if (label) {
        console.log(
          `[TrelloSync] Label Trello encontrada por nombre "${desiredName}": ${label.id}`
        );
      } else {
        label = await trelloProvider.createBoardLabel({
          boardId: args.boardId,
          name: desiredName,
          color,
        });
        console.log(
          `[TrelloSync] Label Trello creada "${desiredName}" (${color}): ${label.id}`
        );
      }

      await ctx.runMutation(internalTrello.markSubBrandLabelSynced, {
        subBrandId: args.subBrandId,
        clientBrandId: args.clientBrandId,
        trelloLabelId: label.id,
        trelloLabelName: label.name || desiredName,
        trelloLabelColor: label.color || color,
      });

      return label.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internalTrello.markSubBrandLabelError, {
        subBrandId: args.subBrandId,
        clientBrandId: args.clientBrandId,
        error: message,
      });
      throw error;
    }
  }

  throw new Error("No se pudo sincronizar la etiqueta Trello de la marca.");
}

async function syncTaskAttachmentsToTrello(ctx: any, args: {
  taskId: any;
  cardId: string;
}) {
  const attachments = await ctx.runQuery(
    internal.data.tasks.getTaskAttachmentsForTrello,
    { taskId: args.taskId },
  );

  if (attachments.length === 0) {
    await ctx.runMutation(internal.data.tasks.updateTaskTrelloAttachmentSummary, {
      taskId: args.taskId,
      status: "synced",
    });
    return { total: 0, synced: 0, failed: 0 };
  }

  console.log(
    `[TrelloSync][Attachments] Subiendo ${attachments.length} archivo(s) a card ${args.cardId}`
  );

  let synced = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const attachment of attachments) {
    if (attachment.trelloAttachmentId) {
      synced += 1;
      continue;
    }

    try {
      const blob = await ctx.storage.get(attachment.storageId as any);
      if (!blob) {
        throw new Error(`Blob no encontrado para storageId ${attachment.storageId}`);
      }

      const trelloAttachment = await trelloProvider.addCardAttachment({
        cardId: args.cardId,
        name: attachment.filename,
        file: blob,
      });

      await ctx.runMutation(internal.data.tasks.updateAttachmentTrelloSync, {
        attachmentId: attachment._id,
        trelloAttachmentId: trelloAttachment.id,
        trelloAttachmentUrl: trelloAttachment.url,
      });

      synced += 1;
      console.log(
        `[TrelloSync][Attachments] ✅ ${attachment.filename} → Trello attachment ${trelloAttachment.id}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;
      errors.push(`${attachment.filename}: ${message}`);
      console.error(
        `[TrelloSync][Attachments] ⚠️ Error subiendo ${attachment.filename}: ${message}`
      );

      await ctx.runMutation(internal.data.tasks.updateAttachmentTrelloError, {
        attachmentId: attachment._id,
        error: message,
      });
    }
  }

  const status =
    failed === 0 ? "synced" : synced > 0 ? "partial" : "error";
  await ctx.runMutation(internal.data.tasks.updateTaskTrelloAttachmentSummary, {
    taskId: args.taskId,
    status,
    error: errors.length > 0 ? errors.join(" | ") : undefined,
  });

  console.log(
    `[TrelloSync][Attachments] Resultado task ${args.taskId}: ${synced}/${attachments.length} subidos, ${failed} error(es)`
  );

  return { total: attachments.length, synced, failed };
}

export const scheduleCreateCardForExternalTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    requestType: v.string(),
    deliverablesCount: v.number(),
  },
  handler: async (ctx, args) => {
    console.log(
      `[TrelloSync] Programando creación de card para task ${args.taskId} (tipo: ${args.requestType}, entregables: ${args.deliverablesCount})`
    );
    await ctx.scheduler.runAfter(0, internalTrello.createCardForExternalTask, args);
  },
});

export const createCardForExternalTask: any = internalAction({
  args: {
    taskId: v.id("tasks"),
    requestType: v.string(),
    deliverablesCount: v.number(),
  },
  handler: async (ctx, args) => {
    console.log(`[TrelloSync] Iniciando creación de card para task ${args.taskId}`);
    const data = await ctx.runQuery(internalTrello.getTaskProjectForTrello, {
      taskId: args.taskId,
    });

    if (!data.ok) {
      console.warn(`[TrelloSync] No se puede crear card para task ${args.taskId}: ${data.error}`);
      await ctx.runMutation(internalTrello.markTrelloCardError, {
        taskId: args.taskId,
        error: data.error,
      });
      return { success: false, error: data.error };
    }

    if (data.existingCard?.trelloCardId && data.existingCard.syncStatus === "synced") {
      console.log(
        `[TrelloSync] Task ${args.taskId} ya tiene card sincronizada: ${data.existingCard.trelloCardId}`
      );
      return {
        success: true,
        cardId: data.existingCard.trelloCardId,
        url: data.existingCard.trelloCardUrl,
      };
    }

    await ctx.runMutation(internalTrello.markTrelloCardSyncing, {
      taskId: data.task._id,
      projectId: data.project._id,
      clientBrandId: data.brand._id,
      trelloBoardId: data.boardId,
      trelloListId: data.listId,
    });

    try {
      console.log(
        `[TrelloSync] Creando card en board ${data.boardId}, list ${data.listId}, brand "${data.brand.name}"`
      );
      const idLabels: string[] = [];
      if (data.task.subBrandId) {
        const labelId = await ensureTrelloLabelForSubBrand(ctx, {
          subBrandId: data.task.subBrandId,
          clientBrandId: data.brand._id,
          boardId: data.boardId,
        });
        idLabels.push(labelId);
      }

      const card = await trelloProvider.createCard({
        idList: data.listId,
        name: data.task.title,
        desc: buildTrelloDescription({
          task: data.task,
          project: data.project,
          requestType: args.requestType,
          deliverablesCount: args.deliverablesCount,
        }),
        due: data.task.deadline,
        idLabels: idLabels.length > 0 ? idLabels : undefined,
      });

      const fieldsByKey = new Map(
        data.customFields.map((field: any) => [field.fieldKey, field]),
      );

      const customValues = [
        { key: "brand", value: data.brand.name },
        { key: "requestType", value: args.requestType },
        { key: "priority", value: PRIORITY_LABELS[data.task.priority ?? 1] ?? "Media" },
        { key: "deliverablesCount", value: args.deliverablesCount },
      ];

      for (const customValue of customValues) {
        const field = fieldsByKey.get(customValue.key) as any;
        if (!field) continue;
        await trelloProvider.setCustomFieldValue({
          cardId: card.id,
          customFieldId: field.trelloCustomFieldId,
          type: field.type,
          value: customValue.value,
        });
      }

      await syncTaskAttachmentsToTrello(ctx, {
        taskId: data.task._id,
        cardId: card.id,
      });

      await ctx.runMutation(internalTrello.markTrelloCardSynced, {
        taskId: data.task._id,
        projectId: data.project._id,
        trelloListId: data.listId,
        trelloCardId: card.id,
        trelloCardUrl: card.url || card.shortUrl || "",
      });

      console.log(`[TrelloSync] Card creada para task ${args.taskId}: ${card.id}`);
      return { success: true, cardId: card.id, url: card.url || card.shortUrl };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[TrelloSync] Error creando card para task ${args.taskId}: ${message}`);
      await ctx.runMutation(internalTrello.markTrelloCardError, {
        taskId: data.task._id,
        projectId: data.project._id,
        error: message,
      });
      return { success: false, error: message };
    }
  },
});

export const syncTrelloBoardConfigForBrand: any = action({
  args: {
    clientBrandId: v.id("clientBrands"),
  },
  handler: async (ctx, args) => {
    const brand = await ctx.runQuery(internal.data.clientBrands.getById, {
      clientBrandId: args.clientBrandId,
    });

    if (!brand) {
      throw new Error("Marca no encontrada.");
    }

    if (!brand.trelloBoardId) {
      throw new Error(`La marca "${brand.name}" no tiene trelloBoardId configurado.`);
    }

    const lists = await trelloProvider.getBoardLists(brand.trelloBoardId);
    const listsByName = new Map(lists.map((list) => [list.name.trim(), list]));
    const syncedLists = [];

    for (const status of TASK_STATUS_OPTIONS) {
      let list = listsByName.get(status.name);
      if (!list) {
        list = await trelloProvider.createList(brand.trelloBoardId, status.name);
      }

      await ctx.runMutation(internalTrello.upsertBoardListMapping, {
        clientBrandId: brand._id,
        trelloBoardId: brand.trelloBoardId,
        status: status.value,
        name: status.name,
        trelloListId: list.id,
      });

      syncedLists.push({ status: status.value, name: status.name, trelloListId: list.id });
    }

    const remoteFields = await trelloProvider.getBoardCustomFields(brand.trelloBoardId);
    const fieldsByName = new Map(
      remoteFields.map((field) => [(field.display?.name || field.name || "").trim(), field]),
    );
    const syncedFields = [];

    for (const fieldConfig of CUSTOM_FIELDS) {
      let field = fieldsByName.get(fieldConfig.name);
      if (!field) {
        field = await trelloProvider.createCustomField({
          boardId: brand.trelloBoardId,
          name: fieldConfig.name,
          type: fieldConfig.type,
        });
      }

      await ctx.runMutation(internalTrello.upsertCustomFieldMapping, {
        clientBrandId: brand._id,
        trelloBoardId: brand.trelloBoardId,
        fieldKey: fieldConfig.key,
        name: fieldConfig.name,
        type: fieldConfig.type,
        trelloCustomFieldId: field.id,
      });

      syncedFields.push({
        fieldKey: fieldConfig.key,
        name: fieldConfig.name,
        trelloCustomFieldId: field.id,
      });
    }

    return {
      success: true,
      brand: brand.name,
      trelloBoardId: brand.trelloBoardId,
      lists: syncedLists,
      customFields: syncedFields,
    };
  },
});
