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

function getFirstName(name: string | undefined) {
  return name?.trim().split(/\s+/)[0] ?? "";
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
    const searchTerm = getFirstName(userName);

    if (!searchTerm) {
      return {
        ok: false,
        error: "El usuario no tiene nombre para buscar en COR.",
      };
    }

    if (!userEmail) {
      return {
        ok: false,
        error: "El usuario no tiene email para validar su identidad en COR.",
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

    const match = corUsers.find(
      (u) => u.email.trim().toLowerCase() === userEmail,
    );

    if (!match) {
      return {
        ok: false,
        error: `COR devolvió ${corUsers.length} resultado(s) para "${searchTerm}", pero ninguno coincide con el email ${userEmail}.`,
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
      corEmail: string;
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
    const searchName = getFirstName(corUser.corFirstName);
    const corUsers = await provider.searchUsersByName(searchName);
    const corEmail = corUser.corEmail.trim().toLowerCase();
    const match = corUsers.find(
      (u) => u.email.trim().toLowerCase() === corEmail,
    );

    if (!match) {
      return {
        ok: false,
        error: `COR no encontró el usuario "${searchName}" con email ${corEmail}.`,
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
