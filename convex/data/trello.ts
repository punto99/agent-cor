import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { trelloProvider } from "../integrations/trelloProvider";
import { TASK_STATUS_OPTIONS, getTaskStatusName } from "../lib/taskStatuses";

const CUSTOM_FIELDS = [
  { key: "requestType", name: "Tipo de requerimiento", type: "text" as const },
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
const CONVEX_TRELLO_CLIENT_IDENTIFIER = "agent-core-convex-trello-sync";
const BUSINESS_TIME_ZONE = "America/Guayaquil";

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

function jsonValue(value: unknown) {
  return value === undefined ? undefined : JSON.stringify(value);
}

function formatDateInBusinessTimeZone(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function formatDeadlineForTrelloDue(value: string | undefined) {
  if (!value) return undefined;

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;

  const [, year, month, day] = match;
  // Trello stores due dates as instants. Noon Ecuador avoids UTC conversion
  // showing the previous calendar day in Trello.
  return `${year}-${month}-${day}T17:00:00.000Z`;
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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInlineMarkdownWithoutLinks(value: string) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/_([^_\n]+)_/g, "<em>$1</em>");
}

function formatInlineMarkdown(value: string) {
  const links: string[] = [];
  const textWithPlaceholders = value.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
    (_match, label: string, href: string) => {
      const index = links.length;
      links.push(
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${formatInlineMarkdownWithoutLinks(label)}</a>`,
      );
      return `\u0000LINK${index}\u0000`;
    },
  );

  return formatInlineMarkdownWithoutLinks(textWithPlaceholders).replace(
    /\u0000LINK(\d+)\u0000/g,
    (_match, index: string) => links[Number(index)] ?? "",
  );
}

function trelloMarkdownToConvexHtml(value: string | undefined) {
  if (!value) return "";

  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${paragraph.map(formatInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType || listItems.length === 0) return;
    blocks.push(`<${listType}>${listItems.join("")}</${listType}>`);
    listItems = [];
    listType = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(`<p><strong>${formatInlineMarkdown(heading[1])}</strong></p>`);
      continue;
    }

    const unorderedItem = line.match(/^[-*]\s+(.+)$/);
    if (unorderedItem) {
      flushParagraph();
      if (listType !== "ul") {
        flushList();
        listType = "ul";
      }
      listItems.push(`<li>${formatInlineMarkdown(unorderedItem[1])}</li>`);
      continue;
    }

    const orderedItem = line.match(/^\d+[.)]\s+(.+)$/);
    if (orderedItem) {
      flushParagraph();
      if (listType !== "ol") {
        flushList();
        listType = "ol";
      }
      listItems.push(`<li>${formatInlineMarkdown(orderedItem[1])}</li>`);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();

  return blocks.join("\n").trim();
}

function buildTrelloDescription(args: { task: any }) {
  return htmlToTrelloMarkdown(args.task.description);
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

export const getTaskStatusTrelloSyncContext = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") {
      return { ok: false as const, skip: true as const, error: "Task no encontrada." };
    }

    if (task.source !== "external" && !task.trelloCardId) {
      return {
        ok: false as const,
        skip: true as const,
        taskId: task._id,
        projectId: task.projectId,
        error: "La task no tiene integración Trello.",
      };
    }

    const clientBrandId = task.clientBrandId;
    if (!clientBrandId) {
      return {
        ok: false as const,
        skip: false as const,
        taskId: task._id,
        projectId: task.projectId,
        error: "La task no tiene categoría asociada para mover card en Trello.",
      };
    }

    const trelloCard = await ctx.db
      .query("trelloCards")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .first();

    if (!trelloCard?.trelloCardId) {
      return {
        ok: false as const,
        skip: true as const,
        taskId: task._id,
        projectId: task.projectId,
        error: "La task no tiene card Trello creada.",
      };
    }

    const listMapping = await ctx.db
      .query("trelloBoardLists")
      .withIndex("by_brand_and_status", (q) =>
        q.eq("clientBrandId", clientBrandId).eq("status", task.status),
      )
      .unique();

    if (!listMapping) {
      return {
        ok: false as const,
        skip: false as const,
        taskId: task._id,
        projectId: task.projectId,
        error: `No hay lista Trello configurada para el status "${getTaskStatusName(task.status)}".`,
      };
    }

    if (trelloCard.trelloBoardId !== listMapping.trelloBoardId) {
      return {
        ok: false as const,
        skip: false as const,
        taskId: task._id,
        projectId: task.projectId,
        error: "La card Trello pertenece a un board distinto al mapping del status.",
      };
    }

    return {
      ok: true as const,
      taskId: task._id,
      projectId: task.projectId,
      trelloCardId: trelloCard.trelloCardId,
      currentTrelloListId: trelloCard.trelloListId,
      targetTrelloListId: listMapping.trelloListId,
      status: task.status,
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

export const upsertWebhookMapping = internalMutation({
  args: {
    clientBrandId: v.id("clientBrands"),
    trelloBoardId: v.string(),
    trelloWebhookId: v.string(),
    callbackURL: v.string(),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("trelloWebhooks")
      .withIndex("by_board", (q) => q.eq("trelloBoardId", args.trelloBoardId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        clientBrandId: args.clientBrandId,
        trelloWebhookId: args.trelloWebhookId,
        callbackURL: args.callbackURL,
        active: args.active,
        updatedAt: now,
        lastError: undefined,
      });
      return existing._id;
    }

    return await ctx.db.insert("trelloWebhooks", {
      clientBrandId: args.clientBrandId,
      trelloBoardId: args.trelloBoardId,
      trelloWebhookId: args.trelloWebhookId,
      callbackURL: args.callbackURL,
      active: args.active,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const markWebhookError = internalMutation({
  args: {
    clientBrandId: v.id("clientBrands"),
    trelloBoardId: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("trelloWebhooks")
      .withIndex("by_board", (q) => q.eq("trelloBoardId", args.trelloBoardId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        active: false,
        updatedAt: Date.now(),
        lastError: args.error,
      });
      return existing._id;
    }

    return await ctx.db.insert("trelloWebhooks", {
      clientBrandId: args.clientBrandId,
      trelloBoardId: args.trelloBoardId,
      trelloWebhookId: "",
      callbackURL: "",
      active: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastError: args.error,
    });
  },
});

export const recordWebhookEvent = internalMutation({
  args: {
    trelloActionId: v.string(),
    trelloWebhookId: v.optional(v.string()),
    trelloBoardId: v.optional(v.string()),
    trelloCardId: v.optional(v.string()),
    actionType: v.string(),
    sourceIdentifier: v.optional(v.string()),
    payloadJson: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("trelloWebhookEvents")
      .withIndex("by_action", (q) => q.eq("trelloActionId", args.trelloActionId))
      .unique();

    if (existing) {
      return { eventId: existing._id, duplicate: true };
    }

    const now = Date.now();
    const eventId = await ctx.db.insert("trelloWebhookEvents", {
      trelloActionId: args.trelloActionId,
      trelloWebhookId: args.trelloWebhookId,
      trelloBoardId: args.trelloBoardId,
      trelloCardId: args.trelloCardId,
      actionType: args.actionType,
      sourceIdentifier: args.sourceIdentifier,
      payloadJson: args.payloadJson,
      status: "received",
      receivedAt: now,
    });

    if (args.trelloWebhookId) {
      const webhook = await ctx.db
        .query("trelloWebhooks")
        .withIndex("by_webhook", (q) =>
          q.eq("trelloWebhookId", args.trelloWebhookId!),
        )
        .first();
      if (webhook) {
        await ctx.db.patch(webhook._id, {
          lastEventAt: now,
          updatedAt: now,
        });
      }
    }

    await ctx.scheduler.runAfter(0, internalTrello.processWebhookEvent, {
      eventId,
    });

    return { eventId, duplicate: false };
  },
});

export const getWebhookEventById = internalQuery({
  args: {
    eventId: v.id("trelloWebhookEvents"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.eventId);
  },
});

export const getTrelloCardContextByCardId = internalQuery({
  args: {
    trelloCardId: v.string(),
  },
  handler: async (ctx, args) => {
    const card = await ctx.db
      .query("trelloCards")
      .withIndex("by_card", (q) => q.eq("trelloCardId", args.trelloCardId))
      .first();
    if (!card) return null;

    const task = await ctx.db.get(card.taskId);
    const project = await ctx.db.get(card.projectId);
    return { card, task, project };
  },
});

export const getStatusByTrelloListId = internalQuery({
  args: {
    trelloListId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("trelloBoardLists")
      .withIndex("by_list", (q) => q.eq("trelloListId", args.trelloListId))
      .first();
  },
});

export const markWebhookEventStatus = internalMutation({
  args: {
    eventId: v.id("trelloWebhookEvents"),
    status: v.string(),
    reason: v.optional(v.string()),
    error: v.optional(v.string()),
    taskId: v.optional(v.id("tasks")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.eventId, {
      status: args.status,
      reason: args.reason,
      error: args.error,
      taskId: args.taskId,
      processedAt: Date.now(),
    });
  },
});

export const recordInboundChange = internalMutation({
  args: {
    eventId: v.id("trelloWebhookEvents"),
    taskId: v.optional(v.id("tasks")),
    projectId: v.optional(v.id("projects")),
    trelloCardId: v.optional(v.string()),
    actionType: v.string(),
    field: v.string(),
    oldValueJson: v.optional(v.string()),
    newValueJson: v.optional(v.string()),
    applied: v.boolean(),
    requiresReview: v.boolean(),
    reviewStatus: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("trelloInboundChanges", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const applySafeInboundCardUpdate = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.optional(v.id("projects")),
    updates: v.object({
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      deadline: v.optional(v.string()),
      status: v.optional(v.string()),
      trelloListId: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const taskPatch: Record<string, any> = {
      trelloInboundSyncStatus: "pending_review",
      trelloLastInboundAt: now,
      trelloInboundSyncError: undefined,
    };

    if (args.updates.title !== undefined) taskPatch.title = args.updates.title;
    if (args.updates.description !== undefined) {
      taskPatch.description = args.updates.description;
    }
    if (args.updates.deadline !== undefined) {
      taskPatch.deadline = args.updates.deadline;
    }
    if (args.updates.status !== undefined) taskPatch.status = args.updates.status;

    await ctx.db.patch(args.taskId, taskPatch);

    if (args.projectId) {
      const projectPatch: Record<string, any> = {};
      if (args.updates.title !== undefined) projectPatch.name = args.updates.title;
      if (args.updates.deadline !== undefined) {
        projectPatch.endDate = args.updates.deadline;
      }
      if (Object.keys(projectPatch).length > 0) {
        await ctx.db.patch(args.projectId, projectPatch);
      }
    }

    if (args.updates.trelloListId) {
      const trelloCard = await ctx.db
        .query("trelloCards")
        .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
        .first();
      if (trelloCard) {
        await ctx.db.patch(trelloCard._id, {
          trelloListId: args.updates.trelloListId,
        });
      }
    }
  },
});

export const markTaskInboundReviewNeeded = internalMutation({
  args: {
    taskId: v.id("tasks"),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId, {
      trelloInboundSyncStatus: "pending_review",
      trelloInboundSyncError: args.error,
      trelloLastInboundAt: Date.now(),
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

export const markTrelloCardListSynced = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.optional(v.id("projects")),
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
        trelloListId: args.trelloListId,
        syncStatus: "synced",
        syncError: undefined,
        syncedAt: now,
      });
    }

    await ctx.db.patch(args.taskId, {
      trelloSyncStatus: "synced",
      trelloSyncError: undefined,
      trelloSyncedAt: now,
    });

    if (args.projectId) {
      await ctx.db.patch(args.projectId, {
        trelloSyncStatus: "synced",
        trelloSyncError: undefined,
        trelloSyncedAt: now,
      });
    }
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
        }),
        due: formatDeadlineForTrelloDue(data.task.deadline),
        idLabels: idLabels.length > 0 ? idLabels : undefined,
      });

      const fieldsByKey = new Map(
        data.customFields.map((field: any) => [field.fieldKey, field]),
      );

      const customValues = [
        { key: "requestType", value: args.requestType },
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

export const syncTaskStatusToTrello: any = internalAction({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(
      internalTrello.getTaskStatusTrelloSyncContext,
      { taskId: args.taskId },
    );

    if (!context.ok) {
      console.log(
        `[TrelloSync] No se mueve card para task ${args.taskId}: ${context.error}`,
      );
      if (!context.skip && context.taskId) {
        await ctx.runMutation(internalTrello.markTrelloCardError, {
          taskId: context.taskId,
          projectId: context.projectId,
          error: context.error,
        });
      }
      return { success: false, skipped: context.skip, error: context.error };
    }

    if (context.currentTrelloListId === context.targetTrelloListId) {
      return {
        success: true,
        skipped: true,
        reason: "La card Trello ya está en la lista correcta.",
      };
    }

    try {
      console.log(
        `[TrelloSync] Moviendo card ${context.trelloCardId} a lista ${context.targetTrelloListId} por status "${context.status}"`,
      );
      await trelloProvider.updateCard({
        cardId: context.trelloCardId,
        idList: context.targetTrelloListId,
      });

      await ctx.runMutation(internalTrello.markTrelloCardListSynced, {
        taskId: context.taskId,
        projectId: context.projectId,
        trelloListId: context.targetTrelloListId,
      });

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[TrelloSync] Error moviendo card Trello para task ${args.taskId}: ${message}`,
      );
      await ctx.runMutation(internalTrello.markTrelloCardError, {
        taskId: context.taskId,
        projectId: context.projectId,
        error: message,
      });
      return { success: false, error: message };
    }
  },
});

