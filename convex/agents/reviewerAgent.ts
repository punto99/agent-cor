// convex/reviewerAgent.ts
// Agente supervisor de calidad para revisar briefs
import { Agent } from "@convex-dev/agent";
import { components } from "../_generated/api";
import { google } from "@ai-sdk/google";
import { agentConfig, getReviewerAgentInstructions } from "../lib/serverConfig";

const languageModel = google("gemini-3.1-pro-preview");

// ==================== AGENTE SUPERVISOR: Quality Reviewer ====================
// Este agente revisa el trabajo del briefAgent y da feedback
// NO interactua con el usuario, solo con el briefAgent a traves del tool

export const reviewerAgent = new Agent(components.agent, {
  name: agentConfig.reviewer.name,
  instructions: getReviewerAgentInstructions(),
  languageModel,
  tools: {},
  maxSteps: 3,
});
