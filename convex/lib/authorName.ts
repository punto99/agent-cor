import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// External profiles own their display name; internal profiles use users.name.
export async function getAuthorName(
  ctx: Pick<QueryCtx, "db">,
  userId: Id<"users"> | null | undefined,
  fallback = "Autor sin nombre",
): Promise<string> {
  if (!userId) return fallback;
  const external = await ctx.db.query("approvedExternalUsers")
    .withIndex("by_user", q => q.eq("userId", userId)).unique();
  return external?.name?.trim() || (await ctx.db.get(userId))?.name?.trim() || fallback;
}

type CommentAuthorFields = Pick<Doc<"taskMessages">, "userId" | "source" | "trelloAuthorName">;

// Display metadata must not make a saved comment unavailable. Access checks stay
// in the callers and are deliberately not covered by this fallback.
export async function getCommentAuthor(
  ctx: Pick<QueryCtx, "db">,
  message: CommentAuthorFields,
  fallback = "Autor sin nombre",
): Promise<{ name: string; isExternal: boolean }> {
  const trelloName = message.source === "trello" ? message.trelloAuthorName?.trim() : undefined;
  const author = { name: message.source === "trello" ? trelloName || "Autor sin nombre" : fallback, isExternal: false };
  if (!message.userId) return author;
  try {
    const external = await ctx.db.query("approvedExternalUsers")
      .withIndex("by_user", q => q.eq("userId", message.userId)).unique();
    author.isExternal = Boolean(external);
    // Even historical Trello comments with an internal userId use Trello's name.
    if (message.source === "trello" && !external) return author;
    author.name = external?.name?.trim() || (await ctx.db.get(message.userId))?.name?.trim() || author.name;
  } catch (error) {
    console.warn("[CommentAuthor] No se pudo consultar el perfil del autor.", {
      userId: message.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return author;
}

export async function getCommentAuthorName(
  ctx: Pick<QueryCtx, "db">,
  message: CommentAuthorFields,
  fallback = "Autor sin nombre",
): Promise<string> {
  return (await getCommentAuthor(ctx, message, fallback)).name;
}
