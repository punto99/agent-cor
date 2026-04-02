// convex/lib/llmFallback.ts
// Sistema de fallback para LLMs: Gemini -> OpenAI GPT
// Si Gemini falla, automáticamente usa GPT-5.2 como respaldo

import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

// ==================== TIPOS ====================

export type LLMProvider = "gemini" | "openai";

export interface LLMConfig {
  provider: LLMProvider;
  model: LanguageModel;
  modelId: string;
  providerOptions?: Record<string, unknown>;
}

export interface LLMError {
  provider: LLMProvider;
  model: string;
  errorType: "rate_limit" | "high_demand" | "timeout" | "unknown";
  errorMessage: string;
  timestamp: number;
}

export interface LLMHealthCheckResult {
  provider: LLMProvider;
  available: boolean;
  reason?: string;
}

// ==================== CONFIGURACIÓN DE MODELOS ====================

// Modelo principal: Gemini 3 Pro Preview
export const geminiConfig: LLMConfig = {
  provider: "gemini",
  model: google("gemini-3.1-pro-preview"),
  modelId: "gemini-3.1-pro-preview",
  providerOptions: {
    google: {
      thinkingConfig: {
        thinkingLevel: "low", // Reducir latencia
      },
    },
  },
};

// Modelo fallback: OpenAI GPT-5.2
export const openaiConfig: LLMConfig = {
  provider: "openai",
  model: openai("gpt-5.2"),
  modelId: "gpt-5.2",
  providerOptions: undefined,
};

// ==================== UTILIDADES ====================

/**
 * Clasifica el tipo de error basándose en el mensaje
 */
export function classifyError(error: unknown): LLMError["errorType"] {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = errorMessage.toLowerCase();
  
  if (lowerMessage.includes("high demand") || lowerMessage.includes("rate limit") || lowerMessage.includes("quota")) {
    return "rate_limit";
  }
  if (lowerMessage.includes("experiencing high demand") || lowerMessage.includes("overloaded")) {
    return "high_demand";
  }
  if (lowerMessage.includes("timeout") || lowerMessage.includes("timed out")) {
    return "timeout";
  }
  return "unknown";
}

/**
 * Extrae el mensaje de error de forma segura
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Determina si un error es recuperable (vale la pena hacer fallback)
 */
export function isRecoverableError(error: unknown): boolean {
  const errorType = classifyError(error);
  // Todos estos errores son recuperables con un fallback
  return ["rate_limit", "high_demand", "timeout"].includes(errorType);
}

// ==================== OBTENER CONFIGURACIÓN ====================

/**
 * Obtiene la configuración del modelo primario (Gemini)
 */
export function getPrimaryConfig(): LLMConfig {
  return geminiConfig;
}

/**
 * Obtiene la configuración del modelo fallback (OpenAI)
 */
export function getFallbackConfig(): LLMConfig {
  return openaiConfig;
}

/**
 * Log helper para debugging
 */
export function logLLMAttempt(provider: LLMProvider, model: string, success: boolean, durationMs?: number) {
  const status = success ? "✅" : "❌";
  const duration = durationMs ? ` (${durationMs}ms)` : "";
  console.log(`[LLM] ${status} ${provider}/${model}${duration}`);
}

// ==================== WRAPPER DE FALLBACK ====================

/**
 * Datos del error LLM para logging vía ctx.runMutation
 */
export interface LLMErrorLog {
  provider: LLMProvider;
  model: string;
  agentName: string;
  errorType: LLMError["errorType"];
  errorMessage: string;
  threadId: string;
  resolved: boolean;
  fallbackUsed: string | undefined;
}

/**
 * Opciones para withLLMFallback
 */
export interface LLMFallbackOptions<T> {
  /** Nombre del agente para logging */
  agentName: string;
  /** Thread ID para contexto de error */
  threadId: string;
  /** Si Gemini está habilitado (consultar vía llmConfig.isProviderEnabled) */
  geminiEnabled: boolean;
  /** Si OpenAI está habilitado (consultar vía llmConfig.isProviderEnabled) */
  openaiEnabled: boolean;
  /** Función que ejecuta el LLM con el modelo primario (Gemini) */
  primaryFn: () => Promise<T>;
  /** Función que ejecuta el LLM con el modelo fallback (OpenAI) */
  fallbackFn: () => Promise<T>;
  /** Callback para persistir errores LLM (ej: ctx.runMutation(internal.data.llmConfig.logLLMError, log)) */
  logError?: (log: LLMErrorLog) => Promise<void>;
  /** Mensaje de error cuando ambos proveedores fallan */
  onBothFailed?: string;
}

