"use node";

// convex/data/backfill.ts
// =====================================================
// Funciones de backfill para migración de datos existentes.
// Diseñadas para correr desde el dashboard de Convex (internalAction).
//
// ⚠️  ARCHIVO TEMPORAL — Borrar cuando ya no se necesite.
//
// Funciones:
//   1. backfillCorUsers   — Resuelve usuarios existentes de Convex en COR
//   2. backfillCorClients — Importa TODOS los clientes desde COR
// =====================================================

import { internalAction } from "../_generated/server";
import { components, internal } from "../_generated/api";
import { getProjectManagementProvider } from "../integrations/registry";
import { v } from "convex/values";
import { listMessages } from "@convex-dev/agent";

// ==================== 1. BACKFILL COR USERS ====================

/**
 * Resuelve TODOS los usuarios existentes de Convex en COR.
 *
 * Flujo:
 *   1. Lista todos los usuarios de Convex (authTables)
 *   2. Lista todos los usuarios de COR (GET /users?page=false)
 *   3. Cruza por email (coincidencia exacta, case-insensitive)
 *   4. Para cada match → upsert en tabla corUsers
 *
 * Logs detallados:
 *   - ✅ Para cada usuario resuelto exitosamente
 *   - ⚠️ Para usuarios de Convex sin match en COR
 *   - ❌ Para errores
 *   - 📊 Resumen final con contadores
 *
 * Ejecutar desde: Dashboard de Convex → Functions → data/backfill:backfillCorUsers → Run
 */
