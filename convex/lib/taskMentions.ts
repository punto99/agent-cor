import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getAuthorName } from "./authorName";

export async function eligibleMentionUsers(ctx: QueryCtx, task: Doc<"tasks">) {
  // Subbrands inherit permissions from their parent brand in the current access model.
  const subBrand = task.subBrandId ? await ctx.db.get(task.subBrandId) : null;
  const brandId = task.clientBrandId ?? subBrand?.clientBrandId;
  const brand = brandId ? await ctx.db.get(brandId) : null;
  const clientId = brand?.clientId ?? task.clientId ?? (task.corClientId !== undefined
    ? (await ctx.db.query("corClients").withIndex("by_corClientId", q => q.eq("corClientId", task.corClientId!)).unique())?._id : undefined);
  if (!clientId || (brandId && !brand)) return [];
  const assignments = await ctx.db.query("clientUserAssignments").withIndex("by_client", q => q.eq("clientId", clientId)).collect();
  const ids = [...new Set(assignments.filter(a => !a.brandId || a.brandId === brandId).map(a => a.userId))];
  const people = await Promise.all(ids.map(async id => {
    if (!(await ctx.db.get(id))) return null;
    const name = await getAuthorName(ctx, id, "");
    return name ? { id, name } : null;
  }));
  return people.filter((p): p is NonNullable<typeof p> => p !== null).sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export function resolveMentions(text: string, people: { id: string; name: string }[]) {
  const selected = new Set<string>();
  const message = text.replace(/\{\{task-panel-mention:([^}]+)\}\}/g, (_match, id: string) => {
    const person = people.find(p => p.id === id);
    if (!person) throw new Error("Una persona mencionada ya no tiene acceso. Quitá esa mención y volvé a intentar.");
    selected.add(id);
    const label = person.name.replace(/[\\`*_{}\[\]<>!#]/g, "\\$&").replace(/[\r\n]/g, " ");
    return `[@${label}](#mention-${id})`;
  });
  return { message, userIds: [...selected] };
}

export function mentionsForSync(text: string) {
  return text.replace(/\[(@(?:\\.|[^\]])*)\]\(#mention-[^)]+\)/g, "$1");
}
