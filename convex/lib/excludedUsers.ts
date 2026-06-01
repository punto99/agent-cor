import { clientConfig } from "../../config/tenant.config";

const excludedUserIdSet = new Set(
  clientConfig.excludedUserIds.map((userId) => String(userId)),
);

export function isExcludedUserId(userId: unknown) {
  if (userId === null || userId === undefined) return false;
  const normalized = String(userId).trim();
  return normalized.length > 0 && excludedUserIdSet.has(normalized);
}

