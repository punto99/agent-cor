import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

const audienceValidator = v.union(v.literal("internal"), v.literal("external"));

function appliesToAudience(
  audience: "internal" | "external" | undefined,
  requestedAudience: "internal" | "external",
) {
  return audience === undefined || audience === requestedAudience;
}

function formatKnowledgeRecords(
  records: Array<{
    name: string;
    audience?: "internal" | "external";
    text: string;
  }>,
) {
  if (records.length === 0) return undefined;

  return records
    .map((record) => {
      const audienceLabel = record.audience
        ? `\nAudiencia: ${record.audience}`
        : "";
      return `## ${record.name}${audienceLabel}\n\n${record.text.trim()}`;
    })
    .join("\n\n---\n\n");
}

export const getForAgent = internalQuery({
  args: {
    corClientId: v.number(),
    audience: audienceValidator,
  },
  handler: async (ctx, args) => {
    const agencyRecords = await ctx.db
      .query("clientKnowledge")
      .withIndex("by_scope", (q) => q.eq("scope", "agency"))
      .collect();

    const clientRecords = await ctx.db
      .query("clientKnowledge")
      .withIndex("by_corClientId", (q) => q.eq("corClientId", args.corClientId))
      .collect();

    const filteredAgency = agencyRecords
      .filter((record) => appliesToAudience(record.audience, args.audience))
      .sort((a, b) => a.name.localeCompare(b.name));

    const filteredClient = clientRecords
      .filter(
        (record) =>
          record.scope === "client" &&
          appliesToAudience(record.audience, args.audience),
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      agency: formatKnowledgeRecords(filteredAgency),
      client: formatKnowledgeRecords(filteredClient),
    };
  },
});

export const upsert = internalMutation({
  args: {
    scope: v.union(v.literal("agency"), v.literal("client")),
    corClientId: v.optional(v.number()),
    audience: v.optional(audienceValidator),
    name: v.string(),
    text: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.scope === "client" && args.corClientId === undefined) {
      throw new Error("clientKnowledge scope=client requiere corClientId.");
    }

    if (args.scope === "agency" && args.corClientId !== undefined) {
      throw new Error("clientKnowledge scope=agency no debe tener corClientId.");
    }

    const now = Date.now();
    const candidates =
      args.scope === "agency"
        ? await ctx.db
            .query("clientKnowledge")
            .withIndex("by_scope", (q) => q.eq("scope", "agency"))
            .collect()
        : await ctx.db
            .query("clientKnowledge")
            .withIndex("by_corClientId_audience", (q) =>
              q.eq("corClientId", args.corClientId).eq("audience", args.audience),
            )
            .collect();

    const existing = candidates.find(
      (record) =>
        record.scope === args.scope &&
        record.corClientId === args.corClientId &&
        record.audience === args.audience &&
        record.name === args.name,
    );

    if (existing) {
      await ctx.db.patch(existing._id, {
        text: args.text,
        source: args.source,
        updatedAt: now,
      });
      return { id: existing._id, created: false };
    }

    const id = await ctx.db.insert("clientKnowledge", {
      scope: args.scope,
      corClientId: args.corClientId,
      audience: args.audience,
      name: args.name,
      text: args.text,
      source: args.source,
      updatedAt: now,
    });

    return { id, created: true };
  },
});

export const listInternal = internalQuery({
  args: {
    scope: v.optional(v.union(v.literal("agency"), v.literal("client"))),
    corClientId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.corClientId !== undefined) {
      return await ctx.db
        .query("clientKnowledge")
        .withIndex("by_corClientId", (q) => q.eq("corClientId", args.corClientId))
        .collect();
    }

    if (args.scope) {
      return await ctx.db
        .query("clientKnowledge")
        .withIndex("by_scope", (q) => q.eq("scope", args.scope!))
        .collect();
    }

    return await ctx.db.query("clientKnowledge").collect();
  },
});