export const backfillCorUsers = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("\n" + "=".repeat(60));
    console.log("[Backfill] 🚀 INICIO: backfillCorUsers");
    console.log("=".repeat(60));

    const stats = {
      totalConvexUsers: 0,
      totalCORUsers: 0,
      matched: 0,
      alreadyExisted: 0,
      created: 0,
      noMatch: 0,
      skippedNoEmail: 0,
      errors: 0,
    };

    try {
      // 1. Listar todos los usuarios de Convex
      console.log("[Backfill] 📋 Obteniendo usuarios de Convex...");
      const convexUsers = await ctx.runQuery(
        internal.data.corUsers.listAllConvexUsers,
        {},
      );
      stats.totalConvexUsers = convexUsers.length;
      console.log(
        `[Backfill] ✅ ${convexUsers.length} usuarios encontrados en Convex`,
      );

      if (convexUsers.length === 0) {
        console.log("[Backfill] ⚠️ No hay usuarios en Convex. Nada que hacer.");
        return { success: true, stats };
      }

      // 2. Listar todos los usuarios de COR (una sola llamada HTTP)
      console.log("[Backfill] 📋 Obteniendo usuarios de COR (page=false)...");
      const provider = getProjectManagementProvider();

      if (provider.name === "noop") {
        console.log(
          "[Backfill] ❌ Provider es noop — no se puede hacer backfill sin integración COR.",
        );
        return { success: false, error: "Provider es noop", stats };
      }

      const corUsers = await provider.listAllUsers();
      stats.totalCORUsers = corUsers.length;
      console.log(
        `[Backfill] ✅ ${corUsers.length} usuarios encontrados en COR`,
      );

      if (corUsers.length === 0) {
        console.log(
          "[Backfill] ⚠️ No se obtuvieron usuarios de COR. Verifica las credenciales.",
        );
        return { success: false, error: "COR retornó 0 usuarios", stats };
      }

      // 3. Crear mapa de email → COR user para búsqueda O(1)
      const corUsersByEmail = new Map<string, (typeof corUsers)[0]>();
      for (const cu of corUsers) {
        if (cu.email) {
          corUsersByEmail.set(cu.email.toLowerCase(), cu);
        }
      }
      console.log(
        `[Backfill] 📊 ${corUsersByEmail.size} usuarios de COR con email indexados`,
      );

      // 4. Verificar cuáles ya tienen corUser
      console.log(
        "[Backfill] 🔍 Verificando cuáles usuarios ya tienen corUser...",
      );

      // 5. Cruzar usuarios
      console.log("[Backfill] 🔄 Cruzando usuarios Convex ↔ COR...\n");

      for (const convexUser of convexUsers) {
        const email = convexUser.email;
        const name = convexUser.name || "(sin nombre)";

        if (!email) {
          console.log(
            `[Backfill] ⚠️ SKIP: ${name} (ID: ${convexUser._id}) — sin email`,
          );
          stats.skippedNoEmail++;
          continue;
        }

        // Verificar si ya tiene corUser
        const existingCorUser = await ctx.runQuery(
          internal.data.corUsers.getCorUserByUserId,
          { userId: convexUser._id },
        );

        if (existingCorUser) {
          console.log(
            `[Backfill] ℹ️ YA EXISTE: ${name} (${email}) → COR ID: ${existingCorUser.corUserId}`,
          );
          stats.alreadyExisted++;
          stats.matched++;
          continue;
        }

        // Buscar match por email en COR
        const corMatch = corUsersByEmail.get(email.toLowerCase());

        if (!corMatch) {
          console.log(
            `[Backfill] ⚠️ SIN MATCH: ${name} (${email}) — no encontrado en COR`,
          );
          stats.noMatch++;
          continue;
        }

        // Match encontrado → upsert
        try {
          await ctx.runMutation(internal.data.corUsers.upsertCorUser, {
            userId: convexUser._id,
            corUserId: corMatch.id,
            corFirstName: corMatch.firstName,
            corLastName: corMatch.lastName,
            corEmail: corMatch.email,
            corRoleId: corMatch.roleId,
            corPositionName: corMatch.positionName,
          });

          console.log(
            `[Backfill] ✅ CREADO: ${name} (${email}) → COR: ${corMatch.firstName} ${corMatch.lastName} (ID: ${corMatch.id}, Rol: ${corMatch.roleId})`,
          );
          stats.matched++;
          stats.created++;
        } catch (error) {
          console.error(
            `[Backfill] ❌ ERROR upsert para ${name} (${email}):`,
            error instanceof Error ? error.message : String(error),
          );
          stats.errors++;
        }
      }

      // 6. Resumen final
      console.log("\n" + "=".repeat(60));
      console.log("[Backfill] 📊 RESUMEN backfillCorUsers:");
      console.log(`  Usuarios Convex:       ${stats.totalConvexUsers}`);
      console.log(`  Usuarios COR:          ${stats.totalCORUsers}`);
      console.log(`  Matched total:         ${stats.matched}`);
      console.log(`    - Ya existían:       ${stats.alreadyExisted}`);
      console.log(`    - Creados ahora:     ${stats.created}`);
      console.log(`  Sin match en COR:      ${stats.noMatch}`);
      console.log(`  Sin email (skipped):   ${stats.skippedNoEmail}`);
      console.log(`  Errores:               ${stats.errors}`);
      console.log("=".repeat(60) + "\n");

      return { success: true, stats };
    } catch (error) {
      console.error("[Backfill] ❌ ERROR FATAL en backfillCorUsers:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        stats,
      };
    }
  },
});

// ==================== 2. BACKFILL COR CLIENTS ====================

/**
 * Importa TODOS los clientes desde COR a la tabla corClients.
 *
 * Flujo:
 *   1. Llama GET /clients?page=false (trae todos sin paginación)
 *   2. Para cada cliente → upsert en tabla corClients
 *
 * Logs detallados:
 *   - ✅ Para cada cliente creado/actualizado
 *   - ❌ Para errores individuales
 *   - 📊 Resumen final con contadores
 *
 * Ejecutar desde: Dashboard de Convex → Functions → data/backfill:backfillCorClients → Run
 */
