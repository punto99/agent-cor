// Agente de brief para clientes externos aprobados.
// Crea proyectos/tasks locales en Convex sin publicar en COR.
import { Agent } from "@convex-dev/agent";
import { components } from "../_generated/api";
import { google } from "@ai-sdk/google";
import {
  createExternalTaskTool,
  listAccessibleBrandsTool,
  reviewBriefTool,
  nowTool,
  validateExternalUserForBrandTool,
} from "../tools";
import { agentConfig, getExternalBriefAgentInstructions } from "../lib/serverConfig";

const languageModel = google("gemini-3.5-flash");

export const externalBriefAgent = new Agent(components.agent, {
  name: agentConfig.externalBrief.name,
  instructions: getExternalBriefAgentInstructions(),

  languageModel,

  tools: {
    listAccessibleBrands: listAccessibleBrandsTool,
    validateExternalUserForBrand: validateExternalUserForBrandTool,
    reviewBrief: reviewBriefTool,
    createExternalTask: createExternalTaskTool,
    now: nowTool,
  },

  maxSteps: 8,

  contextOptions: {
    recentMessages: 100,
  },
});
