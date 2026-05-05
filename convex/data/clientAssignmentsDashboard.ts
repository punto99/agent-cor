import { mutation } from "../_generated/server";
import { v } from "convex/values";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Función de dashboard para crear asignaciones usuario-cliente en lote.
 *
 * Uso típico:
 * - Pasar email + lista de clientes por nombre
 * - O pasar email + allClients=true para asignarlo a todos los clientes
 */
export const assignUserToClientsBulkDashboard = mutation({
  args: {
    userEmail: v.string(),
    clientNames: v.optional(v.array(v.string())),
    allClients: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const email = normalize(args.userEmail);
    if (!email) {
      throw new Error("Debes enviar un email válido.");
    }

    const useAllClients = args.allClients === true;
    const requestedNames = (args.clientNames || [])
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    if (!useAllClients && requestedNames.length === 0) {
      throw new Error(
        "Debes enviar clientNames o activar allClients=true para asignar todos los clientes."
      );
    }

    // Resolver usuario local por email (authTables users)
    const users = await ctx.db.query("users").collect();
    const user = users.find((u) => {
      const userEmail = (u as Record<string, unknown>).email;
      return typeof userEmail === "string" && normalize(userEmail) === email;
    });

    if (!user) {
      throw new Error(`No se encontró usuario local con email "${args.userEmail}".`);
    }

    const allClients = await ctx.db.query("corClients").collect();
    const clientsByNormalizedName = new Map<string, (typeof allClients)[number]>();
    for (const client of allClients) {
      clientsByNormalizedName.set(normalize(client.name), client);
    }

    let targetClients: typeof allClients = [];
    const missingClientNames: string[] = [];

    if (useAllClients) {
      targetClients = allClients;
    } else {
      const seen = new Set<string>();
      for (const requestedName of requestedNames) {
        const key = normalize(requestedName);
        if (seen.has(key)) continue;
        seen.add(key);

        const client = clientsByNormalizedName.get(key);
        if (client) {
          targetClients.push(client);
        } else {
          missingClientNames.push(requestedName);
        }
      }
    }

    let created = 0;
    let alreadyExisted = 0;

    for (const client of targetClients) {
      const existingAssignment = await ctx.db
        .query("clientUserAssignments")
        .withIndex("by_client_and_user", (q) =>
          q.eq("clientId", client._id).eq("userId", user._id)
        )
        .unique();

      if (existingAssignment) {
        alreadyExisted += 1;
        continue;
      }

      await ctx.db.insert("clientUserAssignments", {
        clientId: client._id,
        userId: user._id,
        assignedAt: Date.now(),
      });
      created += 1;
    }

    return {
      ok: true,
      user: {
        id: user._id,
        email,
      },
      mode: useAllClients ? "allClients" : "selectedClients",
      requestedClientCount: useAllClients ? allClients.length : requestedNames.length,
      resolvedClientCount: targetClients.length,
      createdAssignments: created,
      existingAssignments: alreadyExisted,
      missingClientNames,
      assignedClients: targetClients.map((client) => ({
        id: client._id,
        corClientId: client.corClientId,
        name: client.name,
      })),
    };
  },
});
