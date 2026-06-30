import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { canUserAccessInternalUserAdmin } from "../lib/internalUserAdminAccess";
import { isTrelloEnabledForCorClientId } from "../lib/trelloPolicy";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeText(value: string | undefined) {
  return value?.trim() || undefined;
}

function formatUserName(user: Record<string, unknown> | null) {
  if (!user) return undefined;
  const name = typeof user.name === "string" ? user.name.trim() : "";
  const email = typeof user.email === "string" ? user.email.trim() : "";
  return name || email || undefined;
}

async function requireExternalUserAdmin(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("No autenticado");
  if (!canUserAccessInternalUserAdmin(String(userId))) {
    throw new Error("No tienes permisos para administrar usuarios externos.");
  }
  return userId;
}

function getExternalStatus(args: {
  hasUser: boolean;
  assignedBrandCount: number;
  trelloRequired: boolean;
  trelloMemberId?: string;
  trelloMemberSyncStatus?: string;
  missingBoardCount: number;
}) {
  if (!args.hasUser) return "pending_registration" as const;
  if (args.assignedBrandCount === 0) return "missing_categories" as const;
  if (!args.trelloRequired) return "ready" as const;
  if (!args.trelloMemberId) return "missing_trello" as const;
  if (args.missingBoardCount > 0) return "missing_boards" as const;
  if (args.trelloMemberSyncStatus === "verified") return "ready" as const;
  if (args.trelloMemberSyncStatus === "error") return "trello_error" as const;
  return "needs_trello_check" as const;
}

export const viewerCanAccessExternalUserAdmin = query({
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

    const [approvedUsers, clients, brands] = await Promise.all([
      ctx.db.query("approvedExternalUsers").collect(),
      ctx.db.query("corClients").collect(),
      ctx.db.query("clientBrands").collect(),
    ]);

    const brandsById = new Map(
      brands.map((brand) => [String(brand._id), brand]),
    );
    const brandsByClientId = new Map<string, any[]>();
    for (const brand of brands) {
      if (!brand.clientId) continue;
      const clientBrands = brandsByClientId.get(String(brand.clientId)) ?? [];
      clientBrands.push(brand);
      brandsByClientId.set(String(brand.clientId), clientBrands);
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
            trelloBoardUrl: brand.trelloBoardUrl,
          })),
      }));

    const users = [];
    for (const approvedUser of approvedUsers) {
      const linkedUser = approvedUser.userId
        ? ((await ctx.db.get(approvedUser.userId)) as Record<
            string,
            unknown
          > | null)
        : null;
      const assignments = approvedUser.userId
        ? await ctx.db
            .query("clientUserAssignments")
            .withIndex("by_user", (q) => q.eq("userId", approvedUser.userId!))
            .collect()
        : [];

      const brandAssignments = assignments
        .filter((assignment) => assignment.brandId)
        .map((assignment) => {
          const brand = brandsById.get(String(assignment.brandId));
          return {
            _id: assignment._id,
            clientId: assignment.clientId,
            brandId: assignment.brandId,
            assignedAt: assignment.assignedAt,
            brandName: brand?.name,
            corClientId: brand?.corClientId,
            trelloBoardId: brand?.trelloBoardId,
            trelloEnabled: isTrelloEnabledForCorClientId(brand?.corClientId),
          };
        });
      const missingBoardCount = brandAssignments.filter(
        (assignment) => assignment.trelloEnabled && !assignment.trelloBoardId,
      ).length;
      const trelloRequired = brandAssignments.some(
        (assignment) => assignment.trelloEnabled,
      );

      users.push({
        _id: approvedUser._id,
        email: approvedUser.email,
        name: approvedUser.name,
        userId: approvedUser.userId,
        linkedUserName: formatUserName(linkedUser),
        createdAt: approvedUser.createdAt,
        trelloMemberId: approvedUser.trelloMemberId,
        trelloUsername: approvedUser.trelloUsername,
        trelloMemberEmail: approvedUser.trelloMemberEmail,
        trelloMemberFullName: approvedUser.trelloMemberFullName,
        trelloMemberSyncStatus: approvedUser.trelloMemberSyncStatus,
        trelloMemberSyncError: approvedUser.trelloMemberSyncError,
        trelloMemberVerifiedAt: approvedUser.trelloMemberVerifiedAt,
        assignments: brandAssignments,
        assignedBrandCount: brandAssignments.length,
        missingBoardCount,
        status: getExternalStatus({
          hasUser: Boolean(approvedUser.userId),
          assignedBrandCount: brandAssignments.length,
          trelloRequired,
          trelloMemberId: approvedUser.trelloMemberId,
          trelloMemberSyncStatus: approvedUser.trelloMemberSyncStatus,
          missingBoardCount,
        }),
      });
    }

    users.sort((a, b) =>
      (a.name || a.email).localeCompare(b.name || b.email, "es", {
        sensitivity: "base",
      }),
    );

    return {
      canAccess: true as const,
      users,
      clients: catalog,
      generatedAt: Date.now(),
    };
  },
});

