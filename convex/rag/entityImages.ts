// convex/entityImages.ts
// CRUD para la tabla entityImages - Imágenes de entidades extraídas de documentos
import { query, mutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { cosineSimilarity } from "../lib/math";

// Listar todas las imágenes de entidades
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const images = await ctx.db.query("entityImages").order("desc").collect();
    return limit ? images.slice(0, limit) : images;
  },
});

// Obtener imagen por ID
export const getById = query({
  args: { id: v.id("entityImages") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

// Obtener imágenes de un documento
export const getByDocument = query({
  args: { documentId: v.id("ragDocuments") },
  handler: async (ctx, { documentId }) => {
    return await ctx.db
      .query("entityImages")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
  },
});

// Obtener imágenes de una página
export const getByPage = query({
  args: {
    documentId: v.id("ragDocuments"),
    pageNumber: v.number(),
  },
  handler: async (ctx, { documentId, pageNumber }) => {
    return await ctx.db
      .query("entityImages")
      .withIndex("by_page", (q) => 
        q.eq("documentId", documentId).eq("pageNumber", pageNumber)
      )
      .collect();
  },
});

// Buscar por código de entidad
export const getByEntityCode = query({
  args: { entityCode: v.string() },
  handler: async (ctx, { entityCode }) => {
    return await ctx.db
      .query("entityImages")
      .withIndex("by_entity_code", (q) => q.eq("entityCode", entityCode))
      .collect();
  },
});

// Obtener URL de imagen
export const getImageUrl = query({
  args: { id: v.id("entityImages") },
  handler: async (ctx, { id }) => {
    const entity = await ctx.db.get(id);
    if (!entity || !entity.imageStorageId) {
      return null;
    }
    return await ctx.storage.getUrl(entity.imageStorageId);
  },
});

// Crear una imagen de entidad
export const create = mutation({
  args: {
    documentId: v.id("ragDocuments"),
    pageNumber: v.number(),
    imageStorageId: v.id("_storage"),
    imageEmbedding: v.optional(v.array(v.float64())),
    entityName: v.optional(v.string()),
    entityCode: v.optional(v.string()),
    description: v.optional(v.string()),
    price: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log(`[EntityImages:create] 📷 Creando entidad: ${args.entityName || "sin nombre"}`);
    return await ctx.db.insert("entityImages", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

// Actualizar información de una entidad
export const update = mutation({
  args: {
    id: v.id("entityImages"),
    entityName: v.optional(v.string()),
    entityCode: v.optional(v.string()),
    description: v.optional(v.string()),
    price: v.optional(v.number()),
  },
  handler: async (ctx, { id, ...updates }) => {
    console.log(`[EntityImages:update] 🔄 Actualizando entidad: ${id}`);
    await ctx.db.patch(id, updates);
  },
});

// Actualizar embedding de imagen
export const updateImageEmbedding = mutation({
  args: {
    id: v.id("entityImages"),
    imageEmbedding: v.array(v.float64()),
  },
  handler: async (ctx, { id, imageEmbedding }) => {
    await ctx.db.patch(id, { imageEmbedding });
  },
});

// Eliminar imagen de entidad
export const deleteEntity = mutation({
  args: { id: v.id("entityImages") },
  handler: async (ctx, { id }) => {
    const entity = await ctx.db.get(id);
    if (entity) {
      if (entity.imageStorageId) {
        try {
          await ctx.storage.delete(entity.imageStorageId);
        } catch (e) {
          console.warn(`[EntityImages:delete] ⚠️ No se pudo eliminar imagen: ${entity.imageStorageId}`);
        }
      }
      await ctx.db.delete(id);
      console.log(`[EntityImages:delete] 🗑️ Entidad eliminada: ${id}`);
    }
  },
});

// Estadísticas de imágenes de entidades
export const getStats = query({
  args: { documentId: v.optional(v.id("ragDocuments")) },
  handler: async (ctx, { documentId }) => {
    let images;
    if (documentId) {
      images = await ctx.db
        .query("entityImages")
        .withIndex("by_document", (q) => q.eq("documentId", documentId))
        .collect();
    } else {
      images = await ctx.db.query("entityImages").collect();
    }
    
    const uniqueNames = new Set(images.map(i => i.entityName).filter(Boolean));
    const uniqueCodes = new Set(images.map(i => i.entityCode).filter(Boolean));
    
    return {
      total: images.length,
      withName: images.filter(i => i.entityName).length,
      withCode: images.filter(i => i.entityCode).length,
      withPrice: images.filter(i => i.price !== undefined).length,
      withEmbedding: images.filter(i => i.imageEmbedding && i.imageEmbedding.length > 0).length,
      uniqueEntities: uniqueNames.size,
      uniqueCodes: uniqueCodes.size,
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
    // Obtener todas las entidades con embedding
    const entities = await ctx.db.query("entityImages").collect();
    
    // Filtrar las que tienen embedding y calcular similitud
    const withScores = entities
      .filter(e => e.imageEmbedding && e.imageEmbedding.length > 0)
      .map(e => ({
        entityId: e._id,
        documentId: e.documentId,
        pageNumber: e.pageNumber,
        entityName: e.entityName,
        entityCode: e.entityCode,
        description: e.description,
        price: e.price,
        score: cosineSimilarity(embedding, e.imageEmbedding!),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    
    return withScores;
  },
});

// cosineSimilarity importada desde lib/math.ts

// Query interna para obtener URL de imagen de entidad (para uso en actions)
export const getImageUrlInternal = internalQuery({
  args: { entityId: v.id("entityImages") },
  handler: async (ctx, { entityId }) => {
    const entity = await ctx.db.get(entityId);
    if (!entity || !entity.imageStorageId) return null;
    return await ctx.storage.getUrl(entity.imageStorageId);
  },
});
