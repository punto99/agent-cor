import type { Id } from "@/convex/_generated/dataModel";

export interface FullTask {
  _id: Id<"tasks">;
  _creationTime: number;
  title: string;
  description?: string;
  deadline?: string;
  deliverablesCount?: number;
  priority?: number;
  strategicPriority?: "I_U" | "I_NU" | "NI_U" | "NI_NU";
  status: string;
  threadId: string;
  createdBy?: string;
  createdByName?: string;
  createdByEmail?: string;
  corTaskId?: string;
  corProjectId?: number;
  corSyncStatus?: string;
  corSyncError?: string;
  corSyncedAt?: number;
  corTaskMissingInCOR?: boolean;
  corProjectMissingInCOR?: boolean;
  corClientId?: number;
  corClientName?: string;
  corDescriptionHash?: string;
  lastLocalEditAt?: number;
  projectId?: Id<"projects">;
  source?: "internal" | "external";
  brandName?: string;
  clientBrandId?: Id<"clientBrands">;
  brandId?: number;
  subBrandId?: Id<"subBrands">;
  productId?: number;
  subBrandName?: string;
  trelloCardId?: string;
  trelloCardUrl?: string;
  trelloSyncStatus?: string;
  trelloSyncError?: string;
  trelloSyncedAt?: number;
}

export interface ControlPanelClient {
  client: {
    _id: Id<"corClients">;
    name: string;
    nomenclature?: string;
    corClientId: number;
  };
  brands: Array<{
    _id: Id<"clientBrands">;
    name: string;
    corBrandId: number;
    taskCount?: number;
  }>;
  taskCount: number;
  projectCount: number;
  projects: ControlPanelProjectGroup[];
}

export interface ControlPanelProjectGroup {
  project: {
    _id: Id<"projects"> | string;
    _creationTime?: number;
    name: string;
    status?: string;
    endDate?: string;
    source?: "internal" | "external";
  };
  tasks: FullTask[];
}

export type ControlPanelView = "cards" | "list";
export type ControlPanelPublicationTab = "all" | "cor" | "unpublished";

export type ControlPanelToastState = {
  type: "success" | "error";
  message: string;
};
