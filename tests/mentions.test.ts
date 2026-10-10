import test from "node:test";
import assert from "node:assert/strict";
import { mentionQuery, filterMentionPeople } from "../app/components/requests/comment-editor/mentions";
import { serializeComment } from "../app/components/requests/comment-editor/serializeComment";
import { resolveMentions, mentionsForSync } from "../convex/lib/taskMentions";

test("mention search recognizes names but leaves email addresses and punctuation alone", () => {
  assert.deepEqual(mentionQuery("Hola @"), { query: "", length: 1 });
  assert.deepEqual(mentionQuery("@María"), { query: "María", length: 6 });
  for (const text of ["@ ", "@  ", "@María ", "@María Pé", "@\t", "@\n"]) assert.equal(mentionQuery(text), null);
  for (const text of ["maria@example", "@maria.com", "@maria@", "hola @maria!", "foo@", "hola"]) assert.equal(mentionQuery(text), null);
  const people = [{ id: "1", name: "María Pérez" }, { id: "2", name: "Julia Sartirana" }];
  assert.deepEqual(filterMentionPeople(people, "maria pe"), [people[0]]);
  assert.deepEqual(filterMentionPeople(people, "inexistente"), []);
});

test("only selected mention nodes serialize as mentions; deletion removes their identity", () => {
  const doc: any = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hola @texto " }, { type: "mention", attrs: { userId: "u1", label: "Nombre falsificado" } }] }] };
  const text = serializeComment(doc, []);
  const result = resolveMentions(text, [{ id: "u1", name: "María Pérez" }]);
  assert.equal(result.message, "Hola @texto [@María Pérez](#mention-u1)");
  assert.deepEqual(result.userIds, ["u1"]);
  assert.equal(mentionsForSync(result.message), "Hola @texto @María Pérez");
  assert.throws(() => resolveMentions(text, []), /ya no tiene acceso/);
  doc.content[0].content.pop();
  assert.deepEqual(resolveMentions(serializeComment(doc, []), []).userIds, []);
});

import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { DISMISS_MENTION, nextMentionSession, type MentionSession } from "../app/components/requests/comment-editor/mentions";

function mentionEditor() {
  const schema = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: { group: "inline" } } });
  let state = EditorState.create({ schema });
  let session: MentionSession = null;
  const apply = (tr: Transaction) => { session = nextMentionSession(session, tr); state = state.apply(tr); };
  return { get state() { return state; }, get session() { return session; }, apply,
    type: (text: string) => apply(state.tr.insertText(text)),
    dismiss: () => apply(state.tr.setMeta(DISMISS_MENTION, true)),
  };
}

test("space ends the session; deleting it or moving the cursor cannot reopen the old @", () => {
  const editor = mentionEditor();
  editor.type("@"); assert.ok(editor.session);
  editor.type("Julia"); assert.ok(editor.session);
  editor.type(" "); assert.equal(editor.session, null);
  editor.apply(editor.state.tr.delete(editor.state.selection.from - 1, editor.state.selection.from));
  assert.equal(editor.session, null);
  editor.type("a"); assert.equal(editor.session, null);
  editor.apply(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)));
  assert.equal(editor.session, null);
  editor.apply(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
  editor.type(" @"); assert.ok(editor.session);
});

test("dismissal preserves native space/delete behavior and stays closed until a new trigger", () => {
  for (const key of ["Space", "Backspace", "Delete", "Escape"]) {
    const editor = mentionEditor();
    editor.type("@Julia"); editor.apply(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    editor.type(" @"); editor.type("Ju");
    assert.ok(editor.session);
    const before = editor.state.doc.textContent;
    editor.dismiss();
    assert.equal(editor.session, null);
    assert.equal(editor.state.doc.textContent, before, key + " should not alter text on dismissal");
    if (key === "Backspace") editor.apply(editor.state.tr.delete(editor.state.selection.from - 1, editor.state.selection.from));
    if (key === "Space") editor.type(" ");
    editor.type("x"); assert.equal(editor.session, null);
    editor.type(" @"); assert.ok(editor.session);
  }
});

test("native deletion and email text do not activate suggestions", () => {
  const editor = mentionEditor();
  editor.type("persona@"); assert.equal(editor.session, null);
  editor.type("dominio.com "); editor.type("@"); assert.ok(editor.session);
  editor.type("Julia");
  editor.apply(editor.state.tr.delete(editor.state.selection.from - 1, editor.state.selection.from));
  assert.equal(editor.session, null);
});