/**
 * Resultado de withLLMFallback
 */
export interface LLMFallbackResult<T> {
  /** Resultado de la operación */
  result: T;
  /** Provider que se usó */
  provider: LLMProvider;
  /** Si el primario falló y se usó fallback */
  usedFallback: boolean;
}

/**
 * Ejecuta una operación LLM con fallback automático: Gemini → OpenAI.
 * 
 * Maneja: timing, logging, clasificación de errores, y reporte de fallback.
 * El caller solo necesita proveer las funciones primary/fallback y el callback de log.
 *
 * Ejemplo de uso:
 * ```
 * const { result, provider } = await withLLMFallback({
 *   agentName: "evaluatorAgent",
 *   threadId,
 *   geminiEnabled, openaiEnabled,
 *   primaryFn: () => generateText({ ...args, model: geminiConfig.model }),
 *   fallbackFn: () => generateText({ ...args, model: openaiConfig.model }),
 *   logError: async (log) => ctx.runMutation(internal.data.llmConfig.logLLMError, log),
 * });
 * ```
 */
export async function withLLMFallback<T>(
  opts: LLMFallbackOptions<T>
): Promise<LLMFallbackResult<T>> {
  const { agentName, threadId, logError } = opts;
  let primaryError: Error | null = null;

  // 1. Intentar con el modelo primario (Gemini)
  if (opts.geminiEnabled) {
    const start = Date.now();
    try {
      const result = await opts.primaryFn();
      logLLMAttempt(geminiConfig.provider, geminiConfig.modelId, true, Date.now() - start);
      return { result, provider: "gemini", usedFallback: false };
    } catch (err) {
      primaryError = err instanceof Error ? err : new Error(String(err));
      logLLMAttempt(geminiConfig.provider, geminiConfig.modelId, false, Date.now() - start);
      console.error(`[${agentName}] ⚠️ Gemini falló: ${extractErrorMessage(err)}`);

      if (logError) {
        await logError({
          provider: geminiConfig.provider,
          model: geminiConfig.modelId,
          agentName,
          errorType: classifyError(err),
          errorMessage: extractErrorMessage(err),
          threadId,
          resolved: false,
          fallbackUsed: undefined,
        });
      }
    }
  }

  // 2. Fallback al modelo secundario (OpenAI)
  if (opts.openaiEnabled) {
    const start = Date.now();
    console.log(`[${agentName}] 🔄 Intentando con OpenAI (fallback)...`);
    try {
      const result = await opts.fallbackFn();
      logLLMAttempt(openaiConfig.provider, openaiConfig.modelId, true, Date.now() - start);

      // Marcar el error de Gemini como resuelto con fallback
      if (primaryError && logError) {
        await logError({
          provider: geminiConfig.provider,
          model: geminiConfig.modelId,
          agentName,
          errorType: classifyError(primaryError),
          errorMessage: extractErrorMessage(primaryError),
          threadId,
          resolved: true,
          fallbackUsed: openaiConfig.modelId,
        });
      }

      return { result, provider: "openai", usedFallback: true };
    } catch (err) {
      logLLMAttempt(openaiConfig.provider, openaiConfig.modelId, false, Date.now() - start);
      console.error(`[${agentName}] ❌ OpenAI también falló: ${extractErrorMessage(err)}`);

      if (logError) {
        await logError({
          provider: openaiConfig.provider,
          model: openaiConfig.modelId,
          agentName,
          errorType: classifyError(err),
          errorMessage: extractErrorMessage(err),
          threadId,
          resolved: false,
          fallbackUsed: undefined,
        });
      }
    }
  }

  // 3. Ambos fallaron
  throw new Error(
    opts.onBothFailed || `[${agentName}] Ambos proveedores LLM fallaron`
  );
}