export const backfillCorClients = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("\n" + "=".repeat(60));
    console.log("[Backfill] 🚀 INICIO: backfillCorClients");
    console.log("=".repeat(60));

    const stats = {
      totalCORClients: 0,
      created: 0,
      updated: 0,
      errors: 0,
      errorDetails: [] as string[],
    };

    try {
      // 1. Obtener todos los clientes de COR
      console.log("[Backfill] 📋 Obteniendo clientes de COR (page=false)...");
      const provider = getProjectManagementProvider();

      if (provider.name === "noop") {
        console.log(
          "[Backfill] ❌ Provider es noop — no se puede hacer backfill sin integración COR.",
        );
        return { success: false, error: "Provider es noop", stats };
      }

      const corClients = await provider.listAllClients();
      stats.totalCORClients = corClients.length;
      console.log(
        `[Backfill] ✅ ${corClients.length} clientes obtenidos de COR`,
      );

      if (corClients.length === 0) {
        console.log(
          "[Backfill] ⚠️ COR retornó 0 clientes. Verifica las credenciales.",
        );
        return { success: false, error: "COR retornó 0 clientes", stats };
      }

      // 2. Upsert cada cliente
      console.log("[Backfill] 🔄 Importando clientes...\n");

      for (const client of corClients) {
        try {
          // Verificar si ya existe para loguear create vs update
          const existing = await ctx.runQuery(
            internal.data.corClients.getClientByCorId,
            { corClientId: client.id },
          );

          await ctx.runMutation(internal.data.corClients.upsertClient, {
            corClientId: client.id,
            name: client.name,
            businessName: client.businessName,
            nameContact: client.nameContact,
            lastNameContact: client.lastNameContact,
            emailContact: client.email,
            website: client.website,
            description: client.description,
            phone: client.phone,
          });

          if (existing) {
            console.log(
              `[Backfill] 🔄 ACTUALIZADO: ${client.name} (COR ID: ${client.id})`,
            );
            stats.updated++;
          } else {
            console.log(
              `[Backfill] ✅ CREADO: ${client.name} (COR ID: ${client.id})`,
            );
            stats.created++;
          }
        } catch (error) {
          const errorMsg = `${client.name} (COR ID: ${client.id}): ${error instanceof Error ? error.message : String(error)}`;
          console.error(`[Backfill] ❌ ERROR: ${errorMsg}`);
          stats.errors++;
          stats.errorDetails.push(errorMsg);
        }
      }

      // 3. Resumen final
      console.log("\n" + "=".repeat(60));
      console.log("[Backfill] 📊 RESUMEN backfillCorClients:");
      console.log(`  Clientes en COR:       ${stats.totalCORClients}`);
      console.log(`  Creados:               ${stats.created}`);
      console.log(`  Actualizados:          ${stats.updated}`);
      console.log(`  Errores:               ${stats.errors}`);
      if (stats.errorDetails.length > 0) {
        console.log(`  Detalle errores:`);
        stats.errorDetails.forEach((e) => console.log(`    - ${e}`));
      }
      console.log("=".repeat(60) + "\n");

      return { success: true, stats };
    } catch (error) {
      console.error("[Backfill] ❌ ERROR FATAL en backfillCorClients:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        stats,
      };
    }
  },
});

// ==================== 3. SYNC CLIENT BRANDS ====================

/**
 * Importa las marcas de COR asociadas a un cliente.
 *
 * COR no expone un endpoint directo de marcas por cliente, por eso:
 *   1. Lista TODAS las marcas con GET /brands usando paginado.
 *   2. Filtra localmente por client_id === corClientId.
 *   3. Upsert en clientBrands.
 *
 * Ejecutar desde:
 * Dashboard de Convex → Functions → data/backfill:syncClientBrandsFromCOR → Run
 */