export const upsertApprovedExternalUser = mutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const adminUserId = await requireExternalUserAdmin(ctx);
    const email = normalizeEmail(args.email);
    if (!email || !email.includes("@")) {
      throw new Error("Ingresa un correo válido.");
    }

    const existing = await ctx.db
      .query("approvedExternalUsers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    const name = normalizeText(args.name);
    if (existing) {
      await ctx.db.patch(existing._id, {
        name,
        addedBy: existing.addedBy ?? adminUserId,
      });
      return { ok: true, id: existing._id, created: false };
    }

    const id = await ctx.db.insert("approvedExternalUsers", {
      email,
      name,
      createdAt: Date.now(),
      addedBy: adminUserId,
    });

    return { ok: true, id, created: true };
  },
});

export const setExternalUserBrandAssignments = mutation({
  args: {
    approvedExternalUserId: v.id("approvedExternalUsers"),
    brandIds: v.array(v.id("clientBrands")),
  },
  handler: async (ctx, args) => {
    const adminUserId = await requireExternalUserAdmin(ctx);
    const approvedUser = await ctx.db.get(args.approvedExternalUserId);
    if (!approvedUser) throw new Error("No encontramos este usuario externo.");
    if (!approvedUser.userId) {
      throw new Error(
        "Esta persona todavía no ingresó a la plataforma. Podrás asignarle categorías cuando lo haga por primera vez.",
      );
    }

    const desired = new Map<string, { clientId: any; brandId: any }>();
    for (const brandIdString of Array.from(
      new Set(args.brandIds.map(String)),
    )) {
      const brandId = ctx.db.normalizeId("clientBrands", brandIdString);
      if (!brandId) throw new Error("Una categoría seleccionada no es válida.");
      const brand = await ctx.db.get(brandId);
      if (!brand) throw new Error("Una categoría seleccionada ya no existe.");
      if (!brand.clientId) {
        throw new Error(
          `La categoría "${brand.name}" todavía no está conectada a un cliente.`,
        );
      }
      desired.set(String(brandId), { clientId: brand.clientId, brandId });
    }

    const existingAssignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_user", (q) => q.eq("userId", approvedUser.userId!))
      .collect();

    const kept = new Set<string>();
    let created = 0;
    let removed = 0;

    for (const assignment of existingAssignments) {
      const key = assignment.brandId ? String(assignment.brandId) : "";
      if (key && desired.has(key) && !kept.has(key)) {
        kept.add(key);
        continue;
      }
      await ctx.db.delete(assignment._id);
      removed += 1;
    }

    for (const [key, assignment] of desired.entries()) {
      if (kept.has(key)) continue;
      await ctx.db.insert("clientUserAssignments", {
        clientId: assignment.clientId,
        userId: approvedUser.userId,
        brandId: assignment.brandId,
        assignedAt: Date.now(),
        assignedBy: adminUserId,
      });
      created += 1;
    }

    await ctx.db.patch(approvedUser._id, {
      trelloMemberSyncStatus:
        approvedUser.trelloMemberId && desired.size > 0
          ? "needs_verification"
          : approvedUser.trelloMemberSyncStatus,
      trelloMemberSyncError: undefined,
    });

    return { ok: true, created, removed, totalAssignments: desired.size };
  },
});

