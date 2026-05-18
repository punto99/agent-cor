// convex/chat.ts
// Funciones para manejar conversaciones con el sistema multi-agente
// NOTA: generateResponseAsync fue movido a chatGenerate.ts ("use node" — Node.js runtime 512MB)
import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { components, internal } from "../_generated/api";
import { saveMessage, listUIMessages, getFile, syncStreams, vStreamArgs } from "@convex-dev/agent";
import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// NOTA: La creación de threads ahora se hace a través de convex/threads.ts
// que usa autenticación y crea correctamente el thread del Agent + chatThreads

// Obtener el último thread de CHAT del usuario (no incluye threads de evaluación)
export const getLatestThread = query({
  args: {},
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .first();
    
    if (chatThread) {
      return chatThread.threadId;
    }
    
    return null;
  },
});

// Enviar un mensaje y generar respuesta asíncrona
export const sendMessage = mutation({
  args: {
    threadId: v.string(),
    prompt: v.string(),
    fileId: v.optional(v.string()), // Mantener para compatibilidad
    fileIds: v.optional(v.array(v.string())), // Nuevo: múltiples archivos
  },
  handler: async (ctx, { threadId, prompt, fileId, fileIds }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }

    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .first();

    if (!chatThread || chatThread.userId !== userId) {
      throw new Error("Thread not found or access denied");
    }

    console.log(`[Chat] 📤 Guardando mensaje en thread ${threadId}`);
    
    // Crear contenido del mensaje
    const content: any[] = [];
    
    // Combinar fileId y fileIds para compatibilidad
    const allFileIds: string[] = [];
    let hasAudioInput = false;
    if (fileId) allFileIds.push(fileId);
    if (fileIds) allFileIds.push(...fileIds);
    
    // Procesar todos los archivos
    for (const fId of allFileIds) {
      try {
        const fileData = await getFile(ctx, components.agent, fId);
        
        const { imagePart, filePart, file } = fileData;
        const mimeType =
          ((filePart as any)?.mimeType as string | undefined) ||
          ((filePart as any)?.mediaType as string | undefined) ||
          "";
        const lowerFilename = (file?.filename || "").toLowerCase();
        const isAudioByMime = mimeType.toLowerCase().startsWith("audio/");
        const isAudioByExtension = /\.(mp3|wav|wave|ogg|webm|m4a|aac|flac|mp4)$/i.test(lowerFilename);
        if (isAudioByMime || isAudioByExtension) {
          hasAudioInput = true;
        }

        // Verificar si es un archivo Word (Gemini no lo soporta)
        // Usamos la extensión del filename para detectar archivos Word
        const filename = file?.filename || '';
        const isWordDocument = filename.toLowerCase().endsWith('.docx') || 
          filename.toLowerCase().endsWith('.doc');
        
        // Preferir imagePart si es una imagen
        if (imagePart) {
          // LOG: Estimar tamaño de la imagen si tiene data inline
          if ((imagePart as any).image?.source?.data) {
            const dataLength = (imagePart as any).image.source.data.length;
            console.log(`[Chat] 🖼️ Agregando imagePart - tamaño data: ${(dataLength / 1024).toFixed(1)}KB`);
          } else {
            console.log(`[Chat] 🖼️ Agregando imagePart (referencia URL)`);
          }
          content.push(imagePart);
        } else if (filePart && !isWordDocument) {
          // Solo agregar filePart si NO es Word (Gemini no soporta Word)
          console.log(`[Chat] 📄 Agregando filePart`);
          content.push(filePart);
        } else if (isWordDocument) {
          // Para Word, el contenido ya fue extraído y las imágenes guardadas por separado
          // No enviamos el archivo original porque Gemini no lo soporta
          console.log(`[Chat] 📝 Archivo Word detectado - omitiendo (contenido extraído en frontend)`);
        }
      } catch (error) {
        console.error(`[Chat] Error obteniendo archivo ${fId}:`, error);
      }
    }
    
    // Agregar texto si existe
    if (prompt.trim()) {
      content.push({ type: "text", text: prompt });
    }
    
    // Si no hay contenido, lanzar error
    if (content.length === 0) {
      throw new Error("El mensaje debe contener texto o archivo");
    }
    
    // Guardar el mensaje del usuario
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      message: { 
        role: "user", 
        content
      },
      metadata:
        allFileIds.length > 0
          ? {
              fileIds: allFileIds,
              ...(hasAudioInput ? { hasAudioInput: true } : {}),
            }
          : undefined,
    });
    
    console.log(`[Chat] ✅ Mensaje guardado: ${messageId}`);
    
    // Disparar generación de respuesta asíncrona
    await ctx.scheduler.runAfter(0, internal.messaging.chatGenerate.generateResponseAsync, {
      threadId,
      promptMessageId: messageId,
    });
    
    return { messageId };
  },
});

// Listar mensajes de un thread (con soporte para streaming deltas)
export const listThreadMessages = query({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return {
        page: [],
        isDone: true,
        continueCursor: "",
        streams: undefined,
      };
    }

    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    if (!chatThread || chatThread.userId !== userId) {
      return {
        page: [],
        isDone: true,
        continueCursor: "",
        streams: undefined,
      };
    }

    // Obtener mensajes regulares (no-streaming)
    const paginated = await listUIMessages(ctx, components.agent, args);

    // Sincronizar deltas de streaming activos para este thread
    const streams = await syncStreams(ctx, components.agent, args);

    return { ...paginated, streams };
  },
});

// Listar todos los threads de chat del usuario (para historial)
export const listChatThreads = query({
  args: {},
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const threads = await ctx.db
      .query("chatThreads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    
    return threads;
  },
});

// Obtener el thread de chat asociado a un threadId específico
export const getChatThreadInfo = query({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    if (!chatThread || chatThread.userId !== userId) {
      return null;
    }
    
    return chatThread;
  },
});
