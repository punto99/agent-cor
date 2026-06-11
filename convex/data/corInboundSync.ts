// convex/data/corInboundSync.ts
// =====================================================
// Sync inbound: COR → Convex
//
// Permite al usuario traer manualmente los últimos datos de COR
// para actualizar una task y su proyecto en Convex.
// COR es la fuente de verdad — si algo cambió allá, se refleja acá.
//
// Flujo:
//   1. Usuario clickea RefreshCcw en el dialog
//   2. startPullFromCOR (mutation) verifica auth/permisos y schedula la action
//   3. pullFromCORAction (action) llama a COR API y ejecuta mutations de update
//   4. applyInboundTaskUpdate / applyInboundProjectUpdate aplican cambios atómicamente
// =====================================================

import { v } from "convex/values";
import {
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { internal, components } from "../_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { storeFile } from "@convex-dev/agent";
import { getProjectManagementProvider } from "../integrations/registry";
import { CORNotFoundError } from "../integrations/corProvider";
import { hashText } from "../lib/briefFormat";
import { applyProjectDeliverablesDelta } from "../lib/deliverableAnalytics";

const SCHEDULED_SYNC_STATE_KEY = "scheduled-cor-inbound-sync";
const SCHEDULED_EXPIRED_SYNC_STATE_KEY = "scheduled-expired-cor-inbound-sync";
const SCHEDULED_SYNC_LEASE_MS = 8 * 60 * 1000;
const SCHEDULED_TASKS_PER_RUN = 20;
const SCHEDULED_PROJECTS_PER_RUN = 10;
const SCHEDULED_WORKER_STAGGER_MS = 750;
const SCHEDULED_ATTACHMENT_DELAY_MS = 30_000;
const MAX_COR_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_COR_ATTACHMENTS_PER_TASK = 5;

const SCHEDULED_TASK_BUCKETS = [
  { key: "active-dated", convexStatus: "active", includeUndated: false },
  { key: "legacy-dated", convexStatus: undefined, includeUndated: false },
  { key: "active-undated", convexStatus: "active", includeUndated: true },
  { key: "legacy-undated", convexStatus: undefined, includeUndated: true },
] as const;

const SCHEDULED_PROJECT_BUCKETS = [
  { key: "active-dated", convexStatus: "active", includeUndated: false },
  { key: "legacy-dated", convexStatus: undefined, includeUndated: false },
  { key: "active-undated", convexStatus: "active", includeUndated: true },
  { key: "legacy-undated", convexStatus: undefined, includeUndated: true },
] as const;

type ScheduledDateMode = "current" | "expired";

function parseCORTaskId(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const parsed = parseInt(String(raw).trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getEcuadorDateKey(now = Date.now()): string {
  const utcMinusFive = new Date(now - 5 * 60 * 60 * 1000);
  return utcMinusFive.toISOString().slice(0, 10);
}

async function isExternalUser(ctx: any, userId: any) {
  const approvedExternalUser = await ctx.db
    .query("approvedExternalUsers")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .unique();
  return Boolean(approvedExternalUser);
}

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

async function resolveInboundProjectTaxonomy(
  ctx: any,
  args: {
    corClientId?: number;
    corBrandId: number;
    corProductId?: number;
  },
) {
  const brand = await ctx.db
    .query("clientBrands")
    .withIndex("by_corBrandId", (q: any) => q.eq("corBrandId", args.corBrandId))
    .unique();

  const validBrand =
    brand &&
    (args.corClientId === undefined || brand.corClientId === args.corClientId)
      ? brand
      : null;

  let subBrand = null;
  if (validBrand && args.corProductId !== undefined) {
    const candidate = await ctx.db
      .query("subBrands")
      .withIndex("by_corBrandId_and_corProductId", (q: any) =>
        q
          .eq("corBrandId", args.corBrandId)
          .eq("corProductId", args.corProductId!),
      )
      .unique();

    if (candidate && candidate.clientBrandId === validBrand._id) {
      subBrand = candidate;
    }
  }

  return {
    brandId: args.corBrandId,
    productId: args.corProductId,
    clientBrandId: validBrand?._id,
    brandName: validBrand?.name,
    subBrandId: subBrand?._id,
    subBrandName: subBrand?.name,
  };
}

async function syncTaskAttachmentsFromCOR(
  ctx: any,
  taskId: Id<"tasks">,
  corTaskId: number,
): Promise<void> {
  const provider = getProjectManagementProvider();
  const allRemoteAttachments = await provider.getTaskAttachments(corTaskId);
  const remoteAttachments = allRemoteAttachments.slice(
    0,
    MAX_COR_ATTACHMENTS_PER_TASK,
  );
  if (allRemoteAttachments.length > MAX_COR_ATTACHMENTS_PER_TASK) {
    console.log(
      `[InboundSync][Attachments] Task ${taskId} tiene ${allRemoteAttachments.length} attachments en COR; se sincronizan solo los primeros ${MAX_COR_ATTACHMENTS_PER_TASK}`,
    );
  }
  const localAttachments = await ctx.runQuery(
    internal.data.tasks.getTaskAttachments,
    {
      taskId,
    },
  );

  const remoteById = new Map<number, (typeof remoteAttachments)[number]>();
  for (const remote of remoteAttachments) {
    if (Number.isFinite(remote.id)) remoteById.set(remote.id, remote);
  }

  const localByCorId = new Map<number, (typeof localAttachments)[number]>();
  for (const local of localAttachments) {
    if (typeof local.corAttachmentId === "number") {
      localByCorId.set(local.corAttachmentId, local);
    }
  }

  let deletedCount = 0;
  for (const [corAttachmentId, localAttachment] of localByCorId.entries()) {
    if (!remoteById.has(corAttachmentId)) {
      await ctx.runMutation(internal.data.tasks.deleteTaskAttachment, {
        attachmentId: localAttachment._id,
      });
      deletedCount += 1;
    }
  }

  let addedCount = 0;
  for (const [corAttachmentId, remoteAttachment] of remoteById.entries()) {
    if (localByCorId.has(corAttachmentId)) continue;
    if (!remoteAttachment.url) {
      console.warn(
        `[InboundSync][Attachments] ⚠️ Attachment ${corAttachmentId} sin URL en COR, se omite`,
      );
      continue;
    }
    if (
      remoteAttachment.size !== undefined &&
      remoteAttachment.size > MAX_COR_ATTACHMENT_BYTES
    ) {
      console.warn(
        `[InboundSync][Attachments] ⚠️ Attachment ${corAttachmentId} pesa ${remoteAttachment.size} bytes y supera el límite seguro de sync, se omite`,
      );
      continue;
    }

    try {
      const response = await fetch(remoteAttachment.url);
      if (!response.ok) {
        console.warn(
          `[InboundSync][Attachments] ⚠️ No se pudo descargar attachment ${corAttachmentId} (${response.status})`,
        );
        continue;
      }
      const contentLength = response.headers.get("content-length");
      const contentBytes = contentLength ? Number(contentLength) : null;
      if (
        contentBytes !== null &&
        Number.isFinite(contentBytes) &&
        contentBytes > MAX_COR_ATTACHMENT_BYTES
      ) {
        console.warn(
          `[InboundSync][Attachments] ⚠️ Attachment ${corAttachmentId} pesa ${contentBytes} bytes y supera el límite seguro de sync, se omite`,
        );
        continue;
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_COR_ATTACHMENT_BYTES) {
        console.warn(
          `[InboundSync][Attachments] ⚠️ Attachment ${corAttachmentId} pesa ${buffer.byteLength} bytes y supera el límite seguro de sync, se omite`,
        );
        continue;
      }
      const mimeType =
        remoteAttachment.mimeType ||
        response.headers.get("content-type") ||
        "application/octet-stream";
      const filename = remoteAttachment.name || `attachment_${corAttachmentId}`;

      const { file } = await storeFile(
        ctx,
        components.agent,
        new Blob([buffer], { type: mimeType }),
        { filename },
      );

      const attachmentId = await ctx.runMutation(
        internal.data.tasks.createTaskAttachment,
        {
          taskId,
          fileId: file.fileId,
          storageId: String(file.storageId),
          filename,
          mimeType,
          size: remoteAttachment.size ?? buffer.byteLength,
        },
      );

      await ctx.runMutation(internal.data.tasks.updateAttachmentCORSync, {
        attachmentId,
        corAttachmentId,
        corUrl: remoteAttachment.url,
      });

      addedCount += 1;
    } catch (error) {
      console.warn(
        `[InboundSync][Attachments] ⚠️ Error sincronizando attachment ${corAttachmentId}:`,
        error,
      );
    }
  }

  if (addedCount > 0 || deletedCount > 0) {
    console.log(
      `[InboundSync][Attachments] ✅ Task ${taskId}: +${addedCount} / -${deletedCount}`,
    );
  }
}

// ==================== ENTRY POINT (pública) ====================

/**
 * Mutation pública: el usuario solicita actualizar una task desde COR.
 * Verifica auth + permisos + que la task esté publicada.
 * Schedula la action via scheduler para no bloquear la UI.
 */
export const startPullFromCOR = mutation({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    // 1. Auth
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    if (await isExternalUser(ctx, userId)) {
      throw new Error(
        "Los usuarios externos no pueden actualizar tasks desde COR.",
      );
    }

    // 2. Leer task
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task no encontrada");

    // 3. Solo permitir pull si está publicada y en estado estable
    if (!task.corTaskId) {
      throw new Error("La task no está publicada en el sistema externo.");
    }
    if (task.corSyncStatus === "syncing" || task.corSyncStatus === "retrying") {
      throw new Error(
        "La task se está sincronizando. Espera a que termine antes de actualizar.",
      );
    }

    // 4. Verificar permisos (clientUserAssignments)
    if (!(await hasTaskAccess(ctx, task, userId))) {
      throw new Error(
        `No tienes permisos para actualizar esta task desde COR.`,
      );
    }

    // 5. Programar la action (no bloquea UI)
    await ctx.scheduler.runAfter(
      0,
      internal.data.corInboundSync.pullFromCORAction,
      {
        taskId: args.taskId,
      },
    );

    return { success: true };
  },
});

// ==================== ACTION: llamada a COR ====================

/**
 * Action interna: consulta COR API y actualiza task + proyecto en Convex.
 * Máximo 2 llamadas HTTP: una para task, una para proyecto.
 */
export const pullFromCORAction = internalAction({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    console.log("\n========================================");
    console.log("[InboundSync] 🔄 PULL COR → CONVEX");
    console.log(`[InboundSync] Task Convex ID: ${args.taskId}`);
    console.log("========================================\n");

    try {
      // 1. Leer task de Convex para obtener IDs de COR
      const task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, {
        taskId: args.taskId as string,
      });

      if (!task) {
        console.error("[InboundSync] ❌ Task no encontrada en Convex");
        return;
      }

      if (!task.corTaskId) {
        console.error("[InboundSync] ❌ Task no tiene corTaskId");
        return;
      }

      const provider = getProjectManagementProvider();
      const corTaskId = parseCORTaskId(task.corTaskId);
      if (corTaskId === null) {
        console.error(
          `[InboundSync] ❌ corTaskId inválido para task ${args.taskId}: ${String(task.corTaskId)}`,
        );
        return;
      }

      // 2. Traer task de COR
      console.log(`[InboundSync] 📡 Consultando task COR ${task.corTaskId}...`);
      let corTask = null;
      try {
        corTask = await provider.getTask(corTaskId);
      } catch (error) {
        if (error instanceof CORNotFoundError) {
          await ctx.runMutation(
            internal.data.corInboundSync.setTaskNotFoundInCOR,
            {
              taskId: args.taskId,
              missing: true,
            },
          );
          console.warn(
            `[InboundSync] ⚠️ Task COR ${task.corTaskId} no encontrada para task ${args.taskId}`,
          );
          corTask = null;
        } else {
          throw error;
        }
      }

      if (!corTask) {
        console.warn(
          `[InboundSync] ⚠️ Task COR ${task.corTaskId} no encontrada (¿eliminada?)`,
        );
      } else {
        await ctx.runMutation(
          internal.data.corInboundSync.setTaskNotFoundInCOR,
          {
            taskId: args.taskId,
            missing: false,
          },
        );

        // Aplicar cambios de la task
        const taskUpdateResult = await ctx.runMutation(
          internal.data.corInboundSync.applyInboundTaskUpdate,
          {
            taskId: args.taskId,
            corTitle: corTask.title,
            corDescription: corTask.description ?? undefined,
            corDeadline: corTask.deadline ?? undefined,
            corPriority: corTask.priority ?? undefined,
            corStatus: corTask.status ?? undefined,
          },
        );

        if (taskUpdateResult?.statusChanged) {
          await ctx.scheduler.runAfter(
            0,
            (internal as any).data.trello.syncTaskStatusFromCORToTrello,
            { taskId: args.taskId },
          );
        }

        if (taskUpdateResult?.trelloFieldsChanged) {
          await ctx.scheduler.runAfter(
            0,
            (internal as any).data.trello.syncTaskFieldsFromCORToTrello,
            { taskId: args.taskId },
          );
        }

        await syncTaskAttachmentsFromCOR(ctx, args.taskId, corTaskId);
      }

      // 3. Traer proyecto de COR (si la task tiene corProjectId)
      if (task.corProjectId && task.projectId) {
        console.log(
          `[InboundSync] 📡 Consultando proyecto COR ${task.corProjectId}...`,
        );
        let corProject = null;
        try {
          corProject = await provider.getProject(task.corProjectId);
        } catch (error) {
          if (error instanceof CORNotFoundError) {
            await ctx.runMutation(
              internal.data.corInboundSync.setProjectNotFoundInCOR,
              {
                projectId: task.projectId,
                missing: true,
              },
            );
            console.warn(
              `[InboundSync] ⚠️ Proyecto COR ${task.corProjectId} no encontrado para proyecto ${task.projectId}`,
            );
            corProject = null;
          } else {
            throw error;
          }
        }

        if (!corProject) {
          console.warn(
            `[InboundSync] ⚠️ Proyecto COR ${task.corProjectId} no encontrado (¿eliminado?)`,
          );
        } else {
          await ctx.runMutation(
            internal.data.corInboundSync.setProjectNotFoundInCOR,
            {
              projectId: task.projectId,
              missing: false,
            },
          );
          await ctx.runMutation(
            internal.data.corInboundSync.applyInboundProjectUpdate,
            {
              projectId: task.projectId,
              corName: corProject.name,
              corBrief: corProject.brief ?? undefined,
              corStartDate: corProject.startDate ?? undefined,
              corEndDate: corProject.endDate ?? undefined,
              corDeliverables: corProject.deliverables ?? undefined,
              corStatus: corProject.status ?? undefined,
              corEstimatedTime: corProject.estimatedTime ?? undefined,
              corBrandId: corProject.brandId,
              corProductId: corProject.productId,
            },
          );
        }
      }

      console.log("[InboundSync] ✅ Pull completado");
      console.log("========================================\n");
    } catch (error) {
      console.error(
        "[InboundSync] ❌ Error en pull:",
        error instanceof Error ? error.message : error,
      );
    }
  },
});