export const processWebhookEvent: any = internalAction({
  args: {
    eventId: v.id("trelloWebhookEvents"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.runQuery(internalTrello.getWebhookEventById, {
      eventId: args.eventId,
    });
    if (!event) return { success: false, error: "Evento no encontrado." };

    if (event.status !== "received") {
      return { success: true, ignored: true, reason: "Evento ya procesado." };
    }

    let payload: any;
    try {
      payload = JSON.parse(event.payloadJson);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internalTrello.markWebhookEventStatus, {
        eventId: args.eventId,
        status: "failed",
        error: `Payload inválido: ${message}`,
      });
      return { success: false, error: message };
    }

    if (event.sourceIdentifier === CONVEX_TRELLO_CLIENT_IDENTIFIER) {
      await ctx.runMutation(internalTrello.markWebhookEventStatus, {
        eventId: args.eventId,
        status: "ignored",
        reason: "Evento originado por Convex.",
      });
      return { success: true, ignored: true };
    }

    const cardId =
      event.trelloCardId ||
      payload?.action?.data?.card?.id ||
      payload?.action?.data?.card?.idShort;
    if (!cardId) {
      await ctx.runMutation(internalTrello.markWebhookEventStatus, {
        eventId: args.eventId,
        status: "ignored",
        reason: "Evento sin card asociada.",
      });
      return { success: true, ignored: true };
    }

    const context = await ctx.runQuery(internalTrello.getTrelloCardContextByCardId, {
      trelloCardId: cardId,
    });
    if (!context?.task || !context.project) {
      await ctx.runMutation(internalTrello.markWebhookEventStatus, {
        eventId: args.eventId,
        status: "ignored",
        reason: "Card Trello sin mapping local.",
      });
      return { success: true, ignored: true };
    }

    const action = payload.action;
    const data = action?.data ?? {};
    const oldValues = data.old ?? {};
    const card = data.card ?? {};
    const safeUpdates: {
      title?: string;
      description?: string;
      deadline?: string;
      status?: string;
      trelloListId?: string;
    } = {};
    let appliedCount = 0;
    let reviewCount = 0;

    try {
      if (event.actionType === "updateCard") {
        if (Object.prototype.hasOwnProperty.call(oldValues, "name")) {
          safeUpdates.title = String(card.name ?? "");
          await ctx.runMutation(internalTrello.recordInboundChange, {
            eventId: args.eventId,
            taskId: context.task._id,
            projectId: context.project._id,
            trelloCardId: cardId,
            actionType: event.actionType,
            field: "title",
            oldValueJson: jsonValue(oldValues.name),
            newValueJson: jsonValue(card.name),
            applied: true,
            requiresReview: false,
            note: "Título actualizado desde Trello en Convex. No se publicó en COR.",
          });
          appliedCount += 1;
        }

        if (Object.prototype.hasOwnProperty.call(oldValues, "due")) {
          if (typeof card.due === "string" && card.due.length > 0) {
            const businessDeadline = formatDateInBusinessTimeZone(card.due);
            if (!businessDeadline) {
              await ctx.runMutation(internalTrello.recordInboundChange, {
                eventId: args.eventId,
                taskId: context.task._id,
                projectId: context.project._id,
                trelloCardId: cardId,
                actionType: event.actionType,
                field: "deadline",
                oldValueJson: jsonValue(oldValues.due),
                newValueJson: jsonValue(card.due),
                applied: false,
                requiresReview: true,
                reviewStatus: "pending",
                note: "Trello envió una fecha inválida; requiere revisión interna.",
              });
              reviewCount += 1;
            } else {
              safeUpdates.deadline = businessDeadline;
              await ctx.runMutation(internalTrello.recordInboundChange, {
                eventId: args.eventId,
                taskId: context.task._id,
                projectId: context.project._id,
                trelloCardId: cardId,
                actionType: event.actionType,
                field: "deadline",
                oldValueJson: jsonValue(oldValues.due),
                newValueJson: jsonValue({
                  trelloDue: card.due,
                  businessDate: businessDeadline,
                  timeZone: BUSINESS_TIME_ZONE,
                }),
                applied: true,
                requiresReview: false,
                note: "Deadline actualizado desde Trello como fecha calendario de Ecuador. No se publicó en COR.",
              });
              appliedCount += 1;
            }
          } else {
            await ctx.runMutation(internalTrello.recordInboundChange, {
              eventId: args.eventId,
              taskId: context.task._id,
              projectId: context.project._id,
              trelloCardId: cardId,
              actionType: event.actionType,
              field: "deadline",
              oldValueJson: jsonValue(oldValues.due),
              newValueJson: jsonValue(card.due),
              applied: false,
              requiresReview: true,
              reviewStatus: "pending",
              note: "Remover deadline desde Trello requiere revisión interna.",
            });
            reviewCount += 1;
          }
        }

        if (Object.prototype.hasOwnProperty.call(oldValues, "idList")) {
          const mapping = card.idList
            ? await ctx.runQuery(internalTrello.getStatusByTrelloListId, {
                trelloListId: card.idList,
              })
            : null;

          if (mapping?.status) {
            safeUpdates.status = mapping.status;
            safeUpdates.trelloListId = card.idList;
            await ctx.runMutation(internalTrello.recordInboundChange, {
              eventId: args.eventId,
              taskId: context.task._id,
              projectId: context.project._id,
              trelloCardId: cardId,
              actionType: event.actionType,
              field: "status",
              oldValueJson: jsonValue(oldValues.idList),
              newValueJson: jsonValue(card.idList),
              applied: true,
              requiresReview: false,
              note: "Status actualizado desde lista Trello en Convex. No se publicó en COR.",
            });
            appliedCount += 1;
          } else {
            await ctx.runMutation(internalTrello.recordInboundChange, {
              eventId: args.eventId,
              taskId: context.task._id,
              projectId: context.project._id,
              trelloCardId: cardId,
              actionType: event.actionType,
              field: "status",
              oldValueJson: jsonValue(oldValues.idList),
              newValueJson: jsonValue(card.idList),
              applied: false,
              requiresReview: true,
              reviewStatus: "pending",
              note: "La lista Trello no tiene mapping local de status.",
            });
            reviewCount += 1;
          }
        }

        if (Object.prototype.hasOwnProperty.call(oldValues, "desc")) {
          safeUpdates.description = trelloMarkdownToConvexHtml(String(card.desc ?? ""));
          await ctx.runMutation(internalTrello.recordInboundChange, {
            eventId: args.eventId,
            taskId: context.task._id,
            projectId: context.project._id,
            trelloCardId: cardId,
            actionType: event.actionType,
            field: "description",
            oldValueJson: jsonValue(oldValues.desc),
            newValueJson: jsonValue(card.desc),
            applied: true,
            requiresReview: false,
            note: "Descripción completa actualizada desde Trello en Convex como HTML. No se publicó en COR.",
          });
          appliedCount += 1;
        }

        if (Object.prototype.hasOwnProperty.call(oldValues, "closed")) {
          await ctx.runMutation(internalTrello.recordInboundChange, {
            eventId: args.eventId,
            taskId: context.task._id,
            projectId: context.project._id,
            trelloCardId: cardId,
            actionType: event.actionType,
            field: "closed",
            oldValueJson: jsonValue(oldValues.closed),
            newValueJson: jsonValue(card.closed),
            applied: false,
            requiresReview: true,
            reviewStatus: "pending",
            note: "Archivado/cierre en Trello requiere revisión.",
          });
          reviewCount += 1;
        }

        if (Object.keys(safeUpdates).length > 0) {
          await ctx.runMutation(internalTrello.applySafeInboundCardUpdate, {
            taskId: context.task._id,
            projectId: context.project._id,
            updates: safeUpdates,
          });
        }
      } else if (
        event.actionType === "addAttachmentToCard" ||
        event.actionType === "deleteAttachmentFromCard" ||
        event.actionType === "addLabelToCard" ||
        event.actionType === "removeLabelFromCard"
      ) {
        const fieldMap: Record<string, string> = {
          addAttachmentToCard: "attachment_added",
          deleteAttachmentFromCard: "attachment_removed",
          addLabelToCard: "label_added",
          removeLabelFromCard: "label_removed",
        };
        await ctx.runMutation(internalTrello.recordInboundChange, {
          eventId: args.eventId,
          taskId: context.task._id,
          projectId: context.project._id,
          trelloCardId: cardId,
          actionType: event.actionType,
          field: fieldMap[event.actionType] ?? event.actionType,
          oldValueJson: undefined,
          newValueJson: jsonValue(data),
          applied: false,
          requiresReview: true,
          reviewStatus: "pending",
          note: "Cambio recibido desde Trello; requiere revisión antes de modificar datos locales sensibles.",
        });
        reviewCount += 1;
      } else {
        await ctx.runMutation(internalTrello.markWebhookEventStatus, {
          eventId: args.eventId,
          status: "ignored",
          taskId: context.task._id,
          reason: `Tipo de evento no manejado: ${event.actionType}`,
        });
        return { success: true, ignored: true };
      }

      if (reviewCount > 0) {
        await ctx.runMutation(internalTrello.markTaskInboundReviewNeeded, {
          taskId: context.task._id,
          error: `${reviewCount} cambio(s) de Trello requieren revisión interna.`,
        });
      }

      await ctx.runMutation(internalTrello.markWebhookEventStatus, {
        eventId: args.eventId,
        status: reviewCount > 0 ? "needs_review" : "processed",
        taskId: context.task._id,
        reason: `${appliedCount} cambio(s) aplicado(s), ${reviewCount} pendiente(s) de revisión.`,
      });

      return { success: true, appliedCount, reviewCount };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internalTrello.markWebhookEventStatus, {
        eventId: args.eventId,
        status: "failed",
        taskId: context.task._id,
        error: message,
      });
      await ctx.runMutation(internalTrello.markTaskInboundReviewNeeded, {
        taskId: context.task._id,
        error: message,
      });
      return { success: false, error: message };
    }
  },
});