export const syncClientBrandsFromCOR = internalAction({
  args: {
    corClientId: v.number(),
  },
  handler: async (ctx, args): Promise<any> => {
    console.log("\n" + "=".repeat(60));
    console.log("[ClientBrands] 🚀 INICIO: syncClientBrandsFromCOR");
    console.log(`[ClientBrands] COR client_id: ${args.corClientId}`);
    console.log("=".repeat(60));

    const stats = {
      totalCORBrands: 0,
      matchedForClient: 0,
      created: 0,
      updated: 0,
      errors: 0,
      errorDetails: [] as string[],
    };

    try {
      const provider = getProjectManagementProvider();

      if (provider.name === "noop") {
        console.log(
          "[ClientBrands] ❌ Provider es noop — no se puede sincronizar marcas sin integración COR.",
        );
        return { success: false, error: "Provider es noop", stats };
      }

      const localClient: any = await ctx.runQuery(
        internal.data.clientBrands.getLocalClientByCorId,
        { corClientId: args.corClientId },
      );

      if (!localClient) {
        console.log(
          `[ClientBrands] ⚠️ No existe corClients para COR client_id ${args.corClientId}. Se guardarán las marcas sin clientId local.`,
        );
      } else {
        console.log(
          `[ClientBrands] Cliente local: ${localClient.name} (${localClient._id})`,
        );
      }

      console.log("[ClientBrands] 📋 Obteniendo todas las marcas de COR...");
      const allBrands = await provider.listAllBrands();
      stats.totalCORBrands = allBrands.length;

      const clientBrands = allBrands.filter(
        (brand) => brand.clientId === args.corClientId,
      );
      stats.matchedForClient = clientBrands.length;

      console.log(
        `[ClientBrands] ✅ ${clientBrands.length} marcas encontradas para cliente ${args.corClientId} de ${allBrands.length} marcas totales`,
      );

      for (const brand of clientBrands) {
        try {
          const result = await ctx.runMutation(
            internal.data.clientBrands.upsertClientBrand,
            {
              clientId: localClient?._id,
              corClientId: args.corClientId,
              corBrandId: brand.id,
              name: brand.name,
            },
          );

          if (result.created) {
            stats.created++;
            console.log(
              `[ClientBrands] ✅ CREADA: ${brand.name} (brand_id: ${brand.id})`,
            );
          } else {
            stats.updated++;
            console.log(
              `[ClientBrands] 🔄 ACTUALIZADA: ${brand.name} (brand_id: ${brand.id})`,
            );
          }
        } catch (error) {
          const errorMsg = `${brand.name} (brand_id: ${brand.id}): ${
            error instanceof Error ? error.message : String(error)
          }`;
          stats.errors++;
          stats.errorDetails.push(errorMsg);
          console.error(`[ClientBrands] ❌ ERROR: ${errorMsg}`);
        }
      }

      console.log("\n" + "=".repeat(60));
      console.log("[ClientBrands] 📊 RESUMEN syncClientBrandsFromCOR:");
      console.log(`  Marcas COR totales:      ${stats.totalCORBrands}`);
      console.log(`  Marcas del cliente:      ${stats.matchedForClient}`);
      console.log(`  Creadas:                 ${stats.created}`);
      console.log(`  Actualizadas:            ${stats.updated}`);
      console.log(`  Errores:                 ${stats.errors}`);
      if (stats.errorDetails.length > 0) {
        console.log("  Detalle errores:");
        stats.errorDetails.forEach((e) => console.log(`    - ${e}`));
      }
      console.log("=".repeat(60) + "\n");

      return {
        success: true,
        corClientId: args.corClientId,
        localClientId: localClient?._id,
        brands: clientBrands,
        stats,
      };
    } catch (error) {
      console.error(
        "[ClientBrands] ❌ ERROR FATAL en syncClientBrandsFromCOR:",
        error,
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        stats,
      };
    }
  },
});

// ==================== 4. SYNC SUB BRANDS ====================

/**
 * Importa los productos de COR asociados a una marca.
 *
 * En Convex estos productos se guardan como subBrands.
 * COR no expone aquí un endpoint directo de productos por marca, por eso:
 *   1. Lista TODOS los productos con GET /products usando paginado.
 *   2. Filtra localmente por brand_id === corBrandId.
 *   3. Upsert en subBrands.
 *
 * Ejecutar desde:
 * Dashboard de Convex → Functions → data/backfill:syncSubBrandsFromCOR → Run
 */
