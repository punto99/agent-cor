type DbContext = {
  db: any;
};

export type PreapprovedClientAccess = {
  clientId: any;
  brandIds?: any[];
};

function assignmentKey(clientId: unknown, brandId?: unknown) {
  return brandId ? `${clientId}:${brandId}` : `${clientId}:*`;
}

export async function validatePreapprovedClientAccess(
  ctx: DbContext,
  args: {
    clientId: any;
    brandIds?: any[];
  },
): Promise<PreapprovedClientAccess[]> {
  const client = await ctx.db.get(args.clientId);
  if (!client) throw new Error("Selecciona un cliente válido.");

  const uniqueBrandIds = Array.from(
    new Set((args.brandIds ?? []).map(String)),
  );

  if (uniqueBrandIds.length === 0) {
    return [{ clientId: args.clientId }];
  }

  const brandIds = [];
  for (const brandIdString of uniqueBrandIds) {
    const brandId = ctx.db.normalizeId("clientBrands", brandIdString);
    if (!brandId) throw new Error("Una categoría seleccionada no es válida.");

    const brand = await ctx.db.get(brandId);
    if (!brand) throw new Error("Una categoría seleccionada ya no existe.");
    if (!brand.clientId || String(brand.clientId) !== String(args.clientId)) {
      throw new Error(
        `La categoría "${brand.name}" no pertenece al cliente seleccionado.`,
      );
    }

    brandIds.push(brandId);
  }

  return [{ clientId: args.clientId, brandIds }];
}

export async function syncClientAssignmentsFromAccess(
  ctx: DbContext,
  args: {
    userId: any;
    access: PreapprovedClientAccess[];
    assignedBy?: any;
    replaceAll?: boolean;
  },
) {
  const desired = new Map<
    string,
    {
      clientId: any;
      brandId?: any;
    }
  >();
  const managedClientIds = new Set<string>();
  const fullClientIds = new Set<string>();

  for (const entry of args.access) {
    const client = await ctx.db.get(entry.clientId);
    if (!client) continue;

    const clientKey = String(entry.clientId);
    managedClientIds.add(clientKey);
    if (!entry.brandIds || entry.brandIds.length === 0) {
      fullClientIds.add(clientKey);
      desired.set(assignmentKey(entry.clientId), {
        clientId: entry.clientId,
      });
    }
  }

  for (const entry of args.access) {
    const clientKey = String(entry.clientId);
    if (!managedClientIds.has(clientKey)) continue;
    if (fullClientIds.has(clientKey)) continue;

    for (const brandId of entry.brandIds ?? []) {
      const brand = await ctx.db.get(brandId);
      if (!brand?.clientId || String(brand.clientId) !== clientKey) continue;

      desired.set(assignmentKey(entry.clientId, brandId), {
        clientId: entry.clientId,
        brandId,
      });
    }
  }

  const existingAssignments = await ctx.db
    .query("clientUserAssignments")
    .withIndex("by_user", (q: any) => q.eq("userId", args.userId))
    .collect();

  const keptKeys = new Set<string>();
  let created = 0;
  let removed = 0;

  for (const assignment of existingAssignments) {
    const shouldManage =
      args.replaceAll || managedClientIds.has(String(assignment.clientId));
    if (!shouldManage) continue;

    const key = assignmentKey(assignment.clientId, assignment.brandId);
    if (desired.has(key) && !keptKeys.has(key)) {
      keptKeys.add(key);
      continue;
    }

    await ctx.db.delete(assignment._id);
    removed += 1;
  }

  for (const [key, assignment] of desired.entries()) {
    if (keptKeys.has(key)) continue;
    await ctx.db.insert("clientUserAssignments", {
      clientId: assignment.clientId,
      userId: args.userId,
      brandId: assignment.brandId,
      assignedAt: Date.now(),
      assignedBy: args.assignedBy,
    });
    created += 1;
  }

  return {
    created,
    removed,
    totalAssignments: desired.size,
  };
}
