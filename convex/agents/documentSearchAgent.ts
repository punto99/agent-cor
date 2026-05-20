// convex/agents/documentSearchAgent.ts
// Agente de Búsqueda en Documentos — busca información en documentos/catálogos indexados
import { Agent } from "@convex-dev/agent";
import { components } from "../_generated/api";
import { google } from "@ai-sdk/google";
import { agentConfig, getDocumentSearchAgentInstructions } from "../lib/serverConfig";
import { searchDocumentsTool, searchEntitiesTool, getRAGStatisticsTool, searchByImageTool } from "../rag/ragTools";

// Mismo modelo base que los demás agentes
const languageModel = google("gemini-3.5-flash");

// ==================== DOCUMENT SEARCH AGENT ====================
// - Tools de RAG: searchDocuments, searchEntities, getRAGStatistics, searchByImage
// - Solo busca información — NO crea briefs ni tasks
// - maxSteps: 10 — permite búsquedas iterativas

export const documentSearchAgent = new Agent(components.agent, {
  name: agentConfig.documentSearch.name,
  instructions: getDocumentSearchAgentInstructions(),
  
  languageModel,
  
  tools: {
    searchDocuments: searchDocumentsTool,
    searchEntities: searchEntitiesTool,
    getRAGStatistics: getRAGStatisticsTool,
    searchByImage: searchByImageTool,
  },
  
  maxSteps: 10,
});
