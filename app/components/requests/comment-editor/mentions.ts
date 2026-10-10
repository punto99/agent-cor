export type MentionPerson = { id: string; name: string };
export function mentionQuery(beforeCursor: string) {
  const match = /(?:^|\s)@([\p{L}\p{M}\p{N}'\-]{0,80})$/u.exec(beforeCursor);
  return match ? { query: match[1], length: match[1].length + 1 } : null;
}
export const foldName = (name: string) => name.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
export function filterMentionPeople(people: MentionPerson[], query: string) {
  const terms = foldName(query).split(/\s+/).filter(Boolean);
  return people.filter(person => terms.every(term => foldName(person.name).includes(term)));
}

import type { Transaction } from "@tiptap/pm/state";
export const DISMISS_MENTION = "dismissCommentMention";
export type MentionSession = { from: number } | null;

// A search belongs to a newly inserted @, not merely text near the cursor.
export function nextMentionSession(session: MentionSession, transaction: Transaction): MentionSession {
  if (transaction.getMeta(DISMISS_MENTION)) return null;
  const { selection } = transaction;
  if (!selection.empty) return null;
  const query = mentionQuery(selection.$from.parent.textBetween(0, selection.$from.parentOffset, "\n", "\ufffc"));
  if (!query) return null;
  const from = selection.from - query.length;
  const insertedTrigger = query.query === "" && transaction.steps.some((step, index) => {
    let inserted = false;
    step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const remaining = transaction.mapping.slice(index + 1);
      const start = remaining.map(newStart, -1);
      const end = remaining.map(newEnd, 1);
      if (newEnd > newStart && from >= start && from < end) inserted = true;
    });
    return inserted;
  });
  if (insertedTrigger) return { from };
  const deletedText = transaction.steps.some(step => {
    let deleted = false;
    step.getMap().forEach((oldStart, oldEnd) => { if (oldEnd > oldStart) deleted = true; });
    return deleted;
  });
  if (deletedText) return null;
  if (!session || (!transaction.docChanged && transaction.selectionSet)) return null;
  return transaction.mapping.map(session.from, -1) === from ? { from } : null;
}
