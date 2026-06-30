import { isExcludedUserId } from "./excludedUsers";

const ROLLUP_SHARDS = 16;

type RollupScope = "global" | "client" | "brand" | "subBrand";

type ProjectSnapshot = {
  _id?: unknown;
  convexStatus?: "active" | "deleted";
  createdBy?: unknown;
  deliverables?: number;
  clientId?: unknown;
  corClientId?: number;
  clientBrandId?: unknown;
  brandId?: number;
  subBrandId?: unknown;
  productId?: number;
};

type RollupDimensions = {
  scope: RollupScope;
  clientId?: unknown;
  corClientId?: number;
  clientBrandId?: unknown;
  brandId?: number;
  subBrandId?: unknown;
  productId?: number;
};

type RollupContribution = RollupDimensions & {
  rollupKey: string;
  shard: number;
  deliverables: number;
};

type RollupDelta = RollupContribution & {
  deliverablesDelta: number;
  projectCountDelta: number;
};

function positiveDeliverables(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : 0;
}

function hashShard(projectId: unknown) {
  const value = String(projectId ?? "");
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash % ROLLUP_SHARDS;
}

function dimensionKey(value: unknown) {
  return value === undefined || value === null ? "-" : String(value);
}

function buildRollupKey(dimensions: RollupDimensions, shard: number) {
  return [
    dimensions.scope,
    shard,
    dimensionKey(dimensions.clientId),
    dimensionKey(dimensions.clientBrandId),
    dimensionKey(dimensions.subBrandId),
  ].join("|");
}

function getDimensions(project: ProjectSnapshot): RollupDimensions[] {
  const dimensions: RollupDimensions[] = [{ scope: "global" }];

  if (project.clientId) {
    dimensions.push({
      scope: "client",
      clientId: project.clientId,
      corClientId: project.corClientId,
    });
  }

  if (project.clientBrandId) {
    dimensions.push({
      scope: "brand",
      clientId: project.clientId,
      corClientId: project.corClientId,
      clientBrandId: project.clientBrandId,
      brandId: project.brandId,
    });
  }

  if (project.subBrandId) {
    dimensions.push({
      scope: "subBrand",
      clientId: project.clientId,
      corClientId: project.corClientId,
      clientBrandId: project.clientBrandId,
      brandId: project.brandId,
      subBrandId: project.subBrandId,
      productId: project.productId,
    });
  }

  return dimensions;
}

function getContributions(project?: ProjectSnapshot | null): RollupContribution[] {
  if (!project || project.convexStatus === "deleted") return [];
  if (isExcludedUserId(project.createdBy)) return [];

  const deliverables = positiveDeliverables(project.deliverables);
  if (deliverables === 0) return [];

  const shard = hashShard(project._id);
  return getDimensions(project).map((dimensions) => ({
    ...dimensions,
    rollupKey: buildRollupKey(dimensions, shard),
    shard,
    deliverables,
  }));
}

function addDelta(
  deltas: Map<string, RollupDelta>,
  contribution: RollupContribution,
  direction: 1 | -1,
) {
  const existing = deltas.get(contribution.rollupKey);
  if (existing) {
    existing.deliverablesDelta += contribution.deliverables * direction;
    existing.projectCountDelta += direction;
    return;
  }

  deltas.set(contribution.rollupKey, {
    ...contribution,
    deliverablesDelta: contribution.deliverables * direction,
    projectCountDelta: direction,
  });
}

export async function applyProjectDeliverablesDelta(
  ctx: any,
  beforeProject: ProjectSnapshot | null | undefined,
  afterProject: ProjectSnapshot | null | undefined,
) {
  const deltas = new Map<string, RollupDelta>();

  for (const contribution of getContributions(beforeProject)) {
    addDelta(deltas, contribution, -1);
  }
  for (const contribution of getContributions(afterProject)) {
    addDelta(deltas, contribution, 1);
  }

  const now = Date.now();
  for (const delta of deltas.values()) {
    if (delta.deliverablesDelta === 0 && delta.projectCountDelta === 0) {
      continue;
    }

    const existing = await ctx.db
      .query("deliverableAnalyticsRollups")
      .withIndex("by_key", (q: any) => q.eq("rollupKey", delta.rollupKey))
      .unique();

    if (!existing) {
      if (delta.deliverablesDelta <= 0 || delta.projectCountDelta <= 0) {
        continue;
      }

      await ctx.db.insert("deliverableAnalyticsRollups", {
        rollupKey: delta.rollupKey,
        scope: delta.scope,
        shard: delta.shard,
        clientId: delta.clientId,
        corClientId: delta.corClientId,
        clientBrandId: delta.clientBrandId,
        brandId: delta.brandId,
        subBrandId: delta.subBrandId,
        productId: delta.productId,
        deliverablesTotal: delta.deliverablesDelta,
        projectCount: delta.projectCountDelta,
        updatedAt: now,
      });
      continue;
    }

    const deliverablesTotal = existing.deliverablesTotal + delta.deliverablesDelta;
    const projectCount = existing.projectCount + delta.projectCountDelta;

    await ctx.db.patch(existing._id, {
      deliverablesTotal,
      projectCount,
      updatedAt: now,
    });
  }
}