// ==================== SCHEDULED INBOUND SYNC (cron) ====================

function normalizeScheduledIndex(index: number, length: number) {
  return ((index % length) + length) % length;
}

async function getNextScheduledTaskPage(
  ctx: any,
  args: {
    bucketIndex: number;
    cursor: string;
    numItems: number;
    dateMode: ScheduledDateMode;
    dateKey: string;
  },
) {
  let bucketIndex = normalizeScheduledIndex(
    args.bucketIndex,
    SCHEDULED_TASK_BUCKETS.length,
  );
  let cursor: string | null = args.cursor || null;

  for (
    let attempt = 0;
    attempt < SCHEDULED_TASK_BUCKETS.length;
    attempt += 1
  ) {
    const bucket = SCHEDULED_TASK_BUCKETS[bucketIndex];
    if (args.dateMode === "expired" && bucket.includeUndated) {
      bucketIndex = normalizeScheduledIndex(
        bucketIndex + 1,
        SCHEDULED_TASK_BUCKETS.length,
      );
      cursor = null;
      continue;
    }

    const page = await ctx.runQuery(
      internal.data.corInboundSync.listTasksForScheduledPull,
      {
        convexStatus: bucket.convexStatus,
        dateMode: args.dateMode,
        dateKey: args.dateKey,
        includeUndated: bucket.includeUndated,
        paginationOpts: {
          cursor,
          numItems: args.numItems,
        },
      },
    );

    const nextBucketIndex = page.isDone
      ? normalizeScheduledIndex(bucketIndex + 1, SCHEDULED_TASK_BUCKETS.length)
      : bucketIndex;
    const nextCursor = page.isDone ? "" : page.continueCursor;

    if (page.page.length > 0 || !page.isDone) {
      return {
        bucket: bucket.key,
        page: page.page,
        nextBucketIndex,
        nextCursor,
      };
    }

    bucketIndex = nextBucketIndex;
    cursor = null;
  }

  const bucket = SCHEDULED_TASK_BUCKETS[bucketIndex];
  return {
    bucket: bucket.key,
    page: [],
    nextBucketIndex: bucketIndex,
    nextCursor: "",
  };
}

