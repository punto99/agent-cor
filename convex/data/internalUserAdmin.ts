import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation, query } from "../_generated/server";
import { canUserAccessInternalUserAdmin } from "../lib/internalUserAdminAccess";
import { isExcludedUserId } from "../lib/excludedUsers";

function normalizeEmail(email: unknown) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function formatUserName(user: Record<string, unknown>) {
  const name = typeof user.name === "string" ? user.name.trim() : "";
  const email = normalizeEmail(user.email);
  return name || email || "Usuario sin nombre";
}

async function requireInternalUserAdmin(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("No autenticado");
  if (!canUserAccessInternalUserAdmin(String(userId))) {
    throw new Error("No tienes permisos para administrar usuarios internos.");
  }
  return userId;
}

async function isExternalUser(ctx: any, userId: any) {
  const approvedExternalUser = await ctx.db
    .query("approvedExternalUsers")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .unique();
  return Boolean(approvedExternalUser);
}

export const viewerCanAccessInternalUserAdmin = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { isAuthenticated: false, canAccess: false };
    }

    return {
      isAuthenticated: true,
      userId,
      canAccess: canUserAccessInternalUserAdmin(String(userId)),
    };
  },
});

export const getDashboard = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || !canUserAccessInternalUserAdmin(String(userId))) {
      return { canAccess: false as const };
    }

    const [users, clients, brands, publishingSettings] = await Promise.all([
      ctx.db.query("users").collect(),
      ctx.db.query("corClients").collect(),
      ctx.db.query("clientBrands").collect(),
      ctx.db.query("clientCorPublishingSettings").collect(),
    ]);

    const brandsByClientId = new Map<string, any[]>();
    for (const brand of brands) {
      if (!brand.clientId) continue;
      const clientId = String(brand.clientId);
      const clientBrands = brandsByClientId.get(clientId) ?? [];
      clientBrands.push(brand);
      brandsByClientId.set(clientId, clientBrands);
    }

    const catalog = clients
      .slice()
      .sort((a, b) =>
        a.name.localeCompare(b.name, "es", { sensitivity: "base" }),
      )
      .map((client) => ({
        _id: client._id,
        name: client.name,
        corClientId: client.corClientId,
        nomenclature: client.nomenclature,
        brands: (brandsByClientId.get(String(client._id)) ?? [])
          .slice()
          .sort((a, b) =>
            a.name.localeCompare(b.name, "es", { sensitivity: "base" }),
          )
          .map((brand) => ({
            _id: brand._id,
            name: brand.name,
            corBrandId: brand.corBrandId,
            trelloBoardId: brand.trelloBoardId,
          })),
      }));

    const internalUsers = [];
    for (const user of users) {
      if (isExcludedUserId(user._id)) continue;
      if (await isExternalUser(ctx, user._id)) continue;

      const [corUser, assignments] = await Promise.all([
        ctx.db
          .query("corUsers")
          .withIndex("by_userId", (q: any) => q.eq("userId", user._id))
          .unique(),
        ctx.db
          .query("clientUserAssignments")
          .withIndex("by_user", (q: any) => q.eq("userId", user._id))
          .collect(),
      ]);

      const fullClientCount = assignments.filter(
        (assignment: any) => assignment.brandId === undefined,
      ).length;
      const brandCount = assignments.filter(
        (assignment: any) => assignment.brandId !== undefined,
      ).length;

      internalUsers.push({
        _id: user._id,
        name: formatUserName(user as Record<string, unknown>),
        email: normalizeEmail((user as Record<string, unknown>).email),
        image:
          typeof (user as Record<string, unknown>).image === "string"
            ? ((user as Record<string, unknown>).image as string)
            : undefined,
        corUser: corUser
          ? {
              _id: corUser._id,
              corUserId: corUser.corUserId,
              corFirstName: corUser.corFirstName,
              corLastName: corUser.corLastName,
              corEmail: corUser.corEmail,
              corRoleId: corUser.corRoleId,
              corPositionName: corUser.corPositionName,
              resolvedAt: corUser.resolvedAt,
              lastVerifiedAt: corUser.lastVerifiedAt,
            }
          : null,
        assignments: assignments.map((assignment: any) => ({
          _id: assignment._id,
          clientId: assignment.clientId,
          brandId: assignment.brandId,
          assignedAt: assignment.assignedAt,
          assignedBy: assignment.assignedBy,
        })),
        fullClientCount,
        brandCount,
        isCompleteForBrief: Boolean(corUser) && assignments.length > 0,
      });
    }

    internalUsers.sort((a, b) =>
      a.name.localeCompare(b.name, "es", { sensitivity: "base" }),
    );

    return {
      canAccess: true as const,
      users: internalUsers,
      clients: catalog,
      clientCorPublishingSettings: publishingSettings.map((settings) => ({
        _id: settings._id,
        clientId: settings.clientId,
        externalTaskCollaboratorUserIds:
          settings.externalTaskCollaboratorUserIds,
        updatedAt: settings.updatedAt,
        updatedBy: settings.updatedBy,
      })),
      generatedAt: Date.now(),
    };
  },
});

/**
 * Configura, por cliente, los usuarios internos que deben agregarse a COR
 * exclusivamente al publicar tasks creadas por usuarios externos.
 *
 * Una configuración ausente significa "cliente no configurado". Una lista
 * vacía es una decisión explícita de no agregar colaboradores automáticos.
 */
