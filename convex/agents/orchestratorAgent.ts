// convex/agents/orchestratorAgent.ts
// Agente Orquestador — clasifica la intención del usuario y enruta al agente correcto
import { Agent } from "@convex-dev/agent";
import { components } from "../_generated/api";
import { google } from "@ai-sdk/google";
import { agentConfig, getOrchestratorAgentInstructions } from "../lib/serverConfig";

// Mismo modelo base que los demás agentes
const languageModel = google("gemini-3.5-flash");

// ==================== ORCHESTRATOR AGENT ====================
// - Sin tools — solo clasifica la intención del usuario
// - Usa generateObject() para obtener clasificación estructurada
// - storageOptions: { saveMessages: "none" } — NO visible al usuario
// - maxSteps: 1 — solo necesita una llamada LLM para clasificar

export const orchestratorAgent = new Agent(components.agent, {
  name: agentConfig.orchestrator.name,
  instructions: getOrchestratorAgentInstructions(),
  
  languageModel,
  
  tools: {},
  
  maxSteps: 1,
});
