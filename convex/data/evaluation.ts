// convex/evaluation.ts
// Funciones para manejar la evaluación de resultados
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { components, internal } from "../_generated/api";
import { createThread, saveMessage, listUIMessages, getFile } from "@convex-dev/agent";
import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";

const evaluationStageValidator = v.union(
  v.literal("queued"),
  v.literal("preparing_files"),
  v.literal("generating_gemini"),
  v.literal("generating_openai"),
  v.literal("saving_result"),
  v.literal("completed"),
  v.literal("failed"),
);

const EVALUATION_STALE_AFTER_MS = 15 * 60 * 1000;

async function buildEvaluationContent(
  ctx: any,
  args: {
    fileIds: string[];
    briefThreadId: string;
    taskId: string;
  },
) {
  const loadFileParts = async (fileIds: string[]) => {
    const parts: any[] = [];
    const loadedFileIds: string[] = [];

    for (const fileId of fileIds) {
      try {
        const fileData = await getFile(ctx, components.agent, fileId);
        const { imagePart, filePart, file } = fileData;
        const filename = file?.filename || "";
        const isWordDocument =
          filename.toLowerCase().endsWith(".docx") ||
          filename.toLowerCase().endsWith(".doc");

        if (imagePart) {
          parts.push(imagePart);
          loadedFileIds.push(fileId);
        } else if (filePart && !isWordDocument) {
          parts.push(filePart);
          loadedFileIds.push(fileId);
        } else if (isWordDocument) {
          console.log(
            `[Evaluation] Archivo Word omitido porque el evaluador no lo soporta: ${filename}`,
          );
        }
      } catch (error) {
        console.error(`[Evaluation] Error obteniendo archivo ${fileId}:`, error);
      }
    }

    return { parts, loadedFileIds };
  };

  const finalFiles = await loadFileParts(args.fileIds);
  if (finalFiles.loadedFileIds.length !== args.fileIds.length) {
    throw new Error(
      `No se pudieron recuperar todos los archivos de la evaluación: ${finalFiles.loadedFileIds.length}/${args.fileIds.length}.`,
    );
  }

  const taskId = ctx.db.normalizeId("tasks", args.taskId);
  const taskAttachments = taskId
    ? await ctx.db
        .query("taskAttachments")
        .withIndex("by_task", (q: any) => q.eq("taskId", taskId))
        .collect()
    : [];
  const finalFileIdSet = new Set(args.fileIds);
  const originalCandidateIds = Array.from(
    new Set<string>(
      taskAttachments
        .map((attachment: any) => String(attachment.fileId))
        .filter((fileId: string) => !finalFileIdSet.has(fileId)),
    ),
  );
  const originalFiles = await loadFileParts(originalCandidateIds);

  const content: any[] = [
    {
      type: "text",
      text: "ENTREGABLES FINALES A EVALUAR:",
    },
    ...finalFiles.parts,
  ];

  if (originalFiles.parts.length > 0) {
    content.push(
      {
        type: "text",
        text: "ARCHIVOS DE REFERENCIA DEL REQUERIMIENTO ORIGINAL:",
      },
      ...originalFiles.parts,
    );
  }

  content.push({
    type: "text",
    text: `📋 INFORMACIÓN DEL CONTEXTO

Se adjuntaron los siguientes elementos para evaluación:
✅ ${finalFiles.loadedFileIds.length} entregable(s) final(es)
${originalFiles.loadedFileIds.length > 0 ? `✅ ${originalFiles.loadedFileIds.length} archivo(s) de referencia original` : "ℹ️ Sin archivos de referencia originales"}

Referencias del requerimiento original:
• Brief Thread ID: ${args.briefThreadId}
• Task ID: ${args.taskId}`,
  });

  return {
    content,
    finalFileIds: finalFiles.loadedFileIds,
    originalReferenceFileIds: originalFiles.loadedFileIds,
  };
}

