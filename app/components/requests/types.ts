import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";

export type ExternalRequest = FunctionReturnType<typeof api.data.tasks.listMyExternalRequests>[number];
export type FilterOption = { key: string; label: string };
export type BoardStage = { key: string; label: string; subtitle: string; accent: string; cardAccent: string };