export const syncTrelloWebhookForBrand: any = action({
  args: {
    clientBrandId: v.id("clientBrands"),
  },
  handler: async (ctx, args) => {
    const callbackURL = process.env.TRELLO_WEBHOOK_CALLBACK_URL;
    if (!callbackURL) {
      throw new Error(
        "Falta TRELLO_WEBHOOK_CALLBACK_URL en Convex. Debe ser la URL pública exacta del endpoint /trello/webhook.",
      );
    }

    const brand = await ctx.runQuery(internal.data.clientBrands.getById, {
      clientBrandId: args.clientBrandId,
    });
    if (!brand) throw new Error("Categoría no encontrada.");
    if (!brand.trelloBoardId) {
      throw new Error(`La categoría "${brand.name}" no tiene trelloBoardId configurado.`);
    }

    try {
      const webhook = await trelloProvider.createWebhook({
        callbackURL,
        idModel: brand.trelloBoardId,
        description: `Agent Core inbound sync - ${brand.name}`,
      });

      await ctx.runMutation(internalTrello.upsertWebhookMapping, {
        clientBrandId: brand._id,
        trelloBoardId: brand.trelloBoardId,
        trelloWebhookId: webhook.id,
        callbackURL,
        active: webhook.active,
      });

      return {
        success: true,
        clientBrandId: brand._id,
        brand: brand.name,
        trelloBoardId: brand.trelloBoardId,
        trelloWebhookId: webhook.id,
        callbackURL,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internalTrello.markWebhookError, {
        clientBrandId: brand._id,
        trelloBoardId: brand.trelloBoardId,
        error: message,
      });
      throw error;
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