async function enqueueTaskEvaluation(
  ctx: any,
  args: {
    task: any;
    evaluationThreadId: string;
    briefThreadId: string;
    prompt: string;
    fileIds: string[];
    originalReferenceFileIds: string[];
    content: any[];
    userId: string;
    attempt: number;
    retryOfEvaluationId?: any;
  },
) {
  const agentEvaluationThreadId = await createThread(ctx, components.agent, {
    userId: args.userId,
    title: `Evaluación aislada de Brief`,
    summary: `Thread técnico para evaluar task ${args.task._id}`,
  });

  const allContextFileIds = [
    ...new Set([...args.fileIds, ...args.originalReferenceFileIds]),
  ];

  const { messageId } = await saveMessage(ctx, components.agent, {
    threadId: args.evaluationThreadId,
    message: {
      role: "user",
      content: args.content,
    },
    metadata:
      allContextFileIds.length > 0
        ? { fileIds: allContextFileIds }
        : undefined,
  });

  const { messageId: agentUserMessageId } = await saveMessage(
    ctx,
    components.agent,
    {
      threadId: agentEvaluationThreadId,
      message: {
        role: "user",
        content: args.content,
      },
      metadata:
        allContextFileIds.length > 0
          ? { fileIds: allContextFileIds }
          : undefined,
    },
  );

  const now = Date.now();
  const evaluationId = await ctx.db.insert("taskEvaluations", {
    taskId: args.task._id,
    evaluationThreadId: args.evaluationThreadId,
    agentEvaluationThreadId,
    originalThreadId: args.briefThreadId,
    requestedBy: args.userId,
    requestedBySource: "auth",
    requestedAt: now,
    status: "processing",
    stage: "queued",
    attempt: args.attempt,
    retryOfEvaluationId: args.retryOfEvaluationId,
    prompt: args.prompt,
    inputFileIds: args.fileIds,
    originalReferenceFileIds: args.originalReferenceFileIds,
    userMessageId: messageId,
    agentUserMessageId,
    clientId: args.task.clientId,
    clientBrandId: args.task.clientBrandId,
    taskSource: args.task.source,
    createdAt: now,
    updatedAt: now,
  });

  const scheduledFunctionId = await ctx.scheduler.runAfter(
    0,
    internal.agents.evaluatorAgentAction.generateEvaluationAsync,
    {
      threadId: agentEvaluationThreadId,
      promptMessageId: agentUserMessageId,
      visibleThreadId: args.evaluationThreadId,
      visiblePromptMessageId: messageId,
      evaluationId,
      contextFileIds: allContextFileIds,
    },
  );

  await ctx.db.patch(evaluationId, {
    scheduledFunctionId: String(scheduledFunctionId),
  });

  return { messageId, evaluationId };
}

// Crear un thread de evaluación para un thread de brief existente
export const createEvaluationThread = mutation({
  args: {
    briefThreadId: v.string(),
    taskId: v.id("tasks"),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Verificar si ya existe un thread de evaluación para esta task
    const existing = await ctx.db
      .query("evaluationThreads")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .first();
    
    if (existing) {
      console.log(`[Evaluation] Thread de evaluación ya existe: ${existing.evaluationThreadId}`);
      return {
        evaluationThreadId: existing.evaluationThreadId,
        briefThreadId: args.briefThreadId,
        isNew: false,
      };
    }
    
    // Crear un nuevo thread para la evaluación
    const evaluationThreadId = await createThread(ctx, components.agent, {
      userId: args.userId,
      title: `Evaluación de Brief`,
      summary: `Thread de evaluación para el brief ${args.briefThreadId}`,
    });
    
    // Guardar la relación en la tabla evaluationThreads
    await ctx.db.insert("evaluationThreads", {
      taskId: args.taskId,
      originalThreadId: args.briefThreadId,
      evaluationThreadId,
      status: "pending",
      createdAt: Date.now(),
    });
    
    console.log(`[Evaluation] ✅ Thread de evaluación creado: ${evaluationThreadId}`);
    
    return {
      evaluationThreadId,
      briefThreadId: args.briefThreadId,
      isNew: true,
    };
  },
});