async function getNextScheduledProjectPage(
  ctx: any,
  args: {
    bucketIndex: number;
    cursor: string;
    numItems: number;
    dateMode: ScheduledDateMode;
    dateKey: string;
  },
) {
  let bucketIndex = normalizeScheduledIndex(
    args.bucketIndex,
    SCHEDULED_PROJECT_BUCKETS.length,
  );
  let cursor: string | null = args.cursor || null;

  for (
    let attempt = 0;
    attempt < SCHEDULED_PROJECT_BUCKETS.length;
    attempt += 1
  ) {
    const bucket = SCHEDULED_PROJECT_BUCKETS[bucketIndex];
    if (args.dateMode === "expired" && bucket.includeUndated) {
      bucketIndex = normalizeScheduledIndex(
        bucketIndex + 1,
        SCHEDULED_PROJECT_BUCKETS.length,
      );
      cursor = null;
      continue;
    }

    const page = await ctx.runQuery(
      internal.data.corInboundSync.listProjectsForScheduledPull,
      {
        convexStatus: bucket.convexStatus,
        dateMode: args.dateMode,
        dateKey: args.dateKey,
        includeUndated: bucket.includeUndated,
        paginationOpts: {
          cursor,
          numItems: args.numItems,
        },
      },
    );

    const nextBucketIndex = page.isDone
      ? normalizeScheduledIndex(
          bucketIndex + 1,
          SCHEDULED_PROJECT_BUCKETS.length,
        )
      : bucketIndex;
    const nextCursor = page.isDone ? "" : page.continueCursor;

    if (page.page.length > 0 || !page.isDone) {
      return {
        bucket: bucket.key,
        page: page.page,
        nextBucketIndex,
        nextCursor,
      };
    }

    bucketIndex = nextBucketIndex;
    cursor = null;
  }

  const bucket = SCHEDULED_PROJECT_BUCKETS[bucketIndex];
  return {
    bucket: bucket.key,
    page: [],
    nextBucketIndex: bucketIndex,
    nextCursor: "",
  };
}

