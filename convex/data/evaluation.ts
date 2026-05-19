// convex/evaluation.ts
// Funciones para manejar la evaluación de resultados
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { components, internal } from "../_generated/api";
import { createThread, saveMessage, listUIMessages, getFile } from "@convex-dev/agent";
import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";

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
    
    // Crear contenido del mensaje
    const content: any[] = [];
    
    // Combinar fileId y fileIds para compatibilidad
    const allFileIds: string[] = [];
    if (fileId) allFileIds.push(fileId);
    if (fileIds) allFileIds.push(...fileIds);
    
    // Procesar todos los archivos
    for (const fId of allFileIds) {
      try {
        const fileData = await getFile(ctx, components.agent, fId);
        const { imagePart, filePart, file } = fileData;

        // Verificar si es Word (no soportado por Gemini)
        const filename = file?.filename || '';
        const isWordDocument = filename.toLowerCase().endsWith('.docx') || 
          filename.toLowerCase().endsWith('.doc');
        
        if (imagePart) {
          // LOG: Estimar tamaño de la imagen
          if ((imagePart as any).image?.source?.data) {
            const dataLength = (imagePart as any).image.source.data.length;
            console.log(`[Evaluation] 🖼️ imagePart tamaño data: ${(dataLength / 1024).toFixed(1)}KB`);
          } else {
            console.log(`[Evaluation] 🖼️ imagePart es referencia URL`);
          }
          content.push(imagePart);
        } else if (filePart && !isWordDocument) {
          content.push(filePart);
        } else if (isWordDocument) {
          console.log(`[Evaluation] 📝 Archivo Word detectado - omitiendo (contenido no soportado)`);
        }
      } catch (error) {
        console.error(`[Evaluation] Error obteniendo archivo ${fId}:`, error);
      }
    }
    
    // Agregar contexto del brief thread con el taskId para que el tool pueda encontrarlo
    // Los IDs se incluyen en el texto ya que metadata tiene esquema fijo
    const contextPrompt = `📋 INFORMACIÓN DEL CONTEXTO

Se adjuntaron los siguientes elementos para evaluación:
${allFileIds.length > 0 ? `✅ ${allFileIds.length} archivo(s) adjunto(s)` : '❌ Sin archivos adjuntos'}

Referencias del requerimiento original:
• Brief Thread ID: ${briefThreadId}
• Task ID: ${taskId}`;
    
    content.push({ type: "text", text: contextPrompt });
    
    if (content.length === 0) {
      throw new Error("Debes adjuntar al menos un archivo o escribir un mensaje");
    }
    
    // Guardar el mensaje del usuario (sin metadata personalizado)
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId: evaluationThreadId,
      message: { 
        role: "user", 
        content
      },
      metadata: allFileIds.length > 0 ? { fileIds: allFileIds } : undefined,
    });
    
    console.log(`[Evaluation] ✅ Mensaje de evaluación guardado: ${messageId}`);
    
    // Actualizar status del thread de evaluación
    await ctx.db.patch(evalThread._id, { status: "in_progress" });

    const now = Date.now();
    const evaluationId = await ctx.db.insert("taskEvaluations", {
      taskId,
      evaluationThreadId,
      originalThreadId: briefThreadId,
      requestedBy: userId,
      requestedBySource: "auth",
      requestedAt: now,
      status: "processing",
      prompt,
      inputFileIds: allFileIds,
      userMessageId: messageId,
      clientId: task.clientId,
      clientBrandId: task.clientBrandId,
      taskSource: task.source,
      createdAt: now,
      updatedAt: now,
    });
    
    // Disparar generación de evaluación asíncrona
    await ctx.scheduler.runAfter(0, internal.agents.evaluatorAgentAction.generateEvaluationAsync, {
      threadId: evaluationThreadId,
      promptMessageId: messageId,
      evaluationId,
    });
    
    return { messageId, evaluationId };
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

export const completeTaskEvaluation = internalMutation({
  args: {
    evaluationId: v.id("taskEvaluations"),
    resultText: v.string(),
    resultMessageId: v.optional(v.string()),
    resultProvider: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const evaluation = await ctx.db.get(args.evaluationId);
    if (!evaluation) return { status: "missing" as const };

    const now = Date.now();
    await ctx.db.patch(args.evaluationId, {
      status: "completed",
      resultText: args.resultText,
      resultMessageId: args.resultMessageId,
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

    const now = Date.now();
    await ctx.db.patch(args.evaluationId, {
      status: "failed",
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
