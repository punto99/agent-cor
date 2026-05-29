"use node";

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { getProjectManagementProvider } from "../integrations/registry";
import { canUserAccessInternalUserAdmin } from "../lib/internalUserAdminAccess";

type CorActionResult =
  | {
      ok: true;
      corUserId: number;
      name: string;
      email: string;
    }
  | {
      ok: false;
      error: string;
    };

async function requireInternalUserAdmin(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("No autenticado");
  if (!canUserAccessInternalUserAdmin(String(userId))) {
    throw new Error("No tienes permisos para administrar usuarios internos.");
  }
  return userId;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function resolveInternalUserInCORNowHandler(
  ctx: any,
  args: { targetUserId: any },
): Promise<CorActionResult> {
  await requireInternalUserAdmin(ctx);

  const approvedExternalUser = await ctx.runQuery(
    internal.data.approvedExternalUsers.getApprovedExternalUserByUserId,
    { userId: args.targetUserId },
  );
  if (approvedExternalUser) {
    return {
      ok: false,
      error: "Esta acción solo aplica a usuarios internos.",
    };
  }

  try {
    const userInfo: { name?: string; email?: string } | null =
      await ctx.runQuery(internal.data.corUsers.getUserBasicInfo, {
        userId: args.targetUserId,
      });

    if (!userInfo) {
      return {
        ok: false,
        error: "Usuario no encontrado en Convex.",
      };
    }

    const userName = userInfo.name?.trim();
    const userEmail = userInfo.email?.trim().toLowerCase();
    const searchTerm = userName || userEmail || "";

    if (!searchTerm) {
      return {
        ok: false,
        error: "El usuario no tiene nombre ni email para buscar en COR.",
      };
    }

    const provider = getProjectManagementProvider();
    const corUsers = await provider.searchUsersByName(searchTerm);

    if (corUsers.length === 0) {
      return {
        ok: false,
        error: `COR no encontró usuarios para "${searchTerm}". Verifica que el nombre del usuario en la app coincida con el nombre registrado en COR.`,
      };
    }

    let match = userEmail
      ? corUsers.find((u) => u.email.toLowerCase() === userEmail)
      : null;

    if (!match && userName) {
      const nameLower = userName.toLowerCase();
      match = corUsers.find((u) => {
        const fullName = `${u.firstName} ${u.lastName}`.toLowerCase();
        return fullName === nameLower;
      });
    }

    if (!match && corUsers.length === 1) {
      match = corUsers[0];
    }

    if (!match) {
      return {
        ok: false,
        error: `COR devolvió ${corUsers.length} resultado(s) para "${searchTerm}", pero ninguno coincide por email o nombre exacto.`,
      };
    }

    await ctx.runMutation(internal.data.corUsers.upsertCorUser, {
      userId: args.targetUserId,
      corUserId: match.id,
      corFirstName: match.firstName,
      corLastName: match.lastName,
      corEmail: match.email,
      corRoleId: match.roleId,
      corPositionName: match.positionName,
    });

    return {
      ok: true,
      corUserId: match.id,
      name: `${match.firstName} ${match.lastName}`.trim(),
      email: match.email,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Error consultando COR: ${formatError(error)}`,
    };
  }
}

async function verifyInternalUserInCORNowHandler(
  ctx: any,
  args: { targetUserId: any },
): Promise<CorActionResult> {
  await requireInternalUserAdmin(ctx);

  const approvedExternalUser = await ctx.runQuery(
    internal.data.approvedExternalUsers.getApprovedExternalUserByUserId,
    { userId: args.targetUserId },
  );
  if (approvedExternalUser) {
    return {
      ok: false,
      error: "Esta acción solo aplica a usuarios internos.",
    };
  }

  try {
    const corUser: {
      corUserId: number;
      corFirstName: string;
      corLastName: string;
    } | null = await ctx.runQuery(internal.data.corUsers.getCorUserByUserId, {
      userId: args.targetUserId,
    });

    if (!corUser) {
      return {
        ok: false,
        error: "Este usuario todavía no tiene corUser para verificar.",
      };
    }

    const provider = getProjectManagementProvider();
    const searchName = `${corUser.corFirstName} ${corUser.corLastName}`;
    const corUsers = await provider.searchUsersByName(searchName);
    const match = corUsers.find((u) => u.id === corUser.corUserId);

    if (!match) {
      return {
        ok: false,
        error: `COR no encontró el usuario "${searchName}" con ID ${corUser.corUserId}.`,
      };
    }

    await ctx.runMutation(internal.data.corUsers.upsertCorUser, {
      userId: args.targetUserId,
      corUserId: match.id,
      corFirstName: match.firstName,
      corLastName: match.lastName,
      corEmail: match.email,
      corRoleId: match.roleId,
      corPositionName: match.positionName,
    });

    return {
      ok: true,
      corUserId: match.id,
      name: `${match.firstName} ${match.lastName}`.trim(),
      email: match.email,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Error consultando COR: ${formatError(error)}`,
    };
  }
}

export const resolveInternalUserInCORNow = action({
  args: {
    targetUserId: v.id("users"),
  },
  handler: resolveInternalUserInCORNowHandler,
});

export const verifyInternalUserInCORNow = action({
  args: {
    targetUserId: v.id("users"),
  },
  handler: verifyInternalUserInCORNowHandler,
});
