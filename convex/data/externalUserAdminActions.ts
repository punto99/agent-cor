"use node";

import { getAuthUserId } from "@convex-dev/auth/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { trelloProvider } from "../integrations/trelloProvider";
import { canUserAccessInternalUserAdmin } from "../lib/internalUserAdminAccess";

const syncTrelloBoardConfigForBrand = makeFunctionReference<"action">(
  "data/trello:syncTrelloBoardConfigForBrand",
);
const syncTrelloWebhookForBrand = makeFunctionReference<"action">(
  "data/trello:syncTrelloWebhookForBrand",
);

type TrelloBoardCandidate = {
  id: string;
  name: string;
  url?: string;
  shortUrl?: string;
  matchReason: string;
};

type TrelloCandidate = {
  id: string;
  username?: string;
  fullName?: string;
  email?: string;
  memberType?: string;
  confirmed?: boolean;
  matchReason: string;
};

async function requireExternalUserAdmin(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("No autenticado");
  if (!canUserAccessInternalUserAdmin(String(userId))) {
    throw new Error("No tienes permisos para administrar usuarios externos.");
  }
  return userId;
}

function normalize(value: string | undefined) {
  return value?.trim().toLowerCase() || "";
}

function rankBoards(args: {
  boards: Array<{
    id: string;
    name: string;
    url?: string;
    shortUrl?: string;
    closed?: boolean;
  }>;
  query: string;
  brandName: string;
}) {
  const query = normalize(args.query);
  const brandName = normalize(args.brandName);
  const tokens = query.split(/\s+/).filter((token) => token.length > 1);

  return args.boards
    .filter((board) => !board.closed)
    .map((board) => {
      const boardName = normalize(board.name);
      let score = 0;
      let matchReason = "Tablero disponible";

      if (query && boardName === query) {
        score = 100;
        matchReason = "Coincide con la búsqueda";
      } else if (brandName && boardName === brandName) {
        score = 90;
        matchReason = "Coincide con la categoría";
      } else if (query && boardName.includes(query)) {
        score = 75;
        matchReason = "Nombre parecido";
      } else if (brandName && boardName.includes(brandName)) {
        score = 65;
        matchReason = "Nombre parecido a la categoría";
      } else if (
        tokens.length > 0 &&
        tokens.some((token) => boardName.includes(token))
      ) {
        score = 45;
        matchReason = "Coincidencia parcial";
      } else if (!query) {
        score = 10;
      }

      return { ...board, score, matchReason };
    })
    .filter((board) => board.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 12)
    .map(({ score: _score, closed: _closed, ...board }) => board);
}

function rankCandidates(args: {
  members: Array<{
    id: string;
    username?: string;
    fullName?: string;
    email?: string;
    memberType?: string;
    confirmed?: boolean;
  }>;
  email: string;
  name?: string;
}) {
  const email = normalize(args.email);
  const name = normalize(args.name);

  return args.members
    .map((member) => {
      const memberEmail = normalize(member.email);
      const fullName = normalize(member.fullName);
      const username = normalize(member.username);
      let score = 0;
      let matchReason = "Coincidencia posible";

      if (email && memberEmail === email) {
        score = 100;
        matchReason = "Coincide por correo";
      } else if (name && fullName === name) {
        score = 80;
        matchReason = "Coincide por nombre";
      } else if (email && username && email.split("@")[0] === username) {
        score = 60;
        matchReason = "Coincide por usuario";
      } else if (
        name &&
        (fullName.includes(name) || name.includes(fullName)) &&
        fullName.length > 2
      ) {
        score = 40;
        matchReason = "Nombre parecido";
      }

      return { ...member, score, matchReason };
    })
    .filter((member) => member.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ score: _score, ...member }) => member);
}

export const searchTrelloBoardsForBrand = action({
  args: {
    clientBrandId: v.id("clientBrands"),
    query: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        ok: true;
        brandName: string;
        boards: TrelloBoardCandidate[];
      }
    | { ok: false; error: string }
  > => {
    await requireExternalUserAdmin(ctx);

    try {
      const brand = await ctx.runQuery(internal.data.clientBrands.getById, {
        clientBrandId: args.clientBrandId,
      });

      if (!brand) {
        return { ok: false, error: "No encontramos esta categoría." };
      }

      const boards = await trelloProvider.listMyBoards();
      const candidates = rankBoards({
        boards,
        query: args.query || brand.name,
        brandName: brand.name,
      });

      if (candidates.length === 0) {
        return {
          ok: false,
          error:
            "No encontramos tableros disponibles con esa búsqueda. Prueba con otro nombre.",
        };
      }

      return {
        ok: true,
        brandName: brand.name,
        boards: candidates,
      };
    } catch (error) {
      console.error("[ExternalUserAdmin] Error buscando tableros:", error);
      return {
        ok: false,
        error:
          "No pudimos consultar los tableros de Trello en este momento. Intenta nuevamente en unos minutos.",
      };
    }
  },
});

