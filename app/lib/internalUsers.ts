import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

// Keep the UI contract aligned with the Convex query without duplicating it.
export type InternalUsersDashboard = Extract<
  FunctionReturnType<typeof api.data.internalUserAdmin.getDashboard>,
  { canAccess: true }
>;
export type InternalUser = InternalUsersDashboard["users"][number];
export type InternalClient = InternalUsersDashboard["clients"][number];
export type InternalUserStatus = "active" | "inactive";

export type InternalUsersSummary = {
  completeUsers: number;
  missingCor: number;
  missingPermissions: number;
};

export type InternalUsersToast = {
  type: "success" | "error";
  message: string;
};

export function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export function getInitials(name: string, email: string) {
  const source = name || email || "U";
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function formatDateTime(timestamp: number) {
  return new Date(timestamp).toLocaleString("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
