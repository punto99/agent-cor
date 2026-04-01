"use node";

// convex/agents/priorityAgent.ts
// Agente clasificador de prioridades estratégicas
// Clasifica tareas en cuadrantes: I_U, I_NU, NI_U, NI_NU
// Usa generateObject (output estructurado) — no necesita Agent instance ni threads

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { z } from "zod";
import { getPriorityAgentInstructions } from "../lib/serverConfig";
import {
  geminiConfig,
  openaiConfig,
  classifyError,
  extractErrorMessage,
  logLLMAttempt,
} from "../lib/llmFallback";

// Schema de respuesta — garantiza output válido
const prioritySchema = z.object({
  priority: z.enum(["I_U", "I_NU", "NI_U", "NI_NU"]),
});

/**
 * Construye el prompt con toda la información de la tarea
 * para que el LLM tenga contexto completo al clasificar.
 */
function buildTaskPrompt(args: {
  title: string;
  requestType: string;
  brand: string;
  objective?: string;
  keyMessage?: string;
  kpis?: string;
  deadline?: string;
  budget?: string;
  approvers?: string;
}): string {
  const parts: string[] = [];
  parts.push(`Título: ${args.title}`);
  parts.push(`Tipo de requerimiento: ${args.requestType}`);
  parts.push(`Marca: ${args.brand}`);
  if (args.objective) parts.push(`Objetivo: ${args.objective}`);
  if (args.keyMessage) parts.push(`Mensaje clave: ${args.keyMessage}`);
  if (args.kpis) parts.push(`KPIs: ${args.kpis}`);
  if (args.deadline) parts.push(`Deadline: ${args.deadline}`);
  if (args.budget) parts.push(`Presupuesto: ${args.budget}`);
  if (args.approvers) parts.push(`Aprobadores: ${args.approvers}`);

  return `Clasifica la siguiente tarea:\n\n${parts.join("\n")}`;
}

// ==================== ACTION: Clasificar Prioridad ====================

export const classifyPriorityAction = internalAction({
  args: {
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
  handler: async (ctx, args): Promise<string> => {
    const startTime = Date.now();
    console.log("[PriorityAgent] 🎯 Clasificando prioridad estratégica...");

    const { generateObject } = await import("ai");

    const systemPrompt = getPriorityAgentInstructions();
    const userPrompt = buildTaskPrompt(args);

    // Verificar qué proveedores están habilitados
    const geminiEnabled = await ctx.runQuery(internal.data.llmConfig.isProviderEnabled, { provider: "gemini" });
    const openaiEnabled = await ctx.runQuery(internal.data.llmConfig.isProviderEnabled, { provider: "openai" });

    let result: z.infer<typeof prioritySchema> | null = null;
    let usedProvider: "gemini" | "openai" | null = null;

    // Intento 1: Gemini
    if (geminiEnabled) {
      const geminiStart = Date.now();
      console.log("[PriorityAgent] 📍 Intentando con Gemini...");

      try {
        const response = await generateObject({
          model: geminiConfig.model,
          providerOptions: geminiConfig.providerOptions as any,
          schema: prioritySchema,
          system: systemPrompt,
          prompt: userPrompt,
          maxRetries: 0,
        });

        result = response.object;
        usedProvider = "gemini";
        logLLMAttempt(geminiConfig.provider, geminiConfig.modelId, true, Date.now() - geminiStart);
      } catch (error) {
        logLLMAttempt(geminiConfig.provider, geminiConfig.modelId, false, Date.now() - geminiStart);
        console.error(`[PriorityAgent] ❌ Gemini falló: ${extractErrorMessage(error)}`);

        await ctx.runMutation(internal.data.llmConfig.logLLMError, {
          provider: geminiConfig.provider,
          model: geminiConfig.modelId,
          agentName: "priorityAgent",
          errorType: classifyError(error),
          errorMessage: extractErrorMessage(error),
          resolved: false,
          fallbackUsed: undefined,
        });
      }
    }

    // Intento 2: Fallback a OpenAI
    if (!result && openaiEnabled) {
      const openaiStart = Date.now();
      console.log("[PriorityAgent] 📍 Fallback a OpenAI...");

      try {
        const response = await generateObject({
          model: openaiConfig.model,
          schema: prioritySchema,
          system: systemPrompt,
          prompt: userPrompt,
          maxRetries: 0,
        });

        result = response.object;
        usedProvider = "openai";
        logLLMAttempt(openaiConfig.provider, openaiConfig.modelId, true, Date.now() - openaiStart);
      } catch (error) {
        logLLMAttempt(openaiConfig.provider, openaiConfig.modelId, false, Date.now() - openaiStart);
        console.error(`[PriorityAgent] ❌ OpenAI falló: ${extractErrorMessage(error)}`);

        await ctx.runMutation(internal.data.llmConfig.logLLMError, {
          provider: openaiConfig.provider,
          model: openaiConfig.modelId,
          agentName: "priorityAgent",
          errorType: classifyError(error),
          errorMessage: extractErrorMessage(error),
          resolved: false,
          fallbackUsed: undefined,
        });
      }
    }

    // Si ambos fallan, retornar null (la task se crea sin clasificación)
    if (!result) {
      console.error("[PriorityAgent] ❌ Todos los proveedores fallaron. Task se creará sin clasificación.");
      return "";
    }

    const totalTime = Date.now() - startTime;
    console.log(`[PriorityAgent] ✅ Clasificación: ${result.priority} (${usedProvider}, ${totalTime}ms)`);

    return result.priority;
  },
});