export const setExternalTrelloMember = mutation({
  args: {
    approvedExternalUserId: v.id("approvedExternalUsers"),
    trelloMemberId: v.string(),
    trelloUsername: v.optional(v.string()),
    trelloMemberEmail: v.optional(v.string()),
    trelloMemberFullName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireExternalUserAdmin(ctx);
    const approvedUser = await ctx.db.get(args.approvedExternalUserId);
    if (!approvedUser) throw new Error("No encontramos este usuario externo.");

    await ctx.db.patch(args.approvedExternalUserId, {
      trelloMemberId: args.trelloMemberId,
      trelloUsername: normalizeText(args.trelloUsername),
      trelloMemberEmail: normalizeText(args.trelloMemberEmail),
      trelloMemberFullName: normalizeText(args.trelloMemberFullName),
      trelloMemberSyncStatus: "needs_verification",
      trelloMemberSyncError: undefined,
      trelloMemberVerifiedAt: undefined,
    });

    return { ok: true };
  },
});

export const getExternalTrelloContext = internalQuery({
  args: {
    approvedExternalUserId: v.id("approvedExternalUsers"),
  },
  handler: async (ctx, args) => {
    const approvedUser = await ctx.db.get(args.approvedExternalUserId);
    if (!approvedUser) return null;

    const user = approvedUser.userId
      ? await ctx.db.get(approvedUser.userId)
      : null;
    const assignments = approvedUser.userId
      ? await ctx.db
          .query("clientUserAssignments")
          .withIndex("by_user", (q) => q.eq("userId", approvedUser.userId!))
          .collect()
      : [];

    const brands = [];
    for (const assignment of assignments) {
      if (!assignment.brandId) continue;
      const brand = await ctx.db.get(assignment.brandId);
      if (!brand) continue;
      brands.push({
        _id: brand._id,
        name: brand.name,
        clientId: brand.clientId,
        corClientId: brand.corClientId,
        trelloBoardId: brand.trelloBoardId,
        trelloEnabled: isTrelloEnabledForCorClientId(brand.corClientId),
      });
    }

    return {
      approvedUser,
      user: user
        ? {
            _id: user._id,
            name: (user as Record<string, unknown>).name as string | undefined,
            email: (user as Record<string, unknown>).email as
              | string
              | undefined,
          }
        : null,
      brands,
    };
  },
});

export const markExternalTrelloStatus = internalMutation({
  args: {
    approvedExternalUserId: v.id("approvedExternalUsers"),
    status: v.string(),
    error: v.optional(v.string()),
    verifiedAt: v.optional(v.number()),
    trelloMemberEmail: v.optional(v.string()),
    trelloMemberFullName: v.optional(v.string()),
    trelloUsername: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.approvedExternalUserId, {
      trelloMemberSyncStatus: args.status,
      trelloMemberSyncError: args.error,
      trelloMemberVerifiedAt: args.verifiedAt,
      trelloMemberEmail: args.trelloMemberEmail,
      trelloMemberFullName: args.trelloMemberFullName,
      trelloUsername: args.trelloUsername,
    });
  },
});

export const setClientBrandTrelloBoard = internalMutation({
  args: {
    clientBrandId: v.id("clientBrands"),
    trelloBoardId: v.string(),
    trelloBoardUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const brand = await ctx.db.get(args.clientBrandId);
    if (!brand) throw new Error("No encontramos esta categoría.");
    if (!isTrelloEnabledForCorClientId(brand.corClientId)) {
      throw new Error("Esta categoría no está habilitada para Trello.");
    }

    await ctx.db.patch(args.clientBrandId, {
      trelloBoardId: args.trelloBoardId,
      trelloBoardUrl: normalizeText(args.trelloBoardUrl),
    });

    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_brand", (q) => q.eq("brandId", args.clientBrandId))
      .collect();

    for (const assignment of assignments) {
      const approvedUser = await ctx.db
        .query("approvedExternalUsers")
        .withIndex("by_user", (q) => q.eq("userId", assignment.userId))
        .unique();

      if (!approvedUser?.trelloMemberId) continue;
      await ctx.db.patch(approvedUser._id, {
        trelloMemberSyncStatus: "needs_verification",
        trelloMemberSyncError: undefined,
        trelloMemberVerifiedAt: undefined,
      });
    }

    return { ok: true };
  },
});
