import { query, mutation, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  createThread as createAgentThread,
  listMessages,
} from "@convex-dev/agent";
import { components } from "../_generated/api";

const DEFAULT_THREAD_TITLE_PATTERNS = [
  /^nueva conversaci[oó]n$/i,
  /^nuevo brief$/i,
  /^nuevo chat(?:\s*•.*)?$/i,
  /^sin t[ií]tulo$/i,
];

function shouldAutoRenameThread(title: string | undefined) {
  const normalized = title?.trim();
  if (!normalized) return true;
  return DEFAULT_THREAD_TITLE_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

// Obtener threads del usuario con paginación
export const getMyThreads = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      };
    }

    const threads = await ctx.db
      .query("chatThreads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate(args.paginationOpts);

    return threads;
  },
});

// Verificar si un thread tiene mensajes
export const hasThreadMessages = query({
  args: { threadId: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return false;
    }

    // Verificar que el thread pertenece al usuario
    const thread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    if (!thread || thread.userId !== userId) {
      return false;
    }

    // Verificar si tiene mensajes en el componente Agent
    const messages = await listMessages(ctx, components.agent, {
      threadId: args.threadId,
      paginationOpts: { cursor: null, numItems: 1 },
    });

    return messages.page.length > 0;
  },
});

// Obtener un thread específico (solo si pertenece al usuario)
export const getThread = query({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }

    const thread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    // IMPORTANTE: Solo devolver si pertenece al usuario
    if (!thread || thread.userId !== userId) {
      return null;
    }

    return thread;
  },
});

// Crear un nuevo thread
// IMPORTANTE: Crea el thread en el componente Agent Y en nuestra tabla chatThreads
export const createThread = mutation({
  args: {
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }

    // Obtener o crear workspace
    let workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .first();

    if (!workspace) {
      const workspaceId = await ctx.db.insert("workspaces", {
        ownerId: userId,
        createdAt: Date.now(),
      });
      workspace = await ctx.db.get(workspaceId);
    }

    if (!workspace) {
      throw new Error("Could not create workspace");
    }

    const title = args.title || "Nueva conversación";

    // CLAVE: Crear el thread en el componente Agent usando createThread de @convex-dev/agent
    // Esto crea el documento en la tabla "threads" del componente que espera listUIMessages
    const threadId = await createAgentThread(ctx, components.agent, {
      userId: userId, // ID del usuario autenticado
      title,
      summary: "Conversación de chat",
    });

    console.log(`[Threads] ✅ Thread del Agent creado: ${threadId}`);

    const now = Date.now();
    const chatThreadId = await ctx.db.insert("chatThreads", {
      threadId, // El ID real del thread del componente Agent
      userId: userId,
      workspaceId: workspace._id,
      title,
      createdAt: now,
      updatedAt: now,
    });

    console.log(`[Threads] ✅ ChatThread registrado: ${chatThreadId}`);

    // Retornamos el threadId del Agent (string) que es lo que necesita ChatInterface
    return threadId;
  },
});

// Actualizar título del thread
// IMPORTANTE: Actualiza tanto la tabla chatThreads como la tabla threads del componente Agent
export const updateThreadTitle = mutation({
  args: {
    threadId: v.string(),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }

    const thread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    // Solo actualizar si pertenece al usuario
    if (!thread || thread.userId !== userId) {
      throw new Error("Thread not found or access denied");
    }

    // 1. Actualizar nuestra tabla chatThreads
    await ctx.db.patch(thread._id, {
      title: args.title,
      updatedAt: Date.now(),
    });

    // 2. Actualizar la tabla threads del componente Agent
    await ctx.runMutation(components.agent.threads.updateThread, {
      threadId: args.threadId,
      patch: {
        title: args.title,
      },
    });
  },
});

// Actualizar título desde procesos internos del backend.
// No requiere auth porque se llama después de que la task ya fue creada
// para el thread validado. Solo pisa títulos genéricos para respetar
// renombres manuales hechos por el usuario.
export const updateThreadTitleInternal = internalMutation({
  args: {
    threadId: v.string(),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const title = args.title.trim();
    if (!title) {
      return { updated: false, reason: "empty_title" };
    }

    const thread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    if (!thread) {
      return { updated: false, reason: "thread_not_found" };
    }

    if (!shouldAutoRenameThread(thread.title)) {
      return { updated: false, reason: "manual_title_preserved" };
    }

    await ctx.db.patch(thread._id, {
      title,
      updatedAt: Date.now(),
    });

    await ctx.runMutation(components.agent.threads.updateThread, {
      threadId: args.threadId,
      patch: {
        title,
      },
    });

    return { updated: true, title };
  },
});

// Actualizar timestamp del thread (cuando hay nuevo mensaje)
export const touchThread = mutation({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }

    const thread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    if (!thread || thread.userId !== userId) {
      return; // Silently ignore if not found
    }

    await ctx.db.patch(thread._id, {
      updatedAt: Date.now(),
    });
  },
});

// Eliminar un thread
export const deleteThread = mutation({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }

    const thread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    // Solo eliminar si pertenece al usuario
    if (!thread || thread.userId !== userId) {
      throw new Error("Thread not found or access denied");
    }

    await ctx.db.delete(thread._id);
  },
});
