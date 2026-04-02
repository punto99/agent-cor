// convex/ragPages.ts
// CRUD para la tabla ragPages - Páginas de documentos con embeddings
import { query, mutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { cosineSimilarity } from "../lib/math";

// Obtener páginas de un documento
export const getByDocument = query({
  args: { documentId: v.id("ragDocuments") },
  handler: async (ctx, { documentId }) => {
    return await ctx.db
      .query("ragPages")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
  },
});

// Obtener página por ID
export const getById = query({
  args: { id: v.id("ragPages") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

// Obtener una página específica por documento y número
export const getPage = query({
  args: {
    documentId: v.id("ragDocuments"),
    pageNumber: v.number(),
  },
  handler: async (ctx, { documentId, pageNumber }) => {
    return await ctx.db
      .query("ragPages")
      .withIndex("by_document_page", (q) =>
        q.eq("documentId", documentId).eq("pageNumber", pageNumber)
      )
      .first();
  },
});

// Crear una página con todos los campos
export const create = mutation({
  args: {
    documentId: v.id("ragDocuments"),
    pageNumber: v.number(),
    text: v.string(),
    imageStorageId: v.optional(v.id("_storage")),
    imageEmbedding: v.optional(v.array(v.float64())),
    ragEntryId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log(`[RagPages:create] 📄 Creando página ${args.pageNumber}`);
    return await ctx.db.insert("ragPages", args);
  },
});

// Actualizar el ragEntryId de una página existente
export const updateRagEntryId = mutation({
  args: {
    pageId: v.id("ragPages"),
    ragEntryId: v.string(),
  },
  handler: async (ctx, { pageId, ragEntryId }) => {
    await ctx.db.patch(pageId, { ragEntryId });
  },
});

// Actualizar el imageEmbedding de una página
export const updateImageEmbedding = mutation({
  args: {
    pageId: v.id("ragPages"),
    imageEmbedding: v.array(v.float64()),
  },
  handler: async (ctx, { pageId, imageEmbedding }) => {
    await ctx.db.patch(pageId, { imageEmbedding });
  },
});

// Obtener URL de imagen de una página
export const getImageUrl = query({
  args: { pageId: v.id("ragPages") },
  handler: async (ctx, { pageId }) => {
    const page = await ctx.db.get(pageId);
    if (!page || !page.imageStorageId) {
      return null;
    }
    return await ctx.storage.getUrl(page.imageStorageId);
  },
});

// Obtener todas las páginas con ragEntryId (para limpieza)
export const getAllWithRagEntryId = query({
  args: {},
  handler: async (ctx) => {
    const pages = await ctx.db.query("ragPages").collect();
    return pages.filter(p => p.ragEntryId);
  },
});

// Debug: Obtener info de páginas
export const debugPages = query({
  args: {},
  handler: async (ctx) => {
    const pages = await ctx.db.query("ragPages").collect();
    return pages.map(p => ({
      _id: p._id,
      pageNumber: p.pageNumber,
      documentId: p.documentId,
      ragEntryId: p.ragEntryId,
      hasImage: !!p.imageStorageId,
      hasEmbedding: !!(p.imageEmbedding && p.imageEmbedding.length > 0),
      textPreview: p.text.substring(0, 50),
    }));
  },
});

// Estadísticas de páginas
export const getStats = query({
  args: { documentId: v.optional(v.id("ragDocuments")) },
  handler: async (ctx, { documentId }) => {
    let pages;
    if (documentId) {
      pages = await ctx.db
        .query("ragPages")
        .withIndex("by_document", (q) => q.eq("documentId", documentId))
        .collect();
    } else {
      pages = await ctx.db.query("ragPages").collect();
    }
    
    return {
      total: pages.length,
      withText: pages.filter(p => p.text && p.text.length > 0).length,
      withImage: pages.filter(p => p.imageStorageId).length,
      withImageEmbedding: pages.filter(p => p.imageEmbedding && p.imageEmbedding.length > 0).length,
      withRagEntry: pages.filter(p => p.ragEntryId).length,
    };
  },
});

// Query interna para búsqueda vectorial por imagen
export const searchByImageEmbedding = internalQuery({
  args: {
    embedding: v.array(v.float64()),
    limit: v.number(),
  },
  handler: async (ctx, { embedding, limit }) => {
    // Obtener todas las páginas con embedding
    const pages = await ctx.db.query("ragPages").collect();
    
    // Filtrar las que tienen embedding y calcular similitud
    const withScores = pages
      .filter(p => p.imageEmbedding && p.imageEmbedding.length > 0)
      .map(p => ({
        pageId: p._id,
        documentId: p.documentId,
        pageNumber: p.pageNumber,
        score: cosineSimilarity(embedding, p.imageEmbedding!),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    
    return withScores;
  },
});

// cosineSimilarity importada desde lib/math.ts
// Query interna para obtener URL de imagen (para uso en actions)
export const getImageUrlInternal = internalQuery({
  args: { pageId: v.id("ragPages") },
  handler: async (ctx, { pageId }) => {
    const page = await ctx.db.get(pageId);
    if (!page || !page.imageStorageId) return null;
    return await ctx.storage.getUrl(page.imageStorageId);
  },
});
