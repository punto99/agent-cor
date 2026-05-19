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
