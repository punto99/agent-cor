import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import {
  INTERNAL_USER_ADMIN_ALLOWED_USER_IDS,
  canUserAccessInternalUserAdmin,
} from "../lib/internalUserAdminAccess";
import {
  syncClientAssignmentsFromAccess,
  validatePreapprovedClientAccess,
} from "../lib/externalUserPreapproval";
import { isTrelloEnabledForCorClientId } from "../lib/trelloPolicy";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeText(value: string | undefined) {
  return value?.trim() || undefined;
}

function normalizeRequiredText(value: string | undefined, fieldName: string) {
  const normalized = normalizeText(value);
  if (!normalized) throw new Error(`${fieldName} es obligatorio.`);
  return normalized;
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
  assignmentCount: number;
  trelloRequired: boolean;
  trelloMemberId?: string;
  trelloMemberSyncStatus?: string;
  missingBoardCount: number;
}) {
  if (!args.hasUser) return "pending_registration" as const;
  if (args.assignmentCount === 0) return "missing_categories" as const;
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
    const clientsById = new Map(
      clients.map((client) => [String(client._id), client]),
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

      const assignmentDetails = assignments.map((assignment) => {
        const client = clientsById.get(String(assignment.clientId));
        if (assignment.brandId) {
          const brand = brandsById.get(String(assignment.brandId));
          return {
            _id: assignment._id,
            clientId: assignment.clientId,
            brandId: assignment.brandId,
            assignedAt: assignment.assignedAt,
            clientName: client?.name,
            brandName: brand?.name,
            corClientId: brand?.corClientId,
            trelloBoardId: brand?.trelloBoardId,
            trelloEnabled: isTrelloEnabledForCorClientId(brand?.corClientId),
          };
        }

        return {
          _id: assignment._id,
          clientId: assignment.clientId,
          brandId: undefined,
          assignedAt: assignment.assignedAt,
          clientName: client?.name,
          brandName: undefined,
          corClientId: client?.corClientId,
          trelloBoardId: undefined,
          trelloEnabled: false,
        };
      });

      const accessibleBrandsById = new Map<string, any>();
      for (const assignment of assignments) {
        if (assignment.brandId) {
          const brand = brandsById.get(String(assignment.brandId));
          if (brand) accessibleBrandsById.set(String(brand._id), brand);
          continue;
        }

        for (const brand of brandsByClientId.get(
          String(assignment.clientId),
        ) ?? []) {
          accessibleBrandsById.set(String(brand._id), brand);
        }
      }
      const accessibleBrands = Array.from(accessibleBrandsById.values());
      const invitedAccess = (approvedUser.preapprovedClientAccess ?? [])
        .map((entry) => {
          const client = clientsById.get(String(entry.clientId));
          if (!client) return null;

          const allClientBrands =
            brandsByClientId.get(String(entry.clientId)) ?? [];
          const hasSpecificBrands = Boolean(entry.brandIds?.length);
          const invitedBrands = hasSpecificBrands
            ? (entry.brandIds ?? [])
                .map((brandId) => brandsById.get(String(brandId)))
                .filter(
                  (brand): brand is NonNullable<typeof brand> =>
                    Boolean(
                      brand && String(brand.clientId) === String(entry.clientId),
                    ),
                )
            : allClientBrands;

          return {
            clientId: client._id,
            clientName: client.name,
            corClientId: client.corClientId,
            allBrands: !hasSpecificBrands,
            brands: invitedBrands.map((brand) => ({
              _id: brand._id,
              name: brand.name,
              corClientId: brand.corClientId,
              corBrandId: brand.corBrandId,
              trelloBoardId: brand.trelloBoardId,
              trelloEnabled: isTrelloEnabledForCorClientId(brand.corClientId),
            })),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      const relevantBrands = approvedUser.userId
        ? accessibleBrands
        : invitedAccess.flatMap((entry) => entry.brands);
      const missingBoardCount = relevantBrands.filter(
        (brand) =>
          isTrelloEnabledForCorClientId(brand.corClientId) &&
          !brand.trelloBoardId,
      ).length;
      const trelloRequired = relevantBrands.some((brand) =>
        isTrelloEnabledForCorClientId(brand.corClientId),
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
        assignments: assignmentDetails,
        invitedAccess,
        assignedBrandCount: accessibleBrands.length,
        fullClientCount: assignments.filter((assignment) => !assignment.brandId)
          .length,
        brandCount: assignments.filter((assignment) => assignment.brandId)
          .length,
        missingBoardCount,
        trelloRequired,
        status: getExternalStatus({
          hasUser: Boolean(approvedUser.userId),
          assignmentCount: assignments.length,
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
    firstName: v.string(),
    lastName: v.string(),
    clientId: v.id("corClients"),
    brandIds: v.optional(v.array(v.id("clientBrands"))),
  },
  handler: async (ctx, args) => {
    const adminUserId = await requireExternalUserAdmin(ctx);
    const email = normalizeEmail(args.email);
    if (!email || !email.includes("@")) {
      throw new Error("Ingresa un correo válido.");
    }
    const firstName = normalizeRequiredText(args.firstName, "El nombre");
    const lastName = normalizeRequiredText(args.lastName, "El apellido");
    const name = `${firstName} ${lastName}`;
    const preapprovedClientAccess = await validatePreapprovedClientAccess(ctx, {
      clientId: args.clientId,
      brandIds: args.brandIds,
    });

    const existing = await ctx.db
      .query("approvedExternalUsers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name,
        preapprovedClientAccess,
        addedBy: existing.addedBy ?? adminUserId,
      });
      if (existing.userId) {
        await syncClientAssignmentsFromAccess(ctx, {
          userId: existing.userId,
          access: preapprovedClientAccess,
          assignedBy: existing.addedBy ?? adminUserId,
        });
      }
      return { ok: true, id: existing._id, created: false };
    }

    const id = await ctx.db.insert("approvedExternalUsers", {
      email,
      name,
      preapprovedClientAccess,
      createdAt: Date.now(),
      addedBy: adminUserId,
    });

    return { ok: true, id, created: true };
  },
});

export const setExternalUserBrandAssignments = mutation({
  args: {
    approvedExternalUserId: v.id("approvedExternalUsers"),
    fullClientIds: v.optional(v.array(v.id("corClients"))),
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

    const access = [];
    const fullClientIds = Array.from(
      new Set((args.fullClientIds ?? []).map(String)),
    );
    const fullClientIdSet = new Set(fullClientIds);

    for (const clientIdString of fullClientIds) {
      const clientId = ctx.db.normalizeId("corClients", clientIdString);
      if (!clientId) throw new Error("Cliente inválido.");
      const client = await ctx.db.get(clientId);
      if (!client) throw new Error("Cliente no encontrado.");
      access.push({ clientId });
    }

    const brandIdsByClientId = new Map<string, any[]>();
    for (const brandIdString of Array.from(new Set(args.brandIds.map(String)))) {
      const brandId = ctx.db.normalizeId("clientBrands", brandIdString);
      if (!brandId) throw new Error("Una categoría seleccionada no es válida.");
      const brand = await ctx.db.get(brandId);
      if (!brand) throw new Error("Una categoría seleccionada ya no existe.");
      if (!brand.clientId) {
        throw new Error(
          `La categoría "${brand.name}" todavía no está conectada a un cliente.`,
        );
      }
      if (fullClientIdSet.has(String(brand.clientId))) continue;

      const clientBrandIds = brandIdsByClientId.get(String(brand.clientId)) ?? [];
      clientBrandIds.push(brandId);
      brandIdsByClientId.set(String(brand.clientId), clientBrandIds);
    }

    for (const [clientIdString, brandIds] of brandIdsByClientId.entries()) {
      const clientId = ctx.db.normalizeId("corClients", clientIdString);
      if (!clientId) continue;
      access.push({ clientId, brandIds });
    }

    const result = await syncClientAssignmentsFromAccess(ctx, {
      userId: approvedUser.userId,
      access,
      assignedBy: adminUserId,
      replaceAll: true,
    });

    await ctx.db.patch(approvedUser._id, {
      trelloMemberSyncStatus:
        approvedUser.trelloMemberId && access.length > 0
          ? "needs_verification"
          : approvedUser.trelloMemberSyncStatus,
      trelloMemberSyncError: undefined,
    });

    return { ok: true, ...result };
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

    const brandsById = new Map<string, any>();
    for (const assignment of assignments) {
      if (assignment.brandId) {
        const brand = await ctx.db.get(assignment.brandId);
        if (brand) brandsById.set(String(brand._id), brand);
        continue;
      }

      const clientBrands = await ctx.db
        .query("clientBrands")
        .withIndex("by_client", (q) => q.eq("clientId", assignment.clientId))
        .collect();
      for (const brand of clientBrands) {
        brandsById.set(String(brand._id), brand);
      }
    }

    if (!approvedUser.userId) {
      for (const access of approvedUser.preapprovedClientAccess ?? []) {
        if (access.brandIds?.length) {
          for (const brandId of access.brandIds) {
            const brand = await ctx.db.get(brandId);
            if (
              brand?.clientId &&
              String(brand.clientId) === String(access.clientId)
            ) {
              brandsById.set(String(brand._id), brand);
            }
          }
          continue;
        }

        const clientBrands = await ctx.db
          .query("clientBrands")
          .withIndex("by_client", (q) => q.eq("clientId", access.clientId))
          .collect();
        for (const brand of clientBrands) {
          brandsById.set(String(brand._id), brand);
        }
      }
    }

    const brands = Array.from(brandsById.values()).map((brand) => ({
      _id: brand._id,
      name: brand.name,
      clientId: brand.clientId,
      corClientId: brand.corClientId,
      trelloBoardId: brand.trelloBoardId,
      trelloEnabled: isTrelloEnabledForCorClientId(brand.corClientId),
    }));

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
    trelloMemberId: v.optional(v.string()),
    trelloMemberEmail: v.optional(v.string()),
    trelloMemberFullName: v.optional(v.string()),
    trelloUsername: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const approvedUser = await ctx.db.get(args.approvedExternalUserId);
    if (!approvedUser) return { ok: false, shouldNotifyManualReview: false };

    const shouldNotifyManualReview =
      args.status === "manual_required" &&
      (approvedUser.trelloMemberSyncStatus !== "manual_required" ||
        (!approvedUser.trelloManualReviewNotificationSentAt &&
          !approvedUser.trelloManualReviewNotificationError));
    const patch: Record<string, unknown> = {
      trelloMemberSyncStatus: args.status,
      trelloMemberSyncError: args.error,
      trelloMemberVerifiedAt: args.verifiedAt,
      trelloMemberEmail: args.trelloMemberEmail,
      trelloMemberFullName: args.trelloMemberFullName,
      trelloUsername: args.trelloUsername,
    };
    if (args.trelloMemberId !== undefined) {
      patch.trelloMemberId = args.trelloMemberId;
    }
    if (args.status === "verified") {
      patch.trelloManualReviewNotificationError = undefined;
    }

    await ctx.db.patch(args.approvedExternalUserId, patch);
    return { ok: true, shouldNotifyManualReview };
  },
});

export const markExternalTrelloManualReviewNotification = internalMutation({
  args: {
    approvedExternalUserId: v.id("approvedExternalUsers"),
    sentAt: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.approvedExternalUserId, {
      trelloManualReviewNotificationSentAt: args.sentAt,
      trelloManualReviewNotificationError: args.error,
    });
  },
});

export const getExternalTrelloManualReviewNotificationContext = internalQuery({
  args: {
    approvedExternalUserId: v.id("approvedExternalUsers"),
    clientBrandId: v.id("clientBrands"),
  },
  handler: async (ctx, args) => {
    const approvedUser = await ctx.db.get(args.approvedExternalUserId);
    const brand = await ctx.db.get(args.clientBrandId);
    const client = brand?.clientId ? await ctx.db.get(brand.clientId) : null;

    const adminEmails = [];
    for (const adminUserIdString of INTERNAL_USER_ADMIN_ALLOWED_USER_IDS) {
      const adminUserId = ctx.db.normalizeId("users", adminUserIdString);
      if (!adminUserId) continue;
      const adminUser = await ctx.db.get(adminUserId);
      const email =
        typeof (adminUser as Record<string, unknown> | null)?.email ===
        "string"
          ? ((adminUser as Record<string, unknown>).email as string).trim()
          : "";
      if (email) adminEmails.push(email);
    }

    return {
      approvedUser: approvedUser
        ? {
            _id: approvedUser._id,
            name: approvedUser.name,
            email: approvedUser.email,
            trelloMemberSyncError: approvedUser.trelloMemberSyncError,
          }
        : null,
      brand: brand
        ? {
            _id: brand._id,
            name: brand.name,
            trelloBoardId: brand.trelloBoardId,
            trelloBoardUrl: brand.trelloBoardUrl,
          }
        : null,
      client: client
        ? {
            _id: client._id,
            name: client.name,
            corClientId: client.corClientId,
          }
        : null,
      adminEmails: Array.from(new Set(adminEmails)),
    };
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