export const associateTrelloBoardToBrand = action({
  args: {
    clientBrandId: v.id("clientBrands"),
    trelloBoardId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        ok: true;
        board: {
          id: string;
          name: string;
          url?: string;
          shortUrl?: string;
        };
        warnings: string[];
      }
    | { ok: false; error: string }
  > => {
    await requireExternalUserAdmin(ctx);

    try {
      const brand = await ctx.runQuery(internal.data.clientBrands.getById, {
        clientBrandId: args.clientBrandId,
      });

      if (!brand) {
        return { ok: false, error: "No encontramos esta categoría." };
      }

      const board = await trelloProvider.getBoard(args.trelloBoardId);
      if (board.closed) {
        return {
          ok: false,
          error: "Ese tablero está cerrado en Trello. Elige un tablero activo.",
        };
      }

      await ctx.runMutation(
        internal.data.externalUserAdmin.setClientBrandTrelloBoard,
        {
          clientBrandId: args.clientBrandId,
          trelloBoardId: board.id,
          trelloBoardUrl: board.url || board.shortUrl,
        },
      );

      const warnings: string[] = [];

      try {
        await ctx.runAction(syncTrelloBoardConfigForBrand, {
          clientBrandId: args.clientBrandId,
        });
      } catch (error) {
        console.error("[ExternalUserAdmin] Error configurando tablero:", error);
        warnings.push("Falta finalizar su configuración automática.");
      }

      try {
        await ctx.runAction(syncTrelloWebhookForBrand, {
          clientBrandId: args.clientBrandId,
        });
      } catch (error) {
        console.error("[ExternalUserAdmin] Error configurando webhook:", error);
        warnings.push(
          "Falta activar la sincronización de cambios desde Trello.",
        );
      }

      return {
        ok: true,
        board: {
          id: board.id,
          name: board.name,
          url: board.url,
          shortUrl: board.shortUrl,
        },
        warnings,
      };
    } catch (error) {
      console.error("[ExternalUserAdmin] Error asociando tablero:", error);
      return {
        ok: false,
        error:
          "No pudimos asociar ese tablero. Verifica que el tablero exista y que la cuenta conectada tenga acceso.",
      };
    }
  },
});