export const syncSubBrandsFromCOR = internalAction({
  args: {
    corBrandId: v.number(),
  },
  handler: async (ctx, args): Promise<any> => {
    console.log("\n" + "=".repeat(60));
    console.log("[SubBrands] 🚀 INICIO: syncSubBrandsFromCOR");
    console.log(`[SubBrands] COR brand_id: ${args.corBrandId}`);
    console.log("=".repeat(60));

    const stats = {
      totalCORProducts: 0,
      matchedForBrand: 0,
      created: 0,
      updated: 0,
      errors: 0,
      errorDetails: [] as string[],
    };

    try {
      const provider = getProjectManagementProvider();

      if (provider.name === "noop") {
        console.log(
          "[SubBrands] ❌ Provider es noop — no se puede sincronizar productos sin integración COR.",
        );
        return { success: false, error: "Provider es noop", stats };
      }

      const localBrand: any = await ctx.runQuery(
        internal.data.subBrands.getLocalBrandByCorId,
        { corBrandId: args.corBrandId },
      );

      if (!localBrand) {
        console.log(
          `[SubBrands] ❌ No existe clientBrands para COR brand_id ${args.corBrandId}. Sin la marca local no se pueden guardar subBrands.`,
        );
        return {
          success: false,
          error: `No existe clientBrands para COR brand_id ${args.corBrandId}`,
          stats,
        };
      }

      console.log(
        `[SubBrands] Marca local: ${localBrand.name} (${localBrand._id})`,
      );

      console.log("[SubBrands] 📋 Obteniendo todos los productos de COR...");
      const allProducts = await provider.listAllProducts();
      stats.totalCORProducts = allProducts.length;

      const brandProducts = allProducts.filter(
        (product) => product.brandId === args.corBrandId,
      );
      stats.matchedForBrand = brandProducts.length;

      console.log(
        `[SubBrands] ✅ ${brandProducts.length} productos encontrados para marca ${args.corBrandId} de ${allProducts.length} productos totales`,
      );

      for (const product of brandProducts) {
        try {
          const result = await ctx.runMutation(
            internal.data.subBrands.upsertSubBrand,
            {
              clientBrandId: localBrand._id,
              clientId: localBrand.clientId,
              corClientId: product.clientId,
              corBrandId: product.brandId,
              corProductId: product.id,
              name: product.name,
            },
          );

          if (result.created) {
            stats.created++;
            console.log(
              `[SubBrands] ✅ CREADA: ${product.name} (product_id: ${product.id})`,
            );
          } else {
            stats.updated++;
            console.log(
              `[SubBrands] 🔄 ACTUALIZADA: ${product.name} (product_id: ${product.id})`,
            );
          }
        } catch (error) {
          const errorMsg = `${product.name} (product_id: ${product.id}): ${
            error instanceof Error ? error.message : String(error)
          }`;
          stats.errors++;
          stats.errorDetails.push(errorMsg);
          console.error(`[SubBrands] ❌ ERROR: ${errorMsg}`);
        }
      }

      console.log("\n" + "=".repeat(60));
      console.log("[SubBrands] 📊 RESUMEN syncSubBrandsFromCOR:");
      console.log(`  Productos COR totales:   ${stats.totalCORProducts}`);
      console.log(`  Productos de la marca:   ${stats.matchedForBrand}`);
      console.log(`  Creados:                 ${stats.created}`);
      console.log(`  Actualizados:            ${stats.updated}`);
      console.log(`  Errores:                 ${stats.errors}`);
      if (stats.errorDetails.length > 0) {
        console.log("  Detalle errores:");
        stats.errorDetails.forEach((e) => console.log(`    - ${e}`));
      }
      console.log("=".repeat(60) + "\n");

      return {
        success: true,
        corBrandId: args.corBrandId,
        localBrandId: localBrand._id,
        subBrands: brandProducts,
        stats,
      };
    } catch (error) {
      console.error(
        "[SubBrands] ❌ ERROR FATAL en syncSubBrandsFromCOR:",
        error,
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        stats,
      };
    }
  },
});

// ==================== 5. BACKFILL TASK CLIENT IDS ====================

/**
 * Agrega tasks.clientId a tasks existentes.
 *
 * Resolución por task:
 *   1. clientBrandId -> clientBrands.clientId
 *   2. projectId -> projects.clientId
 *   3. corClientId -> corClients.by_corClientId
 *   4. corClientName -> match normalizado con corClients.name
 *
 * Ejecutar desde:
 * Dashboard de Convex → Functions → data/backfill:backfillTaskClientIds → Run
 */