// Enviar archivo para evaluación
export const sendEvaluationFile = mutation({
  args: {
    evaluationThreadId: v.string(),
    briefThreadId: v.string(),
    taskId: v.id("tasks"),
    prompt: v.string(),
    fileId: v.optional(v.string()), // Mantener para compatibilidad
    fileIds: v.optional(v.array(v.string())), // Nuevo: múltiples archivos
  },
  handler: async (ctx, { evaluationThreadId, briefThreadId, taskId, prompt, fileId, fileIds }) => {
    console.log(`[Evaluation] 📤 Enviando archivo(s) para evaluación`);
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Debes iniciar sesión para enviar una evaluación.");
    }

    const task = await ctx.db.get(taskId);
    if (!task || task.convexStatus === "deleted") {
      throw new Error("No se encontró la task asociada a esta evaluación.");
    }

    const evalThread = await ctx.db
      .query("evaluationThreads")
      .withIndex("by_evaluation_thread", (q) => q.eq("evaluationThreadId", evaluationThreadId))
      .first();

    if (!evalThread || evalThread.taskId !== taskId) {
      throw new Error("El thread de evaluación no corresponde a esta task.");
    }
    
    // Combinar fileId y fileIds para compatibilidad
    const combinedFileIds: string[] = [];
    if (fileId) combinedFileIds.push(fileId);
    if (fileIds) combinedFileIds.push(...fileIds);
    const allFileIds = [...new Set(combinedFileIds)];

    if (allFileIds.length === 0) {
      throw new Error("Debes adjuntar al menos un archivo para evaluar.");
    }

    const preparedContent = await buildEvaluationContent(ctx, {
      fileIds: allFileIds,
      briefThreadId,
      taskId,
    });

    await ctx.db.patch(evalThread._id, { status: "in_progress" });

    const result = await enqueueTaskEvaluation(ctx, {
      task,
      evaluationThreadId,
      briefThreadId,
      prompt,
      fileIds: preparedContent.finalFileIds,
      originalReferenceFileIds: preparedContent.originalReferenceFileIds,
      content: preparedContent.content,
      userId,
      attempt: 1,
    });

    console.log(
      `[Evaluation] ✅ Evaluación encolada: ${result.evaluationId}`,
    );
    return result;
  },
});

export const retryTaskEvaluation = mutation({
  args: {
    evaluationId: v.id("taskEvaluations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Debes iniciar sesión para reintentar una evaluación.");
    }

    const previousEvaluation = await ctx.db.get(args.evaluationId);
    if (!previousEvaluation) {
      throw new Error("No se encontró la evaluación que deseas reintentar.");
    }

    const latestEvaluation = await ctx.db
      .query("taskEvaluations")
      .withIndex("by_task_and_createdAt", (q) =>
        q.eq("taskId", previousEvaluation.taskId),
      )
      .order("desc")
      .first();

    if (latestEvaluation && latestEvaluation._id !== previousEvaluation._id) {
      if (latestEvaluation.status === "processing") {
        return {
          status: "already_processing" as const,
          evaluationId: latestEvaluation._id,
        };
      }
      throw new Error(
        "Esta evaluación ya no es la más reciente de la task.",
      );
    }

    const isStaleProcessing =
      previousEvaluation.status === "processing" &&
      previousEvaluation.updatedAt < Date.now() - EVALUATION_STALE_AFTER_MS;

    if (previousEvaluation.status !== "failed" && !isStaleProcessing) {
      throw new Error(
        "Solo puedes reintentar evaluaciones fallidas o interrumpidas.",
      );
    }

    const task = await ctx.db.get(previousEvaluation.taskId);
    if (!task || task.convexStatus === "deleted") {
      throw new Error("No se encontró la task asociada a esta evaluación.");
    }

    const evalThread = await ctx.db
      .query("evaluationThreads")
      .withIndex("by_evaluation_thread", (q) =>
        q.eq("evaluationThreadId", previousEvaluation.evaluationThreadId),
      )
      .first();

    if (!evalThread || evalThread.taskId !== previousEvaluation.taskId) {
      throw new Error("El thread de evaluación no corresponde a esta task.");
    }

    if (previousEvaluation.inputFileIds.length === 0) {
      throw new Error("La evaluación anterior no tiene archivos para reintentar.");
    }

    const preparedContent = await buildEvaluationContent(ctx, {
      fileIds: previousEvaluation.inputFileIds,
      briefThreadId: previousEvaluation.originalThreadId,
      taskId: previousEvaluation.taskId,
    });

    if (isStaleProcessing) {
      await ctx.db.patch(previousEvaluation._id, {
        status: "failed",
        stage: "failed",
        error: "La evaluación anterior fue interrumpida antes de completarse.",
        updatedAt: Date.now(),
      });
    }

    await ctx.db.patch(evalThread._id, { status: "in_progress" });

    const result = await enqueueTaskEvaluation(ctx, {
      task,
      evaluationThreadId: previousEvaluation.evaluationThreadId,
      briefThreadId: previousEvaluation.originalThreadId,
      prompt:
        previousEvaluation.prompt ||
        "Por favor evalúa este producto final y compáralo con el requerimiento original.",
      fileIds: preparedContent.finalFileIds,
      originalReferenceFileIds: preparedContent.originalReferenceFileIds,
      content: preparedContent.content,
      userId,
      attempt: (previousEvaluation.attempt ?? 1) + 1,
      retryOfEvaluationId: previousEvaluation._id,
    });

    return { status: "scheduled" as const, ...result };
  },
});

