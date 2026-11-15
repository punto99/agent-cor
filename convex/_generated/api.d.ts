/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents_agent from "../agents/agent.js";
import type * as agents_documentSearchAgent from "../agents/documentSearchAgent.js";
import type * as agents_evaluatorAgentAction from "../agents/evaluatorAgentAction.js";
import type * as agents_evaluatorFilePreparation from "../agents/evaluatorFilePreparation.js";
import type * as agents_externalBriefAgent from "../agents/externalBriefAgent.js";
import type * as agents_orchestratorAgent from "../agents/orchestratorAgent.js";
import type * as agents_priorityAgent from "../agents/priorityAgent.js";
import type * as agents_reviewerAgent from "../agents/reviewerAgent.js";
import type * as analytics_calendar from "../analytics/calendar.js";
import type * as analytics_deliverables from "../analytics/deliverables.js";
import type * as analytics_jobs from "../analytics/jobs.js";
import type * as analytics_maintenance from "../analytics/maintenance.js";
import type * as analytics_notify from "../analytics/notify.js";
import type * as analytics_projection from "../analytics/projection.js";
import type * as analytics_tables from "../analytics/tables.js";
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as data_analytics from "../data/analytics.js";
import type * as data_approvedExternalUsers from "../data/approvedExternalUsers.js";
import type * as data_backfill from "../data/backfill.js";
import type * as data_clientAdmin from "../data/clientAdmin.js";
import type * as data_clientAdminActions from "../data/clientAdminActions.js";
import type * as data_clientAssignmentsDashboard from "../data/clientAssignmentsDashboard.js";
import type * as data_clientBrands from "../data/clientBrands.js";
import type * as data_clientKnowledge from "../data/clientKnowledge.js";
import type * as data_commentNotifications from "../data/commentNotifications.js";
import type * as data_controlPanel from "../data/controlPanel.js";
import type * as data_corClientRelatedUsersDashboard from "../data/corClientRelatedUsersDashboard.js";
import type * as data_corClients from "../data/corClients.js";
import type * as data_corInboundSync from "../data/corInboundSync.js";
import type * as data_corUsers from "../data/corUsers.js";
import type * as data_corUsersActions from "../data/corUsersActions.js";
import type * as data_evaluation from "../data/evaluation.js";
import type * as data_externalComments from "../data/externalComments.js";
import type * as data_externalTaskStatus from "../data/externalTaskStatus.js";
import type * as data_externalUserAdmin from "../data/externalUserAdmin.js";
import type * as data_externalUserAdminActions from "../data/externalUserAdminActions.js";
import type * as data_files from "../data/files.js";
import type * as data_internalUserAdmin from "../data/internalUserAdmin.js";
import type * as data_internalUserAdminActions from "../data/internalUserAdminActions.js";
import type * as data_llmConfig from "../data/llmConfig.js";
import type * as data_notificationHistory from "../data/notificationHistory.js";
import type * as data_permissions from "../data/permissions.js";
import type * as data_preferences from "../data/preferences.js";
import type * as data_projects from "../data/projects.js";
import type * as data_subBrands from "../data/subBrands.js";
import type * as data_taskCreationNotifications from "../data/taskCreationNotifications.js";
import type * as data_taskPanel from "../data/taskPanel.js";
import type * as data_taskPanelMedia from "../data/taskPanelMedia.js";
import type * as data_taskPanelSync from "../data/taskPanelSync.js";
import type * as data_taskStatusNotifications from "../data/taskStatusNotifications.js";
import type * as data_tasks from "../data/tasks.js";
import type * as data_trello from "../data/trello.js";
import type * as data_userAccess from "../data/userAccess.js";
import type * as data_users from "../data/users.js";
import type * as data_workspaces from "../data/workspaces.js";
import type * as http from "../http.js";
import type * as integrations_corProvider from "../integrations/corProvider.js";
import type * as integrations_noopProvider from "../integrations/noopProvider.js";
import type * as integrations_registry from "../integrations/registry.js";
import type * as integrations_trelloProvider from "../integrations/trelloProvider.js";
import type * as integrations_types from "../integrations/types.js";
import type * as lib_analyticsAccess from "../lib/analyticsAccess.js";
import type * as lib_authorName from "../lib/authorName.js";
import type * as lib_boardLabel from "../lib/boardLabel.js";
import type * as lib_briefFormat from "../lib/briefFormat.js";
import type * as lib_chatModelFileBudget from "../lib/chatModelFileBudget.js";
import type * as lib_commentNotifications from "../lib/commentNotifications.js";
import type * as lib_corRetry from "../lib/corRetry.js";
import type * as lib_deliverableAnalytics from "../lib/deliverableAnalytics.js";
import type * as lib_directExternalComments from "../lib/directExternalComments.js";
import type * as lib_excludedUsers from "../lib/excludedUsers.js";
import type * as lib_externalRequestsAccess from "../lib/externalRequestsAccess.js";
import type * as lib_externalUserPreapproval from "../lib/externalUserPreapproval.js";
import type * as lib_internalUserAdminAccess from "../lib/internalUserAdminAccess.js";
import type * as lib_internalUserStatus from "../lib/internalUserStatus.js";
import type * as lib_llmFallback from "../lib/llmFallback.js";
import type * as lib_math from "../lib/math.js";
import type * as lib_registerStoredAgentFile from "../lib/registerStoredAgentFile.js";
import type * as lib_serverConfig from "../lib/serverConfig.js";
import type * as lib_speechToText from "../lib/speechToText.js";
import type * as lib_taskCreationNotifications from "../lib/taskCreationNotifications.js";
import type * as lib_taskMentions from "../lib/taskMentions.js";
import type * as lib_taskPanelComment from "../lib/taskPanelComment.js";
import type * as lib_taskStatusNotifications from "../lib/taskStatusNotifications.js";
import type * as lib_taskStatuses from "../lib/taskStatuses.js";
import type * as lib_trelloCommentFormat from "../lib/trelloCommentFormat.js";
import type * as lib_trelloPolicy from "../lib/trelloPolicy.js";
import type * as lib_userRoles from "../lib/userRoles.js";
import type * as messaging_chat from "../messaging/chat.js";
import type * as messaging_chatGenerate from "../messaging/chatGenerate.js";
import type * as messaging_threadTitle from "../messaging/threadTitle.js";
import type * as messaging_threads from "../messaging/threads.js";
import type * as rag_entityImages from "../rag/entityImages.js";
import type * as rag_rag from "../rag/rag.js";
import type * as rag_ragDocuments from "../rag/ragDocuments.js";
import type * as rag_ragPages from "../rag/ragPages.js";
import type * as rag_ragSearch from "../rag/ragSearch.js";
import type * as rag_ragTools from "../rag/ragTools.js";
import type * as taskPanelMediaHttp from "../taskPanelMediaHttp.js";
import type * as taskPanelUpload from "../taskPanelUpload.js";
import type * as tools_attachFileToTaskTool from "../tools/attachFileToTaskTool.js";
import type * as tools_createExternalTaskTool from "../tools/createExternalTaskTool.js";
import type * as tools_createTaskTool from "../tools/createTaskTool.js";
import type * as tools_editExternalTaskTool from "../tools/editExternalTaskTool.js";
import type * as tools_editProjectTool from "../tools/editProjectTool.js";
import type * as tools_editTaskTool from "../tools/editTaskTool.js";
import type * as tools_getClientKnowledgeTool from "../tools/getClientKnowledgeTool.js";
import type * as tools_getExternalTaskStatusTool from "../tools/getExternalTaskStatusTool.js";
import type * as tools_getProjectTool from "../tools/getProjectTool.js";
import type * as tools_getTaskFromCORTool from "../tools/getTaskFromCORTool.js";
import type * as tools_getTaskTool from "../tools/getTaskTool.js";
import type * as tools_index from "../tools/index.js";
import type * as tools_listAccessibleBrandsTool from "../tools/listAccessibleBrandsTool.js";
import type * as tools_nowTool from "../tools/nowTool.js";
import type * as tools_reviewBriefTool from "../tools/reviewBriefTool.js";
import type * as tools_reviewExternalBriefTool from "../tools/reviewExternalBriefTool.js";
import type * as tools_searchClientInCORTool from "../tools/searchClientInCORTool.js";
import type * as tools_validateExternalUserForBrandTool from "../tools/validateExternalUserForBrandTool.js";
import type * as tools_validateUserForClientTool from "../tools/validateUserForClientTool.js";
import type * as workflows_index from "../workflows/index.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "agents/agent": typeof agents_agent;
  "agents/documentSearchAgent": typeof agents_documentSearchAgent;
  "agents/evaluatorAgentAction": typeof agents_evaluatorAgentAction;
  "agents/evaluatorFilePreparation": typeof agents_evaluatorFilePreparation;
  "agents/externalBriefAgent": typeof agents_externalBriefAgent;
  "agents/orchestratorAgent": typeof agents_orchestratorAgent;
  "agents/priorityAgent": typeof agents_priorityAgent;
  "agents/reviewerAgent": typeof agents_reviewerAgent;
  "analytics/calendar": typeof analytics_calendar;
  "analytics/deliverables": typeof analytics_deliverables;
  "analytics/jobs": typeof analytics_jobs;
  "analytics/maintenance": typeof analytics_maintenance;
  "analytics/notify": typeof analytics_notify;
  "analytics/projection": typeof analytics_projection;
  "analytics/tables": typeof analytics_tables;
  auth: typeof auth;
  crons: typeof crons;
  "data/analytics": typeof data_analytics;
  "data/approvedExternalUsers": typeof data_approvedExternalUsers;
  "data/backfill": typeof data_backfill;
  "data/clientAdmin": typeof data_clientAdmin;
  "data/clientAdminActions": typeof data_clientAdminActions;
  "data/clientAssignmentsDashboard": typeof data_clientAssignmentsDashboard;
  "data/clientBrands": typeof data_clientBrands;
  "data/clientKnowledge": typeof data_clientKnowledge;
  "data/commentNotifications": typeof data_commentNotifications;
  "data/controlPanel": typeof data_controlPanel;
  "data/corClientRelatedUsersDashboard": typeof data_corClientRelatedUsersDashboard;
  "data/corClients": typeof data_corClients;
  "data/corInboundSync": typeof data_corInboundSync;
  "data/corUsers": typeof data_corUsers;
  "data/corUsersActions": typeof data_corUsersActions;
  "data/evaluation": typeof data_evaluation;
  "data/externalComments": typeof data_externalComments;
  "data/externalTaskStatus": typeof data_externalTaskStatus;
  "data/externalUserAdmin": typeof data_externalUserAdmin;
  "data/externalUserAdminActions": typeof data_externalUserAdminActions;
  "data/files": typeof data_files;
  "data/internalUserAdmin": typeof data_internalUserAdmin;
  "data/internalUserAdminActions": typeof data_internalUserAdminActions;
  "data/llmConfig": typeof data_llmConfig;
  "data/notificationHistory": typeof data_notificationHistory;
  "data/permissions": typeof data_permissions;
  "data/preferences": typeof data_preferences;
  "data/projects": typeof data_projects;
  "data/subBrands": typeof data_subBrands;
  "data/taskCreationNotifications": typeof data_taskCreationNotifications;
  "data/taskPanel": typeof data_taskPanel;
  "data/taskPanelMedia": typeof data_taskPanelMedia;
  "data/taskPanelSync": typeof data_taskPanelSync;
  "data/taskStatusNotifications": typeof data_taskStatusNotifications;
  "data/tasks": typeof data_tasks;
  "data/trello": typeof data_trello;
  "data/userAccess": typeof data_userAccess;
  "data/users": typeof data_users;
  "data/workspaces": typeof data_workspaces;
  http: typeof http;
  "integrations/corProvider": typeof integrations_corProvider;
  "integrations/noopProvider": typeof integrations_noopProvider;
  "integrations/registry": typeof integrations_registry;
  "integrations/trelloProvider": typeof integrations_trelloProvider;
  "integrations/types": typeof integrations_types;
  "lib/analyticsAccess": typeof lib_analyticsAccess;
  "lib/authorName": typeof lib_authorName;
  "lib/boardLabel": typeof lib_boardLabel;
  "lib/briefFormat": typeof lib_briefFormat;
  "lib/chatModelFileBudget": typeof lib_chatModelFileBudget;
  "lib/commentNotifications": typeof lib_commentNotifications;
  "lib/corRetry": typeof lib_corRetry;
  "lib/deliverableAnalytics": typeof lib_deliverableAnalytics;
  "lib/directExternalComments": typeof lib_directExternalComments;
  "lib/excludedUsers": typeof lib_excludedUsers;
  "lib/externalRequestsAccess": typeof lib_externalRequestsAccess;
  "lib/externalUserPreapproval": typeof lib_externalUserPreapproval;
  "lib/internalUserAdminAccess": typeof lib_internalUserAdminAccess;
  "lib/internalUserStatus": typeof lib_internalUserStatus;
  "lib/llmFallback": typeof lib_llmFallback;
  "lib/math": typeof lib_math;
  "lib/registerStoredAgentFile": typeof lib_registerStoredAgentFile;
  "lib/serverConfig": typeof lib_serverConfig;
  "lib/speechToText": typeof lib_speechToText;
  "lib/taskCreationNotifications": typeof lib_taskCreationNotifications;
  "lib/taskMentions": typeof lib_taskMentions;
  "lib/taskPanelComment": typeof lib_taskPanelComment;
  "lib/taskStatusNotifications": typeof lib_taskStatusNotifications;
  "lib/taskStatuses": typeof lib_taskStatuses;
  "lib/trelloCommentFormat": typeof lib_trelloCommentFormat;
  "lib/trelloPolicy": typeof lib_trelloPolicy;
  "lib/userRoles": typeof lib_userRoles;
  "messaging/chat": typeof messaging_chat;
  "messaging/chatGenerate": typeof messaging_chatGenerate;
  "messaging/threadTitle": typeof messaging_threadTitle;
  "messaging/threads": typeof messaging_threads;
  "rag/entityImages": typeof rag_entityImages;
  "rag/rag": typeof rag_rag;
  "rag/ragDocuments": typeof rag_ragDocuments;
  "rag/ragPages": typeof rag_ragPages;
  "rag/ragSearch": typeof rag_ragSearch;
  "rag/ragTools": typeof rag_ragTools;
  taskPanelMediaHttp: typeof taskPanelMediaHttp;
  taskPanelUpload: typeof taskPanelUpload;
  "tools/attachFileToTaskTool": typeof tools_attachFileToTaskTool;
  "tools/createExternalTaskTool": typeof tools_createExternalTaskTool;
  "tools/createTaskTool": typeof tools_createTaskTool;
  "tools/editExternalTaskTool": typeof tools_editExternalTaskTool;
  "tools/editProjectTool": typeof tools_editProjectTool;
  "tools/editTaskTool": typeof tools_editTaskTool;
  "tools/getClientKnowledgeTool": typeof tools_getClientKnowledgeTool;
  "tools/getExternalTaskStatusTool": typeof tools_getExternalTaskStatusTool;
  "tools/getProjectTool": typeof tools_getProjectTool;
  "tools/getTaskFromCORTool": typeof tools_getTaskFromCORTool;
  "tools/getTaskTool": typeof tools_getTaskTool;
  "tools/index": typeof tools_index;
  "tools/listAccessibleBrandsTool": typeof tools_listAccessibleBrandsTool;
  "tools/nowTool": typeof tools_nowTool;
  "tools/reviewBriefTool": typeof tools_reviewBriefTool;
  "tools/reviewExternalBriefTool": typeof tools_reviewExternalBriefTool;
  "tools/searchClientInCORTool": typeof tools_searchClientInCORTool;
  "tools/validateExternalUserForBrandTool": typeof tools_validateExternalUserForBrandTool;
  "tools/validateUserForClientTool": typeof tools_validateUserForClientTool;
  "workflows/index": typeof workflows_index;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
  rag: import("@convex-dev/rag/_generated/component.js").ComponentApi<"rag">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
