"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { components, internal } from "../_generated/api";
import { listMessages } from "@convex-dev/agent";
import {
  extractErrorMessage,
  geminiConfig,
  openaiConfig,
  withLLMFallback,
} from "../lib/llmFallback";

const MAX_THREAD_TITLE_LENGTH = 45;
const TITLE_AGENT_NAME = "threadTitleGenerator";

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncateTitle(value: string, maxLength = MAX_THREAD_TITLE_LENGTH) {
  const clean = compactWhitespace(value);
  if (clean.length <= maxLength) return clean;

  const clipped = clean.slice(0, maxLength).trimEnd();
  const lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLength * 0.6)) {
    return clipped.slice(0, lastSpace).trimEnd();
  }
  return clipped;
}

function sanitizeGeneratedTitle(value: string) {
  const withoutLabel = value
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^t[ií]tulo\s*:\s*/i, "")
    .replace(/\s*[.!?。]+$/g, "");

  return truncateTitle(withoutLabel);
}

function fallbackTitle(task: any) {
  const title = typeof task?.title === "string" ? task.title : "";
  const brand =
    task?.subBrandName || task?.brandName || task?.corClientName || "";

  if (!brand) return truncateTitle(title || "Nuevo brief");

  const normalizedTitle = compactWhitespace(title);
  const normalizedBrand = compactWhitespace(String(brand));
  if (
    normalizedTitle
      .toLocaleLowerCase()
      .startsWith(normalizedBrand.toLocaleLowerCase())
  ) {
    return truncateTitle(normalizedTitle);
  }

  return truncateTitle(`${normalizedBrand} - ${normalizedTitle || "Brief"}`);
}

function extractTextPart(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part: any) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

async function getConversationContext(ctx: any, threadId: string) {
  try {
    const messagesResult = await listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    });

    return messagesResult.page
      .map((message: any) => {
        const role = message?.message?.role;
        if (role !== "user" && role !== "assistant") return "";
        const text = extractTextPart(message?.message?.content);
        return text ? `${role}: ${compactWhitespace(text)}` : "";
      })
      .filter(Boolean)
      .slice(-10)
      .join("\n")
      .slice(0, 2500);
  } catch (error) {
    console.log(
      `[ThreadTitle] No se pudo leer contexto del thread: ${extractErrorMessage(error)}`,
    );
    return "";
  }
}

function buildPrompt(task: any, conversationContext: string) {
  return `Genera un titulo corto para identificar un chat en un sidebar.

Reglas:
- Responde solo con el titulo, sin comillas ni explicaciones.
- Maximo ${MAX_THREAD_TITLE_LENGTH} caracteres.
- No uses fechas.
- No uses "Nuevo chat", "Nuevo brief" ni nombres genericos.
- Debe estar relacionado con el requerimiento creado.
- Prioriza marca/cliente + objetivo o entregable.
- Si hay categoria y marca, prioriza la marca.

Datos del requerimiento:
Cliente: ${task?.corClientName || "No especificado"}
Categoria: ${task?.brandName || "No especificada"}
Marca: ${task?.subBrandName || "No especificada"}
Titulo de task: ${task?.title || "No especificado"}
Brief:
${task?.description || "No especificado"}

Contexto reciente de la conversacion:
${conversationContext || "No disponible"}`;
}

export const generateAndApplyThreadTitle = internalAction({
  args: {
    threadId: v.string(),
    taskId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ updated: boolean; reason?: string; title?: string }> => {
    const task: any = await ctx.runQuery(
      internal.data.tasks.getTaskByIdInternal,
      {
        taskId: args.taskId,
      },
    );

    if (!task || task.threadId !== args.threadId) {
      console.log(
        `[ThreadTitle] Task no encontrada o no pertenece al thread ${args.threadId}`,
      );
      return { updated: false, reason: "task_not_found" };
    }

    const fallback = fallbackTitle(task);
    let title = fallback;

    try {
      const { generateText } = await import("ai");
      const [geminiEnabled, openaiEnabled] = await Promise.all([
        ctx.runQuery(internal.data.llmConfig.isProviderEnabled, {
          provider: "gemini",
        }),
        ctx.runQuery(internal.data.llmConfig.isProviderEnabled, {
          provider: "openai",
        }),
      ]);

      const conversationContext = await getConversationContext(
        ctx,
        args.threadId,
      );
      const prompt = buildPrompt(task, conversationContext);

      const { result, provider } = await withLLMFallback({
        agentName: TITLE_AGENT_NAME,
        threadId: args.threadId,
        geminiEnabled,
        openaiEnabled,
        timeoutMs: 30_000,
        primaryFn: (signal) =>
          generateText({
            model: geminiConfig.model,
            providerOptions: geminiConfig.providerOptions as any,
            prompt,
            maxRetries: 0,
            abortSignal: signal,
          }),
        fallbackFn: (signal) =>
          generateText({
            model: openaiConfig.model,
            prompt,
            maxRetries: 0,
            abortSignal: signal,
          }),
        logError: async (log) => {
          await ctx.runMutation(internal.data.llmConfig.logLLMError, log);
        },
        onBothFailed:
          "No se pudo generar el titulo del thread con proveedores LLM.",
      });

      const generated = sanitizeGeneratedTitle(result.text);
      if (generated) {
        title = generated;
      }
      console.log(`[ThreadTitle] Titulo generado con ${provider}: "${title}"`);
    } catch (error) {
      console.log(
        `[ThreadTitle] Usando fallback por error: ${extractErrorMessage(error)}`,
      );
    }

    const result: any = await ctx.runMutation(
      (internal as any).messaging.threads.updateThreadTitleInternal,
      {
        threadId: args.threadId,
        title,
      },
    );
    return result;
  },
});