// Listar mensajes del thread de evaluación
export const listEvaluationMessages = query({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { threadId, paginationOpts }) => {
    const messages = await listUIMessages(ctx, components.agent, {
      threadId,
      paginationOpts,
    });
    
    return messages;
  },
});

// Obtener thread de evaluación por taskId
export const getEvaluationThreadByTask = query({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const evalThread = await ctx.db
      .query("evaluationThreads")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .first();
    
    return evalThread;
  },
});

export const getLatestTaskEvaluationByTask = query({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const evaluation = await ctx.db
      .query("taskEvaluations")
      .withIndex("by_task_and_createdAt", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .first();

    if (!evaluation) return null;

    return {
      ...evaluation,
      isStale:
        evaluation.status === "processing" &&
        evaluation.updatedAt < Date.now() - EVALUATION_STALE_AFTER_MS,
    };
  },
});

export const updateTaskEvaluationProgress = internalMutation({
  args: {
    evaluationId: v.id("taskEvaluations"),
    stage: evaluationStageValidator,
  },
  handler: async (ctx, args) => {
    const evaluation = await ctx.db.get(args.evaluationId);
    if (!evaluation || evaluation.status !== "processing") {
      return { status: "ignored" as const };
    }

    await ctx.db.patch(args.evaluationId, {
      stage: args.stage,
      updatedAt: Date.now(),
    });
    return { status: "updated" as const };
  },
});

export const claimTaskEvaluationRun = internalMutation({
  args: {
    evaluationId: v.id("taskEvaluations"),
  },
  handler: async (ctx, args) => {
    const evaluation = await ctx.db.get(args.evaluationId);
    if (!evaluation || evaluation.status !== "processing") {
      return { shouldRun: false as const };
    }

    await ctx.db.patch(args.evaluationId, { updatedAt: Date.now() });
    return { shouldRun: true as const };
  },
});

export const completeTaskEvaluation = internalMutation({
  args: {
    evaluationId: v.id("taskEvaluations"),
    resultText: v.string(),
    resultMessageId: v.optional(v.string()),
    agentResultMessageId: v.optional(v.string()),
    resultProvider: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const evaluation = await ctx.db.get(args.evaluationId);
    if (!evaluation) return { status: "missing" as const };
    if (evaluation.status !== "processing") {
      return { status: "ignored" as const };
    }

    const now = Date.now();
    await ctx.db.patch(args.evaluationId, {
      status: "completed",
      stage: "completed",
      resultText: args.resultText,
      resultMessageId: args.resultMessageId,
      agentResultMessageId: args.agentResultMessageId,
      resultProvider: args.resultProvider,
      completedAt: now,
      updatedAt: now,
      error: undefined,
    });

    const evalThread = await ctx.db
      .query("evaluationThreads")
      .withIndex("by_evaluation_thread", (q) =>
        q.eq("evaluationThreadId", evaluation.evaluationThreadId),
      )
      .first();

    if (evalThread) {
      await ctx.db.patch(evalThread._id, { status: "completed" });
    }

    return { status: "completed" as const };
  },
});