export const searchTrelloMembersForExternalUser = action({
  args: {
    approvedExternalUserId: v.id("approvedExternalUsers"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        ok: true;
        brandName: string;
        boardId: string;
        candidates: TrelloCandidate[];
      }
    | { ok: false; error: string }
  > => {
    await requireExternalUserAdmin(ctx);

    try {
      const context = await ctx.runQuery(
        internal.data.externalUserAdmin.getExternalTrelloContext,
        { approvedExternalUserId: args.approvedExternalUserId },
      );

      if (!context) {
        return { ok: false, error: "No encontramos este usuario externo." };
      }
      if (!context.approvedUser.userId || !context.user) {
        return {
          ok: false,
          error:
            "Esta persona todavía no ingresó a la plataforma. Podrás buscarla en Trello cuando lo haga por primera vez.",
        };
      }
      if (context.brands.length === 0) {
        return {
          ok: false,
          error:
            "Primero selecciona al menos una categoría para saber en qué tablero buscar.",
        };
      }

      const brandWithBoard = context.brands.find(
        (brand) => brand.trelloBoardId,
      );
      if (!brandWithBoard?.trelloBoardId) {
        return {
          ok: false,
          error:
            "Las categorías seleccionadas todavía no tienen tablero de Trello configurado.",
        };
      }

      const members = await trelloProvider.getBoardMembers(
        brandWithBoard.trelloBoardId,
      );
      let candidates = rankCandidates({
        members,
        email: context.approvedUser.email,
        name: context.approvedUser.name || context.user.name,
      });

      if (candidates.length === 0 && members.length > 0) {
        candidates = members.map((member) => ({
          ...member,
          matchReason: "Miembro del tablero",
        }));
      }

      if (candidates.length === 0) {
        return {
          ok: false,
          error:
            "No encontramos miembros disponibles en el tablero seleccionado.",
        };
      }

      return {
        ok: true,
        brandName: brandWithBoard.name,
        boardId: brandWithBoard.trelloBoardId,
        candidates: candidates.slice(0, 6),
      };
    } catch (error) {
      console.error(
        "[ExternalUserAdmin] Error buscando miembros en Trello:",
        error,
      );
      return {
        ok: false,
        error:
          "No pudimos consultar Trello en este momento. Intenta nuevamente en unos minutos.",
      };
    }
  },
});

export const verifyExternalUserTrelloAccess = action({
  args: {
    approvedExternalUserId: v.id("approvedExternalUsers"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        ok: true;
        checkedBoards: number;
      }
    | { ok: false; error: string }
  > => {
    await requireExternalUserAdmin(ctx);

    try {
      const context = await ctx.runQuery(
        internal.data.externalUserAdmin.getExternalTrelloContext,
        { approvedExternalUserId: args.approvedExternalUserId },
      );

      if (!context) {
        return { ok: false, error: "No encontramos este usuario externo." };
      }
      if (!context.approvedUser.userId) {
        return {
          ok: false,
          error:
            "Esta persona todavía no ingresó a la plataforma. Espera su primer ingreso antes de verificar Trello.",
        };
      }
      if (context.brands.length === 0) {
        return {
          ok: false,
          error: "Primero asigna al menos una categoría.",
        };
      }
      if (!context.approvedUser.trelloMemberId) {
        return {
          ok: false,
          error: "Primero vincula a esta persona con su usuario de Trello.",
        };
      }

      const missingBoards = context.brands.filter(
        (brand) => !brand.trelloBoardId,
      );
      if (missingBoards.length > 0) {
        const names = missingBoards.map((brand) => brand.name).join(", ");
        await ctx.runMutation(
          internal.data.externalUserAdmin.markExternalTrelloStatus,
          {
            approvedExternalUserId: args.approvedExternalUserId,
            status: "error",
            error: `Falta tablero de Trello en: ${names}`,
          },
        );
        return {
          ok: false,
          error: `Hay categorías sin tablero de Trello configurado: ${names}.`,
        };
      }

      const boardIds = Array.from(
        new Set(context.brands.map((brand) => brand.trelloBoardId!)),
      );
      let foundMember:
        | {
            username?: string;
            fullName?: string;
            email?: string;
          }
        | undefined;

      for (const boardId of boardIds) {
        const members = await trelloProvider.getBoardMembers(boardId);
        const member = members.find(
          (candidate) => candidate.id === context.approvedUser.trelloMemberId,
        );
        if (!member) {
          const brandNames = context.brands
            .filter((brand) => brand.trelloBoardId === boardId)
            .map((brand) => brand.name)
            .join(", ");
          await ctx.runMutation(
            internal.data.externalUserAdmin.markExternalTrelloStatus,
            {
              approvedExternalUserId: args.approvedExternalUserId,
              status: "error",
              error: `No tiene acceso al tablero de: ${brandNames}`,
            },
          );
          return {
            ok: false,
            error: `Esta persona no aparece como miembro del tablero de Trello para: ${brandNames}.`,
          };
        }
        foundMember = member;
      }

      await ctx.runMutation(
        internal.data.externalUserAdmin.markExternalTrelloStatus,
        {
          approvedExternalUserId: args.approvedExternalUserId,
          status: "verified",
          verifiedAt: Date.now(),
          error: undefined,
          trelloMemberEmail: foundMember?.email,
          trelloMemberFullName: foundMember?.fullName,
          trelloUsername: foundMember?.username,
        },
      );

      return { ok: true, checkedBoards: boardIds.length };
    } catch (error) {
      console.error("[ExternalUserAdmin] Error verificando Trello:", error);
      const message =
        "No pudimos verificar Trello en este momento. Intenta nuevamente en unos minutos.";
      await ctx.runMutation(
        internal.data.externalUserAdmin.markExternalTrelloStatus,
        {
          approvedExternalUserId: args.approvedExternalUserId,
          status: "error",
          error: message,
        },
      );
      return { ok: false, error: message };
    }
  },
});