export const backfillTaskClientIds = internalAction({
  args: {
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    console.log("\n" + "=".repeat(60));
    console.log("[BackfillTaskClientIds] 🚀 INICIO");
    console.log(
      `[BackfillTaskClientIds] dryRun=${args.dryRun === true}, limit=${args.limit ?? 500}`,
    );
    console.log("=".repeat(60));

    const stats = {
      reviewed: 0,
      updated: 0,
      wouldUpdate: 0,
      alreadySet: 0,
      unresolved: 0,
      missing: 0,
      errors: 0,
      byReason: {} as Record<string, number>,
      unresolvedTasks: [] as Array<{
        taskId: string;
        title: string;
        corClientId?: number;
        corClientName?: string;
      }>,
      errorDetails: [] as string[],
    };

    const tasks = await ctx.runQuery(
      internal.data.tasks.listTasksForClientIdBackfill,
      {
        limit: args.limit,
      },
    );

    stats.reviewed = tasks.length;

    for (const task of tasks) {
      try {
        const result = await ctx.runMutation(
          internal.data.tasks.backfillTaskClientId,
          {
            taskId: task._id,
            dryRun: args.dryRun,
          },
        );

        if (result.status === "updated") stats.updated++;
        if (result.status === "would_update") stats.wouldUpdate++;
        if (result.status === "already_set") stats.alreadySet++;
        if (result.status === "missing") stats.missing++;

        if (
          result.status === "updated" ||
          result.status === "would_update" ||
          result.status === "already_set"
        ) {
          const reason = result.reason ?? "unknown";
          stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
        }

        if (result.status === "unresolved") {
          stats.unresolved++;
          stats.unresolvedTasks.push({
            taskId: String(result.taskId),
            title: result.title,
            corClientId: result.corClientId,
            corClientName: result.corClientName,
          });
        }
      } catch (error) {
        const errorMsg = `${task._id}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        stats.errors++;
        stats.errorDetails.push(errorMsg);
        console.error(`[BackfillTaskClientIds] ❌ ${errorMsg}`);
      }
    }

    console.log("[BackfillTaskClientIds] 📊 RESUMEN:");
    console.log(`  Revisadas:       ${stats.reviewed}`);
    console.log(`  Actualizadas:    ${stats.updated}`);
    console.log(`  Would update:    ${stats.wouldUpdate}`);
    console.log(`  Ya tenían:       ${stats.alreadySet}`);
    console.log(`  Sin resolver:    ${stats.unresolved}`);
    console.log(`  Missing:         ${stats.missing}`);
    console.log(`  Errores:         ${stats.errors}`);
    console.log(`  Por razón:       ${JSON.stringify(stats.byReason)}`);
    if (stats.unresolvedTasks.length > 0) {
      console.log("  Sin resolver:");
      for (const unresolved of stats.unresolvedTasks) {
        console.log(
          `    - ${unresolved.taskId} | ${unresolved.title} | corClientId=${unresolved.corClientId} | corClientName=${unresolved.corClientName}`,
        );
      }
    }
    console.log("=".repeat(60) + "\n");

    return {
      success: stats.errors === 0,
      dryRun: args.dryRun === true,
      stats,
    };
  },
});

// ==================== 6. BACKFILL TASK DELIVERABLES COUNT ====================

/**
 * Agrega tasks.deliverablesCount a tasks existentes usando el deliverables
 * del proyecto asociado. Es seguro para el histórico actual porque cada task
 * existente nació con su propio proyecto.
 *
 * Ejecutar primero en dry run:
 * Dashboard de Convex → Functions → data/backfill:backfillTaskDeliverablesCount
 * Args: { "dryRun": true, "limit": 100 }
 */
export const backfillTaskDeliverablesCount = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    console.log("\n" + "=".repeat(60));
    console.log("[BackfillTaskDeliverablesCount] 🚀 INICIO");
    console.log(
      `[BackfillTaskDeliverablesCount] dryRun=${dryRun}, limit=${args.limit ?? 500}`,
    );
    console.log("=".repeat(60));

    const stats = {
      reviewed: 0,
      updated: 0,
      wouldUpdate: 0,
      alreadySet: 0,
      unresolved: 0,
      missing: 0,
      errors: 0,
      unresolvedTasks: [] as Array<{
        taskId: string;
        title: string;
        reason?: string;
      }>,
      errorDetails: [] as string[],
    };

    const tasks = await ctx.runQuery(
      internal.data.tasks.listTasksForDeliverablesCountBackfill,
      { limit: args.limit },
    );

    stats.reviewed = tasks.length;

    for (const task of tasks) {
      try {
        const result = await ctx.runMutation(
          internal.data.tasks.backfillTaskDeliverablesCount,
          {
            taskId: task._id,
            dryRun,
          },
        );

        if (result.status === "updated") stats.updated++;
        if (result.status === "would_update") stats.wouldUpdate++;
        if (result.status === "already_set") stats.alreadySet++;
        if (result.status === "missing") stats.missing++;
        if (result.status === "unresolved") {
          stats.unresolved++;
          stats.unresolvedTasks.push({
            taskId: String(result.taskId),
            title: result.title,
            reason: result.reason,
          });
        }
      } catch (error) {
        const errorMsg = `${task._id}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        stats.errors++;
        stats.errorDetails.push(errorMsg);
        console.error(`[BackfillTaskDeliverablesCount] ❌ ${errorMsg}`);
      }
    }

    console.log("[BackfillTaskDeliverablesCount] 📊 RESUMEN:");
    console.log(`  Revisadas:       ${stats.reviewed}`);
    console.log(`  Actualizadas:    ${stats.updated}`);
    console.log(`  Would update:    ${stats.wouldUpdate}`);
    console.log(`  Ya tenían:       ${stats.alreadySet}`);
    console.log(`  Sin resolver:    ${stats.unresolved}`);
    console.log(`  Missing:         ${stats.missing}`);
    console.log(`  Errores:         ${stats.errors}`);
    if (stats.unresolvedTasks.length > 0) {
      console.log("  Sin resolver:");
      for (const unresolved of stats.unresolvedTasks) {
        console.log(
          `    - ${unresolved.taskId} | ${unresolved.title} | reason=${unresolved.reason}`,
        );
      }
    }
    console.log("=".repeat(60) + "\n");

    return {
      success: stats.errors === 0,
      dryRun,
      stats,
    };
  },
});