/**
 * Lista paginada de tasks locales activas para sync programado.
 * Las finalizadas quedan fuera del cron normal.
 */
export const listTasksForScheduledPull = internalQuery({
  args: {
    convexStatus: v.optional(v.union(v.literal("active"), v.literal("deleted"))),
    dateMode: v.union(v.literal("current"), v.literal("expired")),
    dateKey: v.string(),
    includeUndated: v.boolean(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const dateRange = (q: any) => {
      if (args.includeUndated) return q.eq("deadline", undefined);
      if (args.dateMode === "expired") {
        return q.gt("deadline", "").lt("deadline", args.dateKey);
      }
      return q.gte("deadline", args.dateKey);
    };

    return await ctx.db
      .query("tasks")
      .withIndex("by_convexStatus_deadline", (q) =>
        dateRange(q.eq("convexStatus", args.convexStatus)),
      )
      .paginate(args.paginationOpts);
  },
});

/**
 * Lista paginada de proyectos locales activos para sync programado.
 * Los finalizados quedan fuera del cron normal.
 */
export const listProjectsForScheduledPull = internalQuery({
  args: {
    convexStatus: v.optional(v.union(v.literal("active"), v.literal("deleted"))),
    dateMode: v.union(v.literal("current"), v.literal("expired")),
    dateKey: v.string(),
    includeUndated: v.boolean(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const dateRange = (q: any) => {
      if (args.includeUndated) return q.eq("endDate", undefined);
      if (args.dateMode === "expired") {
        return q.gt("endDate", "").lt("endDate", args.dateKey);
      }
      return q.gte("endDate", args.dateKey);
    };

    return await ctx.db
      .query("projects")
      .withIndex("by_convexStatus_endDate", (q) =>
        dateRange(q.eq("convexStatus", args.convexStatus)),
      )
      .paginate(args.paginationOpts);
  },
});

export const claimScheduledInboundSyncRun = internalMutation({
  args: {
    stateKey: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("corInboundSyncState")
      .withIndex("by_key", (q) => q.eq("key", args.stateKey))
      .unique();

    if (existing?.leaseUntil && existing.leaseUntil > now) {
      return {
        claimed: false as const,
        leaseUntil: existing.leaseUntil,
      };
    }

    const baseState = {
      taskStatusIndex: existing?.taskStatusIndex ?? 0,
      taskCursor: existing?.taskCursor ?? "",
      projectStatusIndex: existing?.projectStatusIndex ?? 0,
      projectCursor: existing?.projectCursor ?? "",
    };

    const patch = {
      ...baseState,
      leaseUntil: now + SCHEDULED_SYNC_LEASE_MS,
      lastRunAt: now,
      lastError: "",
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("corInboundSyncState", {
        key: args.stateKey,
        ...patch,
      });
    }

    return {
      claimed: true as const,
      ...baseState,
    };
  },
});

export const completeScheduledInboundSyncRun = internalMutation({
  args: {
    stateKey: v.string(),
    taskStatusIndex: v.number(),
    taskCursor: v.string(),
    projectStatusIndex: v.number(),
    projectCursor: v.string(),
    taskCount: v.number(),
    projectCount: v.number(),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("corInboundSyncState")
      .withIndex("by_key", (q) => q.eq("key", args.stateKey))
      .unique();
    if (!state) return;

    const now = Date.now();
    await ctx.db.patch(state._id, {
      taskStatusIndex: args.taskStatusIndex,
      taskCursor: args.taskCursor,
      projectStatusIndex: args.projectStatusIndex,
      projectCursor: args.projectCursor,
      leaseUntil: 0,
      lastCompletedAt: now,
      lastError: "",
      lastTaskCount: args.taskCount,
      lastProjectCount: args.projectCount,
      updatedAt: now,
    });
  },
});

export const failScheduledInboundSyncRun = internalMutation({
  args: {
    stateKey: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("corInboundSyncState")
      .withIndex("by_key", (q) => q.eq("key", args.stateKey))
      .unique();
    if (!state) return;

    await ctx.db.patch(state._id, {
      leaseUntil: 0,
      lastError: args.error,
      updatedAt: Date.now(),
    });
  },
});

async function runScheduledInboundSync(
  ctx: any,
  args: {
    stateKey: string;
    dateMode: ScheduledDateMode;
    label: string;
  },
) {
  const dateKey = getEcuadorDateKey();

  console.log("\n========================================");
  console.log(
    `[InboundSync][Cron] ⏱️ Inicio corrida programada ${args.label} COR → Convex (fecha Ecuador: ${dateKey})`,
  );
  console.log("========================================\n");

  const state = await ctx.runMutation(
    internal.data.corInboundSync.claimScheduledInboundSyncRun,
    { stateKey: args.stateKey },
  );

  if (!state.claimed) {
    console.log(
      `[InboundSync][Cron] ⏭️ Hay otra corrida activa para ${args.label} hasta ${state.leaseUntil}, se omite`,
    );
    return;
  }

  try {
    const tasksPage = await getNextScheduledTaskPage(ctx, {
      bucketIndex: state.taskStatusIndex,
      cursor: state.taskCursor,
      numItems: SCHEDULED_TASKS_PER_RUN,
      dateMode: args.dateMode,
      dateKey,
    });

    const projectsPage = await getNextScheduledProjectPage(ctx, {
      bucketIndex: state.projectStatusIndex,
      cursor: state.projectCursor,
      numItems: SCHEDULED_PROJECTS_PER_RUN,
      dateMode: args.dateMode,
      dateKey,
    });

    let delay = 0;
    for (const task of tasksPage.page as Array<{ _id: Id<"tasks"> }>) {
      await ctx.scheduler.runAfter(
        delay,
        internal.data.corInboundSync.pullTaskFromCORWorker,
        { taskId: task._id },
      );
      delay += SCHEDULED_WORKER_STAGGER_MS;
    }

    for (const project of projectsPage.page as Array<{ _id: Id<"projects"> }>) {
      await ctx.scheduler.runAfter(
        delay,
        internal.data.corInboundSync.pullProjectFromCORWorker,
        { projectId: project._id },
      );
      delay += SCHEDULED_WORKER_STAGGER_MS;
    }

    await ctx.runMutation(
      internal.data.corInboundSync.completeScheduledInboundSyncRun,
      {
        stateKey: args.stateKey,
        taskStatusIndex: tasksPage.nextBucketIndex,
        taskCursor: tasksPage.nextCursor,
        projectStatusIndex: projectsPage.nextBucketIndex,
        projectCursor: projectsPage.nextCursor,
        taskCount: tasksPage.page.length,
        projectCount: projectsPage.page.length,
      },
    );

    console.log(
      `[InboundSync][Cron] ✅ Corrida ${args.label} despachada. Tasks: ${tasksPage.page.length} (${tasksPage.bucket}), Proyectos: ${projectsPage.page.length} (${projectsPage.bucket})`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(
      internal.data.corInboundSync.failScheduledInboundSyncRun,
      { stateKey: args.stateKey, error: message },
    );
    throw error;
  }
}

/**
 * Orquestador programado por cron frecuente.
 * Avanza por lotes pequeños sobre tasks/proyectos no vencidos y continúa en la próxima corrida.
 */
export const runScheduledInboundSyncAction = internalAction({
  args: {},
  handler: async (ctx) => {
    await runScheduledInboundSync(ctx, {
      stateKey: SCHEDULED_SYNC_STATE_KEY,
      dateMode: "current",
      label: "vigente",
    });
  },
});

/**
 * Orquestador programado diario para tasks/proyectos vencidos.
 */
export const runScheduledExpiredInboundSyncAction = internalAction({
  args: {},
  handler: async (ctx) => {
    await runScheduledInboundSync(ctx, {
      stateKey: SCHEDULED_EXPIRED_SYNC_STATE_KEY,
      dateMode: "expired",
      label: "vencida",
    });
  },
});

/**
 * Worker de task para sync inbound programado.
 * Evita conflictos saltando tasks en syncing/retrying.
 */
export const pullTaskFromCORWorker = internalAction({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const task = await ctx.runQuery(
      internal.data.tasks.getTaskCORSyncSnapshotInternal,
      {
        taskId: args.taskId as unknown as string,
      },
    );

    if (!task) return;

    if (task.status === "finalizada") {
      console.log(
        `[InboundSync][Cron] ⏭️ Task ${args.taskId} finalizada, se omite`,
      );
      return;
    }

    if (!task.corTaskId) {
      console.log(
        `[InboundSync][Cron] ⏭️ Task ${args.taskId} sin corTaskId, se omite`,
      );
      return;
    }

    if (task.corSyncStatus === "syncing" || task.corSyncStatus === "retrying") {
      console.log(
        `[InboundSync][Cron] ⏭️ Task ${args.taskId} en ${task.corSyncStatus}, se omite`,
      );
      return;
    }

    const corTaskId = parseCORTaskId(task.corTaskId);
    if (corTaskId === null) {
      console.warn(
        `[InboundSync][Cron] ⚠️ Task ${args.taskId} tiene corTaskId inválido (${task.corTaskId})`,
      );
      return;
    }

    const provider = getProjectManagementProvider();
    let corTask = null;
    try {
      corTask = await provider.getTask(corTaskId);
    } catch (error) {
      if (error instanceof CORNotFoundError) {
        await ctx.runMutation(
          internal.data.corInboundSync.setTaskNotFoundInCOR,
          {
            taskId: args.taskId,
            missing: true,
          },
        );
        console.warn(
          `[InboundSync][Cron] ⚠️ Task COR ${task.corTaskId} no encontrada para task ${args.taskId}`,
        );
        return;
      }
      throw error;
    }
    if (!corTask) {
      console.warn(
        `[InboundSync][Cron] ⚠️ Task COR ${task.corTaskId} no encontrada para task ${args.taskId}`,
      );
      return;
    }

    await ctx.runMutation(internal.data.corInboundSync.setTaskNotFoundInCOR, {
      taskId: args.taskId,
      missing: false,
    });

    const taskUpdateResult = await ctx.runMutation(
      internal.data.corInboundSync.applyInboundTaskUpdate,
      {
        taskId: args.taskId,
        corTitle: corTask.title,
        corDescription: corTask.description ?? undefined,
        corDeadline: corTask.deadline ?? undefined,
        corPriority: corTask.priority ?? undefined,
        corStatus: corTask.status ?? undefined,
      },
    );

    if (taskUpdateResult?.statusChanged) {
      await ctx.scheduler.runAfter(
        0,
        (internal as any).data.trello.syncTaskStatusFromCORToTrello,
        { taskId: args.taskId },
      );
    }

    await ctx.scheduler.runAfter(
      0,
      (internal as any).data.trello.syncTaskFieldsFromCORToTrello,
      { taskId: args.taskId },
    );

    await ctx.scheduler.runAfter(
      SCHEDULED_ATTACHMENT_DELAY_MS,
      internal.data.corInboundSync.pullTaskAttachmentsFromCORWorker,
      {
        taskId: args.taskId,
        corTaskId,
      },
    );
  },
});

/**
 * Worker separado para attachments del cron.
 * Mantiene los archivos sincronizados sin cargar attachments dentro del worker principal.
 */
export const pullTaskAttachmentsFromCORWorker = internalAction({
  args: {
    taskId: v.id("tasks"),
    corTaskId: v.number(),
  },
  handler: async (ctx, args) => {
    const task = await ctx.runQuery(
      internal.data.tasks.getTaskCORSyncSnapshotInternal,
      {
        taskId: args.taskId as unknown as string,
      },
    );

    if (!task) return;
    if (task.status === "finalizada") {
      console.log(
        `[InboundSync][Attachments] ⏭️ Task ${args.taskId} finalizada, se omite`,
      );
      return;
    }
    if (task.corSyncStatus === "syncing" || task.corSyncStatus === "retrying") {
      console.log(
        `[InboundSync][Attachments] ⏭️ Task ${args.taskId} en ${task.corSyncStatus}, se omite`,
      );
      return;
    }

    const currentCorTaskId = parseCORTaskId(task.corTaskId);
    if (currentCorTaskId !== args.corTaskId) {
      console.warn(
        `[InboundSync][Attachments] ⚠️ Task ${args.taskId} cambió de corTaskId, se omite`,
      );
      return;
    }

    await syncTaskAttachmentsFromCOR(ctx, args.taskId, args.corTaskId);
  },
});

/**
 * Worker de proyecto para sync inbound programado.
 * Evita conflictos saltando proyectos en syncing/retrying.
 */
export const pullProjectFromCORWorker = internalAction({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const project = await ctx.runQuery(
      internal.data.projects.getProjectInternal,
      {
        projectId: args.projectId,
      },
    );

    if (!project) return;

    if (project.status === "finished") {
      console.log(
        `[InboundSync][Cron] ⏭️ Proyecto ${args.projectId} finalizado, se omite`,
      );
      return;
    }

    if (!project.corProjectId) {
      console.log(
        `[InboundSync][Cron] ⏭️ Proyecto ${args.projectId} sin corProjectId, se omite`,
      );
      return;
    }

    if (
      project.corSyncStatus === "syncing" ||
      project.corSyncStatus === "retrying"
    ) {
      console.log(
        `[InboundSync][Cron] ⏭️ Proyecto ${args.projectId} en ${project.corSyncStatus}, se omite`,
      );
      return;
    }

    const provider = getProjectManagementProvider();
    let corProject = null;
    try {
      corProject = await provider.getProject(project.corProjectId);
    } catch (error) {
      if (error instanceof CORNotFoundError) {
        await ctx.runMutation(
          internal.data.corInboundSync.setProjectNotFoundInCOR,
          {
            projectId: args.projectId,
            missing: true,
          },
        );
        console.warn(
          `[InboundSync][Cron] ⚠️ Proyecto COR ${project.corProjectId} no encontrado para proyecto ${args.projectId}`,
        );
        return;
      }
      throw error;
    }
    if (!corProject) {
      console.warn(
        `[InboundSync][Cron] ⚠️ Proyecto COR ${project.corProjectId} no encontrado para proyecto ${args.projectId}`,
      );
      return;
    }

    await ctx.runMutation(
      internal.data.corInboundSync.setProjectNotFoundInCOR,
      {
        projectId: args.projectId,
        missing: false,
      },
    );

    await ctx.runMutation(
      internal.data.corInboundSync.applyInboundProjectUpdate,
      {
        projectId: args.projectId,
        corName: corProject.name,
        corBrief: corProject.brief ?? undefined,
        corStartDate: corProject.startDate ?? undefined,
        corEndDate: corProject.endDate ?? undefined,
        corDeliverables: corProject.deliverables ?? undefined,
        corStatus: corProject.status ?? undefined,
        corEstimatedTime: corProject.estimatedTime ?? undefined,
        corBrandId: corProject.brandId,
        corProductId: corProject.productId,
      },
    );
  },
});

/**
 * Marca si la task local ya no existe en COR.
 */
export const setTaskNotFoundInCOR = internalMutation({
  args: {
    taskId: v.id("tasks"),
    missing: v.boolean(),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return;

    if (args.missing) {
      await ctx.db.patch(args.taskId, {
        corTaskMissingInCOR: true,
        corSyncError:
          "No encontrada en COR: la tarea no fue encontrada en COR y posiblemente fue eliminada.",
      });
      return;
    }

    const patch: Record<string, string | boolean> = {
      corTaskMissingInCOR: false,
    };

    if (
      task.corSyncError?.startsWith("Eliminado en COR:") ||
      task.corSyncError?.startsWith("No encontrada en COR:")
    ) {
      patch.corSyncError = "";
    }

    await ctx.db.patch(args.taskId, patch as any);
  },
});

/**
 * Marca si el proyecto local ya no existe en COR y propaga el estado a sus tasks.
 */
export const setProjectNotFoundInCOR = internalMutation({
  args: {
    projectId: v.id("projects"),
    missing: v.boolean(),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return;

    if (args.missing) {
      await ctx.db.patch(args.projectId, {
        corMissingInCOR: true,
        corSyncError:
          "No encontrado en COR: el proyecto no fue encontrado en COR y posiblemente fue eliminado.",
      });
    } else {
      const patch: Record<string, string | boolean> = {
        corMissingInCOR: false,
      };

      if (
        project.corSyncError?.startsWith("Eliminado en COR:") ||
        project.corSyncError?.startsWith("No encontrado en COR:")
      ) {
        patch.corSyncError = "";
      }

      await ctx.db.patch(args.projectId, patch as any);
    }

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .collect();

    for (const task of tasks) {
      await ctx.db.patch(task._id, {
        corProjectMissingInCOR: args.missing,
      });
    }
  },
});

// ==================== MUTATIONS: aplicar cambios ====================

/**
 * Aplica cambios de COR a una task en Convex.
 * Guarda atómica: si corSyncStatus cambió (outbound sync en curso), aborta.
 * Solo escribe si al menos un campo cambió (evita re-renders innecesarios).
 */
export const applyInboundTaskUpdate = internalMutation({
  args: {
    taskId: v.id("tasks"),
    corTitle: v.string(),
    corDescription: v.optional(v.string()),
    corDeadline: v.optional(v.string()),
    corPriority: v.optional(v.number()),
    corStatus: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Re-leer la task (estado fresco, atómico dentro de la mutation)
    const task = await ctx.db.get(args.taskId);
    if (!task) {
      return {
        updated: false,
        statusChanged: false,
        trelloFieldsChanged: false,
      };
    }

    // Guarda de conflicto: si un outbound sync se inició, no tocar
    if (
      task.corSyncStatus !== "synced" &&
      task.corSyncStatus !== "error" &&
      task.corSyncStatus !== "pending"
    ) {
      console.log(
        `[InboundSync] ⏭️ Task ${args.taskId} en estado "${task.corSyncStatus}", omitiendo update inbound`,
      );
      return {
        updated: false,
        statusChanged: false,
        trelloFieldsChanged: false,
      };
    }

    // Comparar campos — solo escribir si hay diferencia
    const updates: Record<string, unknown> = {};

    if (args.corTitle !== task.title) updates.title = args.corTitle;
    if (
      args.corDescription !== undefined &&
      args.corDescription !== (task.description ?? "")
    ) {
      updates.description = args.corDescription;
    }
    if (args.corDeadline !== undefined && args.corDeadline !== task.deadline) {
      updates.deadline = args.corDeadline;
    }
    if (args.corPriority !== undefined && args.corPriority !== task.priority) {
      updates.priority = args.corPriority;
    }
    const statusChanged =
      args.corStatus !== undefined && args.corStatus !== task.status;
    if (statusChanged) {
      updates.status = args.corStatus;
    }

    const titleChanged = updates.title !== undefined;
    const descriptionChanged = updates.description !== undefined;
    const deadlineChanged = updates.deadline !== undefined;
    const trelloFieldsChanged =
      titleChanged || descriptionChanged || deadlineChanged;

    if (Object.keys(updates).length === 0) {
      console.log(
        `[InboundSync] ✅ Task ${args.taskId} ya está al día — sin cambios`,
      );
      return {
        updated: false,
        statusChanged: false,
        trelloFieldsChanged: false,
      };
    }

    // Actualizar timestamps de sync (NO lastLocalEditAt — esto no es edición local)
    updates.corSyncedAt = Date.now();
    if (updates.description) {
      updates.corDescriptionHash = hashText(updates.description as string);
    }

    await ctx.db.patch(args.taskId, updates as any);
    console.log(
      `[InboundSync] ✅ Task ${args.taskId} actualizada: ${Object.keys(updates)
        .filter((k) => !k.startsWith("cor"))
        .join(", ")}`,
    );
    return { updated: true, statusChanged, trelloFieldsChanged };
  },
});

/**
 * Aplica cambios de COR a un proyecto en Convex.
 * Misma lógica de guarda atómica y comparación que la task.
 */
export const applyInboundProjectUpdate = internalMutation({
  args: {
    projectId: v.id("projects"),
    corName: v.string(),
    corBrief: v.optional(v.string()),
    corStartDate: v.optional(v.string()),
    corEndDate: v.optional(v.string()),
    corDeliverables: v.optional(v.number()),
    corStatus: v.optional(v.string()),
    corEstimatedTime: v.optional(v.number()),
    corBrandId: v.optional(v.number()),
    corProductId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return;

    // Guarda de conflicto
    if (
      project.corSyncStatus !== "synced" &&
      project.corSyncStatus !== "error" &&
      project.corSyncStatus !== "pending"
    ) {
      console.log(
        `[InboundSync] ⏭️ Proyecto ${args.projectId} en estado "${project.corSyncStatus}", omitiendo update inbound`,
      );
      return;
    }

    // Comparar campos
    const updates: Record<string, unknown> = {};

    if (args.corName !== project.name) updates.name = args.corName;
    if (
      args.corBrief !== undefined &&
      args.corBrief !== (project.brief ?? "")
    ) {
      updates.brief = args.corBrief;
    }
    if (
      args.corStartDate !== undefined &&
      args.corStartDate !== project.startDate
    ) {
      updates.startDate = args.corStartDate;
    }
    if (args.corEndDate !== undefined && args.corEndDate !== project.endDate) {
      updates.endDate = args.corEndDate;
    }
    if (
      args.corDeliverables !== undefined &&
      args.corDeliverables !== project.deliverables
    ) {
      updates.deliverables = args.corDeliverables;
    }
    if (args.corStatus !== undefined && args.corStatus !== project.status) {
      updates.status = args.corStatus;
    }
    if (
      args.corEstimatedTime !== undefined &&
      args.corEstimatedTime !== project.estimatedTime
    ) {
      updates.estimatedTime = args.corEstimatedTime;
    }
    if (args.corBrandId !== undefined) {
      const taxonomy = await resolveInboundProjectTaxonomy(ctx, {
        corClientId: project.corClientId,
        corBrandId: args.corBrandId,
        corProductId: args.corProductId,
      });

      if (taxonomy.brandId !== project.brandId)
        updates.brandId = taxonomy.brandId;
      if (taxonomy.clientBrandId !== project.clientBrandId) {
        updates.clientBrandId = taxonomy.clientBrandId;
      }
      if (taxonomy.brandName !== project.brandName)
        updates.brandName = taxonomy.brandName;
      if (taxonomy.productId !== project.productId)
        updates.productId = taxonomy.productId;
      if (taxonomy.subBrandId !== project.subBrandId) {
        updates.subBrandId = taxonomy.subBrandId;
      }
      if (taxonomy.subBrandName !== project.subBrandName) {
        updates.subBrandName = taxonomy.subBrandName;
      }
    }

    if (Object.keys(updates).length === 0) {
      console.log(
        `[InboundSync] ✅ Proyecto ${args.projectId} ya está al día — sin cambios`,
      );
      return;
    }

    updates.corSyncedAt = Date.now();

    await ctx.db.patch(args.projectId, updates as any);
    const updatedProject = await ctx.db.get(args.projectId);
    await applyProjectDeliverablesDelta(ctx, project, updatedProject);
    console.log(
      `[InboundSync] ✅ Proyecto ${args.projectId} actualizado: ${Object.keys(
        updates,
      )
        .filter((k) => !k.startsWith("cor"))
        .join(", ")}`,
    );
  },
});