export const failTaskEvaluation = internalMutation({
  args: {
    evaluationId: v.id("taskEvaluations"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const evaluation = await ctx.db.get(args.evaluationId);
    if (!evaluation) return { status: "missing" as const };
    if (evaluation.status === "completed") {
      return { status: "ignored" as const };
    }

    const now = Date.now();
    await ctx.db.patch(args.evaluationId, {
      status: "failed",
      stage: "failed",
      error: args.error,
      updatedAt: now,
    });

    const evalThread = await ctx.db
      .query("evaluationThreads")
      .withIndex("by_evaluation_thread", (q) =>
        q.eq("evaluationThreadId", evaluation.evaluationThreadId),
      )
      .first();

    if (evalThread) {
      await ctx.db.patch(evalThread._id, { status: "completed" });
    }

    return { status: "failed" as const };
  },
});

export const listEvaluationThreadsForBackfill = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("evaluationThreads")
      .withIndex("by_createdAt")
      .order("desc")
      .take(args.limit ?? 100);
  },
});

export const createBackfilledTaskEvaluation = internalMutation({
  args: {
    taskId: v.id("tasks"),
    evaluationThreadId: v.string(),
    originalThreadId: v.string(),
    requestedBy: v.optional(v.string()),
    requestedBySource: v.string(),
    requestedAt: v.number(),
    completedAt: v.number(),
    prompt: v.optional(v.string()),
    inputFileIds: v.array(v.string()),
    userMessageId: v.optional(v.string()),
    resultMessageId: v.optional(v.string()),
    resultText: v.string(),
    resultProvider: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.userMessageId) {
      const existing = await ctx.db
        .query("taskEvaluations")
        .withIndex("by_userMessageId", (q) =>
          q.eq("userMessageId", args.userMessageId),
        )
        .first();
      if (existing) return { status: "already_exists" as const, evaluationId: existing._id };
    }

    if (args.resultMessageId) {
      const existing = await ctx.db
        .query("taskEvaluations")
        .withIndex("by_resultMessageId", (q) =>
          q.eq("resultMessageId", args.resultMessageId),
        )
        .first();
      if (existing) return { status: "already_exists" as const, evaluationId: existing._id };
    }

    const task = await ctx.db.get(args.taskId);
    if (!task || task.convexStatus === "deleted") {
      return { status: "missing_task" as const };
    }

    let requestedBy = args.requestedBy
      ? ctx.db.normalizeId("users", args.requestedBy)
      : null;
    let requestedBySource = requestedBy ? args.requestedBySource : "unknown";

    if (!requestedBy && task.createdBy) {
      requestedBy = ctx.db.normalizeId("users", task.createdBy);
      if (requestedBy) requestedBySource = "taskCreatedBy";
    }

    const now = Date.now();
    const evaluationId = await ctx.db.insert("taskEvaluations", {
      taskId: args.taskId,
      evaluationThreadId: args.evaluationThreadId,
      originalThreadId: args.originalThreadId,
      requestedBy: requestedBy ?? undefined,
      requestedBySource,
      requestedAt: args.requestedAt,
      completedAt: args.completedAt,
      status: "completed",
      stage: "completed",
      attempt: 1,
      prompt: args.prompt,
      inputFileIds: args.inputFileIds,
      userMessageId: args.userMessageId,
      resultMessageId: args.resultMessageId,
      resultText: args.resultText,
      resultProvider: args.resultProvider,
      clientId: task.clientId,
      clientBrandId: task.clientBrandId,
      taskSource: task.source,
      backfilled: true,
      createdAt: args.requestedAt,
      updatedAt: now,
    });

    return { status: "created" as const, evaluationId };
  },
});