// ==================== 7. BACKFILL TASK EVALUATIONS ====================

/**
 * Migra evaluaciones reales desde los mensajes existentes del agent component.
 *
 * Importante:
 * - evaluationThreads se mantiene como thread único por task.
 * - taskEvaluations se crea solo si el thread tiene un mensaje de usuario con
 *   archivos y una respuesta posterior del agente.
 *
 * Ejecutar primero en dry run:
 * Dashboard de Convex → Functions → data/backfill:backfillTaskEvaluationsFromThreads
 * Args: { "dryRun": true, "limit": 100 }
 */
export const backfillTaskEvaluationsFromThreads = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    console.log("\n" + "=".repeat(60));
    console.log("[BackfillTaskEvaluations] 🚀 INICIO");
    console.log(`[BackfillTaskEvaluations] dryRun=${dryRun}`);
    console.log("=".repeat(60));

    const stats = {
      threadsReviewed: 0,
      unusedThreads: 0,
      candidateEvaluations: 0,
      wouldCreate: 0,
      created: 0,
      alreadyExists: 0,
      missingTask: 0,
      incomplete: 0,
      errors: 0,
      details: [] as Array<{
        taskId: string;
        evaluationThreadId: string;
        fileCount: number;
        requestedAt: number;
        completedAt: number;
        resultPreview: string;
      }>,
      errorDetails: [] as string[],
    };

    const evaluationThreads = await ctx.runQuery(
      internal.data.evaluation.listEvaluationThreadsForBackfill,
      { limit: args.limit },
    );

    stats.threadsReviewed = evaluationThreads.length;

    for (const evalThread of evaluationThreads) {
      try {
        const messagesResult = await listMessages(ctx, components.agent, {
          threadId: evalThread.evaluationThreadId,
          paginationOpts: { cursor: null, numItems: 100 },
          excludeToolMessages: true,
        });

        const messages = [...messagesResult.page].sort((a: any, b: any) => {
          if (a.order !== b.order) return a.order - b.order;
          if (a.stepOrder !== b.stepOrder) return a.stepOrder - b.stepOrder;
          return a._creationTime - b._creationTime;
        });

        const userMessages = messages.filter((message: any) => {
          return (
            message.message?.role === "user" &&
            Array.isArray(message.fileIds) &&
            message.fileIds.length > 0
          );
        });

        if (userMessages.length === 0) {
          stats.unusedThreads++;
          continue;
        }

        for (const userMessage of userMessages) {
          const assistantMessage = messages.find((message: any) => {
            return (
              message.message?.role === "assistant" &&
              !message.tool &&
              message._creationTime >= userMessage._creationTime &&
              typeof message.text === "string" &&
              message.text.trim().length > 0
            );
          }) as any;

          if (!assistantMessage) {
            stats.incomplete++;
            continue;
          }

          stats.candidateEvaluations++;
          const fileIds = uniqueStrings(userMessage.fileIds ?? []);
          const resultText = assistantMessage.text.trim();
          const detail = {
            taskId: String(evalThread.taskId),
            evaluationThreadId: evalThread.evaluationThreadId,
            fileCount: fileIds.length,
            requestedAt: userMessage._creationTime,
            completedAt: assistantMessage._creationTime,
            resultPreview: resultText.slice(0, 180),
          };
          stats.details.push(detail);

          if (dryRun) {
            stats.wouldCreate++;
            continue;
          }

          const result = await ctx.runMutation(
            internal.data.evaluation.createBackfilledTaskEvaluation,
            {
              taskId: evalThread.taskId,
              evaluationThreadId: evalThread.evaluationThreadId,
              originalThreadId: evalThread.originalThreadId,
              requestedBy: userMessage.userId,
              requestedBySource: userMessage.userId ? "message" : "unknown",
              requestedAt: userMessage._creationTime,
              completedAt: assistantMessage._creationTime,
              prompt: extractMessageText(userMessage),
              inputFileIds: fileIds,
              userMessageId: userMessage._id,
              resultMessageId: assistantMessage._id,
              resultText,
              resultProvider: assistantMessage.provider,
            },
          );

          if (result.status === "created") stats.created++;
          if (result.status === "already_exists") stats.alreadyExists++;
          if (result.status === "missing_task") stats.missingTask++;
        }
      } catch (error) {
        const errorMsg = `${evalThread.evaluationThreadId}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        stats.errors++;
        stats.errorDetails.push(errorMsg);
        console.error(`[BackfillTaskEvaluations] ❌ ${errorMsg}`);
      }
    }

    console.log("[BackfillTaskEvaluations] 📊 RESUMEN:");
    console.log(`  Threads revisados:       ${stats.threadsReviewed}`);
    console.log(`  Threads sin uso:         ${stats.unusedThreads}`);
    console.log(`  Candidatas completas:    ${stats.candidateEvaluations}`);
    console.log(`  Incompletas:             ${stats.incomplete}`);
    console.log(`  Would create:            ${stats.wouldCreate}`);
    console.log(`  Creadas:                 ${stats.created}`);
    console.log(`  Ya existían:             ${stats.alreadyExists}`);
    console.log(`  Task faltante:           ${stats.missingTask}`);
    console.log(`  Errores:                 ${stats.errors}`);
    console.log("=".repeat(60) + "\n");

    return {
      success: stats.errors === 0,
      dryRun,
      stats,
    };
  },
});

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractMessageText(message: any) {
  if (typeof message.text === "string" && message.text.trim()) {
    return message.text.trim();
  }

  const content = message.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const text = content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");

  return text || undefined;
}
