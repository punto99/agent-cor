// convex/agent.ts
// Agente principal para recolección de Brief
import { Agent } from "@convex-dev/agent";
import { components } from "../_generated/api";
import { google } from "@ai-sdk/google";
import { createTaskTool, reviewBriefTool, editTaskTool, getTaskTool, nowTool, getTaskFromCORTool, searchClientInCORTool } from "../tools";
import { agentConfig, getBriefAgentInstructions } from "../lib/serverConfig";
import { isProjectManagementEnabled } from "../integrations/registry";

// Gemini model (thinking config is passed in providerOptions)
const languageModel = google("gemini-3.1-pro-preview");

// ==================== MAIN AGENT: Brief Collector ====================
// NOTA: Las RAG tools (searchDocuments, searchEntities, getRAGStatistics, searchByImage)
// fueron movidas al documentSearchAgent.ts como parte de la arquitectura multi-agente.

// Build tools object — conditionally include integration-specific tools
const agentTools: Record<string, any> = {
  createTask: createTaskTool,
  reviewBrief: reviewBriefTool,
  editTask: editTaskTool,
  getTask: getTaskTool,
  getTaskFromCOR: getTaskFromCORTool,
  now: nowTool,
};

// Conditionally add integration-specific tools
if (isProjectManagementEnabled()) {
  agentTools.searchClientInCOR = searchClientInCORTool;
}

export const briefAgent = new Agent(components.agent, {
  name: agentConfig.brief.name,
  instructions: getBriefAgentInstructions(),
  
  languageModel,
  
  tools: agentTools,
  
  maxSteps: 15,
});