export const setClientCorPublishingCollaborators = mutation({
  args: {
    clientId: v.id("corClients"),
    userIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const adminUserId = await requireInternalUserAdmin(ctx);
    const client = await ctx.db.get(args.clientId);
    if (!client) throw new Error("Cliente no encontrado.");

    const uniqueUserIds = Array.from(
      new Set(args.userIds.map((userId) => String(userId))),
    ).map((userId) => {
      const normalized = ctx.db.normalizeId("users", userId);
      if (!normalized) throw new Error(`Usuario inválido: ${userId}`);
      return normalized;
    });

    if (uniqueUserIds.length > 20) {
      throw new Error(
        "COR admite como máximo 20 colaboradores directos por task.",
      );
    }

    for (const userId of uniqueUserIds) {
      const user = await ctx.db.get(userId);
      if (!user) throw new Error(`Usuario no encontrado: ${userId}`);
      if (await isExternalUser(ctx, userId)) {
        throw new Error(
          `El usuario ${formatUserName(user as Record<string, unknown>)} es externo y no puede configurarse como colaborador interno obligatorio.`,
        );
      }

      const corUser = await ctx.db
        .query("corUsers")
        .withIndex("by_userId", (q: any) => q.eq("userId", userId))
        .unique();
      if (!corUser) {
        throw new Error(
          `El usuario ${formatUserName(user as Record<string, unknown>)} todavía no está resuelto en COR.`,
        );
      }

      const localEmail = normalizeEmail(
        (user as Record<string, unknown>).email,
      );
      const corEmail = normalizeEmail(corUser.corEmail);
      if (!localEmail || localEmail !== corEmail) {
        throw new Error(
          `El email de ${formatUserName(user as Record<string, unknown>)} no coincide con su usuario COR.`,
        );
      }
    }

    const existing = await ctx.db
      .query("clientCorPublishingSettings")
      .withIndex("by_client", (q: any) => q.eq("clientId", args.clientId))
      .unique();
    const update = {
      externalTaskCollaboratorUserIds: uniqueUserIds,
      updatedAt: Date.now(),
      updatedBy: adminUserId,
    };

    if (existing) {
      await ctx.db.patch(existing._id, update);
      return existing._id;
    }

    return await ctx.db.insert("clientCorPublishingSettings", {
      clientId: args.clientId,
      ...update,
    });
  },
});

export const resolveInternalUserInCOR = mutation({
  args: {
    targetUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await requireInternalUserAdmin(ctx);

    const user = await ctx.db.get(args.targetUserId);
    if (!user) throw new Error("Usuario no encontrado.");
    if (await isExternalUser(ctx, args.targetUserId)) {
      throw new Error("Esta acción solo aplica a usuarios internos.");
    }

    await ctx.scheduler.runAfter(
      0,
      internal.data.corUsersActions.resolveUserInCOR,
      {
        userId: args.targetUserId,
      },
    );

    return { ok: true };
  },
});

export const verifyInternalUserInCOR = mutation({
  args: {
    targetUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await requireInternalUserAdmin(ctx);

    const user = await ctx.db.get(args.targetUserId);
    if (!user) throw new Error("Usuario no encontrado.");
    if (await isExternalUser(ctx, args.targetUserId)) {
      throw new Error("Esta acción solo aplica a usuarios internos.");
    }

    await ctx.scheduler.runAfter(
      0,
      internal.data.corUsersActions.verifyUserInCOR,
      {
        userId: args.targetUserId,
      },
    );

    return { ok: true };
  },
});

export const setInternalUserAssignments = mutation({
  args: {
    targetUserId: v.id("users"),
    fullClientIds: v.array(v.id("corClients")),
    brandIds: v.array(v.id("clientBrands")),
  },
  handler: async (ctx, args) => {
    const adminUserId = await requireInternalUserAdmin(ctx);

    const user = await ctx.db.get(args.targetUserId);
    if (!user) throw new Error("Usuario no encontrado.");
    if (await isExternalUser(ctx, args.targetUserId)) {
      throw new Error("Esta acción solo aplica a usuarios internos.");
    }

    const desired = new Map<
      string,
      {
        clientId: (typeof args.fullClientIds)[number];
        brandId?: (typeof args.brandIds)[number];
      }
    >();
    const fullClientIds = Array.from(new Set(args.fullClientIds.map(String)));

    for (const clientIdString of fullClientIds) {
      const clientId = ctx.db.normalizeId("corClients", clientIdString);
      if (!clientId) throw new Error("Cliente inválido.");
      const client = await ctx.db.get(clientId);
      if (!client) throw new Error("Cliente no encontrado.");
      desired.set(`${clientId}:*`, { clientId });
    }

    const selectedFullClientIds = new Set(fullClientIds);
    const uniqueBrandIds = Array.from(new Set(args.brandIds.map(String)));
    for (const brandIdString of uniqueBrandIds) {
      const brandId = ctx.db.normalizeId("clientBrands", brandIdString);
      if (!brandId) throw new Error("Categoría inválida.");
      const brand = await ctx.db.get(brandId);
      if (!brand) throw new Error("Categoría no encontrada.");
      if (!brand.clientId) {
        throw new Error(
          `La categoría "${brand.name}" no está vinculada a un cliente.`,
        );
      }
      if (selectedFullClientIds.has(String(brand.clientId))) continue;
      desired.set(`${brand.clientId}:${brandId}`, {
        clientId: brand.clientId,
        brandId,
      });
    }

    const existingAssignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_user", (q) => q.eq("userId", args.targetUserId))
      .collect();

    const keptKeys = new Set<string>();
    let created = 0;
    let removed = 0;

    for (const assignment of existingAssignments) {
      const key = assignment.brandId
        ? `${assignment.clientId}:${assignment.brandId}`
        : `${assignment.clientId}:*`;

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
        userId: args.targetUserId,
        brandId: assignment.brandId,
        assignedAt: Date.now(),
        assignedBy: adminUserId,
      });
      created += 1;
    }

    return {
      ok: true,
      created,
      removed,
      totalAssignments: desired.size,
    };
  },
});
