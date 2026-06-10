import { v } from "convex/values";
import { query } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

async function isExternalUser(ctx: any, userId: any) {
  const approvedExternalUser = await ctx.db
    .query("approvedExternalUsers")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .unique();
  return Boolean(approvedExternalUser);
}

function formatUserName(user: Record<string, unknown> | null) {
  if (!user) return undefined;
  const name = typeof user.name === "string" ? user.name.trim() : "";
  const email = typeof user.email === "string" ? user.email.trim() : "";
  return name || email || undefined;
}

export const listMyClientProjects = query({
  args: {
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (await isExternalUser(ctx, userId)) return [];

    const userIdStr = String(userId);
    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    if (assignments.length === 0) return [];

    const fullClientIds = new Set<string>();
    const brandIds = new Set<string>();
    const authorizedClientIds = new Set<string>();

    for (const assignment of assignments) {
      authorizedClientIds.add(String(assignment.clientId));
      if (assignment.brandId) {
        brandIds.add(String(assignment.brandId));
      } else {
        fullClientIds.add(String(assignment.clientId));
      }
    }

    const clientsById = new Map<string, any>();
    for (const clientId of authorizedClientIds) {
      const client = await ctx.db.get(clientId as any);
      if (client) clientsById.set(clientId, client);
    }

    const brandsById = new Map<string, any>();
    for (const brandId of brandIds) {
      const brand = await ctx.db.get(brandId as any);
      if (brand) brandsById.set(brandId, brand);
    }

    for (const clientId of fullClientIds) {
      const clientBrands = await ctx.db
        .query("clientBrands")
        .withIndex("by_client", (q) => q.eq("clientId", clientId as any))
        .collect();
      for (const brand of clientBrands)
        brandsById.set(String(brand._id), brand);
    }

    const tasksById = new Map<string, any>();

    for (const clientId of fullClientIds) {
      const ownClientTasksQuery = ctx.db
        .query("tasks")
        .withIndex("by_createdBy_clientId_status", (q) => {
          const byClient = q
            .eq("createdBy", userIdStr)
            .eq("clientId", clientId as any);
          return args.status ? byClient.eq("status", args.status) : byClient;
        });
      const ownClientTasks = await ownClientTasksQuery.collect();
      for (const task of ownClientTasks) tasksById.set(String(task._id), task);

      const externalClientTasksQuery = ctx.db
        .query("tasks")
        .withIndex("by_clientId_source_status", (q) => {
          const bySource = q
            .eq("clientId", clientId as any)
            .eq("source", "external");
          return args.status ? bySource.eq("status", args.status) : bySource;
        });
      const externalClientTasks = await externalClientTasksQuery.collect();
      for (const task of externalClientTasks)
        tasksById.set(String(task._id), task);
    }

    for (const brandId of brandIds) {
      const ownBrandTasksQuery = ctx.db
        .query("tasks")
        .withIndex("by_createdBy_clientBrandId_status", (q) => {
          const byBrand = q
            .eq("createdBy", userIdStr)
            .eq("clientBrandId", brandId as any);
          return args.status ? byBrand.eq("status", args.status) : byBrand;
        });
      const ownBrandTasks = await ownBrandTasksQuery.collect();
      for (const task of ownBrandTasks) tasksById.set(String(task._id), task);

      const externalBrandTasksQuery = ctx.db
        .query("tasks")
        .withIndex("by_clientBrandId_source_status", (q) => {
          const bySource = q
            .eq("clientBrandId", brandId as any)
            .eq("source", "external");
          return args.status ? bySource.eq("status", args.status) : bySource;
        });
      const externalBrandTasks = await externalBrandTasksQuery.collect();
      for (const task of externalBrandTasks)
        tasksById.set(String(task._id), task);
    }

    const tasksByClient = new Map<string, any[]>();
    const projectsById = new Map<string, any>();
    const creatorInfoById = new Map<
      string,
      { createdByName?: string; createdByEmail?: string }
    >();

    const getCreatorInfo = async (createdBy: unknown) => {
      if (typeof createdBy !== "string" || !createdBy) return {};
      if (creatorInfoById.has(createdBy)) return creatorInfoById.get(createdBy)!;

      const userId = ctx.db.normalizeId("users", createdBy);
      const user = userId
        ? ((await ctx.db.get(userId)) as Record<string, unknown> | null)
        : null;
      const info = {
        createdByName: formatUserName(user),
        createdByEmail:
          typeof user?.email === "string" ? user.email.trim() : undefined,
      };
      creatorInfoById.set(createdBy, info);
      return info;
    };

    for (const task of tasksById.values()) {
      if (task.convexStatus === "deleted") continue;
      if (task.source !== "external" && task.createdBy !== userIdStr) continue;

      const clientId = task.clientId ? String(task.clientId) : null;
      if (!clientId || !clientsById.has(clientId)) continue;

      if (task.clientBrandId) {
        const brand = brandsById.get(String(task.clientBrandId));
        if (!brand?.clientId) continue;

        const hasBrandAccess =
          brandIds.has(String(task.clientBrandId)) ||
          fullClientIds.has(String(brand.clientId));
        if (!hasBrandAccess) continue;
      } else if (!fullClientIds.has(clientId)) {
        continue;
      }

      const taskWithCreator = {
        ...task,
        ...(await getCreatorInfo(task.createdBy)),
      };

      if (!tasksByClient.has(clientId)) tasksByClient.set(clientId, []);
      tasksByClient.get(clientId)!.push(taskWithCreator);

      if (task.projectId && !projectsById.has(String(task.projectId))) {
        const project = (await ctx.db.get(task.projectId as any)) as any;
        if (project && project.convexStatus !== "deleted") {
          projectsById.set(String(project._id), project);
        }
      }
    }

    return Array.from(clientsById.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((client) => {
        const clientId = String(client._id);
        const tasks = tasksByClient.get(clientId) ?? [];
        const projectsMap = new Map<string, { project: any; tasks: any[] }>();

        for (const task of tasks) {
          const projectKey = task.projectId
            ? String(task.projectId)
            : `task:${task._id}`;
          const project = task.projectId
            ? projectsById.get(String(task.projectId))
            : null;

          if (!projectsMap.has(projectKey)) {
            projectsMap.set(projectKey, {
              project: project ?? {
                _id: projectKey,
                name: "Sin proyecto",
                status: "active",
                createdBy: task.createdBy,
                threadId: task.threadId,
              },
              tasks: [],
            });
          }

          projectsMap.get(projectKey)!.tasks.push(task);
        }

        const brandTaskCounts = new Map<string, number>();
        for (const task of tasks) {
          if (!task.clientBrandId) continue;
          const key = String(task.clientBrandId);
          brandTaskCounts.set(key, (brandTaskCounts.get(key) ?? 0) + 1);
        }

        const brands = Array.from(brandsById.values())
          .filter((brand) => String(brand.clientId) === clientId)
          .sort((a, b) => a.name.localeCompare(b.name));

        const projects = Array.from(projectsMap.values()).sort((a, b) => {
          const aTime = Math.max(...a.tasks.map((task) => task._creationTime));
          const bTime = Math.max(...b.tasks.map((task) => task._creationTime));
          return bTime - aTime;
        });

        return {
          client: {
            _id: client._id,
            name: client.name,
            nomenclature: client.nomenclature,
            corClientId: client.corClientId,
          },
          brands: brands.map((brand) => ({
            _id: brand._id,
            name: brand.name,
            corBrandId: brand.corBrandId,
            taskCount: brandTaskCounts.get(String(brand._id)) ?? 0,
          })),
          taskCount: tasks.length,
          projectCount: projects.length,
          projects,
        };
      });
  },
});
